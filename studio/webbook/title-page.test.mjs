import test from 'node:test';
import assert from 'node:assert/strict';
import {measureTitlePage} from './title-page.mjs';
import {render} from './core.mjs';
const title={type:'text',cn:'新HSK教程 1',en:'New HSK Course 1',ru:'Новый курс HSK 1',box:{x:.18,y:.15,w:.67,h:.29}};
const credit={type:'text',cn:'主编：郭风岚',ru:'Главный редактор: Го Фэнлань',box:{x:.24,y:.48,w:.14,h:.08}};
const publisher={type:'text',cn:'外语教学与研究出版社\n北京 BEIJING',en:'FOREIGN LANGUAGE TEACHING AND RESEARCH PRESS\nBEIJING',ru:'Издательство\nПекин',box:{x:.39,y:.91,w:.22,h:.06}};
const lines=[{text:title.en,box:{x:.377,y:.45,w:.22,h:.019}},{text:credit.cn,box:{x:.24,y:.48,w:.1,h:.016}},{text:'外语教学与研究出版社',box:{x:.4,y:.91,w:.2,h:.014}}];
const grid={W:700,H:950,at(x,y){return x>210&&x<500&&y>=150&&y<=420?[230,100,100]:[255,255,255];}};
test('title-page vector includes entire display lettering and keeps native localized credits',()=>{
  const layout={page:{width:2342,height:3190},source:{blocks:[title]},blocks:structuredClone([title,credit,publisher]),kz:{[title.ru]:'Жаңа HSK курсы 1'}};
  assert.equal(measureTitlePage(layout,grid,lines),true);
  const b=layout.blocks[0];assert.ok(b.titleArtwork.box.y+b.titleArtwork.box.h>=421/950);assert.ok(b.titleFont>2);
  const html=render(layout);assert.match(html,/hsk-title-art/);assert.match(html,/Главный редактор/);assert.match(html,/data-kz="Жаңа HSK курсы 1"/);assert.doesNotMatch(html,/<img/);
});
test('title-page specialization cannot alter a lesson or workbook drill',()=>{
  const layout={source:{blocks:[title]},blocks:[structuredClone(title),{type:'para',box:{x:.2,y:.5,w:.7,h:.1},cn:'听录音'}]};
  const before=JSON.stringify(layout);assert.equal(measureTitlePage(layout,grid,lines),false);assert.equal(JSON.stringify(layout),before);
});
