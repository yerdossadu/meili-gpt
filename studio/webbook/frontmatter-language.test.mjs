import test from 'node:test';
import assert from 'node:assert/strict';
import {setLang, render} from './core.mjs';

test('English, Kazakh and original switches preserve Russian text across repeated changes', () => {
  const elements = [
    {textContent:'Русский', dataset:{en:'English',kz:'Қазақша'}},
    {textContent:'ISBN', dataset:{en:'ISBN'}}
  ];
  const page = {dataset:{},querySelectorAll:()=>elements};
  for (const lang of ['en','kz','ru','orig','en','ru']) {
    setLang(page,lang);
    assert.equal(elements[0].textContent,lang==='en'?'English':lang==='kz'?'Қазақша':'Русский');
    assert.equal(elements[1].textContent,'ISBN');
    assert.equal(page.dataset.lang,lang==='orig'?'orig':'ru');
    assert.equal(page.dataset.en,lang==='en'?'on':'off');
  }
});

test('native frontmatter and ordinary bilingual lessons expose English in the translation layer', () => {
  const block={type:'text',cn:'前言',ru:'Предисловие',en:'Preface',box:{x:.1,y:.1,w:.8,h:.1}};
  const layout={page:{width:1000,height:1360},blocks:[{...block,foreword:{font:2,lines:[],heading:true}}]};
  assert.match(render(layout),/data-en="Preface"/);
  assert.match(render({...layout,blocks:[block]}),/data-en="Preface"/);
});
