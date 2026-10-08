// Sparse title pages need different geometry from paragraphs in a lesson.
// Preserve display lettering as vector artwork; credits stay native text.
export function measureTitlePage(layout, grid, lines) {
  const source=layout.source?.blocks||[];
  if(layout.blocks.length>9||layout.blocks.some(b=>!['text','decor'].includes(b.type)))return false;
  const title=source.find(b=>b.type==='text'&&b.box?.h>.18&&/HSK/i.test(b.en||b.cn||''));
  const credits=lines.filter(l=>/主编|编者|出版社/.test(l.text));
  if(!title||credits.length<2)return false;
  const b=layout.blocks.find(b=>b.en===title.en);if(!b)return false;
  const english=lines.find(l=>l.text.trim()===title.en.trim());if(!english)return false;
  const pixels=grid.hi||grid;
  const {W,H}=pixels, q=title.box, end=Math.min(english.box.y-.004,q.y+q.h+.025);
  const x0=Math.max(0,Math.floor((q.x-.015)*W)),x1=Math.min(W-1,Math.ceil((q.x+q.w+.015)*W));
  const y0=Math.max(0,Math.floor((q.y-.015)*H)),y1=Math.min(H-1,Math.ceil(end*H));
  const runs=[],colors=[];let left=W,top=H,right=0,bottom=0;
  for(let y=y0;y<=y1;y++){
    let start=-1;
    for(let x=x0;x<=x1+1;x++){
      const p=x<=x1?pixels.at(x,y):[255,255,255];
      const ink=p[0]>120&&p[0]>p[1]*1.25&&p[0]>p[2]*1.2;
      if(ink&&start<0)start=x;
      if(ink&&x%5===0&&y%5===0)colors.push(p);
      if(!ink&&start>=0){if(x-start>=2){runs.push(`M${start} ${y}h${x-start}v1h${start-x}z`);left=Math.min(left,start);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y+1);}start=-1;}
    }
  }
  if(!runs.length)return false;
  const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
  const color=colors.length?'#'+[0,1,2].map(i=>median(colors.map(p=>p[i])).toString(16).padStart(2,'0')).join(''):'#e66b6b';
  b.titleArtwork={box:{x:left/W,y:top/H,w:(right-left)/W,h:(bottom-top)/H},viewBox:`${left} ${top} ${right-left} ${bottom-top}`,path:runs.join(''),color,label:title.cn};
  b.titlePageRole='title';b.box={...english.box,h:english.box.h*1.5};b.titleFont=english.box.h*H/W*100*.91;b.color=color;b.align='center';b.translationOnly=true;
  for(const c of layout.blocks.filter(c=>c!==b&&c.type==='text')){
    const matches=lines.filter(l=>l.box.y>.46&&l.text.trim().length>2&&c.cn.replace(/[\s：:]/g,'').includes(l.text.replace(/[\s：:]/g,'')));
    if(!matches.length)continue;
    const x=Math.min(...matches.map(l=>l.box.x)),y=Math.min(...matches.map(l=>l.box.y));
    const bottom=Math.max(...matches.map(l=>l.box.y+l.box.h));
    const next=layout.blocks.filter(o=>o!==c&&o!==b&&Math.abs(o.box.y-y)<.025&&o.box.x>x+.04).map(o=>o.box.x);
    const publisher=/出版社/.test(c.cn),right=publisher?x+(Math.max(...matches.map(l=>l.box.x+l.box.w))-x):Math.min(...next,.79);
    const width=publisher?Math.max(.42,right-x):Math.max(.1,right-x-.008);
    c.box={x:publisher?x+(right-x-width)/2:x,y,w:width,h:Math.max(.06,bottom-y+.035)};
    c.titlePageRole=publisher?'publisher':'credit';c.titleFont=(publisher?matches[0].box.h:Math.min(...matches.map(l=>l.box.h)))*H/W*100*.9;c.align=publisher?'center':'left';c.color=publisher?'#222222':'#777777';c.translationOnly=false;
    // Keep semantic fields unchanged so existing translations remain valid.
    // Source-only display lines preserve the publisher's three baselines.
    if(publisher){
      c.titleCn=c.cn.split('\n')[0];
      c.titleOriginalLines=lines.filter(l=>l.box.y>=y-.002&&l.box.y<bottom+.003&&l.box.x>=x-.005&&l.box.x+l.box.w<=x+c.box.w+.02)
        .map(l=>({box:l.box,text:/^FOREIGN/i.test(l.text)?c.en.split('\n')[0]:l.text.replace(/北京\s*BEIJING/,'北京 BEIJING')}));
    }
  }
  layout.titlePage=true;
  return true;
}
