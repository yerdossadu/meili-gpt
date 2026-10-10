// Printed frontmatter and merged tables share OCR baselines and source rules.
import {nativeLines} from './imprint-page.mjs';
const median=a=>a.sort((a,b)=>a-b)[a.length>>1];
const union=a=>{const x=Math.min(...a.map(b=>b.x)),y=Math.min(...a.map(b=>b.y));return{x,y,w:Math.max(...a.map(b=>b.x+b.w))-x,h:Math.max(...a.map(b=>b.y+b.h))-y};};
const dark=p=>Math.max(...p.slice(0,3))<220;
const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'');
// Separate pale paper regions by connected area. A global bounding rectangle
// incorrectly joins distant coloured specks across a white text column.
export function detectTintedPanels(grid){
 const step=2,W=Math.ceil(grid.W/step),H=Math.ceil(grid.H/step),mask=new Uint8Array(W*H),g=grid.hi||grid;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){let hits=0;for(const[dx,dy]of[[0,0],[-1,0],[1,0],[0,-1],[0,1]]){const p=g.at(Math.max(0,Math.min(g.W-1,Math.round((x*step+dx)/grid.W*g.W))),Math.max(0,Math.min(g.H-1,Math.round((y*step+dy)/grid.H*g.H))));if(Math.min(...p.slice(0,3))>155&&Math.max(...p.slice(0,3))>220&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))>15)hits++;}if(hits>=3)mask[y*W+x]=1;}
 const panels=[];for(let i=0;i<mask.length;i++){if(!mask[i])continue;const stack=[i],points=[];mask[i]=0;let x0=W,y0=H,x1=0,y1=0;while(stack.length){const n=stack.pop(),x=n%W,y=Math.floor(n/W);points.push(n);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);for(const[a,b]of[[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(a>=0&&b>=0&&a<W&&b<H&&mask[b*W+a]){mask[b*W+a]=0;stack.push(b*W+a);}}
  if(points.length<W*H*.008||points.length/((x1-x0+1)*(y1-y0+1))<.45)continue;const colors=points.filter((_,j)=>j%5===0).map(n=>g.at(Math.round((n%W)*step/grid.W*g.W),Math.round(Math.floor(n/W)*step/grid.H*g.H)));panels.push({box:{x:x0*step/grid.W,y:y0*step/grid.H,w:(x1-x0+1)*step/grid.W,h:(y1-y0+1)*step/grid.H},color:'#'+[0,1,2].map(k=>median(colors.map(p=>p[k])).toString(16).padStart(2,'0')).join('')});
 }return panels;
}
export function ruleEdges(grid,box,axis,light=false){
 grid=grid.hi||grid;
 const {W,H}=grid,start=Math.round((axis==='x'?box.x:box.y)*(axis==='x'?W:H)),end=Math.round((axis==='x'?box.x+box.w:box.y+box.h)*(axis==='x'?W:H));
 const from=Math.round((axis==='x'?box.y:box.x)*(axis==='x'?H:W)),to=Math.round((axis==='x'?box.y+box.h:box.x+box.w)*(axis==='x'?H:W)),hits=[];
 for(let i=start;i<=end;i++){let count=0,run=0,longest=0;for(let j=from;j<=to;j++){const p=grid.at(axis==='x'?i:j,axis==='x'?j:i),ink=light?Math.min(...p.slice(0,3))>225&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<25:dark(p);if(ink){count++;run++;longest=Math.max(longest,run);}else run=0;}if(count/Math.max(1,to-from+1)>(light?.5:.24)&&longest/Math.max(1,to-from+1)>(light?.3:.13))hits.push(i);}
 const groups=[];for(const n of hits){const g=groups.at(-1);if(g&&n-g.at(-1)<=(light?Math.max(2,Math.round((axis==='x'?grid.W:grid.H)*.005)):2))g.push(n);else groups.push([n]);}
 return groups.map(g=>median(g)/(axis==='x'?W:H));
}

// Short neutral rules beside a printed label are answer slots, not OCR text.
export function detectAnswerRules(grid,label,ocr=[],options={}){
 const g=grid.hi||grid.raw||grid,{W,H}=g,hits=[];
 const ink=(x,y)=>{const p=g.at(x,y);return p&&Math.max(...p.slice(0,3))<205&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<45;};
 for(let y=Math.max(0,Math.floor((label.y+.003)*H));y<Math.min(H,(label.y+label.h+.009)*H);y++){
  let start=-1,last=-1;const emit=()=>{if(start<0)return;const w=(last-start+1)/W;if(w>=(options.minWidth||.025)&&w<=(options.maxWidth||.12)){const q={x:start/W,y:y/H,w};const overlaps=ocr.filter(l=>!/^[\s_—-]*$/.test(l.text)&&q.x<l.box.x+l.box.w&&q.x+q.w>l.box.x&&q.y>=l.box.y&&q.y<=l.box.y+l.box.h);if(options.minCount===1&&overlaps.length&&overlaps.every(l=>l.box.x>q.x+q.w-.04))q.w=Math.min(...overlaps.map(l=>l.box.x))-q.x-.002;else if(overlaps.length){start=-1;return;}if(q.w>=(options.minWidth||.025))hits.push(q);}start=-1;};
  for(let x=Math.ceil((label.x+label.w+.005)*W);x<Math.min(W,.94*W);x++){if(ink(x,y)){if(start<0)start=x;last=x;}else if(start>=0&&x-last>1)emit();}emit();
 }
 const groups=[];for(const h of hits){let r=groups.find(r=>Math.abs(r.x-h.x)<.004&&Math.abs(r.y-h.y)<.004);if(!r){r={...h,count:0};groups.push(r);}r.count++;r.w=Math.max(r.w,h.w);}
 const rows=[];for(const q of groups){let r=rows.find(r=>Math.abs(r[0].y-q.y)<.006);if(!r){r=[];rows.push(r);}r.push(q);}
 if(options.minCount===1)return groups.length?[groups.sort((a,b)=>b.w-a.w)[0]]:[];
 return rows.filter(r=>r.length>=(options.minCount||2)&&Math.max(...r.map(q=>q.w))/Math.min(...r.map(q=>q.w))<1.5).sort((a,b)=>b.length-a.length)[0]?.sort((a,b)=>a.x-b.x)||[];
}


export function detectAudioDisc(grid,track,lines){
 const line=lines.find(l=>String(l.text).replace(/\s/g,'').endsWith(track));if(!line)return null;
 const q=line.box,g=grid.hi||grid.raw||grid,right=q.x+q.w;
 const region={x:right-.074,y:q.y,w:.04,h:q.h};let left=1,top=1,r=0,bottom=0,count=0;
 for(let y=Math.max(0,Math.floor(region.y*g.H));y<Math.min(g.H,(region.y+region.h)*g.H);y++)for(let x=Math.max(0,Math.floor(region.x*g.W));x<Math.min(g.W,(region.x+region.w)*g.W);x++){
  const p=g.at(x,y);if(Math.max(...p.slice(0,3))<215&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<65){count++;left=Math.min(left,x/g.W);top=Math.min(top,y/g.H);r=Math.max(r,x/g.W);bottom=Math.max(bottom,y/g.H);}
 }
 if(count<g.W*g.H*.000025||r-left<.012||bottom-top<.005)return null;
 return{x:Math.max(region.x,left-.002),y:q.y,w:right-Math.max(region.x,left-.002),h:q.h};
}

export function measureDocumentPage(layout,grid,lines){
 const source=layout.source?.blocks||[];if(!source.some(b=>b.documentText||b.type==='table'))return false;
 for(let i=0;i<layout.blocks.length;i++){
  const b=layout.blocks[i],raw=b.documentText?source.find(s=>s.documentText&&(b.documentText.sourceBox?s.documentText.sourceBox&&['x','y','w','h'].every(k=>Math.abs(s.documentText.sourceBox[k]-b.documentText.sourceBox[k])<1e-6):clean(s.cn||s.en)===clean(b.cn||b.en))):b.type==='table'?source.find(s=>s.type==='table'):null;if(!raw)continue;
  if(b.type==='table'){
   b.box={...raw.box};let xs=ruleEdges(grid,b.box,'x'),ys=ruleEdges(grid,b.box,'y');const lx=ruleEdges(grid,b.box,'x',true),ly=ruleEdges(grid,b.box,'y',true),light=lx.length===b.columns+1&&ly.length===b.rowCount+1;
   if(light){xs=lx;ys=ly;}
   // Open outer borders and solid header ribbons are common in contents tables.
   // A ribbon's middle is not a printed rule: replace it by its top/bottom.
   if(!light){const probe=grid.hi||grid,header=[];for(let y=Math.round(b.box.y*probe.H);y<Math.round((b.box.y+Math.min(.07,b.box.h*.2))*probe.H);y++){let colored=0;for(let x=Math.round(b.box.x*probe.W);x<Math.round((b.box.x+b.box.w)*probe.W);x+=3){const p=probe.at(x,y);if(Math.max(...p.slice(0,3))<180&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))>25)colored++;}if(colored>b.box.w*probe.W/3*.55)header.push(y/probe.H);}
    if(header.length>2){const top=header[0],bottom=header.at(-1)+1/probe.H;const candidates=[top,bottom,...ys.filter(y=>y>bottom+.002),b.box.y+b.box.h].filter((y,i,a)=>i===0||y-a[i-1]>.004);if(candidates.length===b.rowCount+1)ys=candidates;}
    if(xs.length===b.columns-1)xs=[b.box.x,...xs,b.box.x+b.box.w];
   }
   b.columnEdges=xs.length===b.columns+1?xs:Array.from({length:b.columns+1},(_,n)=>b.box.x+b.box.w*n/b.columns);
   b.rowEdges=ys.length===b.rowCount+1?ys:Array.from({length:b.rowCount+1},(_,n)=>b.box.y+b.box.h*n/b.rowCount);
   b.tableGeometry={verticalRules:xs.length,horizontalRules:ys.length,verified:xs.length===b.columns+1&&ys.length===b.rowCount+1};
   b.borderColor=light?'#fff':'#888';
   const probe=grid.hi||grid;
   for(const c of b.cells){const colors=[];for(let y=b.rowEdges[c.row]+.001;y<b.rowEdges[c.row+c.rowspan]-.001;y+=.002)for(let x=b.columnEdges[c.col]+.001;x<b.columnEdges[c.col+c.colspan]-.001;x+=.002)colors.push(probe.at(Math.round(x*probe.W),Math.round(y*probe.H)));c.fill=colors.length?'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join(''):'#fff';c.color=parseInt(c.fill.slice(1,3),16)<130?'#fff':'#333';}
   continue;
  }
  if(!raw.documentText)continue;
  const q=raw.documentText.sourceBox||raw.box,pad=raw.documentText.sourceBox?.002:.02,sourceText=clean(raw.cn||raw.en),found=lines.filter(l=>l.box.y>=q.y-pad&&l.box.y+l.box.h<=q.y+q.h+pad&&l.box.x>=q.x-pad&&l.box.x+l.box.w<=q.x+q.w+pad).filter(l=>raw.documentText.sourceBox||sourceText.includes(clean(l.text))||[...clean(l.text)].filter(c=>sourceText.includes(c)).length/clean(l.text).length>.9).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
  const rows=[];for(const l of found){let r=rows.find(r=>Math.abs(r.box.y-l.box.y)<.006);if(!r){r={box:l.box,tokens:[]};rows.push(r);}r.tokens.push(l);r.box=union(r.tokens.map(t=>t.box));}
  rows.forEach(r=>r.text=r.tokens.sort((a,b)=>a.box.x-b.box.x).map(t=>t.text).join(' '));
  const ordered=rows.flatMap(r=>r.tokens.sort((a,b)=>a.box.x-b.box.x));
  // Reviewed source fragments recover OCR omissions without merging the gaps
  // between independently printed exercise words.
  const reviewed=raw.documentText.sourceLines?.filter(l=>l.text&&l.box&&['x','y','w','h'].every(k=>Number.isFinite(l.box[k]))&&l.box.x>=q.x-.003&&l.box.y>=q.y-.003&&l.box.x+l.box.w<=q.x+q.w+.003&&l.box.y+l.box.h<=q.y+q.h+.003);
  const native=reviewed?.length?reviewed:nativeLines(raw.cn||raw.en,ordered.map(l=>({text:l.text,box:l.box})));if(!native?.length){b.unresolvedStructure=true;continue;}
  b.box={...raw.box};delete b.foreword;delete b.imprint;delete b.credits;delete b.exactTokens;
  const measured=reviewed?.length?native:found.length?found:native;
  const explicitFonts=reviewed?.map(l=>l.font).filter(f=>Number.isFinite(f)&&f>0&&f<=30);
  const font=explicitFonts?.length?median(explicitFonts):raw.documentText.vertical?median(measured.map(l=>l.box.w))*100*.86:median(measured.map(l=>l.box.h))*layout.page.height/layout.page.width*100*.86;
  const colors=[];for(let y=Math.floor(q.y*grid.H);y<Math.ceil((q.y+q.h)*grid.H);y++)for(let x=Math.floor(q.x*grid.W);x<Math.ceil((q.x+q.w)*grid.W);x++){const p=(grid.raw||grid).at(x,y);if(Math.max(...p)<180)colors.push(p);}
  const color=colors.length?'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join(''):'#333333';
  if(raw.en) b.en=raw.en;
  b.documentText={sourceBox:q,lines:native,font,color:raw.documentText.color||color,translationColor:raw.documentText.color||'#333',heading:q.h>.03&&clean(raw.cn||raw.en).length<15,bold:raw.documentText.bold||false,sans:raw.documentText.sans||false,...(raw.documentText.audioTrack?{audioTrack:raw.documentText.audioTrack}:{}),...(raw.documentText.studyToken?{studyToken:true}:{}),...(raw.documentText.bilingualChoice?{bilingualChoice:true}:{}),...(raw.documentText.keepOriginal?{keepOriginal:true,translationBox:raw.documentText.translationBox}:{}),...(raw.documentText.choice?{choice:raw.documentText.choice}:{}),...(raw.documentText.vertical?{vertical:true}:{}),...(raw.documentText.cloze?{cloze:raw.documentText.cloze}:{}),...(raw.documentText.vocabulary?{vocabulary:raw.documentText.vocabulary}:{})};
  if(raw.documentText.eraseBackground){const samples=[];for(let y=Math.floor(q.y*grid.H);y<Math.ceil((q.y+q.h)*grid.H);y++)for(let x=Math.floor(q.x*grid.W);x<Math.ceil((q.x+q.w)*grid.W);x++){const p=(grid.raw||grid).at(x,y);if(Math.min(...p)>190)samples.push(p);}if(samples.length)b.documentText.eraseColor='#'+[0,1,2].map(i=>median(samples.map(p=>p[i])).toString(16).padStart(2,'0')).join('');}delete b.unresolvedStructure;
 }
 // OCR often merges the disc label with the preceding heading. Recover the
 // recording number and its nearby printed disc from the original pixels.
 for(const b of layout.blocks)if(/^\d{2}-\d{1,2}$/.test(b.cn||'')){
  const box=detectAudioDisc(grid,b.cn,lines);if(!box)continue;
  b.box=box;b.documentText={...(b.documentText||{}),sourceBox:box,audioTrack:b.cn,font:1.46};
 }
 // Restore answer slots from pixel geometry on any labeled exercise row.
 const fields=[];
 for(const b of layout.blocks){const q=b.documentText?.sourceBox,exercise=/^(?:[（(]\d+[)）].*[,，:：]$|[AB][：:])/.test(b.cn||'');if(!q||q.h>.04||(!/[:：]/.test(b.cn)&&!exercise)||clean(b.cn).length>40||b.documentText.choice||b.documentText.keepOriginal)continue;
  const rules=detectAnswerRules(grid,q,lines,exercise?{minWidth:.15,maxWidth:.65,minCount:1}:{});if(!rules.length)continue;
  b.box.w=Math.max(q.w,rules[0].x-b.box.x-.012);
  rules.forEach((r,i)=>{const box={x:r.x,y:r.y-Math.max(.012,q.h*.85),w:r.w,h:Math.max(.012,q.h*.85)},key='answer-'+Math.round(q.x*10000)+'-'+Math.round(q.y*10000)+'-'+(i+1);fields.push({type:'text',box,cn:'',en:'',ru:'',answerField:key,sourceRule:{x:r.x,y:r.y,w:r.w}});});
 }
 layout.blocks.push(...fields);
 // Fragmented A–D labels must not produce different print sizes in one exercise.
 const choices=layout.blocks.filter(b=>b.documentText?.choice&&b.documentText.font);
 if(choices.length){const font=median(choices.map(b=>b.documentText.font));for(const b of choices)b.documentText.font=font;}
 // Dense horizontal choice rows have no space for a second line beneath the
 // Chinese. Put the translation in the existing gap after each source option.
 const choiceGroups=new Map();for(const b of choices){const key=b.documentText.choice.question;if(!choiceGroups.has(key))choiceGroups.set(key,[]);choiceGroups.get(key).push(b);}
 for(const row of choiceGroups.values())if(row.length>=3&&Math.max(...row.map(b=>b.box.y))-Math.min(...row.map(b=>b.box.y))<.008){
  const y=median(row.map(b=>b.box.y)),next=choices.filter(b=>b.box.y>y+.009).sort((a,b)=>a.box.y-b.box.y)[0];const previous=choices.filter(b=>b.box.y<y-.009).sort((a,b)=>b.box.y-a.box.y)[0],pitch=next?next.box.y-y:previous?y-previous.box.y:1;if(pitch>.028)continue;
  for(const b of row){const q=b.documentText.sourceBox,x=q.x+q.w+.006,right=b.box.x+b.box.w;if(right-x<.035)continue;b.box.h=Math.min(b.box.h,pitch-.001);b.documentText.choiceCaptionBox={x,y:b.box.y,w:right-x,h:b.box.h};}
 }
 const study=layout.blocks.filter(b=>b.documentText?.studyToken);
 const studyRows=[];for(const b of study){let row=studyRows.find(r=>Math.abs(r[0].documentText.sourceBox.y-b.documentText.sourceBox.y)<.006);if(!row){row=[];studyRows.push(row);}row.push(b);}
 for(const row of studyRows){const font=median(row.map(b=>b.documentText.font));for(const b of row)b.documentText.font=font;}
 // A tinted paper panel is measured independently of its printed characters.
 layout.theme.documentPanels=source.filter(b=>b.documentPanel?.box).map(b=>{const q=b.documentPanel.box,p=(grid.hi||grid),colors=[];for(let y=q.y+.002;y<q.y+q.h-.002;y+=.003)for(let x=q.x+.002;x<q.x+q.w-.002;x+=.003)colors.push(p.at(Math.round(x*p.W),Math.round(y*p.H)));return{box:q,color:'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join('')};});
 if(!source.some(b=>b.type==='table')){const panels=detectTintedPanels(grid);if(panels.length){layout.theme.paper='#fff';layout.theme.background=null;layout.theme.documentPanels.push(...panels.filter(p=>!layout.theme.documentPanels.some(e=>p.box.x>=e.box.x-.01&&p.box.y>=e.box.y-.01&&p.box.x+p.box.w<=e.box.x+e.box.w+.01&&p.box.y+p.box.h<=e.box.y+e.box.h+.01)));}}
 const probe=grid.hi||grid,occupied=source.flatMap(b=>[b.documentText?.sourceBox||b.box,...(b.documentPanel?.box?[b.documentPanel.box]:[])]),rules=[];
 for(let y=0;y<probe.H;y+=2){const ny=y/probe.H;if(occupied.some(q=>ny>=q.y-.002&&ny<=q.y+q.h+.002))continue;let count=0,x0=probe.W,x1=0,run=0,longest=0;for(let x=0;x<probe.W;x+=2){if(dark(probe.at(x,y))){count++;x0=Math.min(x0,x);x1=x;run++;longest=Math.max(longest,run);}else run=0;}if(count>probe.W*.12&&(x1-x0)>probe.W*.28){const previous=rules.at(-1);if(previous&&ny-previous.box.y<4/probe.H)continue;rules.push({box:{x:x0/probe.W,y:ny,w:(x1-x0+1)/probe.W,h:1/probe.H},dashed:longest<count*.4});}}
 layout.theme.documentRules=rules;
 return true;
}
