import{sourceExamLexicon}from'./source-lexicon.mjs';
// Source-aligned picture tests: never infer which answer is correct.
export function alignExamPictures(layout,lines,grid){
 const images=layout.blocks.filter(b=>b.type==='image'&&!b.caption),source=layout.source?.blocks||[];
 const rows=[];
 for(const b of images){const s=source.find(s=>s.type==='image'&&s.alt===b.alt);if(!s)continue;const row=rows.find(r=>Math.abs(r[0].s.box.y-s.box.y)<.025);if(row)row.push({b,s});else rows.push([{b,s}]);}
 const accepted=rows.filter(r=>r.length===3&&r.every(({s})=>Math.abs(s.box.w-r[0].s.box.w)<.025));
 if(accepted.length<3)return;
 const all=[];
 for(const row of accepted){row.sort((a,b)=>a.s.box.x-b.s.box.x);const labels=[];
  for(let i=0;i<3;i++){const {s}=row[i],cx=s.box.x+s.box.w/2;const found=lines.find(l=>new RegExp('^'+String.fromCharCode(65+i)+'[✓✔√]?$').test(l.text.replace(/\s/g,''))&&Math.abs(l.box.x+l.box.w/2-cx)<.04&&l.box.y>s.box.y+s.box.h-.025&&l.box.y<s.box.y+s.box.h+.05);if(!found)break;labels.push(found);}
  if(labels.length!==3)continue;
  const top=Math.min(...row.map(x=>x.s.box.y)),end=Math.min(...labels.map(l=>l.box.y))-.005;
  row.forEach(({b,s},i)=>all.push({b,box:{...s.box,y:top,h:end-top},choice:{letter:String.fromCharCode(65+i),box:labels[i].box,checked:/[✓✔√]/.test(labels[i].text),group:'picture-'+top.toFixed(3)}}));
 }
 if(all.length<9)return;
 for(const p of all){p.b.box=p.box;delete p.b.frame;p.b.examChoice=p.choice;
  const g=grid&&(grid.hi||grid.raw||grid);if(g){const q=p.b.box,x0=Math.round(q.x*g.W),x1=Math.round((q.x+q.w)*g.W),y0=Math.round(q.y*g.H),y1=Math.round((q.y+q.h)*g.H),grey=p=>Math.max(...p)-Math.min(...p)<18&&p[0]>55&&p[0]<215;let left=x0,right=x1,top=y0,bottom=y1;
   for(let x=x0;x<x1;x++){if(x>x0+g.W*.015&&x<x1-g.W*.015)continue;let n=0;for(let y=y0;y<y1;y+=2)if(grey(g.at(x,y)))n++;if(n>(y1-y0)/2*.75){if(x<x0+g.W*.015)left=Math.max(left,x+2);else right=Math.min(right,x-2);}}
   for(let y=y0;y<y1;y++){if(y>y0+g.H*.012&&y<y1-g.H*.012)continue;let n=0;for(let x=x0;x<x1;x+=2)if(grey(g.at(x,y)))n++;if(n>(x1-x0)/2*.75){if(y<y0+g.H*.012)top=Math.max(top,y+2);else bottom=Math.min(bottom,y-2);}}
   if(right-left>(x1-x0)*.8&&bottom-top>(y1-y0)*.8)p.b.box={x:left/g.W,y:top/g.H,w:(right-left)/g.W,h:(bottom-top)/g.H};
  }}
 const ordered=accepted.filter(r=>r.every(x=>x.b.examChoice)).sort((a,b)=>a[0].b.box.y-b[0].b.box.y);
 const xs=ordered[0].map(({b})=>b.examChoice.box.x+b.examChoice.box.w/2),pitch=(xs[2]-xs[0])/2;
 const first=layout.blocks.find(b=>b.type==='text'&&/^例如/.test(b.cn));const left=first?.box.x||xs[0]-pitch*.85;
 const vertical=[left,xs[0]-pitch/2,(xs[0]+xs[1])/2,(xs[1]+xs[2])/2,xs[2]+pitch/2];
 const horizontal=[ordered[0][0].b.box.y-.006,...ordered.map(r=>Math.max(...r.map(({b})=>b.examChoice.box.y+b.examChoice.box.h))+.008)];
 layout.examGrid={vertical,horizontal};
 // Preserve the narrow source row labels; text fitting must not inflate them.
 for(const b of layout.blocks)if(b.type==='text'&&(/^(?:例如[：:]|[1-9]\.)$/.test(b.cn))){const token=lines.find(l=>l.text.replace(/\s/g,'')===b.cn.replace(/\s/g,''));if(token)b.sourceLabelBox=token.box;}
}

export function alignExamOptions(layout,lines=[]){
 if(!layout.blocks.some(b=>/选择正确回答/.test(b.cn||'')))return;
 for(const b of layout.blocks){const m=/^([ABC])\s*([\p{Script=Han}0-9].*)$/u.exec(b.cn||'');if(b.type==='para'&&m&&b.py){const hz=m[2].replace(/\s/g,''),label=sourceExamLexicon[hz],clean=v=>String(v||'').replace(/[\s\p{P}]/gu,'').toLowerCase();const token=lines.filter(l=>/^[\p{Script=Latin}’'\s]+$/u.test(l.text)&&Math.abs(l.box.y-b.box.y)<.035&&Math.abs(l.box.x+l.box.w/2-b.box.x-b.box.w/2)<b.box.w*.7&&clean(label?.py||b.py).endsWith(clean(l.text))).sort((a,c)=>Math.abs(a.box.y-b.box.y)-Math.abs(c.box.y-b.box.y))[0];b.examOption={letter:m[1],hz,printedPy:token?.text,group:'options-'+Math.round(b.box.y*20)};if(label){b.ru||=label.ru;b.en||=label.en;if(/\d/.test(hz))b.py=label.py;layout.kz||={};layout.kz[b.ru]||=label.kk;}}}
 for(const b of layout.blocks)if(b.type==='text'&&/^\d+\.$/.test(b.cn)){const label=lines.find(l=>l.text.replace(/\s/g,'')===b.cn);if(label){b.sourceLabelBox=label.box;b.box=label.box;}}
 if(!layout.blocks.some(b=>/选择.*图片/.test(b.cn||'')))return;
 for(const b of layout.blocks.filter(b=>b.type==='image'&&!b.caption)){const label=layout.blocks.find(o=>o.type==='text'&&/^[A-D]$/.test(o.cn||'')&&o.box.x<b.box.x&&b.box.x-o.box.x<.15&&Math.abs(o.box.y+b.box.h*.0-b.box.y-b.box.h/2)<.07);if(label)b.examChoice={letter:label.cn,group:'pictures',labelOutside:true};}
}
