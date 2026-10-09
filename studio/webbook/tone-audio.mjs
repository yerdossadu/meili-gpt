// Tone marks are pronunciation data, not browser TTS hints.
export function toneKey(value) {
  const text=String(value||'').trim().toLowerCase().normalize('NFD');
  const marks=[...text].filter(c=>'\u0304\u0301\u030c\u0300'.includes(c));
  if(marks.length!==1)return null;
  const tone='\u0304\u0301\u030c\u0300'.indexOf(marks[0])+1;
  const syllable=text.replace(/[\u0304\u0301\u030c\u0300]/g,'').normalize('NFC');
  if(!/^(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(?:a|o|e|ai|ei|ao|ou|an|en|ang|eng|ong|i|ia|ie|iao|iu|ian|in|iang|ing|iong|u|ua|uo|uai|ui|uan|un|uang|ueng|ü|üe|üan|ün|er)$/.test(syllable))return null;
  return syllable.replace(/ü/g,'v')+tone;
}
export function toneRecordings(layout) {
  return [...new Set((layout.blocks||[]).flatMap(b=>[...(b.toneRows||[]).flat(),...(b.readingTokens||[]).map(t=>t.text),...(b.numberedPhonetics||[]).map(t=>t.text),...(!b.toneAnswers?(b.phraseCells||[]).map(t=>t.text):[]),...(b.sandhiRows||[]).map(r=>r.py.split('→')[0].replace(/\s*\+\s*/g,'').trim())]).map(recordingKey).filter(Boolean))];
}
export const wordRecordingKeys={"pěngchǎng":"word-pengchang-33","hǎojiǔ":"word-haojiu-33","wǎndiǎn":"word-wandian-33","liǎojiě":"word-liaojie-33","xǐzǎo":"word-xizao-33","zhǐyǒu":"word-zhiyou-33","bāozi":"word-baozi-1","xièxie":"word-xiexie-4","piányi":"word-pianyi-2","dìdi":"word-didi-4","piàoliang":"word-piaoliang-4","méiguānxi":"word-meiguanxi-21","duìbuqǐ":"word-duibuqi-43","duibuqǐ":"word-duibuqi-43","rènshi":"word-renshi-4","sūnzǐ":"word-sunzi-13","sūnzi":"word-sunzi-1","dōngxī":"word-dongxi-11","dōngxi":"word-dongxi-1","yùnqì":"word-yunqi-44","yùnqi":"word-yunqi-4","lǎozǐ":"word-laozi-33","lǎozi":"word-laozi-3","dìfāng":"word-difang-41","difāng":"word-difang-41","dìfang":"word-difang-4","mǎmǎhūhū":"word-mamahuhu-3311","mǎhu":"word-mahu-3",'yóuyǒng':'you2-yong3','lǚyóu':'lv3-you2','péngyou':'pengyou','shuǐguǒ':'shui2-guo3','nǐhǎo':'ni2-hao3','kěyǐ':'ke2-yi3','nǎlǐ':'na2-li3','hěnhǎo':'hen2-hao3','suǒyǐ':'suo2-yi3','qǐngnǐ':'qing2-ni3','shǒubiǎo':'shou2-biao3','xiǎoyǔ':'xiao2-yu3'};
export const recordingKey=value=>wordRecordingKeys[String(value).replace(/\s+/g,'').toLowerCase()]||wordRecordingKeys[value]||toneKey(value)||null;
export const phoneticRecordingKey=value=>/^i\[[ɿʅ/]+\]$/.test(value)?'apical-i':value.replace(/\s*\[[^\]]+\]/g,'').replace(/^iou\s*\(iu\)$/,'iu').replace(/^uei\s*\(ui\)$/,'ui').replace(/^uen\s*\(un\)$/,'un').replace(/^ueng$/,'weng1');
export function phoneticRecordings(layout) {
  return [...new Set((layout.blocks||[]).filter(b=>b.phoneticTextTable).flatMap(b=>(b.exactTokens||[]).filter(t=>t.tableRow).map(t=>phoneticRecordingKey(t.text))))];
}
