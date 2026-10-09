import test from 'node:test';
import assert from 'node:assert/strict';
import {ruleEdges,measureDocumentPage} from './document-page.mjs';
import {fromModel,render,ocrLinesOf,pageDocument,findDecorations,pageVocabulary} from './core.mjs';
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

test('light printed rules restore colored cells without becoming a page-sized background',()=>{
 const box={x:.1,y:.1,w:.8,h:.6};
 const grid={W:100,H:100,at:(x,y)=>x<10||x>90||y<10||y>70||[10,50,90].includes(x)||[10,40,70].includes(y)?[255,255,255]:y<40?[65,60,150]:[222,209,246]};
 const l=fromModel({blocks:[{type:'table',box,columns:2,rowCount:2,cells:[{row:0,col:0,cn:'表'},{row:0,col:1,cn:'课'},{row:1,col:0,cn:'150'},{row:1,col:1,cn:'30–45'}]}]},100,100);l.theme={};
 measureDocumentPage(l,grid,[]);assert.equal(l.blocks[0].tableGeometry.verified,true);assert.equal(l.blocks[0].borderColor,'#fff');assert.equal(l.blocks[0].cells[0].fill,'#413c96');assert.equal(l.blocks[0].cells[2].fill,'#ded1f6');assert.equal(l.theme.background,undefined);assert.match(render(l),/border-color:#fff/);
});

test('CSS unit panels cannot be recovered as scan decorations covering native translations',()=>{
 const box={x:.1,y:.3,w:.8,h:.2};const layout={theme:{documentPanels:[{box,color:'#85878b'}]},blocks:[]};
 const grid={W:100,H:100,at:(x,y)=>x>=10&&x<=90&&y>=30&&y<=50?[133,135,139]:[255,255,255]};
 assert.deepEqual(findDecorations(layout,grid),[]);
});

test('HSK5 pages 7–8 retain table numbers, contents routing and all language switches',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('../../conversion-fixtures/hsk5-source-pages-007-008.json',import.meta.url),'utf8'));
 for(const f of fixtures){const l=fromModel(f.source,f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));
  const localized=localizeLayout(l);assert.deepEqual(validatePage(localized,{requireKz:true}).errors,[]);
  const html=pageDocument(localized);for(const lang of ['ru','en','kz','orig'])assert.match(html,new RegExp('data-lang="'+lang+'"'));
  for(const b of l.blocks.filter(b=>b.documentText))assert.ok(b.documentText.lines?.length,`${f.bookId}/${f.sourcePage}: source text lost`);
  if(f.bookId==='9b495a8351c6'&&f.sourcePage===7){const t=l.blocks.find(b=>b.type==='table');assert.equal(t.cells.length,32);assert.equal(t.cells.find(c=>c.row===6&&c.col===3).cn,'240–320');assert.equal(t.cells.find(c=>c.row===7&&c.col===3).cn,'600–850');}
  if(f.bookId==='1a3750a2f488'&&f.sourcePage===7)assert.equal(l.blocks.find(b=>b.type==='toc').rows.find(r=>r.label.cn==='12').printedPage,'82');
 }
});

test('HSK5 pages 9–10 preserve language coverage and independent source answer groups',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('../../conversion-fixtures/hsk5-source-pages-009-010.json',import.meta.url),'utf8'));
 for(const f of fixtures){const l=fromModel(f.source,f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));
  assert.deepEqual(validatePage(localizeLayout(l),{requireKz:true}).errors,[]);
  const html=pageDocument(l);for(const lang of ['ru','en','kz','orig'])assert.match(html,new RegExp('data-lang="'+lang+'"'));
  const choices=l.blocks.filter(b=>b.documentText?.choice);
  if(f.bookId==='1a3750a2f488'){
   assert.equal(choices.length,f.sourcePage===9?24:32);
   for(const q of new Set(choices.map(b=>b.documentText.choice.question)))assert.deepEqual(choices.filter(b=>b.documentText.choice.question===q).map(b=>b.documentText.choice.letter).sort(),['A','B','C','D']);
   assert.equal(new Set(choices.map(b=>b.documentText.font)).size,1);
   assert.match(html,/data-hsk-speak=/);assert.match(html,/\.lang=&#39;zh-CN&#39;/);
   for(const b of choices)for(const v of b.documentText.choice.vocabulary){assert.ok(b.documentText.choice.hz.includes(v.hz));assert.ok(v.ru&&v.en&&v.kk);}
  }else assert.equal(choices.length,0);
 }
});

