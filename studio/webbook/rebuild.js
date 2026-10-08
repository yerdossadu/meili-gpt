import {expansionBands,shiftedTop} from './rebuild-layout.mjs';
function fit(){const width=document.querySelector('.page').clientWidth;document.querySelectorAll('.glyph').forEach(n=>{n.style.transform='';const target=Number(n.dataset.width)*width/100;const actual=n.getBoundingClientRect().width;if(actual>0)n.style.transform=`scaleX(${Math.min(1,target/actual)})`;n.style.transformOrigin='left top';});}
document.fonts.ready.then(fit);window.addEventListener('resize',()=>{if(!document.body.classList.contains('translated'))fit();});
const blocks=[...document.querySelectorAll('[data-block]')];
const originals=blocks.map(b=>b.innerHTML);
const page=document.querySelector('.page'),nodes=[...page.children];
const sourceStyles=nodes.map(n=>n.getAttribute('style')),pageStyle=page.getAttribute('style');
let applied=null;
function resetGeometry(){page.setAttribute('style',pageStyle);nodes.forEach((n,i)=>n.setAttribute('style',sourceStyles[i]));}
function reflow(){
 resetGeometry();const width=page.clientWidth,height=page.clientHeight;
 const geometry=nodes.map(n=>({top:parseFloat(n.style.top)*height/100,height:parseFloat(n.style.height)*height/100}));
 const expanded=[];
 blocks.forEach((b,i)=>{if(!applied?.has(i))return;const index=nodes.indexOf(b),g=geometry[index];b.style.fontSize=b.dataset.font+'cqw';b.style.height='auto';expanded.push({...g,required:Math.max(g.height,b.scrollHeight)});});
 const bands=expansionBands(expanded);page.style.aspectRatio='auto';page.style.height=(height+bands.reduce((sum,b)=>sum+b.extra,0))+'px';
 nodes.forEach((n,i)=>{n.style.top=shiftedTop(geometry[i].top,bands)+'px';if(!n.classList.contains('translated-block'))n.style.height=geometry[i].height+'px';});
}
window.addEventListener('resize',()=>{if(applied)reflow();});
const texts=blocks.map(b=>[...b.querySelectorAll('.glyph')].map(n=>n.textContent).join(' ').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,'$1'));
const status=document.querySelector('#status'),run=document.querySelector('#translatePage');
document.querySelector('#restore').onclick=()=>{if(run.disabled)return;applied=null;blocks.forEach((b,i)=>{b.innerHTML=originals[i];b.classList.remove('translated-block');});resetGeometry();document.body.classList.remove('translated');fit();status.textContent='Исходный распознанный текст';};
run.onclick=async()=>{
 run.disabled=true;const language=document.querySelector('#language').value,translated=[];
 try{
  for(let i=0;i<texts.length;i++){
   if(texts[i].length<15){translated.push(texts[i]);continue;}
   status.textContent=`Перевод: ${i+1} / ${texts.length}`;
   const response=await fetch('/local/auto-web/translate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:texts[i],language})});
   const data=await response.json();if(!response.ok||!data.translation)throw new Error(data.error||'Пустой перевод');translated.push(data.translation);
  }
  applied=new Set();blocks.forEach((b,i)=>{b.innerHTML=originals[i];b.classList.remove('translated-block');if(texts[i].length>=15){b.textContent=translated[i];b.classList.add('translated-block');applied.add(i);}});document.body.classList.add('translated');reflow();status.textContent='Перевод готов. Исходный текст можно восстановить.';
 }catch(e){status.textContent='Перевод не применён: '+e.message;}finally{run.disabled=false;}
};

async function bindMedia(){
 const manifest=page.dataset.mediaManifest;if(!manifest)return;
 try{
  const response=await fetch(manifest);if(!response.ok)throw new Error('Нет описания карточек');const data=await response.json();
  for(const card of document.querySelectorAll('.media-card')){
   const item=data.cards.find(i=>i.id===card.dataset.mediaId);if(!item)continue;
   const select=()=>{document.querySelector('.media-card.selected')?.classList.remove('selected');card.classList.add('selected');status.textContent='Карточка: '+item.text.join(' ');card.dispatchEvent(new CustomEvent('study:media-select',{bubbles:true,detail:{id:item.id,text:item.text}}));};
   card.addEventListener('click',select);card.addEventListener('keydown',e=>{if(e.target===card&&['Enter',' '].includes(e.key)){e.preventDefault();select();}});
   for(const kind of ['audio','video']){if(!item[kind])continue;const url=new URL(item[kind],location.href);if(!['http:','https:','file:'].includes(url.protocol))continue;const player=document.createElement(kind);player.controls=true;player.preload='none';player.src=url.href;if(kind==='video')player.poster=item.image;card.append(player);}
  }
 }catch(e){status.textContent='Карточки: '+e.message;}
}
bindMedia();
