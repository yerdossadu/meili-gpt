import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {render,pageDocument} from './core.mjs';

test('source view retains OCR text, translations and interactive phonetics',async()=>{
 const phonetics=JSON.parse(await readFile(new URL('./phonetics/workbook-page4.json',import.meta.url),'utf8'));
 assert.equal(phonetics.cells.length,26);
 assert.deepEqual(phonetics.cells.filter(c=>c.kind==='initial').map(c=>c.text),['b','p','m','f','d','t','n','l','g','k','h']);
 const assets={sourceScan:'scan.png'};
 for(const cell of phonetics.cells){
   const file=await readFile(new URL(`./phonetics/${cell.text}.mp3`,import.meta.url));assert.ok(file.length>1000,cell.text);
   assets[`phonetic-${cell.text}`]=`assets/${cell.text}.mp3`;
 }
 const layout={page:{width:3912,height:5670},phonetics,sourceLines:[{text:'汉语声母和韵母',position:{x:.1,y:.2,width:.3,height:.02}}],blocks:[{type:'para',cn:'声母和韵母',en:'Initials and Finals',ru:'Инициали и финали',box:{x:.1,y:.1,w:.8,h:.04}}]};
 const html=render(layout,{assets,lang:'original'});
 assert.ok(html.includes('hsk-source-page'));assert.ok(html.includes('汉语声母和韵母'));assert.ok(html.includes('Инициали и финали'));
 assert.equal((html.match(/class="hsk-phonetic-cell"/g)||[]).length,26);
 assert.ok(html.includes('assets/b.mp3'));assert.ok(html.includes('aria-pressed="false"'));
 assert.ok(pageDocument(layout,{assets}).includes('setLang(page,b.dataset.lang)'));
});

test('workbook page 7 keeps every initial, final and read-aloud syllable clickable without a recording',async()=>{
 const phonetics=JSON.parse(await readFile(new URL('./phonetics/workbook-page7.json',import.meta.url),'utf8'));
 assert.equal(phonetics.cells.filter(c=>c.kind==='initial').length,3);
 assert.equal(phonetics.cells.filter(c=>c.kind==='final').length,14);
 assert.equal(phonetics.cells.filter(c=>c.kind==='syllable').length,18);
 const html=render({page:{width:1200,height:1739},phonetics,blocks:[]},{assets:{},lang:'original'});
 assert.equal((html.match(/class="hsk-phonetic-cell"/g)||[]).length,35);
 assert.doesNotMatch(html,/class="hsk-phonetic-cell"[^>]*disabled/);
 assert.match(html,/data-hsk-speak="jī"/);
 assert.match(html,/Слог jī — выбрать и прослушать/);
 assert.match(html,/SpeechSynthesisUtterance\(this\.dataset\.hskSpeak\|\|this\.textContent\)/);
});

test('workbook page 11 exposes all initials and finals in its scan-based chart',async()=>{
 const phonetics=JSON.parse(await readFile(new URL('./phonetics/workbook-page11.json',import.meta.url),'utf8'));
 assert.equal(phonetics.cells.filter(c=>c.kind==='initial').length,7);
 assert.equal(phonetics.cells.filter(c=>c.kind==='final').length,20);
 const html=render({page:{width:1200,height:1739},phonetics,blocks:[]},{assets:{},lang:'original'});
 assert.equal((html.match(/class="hsk-phonetic-cell"/g)||[]).length,27);
 assert.doesNotMatch(html,/class="hsk-phonetic-cell"[^>]*disabled/);
});
