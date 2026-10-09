// Tone marks are pronunciation data, not browser TTS hints.
export function toneKey(value) {
  const text=String(value||'').trim().toLowerCase().normalize('NFD');
  const marks=[...text].filter(c=>'\u0304\u0301\u030c\u0300'.includes(c));
  if(marks.length!==1)return null;
  const tone='\u0304\u0301\u030c\u0300'.indexOf(marks[0])+1;
  const syllable=text.replace(/[\u0304\u0301\u030c\u0300]/g,'').normalize('NFC');
  if(!/^[a-zü]+$/.test(syllable))return null;
  return syllable.replace(/ü/g,'v')+tone;
}
export function toneRecordings(layout) {
  return [...new Set((layout.blocks||[]).flatMap(b=>[...(b.toneRows||[]).flat(),...(b.readingTokens||[]).map(t=>t.text),...(!b.toneAnswers?(b.phraseCells||[]).map(t=>t.text):[]),...(b.sandhiRows||[]).map(r=>r.py.split('→')[0].replace(/\s*\+\s*/g,'').trim())]).map(recordingKey).filter(Boolean))];
}
export const wordRecordingKeys={'yóuyǒng':'you2-yong3','lǚyóu':'lv3-you2','péngyou':'pengyou','shuǐguǒ':'shui2-guo3','nǐhǎo':'ni2-hao3','kěyǐ':'ke2-yi3','nǎlǐ':'na2-li3','hěnhǎo':'hen2-hao3','suǒyǐ':'suo2-yi3','qǐngnǐ':'qing2-ni3','shǒubiǎo':'shou2-biao3','xiǎoyǔ':'xiao2-yu3'};
export const recordingKey=value=>wordRecordingKeys[String(value).replace(/\s+/g,'').toLowerCase()]||wordRecordingKeys[value]||toneKey(value)||null;
export const phoneticRecordingKey=value=>/^i\[[ɿʅ/]+\]$/.test(value)?'apical-i':value.replace(/\s*\[[^\]]+\]/g,'').replace(/^iou\s*\(iu\)$/,'iu').replace(/^uei\s*\(ui\)$/,'ui').replace(/^uen\s*\(un\)$/,'un').replace(/^ueng$/,'weng1');
export function phoneticRecordings(layout) {
  return [...new Set((layout.blocks||[]).filter(b=>b.phoneticTextTable).flatMap(b=>(b.exactTokens||[]).filter(t=>t.tableRow).map(t=>phoneticRecordingKey(t.text))))];
}
