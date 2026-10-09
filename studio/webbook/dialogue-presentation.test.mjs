import test from 'node:test';
import assert from 'node:assert/strict';
import {dialoguePresentation} from './dialogue-presentation.mjs';
import {fromModel,render} from './core.mjs';
const turn={speaker:'A',hz:'王老师是你的中文老师吗？',py:'Wáng lǎoshī shì nǐ de Zhōngwén lǎoshī ma?',cnBox:{x:.1,y:.4,w:.38,h:.02},translation:{ru:'Учитель Ван ваш учитель китайского?',en:'Is Teacher Wang your Chinese teacher?',kk:'Ван мұғалім сіздің қытай тілі мұғаліміңіз бе?'}};
test('translated dialogue rows share a top and reserve enough room for the longest language',()=>{
 const blocks=[.4,.48].flatMap(y=>[.1,.55].map(x=>({box:{x,y,w:.35,h:.07},optionTurns:[structuredClone(turn),structuredClone(turn)]}))),layout={page:{width:1000,height:1400},blocks};const before=structuredClone(blocks),positions=dialoguePresentation(layout);
 assert.equal(positions.get(blocks[0]).y,positions.get(blocks[1]).y);
 assert.ok(positions.get(blocks[2]).y>=positions.get(blocks[0]).y+positions.get(blocks[0]).h+.01);
 assert.deepEqual(blocks,before,'original scan positions must remain intact');
});
test('dialogue rendering retains original Chinese width and gives translations their own readable lines',()=>{
 const layout=fromModel({blocks:[{type:'para',box:{x:.1,y:.4,w:.4,h:.08},cn:turn.hz,en:turn.translation.en,ru:turn.translation.ru}]},1000,1400);layout.blocks[0].optionTurns=[turn];
 const html=render(layout);assert.match(html,/hsk-option-original/);assert.match(html,/hsk-option-localized/);assert.match(html,/hsk-option-meaning/);assert.match(html,/data-en="Is Teacher Wang/);assert.doesNotMatch(html,/width:65\.000%/);
});
test('duplicated English print lines leave the Chinese layer without removing mixed Chinese names',()=>{
 const l=fromModel({blocks:[{type:'para',box:{x:.1,y:.1,w:.8,h:.2},cn:'AI 小语你好！\nHello, AI Xiaoyu!\n你好吗？',en:'Hello, AI Xiaoyu!'}]});
 assert.equal(l.blocks[0].cn,'AI 小语你好！\n你好吗？');assert.equal(l.blocks[0].en,'Hello, AI Xiaoyu!');
});
test('translated dialogue expansion never moves the printed page number',()=>{
 const dialogue={type:'para',box:{x:.1,y:.8,w:.2,h:.06},optionTurns:[turn,turn,turn]},folio={type:'folio',box:{x:.05,y:.96,w:.03,h:.03},text:'008'};
 const positions=dialoguePresentation({page:{width:1000,height:1400},blocks:[dialogue,folio]});
 assert.ok(positions.has(dialogue));assert.equal(positions.has(folio),false);
});
