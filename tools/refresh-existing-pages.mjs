import {readFile,writeFile} from 'node:fs/promises';
import {savedPages} from './page-inventory.mjs';
const inventory=await savedPages(),results=[];
for(const {id,n} of inventory){
 const prefix=`http://127.0.0.1:4180/local/webbook/books/${id}/pages/${n}`;
 const source=JSON.parse(await readFile(`studio/library/${id}/pages/${String(n).padStart(3,'0')}/layout.json`));
 let result,status;
 if(!source.conversionId){await fetch(prefix+'/convert',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});do{await new Promise(r=>setTimeout(r,1000));result=await(await fetch(prefix+'/job')).json();}while(['queued','running'].includes(result.state));status=result.state==='done'?200:500;}
 else{for(let attempt=0;attempt<3;attempt++){const response=await fetch(prefix+'/refresh',{method:'POST'});status=response.status;result=await response.json();if(status===200||!/(EPERM|EBUSY)/.test(result.error||''))break;await new Promise(r=>setTimeout(r,250*(attempt+1)));}}
 results.push({id,n,status,...result});await writeFile('.codex/checks/all-pages-refreshed.json',JSON.stringify(results,null,2));
 if(results.length%10===0||status!==200)console.log(JSON.stringify({finished:results.length,total:inventory.length,id,n,status,error:result.error}));
}
console.log('Finished '+results.length);if(results.some(r=>r.status!==200))process.exitCode=1;
