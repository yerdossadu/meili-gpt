import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const port = Number(process.env.PDF_RENDER_PORT || 4181);
const runtimeNodeModules = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
let pdfjsPromise;
let canvasPromise;

async function getCanvasModule() {
  if (!canvasPromise) canvasPromise = import(pathToFileURL(join(runtimeNodeModules, '@napi-rs', 'canvas', 'index.js')));
  return canvasPromise;
}

async function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = (async () => {
    const canvas = await getCanvasModule();
    globalThis.DOMMatrix ||= canvas.DOMMatrix;
    globalThis.ImageData ||= canvas.ImageData;
    globalThis.Path2D ||= canvas.Path2D;
    return import(pathToFileURL(join(runtimeNodeModules, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')));
  })();
  return pdfjsPromise;
}

async function extractLayout(pdfData, pageNumber) {
  const pdfjs = await getPdfjs();
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdfData), useSystemFonts: true, verbosity: 0 }).promise;
  if (pageNumber > document.numPages) throw new Error(`В PDF ${document.numPages} страниц; запрошена ${pageNumber}.`);
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles || {};
  const lines = content.items.filter(item => typeof item.str === 'string' && item.str.trim()).map((item, id) => {
    const transform = pdfjs.Util.transform(viewport.transform, item.transform);
    const height = Math.max(Number(item.height) || Math.hypot(transform[2], transform[3]), 1);
    const x = transform[4], baseline = transform[5], style = styles[item.fontName] || {};
    return {
      id,
      text: item.str.trim(),
      position: {
        x: Math.max(0, x / viewport.width),
        y: Math.max(0, (baseline - height) / viewport.height),
        width: Math.min(1, Math.max(0, Number(item.width) / viewport.width)),
        height: Math.min(1, height / viewport.height),
      },
      fontName: style.fontFamily || item.fontName,
      fontSizePt: Number(item.height) || height,
      fontColor: '#202020',
      bold: Boolean(style.fontWeight && Number(style.fontWeight) >= 600),
      italic: Boolean(style.italic),
    };
  });
  await document.destroy();
  return { pageNumber, widthPt:viewport.width, heightPt:viewport.height, rotation:page.rotate || 0, hasTextLayer:lines.length > 0, pageBackground:'#ffffff', lines, shapes:[], images:[] };
}

async function renderPagePng(pdfData, pageNumber, dpi) {
  const [pdfjs, canvasModule] = await Promise.all([getPdfjs(), getCanvasModule()]);
  const document = await pdfjs.getDocument({ data:new Uint8Array(pdfData), useSystemFonts:true, verbosity:0 }).promise;
  try {
    if (pageNumber > document.numPages) throw new Error(`В PDF ${document.numPages} страниц; запрошена ${pageNumber}.`);
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale:dpi / 72 });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext:context, viewport, canvas }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await document.destroy();
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (origin === 'http://127.0.0.1:4174' || origin === 'http://localhost:4174') {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(JSON.stringify({ available:true, version:4, renderer:'pdfjs', ocrService:'http://127.0.0.1:4182/health' }));
    return;
  }
  if (req.method !== 'POST' || !['/render', '/layout', '/ocr', '/ocr-image', '/vectorize'].includes(url.pathname)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const page = Number(url.searchParams.get('page'));
    if (!Number.isInteger(page) || page < 1 || page > 5000) throw new Error('Номер страницы должен быть от 1 до 5000.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) throw new Error('PDF превышает 200 МБ.');
      chunks.push(chunk);
    }
    if (!size) throw new Error('PDF пустой.');
    const pdfData = Buffer.concat(chunks);
    if(url.pathname==='/vectorize') {
      if(origin!=='http://127.0.0.1:4174'&&origin!=='http://localhost:4174')throw Error('Local app origin required');
      if(size>25*1024*1024)throw Error('PNG payload exceeds 25 MB');
      const base=fileURLToPath(new URL('.',import.meta.url));
      const result=await new Promise((resolve,reject)=>{
        const proc=spawn(join(base,'ocr-runtime','Scripts','python.exe'),[join(base,'png-geometry.py')],{windowsHide:true});
        const output=[],errors=[];const timer=setTimeout(()=>{proc.kill();reject(Error('Vector extraction timed out'))},90000);
        proc.stdout.on('data',c=>output.push(c));proc.stderr.on('data',c=>errors.push(c));proc.on('error',reject);
        proc.on('close',code=>{clearTimeout(timer);code?reject(Error(Buffer.concat(errors).toString().slice(-1000))):resolve(Buffer.concat(output))});
        proc.stdin.on('error',reject);proc.stdin.end(pdfData);
      });
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(result);return;
    }
    if (url.pathname === '/ocr-image') {
      const dpi = Math.max(72, Math.min(600, Math.round(Number(url.searchParams.get('dpi')) || 288)));
      const imageType = String(req.headers['content-type'] || 'image/png').split(';')[0].trim().toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(imageType)) throw new Error('Для OCR загрузите PNG, JPEG или WebP.');
      let response;
      try {
        response = await fetch(`http://127.0.0.1:4182/ocr?page=${page}&dpi=${dpi}`, { method:'POST', headers:{ 'content-type':imageType }, body:pdfData });
      } catch {
        throw new Error('Локальный OCR-сервис не запущен. Закройте Forma Studio и откройте start-forma-studio.bat.');
      }
      const data = await response.text();
      if (!response.ok) {
        let detail = data;
        try { detail = JSON.parse(data).error || data; } catch {}
        throw new Error(detail || 'Локальный OCR не смог распознать изображение.');
      }
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
      res.end(data);
      return;
    }
    if (url.pathname === '/layout') {
      const layout = await extractLayout(pdfData, page);
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
      res.end(JSON.stringify(layout));
      return;
    }
    const requestedDpi = Number(url.searchParams.get('dpi')) || 144;
    const dpi = url.pathname === '/ocr' ? 288 : Math.max(72, Math.min(400, Math.round(requestedDpi)));
    if (url.pathname === '/ocr') {
      const png = await renderPagePng(pdfData, page, dpi);
      let response;
      try {
        response = await fetch(`http://127.0.0.1:4182/ocr?page=${page}&dpi=${dpi}`, { method:'POST', headers:{ 'content-type':'image/png' }, body:png });
      } catch {
        throw new Error('Локальный OCR-сервис не запущен. Закройте Forma Studio и откройте start-forma-studio.bat.');
      }
      const data = await response.text();
      if (!response.ok) {
        let detail = data;
        try { detail = JSON.parse(data).error || data; } catch {}
        throw new Error(detail || 'Локальный OCR не смог распознать страницу.');
      }
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }).end(data);
      return;
    }
    const png = await renderPagePng(pdfData, page, dpi);
    res.writeHead(200, { 'content-type':'image/png', 'cache-control':'no-store' }).end(png);
  } catch (error) {
    res.writeHead(400, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(JSON.stringify({ error:error.message || 'Не удалось обработать PDF.' }));
  }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`PDF/OCR service listening on 127.0.0.1:${port}\n`));
