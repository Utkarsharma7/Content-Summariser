const DEFAULT_API_URL = "http://localhost:8000";
let API_BASE = DEFAULT_API_URL;

async function loadApiBase() {
  const { apiUrl } = await chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL });
  API_BASE = apiUrl.replace(/\/+$/, "");
  return API_BASE;
}

async function getApiBase() {
  if (!API_BASE) return loadApiBase();
  return API_BASE;
}

loadApiBase();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.apiUrl) {
    API_BASE = (changes.apiUrl.newValue || DEFAULT_API_URL).replace(/\/+$/, "");
  }
});

// ---------------------------------------------------------------------------
// NotebookLM auth — read Google cookies from browser, send with API requests
// ---------------------------------------------------------------------------
let _cachedAuthToken = null;

async function getAuthToken() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: ".google.com" });
    const hasSID = cookies.some((c) => c.name === "SID");
    if (!hasSID) return null;
    const storageState = {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
      })),
    };
    _cachedAuthToken = btoa(unescape(encodeURIComponent(JSON.stringify(storageState))));
    return _cachedAuthToken;
  } catch {
    return _cachedAuthToken;
  }
}

async function isLoggedIn() {
  const token = await getAuthToken();
  return token !== null;
}

const processedTabs = new Set();
const chooserShownTabs = new Set();
let activeRequests = 0;

const preUploadCache = new Map();

const EXTENSION_MAP = {
  report: "pdf",
  slides: "pptx",
  podcast: "mp4",
  quiz: "pdf",
};

const LABEL_MAP = {
  report: "Report",
  slides: "Presentation",
  podcast: "Podcast",
  quiz: "Quiz",
};

