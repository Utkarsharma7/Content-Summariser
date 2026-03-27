# Render Deployment Guide

## Architecture

The backend is now **stateless regarding auth**. Each user's Chrome extension captures their own Google/NotebookLM cookies and sends them with every API request. The server creates per-user NotebookLM clients on-the-fly.

**You deploy once. No tokens to maintain. No cookies to refresh. Zero maintenance.**

## What End Users Do

1. Install the Chrome extension
2. Click extension icon → click "Login" → sign into Google on NotebookLM
3. Set the Backend API URL to your Render URL in the popup
4. Open a PDF → choose output → done

Each user uses their own Google account. Their session is managed entirely by their browser cookies.

## Deploy on Render

1. Push this project to GitHub.
2. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **Web Service**.
3. Connect the GitHub repo.
4. Settings:
   - Runtime: **Docker**
   - Branch: your deploy branch
   - Region: closest to users
5. Environment variables (minimal):
   - `ENV` = `production`
   - No `NOTEBOOKLM_AUTH_JSON` needed (auth comes from users)
   - Do not hardcode `PORT` (Render injects it)
6. Deploy.
7. Verify: `https://<your-service>.onrender.com/health` should return:
   ```json
   {"status": "ok", "auth_mode": "per-user", "active_user_sessions": 0}
   ```

## Connect Extension to Render Backend

1. Open extension popup
2. Set Backend API URL: `https://<your-service>.onrender.com`
3. Health status should show "Connected"
4. Test with any PDF

## How Per-User Auth Works

1. Extension uses `chrome.cookies.getAll({domain: ".google.com"})` to read cookies
2. Cookies are base64-encoded and sent as `X-NLM-Auth` header
3. Backend decodes, writes to temp file, creates `NotebookLMClient.from_storage()`
4. Client is cached by cookie hash for 1 hour of inactivity
5. Expired sessions are automatically cleaned up

## Session Expiry

If a user's Google session cookies expire (Google typically refreshes them automatically in an active browser), the user just needs to visit NotebookLM once in their browser to refresh cookies. No action needed from you.

## Optional: Global Fallback

If you set `NOTEBOOKLM_AUTH_JSON` on Render, the server will use it as a fallback for requests without the `X-NLM-Auth` header. This is optional and not recommended for production.
