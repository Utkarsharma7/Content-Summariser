const DEFAULT_API_URL = "http://localhost:8000";

const toggle = document.getElementById("enabledToggle");
const apiInput = document.getElementById("apiUrlInput");
const apiStatus = document.getElementById("apiStatus");
const summariseBtn = document.getElementById("summariseBtn");
const btnHint = document.getElementById("btnHint");
const authDot = document.getElementById("authDot");
const authLabel = document.getElementById("authLabel");
const loginBtn = document.getElementById("loginBtn");
const authHint = document.getElementById("authHint");

let debounceTimer = null;

// ---------------------------------------------------------------------------
// NotebookLM auth check
// ---------------------------------------------------------------------------
function setAuthUI(loggedIn) {
  if (loggedIn) {
    authDot.className = "status-dot ok";
    authLabel.textContent = "Logged in to NotebookLM";
    loginBtn.style.display = "none";
    authHint.style.display = "none";
  } else {
    authDot.className = "status-dot err";
    authLabel.textContent = "Not logged in";
    loginBtn.style.display = "inline-block";
    loginBtn.textContent = "Login";
    authHint.style.display = "block";
    authHint.textContent = "Sign in to your Google account on NotebookLM to use this extension.";
  }
}

async function checkAuth() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: "checkNlmAuth" });
    setAuthUI(resp?.loggedIn === true);
  } catch {
    setAuthUI(false);
  }
}

checkAuth();

loginBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://notebooklm.google.com" });
  loginBtn.textContent = "Logging in...";
  authHint.textContent = "Sign in on the NotebookLM tab, then come back here.";

  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const resp = await chrome.runtime.sendMessage({ action: "checkNlmAuth" });
      if (resp?.loggedIn) {
        clearInterval(poll);
        setAuthUI(true);
      }
    } catch { /* keep polling */ }
    if (attempts > 60) clearInterval(poll);
  }, 3000);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
chrome.storage.sync.get({ enabled: true, apiUrl: DEFAULT_API_URL }, (data) => {
  toggle.checked = data.enabled;
  apiInput.value = data.apiUrl;
  checkHealth(data.apiUrl);
});

toggle.addEventListener("change", async () => {
  if (toggle.checked) {
    const granted = await chrome.permissions.request({
      origins: ["https://*/*", "http://*/*"],
    });
    if (!granted) {
      toggle.checked = false;
      return;
    }
  }
  chrome.storage.sync.set({ enabled: toggle.checked });
});

apiInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const url = apiInput.value.trim().replace(/\/+$/, "");
    if (!url) return;
    chrome.storage.sync.set({ apiUrl: url });
    checkHealth(url);
  }, 600);
});

async function checkHealth(baseUrl) {
  apiStatus.textContent = "Checking...";
  apiStatus.className = "api-status";
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      apiStatus.textContent = "Connected";
      apiStatus.className = "api-status ok";
    } else {
      apiStatus.textContent = "Server returned " + resp.status;
      apiStatus.className = "api-status err";
    }
  } catch {
    apiStatus.textContent = "Cannot reach server";
    apiStatus.className = "api-status err";
  }
}

async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    const url = tab.url.toLowerCase();
    const isPdf = url.endsWith(".pdf") || url.includes(".pdf?") || url.includes(".pdf#");
    let isPdfContent = false;
    if (!isPdf && tab.id) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.contentType === "application/pdf",
        });
        isPdfContent = Boolean(result?.result);
      } catch { /* ignore */ }
    }
    if (isPdf || isPdfContent) {
      summariseBtn.disabled = false;
      btnHint.textContent = "Opens the output chooser on this PDF";
    }
  } catch { /* ignore */ }
}

checkActiveTab();

summariseBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.runtime.sendMessage({ action: "openChooser", tabId: tab.id });
  window.close();
});
