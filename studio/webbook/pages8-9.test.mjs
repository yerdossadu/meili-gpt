import test from 'node:test';
import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';
import{measureCharacterPage}from'./character-page.mjs';
import{measureForewordPage}from'./foreword-page.mjs';
import{measureReadingGrid}from'./workbook-drills.mjs';
import{attachInteractiveCaptions,render,fromModel}from'./core.mjs';
import{recordingKey}from'./tone-audio.mjs';
const grid={W:100,H:140,at:(x)=>x>92?[255,255,255]:[250,222,219]};
test('bilingual introduction separates native CN and EN and never expands portraits into pink paper',()=>{
 const cn='内容梗概及主要人物',en='Content Summary and Main Characters',blocks=[{type:'text',cn,en,ru:'Заголовок',box:{x:.2,y:.1,w:.6,h:.08}},...Array.from({length:2},(_,i)=>({type:'image',box:{x:.09,y:.5+i*.2,w:.1,h:.09}}))];
 const layout={blocks,source:{blocks:structuredClone(blocks)},theme:{},page:{width:1000,height:1400}};
 blocks[1].box={x:0,y:.2,w:.5,h:.7};
 const lines=[{text:cn,box:{x:.27,y:.06,w:.4,h:.03}},{text:en,box:{x:.2,y:.1,w:.6,h:.02}}];
 assert.equal(measureCharacterPage(layout,grid,lines),true);
 assert.equal(blocks[0].bilingualPrint.cn.map(l=>l.text).join(''),cn);
 assert.equal(blocks[0].bilingualPrint.en.map(l=>l.text).join(''),en);
 assert.deepEqual(blocks[1].box,layout.source.blocks[1].box);
 assert.equal(layout.theme.background.box.x,0);assert.ok(layout.theme.background.box.w<1);
 assert.match(render(layout),/data-en="Content Summary and Main Characters"/);
 assert.equal(measureCharacterPage({blocks:[{cn:'声母 韵母'}]},grid,[]),false);
});
test('English usage guide keeps full original Latin prose across measured lines',()=>{
 const text='The new course offers language study and practical communication. '.repeat(3),blocks=[{type:'text',cn:'',en:'Instructions for Use',box:{x:.25,y:.05,w:.5,h:.03}},...Array.from({length:2},(_,i)=>({type:'text',cn:'',en:text,ru:'Перевод',box:{x:.1,y:.2+i*.3,w:.75,h:.15}}))];
 const lines=blocks.flatMap(b=>[{text:b.en,box:b.box}]),layout={blocks,source:{blocks:structuredClone(blocks)},theme:{},page:{width:1000,height:1400}};
 assert.equal(measureForewordPage(layout,grid,lines),true);
 for(const b of blocks){assert.equal(b.foreword.latin,true);assert.equal(b.foreword.lines.map(l=>l.text).join(''),b.en);}
});
test('mixed syllable and word row preserves umlaut despite OCR u and uses complete word recordings',()=>{
 const values=['yōu','yóu','yǒu','yòu','yóuyǒng','lǚyóu','péngyou'],lines=values.map((text,i)=>({text:text==='lǚyóu'?'lǔyóu':text,confidence:.99,box:{x:.1+i*.1,y:.3,w:.07,h:.02}}));
 const b={type:'text',cn:values.join(' '),box:{x:.1,y:.29,w:.75,h:.05}},r=measureReadingGrid(b,lines);
 assert.deepEqual(r.readingTokens.map(t=>t.text),values);assert.equal(new Set(r.readingTokens.map(t=>t.row)).size,1);
 assert.equal(recordingKey('lǚyóu'),'lv3-you2');assert.equal(recordingKey('yóuyǒng'),'you2-yong3');assert.equal(recordingKey('péngyou'),'pengyou');
 const html=render({page:{width:1000,height:1400},blocks:[{...b,...r}]},{assets:{'tone-pengyou':'pengyou.mp3'}});
 assert.match(html,/aria-label="Слово péngyou"/);assert.doesNotMatch(html,/тон u/);
});
test('descriptive card alt produces separate native captions and page vocabulary without guessing matching exercises',()=>{
 const img={type:'image',alt:'Карточка с фотографией друзей, пиньинем péngyou и иероглифами 朋友.',box:{x:.1,y:.7,w:.15,h:.15}};
 assert.deepEqual(attachInteractiveCaptions({blocks:[img]}).blocks[0].caption,{hz:'朋友',py:'péngyou',ru:'друг',en:'friend'});
 assert.equal(attachInteractiveCaptions({blocks:[img,{type:'text',cn:'选择对应图片'}]}).blocks[0].caption,undefined);
});

test('plain Latin prose is never discarded as a phonetic drill',()=>{const text='this is a complete introduction with several plain latin words';const l=fromModel({blocks:[{type:'text',cn:text,en:'',ru:'Перевод',box:{x:.1,y:.2,w:.8,h:.1}}]},1000,1400);assert.equal(l.blocks[0].cn,text);assert.equal(l.blocks[0].ru,'Перевод');});
