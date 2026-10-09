import {readdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
export async function savedPages(root=resolve(import.meta.dirname,'..')){
 const library=join(root,'studio','library'),result=[];
 for(const entry of await readdir(library,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const id=entry.name;try{await access(join(library,id,'book.json'));}catch{continue;}
  let leaves;try{leaves=await readdir(join(library,id,'pages'));}catch{continue;}
  for(const leaf of leaves){if(!/^\d+$/.test(leaf))continue;try{await access(join(library,id,'pages',leaf,'layout.json'));}catch{continue;}
   result.push({id,n:Number(leaf),url:`http://127.0.0.1:4180/library/${id}/pages/${leaf}/index.html`});
  }
 }
 return result.sort((a,b)=>a.id.localeCompare(b.id)||a.n-b.n);
}
