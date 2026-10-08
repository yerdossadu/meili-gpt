import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expansionBands,shiftedTop} from './rebuild-layout.mjs';
test('parallel columns share expansion; downstream table stays together',()=>{
 const bands=expansionBands([{top:10,height:30,required:60},{top:12,height:28,required:45}]);
 assert.equal(bands.length,1);assert.equal(shiftedTop(50,bands),80);
 assert.equal(shiftedTop(80,bands)-shiftedTop(50,bands),30);
 assert.equal(shiftedTop(12,bands),12);
});
test('independent expanded paragraphs accumulate space without compressing originals',()=>{
 const bands=expansionBands([{top:0,height:20,required:35},{top:40,height:20,required:45},{top:80,height:20,required:5}]);
 assert.equal(shiftedTop(100,bands),140);assert.equal(shiftedTop(40,bands),55);
});
