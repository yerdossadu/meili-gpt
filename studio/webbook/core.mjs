// Forma "PDF → Web" core, shared by the studio console (browser) and the
// conversion server (Node).
//
// Pipeline idea: a vision model is good at *what* is on a textbook page
// (block types, exact text, translation) but places boxes several percent off.
// Local OCR line boxes and the scan's own pixels are exact, so the model's
// structure is snapped to them, and colours / font sizes are measured from the
// scan. The model never produces HTML; pages are drawn from fixed components
// (components.css) so every page of the book shares one design system.

import { measurePrintedGeometry, hasPrintedCardFrame, printedCardBounds, measureTextTable, restorePhoneticTokens, printedParagraphLines } from './source-geometry.mjs';
import { measureTitlePage } from './title-page.mjs';
import { measureImprintPage } from './imprint-page.mjs';
import { measureCreditsPage } from './credits-page.mjs';
import { measureForewordPage } from './foreword-page.mjs';
import { measureCharacterPage } from './character-page.mjs';
import { measureClassroomPage } from './classroom-page.mjs';
import {wordLabels} from './word-labels.mjs';
import {toneKey,recordingKey,phoneticRecordingKey} from './tone-audio.mjs';
import {reconcileAnswerGrid,measureDialogueOptions,clipImagesBeforeText,dialogueLabels,measureReadingGrid,measureAnswerLattice} from './workbook-drills.mjs';
export {toneRecordings,phoneticRecordings} from './tone-audio.mjs';
export const NORM_VERSION = 3;
export const SNAP_VERSION = 3;
export const TYPES = ['runhead', 'lesson', 'objectives', 'section', 'para', 'tip', 'dialogue', 'image', 'card', 'words', 'folio', 'text', 'decor', 'bonus'];

export const PROMPT = `Ты размечаешь скан страницы китайского учебника HSK для пересборки в HTML из готовых компонентов.
Верни ТОЛЬКО JSON вида {"blocks":[...],"kz":{"русская строка":"казахский перевод"}} без пояснений. В kz включи каждую русскую строку блоков; имена и пиньинь сохраняй.
Каждый блок: {"type":..., "box":{"x","y","w","h"}, ...поля типа}.
box — рамка блока в ДОЛЯХ страницы от 0 до 1: x,y — левый верхний угол, w,h — ширина и высота. Не проценты и не пиксели.
Пример: блок, который начинается на 12% ширины и 15% высоты страницы, шириной 72% и высотой 4%: {"x":0.12,"y":0.15,"w":0.72,"h":0.04}.
Точность рамок проверяется по скану отдельно; главное — правильно определить блоки и их текст.
Таблицу инициалей и финалей передавай текстом по группам: «声母\\nInitials\\n<строки инициалей>\\n韵母\\nFinals\\n<строки финалей>». Сохраняй ü, i [i], iou (iu) и все клетки. Упражнения чтения передавай строками слогов в печатном порядке с точными тонами, включая последнюю смешанную строку.
Во вводных страницах сохраняй каждый заголовок и абзац отдельным блоком; если оригинал только английский, cn оставляй пустым. В двуязычных представлениях персонажей держи китайский текст и его английский перевод в одном блоке, портрет — отдельным image. Не включай соседний текст и цветной фон страницы в рамку портрета.\nДля каждого текста дай: cn (китайский дословно, без пиньиня), en (английский дословно), ru (точный русский перевод английского, по возможности не длиннее английского), py (пиньинь, если он напечатан над иероглифами, дословно с тонами).
Переносы строк, напечатанные в cn, py и en (стихи, скороговорки), передавай символом \\n; в ru — в тех же местах, что в en.
Типы блоков:
- runhead: колонтитул вверху. cn, en, ru; number — крупная цифра урока рядом с колонтитулом (напр. "2"), если есть; в en и ru её не повторяй.
- lesson: крупная шапка урока. number, cn, en, ru, py (пиньинь над заголовком), label (напр. "Lesson").
- objectives: блок целей. heading{cn,en,ru}, items[{cn,en,ru}].
- section: ярлык раздела, напр. "课文 2 | Text 2" или рубрика с персонажем ("小语的彩蛋 | Xiaoyu's Bonus Content", "小语讲堂 | Xiaoyu's Classroom"). cn, en, ru; track (номер аудио/видео, если есть); avatar: box рисунка персонажа у ярлыка или null. box — только сам ярлык (красная плашка и белая табличка), без панели под ним.
- bonus: панель видеобонуса под рубрикой «小语的彩蛋»: цветная панель с полосой видеоплеера внизу. cn, en, ru — заголовок внутри панели; image: box картинки внутри панели (доска, рисунок) или null.
- para: абзац или задание. icon: "pin" | "square" | "none"; cn, en, ru, py; track (номер аудио, напр. "1-3", если есть). Нумерованный пункт ("1 汉语的基本语序") — para с полем number ("1").
- tip: плашка-подсказка. label{cn,en,ru}; cn, en, ru; avatar: box картинки персонажа над плашкой или null.
- dialogue: столбец реплик с аватарами слева и пузырями справа. box охватывает все реплики. turns[{speaker{cn,py,ru,avatar:"photo"|"group"|"none",avatarBox}, py, hz, highlight}] (speaker.ru — имя говорящего по-русски, напр. "Ван Ифэй"). hz — иероглифы реплики; highlight — символы, выделенные цветом (или ""). avatarBox — рамка круглого портрета, если avatar="photo".
- image: фотография или иллюстрация (будет вырезана из скана). alt по-русски. Каждая учебная картинка с рамкой — отдельный image; напечатанную подпись передавай как caption{hz,py,en,ru}, перевод caption.ru обязательно включай в kz. В упражнениях на сопоставление не связывай перемешанные подписи с картинками наугад.
- card: цветная карточка с переводом диалога. lines[{en,ru}].
- words: таблица новых слов. heading{cn,en,ru}; track; rows[{i (номер в кружке, напр. "②"), hz, py, pos_en, pos_ru, en, ru}]. Подзаголовок внутри таблицы — отдельная строка {"group":{cn,en,ru}}.
- folio: номер страницы. text.
- text: любой иной текст. cn, en, ru; size ("s"|"m"|"l").
- decor: отдельная графика, которую не передают блоки выше: стрелки (в т.ч. пунктирные, соединяющие подсказку и реплику), линии, выноски, звёздочки, декоративные значки. box — плотно вокруг графики, даже если она лежит поверх или внутри другого блока. alt — что это (по-русски). Не отмечай как decor рамки, фоны, булавки и квадратики самих блоков выше.
Не выдумывай блоки, не дублируй. Ничего напечатанного на странице не пропускай. Порядок — сверху вниз.`;

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(value) || 0));
const str = value => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());

// ---- Model output → layout ---------------------------------------------

const rawVals = raw => raw && typeof raw === 'object' ? [raw.x, raw.y, raw.w ?? raw.width, raw.h ?? raw.height].map(Number) : null;

// Models return boxes as fractions, percents, source pixels or a 0..1000 grid
// regardless of the prompt. Detect the unit once for the whole page.
// The clip grows from its place to the middle of the screen (80 % of it), plays there and returns
// when it ends (or on a click outside / Esc). Written inline: the page works the same in the studio,
// an exported file and the platform, none of which runs page scripts.
const CLIP_ZOOM = [
  "var f=this.parentNode,v=f.querySelector('video');if(!v||f.dataset.z)return;f.dataset.z='1';f.classList.add('playing');",
  "var r=f.getBoundingClientRect(),W=innerWidth,H=innerHeight,k=Math.min(W*.8/r.width,H*.8/r.height),T='left .45s ease,top .45s ease,width .45s ease,height .45s ease,border-radius .45s ease';",
  "var bg=document.createElement('div');bg.style.cssText='position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);opacity:0;transition:opacity .45s ease;cursor:zoom-out';document.body.appendChild(bg);",
  "var at=function(q,rad){v.style.left=q.left+'px';v.style.top=q.top+'px';v.style.width=q.width+'px';v.style.height=q.height+'px';v.style.borderRadius=rad};",
  "v.style.cssText='position:fixed;z-index:2147483001;margin:0;object-fit:contain;background:#000;box-shadow:0 20px 70px rgba(0,0,0,.5);transition:'+T;at(r,'8px');document.body.appendChild(v);",
  "requestAnimationFrame(function(){requestAnimationFrame(function(){var w=r.width*k,h=r.height*k;at({left:(W-w)/2,top:(H-h)/2,width:w,height:h},'14px');bg.style.opacity='1'})});",
  "v.controls=true;var p=v.play();if(p)p.catch(function(){});",
  "var done=false,back=function(){if(done)return;done=true;document.removeEventListener('keydown',esc);v.pause();v.controls=false;at(f.getBoundingClientRect(),'0');bg.style.opacity='0';",
  "setTimeout(function(){f.insertBefore(v,f.firstChild);v.style.cssText='';bg.remove();f.classList.remove('playing');delete f.dataset.z;v.load()},470)};",
  "var esc=function(e){if(e.key==='Escape')back()};document.addEventListener('keydown',esc);v.onended=back;bg.onclick=back;"
].join('');

export function detectScale(parsed, width, height) {
  const boxes = [];
  const add = raw => { const v = rawVals(raw); if (v && v.every(Number.isFinite)) boxes.push(v); };
  for (const b of (Array.isArray(parsed) ? parsed : parsed?.blocks) || []) {
    add(b?.box); add(b?.avatar);
    for (const t of b?.turns || []) add(t?.speaker?.avatarBox);
  }
  if (!boxes.length) return { sx: 1, sy: 1, unit: 'fraction' };
  // Decide by the majority: one mistyped box (x: 2.76 for 0.276) must not
  // turn a page of fractions into percents.
  const fractional = boxes.filter(([x, y, w, h]) => x + w <= 1.05 && y + h <= 1.05).length;
  if (fractional >= boxes.length * 0.7) return { sx: 1, sy: 1, unit: 'fraction' };
  // Same majority rule for percents and a 0..1000 grid: a box drawn past the
  // page edge (x 154 + w 907) must not flip the unit for every block.
  const within = lim => boxes.filter(([x, y, w, h]) => x + w <= lim && y + h <= lim).length >= boxes.length * 0.7;
  const maxX = Math.max(...boxes.map(([x, , w]) => x + w)), maxY = Math.max(...boxes.map(([, y, , h]) => y + h));
  const maxStartY = Math.max(...boxes.map(([, y]) => y));
  if (within(101)) return { sx: 0.01, sy: 0.01, unit: 'percent' };
  // Content reaches the lower third of a page, so on a scan taller than
  // 1000 px boxes that stay within 1000 mean a 0..1000 grid.
  if (within(1005) && maxStartY <= 1000 && (!(height > 1050) || maxStartY < height * 0.66)) return { sx: 0.001, sy: 0.001, unit: 'grid1000' };
  if (width > 0 && height > 0) return { sx: 1 / Math.max(width, maxX), sy: 1 / Math.max(height, maxY), unit: 'pixels' };
  return { sx: 1 / maxX, sy: 1 / maxY, unit: 'scaled' };
}

function normBox(raw, scale = { sx: 1, sy: 1, unit: 'fraction' }) {
  let vals = rawVals(raw);
  if (!vals || vals.some(v => !Number.isFinite(v))) return null;
  // On a fraction page a value above 1 is a dropped decimal point (2.76 for
  // 0.276); repair it, or drop the box if that still does not fit.
  if (scale.sx === 1 && scale.sy === 1) {
    vals = vals.map(v => v > 1.05 && v / 10 <= 1.05 ? v / 10 : v);
    if (vals[0] + vals[2] > 1.1 || vals[1] + vals[3] > 1.1) return null;
  }
  const x = vals[0] * scale.sx, y = vals[1] * scale.sy, w = vals[2] * scale.sx, h = vals[3] * scale.sy;
  if (w <= 0.002 || h <= 0.002) return null;
  return { x: num(x), y: num(y), w: num(w, 0.002, 1 - num(x)), h: num(h, 0.002, 1 - num(y)) };
}
// Chinese text is printed with full-width punctuation; models often return
// ASCII marks next to hanzi.
const FW = { ',': '，', '!': '！', '?': '？', ':': '：', ';': '；', '(': '（', ')': '）' };
export const zhPunct = s => String(s || '').replace(/(\p{Script=Han}|[”’）])\s*([,!?:;)])|([,!?:;(])\s*(?=\p{Script=Han})/gu, (m, a, p1, p2) => a ? a + FW[p1] : FW[p2])
  .replace(/(\p{Script=Han})\s*\.(?=\s*$|\s*\p{Script=Han}|\s*\n)/gu, '$1。');
// A «translation» that only repeats the original (the model copies a syllable table into every
// field) is no translation: printed three times otherwise.
const tri = obj => {
  const cn = zhPunct(str(obj?.cn)), same = s => s && s.replace(/\s+/g, '') === str(obj?.cn).replace(/\s+/g, '');
  return { cn, en: same(str(obj?.en)) ? '' : str(obj?.en), ru: same(str(obj?.ru)) ? '' : str(obj?.ru), py: str(obj?.py) };
};

export function normalize(parsed, scale = { sx: 1, sy: 1 }) {
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const blocks = [];
  for (const raw of list.slice(0, 60)) {
    const type = str(raw?.type), box = normBox(raw?.box, scale);
    if (!TYPES.includes(type) || !box) continue;
    const b = { type, box, ...tri(raw) };
    if (type === 'lesson') Object.assign(b, { number: str(raw.number), label: str(raw.label) || 'Lesson' });
    // «课文 2 / Text 2» is a text tab, not a lesson band: the model sometimes calls any band at the page edge "lesson" (p27, p39).
    if (type === 'lesson' && (/^(课文|语音|会话|听说|生词)/.test(b.cn) || /^(text|dialogue|phonetics|new words)\b/i.test(b.en)) && /^\d+$/.test(b.number || '')) {
      const n = b.number, add = s => (s ? `${s} ${n}` : s);
      Object.assign(b, { type: 'section', cn: add(b.cn), en: add(b.en), ru: add(b.ru), track: '', avatar: null });
      delete b.number; delete b.label;
    }
    if (type === 'objectives') Object.assign(b, { heading: tri(raw.heading), items: (raw.items || []).slice(0, 8).map(tri) });
    if (type === 'para') Object.assign(b, { icon: ['pin', 'square'].includes(raw.icon) ? raw.icon : 'none', track: str(raw.track), number: str(raw.number) });
    if (type === 'tip') Object.assign(b, { label: tri(raw.label), avatar: normBox(raw.avatar, scale) });
    if (type === 'section') Object.assign(b, { track: str(raw.track), avatar: normBox(raw.avatar, scale) });
    if (type === 'bonus') b.image = normBox(raw.image, scale);
    if (type === 'runhead') {
      // "Lesson 2" → label "Lesson" and the big lesson number beside it.
      b.number = str(raw.number);
      const m = /^(lesson)\s*(\d+)$/i.exec(b.en);
      if (m && (!b.number || b.number === m[2])) { b.number = m[2]; b.en = m[1]; b.ru = b.ru.replace(/\s*\d+$/, ''); }
    }
    if (type === 'dialogue') b.turns = (raw.turns || []).slice(0, 12).map(t => ({
      speaker: { cn: str(t?.speaker?.cn), py: str(t?.speaker?.py), ru: str(t?.speaker?.ru), avatar: ['photo', 'group'].includes(t?.speaker?.avatar) ? t.speaker.avatar : 'none', avatarBox: normBox(t?.speaker?.avatarBox, scale) },
      py: str(t?.py), hz: zhPunct(str(t?.hz)), highlight: str(t?.highlight)
    })).filter(t => t.hz);
    if (type === 'image' || type === 'decor') b.alt = str(raw.alt);
    if (type === 'card') b.lines = (raw.lines || []).slice(0, 12).map(l => ({ en: str(l?.en), ru: str(l?.ru) }));
    if (type === 'words') {
      const rows = (raw.rows || []).slice(0, 24).map(r => r?.group ? { group: tri(r.group) } : ({ i: str(r?.i), hz: str(r?.hz), py: str(r?.py), pos_en: str(r?.pos_en), pos_ru: str(r?.pos_ru), en: str(r?.en), ru: str(r?.ru) }));
      const groups = rows.filter(r => r.group).map(r => [r.group.cn, r.group.en, r.group.ru].join(' ')).join(' ');
      const phoneticChart = /声母|initials/i.test(groups) && /韵母|finals/i.test(groups) && /声调|tones/i.test(groups)
        && rows.some(r => r.hz && r.py && r.pos_en && r.pos_ru);
      Object.assign(b, { heading: tri(raw.heading), track: str(raw.track), rows, ...(phoneticChart ? { phoneticChart: true } : {}) });
    }
    if (type === 'folio') b.text = str(raw.text);
    if (type === 'text') b.size = ['s', 'm', 'l'].includes(raw.size) ? raw.size : 'm';
    blocks.push(b);
  }
  repairStructure(blocks);
  // «2 拼写规则 / 2 Spelling Rules» given as a section tab: a numbered heading (red number box + title).
  for (const [k, b] of blocks.entries()) {
    if(b.cn&&/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/u.test(b.cn)&&/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ\s]+$/u.test(b.cn)&&b.cn.trim().split(/\s+/).length>=8){
      b.py=b.cn;b.cn='';b.en='';b.ru='';
    }
    const m = b.type === 'section' && !b.track && /^(\d{1,2})\s+(\S.*)$/.exec(b.cn || '');
    if (!m) continue;
    const cut = s => String(s || '').replace(new RegExp('^' + m[1] + '\\s+'), '');
    blocks[k] = { type: 'para', box: b.box, cn: m[2], en: cut(b.en), ru: cut(b.ru), py: '', icon: 'none', track: '', number: m[1] };
  }
  // Answer options («❶ A：你好！ B：你好！» under photos) given as dialogues:
  // speakers are bare letters, no characters, no bubbles — printed as plain
  // numbered lines. Numbered in reading order when the model left the numbers out.
  const options = [];
  blocks.forEach((b, k) => {
    if (b.type !== 'dialogue' || !b.turns?.length || b.turns.length > 4) return;
    if (!b.turns.every(t => /^[A-ZА-Я]$/.test(t.speaker.cn || t.speaker.ru) && t.speaker.avatar === 'none')) return;
    const label = t => /^[A-Z]$/.test(t.speaker.cn) ? t.speaker.cn : String.fromCharCode(65 + Math.max(0, 'АБВГ'.indexOf(t.speaker.ru)));
    const para = { type: 'para', box: b.box, cn: b.turns.map(t => `${label(t)}：${t.hz}`).join('\n'), py: b.turns.map(t => t.py).join('\n'), en: '', ru: '', icon: 'none', track: '', number: '', dialogueOptions:b.turns.map(t=>({speaker:label(t),hz:t.hz,py:t.py})) };
    blocks[k] = para; options.push(para);
  });
  if (options.length >= 2) options.slice().sort((p, q) => Math.abs(p.box.y - q.box.y) > 0.03 ? p.box.y - q.box.y : p.box.x - q.box.x).forEach((p, i) => { p.number = String(i + 1); });
  // A lesson number printed beside the running head sometimes comes back as
  // a separate text block ("2"): it belongs to the running head.
  for (const head of blocks.filter(b => b.type === 'runhead')) {
    const k = blocks.findIndex(o => o.type === 'text' && /^\d{1,2}$/.test(o.cn || o.en) && Math.abs(o.box.y - head.box.y) < 0.04 && Math.abs(o.box.x - (head.box.x + head.box.w)) < 0.08);
    if (k < 0) continue;
    head.number ||= blocks[k].cn || blocks[k].en;
    blocks.splice(k, 1);
  }
  return blocks;
}

// Recurring book elements the model marks up inconsistently, brought to one
// structure: feature tabs with the character ("小语的彩蛋", "小语讲堂") are
// sections with an avatar, the video panel under "小语的彩蛋" is a bonus
// block, and "1 汉语的基本语序" is a numbered paragraph.
const FEATURE_CN = /^(小语的彩蛋|小语讲堂)$/;
const FEATURE_EN = /^xiaoyu['’]s\s+(bonus content|classroom)$/i;
const CHARACTER_ALT = /сяою|девушк|персонаж|character|girl|xiaoyu/i;
const isFeature = o => FEATURE_CN.test(String(o?.cn || '').replace(/\s/g, '')) || FEATURE_EN.test(String(o?.en || '').trim());
const inside = (a, r) => a.x + a.w / 2 >= r.x && a.x + a.w / 2 <= r.x + r.w && a.y + a.h / 2 >= r.y && a.y + a.h / 2 <= r.y + r.h;

function repairStructure(blocks) {
  const drop = new Set();
  for (const [k, b] of blocks.entries()) {
    // Multi-row pinyin tone drills are a grid even when classified as verse.
    if(!b.cn&&b.py?.includes('\n')&&!b.py.includes('___')){
      const rows=b.py.split('\n').map(r=>r.trim().split(/\s+/));
      const tone=s=>{const m=s.normalize('NFD').match(/[\u0304\u0301\u030c\u0306\u0300]/);return m?({'̄':1,'́':2,'̌':3,'̆':3,'̀':4}[m[0]]):0;};
      if(rows.length>=3&&rows.length<=12&&rows.every(r=>r.length>=2&&r.length<=16&&r.every(t=>tone(t)))){
        b.type='text';b.toneSourceBox={...b.box};const groups=Math.ceil(Math.max(...rows.map(r=>r.length))/4);b.toneAlign=groups>1?'left':'center';
        b.toneRows=rows.map(r=>{const cells=new Array(groups*4).fill('');for(const [i,s]of r.entries())cells[Math.floor(i/4)*4+tone(s)-1]=s.normalize('NFD').replace(/\u0306/g,'\u030c').normalize('NFC');return cells;});b.py=b.toneRows.map(r=>r.join('\t')).join('\n');
      }
    }
    // A feature title marked as plain text.
    if (b.type === 'text' && isFeature(b)) Object.assign(b, { type: 'section', track: '', avatar: null });
    // A feature marked as a tip: its label is the tab, its text the panel.
    if (b.type === 'tip' && isFeature(b.label)) {
      const tab = { type: 'section', box: { x: Math.max(0, b.box.x - 0.03), y: Math.max(0, b.box.y - 0.05), w: Math.min(1, b.box.w + 0.03), h: 0.045 }, ...b.label, track: '', avatar: b.avatar };
      const panel = { type: 'bonus', box: b.box, cn: b.cn, en: b.en, ru: b.ru, py: '', image: null };
      blocks.splice(k, 1, tab, panel);
    }
  }
  for (const s of blocks.filter(o => o.type === 'section' && isFeature(o))) {
    // The character next to the tab, marked as a picture or a graphic.
    if (!s.avatar) {
      // It stands at the tab's left end, reaching above it.
      const near = { x: s.box.x - 0.15, y: s.box.y - 0.07, w: 0.3, h: s.box.h + 0.1 };
      const c = blocks.find(o => !drop.has(o) && (o.type === 'image' || o.type === 'decor') && CHARACTER_ALT.test(o.alt || '') && o.box.w < 0.3 && inside(o.box, near));
      if (c) { s.avatar = c.box; drop.add(c); }
    }
    // The video panel under "小语的彩蛋" given as loose pieces.
    if (/彩蛋/.test(s.cn) && !blocks.some(o => o.type === 'bonus')) {
      const below = { x: s.box.x, y: s.box.y + Math.min(s.box.h, 0.05) - 0.01, w: Math.max(s.box.w, 0.6), h: 0.32 };
      const pieces = blocks.filter(o => o !== s && !drop.has(o) && ['text', 'image', 'decor'].includes(o.type) && inside(o.box, below));
      const title = pieces.find(o => o.type === 'text'), picture = pieces.find(o => o.type === 'image' && !CHARACTER_ALT.test(o.alt || ''));
      if (title || picture) {
        const k = blocks.indexOf(title || picture);
        blocks.splice(k, 0, { type: 'bonus', box: union(pieces.map(o => o.box)), cn: title?.cn || '', en: title?.en || '', ru: title?.ru || '', py: '', image: picture?.box || null });
        pieces.forEach(o => drop.add(o));
      }
      // The tab is a strip; the model sometimes spans the panel with it.
      if (s.box.h > 0.06) s.box = { ...s.box, h: 0.045 };
    }
  }
  // Numbered sub-heading: "1 汉语的基本语序" → number "1".
  for (const b of blocks) if (b.type === 'para' && !b.number) {
    const m = /^(\d{1,2})\s+(.+)$/s.exec(b.cn);
    if (m) { b.number = m[1]; b.cn = m[2]; b.en = b.en.replace(/^\d{1,2}\s+/, ''); b.ru = b.ru.replace(/^\d{1,2}\s+/, ''); b.icon = 'none'; }
  }
  for (let k = blocks.length - 1; k >= 0; k--) if (drop.has(blocks[k])) blocks.splice(k, 1);
}

// Build a layout from raw model output; the raw output is kept so later fixes
// to normalisation or snapping never need a new paid request.
export function fromModel(parsed, width, height) {
  const scale = detectScale(parsed, width, height);
  return { version: 1, normVersion: NORM_VERSION, unit: scale.unit, page: { width, height }, blocks: normalize(parsed, scale), kz: {...(parsed.kz||{})}, source: parsed };
}

export function parseModelJson(text) {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(clean); } catch {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('Модель вернула не JSON.');
    return JSON.parse(clean.slice(a, b + 1));
  }
}

// ---- Scan pixels -------------------------------------------------------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = p => '#' + p.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
// Paper tinted by the scanner prints as white on the web.
const clean = p => p.every(v => v >= 234) ? [255, 255, 255] : p;

function modeColor(samples, shift = 3) {
  const counts = new Map();
  for (const p of samples) { const k = (p[0] >> shift) + ',' + (p[1] >> shift) + ',' + (p[2] >> shift); counts.set(k, (counts.get(k) || 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top ? { color: top[0].split(',').map(v => Number(v) * (1 << shift) + (1 << (shift - 1))), share: top[1] / samples.length } : null;
}

// 3×3 median per channel: removes scanner grain and print dither while
// keeping panel edges sharp (a box blur would smear panels into the page and
// let fills leak). Used for layout analysis only; published images are cut
// from the original scan.
function denoise(data, W, H) {
  const out = new Uint8ClampedArray(W * H * 3), win = new Uint8Array(9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let c = 0; c < 3; c++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = Math.min(H - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(W - 1, Math.max(0, x + dx)); win[n++] = data[(yy * W + xx) * 4 + c]; } }
      win.sort();
      out[(y * W + x) * 3 + c] = win[4];
    }
  }
  return out;
}

// High-contrast analysis template: the denoised scan reduced to its main
// print colours (k-means). Every pixel takes its cluster's mean colour, so
// panels become flat regions with sharp edges and their measured colour is
// the average print colour rather than one noisy shade. Never published.
function posterize(px, W, H, k = 10) {
  const n = W * H, sample = [];
  for (let i = 0; i < n; i += 5) sample.push(i);
  // k-means++ seeding on a sample of pixels.
  const centers = [[px[0], px[1], px[2]]];
  const d2 = new Float64Array(sample.length);
  while (centers.length < k) {
    let sum = 0;
    sample.forEach((i, s) => { let m = Infinity; for (const c of centers) { const dr = px[i * 3] - c[0], dg = px[i * 3 + 1] - c[1], db = px[i * 3 + 2] - c[2]; m = Math.min(m, dr * dr + dg * dg + db * db); } d2[s] = m; sum += m; });
    if (!sum) break;
    let r = ((centers.length * 2654435761) % 1000) / 1000 * sum, s = 0;
    while (s < sample.length - 1 && (r -= d2[s]) > 0) s++;
    centers.push([px[sample[s] * 3], px[sample[s] * 3 + 1], px[sample[s] * 3 + 2]]);
  }
  const nearest = i => { let best = 0, m = Infinity; for (let c = 0; c < centers.length; c++) { const dr = px[i * 3] - centers[c][0], dg = px[i * 3 + 1] - centers[c][1], db = px[i * 3 + 2] - centers[c][2], v = dr * dr + dg * dg + db * db; if (v < m) { m = v; best = c; } } return best; };
  for (let it = 0; it < 8; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const i of sample) { const c = nearest(i), a = acc[c]; a[0] += px[i * 3]; a[1] += px[i * 3 + 1]; a[2] += px[i * 3 + 2]; a[3]++; }
    acc.forEach((a, c) => { if (a[3]) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) { const c = centers[nearest(i)]; out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; }
  return out;
}

// Wrap an RGBA buffer (a downscaled scan) for the pixel measurements below.
// Geometry is read from the high-contrast template (`at`); colours are read
// from the denoised scan (`raw`), because clustering pulls similar print
// colours together (a red drifting to orange, all beiges merging).
export function gridFromRGBA(data, W, H, { poster = true } = {}) {
  const make = px => {
    const at = (x, y) => { const i = (y * W + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
    const right = [];
    for (let y = 0; y < H; y += 2) for (let x = W - 6; x < W - 1; x++) right.push(at(x, y));
    return { W, H, at, bg: modeColor(right).color };
  };
  const clean = denoise(data, W, H), raw = make(clean);
  if (!poster) return { ...raw, raw };
  return { ...make(posterize(clean, W, H)), raw };
}

function flood(grid, seeds, win, ok) {
  const { W, H } = grid, x0 = Math.max(0, Math.floor(win.x * W)), y0 = Math.max(0, Math.floor(win.y * H));
  const x1 = Math.min(W - 1, Math.ceil((win.x + win.w) * W)), y1 = Math.min(H - 1, Math.ceil((win.y + win.h) * H));
  const seen = new Uint8Array(W * H), stack = [], rows = new Uint32Array(H), cols = new Uint32Array(W);
  for (const [sx, sy] of seeds) if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && ok(grid.at(sx, sy), sx, sy)) stack.push(sx, sy);
  let count = 0;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop(), k = y * W + x;
    if (seen[k]) continue; seen[k] = 1;
    if (!ok(grid.at(x, y), x, y)) continue;
    count++; rows[y]++; cols[x]++;
    if (x > x0) stack.push(x - 1, y); if (x < x1) stack.push(x + 1, y); if (y > y0) stack.push(x, y - 1); if (y < y1) stack.push(x, y + 1);
  }
  if (count < 20) return null;
  // Fills leak along thin borders of touching panels: trim sparse edge rows
  // firmly and columns only lightly (a banner can be thin above a card).
  const span = (arr, lo, hi, share) => {
    let max = 0; for (let i = lo; i <= hi; i++) if (arr[i] > max) max = arr[i];
    const min = max * share; let a = lo, b = hi;
    while (a < b && arr[a] < min) a++; while (b > a && arr[b] < min) b--;
    return [a, b];
  };
  const [minX, maxX] = span(cols, x0, x1, 0.04), [minY, maxY] = span(rows, y0, y1, 0.25);
  // Columns filled over most of the panel height: the solid part of a panel,
  // without borders or coloured text of a neighbouring tag.
  const [solidX0, solidX1] = span(cols, x0, x1, 0.6);
  return { x: minX / W, y: minY / H, w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H, solidRight: (solidX1 + 1) / W, solidLeft: solidX0 / W };
}

// Pixels that belong to a solid area (a photo), not to a thin line or a text
// stroke: at least 85% of the (2r+1)² window differs from the page. Built once
// per grid from an integral image.
const SOLID_CACHE = new WeakMap(), SOLID_PHOTOS = new WeakSet();
function solidBy(grid, pred, share = 0.85, radius = 0) {
  const { W, H } = grid, r = radius || Math.max(2, Math.round(W * 0.004)), S = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) { if (pred(grid.at(x, y))) run++; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + run; }
  }
  const test = (x, y) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
    const n = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
    return n >= (x1 - x0) * (y1 - y0) * share;
  };
  test.r = r;
  return test;
}
function solidTest(grid) {
  if (!SOLID_CACHE.has(grid)) SOLID_CACHE.set(grid, solidBy(grid, p => dist(p, grid.bg) > 30));
  return SOLID_CACHE.get(grid);
}