test('HSK5 pages 11–12 keep merged contents, four reading choices and numbered blanks',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('../../conversion-fixtures/hsk5-source-pages-011-012.json',import.meta.url),'utf8'));
 for(const f of fixtures){const l=fromModel(f.source,f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));assert.deepEqual(validatePage(localizeLayout(l),{requireKz:true}).errors,[]);const html=pageDocument(l);assert.match(html,/data-en=/);assert.match(html,/data-kz=/);
  if(f.bookId==='9b495a8351c6'){const t=l.blocks.find(b=>b.type==='table');assert.equal(t.rowCount,13);if(f.sourcePage===11){assert.equal(t.cells.filter(c=>c.rowspan===3).length,4);assert.equal(t.cells.find(c=>c.row===12&&c.col===3).cn,'97');assert.equal(t.cells.length,44);}else {assert.equal(t.cells.length,39);const vocabulary=pageVocabulary(l);assert.equal(vocabulary.length,40);assert.ok(vocabulary.every(v=>v.trans&&v.trans_en&&v.trans_kz));assert.ok(vocabulary.some(v=>v.word==='过来'&&v.py==='guòlái'));}assert.match(html,/role="table"/);}
  else {const c=l.blocks.filter(b=>b.documentText?.choice);assert.equal(c.length,16);for(const q of new Set(c.map(b=>b.documentText.choice.question)))assert.deepEqual(c.filter(b=>b.documentText.choice.question===q).map(b=>b.documentText.choice.letter).sort(),['A','B','C','D']);if(f.sourcePage===11){assert.deepEqual(l.blocks.find(b=>b.documentText?.cloze).documentText.cloze,[15,16,17,18]);assert.match(html,/data-cloze-numbers="15,16,17,18"/);}else assert.equal(c.find(b=>b.documentText.choice.question===20&&b.documentText.choice.letter==='D').cn,'D 婚姻是否幸福，别人更清楚');}
 }
});

test('small HSK running logo does not trigger cover OCR',()=>{
 assert.equal(needsDisplayOcr({lines:[{text:'HSK',position:{height:.041}},...Array.from({length:30},()=>({text:'阅读'}))]}),false);
 assert.equal(needsDisplayOcr({lines:[{text:'HSK',position:{height:.18}},{text:'标准教程'}]}),true);
});

test('open tables use interior rules and header boundaries instead of equal columns',()=>{
 const g={W:100,H:100,at:(x,y)=>y>=10&&y<15?[30,20,100]:[40,75].includes(x)||[35,60,85].includes(y)?[90,90,90]:[255,255,255]};
 const l=fromModel({blocks:[{type:'table',box:{x:.1,y:.1,w:.8,h:.75},columns:3,rowCount:4,cells:[]}]},100,100);l.theme={};measureDocumentPage(l,g,[]);assert.deepEqual(l.blocks[0].columnEdges,[.1,.4,.75,.9]);assert.ok(l.blocks[0].rowEdges.every((v,i)=>Math.abs(v-[.1,.15,.35,.6,.85][i])<1e-8));assert.equal(l.blocks[0].tableGeometry.verified,true);
});

test('HSK5 pages 13–14 preserve contents continuation and source reading questions 23–28',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('../../conversion-fixtures/hsk5-source-pages-013-014.json',import.meta.url),'utf8'));
 for(const f of fixtures){const l=fromModel(f.source,f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));
  assert.deepEqual(validatePage(localizeLayout(l),{requireKz:true}).errors,[]);const html=pageDocument(l);for(const lang of ['ru','en','kz','orig'])assert.match(html,new RegExp('data-lang="'+lang+'"'));
  assert.equal(l.blocks.find(b=>b.type==='folio').plain,true);assert.doesNotMatch(html,/class="hsk-at hsk-folio(?:-right)?"/);
  if(f.bookId==='9b495a8351c6'){const t=l.blocks.find(b=>b.type==='table');assert.equal(t.rowCount,7);
   if(f.sourcePage===13){assert.equal(t.columns,4);assert.equal(t.cells.filter(c=>c.rowspan===3).length,2);assert.deepEqual(t.cells.filter(c=>c.col===1&&c.row>0).map(c=>c.cn),['13','14','15','16','17','18']);assert.deepEqual(t.cells.filter(c=>c.col===3&&c.row>0).map(c=>c.cn),['106','114','123','134','142','150']);assert.equal(l.blocks.find(b=>b.cn?.includes('词语总表')).documentText.translationColor,'#ffffff');}
   else {assert.equal(t.columns,3);const v=pageVocabulary(l);assert.equal(v.length,30);assert.ok(v.every(w=>w.trans&&w.trans_en&&w.trans_kz));assert.ok(v.some(w=>w.word==='起'&&w.py==='qǐ'));assert.ok(!v.some(w=>w.word==='为所'));}
  }else{const choices=l.blocks.filter(b=>b.documentText?.choice),qs=f.sourcePage===13?[23,24,25]:[26,27,28];assert.equal(choices.length,12);for(const q of qs)assert.deepEqual(choices.filter(b=>b.documentText.choice.question===q).map(b=>b.documentText.choice.letter).sort(),['A','B','C','D']);
   const vocabulary=pageVocabulary(l);assert.ok(vocabulary.some(v=>v.word===(f.sourcePage===13?'保护':'责任感')));assert.ok(vocabulary.every(v=>v.trans_en&&v.trans_kz));
   for(const b of l.blocks.filter(b=>b.documentText?.vocabulary)){for(const v of b.documentText.vocabulary)assert.ok(b.cn.includes(v.hz));const raw=f.source.blocks.find(s=>s.documentText?.sourceBox&&['x','y','w','h'].every(k=>s.documentText.sourceBox[k]===b.documentText.sourceBox[k]));assert.ok(raw);assert.deepEqual(b.documentText.vocabulary,raw.documentText.vocabulary);}
   const inset=l.blocks.find(b=>b.cn.includes(f.sourcePage===13?'别人和他':'持续上升'));assert.ok(f.sourcePage===13?inset.box.x>.30:inset.box.w<.55);assert.match(html,/data-hsk-speak=/);
  }
 }
});
