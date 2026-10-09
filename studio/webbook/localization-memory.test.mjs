import test from 'node:test';import assert from 'node:assert/strict';
import {translationMemory,restoreTranslations} from './localization-memory.mjs';
test('translation reuse requires matching source and Russian wording',()=>{
 const memory=translationMemory([{blocks:[{type:'text',en:'Mother',ru:'Мама'}],kz:{Мама:'Ана'}}]);
 const restored=restoreTranslations({blocks:[{en:'Mother',ru:'мама'},{en:'Father',ru:'Мама'}],kz:{}},memory);
 assert.equal(restored.restored,1);assert.equal(restored.layout.kz['мама'],'Ана');assert.equal(restored.layout.kz['Мама'],undefined);
});
test('conflicting cached translations cannot silently decide new page wording',()=>{
 const memory=translationMemory(['Ана','Шеше'].map(kk=>({blocks:[{en:'Mother',ru:'Мама'}],kz:{Мама:kk}})));
 assert.equal(restoreTranslations({blocks:[{en:'Mother',ru:'Мама'}]},memory).restored,0);
});
