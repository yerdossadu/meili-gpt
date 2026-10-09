// Standard Course covers: source boxes, native selectable text and CSS/SVG fields.
// No book id, page ordinal or hand-measured coordinates participate in recognition.
const hex=p=>'#'+p.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
const delta=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
const median=a=>a.sort((a,b)=>a-b)[a.length>>1];
const clean=p=>p.every(v=>v>250)?[255,255,255]:p;
function inkBounds(line,grid){
 if(/^(HSK|[1-6上下]|[1-6][上下])$/.test(line.text))return line;
 const q=line.box,x0=Math.max(0,Math.floor(q.x*grid.W)),x1=Math.min(grid.W,Math.ceil((q.x+q.w)*grid.W)),y0=Math.max(0,Math.floor(q.y*grid.H)),y1=Math.min(grid.H,Math.ceil((q.y+q.h)*grid.H));
 const base=grid.at(Math.floor((x0+x1)/2),Math.max(0,y0-2)),runs=[];let active=null;
 for(let y=y0;y<y1;y++){let left=x1,right=x0,count=0;for(let x=x0;x<x1;x++)if(delta(grid.at(x,y),base)>35){left=Math.min(left,x);right=Math.max(right,x);count++;}
  if(count>Math.max(1,(x1-x0)*.025)){if(!active||y-active.bottom>2){active={top:y,bottom:y,left,right,count};runs.push(active);}else{active.bottom=y;active.left=Math.min(active.left,left);active.right=Math.max(active.right,right);active.count+=count;}}
 }const r=runs.sort((a,b)=>b.count-a.count)[0];if(!r||r.bottom-r.top<2)return line;
 return {...line,box:{x:r.left/grid.W,y:r.top/grid.H,w:(r.right-r.left+1)/grid.W,h:(r.bottom-r.top+1)/grid.H}};
}
function displayCharacters(line,grid,courseBottom){
 const q=line.box,text=line.text.trim();if(!/^(HSK|[1-6][上下])$/.test(text))return [line];
 const x0=Math.max(0,Math.floor(q.x*grid.W)),x1=Math.min(grid.W,Math.ceil((q.x+q.w)*grid.W));
 const y0=Math.floor(Math.max(q.y,text==='HSK'?courseBottom+.002:q.y)*grid.H),y1=Math.min(grid.H,Math.ceil((q.y+q.h)*grid.H));
 const base=grid.at(Math.max(0,x0-3),Math.min(grid.H-1,Math.floor((y0+y1)/2))),seen=new Set(),components=[];
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const key=y*grid.W+x;if(seen.has(key)||delta(grid.at(x,y),base)<45)continue;
  const todo=[[x,y]];seen.add(key);let left=x,right=x,top=y,bottom=y,count=0;
  while(todo.length){const [xx,yy]=todo.pop();count++;left=Math.min(left,xx);right=Math.max(right,xx);top=Math.min(top,yy);bottom=Math.max(bottom,yy);
   for(const [a,b] of [[xx-1,yy],[xx+1,yy],[xx,yy-1],[xx,yy+1]]){if(a<x0||a>=x1||b<y0||b>=y1)continue;const k=b*grid.W+a;if(seen.has(k)||delta(grid.at(a,b),base)<45)continue;seen.add(k);todo.push([a,b]);}
  }if(count>grid.W*grid.H*.0004)components.push({left,right,top,bottom,count});
 }
 const chosen=components.sort((a,b)=>b.count-a.count).slice(0,text.length).sort((a,b)=>a.left-b.left);
 if(chosen.length!==text.length)return [line];
 return chosen.map((c,i)=>({...line,text:text[i],bold:text==='HSK',box:{x:c.left/grid.W,y:c.top/grid.H,w:(c.right-c.left+1)/grid.W,h:(c.bottom-c.top+1)/grid.H}}));
}
export function measureCoverPage(layout,grid,lines){
 const text=lines.map(l=>l.text).join(' ');
 const hsk=lines.find(l=>/^HSK$/i.test(l.text.trim())&&l.box.h>.12);
 if(!hsk||!(/STANDARD/i.test(text)&&/COURSE/i.test(text))||!text.includes('标准教程'))return false;
 if(layout.blocks.some(b=>!['text','image','decor'].includes(b.type)))return false;
 grid=grid.raw||grid;
 const bands=[];
 // Robust row samples exclude the central display lettering.
 for(let y=0;y<grid.H;y++){
  const samples=[];for(const x of [.01,.04,.08])samples.push(grid.at(Math.floor(x*(grid.W-1)),y));
  const color=clean([0,1,2].map(i=>median(samples.map(p=>p[i])))),last=bands.at(-1);
  if(last&&delta(last.color,color)<8)last.end=y+1;else bands.push({start:y,end:y+1,color});
 }
 // Ignore scan noise and boundaries narrower than 0.5 percent of the page.
 const stable=bands.filter(b=>b.end-b.start>grid.H*.005);
 const fields=stable.map((b,i)=>({box:{x:0,y:(i?b.start:0)/grid.H,w:1,h:((stable[i+1]?.start||grid.H)-(i?b.start:0))/grid.H},color:hex(b.color)}));
 const panels=[];
 // Bottom/right author field is a distinct solid panel, measured independently.
 for(const band of fields){const y=Math.round((band.box.y+band.box.h/2)*grid.H);if(y>=grid.H)continue;
  const color=clean(grid.at(Math.floor(grid.W*.98),y));
  if(delta(color,band.color.slice(1).match(/../g).map(v=>parseInt(v,16)))<30)continue;
  const sampleAt=x=>[0,1,2].map(i=>median([.15,.3,.5,.7,.85].map(f=>grid.at(x,Math.min(grid.H-1,Math.floor((band.box.y+band.box.h*f)*grid.H)))[i])));
  let x=Math.floor(grid.W*.98);while(x>grid.W*.45&&delta(sampleAt(x),color)<30)x--;
  if(x<grid.W*.9)panels.push({box:{x:(x+1)/grid.W,y:band.box.y,w:1-(x+1)/grid.W,h:band.box.h},color:hex(color)});
 }
 const runsAt=y=>{const out=[];let start=0,last=grid.at(0,y);for(let x=1;x<=grid.W;x++){const p=x<grid.W?grid.at(x,y):null;if(!p||delta(p,last)>18){if(x-start>2)out.push({x:start,w:x-start,color:last});start=x;last=p;}}return out.filter(r=>r.color.every(v=>v>200)&&r.w<grid.W*.04);};
 let stripeY=0,pale=[];for(const f of [.9,.99,.97]){const candidate=runsAt(Math.floor(grid.H*f));if(candidate.length>12){stripeY=Math.floor(grid.H*f);pale=candidate;break;}}
 if(pale.length>12){let y=Math.floor((hsk.box.y+hsk.box.h)*grid.H),first=stripeY;for(;y<stripeY;y++){if(runsAt(y).filter(r=>r.x<grid.W*.3).length>=8){first=y;break;}}y=first-1;
  const pitch=median(pale.map(r=>r.w)),a=pale[0],b=pale.find(r=>delta(r.color,a.color)>18);
  if(b)fields.push({box:{x:0,y:(y+1)/grid.H,w:1,h:1-(y+1)/grid.H},color:`repeating-linear-gradient(90deg,${hex(a.color)} 0 ${pitch/grid.W*100}cqw,${hex(b.color)} ${pitch/grid.W*100}cqw ${pitch/grid.W*200}cqw)`});
 }
 layout.coverPage={fields:[...fields,...panels]};layout.theme={paper:'#ffffff',background:null};
 for(const b of layout.blocks.filter(b=>b.type==='text')){
  const original=layout.source?.blocks.find(o=>o.type==='text'&&o.cn===b.cn&&o.en===b.en);if(original)b.box={...original.box};
  const key=s=>String(s||'').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase(),semantic=key(b.cn+' '+b.en);
  const matches=lines.filter(l=>{const q=b.box,c=l.box,k=key(l.text);return k&&semantic.includes(k)&&c.x+c.w/2>=q.x-.01&&c.x+c.w/2<=q.x+q.w+.01&&c.y+c.h/2>=q.y-.01&&c.y+c.h/2<=q.y+q.h+.01;});
  if(!matches.length)continue;
  const courseBottom=Math.max(...lines.filter(l=>/^COURSE$/i.test(l.text.trim())).map(l=>l.box.y+l.box.h));
  b.coverLines=matches.flatMap(l=>displayCharacters(l,grid,courseBottom)).map(l=>inkBounds(l,grid)).map(l=>{
   const q=l.box,colors=[];
   const y=Math.floor((q.y+q.h*.5)*grid.H);const base=grid.at(Math.floor((q.x+q.w*.5)*grid.W),Math.max(0,Math.floor(q.y*grid.H)-2));
   for(let yy=Math.floor(q.y*grid.H);yy<(q.y+q.h)*grid.H;yy+=2)for(let xx=Math.floor(q.x*grid.W);xx<(q.x+q.w)*grid.W;xx+=2){const p=grid.at(xx,yy);if(delta(p,base)>45)colors.push(p);}
   const color=colors.length?hex([0,1,2].map(i=>median(colors.map(p=>p[i])))):delta(base,[255,255,255])>30?'#ffffff':'#222222';
   return {text:l.text,box:{...q},color,bold:l.bold??(q.h>.035&&!/^[1-6上下]$/.test(l.text)||/主编|编者|STANDARD|COURSE|HSK/.test(l.text))};
  });
  b.box={x:Math.min(...matches.map(l=>l.box.x)),y:Math.min(...matches.map(l=>l.box.y)),w:Math.max(...matches.map(l=>l.box.x+l.box.w))-Math.min(...matches.map(l=>l.box.x)),h:Math.max(...matches.map(l=>l.box.y+l.box.h))-Math.min(...matches.map(l=>l.box.y))};
 }
 return true;
}
