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
1. Open any PDF in Chrome
2. Click the extension icon or let auto-detect open the chooser
3. Pick your output type
4. The extension sends the PDF to your backend server, which uses NotebookLM to generate the output
5. Your file downloads automatically

SETUP
This extension requires a backend server running the PDF Summariser API (powered by the notebooklm-py library). You can:
- Run the server locally on your machine
- Deploy it to a cloud service like Railway or Render

Configure the backend URL in the extension popup settings.

FEATURES
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

1. **Chooser Modal** (1280x800): Open a PDF in Chrome, show the dark-themed chooser modal with all 6 options visible
2. **Popup Settings** (1280x800): Show the extension popup with the toggle, API URL field, and "Connected" status
3. **Chat Widget** (1280x800): Show the floating chat widget on a PDF page with a conversation
4. **Toast Notification** (1280x800): Show the green "Ready! Downloaded:" success toast on a PDF page

Tips for screenshots:
- Use a clean browser window with minimal tabs
- Make sure the PDF content behind the modal is visible and readable
- Use a real PDF (e.g., a research paper) for authenticity