// ---------------------------------------------------------------------------
// Fetch helpers — timeout + retry for reliability
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 300000) {
  const api = await getApiBase();
  if (url.startsWith(api)) {
    const auth = await getAuthToken();
    if (auth) {
      options.headers = { ...(options.headers || {}), "X-NLM-Auth": auth };
    }
  }
  const controller = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort());
  }
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 300000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// In-page toast — only dismissed by clicking X
// ---------------------------------------------------------------------------
function showToast(tabId, message, type = "info") {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (msg, t) => {
      const existing = document.getElementById("__summariser_toast");
      if (existing) existing.remove();
      const colors = {
        info:    { bg: "#4285f4", icon: "\u23F3" },
        success: { bg: "#0f9d58", icon: "\u2705" },
        error:   { bg: "#db4437", icon: "\u274C" },
        warn:    { bg: "#f4b400", icon: "\u26A0\uFE0F" },
      };
      const c = colors[t] || colors.info;
      const toast = document.createElement("div");
      toast.id = "__summariser_toast";
      toast.style.cssText =
        "position:fixed;top:16px;right:16px;z-index:2147483647;" +
        "display:flex;align-items:center;max-width:420px;padding:14px 18px;" +
        `background:${c.bg};color:#fff;` +
        "font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:500;" +
        "border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.25);" +
        "animation:__stSlideIn 0.35s ease-out;";

      const iconSpan = document.createElement("span");
      iconSpan.style.cssText = "font-size:18px;margin-right:10px";
      iconSpan.textContent = c.icon;

      const msgSpan = document.createElement("span");
      msgSpan.textContent = msg;

      const closeSpan = document.createElement("span");
      closeSpan.id = "__summariser_toast_close";
      closeSpan.style.cssText =
        "margin-left:auto;cursor:pointer;font-size:18px;opacity:0.7;padding:0 4px";
      closeSpan.innerHTML = "&times;";

      toast.appendChild(iconSpan);
      toast.appendChild(msgSpan);
      toast.appendChild(closeSpan);

      const style = document.createElement("style");
      style.id = "__summariser_toast_style";
      style.textContent =
        "@keyframes __stSlideIn{from{transform:translateX(120%);opacity:0}" +
        "to{transform:translateX(0);opacity:1}}" +
        "@keyframes __stSlideOut{from{transform:translateX(0);opacity:1}" +
        "to{transform:translateX(120%);opacity:0}}";
      if (!document.getElementById("__summariser_toast_style"))
        document.head.appendChild(style);
      document.body.appendChild(toast);
      closeSpan.addEventListener("click", () => {
        toast.style.animation = "__stSlideOut 0.3s ease-in forwards";
        setTimeout(() => toast.remove(), 350);
      });
    },
    args: [message, type],
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// In-page chooser — dark themed, 5 options
// ---------------------------------------------------------------------------
function showChooser(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const old = document.getElementById("__summariser_chooser");
      if (old) old.remove();

      const backdrop = document.createElement("div");
      backdrop.id = "__summariser_chooser";
      backdrop.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;" +
        "display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
        "animation:__scFadeIn 0.25s ease-out;" +
        "font-family:'Segoe UI',system-ui,-apple-system,sans-serif;";

      const card = document.createElement("div");
      card.style.cssText =
        "background:#1a1a2e;border:1px solid rgba(255,255,255,0.08);" +
        "border-radius:20px;padding:30px 28px 22px;width:400px;" +
        "box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.05);" +
        "animation:__scPopIn 0.3s cubic-bezier(0.16,1,0.3,1);";

      const header = document.createElement("div");
      header.style.cssText = "text-align:center;margin-bottom:22px;";
      header.innerHTML =
        '<div style="font-size:32px;margin-bottom:10px">\uD83D\uDCC1</div>' +
        '<h2 style="margin:0 0 6px;font-size:18px;font-weight:700;color:#f0f0f0;letter-spacing:-0.3px">' +
        "PDF Detected</h2>" +
        '<p style="margin:0;font-size:13px;color:#888;font-weight:400">' +
        "What would you like to generate?</p>";
      card.appendChild(header);

      const items = [
        { value: "report",  icon: "\uD83D\uDCC4", label: "Summary",        desc: "Summary pdf",                accent: "#6C63FF" },
        { value: "slides",  icon: "\uD83D\uDCCA", label: "Presentation",  desc: "Slide deck",                  accent: "#00C9A7" },
        { value: "podcast", icon: "\uD83C\uDFA7", label: "Podcast",       desc: "Podcast",                     accent: "#FF6B6B" },
        { value: "quiz",    icon: "\u2753",        label: "Quiz",          desc: "Quiz",                        accent: "#FFA940" },
        { value: "chat",    icon: "\uD83D\uDCAC",  label: "Chat with PDF", desc: "Chat with pdf",              accent: "#4285F4" },
        { value: "export_docs", icon: "\uD83D\uDCDD", label: "Export to Docs", desc: "Export report to Google Docs", accent: "#34A853" },
      ];

      items.forEach((item) => {
        const btn = document.createElement("button");
        btn.style.cssText =
          "display:flex;align-items:center;gap:14px;width:100%;" +
          "padding:13px 16px;margin-bottom:8px;" +
          "border:1.5px solid rgba(255,255,255,0.08);border-radius:12px;" +
          "background:rgba(255,255,255,0.04);cursor:pointer;" +
          "transition:all 0.2s ease;font-family:inherit;text-align:left;";
        btn.innerHTML =
          `<div style="width:40px;height:40px;border-radius:10px;` +
          `background:${item.accent}20;display:flex;align-items:center;justify-content:center;` +
          `font-size:20px;flex-shrink:0">${item.icon}</div>` +
          `<div style="display:flex;flex-direction:column;gap:2px">` +
          `<span style="font-size:14px;font-weight:600;color:#eee">${item.label}</span>` +
          `<span style="font-size:11.5px;color:#777">${item.desc}</span></div>` +
          `<span style="margin-left:auto;color:#555;font-size:16px">\u203A</span>`;
        btn.addEventListener("mouseenter", () => {
          btn.style.borderColor = item.accent;
          btn.style.background = `${item.accent}15`;
          btn.style.transform = "translateX(4px)";
        });
        btn.addEventListener("mouseleave", () => {
          btn.style.borderColor = "rgba(255,255,255,0.08)";
          btn.style.background = "rgba(255,255,255,0.04)";
          btn.style.transform = "translateX(0)";
        });
        btn.addEventListener("click", () => {
          let action = "generate";
          if (item.value === "chat") action = "chat";
          else if (item.value === "export_docs") action = "export_docs";
          chrome.runtime.sendMessage({ action, outputType: item.value });
          backdrop.remove();
        });
        card.appendChild(btn);
      });

      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.style.cssText =
        "display:block;width:100%;margin-top:12px;padding:11px;" +
        "border:1.5px solid rgba(255,255,255,0.1);border-radius:10px;" +
        "background:transparent;color:#888;font-size:13px;font-weight:600;" +
        "cursor:pointer;font-family:inherit;transition:all 0.2s;letter-spacing:0.3px;";
      cancel.addEventListener("mouseenter", () => {
        cancel.style.borderColor = "rgba(255,255,255,0.25)";
        cancel.style.color = "#bbb";
      });
      cancel.addEventListener("mouseleave", () => {
        cancel.style.borderColor = "rgba(255,255,255,0.1)";
        cancel.style.color = "#888";
      });
      cancel.addEventListener("click", () => backdrop.remove());
      card.appendChild(cancel);

      const style = document.createElement("style");
      style.textContent =
        "@keyframes __scFadeIn{from{opacity:0}to{opacity:1}}" +
        "@keyframes __scPopIn{from{transform:scale(0.92) translateY(10px);opacity:0}" +
        "to{transform:scale(1) translateY(0);opacity:1}}";
      document.head.appendChild(style);
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Floating chat widget — accepts optional pre-uploaded sourceId for instant start
// ---------------------------------------------------------------------------
async function injectChatWidget(tabId, apiBase, preSourceId = null) {
  const authToken = await getAuthToken();
  chrome.scripting.executeScript({
    target: { tabId },
    func: (API, existingSourceId, nlmAuth) => {
      const authHeaders = nlmAuth ? { "X-NLM-Auth": nlmAuth } : {};
      if (document.getElementById("__summariser_chat")) return;

      const widget = document.createElement("div");
      widget.id = "__summariser_chat";
      widget.innerHTML = `
        <div id="__sc_header" style="display:flex;align-items:center;justify-content:space-between;
            padding:14px 16px;background:#4285f4;color:#fff;border-radius:14px 14px 0 0;cursor:move;user-select:none">
          <span style="font-weight:700;font-size:14px">\uD83D\uDCAC Chat with PDF</span>
          <div style="display:flex;gap:8px">
            <span id="__sc_minimize" style="cursor:pointer;font-size:18px;opacity:0.8" title="Minimize">\u2013</span>
            <span id="__sc_close" style="cursor:pointer;font-size:18px;opacity:0.8" title="Close">&times;</span>
          </div>
        </div>
        <div id="__sc_body" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px">
          <div style="text-align:center;color:#888;font-size:13px;padding:20px 0">
            ${existingSourceId ? "Starting chat session..." : "Uploading PDF to NotebookLM...<br>This may take a minute."}
          </div>
        </div>
        <div id="__sc_input_row" style="display:flex;gap:8px;padding:10px 14px;border-top:1px solid #e0e0e0">
          <input id="__sc_input" type="text" placeholder="Ask a question about this PDF..."
            disabled style="flex:1;padding:10px 12px;border:1.5px solid #ddd;border-radius:8px;
            font-size:13px;font-family:inherit;outline:none;transition:border 0.15s" />
          <button id="__sc_send" disabled style="padding:10px 16px;border:none;border-radius:8px;
            background:#4285f4;color:#fff;font-weight:600;font-size:13px;cursor:pointer;
            font-family:inherit;opacity:0.5;transition:opacity 0.15s">Send</button>
        </div>
      `;
      widget.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
        "width:380px;height:520px;background:#fff;border-radius:14px;" +
        "box-shadow:0 12px 40px rgba(0,0,0,0.25);display:flex;flex-direction:column;" +
        "font-family:system-ui,-apple-system,sans-serif;" +
        "animation:__scPopIn 0.3s ease-out;overflow:hidden;";
      const chatStyle = document.createElement("style");
      chatStyle.id = "__sc_styles";
      chatStyle.textContent = `
        @keyframes __scPopIn{from{transform:scale(0.9);opacity:0}to{transform:scale(1);opacity:1}}
        #__sc_body::-webkit-scrollbar{width:5px}
        #__sc_body::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}
        .__sc_msg_user{align-self:flex-end;background:#e8f0fe;color:#222;
          padding:10px 14px;border-radius:14px 14px 4px 14px;max-width:85%;font-size:13px;line-height:1.5}
        .__sc_msg_bot{align-self:flex-start;background:#f4f4f4;color:#222;
          padding:10px 14px;border-radius:14px 14px 14px 4px;max-width:85%;font-size:13px;line-height:1.5}
        .__sc_msg_bot strong{font-weight:600}
        .__sc_typing{align-self:flex-start;color:#888;font-size:12px;font-style:italic;padding:4px 0}
      `;
      document.head.appendChild(chatStyle);
      document.body.appendChild(widget);

      let sessionId = null;
      const body = document.getElementById("__sc_body");
      const input = document.getElementById("__sc_input");
      const sendBtn = document.getElementById("__sc_send");
      let minimized = false;

      document.getElementById("__sc_minimize").addEventListener("click", () => {
        const b = document.getElementById("__sc_body");
        const r = document.getElementById("__sc_input_row");
        minimized = !minimized;
        b.style.display = minimized ? "none" : "flex";
        r.style.display = minimized ? "none" : "flex";
        widget.style.height = minimized ? "auto" : "520px";
      });

      document.getElementById("__sc_close").addEventListener("click", () => {
        if (sessionId) {
          const fd = new FormData();
          fd.append("session_id", sessionId);
          fetch(`${API}/chat/end`, { method: "POST", body: fd, headers: authHeaders }).catch(() => {});
        }
        widget.remove();
        chatStyle.remove();
      });

      function addMessage(text, cls) {
        const d = document.createElement("div");
        d.className = cls;
        d.textContent = text;
        body.appendChild(d);
        body.scrollTop = body.scrollHeight;
        return d;
      }

      async function sendQuestion() {
        const q = input.value.trim();
        if (!q || !sessionId) return;
        input.value = "";
        addMessage(q, "__sc_msg_user");
        const typing = addMessage("Thinking...", "__sc_typing");
        sendBtn.disabled = true;
        input.disabled = true;
        try {
          const resp = await fetch(`${API}/chat/ask`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ session_id: sessionId, question: q }),
          });
          typing.remove();
          if (!resp.ok) {
            const err = await resp.text().catch(() => "");
            addMessage("Error: " + (err || resp.status), "__sc_msg_bot");
          } else {
            const data = await resp.json();
            addMessage(data.answer, "__sc_msg_bot");
          }
        } catch (e) {
          typing.remove();
          addMessage("Error: " + e.message, "__sc_msg_bot");
        }
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      }

      sendBtn.addEventListener("click", sendQuestion);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
      });
      input.addEventListener("focus", () => { input.style.borderColor = "#4285f4"; });
      input.addEventListener("blur", () => { input.style.borderColor = "#ddd"; });

      function enableInput() {
        body.innerHTML = "";
        addMessage("PDF ready! Ask me anything about this document.", "__sc_msg_bot");
        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = "1";
        input.focus();
      }

      (async () => {
        try {
          let data;
          if (existingSourceId) {
            const fd = new FormData();
            fd.append("source_id", existingSourceId);
            const resp = await fetch(`${API}/chat/start-from-source`, { method: "POST", body: fd, headers: authHeaders });
            if (!resp.ok) throw new Error("Server error " + resp.status);
            data = await resp.json();
          } else {
            const pdfResp = await fetch(location.href, { credentials: "include" });
            if (!pdfResp.ok) throw new Error("Could not fetch PDF");
            const blob = await pdfResp.blob();
            const fname = location.pathname.split("/").pop() || "document.pdf";
            const fd = new FormData();
            fd.append("file", blob, fname);
            const resp = await fetch(`${API}/chat/start`, { method: "POST", body: fd, headers: authHeaders });
            if (!resp.ok) throw new Error("Server error " + resp.status);
            data = await resp.json();
          }
          sessionId = data.session_id;
          enableInput();
        } catch (e) {
          body.innerHTML = "";
          addMessage("Failed to start chat: " + e.message, "__sc_msg_bot");
        }
      })();
    },
    args: [apiBase, preSourceId, authToken],
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// PDF detection
// ---------------------------------------------------------------------------
function isLikelyPdfUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes("_report.") || lower.includes("_slides.") ||
      lower.includes("_podcast.") || lower.includes("_quiz.") ||
      lower.includes("_export_docs")) return false;
  if (lower.endsWith(".pdf")) return true;
  if (lower.includes(".pdf?") || lower.includes(".pdf#")) return true;
  return false;
}

