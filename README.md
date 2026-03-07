# TextBridge Chrome Extension

TextBridge is a Manifest V3 Chrome extension for quick English vocabulary lookup while reading web pages and PDFs.

When you select text, it shows:
- English definition (+ phonetic when available)
- Native-script translation (Urdu and Hindi by default)
- Romanized transliteration
- Audio pronunciation (system TTS first, remote fallback)

It also stores lookup history locally and can sync that history to Google Sheets.

## Features

### 1. Selection-to-popup translation
- Works on normal web pages and inside the built-in TextBridge PDF viewer.
- Auto-detects text selection via mouse and keyboard selection changes.
- Popup includes:
  - Word
  - English definition
  - Two translation panes (language switchers: `en`, `ur`, `hi`)
  - Romanization text
  - Play-audio button per translation pane
  - History-saved indicator

### 2. Dictionary + translation + romanization pipeline
- Dictionary source: `https://api.dictionaryapi.dev`.
- Translation source: `https://translate.googleapis.com/translate_a/single`.
- Romanization parser for Urdu/Hindi with fallback back-translation logic when primary romanization is weak/unavailable.

### 3. Pronunciation with fallback
- First tries Chrome system TTS (`chrome.tts`) with language-aware voice scoring.
- For Urdu/Hindi, avoids obviously mismatched voices.
- Falls back to Google TTS endpoints and plays returned audio data.
- In-memory LRU audio cache to reduce repeated fetches.

### 4. PDF-focused reading mode
- Detects PDF navigations and redirects to `viewer.html` automatically.
- Supports:
  - Zoom controls
  - Page jump controls
  - OCR toggle (`TextDetector` API based)
  - Lite mode for low-resource devices
- For scanned/no-text-layer pages, double-click fallback can run local OCR and translate detected text.

### 5. History and persistence
- Every successful lookup is stored in local history (`lex_history`).
- Local history limit: 500 entries.
- Translation response cache in storage with TTL and cap:
  - Key: `translationCacheV2`
  - Max entries: 50
  - TTL: 7 days
- Remembers selected target languages and PDF viewer mode toggles.

### 6. Google Sheets sync (optional)
- Options page supports:
  - Spreadsheet ID (or full URL)
  - Detailed sheet tab name
  - Quick revision sheet tab name
  - Enable/disable auto-sync
  - Local history mode: `hybrid` or `sheet_only`
- Uses `chrome.identity` OAuth and Sheets API.
- Maintains two tabs:
  - Detailed tab headers: `word, definition, ur, hi, timestamp, url`
  - Quick tab headers: `En, Ur, Hi`
- Manual sync deduplicates existing sheet rows before append.

### 7. Runtime hardening
- Retry logic and request timeouts for translation/audio APIs.
- Inflight translation de-duplication to avoid duplicate concurrent requests for same term/lang pair.
- Dynamic `declarativeNetRequest` rules to improve PDF/TTS compatibility.

## Tech Stack

- Chrome Extension Manifest V3
- Plain JavaScript (no bundler/build step)
- PDF.js (`pdfjs-dist`)
- Chrome extension APIs:
  - `storage`, `identity`, `tts`, `webNavigation`, `declarativeNetRequest`, `tabs`

## Project Structure

```text
.
|-- manifest.json
|-- background.js
|-- content.js
|-- viewer.html
|-- viewer.js
|-- styles.css
|-- options.html
|-- options.js
|-- services/
|   |-- translation-service.js
|   |-- romanization-service.js
|   |-- pronunciation-service.js
|   `-- sheets-history-service.js
|-- tests/
|   |-- romanization-service.test.js
|   `-- fixtures/romanization/*.json
`-- pdfjs/
    |-- pdf.min.js
    |-- pdf.worker.min.js
    `-- pdf_viewer.js
```

## Local Setup

### Prerequisites
- Google Chrome (latest stable recommended)
- Node.js 18+ and npm (for tests only)

### 1. Install dependencies

```bash
npm install
```

### 2. Create your local env file

```bash
copy .env.example .env
```

Update `.env` with your real OAuth project/client values.

### 3. Generate runtime config + manifest from `.env`

```bash
npm run build:config
```

This command:
- Validates critical values (OAuth ID format + HTTPS-only endpoints)
- Generates `manifest.json` from `manifest.template.json`
- Generates `services/runtime-config.js`

### 4. Load extension in Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder:
   - `d:\Ramzan_Khan\Projects\multi-translate-extension`

### 5. Enable local PDF access (important)
1. In `chrome://extensions`, open TextBridge details.
2. Enable **Allow access to file URLs**.

Without this, local `file:///...pdf` translation in the custom viewer can fail.

