// Restore a missed volume suffix only from another recognized cover in the same PDF.
export function restoreCoverVolume(ocr,prior,grid){
 const label=prior.lines.find(l=>/^[1-6][上下]$/.test(l.text));
 const digit=ocr.lines.find(l=>l.text===label?.text[0]&&l.confidence>.95&&l.position.height>.12);
 const end=ocr.lines.find(l=>/练习册|Workbook/i.test(l.text))?.position.x;
 if(!label||!digit||!end||ocr.lines.some(l=>l.text===label.text[1]))return false;
 const q=digit.position,x0=Math.floor((q.x+q.width*.55)*grid.W),x1=Math.floor((end-.006)*grid.W),y0=Math.floor((q.y+q.height*.45)*grid.H),y1=Math.floor((q.y+q.height+.005)*grid.H);
 const seen=new Set(),parts=[];
 for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
  const k=y*grid.W+x,p=grid.at(x,y);if(seen.has(k)||p.reduce((a,v)=>a+v,0)/3>190)continue;
  const todo=[[x,y]];seen.add(k);let left=x,right=x,top=y,bottom=y,count=0;
  while(todo.length){const [a,b]=todo.pop();count++;left=Math.min(left,a);right=Math.max(right,a);top=Math.min(top,b);bottom=Math.max(bottom,b);for(const [xx,yy] of [[a-1,b],[a+1,b],[a,b-1],[a,b+1]]){const key=yy*grid.W+xx;if(xx<x0||xx>=x1||yy<y0||yy>=y1||seen.has(key)||grid.at(xx,yy).reduce((s,v)=>s+v,0)/3>190)continue;seen.add(key);todo.push([xx,yy]);}}
  if(count>30&&(bottom-top)>grid.H*.025&&(bottom-top)<grid.H*.11&&left>x0+2)parts.push({left,right,top,bottom,count});
 }
 const c=parts.sort((a,b)=>b.right-a.right)[0];if(!c)return false;
 // A suffix must be a separate compact glyph, not a strip or digit fragment.
 const aspect=(c.right-c.left+1)/(c.bottom-c.top+1);if(aspect<.6||aspect>1.8)return false;
 ocr.lines.push({id:ocr.lines.length,text:label.text[1],confidence:null,position:{x:c.left/grid.W,y:c.top/grid.H,width:(c.right-c.left+1)/grid.W,height:(c.bottom-c.top+1)/grid.H},sourceEvidence:{samePdfCoverLabel:label.text,method:'separate-volume-glyph',requiresVisualReview:true}});return true;
}
