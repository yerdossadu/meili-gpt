const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'');
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const red=p=>p[0]>130&&p[0]>p[1]*1.25&&p[0]>p[2]*1.2;
const union=a=>{const x=Math.min(...a.map(b=>b.x)),y=Math.min(...a.map(b=>b.y));return{x,y,w:Math.max(...a.map(b=>b.x+b.w))-x,h:Math.max(...a.map(b=>b.y+b.h))-y};};
function redBox(grid,box){const {W,H}=grid;let x0=W,y0=H,x1=0,y1=0,colors=[];
 for(let y=Math.max(0,Math.floor(box.y*H));y<Math.min(H,(box.y+box.h)*H);y++)for(let x=Math.max(0,Math.floor(box.x*W));x<Math.min(W,(box.x+box.w)*W);x++){const p=grid.at(x,y);if(red(p)){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);colors.push(p);}}
 if(!colors.length)return null;return{box:{x:x0/W,y:y0/H,w:(x1-x0+1)/W,h:(y1-y0+1)/H},color:'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join('')};}
export function reconcileCreditNames(blocks,lines){
 const levels=blocks.filter(b=>/^第\d+级/.test(b.cn)),known=new Map();
 const names=b=>{const a=b.cn.split(/[：:]/).slice(1).join(':').trim().split(/\s+/),out=[];for(let i=0;i<a.length;i++){if(a[i].length===1&&a[i+1]?.length===1)out.push(a[i]+a[++i]);else out.push(a[i]);}return out;};
 const list=s=>s?.split(/[：:]/).slice(1).join(':').split(/[,，]/).map(s=>s.trim())||[];
 for(const b of levels){const ns=names(b),ru=list(b.ru),en=list(b.en);ns.forEach((n,i)=>{if(n.length>=2&&ru[i]&&en[i])known.set(n,{ru:ru[i],en:en[i]});});}
 const evidence=b=>lines.filter(l=>l.confidence>=.9&&l.box.y>=b.box.y-.008&&l.box.y<b.box.y+b.box.h+.004).map(l=>clean(l.text)).join('');
 for(const b of levels)for(const old of names(b)){
   const seen=evidence(b);if(seen.includes(old))continue;
   const replacement=[...known.keys()].find(n=>n.length===old.length&&[...n].filter((c,i)=>c!==old[i]).length===1&&seen.includes(n)&&levels.filter(o=>evidence(o).includes(n)).length>=2);
   if(!replacement)continue;const from=known.get(old),to=known.get(replacement);if(!from||!to)continue;
   const correction={oldName:old,newName:replacement,ru:{from:from.ru,to:to.ru},en:{from:from.en,to:to.en},evidence:'repeated-high-confidence-OCR-and-existing-name'};
   b.cn=b.cn.replace(new RegExp([...old].join('\\s*'),'g'),replacement);
   b.ru=b.ru.replaceAll(from.ru,to.ru);b.en=b.en.replaceAll(from.en,to.en);b.nameCorrections=[...(b.nameCorrections||[]),correction];
 }
}
export function measureCreditsPage(layout,grid,lines){
 if(!layout.blocks.some(b=>/编写团队/.test(b.cn))||layout.blocks.filter(b=>/^第\d+级/.test(b.cn)).length<3)return false;
 reconcileCreditNames(layout.blocks,lines);
 for(const b of layout.blocks){
   if(b.type==='folio'){
     const r=redBox(grid,{x:.85,y:.90,w:.15,h:.09});if(r){b.box={...r.box,w:1-r.box.x};b.creditsFolio={color:r.color};}continue;
   }
   if(b.type!=='text')continue;
   const q=b.box,found=lines.filter(l=>l.box.y>=q.y-.006&&l.box.y<q.y+q.h+.003&&l.box.h<.06&&l.text.trim());
   if(!found.length)continue;
   const rows=[];for(const l of found.sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x)){const r=rows.find(r=>Math.abs(r.box.y-l.box.y)<.006);if(r){r.tokens.push(l);r.box=union(r.tokens.map(t=>t.box));}else rows.push({box:l.box,tokens:[l]});}
   const sourceRows=b.cn.split('\n'),native=rows.map((r,i)=>({text:sourceRows[i]||'',box:r.box})).filter(r=>r.text);
   if(native.length!==sourceRows.length)continue;
   const bounds=union(native.map(l=>l.box)),heading=!/[：:]/.test(b.cn),colored=redBox(grid,{x:bounds.x-.008,y:bounds.y-.004,w:bounds.w+.016,h:bounds.h+.008});
   const label=/^([^：:]+[：:])\s*/.exec(native[0].text);
   b.credits={heading,title:/编写团队/.test(b.cn),lines:native,font:median(found.map(l=>l.box.h))*layout.page.height/layout.page.width*100*.84,color:colored?.color||'#dc7777',label:label&&colored?{text:label[1].replace(/\s/g,''),box:colored.box}:null};
   if(b.cn.trim()==='编写组'){b.ru='Авторская группа';b.en='Writing team';b.credits.kk='Авторлар тобы';}
   const center=bounds.x+bounds.w/2;
   b.box=heading?{x:Math.max(.04,center-(b.credits.title?.42:.2)),y:bounds.y,w:b.credits.title?.84:.4,h:Math.max(bounds.h,.04)}:{x:bounds.x,y:bounds.y,w:.88-bounds.x,h:Math.max(bounds.h,.025)};
 }
 const fonts=layout.blocks.filter(b=>b.credits&&!b.credits.heading).map(b=>b.credits.font);if(fonts.length)for(const b of layout.blocks)if(b.credits&&!b.credits.heading)b.credits.font=median([...fonts]);
 return true;
}
