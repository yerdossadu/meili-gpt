// Reusable OCR structure: reading-order paragraphs, glossary rows and choices.
// Translation annotations carry content; all positions come from the source OCR.
export const sourceBox=l=>l.box||{x:l.position.x,y:l.position.y,w:l.position.width,h:l.position.height};
export const boxUnion=lines=>{const qs=lines.map(sourceBox),x=Math.min(...qs.map(q=>q.x)),y=Math.min(...qs.map(q=>q.y));return{x,y,w:Math.max(...qs.map(q=>q.x+q.w))-x,h:Math.max(...qs.map(q=>q.y+q.h))-y};};
export function sourceTableFrame(grid,lines){
 const tinted=sourceTintedTableFrame(grid,lines);if(tinted)return tinted;
 const seed=boxUnion(lines),g=grid.hi||grid,x0=Math.max(0,Math.floor((seed.x-.075)*g.W)),x1=Math.min(g.W-1,Math.ceil((seed.x+seed.w+.075)*g.W)),hits=[];
 for(let y=Math.max(0,Math.floor((seed.y-.025)*g.H));y<Math.min(g.H,(seed.y+seed.h+.025)*g.H);y++){let left=x1,right=x0,count=0;for(let x=x0;x<=x1;x+=2){const p=g.at(x,y),mx=Math.max(...p.slice(0,3)),mn=Math.min(...p.slice(0,3));if(mx<235||(mx-mn>40&&mn<220)){left=Math.min(left,x);right=x;count++;}}if(count>(x1-x0)*.27)hits.push({y,left,right});}
 if(hits.length<2)throw Error('No printed table frame');const groups=[];for(const h of hits){const previous=groups.at(-1);if(previous&&h.y-previous.at(-1).y<=4)previous.push(h);else groups.push([h]);}
 const med=a=>[...a].sort((a,b)=>a-b)[a.length>>1];let left=med(hits.map(h=>h.left)),right=med(hits.map(h=>h.right));
 const edges=groups.flatMap(r=>r.at(-1).y-r[0].y>g.H*.007?[r[0].y/g.H,(r.at(-1).y+2)/g.H]:[med(r.map(h=>h.y))/g.H]);
 // A dark header ribbon gives the true left/right frame. Stray side labels
 // must not widen a two-column table into the neighbouring heading.
 if(edges.length>=3){const top=Math.ceil((edges[0]+.0005)*g.H),bottom=Math.floor((edges[1]-.0005)*g.H),runs=[];let start=-1,last=-1;for(let x=x0;x<x1;x++){let ink=0,total=0;for(let y=top;y<bottom;y+=3){const p=g.at(x,y);total++;if(Math.min(...p)<180&&Math.max(...p)-Math.min(...p)>25)ink++;}if(total&&ink/total>.15){if(start<0)start=x;last=x;}else if(start>=0&&x-last>g.W*.004){runs.push([start,last]);start=-1;}}if(start>=0)runs.push([start,last]);const best=runs.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0];if(best&&best[1]-best[0]>g.W*.35){left=best[0];right=best[1];}}
 const green=[];for(let y=Math.floor(edges[0]*g.H);y<edges.at(-1)*g.H;y+=3)for(let x=left-Math.ceil(g.W*.012);x<left+Math.ceil(g.W*.012);x+=2){if(x<0)continue;const p=g.at(x,y);if(Math.min(...p)>200&&p[1]>p[0]+3&&p[1]>p[2]+5)green.push(p);}
 return{box:{x:left/g.W,y:edges[0],w:(right-left+2)/g.W,h:edges.at(-1)-edges[0]},rowEdges:edges,...(green.length>20?{frameColor:'#'+[0,1,2].map(i=>med(green.map(p=>p[i])).toString(16).padStart(2,'0')).join('')}: {})};
}
// Pale multi-column exercise tables have white separators, not dark rules.
// Measure continuous coloured rows first so printed letters cannot become rows.
export function sourceTintedTableFrame(grid,lines){
 const q=boxUnion(lines),g=grid.hi||grid,x0=Math.max(0,Math.floor((q.x-.04)*g.W)),x1=Math.min(g.W-1,Math.ceil((q.x+q.w+.14)*g.W)),rows=[];
 for(let y=Math.max(0,Math.floor((q.y-.015)*g.H));y<Math.min(g.H,(q.y+q.h+.02)*g.H);y++){let left=x1,right=x0,n=0;for(let x=x0;x<x1;x+=2){const p=g.at(x,y);if(Math.min(...p)>150&&Math.max(...p)>220&&Math.max(...p)-Math.min(...p)>18){left=Math.min(left,x);right=x;n++;}}if(n>(x1-x0)*.32)rows.push({y,left,right});}
 if(!rows.length)return null;const groups=[];for(const r of rows){const a=groups.at(-1);if(a&&r.y-a.at(-1).y<=2)a.push(r);else groups.push([r]);}
 const large=groups.filter(a=>a.length>g.H*.015);if(large.length<3||large.length>12)return null;
 const med=a=>a.sort((a,b)=>a-b)[a.length>>1],left=med(rows.map(r=>r.left)),right=med(rows.map(r=>r.right));
 const edges=[large[0][0].y/g.H,...large.slice(1).map((a,i)=>(large[i].at(-1).y+a[0].y)/2/g.H),(large.at(-1).at(-1).y+1)/g.H];return{box:{x:left/g.W,y:edges[0],w:(right-left+2)/g.W,h:edges.at(-1)-edges[0]},rowEdges:edges,whiteRules:true};
}
// Refine a separator suggested by OCR column anchors against the printed ink.
// Searching only the inter-column gap avoids interpreting character stems as rules.
export function sourceColumnRule(grid,frame,anchor,radius=.018){
 const g=grid.hi||grid,top=Math.ceil(frame.box.y*g.H),bottom=Math.floor((frame.box.y+frame.box.h)*g.H);let best={score:-1,x:anchor};
 const white=x=>{let n=0;for(let y=top;y<=bottom;y++){const p=g.at(x,y);if(Math.min(...p)>235&&Math.max(...p)-Math.min(...p)<18)n++;}return n/(bottom-top+1);};
 const pale=[];for(let x=Math.max(3,Math.floor((anchor-.035)*g.W));x<Math.min(g.W-4,(anchor+.035)*g.W);x++){const score=white(x);if(score>.65&&white(x-Math.ceil(g.W*.008))<.55&&white(x+Math.ceil(g.W*.008))<.55)pale.push(x);}if(pale.length)return pale[pale.length>>1]/g.W;
 for(let x=Math.max(0,Math.floor((anchor-radius)*g.W));x<Math.min(g.W,(anchor+radius)*g.W);x++){let hits=0;for(let y=top;y<=bottom;y++){const p=g.at(x,y);if(Math.min(...p.slice(0,3))<240)hits++;}const score=hits/(bottom-top+1)-Math.abs(x/g.W-anchor)*.2;if(score>best.score)best={score,x:x/g.W};}return best.x;
}
// Find a standalone photograph in the unoccupied column beside a paragraph.
// The caller supplies OCR-derived free space, never a hand-cut bitmap.
export function sourcePhotoBox(grid,region){const g=grid.hi||grid,hits=[];for(let y=Math.floor(region.y*g.H);y<(region.y+region.h)*g.H;y++){let left=g.W,right=0,n=0;for(let x=Math.floor(region.x*g.W);x<(region.x+region.w)*g.W;x+=2){const p=g.at(x,y);if(Math.min(...p)<190&&Math.max(...p)-Math.min(...p)>25){n++;left=Math.min(left,x);right=x;}}if(n>region.w*g.W*.15)hits.push({y,left,right});}if(hits.length<g.H*.025)return null;const med=a=>a.sort((a,b)=>a-b)[a.length>>1],x=med(hits.map(h=>h.left)),right=med(hits.map(h=>h.right));return{x:x/g.W,y:hits[0].y/g.H,w:(right-x+2)/g.W,h:(hits.at(-1).y-hits[0].y+1)/g.H};}
export function sourceExerciseBadge(grid,label){const g=grid.hi||grid,points=[];for(let y=Math.max(0,Math.floor((label.y-.003)*g.H));y<Math.min(g.H,(label.y+label.h+.004)*g.H);y++)for(let x=Math.max(0,Math.floor((label.x-.035)*g.W));x<(label.x-.005)*g.W;x++){const p=g.at(x,y);if(Math.min(...p)<220&&Math.max(...p)-Math.min(...p)>13)points.push({x,y,p});}if(points.length<g.W*g.H*.000025)return null;const med=a=>a.sort((a,b)=>a-b)[a.length>>1],x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y)),r=Math.max(...points.map(p=>p.x)),b=Math.max(...points.map(p=>p.y));return{box:{x:x/g.W,y:y/g.H,w:(r-x+1)/g.W,h:(b-y+1)/g.H},fill:'#'+[0,1,2].map(i=>med(points.map(p=>p.p[i])).toString(16).padStart(2,'0')).join('')};}
export function sourceTableAnchors(lines,columns,cells){
 const center=l=>sourceBox(l).x+sourceBox(l).w/2;
 if(columns===2){const marks=lines.filter(l=>l.text==='+');if(marks.length)return[marks.map(center).sort((a,b)=>a-b)[marks.length>>1]];}
 if(columns===3&&!(cells.find(c=>c.row===0&&c.col===0)?.cn||'')){
  const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'');
  const headers=[1,2].map(col=>{const c=cells.find(c=>c.row===0&&c.col===col);return c?.cn?lines.filter(l=>clean(l.text)===clean(c.cn)).sort((a,b)=>sourceBox(a).y-sourceBox(b).y)[0]:null;});
  if(headers.every(Boolean)){const[a,b]=headers.map(center);if(b>a&&Math.abs(sourceBox(headers[0]).y-sourceBox(headers[1]).y)<.015)return[a-(b-a)/2,(a+b)/2];}
 }return null;
}
export function paragraphGroups(lines){
 const ordered=[...lines].sort((a,b)=>sourceBox(a).y-sourceBox(b).y),left=Math.min(...ordered.map(l=>sourceBox(l).x)),groups=[];
 for(const l of ordered){const prev=groups.at(-1),q=sourceBox(l);if(!prev||q.x>left+.025||q.y>sourceBox(prev.at(-1)).y+sourceBox(prev.at(-1)).h+.025)groups.push([l]);else prev.push(l);}return groups;
}
export function translatedSourceBlock(lines,translation,{cn,extraHeight=0,width,options={}}={}){
 const q=boxUnion(lines),text=cn||lines.map(l=>l.text).join('');return{type:'text',box:{...q,w:width||q.w,h:q.h+extraHeight},cn:text,en:translation.en,ru:translation.ru,documentText:{sourceBox:q,...(lines.every(l=>l.box&&!l.position)?{sourceLines:lines}:{}),...options}};
}
const label=/^\s*(\d+)\s*[.．]\s*A\s*/;
const letter=/^\s*(?:\d+\s*[.．]\s*)?([ABCD])\s*/;
export function sourceChoices(lines){
 const anchors=lines.filter(l=>label.test(l.text)),groups=[];
 if(!anchors.length){
  const rows=[];for(const l of [...lines].sort((a,b)=>sourceBox(a).y-sourceBox(b).y||sourceBox(a).x-sourceBox(b).x)){let row=rows.find(r=>Math.abs(sourceBox(r[0]).y-sourceBox(l).y)<.007);if(!row){row=[];rows.push(row);}row.push(l);}
  let question=null;for(const row of rows){row.sort((a,b)=>sourceBox(a).x-sourceBox(b).x);const header=row.find(l=>/^\s*\d+[.．]\s*(?![ABCD])/.test(l.text));if(header){question=Number(/^\s*(\d+)/.exec(header.text)[1]);continue;}if(!question)continue;let part=null;for(const l of row){const m=letter.exec(l.text);if(m){part={question,letter:m[1],lines:[l],hz:l.text.slice(m[0].length)};groups.push(part);}else if(part){part.lines.push(l);part.hz+=l.text;}}
  }return groups.sort((a,b)=>a.question-b.question||a.letter.localeCompare(b.letter));
 }
 const horizontal=anchors.some(a=>lines.filter(l=>letter.test(l.text)&&Math.abs(sourceBox(l).y-sourceBox(a).y)<.007).length>=3);
 if(horizontal){for(const anchor of anchors){const row=lines.filter(l=>Math.abs(sourceBox(l).y-sourceBox(anchor).y)<.007).sort((a,b)=>sourceBox(a).x-sourceBox(b).x),question=Number(label.exec(anchor.text)[1]);let parts=[];for(const l of row){if(letter.test(l.text)){const m=letter.exec(l.text);parts.push({question,letter:m[1],lines:[l],hz:l.text.slice(m[0].length)});}else if(parts.length){parts.at(-1).lines.push(l);parts.at(-1).hz+=l.text;}}groups.push(...parts);}}
 else{const xs=[...new Set(anchors.map(l=>Math.round(sourceBox(l).x*10)/10))].sort((a,b)=>a-b),mid=xs.length>1?(xs[0]+xs.at(-1))/2:1;
  for(const column of [lines.filter(l=>sourceBox(l).x<mid),lines.filter(l=>sourceBox(l).x>=mid)]){const rows=[];for(const l of [...column].sort((a,b)=>sourceBox(a).y-sourceBox(b).y)){let row=rows.find(r=>Math.abs(sourceBox(r[0]).y-sourceBox(l).y)<.007);if(!row){row=[];rows.push(row);}row.push(l);}let question=null;for(const row of rows){row.sort((a,b)=>sourceBox(a).x-sourceBox(b).x);const start=row.find(l=>letter.test(l.text));if(!start)continue;const a=label.exec(start.text);if(a)question=Number(a[1]);if(!question)continue;const m=letter.exec(start.text);const selected=row.filter(l=>sourceBox(l).x>=sourceBox(start).x&&!/^[一_—-]$/.test(l.text));groups.push({question,letter:m[1],lines:selected,hz:selected.map(l=>l===start?l.text.slice(m[0].length):l.text).join('')});}}
 }
 return groups.sort((a,b)=>a.question-b.question||a.letter.localeCompare(b.letter));
}
const numbered=/^\s*\*?\s*(\d+)\s*[.．]\s*([\p{Script=Han}]+)/u;
const weighted=s=>[...s].reduce((n,c)=>n+(/[\p{Script=Han}]/u.test(c)?1:/[ilI'.,:;\s]/.test(c)?.27:/[mwMW]/.test(c)?.85:.53),0);
export function splitSourceLine(line,texts){const q=sourceBox(line),total=texts.reduce((n,s)=>n+weighted(s),0);const gap=Math.min(.006,q.w/(texts.length*12)),usable=q.w-gap*(texts.length-1);let x=q.x;return texts.map(text=>{const w=usable*weighted(text)/total,part={text,box:{...q,x,w}};x+=w+gap;return part;});}
// Separated word-bank items have real wide whitespace. Recover those gaps
// from ink projection before falling back to character-weighted splitting.
export function splitSourceWords(grid,line,texts){const q=sourceBox(line),g=grid.hi||grid,runs=[];let start=-1,last=-1;for(let x=Math.floor(q.x*g.W);x<Math.ceil((q.x+q.w)*g.W);x++){let ink=0;for(let y=Math.floor(q.y*g.H);y<(q.y+q.h)*g.H;y++){const p=g.at(x,y);if(Math.max(...p)<210)ink++;}if(ink>=2){if(start<0)start=x;last=x;}else if(start>=0&&x-last>g.W*.009){runs.push([start,last]);start=-1;}}if(start>=0)runs.push([start,last]);return runs.length===texts.length?texts.map((text,i)=>({text,box:{...q,x:runs[i][0]/g.W,w:(runs[i][1]-runs[i][0]+1)/g.W}})):splitSourceLine(line,texts);}
export function glossaryRows(lines,lexicon){
 const starts=lines.filter(l=>numbered.test(l.text)).sort((a,b)=>sourceBox(a).y-sourceBox(b).y),rows=[];
 for(let i=0;i<starts.length;i++){
  const l=starts[i],match=numbered.exec(l.text),term=lexicon.find(t=>t.hz===match[2]);if(!term)throw Error('No glossary translation: '+match[2]);
  const q=sourceBox(l),next=starts[i+1],baseline=q.y+q.h/2,end=next?sourceBox(next).y+sourceBox(next).h/2-.006:q.y+.07;
  const own=lines.filter(o=>sourceBox(o).x>=q.x-.003&&sourceBox(o).y+sourceBox(o).h/2>=baseline-.007&&sourceBox(o).y+sourceBox(o).h/2<end).sort((a,b)=>sourceBox(a).y-sourceBox(b).y||sourceBox(a).x-sourceBox(b).x);
  const native=[],definitions=[];
  for(const o of own){const oq=sourceBox(o),m=numbered.exec(o.text),hzPrefix=m?m[0]:'',rest=m?o.text.slice(m[0].length).trim():o.text;
   if(m){const only=rest.length===0;native.push({text:hzPrefix,box:{...oq,w:only?oq.w:oq.w*weighted(hzPrefix)/weighted(o.text)},color:'#9b702b'});if(only)continue;}
   let tail=rest,prefix='';const pos=/\b(?:v\.?\/adj\.?|adv\.?|adj\.?|n\.?|v\.?|m\.?)\s*[.]/i.exec(tail);
   if(pos){prefix=tail.slice(0,pos.index).trim();tail=tail.slice(pos.index);}else{const py=term.py.replace(/\s/g,'').toLowerCase(),raw=tail.replace(/\s/g,'').toLowerCase();if(raw.startsWith(py)){let chars=0,end=0;for(;end<tail.length&&chars<py.length;end++)if(!/\s/.test(tail[end]))chars++;prefix=tail.slice(0,end).trim();tail=tail.slice(end).trim();}else if(/^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü'\s]+$/i.test(tail)&&own.indexOf(o)<=1){prefix=tail;tail='';}}
   const used=weighted(hzPrefix)+(hzPrefix?1:0),whole=weighted(o.text),start=oq.x+oq.w*used/whole,w=oq.x+oq.w-start;
   if(prefix){const split=tail?weighted(prefix)/(weighted(prefix)+weighted(tail)+1):1;if(!native.some(l=>l.text===term.py))native.push({text:term.py,box:{x:start,y:oq.y,w:w*split,h:oq.h},sans:true,color:'#333333'});if(tail)definitions.push({text:tail,box:{x:start+w*split+Math.max(w*.025,.006),y:oq.y,w:w*(1-split)-Math.max(w*.025,.006),h:oq.h},translationSource:true});}
   else if(tail)definitions.push({text:tail,box:oq,translationSource:true});
  }
  if(!definitions.length)throw Error('No source meaning for '+term.hz);
  const source=boxUnion(own),meaning=boxUnion(definitions.map(d=>({box:d.box}))),originalMeaning=definitions.map(d=>d.text).join(' ');
  rows.push({type:'text',box:source,cn:term.hz,en:originalMeaning,ru:term.ru,documentText:{sourceBox:source,color:'#333333',keepOriginal:true,sourceLines:[...native,...definitions],translationBox:meaning,vocabulary:[term]}});
 }
 return rows;
}
