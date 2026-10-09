// Keep source coordinates intact. Translations need their own readable rows,
// rather than taking width away from the Chinese sentence beside them.
export function dialoguePresentation(layout){
 const ratio=layout.page.height/layout.page.width,positions=new Map(),groups=[];
 const blocks=layout.blocks.filter(b=>b.optionTurns?.length).sort((a,b)=>a.box.y-b.box.y);
 for(const b of blocks){let row=groups.find(g=>Math.abs(g.sourceY-b.box.y)<.018);if(!row){row={sourceY:b.box.y,blocks:[]};groups.push(row);}row.blocks.push(b);}
 let end=0;
 for(const group of groups){const y=Math.max(group.sourceY,end+.012);let height=0;
  for(const b of group.blocks){const h=b.optionTurns.reduce((sum,t)=>{const translations=[t.translation?.ru,t.translation?.en,t.translation?.kk].filter(Boolean),length=Math.max(0,...translations.map(s=>Array.from(s).length));const lines=Math.max(1,Math.ceil(length*.008/b.box.w));return sum+(.016+.029+.019*lines+.014)/ratio;},0);positions.set(b,{y,h});height=Math.max(height,h);}
  end=y+height;
 }
 // Page numbers and scan decorations are anchored to the original page,
 // not to the preceding exercise. Moving them would push the folio outside.
 const movable=b=>!['folio','decor','runhead'].includes(b.type);
 if(blocks.length){const sourceEnd=Math.max(...blocks.map(b=>b.box.y+b.box.h)),next=layout.blocks.filter(b=>movable(b)&&!positions.has(b)&&b.box.y>=sourceEnd).sort((a,b)=>a.box.y-b.box.y)[0];if(next&&end+.012>next.box.y){const shift=end+.012-next.box.y;for(const b of layout.blocks)if(movable(b)&&!positions.has(b)&&b.box.y>=next.box.y)positions.set(b,{y:b.box.y+shift,h:b.box.h});}}
 return positions;
}
