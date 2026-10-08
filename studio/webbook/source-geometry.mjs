// Measure printed graphic surfaces separately from their editable text.
// The scan supplies a vector silhouette and a small text-free texture tile;
// headings and translations remain real HTML, at their OCR coordinates.
const union = boxes => {
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
const red = p => p[0] > 115 && p[0] > p[1] * 1.3 && p[0] > p[2] * 1.25;
const beige = p => p[0] > 218 && p[1] > 205 && p[2] > 180 && p[0] - p[2] > 9 && p[0] - p[1] < 20;
const hasHan = s => /\p{Script=Han}/u.test(s);

export function hasPrintedCardFrame(box, grid) {
  const g=grid.hi||grid.raw||grid;let rows=0;
  for(let j=2;j<18;j++){
    const y=Math.round((box.y+box.h*j/20)*g.H);let found=false;
    for(let d=-Math.round(.008*g.W);d<=Math.round(.008*g.W)&&!found;d++)for(const edge of [box.x,box.x+box.w]){
      const x=Math.round(edge*g.W)+d;if(x<0||x>=g.W||y<0||y>=g.H)continue;
      const [r,v,b]=g.at(x,y);
      if(r>155&&r>v*1.12&&r>b*1.12&&Math.abs(v-b)<55){found=true;break;}
    }
    if(found)rows++;
  }
  return rows>=10;
}

export function printedCardBounds(box,grid) {
  if(!hasPrintedCardFrame(box,grid))return null;
  const g=grid.hi||grid.raw||grid,points=[];
  for(let y=Math.max(0,Math.floor((box.y-.012)*g.H));y<Math.min(g.H,(box.y+box.h+.012)*g.H);y++)
    for(const edge of [box.x,box.x+box.w])for(let x=Math.max(0,Math.floor((edge-.012)*g.W));x<Math.min(g.W,(edge+.012)*g.W);x++){
      const [r,v,b]=g.at(x,y);if(r>155&&r>v*1.12&&r>b*1.12&&Math.abs(v-b)<55)points.push({x:x/g.W,y:y/g.H,w:1/g.W,h:1/g.H});
    }
  if(!points.length)return null;
  // A generous model box may cross the next card. Split the border at the
  // white inter-row gap instead of joining both printed frames.
  const bands=[];
  for(const p of points.sort((a,b)=>a.y-b.y)){
    const band=bands.at(-1);
    if(!band||p.y-band.at(-1).y>.004)bands.push([p]);else band.push(p);
  }
  const centre=box.y+box.h/2;
  const candidates=bands.map(union).filter(b=>b.h>.04&&b.w>box.w*.85);
  const found=candidates.sort((a,b)=>Math.abs(a.y+a.h/2-centre)-Math.abs(b.y+b.h/2-centre))[0];
  if(!found)return null;
  return found.w>box.w*.85&&found.w<box.w*1.15&&found.h>box.h*.6?found:null;
}

function surface(grid, window, test, gap) {
  const { W, H } = grid, rows = [], boxes = [];
  const x0 = Math.max(0, Math.floor(window.x * W)), x1 = Math.min(W - 1, Math.ceil((window.x + window.w) * W));
  const y0 = Math.max(0, Math.floor(window.y * H)), y1 = Math.min(H - 1, Math.ceil((window.y + window.h) * H));
  for (let y = y0; y <= y1; y++) {
    const runs = []; let start = -1, last = -1;
    for (let x = x0; x <= x1; x++) if (test(grid.at(x, y))) {
      if (start < 0) start = x;
      else if (x - last > gap) { runs.push([start, last + 1]); start = x; }
      last = x;
    }
    if (start >= 0) runs.push([start, last + 1]);
    for (const [a, b] of runs) if (b - a >= 1) { rows.push(`M${a} ${y}h${b-a}v1h${a-b}z`); boxes.push({ x: a / W, y: y / H, w: (b-a) / W, h: 1 / H }); }
  }
  return boxes.length ? { path: rows.join(''), box: union(boxes) } : null;
}

function texture(grid, box) {
  const { W, H } = grid, size = 22;
  for (let y = Math.ceil(box.y * H) + 2; y < (box.y + box.h) * H - size; y += 3)
    for (let x = Math.floor((box.x + box.w) * W) - size - 2; x > box.x * W; x -= size) {
      let n = 0;
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) if (red(grid.at(x + dx, y + dy))) n++;
      if (n === size * size) return { x: x / W, y: y / H, w: size / W, h: size / H };
    }
  return null;
}

