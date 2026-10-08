import test from'node:test';import assert from'node:assert/strict';
import{reconcileCreditNames,measureCreditsPage}from'./credits-page.mjs';import{localizeLayout}from'./page-contract.mjs';
import{render}from'./core.mjs';
const fixture=()=>[
 {type:'text',cn:'第2级：王 磊 于 森',en:'Level 2: Wang Lei, Yu Sen',ru:'Уровень 2: Ван Лэй, Юй Сэнь',box:{x:.2,y:.3,w:.5,h:.025}},
 {type:'text',cn:'第3级：王 枫 于 森',en:'Level 3: Wang Feng, Yu Sen',ru:'Уровень 3: Ван Фэн, Юй Сэнь',box:{x:.2,y:.4,w:.5,h:.025}},
 {type:'text',cn:'第5级：于 淼',en:'Level 5: Yu Miao',ru:'Уровень 5: Юй Мяо',box:{x:.2,y:.5,w:.5,h:.025}}
];
const evidence=confidence=>[.3,.4,.5].map((y,i)=>({text:i===0?'第2级王磊于淼':i===1?'第3级王枫于淼':'第5级于淼',confidence,box:{x:.2,y,w:.5,h:.02}}));
test('repeated OCR corrects a known proper name and preserves its KZ transliteration',()=>{
 const blocks=fixture(),before={blocks:structuredClone(blocks),kz:{[blocks[0].ru]:'2-деңгей: Ван Лэй, Юй Сэнь',[blocks[1].ru]:'3-деңгей: Ван Фэн, Юй Сэнь'}};
 reconcileCreditNames(blocks,evidence(.98));assert.match(blocks[0].cn,/于淼/);assert.match(blocks[0].ru,/Юй Мяо/);assert.match(blocks[0].en,/Yu Miao/);assert.equal(blocks[0].nameCorrections.length,1);
 const result=localizeLayout({blocks,kz:{}},before);assert.equal(result.blocks[0].translations.ru.kk,'2-деңгей: Ван Лэй, Юй Мяо');assert.equal(result.blocks[1].translations.ru.kk,'3-деңгей: Ван Фэн, Юй Мяо');
});
test('low-confidence evidence cannot replace a personal name',()=>{const blocks=fixture(),before=JSON.stringify(blocks);reconcileCreditNames(blocks,evidence(.6));assert.equal(JSON.stringify(blocks),before);});
test('credits specialization cannot change a workbook lesson',()=>{const layout={blocks:fixture()};const before=JSON.stringify(layout);assert.equal(measureCreditsPage(layout,{W:10,H:10,at:()=>[255,255,255]},[]),false);assert.equal(JSON.stringify(layout),before);});
test('Roman printed folio is retained once in the full-width capsule',()=>{const html=render({page:{width:1000,height:1360},blocks:[{type:'folio',text:'I',box:{x:.9,y:.94,w:.1,h:.03},creditsFolio:{color:'#d8706e'}}]});assert.equal((html.match(/hsk-credits-folio/g)||[]).length,1);assert.match(html,/>I<\/span>/);});