// A photo's own hairline outline can lie beyond its solid part when a corner is
// pale (a white window, a folded corner). Move a side out to that line, but only
// if the photo's top and bottom lines run on to it: a card frame that merely
// stands near the photo is not joined to it by such lines.
export function extendToOutline(grid, box) {
  const g = grid.hi || null;
  if (!g) return box;
  const { W, H } = g, paper = grid.bg;
  const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && dist(g.at(x, y), paper) > 28;
  const vShare = (x, y0, y1) => { let n = 0, t = 0; for (let y = y0; y <= y1; y++) { t++; if (ink(x, y) || ink(x - 1, y) || ink(x + 1, y)) n++; } return n / Math.max(1, t); };
  const hShare = (y, x0, x1) => { let n = 0, t = 0; for (let x = x0; x <= x1; x++) { t++; if (ink(x, y) || ink(x, y - 1) || ink(x, y + 1)) n++; } return n / Math.max(1, t); };
  const top = Math.round(box.y * H), bottom = Math.round((box.y + box.h) * H);
  const rowsAcross = (y, xa, xb) => { let best = 0; for (let d = -4; d <= 4; d++) best = Math.max(best, hShare(y + d, Math.min(xa, xb), Math.max(xa, xb))); return best; };
  const reach = Math.round(0.06 * W), thin = Math.round(0.004 * W);
  let left = Math.round(box.x * W), right = Math.round((box.x + box.w) * W);
  const scan = dir => {
    const from = dir < 0 ? left : right;
    for (let d = 2; d <= reach; d++) {
      const x = from + dir * d;
      if (vShare(x, top, bottom) < 0.85) continue;
      // hairline: the columns a few pixels further out are mostly paper
      if (vShare(x + dir * thin, top, bottom) > 0.4) continue;
      if (rowsAcross(top, from, x) < 0.85 || rowsAcross(bottom, from, x) < 0.85) continue;
      return x;
    }
    return from;
  };
  const nl = scan(-1), nr = scan(1);
  return { ...box, x: nl / W, w: (nr - nl + 1) / W };
}
// The thin outline around a photo and its caption (a rounded card). Each side
// is the line, within reach of the photo, that is inked along most of its
// length; captions are sparse, so they never pass for a bottom border. All four
// sides must be found, otherwise the photo simply has no frame.
export function detectFrame(grid, box, reach = {}) {
  const { side = 0.04, above = 0.03, below = 0.14, maxW = 0.7, maxArea = 0.3 } = reach;
  // Outlines are 1-3 px at print resolution and vanish in the 700 px grid: use the full-size pixels.
  const g = grid.hi || grid.raw || grid, { W, H } = g, paper = grid.bg;
  const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && dist(g.at(x, y), paper) > 28;
  const vLine = (fx, y0, y1) => { const x = Math.round(fx * W), a = Math.round(y0 * H), b = Math.round(y1 * H); let n = 0; for (let y = a; y <= b; y++) if (ink(x, y) || ink(x - 1, y) || ink(x + 1, y)) n++; return n / Math.max(1, b - a + 1); };
  const hLine = (fy, x0, x1) => { const y = Math.round(fy * H), a = Math.round(x0 * W), b = Math.round(x1 * W); let n = 0; for (let x = a; x <= b; x++) if (ink(x, y) || ink(x, y - 1) || ink(x, y + 1)) n++; return n / Math.max(1, b - a + 1); };
  // Nearest qualifying line first (the far side of a neighbouring frame must not win),
  // then the strongest line within a few pixels of it.
  const best = (from, to, step, score, need) => {
    for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
      const s = score(v);
      if (s < need) continue;
      let top = { v, s };
      for (let k = 1; k <= 4; k++) { const u = v + k * step, su = score(u); if (su > top.s) top = { v: u, s: su }; }
      return top;
    }
    return null;
  };
  const px = 1 / W, py = 1 / H, gap = 0.003;
  const yTop = box.y, yBot = box.y + box.h, xL = box.x, xR = box.x + box.w;
  const left = best(xL - gap, xL - side, -px, v => vLine(v, yTop, yBot), 0.8);
  const right = best(xR + gap, xR + side, px, v => vLine(v, yTop, yBot), 0.8);
  if (!left || !right) return null;
  const top = best(yTop - gap, yTop - above, -py, v => hLine(v, left.v, right.v), 0.8);
  const bottom = best(yBot + gap, yBot + below, py, v => hLine(v, left.v, right.v), 0.8);
  if (!top || !bottom) return null;
  const frame = { x: left.v, y: top.v, w: right.v - left.v, h: bottom.v - top.v };
  if (frame.w * frame.h > maxArea || frame.w > maxW) return null;
  // Outline colour: the ink along the left line.
  // (median of the strongest pixels, so anti-aliased edges do not wash it out).
  const cx = Math.round(left.v * W), cs = [];
  for (let y = Math.round(yTop * H); y <= Math.round(yBot * H); y += 3) for (let dx = -3; dx <= 3; dx++) if (ink(cx + dx, y)) cs.push({ p: g.at(cx + dx, y), d: dist(g.at(cx + dx, y), paper) });
  const maxD = Math.max(0, ...cs.map(o => o.d)), hard = cs.filter(o => o.d >= maxD * 0.6), med = k => { const v = hard.map(o => o.p[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const c = hard.length ? [med(0), med(1), med(2)] : [230, 158, 150];
  // A real outline is clearly darker than the paper; faint page texture is not.
  if (dist(c, paper) < 60) return null;
  return { ...frame, color: '#' + c.map(v => v.toString(16).padStart(2, '0')).join('') };
}

// Panel fill = dominant non-background colour on a thin ring around the text.
// `page` is the page's own background colour: a tight ring around a small
// label (a folio pill hardly taller than its digits) runs over the page
// around it, which must not win over the label's fill.
function fillColor(grid, box, page = null) {
  const samples = [], pad = 3;
  const x0 = Math.max(0, Math.floor(box.x * grid.W) - pad), x1 = Math.min(grid.W - 1, Math.ceil((box.x + box.w) * grid.W) + pad);
  const y0 = Math.max(0, Math.floor(box.y * grid.H) - pad), y1 = Math.min(grid.H - 1, Math.ceil((box.y + box.h) * grid.H) + pad);
  let total = 0;
  const take = (x, y) => { total++; const p = grid.at(x, y); if (dist(p, grid.bg) >= 24 && !(page && dist(p, page) < 22)) samples.push(p); };
  for (let x = x0; x <= x1; x++) { take(x, y0); take(x, y1); }
  for (let y = y0; y <= y1; y++) { take(x0, y); take(x1, y); }
  // Scan noise spreads one printed colour over neighbouring shades, so bin
  // coarsely and report the mean of the samples close to the winning bin.
  const top = samples.length ? modeColor(samples, 5) : null;
  if (!top) return null;
  const near = samples.filter(p => dist(p, top.color) < 40);
  if (near.length < total * 0.12) return null;
  // Average only shades close to the bin so lines and text do not tint it.
  const core = near.filter(p => dist(p, top.color) < 20), pool = core.length >= 8 ? core : near;
  return [0, 1, 2].map(i => pool.reduce((s, p) => s + p[i], 0) / pool.length);
}

// Dominant colour inside a found panel, ignoring dark ink: the printed fill
// the web panel should carry.
function interiorColor(grid, box) {
  const samples = [];
  const x0 = Math.floor(box.x * grid.W), x1 = Math.min(grid.W - 1, Math.ceil((box.x + box.w) * grid.W));
  const y0 = Math.floor(box.y * grid.H), y1 = Math.min(grid.H - 1, Math.ceil((box.y + box.h) * grid.H));
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { const p = grid.at(x, y); if (p[0] + p[1] + p[2] >= 330) samples.push(p); }
  if (samples.length < 20) return null;
  const top = modeColor(samples, 5), pool = samples.filter(p => dist(p, top.color) < 20);
  return pool.length >= 8 ? [0, 1, 2].map(i => pool.reduce((s, p) => s + p[i], 0) / pool.length) : top.color;
}

// Page paper, and the coloured page background when it does not reach the
// left edge (the white binding strip on lesson opener pages).
export function extractTheme(grid) {
  const left = [];
  for (let y = 0; y < grid.H; y += 2) for (let x = 1; x < 5; x++) left.push(grid.at(x, y));
  const leftColor = modeColor(left).color, bg = grid.bg;
  if (dist(leftColor, bg) <= 24) return { paper: hex(clean(bg)), background: null };
  const widths = [];
  for (const fy of [0.25, 0.4, 0.55, 0.7, 0.85]) {
    const y = Math.floor(fy * grid.H);
    let x = 0; while (x < grid.W / 3 && dist(grid.at(x, y), leftColor) <= 24) x++;
    if (x < grid.W / 3 && dist(grid.at(x, y), bg) <= 24) widths.push(x);
  }
  if (!widths.length) return { paper: hex(clean(bg)), background: null };
  const stripW = widths.sort((a, b) => a - b)[widths.length >> 1] / grid.W;
  return { paper: hex(clean(leftColor)), background: { color: hex(clean(bg)), box: { x: stripW, y: 0, w: 1 - stripW, h: 1 } } };
}

// ---- Snapping model boxes to the scan -----------------------------------

const PANEL_TYPES = new Set(['lesson', 'objectives', 'section', 'tip', 'words', 'card', 'folio']);
// Default font size (in % of page width) each component is drawn with; the
// measured OCR line height scales it per block.
const BASE_FONT = { para: 1.8, text: 1.8, card: 1.9, objectives: 1.86, tip: 1.65, words: 1.85, runhead: 2 };
const plain = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function blockStrings(b) {
  const out = [b.cn, b.en, b.py, b.number, b.label, b.text];
  const add = o => o && out.push(o.cn, o.en, o.py);
  add(b.heading); add(b.label && typeof b.label === 'object' ? b.label : null);
  (b.items || []).forEach(add);
  (b.lines || []).forEach(l => out.push(l.en));
  (b.rows || []).forEach(r => r.group ? add(r.group) : out.push(r.hz, r.py, r.en, r.pos_en, r.i));
  (b.turns || []).forEach(t => out.push(t.hz, t.py, t.speaker?.cn, t.speaker?.py));
  if (b.track) out.push(b.track);
  return plain(out.filter(v => typeof v === 'string').join('|'));
}

// Share of the OCR line found inside the block text (longest common run).
function matchScore(line, text) {
  if (!line || !text) return 0;
  if (text.includes(line)) return 1;
  let best = 0, prev = new Array(text.length + 1).fill(0);
  for (let i = 1; i <= line.length; i++) {
    const cur = new Array(text.length + 1).fill(0);
    for (let j = 1; j <= text.length; j++) if (line[i - 1] === text[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  // A long line read with small OCR slips («i[」 for «i [i]») breaks the longest run: also count
  // all characters it shares in order with the text (LCS).
  if (line.length < 12 || best / line.length >= 0.6) return best / line.length;
  let row = new Array(text.length + 1).fill(0);
  for (let i = 1; i <= line.length; i++) { const cur = new Array(text.length + 1).fill(0); for (let j = 1; j <= text.length; j++) cur[j] = line[i - 1] === text[j - 1] ? row[j - 1] + 1 : Math.max(row[j], cur[j - 1]); row = cur; }
  return Math.max(best / line.length, row[text.length] / line.length * 0.9);
}

const union = boxes => {
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
const grow = (b, gx, gy) => ({ x: b.x - gx, y: b.y - gy, w: b.w + 2 * gx, h: b.h + 2 * gy });
const clampBox = b => { const x = num(b.x), y = num(b.y); return { x, y, w: num(b.w, 0.002, 1 - x), h: num(b.h, 0.002, 1 - y) }; };
const centerDist = (a, b) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
const overlapShare = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (b.w * b.h) : 0;
};
const seedsIn = (grid, box, step = 3) => {
  const s = [];
  for (let y = Math.floor(box.y * grid.H); y <= (box.y + box.h) * grid.H; y += step) for (let x = Math.floor(box.x * grid.W); x <= (box.x + box.w) * grid.W; x += step) s.push([Math.min(grid.W - 1, Math.max(0, x)), Math.min(grid.H - 1, Math.max(0, y))]);
  return s;
};

// Assign every OCR line to the block whose text it matches, preferring the
// closest block when a phrase repeats (e.g. a title echoed in a dialogue).
// Workbook drill: rows/columns of syllables or answer blanks («____»), given
// with tabs or as short space-separated items — not a sentence.
export function gridRows(b) {
  if (!b || b.type !== 'text') return null;
  const src = b.cn || b.py || '';
  const lines = src.split('\n').map(r => r.trim()).filter(Boolean);
  if (src.includes('\t')) return src.split('\n').map(r => r.split('\t'));
  if (/_{3,}/.test(src)) {
    // Space-separated: a lone blank belongs to its syllable — the next one when
    // the row starts with a blank («___ ián»), else the previous one («j ___»).
    const split = r => {
      const t = r.split(/\s+/).filter(Boolean), out = [], lead = /^_{3,}$/.test(t[0] || '');
      for (let i = 0; i < t.length; i++) {
        if (/^_{3,}$/.test(t[i]) && lead && i + 1 < t.length && !/^_{3,}$/.test(t[i + 1])) { out.push(t[i] + ' ' + t[++i]); continue; }
        if (/^_{3,}$/.test(t[i]) && !lead && out.length) { out[out.length - 1] += ' ' + t[i]; continue; }
        out.push(t[i]);
      }
      return out;
    };
    return lines.map(split);
  }
  // One cell per line (the model read the drill column by column).
  if (lines.length >= 4 && lines.every(r => r.split(/\s+/).length <= 2 && r.length <= 12 && !/[㐀-鿿]/.test(r))) return lines.map(r => [r]);
  const spaced =lines.length >= 2 && lines.every(r => { const t = r.split(/\s+/); return t.length >= 3 && t.every(w => w.length <= 9) && !/[㐀-鿿]{3}/.test(r); });
  return spaced ? lines.map(r => r.split(/\s+/)) : null;
}

// The drill's cells as printed rows; a column-by-column list is reflowed into
// `R` rows (measured from the scan).
export function gridLayout(b, R = b?.gridR) {
  const rows = gridRows(b);
  if (!rows) return null;
  if (!(R > 1 && rows.every(r => r.length === 1))) return rows;
  const items = rows.map(r => r[0]), C = Math.ceil(items.length / R);
  return Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => items[c * R + r] ?? ''));
}

function assignLines(blocks, ocrLines) {
  const texts = blocks.map(blockStrings), hits = blocks.map(() => []);
  const grids = blocks.map((b, n) => gridRows(b) ? n : -1).filter(n => n >= 0);
  for (const line of ocrLines) {
    const t = plain(line.text);
    if (!t.length || (t.length < 2 && !grids.length)) continue;
    const c = { x: line.box.x + line.box.w / 2, y: line.box.y + line.box.h / 2 };
    // A lone syllable («ān», «ěng») inside a drill's area belongs to the drill,
    // not to the instruction above it («and» contains «an»).
    if (t.length <= 5 && !/\s/.test(line.text.trim()) && !/^\d+$/.test(t)) {   // digits: an exercise number
      const g = grids.filter(n => { const r = grow(blocks[n].box, 0.06, 0.04); return c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h; })
        .sort((p, q) => centerDist(line.box, blocks[p].box) - centerDist(line.box, blocks[q].box))[0];
      if (g !== undefined) { hits[g].push(line); continue; }
    }
    if (t.length < 2) continue;
    let best = null;
    // A track mark («🔊 2-1») belongs to a block with a track, not to text that happens to hold a digit.
    const trackMark = /^\W*\d{1,2}\s*[-–]\s*\d{1,3}\W*$/.test(line.text.trim());
    blocks.forEach((b, n) => {
      if (b.type === 'image') return;
      if (trackMark && !b.track) return;
      const score = matchScore(t, texts[n]), g = grow(b.box, 0.15, 0.1);
      if (score < 0.6 || c.x < g.x || c.x > g.x + g.w || c.y < g.y || c.y > g.y + g.h) return;
      // A line that IS one of the block's own lines («Initials» in a table) beats a long text merely containing the word.
      const whole = String([b.cn, b.en, b.py, b.text].filter(Boolean).join('\n')).split('\n').some(s => plain(s) === t);
      // Prefer the block whose original model box actually contains the OCR
      // line. A short heading such as «语音» is also a substring of a nearby
      // paragraph («汉语音节»); fuzzy text alone can snap the heading to that
      // paragraph and move both blocks on top of each other.
      const inside = c.x >= b.box.x && c.x <= b.box.x + b.box.w && c.y >= b.box.y && c.y <= b.box.y + b.box.h;
      const rank = score - centerDist(line.box, b.box) * 1.5 + (whole ? 0.5 : 0) + (inside ? 0.75 : 0);
      if (!best || rank > best.rank) best = { n, rank };
    });
    if (best) hits[best.n].push(line);
  }
  // A block the model placed far off (e.g. a section tab at the page bottom)
  // finds nothing near its box: look for its text anywhere among lines no
  // block has claimed, accepting only near-exact matches.
  // Only short labels qualify, and a line must contain the block's own text
  // (a short line merely contained in a long paragraph proves nothing).
  const taken = new Set(hits.flat());
  blocks.forEach((b, n) => {
    if (hits[n].length || !['section', 'runhead', 'folio', 'text'].includes(b.type)) return;
    const keys = [b.cn, b.en, b.text, b.number].map(plain).filter(k => k.length >= 2);
    if (!keys.length) return;
    const found = ocrLines.filter(l => !taken.has(l) && keys.some(k => matchScore(k, plain(l.text)) >= 0.8));
    for (const l of found) { hits[n].push(l); taken.add(l); }
  });
  return hits;
}

export function ocrLinesOf(ocr) {
  return (ocr?.lines || []).map(l => ({ text: String(l.text || ''),confidence:l.confidence, box: { x: +l.position.x, y: +l.position.y, w: +(l.position.width ?? l.position.w), h: +(l.position.height ?? l.position.h) } }))
    .filter(l => l.text && [l.box.x, l.box.y, l.box.w, l.box.h].every(Number.isFinite));
}

// Walk from a point in page fractions until the colour leaves `ref` (a border
// or a glyph). Uses the full-resolution scan when the server provides it, so
// hairline borders that the analysis grid smooths away are still found.
function probe(grid, fx, fy, dx, dy, ref, limit, tol = 55) {
  const g = grid.hi || grid.raw || grid, sx = g.W, sy = g.H;
  let x = Math.round(fx * sx), y = Math.round(fy * sy);
  const steps = Math.round(limit * (dx ? sx : sy));
  for (let i = 0; i < steps; i++) {
    x += dx; y += dy;
    if (x < 0 || y < 0 || x >= sx || y >= sy) return null;
    if (dist(g.at(x, y), ref) > tol) return dx ? x / sx : y / sy;
  }
  return null;
}

// Most common colour inside a box of the scan (the fill behind its text).
function paperUnder(grid, box) {
  const g = grid.raw || grid, samples = [];
  for (let y = Math.floor(box.y * g.H); y <= (box.y + box.h) * g.H && y < g.H; y++) for (let x = Math.floor(box.x * g.W); x <= (box.x + box.w) * g.W && x < g.W; x++) samples.push(g.at(x, y));
  return samples.length ? modeColor(samples, 4).color : [255, 255, 255];
}

const median = arr => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

// Coloured marks (arrows, rings) near a decor box: saturated pixels that are
// no panel colour, minus long thin lines (panel and bubble borders) and text,
// grouped with small gaps (dashes). Components touching the model's box give
// the graphic's real extent.
// Printed marks inside a window of the page: pixels passing `test` (page and
// panel colours never do), outside `masks` (text, photos), optionally minus
// long straight runs (borders). Returns connected pieces joined over gaps of
// 3 px of the analysis grid. Uses the full scan when available: thin dashes
// blend into a panel colour on the small grid.
function inkParts(grid, theme, blocks, win, { saturated = false, masks = [], strip = false, scale = 1 } = {}) {
  const g = grid.hi || grid.raw || grid, full = g.W, step = Math.max(1, Math.round(scale)), W = Math.ceil(full / step), H = Math.ceil(g.H / step), px1 = W / 700;
  const x0 = Math.max(0, Math.floor(win.x * W)), x1 = Math.min(W - 1, Math.ceil((win.x + win.w) * W));
  const y0 = Math.max(0, Math.floor(win.y * H)), y1 = Math.min(H - 1, Math.ceil((win.y + win.h) * H));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 4 || h < 4) return [];
  // A panel's colour is dropped only over that panel: a red mark elsewhere
  // on the page may share the colour of a red folio pill.
  const panels = blocks.filter(o => o.fill && o.box).map(o => ({ box: grow(o.box, 0.004, 0.004), c: parseHex(o.fill) })).filter(o => o.box.x < win.x + win.w && o.box.x + o.box.w > win.x && o.box.y < win.y + win.h && o.box.y + o.box.h > win.y);
  const fills = { some: (test, fx, fy) => panels.some(o => fx >= o.box.x && fx <= o.box.x + o.box.w && fy >= o.box.y && fy <= o.box.y + o.box.h && test(o.c)) };
  const masked = (fx, fy) => masks.some(t => fx >= t.x && fx <= t.x + t.w && fy >= t.y && fy <= t.y + t.h);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = g.at(Math.min(full - 1, (x0 + x) * step), Math.min(g.H - 1, (y0 + y) * step)), fx = (x0 + x) / W, fy = (y0 + y) / H;
    if (saturated && Math.max(...p) - Math.min(...p) < 60) continue;
    if (dist(p, backgroundAt(theme, fx, fy)) < 45 || fills.some(f => dist(p, f) < 40, fx, fy) || masked(fx, fy)) continue;
    m[y * w + x] = 1;
  }
  if (strip) {
    // Long thin runs are borders, not marks.
    const L = Math.round(W * 0.03);
    const thinRun = (len, at) => { let start = -1; for (let i = 0; i <= len; i++) { const on = i < len && m[at(i)]; if (on && start < 0) start = i; if (!on && start >= 0) { if (i - start > L) for (let k = start; k < i; k++) m[at(k)] = 2; start = -1; } } };
    for (let y = 0; y < h; y++) thinRun(w, i => y * w + i);
    for (let x = 0; x < w; x++) thinRun(h, i => i * w + x);
    for (let k = 0; k < w * h; k++) if (m[k] === 2) m[k] = 0;
  }
  const R = Math.max(3, Math.round(3 * px1)), seen = new Uint8Array(w * h), parts = [];
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1; let bx0 = w, by0 = h, bx1 = 0, by1 = 0, n = 0;
    while (stack.length) {
      const k = stack.pop(), x = k % w, y = (k / w) | 0; n++;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const xx = x + dx, yy = y + dy, kk = yy * w + xx; if (xx >= 0 && yy >= 0 && xx < w && yy < h && m[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); } }
    }
    // Single dashes are small at full resolution: keep anything above speckle.
    if (n >= 2 * px1 * px1) parts.push({ box: { x: (x0 + bx0) / W, y: (y0 + by0) / H, w: (bx1 - bx0 + 1) / W, h: (by1 - by0 + 1) / H }, n });
  }
  return parts;
}

const boxGap = (a, c) => Math.max(0, Math.max(a.x, c.x) - Math.min(a.x + a.w, c.x + c.w), Math.max(a.y, c.y) - Math.min(a.y + a.h, c.y + c.h));
// Pieces lying within `join` of each other form one graphic.
function clusterParts(parts, join) {
  const clusters = [];
  for (const p of parts) {
    const near = clusters.filter(c => c.some(q => boxGap(p.box, q.box) < join));
    for (const c of near) clusters.splice(clusters.indexOf(c), 1);
    clusters.push([p, ...near.flat()]);
  }
  return clusters.map(c => ({ parts: c, box: union(c.map(p => p.box)) }));
}

// Text, photos and portraits: never part of a printed mark.
// Speech bubbles too: their frame (a thin band) and the tail; an arrow
// crossing a frame only loses the crossing point. Their text is masked line
// by line (OCR lines), not as one block: an arrow may end inside the bubble
// next to a short last line.
const bubbleMasks = t => {
  const r = t.bubble, e = 0.004;
  if (!r) return [];
  return [{ x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: 2 * e }, { x: r.x - e, y: r.y + r.h - e, w: r.w + 2 * e, h: 2 * e },
    { x: r.x - 0.012, y: r.y - e, w: 0.012 + e, h: r.h + 2 * e }, { x: r.x + r.w - e, y: r.y - e, w: 2 * e, h: r.h + 2 * e }];
};
const markMasks = (blocks, lines, except) => [...lines.map(l => l.box),
  ...blocks.filter(o => o !== except && o.type === 'image').map(o => grow(o.box, 0.005, 0.005)),
  ...blocks.filter(o => o !== except).flatMap(o => [o.avatar, ...(o.turns || []).map(t => t.speaker?.avatarBox)]).filter(Boolean).map(a => grow(a, 0.01, 0.01)),
  ...blocks.flatMap(o => (o.turns || []).flatMap(bubbleMasks))];

function snapDecor(b, grid, theme, blocks, lines) {
  const target = grow(b.box, 0.01, 0.01);
  const parts = inkParts(grid, theme, blocks, grow(b.box, 0.08, 0.06), { saturated: true, strip: true, masks: markMasks(blocks, lines) })
    .map(p => ({ ...p, hit: overlapShare(target, p.box) > 0 }));
  if (!parts.length) return null;
  // A dashed arrow is many pieces: cluster pieces lying within 1.5% of the
  // page of each other. Take clusters touching the model's box; if none do,
  // the model missed by a few percent: take the nearest cluster.
  const clusters = clusterParts(parts, 0.015);
  let pick = clusters.filter(c => c.parts.some(p => p.hit));
  if (!pick.length) {
    // Nearby and substantial: an arrow outweighs the corner of a bubble tail.
    const score = c => c.parts.reduce((s, p) => s + p.n, 0) * Math.exp(-boxGap(c.box, b.box) / 0.03);
    const best = clusters.filter(c => boxGap(c.box, b.box) < 0.06).sort((p, q) => score(q) - score(p))[0];
    if (best) pick = [best];
  }
  // A graphic is small; a cluster spanning a large part of the page is
  // something else (a border the line filter missed).
  pick = pick.filter(c => c.box.w < 0.35 && c.box.h < 0.3);
  if (!pick.length) return null;
  // The model's box may cover only part of a long arrow: follow the dashes
  // beyond the search window while new ones lie next to what is found.
  let r = union(pick.map(c => c.box));
  for (let round = 0; round < 4; round++) {
    const more = clusterParts(inkParts(grid, theme, blocks, grow(r, 0.05, 0.05), { saturated: true, strip: true, masks: markMasks(blocks, lines) }), 0.015)
      .filter(c => boxGap(c.box, r) < 0.015 && c.box.w < 0.35 && c.box.h < 0.3);
    const next = union([r, ...more.map(c => c.box)]);
    if (next.w > 0.4 || next.h > 0.35 || (Math.abs(next.w - r.w) < 1e-4 && Math.abs(next.h - r.h) < 1e-4)) break;
    r = next;
  }
  return clampBox(grow(r, 0.006, 0.006));
}

