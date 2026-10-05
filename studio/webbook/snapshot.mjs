// Picture of a converted page as the reader sees it, beside its scan, for eye checks.
//   node webbook/snapshot.mjs <bookId> <page> [out.png]
// Needs the studio running (it serves the page and render-frame.html).
import { renderPng, canvasLib } from './fidelity.mjs';
import { join } from 'node:path';
const [book, n, outArg] = process.argv.slice(2);
const pad = String(n).padStart(3, '0'), dir = join(process.cwd(), 'library', book, 'pages', pad);
const out = outArg || join(dir, 'compare.png'), shot = join(dir, 'snapshot-render.png');
const { loadImage, createCanvas } = await canvasLib();
const scan = await loadImage(join(dir, 'scan.png')), W = 900, H = Math.round(scan.height * W / scan.width);
await renderPng(`http://127.0.0.1:4180/webbook/render-frame.html?w=${W}&h=${H}&src=${encodeURIComponent(`/library/${book}/pages/${pad}/index.html`)}`, W, H, shot);
const web = await loadImage(shot), c = createCanvas(W * 2 + 20, H), g = c.getContext('2d');
g.fillStyle = '#888'; g.fillRect(0, 0, c.width, H); g.drawImage(scan, 0, 0, W, H); g.drawImage(web, W + 20, 0, W, H);
const { writeFile } = await import('node:fs/promises');
await writeFile(out, c.encode ? await c.encode('png') : c.toBuffer('image/png'));
console.log(out); process.exit(0);
