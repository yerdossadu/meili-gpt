// Copyright/CIP pages are structured print, not flowing lesson paragraphs.
const clean=s=>String(s||'').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const union=boxes=>{const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return{x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};};
export function nativeLines(text,groups){
  const raw=[...text.replace(/\n/g,'')],idx=raw.map((c,i)=>/\s/.test(c)?-1:i).filter(i=>i>=0),z=idx.map(i=>raw[i]);
  const a=[...groups.map(g=>g.text.replace(/\s/g,'')).join('')];if(a.length>1500||z.length>1500)return null;
  const dp=Array.from({length:a.length+1},()=>new Uint16Array(z.length+1));
  for(let i=0;i<=a.length;i++)dp[i][0]=i;for(let j=0;j<=z.length;j++)dp[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=z.length;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===z[j-1]?0:1));
  if(dp[a.length][z.length]/Math.max(a.length,z.length)>.3)return null;
  const map=new Map();let i=a.length,j=z.length;map.set(i,j);
  while(i||j){if(i&&j&&dp[i][j]===dp[i-1][j-1]+(a[i-1]===z[j-1]?0:1)){i--;j--;}else if(j&&dp[i][j]===dp[i][j-1]+1)j--;else i--;map.set(i,j);}
  let seen=0,from=0;return groups.map((g,k)=>{seen += [...g.text.replace(/\s/g,'')].length;const to=k===groups.length-1?raw.length:(idx[map.get(seen)]??raw.length),text=raw.slice(from,to).join('');from=to;return{text,box:g.box};});
}
export function measureImprintPage(layout,lines){
  const source=layout.source?.blocks||[];
  const dense=layout.blocks.find(b=>b.type==='text'&&/出版发行/.test(b.cn)&&/ISBN/.test(b.cn)&&b.cn.split('\n').length>=10);
  if(!dense||!layout.blocks.some(b=>/CIP/.test(b.cn)))return false;
  for(const b of layout.blocks.filter(b=>b.type==='text')){
    const original=source.find(s=>clean(s.cn)===clean(b.cn));if(!original)continue;
    const q=original.box,s=clean(b.cn);
    const found=lines.filter(l=>l.box.h<.04&&l.box.y>=q.y-.045&&l.box.y<q.y+q.h+.025&&l.box.x>=q.x-.05&&l.box.x<q.x+q.w+.025&&clean(l.text).length>=2)
      .filter(l=>{const t=clean(l.text);return s.includes(t)||[...t].filter(c=>s.includes(c)).length/t.length>.9;}).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
    if(!found.length)continue;
    const groups=[];for(const l of found){let g=groups.find(g=>Math.abs(g.box.y-l.box.y)<.005);if(g){g.tokens.push(l);g.box=union(g.tokens.map(t=>t.box));}else groups.push({box:l.box,tokens:[l]});}
    groups.forEach(g=>g.text=g.tokens.sort((a,b)=>a.box.x-b.box.x).map(t=>t.text).join(' '));
    if(b===dense){
      const rows=b.cn.split('\n'),anchors=[];
      rows.forEach((row,r)=>{const v=clean(row);const best=found.filter(l=>clean(l.text).length>=2&&v.includes(clean(l.text))).sort((a,b)=>clean(b.text).length-clean(a.text).length)[0];if(best)anchors.push({r,y:best.box.y});});
      const pitches=anchors.slice(1).map((a,i)=>(a.y-anchors[i].y)/(a.r-anchors[i].r)).filter(p=>p>.008&&p<.03);
      if(anchors.length<6||!pitches.length)continue;
      const pitch=median(pitches),y=median(anchors.map(a=>a.y-a.r*pitch)),x=Math.min(...found.map(l=>l.box.x));
      const values=found.filter(l=>l.box.x>x+.055&&l.text.length>3).map(l=>l.box.x),valueX=values.length?median(values):x+.075;
      b.imprint={kind:'rows',pitch,rows:rows.map((text,r)=>{const parts=text.trim().split(/\s+/),n=parts[0].length===1?2:1;return{text,label:parts.slice(0,n).join(''),value:parts.slice(n).join(' '),y:y+r*pitch};}),valueX};
      b.box={x,y,w:.88-x,h:rows.length*pitch};
    }else{
      const native=nativeLines(b.cn,groups);if(!native)continue;
      b.imprint={kind:'lines',lines:native};b.box=union(native.map(l=>l.box));
      // Translation uses free width rather than shrinking the whole page.
      if(b.ru)b.box={...b.box,w:.88-b.box.x,h:Math.max(b.box.h,.045)};
    }
    b.imprint.font=median(found.map(l=>l.box.h))*layout.page.height/layout.page.width*100*.85;
    b.trOff=false;
  }
  const slogans={
    '记载人类文明':{ru:'Сохраняя цивилизацию человечества',kk:'Адамзат өркениетін сақтау'},
    '沟通世界文化':{ru:'Объединяя культуры мира',kk:'Әлем мәдениеттерін байланыстыру'}
  };
  for(const b of layout.blocks.filter(b=>b.type==='image')){
    const q=b.box,labels=lines.filter(l=>l.box.y>=q.y-.035&&l.box.y<q.y+q.h+.01&&l.box.x>q.x+.025&&l.box.x<q.x+q.w&& (slogans[l.text.trim()]||/^www\./.test(l.text)));
    if(labels.length<3)continue;
    const bounds=union(labels.map(l=>l.box)),x=Math.min(...layout.blocks.filter(b=>b.imprint).map(b=>b.box.x));
    b.box={x,y:bounds.y-.004,w:bounds.x-x-.004,h:bounds.h+.008};delete b.frame;
    b.imprintLabels=labels.map(l=>({text:l.text,box:l.box,...slogans[l.text.trim()]}));
  }
  return true;
}
