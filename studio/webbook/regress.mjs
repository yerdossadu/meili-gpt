// Golden-page regression check for the converter.
//
// Approved pages of a book are its golden set (library/<book>/golden.json).
// After any change to core.mjs / server.mjs / components.css, run
//
//   node webbook/regress.mjs [--book <id>] [--accept] [pages...]
//
// Each golden page is rebuilt from its cached OCR and model answer in a
// sandbox copy (the real page, with its manual edits, is never touched),
// rendered, scored against the scan (fidelity.mjs) and compared with the
// score accepted last time. A page or a region of it that got worse is a
// regression: the run lists it, writes a before/after picture and exits 1.
// --accept stores the current results as the new baseline (after the
// changes have been checked). No model is called: pages without a cached
// answer are skipped.

import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scorePage, compareRenders } from './fidelity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'library');
const pad3 = n => String(n).padStart(3, '0');
const readJson = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const PAGE_DROP = 0.5, CELL_DROP = 4;   // points of score that count as "worse"

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2' };

export async function goldenFile(book) { return join(LIB, book, 'golden.json'); }
export async function readGolden(book) { return await readJson(await goldenFile(book)) || { pages: {} }; }
export async function writeGolden(book, golden) { await writeFile(await goldenFile(book), JSON.stringify(golden, null, 1)); }

// Where sandboxes, baselines and reports live: next to the real library
// (D:\Forma when the library is a junction there).
async function workRoot() { return join(dirname(await realpath(LIB)), 'regress'); }

async function codeStamp() {
  const h = createHash('sha256');
  for (const f of ['core.mjs', 'server.mjs', 'components.css']) h.update(await readFile(join(ROOT, 'webbook', f)));
  return h.digest('hex').slice(0, 10);
}

