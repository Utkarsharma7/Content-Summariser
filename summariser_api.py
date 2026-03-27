import asyncio
import base64
import hashlib
import json
import logging
import re
import shutil
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from html import escape
from pathlib import Path

import markdown
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask
from xhtml2pdf import pisa

from notebooklm import NotebookLMClient
from notebooklm.rpc import (
    AudioFormat,
    AudioLength,
    ExportType,
    QuizDifficulty,
    QuizQuantity,
    ReportFormat,
    SlideDeckFormat,
    SlideDeckLength,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s")
logger = logging.getLogger("summariser")

for _noisy in ("xhtml2pdf", "reportlab", "html5lib", "PIL", "httpx"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

# ---------------------------------------------------------------------------
# Persistent state
# ---------------------------------------------------------------------------
_source_filenames: dict[str, str] = {}

SUMMARY_NOTEBOOK_TITLE = "Content Summaries"
VALID_OUTPUT_TYPES = {"report", "slides", "podcast", "quiz"}

POLL_INITIAL = 1.0
POLL_MAX = 4.0

CHAT_SESSION_TTL = 1800
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
USER_SESSION_TTL = 3600  # 1 hour inactivity before user session cleanup

# ---------------------------------------------------------------------------
# Per-user session management
# ---------------------------------------------------------------------------
_user_sessions: dict[str, dict] = {}  # cookie_hash -> {client, notebook_id, last_active}

# Optional global fallback client (used when NOTEBOOKLM_AUTH_JSON is set on server)
_global_client: NotebookLMClient | None = None
_global_notebook_id: str | None = None
_global_client_available = False


async def _init_global_client():
    """Try to create a global client from env/storage. Non-fatal if missing."""
    global _global_client, _global_client_available
    try:
        _global_client = await NotebookLMClient.from_storage()
        await _global_client.__aenter__()
        _global_client_available = True
        logger.info("Global NotebookLM client opened (from env/storage)")
    except Exception as exc:
        _global_client = None
        _global_client_available = False
        logger.info("No global NotebookLM auth found (%s) — per-user auth required", exc)


async def _get_global_client() -> NotebookLMClient:
    global _global_client, _global_client_available
    if _global_client is None:
        raise HTTPException(401, "No auth. Send X-NLM-Auth header or set NOTEBOOKLM_AUTH_JSON on server.")
    return _global_client


async def _get_global_notebook_id() -> str:
    global _global_notebook_id
    if _global_notebook_id:
        return _global_notebook_id
    client = await _get_global_client()
    notebooks = await client.notebooks.list()
    for nb in notebooks:
        if nb.title == SUMMARY_NOTEBOOK_TITLE:
            _global_notebook_id = nb.id
            return nb.id
    nb = await client.notebooks.create(SUMMARY_NOTEBOOK_TITLE)
    _global_notebook_id = nb.id
    return nb.id


async def _create_user_client(auth_json: str) -> NotebookLMClient:
    """Create a NotebookLMClient from a user's cookie JSON."""
    temp_dir = Path(tempfile.mkdtemp(prefix="nlm_user_"))
    auth_file = temp_dir / "storage_state.json"
    try:
        auth_file.write_text(auth_json, encoding="utf-8")
        client = await NotebookLMClient.from_storage(str(auth_file))
        await client.__aenter__()
        return client
    except Exception as exc:
        raise HTTPException(401, f"NotebookLM auth failed: {exc}") from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


async def _get_user_notebook_id(session: dict) -> str:
    if session.get("notebook_id"):
        return session["notebook_id"]
    client = session["client"]
    notebooks = await client.notebooks.list()
    for nb in notebooks:
        if nb.title == SUMMARY_NOTEBOOK_TITLE:
            session["notebook_id"] = nb.id
            return nb.id
    nb = await client.notebooks.create(SUMMARY_NOTEBOOK_TITLE)
    session["notebook_id"] = nb.id
    return nb.id


async def _resolve_session(request: Request) -> tuple:
    """Resolve (client, notebook_id) from per-user auth header or global fallback."""
    auth_header = request.headers.get("x-nlm-auth")

    if auth_header:
        try:
            auth_json = base64.b64decode(auth_header).decode("utf-8")
        except Exception:
            raise HTTPException(401, "Invalid X-NLM-Auth header encoding")

        cookie_hash = hashlib.sha256(auth_json.encode()).hexdigest()[:16]

        if cookie_hash in _user_sessions:
            session = _user_sessions[cookie_hash]
            session["last_active"] = time.monotonic()
            nb_id = await _get_user_notebook_id(session)
            return session["client"], nb_id

        client = await _create_user_client(auth_json)
        session = {
            "client": client,
            "notebook_id": None,
            "last_active": time.monotonic(),
        }
        _user_sessions[cookie_hash] = session
        logger.info("Created per-user session: %s", cookie_hash)
        nb_id = await _get_user_notebook_id(session)
        return client, nb_id

    # Fallback to global
    client = await _get_global_client()
    nb_id = await _get_global_notebook_id()
    return client, nb_id


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _init_global_client()
    chat_cleanup_task = asyncio.create_task(_cleanup_stale_chat_sessions())
    user_cleanup_task = asyncio.create_task(_cleanup_expired_user_sessions())
    yield
    chat_cleanup_task.cancel()
    user_cleanup_task.cancel()
    if _global_client:
        await _global_client.__aexit__(None, None, None)
    for session in _user_sessions.values():
        try:
            await session["client"].__aexit__(None, None, None)
        except Exception:
            pass
    logger.info("All sessions closed")


app = FastAPI(title="PDF Summariser via NotebookLM", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _safe_delete_artifact(client, nb_id: str, artifact_id: str):
    try:
        await client.artifacts.delete(nb_id, artifact_id)
    except Exception:
        logger.debug("Could not delete artifact %s", artifact_id, exc_info=True)


_chat_sessions: dict[str, dict] = {}


async def _cleanup_stale_chat_sessions():
    while True:
        await asyncio.sleep(300)
        now = time.monotonic()
        expired = [
            sid for sid, s in _chat_sessions.items()
            if now - s.get("last_active", now) > CHAT_SESSION_TTL
        ]
        for sid in expired:
            session = _chat_sessions.pop(sid, None)
            if not session:
                continue
            if session.get("owns_source", True):
                try:
                    client = session.get("client")
                    if client:
                        await client.sources.delete(session["nb_id"], session["source_id"])
                except Exception:
                    pass
            shutil.rmtree(session.get("temp_dir", ""), ignore_errors=True)
            logger.info("Chat session expired (TTL): %s", sid)


async def _cleanup_expired_user_sessions():
    while True:
        await asyncio.sleep(300)
        now = time.monotonic()
        expired = [
            k for k, v in _user_sessions.items()
            if now - v["last_active"] > USER_SESSION_TTL
        ]
        for k in expired:
            session = _user_sessions.pop(k, None)
            if session and session.get("client"):
                try:
                    await session["client"].__aexit__(None, None, None)
                except Exception:
                    pass
            logger.info("User session expired: %s", k)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
REPORT_INSTRUCTIONS = (
    "You are an expert analyst writing a comprehensive briefing document.\n\n"
    "Produce a thorough, detailed report of this PDF. Be extensive — do NOT skip sections:\n"
    "1. Start with a full executive summary (2-3 paragraphs) covering purpose, context, "
    "and main conclusions.\n"
    "2. Break the ENTIRE document into logical sections with descriptive headings.\n"
    "3. Under each heading, provide detailed bullet points covering ALL key information — "
    "arguments, evidence, data, examples, and reasoning.\n"
    "4. Include a dedicated section for key data, statistics, figures, or formulas "
    "mentioned in the document. Preserve exact numbers and definitions.\n"
    "5. If the document discusses methodology, include a methodology section.\n"
    "6. Include relevant quotes or paraphrased arguments where they add value.\n"
    "7. End with a 'Key Takeaways' section listing the 5-8 most important points.\n"
    "8. Use plain, precise language. Avoid filler but DO NOT sacrifice completeness.\n"
    "9. Aim for 5-10 pages of content. More detail is better than less.\n"
    "10. Cover every major section of the original document — nothing should be skipped.\n"
)

SLIDES_INSTRUCTIONS = (
    "Create a text-heavy, content-rich presentation. NO images, NO icons, NO decorative "
    "graphics — only text.\n"
    "1. Title slide with the document title and a brief subtitle.\n"
    "2. An 'Overview' slide with a paragraph explaining the purpose and scope.\n"
    "3. One slide per major section — use 5-8 detailed bullet points per slide.\n"
    "4. Include full sentences and key details on each slide — do not abbreviate.\n"
    "5. Include a 'Key Data & Findings' slide with exact numbers, statistics, and results.\n"
    "6. If formulas, definitions, or technical terms exist, include them on the slides.\n"
    "7. End with a 'Summary & Takeaways' slide listing all major conclusions.\n"
    "8. Aim for 12-18 slides total. More content per slide is better.\n"
    "9. Do NOT add any images, illustrations, or stock photos. Text only.\n"
)

PODCAST_INSTRUCTIONS = (
    "Create an engaging, well-structured audio discussion:\n"
    "1. Open with a brief hook explaining why this document matters.\n"
    "2. Walk through the major sections in logical order.\n"
    "3. Explain complex ideas using analogies or simple language.\n"
    "4. Highlight surprising findings or counterintuitive points.\n"
    "5. End with a clear recap of the most important takeaways.\n"
    "6. Keep the tone conversational but focused — avoid rambling.\n"
)

QUIZ_INSTRUCTIONS = (
    "Generate quiz questions that thoroughly test understanding:\n"
    "1. Cover every major section of the document.\n"
    "2. Mix factual recall questions with conceptual understanding questions.\n"
    "3. Make wrong answer options plausible — avoid obviously wrong choices.\n"
    "4. Include questions about key data, conclusions, and methodology.\n"
    "5. Write clear, unambiguous question stems.\n"
)


# ---------------------------------------------------------------------------
# PDF conversion helpers
# ---------------------------------------------------------------------------
BASE_CSS = """
  @page { size: A4; margin: 2.5cm; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 11pt;
         line-height: 1.6; color: #222; }
  h1 { font-size: 20pt; color: #1a1a1a; border-bottom: 2px solid #4285f4;
       padding-bottom: 6px; margin-top: 24px; }
  h2 { font-size: 16pt; color: #333; margin-top: 20px; }
  h3 { font-size: 13pt; color: #444; margin-top: 16px; }
  ul, ol { margin-left: 18px; margin-bottom: 10px; }
  li { margin-bottom: 4px; }
  code { background: #f4f4f4; padding: 1px 5px; border-radius: 3px;
         font-family: Consolas, monospace; font-size: 10pt; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px;
        font-size: 9pt; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; }
  blockquote { border-left: 3px solid #4285f4; margin: 10px 0;
               padding: 4px 12px; color: #555; }
"""


def _strip_latex(text: str) -> str:
    text = re.sub(r"\$\$(.+?)\$\$", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"\$(.+?)\$", r"\1", text)
    text = re.sub(r"\\(?:text|mathrm|mathbf|mathit|textbf|textit)\{([^}]*)\}", r"\1", text)
    text = re.sub(r"\\(?:sigma|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|tau|phi|omega|Sigma|Alpha|Beta|Gamma|Delta|Theta|Lambda|Pi|Omega)(?:_\{?[^}\s]*\}?)?", "", text)
    text = re.sub(r"\\[a-zA-Z]+", "", text)
    text = re.sub(r"[\\{}^_]", " ", text)
    text = re.sub(r"  +", " ", text)
    return text.strip()


def _html_to_pdf(html_body: str, pdf_path: Path, extra_css: str = "") -> None:
    full_html = (
        f'<!DOCTYPE html><html><head><meta charset="utf-8"/>'
        f"<style>{BASE_CSS}\n{extra_css}</style>"
        f"</head><body>{html_body}</body></html>"
    )
    with open(pdf_path, "wb") as f:
        pisa.CreatePDF(full_html, dest=f)


def _markdown_to_pdf(md_path: Path, pdf_path: Path) -> None:
    md_text = md_path.read_text(encoding="utf-8")
    md_text = _strip_latex(md_text)
    html_body = markdown.markdown(
        md_text, extensions=["tables", "fenced_code", "toc", "sane_lists"]
    )
    _html_to_pdf(html_body, pdf_path)


def _quiz_json_to_pdf(json_path: Path, pdf_path: Path) -> None:
    data = json.loads(json_path.read_text(encoding="utf-8"))
    questions = data.get("questions", [])
    title = escape(data.get("title", "Quiz"))

    parts = [f"<h1>{title}</h1>"]

    for i, q in enumerate(questions, 1):
        parts.append(f"<h2>Question {i}</h2>")
        parts.append(f"<p>{escape(q.get('question', ''))}</p>")
        parts.append("<ol type='A'>")
        for opt in q.get("answerOptions", []):
            parts.append(f"<li>{escape(opt.get('text', ''))}</li>")
        parts.append("</ol>")
        if q.get("hint"):
            parts.append(f"<p><em>Hint: {escape(q['hint'])}</em></p>")

    parts.append('<div class="page-break"></div>')
    parts.append("<h1>Answer Key</h1>")

    for i, q in enumerate(questions, 1):
        for j, opt in enumerate(q.get("answerOptions", [])):
            if opt.get("isCorrect"):
                parts.append(
                    f"<p><strong>Q{i}:</strong> "
                    f"{chr(65 + j)}. {escape(opt.get('text', ''))}</p>"
                )
                break

    quiz_css = """
      .page-break { page-break-before: always; }
      ol[type='A'] { margin-left: 24px; }
      ol[type='A'] li { margin-bottom: 6px; padding-left: 4px; }
    """
    _html_to_pdf("\n".join(parts), pdf_path, extra_css=quiz_css)


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------
async def _generate_report(client, nb_id, source_id, out_dir):
    status = await client.artifacts.generate_report(
        nb_id,
        report_format=ReportFormat.BRIEFING_DOC,
        source_ids=[source_id],
        language="en",
        extra_instructions=REPORT_INSTRUCTIONS,
    )
    logger.info("Report generation started: %s", status.task_id)
    final = await client.artifacts.wait_for_completion(
        nb_id, status.task_id,
        initial_interval=POLL_INITIAL, max_interval=POLL_MAX, timeout=600.0,
    )
    if not final.is_complete:
        raise HTTPException(500, f"Report generation failed: {final.status}")

    md_path = out_dir / "summary.md"
    await client.artifacts.download_report(nb_id, str(md_path), artifact_id=final.task_id)
    pdf_path = out_dir / "report.pdf"
    await asyncio.to_thread(_markdown_to_pdf, md_path, pdf_path)
    return pdf_path, "application/pdf", "pdf", final.task_id


async def _generate_slides(client, nb_id, source_id, out_dir):
    status = await client.artifacts.generate_slide_deck(
        nb_id,
        source_ids=[source_id],
        language="en",
        instructions=SLIDES_INSTRUCTIONS,
        slide_format=SlideDeckFormat.DETAILED_DECK,
        slide_length=SlideDeckLength.DEFAULT,
    )
    logger.info("Slides generation started: %s", status.task_id)
    final = await client.artifacts.wait_for_completion(
        nb_id, status.task_id,
        initial_interval=POLL_INITIAL, max_interval=POLL_MAX, timeout=600.0,
    )
    if not final.is_complete:
        raise HTTPException(500, f"Slides generation failed: {final.status}")

    out = out_dir / "slides.pptx"
    await client.artifacts.download_slide_deck(
        nb_id, str(out), artifact_id=final.task_id, output_format="pptx",
    )
    return out, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx", final.task_id


async def _generate_podcast(client, nb_id, source_id, out_dir):
    status = await client.artifacts.generate_audio(
        nb_id,
        source_ids=[source_id],
        language="en",
        instructions=PODCAST_INSTRUCTIONS,
        audio_format=AudioFormat.DEEP_DIVE,
        audio_length=AudioLength.SHORT,
    )
    logger.info("Podcast generation started: %s", status.task_id)
    final = await client.artifacts.wait_for_completion(
        nb_id, status.task_id,
        initial_interval=POLL_INITIAL, max_interval=POLL_MAX, timeout=900.0,
    )
    if not final.is_complete:
        raise HTTPException(500, f"Podcast generation failed: {final.status}")

    out = out_dir / "podcast.mp4"
    await client.artifacts.download_audio(nb_id, str(out), artifact_id=final.task_id)
    return out, "audio/mp4", "mp4", final.task_id


async def _generate_quiz(client, nb_id, source_id, out_dir):
    status = await client.artifacts.generate_quiz(
        nb_id,
        source_ids=[source_id],
        instructions=QUIZ_INSTRUCTIONS,
        quantity=QuizQuantity.STANDARD,
        difficulty=QuizDifficulty.HARD,
    )
    logger.info("Quiz generation started: %s", status.task_id)
    final = await client.artifacts.wait_for_completion(
        nb_id, status.task_id,
        initial_interval=POLL_INITIAL, max_interval=POLL_MAX, timeout=600.0,
    )
    if not final.is_complete:
        raise HTTPException(500, f"Quiz generation failed: {final.status}")

    json_path = out_dir / "quiz.json"
    await client.artifacts.download_quiz(
        nb_id, str(json_path), artifact_id=final.task_id, output_format="json",
    )
    pdf_path = out_dir / "quiz.pdf"
    await asyncio.to_thread(_quiz_json_to_pdf, json_path, pdf_path)
    return pdf_path, "application/pdf", "pdf", final.task_id


GENERATORS = {
    "report": _generate_report,
    "slides": _generate_slides,
    "podcast": _generate_podcast,
    "quiz": _generate_quiz,
}


# ---------------------------------------------------------------------------
# Upload helper
# ---------------------------------------------------------------------------
async def _read_upload(file: UploadFile) -> tuple[bytes, str]:
    try:
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "Uploaded file is empty.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "Failed to read uploaded file.") from exc
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File too large ({len(raw) // (1024*1024)} MB). Max is {MAX_UPLOAD_BYTES // (1024*1024)} MB.")
    filename = Path(file.filename or "input.pdf").name
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    return raw, filename


# ---------------------------------------------------------------------------
# PRE-UPLOAD
# ---------------------------------------------------------------------------
@app.post("/pre-upload")
async def pre_upload(request: Request, file: UploadFile = File(...)):
    raw, filename = await _read_upload(file)
    temp_dir = Path(tempfile.mkdtemp(prefix="preupload_"))
    try:
        input_path = temp_dir / filename
        input_path.write_bytes(raw)

        t0 = time.monotonic()
        logger.info("▶ Pre-upload: %s (%d KB)", filename, len(raw) // 1024)

        client, nb_id = await _resolve_session(request)

        source = await client.sources.add_file(
            nb_id, input_path, wait=True, wait_timeout=300.0,
        )
        elapsed = time.monotonic() - t0
        logger.info("✓ Pre-upload done in %.1fs: source=%s", elapsed, source.id)

        _source_filenames[source.id] = filename

        return JSONResponse({
            "source_id": source.id,
            "nb_id": nb_id,
            "filename": filename,
        })
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Pre-upload error")
        raise HTTPException(500, str(exc)) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# GENERATE
# ---------------------------------------------------------------------------
@app.post("/generate")
async def generate_from_source(
    request: Request,
    source_id: str = Form(...),
    output_type: str = Form("slides"),
):
    if output_type not in VALID_OUTPUT_TYPES:
        raise HTTPException(400, f"Invalid output_type. Choose from: {VALID_OUTPUT_TYPES}")

    temp_dir_path = Path(tempfile.mkdtemp(prefix="gen_"))
    try:
        t0 = time.monotonic()
        logger.info("▶ Generate: source=%s → %s", source_id, output_type)

        client, nb_id = await _resolve_session(request)

        generator = GENERATORS[output_type]
        output_path, media_type, ext, artifact_id = await generator(
            client, nb_id, source_id, temp_dir_path,
        )

        t_total = time.monotonic() - t0
        logger.info("✓ Generated in %.1fs: %s", t_total, output_type)

        await _safe_delete_artifact(client, nb_id, artifact_id)

        stem = Path(_source_filenames.get(source_id, "output")).stem
        suggested_name = f"{stem}_{output_type}.{ext}"

        cleanup = BackgroundTask(shutil.rmtree, temp_dir_path, ignore_errors=True)
        return FileResponse(
            path=str(output_path),
            media_type=media_type,
            filename=suggested_name,
            background=cleanup,
        )
    except HTTPException:
        shutil.rmtree(temp_dir_path, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(temp_dir_path, ignore_errors=True)
        logger.exception("Generate error")
        raise HTTPException(500, str(exc)) from exc


# ---------------------------------------------------------------------------
# CLEANUP-SOURCE
# ---------------------------------------------------------------------------
@app.post("/cleanup-source")
async def cleanup_source(request: Request, source_id: str = Form(...)):
    try:
        client, nb_id = await _resolve_session(request)
        await client.sources.delete(nb_id, source_id)
        logger.info("Cleaned up source: %s", source_id)
    except Exception:
        logger.debug("Could not delete source %s", source_id, exc_info=True)
    _source_filenames.pop(source_id, None)
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# EXPORT TO GOOGLE DOCS
# ---------------------------------------------------------------------------
@app.post("/export-to-docs")
async def export_to_docs(request: Request, source_id: str = Form(...)):
    try:
        t0 = time.monotonic()
        logger.info("▶ Export to Docs: source=%s", source_id)

        client, nb_id = await _resolve_session(request)

        status = await client.artifacts.generate_report(
            nb_id,
            report_format=ReportFormat.BRIEFING_DOC,
            source_ids=[source_id],
            language="en",
            extra_instructions=REPORT_INSTRUCTIONS,
        )
        final = await client.artifacts.wait_for_completion(
            nb_id, status.task_id,
            initial_interval=POLL_INITIAL, max_interval=POLL_MAX, timeout=600.0,
        )
        if not final.is_complete:
            raise HTTPException(500, f"Report generation failed: {final.status}")

        stem = Path(_source_filenames.get(source_id, "Document")).stem
        title = f"{stem} — Report"

        result = await client.artifacts.export_report(
            nb_id, final.task_id, title=title, export_type=ExportType.DOCS,
        )

        await _safe_delete_artifact(client, nb_id, final.task_id)

        doc_url = None
        if isinstance(result, list):
            for item in result:
                if isinstance(item, str) and "docs.google.com" in item:
                    doc_url = item
                    break
            if not doc_url:
                for item in result:
                    if isinstance(item, str) and item.startswith("http"):
                        doc_url = item
                        break

        t_total = time.monotonic() - t0
        logger.info("✓ Exported to Docs in %.1fs: %s", t_total, doc_url or "no URL")

        return JSONResponse({
            "status": "exported",
            "title": title,
            "doc_url": doc_url,
        })
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Export to Docs error")
        raise HTTPException(500, "Export failed. Check server logs.") from exc


# ---------------------------------------------------------------------------
# Legacy endpoint — full upload + generate in one call
# ---------------------------------------------------------------------------
@app.post("/summarise-pdf")
async def summarise_pdf(
    request: Request,
    file: UploadFile = File(...),
    output_type: str = Form("slides"),
):
    if output_type not in VALID_OUTPUT_TYPES:
        raise HTTPException(400, f"Invalid output_type. Choose from: {VALID_OUTPUT_TYPES}")

    raw, filename = await _read_upload(file)

    temp_dir_path = Path(tempfile.mkdtemp(prefix="summariser_"))
    try:
        input_path = temp_dir_path / filename
        input_path.write_bytes(raw)

        t0 = time.monotonic()
        logger.info("▶ Processing: %s (%d KB) → %s", filename, len(raw) // 1024, output_type)

        client, nb_id = await _resolve_session(request)

        source = await client.sources.add_file(
            nb_id, input_path, wait=True, wait_timeout=300.0,
        )
        t_upload = time.monotonic() - t0
        logger.info("  Source uploaded in %.1fs: %s", t_upload, source.id)

        generator = GENERATORS[output_type]
        output_path, media_type, ext, artifact_id = await generator(
            client, nb_id, source.id, temp_dir_path,
        )

        t_total = time.monotonic() - t0
        logger.info("✓ Done in %.1fs: %s → %s", t_total, filename, output_type)

        await _safe_delete_artifact(client, nb_id, artifact_id)
        try:
            await client.sources.delete(nb_id, source.id)
        except Exception:
            pass

        stem = Path(filename).stem
        suggested_name = f"{stem}_{output_type}.{ext}"

        cleanup = BackgroundTask(shutil.rmtree, temp_dir_path, ignore_errors=True)
        return FileResponse(
            path=str(output_path),
            media_type=media_type,
            filename=suggested_name,
            background=cleanup,
        )

    except HTTPException:
        shutil.rmtree(temp_dir_path, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(temp_dir_path, ignore_errors=True)
        logger.exception("Unexpected error processing PDF")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Chat with PDF
# ---------------------------------------------------------------------------
@app.post("/chat/start")
async def chat_start(request: Request, file: UploadFile = File(...)):
    raw, filename = await _read_upload(file)

    temp_dir = Path(tempfile.mkdtemp(prefix="chat_"))
    try:
        input_path = temp_dir / filename
        input_path.write_bytes(raw)

        logger.info("Chat: uploading %s (%d KB)", filename, len(raw) // 1024)

        client, nb_id = await _resolve_session(request)

        source = await client.sources.add_file(
            nb_id, input_path, wait=True, wait_timeout=300.0,
        )
        logger.info("Chat: source ready %s", source.id)

        session_id = uuid.uuid4().hex[:12]
        _chat_sessions[session_id] = {
            "nb_id": nb_id,
            "source_id": source.id,
            "conversation_id": None,
            "filename": filename,
            "temp_dir": temp_dir,
            "owns_source": True,
            "client": client,
            "last_active": time.monotonic(),
        }

        return JSONResponse({"session_id": session_id, "filename": filename})

    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.exception("Chat start error")
        raise HTTPException(500, str(exc)) from exc


@app.post("/chat/start-from-source")
async def chat_start_from_source(request: Request, source_id: str = Form(...)):
    client, nb_id = await _resolve_session(request)
    session_id = uuid.uuid4().hex[:12]
    _chat_sessions[session_id] = {
        "nb_id": nb_id,
        "source_id": source_id,
        "conversation_id": None,
        "owns_source": False,
        "client": client,
        "last_active": time.monotonic(),
    }
    logger.info("Chat: instant session %s from source %s", session_id, source_id)
    return JSONResponse({"session_id": session_id})


class ChatMessage(BaseModel):
    session_id: str
    question: str


@app.post("/chat/ask")
async def chat_ask(request: Request, msg: ChatMessage):
    session = _chat_sessions.get(msg.session_id)
    if not session:
        raise HTTPException(404, "Session not found. Upload a PDF first via /chat/start.")

    session["last_active"] = time.monotonic()
    client = session.get("client")
    if not client:
        client, _ = await _resolve_session(request)
    try:
        result = await client.chat.ask(
            session["nb_id"],
            msg.question,
            source_ids=[session["source_id"]],
            conversation_id=session.get("conversation_id"),
        )
        session["conversation_id"] = result.conversation_id

        answer = _strip_latex(result.answer)

        return JSONResponse({
            "answer": answer,
            "conversation_id": result.conversation_id,
            "turn": result.turn_number,
        })
    except Exception as exc:
        logger.exception("Chat ask error")
        raise HTTPException(500, str(exc)) from exc


@app.post("/chat/end")
async def chat_end(request: Request, session_id: str = Form(...)):
    session = _chat_sessions.pop(session_id, None)
    if not session:
        return JSONResponse({"status": "already_ended"})

    if session.get("owns_source", True):
        client = session.get("client")
        if not client:
            try:
                client, _ = await _resolve_session(request)
            except Exception:
                client = None
        if client:
            try:
                await client.sources.delete(session["nb_id"], session["source_id"])
            except Exception:
                logger.debug("Could not delete chat source %s", session["source_id"])
    shutil.rmtree(session.get("temp_dir", ""), ignore_errors=True)
    return JSONResponse({"status": "ended"})


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "auth_mode": "global" if _global_client_available else "per-user",
        "active_user_sessions": len(_user_sessions),
    }


if __name__ == "__main__":
    import os

    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0")
    reload = os.environ.get("ENV", "production") != "production"
    uvicorn.run("summariser_api:app", host=host, port=port, reload=reload)
