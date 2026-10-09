import test from 'node:test';import assert from 'node:assert/strict';
import {measureCoverPage} from './cover-page.mjs';import{render}from'./core.mjs';
test('cover display area cannot absorb unrelated credits or OCR noise',()=>{
 const line=(text,x,y,w,h)=>({text,box:{x,y,w,h}});
 const lines=[line('标准教程',.3,.1,.4,.05),line('STANDARD',.3,.16,.4,.04),line('COURSE',.3,.21,.4,.04),line('HSK',.15,.3,.7,.25),line('5上',.4,.65,.3,.2),line('主编：',.4,.56,.1,.03),line('-',.5,.4,.1,.03)];
 const title={type:'text',cn:'HSK 5上',en:'',ru:'',box:{x:.1,y:.28,w:.8,h:.6}};
 const heading={type:'text',cn:'标准教程',en:'STANDARD\nCOURSE',ru:'СТАНДАРТНЫЙ\nКУРС',box:{x:.3,y:.1,w:.4,h:.15}};
 const layout={page:{width:700,height:1000},blocks:[title,heading],kz:{[heading.ru]:'СТАНДАРТТЫ\nКУРС'}};
 const grid={W:100,H:140,at:(x,y)=>y>40&&y<80?[10,20,65]:[255,255,255]};
 assert.equal(measureCoverPage(layout,grid,lines),true);
 assert.deepEqual(title.coverLines.map(l=>l.text),['HSK','5上']);
 const html=render(layout);assert.match(html,/<text/);assert.match(html,/data-kz="СТАНДАРТТЫ"/);assert.doesNotMatch(html,/<img/);
});
test('ordinary teaching pages do not enter the cover specialization',()=>{
 const layout={blocks:[{type:'para',cn:'标准教程'}]};const before=JSON.stringify(layout);
 assert.equal(measureCoverPage(layout,{},[]),false);assert.equal(JSON.stringify(layout),before);
});
