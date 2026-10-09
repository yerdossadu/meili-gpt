// Forma "PDF → Web" conversion service, mounted by server.mjs under
// /local/webbook/*. Every page is converted by the same pipeline:
//
//   1. render  — PDF page → PNG scan (pdf.js + @napi-rs/canvas, 288 dpi)
//   2. ocr     — local PaddleOCR service (port 4176) → exact line boxes
//   3. model   — OpenRouter vision model → blocks, text, translation (cached)
//   4. layout  — snap blocks to OCR + pixels, sample colours and font sizes
//   5. assets  — cut photos and avatars out of the scan (WebP)
//   6. html    — standalone page for the learning platform
//
// Results live on disk in library/<book>/pages/<nnn>/ so they survive the
// browser and can be inspected or re-derived without new paid requests.

import { mkdir, readFile, writeFile, readdir, stat, rm, rename, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest, localizeLayout, validatePage, layoutFromOcr } from './page-contract.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as core from './core.mjs';
import { scorePage } from './fidelity.mjs';

const RUNTIME = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
const OCR_URL = process.env.FORMA_OCR_URL || 'http://127.0.0.1:4182/ocr';
const SCAN_DPI = 288;
const CODE = fileURLToPath(new URL('.', import.meta.url));
// A geometry or CSS fix changes the renderer just as a core change does.
// Frozen revisions must never be published as if they used those new rules.
const RENDERER_FILES=['core.mjs','components.css','source-geometry.mjs','word-labels.mjs','tone-audio.mjs','workbook-drills.mjs','title-page.mjs','imprint-page.mjs','credits-page.mjs','foreword-page.mjs','character-page.mjs','classroom-page.mjs','contents-page.mjs','page-contract.mjs'];
const RENDERER_HASH = digest(await Promise.all(RENDERER_FILES.map(async name=>[name,await readFile(join(CODE,name),'utf8')])));
const rendererScript = () => `window.FormaPage=(function(){${core.fit.toString()}\n${core.autoFit.toString()}\n${core.setLang.toString()}\nreturn{fit,autoFit,setLang};})();`;
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
async function atomicWrite(path, data) {
  const temp = path + '.new-' + randomUUID();
  await writeFile(temp, data); await rename(temp, path);
}
const writeJson = (path, data) => atomicWrite(path, JSON.stringify(data, null, 1));
async function bodyJson(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Слишком большой запрос.'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// `origin` is the studio's own address; with it, pages are scored against
// their scans (fidelity.mjs) after every conversion and saved edit.
export function createWebbook({ root, getApiKey, getAliKey = () => '', origin = '' }) {
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
    const sourceHash=digest(await readFile(join(dir,'scan.png')));
    const cached = !force && await readJson(join(dir, 'ocr.json'));
    if (cached?.lines?.length && (!cached.sourceHash || cached.sourceHash===sourceHash)) {
      if(!cached.sourceHash){cached.sourceHash=sourceHash;await writeJson(join(dir,'ocr.json'),cached);}
      return { ocr: cached, note: `из кэша, ${cached.lines.length} строк` };
    }
    const png = await readFile(join(dir, 'scan.png'));
    let response;
    try { response = await fetch(`${OCR_URL}?page=${n}&dpi=${SCAN_DPI}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png, signal: AbortSignal.timeout(240000) }); }
    catch { throw new Error('Локальный OCR (порт 4176) не отвечает. Запустите студию через start-forma-studio.bat.'); }
    const ocr = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(ocr.error || `OCR вернул HTTP ${response.status}.`);
    if (!ocr.lines?.length) throw new Error('OCR не нашёл текста на странице.');
    ocr.sourceHash=sourceHash;
    await writeJson(join(dir, 'ocr.json'), ocr);
    return { ocr, note: `${ocr.lines.length} строк` };
  }

  async function stepModel(dir, model, force, scanImage) {
    const sourceHash=digest(await readFile(join(dir,'scan.png'))), promptHash=digest(core.PROMPT);
    const cached = await readJson(join(dir, 'model.json'));
    if (cached?.content && !force && (!cached.sourceHash || cached.sourceHash===sourceHash)) {
      if(!cached.sourceHash){cached.sourceHash=sourceHash;cached.promptHash=promptHash;await writeJson(join(dir,'model.json'),cached);}
      if(cached.promptHash!==promptHash)cached.needsReview='Изменился prompt разметки; сохранённый ответ требует проверки.';
      return { answer: cached, note: `из кэша (${cached.model}), без запроса${cached.needsReview?' · требует проверки':''}` };
    }
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
    const answer = { model, sourceHash, promptHash, content: d.choices?.[0]?.message?.content || '', cost: d.usage?.cost ?? null, finish, at: new Date().toISOString() };
    core.parseModelJson(answer.content); // fail now rather than in the next step
    await writeJson(join(dir, 'model.json'), answer);
    return { answer, note: `${model}${answer.cost != null ? `, $${Number(answer.cost).toFixed(4)}` : ''}` };
  }

  async function pixelGrid(image) {
    const { createCanvas } = await canvasLib();
    const W = Math.min(700, image.width), H = Math.round(image.height * W / image.width);
    const c = createCanvas(W, H), ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0, W, H);
    const grid = core.gridFromRGBA(ctx.getImageData(0, 0, W, H).data, W, H);
    // Full-resolution pixels for probing hairline borders (speech bubbles).
    const full = createCanvas(image.width, image.height), fctx = full.getContext('2d');
    fctx.drawImage(image, 0, 0);
    const px = fctx.getImageData(0, 0, image.width, image.height).data, FW = image.width;
    grid.hi = { W: image.width, H: image.height, at: (x, y) => { const i = (y * FW + x) * 4; return [px[i], px[i + 1], px[i + 2]]; } };
    return grid;
  }

  async function writeAssets(dir, layout, image) {
    const { createCanvas } = await canvasLib();
    const assetsDir = join(dir, 'assets');
    await rm(assetsDir, { recursive: true, force: true });
    await mkdir(assetsDir, { recursive: true });
    const files = {};
    for (const { key, box, transparent, also = [], flood } of core.assetBoxes(layout)) {
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
        // Further colours to drop (the tab under a character drawn over it).
        const extra = also.map(core.parseHex);
        if (flood) {
          // The tab colour goes wherever it is (the drawing has none). The
          // page colour goes only where reached from the top and sides, and
          // only on a tinted page: a white page matches the web page anyway,
          // and the drawing's white fill, behind a hairline outline with
          // gaps, would be flooded too.
          const tab = i => Math.min(Infinity, ...extra.map(c => near(i, c)));
          const paper = Math.hypot(255 - bg[0], 255 - bg[1], 255 - bg[2]) > 20;
          const keyDist = i => Math.min(tab(i), paper ? near(i, bg) : Infinity);
          const gone = new Uint8Array(w * h), stack = [];
          for (let k = 0; k < w * h; k++) if (tab(k * 4) < 40) gone[k] = 1;
          const seed = (x, y) => { const k = y * w + x; if (!gone[k] && paper && near(k * 4, bg) < 40) { gone[k] = 1; stack.push(k); } };
          for (let x = 0; x < w; x++) seed(x, 0);
          for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
          while (stack.length) {
            const k = stack.pop(), x = k % w, y = (k - x) / w;
            if (x > 0) seed(x - 1, y); if (x < w - 1) seed(x + 1, y); if (y > 0) seed(x, y - 1); if (y < h - 1) seed(x, y + 1);
          }
          // Soft edge: pixels next to the cleared area fade with their distance from it.
          for (let k = 0; k < w * h; k++) {
            if (gone[k]) { px[k * 4 + 3] = 0; continue; }
            const x = k % w, y = (k - x) / w, edge = (x > 0 && gone[k - 1]) || (x < w - 1 && gone[k + 1]) || (y > 0 && gone[k - w]) || (y < h - 1 && gone[k + w]);
            if (edge) px[k * 4 + 3] = Math.max(0, Math.min(255, Math.round((keyDist(k * 4) - 22) * 6)));
          }
          // A character's crop often takes in a bit of the line beside it (p27: the "🔊 3-3" mark). Marks that are
          // separate from the drawing and lie inside another text block belong to that block: they are cleared.
          if (/^tip-/.test(key)) {
            const ink = new Uint8Array(w * h), isInk = k => px[k * 4 + 3] > 40 && near(k * 4, bg) > 60 && near(k * 4, [255, 255, 255]) > 60;
            for (let k = 0; k < w * h; k++) ink[k] = isInk(k) ? 1 : 0;
            const R = Math.max(4, Math.round(w * 0.012)), lab = new Int32Array(w * h).fill(-1), comps = [];
            const near2 = (x, y) => { for (let dy = -R; dy <= R; dy += 2) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -R; dx <= R; dx += 2) { const xx = x + dx; if (xx >= 0 && xx < w && ink[yy * w + xx]) return true; } } return false; };
            for (let s = 0; s < w * h; s++) {
              if (!ink[s] || lab[s] >= 0) continue;
              const id = comps.length, st = [s], cells = []; lab[s] = id;
              let x0 = w, y0 = h, x1 = 0, y1 = 0;
              while (st.length) {
                const k = st.pop(), x = k % w, y = (k - x) / w;
                if (ink[k]) { cells.push(k); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
                for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
                  const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                  const kk = yy * w + xx; if (lab[kk] < 0 && ink[kk] && (dx || dy)) { lab[kk] = id; st.push(kk); }
                }
              }
              comps.push({ cells, box: { x: box.x + x0 / w * box.w, y: box.y + y0 / h * box.h, w: (x1 - x0 + 1) / w * box.w, h: (y1 - y0 + 1) / h * box.h } });
            }
            const main = comps.reduce((a, b) => (b.cells.length > (a?.cells.length || 0) ? b : a), null);
            const text = layout.blocks.filter(o => ['para', 'text', 'runhead'].includes(o.type) && o.box);
            for (const cp of comps) {
              if (cp === main) continue;
              // Only a clearly separate mark: far from the drawing, and small beside it (never a stroke of the drawing itself).
              const mb = main.box, gx = Math.max(mb.x - (cp.box.x + cp.box.w), cp.box.x - (mb.x + mb.w), 0), gy = Math.max(mb.y - (cp.box.y + cp.box.h), cp.box.y - (mb.y + mb.h), 0);
              if (Math.hypot(gx, gy) < box.w * 0.05 || cp.cells.length > main.cells.length * 0.5) continue;
              const cx = cp.box.x + cp.box.w / 2, cy = cp.box.y + cp.box.h / 2;
              if (!text.some(o => cx >= o.box.x && cx <= o.box.x + o.box.w && cy >= o.box.y && cy <= o.box.y + o.box.h)) continue;
              // Clear the mark and its anti-aliased fringe.
              const x0 = Math.max(0, Math.floor((cp.box.x - box.x) / box.w * w) - 3), x1 = Math.min(w - 1, Math.ceil((cp.box.x + cp.box.w - box.x) / box.w * w) + 3);
              const y0 = Math.max(0, Math.floor((cp.box.y - box.y) / box.h * h) - 3), y1 = Math.min(h - 1, Math.ceil((cp.box.y + cp.box.h - box.y) / box.h * h) + 3);
              for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px[(y * w + x) * 4 + 3] = 0;
            }
          }
          ctx.putImageData(data, 0, 0);
          await writeFile(join(assetsDir, `${key}.png`), await c.encode('png'));
          files[key] = `assets/${key}.png`;
          continue;
        }
        for (let i = 0; i < px.length; i += 4) {
          let a = Math.max(0, Math.min(255, Math.round((Math.min(near(i, bg), ...extra.map(c => near(i, c))) - 22) * 6)));
          if (marked && (px[i] + px[i + 1] + px[i + 2] < 330 || fills.some(f => near(i, f) < 30))) a = 0;
          px[i + 3] = a;
        }
        if (marked) {
          // Keep only the graphic's own colour (the dominant colour of what
          // is left), dropping grey text such as punctuation.
          // Only strong ink votes (pale scan halo around strokes would win
          // otherwise), in coarse bins, and the winner is the mean of its bin.
          // Photos and portraits under the box are drawn by their own blocks.
          const holes = [...layout.blocks.filter(o => o.type === 'image').map(o => o.box), ...layout.blocks.flatMap(o => [o.avatar, ...(o.turns || []).map(t => t.speaker?.avatarBox)]).filter(Boolean)];
          for (const hb of holes) {
            const hx0 = Math.max(0, Math.round((hb.x - box.x) * image.width)), hx1 = Math.min(w, Math.round((hb.x + hb.w - box.x) * image.width));
            const hy0 = Math.max(0, Math.round((hb.y - box.y) * image.height)), hy1 = Math.min(h, Math.round((hb.y + hb.h - box.y) * image.height));
            for (let y = hy0; y < hy1; y++) for (let x = hx0; x < hx1; x++) px[(y * w + x) * 4 + 3] = 0;
          }
          const counts = new Map();
          for (let i = 0; i < px.length; i += 4) if (px[i + 3] && near(i, bg) > 90 && Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 60) {
            const k = (px[i] >> 5) + ',' + (px[i + 1] >> 5) + ',' + (px[i + 2] >> 5), e = counts.get(k) || [0, 0, 0, 0];
            e[0] += px[i]; e[1] += px[i + 1]; e[2] += px[i + 2]; e[3]++; counts.set(k, e);
          }
          const top = [...counts.values()].sort((a, b) => b[3] - a[3])[0];
          if (top) {
            const ink = [top[0] / top[3], top[1] / top[3], top[2] / top[3]];
            // Keep the ink and its anti-aliased edge: colours on the way from
            // the page colour to the ink, not other inks.
            const d = [ink[0] - bg[0], ink[1] - bg[1], ink[2] - bg[2]], dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
            for (let i = 0; i < px.length; i += 4) {
              if (!px[i + 3]) continue;
              const t = Math.max(0, Math.min(1.15, ((px[i] - bg[0]) * d[0] + (px[i + 1] - bg[1]) * d[1] + (px[i + 2] - bg[2]) * d[2]) / dd));
              const off = Math.hypot(px[i] - bg[0] - t * d[0], px[i + 1] - bg[1] - t * d[1], px[i + 2] - bg[2] - t * d[2]);
              if (off > 45 || t < 0.25) px[i + 3] = 0;
            }
          }
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
  const readPhonetics = async (id,n) => await readJson(join(pageDir(id,n),'phonetics.json')) || (id === '8bf3af15d090' && [3,4,7,11].includes(n) ? await readJson(join(root,'webbook','phonetics',`workbook-page${n}.json`)) : null);
  const readSourceRegions = async (id,n) => id === '8bf3af15d090' && n === 4 ? await readJson(join(root,'webbook','phonetics',`workbook-page${n}-regions.json`)) : null;

  // Studio characters for the book (portraits replace scanned avatars in
  // every output). Kept in library/<book>/cast/.
  const readCast = id => readJson(join(bookDir(id), 'cast', 'cast.json'));
  const castUrl = (id, c) => `/library/${id}/cast/${c.file}?v=${c.v || 0}`;

  // The page's generated clip and its poster (a frame from the clip), sent by
  // the studio after video generation. Replaced whenever a new clip arrives.
  const readClip = (id, n) => readJson(join(pageDir(id, n), 'clip.json'));
  const clipAssets = (clip, base) => clip ? { clip: `${base}${clip.file}?v=${clip.v}`, clipType: clip.type, ...(clip.poster ? { clipPoster: `${base}${clip.poster}?v=${clip.v}` } : {}) } : {};

  // ---- Loudness ----
  // Clips and textbook recordings play side by side on a page: both are brought
  // to one level (−16 LUFS, peaks under −1.5 dBTP) in two loudnorm passes, so a
  // video is not much louder than the textbook's audio. Video is copied as is.
  const FFMPEG = existsSync(join(root, '.tools', 'ffmpeg', 'ffmpeg.exe')) ? join(root, '.tools', 'ffmpeg', 'ffmpeg.exe') : 'ffmpeg';
  const LOUD = { I: -16, TP: -1.5, LRA: 11 };
  const run = args => new Promise((ok, fail) => { const p = spawn(FFMPEG, args, { windowsHide: true }); let err = ''; p.stderr.on('data', d => { err += d; if (err.length > 200000) err = err.slice(-100000); }); p.on('error', fail); p.on('close', code => code === 0 ? ok(err) : fail(new Error('ffmpeg: ' + err.slice(-400)))); });
  async function normalizeLoudness(file) {
    // A temp name of its own: two runs on one file never write into the same temp.
    const isVideo = /\.(mp4|webm|mov)$/i.test(file), ext = file.match(/\.[^.]+$/)[0].toLowerCase(), tmp = `${file}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.norm${ext}`;
    const log = await run(['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `loudnorm=I=${LOUD.I}:TP=${LOUD.TP}:LRA=${LOUD.LRA}:print_format=json`, '-f', 'null', '-']);
    const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
    if (!Number.isFinite(+m.input_i) || +m.input_i < -70) return { skipped: 'тишина' };      // no sound to level
    if (Math.abs(+m.input_i - LOUD.I) < 1 && +m.input_tp <= LOUD.TP) return { before: +m.input_i, after: +m.input_i };
    const af = `loudnorm=I=${LOUD.I}:TP=${LOUD.TP}:LRA=${LOUD.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    const codec = isVideo ? ['-c:v', 'copy', '-c:a', ext === '.webm' ? 'libopus' : 'aac', '-b:a', '160k', '-ar', '48000'] : ext === '.mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2', '-ar', '44100'] : ['-ar', '44100'];
    await run(['-hide_banner', '-nostats', '-y', '-i', file, '-af', af, ...codec, ...(isVideo && ext !== '.webm' ? ['-movflags', '+faststart'] : []), tmp]);
    await rename(tmp, file);
    return { before: +(+m.input_i).toFixed(1), after: LOUD.I };
  }
  // Every page clip and every book recording, once (and again for new ones).
  async function levelBook(id) {
    const done = [], failed = [];
    for (const d of existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : []) {
      const n = Number(d), clip = await readClip(id, n);
      if (!clip?.file || clip.leveled) continue;
      const file = join(pageDir(id, n), clip.file), keep = join(pageDir(id, n), 'clip.original' + clip.file.slice(clip.file.lastIndexOf('.')));
      try {
        if (!existsSync(keep)) await copyFile(file, keep);
        const r = await normalizeLoudness(file);
        Object.assign(clip, { leveled: true, v: Date.now() }); await writeJson(join(pageDir(id, n), 'clip.json'), clip);
        done.push(`клип стр. ${n}: ${r.before ?? '—'} → ${r.after ?? '—'} LUFS`);
        await republish(id, n); autoRepublish(id, n);
      } catch (e) { failed.push(`клип стр. ${n}: ${e.message}`); }
    }
    const dir = join(bookDir(id), 'audio'), mark = join(dir, 'leveled.json'), leveled = (await readJson(mark)) || {};
    for (const f of existsSync(dir) ? await readdir(dir) : []) {
      if (!AUDIO_EXT.test(f) || leveled[f]) continue;
      try { await normalizeLoudness(join(dir, f)); leveled[f] = true; } catch (e) { failed.push(`${f}: ${e.message}`); }
    }
    if (existsSync(dir)) await writeJson(mark, leveled);
    // Pages with recordings take the new files (their ?v follows the file time).
    for (const d of existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : []) {
      const layout = await readJson(join(bookDir(id), 'pages', d, 'layout.json'));
      if (layout && tracksOf(layout).length) { await writePageHtml(id, Number(d), layout); autoRepublish(id, Number(d)); }
    }
    return { clips: done, tracks: Object.keys(leveled).length, failed };
  }

  // ---- Textbook audio ----
  // Recordings live once per book in library/<id>/audio as «<lesson>-<track>.<ext>»
  // (the numbers printed next to the speaker marks: «1-3»). A page plays the ones it marks.
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|wav)$/i;
  async function bookAudio(id) {
    const dir = join(bookDir(id), 'audio'), out = {};
    if (!existsSync(dir)) return out;
    for (const f of await readdir(dir)) { const m = f.match(/^(\d{1,2}-\d{1,3})\.(mp3|m4a|aac|ogg|wav)$/i); if (m) out[m[1]] = { file: f, v: Math.round((await stat(join(dir, f))).mtimeMs) }; }
    return out;
  }
  function tracksOf(layout) {
    const out = new Set(), walk = o => { if (Array.isArray(o)) return o.forEach(walk); if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (k === 'track' && typeof v === 'string' && /^\d{1,2}-\d{1,3}$/.test(v.trim()) && !core.isVideoMark(o)) out.add(v.trim()); else if (v && typeof v === 'object' && k !== 'box') walk(v); } };
    walk(layout?.blocks); return [...out];
  }
  // «1-3», «1_3», «01-03», «Track 1-3», «第1课 1-3»… → «1-3». The lesson–track pair is what counts.
  function trackOfName(name) {
    const m = String(name).replace(AUDIO_EXT, '').match(/(?:^|[^\d])(\d{1,2})\s*[-_–—.]\s*(\d{1,3})(?:[^\d]|$)/);
    return m ? `${+m[1]}-${+m[2]}` : null;
  }
  async function importAudio(id, folder) {
    const src = String(folder || '').trim().replace(/^"|"$/g, '');
    if (!src || !existsSync(src)) throw new Error('Папка не найдена: ' + (src || '—'));
    const files = [], walk = async d => { for (const e of await readdir(d, { withFileTypes: true })) { if (e.name === '__MACOSX' || e.name.startsWith('._')) continue; const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (AUDIO_EXT.test(e.name)) files.push(p); } };
    await walk(src);
    const dir = join(bookDir(id), 'audio'); await mkdir(dir, { recursive: true });
    const imported = [], skipped = [], seen = new Set();
    for (const f of files) {
      const t = trackOfName(f.split(/[\\/]/).pop());
      if (!t || seen.has(t)) { skipped.push(f.slice(src.length + 1)); continue; }
      seen.add(t);
      const ext = f.match(AUDIO_EXT)[0].toLowerCase();
      for (const old of await readdir(dir)) if (old.startsWith(t + '.')) await rm(join(dir, old), { force: true });
      await writeFile(join(dir, t + ext), await readFile(f));
      // Each recording is levelled as it arrives (the plain copy still plays if that fails).
      try { await normalizeLoudness(join(dir, t + ext)); const mark = join(dir, 'leveled.json'), lv = (await readJson(mark)) || {}; lv[t + ext] = true; await writeJson(mark, lv); } catch { /* keep the copy */ }
      imported.push(t);
    }
    // Pages that mark these tracks get their buttons; published ones follow.
    let pages = 0;
    for (const d of existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : []) {
      const layout = await readJson(join(bookDir(id), 'pages', d, 'layout.json'));
      if (layout && tracksOf(layout).some(t => seen.has(t))) { await writePageHtml(id, Number(d), layout); autoRepublish(id, Number(d)); pages++; }
    }
    return { found: files.length, imported: imported.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), skipped, pages };
  }
  // What the book marks and what it has: for the console.
  async function audioState(id) {
    const have = await bookAudio(id), marks = {};
    for (const d of existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : []) {
      const layout = await readJson(join(bookDir(id), 'pages', d, 'layout.json'));
      for (const t of tracksOf(layout)) (marks[t] ||= []).push(Number(d));
    }
    const all = Object.keys(marks).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { tracks: Object.keys(have).length, marked: all.length, missing: all.filter(t => !have[t]).map(t => ({ track: t, pages: marks[t] })), playable: all.filter(t => have[t]) };
  }

  // Layout and asset URLs as the reader will see them, with the cast applied.
  async function presented(id, n, layout) {
    const [cast, clip, have] = await Promise.all([readCast(id), readClip(id, n), bookAudio(id)]);
    const { layout: shown, assets } = core.applyCast(layout, cast, c => castUrl(id, c));
    const audio = Object.fromEntries(tracksOf(layout).filter(t => have[t]).map(t => [t, `/library/${id}/audio/${have[t].file}?v=${have[t].v}`]));
    const ocr = await readJson(join(pageDir(id, n), 'ocr.json'));
    if (ocr?.lines?.length) shown.sourceLines = ocr.lines;
    shown.phonetics = await readPhonetics(id,n);
    shown.sourceRegions = await readSourceRegions(id,n);
    const sounds = Object.fromEntries((shown.phonetics?.cells || []).filter(c=>!layout.assets?.[`phonetic-${c.text}`]&&existsSync(join(CODE,'phonetics',`${c.text}.mp3`))).map(c=>[`phonetic-${c.text}`,`/webbook/phonetics/${c.text}.mp3`]));
    return { layout: shown, assets: { ...assetUrls(id, n, layout.assets), ...assets, ...clipAssets(clip, `/library/${id}/pages/${pad3(n)}/`), audio, ...sounds, ...(ocr?.lines?.length ? {sourceScan:`/library/${id}/pages/${pad3(n)}/scan.png`} : {}) } };
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

  // One clip operation per page at a time: two clips arriving together (a new
  // generation and the card's re-send) once interleaved into a broken file.
  const clipLocks = new Map();
  function withClipLock(id, n, job) {
    const key = `${id}:${n}`, run = (clipLocks.get(key) || Promise.resolve()).catch(() => {}).then(job);
    clipLocks.set(key, run.catch(() => {}));
    return run;
  }
  const saveClip = (id, n, req, type) => withClipLock(id, n, () => saveClipNow(id, n, req, type));
  async function saveClipNow(id, n, req, type) {
    const dir = pageDir(id, n);
    await mkdir(dir, { recursive: true });
    const ext = /webm/.test(type) ? 'webm' : /quicktime/.test(type) ? 'mov' : 'mp4';
    const old = await readClip(id, n);
    if (old?.file) await rm(join(dir, old.file), { force: true });
    if (old?.poster) await rm(join(dir, old.poster), { force: true });
    const file = `clip.${ext}`, size = await saveBody(req, join(dir, file), 400 * 1024 * 1024);
    // A new clip is levelled on arrival; `size` stays the uploaded size, which the studio uses to know it was sent.
    let leveled = false;
    try { await copyFile(join(dir, file), join(dir, 'clip.original.' + ext)); await normalizeLoudness(join(dir, file)); leveled = true; } catch { /* keeps the original sound */ }
    const clip = { file, type: /^video\/[\w.+-]+$/.test(type) ? type : 'video/mp4', size, leveled, poster: '', v: Date.now(), updatedAt: new Date().toISOString() };
    await writeJson(join(dir, 'clip.json'), clip);
    return clip;
  }

  // Without clip.json the page shows its own illustration again.
  async function removeClip(id, n) {
    const dir = pageDir(id, n), old = await readClip(id, n);
    if (old?.file) await rm(join(dir, old.file), { force: true });
    if (old?.poster) await rm(join(dir, old.poster), { force: true });
    await rm(join(dir, 'clip.json'), { force: true });
    return { removed: Boolean(old) };
  }

  // GPT Image PNGs carry a C2PA provenance chunk («caBX») that the canvas decoder rejects
  // («Invalid SVG image»). Only the chunks that make the picture are kept; other files pass as they are.
  function pngPixelsOnly(buf) {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
    const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'sRGB', 'iCCP', 'cHRM']), parts = [buf.subarray(0, 8)];
    for (let at = 8; at + 12 <= buf.length;) {
      const len = buf.readUInt32BE(at), type = buf.toString('ascii', at + 4, at + 8), end = at + 12 + len;
      if (end > buf.length) return buf;
      if (keep.has(type)) parts.push(buf.subarray(at, end));
      at = end;
      if (type === 'IEND') break;
    }
    return Buffer.concat(parts);
  }

  async function saveClipPoster(id, n, req) {
    const dir = pageDir(id, n), clip = await readClip(id, n);
    if (!clip) throw new Error('Сначала загрузите видео страницы.');
    const tmp = join(dir, 'poster.upload');
    await saveBody(req, tmp, 20 * 1024 * 1024);
    const { loadImage, createCanvas } = await canvasLib();
    const img = await loadImage(pngPixelsOnly(await readFile(tmp)));
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
    layout = core.attachInteractiveCaptions(layout);
    const view = await presented(id, n, layout);
    const css = layout.conversionId ? `/library/${id}/pages/${pad3(n)}/revisions/${layout.conversionId}/components.css` : '/webbook/components.css';
    const html = core.pageDocument(view.layout, { title: `Страница ${n}`, css, assets: view.assets });
    await atomicWrite(join(pageDir(id, n), 'index.html'), html);
    autoScore(id, n);
  }

  async function commitPage(id, n, candidate, { conversionId = randomUUID(), image, quality, engine = 'vision' } = {}) {
    quality ||= candidate.quality;
    const dir = pageDir(id,n), before = await readJson(join(dir,'layout.json'));
    const revision = join(dir,'revisions',conversionId);
    await mkdir(revision,{recursive:true});
    let layout = localizeLayout(core.attachInteractiveCaptions(candidate),before);
    const validation=validatePage(layout,{requireKz:Boolean(Object.keys(before?.kz||{}).length)});
    validation.warnings.push(...(quality?.issues||[]).map(i=>i.note||i.kind));
    if(validation.state==='passed'&&validation.warnings.length)validation.state='review';
    layout={...layout,conversionId,engine,rendererHash:RENDERER_HASH,validation,builtAt:new Date().toISOString()};
    if(validation.errors.length){await writeJson(join(revision,'validation.json'),validation);throw new Error('Новая версия не активирована: '+validation.errors.join('; '));}
    // Keep the previous pre-versioning page as a complete rollback snapshot.
    if(before&&!before.conversionId){
      const backup=join(dir,'revisions','legacy-'+Date.now());await mkdir(backup,{recursive:true});
      for(const f of ['layout.json','index.html','ocr.json'])if(existsSync(join(dir,f)))await copyFile(join(dir,f),join(backup,f));
      if(existsSync(join(dir,'assets')))await (await import('node:fs/promises')).cp(join(dir,'assets'),join(backup,'assets'),{recursive:true});
    }
    if(image){
      const files=await writeAssets(revision,layout,image);
      layout.assets=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,`revisions/${conversionId}/${v}`]));
    }
    // Store exact-tone recordings in the immutable revision, so studio,
    // export and publication all use the same local audio files.
    for(const key of core.phoneticRecordings(layout)){
      const name=`phonetic-${key.replace(/ü/g,'v')}.mp3`,source=join(CODE,'phonetics',`${key.replace(/ü/g,'v')}.mp3`);
      if(!existsSync(source))throw new Error(`Нет учебной записи: ${key}`);
      await mkdir(join(revision,'assets'),{recursive:true});await copyFile(source,join(revision,'assets',name));
      layout.assets||={};layout.assets[`phonetic-${key}`]=`revisions/${conversionId}/assets/${name}`;
    }
    for(const key of core.toneRecordings(layout)){
      const name=`tone-${key}.mp3`,source=join(CODE,'phonetics','tones',`${key}.mp3`);
      if(!existsSync(source))throw new Error(`Нет записи слога с тоном: ${key}. Синтез речи не заменяет учебную запись.`);
      await mkdir(join(revision,'assets'),{recursive:true});
      await copyFile(source,join(revision,'assets',name));
      layout.assets||={};layout.assets[`tone-${key}`]=`revisions/${conversionId}/assets/${name}`;
    }
    await copyFile(join(CODE,'components.css'),join(revision,'components.css'));
    await writeFile(join(revision,'runtime.js'),rendererScript());
    await writeJson(join(revision,'layout.json'),layout);
    // Assets are immutable before the active layout is replaced. Failed asset
    // extraction never removes the currently displayed page's files.
    const previousHtml=await readFile(join(dir,'index.html')).catch(()=>null);
    try {
      await writeJson(join(dir,'layout.json'),layout);
      await writePageHtml(id,n,layout);
    } catch(error) {
      if(before)await writeJson(join(dir,'layout.json'),before);
      else await rm(join(dir,'layout.json'),{force:true});
      if(previousHtml)await atomicWrite(join(dir,'index.html'),previousHtml);
      throw error;
    }
    await copyFile(join(dir,'index.html'),join(revision,'index.html'));
    if(validation.state==='passed')autoRepublish(id,n);
    return {conversionId,validation,html:`/library/${id}/pages/${pad3(n)}/index.html`};
  }

  async function adoptLocal({ book:id, page:n, conversionId, ocr, quality }) {
    const dir=pageDir(id,n), cached=await readJson(join(dir,'model.json'));
    const {loadImage}=await canvasLib(), image=await loadImage(await readFile(join(dir,'scan.png')));
    const grid=await pixelGrid(image);
    // Preserve the semantic understanding from a cached model, while geometry
    // and fine print come from the current local OCR. No new paid request.
    let base=cached?.content?core.fromModel(core.parseModelJson(cached.content),image.width,image.height):layoutFromOcr(ocr);
    // The original line OCR and refined word/character OCR are complementary.
    // Line boxes drive grouping; refined tokens remain source evidence.
    const lineOcr=await readJson(join(dir,'ocr.json'));
    let layout=cached?.content?core.snap(base,grid,lineOcr?.lines?.length?lineOcr:ocr):base;
    layout.sourceTokens=ocr.lines;layout.quality=quality;
    layout.decorations=core.absorbIntoImages(layout,core.findDecorations(layout,grid));
    const result=await commitPage(id,n,layout,{conversionId,image,quality,engine:'local-structure'});
    await writeJson(join(dir,'status.json'),{state:'done',conversionId,validation:result.validation,finishedAt:new Date().toISOString(),steps:[]});
    return result;
  }

  // ---- fidelity: the page as readers see it, scored against its scan ----
  // fidelity.json holds the numbers, fidelity.png the map of differences.

  async function scoreNow(id, n) {
    if (!origin) throw new Error('Оценка сходства доступна только в запущенной студии.');
    const dir = pageDir(id, n);
    if (!existsSync(join(dir, 'index.html'))) throw new Error('Страница ещё не сконвертирована.');
    const version=(await readJson(join(dir,'layout.json')))?.conversionId;
    const { report, heatPng } = await scorePage({ scanFile: await ensureScan(id, n), frameUrl: `${origin}/webbook/render-frame.html`, pageUrl: `/library/${id}/pages/${pad3(n)}/index.html`, work: join(dir,'checks',version||'legacy') });
    report.conversionId=version;
    if((await readJson(join(dir,'layout.json')))?.conversionId!==version)return {...report,stale:true};
    await writeFile(join(dir, 'fidelity.png'), heatPng);
    await writeJson(join(dir, 'fidelity.json'), report);
    return report;
  }

  const scoreTimers = new Map();
  function autoScore(id, n) {
    if (!origin) return;
    const key = `${id}:${n}`;
    clearTimeout(scoreTimers.get(key));
    scoreTimers.set(key, setTimeout(() => { scoreTimers.delete(key); scoreNow(id, n).catch(() => {}); }, 1500));
  }

  // ---- golden pages: approved pages the converter must not make worse ----

  const regress = () => import('./regress.mjs');
  async function setGolden(id, n, on) {
    const { readGolden, writeGolden, runRegression } = await regress();
    const golden = await readGolden(id);
    if (on) golden.pages[n] = golden.pages[n] || {}; else delete golden.pages[n];
    await writeGolden(id, golden);
    // The baseline is the automatic build of the current code.
    if (on) runRegression({ book: id, pages: [n], accept: true, log: () => {} }).catch(() => {});
    return { golden: Object.keys(golden.pages).map(Number) };
  }
  let regressRun = null;
  async function checkGolden(id) {
    if (regressRun) throw new Error('Проверка эталонов уже идёт.');
    const lines = [];
    regressRun = (await regress()).runRegression({ book: id, log: s => lines.push(s) });
    try { const r = await regressRun; return { ...r, lines }; } finally { regressRun = null; }
  }

  // Replace the book's cast: portraits arrive as data URLs from the studio,
  // are stored as WebP, and every converted page is re-published.
  async function saveCast(id, body) {
    const { loadImage, createCanvas } = await canvasLib();
    const dir = join(bookDir(id), 'cast');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
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
      }
      characters.push({ id: cid, names, file, v });
    }
    const manual = Object.fromEntries(Object.entries(body.manual || {}).filter(([k, val]) => k && typeof val === 'string').slice(0, 500));
    const cast = { characters, manual, signature: String(body.signature || ''), updatedAt: new Date().toISOString() };
    await writeJson(join(dir, 'cast.json'), cast);
    let pages = 0;
    if (existsSync(join(bookDir(id), 'pages'))) for (const d of await readdir(join(bookDir(id), 'pages'))) {
      const layout = await readJson(join(bookDir(id), 'pages', d, 'layout.json'));
      if (layout) { await writePageHtml(id, Number(d), layout); autoRepublish(id, Number(d)); pages++; }
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
        snapped.decorations = core.absorbIntoImages(snapped, core.findDecorations(snapped, grid));
        snapped.model = answer.model; snapped.cost = answer.cost; snapped.builtAt = new Date().toISOString();
        if(answer.needsReview)snapped.quality={issues:[{note:answer.needsReview}]};
        return { value: snapped, note: `${snapped.blocks.length} блоков, OCR-строк ${snapped.ocrLines}, декор ${snapped.decorations.length}` };
      });
      const committed = await step('assets', async () => ({value:await commitPage(id,n,layout.value,{image}),note:'Версия и ресурсы сохранены'}));
      job.conversionId=committed.value.conversionId;job.validation=committed.value.validation;
      await step('html', async () => ({note:committed.value.html}));
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
    const golden = (await readJson(join(bookDir(id), 'golden.json')))?.pages || {};
    for (let n = 1; n <= book.pages; n++) {
      const job = jobs.get(`${id}:${n}`);
      if (job && ['queued', 'running'].includes(job.state)) { pages.push({ n, state: job.state }); continue; }
      if (!done.has(pad3(n))) { pages.push({ n, state: 'none' }); continue; }
      const dir = pageDir(id, n);
      const state = existsSync(join(dir, 'layout.json')) ? 'done' : (await readJson(join(dir, 'status.json')))?.state === 'error' ? 'error' : 'none';
      // Published, and whether the page changed after it was published.
      const published = await readJson(join(dir, 'published.json'));
      let stale = false;
      if (published && existsSync(join(dir, 'layout.json'))) stale = (await stat(join(dir, 'layout.json'))).mtimeMs > Date.parse(published.publishedAt) + 2000;
      const fidelity = await readJson(join(dir, 'fidelity.json'));
      pages.push({ n, state, model: existsSync(join(dir, 'model.json')), edited: existsSync(join(dir, 'edited.flag')), published: published ? published.publishedAt : null, stale, pubError: published?.autoError && Date.parse(published.autoErrorAt) > Date.parse(published.publishedAt) ? published.autoError : '',
        score: fidelity?.score ?? null, golden: n in golden });
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
      layout.phonetics = await readPhonetics(id,n);
      layout.sourceRegions = await readSourceRegions(id,n);
      for (const cell of layout.phonetics?.cells || []) {
        const sound = `${cell.text}.mp3`;
        if(!existsSync(join(root,'webbook','phonetics',sound))||assets[`phonetic-${cell.text}`])continue;
        await writeFile(join(out,'assets',sound),await readFile(join(root,'webbook','phonetics',sound)));
        assets[`phonetic-${cell.text}`] = `assets/${sound}`;
      }
      const sourceOcr = await readJson(join(pageDir(id,n),'ocr.json'));
      if (sourceOcr?.lines?.length) {
        layout.sourceLines = sourceOcr.lines;
        const sourceName = `p${pad3(n)}-source.png`;
        await writeFile(join(out,'assets',sourceName),await readFile(await ensureScan(id,n)));
        assets.sourceScan = `assets/${sourceName}`;
      }
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

  // ---- publishing to the learning platform (Meili HSK Study) ----
  // The platform address lives in library/platform.json; its publish token
  // only in memory (or FORMA_PLATFORM_TOKEN), like the OpenRouter key.

  const platformFile = () => join(LIB, 'platform.json');
  let platformToken = process.env.FORMA_PLATFORM_TOKEN || '';
  async function platformSettings() {
    const saved = await readJson(platformFile()) || {};
    return { url: String(saved.url || '').replace(/\/+$/, ''), hasToken: Boolean(platformToken) };
  }
  // Per book: which section and level of the platform it goes to.
  async function bookPlatform(id) {
    const book = await readJson(join(bookDir(id), 'book.json'));
    if (!book) throw new Error('Книга не найдена.');
    const p = book.platform || {};
    return { book, section: p.section || 'HSK 1 v3.0', level: p.level || 'HSK 1', slug: p.slug || 'hsk1-v3' };
  }

  async function platformCall(path, init = {}) {
    const { url } = await platformSettings();
    if (!url) throw new Error('Укажите адрес платформы в блоке «Платформа».');
    if (!platformToken) throw new Error('Введите токен публикации платформы (FORMA_PUBLISH_TOKEN).');
    let response;
    try { response = await fetch(url + path, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${platformToken}` }, signal: AbortSignal.timeout(300000) }); }
    catch (e) { throw new Error(`Платформа не отвечает (${url}). Бесплатный сервер Render просыпается до минуты — повторите.`); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `Платформа вернула HTTP ${response.status}.`);
    return data;
  }

  // Lessons of the book: a lesson opener page starts a lesson; pages before
  // the next opener belong to it. Odd pages name it in the running head.
  async function lessonOf(id, n) {
    const dirs = existsSync(join(bookDir(id), 'pages')) ? (await readdir(join(bookDir(id), 'pages'))).map(Number).filter(k => k <= n).sort((a, b) => b - a) : [];
    let fallback = null;
    for (const k of dirs) {
      const layout = await readJson(join(pageDir(id, k), 'layout.json'));
      if (!layout) continue;
      const opener = layout.blocks.find(b => b.type === 'lesson' && /^\d+$/.test(b.number || ''));
      // The subtitle in every platform language: English as printed, Kazakh from the page's translation.
      if (opener) return { number: Number(opener.number), title: opener.cn || `第 ${opener.number} 课`, subtitle: opener.ru || opener.en || '', opener: k === n,
        i18n: { en: { subtitle: opener.en || '' }, kz: { subtitle: (layout.kz || {})[String(opener.ru || '').trim()] || '' } } };
      const head = layout.blocks.find(b => b.type === 'runhead' && /^\d+$/.test(b.number || ''));
      if (head && !fallback) fallback = { number: Number(head.number), title: head.cn || `第 ${head.number} 课`, subtitle: '', opener: false };
    }
    return fallback || { number: 0, title: 'Вводные страницы', subtitle: '', opener: false };
  }

  // What a page inherits from its lesson, for the multimedia textbook's
  // prompts: the lesson, its objectives (printed on the opener only), and the
  // situation line in force (a text's "开学第一天…" is printed on its first
  // page; the next pages continue the same scene).
  async function pageContext(id, n) {
    const lesson = await lessonOf(id, n);
    const dirs = existsSync(join(bookDir(id), 'pages')) ? (await readdir(join(bookDir(id), 'pages'))).map(Number).filter(k => k <= n).sort((a, b) => b - a) : [];
    let situation = null, objectives = [];
    for (const k of dirs) {
      const layout = await readJson(join(pageDir(id, k), 'layout.json'));
      if (!layout) continue;
      const pin = layout.blocks.find(b => b.type === 'para' && b.icon === 'pin');
      if (!situation && pin) situation = { cn: pin.cn || '', en: pin.en || '', ru: pin.ru || '', page: k };
      const obj = layout.blocks.find(b => b.type === 'objectives');
      if (obj) objectives = (obj.items || []).map(o => ({ cn: o.cn || '', en: o.en || '', ru: o.ru || '' }));
      if (layout.blocks.some(b => b.type === 'lesson')) break;   // the lesson's first page
    }
    // A text that starts on this page (situation, «read the dialogue», picture)
    // often prints its dialogue overleaf: take it from the next page(s) of the
    // same text — up to a page that opens a new text or lesson.
    let dialogue = null;
    const own = await readJson(join(pageDir(id, n), 'layout.json'));
    if (own && !own.blocks.some(b => b.type === 'dialogue')) {
      for (let k = n + 1; k <= n + 2; k++) {
        const next = await readJson(join(pageDir(id, k), 'layout.json'));
        if (!next || next.blocks.some(b => b.type === 'section' || b.type === 'lesson')) break;
        const blocks = next.blocks.filter(b => b.type === 'dialogue' || b.type === 'card');
        if (blocks.some(b => b.type === 'dialogue')) { dialogue = { page: k, blocks }; break; }
      }
    }
    return { lesson, situation, objectives, dialogue };
  }

  // Everything the platform's scenarios need about a page, read from its
  // layout: new words, the task, Xiaoyu's intro, sentence-builder pieces and
  // the tutor's context.
  function pageMeta(layout, n, lesson, level, bookStrip = 0) {
    const blocks = layout.blocks;
    // The platform page number follows the source PDF order. A printed
    // workbook folio (for example, 001 on PDF page 3) is page content, not
    // the page's position in the uploaded document.
    const sourcePage = String(n);
    const section = blocks.find(b => b.type === 'section')?.cn || '';
    // Build the dictionary from this page's semantic labels and vocabulary,
    // excluding phonetics tables such as initials/finals/tones.
    const kz = layout.kz || {}, k = s => kz[String(s || '').trim()] || '';
    const vocab = core.pageVocabulary(layout).map(item => ({ ...item,
      ...(item.trans_en ? { trans_en: item.trans_en } : {}),
      ...(k(item.trans) ? { trans_kz: k(item.trans) } : {})
    }));
    const square = blocks.find(b => b.type === 'para' && b.icon === 'square');
    const pin = blocks.find(b => b.type === 'para' && b.icon === 'pin');
    const turns = blocks.filter(b => b.type === 'dialogue').flatMap(b => b.turns || []);
    const first = turns.find(t => t.py && t.hz) || null;
    const pieces = [];
    if (first) {
      const html = (core.rubyHtml(first.hz, first.py) || '').replace(/<rt>.*?<\/rt>/g, '');
      // Pinyin words group the hanzi; punctuation stays with the word before.
      for (const [, word, other] of html.matchAll(/<ruby>(.*?)<\/ruby>|([^<]+)/g)) {
        const text = (word ?? other ?? '').replace(/<[^>]+>/g, '').trim();
        if (!text) continue;
        if (other !== undefined && pieces.length) pieces[pieces.length - 1] += text;
        else pieces.push(text);
      }
      if (!pieces.length) pieces.push(...first.hz.split(/(?<=[，。！？、])/).map(s => s.trim()).filter(Boolean));
    }
    const lines = turns.map(t => `${t.speaker?.cn || ''}：${t.hz}`).join(' ');
    // The blank binding strip (paper left of the page colour) is not shown
    // on the platform, when nothing is printed on it.
    const strip = layout.theme?.background?.box?.x || 0, crop = {};
    if (strip > 0.01 && strip <= 0.2 && !blocks.some(b => b.type !== 'folio' && b.box && b.box.x < strip - 0.005)
        && !(layout.decorations || []).some(d => d.box.x < strip - 0.005)) crop.left = +strip.toFixed(4);
    // Pages without the strip lose the same width of blank outer margin, so
    // every page of the book has one shape and the reader does not jump.
    const margin = crop.left ? 0 : (bookStrip || 0);
    if (margin > 0.01 && !blocks.some(b => b.type !== 'folio' && b.box && b.box.x + b.box.w > 1 - margin + 0.005)
        && !(layout.decorations || []).some(d => d.box.x < 0.97 && d.box.x + d.box.w > 1 - margin + 0.005)) crop.right = +margin.toFixed(4);
    const about = `Урок ${lesson.number}: ${lesson.title}${lesson.subtitle ? ` (${lesson.subtitle})` : ''}`;
    return {
      n, pageNum: `с. ${sourcePage}`, navLabel: `Стр. ${sourcePage}${section ? ' · ' + section : ''}`, aspect: `${layout.page?.width || 2342}/${layout.page?.height || 3190}`, crop,
      chaoIntro: (pin ? pin.ru || pin.en || pin.cn : '') || `${about}. Нажимай на слова и реплики, чтобы услышать их.`,
      task: square ? [square.cn, square.ru || square.en].filter(Boolean).join(' ') : 'Прочитай страницу и повтори новые слова.',
      builderWords: pieces.filter(Boolean).slice(0, 12),
      systemPrompt: `Ты Мейли — репетитор ${level}. ${about}. Страница ${sourcePage}.${lines ? ' Реплики страницы: ' + lines.slice(0, 1500) : ''}`,
      // Xiaoyu's intro and the page task in the other platform languages (Russian stays the default).
      i18n: (() => {
        const kz = layout.kz || {}, k = s => kz[String(s || '').trim()] || '';
        // Pages without a situation line or a task get the same fallback as in Russian, in each language.
        const sub = lang => lesson.i18n?.[lang]?.subtitle || '', head = lang => lang === 'kz' ? `${lesson.number}-сабақ: ${lesson.title}${sub('kz') ? ` (${sub('kz')})` : ''}` : `Lesson ${lesson.number}: ${lesson.title}${sub('en') ? ` (${sub('en')})` : ''}`;
        const intro = { en: pin?.en || `${head('en')}. Click words and lines to hear them.`, kz: k(pin?.ru) || `${head('kz')}. Сөздер мен репликаларды басып, тыңдаңыз.` };
        const task = { en: square ? [square.cn, square.en].filter(Boolean).join(' ') : 'Read the page and repeat the new words.', kz: square && k(square.ru) ? [square.cn, k(square.ru)].filter(Boolean).join(' ') : square ? '' : 'Бетті оқып, жаңа сөздерді қайталаңыз.' };
        return { en: { chaoIntro: intro.en, task: task.en }, kz: { chaoIntro: intro.kz, task: task.kz } };
      })(),
      vocab,
    };
  }

  // Width of the blank binding strip in this book (from any page that has it).
  async function bookStripOf(id) {
    const dirs = existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : [];
    for (const d of dirs) { const x = (await readJson(join(bookDir(id), 'pages', d, 'layout.json')))?.theme?.background?.box?.x; if (x > 0.01 && x <= 0.2) return x; }
    return 0;
  }

  // ---- Kazakh ----
  // Every Russian text of the page (keys `ru` and `*_ru`) with its English
  // twin as context, translated by Qwen from the Alibaba subscription.
  function russianTexts(layout) {
    const out = new Map();
    const walk = o => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /(^|_)ru$/.test(k) && v.trim()) { const en = o[k.replace(/ru$/, 'en')]; if (!out.has(v.trim())) out.set(v.trim(), typeof en === 'string' ? en : ''); }
        else if (v && typeof v === 'object' && k !== 'box' && k !== 'kz') walk(v);
      }
    };
    walk(layout.blocks);
    return out;
  }
  async function qwenJson(prompt) {
    const key = getAliKey();
    if (!key) throw new Error('Подключите ключ Alibaba (окно «Настроить ключ»): перевод делает Qwen по подписке.');
    const r = await fetch('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.7-plus', temperature: 0.2, enable_thinking: false, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Qwen: ' + (d.error?.message || d.message || 'HTTP ' + r.status));
    return core.parseModelJson(d.choices?.[0]?.message?.content || '{}');
  }
  // ---- A dialogue written for a page that has none ----
  // Only what the learner already knows: the words and lines of this book up
  // to this page. Every hanzi of the answer is checked against them; one retry
  // names the characters that slipped through.
  async function writeDialogue(id, n) {
    const ctx = await pageContext(id, n), { level } = await bookPlatform(id);
    const dirs = (await readdir(join(bookDir(id), 'pages'))).map(Number).filter(k => k <= n).sort((a, b) => a - b);
    const words = new Map(), lines = [], speakers = new Map();
    let page = null;
    for (const k of dirs) {
      const layout = await readJson(join(pageDir(id, k), 'layout.json'));
      if (!layout) continue;
      if (k === n) page = layout;
      for (const b of layout.blocks) {
        if (b.type === 'words') for (const r of b.rows || []) if (!r.group && r.hz) words.set(r.hz, r.ru || r.en || '');
        if (b.type === 'dialogue') for (const t of b.turns || []) { if (t.hz) lines.push(t.hz); if (t.speaker?.cn) speakers.set(t.speaker.cn, { cn: t.speaker.cn, py: t.speaker.py || '', ru: t.speaker.ru || '' }); }
      }
    }
    if (!page) throw new Error(`Страница ${n} ещё не сконвертирована.`);
    const known = new Set([...[...words.keys()].join(''), ...lines.join('')].filter(c => /\p{Script=Han}/u.test(c)));
    const pageText = page.blocks.filter(b => ['para', 'section', 'tip'].includes(b.type)).map(b => [b.cn, b.ru].filter(Boolean).join(' — ')).join('\n');
    const pictures = page.blocks.filter(b => b.type === 'image' && b.alt).map(b => b.alt).join('; ');
    const brief = [
      `Учебник: ${level || 'HSK 1'}, урок ${ctx.lesson?.number || ''} «${ctx.lesson?.title || ''}» (${ctx.lesson?.subtitle || ''}).`,
      ctx.objectives?.length ? 'Цели урока:\n' + ctx.objectives.map(o => '- ' + (o.ru || o.en || o.cn)).join('\n') : '',
      ctx.situation ? `Ситуация: ${ctx.situation.cn} (${ctx.situation.ru})` : '',
      pageText ? 'Текст страницы:\n' + pageText : '', pictures ? 'Картинки страницы: ' + pictures : '',
      speakers.size ? 'Герои книги (используй их): ' + [...speakers.values()].map(s => `${s.cn} (${s.py}, ${s.ru})`).join(', ') : '',
      'Слова, которые ученик уже знает: ' + [...words.keys()].join('、'),
      'Примеры фраз из учебника: ' + lines.slice(-30).join(' ')
    ].filter(Boolean).join('\n');
    const ask = extra => 'Ты автор учебника китайского языка. Напиши короткий живой диалог (4–6 реплик) для этой страницы: он показывает ситуацию страницы и отрабатывает цели урока. ' +
      `Уровень ученика: ${level || 'HSK 1'}. Используй ТОЛЬКО слова и иероглифы, которые ученик уже знает (список ниже), короткие простые предложения как в примерах; имена героев можно. ` +
      'Для каждой реплики дай: говорящего (иероглифы, пиньинь, русское имя), реплику иероглифами, пиньинь с тонами, перевод на русский и английский. ' +
      'Верни только JSON: {"turns":[{"speaker":{"cn":"","py":"","ru":""},"hanzi":"","pinyin":"","translation":"","english":""}]}\n\n' + brief + (extra || '');
    let turns = [], unknown = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await qwenJson(ask(unknown.length ? `\n\nВ прошлом варианте были незнакомые ученику иероглифы: ${unknown.join(' ')}. Замени их знакомыми словами.` : ''));
      turns = (Array.isArray(got.turns) ? got.turns : []).filter(t => t && t.hanzi).slice(0, 8);
      const names = new Set([...speakers.keys()].join('') + turns.map(t => t.speaker?.cn || '').join(''));
      unknown = [...new Set(turns.map(t => t.hanzi).join('').split('').filter(c => /\p{Script=Han}/u.test(c) && !known.has(c) && !names.has(c)))];
      if (turns.length && !unknown.length) break;
    }
    if (!turns.length) throw new Error('Модель не вернула диалог.');
    return { turns, unknown, level: level || 'HSK 1', knownWords: words.size };
  }

  // Parts of speech get fixed Kazakh school abbreviations, not a model's guess.
  const POS_KZ = { 'сущ.': 'зат.', 'прил.': 'сын.', 'гл.': 'ет.', 'мест.': 'есімд.', 'нареч.': 'үст.', 'числ.': 'сан.', 'сч. сл.': 'мөлш.', 'счётн. сл.': 'мөлш.',
    'суф.': 'жұрн.', 'част.': 'шыл.', 'предл.': 'шыл.', 'союз': 'жалғ.', 'межд.': 'од.', 'мод. гл.': 'көм. ет.', 'вспом. гл.': 'көм. ет.', 'собств.': 'жалқы есім' };
  async function translateKazakh(id, n, force = false) {
    const dir = pageDir(id, n), layout = await readJson(join(dir, 'layout.json'));
    if (!layout) throw new Error(`Страница ${n} ещё не сконвертирована.`);
    const kz = force ? {} : { ...(layout.kz || {}) }, texts = russianTexts(layout);
    for (const ru of texts.keys()) if (POS_KZ[ru]) kz[ru] = POS_KZ[ru];
    const todo = [...texts].filter(([ru]) => !kz[ru]);
    for (let i = 0; i < todo.length; i += 60) {
      const part = todo.slice(i, i + 60);
      const prompt = 'Ты переводишь учебник китайского языка (HSK) для казахстанских учеников. Переведи каждую русскую строку на казахский язык (кириллица), естественно и кратко, как в учебнике. ' +
        'Английский оригинал дан для смысла. Китайские иероглифы, пиньинь, номера, знаки и форматирование сохраняй как есть. Имена китайских героев передавай по-казахски (Ван Ифэй, Сяоюй). ' +
        'Термины и сокращения грамматики — как в казахских школьных учебниках (зат есім, сын есім, есімдік, етістік, жұрнақ, көптік жалғау). «Одушевлённые существительные» — «адамды білдіретін зат есімдер». Пиши кратко: строки стоят в узких колонках учебника. ' +
        'Верни только JSON-объект {"<русская строка ровно как дана>": "<казахский перевод>"} для всех строк.\n\n' +
        JSON.stringify(Object.fromEntries(part.map(([ru, en]) => [ru, en ? `EN: ${en}` : ''])), null, 1);
      const got = await qwenJson(prompt);
      for (const [ru] of part) if (typeof got[ru] === 'string' && got[ru].trim()) kz[ru] = got[ru].trim();
    }
    layout.kz = kz;
    await commitPage(id,n,layout);
    return { texts: texts.size, translated: [...texts.keys()].filter(ru => kz[ru]).length };
  }

  // scan.png (288 dpi, several MB) → scan-web.webp 1600 px wide, rebuilt when the scan changes.
  async function webScan(dir) {
    const src = join(dir, 'scan.png'), out = join(dir, 'scan-web.webp');
    if (!existsSync(src)) return null;
    if (existsSync(out) && (await stat(out)).mtimeMs >= (await stat(src)).mtimeMs) return out;
    const { loadImage, createCanvas } = await canvasLib();
    const img = await loadImage(await readFile(src)), w = Math.min(1600, img.width), h = Math.round(img.height * w / img.width);
    const c = createCanvas(w, h); c.getContext('2d').drawImage(img, 0, 0, w, h);
    await writeFile(out, await c.encode('webp', 82));
    return out;
  }

  async function publishPage(id, n, expectedId) {
    const dir = pageDir(id, n), layout = await readJson(join(dir, 'layout.json'));
    if (!layout) throw new Error(`Страница ${n} ещё не сконвертирована.`);
    if(expectedId && expectedId!==layout.conversionId)throw new Error('Версия страницы изменилась. Обновите предпросмотр перед публикацией.');
    if(layout.rendererHash && layout.rendererHash!==RENDERER_HASH)throw new Error('Движок страницы обновлён. Пересоберите страницу перед публикацией новой версией движка.');
    const checked=validatePage(layout,{requireKz:Boolean(Object.keys(layout.kz||{}).length)});
    if(checked.errors.length)throw new Error('Публикация остановлена: '+checked.errors.join('; '));
    const { book, section, level, slug } = await bookPlatform(id);
    const base = `/forma/books/${slug}/`, pageBase = `${base}pages/${pad3(n)}/`;
    const cast = await readCast(id);
    const files = [];   // [platform path, local file]
    const castPaths = new Map();
    const applied = core.applyCast(layout, cast, c => { castPaths.set(c.file, `cast/${c.file}`); return `${base}cast/${c.file}?v=${c.v || 0}`; });
    const assets = {};
    for (const [key, rel] of Object.entries(layout.assets || {})) {
      const safeKey=key.replace(/[^A-Za-z0-9_-]/gu,c=>'u'+c.codePointAt(0).toString(16));
      const target=layout.conversionId?`assets/${layout.conversionId}-${safeKey}${extname(rel)}`:rel;
      assets[key] = pageBase + target; files.push([`pages/${pad3(n)}/${target}`, join(dir, rel)]);
    }
    Object.assign(assets, applied.assets);
    for (const [file, path] of castPaths) files.push([path, join(bookDir(id), 'cast', file)]);
    const clip = await readClip(id, n);
    if (clip?.file && existsSync(join(dir, clip.file))) {
      files.push([`pages/${pad3(n)}/${clip.file}`, join(dir, clip.file)]);
      Object.assign(assets, { clip: `${pageBase}${clip.file}?v=${clip.v}`, clipType: clip.type });
      if (clip.poster && existsSync(join(dir, clip.poster))) { files.push([`pages/${pad3(n)}/${clip.poster}`, join(dir, clip.poster)]); assets.clipPoster = `${pageBase}${clip.poster}?v=${clip.v}`; }
    }
    // The recordings this page marks travel with it (one copy per page on the platform).
    const have = await bookAudio(id);
    assets.audio = {};
    for (const t of tracksOf(layout)) if (have[t]) {
      const name = `track-${have[t].file}`;
      files.push([`pages/${pad3(n)}/assets/${name}`, join(bookDir(id), 'audio', have[t].file)]);
      assets.audio[t] = `${pageBase}assets/${name}?v=${have[t].v}`;
    }
    // A light copy of the printed page, for the reader's «original» button.
    const scan = await webScan(dir);
    if (scan) files.push([`pages/${pad3(n)}/scan.webp`, scan]);
    const sourceOcr = await readJson(join(dir,'ocr.json'));
    if (scan && sourceOcr?.lines?.length) {
      applied.layout.sourceLines = sourceOcr.lines;
      assets.sourceScan = `${pageBase}scan.webp`;
    }
    applied.layout.phonetics = await readPhonetics(id,n);
    applied.layout.sourceRegions = await readSourceRegions(id,n);
    for (const cell of applied.layout.phonetics?.cells || []) {
      const name = `${cell.text}.mp3`;
      if(!existsSync(join(root,'webbook','phonetics',name))||assets[`phonetic-${cell.text}`])continue;
      files.push([`pages/${pad3(n)}/assets/${name}`,join(root,'webbook','phonetics',name)]);
      assets[`phonetic-${cell.text}`] = `${pageBase}assets/${name}`;
    }
    const lesson = await lessonOf(id, n);
    const html = core.render(applied.layout, { assets, lang: 'russian', pinyin: true });
    const meta = { book: { slug, title: book.name, section, level }, page: { ...pageMeta(applied.layout, n, lesson, level, await bookStripOf(id)), ...(scan ? { scan: 'scan.webp' } : {}) }, conversionId:layout.conversionId, lesson, files: files.map(f => f[0]) };
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('html', html);
    form.append('css', await readFile(layout.conversionId?join(dir,'revisions',layout.conversionId,'components.css'):join(root, 'webbook', 'components.css'), 'utf8'));
    form.append('script', layout.conversionId && existsSync(join(dir,'revisions',layout.conversionId,'runtime.js')) ? await readFile(join(dir,'revisions',layout.conversionId,'runtime.js'),'utf8') : rendererScript());
    for (const [path, local] of files) form.append('files', new Blob([await readFile(local)]), path.split('/').pop());
    const result = await platformCall('/api/forma/pages', { method: 'POST', body: form });
    const record = { publishedAt: result.publishedAt || new Date().toISOString(), lessonId: result.lessonId, lesson: lesson.number, section, slug, conversionId:layout.conversionId };
    await writeJson(join(dir, 'published.json'), record);
    return record;
  }

  // A page that is already on the platform follows every change made in the
  // studio: saved edits, rebuilds, a new clip, new character portraits. The
  // update runs in the background a moment after the last change; its outcome
  // is kept in published.json for the console.
  const autoTimers = new Map();
  function autoRepublish(id, n) {
    const key = `${id}:${n}`;
    clearTimeout(autoTimers.get(key));
    autoTimers.set(key, setTimeout(async () => {
      autoTimers.delete(key);
      const file = join(pageDir(id, n), 'published.json'), record = await readJson(file);
      if (!record || !platformToken || !(await platformSettings()).url) return;
      const active=await readJson(join(pageDir(id,n),'layout.json'));
      if(active?.validation && active.validation.state!=='passed')return;
      try { await publishPage(id, n); }
      catch (e) { await writeJson(file, { ...record, autoError: e.message, autoErrorAt: new Date().toISOString() }).catch(() => {}); }
    }, 1500));
  }

  async function unpublishPage(id, n) {
    const { slug } = await bookPlatform(id);
    await platformCall(`/api/forma/pages/${slug}/${n}`, { method: 'DELETE' });
    await rm(join(pageDir(id, n), 'published.json'), { force: true });
    return { ok: true };
  }

  // ---- routes ----

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/local/webbook/')) return false;
    const parts = url.pathname.slice('/local/webbook/'.length).split('/').filter(Boolean);
    try {
      if (parts[0] === 'platform' && parts.length === 1) {
        if (req.method === 'GET') return sendJson(res, 200, await platformSettings()), true;
        if (req.method === 'PUT') {
          const b = await bodyJson(req);
          if (typeof b.url === 'string') {
            const url = b.url.trim().replace(/\/+$/, '');
            if (url && !/^https?:\/\/[^\s/]+/i.test(url)) return sendJson(res, 400, { error: 'Адрес платформы должен начинаться с https://' }), true;
            await mkdir(LIB, { recursive: true });
            await writeJson(platformFile(), { url });
          }
          if (typeof b.token === 'string') platformToken = b.token.trim();
          const settings = await platformSettings();
          if (settings.url && settings.hasToken) {
            try { await platformCall('/api/forma/health'); settings.check = 'ok'; } catch (e) { settings.check = e.message; }
          }
          return sendJson(res, 200, settings), true;
        }
      }
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
      if (parts[2] === 'platform' && parts.length === 3) {
        if (req.method === 'GET') { const p = await bookPlatform(id); return sendJson(res, 200, { section: p.section, level: p.level, slug: p.slug }), true; }
        if (req.method === 'PUT') {
          const b = await bodyJson(req), book = await readJson(join(bookDir(id), 'book.json'));
          if (!book) return sendJson(res, 404, { error: 'Книга не найдена.' }), true;
          const slug = String(b.slug || '').trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return sendJson(res, 400, { error: 'Код книги на платформе: латиница, цифры и дефис.' }), true;
          book.platform = { section: String(b.section || 'HSK 1 v3.0').trim().slice(0, 80), level: String(b.level || 'HSK 1').trim().slice(0, 20), slug };
          await writeJson(join(bookDir(id), 'book.json'), book);
          return sendJson(res, 200, book.platform), true;
        }
      }
      if (parts[2] === 'export' && req.method === 'POST') {
        const b = await bodyJson(req);
        return sendJson(res, 200, await exportBook(id, Math.max(1, +b.from || 1), Math.max(1, +b.to || 9999))), true;
      }
      if (parts[2] === 'golden-check' && req.method === 'POST') return sendJson(res, 200, await checkGolden(id)), true;
      if (parts[2] === 'level' && req.method === 'POST') return sendJson(res, 200, await levelBook(id)), true;
      if (parts[2] === 'audio' && !parts[3] && req.method === 'GET') return sendJson(res, 200, await audioState(id)), true;
      if (parts[2] === 'audio' && parts[3] === 'import' && req.method === 'POST') return sendJson(res, 200, await importAudio(id, (await bodyJson(req)).folder)), true;
      // Re-render every page's HTML from its stored layout (manual edits kept)
      // after a change in how components are drawn; published pages follow.
      if (parts[2] === 'rerender' && req.method === 'POST') {
        let pages = 0;
        for (const d of existsSync(join(bookDir(id), 'pages')) ? await readdir(join(bookDir(id), 'pages')) : []) {
          const layout = await readJson(join(bookDir(id), 'pages', d, 'layout.json'));
          if (layout) { await writePageHtml(id, Number(d), layout); autoRepublish(id, Number(d)); pages++; }
        }
        return sendJson(res, 200, { pages }), true;
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
      if (what === 'context' && req.method === 'GET') return sendJson(res, 200, await pageContext(id, n)), true;
      if (what === 'fidelity' && req.method === 'GET') return sendJson(res, 200, await readJson(join(dir, 'fidelity.json')) || {}), true;
      if (what === 'fidelity' && req.method === 'POST') return sendJson(res, 200, await scoreNow(id, n)), true;
      if (what === 'golden' && req.method === 'PUT') return sendJson(res, 200, await setGolden(id, n, Boolean((await bodyJson(req)).on))), true;
      if (what === 'publish' && req.method === 'POST') return sendJson(res, 200, await publishPage(id, n,(await bodyJson(req)).conversionId)), true;
      if (what === 'publish' && req.method === 'DELETE') return sendJson(res, 200, await unpublishPage(id, n)), true;
      if (what === 'clip' && req.method === 'GET') return sendJson(res, 200, await readClip(id, n) || {}), true;
      if (what === 'clip' && req.method === 'PUT') {
        const clip = await saveClip(id, n, req, String(req.headers['content-type'] || 'video/mp4').split(';')[0].trim());
        await republish(id, n);
        autoRepublish(id, n);
        return sendJson(res, 200, clip), true;
      }
      if (what === 'dialogue' && req.method === 'POST') return sendJson(res, 200, await writeDialogue(id, n)), true;
      if (what === 'kazakh' && req.method === 'POST') return sendJson(res, 200, await translateKazakh(id, n, url.searchParams.get('force') === '1')), true;
      if (what === 'clip' && req.method === 'DELETE') {
        const r = await withClipLock(id, n, () => removeClip(id, n));
        await republish(id, n);
        autoRepublish(id, n);
        return sendJson(res, 200, r), true;
      }
      if (what === 'clip-poster' && req.method === 'PUT') {
        const clip = await withClipLock(id, n, () => saveClipPoster(id, n, req));
        await republish(id, n);
        autoRepublish(id, n);
        return sendJson(res, 200, clip), true;
      }
      if (what === 'job' && req.method === 'GET') {
        return sendJson(res, 200, jobs.get(`${id}:${n}`) || await readJson(join(dir, 'status.json')) || { state: 'none' }), true;
      }
      if(what==='revisions' && req.method==='GET') {
        const base=join(dir,'revisions'),list=[];
        for(const name of await readdir(base).catch(()=>[])){
          const saved=await readJson(join(base,name,'layout.json'));
          if(saved)list.push({conversionId:name,builtAt:saved.builtAt,validation:saved.validation});
        }
        return sendJson(res,200,list),true;
      }
      if(what==='rollback' && req.method==='POST') {
        const {conversionId}=await bodyJson(req);
        if(typeof conversionId!=='string'||!/^[a-zA-Z0-9-]{1,90}$/.test(conversionId))throw new Error('Некорректный ID версии.');
        const saved=await readJson(join(dir,'revisions',conversionId,'layout.json'));
        if(!saved)throw new Error('Сохранённая версия не найдена.');
        const result=await commitPage(id,n,saved,{engine:'rollback'});
        return sendJson(res,200,result),true;
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
        const layout = { ...old, blocks: b.layout.blocks, theme: b.layout.theme || old.theme, editedAt: new Date().toISOString() };
        await commitPage(id,n,layout);
        await writeFile(join(dir, 'edited.flag'), layout.editedAt);
        return sendJson(res, 200, { ok: true, editedAt: layout.editedAt }), true;
      }
      return sendJson(res, 404, { error: 'Не найдено.' }), true;
    } catch (e) {
      sendJson(res, 500, { error: e.message || 'Ошибка конвертера.' });
      return true;
    }
  }

  return { handle, renderScan: ensureScan, adoptLocal };
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

export async function writeZip(dir, zipPath) {
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
