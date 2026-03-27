# PDF Summariser — Browser Extension + NotebookLM API

Chrome extension + Python backend to summarise PDFs with NotebookLM.

## What It Does

- Detects PDF tabs in Chrome
- Lets user generate:
  - Report (PDF)
  - Presentation (PPTX)
  - Podcast (MP4)
  - Quiz (PDF)
  - Chat with PDF
  - Export report to Google Docs

## Architecture — Per-User Auth

Each user authenticates with their own Google account. No shared session on the server.

1. User installs the extension
2. First use: clicks "Login" in popup → opens NotebookLM in a new tab → signs into Google
3. Extension reads their Google cookies via `chrome.cookies` API
4. Every API request includes cookies as `X-NLM-Auth` header
5. Backend creates a per-user NotebookLM client, cached for 1 hour

**You (the developer) deploy the backend once. No session tokens to refresh. Ever.**

## Project Structure

- `extension/` - Chrome MV3 extension
- `summariser_api.py` - FastAPI backend
- `API/notebooklm-py/` - NotebookLM client library
- `Dockerfile` - container deployment
- `privacy-policy.html` - store privacy policy
- `store-listing.md` - Chrome Web Store listing copy

## Local Development

1. Create venv and install deps
2. Install local NotebookLM client package
3. Start API:

```bat
python -m uvicorn summariser_api:app --reload --port 8000
```

4. Load `extension/` as unpacked extension in `chrome://extensions`
5. Click extension icon → Login → sign into NotebookLM → done

The server no longer requires `NOTEBOOKLM_AUTH_JSON` — auth comes from each user's browser.

## Cloud Deployment

See `RENDER_DEPLOYMENT.md` for full Render deployment steps.
