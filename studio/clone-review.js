/* PNG -> editable DOM -> rendered PNG -> bounded vision corrections. */
window.FormaCloneReview = (() => {
  const color = v => /^#[0-9a-f]{6}$/i.test(v || '') ? v : null;
  function position(v) {
    if (!v) return null;
    const a = ['x','y','width','height'].map(k => Number(v[k]));
    if (!a.every(Number.isFinite) || a[0]<0 || a[1]<0 || a[2]<=0 || a[3]<=0 || a[0]+a[2]>1.001 || a[1]+a[3]>1.001) return null;
    return Object.fromEntries(['x','y','width','height'].map((k,i)=>[k,a[i]]));
  }
  async function snapshot(root) {
    await document.fonts.ready;
    const copy=root.cloneNode(true), originals=[root,...root.querySelectorAll('*')], copies=[copy,...copy.querySelectorAll('*')];
    for(let i=0;i<originals.length;i++) {
      const css=getComputedStyle(originals[i]);
      copies[i].style.cssText=Array.from(css).map(k=>k+':'+css.getPropertyValue(k)+';').join('');
      copies[i].removeAttribute('contenteditable');
      if(copies[i].tagName==='IMG' && originals[i].src) {
        const blob=await fetch(originals[i].src).then(r=>r.blob());
        copies[i].src=await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(f.result);f.onerror=reject;f.readAsDataURL(blob)});
      }
    }
    copy.querySelectorAll('.ebook-png-qa-overlay,button,[data-editor-only]').forEach(n=>n.remove());
    const {width,height}=root.getBoundingClientRect();
    if(width<10||height<10)throw Error('Страница скрыта: откройте электронный учебник для визуальной проверки.');
    Object.assign(copy.style,{position:'relative',left:'0',top:'0',margin:'0',transform:'none',width:width+'px',height:height+'px'});
    const xml=new XMLSerializer().serializeToString(copy);
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%">'+xml+'</foreignObject></svg>';
    const invalid=new DOMParser().parseFromString(svg,'image/svg+xml').querySelector('parsererror');
    if(invalid){const at=Number(invalid.textContent.match(/column (\d+)/)?.[1]||0);throw Error('Ошибка сериализации HTML: '+invalid.textContent.slice(0,180)+' / '+svg.slice(Math.max(0,at-100),at+80));}
    const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await img.decode();
    const canvas=document.createElement('canvas');canvas.width=Math.round(width*2);canvas.height=Math.round(height*2);
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png');
  }
  function patch(clone, changes) {
    let count=0;
    for(const change of (changes.lines||[]).slice(0,200)) {
      const line=clone.lines.find(x=>x.id===Number(change.id));if(!line)continue;
      const p=position(change.position);if(p){line.position=p;if(line.style)line.style.fontSizePt=0;count++}
      const s=change.style||{};line.style||={};
      if(color(s.color))line.style.color=s.color;
      for(const k of ['bold','italic'])if(typeof s[k]==='boolean')line.style[k]=s[k];
      if(['left','center','right'].includes(s.align))line.style.align=s.align;
      if(Number.isFinite(Number(s.fontSizeScale)))line.style.fontSizeScale=Math.min(1.5,Math.max(.6,Number(s.fontSizeScale)));
      if(['Arial','Microsoft YaHei','SimSun','STKaiti','Times New Roman'].includes(s.fontName))line.style.fontName=s.fontName;
      count++;
    }
    for(const change of (changes.regions||[]).slice(0,80)) {
      const region=clone.regions[Number(change.index)];if(!region)continue;
      const p=position(change.position);if(p)region.position=p;
      for(const k of ['fill','stroke'])if(color(change[k]))region[k]=change[k];
      if(Number.isFinite(Number(change.radius)))region.radius=Math.min(20,Math.max(0,Number(change.radius)));
      count++;
    }
    for(const item of (changes.addRegions||[]).slice(0,30)) {
      const p=position(item.position);
      if(!p||!['panel','banner','line','illustration'].includes(item.kind))continue;
      clone.regions.push({kind:item.kind,position:p,fill:color(item.fill)||'',stroke:color(item.stroke)||'',radius:Math.min(20,Math.max(0,Number(item.radius)||0))});count++;
    }
    clone.mediaPosition=clone.regions.find(x=>x.kind==='illustration')?.position||clone.mediaPosition;
    return count;
  }
  async function snapPanels(clone, source) {
    if(clone.vectorArtwork)return;
    if(clone.pixelGeometry&&!clone.pixelGeometry.version&&clone.review?.previousLayout?.regions)clone.regions=structuredClone(clone.review.previousLayout.regions);
    const img=new Image();img.src=source;await img.decode();
    const canvas=document.createElement('canvas'),w=600,h=Math.round(600*img.height/img.width);canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,w,h);
    const pixels=ctx.getImageData(0,0,w,h).data,mask=new Uint8Array(w*h),seen=new Uint8Array(w*h);
    for(let n=0;n<mask.length;n++){const r=pixels[n*4],g=pixels[n*4+1],b=pixels[n*4+2];if(r>g+18&&r>b+15&&r>130)mask[n]=g<165?1:2}
    const components=[];
    for(let start=0;start<mask.length;start++){
      if(!mask[start]||seen[start])continue;const type=mask[start],queue=[start];seen[start]=1;let count=0,minX=w,maxX=0,minY=h,maxY=0;
      for(let q=0;q<queue.length;q++){const n=queue[q],x=n%w,y=Math.floor(n/w);count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        for(const next of [x>0?n-1:-1,x<w-1?n+1:-1,y>0?n-w:-1,y<h-1?n+w:-1])if(next>=0&&!seen[next]&&mask[next]===type){seen[next]=1;queue.push(next)}
      }
      const width=maxX-minX+1,height=maxY-minY+1,area=width*height;
      if(count>w*h*.002&&count/area>.45&&width>w*.08&&height>h*.018)components.push({type,position:{x:minX/w,y:minY/h,width:width/w,height:height/h}});
    }
    const used=new Set();let snapped=0;
    for(const region of [...clone.regions].sort((a,b)=>b.position.width*b.position.height-a.position.width*a.position.height)){
      if(!['panel','banner'].includes(region.kind)||!color(region.fill))continue;
      const r=parseInt(region.fill.slice(1,3),16),g=parseInt(region.fill.slice(3,5),16),b=parseInt(region.fill.slice(5,7),16);if(r<g+12||r<b+10)continue;
      const p=region.position;if(p.width*p.height<.002)continue;let best=null,bestScore=.1;
      for(const c of components){if(used.has(c)||c.type!==(g<165?1:2))continue;const q=c.position,intersection=Math.max(0,Math.min(p.x+p.width,q.x+q.width)-Math.max(p.x,q.x))*Math.max(0,Math.min(p.y+p.height,q.y+q.height)-Math.max(p.y,q.y)),score=intersection/(p.width*p.height+q.width*q.height-intersection);if(score>bestScore){bestScore=score;best=c}}
      if(best){region.position={...best.position};used.add(best);snapped++}
    }
    clone.pixelGeometry={version:3,snappedPanels:snapped,detectedPanels:components.length};
  }
  async function vectorize(clone,source,ocr) {
    if(clone.vectorArtwork?.version===3)return;
    const response=await fetch('http://127.0.0.1:4181/vectorize?page=1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:source,lines:ocr?.lines||clone.lines,regions:clone.previousVectorLayout?.regions||clone.regions}),signal:AbortSignal.timeout(90000)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось извлечь контуры PNG');
    clone.previousVectorLayout||={regions:structuredClone(clone.regions),lines:structuredClone(clone.lines)};
    clone.vectorArtwork=result;clone.regions=result.regions;
    clone.mediaPosition=[...result.regions].sort((a,b)=>b.position.width*b.position.height-a.position.width*a.position.height)[0]?.position;
    const byId=new Map((ocr?.lines||[]).map(line=>[line.id,line]));
    const typeById=new Map((result.typography||[]).map(style=>[style.id,style]));
    for(const line of clone.lines){const original=byId.get(line.id);if(original){line.position={...original.position};line.style.fontSizePt=0}if(typeById.has(line.id))Object.assign(line.style,typeById.get(line.id))}
  }
  async function run({clone,source,model,render,root,save,status,parse}) {
    clone.review={status:'running',rounds:[],note:'Оценка модели, не процент пиксельного совпадения'};save();
    // Two correction passes followed by a final comparison. Never an unbounded paid loop.
    for(let round=0;round<3;round++) {
      await snapPanels(clone,source);await render();status('Визуальная проверка '+(round+1)+'/3: сравниваю PNG и отрисованный HTML через '+model+'…');
      const rendered=await snapshot(root());
      const response=await window.json('chat/completions',{model,temperature:0.1,reasoning:{max_tokens:1024},max_tokens:10000,messages:[{role:'user',content:[
        {type:'text',text:'Compare image 1 (source textbook) to image 2 (actual editable HTML render). Ignore intentional removal of pinyin, Russian replacing English, replacement character references. Check geometry, font size, colors, missing blocks and overlaps. Do not modify text. Return JSON {"issues":["specific discrepancy in Russian"],"acceptable":false,"lines":[{"id":0,"position":{"x":0.1,"y":0.1,"width":0.2,"height":0.03},"style":{"fontSizeScale":1,"fontName":"SimSun","color":"#222222"}}],"regions":[{"index":0,"position":{},"fill":"#ffffff"}]}. Positions normalized 0..1. For missing graphic shapes add addRegions:[{kind:"panel",position:{x:0,y:0,width:0.1,height:0.1},fill:"#ffffff",stroke:"#ff0000",radius:0}]. Never add full-page raster. Only necessary corrections; no HTML or scripts. '+(round===2?'Final audit only: return empty correction arrays. ':'')+'Current layout: '+JSON.stringify({page:clone.page,lines:clone.lines,regions:clone.regions})},
        {type:'image_url',image_url:{url:source}},{type:'image_url',image_url:{url:rendered}}
      ]}]},{signal:AbortSignal.timeout(240000)});
      if(response.choices?.[0]?.finish_reason==='length')throw Error('Ответ визуальной проверки обрезан; сохранён последний черновик.');
      const report=parse(response.choices?.[0]?.message?.content);
      clone.cost=Number(clone.cost||0)+Number(response.usage?.cost||0);
      const issues=Array.isArray(report.issues)?report.issues.map(String):['Модель не вернула список замечаний'];
      clone.review.rounds.push({round:round+1,issues,cost:response.usage?.cost??null,at:new Date().toISOString()});save();
      if(report.acceptable===true&&issues.length===0){clone.review.status='reviewed';save();return}
      if(round===2)break;
      clone.review.previousLayout={lines:structuredClone(clone.lines),regions:structuredClone(clone.regions)};
      const applied=patch(clone,report);clone.review.rounds.at(-1).appliedChanges=applied;
      if(!applied)break;
      save();
    }
    clone.review.status='needs-review';save();await render();
  }
  return {run,snapshot,snapPanels,vectorize};
})();