// Static server: /library from the sandbox, everything else from the studio.
function serve(sandbox) {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const base = path.startsWith('/library/') ? sandbox : ROOT;
    const file = normalize(join(base, path));
    if (!file.startsWith(base) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// Copy what a rebuild needs (scan, caches, clip, cast) into the sandbox.
async function stage(sandbox, book, n) {
  const src = join(LIB, book), dst = join(sandbox, 'library', book), page = join(src, 'pages', pad3(n)), out = join(dst, 'pages', pad3(n));
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  if (!existsSync(join(dst, 'book.json'))) {
    await copyFile(join(src, 'book.json'), join(dst, 'book.json'));
    if (existsSync(join(src, 'cast'))) await cp(join(src, 'cast'), join(dst, 'cast'), { recursive: true });
  }
  const clip = await readJson(join(page, 'clip.json'));
  for (const f of ['scan.png', 'ocr.json', 'model.json', 'clip.json', clip?.file, clip?.poster].filter(Boolean))
    if (existsSync(join(page, f))) await copyFile(join(page, f), join(out, f));
}

async function rebuild(wb, book, n) {
  const call = async (method, path, body) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { yield* chunks; } };
    let status = 0, out = '';
    const res = { writeHead(s) { status = s; }, end(d) { out = String(d || ''); } };
    await wb.handle(req, res, new URL('http://x' + path));
    return { status, data: out ? JSON.parse(out) : null };
  };
  await call('POST', `/local/webbook/books/${book}/pages/${n}/convert`, { model: '' });
  for (;;) {
    const job = (await call('GET', `/local/webbook/books/${book}/pages/${n}/job`)).data;
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function runRegression({ book, pages, accept = false, log = console.log }) {
  const golden = await readGolden(book);
  const list = (pages?.length ? pages : Object.keys(golden.pages)).map(Number).sort((a, b) => a - b);
  if (!list.length) { log('Эталонных страниц нет: отметьте страницы как эталон.'); return { results: [], regressions: 0 }; }
  const work = await workRoot(), sandbox = join(work, 'sandbox'), baseDir = join(work, 'baseline', book), report = join(work, 'report', book);
  await mkdir(baseDir, { recursive: true }); await rm(report, { recursive: true, force: true }); await mkdir(report, { recursive: true });
  const { createWebbook } = await import(pathToFileURL(join(ROOT, 'webbook', 'server.mjs')).href + '?t=' + Date.now());
  const wb = createWebbook({ root: sandbox, getApiKey: () => '' });
  const server = await serve(sandbox), origin = `http://127.0.0.1:${server.address().port}`;
  const stamp = await codeStamp(), results = [];
  try {
    for (const n of list) {
      if (!existsSync(join(LIB, book, 'pages', pad3(n), 'model.json'))) { log(`${n}: пропуск — нет сохранённого ответа модели`); continue; }
      await stage(sandbox, book, n);
      const job = await rebuild(wb, book, n);
      if (job.state !== 'done') { results.push({ n, status: 'error', error: job.error }); log(`${n}: ОШИБКА сборки — ${job.error}`); continue; }
      const page = join(sandbox, 'library', book, 'pages', pad3(n));
      const { report: now, heatPng, renderPng } = await scorePage({ scanFile: join(page, 'scan.png'), frameUrl: `${origin}/webbook/render-frame.html`, pageUrl: `/library/${book}/pages/${pad3(n)}/index.html`, work: page });
      const base = golden.pages[n]?.auto;
      const r = { n, score: now.score, base: base?.score ?? null, delta: base ? +(now.score - base.score).toFixed(1) : null, cells: [] };
      if (base?.cells) for (const c of now.cells) {
        const b = base.cells.find(x => x.row === c.row && x.col === c.col);
        if (b && c.score - b.score <= -CELL_DROP) r.cells.push({ row: c.row, col: c.col, from: b.score, to: c.score });
      }
      r.status = !base ? 'new' : (r.delta <= -PAGE_DROP || r.cells.length) ? 'worse' : r.delta >= PAGE_DROP ? 'better' : 'same';
      const baseRender = join(baseDir, `${pad3(n)}.png`);
      if (r.status === 'worse' || r.status === 'better') {
        const pic = existsSync(baseRender) ? await compareRenders(await readFile(baseRender), renderPng, heatPng, r.cells) : heatPng;
        await writeFile(join(report, `${pad3(n)}-${r.status}.png`), pic);
      }
      if (accept) {
        golden.pages[n] = { ...(golden.pages[n] || {}), auto: { score: now.score, ssim: now.ssim, ink: now.ink, colour: now.colour, cells: now.cells, code: stamp, at: now.at } };
        await writeFile(baseRender, renderPng);
      }
      results.push(r);
      const mark = { new: 'новая', same: 'без изменений', better: 'ЛУЧШЕ', worse: 'ХУЖЕ' }[r.status];
      log(`${n}: ${now.score}${r.base != null ? ` (было ${r.base}, ${r.delta >= 0 ? '+' : ''}${r.delta})` : ''} — ${mark}${r.cells.length ? '; хуже участки: ' + r.cells.map(c => `ряд ${c.row + 1}, кол. ${c.col + 1}: ${c.from}→${c.to}`).join('; ') : ''}`);
    }
  } finally { server.close(); }
  if (accept) { golden.code = stamp; golden.acceptedAt = new Date().toISOString(); await writeGolden(book, golden); log('Результаты приняты как новый эталон.'); }
  const regressions = results.filter(r => r.status === 'worse' || r.status === 'error').length;
  await writeFile(join(report, 'summary.json'), JSON.stringify({ book, code: stamp, at: new Date().toISOString(), accept, results }, null, 1));
  log(regressions ? `Стало хуже: ${regressions} стр. Картинки до/после: ${report}` : 'Регрессий нет.');
  return { results, regressions, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const accept = args.includes('--accept'); if (accept) args.splice(args.indexOf('--accept'), 1);
  let book = opt('--book');
  if (!book) book = (await readdir(LIB)).find(d => /^[0-9a-f]{12}$/.test(d) && existsSync(join(LIB, d, 'golden.json'))) || '25d1aad102e4';
  const { regressions } = await runRegression({ book, pages: args, accept });
  process.exit(regressions ? 1 : 0);
}
