import test from 'node:test';
import assert from 'node:assert/strict';
import {fromModel,render} from './core.mjs';
import {measureAnswerLattice} from './workbook-drills.mjs';
import {restorePhoneticTokens} from './source-geometry.mjs';
import {phoneticRecordingKey} from './tone-audio.mjs';
const box=(x,y,w=.02,h=.016)=>({x,y,w,h});
test('answer blanks never become reordered tone quartets',()=>{
 const text='___ián\t___īn\t___iǎng\n___iào\t___iè\t___ǐng\n___ǐ\t___ù\t___ià';
 const l=fromModel({blocks:[{type:'text',box:box(.13,.17,.45,.08),py:text}]});
 assert.equal(l.blocks[0].py,text);assert.equal(l.blocks[0].toneRows,undefined);
 assert.equal((render(l).match(/aria-label="Ответ"/g)||[]).length,9);
});
test('sparse initials OCR preserves all 15 answer cells and recovers last column',()=>{
 const b={type:'text',box:box(.13,.32,.72,.065),py:'j___\tx___\tq___\tj___\tq___\nx___\tj___\tx___\tj___\tq___\nx___\tq___\tj___\tx___\tq___'};
 const lines=[0,1,2].flatMap(r=>[0,1,2,3].map(c=>({text:c%2?'x':'q',box:box(.13+c*.155,.322+r*.023)})));
 const out=measureAnswerLattice(b,b,lines);assert.equal(out.gridX.length,5);assert.equal(out.gridY.length,3);assert.ok(Math.abs(out.gridX[4]-.75)<.005);
});
test('combined initials split, missing r is restored, apical IPA is retained',()=>{
 const block={cn:'声母\nInitials\nzh ch sh r\nz c s\n韵母\nFinals\na e i[ɿ/ʅ] u',textTable:{header:box(.1,.1,.8,.04),splits:[.45]},exactTokens:[...['zh','ch sh','Z','C','S'].map((text,i)=>({text,box:box([.15,.21,.15,.21,.27][i],i<2?.2:.23,i===1?.10:.02)})),...['a','e','i[/1]','u'].map((text,i)=>({text,box:box(.5+i*.09,.2)}))]};
 const out=restorePhoneticTokens(block),texts=out.exactTokens.filter(t=>t.tableRow).map(t=>t.text);
 for(const text of ['zh','ch','sh','r','z','c','s','i[ɿ/ʅ]'])assert.ok(texts.includes(text),text);
 assert.equal(phoneticRecordingKey('i[ɿ/ʅ]'),'apical-i');assert.equal(phoneticRecordingKey('i[i]'),'i');assert.equal(phoneticRecordingKey('uei(ui)'),'ui');
});
