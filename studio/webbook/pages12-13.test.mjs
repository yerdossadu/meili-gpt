import test from'node:test';import assert from'node:assert/strict';
import{fromModel,render}from'./core.mjs';import{measureContentsPage}from'./contents-page.mjs';
import{measureAnswerLattice,reconcileAnswerGrid}from'./workbook-drills.mjs';
import{measureCaptionFrame}from'./source-geometry.mjs';
test('spelling rule number cannot become the lesson number',()=>{
 const l=fromModel({blocks:[{type:'lesson',number:'2',cn:'拼写规则',en:'Spelling Rules',ru:'Правила правописания',box:{x:.1,y:.6,w:.5,h:.03}}]});
 assert.equal(l.blocks[0].type,'para');assert.equal(l.blocks[0].number,'2');assert.ok(!l.blocks.some(b=>b.type==='lesson'));
});
test('contents keeps unequal printed row heights and nested translations',()=>{
 const b={type:'contents',box:{x:.1,y:.1,w:.8,h:.8},columns:[.1,.2,.4,.5,.9],header:[{},{cn:'课文',en:'Lesson',ru:'Урок'},{cn:'页码'},{cn:'小语讲堂'}],rows:Array.from({length:6},(_,i)=>[{cn:String(i+1)},{cn:'你好',en:'Hello',ru:'Привет'},{cn:'001'},{items:[{cn:'1. 语序',en:'Word order',ru:'Порядок слов'}]}])};
 const grid={W:1000,H:1000,at:(x,y)=>x>=100&&x<=900&&[[100,150],[240,330],[450,610],[730,900]].some(([a,z])=>y>=a&&y<z)?[230,160,155]:[255,255,255]};
 const l=fromModel({blocks:[b],kz:{'Урок':'Сабақ','Привет':'Сәлем','Порядок слов':'Сөз тәртібі'}},1000,1000);
 assert.ok(measureContentsPage(l,grid));assert.deepEqual(l.blocks[0].rowEdges,[.1,.15,.24,.33,.45,.61,.73,.9]);
 const html=render(l);assert.match(html,/data-en="Word order"/);assert.match(html,/data-kz="Сөз тәртібі"/);assert.equal((html.match(/hsk-contents-row/g)||[]).length,7);
});
test('initials left of answer-rule model box do not shift columns',()=>{
 const py='z___\tzh___\tc___\tz___\tch___\nr___\tsh___\tz___\tr___\ts___\nch___\tr___\tzh___\tc___\tsh___',b={type:'text',box:{x:.154,y:.85,w:.739,h:.08},py};
 const lines=py.split('\n').flatMap((row,r)=>row.split('\t').map((t,c)=>({text:t.replaceAll('_',''),confidence:.99,box:{x:.118+c*.155,y:.855+r*.023,w:.02,h:.016}})));
 Object.assign(b,measureAnswerLattice(b,b,lines));assert.equal(b.gridX.length,5);assert.ok(b.gridX[0]<.13);assert.equal(reconcileAnswerGrid(b,lines).py,py);
});
test('two printed tone quartets become native tone buttons',()=>{
 const l=fromModel({blocks:[{type:'text',box:{x:.28,y:.13,w:.43,h:.06},py:'wā\twá\twǎ\twà\nwēi\twéi\twěi\twèi'}]},1000,1400);
 assert.equal(l.blocks[0].toneRows.length,2);assert.equal(l.blocks[0].toneRows.flat().length,8);
});
test('caption frames use lower printed borders instead of colourful photo edges',()=>{
 const grid={W:1000,H:1000,at:(x,y)=>((x===200||x===400)&&y>=300&&y<=460||y===460&&x>=200&&x<=400)?[200,100,100]:[255,255,255]};
 const q=measureCaptionFrame({x:.2,y:.3,w:.2,h:.1},grid);assert.ok(q);assert.equal(q.x,.2);assert.equal(q.w,.2);assert.ok(Math.abs(q.h-.16)<1e-8);
});

test('ordinary instructions expose English in the same translation layer as Russian and Kazakh',()=>{
 const l=fromModel({blocks:[{type:'para',cn:'听录音',en:'Listen to the recording',ru:'Прослушайте запись',box:{x:.1,y:.2,w:.8,h:.05}}],kz:{'Прослушайте запись':'Аудионы тыңдаңыз'}},1000,1400);
 const html=render(l);assert.match(html,/data-en="Listen to the recording"/);assert.match(html,/data-kz="Аудионы тыңдаңыз"/);
});
