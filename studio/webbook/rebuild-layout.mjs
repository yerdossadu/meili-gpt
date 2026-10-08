// Insert space after expanded text rows. Side-by-side blocks share one expansion.
export function expansionBands(items){
 const rows=[];
 for(const item of [...items].sort((a,b)=>a.top-b.top)){
  if(!(item.height>0)||!Number.isFinite(item.required))continue;
  let row=rows.find(r=>item.top<r.end-1&&item.top+item.height>r.start+1);
  if(!row){row={start:item.top,end:item.top+item.height,extra:0};rows.push(row);}
  row.end=Math.max(row.end,item.top+item.height);
  row.extra=Math.max(row.extra,Math.max(0,item.required-item.height));
 }
 return rows.filter(r=>r.extra>0).sort((a,b)=>a.end-b.end);
}
export function shiftedTop(top,bands){return top+bands.filter(b=>b.end<=top+1).reduce((sum,b)=>sum+b.extra,0);}
