// «Анализ AI»: a journal of every image and video the studio got from an AI
// model — the file itself, the model, the provider, the price and what it was
// for. Entries are never removed when a picture is deleted in the studio, so
// the user can compare tools over time; each entry takes a rating and a note.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const MAX = 400 * 1024 * 1024;

export function createAiLog(dir) {
  const media = join(dir, 'media'), file = join(dir, 'entries.json');
  let cache = null, queue = Promise.resolve();
  // Entries written before files were fingerprinted get their hash on first load, so twins are still caught.
  const load = async () => {
    if (cache) return cache;
    cache = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : [];
    let filled = 0;
    for (const e of cache) {
      if (!e.hash && e.file && existsSync(join(media, e.file))) { e.hash = createHash('sha256').update(await readFile(join(media, e.file))).digest('hex'); filled++; }
      // Alibaba generations are paid by the subscription, not per item.
      if (e.provider === 'alibaba' && !e.subscription) { e.subscription = true; e.cost = null; filled++; }
    }
    // Every entry gets a lasting number (№1, №2… in the order of generation) to talk about it.
    let top = Math.max(0, ...cache.map(e => e.no || 0));
    for (const e of [...cache].filter(e => !e.no).sort((a, b) => String(a.at).localeCompare(String(b.at)))) { e.no = ++top; filled++; }
    if (filled) await save();
    return cache;
  };
  // One write at a time; written to a temp file first so a crash never leaves half a journal.
  const save = () => (queue = queue.then(async () => { await mkdir(dir, { recursive: true }); await writeFile(file + '.tmp', JSON.stringify(cache, null, 1)); await rename(file + '.tmp', file); }));
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const text = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  async function add(req) {
    let meta = {};
    // The description travels in the body (long prompts in Cyrillic and hanzi overflow a header):
    // «x-ailog-meta-bytes» bytes of JSON, then the file. The old header form is still read.
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX) throw new Error('Файл больше 400 МБ.'); chunks.push(c); }
    let buffer = Buffer.concat(chunks);
    const metaBytes = Number(req.headers['x-ailog-meta-bytes']);
    try {
      if (Number.isInteger(metaBytes) && metaBytes > 0 && metaBytes <= buffer.length) { meta = JSON.parse(buffer.subarray(0, metaBytes).toString('utf8')); buffer = buffer.subarray(metaBytes); }
      else meta = JSON.parse(decodeURIComponent(String(req.headers['x-ailog-meta'] || '%7B%7D')));
    } catch { throw new Error('Неверные данные записи.'); }
    size = buffer.length;
    const entries = await load();
    if (meta.sourceKey && entries.some(e => e.sourceKey === meta.sourceKey)) return { duplicate: true };
    // The same file sent twice (server copy and browser gallery) is one entry; the richer details win.
    const hash = size ? createHash('sha256').update(buffer).digest('hex') : '';
    const twin = hash && entries.find(e => e.hash === hash);
    if (twin) {
      const unknown = s => !s || /^неизвестно/.test(s);
      if (unknown(twin.model) && !unknown(meta.model)) { twin.model = text(meta.model, 160); twin.provider = text(meta.provider, 40) || twin.provider; twin.subscription = Boolean(meta.subscription); }
      if (twin.cost == null && num(meta.cost) != null) twin.cost = num(meta.cost);
      for (const [k, n] of [['purpose', 80], ['section', 60], ['prompt', 30000]]) if (!twin[k] && text(meta[k], n)) twin[k] = text(meta[k], n);
      if (twin.page == null && num(meta.page) != null) twin.page = num(meta.page);
      if (!twin.sourceKey && meta.sourceKey) twin.sourceKey = text(meta.sourceKey, 200);
      await save(); return { duplicate: true, merged: twin.id };
    }
    const id = randomUUID(), mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    let fileName = '';
    if (size) { await mkdir(media, { recursive: true }); fileName = id + (EXT[mime] || ''); await writeFile(join(media, fileName), buffer); }
    const entry = {
      id, no: Math.max(0, ...entries.map(e => e.no || 0)) + 1, at: text(meta.at, 40) || new Date().toISOString(),
      kind: meta.kind === 'video' ? 'video' : 'image', model: text(meta.model, 160) || 'неизвестно', provider: text(meta.provider, 40) || 'openrouter',
      cost: meta.provider === 'alibaba' ? null : num(meta.cost), subscription: Boolean(meta.subscription) || meta.provider === 'alibaba', page: num(meta.page), purpose: text(meta.purpose, 80), section: text(meta.section, 60),
      prompt: text(meta.prompt, 30000), settings: meta.settings && typeof meta.settings === 'object' ? meta.settings : {},
      refs: num(meta.refs), file: fileName, mime, size, hash, sourceKey: text(meta.sourceKey, 200), imported: Boolean(meta.imported), rating: null, comment: ''
    };
    entries.push(entry); await save();
    return entry;
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/local/ailog')) return false;
    try {
      if (url.pathname === '/local/ailog' && req.method === 'GET') return send(res, 200, await load()), true;
      if (url.pathname === '/local/ailog' && req.method === 'POST') return send(res, 200, await add(req)), true;
      const m = url.pathname.match(/^\/local\/ailog\/([0-9a-f-]{36})$/);
      if (m && req.method === 'PATCH') {
        let body = ''; for await (const c of req) body += c;
        const b = JSON.parse(body || '{}'), entries = await load(), e = entries.find(x => x.id === m[1]);
        if (!e) return send(res, 404, { error: 'Запись не найдена.' }), true;
        if ('rating' in b) e.rating = b.rating == null ? null : Math.max(1, Math.min(5, Math.round(Number(b.rating)))) || null;
        if ('comment' in b) e.comment = text(b.comment, 2000);
        e.ratedAt = new Date().toISOString(); await save();
        return send(res, 200, e), true;
      }
      const f = url.pathname.match(/^\/local\/ailog\/media\/([0-9a-f-]{36}\.[a-z0-9]{2,4})$/);
      if (f && req.method === 'GET' && existsSync(join(media, f[1]))) {
        res.writeHead(200, { 'content-type': TYPE[extname(f[1])] || 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' });
        createReadStream(join(media, f[1])).pipe(res); return true;
      }
      return send(res, 404, { error: 'Нет такого адреса журнала.' }), true;
    } catch (err) { return send(res, 400, { error: err.message }), true; }
  }
  return { handle };
}