export function measurePrintedGeometry(block, grid, lines, page) {
  if(block.type==='section'&&!block.avatar&&/^[一二三四五六七八九十]+[、.]/.test(block.cn||'')){
    const near=lines.filter(l=>Math.abs(l.box.y-block.box.y)<.04),cn=near.find(l=>hasHan(l.text)&&l.text.includes(block.cn.replace(/\s/g,''))),en=near.find(l=>l.text.toLowerCase()===String(block.en||'').toLowerCase());
    if(cn&&en){
      const raw=grid.raw||grid,win={x:cn.box.x-.012,y:cn.box.y-.008,w:cn.box.w+.024,h:cn.box.h+.014};
      const graphic=surface(raw,win,red,Math.round(grid.W*.045));
      if(graphic){const pill={x:graphic.box.x+graphic.box.w-.002,y:en.box.y-.006,w:en.box.x+en.box.w+.018-(graphic.box.x+graphic.box.w-.002),h:en.box.h+.014};
        const track=near.find(l=>block.track&&l.text.includes(block.track));const box=union([graphic.box,pill,...(track?[track.box]:[])]);
        return {box,printed:{kind:'section-tab',graphic:graphic.path,grid:[grid.W,grid.H],cnBox:cn.box,enBox:en.box,pill,trackBox:track?.box,cnSize:Math.min(cn.box.h/(page.width/page.height)*82,cn.box.w*100/[...block.cn].length),texture:texture(raw,graphic.box)}};
      }
    }
  }
  if(block.type==='folio'&&block.text){
    const b=block.box,win={x:Math.max(0,b.x-.02),y:Math.max(0,b.y-.015),w:Math.min(.14,b.w+.04),h:Math.min(1-b.y+.015,b.h+.03)};
    const graphic=surface(grid.raw||grid,win,red,Math.round(grid.W*.025));
    if(graphic&&graphic.box.w<.09&&graphic.box.h<.065)return {box:graphic.box,printed:{kind:'folio',graphic:graphic.path,grid:[grid.W,grid.H]}};
  }
  if (block.type === 'runhead' && block.cn && block.en && block.box.y < .08) {
    const near=lines.filter(l=>l.box.y<.08), cn=near.find(l=>hasHan(l.text)), en=near.find(l=>l.text.toLowerCase().includes(block.en.toLowerCase()));
    if(!cn||!en)return null;
    const graphic=surface(grid.raw||grid,{x:0,y:0,w:en.box.x,h:.065},red,Math.round(grid.W*.04));
    if(!graphic||graphic.box.w<.1)return null;
    const ratio=page.width/page.height;
    const units=[...block.cn].reduce((n,c)=>n+(hasHan(c)?1:/\s/.test(c)?.3:.6),0);
    return {box:union([graphic.box,cn.box,en.box]),printed:{kind:'runhead',graphic:graphic.path,grid:[grid.W,grid.H],cnBox:cn.box,enBox:en.box,pyLines:[],cnSize:Math.min(cn.box.h/ratio*100*.88,cn.box.w*100/units),enSize:en.box.h/ratio*100*.92,texture:texture(grid.raw||grid,graphic.box)}};
  }
  if (!['lesson', 'section'].includes(block.type) || (block.type === 'section' && !block.avatar)) return null;
  if (block.type === 'lesson' && block.label) return null;
  const b = block.box, ratio = page.width / page.height, raw = grid.raw || grid;
  const near = lines.filter(l => l.box.y >= b.y - .025 && l.box.y + l.box.h <= b.y + b.h + .025);
  const cn = near.filter(l => hasHan(l.text) && [...l.text].some(c => hasHan(c) && block.cn.includes(c)));
  const en = near.find(l => l.text.replace(/[’']/g, '').toLowerCase().includes(String(block.en || '').replace(/[’']/g, '').toLowerCase()) && block.en);
  if (!cn.length || !en) return null;
  const cnBox = union(cn.map(l => l.box));
  // Include the chapter-number capsule / feature underline, but no adjacent
  // section. The coloured shape is read row by row; short white glyph holes
  // are closed while the large white chapter-number capsule stays empty.
  const win = { x: Math.max(0, b.x - .09), y: Math.max(0, b.y - .008), w: Math.min(1, b.x + b.w + .025) - Math.max(0, b.x - .09), h: b.h + .016 };
  if (block.type === 'section' && block.avatar) { win.x = .035; win.w = .93; }
  const graphic = surface(raw, win, red, Math.round(grid.W * .045));
  if (!graphic || graphic.box.w < (block.type === 'lesson' ? .25 : .12)) return null;
  let tag = null, number = null;
  if (block.type === 'section') {
    tag = surface(raw, { x: en.box.x - .025, y: en.box.y - .012, w: en.box.w + .055, h: en.box.h + .023 }, beige, Math.round(grid.W * .07));
  } else {
    const dark = [];
    // A chapter numeral is the large dark glyph left of the coloured title.
    for (let y = Math.floor(win.y * grid.H); y < (win.y + win.h) * grid.H; y++)
      for (let x = Math.floor(win.x * grid.W); x < (cnBox.x - .025) * grid.W; x++) {
        const p = raw.at(x, y);
        if (Math.max(...p) < 95) dark.push({ x: x / grid.W, y: y / grid.H, w: 1 / grid.W, h: 1 / grid.H });
      }
    if (dark.length > 25) { const bb = union(dark); if (bb.w < .15 && bb.h > .035) number = bb; }
    if (!number) return null;
  }
  const box = union([graphic.box, cnBox, en.box, ...(tag ? [tag.box] : []), ...(number ? [number] : [])]);
  const py = block.type === 'lesson' ? near.filter(l => !hasHan(l.text) && l !== en && l.box.y + l.box.h <= cnBox.y + .01 && /[a-z]/i.test(l.text)).sort((a,b) => a.box.x-b.box.x) : [];
  const tokens = String(block.py || '').split(/\s+/).filter(Boolean); let token = 0;
  const pyLines = py.map(l => { const count = l.text.trim().split(/\s+/).length; return { box: l.box, text: tokens.slice(token, token += count).join(' ') || l.text }; });
  const units = [...block.cn].reduce((n,c) => n + (hasHan(c) || /[，。！？、]/.test(c) ? 1 : /\s/.test(c) ? .25 : .55), 0);
  const cnSize = Math.min(cnBox.h / ratio * 100 * .9, cnBox.w * 100 / Math.max(1, units));
  const track = block.track && near.find(l => l.text.includes(block.track));
  return { box: track ? union([box,track.box]) : box, printed: { graphic: graphic.path, tag: tag?.path || '', grid: [grid.W, grid.H], cnBox, enBox: en.box, trackBox: track?.box, number, pyLines, cnSize, enSize: en.box.h / ratio * 100 * .78, texture: texture(raw, graphic.box) } };
}

