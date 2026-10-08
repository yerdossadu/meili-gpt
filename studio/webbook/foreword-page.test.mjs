import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measureForewordPage,normalizeProseLatin} from './foreword-page.mjs';
const grid={W:100,H:140,at:()=>[255,255,255]};
test('Latin AI OCR ambiguity is corrected only in known educational terms',()=>{
 assert.equal(normalizeProseLatin('AⅠ助学与AΙ技术，AＩ助教'),'AI助学与AI技术，AI助教');
 assert.equal(normalizeProseLatin('Ⅰ II III AⅠ姓名'),'Ⅰ II III AⅠ姓名');
});
test('foreword preserves complete prose across OCR line boundaries and keeps translations',()=>{
 const text='中文教育推动交流与理解。'.repeat(12),blocks=[{type:'text',cn:'序',ru:'Предисловие',kk:'Алғысөз',box:{x:.45,y:.05,w:.05,h:.03}}];
 const lines=[{text:'序',box:blocks[0].box}];
 for(let i=0;i<3;i++){const y=.15+i*.2,box={x:.1,y,w:.75,h:.15};blocks.push({type:'text',cn:text,ru:'Перевод '+i,kk:'Аударма '+i,box});for(let k=0;k<4;k++)lines.push({text:text.slice(k*36,(k+1)*36),box:{x:k===0?.14:.1,y:y+k*.035,w:.7,h:.02}});}
 const layout={page:{width:1000,height:1400},blocks,source:{blocks:structuredClone(blocks)},theme:{}};
 assert.equal(measureForewordPage(layout,grid,lines),true);
 for(const b of blocks){assert.equal(b.foreword.lines.map(l=>l.text).join(''),b.cn);assert.ok(b.foreword.kk);}
 assert.equal(blocks.filter(b=>b.foreword.paragraph).length,3);
});
test('foreword recognition leaves workbook teaching content unchanged',()=>{
 const layout={page:{width:1000,height:1400},blocks:[{type:'para',cn:'声母和韵母',box:{x:.1,y:.1,w:.8,h:.1}}]},before=structuredClone(layout);
 assert.equal(measureForewordPage(layout,grid,[]),false);assert.deepEqual(layout,before);
});
test('binding strip and folio follow both sides of a printed spread',()=>{
 for(const side of ['left','right']){
  const right=side==='right',folio={type:'folio',text:right?'III':'II',box:{x:right?.93:.03,y:.95,w:.025,h:.02}};
  const blocks=[{type:'text',cn:'前言',box:{x:.45,y:.05,w:.08,h:.03}},...Array.from({length:3},(_,i)=>({type:'text',cn:'学习中文'.repeat(30),box:{x:.15,y:.2+i*.2,w:.7,h:.1}})),folio];
  const layout={page:{width:1000,height:1400},blocks,theme:{}};
  const sample={W:100,H:140,at:(x,y)=>{if(y>=132&&y<136&&(right?x>=90:x<10))return[210,100,90];if(right?x<7:x>=93)return[255,255,255];return[250,222,219];}};
  assert.equal(measureForewordPage(layout,sample,[]),true);
  assert.equal(folio.forewordFolioSide,side);assert.ok(folio.box.w<.15);
  assert.equal(right?folio.box.x+folio.box.w:folio.box.x,right?1:0);
  assert.equal(layout.theme.background.box.x,right?.07:0);
  assert.ok(Math.abs(layout.theme.background.box.w-.93)<.001);
 }
});
test('a narrow signature gains translation room without moving original lines',()=>{
 const signature={type:'text',cn:'编者2025年12月',ru:'Составители\nДекабрь 2025 года',box:{x:.8,y:.8,w:.1,h:.06}};
 const blocks=[{type:'text',cn:'前言',box:{x:.45,y:.05,w:.08,h:.03}},...Array.from({length:3},(_,i)=>({type:'text',cn:'学习中文'.repeat(30),box:{x:.15,y:.2+i*.2,w:.7,h:.1}})),signature];
 const lines=[{text:'编者',box:{x:.86,y:.8,w:.04,h:.02}},{text:'2025年12月',box:{x:.8,y:.83,w:.1,h:.02}}];
 assert.equal(measureForewordPage({page:{width:1000,height:1400},blocks,theme:{}},grid,lines),true);
 assert.ok(signature.box.w>=.299);assert.ok(Math.abs(signature.box.x+signature.box.w-.9)<.001);
 for(const [i,l] of signature.foreword.lines.entries())for(const k of ['x','y','w','h'])assert.ok(Math.abs(l.box[k]-lines[i].box[k])<1e-12);
 assert.equal(signature.foreword.paragraph,false);
});
test('usage guide retains section panels and gives short list items the body column',()=>{
 const blocks=[{type:'text',cn:'使用说明',box:{x:.38,y:.05,w:.2,h:.03}},
 {type:'text',cn:'基本设计',box:{x:.1,y:.16,w:.12,h:.025}},
 ...Array.from({length:2},(_,i)=>({type:'text',cn:'学习中文'.repeat(30),box:{x:.1,y:.25+i*.2,w:.75,h:.12}})),
 {type:'text',cn:'目标：提示学习重点。',box:{x:.14,y:.75,w:.28,h:.02}}];
 const lines=blocks.map(b=>({text:b.cn,box:b.box}));
 const sample={W:200,H:280,at:(x,y)=>x>=20&&x<44&&y>=44&&y<54?[210,100,90]:[250,222,219]};
 const layout={page:{width:1000,height:1400},blocks,source:{blocks:structuredClone(blocks)},theme:{}};
 assert.equal(measureForewordPage(layout,sample,lines),true);
 assert.ok(blocks[1].foreword.banner);assert.ok(blocks[1].box.w<.15);
 assert.equal(blocks[4].foreword.paragraph,true);assert.ok(Math.abs(blocks[4].box.x+blocks[4].box.w-.85)<.001);
 assert.equal(blocks[4].foreword.compact,true);
 assert.equal(blocks[4].foreword.lines[0].box.x,.14);assert.equal(blocks[4].foreword.lines[0].text,'目标：提示学习重点。');
});
test('Chinese text size uses measured line width when glyph height understates print size',()=>{
 const text='学习中文'.repeat(30),blocks=[{type:'text',cn:'序',box:{x:.45,y:.05,w:.05,h:.03}}],lines=[{text:'序',box:blocks[0].box}];
 for(let i=0;i<3;i++){const y=.2+i*.2;blocks.push({type:'text',cn:text,box:{x:.1,y,w:.6,h:.12}});for(let k=0;k<4;k++)lines.push({text:text.slice(k*30,(k+1)*30),box:{x:.1,y:y+k*.03,w:.6,h:.014}});}
 assert.equal(measureForewordPage({page:{width:1000,height:1400},blocks,theme:{}},grid,lines),true);
 for(const b of blocks.slice(1))assert.ok(Math.abs(b.foreword.font-2)<1e-9);
});
