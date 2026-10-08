import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStructure} from './structure.mjs';
test('source coordinates survive OCR and table normalization without duplicate text',()=>{
 const ocr={rec_texts:['b','ai'],rec_boxes:[[100,200,120,220],[150,200,180,220]],rec_scores:[.98,.99]};
 const page=normalizeStructure({res:{overall_ocr_res:ocr,table_res_list:[{table_ocr_pred:ocr,pred_html:'<table></table>',cell_box_list:[[100,200,120,220]]}]}},1000,2000);
 assert.equal(page.lines.length,2);assert.deepEqual(page.lines[0].position,{x:.1,y:.1,width:.02,height:.01});assert.equal(page.tables.length,1);
});
test('malformed output fails instead of silently producing image-only success',()=>{assert.throws(()=>normalizeStructure({},1000,2000),/координатами/);});
test('phonetics ambiguity is corrected only in a recognized phonetics table and remains traceable',()=>{
 const ocr={rec_texts:['|','O'],rec_boxes:[[100,200,120,220],[150,200,180,220]]};
 const plain=normalizeStructure({overall_ocr_res:ocr},1000,2000);assert.equal(plain.lines[0].text,'|');
 const page=normalizeStructure({overall_ocr_res:ocr,table_res_list:[{table_ocr_pred:ocr,pred_html:'<td>Initials</td><td>Finals</td>'}]},1000,2000);
 assert.equal(page.lines.length,2);assert.equal(page.lines[0].text,'l');assert.equal(page.lines[0].originalText,'|');assert.equal(page.lines[1].text,'o');
});