### 6. Basic verification
1. Open any web page with English text.
2. Select a word (2-180 chars recommended).
3. Confirm popup shows definition, Urdu/Hindi translations, and romanization.
4. Click speaker icon to test pronunciation.
5. Open a PDF URL and confirm it redirects to TextBridge viewer (`viewer.html?...`).

## Google Sheets Sync Setup (Optional)

If you only need translation, skip this section.

### A. Prepare a spreadsheet
1. Create a Google Sheet.
2. Copy either:
   - Spreadsheet ID, or
   - Full sheet URL

TextBridge can parse both.

### B. OAuth client configuration

The extension uses `chrome.identity` + manifest `oauth2.client_id`.  
If auth fails for your local install, create/use your own OAuth client and update `manifest.json`.

Checklist:
1. Google Cloud project with **Google Sheets API** enabled.
2. OAuth consent screen configured.
3. OAuth client created for Chrome extension usage (label can vary by Google UI, e.g. Chrome Extension/Chrome App).
4. Client ID placed in:
   - `manifest.json` -> `oauth2.client_id`
5. Reload extension after editing manifest.

### C. Configure in extension options
1. Open extension options page:
   - Click extension details -> **Extension options** (or visit `options.html` through the extension).
2. Set:
   - Spreadsheet ID or URL
   - Detailed tab name (default: `TextBridge History`)
   - Quick tab name (default: `TextBridge Quick`)
3. Click **Connect Google**.
4. Enable **automatic sync** if desired.
5. Click **Sync Existing History Now** for one-time backfill.

### D. Local history modes
- `hybrid`:
  - Keep local history after sync.
- `sheet_only`:
  - Remove local history entries after successful sheet sync.

## How It Works

1. User selects text.
2. `content.js` sends `QUERY_TRANSLATION` to background.
3. Background resolves:
   - Dictionary definition/phonetic
   - Two target translations
   - Romanization (with fallback logic)
4. Background stores history and returns payload.
5. Popup renders and supports language switching + pronunciation.

## Development

### Run tests

```bash
npm test
```

Current test suite covers romanization parser behavior using JSON fixtures.

### Useful checks

```bash
npm run check:config
node --check background.js
node --check content.js
node --check viewer.js
node --check options.js
```

## Storage Keys (Local)

- `lang1`, `lang2`
- `translationCacheV2`
- `lex_history`
- `sheets_sync_enabled`
- `sheets_spreadsheet_id`
- `sheets_sheet_name`
- `sheets_simple_sheet_name`
- `sheets_local_history_mode`
- `pdf_ocr_enabled`
- `pdf_low_resource_mode`

## Permissions Overview

Key permissions in `manifest.json` and why:

- `storage`: language preferences, cache, history, sync settings
- `identity`: Google OAuth for Sheets
- `tts`: system voice playback
- `webNavigation` + `tabs` + `activeTab`: PDF detection and redirect to custom viewer
- `declarativeNetRequest` (+ host access): compatibility header modifications for PDF/TTS requests
- Host permissions:
  - `translate.googleapis.com`
  - `translate.google.com`
  - `api.dictionaryapi.dev`
  - `sheets.googleapis.com`
  - `<all_urls>` for content script selection support

## Security Model

- Credential/config handling:
  - `.env` is local-only and ignored by git.
  - `.env.example` is safe template-only.
  - Build step injects config into generated files; no runtime `.env` access is needed.
- Transport encryption:
  - External API traffic uses HTTPS endpoints.
  - Build validation rejects non-HTTPS endpoint configuration.
- Important boundary:
  - Translation requires sending selected text to external providers (`Google Translate`, `dictionaryapi.dev`), so true zero-knowledge end-to-end encryption with those providers is not possible in this architecture.

## Troubleshooting

### Popup not showing
- Ensure selected text length is between 2 and 180 characters.
- Reload extension after code changes.
- Check page is not blocked by browser/extension restrictions.

### Local PDF lookup not working
- Enable **Allow access to file URLs** in extension details.
- Reload the PDF tab.

### OCR toggle disabled or OCR unavailable
- Browser may not support `TextDetector`.
- Use regular text selection if PDF has selectable text layer.

### Google auth/sync fails
- Verify `oauth2.client_id` and Sheets API setup.
- Confirm spreadsheet is accessible by signed-in Google account.
- Reconnect Google from options page.

### Audio unavailable
- Some environments block autoplay/remote audio.
- Try clicking speaker button again after interacting with page.

## Limitations

- Built-in language support is focused on `en`, `ur`, and `hi`.
- History currently has no dedicated in-extension browsing UI; it is stored locally and/or synced to Sheets.
- OCR quality depends on browser support and scan quality.

## License

Package metadata is currently set to `ISC` in `package.json`.
