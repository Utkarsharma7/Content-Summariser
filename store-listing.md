# Chrome Web Store Listing

## Name
NotebookLM PDF Summariser

## Short Description (132 chars max)
Summarise any PDF with Google NotebookLM — generate reports, slide decks, podcasts, quizzes, or chat with your documents.

## Detailed Description

Turn any PDF into actionable content with the power of Google NotebookLM.

When you open a PDF in your browser, this extension lets you instantly generate:

- Summary Report — A comprehensive briefing document with executive summary, key sections, data highlights, and takeaways (PDF)
- Presentation — A detailed slide deck ready for meetings or study (PPTX)
- Podcast — An engaging audio discussion covering the document's key points (MP4)
- Quiz — Multiple-choice questions with answer key to test your understanding (PDF)
- Chat — Ask follow-up questions about the document in a floating chat widget
- Google Docs Export — Send the report directly to your Google Drive

HOW IT WORKS
1. Install the extension and click "Login" to sign into your Google/NotebookLM account
2. Open any PDF in Chrome
3. Click the extension icon or let auto-detect open the chooser
4. Pick your output type
5. Your file downloads automatically

Each user authenticates with their own Google account. No shared credentials, no setup complexity.

FEATURES
- One-click Google/NotebookLM login from the extension popup
- Auto-detects PDFs in any tab (optional, with your permission)
- Pre-uploads PDFs while you choose, so generation starts instantly
- Beautiful dark-themed chooser UI
- Floating chat widget for multi-turn conversations
- Works with any PDF served over HTTP/HTTPS
- Configurable backend URL

## Category
Productivity

## Language
English

## Screenshots Needed (capture these manually)

1. **Chooser Modal** (1280x800): Open a PDF, show the dark-themed chooser modal with all 6 options
2. **Popup Settings** (1280x800): Show extension popup with login status, toggle, API URL, "Connected"
3. **Chat Widget** (1280x800): Show the floating chat widget on a PDF with a conversation
4. **Toast Notification** (1280x800): Show the green "Ready! Downloaded:" success toast

Tips:
- Use a clean browser window with minimal tabs
- Make sure the PDF content behind the modal is visible
- Use a real PDF (e.g., a research paper) for authenticity
- Screenshots must be exactly 1280x800 or 640x400

## Permission Justifications (for Chrome Web Store review)

### cookies
Used to read Google session cookies for NotebookLM authentication. The extension reads cookies from the .google.com domain so users can authenticate with their own Google account. No cookies are stored persistently — they are read on-demand and sent to the backend API for processing.

### tabs
Used to detect when the user navigates to a PDF tab, enabling auto-detection of PDF files for summarisation.

### activeTab
Used to inject the output chooser UI and toast notifications into the currently active PDF tab when the user interacts with the extension.

### scripting
Used to inject the chooser modal, chat widget, and toast notifications into web pages containing PDFs.

### downloads
Used to save generated output files (reports, presentations, podcasts, quizzes) to the user's computer.

### storage
Used to persist user preferences: auto-detect toggle state and backend API URL.

### Host permission (*://*.google.com/*)
Required by the cookies API to read Google session cookies for NotebookLM authentication.

### Host permission (https://notebooklm-summariser-api.onrender.com/*)
Allows the extension to call the configured backend API (upload PDFs, generate outputs, chat) without browser CORS blocking. This is the default production API URL; users may change the API URL in settings if they self-host.

### Optional host permissions (https://*/* and http://*/*)
Requested only when the user enables "Auto-detect PDFs." Allows the extension to detect and interact with PDFs on any website. Not granted by default — the user must explicitly opt in.