// A coloured table is geometry, not a photo. Measure the uninterrupted header
// band and its rules separately from the OCR glyphs so every token stays text.
export function measureTextTable(block,grid) {
  if(!block.exactTokens?.length)return null;
  const g=grid.raw||grid,{W,H}=g,b=block.box;
  const left=Math.max(0,Math.floor((b.x-.025)*W)),right=Math.min(W-1,Math.ceil((b.x+b.w+.025)*W));
  const rows=[];
  for(let y=Math.max(0,Math.floor((b.y-.02)*H));y<Math.min(H,(b.y+b.h)*H);y++){
    let n=0,x0=right,x1=left;
    for(let x=left;x<=right;x++)if(red(g.at(x,y))){n++;x0=Math.min(x0,x);x1=Math.max(x1,x);}
    if(n>(right-left)*.55)rows.push({y,x0,x1});
  }
  if(rows.length<5)return null;
  const top=rows[0].y,bottom=rows.at(-1).y+1;
  if(bottom-top>H*.09)return null;
  const x0=Math.min(...rows.map(r=>r.x0)),x1=Math.max(...rows.map(r=>r.x1))+1;
  const hi=grid.hi||g,pink=p=>p[0]>150&&p[0]>p[1]*1.02&&p[0]>p[2]*1.02&&p[0]-Math.min(p[1],p[2])>8;
  let end=b.y+b.h;
  const lastText=Math.max(bottom/H,...block.exactTokens.map(t=>t.box.y+t.box.h));
  for(let y=Math.round(lastText*hi.H)+3;y<Math.min(hi.H,(b.y+b.h+.035)*hi.H);y++){
    let hit=0,total=0;for(let x=Math.round(x0/W*hi.W);x<x1/W*hi.W;x+=4){total++;if(pink(hi.at(x,y)))hit++;}
    if(hit/Math.max(1,total)>.7)end=y/hi.H;
  }
  const splits=[];
  for(let x=Math.round((x0/W+.03)*hi.W);x<(x1/W-.03)*hi.W;x++){
    let hit=0,total=0;for(let y=Math.round(bottom/H*hi.H)+4;y<end*hi.H-3;y+=4){total++;if(pink(hi.at(x,y)))hit++;}
    if(hit/Math.max(1,total)>.8&&(!splits.length||x/hi.W-splits.at(-1)>.01))splits.push(x/hi.W);
  }
  const header={x:x0/W,y:top/H,w:(x1-x0)/W,h:(bottom-top)/H};
  return {box:union([b,{x:header.x,y:header.y,w:header.w,h:end-header.y}]),textTable:{header,frame:{x:header.x,y:header.y,w:header.w,h:end-header.y},splits,texture:texture(g,header)}};
}

