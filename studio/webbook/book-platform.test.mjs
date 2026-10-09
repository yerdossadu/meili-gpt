import test from 'node:test';import assert from 'node:assert/strict';
import {inferBookPlatform} from './book-platform.mjs';
test('uploaded HSK5 textbook and workbook retain course and material identity',()=>{
 assert.deepEqual(inferBookPlatform({id:'a',name:'HSK5上'}),{level:'HSK 5',section:'HSK 5',slug:'hsk5-upper'});
 assert.equal(inferBookPlatform({id:'b',name:'HSK_5 workbook 1'}).slug,'hsk5-workbook');
 assert.equal(inferBookPlatform({id:'c',name:'unknown'}).level,'');
 assert.equal(inferBookPlatform({name:'HSK5上',platform:{slug:'custom'}}).slug,'custom');
});
