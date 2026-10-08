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
  return [...new Set((layout.blocks||[]).flatMap(b=>[...(b.toneRows||[]).flat(),...(b.readingTokens||[]).map(t=>t.text)]).map(toneKey).filter(Boolean))];
}
export function phoneticRecordings(layout) {
  return [...new Set((layout.blocks||[]).filter(b=>b.phoneticTextTable).flatMap(b=>(b.exactTokens||[]).filter(t=>t.tableRow).map(t=>t.text.replace(/\s*\[i\]/g,'').replace(/^iou\s*\(iu\)$/,'iu'))))];
}