export function restorePhoneticTokens(block) {
  if(!block.textTable||!block.exactTokens?.length||!/^声母\s*\nInitials\s*\n/u.test(block.cn||'')||!String(block.cn).includes('Finals'))return block;
  const parts=block.cn.split(/声母\s*\nInitials\s*\n|韵母\s*\nFinals\s*\n/).filter(Boolean);
  if(parts.length!==2)return block;
  const groups=parts.map(s=>s.trim().split('\n').map(r=>(r.match(/[a-zü]+(?:\s*\[i\]|\s*\([a-zü]+\))?/gi)||[]).map(t=>t.replace(/i\s+\[i\]/g,'i[i]'))));
  if(groups.flat(2).some(s=>!/^([a-zü]+(?:\s*\([a-zü]+\))?|i\s*\[i\])$/.test(s)))return block;
  const tokens=block.exactTokens.map(t=>({...t,box:{...t.box}})),head=block.textTable.header,split=block.textTable.splits[0];
  if(!split)return block;
  const fold=s=>s.toLowerCase().replace(/[\[\]\s]/g,'');
  for(let group=0;group<2;group++){
    const region=tokens.filter(t=>t.box.y>head.y+head.h-.002&&(t.box.x+t.box.w/2<split)===(group===0));
    const rows=groups[group].map(row=>row.map(text=>{const token=region.find(t=>!t.used&&(fold(t.text)===fold(text)||(text.startsWith('ü')&&fold(t.text)===fold(text).replace('ü','u'))||(fold(text)==='ii'&&/^i\[[^\]]*\]$/.test(t.text))));if(token)token.used=true;return {text,token};}));
    const has=rows.flat().filter(c=>c.token);if(has.length<Math.ceil(rows.flat().length*.65))continue;
    for(let ri=0;ri<rows.length;ri++){
      const row=rows[ri],matched=row.filter(c=>c.token);if(!matched.length)continue;
      const cy=matched.reduce((s,c)=>s+c.token.box.y+c.token.box.h/2,0)/matched.length;
      row.forEach((cell,ci)=>{
        if(cell.token){if(cell.text!==cell.token.text){cell.token.ocrText=cell.token.text;cell.token.text=cell.text;}return;}
        let x;
        if(group===0){const same=rows.map(r=>r[ci]?.token).find(Boolean);if(same)x=same.box.x+same.box.w/2;}
        if(x==null){const before=row.slice(0,ci).findLast(c=>c.token),after=row.slice(ci+1).find(c=>c.token);if(before&&after){const a=row.indexOf(before),z=row.indexOf(after);x=before.token.box.x+before.token.box.w/2+(after.token.box.x+after.token.box.w/2-before.token.box.x-before.token.box.w/2)*(ci-a)/(z-a);}}
        if(x==null){const peers=row.map((c,i)=>({c,i})).filter(p=>p.c.token);if(peers.length>=2){const a=peers[0],z=peers.at(-1),ax=a.c.token.box.x+a.c.token.box.w/2,zx=z.c.token.box.x+z.c.token.box.w/2;x=ax+(zx-ax)*(ci-a.i)/(z.i-a.i);}}
        if(x==null)return;
        const w=.012*Math.max(1,cell.text.length),h=.016;
        const t={text:cell.text,box:{x:x-w/2,y:cy-h/2,w,h},recoveredFrom:'semantic-grid',reviewRequired:true};tokens.push(t);cell.token=t;
      });
    }
    // One measured row baseline and one column centre for each lattice line.
    // Individual OCR glyph bounds vary with ascenders/descenders and cannot
    // serve as independent text origins.
    const med=values=>{const v=values.slice().sort((a,b)=>a-b);return v[Math.floor(v.length/2)];};
    const centres=rows.map(row=>med(row.filter(c=>c.token).map(c=>c.token.box.y+c.token.box.h/2)));
    const pitch=centres.length>1?med(centres.slice(1).map((c,i)=>c-centres[i])):0;
    const origin=med(centres.map((c,i)=>c-i*pitch));
    const columns=[];
    for(const cell of rows.flat().filter(c=>c.token).sort((a,b)=>a.token.box.x+a.token.box.w/2-b.token.box.x-b.token.box.w/2)){
      const x=cell.token.box.x+cell.token.box.w/2,last=columns.at(-1);
      if(last&&Math.abs(x-med(last))<.025)last.push(x);else columns.push([x]);
    }
    rows.forEach((row,ri)=>row.forEach(cell=>{
      if(!cell.token)return;
      const t=cell.token,cx=t.box.x+t.box.w/2,col=columns.map(v=>med(v)).sort((a,b)=>Math.abs(a-cx)-Math.abs(b-cx))[0];
      t.ocrBox ||= {...t.box};
      t.box={x:col-t.box.w/2,y:origin+ri*pitch-.008,w:t.box.w,h:.016};
      t.tableRow=`${group}-${ri}`;
    }));
  }
  for(const t of tokens)delete t.used;
  return {...block,exactTokens:tokens,phoneticTextTable:true};
}

