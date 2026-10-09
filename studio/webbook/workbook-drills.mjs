const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?(s[Math.floor(s.length/2)]+s[Math.floor((s.length-1)/2)])/2:NaN;};
const normalize=s=>s.normalize('NFD').replace(/\u0306/g,'\u030c').normalize('NFC');
const base=s=>normalize(s).normalize('NFD').replace(/[\u0304\u0301\u030c\u0300]/g,'').normalize('NFC').toLowerCase();

// A reading exercise can be returned as one syllable per line, including a
// final row of unrelated syllables. Recover rows from OCR, never reorder by tone.
export function measureReadingGrid(b,lines){
  if(b.toneRows||b.exactTokens||!['text','para'].includes(b.type))return null;
  const values=String(b.cn||b.py||'').trim().split(/\s+/).map(normalize);
  if(values.length<4||values.some(s=>! /^(?=.*[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ])[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/u.test(s)))return null;
  const near=lines.filter(l=>l.box.y>=b.box.y-.015&&l.box.y<b.box.y+b.box.h+.015&&l.box.x>=b.box.x-.02&&l.box.x<b.box.x+b.box.w+.02);
  const used=new Set(),cells=values.map(text=>({text}));
  for(const c of cells){const found=near.find(l=>!used.has(l)&&normalize(l.text.trim())===c.text);if(found){used.add(found);c.source=found;}}
  for(const c of cells.filter(c=>!c.source)){
    const found=near.find(l=>!used.has(l)&&base(l.text.trim())===base(c.text)&&(l.confidence??1)>=.9);
    if(found){used.add(found);c.ocrText=c.text;c.text=normalize(found.text.trim());c.source=found;}
  }
  for(const c of cells.filter(c=>!c.source&&base(c.text).includes('ü'))){const found=near.find(l=>!used.has(l)&&base(l.text.trim())===base(c.text).replace(/ü/g,'u'));if(found){used.add(found);c.source=found;}}
  if(cells.filter(c=>c.source).length<values.length*.7)return null;
  const rows=[];
  for(let i=0;i<cells.length;){
    const quartet=cells.slice(i,i+4);
    if(quartet.length===4&&quartet.every(c=>base(c.text)===base(quartet[0].text))&&!(cells[i+4]?.source&&quartet.some(c=>c.source&&Math.abs(c.source.box.y-cells[i+4].source.box.y)<.012))){rows.push(quartet);i+=4;continue;}
    const row=[],first=cells[i].source;if(!first)return null;
    while(i<cells.length&&cells[i].source&&Math.abs(cells[i].source.box.y-first.box.y)<.012)row.push(cells[i++]);
    rows.push(row);
  }
  const centres=rows.map(row=>median(row.filter(c=>c.source).map(c=>c.source.box.y+c.source.box.h/2)));
  const pitch=rows.length>1?median(centres.slice(1).map((y,i)=>y-centres[i])):0,start=median(centres.map((y,i)=>y-i*pitch));
  if(!Number.isFinite(start)||(rows.length>1&&pitch<=0))return null;
  const columns=Array.from({length:Math.max(...rows.map(r=>r.length))},(_,i)=>median(rows.flatMap(r=>r[i]?.source?[r[i].source.box.x]:[])));
  if(columns.some(x=>!Number.isFinite(x)))return null;
  const readingTokens=rows.flatMap((row,r)=>row.map((c,col)=>({text:c.text,row:r,column:col,box:{x:columns[col],y:start+r*pitch-.011,w:Math.max(.025,(c.source?.box.w||.025)),h:.022},...(c.ocrText?{semanticText:c.ocrText,source:'ocr-tone-correction'}:{}),...(!c.source?{source:'semantic-cell-measured-column'}:{})})));
  return {readingTokens,readingSource:'semantic-text + OCR rows and columns'};
}

// Correct source-aligned cells, never by a global letter replacement. Missing
// narrow initials require visible ink at an otherwise empty lattice position.
export function reconcileAnswerGrid(b,lines,grid){
  if(!b.py?.includes('___')||!b.gridX?.length||!b.gridY?.length)return null;
  const rows=b.py.split('\n').map(r=>r.trim().split(/\s+/).map(normalize)),X=b.gridX,Y=b.gridY;
  if(rows.length!==Y.length)return null;
  const leading=rows.every(r=>r.every(s=>s.startsWith('___'))),trailing=rows.every(r=>r.every(s=>s.endsWith('___')));
  if(!leading&&!trailing)return null;
  const evidence=[];const next=Y.map((y,r)=>X.map((x,c)=>{
    const original=rows[r][c]||'',old=original.replace(/_/g,'');
    const found=lines.filter(l=>Math.abs(l.box.x-x)<.025&&Math.abs(l.box.y+l.box.h/2-y)<.012).sort((a,b)=>Math.abs(a.box.x-x)-Math.abs(b.box.x-x))[0];
    let value=old;
    if(found){
      const text=normalize(found.text.trim());
      // Initials have a closed alphabet; low-confidence O must not replace d.
      const valid=leading?/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/u.test(text):/^(?:b|p|m|f|d|t|n|l|g|k|h|j|q|x|zh|ch|sh|r|z|c|s)$/.test(text);
      if(valid&&(found.confidence??1)>=.8){value=text;if(value!==old)evidence.push({row:r,column:c,before:old,after:value,source:'ocr-cell',box:found.box});}
    }
    const displaced=rows[r].length<X.length&&(!original||lines.some(l=>normalize(l.text.trim())===old&&Math.abs(l.box.y+l.box.h/2-y)<.012&&Math.abs(l.box.x-x)>.04));
    if(trailing&&!found&&displaced&&grid){
      const g=grid.hi||grid.raw||grid,pts=[];
      for(let yy=Math.floor((y-.012)*g.H);yy<(y+.006)*g.H;yy++)for(let xx=Math.floor((x-.006)*g.W);xx<(x+.03)*g.W;xx++){
        if(xx<0||xx>=g.W||yy<0||yy>=g.H)continue;
        if(Math.max(...g.at(xx,yy))<140)pts.push([xx/g.W,yy/g.H]);
      }
      // A nearby answer rule is horizontal; exclude it before measuring the
      // missing initial's vertical stroke.
      const counts=new Map();for(const p of pts){const x=Math.round(p[0]*g.W);counts.set(x,(counts.get(x)||0)+1);}
      const stems=pts.filter(p=>(counts.get(Math.round(p[0]*g.W))||0)>g.H*.007);
      if(stems.length){const w=Math.max(...stems.map(p=>p[0]))-Math.min(...stems.map(p=>p[0])),h=Math.max(...stems.map(p=>p[1]))-Math.min(...stems.map(p=>p[1]));
        if(h>.007&&w/h<.5){value='l';evidence.push({row:r,column:c,before:old,after:value,source:'printed-vertical-initial'});}
      }
    }
    return leading?'___'+value:value+'___';
  }));
  // Do not shift a final known token left when the model omitted a cell.
  const pitch=median(Y.slice(1).map((y,i)=>y-Y[i])),start=median(Y.map((y,i)=>y-i*pitch));
  return {py:next.map(r=>r.join('\t')).join('\n'),gridY:Y.map((_,i)=>start+i*pitch),drillCorrections:evidence,drillManual:true};
}

// Explicit semantic rows survive sparse OCR. Locate their lattice without
// assigning repeated letters globally or treating answer blanks as tone drills.
export function measureAnswerLattice(b,source,lines){
 if(b.type!=='text'||!b.py?.includes('\t')||!b.py.includes('___'))return null;
 const rows=b.py.split('\n').map(r=>r.split('\t')),R=rows.length,C=Math.max(...rows.map(r=>r.length)),q=source?.box||b.box;
 // Models can put the box at the first answer rule, to the right of its
 // printed initial. Include that initial before inferring column count.
 const trailing=rows.every(r=>r.every(s=>s.endsWith('___')));
 const near=lines.filter(l=>l.box.x>=q.x-(trailing?.06:.008)&&l.box.x<q.x+q.w+.02&&l.box.y>=q.y-.012&&l.box.y+l.box.h/2<q.y+q.h+.008&&/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/i.test(l.text.trim()));
 const group=(values,gap)=>{const groups=[];for(const v of values.sort((a,b)=>a-b)){const g=groups.at(-1);if(g&&v-median(g)<gap)g.push(v);else groups.push([v]);}return groups.map(median)};
 let X=group(near.map(l=>l.box.x),.025),Y=group(near.map(l=>l.box.y+l.box.h/2),.012);
 if(Y.length!==R||X.length<Math.ceil(C/2)||X.length>C)return null;
 if(X.length<C){const pitch=median(X.slice(1).map((x,i)=>x-X[i]));if(!Number.isFinite(pitch)||pitch<.05)return null;while(X.length<C)X.push(X.at(-1)+pitch);}
 return {gridX:X,gridY:Y,drillManual:true,box:{x:Math.min(q.x,X[0]-.005),y:Y[0]-.013,w:Math.max(q.x+q.w,X.at(-1)+.07)-Math.min(q.x,X[0]-.005),h:Y.at(-1)-Y[0]+.026},drillSource:'semantic rows + sparse OCR lattice'};
}

export const dialogueLabels={
  '你好':{ru:'Привет!',kk:'Сәлем!',en:'Hello!'},
  '你们好':{ru:'Здравствуйте!',kk:'Сәлеметсіздер ме!',en:'Hello, everyone!'},
  '谢谢':{ru:'Спасибо!',kk:'Рақмет!',en:'Thank you!'},
  '不客气':{ru:'Пожалуйста!',kk:'Оқасы жоқ!',en:"You're welcome!"},
  '老师再见':{ru:'До свидания, учитель!',kk:'Сау болыңыз, мұғалім!',en:'Goodbye, teacher!'},
  '再见':{ru:'До свидания!',kk:'Сау болыңыз!',en:'Goodbye!'},
  '对不起':{ru:'Извините.',kk:'Кешіріңіз.',en:'Sorry.'},
  '没关系':{ru:'Ничего страшного.',kk:'Оқасы жоқ.',en:"That’s OK."},
  '很高兴认识你':{ru:'Приятно познакомиться.',kk:'Танысқаныма қуаныштымын.',en:'Nice to meet you.'},
  '认识你我也很高兴':{ru:'Мне тоже приятно познакомиться.',kk:'Мен де танысқаныма қуаныштымын.',en:'Nice to meet you too.'},
  '大家好我叫白家月':{ru:'Всем привет! Я Бай Цзяюэ.',kk:'Бәріне сәлем! Менің атым Бай Цзяюэ.',en:'Hello, everyone! My name is Bai Jiayue.'},
  '白家月你好':{ru:'Привет, Бай Цзяюэ.',kk:'Сәлем, Бай Цзяюэ.',en:'Hello, Bai Jiayue.'}
};
const han=s=>String(s||'').replace(/[^\p{Script=Han}]/gu,'');
export function measureDialogueOptions(b,lines){
  if(!b.dialogueOptions)return null;
  const near=lines.filter(l=>l.box.x>b.box.x-.02&&l.box.x<b.box.x+b.box.w+.01&&l.box.y>b.box.y-.015&&l.box.y<b.box.y+b.box.h+.015);
  const used=new Set(),turns=b.dialogueOptions.map(t=>{
    const cn=near.find(l=>!used.has(l)&&new RegExp('^'+t.speaker+'[：:]').test(l.text)&&han(l.text)===han(t.hz));
    if(!cn)return null;used.add(cn);
    const py=near.filter(l=>l.box.y<cn.box.y&&!/[A-Z][：:]|\p{Script=Han}/u.test(l.text)&&/[a-zāáǎà]/i.test(l.text)).sort((a,c)=>c.box.y-a.box.y)[0];
    return {...t,cnBox:cn.box,pyBox:py?.box,translation:t.ru?{ru:t.ru,en:t.en,kk:t.kk}:dialogueLabels[han(t.hz)]};
  });
  return turns.every(Boolean)?{optionTurns:turns}:null;
}

export function clipImagesBeforeText(blocks,lines){
  for(const img of blocks.filter(b=>b.type==='image'&&!b.caption)){
    const candidates=blocks.filter(b=>b.dialogueOptions&&b.box.x<img.box.x+img.box.w&&b.box.x+b.box.w>img.box.x);
    const text=candidates.flatMap(b=>lines.filter(l=>l.box.x>img.box.x&&l.box.x<img.box.x+img.box.w&&l.box.y>img.box.y+img.box.h*.3&&l.box.y<b.box.y+b.box.h&&(/^[A-Z][：:]/.test(l.text)||/^(Nǐ|Xiè|Bú)/.test(l.text))));
    if(text.length){const end=Math.min(...text.map(l=>l.box.y))-.01;if(end>img.box.y+.035&&end<img.box.y+img.box.h){img.box={...img.box,h:end-img.box.y};delete img.frame;}}
  }
  // Printed matching strips share their frames even when a pale photograph
  // floods down to just its dark subject. Use the intact peer plus the source
  // speaker columns, rather than stretching the subject's bounding box.
  const options=blocks.filter(b=>b.optionTurns?.length).sort((a,b)=>a.optionTurns[0].cnBox.x-b.optionTurns[0].cnBox.x);
  const photos=blocks.filter(b=>b.type==='image'&&!b.caption).sort((a,b)=>a.box.x-b.box.x);
  if(options.length>=3&&photos.length===options.length&&options.every((b,i)=>i===0||b.optionTurns[0].cnBox.x-options[i-1].optionTurns[0].cnBox.x>.1)){
    const first=photos[0],base=options[0].optionTurns[0].cnBox;
    if(first.box.w>.18&&first.box.w<.35&&first.box.h>.05&&first.box.h<.15&&photos.every(p=>Math.abs(p.box.y-first.box.y)<.05)){
      const offset=first.box.x-base.x,top=first.box.y,bottom=Math.min(...options.map(b=>b.optionTurns[0].pyBox?.y??b.optionTurns[0].cnBox.y))-.006;
      photos.forEach((p,i)=>{p.box={x:options[i].optionTurns[0].cnBox.x+offset,y:top,w:first.box.w,h:bottom-top};p.matchingInput=true;delete p.frame;});
    }
  }
}