// A character drawn over a panel (the tip's Xiaoyu): its strokes near the
// model's box, above the label printed under it.
function snapFigure(box, grid, theme, blocks, lines, below) {
  const parts = inkParts(grid, theme, blocks, grow(box, 0.04, 0.04), { masks: lines.map(l => l.box), scale: 3 });
  if (!parts.length) return null;
  const target = grow(box, 0.005, 0.005);
  const clusters = clusterParts(parts, 0.006).filter(c => c.box.w < 0.2 && c.box.h < 0.2);
  const hit = clusters.filter(c => overlapShare(target, c.box) > 0);
  if (!hit.length) return null;
  // Loose strokes of the same drawing (a raised hand, hair ends) lie right
  // next to it without touching the model's box: take them too.
  let r = union(hit.map(c => c.box));
  for (let grew = true; grew;) {
    grew = false;
    for (const c of clusters) if (!hit.includes(c) && boxGap(c.box, r) < 0.012) { hit.push(c); r = union([r, c.box]); grew = true; }
  }
  r = grow(r, 0.003, 0.003);
  if (below && r.y + r.h > below) r = { ...r, h: Math.max(0.01, below - r.y) };
  return clampBox(r);
}

// Share of a box's outline that is plain paper: a photo reaches its edges
// (even one on a white backdrop has a frame or edge), the bounding box of a
// drawing's shapes mostly runs over paper.
function paperShare(grid, box, bg) {
  const g = grid.raw || grid;
  let n = 0, paper = 0;
  for (let i = 0; i <= 40; i++) for (const [fx, fy] of [[box.x + box.w * i / 40, box.y], [box.x + box.w * i / 40, box.y + box.h], [box.x, box.y + box.h * i / 40], [box.x + box.w, box.y + box.h * i / 40]]) {
    n++; if (dist(g.at(Math.min(g.W - 1, Math.round(fx * g.W)), Math.min(g.H - 1, Math.round(fy * g.H))), bg) < 30) paper++;
  }
  return n ? paper / n : 0;
}

// Illustrations on the page (not framed photos) are loose shapes: grow the
// image to the shapes lying next to it, which the model often leaves out.
function growIllustration(img, box, grid, theme, blocks, lines) {
  const g = grid.raw || grid, bg = backgroundAt(theme, box.x + box.w / 2, box.y + box.h / 2);
  let edge = 0, paper = 0;
  for (let i = 0; i <= 40; i++) for (const [fx, fy] of [[box.x + box.w * i / 40, box.y], [box.x + box.w * i / 40, box.y + box.h], [box.x, box.y + box.h * i / 40], [box.x + box.w, box.y + box.h * i / 40]]) {
    const x = Math.min(g.W - 1, Math.round(fx * g.W)), y = Math.min(g.H - 1, Math.round(fy * g.H));
    edge++; if (dist(g.at(x, y), bg) < 30) paper++;
  }
  if (paper < edge * 0.5) return box; // a framed photo
  const others = blocks.filter(o => o !== img && o.type !== 'decor' && o.type !== 'image').map(o => o.box);
  const parts = inkParts(grid, theme, blocks, grow(box, 0.1, 0.06), { masks: [...markMasks(blocks, lines, img), ...others], scale: 3 });
  const seed = { box, n: 0, seed: true };
  const cluster = clusterParts([seed, ...parts], 0.02).find(c => c.parts.includes(seed));
  return cluster ? clampBox(cluster.box) : box;
}

const FULL_WIDTH = /[\p{Script=Han}，。！？：；、“”‘’（）《》—…]/u;

// Runs of characters printed in colour (red) on hanzi lines: each character
// gets a slot of the OCR line proportional to its width, and its ink decides.
// Returns [] when nothing is coloured, null when there is nothing to read.
function redRuns(grid, hzLines, paper) {
  const g = grid.hi || grid.raw || grid;
  if (!hzLines.length) return null;
  const runs = [];
  let run = '';
  const end = () => { if (run.replace(/[^\p{Script=Han}]/gu, '')) runs.push(run.replace(/^[^\p{Script=Han}]+/u, '')); run = ''; };
  for (const l of hzLines) {
    const chars = Array.from(l.text), weight = c => FULL_WIDTH.test(c) ? 1 : 0.5;
    const total = chars.reduce((u, c) => u + weight(c), 0);
    let u = 0;
    for (const c of chars) {
      const x0 = l.box.x + (u + weight(c) * 0.15) / total * l.box.w, x1 = l.box.x + (u + weight(c) * 0.85) / total * l.box.w;
      u += weight(c);
      let ink = 0, red = 0;
      for (let y = Math.floor((l.box.y + l.box.h * 0.1) * g.H); y < (l.box.y + l.box.h * 0.9) * g.H; y++) for (let x = Math.floor(x0 * g.W); x < x1 * g.W; x++) {
        const p = g.at(x, y);
        if (dist(p, paper) < 90) continue;
        ink++;
        if (p[0] - p[1] > 50 && p[0] - p[2] > 40) red++;
      }
      if (ink < 6) { if (!/\p{Script=Han}/u.test(c) && run) run += c; else end(); continue; }
      if (red / ink > 0.5) run += c; else end();
    }
    end();
  }
  return runs;
}

// Dialogue geometry per turn, measured on the scan: each bubble's frame (its
// border found by walking out of the text), the speaker's name label, the
// pinyin of the name and the portrait above it. Turns can differ in height
// (a two-line reply has a taller bubble), so rows are not assumed equal.
function snapDialogue(b, own, grid, theme, ratio, right, allLines = own) {
  // Speakers form a column left of the bubbles: their name lines mark it.
  const isName = l => b.turns.some(t => plain(l.text) === plain(t.speaker.cn));
  const colRight = Math.max(-1, ...own.filter(isName).map(l => l.box.x + l.box.w));
  const inColumn = l => colRight > 0 ? l.box.x + l.box.w / 2 < colRight + 0.005 : isName(l) || b.turns.some(t => t.speaker.py && matchScore(plain(l.text), plain(t.speaker.py)) >= 0.8);
  const bubbleLines = own.filter(l => !inColumn(l));
  // Lines of each bubble, in reading order: a line goes to the best-matching
  // turn at or after the previous line's turn (replies repeat phrases).
  const per = b.turns.map(() => []);
  const sorted = [...bubbleLines].sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x);
  // Lines of one bubble are stacked tightly; bubbles are separated by a gap.
  // When the gaps give exactly one group per turn, that is the assignment.
  const groups = [];
  for (const l of sorted) {
    const g = groups.at(-1);
    if (g && l.box.y < g.bottom + 0.012) { g.lines.push(l); g.bottom = Math.max(g.bottom, l.box.y + l.box.h); }
    else groups.push({ lines: [l], bottom: l.box.y + l.box.h });
  }
  if (groups.length === b.turns.length) groups.forEach((g, k) => per[k].push(...g.lines));
  let cur = 0;
  if (groups.length !== b.turns.length) for (const l of sorted) {
    const t = plain(l.text);
    let best = -1, score = 0.5;
    b.turns.forEach((turn, k) => {
      if (k < cur) return;
      const s = Math.max(matchScore(t, plain(turn.hz)), matchScore(t, plain(turn.py))) - (k - cur) * 0.05;
      if (s > score) { score = s; best = k; }
    });
    if (best >= 0) { per[best].push(l); cur = best; }
  }
  const usedNames = new Set();
  const turns = b.turns.map((t, k) => {
    const mine = per[k];
    if (!mine.length) return { ...t };
    const tb = union(mine.map(l => l.box)), inside = paperUnder(grid, tb);
    // Left border: probe near the top and the bottom of the text (the tail
    // sits in the middle of the left side), take the inner one.
    const lefts = [tb.y + 0.004, tb.y + tb.h - 0.004].map(y => probe(grid, tb.x - 0.002, y, -1, 0, inside, 0.05)).filter(v => v != null);
    const left = lefts.length ? Math.max(...lefts) : null;
    const ix = left != null ? left + 0.007 : tb.x - 0.006;
    const top = probe(grid, ix, tb.y - 0.001, 0, -1, inside, 0.04);
    const bottom = probe(grid, ix, tb.y + tb.h + 0.001, 0, 1, inside, 0.04);
    // Right border at two heights; the outer one wins over marks drawn inside
    // the bubble (the dashed ring an arrow starts from).
    // A border is solid down the whole bubble; a dashed arrow running along
    // the bubble is not: past such a line the probe goes on.
    const gh = grid.hi || grid.raw || grid, y0 = top ?? tb.y, y1 = bottom ?? tb.y + tb.h;
    const solidV = fx => { let hit = 0; for (let i = 1; i < 10; i++) { const y = Math.round((y0 + (y1 - y0) * i / 10) * gh.H), x = Math.round(fx * gh.W); if ([-1, 0, 1, 2].some(d => dist(gh.at(Math.min(gh.W - 1, x + d), y), inside) > 55)) hit++; } return hit >= 8; };
    const reach = Math.max(0.02, right - tb.x - tb.w + 0.04);
    const border = fy => { let v = probe(grid, tb.x + tb.w + 0.002, fy, 1, 0, inside, reach); for (let k = 0; k < 3 && v != null && !solidV(v); k++) v = probe(grid, v + 0.004, fy, 1, 0, inside, Math.max(0.005, tb.x + tb.w + reach - v)); return v; };
    const rs = [0.2, 0.8].map(f => border(tb.y + tb.h * f)).filter(v => v != null);
    const rightEdge = rs.length ? Math.max(...rs) : null;
    const bubble = { measured: [left, top, bottom, rightEdge].filter(v => v != null).length };
    bubble.x = left ?? tb.x - 0.013;
    bubble.y = top ?? tb.y - 0.008;
    bubble.w = (rightEdge ?? Math.max(right, tb.x + tb.w + 0.02)) - bubble.x;
    bubble.h = (bottom ?? tb.y + tb.h + 0.008) - bubble.y;
    // Font size of the hanzi: from the advance of the printed characters
    // (line width per character), checked against the line height.
    const hzLines = mine.filter(l => /\p{Script=Han}/u.test(l.text)).sort((p, q) => p.box.y - q.box.y);
    const pyLines = mine.filter(l => !/\p{Script=Han}/u.test(l.text));
    const units = s => Array.from(s).reduce((u, c) => u + (/[\p{Script=Han}，。！？：；、“”（）]/u.test(c) ? 1 : 0.5), 0);
    const byH = median(hzLines.map(l => l.box.h / ratio * 100 * 0.84));
    const byW = median(hzLines.map(l => l.box.w * 100 / Math.max(1, units(l.text))));
    const out = { ...t, bubble: { ...clampBox(bubble), measured: bubble.measured }, text: tb, speaker: { ...t.speaker } };
    // Line breaks as printed: hanzi count at the end of each printed line.
    if (hzLines.length > 1) {
      let c = 0;
      out.breaks = hzLines.slice(0, -1).map(l => (c += (l.text.match(/\p{Script=Han}/gu) || []).length));
    } else delete out.breaks;
    out.padL = +Math.max(0.004, tb.x - bubble.x).toFixed(4);
    // Glyph size from the line height; the rest of the printed advance is
    // letter spacing (the book spaces its KaiTi).
    const size = byH;
    if (Number.isFinite(size)) out.size = +size.toFixed(2);
    // Pinyin wider than its hanzi spreads a printed line too; the least
    // spread line of the dialogue shows the tracking itself (see below).
    out.spreads = hzLines.filter(l => units(l.text) >= 3).map(l => l.box.w * 100 / units(l.text) - l.box.h / ratio * 100 * 0.84);
    const pySize = median(pyLines.map(l => l.box.h / ratio * 100 * 0.68));
    if (Number.isFinite(pySize)) out.pySize = +pySize.toFixed(2);
    // Coloured characters, read from the print rather than from the model.
    const marks = redRuns(grid, hzLines, inside);
    if (marks) out.highlight = marks.join('|');
    // Name label: the nearest unused line with the speaker's name at the left
    // of the bubble, around its lower edge.
    const cy = bubble.y + bubble.h;
    const nearest = ok => own.filter(l => !usedNames.has(l) && ok(l) && l.box.x + l.box.w < bubble.x + 0.01 && Math.abs(l.box.y - cy) < 0.06)
      .sort((p, q) => Math.abs(p.box.y - cy) - Math.abs(q.box.y - cy))[0];
    // The model sometimes misnames a speaker (同学们 for a printed 学生们):
    // the hanzi label in the speaker column is what is printed.
    let name = nearest(l => plain(l.text) === plain(t.speaker.cn));
    if (!name && colRight > 0) {
      // That label may not have matched the dialogue at all: look among
      // all page lines in the speaker column.
      const pool = allLines.filter(l => !usedNames.has(l) && l.box.x + l.box.w / 2 < colRight + 0.005 && l.box.x > b.box.x - 0.05 && /^\p{Script=Han}{1,6}$/u.test(l.text.trim()) && l.box.x + l.box.w < bubble.x + 0.01 && Math.abs(l.box.y - cy) < 0.06);
      name = pool.sort((p, q) => Math.abs(p.box.y - cy) - Math.abs(q.box.y - cy))[0];
      if (name) out.speaker.cn = name.text.trim();
    }
    if (name) {
      usedNames.add(name);
      out.speaker.nameBox = name.box;
      const ns = name.box.h / ratio * 100 * 0.84, count = Array.from(name.text.trim()).length;
      out.speaker.nameSize = +ns.toFixed(2);
      // Names are letter-spaced in print ("陈 天 中").
      const spacing = count > 1 ? (name.box.w * 100 - count * ns) / (count - 1) : 0;
      if (spacing > 0.15) out.speaker.nameSpacing = +Math.min(spacing, ns).toFixed(2);
      const py = allLines.find(l => !usedNames.has(l) && inColumn(l) && !/\p{Script=Han}/u.test(l.text) && l.box.x > b.box.x - 0.05 && Math.abs(l.box.y + l.box.h - name.box.y) < 0.012);
      if (py) { usedNames.add(py); out.speaker.pyBox = py.box; }
      // Portrait (or group icon) sits just above the name's pinyin.
      const cx = name.box.x + name.box.w / 2, above = (py ? py.box.y : name.box.y) - 0.004;
      const d = 0.056, dh = d * ratio;
      if (t.speaker.avatar !== 'none') out.speaker.avatarBox = clampBox({ x: cx - d / 2, y: above - dh, w: d, h: dh });
    }
    return out;
  });
  // Bubbles of a dialogue share their right edge; one whose border was not
  // found takes the others'.
  const rights = turns.filter(t => t.bubble && t.bubble.measured === 4).map(t => t.bubble.x + t.bubble.w);
  const rightTypical = median(rights);
  if (Number.isFinite(rightTypical)) for (const t of turns) if (t.bubble && t.bubble.measured < 4) t.bubble.w = Math.max(t.text.x + t.text.w + 0.01, rightTypical) - t.bubble.x;
  const parts = turns.flatMap(t => [t.bubble, t.speaker.avatarBox, t.speaker.nameBox, t.speaker.pyBox]).filter(Boolean);
  if (!parts.length) return { turns };
  const box = grow(union(parts), 0.002, 0.002);
  // One type size per dialogue, as printed; spread-out lines (pinyin wider
  // than its hanzi) must not enlarge a single reply.
  const size = median(turns.map(t => t.size)), pySize = median(turns.map(t => t.pySize));
  const spreads = turns.flatMap(t => t.spreads || []), track = spreads.length ? Math.max(0, Math.min(...spreads, size * 0.4)) : 0;
  for (const t of turns) {
    delete t.spreads;
    if (track > 0.05) t.track = +track.toFixed(2); else delete t.track;
    if (Number.isFinite(size) && t.size && Math.abs(t.size / size - 1) < 0.2) t.size = size;
    if (Number.isFinite(pySize) && t.pySize && Math.abs(t.pySize / pySize - 1) < 0.25) t.pySize = pySize;
  }
  return { turns, box, ...(Number.isFinite(size) ? { size } : {}), measured: turns.every(t => t.bubble && t.speaker.nameBox) };
}

// Section tab ("课文 2 | Text 2"): the coloured tab is found from the line of
// its hanzi title (white glyphs on the tab colour), the white tag from the
// remaining lines. A panel under the tab never takes its colour.
const sectionCache = new WeakMap();
function snapSection(b, own, grid) {
  if (sectionCache.has(b)) return sectionCache.get(b);
  let out = null;
  const cnLine = own.map(l => ({ l, s: matchScore(plain(l.text), plain(b.cn)) })).filter(x => x.s >= 0.6).sort((p, q) => q.s - p.s)[0]?.l;
  if (cnLine) {
    const c = cnLine.box, samples = [];
    for (let y = Math.floor(c.y * grid.H); y <= (c.y + c.h) * grid.H && y < grid.H; y++) for (let x = Math.floor(c.x * grid.W); x <= (c.x + c.w) * grid.W && x < grid.W; x++) {
      const p = grid.at(x, y); if (dist(p, [255, 255, 255]) > 60 && p[0] + p[1] + p[2] > 200) samples.push(p);
    }
    const tmpl = samples.length > 20 ? modeColor(samples, 4).color : null;
    if (tmpl) {
      // Snap the mode to the template's own class colour.
      const cls = samples.filter(p => dist(p, tmpl) < 20);
      const col = cls.length ? cls[0] : tmpl;
      let found = flood(grid, seedsIn(grid, c, 2), { x: c.x - 0.3, y: c.y - 0.03, w: c.w + 0.6, h: c.h + 0.06 }, p => dist(p, col) < 30);
      if (found && (found.h > 0.08 || found.w > 0.75 || found.h < c.h * 0.8)) found = null;
      if (found) {
        // A character drawn over the tab splits it: the tab goes on left of
        // the drawing (to the page edge on feature tabs).
        let left = found.x;
        for (const f of [0.3, 0.6, 0.9]) {
          const y = Math.min(grid.H - 1, Math.round((found.y + found.h * f) * grid.H));
          for (let x = Math.round(found.x * grid.W) - 1; x >= Math.max(0, Math.round((found.x - 0.25) * grid.W)); x--) if (dist(grid.at(x, y), col) < 30 && x / grid.W < left) left = x / grid.W;
        }
        if (left < found.x - 0.01) found = { ...found, w: found.w + found.x - left, x: left };
      }
      if (found) {
        let sum = [0, 0, 0], n = 0;
        for (let y = Math.floor(found.y * grid.H); y < (found.y + found.h) * grid.H && y < grid.H; y += 2) for (let x = Math.floor(found.x * grid.W); x < (found.x + found.w) * grid.W && x < grid.W; x += 2) {
          if (dist(grid.at(x, y), col) < 2) { const p = (grid.raw || grid).at(x, y); sum = sum.map((v, i) => v + p[i]); n++; }
        }
        const rest = own.filter(l => l !== cnLine && Math.abs(l.box.y + l.box.h / 2 - (found.y + found.h / 2)) < 0.04);
        const tag = rest.length ? grow(union(rest.map(l => l.box)), 0.008, 0.006) : null;
        const box = tag ? union([found, tag]) : found;
        out = {
          box, fill: hex(clean(n >= 10 ? sum.map(v => v / n) : col)), cnSize: +(c.h * grid.H / grid.W * 100 * 0.85).toFixed(2), titleLine: c,
          split: +Math.max(0.3, Math.min(tag ? 0.95 : 1, (found.x + found.w - box.x) / box.w)).toFixed(3),
          tabH: +Math.max(0.3, Math.min(1, found.h / box.h)).toFixed(3)
        };
      }
    }
  }
  sectionCache.set(b, out);
  return out;
}

// Video bonus panel: a coloured panel, a player bar along its bottom and a
// picture inside. Title position is kept from OCR.
function snapBonus(b, text, grid, theme, own = []) {
  const out = {};
  const bg = backgroundAt(theme, b.box.x + b.box.w / 2, b.box.y + b.box.h / 2);
  const inner = text ? fillColor(grid, text) : interiorColor(grid, b.box);
  if (inner && dist(inner, bg) > 18) {
    const seeds = text ? seedsIn(grid, grow(text, 0.004, 0.003)) : seedsIn(grid, grow(b.box, -b.box.w * 0.3, -b.box.h * 0.3), 4);
    const found = flood(grid, seeds, grow(b.box, 0.04, 0.04), p => dist(p, inner) < 38);
    // A picture on the panel in a colour close to it (a wooden easel) lets
    // the flood run past the panel's edge: keep the panel's solid extent.
    if (found?.solidRight && found.solidRight < found.x + found.w - 0.01) found.w = found.solidRight - found.x;
    if (found?.solidLeft && found.solidLeft > found.x + 0.01) { found.w -= found.solidLeft - found.x; found.x = found.solidLeft; }
    if (found && found.w > b.box.w * 0.5 && found.h > b.box.h * 0.4) {
      out.fill = hex(clean(paperUnder(grid, grow(found, -found.w * 0.05, -found.h * 0.1))));
      // The bar: darker strip below the panel colour, down to the page.
      const g = grid.raw || grid, x = Math.floor((found.x + found.w * 0.18) * g.W);
      let y = Math.min(g.H - 1, Math.ceil((found.y + found.h) * g.H)), sum = [0, 0, 0], n = 0;
      while (y < g.H && dist(g.at(x, y), bg) > 30 && n < g.H * 0.08) { const p = g.at(x, y); sum = sum.map((v, i) => v + p[i]); n++; y++; }
      const box = { ...found };
      if (n / g.H > 0.01) {
        box.h += n / g.H; out.barH = +(n / g.H / box.h).toFixed(3);
        // The bar's colour is its most common one: a column average picks up
        // the white icons and the darker track.
        const by0 = Math.ceil((found.y + found.h) * g.H), samples = [];
        for (let yy = by0 + 1; yy < by0 + n - 1; yy++) for (let xx = Math.floor(found.x * g.W); xx < (found.x + found.w) * g.W; xx += 2) samples.push(g.at(xx, yy));
        const top = samples.length > 20 ? modeColor(samples, 5).color : null, pool = top ? samples.filter(p => dist(p, top) < 20) : [];
        out.bar = hex(pool.length >= 8 ? [0, 1, 2].map(i => pool.reduce((s, p) => s + p[i], 0) / pool.length) : sum.map(v => v / n));
      }
      out.box = box;
    }
  }
  if (text) out.titleBox = text;
  // Title sizes from the printed widths of its lines (the hanzi title and
  // the serif caption under it), in cqw.
  const cnLine = own.find(l => /\p{Script=Han}/u.test(l.text)), enLine = own.find(l => l !== cnLine && /[A-Za-z]/.test(l.text) && !/\p{Script=Han}/u.test(l.text));
  if (cnLine) { const u = Array.from(cnLine.text).reduce((s, c) => s + (FULL_WIDTH.test(c) ? 1 : arialEm(c)), 0); if (u) out.cnSize = +(cnLine.box.w * 100 * 0.96 / u).toFixed(2); }
  if (enLine) { const u = timesEm(enLine.text); if (u) out.enSize = +(enLine.box.w * 100 * 0.96 / u).toFixed(2); }
  if (b.image) {
    const fill = out.fill ? parseHex(out.fill) : inner || bg;
    const found = flood(grid, seedsIn(grid, grow(b.image, -b.image.w * 0.3, -b.image.h * 0.3), 3), grow(b.image, 0.03, 0.03), p => dist(p, fill) > 30 && dist(p, bg) > 20);
    out.image = found && found.w > b.image.w * 0.5 && found.h > b.image.h * 0.5 ? clampBox(grow(found, 0.002, 0.002)) : b.image;
    // The flood stops at parts close to the panel colour (an easel's wooden
    // legs and top): extend the picture while the rows and columns next to
    // it still hold pixels of neither the panel nor the page, not into the
    // player bar.
    const panel = out.box ? { ...out.box, h: out.box.h * (1 - (out.barH || 0)) } : null;
    out.image = extendPicture(grid, out.image, fill, bg, panel);
  }
  return out;
}

function extendPicture(grid, box, fill, bg, panel) {
  const g = grid.raw || grid, W = g.W, H = g.H;
  const lim = grow(box, 0.05, 0.05);
  const y0 = Math.max(0, Math.floor(lim.y * H)), y1 = Math.min(H - 1, Math.ceil((lim.y + lim.h) * H));
  const x0 = Math.max(0, Math.floor(lim.x * W)), x1 = Math.min(W - 1, Math.ceil((lim.x + lim.w) * W));
  const barTop = panel ? Math.floor((panel.y + panel.h) * H) - 1 : y1;
  const odd = (x, y) => { const p = g.at(x, y); return dist(p, fill) > 20 && dist(p, bg) > 20; };
  let L = Math.floor(box.x * W), R = Math.ceil((box.x + box.w) * W), T = Math.floor(box.y * H), B = Math.ceil((box.y + box.h) * H);
  const rowHas = y => { let n = 0; for (let x = L; x <= R; x++) if (odd(x, y)) n++; return n >= 2; };
  const colHas = x => { let n = 0; for (let y = T; y <= B; y++) if (odd(x, y)) n++; return n >= 2; };
  for (let grew = true; grew;) {
    grew = false;
    if (T > y0 && rowHas(T - 1)) { T--; grew = true; }
    if (B < Math.min(y1, barTop) && rowHas(B + 1)) { B++; grew = true; }
    if (L > x0 && colHas(L - 1)) { L--; grew = true; }
    if (R < x1 && colHas(R + 1)) { R++; grew = true; }
  }
  return clampBox({ x: L / W, y: T / H, w: (R - L) / W, h: (B - T) / H });
}