// Align semantic text to measured OCR lines. OCR may omit glyphs, so copying
// its strings would lose content; use it only to locate line boundaries.
export function printedParagraphLines(block,lines,language='cn') {
  const source=block[language];
  if(block.type!=='para'||block.py||(language==='cn'?[...String(source||'')].filter(c=>hasHan(c)).length<30:String(source||'').length<80))return null;
  const b=block.box,found=lines.filter(l=>(language==='cn'?hasHan(l.text):!hasHan(l.text)&&/[a-z]{3}/i.test(l.text))&&l.box.y>=b.y-.004&&l.box.y+l.box.h<=b.y+b.h+.004).sort((a,c)=>a.box.y-c.box.y);
  if(found.length<2)return null;
  const a=[...found.map(l=>l.text.replace(/\s/g,'')).join('')],raw=[...source.replace(/\n/g,language==='cn'?'':' ')],idx=raw.map((c,i)=>/\s/.test(c)?-1:i).filter(i=>i>=0),z=idx.map(i=>raw[i]);
  if(a.length>1000||z.length>1000)return null;
  const dp=Array.from({length:a.length+1},()=>new Uint16Array(z.length+1));
  for(let i=0;i<=a.length;i++)dp[i][0]=i;for(let j=0;j<=z.length;j++)dp[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=z.length;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===z[j-1]?0:1));
  if(dp[a.length][z.length]/Math.max(a.length,z.length)>.35)return null;
  const map=new Map();let i=a.length,j=z.length;map.set(i,j);
  while(i||j){if(i&&j&&dp[i][j]===dp[i-1][j-1]+(a[i-1]===z[j-1]?0:1)){i--;j--;}else if(j&&dp[i][j]===dp[i][j-1]+1)j--;else i--;if(!map.has(i)||map.get(i)<j)map.set(i,j);}
  let from=0,seen=0;const result=[];
  for(let k=0;k<found.length;k++){
    seen += [...found[k].text.replace(/\s/g,'')].length;
    const to=k===found.length-1?raw.length:(idx[map.get(seen)]??raw.length),text=raw.slice(from,to).join('');from=to;
    if(text)result.push({text,box:found[k].box});
  }
  return result.length===found.length?result:null;
}
