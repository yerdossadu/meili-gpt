import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sourceBox,sourceChoices,glossaryRows,paragraphGroups,splitSourceLine,translatedSourceBlock} from './ocr-structure.mjs';
import {detectTintedPanels,detectAnswerRules,measureDocumentPage} from './document-page.mjs';
import {fromModel,ocrLinesOf,pageDocument} from './core.mjs';
import {localizeLayout,validatePage} from './page-contract.mjs';
const fixtures=JSON.parse(readFileSync(new URL('../../conversion-fixtures/hsk5-source-pages-017-018.json',import.meta.url),'utf8'));
test('fragmented real workbook choices retain all four answers in each source question',()=>{
 for(const f of fixtures.filter(f=>f.bookId==='1a3750a2f488')){const parts=sourceChoices(f.ocr.lines.filter(l=>sourceBox(l).y>.19&&sourceBox(l).y<.8)),start=f.sourcePage===17?7:15,end=f.sourcePage===17?14:18;
  assert.equal(parts.length,(end-start+1)*4);for(let q=start;q<=end;q++)assert.deepEqual(parts.filter(p=>p.question===q).map(p=>p.letter),['A','B','C','D']);assert.ok(parts.every(p=>p.hz&&!/^[ABCD]$/.test(p.hz)));
 }
});
test('glossary baseline assignment does not borrow the next word pinyin',()=>{
 const f=fixtures.find(f=>f.bookId==='9b495a8351c6'&&f.sourcePage===17),terms=f.source.blocks.flatMap(b=>b.documentText?.vocabulary||[]),rows=glossaryRows(f.ocr.lines.filter(l=>sourceBox(l).x>.55&&sourceBox(l).x<.94),terms);
 assert.equal(rows.length,26);for(const row of rows){const term=row.documentText.vocabulary[0];assert.equal(row.documentText.sourceLines.filter(l=>l.text===term.py).length,1,term.hz);assert.ok(term.ru&&term.en&&term.kk);}
 const body=f.ocr.lines.filter(l=>sourceBox(l).x<.56&&sourceBox(l).y>.07&&/[\p{Script=Han}]{2}/u.test(l.text));assert.equal(paragraphGroups(body).length,5);
});
test('small and large tinted panels remain independent of white text and dark headings',()=>{
 const grid={W:200,H:300,at:(x,y)=>x>=115&&x<185&&y>=25&&y<260?[255,248,215]:x<30&&y<15?[20,25,80]:[255,255,255]};
 const panels=detectTintedPanels(grid);assert.equal(panels.length,1);assert.ok(panels[0].box.x>.56);assert.ok(panels[0].box.w<.37);
 const small={...grid,at:(x,y)=>x>=115&&x<185&&y>=25&&y<65?[255,248,215]:[255,255,255]};assert.equal(detectTintedPanels(small).length,1);
});
test('single long answer rule survives antialiased partial strokes and end punctuation OCR',()=>{
 const g={W:1000,H:1000,at:(x,y)=>(y===500&&x>=490&&x<=830)||(y===501&&x>=340&&x<=830)?[120,120,120]:[255,255,255]},label={x:.26,y:.48,w:.07,h:.024};
 const rules=detectAnswerRules(g,label,[{text:'?',box:{x:.825,y:.48,w:.018,h:.03}}],{minWidth:.15,maxWidth:.65,minCount:1});assert.equal(rules.length,1);assert.ok(rules[0].w>.47&&rules[0].w<.49);
 assert.deepEqual(detectAnswerRules(g,label,[{text:'occupied',box:{x:.4,y:.48,w:.3,h:.03}}],{minWidth:.15,maxWidth:.65,minCount:1}),[]);
});
test('split bilingual heading binds native fragments instead of falling back to duplicate text',()=>{
 const f=fixtures.find(f=>f.bookId==='9b495a8351c6'&&f.sourcePage===18),line=f.ocr.lines.find(l=>l.text==='Notes1如何'),parts=splitSourceLine(line,['Notes','1 如何']);
 const b=translatedSourceBlock([parts[0]],{en:'Notes',ru:'Слова'});assert.equal(b.documentText.sourceLines.length,1);
 const l=fromModel({blocks:[b],kz:{'Слова':'Сөздер'}},f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));assert.equal(l.blocks[0].unresolvedStructure,undefined);assert.equal(l.blocks[0].documentText.lines[0].text,'Notes');
});
test('all four page contracts preserve source numbering, native text and three languages',()=>{
 for(const f of fixtures){const l=fromModel(f.source,f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));const localized=localizeLayout(l);assert.deepEqual(validatePage(localized,{requireKz:true}).errors,[]);const html=pageDocument(localized);assert.match(html,/data-en=/);assert.match(html,/data-kz=/);assert.doesNotMatch(html,/data-correct=/);assert.ok(l.blocks.every(b=>!b.unresolvedStructure),f.bookId+' '+f.sourcePage);}
});
test('inserting an answer field preserves old field identities without duplicate IDs',()=>{
 const block=(answerField,y)=>({type:'text',box:{x:.3,y,w:.4,h:.02},cn:'',en:'',ru:'',answerField});
 const before=localizeLayout({page:{width:100,height:150},blocks:[block('first',.5),block('third',.7)]});
 const after=localizeLayout({page:before.page,blocks:[block('first',.5),block('second',.6),block('third',.7)]},before);
 assert.equal(after.blocks[0].id,before.blocks[0].id);assert.equal(after.blocks[2].id,before.blocks[1].id);assert.equal(new Set(after.blocks.map(b=>b.id)).size,3);
});
test('dense horizontal choices place translated captions beside native source text',()=>{
 const f=fixtures.find(f=>f.bookId==='1a3750a2f488'&&f.sourcePage===18),l=fromModel(f.source,f.ocr.width,f.ocr.height);l.theme={};measureDocumentPage(l,{W:100,H:150,at:()=>[255,255,255]},ocrLinesOf(f.ocr));
 const choices=l.blocks.filter(b=>b.documentText?.choice);assert.equal(choices.length,16);for(const b of choices){const d=b.documentText,q=d.choiceCaptionBox;assert.ok(q&&q.x>=d.sourceBox.x+d.sourceBox.w+.005);assert.ok(q.x+q.w<=b.box.x+b.box.w+.001);}
 assert.match(pageDocument(localizeLayout(l)),/hsk-choice-inline-caption/);
});
