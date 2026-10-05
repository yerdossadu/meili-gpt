import { mkdir, readFile, writeFile, copyFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { writeZip } from './server.mjs';

const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
export function validateRange(from, to, pages) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > pages) throw new Error(`Выберите страницы от 1 до ${pages}; конец диапазона не должен быть меньше начала.`);
  return { from, to };
}
function run(command, args, cwd, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const capture = data => { output = (output + data.toString()).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (timedOut) reject(new Error('Конвертация превысила 10 минут. Выберите меньший диапазон страниц.')); else if (code !== 0) reject(new Error(output.trim() || `pdf2htmlEX: код ${code}`)); else resolve(output); });
  });
}

export function createPdfLayout({ root, renderScan }) {
  const executable = process.env.PDF2HTMLEX_PATH || join(root, '.tools', 'pdf2htmlEX', 'pdf2htmlEX.exe');
  const jobs = new Map(), queue = []; let working = false, cachedStatus;
  const jobDir = (book, id) => join(root, 'library', book, 'pdf-layout', id);
  async function status() {
    if (cachedStatus) return cachedStatus;
    try { const version = await run(executable, ['--version'], root, 10000); return cachedStatus = { available: true, engine: 'pdf2htmlEX', version: version.split(/\r?\n/)[0] }; }
    catch { return { available: false, engine: 'pdf2htmlEX', error: 'Конвертер не установлен. Запустите studio/setup-pdf2htmlEX.ps1 и перезапустите FS.' }; }
  }
  async function save(job) { await writeFile(join(jobDir(job.book, job.id), 'job.json'), JSON.stringify(job, null, 2)); }
  async function processQueue() {
    if (working) return; working = true;
    try {
      while (queue.length) {
        const job = queue.shift(), dir = jobDir(job.book, job.id), web = join(dir, 'web');
        try {
          job.state = 'running'; await save(job);
          const input = await readFile(join(root, 'library', job.book, 'source.pdf'));
          job.sourceSha256 = createHash('sha256').update(input).digest('hex');
          await writeFile(join(dir, 'source.pdf'), input); await mkdir(join(dir, 'tmp')); await mkdir(web);
          const log = await run(executable, ['--first-page', String(job.from), '--last-page', String(job.to), '--zoom', '1', '--hdpi', '144', '--vdpi', '144', '--embed', 'cfijo', '--correct-text-visibility', '1', '--tmp-dir', 'tmp', '--dest-dir', 'web', 'source.pdf', 'index.html'], dir);
          await writeFile(join(dir, 'conversion.log'), log);
          let html = await readFile(join(web, 'index.html'));
          if (!html.includes(Buffer.from('page-container'))) throw new Error('Конвертер не создал веб-страницу.');
          await copyFile(join(root, 'webbook', 'pdf-layout-viewer.js'), join(web, 'forma-viewer.js'));
          await copyFile(join(root, 'webbook', 'pdf-layout-viewer.css'), join(web, 'forma-viewer.css'));
          html = Buffer.from(html.toString().replace('</head>', '<link rel="stylesheet" href="forma-viewer.css"><script defer src="forma-viewer.js"></script></head>'));
          await writeFile(join(web, 'index.html'), html);
          await copyFile(await renderScan(job.book, job.from), join(web, 'reference.png'));
          const base = `/library/${job.book}/pdf-layout/${job.id}`;
          const manifest = { engine: 'pdf2htmlEX', version: (await status()).version, sourceSha256: job.sourceSha256, from: job.from, to: job.to, book: job.book, createdAt: job.createdAt, note: 'Исходный макет PDF. Для сканов текст остаётся изображением. Перевод и редактирование учебных блоков в этот режим не входят.' };
          await writeFile(join(web, 'manifest.json'), JSON.stringify(manifest, null, 2));
          await writeZip(web, join(dir, 'web-version.zip'));
          job.state = 'done'; job.finishedAt = new Date().toISOString(); job.html = base + '/web/index.html'; job.download = base + '/web-version.zip'; job.scan = base + '/web/reference.png'; job.bytes = html.length;
        } catch (e) { job.state = 'error'; job.error = e.message; }
        finally { await unlink(join(dir, 'source.pdf')).catch(() => {}); await save(job); }
      }
    } finally { working = false; }
  }
  async function body(req) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Слишком большой запрос.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/local/pdf-layout/')) return false;
    try {
      const parts = url.pathname.slice('/local/pdf-layout/'.length).split('/');
      if (parts[0] === 'status' && req.method === 'GET') { json(res, 200, await status()); return true; }
      const book = parts[0];
      if (!/^[0-9a-f]{12}$/.test(book || '')) { json(res, 404, { error: 'Книга не найдена.' }); return true; }
      const meta = JSON.parse(await readFile(join(root, 'library', book, 'book.json'), 'utf8'));
      if (parts.length === 1 && req.method === 'GET') {
        const dir = join(root, 'library', book, 'pdf-layout'), list = [];
        for (const entry of existsSync(dir) ? await readdir(dir) : []) {
          if (!/^[0-9a-f-]{36}$/.test(entry)) continue;
          try { const job = JSON.parse(await readFile(join(dir, entry, 'job.json'), 'utf8')); if (['queued', 'running'].includes(job.state) && !jobs.has(job.id)) { job.state = 'error'; job.error = 'FS была перезапущена. Запустите конвертацию снова.'; await save(job); } list.push(job); } catch {}
        }
        json(res, 200, list.sort((a,b) => b.createdAt.localeCompare(a.createdAt))); return true;
      }
      if (parts.length === 1 && req.method === 'POST') {
        const b = await body(req), range = validateRange(b.from, b.to, meta.pages);
        if (!(await status()).available) { json(res, 503, await status()); return true; }
        if ([...jobs.values()].filter(j => ['running', 'queued'].includes(j.state)).length >= 8) throw new Error('В очереди уже восемь заданий. Дождитесь завершения.');
        const job = { id: randomUUID(), book, ...range, state: 'queued', createdAt: new Date().toISOString() };
        await mkdir(jobDir(book, job.id), { recursive: true }); await save(job); jobs.set(job.id, job); queue.push(job);
        json(res, 202, job); void processQueue().catch(error => console.error('PDF layout queue:', error.message)); return true;
      }
      if (parts.length === 2 && req.method === 'GET' && /^[0-9a-f-]{36}$/.test(parts[1])) {
        const job = jobs.get(parts[1]) || JSON.parse(await readFile(join(jobDir(book, parts[1]), 'job.json'), 'utf8'));
        if (job.book !== book) throw new Error('Задание относится к другой книге.');
        json(res, 200, job); return true;
      }
      json(res, 404, { error: 'Не найдено.' });
    } catch (e) { json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message }); }
    return true;
  }
  return { handle, status };
}
