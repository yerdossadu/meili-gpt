// Shared identity, localization and validation for every conversion engine.
import { createHash } from 'node:crypto';
import {reviewedKazakh} from './reviewed-kazakh.mjs';
export const digest = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const sourceOf = o => {
  if (Array.isArray(o)) return o.map(sourceOf);
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.entries(o).filter(([k]) => /^(cn|en|hz|py|text|number|type|rows|turns|heading|header|items|caption|group|lines)$/.test(k)).map(([k,v])=>[k,sourceOf(v)]));
};
export function russianFields(block) {
  const fields = [];
  const visit = (o,path='') => {
    if (!o || typeof o !== 'object') return;
    for (const [k,v] of Object.entries(o)) {
      const p = path ? path+'.'+k : k;
      if (typeof v==='string' && /(^|_)ru$/.test(k) && v.trim()) fields.push({path:p,value:v.trim()});
      else if (v && typeof v==='object' && !['printed','box','translations'].includes(k)) visit(v,p);
    }
  };
  visit(block);return fields;
}
export function localizeLayout(layout, before) {
  const old = before?.blocks || [], used = new Set();
  const blocks = layout.blocks.map(b => {
    const sourceHash = digest(sourceOf(b));
    let match = old.find(o=>!used.has(o) && o.id && o.id===b.id);
    match ||= old.filter(o=>!used.has(o)&&o.type===b.type&&digest(sourceOf(o))===sourceHash)
      .sort((a,c)=>Math.abs(a.box.y-b.box.y)+Math.abs(a.box.x-b.box.x)-Math.abs(c.box.y-b.box.y)-Math.abs(c.box.x-b.box.x))[0];
    if(match)used.add(match);
    const id=match?.id || b.id || 'b-'+digest({sourceHash,box:b.box}).slice(0,16);
    const translations={};
    for(const f of russianFields(b)){
      const previous=match?.translations?.[f.path];
      const oldValue=match && russianFields(match).find(x=>x.path===f.path)?.value;
      // Keep a translation across RU wording changes only when the original
      // CN/EN content is identical. A changed source must be translated again.
      const unchanged=match && digest(sourceOf(match))===sourceHash;
      // A source-proven proper-name correction carries the corresponding
      // transliteration into existing KZ text; it cannot change other meaning.
      const corrections=b.nameCorrections||[];
      const priorRu=corrections.reduce((s,c)=>s.replaceAll(c.ru.to,c.ru.from),f.value);
      const correctedKk=corrections.length&&before?.kz?.[priorRu] ? corrections.reduce((s,c)=>s.replaceAll(c.ru.from,c.ru.to),before.kz[priorRu]) : '';
      const heading=/^Текст (\d+)$/.exec(f.value);
      const knownHeading=heading?'Мәтін '+heading[1]:/^Новый курс HSK \d+\s+Рабочая тетрадь$/.test(f.value)?f.value.replace('Новый курс','Жаңа курс').replace('Рабочая тетрадь','Жұмыс дәптері'):'';
      const kk=layout.kz?.[f.value] || (unchanged ? previous?.kk || before?.kz?.[oldValue] : '') || correctedKk || knownHeading || reviewedKazakh.get(f.value);
      translations[f.path]={ru:f.value,...(kk?{kk}:{}),sourceHash};
    }
    return {...b,id,sourceHash,translations};
  });
  const kz={...(before?.kz||{}),...(layout.kz||{})};
  for(const b of blocks)for(const t of Object.values(b.translations))if(t.kk)kz[t.ru]=t.kk;
  return {...layout,blocks,kz};
}
export function validatePage(layout,{requireKz=false}={}) {
  const errors=[],warnings=[];
  if(!layout.page?.width||!layout.page?.height||(!layout.blocks?.length&&!(layout.blankPage&&layout.blankEvidence?.blank&&layout.blankEvidence.ocrLines===0&&layout.blankEvidence.inkFraction<.0002)))errors.push('Нет размеров или содержимого страницы.');
  const ids=new Set();
  for(const b of layout.blocks||[]){
    const r=b.box;
    if(!r||![r.x,r.y,r.w,r.h].every(Number.isFinite)||r.w<=0||r.h<=0||r.x<0||r.y<0||r.x+r.w>1.011||r.y+r.h>1.011)errors.push(`Некорректная рамка ${b.id||b.type}.`);
    if(b.id&&ids.has(b.id))errors.push(`Повторяется ID ${b.id}.`);ids.add(b.id);
    if(b.rasterizedText)errors.push(`Учебный текст превращён в изображение: ${b.id}.`);
    for(const f of russianFields(b))if(requireKz&&!b.translations?.[f.path]?.kk&&!layout.kz?.[f.value])errors.push(`Нет казахского перевода: ${f.value}`);
    if(b.unresolvedStructure)warnings.push(`Требует уточнения структура ${b.id}.`);
  }
  return {state:errors.length?'failed':warnings.length?'review':'passed',errors,warnings};
}
export function localizationCoverage(layout){
 const fields=(layout?.blocks||[]).flatMap(b=>russianFields(b).map(f=>({id:b.id,path:f.path,value:f.value,kk:b.translations?.[f.path]?.kk||layout.kz?.[f.value]||''})));
 return{total:fields.length,translated:fields.filter(f=>f.kk).length,missing:fields.filter(f=>!f.kk).map(({id,path,value})=>({id,path,value}))};
}
export function validatePageRevision(layout,before){
 const oldCoverage=localizationCoverage(before),coverage=localizationCoverage(layout);
 const result=validatePage(layout,{requireKz:oldCoverage.total>0&&oldCoverage.translated===oldCoverage.total});
 // Legacy partial coverage must not block an unrelated geometry repair.
 // Every previously present translation, however, remains mandatory.
 for(const old of before?.blocks||[])for(const field of russianFields(old)){
  const kk=old.translations?.[field.path]?.kk||before.kz?.[field.value];if(!kk)continue;
  const current=layout.blocks.find(b=>b.id===old.id)||layout.blocks.find(b=>russianFields(b).some(f=>f.value===field.value));
  const now=current&&russianFields(current).find(f=>f.path===field.path||f.value===field.value);
  if(!now||!(current.translations?.[field.path]?.kk||layout.kz?.[now.value]))result.errors.push(`Утрачен казахский перевод: ${field.value}`);
 }
 if(result.errors.length)result.state='failed';
 return{...result,languageCoverage:{kz:coverage}};
}

// Local OCR can start a page without a paid Vision answer. Keep each original
// token as visible HTML; never silently turn a table into a screenshot.
export function layoutFromOcr(ocr) {
  const blocks=(ocr.lines||[]).map((l,i)=>({type:'text',box:{x:l.position.x,y:l.position.y,w:l.position.width??l.position.w,h:l.position.height??l.position.h},
    cn:l.text,en:'',ru:'',py:'',size:'m',exactTokens:[{text:l.text,box:{x:l.position.x,y:l.position.y,w:l.position.width??l.position.w,h:l.position.height??l.position.h}}],unresolvedStructure:true}));
  return {version:1,page:{width:ocr.width,height:ocr.height},blocks};
}
