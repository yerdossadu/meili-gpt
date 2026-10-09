// Multi-scale OCR for display lettering too large for the normal detector.
export async function supplementDisplayOcr(png,ocr,{canvas,recognize}){
 if(!ocr.lines?.some(l=>l.text.includes('标准教程')))return ocr;
 const img=await canvas.loadImage(png),lines=[...ocr.lines];
 for(const width of [500,250,500]){
  const c=canvas.createCanvas(width,Math.round(img.height/img.width*width));c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  if(width===500&&lines.some(l=>l.text==='HSK')&&!lines.some(l=>/^[1-6][上下]$/.test(l.text))){const ctx=c.getContext('2d'),pixels=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<pixels.data.length;i+=4){const gray=(pixels.data[i]+pixels.data[i+1]+pixels.data[i+2])/3,v=gray<180?0:255;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;}ctx.putImageData(pixels,0,0);}
  const extra=await recognize(await c.encode('png'));
  for(const l of extra.lines||[]){if(!/^(HSK|[1-6][上下])$/i.test(l.text.trim()))continue;
   if(lines.some(o=>o.text===l.text&&o.position.height>.1))continue;
   lines.push({...l,id:lines.length,displayEvidence:{width,engine:extra.engine}});
  }
 }
 if(!lines.some(l=>/^[1-6][上下]$/.test(l.text))){const head=lines.find(l=>l.text==='HSK');if(head){const y=head.position.y+head.position.height,end=.9;if(y<end){const c=canvas.createCanvas(150,Math.round(img.height*(end-y)/img.width*150)),ctx=c.getContext('2d');ctx.drawImage(img,0,y*img.height,img.width,(end-y)*img.height,0,0,c.width,c.height);const d=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<d.data.length;i+=4){const v=d.data[i]<180?0:255;d.data[i]=d.data[i+1]=d.data[i+2]=v;}ctx.putImageData(d,0,0);const extra=await recognize(await c.encode('png'));for(const l of extra.lines||[])if(/^[1-6]$/.test(l.text)&&l.confidence>.95&&!lines.some(a=>a.text===l.text&&a.position.height>.12))lines.push({...l,id:lines.length,position:{...l.position,y:y+l.position.y*(end-y),height:l.position.height*(end-y)},displayEvidence:{cropAfterHSK:true}});}}}
 return {...ocr,lines,displayOcr:true};
}