async function isPdfContentType(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType === "application/pdf",
    });
    return Boolean(result?.result);
  } catch {
    return false;
  }
}

async function isPdfTab(tab) {
  if (!tab || !tab.url) return false;
  if (!tab.url.startsWith("http://") && !tab.url.startsWith("https://")) return false;
  if (isLikelyPdfUrl(tab.url)) return true;
  return isPdfContentType(tab.id);
}

// ---------------------------------------------------------------------------
// Badge + keep-alive
// ---------------------------------------------------------------------------
function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
}

function stopKeepAlive() {
  if (keepAliveInterval && activeRequests === 0) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

async function checkServerHealth() {
  try {
    const api = await getApiBase();
    const resp = await fetch(`${api}/health`, { signal: AbortSignal.timeout(4000) });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pre-upload — fetch PDF + upload to NotebookLM while the chooser is visible
// ---------------------------------------------------------------------------
function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "document.pdf";
    return seg.includes(".") ? seg : `${seg}.pdf`;
  } catch {
    return "document.pdf";
  }
}

async function doPreUpload(url) {
  const api = await getApiBase();
  const resp = await fetchWithTimeout(url, { credentials: "include" }, 60000);
  if (!resp.ok) throw new Error("Could not fetch PDF");
  const blob = await resp.blob();
  const fname = fileNameFromUrl(url);
  const fd = new FormData();
  fd.append("file", blob, fname);
  const apiResp = await fetchWithTimeout(`${api}/pre-upload`, { method: "POST", body: fd }, 300000);
  if (!apiResp.ok) throw new Error("Pre-upload failed: " + apiResp.status);
  return await apiResp.json();
}

function startPreUpload(url) {
  if (preUploadCache.has(url)) return;
  const entry = { promise: null, sourceId: null, status: "pending" };
  entry.promise = doPreUpload(url)
    .then((data) => {
      entry.sourceId = data.source_id;
      entry.status = "done";
      console.log("[Summariser] Pre-upload done:", data.source_id);
      return data;
    })
    .catch((err) => {
      entry.status = "error";
      console.warn("[Summariser] Pre-upload failed:", err.message);
      throw err;
    });
  preUploadCache.set(url, entry);
}

// ---------------------------------------------------------------------------
// File generation — fast path uses pre-uploaded source, fallback does full upload
// ---------------------------------------------------------------------------
async function processPdf(tab, outputType) {
  const cacheKey = `${tab.id}:${tab.url}:${outputType}`;
  if (processedTabs.has(cacheKey)) {
    console.log("Already processed, skipping:", tab.url, outputType);
    return;
  }
  processedTabs.add(cacheKey);

  const label = LABEL_MAP[outputType] || outputType;
  const api = await getApiBase();

  const healthy = await checkServerHealth();
  if (!healthy) {
    setBadge(tab.id, "OFF", "#888888");
    showToast(tab.id, "Server is offline \u2014 start the backend first.", "warn");
    processedTabs.delete(cacheKey);
    return;
  }

  activeRequests++;
  startKeepAlive();

  try {
    setBadge(tab.id, "...", "#FFA500");
    showToast(tab.id, `Generating ${label}\u2026 this may take a few minutes.`, "info");

    let apiResp = null;

    // --- FAST PATH: use pre-uploaded source ---------------------------------
    const cached = preUploadCache.get(tab.url);
    if (cached) {
      if (cached.status === "pending") {
        try { await cached.promise; } catch { /* fall through to slow path */ }
      }
      if (cached.status === "done" && cached.sourceId) {
        setBadge(tab.id, "GEN", "#FFA500");
        const fd = new FormData();
        fd.append("source_id", cached.sourceId);
        fd.append("output_type", outputType);
        try {
          apiResp = await fetchWithRetry(`${api}/generate`, { method: "POST", body: fd }, 1, 300000);
          if (!apiResp.ok) {
            console.warn("[Summariser] Fast path failed:", apiResp.status, "— falling back");
            apiResp = null;
          }
        } catch {
          apiResp = null;
        }
      }
    }

    // --- SLOW PATH: full upload fallback ------------------------------------
    if (!apiResp) {
      setBadge(tab.id, "UPL", "#FFA500");
      const response = await fetchWithTimeout(tab.url, { credentials: "include" }, 60000);
      if (!response.ok) {
        setBadge(tab.id, "ERR", "#FF0000");
        showToast(tab.id, "Could not fetch the PDF from this tab.", "error");
        return;
      }
      const blob = await response.blob();
      const fname = fileNameFromUrl(tab.url);
      const formData = new FormData();
      formData.append("file", blob, fname);
      formData.append("output_type", outputType);

      setBadge(tab.id, "API", "#FFA500");
      apiResp = await fetchWithRetry(`${api}/summarise-pdf`, { method: "POST", body: formData }, 1, 300000);
    }

    if (!apiResp || !apiResp.ok) {
      const detail = apiResp ? await apiResp.text().catch(() => "") : "";
      setBadge(tab.id, "ERR", "#FF0000");
      showToast(tab.id, `API error${apiResp ? ` (${apiResp.status})` : ""}. Check the server terminal.`, "error");
      return;
    }

    // --- Download the result ------------------------------------------------
    const summaryBlob = await apiResp.blob();
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve) => {
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(summaryBlob);
    });

    const ext = EXTENSION_MAP[outputType] || "pdf";
    const stem = fileNameFromUrl(tab.url).replace(/\.pdf$/i, "");
    const suggestedName = `${stem}_${outputType}.${ext}`;

    const downloadId = await new Promise((resolve) => {
      chrome.downloads.download(
        { url: dataUrl, filename: suggestedName, saveAs: false },
        resolve,
      );
    });

    if (downloadId) {
      setBadge(tab.id, "OK", "#00AA00");
      showToast(tab.id, `${label} ready! Downloaded: ${suggestedName}`, "success");
    } else {
      setBadge(tab.id, "ERR", "#FF0000");
      showToast(tab.id, "Download failed \u2014 Chrome could not save the file.", "error");
    }
  } catch (err) {
    setBadge(tab.id, "ERR", "#FF0000");
    showToast(tab.id, `Error: ${err.message || "Something went wrong."}`, "error");
  } finally {
    activeRequests--;
    stopKeepAlive();
  }
}

