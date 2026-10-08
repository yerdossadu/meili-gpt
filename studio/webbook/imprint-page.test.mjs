import test from 'node:test';import assert from 'node:assert/strict';
import{measureImprintPage}from'./imprint-page.mjs';import{render}from'./core.mjs';
test('imprint restores sixteen semantic rows despite merged vertical OCR labels',()=>{
  const rowText=['出版人 王 芳','责任编辑 杨 益','责任校对 杨 飘','封面设计 乔 剑','版式设计 乔 剑 梧桐影','出版发行 外语教学与研究出版社','社 址 北京市西三环北路19号','网 址 https://www.fltrp.com','印 刷 河北文扬印刷有限公司','开 本 889×1194 1/16','印 张 9','字 数 160千字','版 次 2026年1月第1版','印 次 2026年1月第1次印刷','书 号 ISBN978-7-5213-6774-4','定 价 89.00元'];
  const b={type:'text',box:{x:.1,y:.49,w:.4,h:.3},cn:rowText.join('\n'),ru:rowText.map((_,i)=>'Перевод строки '+i).join('\n')};
  const heading={type:'text',box:{x:.14,y:.08,w:.2,h:.02},cn:'CIP数据',ru:'Данные CIP'};
  const layout={page:{width:1000,height:1360},source:{blocks:structuredClone([heading,b])},blocks:[heading,b],kz:{}};
  const lines=rowText.map((t,i)=>({text:t,box:{x:.11,y:.49+i*.016,w:.35,h:.014}}));
  // A vertical OCR token must not collapse six distinct semantic rows.
  lines.push({text:'网印开印字版',box:{x:.11,y:.60,w:.02,h:.10}});
  assert.equal(measureImprintPage(layout,lines),true);assert.equal(b.imprint.rows.length,16);assert.ok(Math.abs(b.imprint.pitch-.016)<1e-8);assert.equal(b.imprint.rows[14].value,'ISBN978-7-5213-6774-4');
  const html=render(layout);assert.equal((html.match(/class="hsk-imprint-row-translation"/g)||[]).length,16);assert.match(html,/2026年1月第1次印刷/);assert.doesNotMatch(html,/hsk-source-page/);
});
test('imprint detection leaves teaching pages unchanged',()=>{
  const layout={blocks:[{type:'para',cn:'听录音',box:{x:.1,y:.1,w:.8,h:.2}}]};const before=JSON.stringify(layout);assert.equal(measureImprintPage(layout,[]),false);assert.equal(JSON.stringify(layout),before);
});
