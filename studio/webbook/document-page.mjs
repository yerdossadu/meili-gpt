// Printed frontmatter and merged tables share OCR baselines and source rules.
import {nativeLines} from './imprint-page.mjs';
const median=a=>a.sort((a,b)=>a-b)[a.length>>1];
const union=a=>{const x=Math.min(...a.map(b=>b.x)),y=Math.min(...a.map(b=>b.y));return{x,y,w:Math.max(...a.map(b=>b.x+b.w))-x,h:Math.max(...a.map(b=>b.y+b.h))-y};};
const dark=p=>Math.max(...p.slice(0,3))<220;
const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'');
export function ruleEdges(grid,box,axis,light=false){
 grid=grid.hi||grid;
 const {W,H}=grid,start=Math.round((axis==='x'?box.x:box.y)*(axis==='x'?W:H)),end=Math.round((axis==='x'?box.x+box.w:box.y+box.h)*(axis==='x'?W:H));
 const from=Math.round((axis==='x'?box.y:box.x)*(axis==='x'?H:W)),to=Math.round((axis==='x'?box.y+box.h:box.x+box.w)*(axis==='x'?H:W)),hits=[];
 for(let i=start;i<=end;i++){let count=0,run=0,longest=0;for(let j=from;j<=to;j++){const p=grid.at(axis==='x'?i:j,axis==='x'?j:i),ink=light?Math.min(...p.slice(0,3))>225&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<25:dark(p);if(ink){count++;run++;longest=Math.max(longest,run);}else run=0;}if(count/Math.max(1,to-from+1)>(light?.5:.24)&&longest/Math.max(1,to-from+1)>(light?.3:.13))hits.push(i);}
 const groups=[];for(const n of hits){const g=groups.at(-1);if(g&&n-g.at(-1)<=(light?Math.max(2,Math.round((axis==='x'?grid.W:grid.H)*.005)):2))g.push(n);else groups.push([n]);}
 return groups.map(g=>median(g)/(axis==='x'?W:H));
}