// ---------------------------------------------------------------------------
// Export to Google Docs — generates a report and exports to user's Drive
// ---------------------------------------------------------------------------
async function processExportToDocs(tab) {
  const api = await getApiBase();
  const healthy = await checkServerHealth();
  if (!healthy) {
    setBadge(tab.id, "OFF", "#888888");
    showToast(tab.id, "Server is offline \u2014 start the backend first.", "warn");
    return;
  }

  activeRequests++;
  startKeepAlive();

  try {
    setBadge(tab.id, "...", "#FFA500");
    showToast(tab.id, "Exporting report to Google Docs\u2026 this may take a few minutes.", "info");

    const cached = preUploadCache.get(tab.url);
    if (cached?.status === "pending") {
      try { await cached.promise; } catch { /* fall through */ }
    }

    let sourceId = cached?.status === "done" ? cached.sourceId : null;

    if (!sourceId) {
      setBadge(tab.id, "UPL", "#FFA500");
      const resp = await fetchWithTimeout(tab.url, { credentials: "include" }, 60000);
      if (!resp.ok) {
        setBadge(tab.id, "ERR", "#FF0000");
        showToast(tab.id, "Could not fetch the PDF from this tab.", "error");
        return;
      }
      const blob = await resp.blob();
      const fd = new FormData();
      fd.append("file", blob, fileNameFromUrl(tab.url));
      const uploadResp = await fetchWithRetry(`${api}/pre-upload`, { method: "POST", body: fd }, 1, 300000);
      if (!uploadResp.ok) {
        setBadge(tab.id, "ERR", "#FF0000");
        showToast(tab.id, "Upload failed. Check the server terminal.", "error");
        return;
      }
      const uploadData = await uploadResp.json();
      sourceId = uploadData.source_id;
    }

    setBadge(tab.id, "EXP", "#34A853");
    const fd = new FormData();
    fd.append("source_id", sourceId);
    const apiResp = await fetchWithRetry(`${api}/export-to-docs`, { method: "POST", body: fd }, 1, 300000);

    if (!apiResp.ok) {
      setBadge(tab.id, "ERR", "#FF0000");
      showToast(tab.id, "Export failed. Check the server terminal.", "error");
      return;
    }

    const data = await apiResp.json();
    setBadge(tab.id, "OK", "#00AA00");

    if (data.doc_url) {
      chrome.tabs.create({ url: data.doc_url });
      showToast(tab.id, `Exported to Google Docs: ${data.title}`, "success");
    } else {
      showToast(tab.id, "Report exported! Check your Google Docs.", "success");
    }
  } catch (err) {
    setBadge(tab.id, "ERR", "#FF0000");
    showToast(tab.id, `Error: ${err.message || "Something went wrong."}`, "error");
  } finally {
    activeRequests--;
    stopKeepAlive();
  }
}

