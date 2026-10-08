// Prose frontmatter: original baselines are measured, translations replace prose.
import {nativeLines} from './imprint-page.mjs';
export const normalizeProseLatin=s=>String(s||'').replace(/A[ⅠΙＩ](?=助学|助教|技术|时代|命题|评分)/gu,'AI');
const clean=s=>normalizeProseLatin(s).replace(/\s/g,'');
const union=a=>{const x=Math.min(...a.map(b=>b.x)),y=Math.min(...a.map(b=>b.y));return{x,y,w:Math.max(...a.map(b=>b.x+b.w))-x,h:Math.max(...a.map(b=>b.y+b.h))-y};};
const median=a=>a.sort((a,b)=>a-b)[a.length>>1];
const headingText=s=>/^(序|前言|序言|致读者|使用说明|使用指南)$/.test(clean(s));
function bannerAt(grid,q){
 const pts=[],colors=[];for(let y=Math.max(0,Math.floor((q.y-.012)*grid.H));y<Math.min(grid.H,(q.y+q.h+.012)*grid.H);y++)for(let x=Math.max(0,Math.floor((q.x-.015)*grid.W));x<Math.min(grid.W,(q.x+q.w+.015)*grid.W);x++){const p=grid.at(x,y);if(p[0]>130&&p[0]>p[1]*1.25&&p[0]>p[2]*1.2){pts.push({x:x/grid.W,y:y/grid.H,w:1/grid.W,h:1/grid.H});colors.push(p);}}
 if(!pts.length)return null;const box=union(pts);if(box.w<.07||pts.length/(box.w*grid.W*box.h*grid.H)<.45)return null;
 return{box,color:'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join('')};
}
export function measureForewordPage(layout,grid,lines){
 const guide=layout.blocks.some(b=>/^使用(说明|指南)$/.test(clean(b.cn)));
 if(!layout.blocks.some(b=>headingText(b.cn))||layout.blocks.filter(b=>(b.cn||'').length>100).length<(guide?2:3))return false;
 const samples=[];for(let y=2;y<grid.H;y+=7)for(let x=2;x<grid.W;x+=7){const p=grid.at(x,y);if(p[0]>p[1]+8&&p[1]>175&&p[0]>210)samples.push(p);}
 if(samples.length>grid.W*grid.H/180){const color='#'+[0,1,2].map(i=>median(samples.map(p=>p[i])).toString(16).padStart(2,'0')).join('');let right=grid.W-1,left=0;const white=x=>grid.at(x,Math.floor(grid.H*.04)).slice(0,3).every(v=>v>248);while(right>grid.W/2&&white(right))right--;while(left<grid.W/2&&white(left))left++;Object.assign(layout.theme,{paper:'#ffffff',background:{color,box:{x:left/grid.W,y:0,w:(right-left+1)/grid.W,h:1}}});}
 const source=layout.source?.blocks||layout.blocks;
 const bodyRight=Math.max(...source.filter(b=>(b.cn||'').length>30&&b.box.w>.4).map(b=>b.box.x+b.box.w),0);
 for(const b of layout.blocks){
  if(b.type==='folio'){
   const q=b.box,right=q.x+q.w/2>.5,pts=[];for(let y=Math.max(0,Math.floor((q.y-.015)*grid.H));y<Math.min(grid.H,(q.y+q.h+.015)*grid.H);y++)for(let x=right?Math.max(0,Math.floor((q.x-.05)*grid.W)):0;x<(right?grid.W:Math.min(grid.W,(q.x+q.w+.05)*grid.W));x++){const p=grid.at(x,y);if(p[0]>140&&p[0]>p[1]*1.25&&p[0]>p[2]*1.2)pts.push({x:x/grid.W,y:y/grid.H,w:1/grid.W,h:1/grid.H});}
   if(pts.length){b.box=union(pts);if(right)b.box.w=1-b.box.x;else{b.box.w+=b.box.x;b.box.x=0;}b.forewordFolio=true;b.forewordFolioSide=right?'right':'left';}continue;
  }
  if(!b.cn)continue;
  const normalized=normalizeProseLatin(b.cn);if(normalized!==b.cn){b.ocrCorrections=[...(b.ocrCorrections||[]),{from:b.cn,to:normalized,reason:'Latin AI term in Chinese educational prose'}];b.cn=normalized;}
  const original=source.find(s=>clean(s.cn)===clean(b.cn))||b,q=original.box,s=clean(b.cn);
  const found=lines.filter(l=>l.box.y>=q.y-.008&&l.box.y+l.box.h<q.y+q.h+.008&&clean(l.text)&&(s.includes(clean(l.text))||[...clean(l.text)].filter(c=>s.includes(c)).length/clean(l.text).length>.9)).sort((a,c)=>a.box.y-c.box.y||a.box.x-c.box.x);
  if(!found.length)continue;
  const groups=[];for(const l of found){let g=groups.find(g=>Math.abs(g.box.y-l.box.y)<.005);if(!g){g={tokens:[],box:l.box};groups.push(g);}g.tokens.push(l);g.box=union(g.tokens.map(t=>t.box));}
  groups.forEach(g=>g.text=g.tokens.sort((a,c)=>a.box.x-c.box.x).map(t=>t.text).join(''));
  const native=nativeLines(b.cn,groups);if(!native)continue;
  const bounds=union(native.map(l=>l.box)),heading=headingText(s),banner=!heading&&s.length<=12?bannerAt(grid,q):null;
  const signature=!heading&&!banner&&q.y>.65&&q.x>.45&&native.length<=3;
  const paragraph=!heading&&!banner&&!signature;
  const heightFont=median(found.map(l=>l.box.h))*layout.page.height/layout.page.width*100*.91;
  const widths=native.filter(l=>[...l.text].filter(c=>/[\u3400-\u9fff]/.test(c)).length>=15&&[...l.text].filter(c=>/[\u3400-\u9fff]/.test(c)).length/l.text.length>.7).map(l=>l.box.w*100/[...l.text].reduce((n,c)=>n+(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef\u2018-\u201f]/.test(c)?1:/\s/.test(c)?.25:.5),0)).filter(f=>f>=heightFont*.85&&f<=heightFont*1.25);
  const lineFont=widths.length?median(widths):heightFont;
  b.foreword={lines:native,font:lineFont,heading,paragraph,banner,compact:guide&&paragraph&&native.length===1&&/^[\u3400-\u9fff]{2,8}[：:]/.test(b.cn),kk:original.kk};
  b.box={...bounds,h:bounds.h+.004};
  if(guide&&paragraph&&bodyRight>bounds.x){b.box.w=Math.max(bounds.w,bodyRight-bounds.x);const next=source.filter(o=>o!==original&&o.box.y>bounds.y+bounds.h-.001&&o.box.x<bodyRight).sort((a,c)=>a.box.y-c.box.y)[0];if(next)b.box.h=Math.max(b.box.h,Math.min(bounds.h+.02,next.box.y-bounds.y-.005));}
  if(!heading&&!paragraph&&bounds.w<.3){b.box.x=Math.max(0,bounds.x+bounds.w-.3);b.box.w=bounds.x+bounds.w-b.box.x;}
  if(heading){const cx=bounds.x+bounds.w/2;b.box={x:Math.max(.03,cx-.36),y:bounds.y,w:.72,h:bounds.h+.008};}
  if(banner)b.box=banner.box;
  b.trOff=false;delete b.exactTokens;
 }
 const fonts=layout.blocks.filter(b=>b.foreword?.paragraph).map(b=>b.foreword.font);
 if(fonts.length)for(const b of layout.blocks)if(b.foreword?.paragraph)b.foreword.font=median([...fonts]);
 return true;
}