// Short neutral rules beside a printed label are answer slots, not OCR text.
export function detectAnswerRules(grid,label,ocr=[]){
 const g=grid.hi||grid.raw||grid,{W,H}=g,hits=[];
 const ink=(x,y)=>{const p=g.at(x,y);return p&&Math.max(...p.slice(0,3))<205&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<45;};
 for(let y=Math.max(0,Math.floor((label.y+.003)*H));y<Math.min(H,(label.y+label.h+.009)*H);y++){
  let start=-1,last=-1;const emit=()=>{if(start<0)return;const w=(last-start+1)/W;if(w>=.025&&w<=.12){const q={x:start/W,y:y/H,w};if(!ocr.some(l=>!/^[\s_—-]*$/.test(l.text)&&q.x<l.box.x+l.box.w&&q.x+q.w>l.box.x&&q.y>=l.box.y&&q.y<=l.box.y+l.box.h))hits.push(q);}start=-1;};
  for(let x=Math.ceil((label.x+label.w+.005)*W);x<Math.min(W,.94*W);x++){if(ink(x,y)){if(start<0)start=x;last=x;}else if(start>=0&&x-last>1)emit();}emit();
 }
 const groups=[];for(const h of hits){let r=groups.find(r=>Math.abs(r.x-h.x)<.004&&Math.abs(r.y-h.y)<.004);if(!r){r={...h,count:0};groups.push(r);}r.count++;r.w=Math.max(r.w,h.w);}
 const rows=[];for(const q of groups){let r=rows.find(r=>Math.abs(r[0].y-q.y)<.006);if(!r){r=[];rows.push(r);}r.push(q);}
 return rows.filter(r=>r.length>=2&&Math.max(...r.map(q=>q.w))/Math.min(...r.map(q=>q.w))<1.5).sort((a,b)=>b.length-a.length)[0]?.sort((a,b)=>a.x-b.x)||[];
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
 for(const b of layout.blocks){const q=b.documentText?.sourceBox;if(!q||q.h>.04||!/[:：]/.test(b.cn)||clean(b.cn).length>40||b.documentText.choice||b.documentText.keepOriginal)continue;
  const rules=detectAnswerRules(grid,q,lines);if(!rules.length)continue;
  b.box.w=Math.max(q.w,rules[0].x-b.box.x-.012);
  rules.forEach((r,i)=>{const box={x:r.x,y:r.y-Math.max(.012,q.h*.85),w:r.w,h:Math.max(.012,q.h*.85)},key='answer-'+Math.round(q.y*10000)+'-'+(i+1);fields.push({type:'text',box,cn:'',en:'',ru:'',answerField:key,sourceRule:{x:r.x,y:r.y,w:r.w}});});
 }
 layout.blocks.push(...fields);
 // Fragmented A–D labels must not produce different print sizes in one exercise.
 const choices=layout.blocks.filter(b=>b.documentText?.choice&&b.documentText.font);
 if(choices.length){const font=median(choices.map(b=>b.documentText.font));for(const b of choices)b.documentText.font=font;}
 const study=layout.blocks.filter(b=>b.documentText?.studyToken);
 const studyRows=[];for(const b of study){let row=studyRows.find(r=>Math.abs(r[0].documentText.sourceBox.y-b.documentText.sourceBox.y)<.006);if(!row){row=[];studyRows.push(row);}row.push(b);}
 for(const row of studyRows){const font=median(row.map(b=>b.documentText.font));for(const b of row)b.documentText.font=font;}
 // A tinted paper panel is measured independently of its printed characters.
 const colored=[],rowHits=new Map(),colHits=new Map();for(let y=0;y<grid.H;y+=2)for(let x=0;x<grid.W;x+=2){const p=grid.hi?grid.hi.at(Math.round(x/grid.W*grid.hi.W),Math.round(y/grid.H*grid.hi.H)):grid.at(x,y);if(Math.min(...p.slice(0,3))>185&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))>12){colored.push({x,y,p});rowHits.set(y,(rowHits.get(y)||0)+1);colHits.set(x,(colHits.get(x)||0)+1);}}
 const dense=colored.filter(p=>rowHits.get(p.y)>grid.W*.1&&colHits.get(p.x)>grid.H*.1);
 if(dense.length>grid.W*grid.H*.025&&!source.some(b=>b.type==='table'||b.documentPanel?.box)){let x=grid.W,y=grid.H,right=0,bottom=0;for(const p of dense){x=Math.min(x,p.x);y=Math.min(y,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}layout.theme.paper='#fff';layout.theme.background={box:{x:x/grid.W,y:y/grid.H,w:(right-x+2)/grid.W,h:(bottom-y+2)/grid.H},color:'#'+[0,1,2].map(i=>median(dense.map(p=>p.p[i])).toString(16).padStart(2,'0')).join('')};}
 layout.theme.documentPanels=source.filter(b=>b.documentPanel?.box).map(b=>{const q=b.documentPanel.box,p=(grid.hi||grid),colors=[];for(let y=q.y+.002;y<q.y+q.h-.002;y+=.003)for(let x=q.x+.002;x<q.x+q.w-.002;x+=.003)colors.push(p.at(Math.round(x*p.W),Math.round(y*p.H)));return{box:q,color:'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join('')};});
 const probe=grid.hi||grid,occupied=source.flatMap(b=>[b.documentText?.sourceBox||b.box,...(b.documentPanel?.box?[b.documentPanel.box]:[])]),rules=[];
 for(let y=0;y<probe.H;y+=2){const ny=y/probe.H;if(occupied.some(q=>ny>=q.y-.002&&ny<=q.y+q.h+.002))continue;let count=0,x0=probe.W,x1=0,run=0,longest=0;for(let x=0;x<probe.W;x+=2){if(dark(probe.at(x,y))){count++;x0=Math.min(x0,x);x1=x;run++;longest=Math.max(longest,run);}else run=0;}if(count>probe.W*.12&&(x1-x0)>probe.W*.28){const previous=rules.at(-1);if(previous&&ny-previous.box.y<4/probe.H)continue;rules.push({box:{x:x0/probe.W,y:ny,w:(x1-x0+1)/probe.W,h:1/probe.H},dashed:longest<count*.4});}}
 layout.theme.documentRules=rules;
 return true;
}
