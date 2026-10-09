import {russianFields} from './page-contract.mjs';
const normalize=s=>String(s||'').normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
const identity=(block,path)=>{const keys=path.split('.');let parent=block;for(const k of keys.slice(0,-1))parent=parent?.[k];const key=keys.at(-1),source=parent?.[key.replace(/ru$/,'en')]||parent?.hz||parent?.cn;return source?normalize(source):'';};
export function translationMemory(layouts){
 const values=new Map();
 for(const layout of layouts)for(const block of layout.blocks||[])for(const f of russianFields(block)){
  const source=identity(block,f.path),kk=block.translations?.[f.path]?.kk||layout.kz?.[f.value];if(!source||!kk)continue;
  const key=source+'\n'+normalize(f.value);if(!values.has(key))values.set(key,new Set());values.get(key).add(kk);
 }
 return new Map([...values].filter(([,v])=>v.size===1).map(([key,v])=>[key,[...v][0]]));
}
export function restoreTranslations(layout,memory){
 const kz={...layout.kz};let restored=0;
 for(const block of layout.blocks||[])for(const f of russianFields(block)){
  if(block.translations?.[f.path]?.kk||kz[f.value])continue;
  const source=identity(block,f.path),kk=memory.get(source+'\n'+normalize(f.value));if(kk){kz[f.value]=kk;restored++;}
 }
 return{layout:{...layout,kz},restored};
}
