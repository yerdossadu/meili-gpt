import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './core.mjs';

const box = (x, y, w = .18, h = .1) => ({ x, y, w, h });
test('explicit pinyin and Chinese labels in cached photo descriptions become native captions',()=>{
 const l=core.attachInteractiveCaptions({blocks:[{type:'image',box:box(.1,.1),alt:'xièxie 谢谢 (спасибо). Рукопожатие.'}]});
 assert.deepEqual(l.blocks[0].caption,{py:'xièxie',hz:'谢谢',ru:'спасибо'});
 assert.match(core.render({...l,page:{width:1000,height:1400}}),/data-hsk-speak="谢谢"/);
});

test('extracts a printed picture label and makes it a translated speech caption', () => {
  const input = { page: { width: 1000, height: 1400 }, blocks: [
    { type: 'image', box: box(.2, .2), alt: 'Стопка книг.' },
    { type: 'para', box: box(.22, .301, .14, .04), cn: '书', py: 'shū', ru: '' }
  ] };
  const layout = core.attachInteractiveCaptions(input);
  assert.deepEqual(layout.blocks[0].caption, { py: 'shū', hz: '书', ru: 'книга' });
  assert.equal(core.pageVocabulary(layout)[0].trans, 'книга');
  assert.match(core.render(layout), /data-hsk-speak="书"/);
  assert.match(core.render(layout), /class="ru"[^>]*>книга<\/span>/);
});

test('keeps images unpaired when the source is a shuffled matching exercise', () => {
  const layout = core.attachInteractiveCaptions({ blocks: [
    { type: 'para', box: box(.1, .1, .8, .04), cn: '给下面的词语选择对应的图片。', ru: 'Подберите к словам соответствующие картинки.' },
    { type: 'image', box: box(.1, .2), alt: 'Пожилой мужчина.' },
    { type: 'para', box: box(.12, .301, .12, .04), cn: '学生', py: 'xuéshēng', ru: 'ученик' }
  ] });
  assert.equal(layout.blocks[1].caption, undefined);
  assert.deepEqual(core.pageVocabulary(layout).map(item => item.word), ['学生']);
});

test('pairs labels inside the lower part of a scanned picture card without rendering them twice', () => {
  const layout = core.attachInteractiveCaptions({page:{width:1000,height:1400},blocks:[
    {type:'image',box:box(.16,.061,.171,.16),alt:'Кружка'},
    {type:'para',box:box(.219,.169,.123,.043),cn:'杯子',py:'bēizi',en:'Cup',ru:'Чашка'}
  ]});
  assert.equal(layout.blocks[0].caption.hz,'杯子');
  assert.equal(layout.blocks[1].photoCaptionOwner,0);
  assert.equal((core.render(layout).match(/>杯子</g)||[]).length,1);
});

test('uses complete image-card alt text when an early layout stores the label there', () => {
  const layout = core.attachInteractiveCaptions({ blocks: [
    { type: 'image', box: box(.1, .1), alt: 'Карточка: чай (chá, 茶)' }
  ] });
  assert.deepEqual(layout.blocks[0].caption, { py: 'chá', hz: '茶', ru: 'чай' });
  assert.deepEqual(core.pageVocabulary(layout).map(item => item.word), ['茶']);
});

test('excludes initials, finals and tone charts from the page vocabulary', () => {
  const layout = { blocks: [
    { type: 'words', rows: [
      { group: { cn: '声母', en: 'Initials', ru: 'Инициали' } },
      { hz: '八', py: 'bā', ru: '音节' }
    ] },
    { type: 'image', box: box(.1, .1), alt: 'Карточка: кошка (māo, 猫)' }
  ] };
  assert.deepEqual(core.pageVocabulary(layout).map(item => item.word), ['猫']);
});
test('source-aligned poem tokens populate a multilingual dictionary including punctuation-adjacent words',()=>{
 const layout={blocks:[{type:'para',cn:'妈种麻，我放马。\n马吃麻，妈骂马。',py:'Mā zhòng má, wǒ fàng mǎ.\nMǎ chī má, mā mà mǎ.',en:'Mom plants flax.',ru:'Мама сажает лён.'}]};
 const words=core.pageVocabulary(layout);assert.equal(words.length,8);assert.ok(words.every(w=>w.trans_kz&&w.trans_en));assert.ok(words.some(w=>w.word==='麻'&&w.py==='má'));
});
test('listening options retain Arabic numbers in the dictionary',()=>{
 const words=core.pageVocabulary({blocks:[{type:'para',cn:'B 20 个',py:'èrshí gè',ru:'двадцать штук',en:'twenty items',examOption:{hz:'20个'}}]});assert.equal(words[0].word,'20个');assert.equal(words.length,1);
});