// Re-measure every block against the scan. Returns a new layout with exact
// boxes, per-block fill colours and font scales, and the page theme.
export function snap(layout, grid, ocr) {
  const lines = ocrLinesOf(ocr), hits = assignLines(layout.blocks, lines);
  const ratio = (layout.page?.width || 1) / (layout.page?.height || 1);
  const theme = extractTheme(grid.raw || grid);
  const blocks = layout.blocks.map((b, n) => {
    const own = hits[n], next = { ...b };
    // A caption's translation the print does not carry («鸡 jī» under a photo, no «chicken»): any scan
    // line around the caption may hold it, assigned to this block or not.
    if (b.type === 'text' && b.cn && b.en && !gridRows(b)) { const area = grow(b.box, 0.03, 0.02); if (!lines.some(l => l.box.x + l.box.w / 2 >= area.x && l.box.x + l.box.w / 2 <= area.x + area.w && l.box.y + l.box.h / 2 >= area.y && l.box.y + l.box.h / 2 <= area.y + area.h && matchScore(plain(l.text), plain(b.en)) >= 0.5)) next.trOff = true; }
    delete next.fill; delete next.k;
    const text = own.length ? union(own.map(l => l.box)) : null;
    if (b.type === 'decor') {
      // Graphics are cut out with everything else made transparent (see the
      // server). The model's box can be several percent off: find the marks
      // themselves around it; a generous box guards against clipping.
      next.box = grow(b.box, 0.015, 0.015); // refined below, once panels are known
    } else if (b.type === 'image') {
      const seeds = seedsIn(grid, grow(b.box, -b.box.w * 0.3, -b.box.h * 0.3), 4);
      const big = f => f && f.w > b.box.w * 0.5 && f.h > b.box.h * 0.5;
      // A photo is solid; a frame line, a caption or a neighbour touching it
      // is thin. Flooding only through solid pixels keeps the cut to the photo.
      const solid = solidTest(grid), pad = solid.r / grid.W;
      let found = flood(grid, seeds, grow(b.box, 0.06, 0.05), (p, x, y) => solid(x, y));
      if (found) found = clampBox(grow(found, pad, solid.r / grid.H));
      if (!big(found)) found = flood(grid, seeds, grow(b.box, 0.06, 0.05), p => dist(p, grid.bg) > 30);
      // A drawing (loose shapes with paper between them) floods only its
      // largest connected shape: keep the model's extent for it, and let
      // growIllustration find all its parts later.
      // Light photos also show paper-like edges: the model's own word for the
      // picture ("Иллюстрация…" vs "Фотография…") decides, the edges confirm.
      const drawn = /иллюстрац|рисун|illustrat|drawing|clip ?art|cartoon/i.test(String(b.alt || ''));
      const drawing = drawn && found && paperShare(grid, found, backgroundAt(theme, found.x + found.w / 2, found.y + found.h / 2)) > 0.5;
      if (big(found) && !drawing) { next.box = extendToOutline(grid, found); SOLID_PHOTOS.add(next); }
      else if (drawing) next.box = union([found, b.box]);
    } else if (b.type === 'section' && text && snapSection(b, own, grid)) {
      Object.assign(next, snapSection(b, own, grid));
    } else if (PANEL_TYPES.has(b.type) && text) {
      // A folio pill is hardly taller than its digits, so a ring around them
      // runs over the paper: read it on the digits' middle line instead.
      const probeBox = b.type === 'folio' ? { x: text.x, y: text.y + text.h * 0.45, w: text.w, h: text.h * 0.1 } : text;
      const fill = fillColor(grid, probeBox, theme.background?.color ? parseHex(theme.background.color) : null);
      let win = union([grow(text, Math.max(0.09, text.w * 0.5), Math.max(0.05, text.h * 0.5)), b.box]);
      // The lesson band runs across the page however short its title is: a
      // window cut at the title would cut the band (and its fold) short.
      if (b.type === 'lesson') win = { ...win, x: 0, w: 1 };
      let found = fill && dist(fill, grid.bg) > 18 ? flood(grid, seedsIn(grid, grow(text, 0.004, 0.003)), win, p => dist(p, fill) < 38) : null, leaked = false;
      // A fill that leaked into the page (a light panel on a light background)
      // grows far beyond its text; real panels are at most a few times larger.
      // Colour alone is not proof: white glyphs fill the inside of a red tab.
      if (found) {
        const grown = (found.w * found.h) / Math.max(1e-6, text.w * text.h), inner = interiorColor(grid, found);
        if (grown > 12 || (grown > 4 && inner && dist(inner, grid.bg) < 24)) found = null, leaked = true;
      }
      // The fill escaped through a gap in the panel's outline (a tab overlapping its
      // corner): thin gaps do not survive a flood that needs a solid 7x7 of fill.
      if (!found && leaked && fill) {
        const inFill = solidBy(grid, p => dist(p, fill) < 38, 0.8, 3);
        const again = flood(grid, seedsIn(grid, grow(text, 0.004, 0.003)), win, (p, x, y) => inFill(x, y));
        if (again) {
          const cand = clampBox(grow(again, 3 / grid.W, 3 / grid.H));
          if ((cand.w * cand.h) / Math.max(1e-6, text.w * text.h) <= 6) found = cand;
        }
      }
      // Tabs and pills stick out of their panel, as do loose OCR boxes; the
      // section tag ("Text 1") sits beside its tab, so that one keeps both.
      next.box = !found ? grow(text, 0.01, 0.006) : b.type !== 'section' && overlapShare(found, text) >= 0.8 ? found : union([found, text]);
      // A white panel on a white page has no fill to find, only an outline: read the outline around the text.
      if (!found) {
        const outline = detectFrame(grid, text, { side: 0.07, above: 0.06, below: 0.06, maxW: 0.98, maxArea: 0.6 });
        if (outline && outline.w * outline.h <= text.w * text.h * 3) next.box = { x: outline.x, y: outline.y, w: outline.w, h: outline.h };
      }
      // Colour comes from the denoised scan, not the template. The interior
      // refines the ring colour (lines and dashes tint the ring) but may be
      // dominated by large white glyphs on a coloured tab; trust it only when
      // it agrees with the ring.
      if (found) {
        // The template says which pixels are the panel; the scan says what
        // colour they are: average the scan over the panel's template class.
        let sum = [0, 0, 0], count = 0;
        if (grid.raw) for (let y = Math.floor(found.y * grid.H); y < (found.y + found.h) * grid.H && y < grid.H; y += 2) for (let x = Math.floor(found.x * grid.W); x < (found.x + found.w) * grid.W && x < grid.W; x += 2) {
          if (dist(grid.at(x, y), fill) < 2) { const p = grid.raw.at(x, y); sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; count++; }
        }
        const measured = count >= 10 ? sum.map(v => v / count) : null;
        const inner = interiorColor(grid, found);
        next.fill = hex(clean(measured || (inner && dist(inner, fill) < 60 ? inner : fill)));
      } else if (fill && b.type === 'folio') {
        // The flood found no panel around the digits (the folio pill is
        // hardly larger than they are): the ring sampled around them is its
        // colour, not the model's guess.
        next.fill = hex(clean(fill));
      }
      // Share of the section box taken by the coloured tab (the rest is the
      // white "Text 1" tag); measured, because it differs between pages.
      if (b.type === 'section' && found) {
        // Walk the tab's top margin (above the glyphs) to its right edge.
        const y = Math.min(grid.H - 1, Math.round((found.y + found.h * 0.1) * grid.H));
        let x = Math.round(found.x * grid.W), gap = 0, end = x;
        while (x < grid.W - 1 && gap <= 2) { if (dist(grid.at(x, y), fill) < 38) { end = x; gap = 0; } else gap++; x++; }
        const right = Math.max((end + 1) / grid.W, found.solidRight);
        next.split = +Math.max(0.4, Math.min(0.95, (right - next.box.x) / next.box.w)).toFixed(3);
        next.tabH = +Math.max(0.3, Math.min(1, found.h / next.box.h)).toFixed(3);
      }
      if (b.type === 'words') {
        const tab = own.find(l => b.heading && matchScore(plain(l.text), plain([b.heading.cn, b.heading.en].join(''))) >= 0.6);
        if (tab) { const top = tab.box.y + tab.box.h / 2, bottom = next.box.y + next.box.h; if (top > next.box.y) next.box = { ...next.box, y: top, h: bottom - top }; }
        // OCR sees only the printed glyphs inside a phonetic chart. Preserve
        // the model's table frame as a lower bound instead of shrinking the
        // component to the first few columns of text.
        if (b.phoneticChart && b.box && next.box.w < b.box.w * 0.78) next.box = union([next.box, b.box]);
        const cols = wordColumns(next.box, own.filter(l => l !== tab), grid, (b.rows || []).some(r => r.pos_en || r.pos_ru) ? 4 : 3);
        if (cols) next.cols = cols;
      }
    } else if (text) {
      // The printed number box («1») is drawn left of the text, outside the
      // block: its OCR digit must not widen the text box.
      const body = b.type === 'para' && b.number ? own.filter(l => plain(l.text) !== plain(b.number)) : own;
      next.box = grow(body.length && body.length < own.length ? union(body.map(l => l.box)) : text, 0.003, 0.003);
      if (b.type === 'para' && b.icon === 'square' && !b.number) { next.box.x -= 0.025; next.box.w += 0.025; }   // a number box is drawn outside the text instead
      // Coloured print (a red sub-heading «(1) 韵母…»): the ink of the first line, read from the scan.
      if (b.type === 'para' && own.length) {
        const l0 = own.slice().sort((p, q) => p.box.y - q.box.y)[0], ink = [];
        for (let y = Math.floor(l0.box.y * grid.H); y < (l0.box.y + l0.box.h) * grid.H && y < grid.H; y++) for (let x = Math.floor(l0.box.x * grid.W); x < (l0.box.x + l0.box.w) * grid.W && x < grid.W; x++) { const p = grid.at(x, y); if (dist(p, grid.bg) > 90) ink.push(p); }
        // Coloured when most of the ink is clearly reddish (anti-aliasing mixes thin strokes with paper).
        const reds = ink.filter(p => p[0] - Math.max(p[1], p[2]) > 45);
        if (ink.length > 20 && reds.length > ink.length * 0.35) next.ink = hex([0, 1, 2].map(c => reds.reduce((s, p) => s + p[c], 0) / reds.length));
      }
      // The translation printed on its own line under a one-line instruction
      // (workbook style), not run on after it.
      if (b.type === 'para' && b.cn && b.en && !b.py) {
        const han = own.filter(l => /\p{Script=Han}/u.test(l.text)), lat = own.filter(l => !/\p{Script=Han}/u.test(l.text) && /[a-z]{3}/i.test(l.text));
        // One instruction line with its translation under it…
        if (!String(b.cn).includes('\n') && han.length === 1 && !/[a-z]{3}/i.test(han[0].text) && lat.length === 1 && lat[0].box.y >= han[0].box.y + han[0].box.h * 0.8 && Math.abs(lat[0].box.x - han[0].box.x) < 0.025) next.enBreak = true;
        // …or a whole Chinese passage, then the whole English one (workbook theory).
        const hanEnd = Math.max(...han.map(l => l.box.y + l.box.h));
        if (han.length >= 2 && lat.length >= 2 && han.every(l => !/[a-z]{4}/i.test(l.text)) && lat.every(l => l.box.y >= hanEnd - han[0].box.h * 0.3) && Math.abs(Math.min(...lat.map(l => l.box.x)) - Math.min(...han.map(l => l.box.x))) < 0.06) next.enBreak = true;
        // Paragraphs printed with a first-line indent (the first line starts right of the others).
        const hs = han.slice().sort((p, q) => p.box.y - q.box.y);
        if (next.enBreak && hs.length >= 2 && hs[0].box.x - Math.min(...hs.slice(1).map(l => l.box.x)) > 0.02) next.indent = true;
        // Long explanatory passages in HSK workbooks print the Chinese text
        // first and the translation as a separate paragraph. Keep that
        // reading order in the web version even when OCR merges language
        // lines or assigns them inconsistently.
        const hanCount = (String(b.cn).match(/\p{Script=Han}/gu) || []).length;
        if (hanCount >= 24 && (String(b.ru || '').length >= 40 || String(b.en || '').length >= 40)) next.enBreak = true;
      }
      // A table flattened into lines (Chinese headers, then columns of short syllables: «声母 Initials |
      // 韵母 Finals» on workbook p7) cannot be rebuilt from the list: it is shown as cut from the scan,
      // inside its printed frame. Nothing in it needs translating.
      const tl = String(b.cn || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (b.type === 'text' && !gridRows(b) && tl.length >= 6 && tl.some(s => /\p{Script=Han}/u.test(s)) && tl.filter(s => s.length <= 10 && !/\p{Script=Han}{3}/u.test(s)).length >= tl.length * 0.6) {
        const frame = detectFrame(grid, text, { side: 0.12, above: 0.04, below: 0.12, maxW: 0.95, maxArea: 0.4 });
        let area = frame && frame.w * frame.h >= text.w * text.h * 0.8 ? frame : grow(text, 0.02, 0.015);
        // The frame is often lost under the coloured header: the table spans from where the instruction
        // above it starts to the right edge of the page's text column.
        let k = n - 1; while (k >= 0 && layout.blocks[k].type !== 'para') k--;
        const instr = k >= 0 ? hits[k].filter(l => /\p{Script=Han}|[a-z]{3}/iu.test(l.text)) : [];
        const body = lines.filter(l => l.box.y > 0.08 && l.box.y < 0.94 && l.box.w > 0.25), right = body.length ? Math.max(...body.map(l => l.box.x + l.box.w)) : area.x + area.w;
        if (instr.length) { const left = Math.min(...instr.map(l => l.box.x)) - 0.004, r = Math.max(area.x + area.w, right + 0.004); area = { ...area, x: Math.min(area.x, left), w: r - Math.min(area.x, left) }; } const top = Math.min(area.y, text.y - 0.012); area = { ...area, y: top, h: area.y + area.h - top };
        // A complex drill remains text even when its row/column structure is
        // unresolved. Keep every OCR token at its printed coordinates.
        const tokens = lines.filter(l => l.box.x+l.box.w/2>=area.x && l.box.x+l.box.w/2<=area.x+area.w && l.box.y+l.box.h/2>=area.y && l.box.y+l.box.h/2<=area.y+area.h);
        Object.assign(next, { type: 'text', box: clampBox(area), exactTokens: tokens, unresolvedStructure: true });
      }
      // OCR sees the syllables of a drill, not its blank lines: blanks before
      // the syllables start where the instruction text starts, blanks after
      // them run to the instruction's right edge.
      const rows = gridRows(b);
      // Cells listed one per line, column by column: the printed rows are the
      // bands of OCR syllables; remember how many, the render lays them out.
      // A list of cells: each takes the place where the scan prints the same syllable (the model may
      // list them by rows or by columns — the scan decides). OCR lines holding several syllables
      // are split into words at estimated positions.
      if (rows && rows.every(r => r.length === 1) && own.length) {
        // Words of the OCR lines; syllables run together («jījí») are split at each pinyin syllable.
        const SYL = /[bcdfghjklmnpqrstwxyz]*h?[aeiouvüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+(?:ng|n|r(?![aeiouāáǎàēéěèīíǐìōóǒòūúǔùü]))?/giu;
        const words = own.flatMap(l => { const s = l.text.trim(), total = s.length || 1; const parts = []; for (const m of s.matchAll(/\S+/g)) { const syl = [...m[0].matchAll(SYL)]; if (syl.length > 1 && syl.map(x => x[0]).join('') === m[0].replace(/[^\p{L}]/gu, '')) for (const x of syl) parts.push({ w: x[0], k: m.index + x.index }); else parts.push({ w: m[0], k: m.index }); } return parts.map(p => ({ w: p.w, x: l.box.x + l.box.w * p.k / total, y: l.box.y + l.box.h / 2, used: false })); });
        const nfc = s => String(s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const pick = (item, test) => words.find(w => !w.used && test(w)) || null;
        // Exact matches first (tones included), then by letters only for what is left.
        const items = rows.map(r => r[0].replace(/_{3,}/g, '').trim()), xy = items.map(() => null);
        for (const pass of [w => item => nfc(w.w) === nfc(item), w => item => plain(w.w) === plain(item)]) items.forEach((item, k) => { if (xy[k] || !item) return; const w = pick(item, cand => pass(cand)(item)); if (w) { w.used = true; xy[k] = [+w.x.toFixed(4), +w.y.toFixed(4)]; } });
        // Printed columns from all rows; each row's cells take, in order, the columns nearest to them
        // (positions estimated inside run-together words move onto the real column).
        const found = xy.filter(Boolean), cols = [];
        for (const x of found.map(p => p[0]).sort((p, q) => p - q)) { const c = cols[cols.length - 1]; if (c && x - c.at(-1) < 0.02) c.push(x); else cols.push([x]); }
        const lattice = cols.filter(c => c.length >= 2).map(c => median(c));
        const rowsOf = []; found.slice().sort((p, q) => p[1] - q[1]).forEach(p => { const r = rowsOf.find(r => Math.abs(r[0][1] - p[1]) < 0.012); if (r) r.push(p); else rowsOf.push([p]); });
        if (lattice.length >= 2) for (const r of rowsOf) {
          r.sort((p, q) => p[0] - q[0]);
          if (r.length > lattice.length) continue;
          // Ordered assignment of the row's cells to columns with the least total shift (small DP).
          const m = r.length, L = lattice.length, cost = Array.from({ length: m + 1 }, () => new Array(L + 1).fill(Infinity)), from = Array.from({ length: m + 1 }, () => new Array(L + 1).fill(-1));
          cost[0].fill(0);
          for (let i = 1; i <= m; i++) for (let j = i; j <= L; j++) { const keep = cost[i][j - 1], take = cost[i - 1][j - 1] + Math.abs(r[i - 1][0] - lattice[j - 1]); if (take <= keep) { cost[i][j] = take; from[i][j] = j - 1; } else { cost[i][j] = keep; from[i][j] = from[i][j - 1]; } }
          let j = L; for (let i = m; i >= 1 && j > 0; i--) { const c = from[i][j]; if (c < 0) break; if (Math.abs(r[i - 1][0] - lattice[c]) < 0.05) r[i - 1][0] = +lattice[c].toFixed(4); j = c; }
        }
        if (xy.filter(Boolean).length >= rows.length * 0.7) next.cellXY = xy;
      }
      if (rows && rows.every(r => r.length === 1) && own.length >= 3 && !next.cellXY) {
        const ys = own.map(l => ({ y: l.box.y + l.box.h / 2, h: l.box.h })).sort((p, q) => p.y - q.y), gap = median(ys.map(o => o.h)) * 0.6;
        const bands = ys.filter((o, i) => !i || o.y - ys[i - 1].y > gap).length;
        if (bands >= 2 && bands < rows.length) next.gridR = bands;
      }
      if (rows) {
        let k = n - 1; while (k >= 0 && layout.blocks[k].type !== 'para') k--;
        const head = k >= 0 ? hits[k].filter(l => /\p{Script=Han}|[a-z]{3}/iu.test(l.text)) : [];
        if (head.length) {
          const left = Math.min(...head.map(l => l.box.x)), right = Math.max(...head.map(l => l.box.x + l.box.w), layout.blocks[k].box.x + layout.blocks[k].box.w * 0.9);
          const lead = rows.some(r => /^_{3,}/.test(r[0] || '')), trail = rows.some(r => /_{3,}$/.test(r[r.length - 1] || ''));
          const x = lead ? Math.min(next.box.x, left) : next.box.x, end = trail ? Math.max(next.box.x + next.box.w, right) : next.box.x + next.box.w;
          next.box = { ...next.box, x, w: end - x };
        }
        // Where the printed columns and rows are: syllable starts and line
        // middles of the OCR tokens (blank lines are not read, the syllables
        // beside them are). Used only when the counts match the cells.
        const cells = gridLayout(b, next.gridR), R = cells.length, C = Math.max(...cells.map(r => r.length));
        const toks = own.filter(l => !/^\d+$/.test(plain(l.text)));
        const groups = (vals, gap) => { const s = vals.slice().sort((p, q) => p - q), out = []; for (const v of s) { const g = out[out.length - 1]; if (g && v - g[g.length - 1] <= gap) g.push(v); else out.push([v]); } return out.map(g => median(g)); };
        const hMed = toks.length ? median(toks.map(l => l.box.h)) : 0;
        const xs = groups(toks.map(l => l.box.x), 0.025), ys = groups(toks.map(l => l.box.y + l.box.h / 2), hMed * 0.6);
        if (xs.length === C && C > 1) next.gridX = xs.map(v => +v.toFixed(4));
        if (ys.length === R && R > 1) next.gridY = ys.map(v => +v.toFixed(4));
        if (hMed) next.gridH = +hMed.toFixed(4);
      }
    }
    if (b.type === 'dialogue' && text) {
      // Rows run from the first avatar to the last speaker label; bubbles keep
      // the model's right edge, which is stable for fixed-width bubbles.
      let right = Math.max(text.x + text.w + 0.03, b.box.x + b.box.w);
      // …but never into a neighbour on the right (a word table or photo beside
      // the dialogue), which would make the fit step shrink the whole dialogue.
      for (const o of layout.blocks) {
        if (o === b || o.type === 'decor' || !o.box) continue;
        const vertical = o.box.y < text.y + text.h && o.box.y + o.box.h > text.y;
        if (vertical && o.box.x > text.x + text.w - 0.005 && o.box.x - 0.012 < right) right = Math.max(text.x + text.w + 0.01, o.box.x - 0.012);
      }
      Object.assign(next, snapDialogue(b, own, grid, theme, ratio, right, lines));
    }
    // Workbook running head: the title in white on a coloured tab, the English
    // title beside it on the same line (the textbook stacks them, unfilled).
    if (b.type === 'runhead' && text && b.box.x < 0.5) {
      const han = own.find(l => /\p{Script=Han}/u.test(l.text)), lat = own.find(l => !/\p{Script=Han}/u.test(l.text) && /[a-z]{3}/i.test(l.text));
      if (han && lat && Math.abs((lat.box.y + lat.box.h / 2) - (han.box.y + han.box.h / 2)) < han.box.h * 0.6 && lat.box.x > han.box.x + han.box.w - 0.01) {
        const fill = fillColor(grid, han.box, null);
        if (fill && dist(fill, grid.bg) > 60) {
          next.tab = hex(clean(fill));
          next.box = { ...next.box, x: Math.min(next.box.x, han.box.x - 0.012), y: han.box.y - han.box.h * 0.25, h: han.box.h * 1.5 };
          next.tabW = +((han.box.x + han.box.w + 0.012) - next.box.x).toFixed(4);
        }
      }
    }
    // «Lesson» over the band is a textbook label; the workbook prints none: keep it only when the scan shows it.
    if (b.type === 'lesson' && b.label && !lines.some(l => /^lesson\b/i.test(l.text.trim()) && l.box.y < b.box.y + b.box.h && l.box.y + l.box.h > b.box.y - 0.04 && l.box.x < b.box.x + b.box.w * 0.4)) next.label = '';
    if (b.type === 'runhead' && text && b.number) {
      // The big lesson number is its own OCR line right of the running head.
      const no = lines.find(l => plain(l.text) === plain(b.number) && l.box.x >= text.x + text.w - 0.01 && l.box.x < text.x + text.w + 0.08 && Math.abs(l.box.y + l.box.h / 2 - (text.y + text.h / 2)) < 0.03);
      if (no) { next.box = grow(union([text, no.box]), 0.003, 0.003); next.numSize = +(no.box.h / ratio * 100 / 0.8).toFixed(2); }
    }
    if (b.type === 'bonus') Object.assign(next, snapBonus(b, text, grid, theme, own));
    // Characters drawn over a tab or a tip panel: measured from their strokes,
    // and never down into the label printed under them ("小语助力").
    if (b.type === 'tip' && b.avatar && b.label?.cn) next.labelLine = own.find(l => matchScore(plain(l.text), plain(b.label.cn)) >= 0.6)?.box;
    // Verse with pinyin: hanzi, pinyin and translation lines are measured
    // separately (they are printed in three sizes).
    let sized = own;
    if (b.type === 'para' && b.py && own.length) {
      const han = own.filter(l => /\p{Script=Han}/u.test(l.text)), toned = own.filter(l => !/\p{Script=Han}/u.test(l.text) && /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(l.text));
      const hz = median(han.map(l => l.box.h / ratio * 100 * 0.68)), pys = median(toned.map(l => l.box.h / ratio * 100 * 0.68));
      if (Number.isFinite(hz)) next.hzSize = +hz.toFixed(2);
      // Printed verse is letter-spaced: advance per character minus glyph size.
      const units = s => Array.from(s).reduce((u, c) => u + (FULL_WIDTH.test(c) ? 1 : 0.5), 0);
      const tr = Math.min(...han.filter(l => units(l.text) >= 4).map(l => l.box.w * 100 / units(l.text) - hz));
      if (Number.isFinite(tr) && tr > 0.05) next.vtrack = +Math.min(tr, hz * 0.6).toFixed(2);
      if (Number.isFinite(pys)) next.pySize = +pys.toFixed(2);
      const rest = own.filter(l => !han.includes(l) && !toned.includes(l));
      if (rest.length) sized = rest;
      // A translation the print does not carry (workbook dialogues: hanzi and
      // pinyin only) is kept in the data but not laid out on the page.
      if (b.en && !rest.some(l => matchScore(plain(l.text), plain(b.en)) >= 0.5)) next.trOff = true;
      // Line pitch as printed (hanzi lines with their pinyin; translation
      // lines), and the translation's size from its widest line, in cqw.
      const pitch = ls => { const c = ls.map(l => l.box.y + l.box.h / 2).sort((p, q) => p - q); return c.length > 1 ? median(c.slice(1).map((y, i) => y - c[i])) / ratio * 100 : NaN; };
      const vline = pitch(han), vlh = pitch(rest);
      if (Number.isFinite(vline) && vline > hz) next.vline = +vline.toFixed(2);
      if (Number.isFinite(vlh)) next.vlh = +vlh.toFixed(2);
      const widest = rest.slice().sort((p, q) => q.box.w - p.box.w)[0];
      if (widest && timesEm(widest.text) > 8) next.vEn = +(widest.box.w * 100 * 0.96 / timesEm(widest.text)).toFixed(2);
    }
    // Font scale from the measured line height (OCR box ≈ 1.37 × font size).
    if (BASE_FONT[b.type] && sized.length) {
      const heights = sized.map(l => l.box.h).sort((p, q) => p - q), median = heights[heights.length >> 1];
      const size = median / ratio * 100 * 0.73;
      next.k = +Math.max(0.75, Math.min(1.35, size / (b.type === 'text' && b.size === 's' ? 1.45 : b.type === 'text' && b.size === 'l' ? 2.6 : BASE_FONT[b.type]))).toFixed(3);
      // A right-hand running head is one line ("我叫李文 | Lesson"): its
      // printed width gives the size more surely than the line height.
      // The bar and the gaps around it are a fixed 1.58cqw (components.css).
      const han = (String(b.cn || '').match(/\p{Script=Han}/gu) || []).slice(0, 2).join('');
      const line = b.type === 'runhead' && next.box.x > 0.5 && han.length === 2 && own.find(l => l.text.includes(han));
      if (line) {
        const em = Array.from(line.text).reduce((s, c) => s + (FULL_WIDTH.test(c) ? 1 : /[|\s]/.test(c) ? 0 : arialEm(c)), 0);
        const s = (line.box.w * 100 * 0.96 - 1.58) / Math.max(1, em);   // OCR boxes run a little wider than the ink
        if (s > 0.6 && s < 3.5) next.k = +Math.max(0.6, Math.min(1.5, s / 1.85)).toFixed(3);
      }
    }
    next.box = clampBox(next.box);
    return next;
  });
  // Numbered answer options with pinyin (①–④ dialogues under a row of
  // photos) are one set, printed in one size: per-block measurements wobble,
  // the set takes their median.
  {
    const set = blocks.filter(b => b.type === 'para' && b.py && /^\d+$/.test(String(b.number || '')) && b.hzSize);
    if (set.length >= 3) {
      const nums = set.map(b => +b.number).sort((p, q) => p - q), same = nums.every((v, i) => v === nums[0] + i) ? set : [];   // 1, 2, 3… — one set
      if (same.length >= 3) for (const key of ['hzSize', 'pySize', 'vtrack', 'vline', 'k']) {
        const v = median(same.map(b => b[key]).filter(Number.isFinite));
        if (Number.isFinite(v)) for (const b of same) b[key] = +v.toFixed(3);
      }
      for (const b of same) b.fitSet = 'options';
    }
  }
  // A caption under a picture card («鸡 jī» under the photo) is printed centred on it.
  for (const b of blocks) {
    if(b.type==='image'){
      const toneLabels=lines.filter(l=>/^[一二三四]声$/.test(l.text.trim())&&inside(l.box,b.box)).sort((a,c)=>a.box.x-c.box.x);
      if(toneLabels.length===4){
        const ru=['Первый тон','Второй тон','Третий тон','Четвёртый тон'],kk=['Бірінші тон','Екінші тон','Үшінші тон','Төртінші тон'];
        b.diagramLabels=toneLabels.map((l,i)=>({cn:l.text.trim(),ru:ru[i],kk:kk[i],box:{x:l.box.x+l.box.w/2-.075,y:l.box.y-.003,w:.15,h:l.box.h+.006}}));
      }
    }
    if(b.toneRows){
      const B=b.toneSourceBox,near=lines.filter(l=>l.box.x>=B.x-.08&&l.box.x<=B.x+B.w+.08&&l.box.y>=B.y-.015&&l.box.y<=B.y+B.h+.02);
      const points=b.toneRows.flatMap((row,r)=>row.flatMap((text,c)=>{const l=text&&near.find(l=>l.text.trim().normalize('NFC')===text);return l?[{r,c,x:l.box.x+(b.toneAlign==='left'?0:l.box.w/2),y:l.box.y+l.box.h/2}]:[];}));
      if(points.length>=5){
        const X=Array.from({length:Math.max(...b.toneRows.map(r=>r.length))},(_,c)=>median(points.filter(p=>p.c===c).map(p=>p.x)));
        const Y=b.toneRows.map((_,r)=>median(points.filter(p=>p.r===r).map(p=>p.y)));
        const valid=Y.map((y,r)=>({y,r})).filter(p=>Number.isFinite(p.y));
        const pitch=median(valid.slice(1).map((p,i)=>(p.y-valid[i].y)/(p.r-valid[i].r))),start=median(valid.map(p=>p.y-p.r*pitch));
        if(X.every(Number.isFinite)&&Number.isFinite(pitch)){
          b.gridX=X;b.gridY=Y.map((_,r)=>start+r*pitch);
          b.box={x:X[0]-.035,y:b.gridY[0]-.021,w:X.at(-1)-X[0]+(b.toneAlign==='left'?.095:.07),h:b.gridY.at(-1)-b.gridY[0]+.042};
        }
      }
    }
    if (b.type !== 'text' || gridRows(b) || String(b.cn || b.py || '').length > 12) continue;
    const cx = b.box.x + b.box.w / 2, pic = blocks.find(o => o.type === 'image' && cx > o.box.x && cx < o.box.x + o.box.w && b.box.y >= o.box.y + o.box.h * 0.5 && b.box.y - (o.box.y + o.box.h) < 0.06);
    if (pic) { b.box = { ...b.box, x: pic.box.x, w: pic.box.w }; b.align = 'center'; b.cardOf = pic; }
  }
  // Picture cards (photo + «jī 鸡» in one printed frame): the whole card is cut from the scan, the
  // caption included, so pinyin and hanzi sit exactly as printed; the separate caption text goes.
  // Captions with a translation printed on the card stay text (they are read and translated).
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k], pic = b.cardOf;
    if (!pic) continue;
    delete b.cardOf;
    if (b.en && !b.trOff) continue;
    pic.box = clampBox(grow(union([pic.box, b.box]), 0.006, 0.005));
    // Preserve the semantic caption before dropping its separate block.
    // The printed bitmap is only the illustration, not the caption source.
    const label=lexicalLabel(b);
    if(label){const word=wordLabels[label.hz];pic.caption={...label,ru:label.ru||CAPTION_RU[label.hz]||pic.alt||'',...(word?{en:word.en}:{})};}
    SOLID_PHOTOS.add(pic);
    b.dropCaption = true;   // removed after the graphics pass (it pairs blocks with the model's by index)
  }
  // Drill grids on one page share one type size: single letters («t», «h»)
  // read shorter than toned syllables and would come out smaller.
  {
    const grids = blocks.filter(b => b.type === 'text' && b.gridH && Number.isFinite(b.k));
    if (grids.length >= 2) { const k = Math.max(...grids.map(b => b.k)); for (const b of grids) b.k = k; }
  }
  // A row of picture cards with captions («jī / 鸡» printed inside each card): the captions on the
  // scan fix where the cards are — centred on them, one pitch apart, from the photo top to the caption.
  {
    const pics = blocks.filter(b => b.type === 'image');
    const rowsOfPics = [];
    for (const p of pics.slice().sort((a, b) => a.box.x - b.box.x)) { const r = rowsOfPics.find(r => Math.abs(r[0].box.y - p.box.y) < 0.06); if (r) r.push(p); else rowsOfPics.push([p]); }
    for (const row of rowsOfPics) {
      if (row.length < 3 || !row.every(p=>p.caption)) continue;
      const top = Math.min(...row.map(p => p.box.y)), x0 = Math.min(...row.map(p => p.box.x)) - 0.05, x1 = Math.max(...row.map(p => p.box.x + p.box.w)) + 0.05;
      const caps = lines.filter(l => { const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2; return cx > x0 && cx < x1 && cy > top + 0.06 && cy < top + 0.24 && l.text.trim().length <= 8 && (/\p{Script=Han}/u.test(l.text) || /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(l.text)); });
      const centres = []; for (const l of caps.slice().sort((a, b) => (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2))) { const cx = l.box.x + l.box.w / 2, c = centres[centres.length - 1]; if (c && cx - c.xs.at(-1) < 0.06) { c.xs.push(cx); c.bottom = Math.max(c.bottom, l.box.y + l.box.h); } else centres.push({ xs: [cx], bottom: l.box.y + l.box.h }); }
      if (centres.length !== row.length) continue;
      const cx = centres.map(c => median(c.xs)), pitch = median(cx.slice(1).map((v, k) => v - cx[k])), w = pitch * 0.9;
      if (!(pitch > 0.08) || row.some((p, k) => Math.abs(p.box.x + p.box.w / 2 - cx[k]) > pitch * 0.6)) continue;
      const bottom = Math.max(...centres.map(c => c.bottom)) + 0.012, y = top - 0.004;
      row.forEach((p, k) => { p.box = clampBox({ x: cx[k] - w / 2, y, w, h: bottom - y }); SOLID_PHOTOS.add(p); });
    }
  }
  // A row of three or more pictures of one size (exercise photos) is printed
  // on one baseline at an even pitch. When most of the row agrees, a picture
  // the flood cut short or shifted takes the row's top, size and slot.
  {
    const pics = blocks.filter(b => b.type === 'image');
    const rows = [];
    for (const p of pics.sort((a, b) => a.box.x - b.box.x)) {
      const row = rows.find(r => Math.abs(r[0].box.y - p.box.y) < 0.09 && Math.abs(r[0].box.h - p.box.h) < 0.1);
      if (row) row.push(p); else rows.push([p]);
    }
    for (const row of rows) {
      if (row.length < 3) continue;
      const w = median(row.map(p => p.box.w)), h = median(row.map(p => p.box.h)), y = median(row.map(p => p.box.y));
      const agree = row.filter(p => Math.abs(p.box.w - w) < w * 0.08 && Math.abs(p.box.h - h) < h * 0.08 && Math.abs(p.box.y - y) < h * 0.08);
      if (agree.length < Math.ceil(row.length / 2) || agree.length === row.length) continue;
      const c0 = row[0].box.x + row[0].box.w / 2, c1 = row[row.length - 1].box.x + row[row.length - 1].box.w / 2;
      const ends = [row[0], row[row.length - 1]].every(p => agree.includes(p));
      const pitch = ends ? (c1 - c0) / (row.length - 1) : median(agree.slice(1).map((p, i) => (p.box.x - agree[i].box.x) / Math.max(1, row.indexOf(p) - row.indexOf(agree[i]))));
      const first = ends ? c0 : agree[0].box.x + w / 2 - row.indexOf(agree[0]) * pitch;
      row.forEach((p, i) => { if (!agree.includes(p)) p.box = clampBox({ x: first + i * pitch - w / 2, y, w, h }); });
    }
  }
  // Graphics, once every panel and its colour is known: arrows, characters
  // over tabs and tips, loose illustrations.
  blocks.forEach((b, n) => {
    const src = layout.blocks[n];
    if (b.type === 'decor') b.box = snapDecor(src, grid, theme, blocks, lines) || b.box;
    if (b.type === 'image') {
      // A photo cut out as one solid area is complete; only loose drawings grow.
      if (!SOLID_PHOTOS.has(b)) b.box = growIllustration(b, b.box, grid, theme, blocks, lines);
      const frame = detectFrame(grid, b.box);
      if (frame) b.frame = frame; else delete b.frame;
    }
    if ((b.type === 'section' || b.type === 'tip') && src.avatar) {
      // Never down into the label printed under the character ("小语助力").
      const below = b.labelLine ? b.labelLine.y - 0.002 : null;
      let a = snapFigure(src.avatar, grid, theme, blocks.filter(o => o !== b || o.fill), lines, below) || src.avatar;
      if (below && a.y + a.h > below) a = { ...a, h: Math.max(0.01, below - a.y) };
      // …nor into the tab's title, which the page draws itself.
      if (b.titleLine && a.x + a.w > b.titleLine.x - 0.004) a = { ...a, w: Math.max(0.01, b.titleLine.x - 0.004 - a.x) };
      delete b.titleLine;
      b.avatar = a;
      delete b.labelLine;
    }
    delete b.titleLine;
  });
  // The model may describe one arrow as two: decors that snapped onto the
  // same marks become one (their union), so the marks are not drawn twice.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.dropCaption) { blocks.splice(i, 1); continue; }
    if (b.type !== 'decor') continue;
    const twin = blocks.find((o, j) => j < i && o.type === 'decor' && Math.max(overlapShare(o.box, b.box), overlapShare(b.box, o.box)) > 0.5);
    if (twin) { twin.box = union([twin.box, b.box]); blocks.splice(i, 1); }
  }
  // Translations run longer than the print: a paragraph may use the free
  // width to its right (up to the next block or the text column's edge)
  // instead of shrinking.
  const columnRight = Math.max(...blocks.filter(o => ['para', 'words', 'card', 'objectives', 'image', 'dialogue', 'tip'].includes(o.type)).map(o => o.box.x + o.box.w), 0.5);
  for (const b of blocks) {
    if (b.toneRows || !['para', 'text'].includes(b.type) || b.box.x > columnRight - 0.1) continue;
    let right = columnRight;
    for (const o of blocks) {
      if (o === b || o.type === 'decor' || o.type === 'runhead' || o.type === 'folio') continue;
      const vertical = o.box.y < b.box.y + b.box.h && o.box.y + o.box.h > b.box.y;
      if (vertical && o.box.x >= b.box.x + b.box.w - 0.005) right = Math.min(right, o.box.x - 0.012);
    }
    if (right > b.box.x + b.box.w) b.box = { ...b.box, w: right - b.box.x };
  }
  // A row of photos is printed at one size. A photo whose edge is as bright as
  // the page (an overexposed sky) has no visible edge to find and comes out
  // narrow: give it the width its row-mates share (only ever wider, never by
  // more than 15%).
  const photos = blocks.filter(o => o.type === 'image' && SOLID_PHOTOS.has(o));
  for (const p of photos) {
    const row = photos.filter(o => Math.abs(o.box.y - p.box.y) < 0.02 && Math.abs(o.box.h - p.box.h) < 0.02);
    if (row.length < 3) continue;
    const widths = row.map(o => o.box.w).sort((a, c) => a - c), median = widths[widths.length >> 1];
    if (p.box.w < median * 0.99 && p.box.w > median * 0.85) p.box = clampBox({ ...p.box, w: median });
  }
  // A caption printed inside a photo's frame belongs to that frame: it spans
  // the frame's inner width whatever the OCR grouping of its lines was.
  for (const img of blocks) {
    if (img.type !== 'image' || !img.frame) continue;
    const f = img.frame, inner = 0.008;
    for (const b of blocks) {
      if (b === img || !['para', 'text'].includes(b.type)) continue;
      const cx = b.box.x + b.box.w / 2, cy = b.box.y + b.box.h / 2;
      if (cx > f.x && cx < f.x + f.w && cy > img.box.y + img.box.h && cy < f.y + f.h) b.box = clampBox({ ...b.box, x: f.x + inner, w: f.w - 2 * inner });
    }
  }
  for (const b of blocks) printedPinyin(b, lines);
  for (const b of blocks) {
    const measured = measurePrintedGeometry(b, grid, lines, layout.page);
    if (measured) Object.assign(b, measured);
    const table = measureTextTable(b,grid);
    if(table){Object.assign(b,table);Object.assign(b,restorePhoneticTokens(b));}
    const paragraph=printedParagraphLines(b,lines);if(paragraph)b.printedCnLines=paragraph;
    const english=printedParagraphLines(b,lines,'en');if(english)b.printedEnLines=english;
    const source=(layout.source?.blocks||[]).find(o=>o.type===b.type&&o.py===b.py);
    const lattice=measureAnswerLattice(b,source,lines);if(lattice)Object.assign(b,lattice);
    const drill=reconcileAnswerGrid(b,lines,grid);if(drill)Object.assign(b,drill);
    const reading=measureReadingGrid(b,lines);if(reading)Object.assign(b,reading);
    const dialogue=measureDialogueOptions(b,lines);if(dialogue)Object.assign(b,dialogue);
  }
  clipImagesBeforeText(blocks,lines);
  measureTitlePage({...layout,blocks},grid,lines);
  measureImprintPage({...layout,blocks},lines);
  measureCreditsPage({...layout,blocks},grid,lines);
  measureForewordPage({...layout,blocks,theme},grid,lines);
  measureCharacterPage({...layout,blocks,theme},grid,lines);
  measureClassroomPage({...layout,blocks,theme},grid,lines);
  const accent = blocks.find(b => ['section', 'lesson', 'folio'].includes(b.type) && b.fill && b.fill !== '#ffffff')?.fill;
  if (accent) theme.accent = accent;
  const result = attachInteractiveCaptions({ ...layout, blocks, theme, snapVersion: SNAP_VERSION, ocrLines: lines.length });
  for(const b of result.blocks.filter(b=>b.type==='runhead'&&b.box.x>.5&&b.number)){
    const tokens=(ocr?.lines||[]).map(t=>({text:t.text,box:t.box||(t.position?{x:t.position.x,y:t.position.y,w:t.position.width,h:t.position.height}:null)})).filter(t=>t.box&&t.box.y<.07);
    const label=tokens.find(t=>/^lesson$/i.test(t.text.trim())),number=label&&tokens.find(t=>t.text.trim()===b.number&&t.box.x>label.box.x);
    if(label&&number)b.rightLesson={label:{...label.box,y:label.box.y+label.box.h*.3,h:label.box.h*.5},number:{...number.box,x:number.box.x-.006,w:number.box.w+.006}};
    else {
      const combined=tokens.find(t=>new RegExp('^Lesson\\s*'+b.number+'$','i').test(t.text.trim()));
      if(combined){const q=combined.box;b.rightLesson={label:{x:q.x+.006,y:q.y+q.h*.38,w:q.w*.72,h:q.h*.5},number:{x:q.x+q.w*.78,y:q.y,w:q.w*.22,h:q.h}};}
    }
  }
  result.kz={...(layout.kz||{})};
  for(const b of result.blocks)if(b.foreword?.kk)result.kz[b.ru]=b.foreword.kk;
  for(const b of result.blocks)if(b.credits?.kk)result.kz[b.ru]=b.credits.kk;
  for(const b of result.blocks)for(const l of b.imprintLabels||[])if(l.ru)result.kz[l.ru]=l.kk;
  for(const b of result.blocks)if(b.caption?.ru&&wordLabels[b.caption.hz])result.kz[b.caption.ru]=wordLabels[b.caption.hz].kk;
  for(const b of result.blocks)for(const l of b.diagramLabels||[])result.kz[l.ru]=l.kk;
  for(const b of result.blocks)for(const t of b.optionTurns||[])if(t.translation)result.kz[t.translation.ru]=t.translation.kk;
  for (const b of result.blocks) if (b.type === 'image' && b.caption) {
    b.captionFrame = hasPrintedCardFrame(b.box,grid);
    const bounds=printedCardBounds(b.box,grid);if(bounds)b.box=bounds;
    if(b.captionFrame)delete b.frame;
  }
  const cardRows=[];
  for(const b of result.blocks.filter(b=>b.type==='image'&&b.captionFrame&&b.caption)){
    const row=cardRows.find(r=>Math.abs(r[0].box.y-b.box.y)<.025);
    if(row)row.push(b);else cardRows.push([b]);
  }
  for(const row of cardRows.filter(r=>r.length>=3)){
    const y=median(row.map(b=>b.box.y)),bottom=median(row.map(b=>b.box.y+b.box.h));
    if(row.every(b=>Math.abs(b.box.y-y)<.015&&Math.abs(b.box.y+b.box.h-bottom)<.015))
      for(const b of row)b.box={...b.box,y,h:bottom-y};
  }
  return result;
}

