import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePrintedGeometry, hasPrintedCardFrame, printedCardBounds, printedParagraphLines, measureTextTable, restorePhoneticTokens } from './source-geometry.mjs';
import { render } from './core.mjs';

test('card border measurement separates adjacent rows despite an oversized model box',()=>{
  const g={W:1000,H:1000,at(x,y){return [100,300].some(top=>y>=top&&y<=top+180&&(x===100||x===300))?[220,150,140]:[255,255,255];}};
  const found=printedCardBounds({x:.1,y:.09,w:.2,h:.23},g);
  assert.ok(found);assert.equal(found.y,.1);assert.ok(found.h<.19);
});

test('tone exercise preserves an empty first-tone slot and speakable accented text',()=>{
  const b={type:'text',box:{x:.2,y:.2,w:.6,h:.3},toneRows:[['ā','á','ǎ','à'],['','ér','ěr','èr']],gridX:[.25,.4,.55,.7],gridY:[.25,.4]};
  const html=render({page:{width:1000,height:1400},blocks:[b],conversionId:'fixture'});
  assert.equal((html.match(/data-hsk-speak=/g)||[]).length,7);
  assert.match(html,/>ěr<\/button>/);assert.doesNotMatch(html,/data-hsk-speak=""/);
});

const block = {type:'lesson',label:'',number:'1',cn:'你好',en:'Hello',ru:'Привет',box:{x:.08,y:.1,w:.82,h:.25}};
const lines = [{text:'你好',box:{x:.3,y:.18,w:.4,h:.08}},{text:'Hello',box:{x:.3,y:.28,w:.3,h:.04}}];

test('OCR line boundaries preserve all semantic Chinese glyphs even when OCR misses characters',()=>{
  const cn='汉语声母和韵母拼合组成音节，但是声母和韵母不是都能相拼的。在下方表格列举的部分声母中，其他声母不能相拼。';
  const printed=[{text:cn.slice(0,29).replace('声母','声'),box:{x:.2,y:.2,w:.7,h:.02}},{text:cn.slice(29),box:{x:.15,y:.23,w:.7,h:.02}}];
  const result=printedParagraphLines({type:'para',cn,box:{x:.15,y:.19,w:.75,h:.1}},printed);
  assert.equal(result.map(l=>l.text).join(''),cn);
  assert.equal(result.length,2);assert.equal(result[1].box.x,.15);
});

test('coloured table geometry restores missing phonetic cells and retains visible text',()=>{
  const grid={W:400,H:400,at(x,y){return y>=80&&y<104&&x>=40&&x<360?[233,110,90]:((y===160&&x>=40&&x<360)||(x===160&&y>=104&&y<=160))?[230,190,180]:[255,255,255];}};
  const token=(text,x,y)=>({text,box:{x,y,w:.025,h:.02}});
  const b={type:'text',box:{x:.1,y:.19,w:.8,h:.22},cn:'声母\nInitials\nb p m f\nd t n l\ng k h\n韵母\nFinals\na o e i [i] u er\nai ei ao ou\nan en\nang eng ong',exactTokens:[
    ...['b','p','m','f'].map((s,i)=>token(s,.15+i*.06,.28)),...['d','t','n'].map((s,i)=>token(s,.15+i*.06,.32)),...['g','K','h'].map((s,i)=>token(s,.15+i*.06,.36)),
    ...['a','o','e','i[]','u','er'].map((s,i)=>token(s,.45+i*.07,.28)),...['ai','ei','ao','ou'].map((s,i)=>token(s,.45+i*.07,.31)),...['an','en'].map((s,i)=>token(s,.45+i*.07,.34)),...['ang','eng','ong'].map((s,i)=>token(s,.45+i*.07,.37))]};
  const measured=measureTextTable(b,grid);assert.ok(measured);assert.equal(measured.textTable.splits.length,1);
  const result=restorePhoneticTokens({...b,...measured});
  assert.ok(result.exactTokens.some(t=>t.text==='l'&&t.recoveredFrom==='semantic-grid'));
  assert.ok(result.exactTokens.some(t=>t.text==='k'&&t.ocrText==='K'));
  assert.ok(result.exactTokens.some(t=>t.text==='i[i]'));
  const html=render({page:{width:400,height:400},blocks:[result],conversionId:'fixture'});
  assert.match(html,/hsk-table-surface/);assert.match(html,/>i\[i\]</);assert.doesNotMatch(html,/hsk-source-page/);
});
function grid(number = true) {
  return {W:200,H:200,at(x,y) {
    if (number && x>=30 && x<40 && y>=36 && y<54) return [10,10,10];
    if (x>=56 && x<180 && y>=20 && y<70) return [220,45,25];
    return [255,255,255];
  }};
}
test('printed header preserves source bounds and renders visible editable text separately from its surface',()=>{
  const measured = measurePrintedGeometry(block,grid(),lines,{width:200,height:200});
  assert.equal(measured.printed.cnBox.x,.3);
  assert.equal(measured.printed.number.x,.15);
  const html=render({page:{width:200,height:200},blocks:[{...block,...measured}]},{editable:true});
  assert.match(html,/hsk-printed-lesson/);
  assert.match(html,/data-hsk-path="cn"[^>]*>你好/);
  assert.match(html,/data-hsk-path="ru"[^>]*>Привет/);
  assert.doesNotMatch(html,/<image[^>]*scan/);
});
test('ambiguous chapter number keeps the established renderer rather than inventing geometry',()=>{
  assert.equal(measurePrintedGeometry(block,grid(false),lines,{width:200,height:200}),null);
});
test('a thin card outline is measured on full resolution, without confusing a coloured photo patch for a frame',()=>{
 const box={x:.2,y:.2,w:.2,h:.3};
 const coarse={W:100,H:100,at:()=>[255,255,255]};
 const hi={W:1000,H:1000,at:(x,y)=>x===201&&y>=220&&y<=480?[230,170,160]:[255,255,255]};
 assert.equal(hasPrintedCardFrame(box,{...coarse,hi}),true);
 assert.equal(hasPrintedCardFrame(box,{...coarse,hi:{...hi,at:(x,y)=>y>=300&&y<310?[230,170,160]:[255,255,255]}}),false);
});
