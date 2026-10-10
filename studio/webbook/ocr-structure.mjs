// Reusable OCR structure: reading-order paragraphs, glossary rows and choices.
// Translation annotations carry content; all positions come from the source OCR.
export const sourceBox=l=>l.box||{x:l.position.x,y:l.position.y,w:l.position.width,h:l.position.height};
export const boxUnion=lines=>{const qs=lines.map(sourceBox),x=Math.min(...qs.map(q=>q.x)),y=Math.min(...qs.map(q=>q.y));return{x,y,w:Math.max(...qs.map(q=>q.x+q.w))-x,h:Math.max(...qs.map(q=>q.y+q.h))-y};};
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