// Turn labels printed beside a picture into a semantic, speakable caption.
// Never guess across a matching exercise: its picture/word pairs are
// intentionally shuffled and cannot be inferred from the nearest position.
const CAPTION_RU = {
  '茶':'чай','狗':'собака','猫':'кошка','菜':'овощи','人':'человек','坐':'сидеть','书':'книга',
  '手机':'смартфон','医生':'врач','出租车':'такси','春':'весна','村':'деревня','睡':'спать','嘴':'рот',
  '你好':'привет','哪里':'где','小语':'Сяоюй','水果':'фрукты','妈妈':'мама','爸爸':'папа','椅子':'стул','饺子':'пельмени',
  '面条儿':'лапша','好玩儿':'интересный, весёлый','一点儿':'немного','饭馆儿':'ресторан','那儿':'там','这儿':'здесь','玩儿':'играть','歌儿':'песня',
  '九':'девять','牛奶':'молоко','休息':'отдыхать','朋友':'друг','五':'пять','哥哥':'старший брат','学生':'ученик, студент','六十岁':'шестьдесят лет','老师':'учитель'
};
const HAN = /\p{Script=Han}/u;
const cleanHanzi = value => String(value || '').replace(/[^\p{Script=Han}]/gu, '');
const lexicalLabel = b => {
  const hz = cleanHanzi(b?.cn), py = String(b?.py || '').trim();
  if (!hz || hz.length > 4 || !py || !/^[\p{Script=Latin}\süÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňḿ̀-]+$/u.test(py)) return null;
  if (py.split(/\s+/).filter(Boolean).length > 4) return null;
  return { hz, py, ru: String(b.ru || '').trim() };
};

export function attachInteractiveCaptions(layout) {
  const blocks = (layout?.blocks || []).map(b => ({ ...b }));
  const images = blocks.filter(b => b.type === 'image');
  const labels = blocks.filter(b => ['text', 'para'].includes(b.type) && lexicalLabel(b));
  const pageText = blocks.filter(b => ['text', 'para', 'section'].includes(b.type)).map(b => b.cn || '').join(' ');
  const shuffledMatchingExercise = /选择.{0,8}对应|对应.{0,8}图片|подбер.{0,30}картин|соответствующ.{0,20}картин/i.test(pageText);
  const labelOwner = new Map();

  for (const image of images) {
    if (image.caption?.hz) {
      image.caption = { ...image.caption, ru: image.caption.ru || CAPTION_RU[cleanHanzi(image.caption.hz)] || String(image.alt || '').replace(/^\s*(?:карточка\s*:\s*)?/iu, '').trim() };
      continue;
    }
    // Some early layouts encoded a complete label in the Russian alt text.
    const fromAlt = String(image.alt || '').match(/^\s*(?:карточка\s*:\s*)?(.+?)\s*\(([^,()]+),\s*([\p{Script=Han}]+)\)\s*$/iu);
    if (fromAlt) {
      image.caption = { py: fromAlt[2].trim(), hz: fromAlt[3], ru: fromAlt[1].trim() };
      continue;
    }
    if (shuffledMatchingExercise) continue;
    const described=String(image.alt||'').match(/пиньинем\s+([\p{Script=Latin}ü]+)\s+и\s+иероглиф(?:ом|ами)\s+([\p{Script=Han}]+)/iu);
    if(described){const hz=described[2],word=wordLabels[hz];image.caption={py:described[1],hz,ru:CAPTION_RU[hz]||hz,...(word?{en:word.en}:{})};continue;}
    const box = image.box || {}, cx = box.x + box.w / 2, bottom = box.y + box.h;
    const possible = labels.map(label => {
      const lb = label.box || {}, lx = lb.x + lb.w / 2, ly = lb.y + lb.h / 2, dy = lb.y - bottom;
      const maxDx = Math.max(.022, box.w * .34);
      const overlapsImageCaptionArea = ly > box.y + box.h * .72 && ly < bottom;
      if (labelOwner.has(label) || (dy < -.006 && !overlapsImageCaptionArea) || dy > .055 || Math.abs(lx - cx) > maxDx) return null;
      // Prefer labels centred below this image, close to its lower edge.
      return { label, score: Math.abs(lx - cx) / maxDx + (overlapsImageCaptionArea ? 0 : Math.abs(dy) / .055) };
    }).filter(Boolean).sort((a, b) => a.score - b.score);
    const winner = possible[0];
    if (!winner || winner.score > 1.25 || (possible[1] && possible[1].score - winner.score < .2)) continue;
    labelOwner.set(winner.label, image);
    const vocab = lexicalLabel(winner.label), ru = vocab.ru || CAPTION_RU[vocab.hz] || String(image.alt || '').trim();
    image.caption = { py: vocab.py, hz: vocab.hz, ru };
    winner.label.photoCaptionOwner = blocks.indexOf(image);
  }
  return { ...layout, blocks };
}

export function pageVocabulary(layout) {
  const enriched = attachInteractiveCaptions(layout), blocks = enriched.blocks || [], result = [], seen = new Set();
  const add = ({ hz, py, ru, en = '', pos = '' }) => {
    hz = cleanHanzi(hz); py = String(py || '').trim(); ru = String(ru || '').trim(); en = String(en || '').trim();
    if (!hz || !py || seen.has(hz) || (!ru && !en)) return;
    seen.add(hz); result.push({ word: hz, py, pos, trans: ru || en, ...(en ? { trans_en: en } : {}) });
  };
  for (const image of blocks.filter(b => b.type === 'image' && b.caption?.hz)) {
    const c = image.caption; add({ hz: c.hz, py: c.py, ru: c.ru || CAPTION_RU[cleanHanzi(c.hz)], en:c.en });
  }
  for (const block of blocks.filter(b => ['text', 'para'].includes(b.type))) {
    const item = lexicalLabel(block);
    if (item) add({ ...item, ru: item.ru || CAPTION_RU[item.hz] });
    for(const t of block.optionTurns||[]){const label=dialogueLabels[cleanHanzi(t.hz)];if(label)add({hz:t.hz,py:t.py,ru:label.ru,en:label.en});}
  }
  const soundGroup = row => row?.group && /声母|韵母|声调|initials|finals|tones/i.test([row.group.cn, row.group.en, row.group.ru].join(' '));
  for (const table of blocks.filter(b => b.type === 'words')) {
    if ((table.rows || []).some(soundGroup)) continue;
    for (const row of table.rows || []) if (!row.group) add({ hz: row.hz, py: row.py, ru: row.ru || CAPTION_RU[cleanHanzi(row.hz)], en: row.en, pos: row.pos_ru || row.pos_en });
  }
  return result.slice(0, 30);
}

// Columns of a word table as printed: every row shares them. Dark neutral
// ink (not the red numbers and dashed rules) is projected onto the x axis
// over the rows; wide gaps separate the columns. Returns the left edge of
// each column (hanzi, pinyin, [part of speech,] meaning) in page fractions.
function wordColumns(box, own, grid, want) {
  const g = grid.hi || grid.raw;
  if (!g || !own.length) return null;
  const y0 = Math.min(...own.map(l => l.box.y)), y1 = Math.max(...own.map(l => l.box.y + l.box.h));
  const X0 = Math.round(box.x * g.W), X1 = Math.round((box.x + box.w) * g.W), Y0 = Math.round(y0 * g.H), Y1 = Math.round(y1 * g.H);
  if (X1 - X0 < 50 || Y1 - Y0 < 10) return null;
  const ink = new Uint16Array(X1 - X0);
  for (let y = Y0; y < Y1; y += 2) for (let x = X0; x < X1; x++) {
    const [r, gg, b] = g.at(x, y);
    if (0.3 * r + 0.59 * gg + 0.11 * b < 120 && Math.max(r, gg, b) - Math.min(r, gg, b) < 70) ink[x - X0]++;
  }
  // Ink runs separated by gaps wider than ~1.1% of the page; narrow tables
  // set their columns closer, so the gap shrinks until the columns the
  // model listed (with or without a part of speech) are all found.
  const runs = gap => { const out = []; let last = -1e9; for (let i = 0; i < ink.length; i++) if (ink[i] > 1) { if (i - last > Math.round(gap * g.W)) out.push(i); last = i; } return out; };
  const starts = [0.011, 0.009, 0.0075, 0.006].map(runs).find(s => s.length === want);
  if (!starts) return null;
  const at = i => +((X0 + i) / g.W).toFixed(4);
  const [hz, py, ...rest] = starts.map(at);
  return rest.length === 2 ? { hz, py, pos: rest[0], en: rest[1] } : { hz, py, en: rest[0] };
}

// The model writes pinyin as a dictionary does and drops tone marks the
// book prints (学生 xuésheng for the printed xuéshēng). Where the OCR of the
// block's area read the same syllables with more tone marks, the print wins.
const toneless = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const toneCount = s => (s.normalize('NFD').match(/[̀-ͯ]/g) || []).length;
function printedPinyin(b, lines) {
  if (!b.box) return;
  const area = { x: b.box.x - 0.01, y: b.box.y - 0.01, w: b.box.w + 0.02, h: b.box.h + 0.02 };
  const printed = new Map();
  for (const l of lines) {
    const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2;
    if (cx < area.x || cx > area.x + area.w || cy < area.y || cy > area.y + area.h) continue;
    for (const t of l.text.split(/[^\p{Script=Latin}]+/u)) if (t && toneCount(t)) { const k = toneless(t); if (!printed.has(k) || toneCount(t) > toneCount(printed.get(k))) printed.set(k, t); }
  }
  if (!printed.size) return;
  const fix = s => typeof s !== 'string' ? s : s.replace(/\p{Script=Latin}+/gu, w => { const p = printed.get(toneless(w)); return p && toneCount(p) > toneCount(w) ? (w[0] === w[0].toUpperCase() ? p[0].toUpperCase() + p.slice(1) : p) : w; });
  if (b.py) b.py = fix(b.py);
  for (const r of b.rows || []) if (r.py) r.py = fix(r.py);
  for (const t of b.turns || []) { if (t.py) t.py = fix(t.py); if (t.speaker?.py) t.speaker.py = fix(t.speaker.py); }
}

// ---- Decorations: nothing printed may go missing -------------------------

export const parseHex = h => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); const v = m ? parseInt(m[1], 16) : 0xffffff; return [v >> 16 & 255, v >> 8 & 255, v & 255]; };

// Page colour under a point: the coloured page background inside its box,
// the paper elsewhere.
export function backgroundAt(theme, fx, fy) {
  const b = theme?.background?.box;
  return b && fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h ? parseHex(theme.background.color) : parseHex(theme?.paper || '#ffffff');
}

// Printed marks no block accounts for (dashed arrows, rules, small icons):
// ink outside every block, grouped so dashed strokes stay one piece. They are
// published as transparent cut-outs of the scan, so the page loses nothing a
// component cannot draw.
export function findDecorations(layout, grid) {
  const { W, H } = grid, theme = layout.theme || {};
  const covered = new Uint8Array(W * H);
  const cover = (box, g = 0.006) => {
    if (!box) return;
    const x0 = Math.max(0, Math.floor((box.x - g) * W)), x1 = Math.min(W - 1, Math.ceil((box.x + box.w + g) * W));
    const y0 = Math.max(0, Math.floor((box.y - g) * H)), y1 = Math.min(H - 1, Math.ceil((box.y + box.h + g) * H));
    for (let y = y0; y <= y1; y++) covered.fill(1, y * W + x0, y * W + x1 + 1);
  };
  // Generous margins: components draw their own pills, tabs, pins and corner
  // triangles just outside their boxes, and those must not be cut twice.
  for (const b of layout.blocks) {
    cover(b.box, 0.02); if (b.avatar) cover(b.avatar, 0.02);
    if(b.titleArtwork)cover(b.titleArtwork.box,.003);
    for(const l of b.imprintLabels||[])cover(l.box,.004);
    for (const t of b.turns || []) cover(t.speaker?.avatarBox, 0.02);
    // The pin sits a little above its line's box (p.25): its zone reaches up so it is not cut twice.
    if ((b.type === 'para' && b.icon !== 'none') || b.type === 'runhead') cover({ x: b.box.x - 0.05, y: b.box.y - (b.icon === 'pin' ? 0.03 : 0), w: 0.05, h: b.box.h + (b.icon === 'pin' ? 0.03 : 0) }, 0.01);
  }
  // Scan borders and page edges are not content.
  const edge = Math.round(W * 0.012), edgeY = Math.round(H * 0.01);
  const ink = new Uint8Array(W * H);
  for (let y = edgeY; y < H - edgeY; y++) for (let x = edge; x < W - edge; x++) {
    const k = y * W + x;
    if (!covered[k] && dist(grid.at(x, y), backgroundAt(theme, x / W, y / H)) > 45) ink[k] = 1;
  }
  // Join marks up to 3 px apart (dash gaps) by labelling a dilated mask.
  const R = 3, label = new Int32Array(W * H).fill(-1), found = [];
  const near = (x, y) => { for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx >= 0 && xx < W && ink[yy * W + xx]) return true; } } return false; };
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || label[s] >= 0) continue;
    const id = found.length, stack = [s]; let count = 0, minX = W, minY = H, maxX = 0, maxY = 0;
    label[s] = id;
    while (stack.length) {
      const k = stack.pop(), x = k % W, y = (k / W) | 0;
      if (ink[k]) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, kk = yy * W + xx;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || label[kk] >= 0) continue;
        if (ink[kk] || near(xx, yy)) { label[kk] = id; stack.push(kk); }
      }
    }
    found.push({ count, box: { x: minX / W, y: minY / H, w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H } });
  }
  return found
    .filter(d => d.count >= 40 && d.box.w * d.box.h < 0.2 && d.box.w < 0.9 && d.box.h < 0.9)
    .map(d => ({ box: clampBox(grow(d.box, 0.003, 0.003)) }));
}

// A photo the model framed too narrowly leaves its edge strips as "decorations"
// (p.25: the left column and a corner of a café photo). A decoration that runs
// alongside a picture — next to it or inside its height, nearly touching — is
// that picture's own edge: the picture grows over it and the decoration goes.
export function absorbIntoImages(layout, decorations) {
  const images = layout.blocks.filter(b => b.type === 'image' && b.box), rest = [];
  let left = [...(decorations || [])], changed = true;
  while (changed) {
    changed = false;
    for (const d of left) {
      const D = d.box, img = images.find(b => {
        const B = b.box, gap = Math.max(B.x - (D.x + D.w), D.x - (B.x + B.w), 0), vgap = Math.max(B.y - (D.y + D.h), D.y - (B.y + B.h), 0);
        const vOverlap = Math.min(D.y + D.h, B.y + B.h) - Math.max(D.y, B.y);
        const beside = gap <= 0.03 && vOverlap >= D.h * 0.8 && D.h >= B.h * 0.04;      // a strip along a side
        const below = vgap <= 0.012 && gap <= 0.03 && D.w <= B.w;                        // a piece just under/over it
        return beside || below;
      });
      if (!img) continue;
      const B = img.box, x0 = Math.min(B.x, D.x), y0 = Math.min(B.y, D.y), x1 = Math.max(B.x + B.w, D.x + D.w), y1 = Math.max(B.y + B.h, D.y + D.h);
      img.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      left = left.filter(x => x !== d); changed = true; break;
    }
  }
  rest.push(...left);
  return rest;
}

// ---- Cast: studio characters in place of scanned avatars -----------------

// Names compared without tones, case, spacing or punctuation.
export const plainName = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const speakerKey = speaker => plainName(speaker?.cn) || plainName(speaker?.py);

