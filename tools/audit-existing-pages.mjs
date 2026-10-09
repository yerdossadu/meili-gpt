import {readFile,writeFile,access} from 'node:fs/promises';
import {russianFields,validatePage} from '../studio/webbook/page-contract.mjs';
import {savedPages} from './page-inventory.mjs';
const inventory=await savedPages(),records=[],comparisons=[];
for(const item of inventory){
 const dir=`studio/library/${item.id}/pages/${String(item.n).padStart(3,'0')}`,layout=JSON.parse(await readFile(dir+'/layout.json')),missingKz=[];
 for(const b of layout.blocks||[])for(const f of russianFields(b))if(!b.translations?.[f.path]?.kk&&!layout.kz?.[f.value])missingKz.push(f.value);
 const html=await readFile(dir+'/index.html','utf8'),resources=[...new Set([...html.matchAll(/(?:src|href|data-src)="(\/(?:library|webbook)\/[^"<>]+)"/g)].map(m=>m[1]))],missingResources=[];
 for(const url of resources)try{await access('studio'+decodeURIComponent(url.split(/[?#]/)[0]));}catch{missingResources.push(url);}
 const shot=dir+'/checks/'+layout.conversionId+'/fidelity-render.png';try{await access(shot);comparisons.push({id:item.id,n:item.n,scan:dir+'/scan.png',render:shot});}catch{}
 records.push({...item,conversionId:layout.conversionId,validation:validatePage(layout).state,sourceScanAvailable:true,missingResources,missingKz:[...new Set(missingKz)],englishLayers:(html.match(/data-en=/g)||[]).length,kazakhLayers:(html.match(/data-kz=/g)||[]).length,qualityWarnings:layout.validation?.warnings||[]});
}
const summary={pages:records.length,withMissingResources:records.filter(r=>r.missingResources.length).length,withMissingKz:records.filter(r=>r.missingKz.length).length,withQualityWarnings:records.filter(r=>r.qualityWarnings.length).length,freshComparisonImages:comparisons.length};
await writeFile('.codex/checks/all-pages-quality.json',JSON.stringify({summary,records},null,2));await writeFile('.codex/checks/fresh-comparison-sheets.json',JSON.stringify(comparisons,null,2));console.log(summary);
