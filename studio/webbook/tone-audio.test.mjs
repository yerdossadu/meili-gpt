import test from 'node:test';
import assert from 'node:assert/strict';
import {toneKey,toneRecordings} from './tone-audio.mjs';
import {render} from './core.mjs';
test('tone marks select distinct recordings, including decomposed Unicode and umlauts',()=>{
  assert.deepEqual(['ā','á','ǎ','à','ér','ě'.normalize('NFD'),'lǜ'].map(toneKey),['a1','a2','a3','a4','er2','e3','lv4']);
  for(const bad of ['a','er','nǐ hǎo','../../a1','āá'])assert.equal(toneKey(bad),null);
  assert.deepEqual(toneRecordings({blocks:[{toneRows:[['ā','á','','à'],['ā','ér']]}]}),['a1','a2','a4','er2']);
});
test('tone exercise plays exact local audio and never falls back to text synthesis',()=>{
  const layout={page:{width:900,height:1304},blocks:[{type:'text',box:{x:.2,y:.2,w:.6,h:.2},toneRows:[['ā','á','ǎ','à']],gridX:[.3,.4,.5,.6],gridY:[.25]}]};
  const html=render(layout,{assets:{'tone-a1':'assets/a1.mp3','tone-a2':'assets/a2.mp3'}});
  assert.match(html,/data-tone-key="a1" data-src="assets\/a1.mp3"/);
  assert.match(html,/data-tone-key="a2" data-src="assets\/a2.mp3"/);
  assert.match(html,/disabled title="Для этого слога/);
  assert.doesNotMatch(html,/SpeechSynthesisUtterance/);
});