// cast = { characters: [{ id, names: [...], file }], manual: { speakerKey: id | 'none' } }
// A manual choice wins; otherwise an exact name match, then a partial one.
export function castFor(speaker, cast) {
  if (!cast?.characters?.length) return null;
  const key = speakerKey(speaker), chosen = cast.manual?.[key];
  if (chosen === 'none') return null;
  if (chosen) return cast.characters.find(c => c.id === chosen) || null;
  const keys = [speaker?.cn, speaker?.py, speaker?.ru].map(plainName).filter(k => k.length >= 2);
  if (!keys.length) return null;
  const names = c => (c.names || []).map(plainName).filter(n => n.length >= 2);
  return cast.characters.find(c => names(c).some(n => keys.includes(n)))
    || cast.characters.find(c => names(c).some(n => keys.some(k => n.includes(k) || k.includes(n)))) || null;
}

// Swap matched speakers' avatars for the cast portraits. Returns a layout copy
// (matched speakers become photo avatars) and asset overrides keyed like
// assetBoxes(); `urlOf(character)` gives the portrait URL for the context.
export function applyCast(layout, cast, urlOf) {
  const assets = {}, copy = { ...layout, blocks: layout.blocks.map(b => b.type !== 'dialogue' ? b : ({ ...b, turns: b.turns.map(t => ({ ...t, speaker: { ...t.speaker } })) })) };
  copy.blocks.forEach((b, n) => {
    if (b.type !== 'dialogue') return;
    b.turns.forEach((t, k) => {
      // A group («学生们») keeps its group picture from the scan: one character's portrait is not «the students».
      if (t.speaker.avatar === 'group' || /们$/.test(t.speaker.cn || '')) return;
      const c = castFor(t.speaker, cast);
      if (!c?.file) return;
      assets[`ava-${n}-${k}`] = urlOf(c);
      t.speaker.avatar = 'photo';
    });
  });
  return { layout: copy, assets };
}

// ---- Assets --------------------------------------------------------------

// The character over a section tab stands on the tab's lower edge: nothing
// below it (the next block's top) belongs to the drawing.
const secAvatarBox = b => { const a = b.avatar, bottom = Math.min(a.y + a.h, b.box.y + b.box.h); return { ...a, h: Math.max(0.005, bottom - a.y) }; };

// Regions cut out of the scan as images: photos, tip character, avatars.
export function assetBoxes(layout) {
  const out = [];
  layout.blocks.forEach((b, n) => {
    if (b.printed?.texture) out.push({ key: `surface-${n}`, box: b.printed.texture });
    if (b.textTable?.texture) out.push({ key: `table-surface-${n}`, box: b.textTable.texture });
    if (b.type === 'image') out.push({ key: `img-${n}`, box: b.box });
    // The character over a tip panel stands half on it, like those on tabs.
    if (b.type === 'tip' && b.avatar) out.push({ key: `tip-${n}`, box: b.avatar, transparent: true, flood: true, also: b.fill ? [b.fill] : [] });
    // A character drawn over a section tab stands half on the page, half on
    // the tab: the page and tab colours reached from its top and sides
    // become transparent; its own white fill, inside the outline, stays.
    if (b.type === 'section' && b.avatar) out.push({ key: `sec-${n}`, box: secAvatarBox(b), transparent: true, flood: true, also: b.fill ? [b.fill] : [] });
    if (b.type === 'bonus' && b.image) out.push({ key: `bon-${n}`, box: b.image });
    if (b.type === 'dialogue') b.turns.forEach((t, k) => { if (t.speaker.avatar === 'photo' && t.speaker.avatarBox) out.push({ key: `ava-${n}-${k}`, box: t.speaker.avatarBox }); });
  });
  // Graphics are cut with a transparent background (see server): blocks the
  // model marked as decor, and orphan marks found on the scan.
  layout.blocks.forEach((b, n) => { if (b.type === 'decor') out.push({ key: `deco-b${n}`, box: b.box, transparent: true }); });
  (layout.decorations || []).forEach((d, i) => out.push({ key: `deco-${i}`, box: d.box, transparent: true }));
  return out;
}

// ---- Rendering -------------------------------------------------------------

const GROUP_ICON = '<svg viewBox="0 0 60 40" aria-hidden="true"><circle cx="15" cy="10" r="7"/><circle cx="45" cy="10" r="7"/><circle cx="30" cy="14" r="8"/><path d="M2 32c0-9 6-13 13-13s10 3 11 6c-4 3-6 7-6 11H4a2 2 0 0 1-2-2ZM58 32c0-9-6-13-13-13s-10 3-11 6c4 3 6 7 6 11h16a2 2 0 0 0 2-2Z"/><path d="M16 38c0-10 6-15 14-15s14 5 14 15a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2Z"/></svg>';
// «小语的彩蛋 / Xiaoyu's Bonus Content» carries a video number, not an audio track.
export const isVideoMark = b => /彩蛋|bonus content/i.test(`${b?.cn || ''} ${b?.en || ''}`);
const VIDEO_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M2 7h12.5v10H2zM16 10.2 22 7v10l-6-3.2z"/></svg>';
const TRACK_ICON ='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3Zm12-1c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/></svg>';
const TARGET_ICON = '<svg class="hsk-target" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="13" r="9"/><circle cx="11" cy="13" r="5"/><circle cx="11" cy="13" r="1.4" class="dot"/><path d="M11 13 20 4M17 3.5 20.5 3.5 20.5 7"/></svg>';
const VIDEO_ICON ='<svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M2 6h13v12H2zM16 10l6-4v12l-6-4z"/></svg>';
const PLAYER_BAR = '<svg class="pb-play" viewBox="0 0 20 20"><path d="M4 2l14 8-14 8z"/></svg><svg class="pb-vol" viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3Zm12-1c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/></svg><span class="pb-track"><i></i></span><svg class="pb-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4M4.6 4.6l2.8 2.8M16.6 16.6l2.8 2.8M4.6 19.4l2.8-2.8M16.6 7.4l2.8-2.8"/></svg><svg class="pb-full" viewBox="0 0 24 24"><path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/></svg>';
const PIN_ICON ='<svg class="hsk-pin" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 29S2 17.5 2 10.5a10 10 0 0 1 20 0C22 17.5 12 29 12 29Z"/><circle cx="12" cy="10.5" r="3.6" fill="#fff"/></svg>';

// ---- Pinyin over hanzi ---------------------------------------------------

const PY_VOWELS = 'aeiouüvāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ';
const VOWEL_RUN = new RegExp(`[${PY_VOWELS}]+`, 'giu');
// Syllables in a pinyin word: one vowel group each, plus a final erhua "r"
// (nǎr = 哪儿), which is a character of its own.
export function pinyinSyllables(word) {
  const w = String(word).normalize('NFC').toLowerCase().replace(new RegExp(`[^a-z${PY_VOWELS}']`, 'giu'), '');
  if (!w) return 0;
  let n = (w.match(VOWEL_RUN) || []).length;
  if (/r$/.test(w) && w.length > 2 && !new RegExp(`(^|')[eēéěè]r$`, 'u').test(w) && new RegExp(`[${PY_VOWELS}ng]r$`, 'iu').test(w)) n++;
  return n;
}

// Character indices of `hz` covered by the coloured runs in `mark`
// ("没关系！" or several runs joined with "|"); a run whose punctuation the
// text spells differently still marks its hanzi.
export function markedChars(hz, mark) {
  const out = new Set(), text = String(hz || '');
  for (const m of String(mark || '').split('|').filter(Boolean)) {
    for (const run of [m, m.replace(/[^\p{Script=Han}]/gu, '')]) {
      if (!run || !text.includes(run)) continue;
      for (let at = text.indexOf(run); at >= 0; at = text.indexOf(run, at + 1)) { const start = Array.from(text.slice(0, at)).length; for (let i = 0; i < Array.from(run).length; i++) out.add(start + i); }
      break;
    }
  }
  return out;
}

// Hanzi with pinyin as ruby, one annotation per printed pinyin word, the way
// the book prints it. Returns null when syllables and characters disagree.
export function rubyHtml(hz, py, mark = '', breaks = []) {
  // Words keep their punctuation for display ("Lǎoshī,"); syllables are
  // counted on the letters.
  const chars = Array.from(String(hz || '')), words = String(py || '').normalize('NFC').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  if (!chars.length || !words.length) return null;
  const marked = markedChars(hz, mark);
  const han = c => /\p{Script=Han}/u.test(c), latin = c => /[A-Za-z0-9]/.test(c);
  const glyph = i => marked.has(i) ? `<em>${esc(chars[i])}</em>` : esc(chars[i]);
  let i = 0, out = '', hanSeen = 0, bi = 0;
  const skip = () => { while (i < chars.length && !han(chars[i]) && !latin(chars[i])) out += glyph(i++); };
  // Printed line breaks, after the punctuation that ends the printed line.
  const brk = () => { if (bi < breaks.length && hanSeen >= breaks[bi]) { skip(); if (i < chars.length) out += '<br>'; while (bi < breaks.length && hanSeen >= breaks[bi]) bi++; } };
  for (const word of words) {
    brk();
    skip();
    if (i >= chars.length) return null;
    if (latin(chars[i])) {
      // Latin in the hanzi line ("AI") carries itself as its own reading.
      let j = i; while (j < chars.length && latin(chars[j])) j++;
      const run = chars.slice(i, j).join('');
      if (run.toLowerCase() !== word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) return null;
      out += `<ruby>${esc(run)}<rt>${esc(word)}</rt></ruby>`; i = j; continue;
    }
    const n = pinyinSyllables(word);
    if (!n) return null;
    let base = '';
    for (let k = 0; k < n; k++) { if (i >= chars.length || !han(chars[i])) return null; base += glyph(i++); }
    hanSeen += n;
    out += `<ruby>${base}<rt>${esc(word)}</rt></ruby>`;
  }
  skip();
  return i === chars.length ? out : null;
}

