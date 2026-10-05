// Fidelity check: how close a converted web page is to its scan.
//
// The page is rendered by headless Edge at the scan's proportions, both
// images are reduced to the same small size (which also hides scan grain),
// and compared three ways:
//   ssim   - structure (layout, shapes, text blocks), 0..1
//   ink    - dark/coloured marks present in both, tolerating a small shift;
//            "missing" = on the scan but not on the web page, "extra" = the
//            opposite. Reported as an F1 score 0..1
//   colour - share of pixels whose colour matches
// and combined into one score 0..100. A heatmap shows where they differ:
// red = missing ink, blue = extra ink, amber = wrong colour; the worst
// regions are outlined.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const RUNTIME = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
let canvasPromise;
const canvasLib = () => (canvasPromise ||= import(pathToFileURL(join(RUNTIME, '@napi-rs', 'canvas', 'index.js')).href));

export const RENDER_W = 1200;   // page width in the screenshot
export const CMP_W = 600;       // comparison width
const COLS = 6, ROWS = 8;       // regions for the per-area report
const INK_LUM = 150, SHIFT = 2, COLOUR_TOL = 40;

const BROWSERS = [
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
];

// A headless browser per process, driven over the DevTools protocol, so a
// screenshot is taken only once the page's web fonts, images and the fit
// step are done (a plain --screenshot raced the font download and measured
// fallback fonts). Its profile folder is per process (the studio and a CLI
// run each get one); folders of processes gone for a day are removed, and
// an idle browser closes after a minute.
const PROFILES = join(tmpdir(), 'forma-fidelity-edge');
readdir(PROFILES).then(ds => ds.forEach(async d => {
  const p = join(PROFILES, d);
  if (d !== String(process.pid) && Date.now() - (await stat(p)).mtimeMs > 86400000) await rm(p, { recursive: true, force: true });
})).catch(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let browserRun = null, idleTimer = 0;
function startBrowser() {
  return browserRun ||= (async () => {
    const exe = BROWSERS.find(existsSync);
    if (!exe) throw new Error('Не найден Microsoft Edge или Chrome для снимка страницы.');
    const profile = join(PROFILES, String(process.pid)), portFile = join(profile, 'DevToolsActivePort');
    await mkdir(profile, { recursive: true }); await rm(portFile, { force: true });
    const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--mute-audio',
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    process.once('exit', () => proc.kill());
    proc.once('exit', () => { browserRun = null; });
    for (let i = 0; i < 150; i++) {
      const [port, path] = (await readFile(portFile, 'utf8').catch(() => '')).split('\n');
      if (path) return { proc, url: `ws://127.0.0.1:${port.trim()}${path.trim()}` };
      await sleep(100);
    }
    proc.kill(); throw new Error('Браузер для снимков не запустился.');
  })().catch(e => { browserRun = null; throw e; });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), waiting = new Map(), events = [];
    let seq = 0;
    ws.onerror = () => reject(new Error('Нет связи с браузером для снимков.'));
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { const [ok, fail] = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? fail(new Error(msg.error.message)) : ok(msg.result); }
      else events.push(msg);
    };
    const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; waiting.set(id, [ok, fail]); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    ws.onopen = () => resolve({ send, events, close: () => ws.close() });
  });
}

