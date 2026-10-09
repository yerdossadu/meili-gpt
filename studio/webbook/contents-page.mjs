// A contents table is measured from its printed coloured bands, not a fixed
// row height. It remains native text in every language.
export function measureContentsPage(layout,grid){
 const b=layout.blocks.find(b=>b.type==='contents');if(!b)return false;
 const title=layout.blocks.find(o=>o.cn==='目录');if(title){title.contentsTitle=true;title.box={...(layout.source?.blocks.find(o=>o.cn==='目录')?.box||title.box)};delete title.exactTokens;}
 const q=layout.source?.blocks?.find(o=>o.type==='contents')?.box||b.box;
 const red=p=>p[0]>p[1]*1.1&&p[0]>p[2]*1.07&&p[0]>130&&p[1]<245;
 const bands=[];let start=null;
 for(let y=Math.floor(q.y*grid.H);y<=Math.ceil((q.y+q.h)*grid.H);y++){
  let count=0;for(let x=Math.floor((q.x+.02)*grid.W);x<(q.x+q.w-.02)*grid.W;x++)if(red(grid.at(x,Math.min(y,grid.H-1))))count++;
  const filled=count>q.w*grid.W*.65;
  if(filled&&start===null)start=y;if(!filled&&start!==null){if(y-start>grid.H*.015)bands.push([start/grid.H,y/grid.H]);start=null;}
 }
 if(start!==null)bands.push([start/grid.H,(q.y+q.h)]);
 // Header plus every other shaded row delimit all rows, including the last.
 if(bands.length===1+Math.floor(b.rows.length/2)){
  const edges=[bands[0][0],bands[0][1]];
  for(const band of bands.slice(1))edges.push(band[0],band[1]);
  if(edges.length===b.rows.length+1)edges.push(q.y+q.h);
  b.rowEdges=edges;b.box={...q,y:edges[0],h:edges.at(-1)-edges[0]};
 }
 b.rowEdges||=[q.y,...b.rows.map((_,i)=>q.y+q.h*(i+1)/(b.rows.length+1)),q.y+q.h];
 // Dashed vertical rules are white in the header and red in unshaded rows.
 const head=b.rowEdges[0],bottom=b.rowEdges[1],scores=[];
 for(let x=Math.floor((q.x+.04)*grid.W);x<(q.x+q.w-.08)*grid.W;x++){
  let white=0;for(let y=Math.ceil((head+.004)*grid.H);y<(bottom-.004)*grid.H;y++){const p=grid.at(x,y);if(p.every(c=>c>215))white++;}
  if(white>(bottom-head)*grid.H*.35)scores.push(x/grid.W);
 }
 const groups=[];for(const x of scores){if(groups.length&&x-groups.at(-1).at(-1)<.004)groups.at(-1).push(x);else groups.push([x]);}
 const rules=groups.filter(g=>g.length<grid.W*.012).map(g=>g[Math.floor(g.length/2)]);
 const expected=b.columns?.slice(1,-1)||[];
 const measured=expected.map(x=>rules.slice().sort((a,c)=>Math.abs(a-x)-Math.abs(c-x))[0]).filter((x,i)=>Math.abs(x-expected[i])<.015);
 if(measured.length===3)b.columns=[q.x,...measured,q.x+q.w];
 b.contentsMeasured=true;delete b.exactTokens;return true;
}
