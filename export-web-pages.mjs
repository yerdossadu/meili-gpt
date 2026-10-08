import {readFile,writeFile,mkdir,copyFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,relative,sep} from 'node:path';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dirname),studio=join(root,'studio'),output=join(root,'approved-web-pages');
const books=[{id:'25d1aad102e4',folder:'hsk1-v3-textbook',label:'Учебник HSK 1'},
 {id:'8bf3af15d090',folder:'hsk1-v3-workbook',label:'WB HSK 1'}];
const shell=(title,body)=>`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:18px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem}li{margin:.8rem 0}a{color:#1769aa}</style></head><body><h1>${title}</h1>${body}</body></html>`;
let count=0;
const selectedBook=process.argv[2],selectedPage=Number(process.argv[3]);
for(const book of books){
 if(selectedBook&&book.id!==selectedBook)continue;
 const destination=join(output,book.folder);await mkdir(destination,{recursive:true});
 const manifestPath=join(destination,'manifest.json');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8').catch(()=>'[]'));
 for(let n=1;n<=11;n++){
  if(selectedPage&&n!==selectedPage)continue;
  const number=String(n).padStart(3,'0'),source=join(studio,'library',book.id,'pages',number);
  let html=await readFile(join(source,'index.html'),'utf8');
  const layout=JSON.parse(await readFile(join(source,'layout.json'),'utf8'));
  // Preserve the existing HTML and embedded runtime; only make resource URLs portable.
  const refs=[...new Set([...html.matchAll(/(?:src|href|data-src)="(\/(?:library|webbook)\/[^"<>]+)"/g)].map(m=>m[1]))];
  const resources=[];
  for(const url of refs){
   const pathname=decodeURIComponent(url.split(/[?#]/)[0]);
   const from=resolve(studio,'.'+pathname);
   assert.ok(from.startsWith(studio+sep),'Resource escapes the Studio directory');
   assert.ok((await stat(from)).isFile(),`Missing resource: ${url}`);
   const local='assets/page-'+number+'/'+relative(studio,from).split(sep).join('/');
   const to=join(destination,local);await mkdir(resolve(to,'..'),{recursive:true});await copyFile(from,to);
   html=html.split(url).join(local);resources.push(local);
  }
  assert.doesNotMatch(html,/(?:src|href|data-src)="\/(?:library|webbook)\//);
  const filename='page-'+number+'.html';await writeFile(join(destination,filename),html);
  const record={sourcePage:n,conversionId:layout.conversionId||null,exportedAt:new Date().toISOString(),englishLayers:(html.match(/data-en=/g)||[]).length,resources};
  const previous=manifest.findIndex(p=>p.sourcePage===n);if(previous<0)manifest.push(record);else manifest[previous]=record;
  count++;
 }
 manifest.sort((a,b)=>a.sourcePage-b.sourcePage);await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 const pages=(await readdir(destination)).filter(n=>/^page-\d{3}\.html$/.test(n)).sort();
 await writeFile(join(destination,'index.html'),shell(book.label,'<ol>'+pages.map(p=>`<li><a href="${p}">Страница ${Number(p.match(/\d+/)[0])}</a></li>`).join('')+'</ol><p>Нумерация соответствует страницам загруженного оригинала.</p>'));
 await writeFile(join(destination,'README.md'),`# ${book.label}\n\nВеб-копии из текущей локальной FS. Страницы 1–11 экспортируются из сохранённых HTML, без повторной конвертации. Исходная нумерация сохранена. CSS, изображения и используемые аудиофайлы скопированы с относительными путями. Переключатели и встроенный runtime сохранены. Внешние шрифты загружаются по сети; сервисные запросы к платформе требуют работающего сервера. Ранее скопированные последующие страницы не удаляются. Откройте index.html.\n`);
}
await writeFile(join(output,'index.html'),shell('Web версии страниц',books.map(b=>`<p><a href="${b.folder}/index.html">${b.label}</a> — страницы 1–11</p>`).join('')));
console.log(`Exported ${count} pages with verified local resources; source files unchanged.`);
