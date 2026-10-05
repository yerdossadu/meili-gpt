import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.cwd();
const pageDir = join(root, 'library', '25d1aad102e4', 'pages', '023');
const path = join(pageDir, 'layout.json');
const layout = JSON.parse(await readFile(path, 'utf8'));
layout.blocks[2].box.w = 0.60;
layout.blocks[3].k = 0.95;
layout.blocks[4].box.w = 0.38;
for (const i of [5,6,7]) layout.blocks[i].box.w = 0.58;
layout.blocks[9].box.w = 0.78;
layout.blocks[10].box.w = 0.46;
layout.blocks[15].k = 1.10;
layout.blocks[15].lines[0].ru = 'Ли Вэнь: Привет! Я Ли Вэнь.';
layout.blocks[15].lines[1].ru = 'Бай Цзяюэ: Привет! Я Бай Цзяюэ.';
layout.blocks[15].lines[2].ru = 'Ли Вэнь: Рад знакомству.';
layout.blocks[15].lines[3].ru = 'Бай Цзяюэ: Мне тоже приятно.';
layout.decorations = [];
await writeFile(path, JSON.stringify(layout, null, 1));
const response = await fetch('http://127.0.0.1:4177/local/webbook/books/25d1aad102e4/pages/23/layout', {
 method: 'PUT', headers: { 'content-type': 'application/json' },
 body: JSON.stringify({ layout: { blocks: layout.blocks, decorations: [], theme: layout.theme } })
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ page: 23, result }, null, 2));
