import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function normalizeStructure(raw, width, height) {
  const data=raw.res||raw, lines=[],seen=new Set();
  function append(ocr, phonetics=false) {
    if(!ocr)return;
    const boxes=ocr.rec_boxes||ocr.rec_polys||[];
    for(let i=0;i<(ocr.rec_texts||[]).length;i++){
      const originalText=String(ocr.rec_texts[i]||'').trim(),box=boxes[i];if(!originalText||!box)continue;
      // Only in an OCR-detected phonetics table: resolve common Latin glyph ambiguity.
      const text=phonetics && /^[|I1]$/.test(originalText)?'l':phonetics&&originalText==='O'?'o':originalText;
      let x,y,x1,y1;
      if(Array.isArray(box[0])) {x=Math.min(...box.map(p=>p[0]));y=Math.min(...box.map(p=>p[1]));x1=Math.max(...box.map(p=>p[0]));y1=Math.max(...box.map(p=>p[1]));}
      else [x,y,x1,y1]=box;
      if(![x,y,x1,y1,width,height].every(Number.isFinite)||width<=0||height<=0||x1<=x||y1<=y)continue;
      const key=`${text}:${Math.round(x)}:${Math.round(y)}`;if(seen.has(key))continue;seen.add(key);
      lines.push({id:lines.length,text,...(text!==originalText?{originalText,normalization:'phonetics-table-glyph-ambiguity'}:{}),confidence:ocr.rec_scores?.[i],position:{x:x/width,y:y/height,width:(x1-x)/width,height:(y1-y)/height}});
    }
  }
  const phoneticTables=(data.table_res_list||[]).filter(t=>/Initials/i.test(t.pred_html||'')&&/Finals/i.test(t.pred_html||''));
  for(const table of data.table_res_list||[])append(table.table_ocr_pred,phoneticTables.includes(table));
  // Table OCR coordinates are global; omit original overlapping boxes after refinement.
  const overall=data.overall_ocr_res;
  if(overall){const filtered={rec_texts:[],rec_boxes:[],rec_scores:[]};for(let i=0;i<(overall.rec_texts||[]).length;i++){
    let box=(overall.rec_boxes||overall.rec_polys||[])[i];if(!box)continue;
    if(Array.isArray(box[0]))box=[Math.min(...box.map(p=>p[0])),Math.min(...box.map(p=>p[1])),Math.max(...box.map(p=>p[0])),Math.max(...box.map(p=>p[1]))];
    if(lines.some(l=>Math.abs(l.position.x*width-box[0])<2&&Math.abs(l.position.y*height-box[1])<2))continue;
    filtered.rec_texts.push(overall.rec_texts[i]);filtered.rec_boxes.push(box);filtered.rec_scores.push(overall.rec_scores?.[i]);
  }append(filtered);}
  if(!lines.length)throw new Error('PP-StructureV3 не вернул текст с координатами.');
  lines.sort((a,b)=>a.position.y-b.position.y||a.position.x-b.position.x);lines.forEach((line,id)=>line.id=id);
  return {engine:'PP-StructureV3',width,height,coordinateSpace:'normalized-0-1',lines,blocks:data.parsing_res_list||[],tables:(data.table_res_list||[]).map(t=>({html:t.pred_html||'',cells:t.cell_box_list||[]}))};
}
export async function runStructure(root, scan, output) {
  const png=await readFile(scan),runner=join(root,'webbook','structure-runner.py');
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const cache=join(root,'..','.local','structure-cache',`${hash(png)}-${hash(await readFile(runner)).slice(0,12)}`);
  let cached=false;try{cached=JSON.parse(await readFile(join(cache,'complete.json'),'utf8')).sourceSha256===hash(png);}catch{}
  await mkdir(cache,{recursive:true});
  const python=join(root,'..','.local','structure-runtime','Scripts','python.exe');
  const args=[runner,'--input',scan,'--output',cache];
  if(!cached)await new Promise((resolve,reject)=>{
    const child=spawn(python,args,{cwd:join(root,'..'),windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';
    const capture=c=>{log=(log+c.toString()).slice(-12000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},900000);
    child.on('error',e=>{clearTimeout(timer);reject(new Error(`PP-StructureV3: ${e.message}`));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(timedOut?'PP-StructureV3 превысил 15 минут.':log.trim().slice(-1500)));else resolve();});
  });
  const files=await readdir(cache),file=files.find(f=>f.endsWith('_res.json'));
  if(!file)throw new Error('PP-StructureV3 не сохранил результат.');
  const raw=JSON.parse(await readFile(join(cache,file),'utf8'));
  // PNG IHDR stores original dimensions, independent of model preprocessing.
  const result=normalizeStructure(raw,png.readUInt32BE(16),png.readUInt32BE(20));
  await writeFile(join(cache,'complete.json'),JSON.stringify({sourceSha256:hash(png)}));
  await cp(cache,output,{recursive:true});return result;
}
