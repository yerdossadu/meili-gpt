import test from 'node:test';
import assert from 'node:assert/strict';
import { fromModel, render, snap, gridFromRGBA } from './core.mjs';
import {measureDocumentPage} from './document-page.mjs';
import {localizeLayout,validatePageRevision} from './page-contract.mjs';

test('small printed source numerals can retain their scan-specific contrast', () => {
  const layout = fromModel({ blocks: [{ type: 'text', box: { x: .8, y: .2, w: .08, h: .12 }, cn: '1', color: '#ffffff', bold: true, sans: true }] });
  assert.equal(layout.blocks[0].color, '#ffffff');
  assert.match(render(layout), /color:#ffffff;font-family:var\(--sans\);font-weight:700/);
});

test('a source-bounded textbook diagram is not auto-expanded into adjacent exercise text', () => {
  const width = 80, height = 120, pixels = new Uint8Array(width * height * 4).fill(255);
  const image = { type: 'image', box: { x: .2, y: .2, w: .5, h: .2 }, documentGraphic: true, alt: 'body diagram' };
  const layout = fromModel({ blocks: [image] }, 800, 1200);
  const result = snap(layout, gridFromRGBA(pixels, width, height), { lines: [] });
  assert.deepEqual(result.blocks[0].box, image.box);
});

test('source answer choices preserve stable question and choice markers', () => {
  const layout = fromModel({ blocks: ['A','B','C','D'].map(letter => ({
    type: 'text', box: { x: .1, y: .3, w: .4, h: .025 }, cn: `${letter} 家里不会太脏`,
    en: `${letter} the house will not be too dirty`, ru: `${letter} дома не будет грязно`,
    documentText: { sourceBox: { x: .1, y: .3, w: .4, h: .025 }, choice: { question: 1, letter, hz: '家里不会太脏' } }
  })) }, 1000, 1400);
  layout.blocks.forEach(b => { b.documentText.lines = [{ text: b.documentText.choice.letter + ' 家里不会太脏', box: { ...b.box } }]; b.documentText.font = 1.4; });
  const html = render(layout);
  for (const letter of ['A','B','C','D']) {
    assert.match(html, new RegExp(`data-question="1" data-choice="${letter}"`));
  }
});

test('reviewed missing OCR words become native Chinese with separate translations',()=>{
 const q={x:.25,y:.4,w:.025,h:.02};
 const l=fromModel({blocks:[{type:'text',box:{...q,w:.05,h:.04},cn:'我',en:'I',ru:'я',documentText:{sourceBox:q,studyToken:true,sourceLines:[{text:'我',box:q}]}}],kz:{я:'мен'}},1000,1400);l.theme={};
 measureDocumentPage(l,{W:20,H:28,at:()=>[255,255,255]},[]);
 assert.equal(l.blocks[0].documentText.lines[0].text,'我');assert.ok(Number.isFinite(l.blocks[0].documentText.font));
 assert.match(render(l),/hsk-study-token-original.*data-hsk-speak="我"/);assert.match(render(l),/data-en="I"/);assert.match(render(l),/data-kz="мен"/);
});

test('splitting a translated source row preserves Kazakh only when all its source words survive',()=>{
 const q={x:.1,y:.3,w:.4,h:.02};
 const before=localizeLayout(fromModel({blocks:[{type:'text',box:q,cn:'她 放弃了 机会',en:'she gave up an opportunity',ru:'она отказалась от возможности',documentText:{sourceBox:q}}],kz:{'она отказалась от возможности':'ол мүмкіндіктен бас тартты'}},1000,1400));
 const words=[['她','она','ол'],['放弃了','отказалась','бас тартты'],['机会','возможность','мүмкіндік']];
 const after=localizeLayout(fromModel({blocks:words.map(([cn,ru],i)=>({type:'text',box:{x:.1+i*.12,y:.3,w:.1,h:.04},cn,ru,documentText:{sourceBox:{x:.1+i*.12,y:.3,w:.1,h:.02},studyToken:true}})),kz:Object.fromEntries(words.map(([,ru,kk])=>[ru,kk]))},1000,1400));
 assert.equal(validatePageRevision(after,before).state,'passed');
 assert.equal(validatePageRevision({...after,blocks:after.blocks.slice(0,2)},before).state,'failed');
 const missing=structuredClone(after);delete missing.blocks[1].translations.ru.kk;delete missing.kz['отказалась'];assert.equal(validatePageRevision(missing,before).state,'failed');
});

test('bilingual glossary keeps source Chinese and pinyin while replacing its English meaning',()=>{
 const q={x:.6,y:.6,w:.3,h:.04},translationBox={x:.78,y:.6,w:.12,h:.03};
 const l=fromModel({blocks:[{type:'text',box:q,cn:'细节',en:'detail',ru:'деталь',documentText:{sourceBox:q,keepOriginal:true,translationBox,sourceLines:[{text:'细节',box:{x:.6,y:.6,w:.07,h:.02}},{text:'xìjié',box:{x:.7,y:.6,w:.07,h:.02}},{text:'detail',box:translationBox,translationSource:true}]}}],kz:{деталь:'егжей-тегжей'}},1000,1400);l.theme={};
 measureDocumentPage(l,{W:20,H:28,at:()=>[255,255,255]},[]);const h=render(l);
 assert.match(h,/hsk-bilingual-original/);assert.match(h,/hsk-bilingual-source-translation/);assert.match(h,/data-kz="егжей-тегжей"/);assert.deepEqual(l.blocks[0].documentText.translationBox,translationBox);
});
test('English source labels remain available when identical to the Chinese field',()=>{
 const q={x:.2,y:.2,w:.2,h:.04};
 const l=fromModel({blocks:[{type:'text',box:q,cn:'Unit 1',en:'Unit 1',ru:'Раздел 1',documentText:{sourceBox:q,keepOriginal:true,translationBox:q,sourceLines:[{text:'Unit',box:q,translationSource:true}]}}],kz:{'Раздел 1':'1-бөлім'}},1000,1400);l.theme={};
 measureDocumentPage(l,{W:20,H:28,at:()=>[255,255,255]},[]);
 assert.equal(l.blocks[0].en,'Unit 1');assert.match(render(l),/data-en="Unit 1"/);
});
test('printed disc marks retain recording identity and use official audio when attached',()=>{
 const q={x:.35,y:.54,w:.07,h:.02};const l=fromModel({blocks:[{type:'text',box:q,cn:'01-1',documentText:{sourceBox:q,audioTrack:'01-1',sourceLines:[{text:'01-1',box:q,font:1.5}]}}]},1000,1400);l.theme={};measureDocumentPage(l,{W:20,H:28,at:()=>[255,255,255]},[]);
 const html=render(l,{assets:{audio:{'01-1':'/audio/01-1.mp3'}}});assert.match(html,/hsk-document-disc/);assert.match(html,/data-track="01-1"/);assert.match(html,/data-src="\/audio\/01-1.mp3"/);assert.match(html,/<ellipse/);assert.doesNotMatch(html,/SpeechSynthesisUtterance/);
});
import{detectAnswerRules}from'./document-page.mjs';
test('answer rules are detected from source pixels independently of page numbers and OCR omission',()=>{
 const W=1000,H=1400,q={x:.1,y:.3,w:.2,h:.02};const g={W,H,at:(x,y)=>y>=443&&y<=444&&[[340,389],[420,469],[500,549]].some(([a,b])=>x>=a&&x<=b)?[145,145,145]:[255,255,255]};
 assert.equal(detectAnswerRules(g,q,[]).length,3);
 assert.equal(detectAnswerRules({W,H,at:()=>[255,255,255]},q,[]).length,0);
 const occupied=[{text:'words',box:{x:.33,y:.3,w:.23,h:.025}}];assert.equal(detectAnswerRules(g,q,occupied).length,0);
 const l=fromModel({blocks:[{type:'text',box:{...q,w:.6},cn:'其他你知道的：',en:'Other words:',ru:'Другие слова:',documentText:{sourceBox:q,sourceLines:[{text:'其他你知道的：',box:q}]}}],kz:{'Другие слова:':'Басқа сөздер:'}},W,H);l.theme={};measureDocumentPage(l,g,[]);
 assert.equal(l.blocks.filter(b=>b.answerField).length,3);assert.match(render(l),/hsk-source-answer/);assert.ok(l.blocks[0].box.x+l.blocks[0].box.w<.34);
});
import{detectAudioDisc}from'./document-page.mjs';
test('disc recovery uses merged OCR plus source ink and rejects a missing mark',()=>{
 const W=1000,H=1400,ocr=[{text:'生词01-2',box:{x:.2,y:.3,w:.2,h:.02}}];const g={W,H,at:(x,y)=>((x-346)/14)**2+((y-434)/7)**2<1?[150,145,148]:[255,255,255]};
 assert.ok(detectAudioDisc(g,'01-2',ocr));assert.equal(detectAudioDisc({W,H,at:()=>[255,255,255]},'01-2',ocr),null);assert.equal(detectAudioDisc(g,'01-1',ocr),null);
});