// ---------------------------------------------------------------------------
// Listen for user choices from the in-page chooser
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "checkNlmAuth") {
    isLoggedIn().then((loggedIn) => sendResponse({ loggedIn }));
    return true;
  }
  if (msg.action === "openChooser" && msg.tabId) {
    chrome.tabs.get(msg.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      startPreUpload(tab.url);
      showChooser(tab.id);
    });
    return;
  }
  if (!sender.tab) return;
  if (msg.action === "generate") {
    processPdf(sender.tab, msg.outputType);
  } else if (msg.action === "chat") {
    startKeepAlive();
    const cached = preUploadCache.get(sender.tab.url);
    const sourceId = cached?.status === "done" ? cached.sourceId : null;
    getApiBase().then((api) => injectChatWidget(sender.tab.id, api, sourceId));
  } else if (msg.action === "export_docs") {
    processExportToDocs(sender.tab);
  }
});

// ---------------------------------------------------------------------------
// Detect PDF tabs — show chooser + start pre-upload simultaneously
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab || tab.id !== tabId) return;

  const { enabled } = await chrome.storage.sync.get({ enabled: true });
  if (!enabled) return;

  const hasPerms = await chrome.permissions.contains({
    origins: ["https://*/*", "http://*/*"],
  });
  if (!hasPerms) return;

  if (await isPdfTab(tab)) {
    startPreUpload(tab.url);

    const key = `${tab.id}:${tab.url}`;
    if (chooserShownTabs.has(key)) return;
    chooserShownTabs.add(key);
    showChooser(tabId);
  }
});

// ---------------------------------------------------------------------------
// Tab close — clean up caches + tell backend to delete the pre-uploaded source
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of processedTabs) {
    if (key.startsWith(`${tabId}:`)) processedTabs.delete(key);
  }

  for (const key of chooserShownTabs) {
    if (key.startsWith(`${tabId}:`)) {
      const url = key.slice(key.indexOf(":") + 1);
      chooserShownTabs.delete(key);

      const cached = preUploadCache.get(url);
      if (cached?.sourceId) {
        const fd = new FormData();
        fd.append("source_id", cached.sourceId);
        Promise.all([getApiBase(), getAuthToken()]).then(([api, auth]) => {
          const headers = auth ? { "X-NLM-Auth": auth } : {};
          fetch(`${api}/cleanup-source`, { method: "POST", body: fd, headers }).catch(() => {});
        });
      }
      preUploadCache.delete(url);
    }
  }
});
