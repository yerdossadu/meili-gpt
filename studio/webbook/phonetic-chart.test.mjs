import test from 'node:test';
import assert from 'node:assert/strict';
import { fromModel, render } from './core.mjs';

const model = {
  blocks: [{
    type: 'words',
    box: { x: 0.11, y: 0.53, w: 0.79, h: 0.2 },
    rows: [
      { group: { cn: '声母\nInitials', en: '韵母\nFinals', ru: '声调\nTones' } },
      { hz: '八', py: 'bā', pos_en: 'b', pos_ru: 'a', en: '–', ru: '' },
      { hz: '拔', py: 'bá', pos_en: 'b', pos_ru: 'a', en: 'ˊ', ru: '' },
      { hz: '把', py: 'bǎ', pos_en: 'b', pos_ru: 'a', en: 'ˇ', ru: '' },
      { hz: '爸', py: 'bà', pos_en: 'b', pos_ru: 'a', en: 'ˋ', ru: '' },
      { hz: '阿', py: 'ā', pos_en: '', pos_ru: 'a', en: '–', ru: '' },
      { hz: '啊', py: 'á', pos_en: '', pos_ru: 'a', en: 'ˊ', ru: '' }
    ]
  }]
};

test('recognizes the initials/finals/tones lesson chart as a five-column web table', () => {
  const layout = fromModel(model, 3912, 5670);
  assert.equal(layout.blocks[0].phoneticChart, true);
  layout.kz = { Инициали: 'Бастапқы дыбыстар' };
  const html = render(layout);
  assert.match(html, /class="hsk-phonetic-table"/);
  assert.match(html, /Initials/);
  assert.match(html, /Example Characters/);
  assert.match(html, /data-kz="Бастапқы дыбыстар"/);
  assert.match(html, /<td class="py"><button[^>]+data-hsk-speak="八"[^>]*>bā<\/button><\/td>/);
  assert.match(html, /<td class="py"><button[^>]+data-hsk-speak="啊"[^>]*>á<\/button><\/td>/);
  assert.equal((html.match(/class="hsk-table-speak"/g)||[]).length,22);
  assert.equal((render(layout,{editable:true}).match(/hsk-table-speak/g)||[]).length,0);
  assert.equal((html.match(/<tr>/g) || []).length, 7);
});

test('versioned HTML cannot be concealed by a legacy full-page scan overlay', () => {
  const layout = fromModel(model, 3912, 5670);
  layout.conversionId = 'visible-html';
  layout.sourceLines = [{text:'scan token',position:{x:0,y:0,width:.1,height:.1}}];
  layout.sourceRegions = [{ru:'legacy overlay',box:{x:0,y:0,w:.1,h:.1}}];
  const html = render(layout,{assets:{sourceScan:'scan.png'}});
  assert.doesNotMatch(html,/hsk-source-page|hsk-source-translated|legacy overlay/);
  assert.match(html,/data-hsk-speak="八"/);
});
