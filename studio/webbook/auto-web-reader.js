let selected='',selectedSpeech='',player;
const selection=document.querySelector('#selection'),result=document.querySelector('#result');
document.querySelector('#showText').onchange=e=>document.body.classList.toggle('show-text',e.target.checked);
document.querySelectorAll('.word').forEach(word=>{const select=()=>{document.querySelector('.word.active')?.classList.remove('active');word.classList.add('active');selected=word.dataset.text;selectedSpeech=word.dataset.speech||'';selection.textContent=selected;};word.onclick=select;word.onfocus=select;});
document.addEventListener('selectionchange',()=>{const text=getSelection().toString().trim();if(text){selected=text;selectedSpeech='';selection.textContent=text;}});
document.querySelector('#speak').onclick=async()=>{
  if(!selected)return;player?.pause();speechSynthesis.cancel();
  // Keep the printed transcription selected; use its leading syllable for audio.
  const phonetic=selected.trim().toLowerCase().replace(/\s*\[[^\]]+\]$/, '').trim();
  if(/^(b|p|m|f|d|t|n|l|g|k|h|a|o|e|i|u|er|ai|ei|ao|ou|an|en|ang|eng|ong)$/.test(phonetic)){
    if(!player){player=document.createElement('audio');player.hidden=true;document.body.append(player);}player.src=`sounds/${phonetic}.mp3`;try{await player.play();result.textContent='';}catch{result.textContent='Запись звука недоступна.';}return;
  }
  const spoken=selectedSpeech||selected;
  if(!/[\u3400-\u9fff]/.test(spoken)){result.textContent='Для этого фрагмента нет проверенной записи китайского произношения.';return;}
  const voice=speechSynthesis.getVoices().find(v=>/^zh/i.test(v.lang));if(!voice){result.textContent='В браузере не установлен китайский голос.';return;}
  const utterance=new SpeechSynthesisUtterance(spoken);utterance.lang='zh-CN';utterance.voice=voice;speechSynthesis.speak(utterance);
};
document.querySelector('#translate').onclick=async()=>{
  if(!selected)return;result.textContent='Переводим…';
  try{const response=await fetch('/local/auto-web/translate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:selected})});if(!response.headers.get('content-type')?.includes('json'))throw new Error('Перевод доступен при открытии страницы через FS.');const data=await response.json();if(!response.ok)throw new Error(data.error);result.textContent=data.translation;}catch(e){result.textContent=e.message;}
};

const showIssues=document.querySelector('#showIssues');
if(showIssues)showIssues.onchange=e=>document.body.classList.toggle('show-issues',e.target.checked);
let issueIndex=-1;
const nextIssue=document.querySelector('#nextIssue');
if(nextIssue)nextIssue.onclick=()=>{const issues=[...document.querySelectorAll('.word.uncertain,.gap')];if(!issues.length){result.textContent='Явных сомнительных фрагментов нет. Полнота распознавания всё равно требует проверки.';return;}document.body.classList.add('show-issues');showIssues.checked=true;issueIndex=(issueIndex+1)%issues.length;issues[issueIndex].focus();issues[issueIndex].scrollIntoView({block:'center'});};

document.querySelectorAll('.gap').forEach(gap=>{gap.onfocus=gap.onclick=()=>{selected='';selection.textContent='Фрагмент не распознан';result.textContent='Здесь обнаружен печатный элемент без текста. Это может быть пропущенный символ или графика.';};});
