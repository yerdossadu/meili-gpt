## Local copy instructions

This is Meili GPT. Only edit D:\Meili GPT. The root AGENTS.md and user instructions take precedence over historical source paths below. Do not edit source projects or publish to Cloud. Local studio port is 4180, PDF 4181, OCR 4182; platform is study/ on port 8010.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Forma Studio is a local, single-user multimedia console (Node, no build step, no package.json) for an HSK Chinese teacher. It turns textbook PDFs into web pages ("PDF → Web"), makes first frames and short clips for the pages, and publishes the pages to the separate learning platform **Meili HSK Study**: a FastAPI app on port 8010, in its own repo `D:\Forma\GitHub\chao-hsk-study`. The UI text and the user are Russian.

## Run and check

- Start: `start-forma-studio.bat`. It starts the PDF/OCR helper (`start-pdf-renderer.ps1`: `pdf-renderer.mjs` + PaddleOCR `pdf-ocr.py`), then `node --use-system-ca server.mjs`.
  - Set `PORT=4174`, otherwise the server listens on 4173.
  - Node is the Codex runtime at `%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.
  - FFmpeg lives in `.tools\ffmpeg\`.
- **Restarting the studio drops every API key** (OpenRouter, Alibaba, OpenAI). Keys are held only in server memory, and the user re-enters them in the UI. After a restart, also re-send the platform publish token: `PUT /local/webbook/platform {token}`. Never type the user's keys yourself.
- There are no tests or linter. Before committing, run:
  - `node --check <file>` for every edited `.js`/`.mjs` file;
  - a syntax check of the inline scripts in `index.html`.
- Converter regression (golden pages): `node webbook/regress.mjs [--book <id>] [--accept] [pages...]`.
  - It rebuilds approved pages from cached OCR and model answers, without calling a model.
  - It exits 1 if a page or a region of it scores worse than the baseline.
  - Run it after changing `webbook/core.mjs`, `webbook/server.mjs` or `components.css`.
- Eye check of one page: `node webbook/snapshot.mjs <bookId> <page> [out.png]` (studio must be running) puts the render beside the scan.
- Character reference library: `node webbook/build-character-refs.cjs "<Desktop>\Референсы персонажей" .` rebuilds `library/character-refs/manifest.json`. The studio re-imports it into the character cards when the manifest version changes.

## Architecture

- **`server.mjs`**: an HTTP server bound to 127.0.0.1. It serves the static UI and holds the keys. Its main routes:
  - proxies to OpenRouter;
  - `/local/alibaba/*`: Alibaba DashScope "Token Plan". The body is read once and the request is retried only on connection errors, never after a timeout, so it is not paid twice;
  - `/local/openai*`: the user's own OpenAI key (chat completions, GPT Image edits and generations).

  It mounts `webbook/server.mjs` (`createWebbook`) and `ailog.mjs` (`createAiLog`).
- **`webbook/`**: the PDF → Web converter.
  - `core.mjs` does layout snapping, block types and rendering. `render()` / `pageDocument()` produce the page HTML from `layout.json`.
  - `fidelity.mjs` scores a render against the scan.
  - `server.mjs` handles per-page jobs (convert, clip, clip poster, publish) under `/local/webbook/books/<id>/pages/<n>/...`.
  - Data lives in `library/<bookId>/pages/<NNN>/` (`scan.png`, OCR, model answer, `layout.json`, `index.html`, `clip.*`, `published.json`). `library/` is git-ignored.
  - Books: textbook `25d1aad102e4`, workbook `8bf3af15d090`.
  - `core.mjs` is loaded once per server process: markup changes need a studio restart, then each page's `index.html` must be regenerated. A `clip-poster` PUT re-renders the page and auto-republishes it to the platform.
  - Published pages on the platform must work without `<script>` (the platform rejects it), so interactive bits (clip play/zoom) are inline `on*` handlers built as strings in `core.mjs`.
- **Client** (plain scripts loaded by `index.html`; the inline app in `index.html` owns model catalogs, the key modal and `fillSelects`):
  - `script-workbench.js` is the big one: «Учебник HSK» / multimedia textbook page cards. It covers first frame → clip → «Режиссёр GPT» prompt → sync to the web page and the platform, plus the job status tray (`trayJob`) and resuming unfinished Alibaba clip tasks (`p.pendingClip`).
  - `textbook-brief.js` (`window.FormaBrief`) builds the page brief and the prompts (start frame, video JSON, spoken lines Chinese-only).
  - `alibaba.js` (`FormaAlibaba`) and `openai.js` (`FormaOpenAI`) adapt each provider to the OpenRouter answer shapes (`images`, `startVideo`/`poll`/`content`).
  - `ai-log.js` / `ailog.mjs` form the «Анализ AI» journal: every generation is stored in `library/ai-log` with its prompt, and the user's ratings and comments are the evidence for prompt decisions.
- **State lives in the user's browser, not on disk**: localStorage `forma.textbookStudio.v1` and IndexedDB `forma-hsk-script-workbench`. The IndexedDB keys look like `character:<id>`, `page-frame:first_frame:<pageId>`, `page-video:<pageId>`. Server-side scripts cannot read first frames or card data; fixes that need them must run in the client.

## Conventions and pitfalls

- Files are CRLF. Scripted replacements must normalise line endings, or the match silently fails.
- Editing JS from PowerShell: never put JS in double-quoted PS strings, because `$x` and `${...}` get interpolated and empty out template literals. Use single-quoted here-strings that write a small Node script, or the Edit tool.
- Avoid ASCII apostrophes inside single-quoted JS strings in prompts (`course's`); use `’`.
- Platform work: logic goes to the base repo `D:\Forma\GitHub\chao-hsk-study` (port 8010, `app.html`, `forma.py`). Design work goes only to the copy `D:\Forma\GitHub\chao-hsk-study-design` (port 8011, branch `design/light-ui`).
- Commit locally when a change is done and checked. Push, merge and deploy only on the user's explicit OK.
- After converting or rebuilding pages, re-check their scores and errors automatically. Look closely only at the pages the user names (5–6 a day at most).
