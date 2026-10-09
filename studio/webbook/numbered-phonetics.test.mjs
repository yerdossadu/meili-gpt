import test from 'node:test';
import assert from 'node:assert/strict';
import {measureNumberedPhonetics} from './phonetic-tasks.mjs';
import {render,pageVocabulary} from './core.mjs';
import {toneKey} from './tone-audio.mjs';
test('numbered contrasts use their own OCR cell rather than the most accented homograph',()=>{
 const b={type:'text',box:{x:.1,y:.2,w:.8,h:.15},py:'(1) Sūnzǐ Sūnzǐ (2) dōngxī dōngxī (3) yùnqì yùnqì'};
 const text=['(1) Sūnzǐ','sūnzi','(2) dōngxī','dōngxi','(3) yùnqì','yùnqi'];
 const lines=text.map((text,i)=>({text,confidence:.99,box:{x:.1+i*.13,y:.22+(i%2)*.001,w:.1,h:.02}}));
 measureNumberedPhonetics(b,null,lines);
 assert.deepEqual(b.numberedPhonetics.map(c=>c.text),['Sūnzǐ','sūnzi','dōngxī','dōngxi','yùnqì','yùnqi']);
 assert.equal(new Set(b.numberedPhonetics.map(c=>c.box.y)).size,1);
 assert.match(render({page:{width:1000,height:1400},blocks:[b]}),/hsk-numbered-phonetics/);
});
test('a missing exercise number cannot silently create a complete grid',()=>{
 const b={type:'text',box:{x:.1,y:.2,w:.8,h:.15},py:'(1) pā bā (2) zì cì (3) jǔ qǔ'};
 measureNumberedPhonetics(b,null,[{text:'(1) pā',box:{x:.1,y:.2,w:.1,h:.02}}]);assert.equal(b.numberedPhonetics,undefined);
});
test('a multi-syllable neutral word is not mistaken for an isolated syllable recording',()=>{
 for(const word of ['bāozi','xièxie','piányi','sūnzi','lǎozi'])assert.equal(toneKey(word),null);
 assert.equal(toneKey('qǐng'),'qing3');
});
test('vocabulary preserves distinct printed pronunciations of one Chinese word',()=>{
 const l={blocks:[{type:'text',numberedPhonetics:[{hz:'东西',text:'dōngxī',ru:'восток и запад',en:'east and west'},{hz:'东西',text:'dōngxi',ru:'вещи',en:'things'}]}]};
 assert.equal(pageVocabulary(l).length,2);
});
