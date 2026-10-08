import test from 'node:test';
import assert from 'node:assert/strict';
import{reconcileAnswerGrid,measureDialogueOptions,clipImagesBeforeText,measureReadingGrid}from'./workbook-drills.mjs';
import{fromModel,render}from'./core.mjs';
import{toneRecordings}from'./tone-audio.mjs';

test('mixed reading rows preserve every cell, recover a missing tone and use source-proven tone corrections',()=>{
 const values=['jī','jí','jǐ','jì','qū','qú','qǔ','qù','jiā','jiǎn','quán','qǐng','xiǎng','xīn'];
 const lines=values.flatMap((text,i)=>i===2?[]:[{text:i===9?'jiàn':text,confidence:.99,box:{x:.1+(i<8?i%4:i-8)*.07,y:.2+Math.floor(i/4)*.04,w:.025,h:.02}}]);
 // The mixed row has its own source baseline, not a new row every four words.
 for(const l of lines.slice(7))l.box.y=.28;
 const b={type:'text',cn:values.join('\n'),box:{x:.08,y:.18,w:.6,h:.15}};
 const result=measureReadingGrid(b,lines);assert.ok(result);
 assert.equal(result.readingTokens.length,14);assert.equal(result.readingTokens[9].text,'jiàn');
 assert.equal(result.readingTokens[2].text,'jǐ');assert.equal(result.readingTokens[2].source,'semantic-cell-measured-column');
 assert.equal(new Set(result.readingTokens.slice(8).map(t=>t.box.y)).size,1);
 const layout={page:{width:1000,height:1400},blocks:[{...b,...result}]};
 assert.ok(toneRecordings(layout).includes('jian4'));assert.ok(!toneRecordings(layout).includes('jian3'));
 const assets=Object.fromEntries(toneRecordings(layout).map(k=>['tone-'+k,k+'.mp3']));
 const html=render(layout,{assets});assert.equal((html.match(/data-tone-key=/g)||[]).length,14);assert.doesNotMatch(html,/disabled/);
});

test('model Kazakh translations survive normalization',()=>{
 const l=fromModel({blocks:[{type:'para',cn:'你好',en:'Hello',ru:'Привет',box:{x:.1,y:.1,w:.8,h:.1}}],kz:{Привет:'Сәлем'}},1000,1400);
 assert.match(render(l),/data-kz="Сәлем"/);
});

test('two parallel tone panels retain all eight columns instead of overwriting equal tones',()=>{
  const l=fromModel({blocks:[{type:'text',box:{x:.1,y:.2,w:.8,h:.2},py:'mō mó mǒ mò lōu lóu lǒu lòu\nfū fú fǔ fù hān hán hǎn hàn\ndī dí dǐ dì pāng páng pǎng pàng'}]},1000,1400);
  assert.equal(l.blocks[0].toneRows.length,3);assert.equal(l.blocks[0].toneRows[0].length,8);
  assert.deepEqual(l.blocks[0].toneRows[0],['mō','mó','mǒ','mò','lōu','lóu','lǒu','lòu']);
});
test('answer grid restores a source-proven missing initial without changing p or b into l',()=>{
  const b={py:'t___ h___ m___ d___ f___\nd___ h___ g___ p___ l___\nk___ f___ n___ b___',gridX:[.1,.2,.3,.4,.5],gridY:[.2,.25,.3]};
  const lines=[{text:'g',confidence:.85,box:{x:.5,y:.24,w:.01,h:.02}},{text:'b',confidence:.99,box:{x:.5,y:.29,w:.01,h:.02}}];
  const grid={W:1000,H:1000,at(x,y){return x>=400&&x<=402&&y>=290&&y<=305?[0,0,0]:[255,255,255];}};
  const r=reconcileAnswerGrid(b,lines,grid),rows=r.py.split('\n').map(r=>r.split('\t'));
  assert.deepEqual(rows[1],['d___','h___','g___','p___','g___']);
  assert.deepEqual(rows[2],['k___','f___','n___','l___','b___']);
});
test('final tone corrections use the source cell and normalize breve to caron',()=>{
  const b={py:'___án ___ĭ\n___à ___ù',gridX:[.2,.4],gridY:[.3,.35]};
  const r=reconcileAnswerGrid(b,[{text:'ān',confidence:.99,box:{x:.2,y:.29,w:.03,h:.02}}]);
  assert.equal(r.py.split('\n')[0],'___ān\t___ǐ');
});
test('matching dialogues remain native translated text and are never guessed as photo captions',()=>{
  const b={type:'para',number:'1',box:{x:.1,y:.8,w:.25,h:.1},dialogueOptions:[{speaker:'A',hz:'谢谢！',py:'Xièxie!'}]};
  const measured=measureDialogueOptions(b,[{text:'Xièxie!',box:{x:.15,y:.81,w:.07,h:.015}},{text:'A：谢谢！',box:{x:.12,y:.83,w:.11,h:.02}}]);
  assert.equal(measured.optionTurns[0].translation.kk,'Рақмет!');
  const html=render({page:{width:900,height:1304},blocks:[{...b,...measured}],kz:{'Спасибо!':'Рақмет!'}});
  assert.match(html,/data-hsk-speak="谢谢！"/);assert.match(html,/data-kz="Рақмет!"/);
});
