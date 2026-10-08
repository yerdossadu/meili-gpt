import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runStructure} from './structure.mjs';

export async function refinePage(root,scan,output){
 await runStructure(root,scan,output);
 const raw=join(output,(await readdir(output)).find(f=>f.endsWith('_res.json')));
 const runner=join(root,'webbook','refine-runner.py');
 const coverage=join(root,'webbook','coverage-check.py');
 const latin=join(root,'webbook','latin-check.py');
 const hash=createHash('sha256').update(await readFile(scan)).update(await readFile(raw)).update(await readFile(runner)).update(await readFile(coverage)).update(await readFile(join(root,'webbook','phonetic-evidence.py'))).update(await readFile(latin)).digest('hex');
 const cacheDir=join(root,'..','.local','refinement-cache');await mkdir(cacheDir,{recursive:true});
 const cache=join(cacheDir,hash+'.json');let result;
 try{result=JSON.parse(await readFile(cache,'utf8'));}catch{}
 if(!result?.quality?.coverageMethod)result=null;
 if(!result){
  for(const args of [[runner,'--input',scan,'--raw',raw,'--output',cache],[latin,'--input',scan,'--result',cache],[coverage,'--input',scan,'--raw',raw,'--result',cache]])await new Promise((resolve,reject)=>{
   const child=spawn(join(root,'..','.local','structure-runtime','Scripts','python.exe'),args,{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});
   let log='';const capture=b=>log=(log+b.toString()).slice(-3000);child.stdout.on('data',capture);child.stderr.on('data',capture);
   const timer=setTimeout(()=>child.kill(),900000);
   child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Повторное распознавание не завершено. '+log));});
  });
  result=JSON.parse(await readFile(cache,'utf8'));
 }
 if(!result.lines?.length||!result.quality)throw new Error('Повторное распознавание не вернуло текст и отчёт.');
 const quoteRunner=join(root,'webbook','quote-recover.py');
 const quoteHash=createHash('sha256').update(JSON.stringify(result)).update(await readFile(quoteRunner)).digest('hex');
 const quoteCache=join(cacheDir,'quotes-'+quoteHash+'.json');
 let recovered;try{recovered=JSON.parse(await readFile(quoteCache,'utf8'));}catch{}
 if(!Array.isArray(recovered?.quoteRecovery)){
  await writeFile(quoteCache,JSON.stringify(result));
  await new Promise((resolve,reject)=>{
   const child=spawn(join(root,'..','.local','structure-runtime','Scripts','python.exe'),[quoteRunner,'--input',scan,'--result',quoteCache],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:['ignore','ignore','pipe']});let log='';child.stderr.on('data',b=>log=(log+b).slice(-2000));const timer=setTimeout(()=>child.kill(),900000);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(log));});
  });recovered=JSON.parse(await readFile(quoteCache,'utf8'));
 }
 result=recovered;
 await writeFile(join(output,'refinement.json'),JSON.stringify(result,null,2));return result;
}
