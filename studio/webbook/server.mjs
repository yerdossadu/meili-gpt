// Forma "PDF → Web" conversion service, mounted by server.mjs under
// /local/webbook/*. Every page is converted by the same pipeline:
//
//   1. render  — PDF page → PNG scan (pdf.js + @napi-rs/canvas, 288 dpi)
//   2. ocr     — local PaddleOCR service (port 4182) → exact line boxes
//   3. model   — OpenRouter vision model → blocks, text, translation (cached)
//   4. layout  — snap blocks to OCR + pixels, sample colours and font sizes
//   5. assets  — cut photos and avatars out of the scan (WebP)
//   6. html    — standalone page for the learning platform
//
// Results live on disk in library/<book>/pages/<nnn>/ so they survive the
// browser and can be inspected or re-derived without new paid requests.

import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as core from './core.mjs';

const RUNTIME = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
const OCR_URL = process.env.FORMA_OCR_URL || 'http://127.0.0.1:4182/ocr';
const SCAN_DPI = 288;
const STEPS = [['render', 'Рендер страницы PDF'], ['ocr', 'Локальный OCR'], ['model', 'Разметка моделью'], ['layout', 'Привязка к скану'], ['assets', 'Картинки'], ['html', 'HTML-страница']];

let canvasPromise, pdfjsPromise;
const canvasLib = () => (canvasPromise ||= import(pathToFileURL(join(RUNTIME, '@napi-rs', 'canvas', 'index.js')).href));
const pdfjsLib = () => (pdfjsPromise ||= (async () => {
  const canvas = await canvasLib();
  globalThis.DOMMatrix ||= canvas.DOMMatrix; globalThis.ImageData ||= canvas.ImageData; globalThis.Path2D ||= canvas.Path2D;
  return import(pathToFileURL(join(RUNTIME, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);
})());

const pad3 = n => String(n).padStart(3, '0');
const sendJson = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 1));
async function bodyJson(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Слишком большой запрос.'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createWebbook({ root, getApiKey }) {
  const LIB = join(root, 'library');
  const bookDir = id => join(LIB, id);
  const pageDir = (id, n) => join(LIB, id, 'pages', pad3(n));
  const docs = new Map();          // bookId → pdf.js document (kept open)
  const jobs = new Map();          // "id:n" → job
  const queue = [];                // pending job keys, processed one by one
  let working = false;

  async function openDoc(id) {
    if (docs.has(id)) return docs.get(id);
    const pdfjs = await pdfjsLib();
    const data = new Uint8Array(await readFile(join(bookDir(id), 'source.pdf')));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
    docs.set(id, doc);
    return doc;
  }

  async function renderPage(id, n, dpi) {
    const [{ createCanvas }, doc] = await Promise.all([canvasLib(), openDoc(id)]);
    if (n < 1 || n > doc.numPages) throw new Error(`В PDF ${doc.numPages} стр.; запрошена ${n}.`);
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
    page.cleanup();
    return canvas.encode('png');
  }

  async function ensureScan(id, n) {
    const dir = pageDir(id, n), file = join(dir, 'scan.png');
    if (!existsSync(file)) { await mkdir(dir, { recursive: true }); await writeFile(file, await renderPage(id, n, SCAN_DPI)); }
    return file;
  }

  async function ensureThumb(id, n) {
    const dir = pageDir(id, n), file = join(dir, 'thumb.png');
    if (!existsSync(file)) { await mkdir(dir, { recursive: true }); await writeFile(file, await renderPage(id, n, 30)); }
    return file;
  }

  // ---- pipeline steps ----

  async function stepOcr(dir, n, force) {
    const cached = !force && await readJson(join(dir, 'ocr.json'));
    if (cached?.lines?.length) return { ocr: cached, note: `из кэша, ${cached.lines.length} строк` };
    const png = await readFile(join(dir, 'scan.png'));
    let response;
    try { response = await fetch(`${OCR_URL}?page=${n}&dpi=${SCAN_DPI}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png, signal: AbortSignal.timeout(240000) }); }
    catch { throw new Error('Локальный OCR (порт 4182) не отвечает. Запустите студию через start-forma-studio.bat.'); }
    const ocr = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(ocr.error || `OCR вернул HTTP ${response.status}.`);
    if (!ocr.lines?.length) throw new Error('OCR не нашёл текста на странице.');
    await writeJson(join(dir, 'ocr.json'), ocr);
    return { ocr, note: `${ocr.lines.length} строк` };
  }

  async function stepModel(dir, model, force, scanImage) {
    const cached = await readJson(join(dir, 'model.json'));
    if (cached?.content && !force) return { answer: cached, note: `из кэша (${cached.model}), без запроса` };
    const key = getApiKey();
    if (!key) throw new Error('Ключ OpenRouter не подключён: добавьте его в «Настроить ключ».');
    if (!model) throw new Error('Выберите модель с поддержкой изображений.');
    // The model only needs to read the page, not measure it: a 1600 px JPEG
    // keeps text legible at a fraction of the tokens of the full scan.
    const { createCanvas } = await canvasLib();
    const w = Math.min(1600, scanImage.width), h = Math.round(scanImage.height * w / scanImage.width);
    const c = createCanvas(w, h); c.getContext('2d').drawImage(scanImage, 0, 0, w, h);
    const url = 'data:image/jpeg;base64,' + (await c.encode('jpeg', 88)).toString('base64');
    // Provider routing on OpenRouter fails transiently ("No endpoints found",
    // rate limits, 5xx); retry twice before reporting.
    const body = JSON.stringify({ model, temperature: 0.1, reasoning: { max_tokens: 2048 }, max_tokens: 16000, messages: [{ role: 'user', content: [{ type: 'text', text: core.PROMPT }, { type: 'image_url', image_url: { url } }] }] });
    let response, d;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 4000 * attempt));
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(300000), body,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-openrouter-title': 'Forma Studio PDF to Web' }
      });
      d = await response.json().catch(() => ({}));
      const transient = response.status === 429 || response.status >= 500 || /no endpoints found|overloaded|temporarily/i.test(d.error?.message || '');
      if (response.ok || !transient) break;
    }
    if (!response.ok) {
      const msg = d.error?.message || `OpenRouter вернул HTTP ${response.status}.`;
      throw new Error(/support image input/i.test(msg) ? `Модель ${model} сейчас не принимает изображения (${msg}). Выберите другую Vision-модель или повторите позже.` : msg);
    }
    const finish = d.choices?.[0]?.finish_reason;
    if (finish === 'length') throw new Error('Ответ модели обрезан. Выберите другую модель или повторите.');
    const answer = { model, content: d.choices?.[0]?.message?.content || '', cost: d.usage?.cost ?? null, finish, at: new Date().toISOString() };
    core.parseModelJson(answer.content); // fail now rather than in the next step
    await writeJson(join(dir, 'model.json'), answer);
    return { answer, note: `${model}${answer.cost != null ? `, $${Number(answer.cost).toFixed(4)}` : ''}` };
  }

  async function pixelGrid(image) {
    const { createCanvas } = await canvasLib();
    const W = Math.min(700, image.width), H = Math.round(image.height * W / image.width);
    const c = createCanvas(W, H), ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0, W, H);
    return core.gridFromRGBA(ctx.getImageData(0, 0, W, H).data, W, H);
  }

  async function writeAssets(dir, layout, image) {
    const { createCanvas } = await canvasLib();
    const assetsDir = join(dir, 'assets');
    // Preserve manually corrected crops and earlier source illustrations.
    await mkdir(assetsDir, { recursive: true });
    const files = {};
    for (const { key, box, transparent } of core.assetBoxes(layout)) {
      const x = Math.round(box.x * image.width), y = Math.round(box.y * image.height);
      const w = Math.round(box.w * image.width), h = Math.round(box.h * image.height);
      if (w < 4 || h < 4) continue;
      const c = createCanvas(w, h), ctx = c.getContext('2d');
      ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
      if (transparent) {
        // Page colour becomes transparent with a soft edge, so the cut-out
        // sits on the web page's own background without a visible box.
        const bg = core.backgroundAt(layout.theme, box.x + box.w / 2, box.y + box.h / 2);
        const data = ctx.getImageData(0, 0, w, h), px = data.data;
        // Marked graphics (arrows) often cross other blocks: keep only the
        // marks themselves, not what the components already draw — panel
        // fills under the box, dark text, and long straight borders.
        const marked = key.startsWith('deco-b');
        const hits = o => o.box.x < box.x + box.w && o.box.x + o.box.w > box.x && o.box.y < box.y + box.h && o.box.y + o.box.h > box.y;
        const fills = marked ? layout.blocks.filter(o => o.type !== 'decor' && o.fill && hits(o)).map(o => core.parseHex(o.fill)) : [];
        const near = (i, c) => Math.hypot(px[i] - c[0], px[i + 1] - c[1], px[i + 2] - c[2]);
        for (let i = 0; i < px.length; i += 4) {
          let a = Math.max(0, Math.min(255, Math.round((near(i, bg) - 22) * 6)));
          if (marked && (px[i] + px[i + 1] + px[i + 2] < 330 || fills.some(f => near(i, f) < 30))) a = 0;
          px[i + 3] = a;
        }
        if (marked) {
          // Arrow crops can overlap printed dialogue, whose dark text often
          // outnumbers the dashed stroke. Keep the page's accent ink instead
          // of choosing the most common colour, which used to erase the arrow.
          const ink = core.parseHex(layout.theme?.accent || '#dc6262');
          for (let i = 0; i < px.length; i += 4) if (px[i + 3] && near(i, ink) > 125) px[i + 3] = 0;
          // Borders of blocks crossed by the graphic are long thin lines,
          // often broken by anti-aliasing; dashes are short and thick. Remove
          // pixels on thin (≤ 0.15% of the page) runs longer than 3% of the
          // page, bridging gaps of a few pixels.
          const L = Math.round(image.width * 0.03), T = Math.max(2, Math.round(image.width * 0.0015)), gap = 3;
          const solid = new Uint8Array(w * h);
          for (let k = 0; k < w * h; k++) solid[k] = px[k * 4 + 3] > 40 ? 1 : 0;
          const thick = (x, y, dx, dy) => { let n = 1; for (const s of [-1, 1]) { let xx = x + dx * s, yy = y + dy * s; while (xx >= 0 && yy >= 0 && xx < w && yy < h && solid[yy * w + xx]) { n++; xx += dx * s; yy += dy * s; } } return n; };
          const clear = new Uint8Array(w * h);
          const sweep = (len, other, at, dx, dy) => {
            for (let o = 0; o < other; o++) {
              let start = -1, last = -1;
              const flush = () => { if (start >= 0 && last - start + 1 > L) for (let p = start; p <= last; p++) { const [x, y] = at(p, o); if (solid[y * w + x] && thick(x, y, dy, dx) <= T) clear[y * w + x] = 1; } start = -1; };
              for (let p = 0; p < len; p++) { const [x, y] = at(p, o); if (solid[y * w + x]) { if (start < 0 || p - last > gap) { flush(); start = p; } last = p; } }
              flush();
            }
          };
          sweep(w, h, (p, o) => [p, o], 1, 0);   // horizontal lines
          sweep(h, w, (p, o) => [o, p], 0, 1);   // vertical lines
          for (let k = 0; k < w * h; k++) if (clear[k]) { px[k * 4 + 3] = 0; solid[k] = 0; }
          // Leftover slivers of those lines are 1–2 px thick; the graphic's
          // own strokes (3 px and up on a 288 dpi scan) are kept.
          const sliver = Math.max(2, Math.round(image.width * 0.0009)), seen = new Uint8Array(w * h);
          for (let s = 0; s < w * h; s++) {
            if (!solid[s] || seen[s]) continue;
            const stack = [s], piece = []; seen[s] = 1;
            let x0 = w, y0 = h, x1 = 0, y1 = 0;
            while (stack.length) {
              const k = stack.pop(), x = k % w, y = (k / w) | 0; piece.push(k);
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy, kk = yy * w + xx; if (xx >= 0 && yy >= 0 && xx < w && yy < h && solid[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); } }
            }
            if (Math.min(x1 - x0 + 1, y1 - y0 + 1) <= sliver || piece.length < 6) for (const k of piece) px[k * 4 + 3] = 0;
          }
        }
        ctx.putImageData(data, 0, 0);
        await writeFile(join(assetsDir, `${key}.png`), await c.encode('png'));
        files[key] = `assets/${key}.png`;
        continue;
      }
      await writeFile(join(assetsDir, `${key}.webp`), await c.encode('webp', 90));
      files[key] = `assets/${key}.webp`;
    }
    return files;
  }

  const assetUrls = (id, n, files) => Object.fromEntries(Object.entries(files || {}).map(([k, v]) => [k, `/library/${id}/pages/${pad3(n)}/${v}`]));

  // Studio characters for the book (portraits replace scanned avatars in
  // every output). Kept in library/<book>/cast/.
  const readCast = id => readJson(join(bookDir(id), 'cast', 'cast.json'));
  const castUrl = (id, c) => `/library/${id}/cast/${c.file}?v=${c.v || 0}`;

  // The page's generated clip and its poster (a frame from the clip), sent by
  // the studio after video generation. Replaced whenever a new clip arrives.
  const readClip = (id, n) => readJson(join(pageDir(id, n), 'clip.json'));
  const clipAssets = (clip, base) => clip ? { clip: `${base}${clip.file}?v=${clip.v}`, clipType: clip.type, ...(clip.poster ? { clipPoster: `${base}${clip.poster}?v=${clip.v}` } : {}) } : {};

  // Layout and asset URLs as the reader will see them, with the cast applied.
  async function presented(id, n, layout) {
    const [cast, clip] = await Promise.all([readCast(id), readClip(id, n)]);
    const { layout: shown, assets } = core.applyCast(layout, cast, c => castUrl(id, c));
    return { layout: shown, assets: { ...assetUrls(id, n, layout.assets), ...assets, ...clipAssets(clip, `/library/${id}/pages/${pad3(n)}/`) } };
  }

  async function saveBody(req, path, limit) {
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = createWriteStream(path);
      req.on('data', c => { size += c.length; if (size > limit) { req.destroy(); out.destroy(); reject(new Error(`Файл больше ${Math.round(limit / 1048576)} МБ.`)); } });
      req.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      req.pipe(out);
    });
    if (size < 100) throw new Error('Файл пустой.');
    return size;
  }

  async function saveClip(id, n, req, type) {
    const dir = pageDir(id, n);
    await mkdir(dir, { recursive: true });
    const ext = /webm/.test(type) ? 'webm' : /quicktime/.test(type) ? 'mov' : 'mp4';
    const old = await readClip(id, n);
    if (old?.file) await rm(join(dir, old.file), { force: true });
    if (old?.poster) await rm(join(dir, old.poster), { force: true });
    const file = `clip.${ext}`, size = await saveBody(req, join(dir, file), 400 * 1024 * 1024);
    const clip = { file, type: /^video\/[\w.+-]+$/.test(type) ? type : 'video/mp4', size, poster: '', v: Date.now(), updatedAt: new Date().toISOString() };
    await writeJson(join(dir, 'clip.json'), clip);
    return clip;
  }

  async function saveClipPoster(id, n, req) {
    const dir = pageDir(id, n), clip = await readClip(id, n);
    if (!clip) throw new Error('Сначала загрузите видео страницы.');
    const tmp = join(dir, 'poster.upload');
    await saveBody(req, tmp, 20 * 1024 * 1024);
    const { loadImage, createCanvas } = await canvasLib();
    const img = await loadImage(await readFile(tmp));
    const c = createCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
    await writeFile(join(dir, 'clip-poster.webp'), await c.encode('webp', 90));
    await rm(tmp, { force: true });
    clip.poster = 'clip-poster.webp'; clip.v = Date.now();
    await writeJson(join(dir, 'clip.json'), clip);
    return clip;
  }

  async function republish(id, n) {
    const layout = await readJson(join(pageDir(id, n), 'layout.json'));
    if (layout) await writePageHtml(id, n, layout);
  }

  async function writePageHtml(id, n, layout) {
    const view = await presented(id, n, layout);
    const html = core.pageDocument(view.layout, { title: `Страница ${n}`, css: '/webbook/components.css?v=20260930-source1', assets: view.assets });
    await writeFile(join(pageDir(id, n), 'index.html'), html);
  }

  // Replace the book's cast: portraits arrive as data URLs from the studio,
  // are stored as WebP, and every converted page is re-published.
  async function saveCast(id, body) {
    const { loadImage, createCanvas } = await canvasLib();
    const dir = join(bookDir(id), 'cast');
    await mkdir(dir, { recursive: true });
    const previous = await readJson(join(dir, 'cast.json'));
    const previousById = new Map((previous?.characters || []).map(c => [c.id, c]));
    const characters = [], v = Date.now();
    for (const c of (body.characters || []).slice(0, 200)) {
      const cid = String(c.id || '').replace(/[^\w-]/g, '').slice(0, 64);
      const names = (c.names || []).map(s => String(s || '').slice(0, 120)).filter(Boolean);
      if (!cid || !names.length) continue;
      let file = '';
      const m = /^data:image\/[\w.+-]+;base64,(.+)$/.exec(String(c.image || ''));
      if (m) {
        const img = await loadImage(Buffer.from(m[1], 'base64'));
        const s = Math.min(1, 480 / Math.max(img.width, img.height));
        const cv = createCanvas(Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        file = `${cid}.webp`;
        await writeFile(join(dir, file), await cv.encode('webp', 90));
      } else {
        // Keep an existing approved portrait if this browser no longer has
        // the corresponding IndexedDB image blob.
        const old = previousById.get(cid);
        if (old?.file && existsSync(join(dir, old.file))) file = old.file;
      }
      characters.push({ id: cid, names, file, v });
    }
    const manual = Object.fromEntries(Object.entries(body.manual || {}).filter(([k, val]) => k && typeof val === 'string').slice(0, 500));
    const cast = { characters, manual, signature: String(body.signature || ''), updatedAt: new Date().toISOString() };
    await writeJson(join(dir, 'cast.json'), cast);
    let pages = 0;
    if (existsSync(join(bookDir(id), 'pages'))) for (const d of await readdir(join(bookDir(id), 'pages'))) {
      const layout = await readJson(join(bookDir(id), 'pages', d, 'layout.json'));
      if (layout) { await writePageHtml(id, Number(d), layout); pages++; }
    }
    return { characters: characters.length, withPortrait: characters.filter(c => c.file).length, pages };
  }

  // Run one conversion job, recording each step for the console.
  async function runJob(job) {
    const { id, n, model, forceModel, forceOcr } = job;
    const dir = pageDir(id, n);
    const step = async (key, fn) => {
      const s = job.steps.find(x => x.key === key), t = Date.now();
      s.status = 'running'; job.current = key;
      try { const r = await fn(); s.status = 'done'; s.note = r?.note || ''; return r; }
      catch (e) { s.status = 'error'; s.note = e.message; throw e; }
      finally { s.ms = Date.now() - t; }
    };
    try {
      await step('render', async () => { await ensureScan(id, n); return { note: `${SCAN_DPI} dpi` }; });
      const { loadImage } = await canvasLib();
      const image = await loadImage(await readFile(join(dir, 'scan.png')));
      // Both steps finish (and cache) even if the other fails, so the log
      // never shows a step stuck in "running" and a retry reuses the OCR.
      const [ocrResult, modelResult] = await Promise.allSettled([
        step('ocr', () => stepOcr(dir, n, forceOcr)),
        step('model', () => stepModel(dir, model, forceModel, image))
      ]);
      for (const r of [modelResult, ocrResult]) if (r.status === 'rejected') throw r.reason;
      const { ocr } = ocrResult.value, { answer } = modelResult.value;
      const layout = await step('layout', async () => {
        const base = core.fromModel(core.parseModelJson(answer.content), image.width, image.height);
        const grid = await pixelGrid(image);
        const snapped = core.snap(base, grid, ocr);
        snapped.decorations = core.findDecorations(snapped, grid);
        snapped.model = answer.model; snapped.cost = answer.cost; snapped.builtAt = new Date().toISOString();
        return { value: snapped, note: `${snapped.blocks.length} блоков, OCR-строк ${snapped.ocrLines}, декор ${snapped.decorations.length}` };
      });
      const files = await step('assets', async () => { const f = await writeAssets(dir, layout.value, image); return { value: f, note: `${Object.keys(f).length} шт.` }; });
      layout.value.assets = files.value;
      await writeJson(join(dir, 'layout.json'), layout.value);
      await step('html', async () => { await writePageHtml(id, n, layout.value); return { note: 'index.html' }; });
      job.state = 'done';
    } catch (e) {
      job.state = 'error'; job.error = e.message;
    } finally {
      job.finishedAt = new Date().toISOString(); job.current = null;
      await writeJson(join(dir, 'status.json'), job).catch(() => {});
    }
  }

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const job = jobs.get(queue.shift());
        if (!job || job.state !== 'queued') continue;
        job.state = 'running'; job.startedAt = new Date().toISOString();
        await runJob(job);
      }
    } finally { working = false; }
  }

  function enqueue(id, n, opts) {
    const key = `${id}:${n}`, existing = jobs.get(key);
    if (existing && ['queued', 'running'].includes(existing.state)) return existing;
    const job = { id, n, ...opts, state: 'queued', queuedAt: new Date().toISOString(), steps: STEPS.map(([key, label]) => ({ key, label, status: 'wait' })) };
    jobs.set(key, job); queue.push(key); pump();
    return job;
  }

  // ---- books ----

  async function listBooks() {
    await mkdir(LIB, { recursive: true });
    const out = [];
    for (const id of await readdir(LIB)) { const b = await readJson(join(bookDir(id), 'book.json')); if (b) out.push(b); }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function uploadBook(req, name) {
    await mkdir(LIB, { recursive: true });
    const tmp = join(LIB, `upload-${Date.now()}.pdf`), hash = createHash('sha256');
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = createWriteStream(tmp);
      req.on('data', c => { size += c.length; hash.update(c); if (size > 400 * 1024 * 1024) { req.destroy(); reject(new Error('PDF больше 400 МБ.')); } });
      req.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      req.pipe(out);
    });
    if (size < 100) { await rm(tmp, { force: true }); throw new Error('Файл пустой.'); }
    const id = hash.digest('hex').slice(0, 12), dir = bookDir(id);
    if (existsSync(join(dir, 'book.json'))) { await rm(tmp, { force: true }); return readJson(join(dir, 'book.json')); }
    await mkdir(dir, { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, join(dir, 'source.pdf'));
    const doc = await openDoc(id);
    const book = { id, name: String(name || 'Учебник').slice(0, 200), pages: doc.numPages, size, createdAt: new Date().toISOString() };
    await writeJson(join(dir, 'book.json'), book);
    return book;
  }

  async function bookState(id) {
    const book = await readJson(join(bookDir(id), 'book.json'));
    if (!book) return null;
    const pages = [];
    const done = new Set(existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : []);
    for (let n = 1; n <= book.pages; n++) {
      const job = jobs.get(`${id}:${n}`);
      if (job && ['queued', 'running'].includes(job.state)) { pages.push({ n, state: job.state }); continue; }
      if (!done.has(pad3(n))) { pages.push({ n, state: 'none' }); continue; }
      const dir = pageDir(id, n);
      const state = existsSync(join(dir, 'layout.json')) ? 'done' : (await readJson(join(dir, 'status.json')))?.state === 'error' ? 'error' : 'none';
      pages.push({ n, state, model: existsSync(join(dir, 'model.json')), edited: existsSync(join(dir, 'edited.flag')) });
    }
    return { ...book, pageStates: pages };
  }

  // ---- export ----

  async function exportBook(id, from, to) {
    const book = await readJson(join(bookDir(id), 'book.json'));
    if (!book) throw new Error('Книга не найдена.');
    const out = join(bookDir(id), 'web');
    await rm(out, { recursive: true, force: true });
    await mkdir(join(out, 'assets'), { recursive: true });
    await writeFile(join(out, 'components.css'), await readFile(join(root, 'webbook', 'components.css')));
    const pages = [];
    for (let n = from; n <= to; n++) if (existsSync(join(pageDir(id, n), 'layout.json'))) pages.push(n);
    if (!pages.length) throw new Error('В выбранном диапазоне нет готовых страниц.');
    // Cast portraits are shared by all pages: copy each once.
    const cast = await readCast(id), castFiles = new Set();
    const castRel = c => { const name = `cast-${c.file}`; castFiles.add(c.file); return `assets/${name}`; };
    for (const [i, n] of pages.entries()) {
      const stored = await readJson(join(pageDir(id, n), 'layout.json'));
      const applied = core.applyCast(stored, cast, castRel), layout = applied.layout;
      const assets = {};
      for (const [key, rel] of Object.entries(layout.assets || {})) {
        const name = `p${pad3(n)}-${key}.${String(rel).split('.').pop()}`;
        await writeFile(join(out, 'assets', name), await readFile(join(pageDir(id, n), rel)));
        assets[key] = `assets/${name}`;
      }
      Object.assign(assets, applied.assets);
      const clip = await readClip(id, n);
      if (clip) {
        const clipName = `p${pad3(n)}-${clip.file}`;
        await writeFile(join(out, 'assets', clipName), await readFile(join(pageDir(id, n), clip.file)));
        let posterName = '';
        if (clip.poster) { posterName = `p${pad3(n)}-${clip.poster}`; await writeFile(join(out, 'assets', posterName), await readFile(join(pageDir(id, n), clip.poster))); }
        Object.assign(assets, { clip: `assets/${clipName}`, clipType: clip.type, ...(posterName ? { clipPoster: `assets/${posterName}` } : {}) });
      }
      const file = n => `page-${pad3(n)}.html`;
      await writeFile(join(out, file(n)), core.pageDocument(layout, { title: `${book.name} — страница ${n}`, css: 'components.css', assets, prev: i ? file(pages[i - 1]) : 'index.html', next: pages[i + 1] ? file(pages[i + 1]) : '' }));
    }
    for (const f of castFiles) await writeFile(join(out, 'assets', `cast-${f}`), await readFile(join(bookDir(id), 'cast', f)));
    const list = pages.map(n => `<li><a href="page-${pad3(n)}.html">Страница ${n}</a></li>`).join('');
    await writeFile(join(out, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${book.name.replace(/[<>&]/g, '')}</title><style>body{margin:0;background:#e9e7e2;font:15px/1.6 system-ui,sans-serif;color:#2b2c27}main{max-width:720px;margin:40px auto;padding:0 20px}h1{font-size:24px}ol{columns:3;padding-left:20px}a{color:#2c6055}</style></head><body><main><h1>${book.name.replace(/[<>&]/g, '')}</h1><ol>${list}</ol></main></body></html>`);
    const zipPath = join(bookDir(id), 'web.zip');
    await writeZip(out, zipPath);
    return { pages: pages.length, folder: out, zip: `/library/${id}/web.zip` };
  }

  // ---- routes ----

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/local/webbook/')) return false;
    const parts = url.pathname.slice('/local/webbook/'.length).split('/').filter(Boolean);
    try {
      if (parts[0] === 'books' && parts.length === 1) {
        if (req.method === 'GET') return sendJson(res, 200, await listBooks()), true;
        if (req.method === 'POST') return sendJson(res, 200, await uploadBook(req, url.searchParams.get('name'))), true;
      }
      const id = parts[1];
      if (parts[0] !== 'books' || !/^[0-9a-f]{12}$/.test(id || '')) return sendJson(res, 404, { error: 'Не найдено.' }), true;
      if (parts.length === 2 && req.method === 'GET') {
        const state = await bookState(id);
        return sendJson(res, state ? 200 : 404, state || { error: 'Книга не найдена.' }), true;
      }
      if (parts[2] === 'cast' && req.method === 'GET') {
        const cast = await readCast(id);
        return sendJson(res, 200, cast ? { signature: cast.signature, characters: cast.characters.length, updatedAt: cast.updatedAt } : { signature: '' }), true;
      }
      if (parts[2] === 'cast' && req.method === 'PUT') {
        return sendJson(res, 200, await saveCast(id, await bodyJson(req, 60 * 1024 * 1024))), true;
      }
      if (parts[2] === 'export' && req.method === 'POST') {
        const b = await bodyJson(req);
        return sendJson(res, 200, await exportBook(id, Math.max(1, +b.from || 1), Math.max(1, +b.to || 9999))), true;
      }
      if (parts[2] !== 'pages') return sendJson(res, 404, { error: 'Не найдено.' }), true;
      const n = Number(parts[3]), what = parts[4];
      if (!Number.isInteger(n) || n < 1 || n > 5000) return sendJson(res, 400, { error: 'Неверный номер страницы.' }), true;
      const dir = pageDir(id, n);
      if (what === 'scan.png' || what === 'thumb.png') {
        const file = what === 'scan.png' ? await ensureScan(id, n) : await ensureThumb(id, n);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
        res.end(await readFile(file));
        return true;
      }
      if (what === 'convert' && req.method === 'POST') {
        const b = await bodyJson(req);
        return sendJson(res, 200, enqueue(id, n, { model: String(b.model || ''), forceModel: Boolean(b.forceModel), forceOcr: Boolean(b.forceOcr) })), true;
      }
      if (what === 'measure' && req.method === 'POST') {
        const layout = await readJson(join(dir, 'layout.json'));
        const ocr = await readJson(join(dir, 'ocr.json'));
        if (!layout || !ocr?.lines?.length) return sendJson(res, 400, { error: 'Сначала нужна готовая страница с локальным OCR.' }), true;
        await ensureScan(id, n);
        const { loadImage } = await canvasLib();
        const image = await loadImage(await readFile(join(dir, 'scan.png')));
        const measured = core.measureOriginal(layout, await pixelGrid(image), ocr);
        const stamp = Date.now();
        const { createCanvas } = await canvasLib();
        await mkdir(join(dir, 'assets'), { recursive:true });
        for (const [index, block] of measured.blocks.entries()) {
          if (block.type !== 'section' || !block.mascotBox) continue;
          const box=block.mascotBox, x=Math.max(0,Math.round(box.x*image.width)), y=Math.max(0,Math.round(box.y*image.height));
          const w=Math.min(image.width-x,Math.round(box.w*image.width)), h=Math.min(image.height-y,Math.round(box.h*image.height));
          if(w<1||h<1)continue;
          const canvas=createCanvas(w,h),ctx=canvas.getContext('2d');ctx.drawImage(image,x,y,w,h,0,0,w,h);
          // Keep the illustration's white shirt and the printed background;
          // removing all white pixels erases part of the character itself.
          const file=`assets/mascot-${index}-source-${stamp}.png`;await writeFile(join(dir,file),await canvas.encode('png'));
          measured.assets={...measured.assets,[`mascot-${index}`]:file};
        }
        await writeJson(join(dir, `layout.before-source-${stamp}.json`), layout);
        if (existsSync(join(dir, 'index.html'))) await writeFile(join(dir, `index.before-source-${stamp}.html`), await readFile(join(dir, 'index.html')));
        await writeJson(join(dir, 'layout.json'), measured);
        await writePageHtml(id, n, measured);
        return sendJson(res, 200, { lines: measured.blocks.reduce((sum, b) => sum + (b.sourceLines?.length || 0), 0), dialogueTurns: measured.blocks.flatMap(b => b.turns || []).filter(t => t.geometry).length, backup: `layout.before-source-${stamp}.json` }), true;
      }
      if (what === 'comparison' && req.method === 'PUT') {
        if (!existsSync(join(dir, 'layout.json'))) return sendJson(res, 400, { error: 'Сначала нужна построенная страница.' }), true;
        const data = await bodyJson(req, 24 * 1024 * 1024);
        const decode = value => {
          if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) throw new Error('Нужен снимок PNG.');
          const bytes = Buffer.from(value.slice(value.indexOf(',')+1), 'base64');
          if (bytes.length > 10*1024*1024 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Некорректный или слишком большой PNG.');
          return bytes;
        };
        const render = decode(data.renderPng), diff = decode(data.diffPng), stamp = Date.now();
        const renderFile = `comparison-${stamp}-render.png`, diffFile = `comparison-${stamp}-diff.png`;
        await writeFile(join(dir, renderFile), render); await writeFile(join(dir, diffFile), diff);
        await writeJson(join(dir, 'comparison.json'), { metrics:data.metrics, render:renderFile, diff:diffFile, status:'needs-review' });
        const base = `/library/${id}/pages/${pad3(n)}/`;
        return sendJson(res, 200, { render:base+renderFile, diff:base+diffFile }), true;
      }
      if (what === 'clip' && req.method === 'GET') return sendJson(res, 200, await readClip(id, n) || {}), true;
      if (what === 'clip' && req.method === 'PUT') {
        const clip = await saveClip(id, n, req, String(req.headers['content-type'] || 'video/mp4').split(';')[0].trim());
        await republish(id, n);
        return sendJson(res, 200, clip), true;
      }
      if (what === 'clip-poster' && req.method === 'PUT') {
        const clip = await saveClipPoster(id, n, req);
        await republish(id, n);
        return sendJson(res, 200, clip), true;
      }
      if (what === 'job' && req.method === 'GET') {
        return sendJson(res, 200, jobs.get(`${id}:${n}`) || await readJson(join(dir, 'status.json')) || { state: 'none' }), true;
      }
      if (what === 'layout' && req.method === 'GET') {
        const layout = await readJson(join(dir, 'layout.json'));
        if (!layout) return sendJson(res, 404, { error: 'Страница ещё не сконвертирована.' }), true;
        // `layout` stays as stored (the console edits and saves it); `view`
        // is what readers see, with cast portraits applied.
        const view = await presented(id, n, layout);
        return sendJson(res, 200, { layout, view: view.layout, assets: view.assets, html: `/library/${id}/pages/${pad3(n)}/index.html` }), true;
      }
      if (what === 'layout' && req.method === 'PUT') {
        const b = await bodyJson(req);
        const old = await readJson(join(dir, 'layout.json'));
        if (!old || !Array.isArray(b.layout?.blocks)) return sendJson(res, 400, { error: 'Нет сохранённой страницы или неверные данные.' }), true;
        // Only editable parts are accepted; measurements stay server-owned.
        const layout = { ...old, blocks: b.layout.blocks, decorations: Array.isArray(b.layout.decorations) ? b.layout.decorations : old.decorations, theme: b.layout.theme || old.theme, editedAt: new Date().toISOString() };
        await writeJson(join(dir, 'layout.json'), layout);
        await writeFile(join(dir, 'edited.flag'), layout.editedAt);
        await writePageHtml(id, n, layout);
        return sendJson(res, 200, { ok: true, editedAt: layout.editedAt }), true;
      }
      return sendJson(res, 404, { error: 'Не найдено.' }), true;
    } catch (e) {
      sendJson(res, 500, { error: e.message || 'Ошибка конвертера.' });
      return true;
    }
  }

  return { handle };
}

// ---- minimal ZIP writer (stored entries; images are already compressed) ----

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

async function collect(dir, base = '') {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name), rel = base ? `${base}/${name}` : name;
    if ((await stat(full)).isDirectory()) out.push(...await collect(full, rel)); else out.push({ rel, full });
  }
  return out;
}

async function writeZip(dir, zipPath) {
  const parts = [], central = [];
  let offset = 0;
  for (const { rel, full } of await collect(dir)) {
    const data = await readFile(full), name = Buffer.from(rel, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0, 12); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  await writeFile(zipPath, Buffer.concat([...parts, ...central, end]));
}


