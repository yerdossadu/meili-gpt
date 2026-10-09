// Read-only browser audit. Pixel resemblance alone cannot prove readable,
// translated and interactive educational content.
export function auditRenderedPage(){
 const page=document.querySelector('.hsk-page');if(!page)return{error:'No native web page'};
 const frame=page.getBoundingClientRect(),visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';},findings=[];
 for(const e of page.querySelectorAll('span,button,input,img')){if(!visible(e))continue;const r=e.getBoundingClientRect(),s=getComputedStyle(e),text=(e.textContent||e.getAttribute('aria-label')||e.getAttribute('alt')||'').trim();if(!text&&e.tagName!=='IMG')continue;
  if(r.left<frame.left-3||r.right>frame.right+3||r.bottom>frame.bottom+3)findings.push({kind:'outside-page',text:text.slice(0,65),className:e.className});
  if(e.tagName==='IMG'&&(!e.complete||!e.naturalWidth))findings.push({kind:'missing-image',text});
  if((e.matches('.hsk-option-meaning,.hsk-option-translation,.hsk-sandhi-rule'))&&(s.fontSize.replace(/px$/,"")*1)/frame.width<.012)findings.push({kind:'small-educational-text',text,font:(s.fontSize.replace(/px$/,"")*1)/frame.width*100});
  if(e.matches('button,input,.hsk-option-meaning')&&e.scrollWidth>e.clientWidth+3)findings.push({kind:'clipped-control-or-translation',text:text.slice(0,65),className:e.className});
 }
 return{title:document.title,language:page.dataset.en==='on'?'en':page.dataset.kz==='on'?'kz':page.dataset.lang,conversionId:page.dataset.conversionId||null,findings,englishLayers:page.querySelectorAll('[data-en]').length,kazakhLayers:page.querySelectorAll('[data-kz]').length,buttons:page.querySelectorAll('button').length,inputs:page.querySelectorAll('input').length,loadedFonts:document.fonts.status};
}
