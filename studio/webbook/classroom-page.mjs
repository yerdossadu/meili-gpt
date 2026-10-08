// Source-measured bilingual phrase lists; no page number or fixed row pitch.
import {measurePinkPaper} from './foreword-page.mjs';
const han=s=>String(s||'').replace(/[^\p{Script=Han}]/gu,'');
const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
const union=a=>{const x=Math.min(...a.map(b=>b.x)),y=Math.min(...a.map(b=>b.y));return{x,y,w:Math.max(...a.map(b=>b.x+b.w))-x,h:Math.max(...a.map(b=>b.y+b.h))-y}};
export function measureClassroomPage(layout,grid,lines){
 if(!layout.blocks.some(b=>b.cn==='课堂用语')||layout.blocks.filter(b=>b.py&&b.number).length<4)return false;
 measurePinkPaper(layout,grid);
 for(const b of layout.blocks){
  if(!b.cn||!b.en)continue;
  const q=(layout.source?.blocks||[]).find(o=>o.cn===b.cn&&String(o.number||'')===String(b.number||''))?.box||b.box,near=lines.filter(l=>l.box.x>=q.x-.015&&l.box.x<q.x+q.w+.025&&l.box.y>q.y-.006&&l.box.y<q.y+q.h+.012);
  const chinese=near.filter(l=>han(l.text)===han(b.cn));
  if(!chinese.length)continue;
  const cn=chinese.map(l=>({text:b.number?b.number+'. '+b.cn:b.cn,box:l.box}));
  const en=near.filter(l=>!han(l.text)&&l.box.y>chinese[0].box.y&&clean(l.text).length>=4&&clean(b.en).includes(clean(l.text)));
  if(!en.length)continue;
  const py=b.py?near.filter(l=>!han(l.text)&&l.box.y<chinese[0].box.y&&/[a-z]/i.test(l.text)):[];
  const enBox=union(en.map(l=>l.box)),bounds=union([...cn,...en,...py].map(l=>l.box));
  // Translation uses the source English area, with spare column width and row height.
  const tr={...enBox,w:b.number?Math.min(.36,(q.x<.4?.48:.915)-enBox.x):Math.max(enBox.w,.43),h:b.number?Math.max(enBox.h,.031):enBox.h};
  b.bilingualPrint={cn,en:en.map(l=>({text:l.text,box:l.box})),py:py.length?[{text:b.py,box:union(py.map(l=>l.box))}]:[],heading:!b.number,translationBox:tr,cnFont:b.number?2.5:b.cn==='课堂用语'?3.25:2.5,enFont:b.cn==='课堂用语'?3.1:1.72,pyFont:1.45,speakText:b.number?b.cn:null};
  b.box=union([bounds,tr]);delete b.exactTokens;
  if(!b.number&&b.cn!=='课堂用语'){
   const c=chinese[0].box,pts=[];
   for(let y=Math.floor((c.y-.012)*grid.H);y<(c.y+c.h+.008)*grid.H;y++)for(let x=Math.floor((c.x-.025)*grid.W);x<(c.x+c.w+.016)*grid.W;x++){const p=grid.at(x,y);if(p[0]>p[1]*1.22&&p[1]<180)pts.push({x:x/grid.W,y:y/grid.H,w:1/grid.W,h:1/grid.H});}
   if(pts.length>20){const frame=union(pts);b.classroomRibbon={frame,translation:{x:frame.x+frame.w,y:frame.y,w:enBox.x+enBox.w-frame.x-frame.w+.008,h:frame.h}};b.box=union([b.box,frame,b.classroomRibbon.translation]);}
  }
  if(b.cn==='课堂用语')b.classroomBanner=true;
 }
 return true;
}
