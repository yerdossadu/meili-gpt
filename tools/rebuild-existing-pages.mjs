import {readFile,writeFile,readdir,mkdir,copyFile,cp,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {savedPages} from './page-inventory.mjs';
const root=resolve(import.meta.dirname,'..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),checkpoint=process.argv[2]?resolve(root,process.argv[2]):join(root,'.codex','checkpoints','all-pages-'+stamp);
await mkdir(checkpoint,{recursive:true});
const records=process.argv[2]?JSON.parse(await readFile(join(checkpoint,'results.json'))):[];
if(!process.argv[2])for(const {id,n:ordinal} of await savedPages(root)){const leaf=String(ordinal).padStart(3,'0');
 const n=Number(leaf),dir=join(root,'studio','library',id,'pages',leaf);let before;
 try{before=JSON.parse(await readFile(join(dir,'layout.json')));}catch{continue;}
 const backup=join(checkpoint,id,leaf);await mkdir(backup,{recursive:true});
 for(const f of ['layout.json','model.json','ocr.json','index.html','status.json','published.json'])try{await copyFile(join(dir,f),join(backup,f));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!before.conversionId)try{await cp(join(dir,'assets'),join(backup,'assets'),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 const row={id,n,before:before.conversionId||'legacy',state:'queued'};records.push(row);
 try{const scan=await readFile(join(dir,'scan.png')),model=JSON.parse(await readFile(join(dir,'model.json'))),ocr=JSON.parse(await readFile(join(dir,'ocr.json'))),hash=createHash('sha256').update(scan).digest('hex');
  if(!model.content||model.sourceHash&&model.sourceHash!==hash||ocr.sourceHash&&ocr.sourceHash!==hash)throw new Error('Cached source mismatch; requires fresh recognition.');
  const response=await fetch(`http://127.0.0.1:4180/local/webbook/books/${id}/pages/${n}/convert`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!response.ok)throw new Error('HTTP '+response.status);
 }catch(e){row.state='skipped';row.error=e.message;}
}
const report=join(checkpoint,'results.json');await writeFile(report,JSON.stringify(records,null,2));
console.log(JSON.stringify({checkpoint,pages:records.length,queued:records.filter(r=>r.state==='queued').length}));
let pending=records.filter(r=>r.state==='queued'),last=0;
while(pending.length){for(const row of pending){let job;try{job=await(await fetch(`http://127.0.0.1:4180/local/webbook/books/${row.id}/pages/${row.n}/job`,{signal:AbortSignal.timeout(10000)})).json();}catch{continue;}if(!['done','error'].includes(job.state))continue;row.state=job.state;row.error=job.error;row.validation=job.validation;row.conversionId=job.conversionId;
 if(job.state==='done'){const dir=join(root,'studio','library',row.id,'pages',String(row.n).padStart(3,'0'));const html=await readFile(join(dir,'index.html'),'utf8');row.englishLayers=(html.match(/data-en=/g)||[]).length;row.kazakhLayers=(html.match(/data-kz=/g)||[]).length;}
 }pending=records.filter(r=>r.state==='queued');const finished=records.length-pending.length;if(finished-last>=10||!pending.length){last=finished;await writeFile(report,JSON.stringify(records,null,2));console.log(JSON.stringify({finished,total:records.length,errors:records.filter(r=>r.state==='error').length}));}if(pending.length)await new Promise(r=>setTimeout(r,1500));}
await writeFile(join(root,'.codex','checks','all-pages-latest.json'),JSON.stringify({checkpoint,records},null,2));
console.log('Finished '+report);
if(records.some(r=>r.state==='error'||r.state==='skipped'))process.exitCode=1;
