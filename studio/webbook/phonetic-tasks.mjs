// Empty source leaves keep their ordinal, but missing OCR on a printed page
// must never be accepted as a blank conversion.
export function blankEvidence(grid,lines=[]){
 const credible=lines.filter(l=>{const y=l.box?.y??l.position?.y??.5;return !((l.confidence??1)<.35&&(y<.02||y>.98)&&!/[\p{L}\p{N}]/u.test(l.text||''));});
 const g=grid.hi||grid.raw||grid;let dark=0,count=0;const step=Math.max(1,Math.floor(Math.max(g.W,g.H)/500));
 for(let y=0;y<g.H;y+=step)for(let x=0;x<g.W;x+=step){count++;if(Math.min(...g.at(x,y))<180)dark++;}
 const inkFraction=dark/Math.max(1,count);return{blank:credible.length===0&&inkFraction<.0002,inkFraction,samples:count,ocrLines:credible.length,rawOcrLines:lines.length};
}
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:NaN;};
const plain=s=>String(s).normalize('NFC').replace(/\s+/g,'').toLowerCase();
export function measureNumberedPhonetics(b,source,lines){
 const text=b.py||'',numbers=[...text.matchAll(/[(（]\s*(\d+)\s*[)）]/g)].map(m=>Number(m[1]));
 if(b.type!=='text'||text.includes('___')||numbers.length<3||numbers.some((n,i)=>n!==i+1))return;
 const q=b.box,near=lines.filter(l=>l.box.y>q.y-.015&&l.box.y<q.y+q.h+.015&&l.box.x>q.x-.025&&l.box.x<q.x+q.w+.025);
 const segments=text.split(/[(（]\s*\d+\s*[)）]/).slice(1).map(s=>s.trim().split(/\s+/)),paired=segments.every(s=>s.length===2);
 const cells=near.flatMap(l=>{const m=/^[(（]\s*(\d+)\s*[)）]\s*/.exec(l.text),value=l.text.replace(/^[(（]\s*\d+\s*[)）]\s*/,'').trim();
  if(!/^[\p{Script=Latin}\s]+$/u.test(value)||(!m&&(l.confidence??1)<.9))return[];
  const words=paired?value.split(/\s+/):[value],weights=words.map((word,i)=>word.length+(i===0&&m?m[0].length:0)),total=weights.reduce((a,c)=>a+c,0);return words.map((word,i)=>({number:m&&i===0?Number(m[1]):null,text:word,sourceBox:words.length===1?l.box:{...l.box,x:l.box.x+l.box.w*weights.slice(0,i).reduce((a,c)=>a+c,0)/total,w:l.box.w*weights[i]/total}}));
 }).sort((a,c)=>a.sourceBox.y-c.sourceBox.y||a.sourceBox.x-c.sourceBox.x);
 const found=cells.filter(c=>c.number).map(c=>c.number).sort((a,c)=>a-c);if(found.join(',')!==numbers.join(','))return;
 const rows=[];for(const c of cells){let row=rows.find(r=>Math.abs(median(r.map(t=>t.sourceBox.y+t.sourceBox.h/2))-c.sourceBox.y-c.sourceBox.h/2)<.013);if(!row){row=[];rows.push(row);}row.push(c);}
 rows.sort((a,c)=>a[0].sourceBox.y-c[0].sourceBox.y);
 const result=rows.flatMap((row,r)=>{const y=median(row.map(c=>c.sourceBox.y+c.sourceBox.h/2))-.01;return row.sort((a,c)=>a.sourceBox.x-c.sourceBox.x).map(c=>({...c,row:r,box:{...c.sourceBox,y,h:.02}}));});
 let number=0,member=0;for(const c of result){if(c.number){number=c.number;member=0;}const semantic=paired?segments[number-1]?.[member++]:segments[number-1]?.join(' ');if(semantic&&!/[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(c.text)&&plain(semantic).normalize('NFD').replace(/\p{M}/gu,'')===plain(c.text)){c.ocrText=c.text;c.text=semantic;c.reviewRequired=true;}}
 b.numberedPhonetics=result;b.phoneticSource='OCR tokens matched by exercise number and row';delete b.exactTokens;
}
export function measurePhraseGrid(b,source,lines){
 if(!b.py?.includes('\t')||b.py.includes('___')||b.toneRows||!b.toneAnswers&&!b.py.split(/\s+/).some(t=>/[āáǎàēéěèīíǐìōóǒòūúǔù]/.test(t)))return;
 const q=source?.box||b.box,rows=b.py.split('\n').map(r=>r.split('\t')),near=lines.filter(l=>l.box.y>q.y-.03&&l.box.y<q.y+q.h+.03&&l.box.x>q.x-.03&&l.box.x<q.x+q.w+.06),used=new Set();
 const cells=rows.map(row=>row.map(text=>{const hit=near.find(l=>!used.has(l)&&plain(l.text)===plain(text));if(hit)used.add(hit);return{text,hit};}));
 if(cells.flat().filter(c=>c.hit).length<cells.flat().length*.65)return;
 const X=Array.from({length:Math.max(...rows.map(r=>r.length))},(_,c)=>median(cells.flatMap(row=>row[c]?.hit?[row[c].hit.box.x]:[]))),Y=cells.map(row=>median(row.filter(c=>c.hit).map(c=>c.hit.box.y+c.hit.box.h/2)));
 if([...X,...Y].some(v=>!Number.isFinite(v)))return;
 b.phraseCells=cells.flatMap((row,r)=>row.map((c,k)=>({text:c.text,row:r,column:k,box:{x:X[k],y:Y[r]-.01,w:Math.max(.06,k+1<X.length?X[k+1]-X[k]-.01:.11),h:.02}})));b.box={x:X[0]-.005,y:Y[0]-.016,w:X.at(-1)-X[0]+.13,h:Y.at(-1)-Y[0]+.034};delete b.exactTokens;
}
export function measureSandhiTable(layout,grid){
 for(const b of layout.blocks.filter(b=>b.sandhiTable)){
 const q=layout.source?.blocks.find(o=>o.type==='words'&&o.rows?.some(r=>r.py?.includes('→')))?.box||b.box;
 const g=grid.hi||grid.raw||grid,red=p=>p[0]-p[1]>14&&p[0]-p[2]>14&&p[1]<238,rows=[];
 for(let y=Math.max(0,Math.floor((q.y-.03)*g.H));y<Math.min(g.H,(q.y+q.h+.025)*g.H);y++){const xs=[];for(let x=Math.floor((q.x-.03)*g.W);x<Math.min(g.W,(q.x+q.w+.05)*g.W);x++)if(red(g.at(x,y)))xs.push(x);if(xs.length>q.w*g.W*.55)rows.push({y:y/g.H,x:xs[0]/g.W,end:xs.at(-1)/g.W});}
 const groups=[];for(const row of rows){if(groups.length&&row.y-groups.at(-1).at(-1).y<2/g.H)groups.at(-1).push(row);else groups.push([row]);}
 const header=groups.find(a=>a.length>g.H*.035);if(!header)continue;
 const x=median(header.map(a=>a.x)),right=median(header.map(a=>a.end)),top=header[0].y,end=header.at(-1).y,lines=groups.filter(a=>a[0].y>end+.003).map(a=>median(a.map(p=>p.y)));
 const data=b.rows.filter(r=>r.hz),bottom=lines.length>=data.length?lines[data.length-1]:q.y+q.h;
 b.box={x,y:top,w:right-x,h:bottom-top};b.sandhiHeader=end-top;b.sandhiRows=data;b.sandhiEdges=[end,...(lines.length>=data.length?lines.slice(0,data.length):data.map((_,i)=>end+(bottom-end)*(i+1)/data.length))];delete b.exactTokens;
 }
}
// A horizontal strip of equal matching cards can contain white photographs.
// Align those cards from the intact first frame and the last outer edge, not
// from the dark subject detected inside each photograph.
export function alignMatchingStrip(blocks,source){
 const raw=source?.blocks?.filter(b=>b.type==='image'&&b.matchingInput)||[],photos=blocks.filter(b=>b.type==='image'&&b.matchingInput).sort((a,b)=>a.box.x-b.box.x);
 if(raw.length<3||photos.length!==raw.length||!raw.every(b=>Math.abs(b.box.y-raw[0].box.y)<.008&&Math.abs(b.box.w-raw[0].box.w)<.01&&Math.abs(b.box.h-raw[0].box.h)<.01))return false;
 const first=photos[0],right=photos.at(-1).box.x+photos.at(-1).box.w,pitch=(right-first.box.x-first.box.w)/(photos.length-1);if(pitch<first.box.w||pitch>first.box.w*1.35)return false;
 const q={...first.box};photos.forEach((b,i)=>{b.box={...q,x:q.x+i*pitch};delete b.frame;});return true;
}
