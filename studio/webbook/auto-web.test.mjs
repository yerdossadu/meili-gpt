import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMathpix,pageHtml} from './auto-web.mjs';
test('OCR preserves word geometry and escapes untrusted text',()=>{
 const ocr=normalizeMathpix({image_width:1000,image_height:2000,word_data:[{text:'你好<script>',cnt:[[100,200],[300,200],[300,240],[100,240]]}]});
 assert.deepEqual(ocr.lines[0].position,{x:.1,y:.1,width:.2,height:.02});
 const html=pageHtml(ocr,3);assert.ok(html.includes('你好&lt;script&gt;'));assert.ok(html.includes('left:10%'));assert.ok(html.includes('src="3.png"'));assert.ok(!html.includes('<script>'));
});
test('missing coordinates fail rather than produce a plausible page',()=>{
 assert.throws(()=>normalizeMathpix({image_width:1000,image_height:2000,line_data:[{text:'你好'}]}),/координатами/);
});
test('uncertain tokens and uncovered print remain visible as review findings',()=>{
 const p={x:.1,y:.2,width:.02,height:.03};
 const html=pageHtml({width:1000,height:2000,lines:[{text:'菜',position:p,reviewRequired:true}],quality:{issues:[{kind:'unassigned-print',position:p}]}},3);
 assert.ok(html.includes('word uncertain'));assert.ok(html.includes('class="gap"'));assert.ok(html.includes('Полнота текста не подтверждена'));assert.ok(html.includes('3.quality.json'));
});
