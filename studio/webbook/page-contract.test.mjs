import test from 'node:test';
import assert from 'node:assert/strict';
import {localizeLayout,validatePage,validatePageRevision,layoutFromOcr} from './page-contract.mjs';
import {render} from './core.mjs';
const page={width:1000,height:1400};
const block={type:'para',box:{x:.1,y:.2,w:.8,h:.1},cn:'你好',en:'Hello',ru:'Привет'};
test('Kazakh survives Russian wording change when the Chinese/English source is unchanged',()=>{
 const before=localizeLayout({page,blocks:[block],kz:{'Привет':'Сәлем'}},null);
 const after=localizeLayout({page,blocks:[{...block,ru:'Здравствуйте'}]},before);
 assert.equal(after.blocks[0].id,before.blocks[0].id);
 assert.equal(after.blocks[0].translations.ru.kk,'Сәлем');
 assert.equal(after.kz['Здравствуйте'],'Сәлем');
 assert.equal(validatePage(after,{requireKz:true}).state,'passed');
 assert.match(render(after),/data-kz="Сәлем"/);
});
test('a changed source cannot silently reuse the old Kazakh meaning',()=>{
 const before=localizeLayout({page,blocks:[block],kz:{'Привет':'Сәлем'}},null);
 const after=localizeLayout({page,blocks:[{...block,cn:'再见',en:'Goodbye',ru:'До свидания'}]},before);
 assert.equal(validatePage(after,{requireKz:true}).state,'failed');
});
test('block IDs follow content when the blocks are reordered or moved',()=>{
 const other={...block,cn:'谢谢',en:'Thanks',ru:'Спасибо',box:{...block.box,y:.4}};
 const before=localizeLayout({page,blocks:[block,other]},null);
 const after=localizeLayout({page,blocks:[other,{...block,box:{...block.box,y:.25}}]},before);
 assert.equal(after.blocks[1].id,before.blocks[0].id);
});
test('single phonetic symbols are retained as visible text in an unresolved local page',()=>{
 const layout=localizeLayout(layoutFromOcr({width:1000,height:1400,lines:[{text:'ǎ',position:{x:.1,y:.1,width:.03,height:.02}}]}),null);
 assert.match(render(layout),/>ǎ<\/span>/);
 assert.equal(validatePage(layout).state,'review');
 assert.doesNotMatch(render(layout),/<img/);
});
test('invalid geometry and rasterized educational text fail validation',()=>{
 const layout=localizeLayout({page,blocks:[{...block,box:{...block.box,w:-1},rasterizedText:true}]},null);
 assert.equal(validatePage(layout).errors.length,2);
});
test('a legacy partial Kazakh page allows geometry repair but cannot lose an existing translation',()=>{
 const other={...block,cn:'再见',en:'Goodbye',ru:'До свидания',box:{...block.box,y:.4}};
 const before=localizeLayout({page,blocks:[block,other],kz:{'Привет':'Сәлем'}},null);
 const after=localizeLayout({...before,blocks:before.blocks.map(b=>({...b,box:{...b.box,x:.12}}))},before);
 const valid=validatePageRevision(after,before);assert.equal(valid.state,'passed');assert.equal(valid.languageCoverage.kz.missing.length,1);
 delete after.kz['Привет'];delete after.blocks[0].translations.ru.kk;
 assert.equal(validatePageRevision(after,before).state,'failed');
});