// What "the page is ready" means: the frame's page is in, fonts loaded,
// images decoded, video showing a frame, and the fit step has re-run.
const READY = `(async () => {
  const f = document.getElementById('f');
  for (let i = 0; i < 300 && !(f.contentDocument?.readyState === 'complete' && f.contentDocument.querySelector('.hsk-page')); i++) await new Promise(r => setTimeout(r, 50));
  const d = f.contentDocument; if (!d) return false;
  await d.fonts.ready;
  await Promise.all([...d.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 5000); })));
  await Promise.all([...d.querySelectorAll('video')].map(v => v.readyState >= 2 ? 0 : new Promise(r => { v.onloadeddata = v.onerror = r; setTimeout(r, 3000); })));
  await new Promise(r => setTimeout(r, 300));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

let chain = Promise.resolve();
export function renderPng(url, w, h, out) {
  const run = chain.then(async () => {
    clearTimeout(idleTimer);
    const { proc, url: wsUrl } = await startBrowser();
    const cdp = await connect(wsUrl);
    let targetId;
    try {
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const s = (m, p) => cdp.send(m, p, sessionId);
      await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await s('Page.enable');
      // Styles and scripts change between runs: never serve them from cache.
      await s('Network.enable'); await s('Network.setCacheDisabled', { cacheDisabled: true });
      await s('Page.navigate', { url });
      const ready = await Promise.race([s('Runtime.evaluate', { expression: READY, awaitPromise: true, returnByValue: true }), sleep(60000).then(() => null)]);
      if (!ready?.result?.value) throw new Error('Страница не загрузилась для снимка.');
      const shot = await s('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(out, Buffer.from(shot.data, 'base64'));
      return out;
    } finally {
      if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      cdp.close();
      idleTimer = setTimeout(() => proc.kill(), 60000);
    }
  });
  chain = run.catch(() => {});
  return run;
}

// Screenshot size for a scan of the given pixel size.
export const renderSize = (scanW, scanH) => ({ w: RENDER_W, h: Math.round(RENDER_W * scanH / scanW) });

async function pixels(buf, W, H) {
  const { loadImage, createCanvas } = await canvasLib();
  const img = await loadImage(buf);
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}

// Sum over a (2r+1)² window via an integral image.
function boxMean(src, W, H, r) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += src[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      out[y * W + x] = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function ssimMap(a, b, W, H) {
  const r = 4, n = W * H, ab = new Float64Array(n), aa = new Float64Array(n), bb = new Float64Array(n);
  for (let i = 0; i < n; i++) { ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; }
  const ma = boxMean(a, W, H, r), mb = boxMean(b, W, H, r), mab = boxMean(ab, W, H, r), maa = boxMean(aa, W, H, r), mbb = boxMean(bb, W, H, r);
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const va = maa[i] - ma[i] ** 2, vb = mbb[i] - mb[i] ** 2, cov = mab[i] - ma[i] * mb[i];
    out[i] = ((2 * ma[i] * mb[i] + c1) * (2 * cov + c2)) / ((ma[i] ** 2 + mb[i] ** 2 + c1) * (va + vb + c2));
  }
  return out;
}

function dilate(mask, W, H, r) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < W) tmp[y * W + xx] = 1; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tmp[y * W + x]) for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < H) out[yy * W + x] = 1; }
  return out;
}

const combine = (ssim, ink, colour) => 100 * (0.45 * Math.max(0, ssim) + 0.35 * ink + 0.2 * colour);
const f1 = (hitScan, scanInk, hitWeb, webInk) => {
  if (scanInk + webInk < 12) return 1;                 // empty area: nothing to miss
  const recall = scanInk ? hitScan / scanInk : 1, precision = webInk ? hitWeb / webInk : 1;
  return recall + precision ? 2 * recall * precision / (recall + precision) : 0;
};

// Compare a scan with a screenshot of its web page (PNG buffers).
export async function compare(scanBuf, webBuf) {
  const { loadImage, createCanvas } = await canvasLib();
  const probe = await loadImage(scanBuf);
  const W = CMP_W, H = Math.round(W * probe.height / probe.width), n = W * H;
  const [A, B] = await Promise.all([pixels(scanBuf, W, H), pixels(webBuf, W, H)]);
  const ga = new Float64Array(n), gb = new Float64Array(n), inkA = new Uint8Array(n), inkB = new Uint8Array(n), colourOk = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    ga[i] = 0.299 * A[p] + 0.587 * A[p + 1] + 0.114 * A[p + 2];
    gb[i] = 0.299 * B[p] + 0.587 * B[p + 1] + 0.114 * B[p + 2];
    inkA[i] = ga[i] < INK_LUM; inkB[i] = gb[i] < INK_LUM;
    colourOk[i] = Math.max(Math.abs(A[p] - B[p]), Math.abs(A[p + 1] - B[p + 1]), Math.abs(A[p + 2] - B[p + 2])) <= COLOUR_TOL;
  }
  const S = ssimMap(ga, gb, W, H), nearA = dilate(inkA, W, H, SHIFT), nearB = dilate(inkB, W, H, SHIFT);
  const missing = new Uint8Array(n), extra = new Uint8Array(n);
  for (let i = 0; i < n; i++) { missing[i] = inkA[i] && !nearB[i]; extra[i] = inkB[i] && !nearA[i]; }

  const region = (x0, y0, x1, y1) => {
    let s = 0, cnt = 0, col = 0, sa = 0, sb = 0, ha = 0, hb = 0, miss = 0, ext = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x; cnt++; s += S[i]; col += colourOk[i];
      if (inkA[i]) { sa++; if (nearB[i]) ha++; else miss++; }
      if (inkB[i]) { sb++; if (nearA[i]) hb++; else ext++; }
    }
    const ssim = s / cnt, ink = f1(ha, sa, hb, sb), colour = col / cnt;
    return { ssim, ink, colour, missing: miss / cnt, extra: ext / cnt, score: combine(ssim, ink, colour) };
  };
  const all = region(0, 0, W, H), cells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x0 = Math.floor(c * W / COLS), x1 = Math.floor((c + 1) * W / COLS), y0 = Math.floor(r * H / ROWS), y1 = Math.floor((r + 1) * H / ROWS);
    cells.push({ row: r, col: c, box: { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H }, ...region(x0, y0, x1, y1) });
  }
  const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
  const tidy = o => ({ ...o, ssim: round(o.ssim), ink: round(o.ink), colour: round(o.colour), missing: round(o.missing, 4), extra: round(o.extra, 4), score: round(o.score, 1) });
  const worst = [...cells].sort((a, b) => a.score - b.score).slice(0, 4).filter(c => c.score < 92);

  // Heatmap over a faded copy of the scan.
  const heat = createCanvas(W, H), hctx = heat.getContext('2d'), img = hctx.createImageData(W, H), px = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let rgb;
    if (missing[i]) rgb = [214, 32, 32];
    else if (extra[i]) rgb = [30, 96, 230];
    else if (!colourOk[i] && !inkA[i] && !inkB[i]) rgb = [245, 178, 60];
    else { const v = 175 + ga[i] * 0.31; rgb = [v, v, v]; }
    px[p] = rgb[0]; px[p + 1] = rgb[1]; px[p + 2] = rgb[2]; px[p + 3] = 255;
  }
  hctx.putImageData(img, 0, 0);
  hctx.strokeStyle = '#d4146b'; hctx.lineWidth = 2;
  for (const c of worst) hctx.strokeRect(c.box.x * W + 1, c.box.y * H + 1, c.box.w * W - 2, c.box.h * H - 2);

  return {
    report: { ...tidy(all), size: [W, H], worst: worst.map(c => ({ row: c.row, col: c.col, box: c.box, score: round(c.score, 1) })), cells: cells.map(c => ({ row: c.row, col: c.col, score: round(c.score, 1) })) },
    heatPng: await heat.encode('png')
  };
}

let labelFont = false;
// Before | after | heatmap of "after", side by side, with the regions that
// changed outlined on all three. For the regression report.
export async function compareRenders(beforeBuf, afterBuf, heatBuf, cells = []) {
  const { loadImage, createCanvas, GlobalFonts } = await canvasLib();
  // Cyrillic labels need a real font; the canvas has none registered.
  const font = join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeuib.ttf');
  if (!labelFont && existsSync(font)) labelFont = GlobalFonts.registerFromPath(font, 'Segoe UI Bold');
  const [a, b, h] = await Promise.all([beforeBuf, afterBuf, heatBuf].map(x => loadImage(x)));
  const W = CMP_W, H = Math.round(W * b.height / b.width), gap = 8, top = 28;
  const c = createCanvas(W * 3 + gap * 2, H + top), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#222'; ctx.font = '16px "Segoe UI Bold", sans-serif';
  ['До (эталон)', 'После (сейчас)', 'Расхождения со сканом'].forEach((t, i) => ctx.fillText(t, i * (W + gap) + 6, 20));
  [a, b, h].forEach((img, i) => ctx.drawImage(img, i * (W + gap), top, W, H));
  ctx.strokeStyle = '#d4146b'; ctx.lineWidth = 3;
  for (const cell of cells) for (let i = 0; i < 3; i++)
    ctx.strokeRect(i * (W + gap) + cell.col * W / COLS, top + cell.row * H / ROWS, W / COLS, H / ROWS);
  return c.encode('png');
}

// Render a page (served at pageUrl) and score it against its scan.
// `frameUrl` is the address of render-frame.html on the same server.
export async function scorePage({ scanFile, frameUrl, pageUrl, work }) {
  const { loadImage } = await canvasLib();
  const scanBuf = await readFile(scanFile), scan = await loadImage(scanBuf);
  const { w, h } = renderSize(scan.width, scan.height);
  await mkdir(work, { recursive: true });
  const shot = join(work, 'fidelity-render.png');
  await rm(shot, { force: true });
  await renderPng(`${frameUrl}?w=${w}&h=${h}&src=${encodeURIComponent(pageUrl)}`, w, h, shot);
  const webBuf = await readFile(shot);
  const { report, heatPng } = await compare(scanBuf, webBuf);
  return { report: { ...report, at: new Date().toISOString() }, heatPng, renderPng: webBuf };
}

export { canvasLib };
