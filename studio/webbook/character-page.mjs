// Measure bilingual character introductions using OCR baselines, preserving both print languages.
import {nativeLines} from './imprint-page.mjs';
import {measurePinkPaper} from './foreword-page.mjs';
const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
const median=a=>a.sort((a,b)=>a-b)[a.length>>1];
const union=a=>{const x=Math.min(...a.map(b=>b.x)),y=Math.min(...a.map(b=>b.y));return{x,y,w:Math.max(...a.map(b=>b.x+b.w))-x,h:Math.max(...a.map(b=>b.y+b.h))-y};};
export function measureCharacterPage(layout,grid,lines){
 const title=layout.blocks.find(b=>/内容梗概.*主要人物/.test(b.cn||''));
 if(!title||layout.blocks.filter(b=>b.type==='image').length<2)return false;
 measurePinkPaper(layout,grid);
 const source=layout.source?.blocks||layout.blocks;
 for(const b of layout.blocks){
  if(b.type==='section'&&/主要人物/.test(b.cn||'')){const original=source.find(o=>o.type==='section'&&clean(o.cn)===clean(b.cn));if(original){b.box={...original.box};b.characterRibbon=true;}continue;}
  if(b.type==='image'){const i=layout.blocks.filter(o=>o.type==='image').indexOf(b),original=source.filter(o=>o.type==='image')[i];if(original){b.box={...original.box};delete b.frame;}continue;}
  if(!['text','para'].includes(b.type)||!b.cn||!b.en)continue;
  const original=source.find(o=>clean(o.cn)===clean(b.cn))||b,q=original.box;
  let cnLimit=1;
  const groupsFor=(text,lang)=>{
   const s=clean(text),found=lines.filter(l=>l.box.y>=q.y-.065&&l.box.y<q.y+q.h+.045&&l.box.x>=q.x-.07&&l.box.x<q.x+q.w+.03)
    .filter(l=>lang==='cn'?l.box.y<cnLimit&&/[\p{Script=Han}]/u.test(l.text):!/[\p{Script=Han}]/u.test(l.text))
    .filter(l=>{const t=clean(l.text);return t.length>=(lang==='cn'?2:4)&&s.includes(t);}).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
   const groups=[];for(const l of found){let g=groups.find(g=>Math.abs(g.box.y-l.box.y)<.005);if(!g){g={tokens:[],box:l.box};groups.push(g);}g.tokens.push(l);g.box=union(g.tokens.map(t=>t.box));}
   for(const g of groups)g.text=g.tokens.sort((a,b)=>a.box.x-b.box.x).map(t=>t.text).join(lang==='cn'?'':' ');
   return nativeLines(text,groups)||[];
  };
  const en=groupsFor(b.en,'en');if(en.length)cnLimit=en[0].box.y;const cn=groupsFor(b.cn.replace(/\s/g,''),'cn');if(!cn.length||!en.length)continue;
  const heading=b===title||b.size==='l',bounds=union([...cn,...en].map(l=>l.box)),translationBox=union(en.map(l=>l.box));
  if(heading&&b!==title)translationBox.w=Math.max(translationBox.w,.36);
  if(!heading)translationBox.w=Math.max(translationBox.w,.845-translationBox.x);
  const bottom=source.filter(o=>o!==original&&o.box.y>bounds.y+bounds.h-.005&&o.box.x<.85).sort((a,b)=>a.box.y-b.box.y)[0]?.box.y;
  if(bottom&&!heading)translationBox.h=Math.max(translationBox.h,bottom-translationBox.y-.012);
  const font=rows=>median(rows.map(l=>l.box.h))*layout.page.height/layout.page.width*100*.91;
  if(heading&&b!==title){const pts=[];for(let y=Math.floor((bounds.y+bounds.h)*grid.H);y<Math.min(grid.H,(bounds.y+bounds.h+.035)*grid.H);y++){const row=[];for(let x=Math.floor(.08*grid.W);x<.9*grid.W;x++){const p=grid.at(x,y);if(p[0]>p[1]*1.2&&p[1]<190)row.push({x:x/grid.W,y:y/grid.H,w:1/grid.W,h:1/grid.H});}if(row.length>grid.W*.1)pts.push(...row);}if(pts.length)b.characterRule=union(pts);}
  const widths=cn.filter(l=>l.text.length>=8).map(l=>l.box.w*100/[...l.text].reduce((n,c)=>n+(/[\p{Script=Han}\p{P}]/u.test(c)?1:.5),0));
  b.bilingualPrint={cn,en,heading,translationBox,cnFont:widths.length?median(widths):font(cn),enFont:font(en)};
  b.box=union([bounds,translationBox]);b.trOff=false;delete b.exactTokens;
 }
 return true;
}
