import test from 'node:test';
import assert from 'node:assert/strict';
import {ruleEdges,measureDocumentPage} from './document-page.mjs';
import {fromModel,render,ocrLinesOf} from './core.mjs';
import {readFileSync} from 'node:fs';
import {needsDisplayOcr,supplementDisplayOcr} from './display-ocr.mjs';
import {validatePage,localizeLayout} from './page-contract.mjs';
test('copyright titles do not trigger expensive cover OCR',async()=>{
 const o={lines:[{text:'HSK标准教程5（上）练习册／姜丽萍主编'}]};
 assert.equal(needsDisplayOcr(o),false);assert.equal(await supplementDisplayOcr(null,o,{recognize:()=>{throw Error('unneeded OCR')}}),o);
 assert.equal(needsDisplayOcr({lines:[{text:'标准教程'}]}),true);
});
test('merged table edges follow printed rules and preserve spans and translations',()=>{
 const grid={W:100,H:100,at:(x,y)=>[10,40,70,90].includes(x)||[10,30,50,70].includes(y)?[80,80,80]:[255,255,255]};
 const box={x:.1,y:.1,w:.8,h:.6};assert.deepEqual(ruleEdges(grid,box,'x'),[.1,.4,.7,.9]);
 const l=fromModel({blocks:[{type:'table',box,columns:3,rowCount:3,cells:[{row:0,col:0,rowspan:2,colspan:2,cn:'试题数量',en:'Question count',ru:'Число заданий'},{row:0,col:2,cn:'20'}]}],kz:{'Число заданий':'Тапсырма саны'}},100,100);
 l.theme={};measureDocumentPage(l,grid,[]);assert.equal(l.blocks[0].tableGeometry.verified,true);
 const html=render(l);assert.match(html,/aria-rowspan="2" aria-colspan="2"/);assert.match(html,/data-en="Question count"/);assert.match(html,/data-kz="Тапсырма саны"/);assert.doesNotMatch(html,/<img/);
});
test('reviewed frontmatter keeps OCR line baselines independently of translation width',()=>{
 const sourceBox={x:.1,y:.2,w:.3,h:.02};
 const l=fromModel({blocks:[{type:'text',box:{...sourceBox,w:.8,h:.04},cn:'中文编辑：纪成',en:'Chinese editor: Ji Cheng',ru:'Редактор: Цзи Чэн',documentText:{sourceBox}}],kz:{'Редактор: Цзи Чэн':'Редактор: Цзи Чэн'}},100,150);
 l.theme={};const grid={W:100,H:150,at:()=>[255,255,255]};measureDocumentPage(l,grid,[{text:'中文编辑：纪成',box:sourceBox}]);
 for(const key of Object.keys(sourceBox))assert.ok(Math.abs(l.blocks[0].documentText.lines[0].box[key]-sourceBox[key])<1e-10);assert.equal(l.blocks[0].box.w,.8);const h=render(l);assert.match(h,/hsk-document-original/);assert.match(h,/data-en="Chinese editor: Ji Cheng"/);
});
test('publication rejects missing, overlapping and out-of-range merged cells',()=>{
 const b={type:'table',box:{x:.1,y:.1,w:.5,h:.5},columns:2,rowCount:2,cells:[{row:0,col:0,rowspan:2,colspan:2,cn:'100'}]};
 const layout={page:{width:100,height:100},blocks:[b]};assert.deepEqual(validatePage(layout).errors,[]);
 assert.ok(validatePage({...layout,blocks:[{...b,cells:[{...b.cells[0],colspan:1}]}]}).errors.some(e=>e.includes('Пропущены')));
 assert.ok(validatePage({...layout,blocks:[{...b,cells:[...b.cells,b.cells[0]]}]}).errors.some(e=>e.includes('Пересекающиеся')));
 assert.ok(validatePage({...layout,blocks:[{...b,cells:[{...b.cells[0],colspan:3}]}]}).errors.some(e=>e.includes('Некорректная')));
 const before=localizeLayout(layout);const after=localizeLayout({...layout,blocks:[{...b,cells:[{...b.cells[0],cn:'101'}]}]},before);assert.notEqual(before.blocks[0].sourceHash,after.blocks[0].sourceHash);
});
test('plain contents retains printed page numbers and all three language fields',()=>{
 const l=fromModel({blocks:[{type:'toc',box:{x:.1,y:.2,w:.8,h:.6},rows:[{box:{x:.1,y:.2,w:.8,h:.04},label:{cn:'1'},cn:'爱的细节',en:'Details of love',ru:'Любовь в деталях',printedPage:'2'}]}],kz:{'Любовь в деталях':'Махаббаттың ұсақ-түйегі'}},100,150);
 const html=render(l);assert.match(html,/hsk-toc-page">2</);assert.match(html,/data-en="Details of love"/);assert.match(html,/data-kz="Махаббаттың ұсақ-түйегі"/);assert.doesNotMatch(html,/<img/);
});

test('reviewed HSK5 source pages retain OCR text positions and language coverage',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('../../conversion-fixtures/hsk5-source-pages-003-006.json',import.meta.url),'utf8'));
 assert.equal(fixtures.length,8);
 for(const f of fixtures){
  const l=fromModel(f.source,1000,1500);l.theme={};
  measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));
  const documents=l.blocks.filter(b=>b.documentText);
  assert.ok(documents.length>0,`${f.bookId}/${f.sourcePage}: document blocks missing`);
  for(const b of documents)assert.ok(b.documentText.lines?.length>0,`${f.bookId}/${f.sourcePage}: lost source text ${b.cn}`);
  assert.deepEqual(validatePage(localizeLayout(l),{requireKz:true}).errors,[],`${f.bookId}/${f.sourcePage}: publication contract`);
  const html=render(l);assert.match(html,/data-en=/);assert.match(html,/data-kz=/);
 }
});