// layout → HTML of one page. `assets` maps asset keys to URLs; `editable`
// makes texts contenteditable for the studio console.
// Advance widths of Arial/Arimo (the pinyin font) in em, for sizing a
// printed label to the width the OCR measured for it.
const ARIAL = { f: .278, i: .222, j: .222, l: .222, t: .278, r: .333, m: .833, w: .722, c: .5, k: .5, s: .5, v: .5, x: .5, y: .5, z: .5, ' ': .278, I: .278, J: .5, M: .833, W: .944 };
const arialEm = s => [...String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')].reduce((sum, ch) => sum + (ARIAL[ch] ?? (/[A-Z]/.test(ch) ? .667 : /[a-z0-9]/.test(ch) ? .556 : .278)), 0);
// The same for Times/Tinos (serif captions and translations).
const TIMES = { a: .444, c: .444, e: .444, z: .444, f: .333, r: .333, s: .389, i: .278, j: .278, l: .278, t: .278, m: .778, w: .722, ' ': .25, I: .333, J: .389, M: .889, W: .944, P: .556, S: .556, F: .556, E: .611, L: .611, T: .611, Z: .611 };
const timesEm = s => [...String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')].reduce((sum, ch) => sum + (TIMES[ch] ?? (/[A-Z]/.test(ch) ? .722 : /[a-z0-9]/.test(ch) ? .5 : .25)), 0);
// OCR boxes are ~12% wider than the ink; kept within sane label sizes.
const nameSize = (text, w) => Math.max(0.7, Math.min(1.6, (w * 100 * 0.88) / Math.max(1, arialEm(text)))).toFixed(2);

// A source-page number glyph can be extracted both as text and as a tiny
// transparent decoration. Keep the scan cut-out and suppress the generated
// number label when both describe the same printed marker.
export function isPrintedNumberDecoration(decoration, block) {
  const d = decoration?.box, b = block?.box;
  if (!d || !b || block.type !== 'para' || !block.number || /^[(（]/.test(String(block.number))) return false;
  return d.w < 0.05 && d.h < 0.035 && d.w / Math.max(d.h, 0.001) >= 0.8
    && d.x + d.w <= b.x + 0.01 && d.x >= b.x - 0.10
    && d.y + d.h / 2 >= b.y - 0.005 && d.y + d.h / 2 <= b.y + b.h;
}

function isPartialNumberDecoration(decoration, block) {
  const d = decoration?.box, b = block?.box;
  if (!d || !b || block.type !== 'para' || !block.number || /^[(（]/.test(String(block.number))) return false;
  return d.w < 0.05 && d.h < 0.035 && d.w / Math.max(d.h, 0.001) < 0.8
    && d.x + d.w <= b.x + 0.01 && d.x >= b.x - 0.10
    && d.y + d.h / 2 >= b.y - 0.005 && d.y + d.h / 2 <= b.y + b.h;
}

export function render(layout, { assets = {}, pinyin = true, lang = '', editable = false, videoButton = '' } = {}) {
  layout = attachInteractiveCaptions(layout);
  const ratio = (layout.page?.height || 1595) / (layout.page?.width || 1171);
  const pct = v => (v * 100).toFixed(3) + '%';
  const vars = b => (b.k ? `--k:${b.k};` : '') + (b.fill ? `--fill:${b.fill};` : '') + (b.split ? `--split:${b.split};` : '') + (b.tabH ? `--tab-h:${b.tabH};` : '') + (b.cnSize ? `--cn:${b.cnSize}cqw;` : '');
  const pos = (b, extra = '') => `left:${pct(b.box.x)};top:${pct(b.box.y)};width:${pct(b.box.w)};${vars(b)}${extra}`;
  // Kazakh rides on the Russian layer: each Russian text carries its
  // translation (layout.kz, keyed by the Russian text) and setLang swaps it in.
  const kz = layout.kz || {};
  const ed = (n, path, value, cls = '') => { const b=layout.blocks[n],isRu=/(^|[._])ru$/.test(path),k=isRu && (b?.translations?.[path]?.kk || kz[String(value ?? '').trim()]),en=isRu&&(b?.characterRibbon||b?.bilingualPrint||b?.foreword||b?.credits||b?.imprint||b?.titlePageRole)&&path.replace(/ru$/,'en').split('.').reduce((o,p)=>o?.[p],b);return `<span class="${cls}"${k ? ` data-kz="${esc(k)}"` : ''}${en?` data-en="${esc(en)}"`:''}${editable ? ` contenteditable="true" data-hsk-block="${n}" data-hsk-path="${esc(path)}"` : ''}>${esc(value)}</span>`; };
  const trio = (n, prefix, o) => (o?.cn ? ed(n, prefix + 'cn', o.cn, 'cn') : '') + (o?.en ? ed(n, prefix + 'en', o.en, 'en') : '') + (o?.ru ? ed(n, prefix + 'ru', o.ru, 'ru') : '');
  // A track mark («🔊 1-3») plays its recording when the book has it. One shared
  // player: a new track stops the previous one, the same mark again pauses.
  // Inline handler: the page works alike in the studio, an exported file and the platform.
  const audio = assets.audio || {};
  const track = (t, kind = 'audio') => {
    if (!t) return '';
    // Xiaoyu's bonus is a video (camera mark), numbered apart from the audio tracks.
    if (kind === 'video') return `<span class="hsk-track hsk-track-video">${VIDEO_MARK} ${esc(t)}</span>`;
    const src = audio[String(t).trim()];
    if (!src || editable) return `<span class="hsk-track">${TRACK_ICON} ${esc(t)}</span>`;
    return `<button type="button" class="hsk-track hsk-track-play" data-src="${esc(src)}" title="Прослушать аудио ${esc(t)}" aria-label="Прослушать аудио ${esc(t)}" onclick="var a=window.hskAudio||(window.hskAudio=new Audio()),b=this,u=b.getAttribute('data-src');document.querySelectorAll('.hsk-track-play.playing').forEach(function(x){x.classList.remove('playing')});if(a.getAttribute('data-src')===u&amp;&amp;!a.paused){a.pause();return}a.setAttribute('data-src',u);a.src=u;a.play();b.classList.add('playing');a.onended=a.onpause=function(){b.classList.remove('playing')}">${TRACK_ICON} ${esc(t)}</button>`;
  };
  const highlight = (hz, mark) => { const m = markedChars(hz, mark); return Array.from(String(hz || '')).map((c, i) => m.has(i) ? `<em>${esc(c)}</em>` : esc(c)).join(''); };
  // Hanzi with its printed pinyin above: ruby when the syllables line up,
  // otherwise a pinyin line over the hanzi line.
  const annotated = (hz, py, mark = '', breaks = []) => {
    // A speaker label («A：», «B:») carries no pinyin: rubies start after it.
    const label = /^\s*([A-Z])\s*[：:]\s*/.exec(String(hz || ''));
    if (label && py && !breaks.length) {
      const rest = rubyHtml(String(hz).slice(label[0].length), py, mark, breaks);
      if (rest) return `<span class="hz hsk-ruby"><span class="hsk-speaker-label">${esc(label[1])}：</span>${rest}</span>`;
    }
    const ruby = py ? rubyHtml(hz, py, mark, breaks) : null;
    if (ruby) return `<span class="hz hsk-ruby">${ruby}</span>`;
    let plain = highlight(hz, mark);
    if (breaks.length) {
      // Break after the n-th hanzi and the punctuation that follows it.
      const m = markedChars(hz, mark), chars = Array.from(String(hz || ''));
      let seen = 0, bi = 0; plain = '';
      chars.forEach((c, k) => {
        plain += m.has(k) ? `<em>${esc(c)}</em>` : esc(c);
        if (/\p{Script=Han}/u.test(c)) seen++;
        if (bi < breaks.length && seen >= breaks[bi] && k + 1 < chars.length && !/[，。！？、：；”）]/u.test(chars[k + 1])) { plain += '<br>'; bi++; }
      });
    }
    return `${py ? `<span class="py">${esc(py)}</span>` : ''}<span class="hz">${plain}</span>`;
  };
  const lines = s => String(s || '').split('\n');
  const rel = (r, B) => `left:${pct((r.x - B.x) / B.w)};top:${pct((r.y - B.y) / B.h)};width:${pct(r.w / B.w)};height:${pct(r.h / B.h)};`;
  // A size set by hand in the editor is final: the fit step leaves it alone.
  const tag = (n, b) => `data-block="${n}" data-hsk-bottom="${(b.box.y + b.box.h).toFixed(4)}"${b.kManual||b.drillManual ? ' data-hsk-manual="1"' : ''}${b.bold ? ' data-hsk-bold="1"' : ''}`;
  const firstImage = layout.blocks.findIndex(x => x.type === 'image');
  const printed = (b, n, at) => {
    const p = b.printed, [W,H] = p.grid, B = b.box, id = `print-${n}`;
    const tile = p.texture, tex = assets[`surface-${n}`];
    const pattern = tex && tile ? `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="${tile.w*W}" height="${tile.h*H}"><image href="${esc(tex)}" preserveAspectRatio="none" width="${tile.w*W}" height="${tile.h*H}"/></pattern></defs>` : '';
    const placed = (box, text, cls, size) => `<span class="hsk-printed-text ${cls}" style="${rel(box,B)}font-size:${size}cqw">${text}</span>`;
    const translation = {...p.enBox,w:Math.max(p.enBox.w,B.x+B.w-p.enBox.x-.01)};
    const markup = `<header ${at} data-hsk-manual="1" class="hsk-at hsk-printed hsk-printed-${b.type}" style="${pos(b,`height:${pct(B.h)};`)}"><svg aria-hidden="true" preserveAspectRatio="none" viewBox="${B.x*W} ${B.y*H} ${B.w*W} ${B.h*H}">${pattern}<path d="${p.graphic}" fill="${b.fill || '#dc321e'}"/>${pattern ? `<path d="${p.graphic}" fill="url(#${id})" opacity=".25"/>` : ''}${p.tag ? `<path d="${p.tag}" fill="#f5efe6"/>` : ''}</svg>${p.number ? placed(p.number,esc(b.number),'hsk-printed-number',p.number.h/(layout.page.width/layout.page.height)*100*1.08) : ''}${placed(p.cnBox,ed(n,'cn',b.cn,'cn'),'hsk-printed-cn',p.cnSize)}${p.pyLines.map(l=>placed(l.box,esc(l.text),'hsk-printed-py',l.box.h/(layout.page.width/layout.page.height)*100*.78)).join('')}${placed(translation,(b.en ? ed(n,'en',b.en,'en') : '')+(b.ru ? ed(n,'ru',b.ru,'ru') : ''),'hsk-printed-translation',p.enSize)}</header>`;
    const trackBox = p.trackBox || (b.track ? {...p.enBox,x:p.enBox.x+p.enBox.w+.012,w:.08} : null);
    return trackBox ? markup.replace("</header>",placed(trackBox,track(b.track),"hsk-printed-track",p.enSize)+"</header>") : markup;
  };

  const html = layout.blocks.map((b, n) => {
    // A paired picture caption is rendered once inside its interactive card.
    if (Number.isInteger(b.photoCaptionOwner) && layout.blocks[b.photoCaptionOwner]?.caption) return '';
    const at = tag(n, b), h = `height:${pct(b.box.h)};`, minH = `min-height:${pct(b.box.h)};`;
    if(b.forewordFolio)return `<span ${at} class="hsk-at hsk-foreword-folio${b.forewordFolioSide==='right'?' hsk-foreword-folio-right':''}" style="${pos(b,h)}">${esc(b.text)}</span>`;
    if(b.characterRibbon)return '<header '+at+' data-hsk-manual="1" class="hsk-at hsk-character-ribbon" style="'+pos(b,h)+'"><span class="cn">'+esc(b.cn)+'</span><span class="hsk-character-ribbon-translation"><span class="en">'+esc(b.en)+'</span>'+ed(n,'ru',b.ru,'ru')+'</span></header>';
    if(b.bilingualPrint){
      const p=b.bilingualPrint,draw=(rows,lang,font)=>rows.map(l=>{let text=p.heading?esc(l.text):esc(l.text).replace(/^([^：:]+[：:])/,'<strong class="hsk-character-name">$1</strong>');if(p.speakText&&lang==='cn')text=`<button type="button" class="hsk-classroom-speak" data-hsk-speak="${esc(p.speakText)}" onclick="event.stopPropagation();speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(this.dataset.hskSpeak);u.lang='zh-CN';speechSynthesis.speak(u)">${text}</button>`;return '<span class="hsk-bilingual-line '+lang+'" style="left:'+pct((l.box.x-b.box.x)/b.box.w)+';top:'+pct((l.box.y-b.box.y)/b.box.h)+';font-size:'+font+'cqw">'+text+'</span>'}).join('');
      const q=p.translationBox,ribbon=b.classroomRibbon?'<span class="hsk-at" style="'+rel(b.classroomRibbon.frame,b.box)+'background:#d66d71;border-radius:0 .8cqw 0 0"></span><span class="hsk-at" style="'+rel(b.classroomRibbon.translation,b.box)+'background:white;border:.1cqw solid #d66d71;box-sizing:border-box"></span>':'';
      return (b.classroomBanner?'<div class="hsk-at hsk-classroom-banner" style="left:0;top:8%;width:93%;height:8%"></div>':'')+'<section '+at+' data-hsk-manual="1" class="hsk-at hsk-bilingual-print'+(p.heading?' hsk-bilingual-heading':'')+(b.classroomBanner?' hsk-classroom-title':'')+(b.classroomRibbon?' hsk-classroom-ribbon':'')+'" style="'+pos(b,h)+'">'+ribbon+draw(p.cn,'cn',p.cnFont)+draw(p.en,'en',p.enFont)+draw(p.py||[],'pyc',p.pyFont)+'<div class="hsk-bilingual-translation" style="left:'+pct((q.x-b.box.x)/b.box.w)+';top:'+pct((q.y-b.box.y)/b.box.h)+';width:'+pct(q.w/b.box.w)+';height:'+pct(q.h/b.box.h)+';font-size:'+p.enFont+'cqw">'+ed(n,'ru',b.ru,'ru')+'</div>'+(b.characterRule?'<span class="hsk-character-rule" style="left:'+pct((b.characterRule.x-b.box.x)/b.box.w)+';top:'+pct((b.characterRule.y-b.box.y)/b.box.h)+';width:'+pct(b.characterRule.w/b.box.w)+'"></span>':'')+'</section>';
    }
    if(b.foreword){
      const p=b.foreword,original=p.lines.map(l=>{const label=/^([\u3400-\u9fff]{2,8}[：:])/.exec(l.text),text=label?`<strong>${esc(label[1])}</strong>${esc(l.text.slice(label[1].length))}`:esc(l.text);return `<span class="hsk-foreword-line${p.latin?' hsk-foreword-latin':''}" style="left:${pct((l.box.x-b.box.x)/b.box.w)};top:${pct((l.box.y-b.box.y)/b.box.h)};${p.heading?`width:${pct(l.box.w/b.box.w)};`:''}">${text}</span>`;}).join('');
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-foreword${p.heading?' hsk-foreword-heading':p.banner?' hsk-foreword-banner':p.paragraph?p.compact?' hsk-foreword-item':' hsk-foreword-prose':' hsk-foreword-signature'}" style="${pos(b,h)}font-size:${p.font}cqw;${p.banner?`background:${p.banner.color};`:''}">${original}${ed(n,'ru',b.ru,'ru hsk-foreword-translation')}</section>`;
    }
    if(b.creditsFolio)return `<span ${at} class="hsk-at hsk-credits-folio" style="${pos(b,h)}background:${b.creditsFolio.color}">${esc(b.text||b.number||'')}</span>`;
    if(b.credits){
      const p=b.credits;
      const original=p.lines.map((l,i)=>{
        const label=i===0?p.label:null,body=label?l.text.replace(/^([^：:]+[：:])\s*/,''):l.text;
        const start=label?label.box.x+label.box.w+.012:l.box.x;
        return (label?`<span class="hsk-credits-label" style="left:${pct((label.box.x-b.box.x)/b.box.w)};top:${pct((l.box.y-b.box.y)/b.box.h)};width:${pct(label.box.w/b.box.w)};color:${p.color}">${esc(label.text)}</span>`:'')+`<span class="hsk-credits-cn" style="left:${pct((start-b.box.x)/b.box.w)};top:${pct((l.box.y-b.box.y)/b.box.h)};${p.heading?`color:${p.color};`:''}">${esc(body)}</span>`;
      }).join('');
      const kk=b.translations?.ru?.kk||kz[b.ru]||'',font=p.title?Math.min(p.font,3.1):Math.min(p.font,(b.box.w*100)/(Math.max(b.ru?.split('\n')[0].length||0,kk.split('\n')[0].length,b.en?.split('\n')[0].length||0)*.57||1));
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-credits${p.heading?' hsk-credits-heading':''}${p.title?' hsk-credits-title':''}" style="${pos(b,h)}font-size:${p.font}cqw;--translated-font:${font}cqw;--credits-color:${p.color}">${original}${ed(n,'ru',b.ru,'ru hsk-credits-translation')}</section>`;
    }
    if(b.imprintLabels){
      return `<figure ${at} class="hsk-at" style="${pos(b,h)}"><img style="width:100%;height:100%;object-fit:fill" src="${esc(assets['img-'+n]||'')}" alt="${esc(b.alt||'')}"></figure>`+b.imprintLabels.map(l=>`<span class="hsk-at hsk-imprint-logo-label" style="left:${pct(l.box.x)};top:${pct(l.box.y)};width:${pct(l.ru?.6:l.box.w)};font-size:${l.box.h*ratio*100*.85}cqw">${l.ru?`<span class="en">${esc(l.text)}</span><span class="ru" data-en="${esc(l.en||({'记载人类文明':'Recording Human Civilization','沟通世界文化':'Connecting World Cultures'})[l.text]||l.text)}" data-kz="${esc(l.kk)}">${esc(l.ru)}</span>`:esc(l.text)}</span>`).join('');
    }
    if(b.imprint){
      const p=b.imprint,style=box=>`left:${pct((box.x-b.box.x)/b.box.w)};top:${pct((box.y-b.box.y)/b.box.h)};width:${pct(box.w/b.box.w)};`;
      const translated=!!b.ru;
      const originals=p.kind==='rows'?p.rows.map(row=>`<span class="hsk-imprint-original" style="${style({x:b.box.x,y:row.y,w:b.box.w})}"><span class="hsk-imprint-label" style="width:${(p.valueX-b.box.x-.015)*100}cqw;margin-right:1.5cqw">${[...row.label].map(c=>`<span>${esc(c)}</span>`).join('')}</span>${esc(row.value)}</span>`).join(''):p.lines.map(l=>`<span class="hsk-imprint-original" style="${style(l.box)}">${esc(l.text)}</span>`).join('');
      const translation=p.kind==='rows'?b.ru.split('\n').map((ru,i)=>{const kk=(b.translations?.ru?.kk||kz[b.ru]||'').split('\n')[i],en=b.en?.split('\n')[i],size=Math.min(p.font,b.box.w*100/(Math.max(ru.length,kk?.length||0,en?.length||0)*.58));return `<span class="hsk-imprint-row-translation" style="top:${pct(i*p.pitch/b.box.h)};font-size:${size}cqw"><span class="ru"${en?` data-en="${esc(en)}"`:''}${kk?` data-kz="${esc(kk)}"`:''}>${esc(ru)}</span></span>`;}).join(''):ed(n,'ru',b.ru,'ru hsk-imprint-translation');
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-imprint${translated?' hsk-imprint-translated':''}" style="${pos(b,h)}font-size:${p.font}cqw">${originals}${translated?translation:''}</section>`;
    }
    if(b.titlePageRole){
      const a=b.titleArtwork;
      const graphic=a?`<svg class="hsk-at hsk-title-art" role="img" aria-label="${esc(a.label)}" style="left:${pct(a.box.x)};top:${pct(a.box.y)};width:${pct(a.box.w)};height:${pct(a.box.h)}" viewBox="${a.viewBox}" preserveAspectRatio="none"><title>${esc(a.label)}</title><path d="${a.path}" fill="${a.color}"/></svg>`:'';
      const original=(b.titleOriginalLines||[]).map(l=>`<span class="hsk-title-original-line" style="left:${pct((l.box.x-b.box.x)/b.box.w)};top:${pct((l.box.y-b.box.y)/b.box.h)};width:${pct(l.box.w/b.box.w)};font-size:${l.box.h*ratio*100*.92}cqw">${esc(l.text)}</span>`).join('');
      return graphic+`<section ${at} data-hsk-manual="1" class="hsk-at hsk-title-text hsk-title-${b.titlePageRole}" style="${pos(b,h)}font-size:${b.titleFont}cqw;color:${b.color};text-align:${b.align}">${original}${trio(n,'',{...b,cn:b.titleCn||b.cn})}</section>`;
    }
    if(b.optionTurns?.length){
      const speak=`event.stopPropagation();var u=new SpeechSynthesisUtterance(this.dataset.hskSpeak);u.lang='zh-CN';speechSynthesis.cancel();speechSynthesis.speak(u)`;
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-option-dialogue" style="${pos(b,h)}">${b.number?`<span class="hsk-option-number">${esc(b.number)}</span>`:''}${b.optionTurns.map((t,k)=>{
        const end=b.box.x+b.box.w,translation={x:t.cnBox.x+t.cnBox.w+.01,y:t.cnBox.y,w:Math.max(.065,end-t.cnBox.x-t.cnBox.w-.01),h:.03};
        return `${t.pyBox?`<span class="hsk-option-py" style="${rel(t.pyBox,b.box)}">${esc(t.py)}</span>`:''}<button type="button" class="hsk-option-cn" data-hsk-speak="${esc(t.hz)}" style="${rel(t.cnBox,b.box)}" onclick="${esc(speak)}">${esc(t.speaker)}：${esc(t.hz)}</button>${t.translation?`<span class="hsk-option-translation" style="${rel(translation,b.box)}">${ed(n,`optionTurns.${k}.translation.en`,t.translation.en,'en')}${ed(n,`optionTurns.${k}.translation.ru`,t.translation.ru,'ru')}</span>`:''}`;
      }).join('')}</section>`;
    }
    if(b.toneRows&&b.gridX&&b.gridY){
      const speak=`event.stopPropagation();speechSynthesis.cancel();document.querySelectorAll('audio').forEach(function(a){a.pause()});var p=this.closest('.hsk-page');var a=p.querySelector('audio.hsk-tone-player');if(!a){a=document.createElement('audio');a.className='hsk-tone-player';a.hidden=true;p.appendChild(a)}var b=this;a.src=this.dataset.src;a.play().catch(function(){b.title='Не удалось воспроизвести запись';b.setAttribute('aria-invalid','true')})`;
      const cells=b.toneRows.map((row,r)=>row.map((s,c)=>{
        if(!s)return '';const key=toneKey(s),src=assets[`tone-${key}`];
        return `<span class="hsk-tone-grid-cell" style="left:${pct((b.gridX[c]-b.box.x)/b.box.w)};top:${pct((b.gridY[r]-b.box.y)/b.box.h)};${b.toneAlign==='left'?'transform:translateY(-50%)':''}"><button type="button" data-hsk-speak="${esc(s)}" data-tone-key="${esc(key||'')}" data-src="${esc(src||'')}" aria-label="Слог ${esc(s)}, тон ${c%4+1}" ${src?`onclick="${esc(speak)}"`:'disabled title="Для этого слога нужна запись соответствующего тона"'}>${esc(s)}</button></span>`;
      }).join('')).join('');
      const panels=b.gridX.length<=4?'':Array.from({length:b.gridX.length/4},(_,i)=>{const x=b.gridX[i*4]-.025,right=b.gridX[i*4+3]+.07;return `<span class="hsk-tone-panel" style="left:${pct((x-b.box.x)/b.box.w)};width:${pct((right-x)/b.box.w)}"></span>`;}).join('');
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-tone-grid" style="${pos(b,h)}${panels?'background:transparent;':''}">${panels}${cells}</section>`;
    }
    if(b.readingTokens){
      const handler=`event.stopPropagation();speechSynthesis.cancel();var p=this.closest('.hsk-page');p.querySelectorAll('audio').forEach(function(a){a.pause()});var a=p.querySelector('audio.hsk-tone-player');if(!a){a=document.createElement('audio');a.className='hsk-tone-player';a.hidden=true;p.appendChild(a)}a.src=this.dataset.src;a.play().catch(function(){})`;
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-reading-grid" style="${pos(b,h)}">${b.readingTokens.map(t=>{const key=recordingKey(t.text),src=assets['tone-'+key],label=toneKey(t.text)&&/\d$/.test(key||'')?`Слог ${t.text}, тон ${key?.slice(-1)}`:`Слово ${t.text}`;return `<span class="hsk-reading-cell" data-reading-row="${t.row}" style="${rel(t.box,b.box)}"><button type="button" class="hsk-table-speak" data-hsk-speak="${esc(t.text)}" data-tone-key="${key}" data-src="${esc(src||'')}" aria-label="${esc(label)}" ${src?`onclick="${esc(handler)}"`:'disabled'}>${esc(t.text)}</button></span>`;}).join('')}</section>`;
    }
    if (b.exactTokens) {
      const T=b.textTable, R=layout.page.width/layout.page.height;
      const rect=(box,fill,stroke='none')=>`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${fill}" stroke="${stroke}" stroke-width=".001"/>`;
      const tex=assets[`table-surface-${n}`];
      const surface=T?`<svg class="hsk-table-surface" aria-hidden="true" preserveAspectRatio="none" viewBox="${b.box.x} ${b.box.y} ${b.box.w} ${b.box.h}"><defs>${tex?`<pattern id="table-${n}" patternUnits="userSpaceOnUse" width="${T.texture.w}" height="${T.texture.h}"><image href="${esc(tex)}" preserveAspectRatio="none" width="${T.texture.w}" height="${T.texture.h}"/></pattern>`:''}</defs>${rect(T.frame,'#fff','#e3a299')}${rect(T.header,'#e99080')}${tex?rect(T.header,`url(#table-${n})`):''}${T.splits.map(x=>`<path d="M${x} ${T.frame.y}V${T.frame.y+T.frame.h}" stroke="#e3a299" stroke-width=".001"/>`).join('')}${(T.horizontalRules||[]).map(r=>`<path d="M${r.x} ${r.y}H${r.x+r.w}" stroke="#e3a299" stroke-width=".001"/>`).join('')}</svg>`:'';
      const tokens=b.exactTokens.map((t,k)=>{
        const header=T&&t.box.y+t.box.h/2<T.header.y+T.header.h;
        const english=header&&/^(Initials|Finals)$/.test(t.text);
        const ru=t.text==='Initials'?'Инициали':'Финали', kk=t.text==='Initials'?'Бастапқы дыбыстар':'Финалдар';
        const key=phoneticRecordingKey(t.text),src=assets['phonetic-'+key];
        const sound=`event.stopPropagation();speechSynthesis.cancel();var p=this.closest('.hsk-page');p.querySelectorAll('audio').forEach(function(a){a.pause()});var a=p.querySelector('audio.hsk-phonetics-player');if(!a){a=document.createElement('audio');a.className='hsk-phonetics-player';a.hidden=true;p.appendChild(a)}a.src=this.dataset.src;a.play().catch(function(){})`;
        const body=english?`<span class="en">${esc(t.text)}</span><span class="ru" data-kz="${kk}">${ru}</span>`:b.phoneticTextTable&&!header&&!editable?`<button type="button" class="hsk-table-speak" data-hsk-speak="${esc(key)}" data-src="${esc(src||'')}" ${src?`onclick="${esc(sound)}"`:'disabled title="Нужна учебная запись"'}>${esc(t.text)}</button>`:ed(n,`exactTokens.${k}.text`,t.text);
        return `<span class="hsk-exact-token${header?' hsk-table-header':''}${b.phoneticTextTable&&!header?' hsk-phonetic-token':''}" style="${rel(t.box,b.box)}font-size:${b.phoneticTextTable&&!header?2.05:t.box.h/R*(header?88:78)}cqw">${body}</span>`;
      }).join('');
      return `<section ${at} data-hsk-manual="1" class="hsk-at hsk-exact-text" style="${pos(b,h)}">${surface}${tokens}${b.ru?`<span class="ru">${ed(n,'ru',b.ru)}</span>`:''}</section>`;
    }
    switch (b.type) {
      case 'runhead':
        if(b.rightLesson){
          const l=b.rightLesson,atBox=q=>`left:${pct(q.x)};top:${pct(q.y)};width:${pct(q.w)};height:${pct(q.h)};`;
          return `<header ${at} class="hsk-right-printed"><span class="hsk-at cn" style="${atBox(b.box)}font-size:1.6cqw">${ed(n,'cn',b.cn)}</span><span class="hsk-at ru" style="${atBox({...b.box,y:b.box.y+b.box.h,h:.016})}font-size:1.1cqw">${ed(n,'ru',b.ru)}</span><span class="hsk-at" style="${atBox(l.label)}font:bold 1.6cqw/1 var(--sans);color:var(--red)">Lesson</span><strong class="hsk-at" style="${atBox(l.number)}font:bold 3.5cqw/1 var(--sans);color:var(--red)">${esc(b.number)}</strong></header>`;
        }
        if (b.printed) return printed(b,n,at);
        // Odd pages: "我叫李文 | Lesson 2" on one line, the number large.
        if (b.box.x > 0.5) return `<header ${at} class="hsk-at hsk-runhead hsk-runhead-right" style="${pos(b, h)}${b.numSize ? `--no:${b.numSize}cqw;` : ''}"><b>${ed(n, 'cn', b.cn)}</b><i></i>${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}${b.number ? `<strong>${esc(b.number)}</strong>` : ''}</header>`;
        if (b.tab) return `<header ${at} class="hsk-at hsk-runhead-tab" style="${pos(b, `height:${pct(b.box.h)};`)}--tab:${esc(b.tab)};--tabw:${(b.tabW / b.box.w * 100).toFixed(2)}%"><b>${ed(n, 'cn', b.cn)}</b><span>${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</span></header>`;
        return `<header ${at} class="hsk-at hsk-runhead" style="${pos(b)}"><b>${ed(n, 'cn', b.cn)}</b><span>${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</span></header>`;
      case 'lesson': {
        if (b.printed) return printed(b,n,at);
        const title = b.py && rubyHtml(b.cn, b.py);
        // The band wraps around the objectives frame below it: where the band
        // sticks out past the frame's right edge it folds down (a 45° flap).
        const right = b.box.x + b.box.w, bottom = b.box.y + b.box.h;
        const under = layout.blocks.find(o => o.type === 'objectives' && Math.abs(o.box.y - bottom) < 0.012 && right - (o.box.x + o.box.w) > 0.005 && right - (o.box.x + o.box.w) < 0.06);
        // A page-level element, not part of the header: the fit step would
        // read anything sticking out of the header as overflowing text.
        const w = under && ((right - under.box.x - under.box.w) * 100).toFixed(2);
        const flap = under ? `<i class="hsk-flap" aria-hidden="true" style="left:${pct(under.box.x + under.box.w)};top:${pct(bottom)};width:${w}cqw;height:${w}cqw;${b.fill ? `--fill:${b.fill}` : ''}"></i>` : '';
        return flap + `<header ${at} class="hsk-at hsk-lesson" style="${pos(b, h)}"><div class="hsk-lesson-no">${esc(b.number)}</div><div class="hsk-lesson-title">${b.label ? `<small>${esc(b.label)}</small>` : ''}${title && !editable ? `<span class="cn hsk-ruby">${title}</span>` : ed(n, 'cn', b.cn, 'cn')}${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</div></header>`;
      }
      case 'objectives':
        return `<section ${at} class="hsk-at hsk-objectives" style="${pos(b, minH)}"><h3>${TARGET_ICON}${trio(n, 'heading.', { ...b.heading, cn: String(b.heading?.cn || '').replace(/^[◎⊙◉⦾]\s*/u, '') })}</h3>${(b.items || []).map((it, k) => `<div class="hsk-objective"><span class="hsk-check"></span><span>${trio(n, `items.${k}.`, it)}</span></div>`).join('')}</section>`;
      case 'section': {
        if(b.printed?.kind==='section-tab'){
          const p=b.printed,[W,H]=p.grid;
          return `<header ${at} data-hsk-manual="1" class="hsk-at hsk-section-tab" style="${pos(b,h)}"><span class="hsk-section-pill" style="${rel(p.pill,b.box)}"></span><svg aria-hidden="true" preserveAspectRatio="none" viewBox="${b.box.x*W} ${b.box.y*H} ${b.box.w*W} ${b.box.h*H}"><path d="${p.graphic}" fill="${esc(b.fill||'#e59180')}"/></svg><span class="hsk-section-cn" style="${rel(p.cnBox,b.box)}font-size:${p.cnSize}cqw">${ed(n,'cn',b.cn)}</span><span class="hsk-section-translation" style="${rel(p.enBox,b.box)}">${ed(n,'en',b.en,'en')}${ed(n,'ru',b.ru,'ru')}</span>${p.trackBox?`<span class="hsk-section-track" style="${rel(p.trackBox,b.box)}">${track(b.track)}</span>`:''}</header>`;
        }
        // Features ("小语的彩蛋") carry the character over the tab's left end.
        const fb = b.avatar && secAvatarBox(b);
        const face = fb && assets[`sec-${n}`] ? `<img class="hsk-at hsk-sec-avatar" style="left:${pct(fb.x)};top:${pct(fb.y)};width:${pct(fb.w)};height:${pct(fb.h)}" src="${esc(assets[`sec-${n}`])}" alt="">` : '';
        if (b.printed) return printed(b,n,at) + face;
        const media = /^\d+-\d+$/.test(b.track || '') && b.avatar ? VIDEO_ICON : TRACK_ICON;
        return face + `<h2 ${at} class="hsk-at hsk-section${b.avatar ? ' hsk-feature' : ''}" style="${pos(b, h)}${b.avatar ? `--face:${pct(Math.max(0, (b.avatar.x + b.avatar.w - b.box.x) / b.box.w))};` : ''}">${ed(n, 'cn', b.cn, 'cn')}<span class="tag">${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}${b.track ? `<span class="hsk-track">${media} ${esc(b.track)}</span>` : ''}</span></h2>`;
      }
      case 'para': {
        const option = /^[A-Z]$/.test(String(b.number || '')) ? ' hsk-option' : ''; // A-F labels under a row of pictures
        // «(1)», «（2）»: plain printed numbers; bare digits are the pink numbered boxes.
        const plainNo = /^[(（]\d+[)）]$/.test(String(b.number || ''));
        const numberAlreadyInScan = b.number && (layout.decorations || []).some(d => isPrintedNumberDecoration(d, b));
        let icon = b.number ? (numberAlreadyInScan ? '' : plainNo ? `<span class="hsk-plainnum">${esc(b.number)}</span>` : `<span class="hsk-num">${esc(b.number)}</span>`) : b.icon === 'pin' ? PIN_ICON + '<span></span>' : b.icon === 'square' ? '<span class="hsk-square"></span>' : '<span></span>';
        // Verse with pinyin (tongue twisters): ruby lines, then the translation
        // lines as printed — in the studio's editor too (its translation stays
        // editable in place), so the page there looks like the print.
        // A short exercise item with a gloss — «(4) 我妈妈 (māma, mother)»: the print has the pinyin and the
        // meaning in brackets on the same line, not stacked above and below the word.
        if (b.py && plainNo && lines(b.cn).length === 1 && Array.from(b.cn || '').length <= 12 && (b.en || b.ru)) {
          const gloss = `<span class="hsk-gloss">(<span class="gl-pyw">${ed(n, 'py', b.py, 'gl-py')}, </span>${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''})</span>`;
          return `<p ${at} class="hsk-at hsk-para" style="${pos(b)}">${icon}<span>${ed(n, 'cn', b.cn, 'cn')} ${gloss}</span></p>`;
        }
        if (b.py) {
          const cn = lines(b.cn), py = lines(b.py), pairs = cn.length === py.length ? cn.map((c, k) => [c, py[k]]) : [[cn.join(''), py.join(' ')]];
          const lead = option ? `<span class="hsk-opt-letter">${esc(b.number)}</span>` : '';
          const verse = pairs.map(([c, p]) => `<span class="hsk-verse-line">${lead}${annotated(c, p)}</span>`).join('');
          if (option) icon = '<span></span>';
          return `<div ${at} class="hsk-at hsk-para hsk-verse${option}"${b.fitSet ? ` data-fit-set="${esc(b.fitSet)}"` : ''} style="${pos(b)}${b.hzSize ? `--vhz:${b.hzSize}cqw;` : ''}${b.vtrack ? `--vtrack:${b.vtrack}cqw;` : ''}${b.pySize ? `--py:${b.pySize}cqw;` : ''}${b.vline ? `--vline:${b.vline}cqw;` : ''}${b.vlh ? `--vlh:${b.vlh}cqw;` : ''}${b.vEn ? `--ven:${b.vEn}cqw;` : ''}">${icon}<div><div class="cn">${verse}</div>${b.en && !b.trOff ? ed(n, 'en', b.en, 'en hsk-lines') : ''}${b.ru && !b.trOff ? ed(n, 'ru', b.ru, 'ru hsk-lines') : ''}${track(b.track, isVideoMark(b) ? 'video' : 'audio')}</div></div>`;
        }
        if(b.printedCnLines?.length&&!editable){
          const ratio=layout.page.height/layout.page.width, end=Math.max(...b.printedCnLines.map(l=>l.box.y+l.box.h));
          const cnFont=median(b.printedCnLines.map(l=>Math.min(l.box.h*ratio*100*.85,l.box.w*100/[...l.text].reduce((s,c)=>s+(/\p{Script=Han}/u.test(c)?1:/[\x00-\x7F]/.test(c)?.5:1),0))));
          const cn=`<span class="cn hsk-printed-paragraph" style="height:${(end-b.box.y)*ratio*100}cqw">${b.printedCnLines.map(l=>{
            const units=[...l.text].reduce((s,c)=>s+(/\p{Script=Han}/u.test(c)?1:/[\x00-\x7F]/.test(c)?.5:1),0),font=Math.min(l.box.h*ratio*100*.85,l.box.w*100/units);
            return `<span style="left:${(l.box.x-b.box.x)*100}cqw;top:${(l.box.y-b.box.y)*ratio*100}cqw;font-size:${cnFont}cqw">${esc(l.text)}</span>`;
          }).join('')}</span>`;
          const enFont=b.printedEnLines?.length?median(b.printedEnLines.map(l=>l.box.h*ratio*78)):0;
          const en=b.printedEnLines?.length?`<span class="en hsk-printed-paragraph" style="height:${(Math.max(...b.printedEnLines.map(l=>l.box.y+l.box.h))-end)*ratio*100}cqw">${b.printedEnLines.map(l=>`<span style="left:${(l.box.x-b.box.x)*100}cqw;top:${(l.box.y-end)*ratio*100}cqw;font-size:${enFont}cqw">${esc(l.text.trim())}</span>`).join('')}</span>`:b.en?ed(n,'en',b.en,'en'):'';
          return `<p ${at} class="hsk-at hsk-para" style="${pos(b)}">${icon}<span>${cn}${en}${b.ru?ed(n,'ru',b.ru,'ru'):''}${track(b.track)}</span></p>`;
        }
        return `<p ${at} class="hsk-at hsk-para${option}${b.enBreak ? ' hsk-para-break' : ''}${b.indent ? ' hsk-para-indent' : ''}" style="${pos(b)}${b.ink ? 'color:' + b.ink + ';' : ''}">${icon}<span>${trio(n, '', b)}${track(b.track)}</span></p>`;
      }
      case 'bonus': {
        const B = b.box, img = b.image && assets[`bon-${n}`] ? `<img class="hsk-bonus-img" style="${rel(b.image, B)}" src="${esc(assets[`bon-${n}`])}" alt="">` : '';
        const title = b.titleBox ? `style="${rel(grow(b.titleBox, 0.03, 0.004), B)}height:auto;"` : '';
        return `<section ${at} class="hsk-at hsk-bonus" style="${pos(b, h)}${b.cnSize ? `--bcn:${b.cnSize}cqw;` : ''}${b.enSize ? `--ben:${b.enSize}cqw;` : ''}${b.bar ? `--bar:${b.bar};` : ''}${b.barH ? `--bar-h:${b.barH * 100}%;` : ''}"><div class="hsk-bonus-title"${title ? ' ' + title : ''}>${b.cn ? `<b>${ed(n, 'cn', b.cn, 'cn')}</b>` : ''}${b.en && !b.trOff ? ed(n, 'en', b.en, 'en hsk-lines') : ''}${b.ru && !b.trOff ? ed(n, 'ru', b.ru, 'ru hsk-lines') : ''}</div>${img}${b.bar ? `<div class="hsk-bonus-bar" aria-hidden="true">${PLAYER_BAR}</div>` : ''}</section>`;
      }
      case 'tip':
        return (b.avatar && assets[`tip-${n}`] ? `<img class="hsk-at hsk-tip-avatar" style="left:${pct(b.avatar.x)};top:${pct(b.avatar.y)};width:${pct(b.avatar.w)};z-index:2" src="${esc(assets[`tip-${n}`])}" alt="">` : '') +
          // The label sits right under the character drawn over the tip.
          `<aside ${at} class="hsk-at hsk-tip" style="${pos(b, minH)}"><div class="hsk-tip-label"${b.avatar && b.avatar.y + b.avatar.h > b.box.y ? ` style="align-self:start;margin-top:${((b.avatar.y + b.avatar.h - b.box.y) * ratio * 100).toFixed(2)}cqw"` : ''}>${b.label?.cn ? ed(n, 'label.cn', b.label.cn) : ''}${b.label?.en ? `<small class="en">${ed(n, 'label.en', b.label.en)}</small>` : ''}${b.label?.ru ? `<small class="ru">${ed(n, 'label.ru', b.label.ru)}</small>` : ''}</div><div>${trio(n, '', b)}</div></aside>`;
      case 'dialogue': if (b.turns.length && b.turns.every(t => t.bubble)) {
        // Measured geometry: every part sits where it is printed.
        const B = b.box;
        return `<section ${at} class="hsk-at hsk-dialogue hsk-dialogue-exact" style="${pos(b, h)}${b.size ? `--hz:${b.size}cqw;` : ''}">` + b.turns.map((t, k) => {
          const src = assets[`ava-${n}-${k}`], s = t.speaker;
          const face = !s.avatarBox ? '' : s.avatar === 'photo' && src ? `<img class="hsk-face" style="${rel(s.avatarBox, B)}" src="${esc(src)}" alt="">` : s.avatar !== 'none' ? `<span class="hsk-face hsk-group" style="${rel(s.avatarBox, B)}">${GROUP_ICON}</span>` : '';
          const label = r => { const w = Math.max(r.w, 0.1), c = r.x + r.w / 2; return { x: c - w / 2, y: r.y, w, h: r.h }; };
          const spy = s.py && s.pyBox ? `<span class="py hsk-name-py" style="${rel(label(s.pyBox), B)}font-size:${nameSize(s.py, s.pyBox.w)}cqw">${esc(s.py)}</span>` : '';
          const name = s.nameBox ? `<b class="hsk-name" style="${rel(label(s.nameBox), B)}${s.nameSize ? `font-size:calc(${s.nameSize}cqw*var(--k,1));` : ''}${s.nameSpacing ? `letter-spacing:${s.nameSpacing}cqw;text-indent:${s.nameSpacing}cqw;` : ''}">${ed(n, `turns.${k}.speaker.cn`, s.cn)}</b>` : '';
          return `<div class="hsk-turn">${face}${spy}${name}<div class="hsk-bubble" style="${rel(t.bubble, B)}${t.size ? `--hz:${t.size}cqw;` : ''}${t.pySize ? `--py:${t.pySize}cqw;` : ''}${t.track ? `--track:${t.track}cqw;` : ''}${t.padL ? `padding-left:${(t.padL * 100).toFixed(2)}cqw;` : ''}">${annotated(t.hz, t.py, t.highlight, t.breaks || [])}</div></div>`;
        }).join('') + '</section>';
      } else {
        const pitch = b.turns.length ? (b.box.h * ratio * 100) / b.turns.length : 10;
        const bubble = Math.min(6.7, pitch * 0.62);
        return `<section ${at} class="hsk-at hsk-dialogue" style="${pos(b, `grid-auto-rows:${pitch.toFixed(3)}cqw;--bubble-h:${bubble.toFixed(3)}cqw;`)}">` + b.turns.map((t, k) => {
          const src = assets[`ava-${n}-${k}`];
          const face = t.speaker.avatar === 'photo' && src ? `<img src="${esc(src)}" alt="">` : t.speaker.avatar !== 'none' ? GROUP_ICON : '';
          return `<div class="hsk-turn"><figure class="hsk-speaker">${face}${t.speaker.py ? `<span class="py">${esc(t.speaker.py)}</span>` : ''}<b>${ed(n, `turns.${k}.speaker.cn`, t.speaker.cn)}</b></figure><div class="hsk-bubble">${annotated(t.hz, t.py, t.highlight)}</div></div>`;
        }).join('') + '</section>';
      }
      case 'image': {
        // The page's generated clip replaces the main illustration; its poster
        // is a frame from that clip, so the page matches what plays.
        const clip = n === firstImage && assets.clip;
        const media = clip
          // A big play button in the middle shows at a glance that the picture is a video;
          // the player's own controls appear once it plays. Inline handlers: the
          // page works the same in the studio, an exported file and the platform.
          ? `<video playsinline preload="metadata" poster="${esc(assets.clipPoster || assets[`img-${n}`] || '')}" aria-label="${esc(b.alt || 'Видео страницы')}" onclick="if(!this.controls)this.parentNode.querySelector('.hsk-play').click()"><source src="${esc(assets.clip)}"${assets.clipType ? ` type="${esc(assets.clipType)}"` : ''}></video>`
            + `<button type="button" class="hsk-play" aria-label="Смотреть видео" title="Смотреть видео" onclick="${CLIP_ZOOM}"><span></span></button>`
          : assets[`img-${n}`] ? `<img src="${esc(assets[`img-${n}`])}" alt="${esc(b.alt)}">` : '';
        const frame = b.frame ? `<div class="hsk-at hsk-deco hsk-frame" aria-hidden="true" style="left:${pct(b.frame.x)};top:${pct(b.frame.y)};width:${pct(b.frame.w)};height:${pct(b.frame.h)};--frame:${esc(b.frame.color || '#e69e96')}"></div>` : '';
        const caption = b.caption ? `<figcaption class="hsk-photo-caption"><span class="py">${ed(n, 'caption.py', b.caption.py || '', 'py')}</span><span class="cn">${ed(n, 'caption.hz', b.caption.hz || '', 'cn')}</span>${b.caption.ru ? `<span class="ru">${ed(n, 'caption.ru', b.caption.ru, 'ru')}</span>` : ''}</figcaption>` : '';
        const speech = b.caption?.hz ? `data-hsk-speak="${esc(b.caption.hz)}" role="button" tabindex="0" aria-label="${esc(`${b.caption.hz}, ${b.caption.ru || ''}. Нажмите, чтобы прослушать.`)}"` : '';
        const labels=(b.diagramLabels||[]).map((l,k)=>`<span class="hsk-graph-label" style="${rel(l.box,b.box)}"><span class="cn">${esc(l.cn)}</span>${ed(n,`diagramLabels.${k}.ru`,l.ru,'ru')}</span>`).join('');
        const optionCount=layout.blocks.filter(o=>o.dialogueOptions||o.optionTurns).length||3;
        const answer=b.matchingInput?'<input class="hsk-picture-answer" '+(optionCount===4?'style="left:0;top:0;width:21%;height:18%" ':'')+'inputmode="numeric" maxlength="1" pattern="[1-'+Math.min(9,optionCount)+']" aria-label="Номер подходящего диалога" autocomplete="off">':'';
        return `${frame}<figure ${at} ${speech} class="hsk-at hsk-photo${b.caption?.hz ? ' hsk-photo-speaking' : ''}${b.captionFrame ? ' hsk-caption-frame' : ''}${clip ? ' hsk-clip' : ''}" style="${pos(b, h)}">${media}${caption}${labels}${answer}${n === firstImage && !clip ? videoButton : ''}</figure>`;
      }
      case 'card':
        return `<section ${at} class="hsk-at hsk-card" style="${pos(b, h)}"><div class="en">${(b.lines || []).map((l, k) => `<p>${ed(n, `lines.${k}.en`, l.en)}</p>`).join('')}</div><div class="ru">${(b.lines || []).map((l, k) => `<p>${ed(n, `lines.${k}.ru`, l.ru)}</p>`).join('')}</div></section>`;
      case 'words': {
        if (b.phoneticChart) {
          const headers = [
            { cn: '声母', en: 'Initials', ru: 'Инициали' },
            { cn: '韵母', en: 'Finals', ru: 'Финали' },
            { cn: '声调', en: 'Tones', ru: 'Тоны' },
            { cn: '音节', en: 'Syllables', ru: 'Слоги' },
            { cn: '例字', en: 'Example Characters', ru: 'Примеры' }
          ];
          const speak=(text,speech,content,kind)=>{
            if(!text)return '';
            if(editable)return content;
            const src=assets[`phonetic-${text}`]||'';
            const handler=`var p=this.closest('.hsk-page');p.querySelectorAll('.hsk-table-speak').forEach(function(b){b.setAttribute('aria-pressed','false')});this.setAttribute('aria-pressed','true');var t=this.dataset.hskSpeak;var say=function(){var u=new SpeechSynthesisUtterance(t);u.lang='zh-CN';speechSynthesis.cancel();speechSynthesis.speak(u)};if(this.dataset.src){var a=p.querySelector('audio.hsk-table-player');if(!a){a=document.createElement('audio');a.className='hsk-table-player';a.hidden=true;p.appendChild(a)}a.pause();a.src=this.dataset.src;a.play().catch(say)}else say()`;
            return `<button type="button" class="hsk-table-speak" data-hsk-speak="${esc(speech||text)}" data-src="${esc(src)}" aria-pressed="false" aria-label="${kind} ${esc(text)} — прослушать" onclick="${esc(handler)}">${content}</button>`;
          };
          const body = (b.rows || []).map((r,k)=>r.group?'':`<tr><td>${speak(r.pos_en,r.pos_en,ed(n,`rows.${k}.pos_en`,r.pos_en,'hz'),'Инициаль')}</td><td>${speak(r.pos_ru,r.pos_ru,ed(n,`rows.${k}.pos_ru`,r.pos_ru,'hz'),'Финаль')}</td><td>${ed(n,`rows.${k}.en`,r.en,'hz')}</td><td class="py">${speak(r.py,r.hz||r.py,esc(r.py),'Слог')}</td><td>${speak(r.hz,r.hz,ed(n,`rows.${k}.hz`,r.hz,'hz'),'Иероглиф')}</td></tr>`).join('');
          const head = headers.map(h => `<th scope="col"><span class="cn">${esc(h.cn)}</span><span class="en">${esc(h.en)}</span><span class="ru"${layout.kz?.[h.ru] ? ` data-kz="${esc(layout.kz[h.ru])}"` : ''}>${esc(h.ru)}</span></th>`).join('');
          return `<section ${at} class="hsk-at hsk-phonetic-chart" style="${pos(b, h)}"><table class="hsk-phonetic-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
        }
        // Columns measured on the scan, shared by every row (otherwise each
        // row sizes its own and a long word pushes its row out of line).
        const c = b.cols, w = v => `calc(${Math.max(0, v * 100).toFixed(2)}cqw / var(--z, 1))`;
        const cols = !c ? '' : `--word-cols:${w(c.hz - b.box.x - 0.012)} minmax(${w(c.py - c.hz)},max-content) minmax(${w((c.pos ?? c.en) - c.py)},max-content) ${c.pos ? `minmax(${w(c.en - c.pos)},max-content)` : '0'} 1fr;`;
        return `<section ${at} class="hsk-at hsk-words${c ? ' hsk-words-cols' : ''}" style="${pos(b, minH + cols)}"><h3 class="hsk-words-tab">${trio(n, 'heading.', b.heading)}${track(b.track)}</h3>` + (b.rows || []).map((r, k) => r.group ? `<h4 class="hsk-words-group">${trio(n, `rows.${k}.group.`, r.group)}</h4>` :
          `<div class="hsk-word"><span class="i">${esc(r.i)}</span>${ed(n, `rows.${k}.hz`, r.hz, 'hz')}<span class="py">${esc(r.py)}</span><span class="pos">${ed(n, `rows.${k}.pos_en`, r.pos_en, 'en')}${ed(n, `rows.${k}.pos_ru`, r.pos_ru, 'ru')}</span>${ed(n, `rows.${k}.en`, r.en, 'en')}${ed(n, `rows.${k}.ru`, r.ru, 'ru')}</div>`).join('') + '</section>';
      }
      case 'decor':
        return ''; // drawn in the graphics layer under the blocks
      case 'folio':
        if(b.printed?.kind==='folio')return `<span ${at} class="hsk-at hsk-folio-measured" style="${pos(b,h)}"><svg aria-hidden="true" preserveAspectRatio="none" viewBox="${b.box.x*b.printed.grid[0]} ${b.box.y*b.printed.grid[1]} ${b.box.w*b.printed.grid[0]} ${b.box.h*b.printed.grid[1]}"><path d="${b.printed.graphic}" fill="${esc(b.fill||'#cb3023')}"/></svg><span>${esc(b.text)}</span></span>`;
        return `<span ${at} class="hsk-at hsk-folio${b.box.x > 0.5 ? ' hsk-folio-right' : ''}" style="${pos(b, h)}">${esc(b.text)}</span>`;
      default: {
        // Rows/columns (tab-separated) and answer blanks («____») — the shape of
        // workbook drills. Outside the editor a blank becomes an input field.
        const rows = gridLayout(b);
        if (rows) {
          const cols = Math.max(...rows.map(r => r.length));
          const blank = editable ? '<span class="hsk-blank"></span>' : '<input class="hsk-blank" autocomplete="off" spellcheck="false" aria-label="Ответ">';
          const cell = c => esc(c).replace(/_{3,}/g, blank);
          const kind = b.cn ? 'cn' : 'pyc';   // pinyin as the content itself: always shown
          // Measured from the scan: each cell at its printed column and row.
          // The syllable sits where it is printed; a blank before it hangs to its left.
          // Cells at the places measured on the scan (a list of syllables); a cell the scan did not
          // show sits one pitch after the previous one.
          if (b.cellXY?.length === rows.length && rows.every(r => r.length === 1)) {
            const pts = b.cellXY.slice(), xs = pts.filter(Boolean).map(p => p[0]).sort((a, c) => a - c), gaps = xs.slice(1).map((v, k) => v - xs[k]).filter(g => g > 0.02), pitch = gaps.length ? median(gaps) : 0.08;
            pts.forEach((pt, k) => { if (!pt) pts[k] = k && pts[k - 1] ? [pts[k - 1][0] + pitch, pts[k - 1][1]] : [b.box.x, b.box.y + b.box.h / 2]; });
            const body = rows.map((r, k) => `<span class="hsk-gcell ${kind}" style="left:${((pts[k][0] - b.box.x) / b.box.w * 100).toFixed(2)}%;top:${((pts[k][1] - b.box.y) / b.box.h * 100).toFixed(2)}%">${(lead => lead ? `<span class="hsk-gl">${blank}</span>` + cell(r[0].slice(lead[0].length)) : cell(r[0]))(/^_{3,}\s*/.exec(r[0]))}</span>`).join('');
            return `<div ${at} class="hsk-at hsk-text hsk-text-${b.size || 'm'} hsk-grid-abs" style="${pos(b, `height:${pct(b.box.h)};`)}">${body}</div>`;
          }
          const X = b.gridX, Y = b.gridY;
          if (X?.length === cols && Y?.length === rows.length) {
            const pitch = X.length > 1 ? median(X.slice(1).map((v, i) => v - X[i])) : 0.15, bw = (pitch * 0.72 * 100).toFixed(2);
            const body = rows.map((r, ri) => r.map((c, ci) => {
              if (!c) return '';
              const lead = /^_{3,}\s*/.exec(c), text = lead ? c.slice(lead[0].length) : c;
              const inner = (lead ? `<span class="hsk-gl">${blank}</span>` : '') + cell(text);
              return `<span class="hsk-gcell ${kind}" style="left:${((X[ci] - b.box.x) / b.box.w * 100).toFixed(2)}%;top:${((Y[ri] - b.box.y) / b.box.h * 100).toFixed(2)}%">${inner}</span>`;
            }).join('')).join('');
            return `<div ${at} class="hsk-at hsk-text hsk-text-${b.size || 'm'} hsk-grid-abs" style="${pos(b, `height:${pct(b.box.h)};`)};--bw:${bw}cqw;${b.drillManual?'--k:1;font-size:1.9cqw;':''}">${body}</div>`;
          }
          const body = rows.map(r => r.map(c => `<span class="hsk-grid-cell ${kind}">${cell(c)}</span>`).join('') + '<span class="hsk-grid-end"></span>'.repeat(cols - r.length)).join('');
          return `<div ${at} class="hsk-at hsk-text hsk-text-${b.size || 'm'} hsk-grid" style="${pos(b)};--cols:${cols}">${body}</div>`;
        }
        const translatedOnly = b.translationOnly === true ? ' hsk-translation-only' : '';
        const color = /^#[\da-f]{6}$/i.test(b.color || '') ? `color:${b.color};` : '';
        return `<p ${at} class="hsk-at hsk-text hsk-text-${b.size || 'm'}${translatedOnly}" style="${pos(b)}${color}${b.align ? 'text-align:' + b.align + ';' : ''}">${b.cn ? '' : b.py ? ed(n, 'py', b.py, 'pyc') : ''}${trio(n, '', b.trOff ? { cn: b.cn } : b)}</p>`;
      }
    }
  }).join('');

  const theme = layout.theme || {};
  const style = `aspect-ratio:${layout.page?.width || 1171}/${layout.page?.height || 1595};background:${theme.paper || '#fff'};${theme.accent ? `--red:${theme.accent};` : ''}`;
  const bg = theme.background ? `<div class="hsk-at hsk-background" style="left:${pct(theme.background.box.x)};top:${pct(theme.background.box.y)};width:${pct(theme.background.box.w)};height:${pct(theme.background.box.h)};background:${theme.background.color}"></div>` : '';
  // Graphics layer; components.css lifts it above the blocks.
  const cut = (key, box, n) => assets[key] ? `<img class="hsk-at hsk-deco"${n != null ? ` data-block="${n}"` : ''} alt="" aria-hidden="true" src="${esc(assets[key])}" style="left:${pct(box.x)};top:${pct(box.y)};width:${pct(box.w)};height:${pct(box.h)}">` : '';
  const deco = layout.blocks.map((b, n) => b.type === 'decor' ? cut(`deco-b${n}`, b.box, n) : '').join('')
    // A printed number mark («❶», a numbered square) cut out of the scan just
    // left of a numbered paragraph: the paragraph draws its own number there,
    // so the cut-out (often clipped) would show it twice.
    + (layout.decorations || []).map((d, i) => layout.blocks.some(b => (b.classroomBanner&&d.box.y<.18)||isPartialNumberDecoration(d, b)||(b.rightLesson&&d.box.y<.07&&d.box.x>b.rightLesson.label.x-.015&&d.box.x+d.box.w<b.rightLesson.number.x+b.rightLesson.number.w+.015)) ? '' : cut(`deco-${i}`, d.box)).join('');
  // Versioned conversions must display their actual HTML in every language.
  // Legacy scan overlays otherwise conceal missing table structure and text.
  const translatedSource = (layout.conversionId ? [] : layout.sourceRegions || []).map(r => {
    const n = layout.blocks.findIndex(b => (r.en && b.en === r.en) || (r.enPrefix && b.en?.startsWith(r.enPrefix))), b = layout.blocks[n];
    const text = b?.ru || r.ru;
    if (!text) return '';
    const translated = n >= 0 ? ed(n,'ru',text,'ru') : `<span class="ru">${esc(text)}</span>`;
    return `<div class="hsk-source-translation" style="left:${pct(r.box.x)};top:${pct(r.box.y)};width:${pct(r.box.w)};height:${pct(r.box.h)};background:${esc(r.fill || '#fff')};color:${esc(r.color || '#222')};font-size:${Number(r.size)||1.7}cqw;align-items:${r.align === 'start' ? 'flex-start' : 'center'}">${translated}</div>`;
  }).join('');
  const source = !layout.conversionId && assets.sourceScan && layout.sourceLines?.length ? `<div class="hsk-source-page"><img src="${esc(assets.sourceScan)}" alt="Исходная страница" draggable="false">${layout.sourceLines.map(l => {
    const b = l.position;
    return b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height) ? `<span class="hsk-source-line" style="left:${pct(b.x)};top:${pct(b.y)};width:${pct(b.width)};height:${pct(b.height)};font-size:${(b.height * ratio * 90).toFixed(3)}cqw">${esc(l.text)}</span>` : '';
  }).join('')}${translatedSource}</div>` : '';
  const phonetics = (layout.phonetics?.cells || []).filter(c=>!layout.blocks.some(b=>(b.phoneticChart||b.phoneticTextTable||b.readingTokens)&&c.box.x+c.box.w/2>=b.box.x&&c.box.x+c.box.w/2<=b.box.x+b.box.w&&c.box.y+c.box.h/2>=b.box.y&&c.box.y+c.box.h/2<=b.box.y+b.box.h)).map(c => {
    const src = assets[`phonetic-${c.text}`];
    const kind = c.kind === 'initial' ? 'Инициаль' : c.kind === 'final' ? 'Финаль' : 'Слог';
    const handler = `var p=this.closest('.hsk-page');p.querySelectorAll('.hsk-phonetic-cell').forEach(function(b){b.setAttribute('aria-pressed','false')});this.setAttribute('aria-pressed','true');var s=p.querySelector('.hsk-phonetic-status');s.textContent='${kind}: '+this.textContent;var say=function(){var u=new SpeechSynthesisUtterance(this.dataset.hskSpeak||this.textContent);u.lang='zh-CN';speechSynthesis.cancel();speechSynthesis.speak(u)}.bind(this);var a=p.querySelector('audio.hsk-phonetics-player');if(!a){a=document.createElement('audio');a.className='hsk-phonetics-player';a.hidden=true;p.appendChild(a)}if(this.dataset.src){a.pause();a.src=this.dataset.src;a.play().catch(say)}else say()`;
    return `<button type="button" class="hsk-phonetic-cell" aria-label="${kind} ${esc(c.text)} — выбрать и прослушать" aria-pressed="false" data-hsk-speak="${esc(c.speak || c.text)}" data-src="${esc(src || '')}" style="left:${pct(c.box.x)};top:${pct(c.box.y)};width:${pct(c.box.w)};height:${pct(c.box.h)}" onclick="${esc(handler)}">${esc(c.text)}</button>`;
  }).join('');
  return `<div class="hsk-page${source ? ' hsk-has-source' : ''}${translatedSource ? ' hsk-source-translated' : ''}"${layout.conversionId ? ` data-conversion-id="${esc(layout.conversionId)}"` : ''}${lang ? ` data-lang="${lang === 'original' ? 'orig' : 'ru'}"` : ''} data-pinyin="${pinyin ? 'on' : 'off'}" style="${style}">${bg}${deco}${html}${source}${phonetics}${phonetics ? '<output class="hsk-phonetic-status" aria-live="polite">Нажмите на инициаль, финаль или слог, чтобы прослушать произношение.</output>' : ''}</div>`;
}

// ---- Fit (browser only) ------------------------------------------------

// Translated text is longer than the original. Shrink each block (CSS zoom
// scales its cqw font sizes, not its percentage box) until it neither runs
// into the block below nor spills sideways; flag blocks that still overflow.
// Self-contained so it can be embedded into exported pages as-is.
// Native frontmatter keeps its Chinese source separate from translations.
// English and Kazakh reuse the Russian layer's geometry with data-en/data-kz.
// Self-contained: it is shipped to the platform as text.
export function setLang(page, lang) {
  const kz = lang === 'kz',en=lang==='en';
  page.querySelectorAll('[data-kz],[data-en]').forEach(el => { if (el.dataset.ru == null) el.dataset.ru = el.textContent; el.textContent = kz&&el.dataset.kz ? el.dataset.kz : en&&el.dataset.en ? el.dataset.en : el.dataset.ru; });
  page.dataset.lang = lang === 'orig' ? 'orig' : 'ru';
  page.dataset.kz = kz ? 'on' : 'off';
  page.dataset.en = en ? 'on' : 'off';
}

export function fit(page) {
  if (!page) return;
  for(const cap of page.querySelectorAll('.hsk-photo-caption')){if(cap.offsetParent===null)continue;const rows=[...cap.children].filter(e=>e.offsetParent!==null);for(const row of rows)row.style.zoom='';let z=1;while(rows.reduce((n,e)=>n+e.getBoundingClientRect().height,0)>cap.clientHeight-2&&z>.65){z*=.97;for(const row of rows)row.style.zoom=z;}}
  for(const el of page.querySelectorAll('.hsk-bilingual-translation')){if(el.offsetParent===null)continue;let size=parseFloat(getComputedStyle(el).fontSize);el.style.fontSize='';size=parseFloat(getComputedStyle(el).fontSize);while((el.scrollHeight>el.clientHeight+2||el.scrollWidth>el.clientWidth+2)&&size>page.clientWidth*.01){size*=.97;el.style.fontSize=size+'px';}}
  const prose=[...page.querySelectorAll('.hsk-foreword-prose .hsk-foreword-translation')].filter(e=>e.offsetParent!==null);
  let proseSize=page.clientWidth*.019;
  for(const el of prose){let size=proseSize;el.style.fontSize=size+'px';while(el.scrollHeight>el.parentElement.clientHeight+2&&size>page.clientWidth*.009){size*=.97;el.style.fontSize=size+'px';}proseSize=Math.min(proseSize,size);}
  for(const el of prose)el.style.fontSize=proseSize+'px';
  for(const el of page.querySelectorAll('.hsk-foreword-signature .hsk-foreword-translation,.hsk-foreword-banner .hsk-foreword-translation,.hsk-foreword-item .hsk-foreword-translation')){if(el.offsetParent===null)continue;let size=page.clientWidth*(el.parentElement.classList.contains('hsk-foreword-banner')?.022:.019);el.style.fontSize=size+'px';while((el.scrollHeight>el.parentElement.clientHeight+2||el.scrollWidth>el.parentElement.clientWidth+2)&&size>page.clientWidth*.009){size*=.97;el.style.fontSize=size+'px';}}
  // The zoom is also exposed as --z: word tables divide their measured
  // column positions by it, so text grows while the columns stay put.
  const setZ = (el, z) => { el.style.zoom = z || ''; if (z) el.style.setProperty('--z', z); else el.style.removeProperty('--z'); };
  // One measuring pass in the language shown now: returns the blocks and the zoom each got.
  const pass = () => {
  const MIN_ZOOM = 0.7, MAX_ZOOM = 1.25, GROW = page.dataset.grow !== 'off', room = new Map();
  const GROWABLE = '.hsk-para, .hsk-text, .hsk-tip, .hsk-card, .hsk-words, .hsk-objectives';
  // Graphics drawn over blocks (arrows, characters) are not neighbours.
  const all = [...page.querySelectorAll(':scope > .hsk-at:not(.hsk-background):not(.hsk-deco):not(.hsk-tip-avatar):not(.hsk-sec-avatar)')].filter(el => el.offsetParent !== null);
  // Measured Chinese-only parts keep their print size.
  // (The bonus panel is measured part by part, and its picture may stand out of it.)
  const blocks = all.filter(el => !el.matches('img, .hsk-photo, .hsk-folio, .hsk-dialogue-exact, .hsk-runhead, .hsk-bonus, [data-hsk-manual]'));
  blocks.forEach(el => { setZ(el, ''); el.removeAttribute('data-hsk-overflow'); });
  const pageRect = page.getBoundingClientRect();
  const rects = new Map(all.map(el => [el, el.getBoundingClientRect()]));
  // Outlines drawn around photos: text printed inside one must stay inside it.
  const frames = [...page.querySelectorAll(':scope > .hsk-frame')].map(f => f.getBoundingClientRect());
  const limitFor = (el, r) => {
    let limit = pageRect.bottom;
    for (const other of all) {
      if (other === el) continue;
      const o = rects.get(other);
      if (o.left < r.right - 2 && o.right > r.left + 2 && o.top >= r.top + 4 && o.top < limit) limit = o.top;
    }
    for (const f of frames) if (r.top >= f.top && r.left >= f.left - 2 && r.right <= f.right + 2 && f.bottom < limit) limit = f.bottom - pageRect.width * 0.006;
    return limit - 2;
  };
  for (const el of blocks) {
    // Fixed-height blocks may touch neighbours by design; only their own
    // content overflow matters. Text blocks must stop above the next block.
    const fixed = Boolean(el.style.height);
    const limit = fixed ? Infinity : limitFor(el, rects.get(el));
    let zoom = 1;
    // Content centred in a fixed-height panel (translation cards) spills
    // upwards as well, which scrollHeight does not see: compare where the
    // in-flow children actually are with the panel itself.
    const flow = fixed ? [...el.children].filter(c => getComputedStyle(c).position !== 'absolute') : [];
    const spills = r => flow.some(c => { const cr = c.getBoundingClientRect(); return cr.height && (cr.top < r.top - 1 || cr.bottom > r.bottom + 1); });
    const over = () => { const r = el.getBoundingClientRect(); return r.bottom > limit || r.right > pageRect.right + 1 || el.scrollWidth > el.clientWidth + 2 || (fixed && (el.scrollHeight > el.clientHeight + 2 || spills(r))); };
    while (over() && zoom > MIN_ZOOM) { zoom = Math.max(MIN_ZOOM, zoom - 0.03); setZ(el, zoom.toFixed(2)); }
    if (over()) el.dataset.hskOverflow = 'true';
    else if (zoom === 1 && GROW && el.matches(GROWABLE) && !el.matches('.hsk-verse')) { // verse keeps its printed size
      // Room to spare: how far the text could grow before it reaches the
      // next block (characters over panels count here) or spills out of
      // its panel. Applied below, evenly.
      const art = [...page.querySelectorAll(':scope > .hsk-tip-avatar, :scope > .hsk-sec-avatar')].map(a => a.getBoundingClientRect());
      const r0 = el.getBoundingClientRect();
      const artLimit = Math.min(limit, ...art.filter(o => o.left < r0.right - 2 && o.right > r0.left + 2 && o.top >= r0.top + 4).map(o => o.top - 2));
      // Panels with a printed height (a table with printed columns, a tip)
      // grow only while they keep that height: a cell or line that wraps
      // would make them taller than the page shows.
      const table = el.matches('.hsk-words-cols, .hsk-tip'), h0 = r0.height;
      // (Its rows keep their printed height whatever the zoom.)
      const wraps = () => table && el.getBoundingClientRect().height > h0 + 2;
      const air = pageRect.width * 0.01, tight = () => over() || el.getBoundingClientRect().bottom > artLimit - air || wraps();
      let can = 1;
      while (can < MAX_ZOOM) { setZ(el, (can + 0.03).toFixed(2)); if (tight()) break; can += 0.03; }
      setZ(el, '');
      room.set(el, can);
    }
    rects.set(el, el.getBoundingClientRect());
  }
  // Paragraphs share one size (the smallest room among them) so the page
  // stays even; panels (tips, cards, word tables) grow each on its own.
  // A set of answer options keeps one size: each takes the set's smallest zoom.
  const sets = blocks.filter(el => el.dataset.fitSet);
  for (const name of new Set(sets.map(el => el.dataset.fitSet))) {
    const group = sets.filter(el => el.dataset.fitSet === name), z = Math.min(...group.map(el => Number(el.style.zoom) || 1));
    if (z < 1) for (const el of group) setZ(el, z.toFixed(2));
  }
  const texts = [...room.keys()].filter(el => el.matches('.hsk-para, .hsk-text'));
  const shared = texts.length ? Math.min(...texts.map(el => room.get(el))) : 1;
  for (const [el, can] of room) { const z = texts.includes(el) ? shared : can; if (z > 1.01) setZ(el, z.toFixed(2)); }
  return { blocks, zooms: blocks.map(el => Number(el.style.zoom) || 1) };
  };
  // Text sizes must not jump when the language changes (Kazakh and Russian run
  // longer than English and would shrink their blocks). So each block gets ONE
  // zoom for all languages: the smallest that fits in every one of them.
  // Measured once per page width / pinyin state, then only re-applied.
  const shown = page.dataset.en === 'on' ? 'en' : page.dataset.kz === 'on' ? 'kz' : page.dataset.lang === 'orig' ? 'orig' : 'ru', hasKz = Boolean(page.querySelector('[data-kz]')),hasEn=Boolean(page.querySelector('[data-en]'));
  if (!page.dataset.lang || typeof setLang !== 'function' || page.dataset.fitUnify === 'off') { pass(); return; }
  const key = [page.clientWidth, page.dataset.pinyin, hasKz,hasEn].join('|');
  let cache = page.__hskZooms;
  if (!cache || cache.key !== key) {
    const runs = ['ru','orig',...(hasKz?['kz']:[]),...(hasEn?['en']:[])].map(l => { setLang(page, l); return pass(); });
    cache = page.__hskZooms = { key, blocks: runs[0].blocks, zooms: runs[0].zooms.map((_, i) => Math.min(...runs.map(r => r.zooms[i]))) };
  }
  setLang(page, shown);
  cache.blocks.forEach((el, i) => setZ(el, cache.zooms[i] === 1 ? '' : cache.zooms[i].toFixed(2)));
}

export function autoFit(page) {
  if (!page || page.__hskFit) return;
  page.__hskFit = true;
  const run = () => requestAnimationFrame(() => { page.__hskZooms = null; fit(page); });
  run();
  document.fonts?.ready.then(run);
  let width = page.clientWidth;
  new ResizeObserver(() => { if (Math.abs(page.clientWidth - width) > 1) { width = page.clientWidth; run(); } }).observe(page);
}

// Write an edited value back into the layout by its dotted path.
export function setField(layout, blockIndex, path, value) {
  const keys = path.split('.');
  let target = layout.blocks[blockIndex];
  for (const key of keys.slice(0, -1)) { if (target == null) return; target = target[key]; }
  if (target && typeof target === 'object') target[keys.at(-1)] = value;
}

// ---- Standalone page document -------------------------------------------

// Metric-compatible open fonts keep line breaks close to the print on any
// computer: Tinos ≈ Times New Roman, Arimo ≈ Arial, Noto Sans SC ≈ SimHei,
// Noto Serif SC (Song) in place of the print's KaiTi, chosen for on-screen
// legibility; same 1em advance, so measured sizes still hold.
export const FONT_LINKS = [
  'https://fonts.googleapis.com/css2?family=Arimo:ital,wght@0,400;0,700;1,400&family=Noto+Sans+SC:wght@400;700&family=Noto+Serif+SC:wght@500;700&family=Tinos:ital,wght@0,400;0,700;1,400;1,700&display=swap'
];

function bindImageSpeech(root) {
  if (!root || root.dataset.imageSpeechBound) return;
  root.dataset.imageSpeechBound = 'true';
  root.addEventListener('click', event => {
    const figure = event.target.closest('.hsk-photo[data-hsk-speak]');
    if (!figure || event.target.closest('.hsk-play,video')) return;
    const utterance = new SpeechSynthesisUtterance(figure.dataset.hskSpeak);
    utterance.lang = 'zh-CN';
    figure.classList.add('playing');
    utterance.onend = utterance.onerror = () => figure.classList.remove('playing');
    speechSynthesis.cancel(); speechSynthesis.speak(utterance);
  });
  root.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.hsk-photo[data-hsk-speak]')) { event.preventDefault(); event.target.click(); }
  });
}

export function pageDocument(layout, { title = 'Страница', css = 'components.css', assets = {}, prev = '', next = '' } = {}) {
  const nav = prev || next ? `<nav class="wb-nav">${prev ? `<a href="${esc(prev)}">← Назад</a>` : '<span></span>'}${next ? `<a href="${esc(next)}">Далее →</a>` : '<span></span>'}</nav>` : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${FONT_LINKS.map(href => `<link rel="stylesheet" href="${href}">`).join('\n')}
<link rel="stylesheet" href="${esc(css)}">
</head>
<body class="wb-body">
<div class="wb-controls" role="group" aria-label="Язык страницы">
  <button type="button" data-lang="orig">Оригинал</button><button type="button" data-lang="ru" aria-pressed="true">Русский</button>${layout.blocks.some(b=>b.en&&b.ru&&(b.characterRibbon||b.bilingualPrint||b.foreword||b.credits||b.imprint||b.titlePageRole))?'<button type="button" data-lang="en">English</button>':''}${Object.keys(layout.kz || {}).length ? '<button type="button" data-lang="kz">Қазақша</button>' : ''}<button type="button" data-pinyin aria-pressed="true">Пиньинь</button>
</div>
<main class="wb-sheet">
${render(layout, { assets, lang: 'russian' })}
</main>
${nav}
<script>
${fit.toString()}
${setLang.toString()}
${bindImageSpeech.toString()}
const page=document.querySelector('.hsk-page');
bindImageSpeech(page);
const refit=()=>requestAnimationFrame(()=>fit(page));
document.querySelectorAll('.wb-controls [data-lang]').forEach(b=>b.onclick=()=>{setLang(page,b.dataset.lang);document.querySelectorAll('.wb-controls [data-lang]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));refit()});
document.querySelector('[data-pinyin]').onclick=e=>{const on=page.dataset.pinyin!=='on';page.dataset.pinyin=on?'on':'off';e.currentTarget.setAttribute('aria-pressed',String(on));refit()};
refit();document.fonts&&document.fonts.ready.then(refit);addEventListener('resize',refit);
</script>
</body>
</html>`;
}
