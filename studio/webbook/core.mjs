// Forma "PDF → Web" core, shared by the studio console (browser) and the
// conversion server (Node).
//
// Pipeline idea: a vision model is good at *what* is on a textbook page
// (block types, exact text, translation) but places boxes several percent off.
// Local OCR line boxes and the scan's own pixels are exact, so the model's
// structure is snapped to them, and colours / font sizes are measured from the
// scan. The model never produces HTML; pages are drawn from fixed components
// (components.css) so every page of the book shares one design system.

export const NORM_VERSION = 2;
export const SNAP_VERSION = 2;
export const TYPES = ['runhead', 'lesson', 'objectives', 'section', 'para', 'tip', 'dialogue', 'image', 'card', 'words', 'folio', 'text', 'decor'];

export const PROMPT = `Ты размечаешь скан страницы китайского учебника HSK для пересборки в HTML из готовых компонентов.
Верни ТОЛЬКО JSON вида {"blocks":[...]} без пояснений.
Каждый блок: {"type":..., "box":{"x","y","w","h"}, ...поля типа}.
box — рамка блока в ДОЛЯХ страницы от 0 до 1: x,y — левый верхний угол, w,h — ширина и высота. Не проценты и не пиксели.
Пример: блок, который начинается на 12% ширины и 15% высоты страницы, шириной 72% и высотой 4%: {"x":0.12,"y":0.15,"w":0.72,"h":0.04}.
Точность рамок проверяется по скану отдельно; главное — правильно определить блоки и их текст.
Для каждого текста дай: cn (китайский дословно, без пиньиня), en (английский дословно), ru (точный русский перевод английского), py (пиньинь, если он напечатан).
Типы блоков:
- runhead: колонтитул вверху. cn, en, ru.
- lesson: крупная шапка урока. number, cn, en, ru, label (напр. "Lesson").
- objectives: блок целей. heading{cn,en,ru}, items[{cn,en,ru}].
- section: ярлык раздела, напр. "课文 2 | Text 2". cn, en, ru.
- para: абзац или задание. icon: "pin" | "square" | "none"; cn, en, ru; track (номер аудио, напр. "1-3", если есть).
- tip: плашка-подсказка. label{cn,en,ru}; cn, en, ru; avatar: box картинки персонажа над плашкой или null.
- dialogue: столбец реплик с аватарами слева и пузырями справа. box охватывает все реплики. turns[{speaker{cn,py,ru,avatar:"photo"|"group"|"none",avatarBox}, py, hz, highlight}] (speaker.ru — имя говорящего по-русски, напр. "Ван Ифэй"). hz — иероглифы реплики; highlight — символы, выделенные цветом (или ""). avatarBox — рамка круглого портрета, если avatar="photo".
- image: фотография или иллюстрация (будет вырезана из скана). alt по-русски.
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
const tri = obj => ({ cn: str(obj?.cn), en: str(obj?.en), ru: str(obj?.ru), py: str(obj?.py) });

export function normalize(parsed, scale = { sx: 1, sy: 1 }) {
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const blocks = [];
  for (const raw of list.slice(0, 60)) {
    const type = str(raw?.type), box = normBox(raw?.box, scale);
    if (!TYPES.includes(type) || !box) continue;
    const b = { type, box, ...tri(raw) };
    if (type === 'lesson') Object.assign(b, { number: str(raw.number), label: str(raw.label) || 'Lesson' });
    if (type === 'objectives') Object.assign(b, { heading: tri(raw.heading), items: (raw.items || []).slice(0, 8).map(tri) });
    if (type === 'para') Object.assign(b, { icon: ['pin', 'square'].includes(raw.icon) ? raw.icon : 'none', track: str(raw.track) });
    if (type === 'tip') Object.assign(b, { label: tri(raw.label), avatar: normBox(raw.avatar, scale) });
    if (type === 'dialogue') b.turns = (raw.turns || []).slice(0, 12).map(t => ({
      speaker: { cn: str(t?.speaker?.cn), py: str(t?.speaker?.py), ru: str(t?.speaker?.ru), avatar: ['photo', 'group'].includes(t?.speaker?.avatar) ? t.speaker.avatar : 'none', avatarBox: normBox(t?.speaker?.avatarBox, scale) },
      py: str(t?.py), hz: str(t?.hz), highlight: str(t?.highlight)
    })).filter(t => t.hz);
    if (type === 'image' || type === 'decor') b.alt = str(raw.alt);
    if (type === 'card') b.lines = (raw.lines || []).slice(0, 12).map(l => ({ en: str(l?.en), ru: str(l?.ru) }));
    if (type === 'words') Object.assign(b, { heading: tri(raw.heading), track: str(raw.track), rows: (raw.rows || []).slice(0, 24).map(r => r?.group ? { group: tri(r.group) } : ({ i: str(r?.i), hz: str(r?.hz), py: str(r?.py), pos_en: str(r?.pos_en), pos_ru: str(r?.pos_ru), en: str(r?.en), ru: str(r?.ru) })) });
    if (type === 'folio') b.text = str(raw.text);
    if (type === 'text') b.size = ['s', 'm', 'l'].includes(raw.size) ? raw.size : 'm';
    blocks.push(b);
  }
  return blocks;
}

// Build a layout from raw model output; the raw output is kept so later fixes
// to normalisation or snapping never need a new paid request.
export function fromModel(parsed, width, height) {
  const scale = detectScale(parsed, width, height);
  return { version: 1, normVersion: NORM_VERSION, unit: scale.unit, page: { width, height }, blocks: normalize(parsed, scale), source: parsed };
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
  for (const [sx, sy] of seeds) if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && ok(grid.at(sx, sy))) stack.push(sx, sy);
  let count = 0;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop(), k = y * W + x;
    if (seen[k]) continue; seen[k] = 1;
    if (!ok(grid.at(x, y))) continue;
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

// Panel fill = dominant non-background colour on a thin ring around the text.
function fillColor(grid, box) {
  const samples = [], pad = 3;
  const x0 = Math.max(0, Math.floor(box.x * grid.W) - pad), x1 = Math.min(grid.W - 1, Math.ceil((box.x + box.w) * grid.W) + pad);
  const y0 = Math.max(0, Math.floor(box.y * grid.H) - pad), y1 = Math.min(grid.H - 1, Math.ceil((box.y + box.h) * grid.H) + pad);
  let total = 0;
  const take = (x, y) => { total++; const p = grid.at(x, y); if (dist(p, grid.bg) >= 24) samples.push(p); };
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
  return best / line.length;
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
function assignLines(blocks, ocrLines) {
  const texts = blocks.map(blockStrings), hits = blocks.map(() => []);
  for (const line of ocrLines) {
    const t = plain(line.text);
    if (t.length < 2) continue;
    const c = { x: line.box.x + line.box.w / 2, y: line.box.y + line.box.h / 2 };
    let best = null;
    blocks.forEach((b, n) => {
      if (b.type === 'image') return;
      const score = matchScore(t, texts[n]), g = grow(b.box, 0.15, 0.1);
      if (score < 0.6 || c.x < g.x || c.x > g.x + g.w || c.y < g.y || c.y > g.y + g.h) return;
      const rank = score - centerDist(line.box, b.box) * 1.5;
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
  return (ocr?.lines || []).map(l => ({ text: String(l.text || ''), box: { x: +l.position.x, y: +l.position.y, w: +(l.position.width ?? l.position.w), h: +(l.position.height ?? l.position.h) } }))
    .filter(l => l.text && [l.box.x, l.box.y, l.box.w, l.box.h].every(Number.isFinite));
}

// Keep printed lines separate from model translations. Coordinates are relative
// to the owning block so manual block moves still move its source text.
export function measureOriginal(layout, grid, ocr) {
  const lines = ocrLinesOf(ocr), hits = assignLines(layout.blocks, lines);
  const ratio = layout.page.height / layout.page.width;
  const reconcile = (own, b) => {
    // Align printed characters to source fields, rejecting large differences
    // such as an invented translation following a Chinese-only exercise.
    if (!['para','card','runhead','text'].includes(b.type)) return null;
    const source = [b.cn,b.en,b.text,...(b.lines||[]).map(l=>l.en)].filter(Boolean).join(' ');
    const chars=Array.from(source), map=[], keys=[];
    chars.forEach((ch,i)=>{for(const k of plain(ch)){keys.push(k);map.push(i)}});
    const a=own.map(l=>plain(l.text)).join(''), z=keys.join('');
    if(!a.length||!z.length||Math.max(a.length,z.length)>3000)return null;
    const rows=Array.from({length:a.length+1},()=>new Uint16Array(z.length+1));
    for(let i=0;i<=a.length;i++)rows[i][0]=i;
    for(let j=0;j<=z.length;j++)rows[0][j]=j;
    for(let i=1;i<=a.length;i++)for(let j=1;j<=z.length;j++)rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+(a[i-1]===z[j-1]?0:1));
    if(rows[a.length][z.length]/Math.max(a.length,z.length)>0.18)return null;
    const mapping=new Array(a.length);let i=a.length,j=z.length;
    while(i||j){if(i&&j&&rows[i][j]===rows[i-1][j-1]+(a[i-1]===z[j-1]?0:1)){mapping[--i]=--j}else if(i&&rows[i][j]===rows[i-1][j]+1)i--;else j--}
    let offset=0;
    return own.map(l=>{const count=plain(l.text).length,indices=mapping.slice(offset,offset+count).filter(Number.isFinite);offset+=count;if(!indices.length)return null;let start=map[indices[0]],end=map[indices.at(-1)]+1;while(start>0&&/[（(“【]/u.test(chars[start-1]))start--;while(end<chars.length&&/[。，！？.!?）)；:：]/u.test(chars[end]))end++;return {text:chars.slice(start,end).join(''),verified:plain(l.text)===plain(chars.slice(start,end).join(''))}});
  };
  const recover = (line, b) => {
    const candidates = [b.cn, b.en, b.text, [b.cn, b.en].filter(Boolean).join(' '), b.heading?.cn, b.heading?.en, ...(b.lines || []).map(l => l.en), ...(b.rows || []).flatMap(r => [r.hz, r.py, r.en, r.pos_en])];
    const needle = plain(line.text);
    for (const candidate of candidates.filter(Boolean)) {
      const chars = Array.from(candidate), map = [], keys = [];
      chars.forEach((ch, i) => { for (const k of plain(ch)) { keys.push(k); map.push(i); } });
      const at = keys.join('').indexOf(needle);
      if (needle.length >= 3 && at >= 0) {
        let start = map[at];
        while (start > 0 && /[（(“【]/u.test(chars[start-1])) start--;
        let end = map[at + needle.length - 1] + 1;
        while (end < chars.length && /[。，！？.!?）)；:：]/u.test(chars[end])) end++;
        return { text: chars.slice(start, end).join(''), verified: true };
      }
    }
    return { text: line.text, verified: false };
  };
  const blocks = layout.blocks.map((b, n) => {
    const next = structuredClone(b);
    if (['para', 'text', 'card', 'runhead'].includes(b.type)) {
      const own = hits[n].filter(l => {
        const cx = l.box.x+l.box.w/2, cy = l.box.y+l.box.h/2;
        const pad = b.type === 'words' ? 0.04 : 0.009;
        return cx > b.box.x-0.025 && cx < b.box.x+b.box.w+0.025 && cy > b.box.y-pad && cy < b.box.y+b.box.h+pad;
      });
      own.sort((a,c)=>a.box.y-c.box.y||a.box.x-c.box.x);
      const reconciled = reconcile(own,b);
      next.sourceLines = own.map((line, k) => {
        const recovered = reconciled?.[k] || recover(line, b), chinese = (line.text.match(/[\u3400-\u9fff]/gu)||[]).length > (line.text.match(/[a-z]/gi)||[]).length;
        const pinyin = !chinese && (b.rows || []).some(r => r.py && plain(r.py) === plain(line.text));
        return { ...recovered, pinyin, box: { x: (line.box.x - b.box.x) / b.box.w, y: (line.box.y - b.box.y) / b.box.h, w: line.box.w / b.box.w, h: line.box.h / b.box.h }, fontSize: line.box.h * ratio * 100 * (chinese ? 1.08 : 1.22), family: chinese ? 'hei' : pinyin ? 'sans' : 'serif' };
      });
      if (b.type === 'para' && b.icon === 'square') {
        const marker = lines.find(l => /^\d{1,2}$/.test(l.text) && l.box.x >= b.box.x - 0.02 && l.box.x < b.box.x + 0.045 && Math.abs(l.box.y - b.box.y) < 0.018);
        if (marker) next.sourceMarker = { text: marker.text, box: { x: marker.box.x - 0.005, y: marker.box.y - 0.003, w: marker.box.w + 0.01, h: marker.box.h + 0.006 } };
      }
    }
    if (b.type === 'words') delete next.sourceLines;
    if (b.type === 'dialogue') {
      const used = new Set();
      next.turns = b.turns.map((t, k) => {
        const expected = b.box.y + b.box.h * k / b.turns.length;
        const take = (text, near, threshold = 0.65) => {
          const matches = lines.filter(l => !used.has(l) && overlapShare(grow(b.box, 0.015, 0.015), l.box) > 0.5 && matchScore(plain(l.text), plain(text)) >= threshold);
          matches.sort((a, c) => Math.abs(a.box.y - near) - Math.abs(c.box.y - near));
          if (matches[0]) used.add(matches[0]);
          return matches[0];
        };
        const hz = take(t.hz, expected + 0.025), name = take(t.speaker.cn, (hz?.box.y ?? expected) + 0.035, 0.9);
        if (!hz) return t;
        const py = lines.filter(l => /[a-z]/i.test(l.text) && !/[\u3400-\u9fff]/u.test(l.text) && l.box.x > hz.box.x - 0.015 && l.box.x < hz.box.x + hz.box.w && l.box.y < hz.box.y && l.box.y > hz.box.y - 0.035);
        const content = union([hz.box, ...py.map(l => l.box)]);
        const x0 = Math.max(b.box.x + 0.065, content.x - 0.018), x1 = b.box.x + b.box.w;
        // Find the long horizontal border above/below this particular utterance.
        const borders = [];
        for (let y = Math.max(0, Math.floor((content.y - 0.023) * grid.H)); y < Math.min(grid.H, (content.y + content.h + 0.025) * grid.H); y++) {
          let start=-1,last=-1,bestStart=-1,bestEnd=-1;
          for (let x = Math.floor(x0 * grid.W); x < Math.min(grid.W, x1 * grid.W); x++) {
            const p = (grid.raw || grid).at(x, y), ink=p[0]>140&&p[0]>p[1]+8&&p[0]>p[2]+5&&p[1]<245;
            if(ink){if(start<0||x-last>3)start=x;last=x;if(last-start>bestEnd-bestStart){bestStart=start;bestEnd=last}}
          }
          if(bestEnd-bestStart>(x1-x0)*grid.W*0.55)borders.push({y:y/grid.H,left:bestStart/grid.W,right:(bestEnd+1)/grid.W});
        }
        const tops = borders.filter(r => r.y < content.y).sort((a,c)=>c.y-a.y), bottoms = borders.filter(r => r.y > content.y + content.h).sort((a,c)=>a.y-c.y);
        const top = tops[0]?.y ?? content.y - 0.008, bottom = bottoms[0]?.y ?? content.y + content.h + 0.008;
        const edges=[tops[0],bottoms[0]].filter(r=>r&&r.right-r.left>=hz.box.w+0.012), left=edges.length?Math.min(...edges.map(r=>r.left)):x0, right=edges.length?Math.max(...edges.map(r=>r.right)):x1;
        const bubble = clampBox({ x:left, y:top, w:right-left, h:bottom-top });
        const oldAvatar=t.speaker.avatarBox;
        const avatarBox=name&&oldAvatar?{...oldAvatar,x:name.box.x+name.box.w/2-oldAvatar.w/2,y:name.box.y-0.012-oldAvatar.h}:oldAvatar;
        return { ...t, speaker:{...t.speaker,avatarBox}, geometry: { bubble, borderMeasured:edges.length>0, hz: hz.box, name: name?.box || null, pinyin: py.map(l => l.box) } };
      });
      const measured=next.turns.filter(t=>t.geometry?.borderMeasured).map(t=>t.geometry.bubble);
      if(measured.length>=2){const widths=measured.map(r=>r.w).sort((a,c)=>a-c),lefts=measured.map(r=>r.x).sort((a,c)=>a-c);for(const t of next.turns)if(t.geometry&&!t.geometry.borderMeasured){t.geometry.bubble.x=lefts[lefts.length>>1];t.geometry.bubble.w=widths[widths.length>>1]}}
    }
    return next;
  });
  return { ...layout, blocks, sourceVersion: 1, sourceMeasuredAt: new Date().toISOString() };
}

// Re-measure every block against the scan. Returns a new layout with exact
// boxes, per-block fill colours and font scales, and the page theme.
export function snap(layout, grid, ocr) {
  const lines = ocrLinesOf(ocr), hits = assignLines(layout.blocks, lines);
  const ratio = (layout.page?.width || 1) / (layout.page?.height || 1);
  const blocks = layout.blocks.map((b, n) => {
    const own = hits[n], next = { ...b };
    delete next.fill; delete next.k;
    const text = own.length ? union(own.map(l => l.box)) : null;
    if (b.type === 'decor') {
      // Graphics are cut out with everything else made transparent (see the
      // server), so a generous box only guards against clipping the ends of
      // an arrow the model measured short.
      next.box = grow(b.box, 0.015, 0.015);
    } else if (b.type === 'image') {
      const seeds = seedsIn(grid, grow(b.box, -b.box.w * 0.3, -b.box.h * 0.3), 4);
      const found = flood(grid, seeds, grow(b.box, 0.06, 0.05), p => dist(p, grid.bg) > 30);
      if (found && found.w > b.box.w * 0.5 && found.h > b.box.h * 0.5) next.box = found;
    } else if (PANEL_TYPES.has(b.type) && text) {
      const fill = fillColor(grid, text);
      const win = union([grow(text, Math.max(0.09, text.w * 0.5), Math.max(0.05, text.h * 0.5)), b.box]);
      let found = fill && dist(fill, grid.bg) > 18 ? flood(grid, seedsIn(grid, grow(text, 0.004, 0.003)), win, p => dist(p, fill) < 38) : null;
      // A fill that leaked into the page (a light panel on a light background)
      // grows far beyond its text; real panels are at most a few times larger.
      // Colour alone is not proof: white glyphs fill the inside of a red tab.
      if (found) {
        const grown = (found.w * found.h) / Math.max(1e-6, text.w * text.h), inner = interiorColor(grid, found);
        if (grown > 12 || (grown > 4 && inner && dist(inner, grid.bg) < 24)) found = null;
      }
      // Tabs and pills stick out of their panel, as do loose OCR boxes; the
      // section tag ("Text 1") sits beside its tab, so that one keeps both.
      next.box = !found ? grow(text, 0.01, 0.006) : b.type !== 'section' && overlapShare(found, text) >= 0.8 ? found : union([found, text]);
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
      }
    } else if (text) {
      next.box = grow(text, 0.003, 0.003);
      if (b.type === 'para' && b.icon === 'square') { next.box.x -= 0.025; next.box.w += 0.025; }
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
      const names = b.turns.map(t => own.filter(l => plain(l.text) === plain(t.speaker.cn)).sort((p, q) => p.box.y - q.box.y)[0]?.box);
      const avatarH = 0.056 * ratio;
      next.turns = b.turns.map((t, k) => {
        const name = names[k];
        if (!name || t.speaker.avatar !== 'photo') return t;
        const cx = name.x + name.w / 2, bottom = name.y - 0.012;
        return { ...t, speaker: { ...t.speaker, avatarBox: clampBox({ x: cx - 0.028, y: bottom - avatarH, w: 0.056, h: avatarH }) } };
      });
      const firstTop = Math.min(text.y, ...next.turns.map(t => t.speaker.avatarBox?.y ?? 1));
      const left = Math.min(text.x, b.box.x);
      next.box = { x: left, y: firstTop, w: right - left, h: text.y + text.h - firstTop };
    }
    // Font scale from the measured line height (OCR box ≈ 1.37 × font size).
    if (BASE_FONT[b.type] && own.length) {
      const heights = own.map(l => l.box.h).sort((p, q) => p - q), median = heights[heights.length >> 1];
      const size = median / ratio * 100 * 0.73;
      next.k = +Math.max(0.75, Math.min(1.35, size / (b.type === 'text' && b.size === 's' ? 1.45 : b.type === 'text' && b.size === 'l' ? 2.6 : BASE_FONT[b.type]))).toFixed(3);
    }
    next.box = clampBox(next.box);
    return next;
  });
  const theme = extractTheme(grid.raw || grid);
  const accent = blocks.find(b => ['section', 'lesson', 'folio'].includes(b.type) && b.fill && b.fill !== '#ffffff')?.fill;
  if (accent) theme.accent = accent;
  return measureOriginal({ ...layout, blocks, theme, snapVersion: SNAP_VERSION, ocrLines: lines.length }, grid, ocr);
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
    for (const t of b.turns || []) cover(t.speaker?.avatarBox, 0.02);
    if ((b.type === 'para' && b.icon !== 'none') || b.type === 'runhead') cover({ x: b.box.x - 0.05, y: b.box.y, w: 0.05, h: b.box.h }, 0.01);
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
    if (b.type === 'section' && b.mascotBox) {
      // Printed section artwork is never a cast portrait.
      return;
    }
    if (b.type === 'tip') {
      // A tip can have its own printed mascot illustration. Keep that exact
      // scan crop; the studio cast portraits belong to dialogue speakers and
      // must not replace the artwork in the hint panel.
      return;
    }
    if (b.type !== 'dialogue') return;
    b.turns.forEach((t, k) => {
      const c = castFor(t.speaker, cast);
      if (c?.file) {
        assets[`ava-${n}-${k}`] = urlOf(c);
        t.speaker.avatar = 'photo';
      } else if (t.speaker.avatar === 'photo') {
        // Do not silently retain a scanned person when this speaker has no
        // approved reference yet; use the neutral group mark until assigned.
        t.speaker.avatar = 'group';
      }
    });
  });
  return { layout: copy, assets };
}

// ---- Assets --------------------------------------------------------------

// Regions cut out of the scan as images: photos, tip character, avatars.
export function assetBoxes(layout) {
  const out = [];
  layout.blocks.forEach((b, n) => {
    if (b.type === 'image') out.push({ key: `img-${n}`, box: b.box });
    if (b.type === 'section' && b.mascotBox) out.push({ key: `mascot-${n}`, box: b.mascotBox });
    if (b.type === 'tip' && b.avatar) out.push({ key: `tip-${n}`, box: b.avatar });
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
const TRACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3Zm12-1c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/></svg>';
const PIN_ICON = '<svg class="hsk-pin" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 29S2 17.5 2 10.5a10 10 0 0 1 20 0C22 17.5 12 29 12 29Z"/><circle cx="12" cy="10.5" r="3.6" fill="#fff"/></svg>';

// Prefer the page's scene illustration as the clip target. Character portraits
// can precede it in reading order, so skip those when another image exists.
function mainIllustrationIndex(layout) {
  const images = layout.blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'image');
  if (!images.length) return -1;
  const isPortrait = alt => /(?:портрет|фотограф|аватар|лицо|portrait|avatar|headshot|персонаж\s+\S+\s*$)/i.test(String(alt || ''));
  const scenes = images.filter(({ b }) => !isPortrait(b.alt));
  const candidates = scenes.length ? scenes : images;
  return candidates.reduce((best, item) => item.b.box.w * item.b.box.h > best.b.box.w * best.b.box.h ? item : best).i;
}

// layout → HTML of one page. `assets` maps asset keys to URLs; `editable`
// makes texts contenteditable for the studio console.
export function render(layout, { assets = {}, pinyin = false, lang = '', editable = false, videoButton = '' } = {}) {
  const ratio = (layout.page?.height || 1595) / (layout.page?.width || 1171);
  const pct = v => (v * 100).toFixed(3) + '%';
  const vars = b => (b.k ? `--k:${b.k};` : '') + (b.fill ? `--fill:${b.fill};` : '') + (b.split ? `--split:${b.split};` : '') + (b.tabH ? `--tab-h:${b.tabH};` : '');
  const pos = (b, extra = '') => `left:${pct(b.box.x)};top:${pct(b.box.y)};width:${pct(b.box.w)};${vars(b)}${extra}`;
  const ed = (n, path, value, cls = '') => `<span class="${cls}"${editable ? ` contenteditable="true" data-hsk-block="${n}" data-hsk-path="${esc(path)}"` : ''}>${esc(value)}</span>`;
  const runheadTitle = (n, field, value, cls, largeNumber = false) => {
    const match = largeNumber && /^(.*?)(\s+)(\d+)$/.exec(String(value || ''));
    if (!match) return ed(n, field, value, cls);
    const editableAttr = editable ? ` contenteditable="true" data-hsk-block="${n}" data-hsk-path="${esc(field)}"` : '';
    return `<span class="${cls} hsk-runhead-line"${editableAttr}>${esc(match[1])} <strong class="hsk-runhead-number">${esc(match[3])}</strong></span>`;
  };
  const trio = (n, prefix, o) => {
    const seen = new Set();
    return ['cn', 'en', 'ru'].map(key => {
      const value = o?.[key];
      if (!value || seen.has(value)) return '';
      seen.add(value);
      return ed(n, prefix + key, value, key);
    }).join('');
  };
  const track = t => t ? `<span class="hsk-track">${TRACK_ICON} ${esc(t)}</span>` : '';
  const highlight = (hz, mark) => mark ? esc(hz).split(esc(mark)).join(`<em>${esc(mark)}</em>`) : esc(hz);
  const tag = (n, b) => `data-block="${n}"${b.sourceLines?.length ? ' data-source-lines="true"' : ''} data-hsk-bottom="${(b.box.y + b.box.h).toFixed(4)}"`;
  const clipImage = mainIllustrationIndex(layout);

  const html = layout.blocks.map((b, n) => {
    const at = tag(n, b), h = `height:${pct(b.box.h)};`, minH = `min-height:${pct(b.box.h)};`;
    switch (b.type) {
      case 'runhead':
        if (b.box.x > 0.5) return `<header ${at} class="hsk-at hsk-runhead hsk-runhead-right" style="${pos(b)}"><b>${ed(n, 'cn', b.cn)}</b><span class="hsk-runhead-segment">${b.en ? runheadTitle(n, 'en', b.en, 'en', true) : ''}${b.ru ? runheadTitle(n, 'ru', b.ru, 'ru', true) : ''}</span></header>`;
        return `<header ${at} class="hsk-at hsk-runhead" style="${pos(b)}"><b>${ed(n, 'cn', b.cn)}</b><span>${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</span></header>`;
      case 'lesson':
        return `<header ${at} class="hsk-at hsk-lesson" style="${pos(b, h)}"><div class="hsk-lesson-no">${esc(b.number)}</div><div class="hsk-lesson-title"><small>${esc(b.label)}</small>${ed(n, 'cn', b.cn, 'cn')}${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</div></header>`;
      case 'objectives':
        return `<section ${at} class="hsk-at hsk-objectives" style="${pos(b, minH)}"><h3>${trio(n, 'heading.', b.heading)}</h3>${(b.items || []).map((it, k) => `<div class="hsk-objective"><span class="hsk-check"></span><span>${trio(n, `items.${k}.`, it)}</span></div>`).join('')}</section>`;
      case 'section':
        return (b.mascotBox && assets[`mascot-${n}`] ? `<img class="hsk-at hsk-section-avatar" style="left:${pct(b.mascotBox.x)};top:${pct(b.mascotBox.y)};width:${pct(b.mascotBox.w)};height:${pct(b.mascotBox.h)}" src="${esc(assets[`mascot-${n}`])}" alt="">` : '') +
          `<h2 ${at} class="hsk-at hsk-section" style="${pos(b, h)}">${ed(n, 'cn', b.cn, 'cn')}<span class="tag">${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</span></h2>`;
      case 'para':
        return `<p ${at} class="hsk-at hsk-para${b.box.x < 0.2 && b.box.y < 0.25 ? ' hsk-para-top' : ''}${b.stackTranslation ? ' hsk-stack-translation' : ''}" style="${pos(b)}">${b.icon === 'pin' ? PIN_ICON + '<span></span>' : b.icon === 'square' ? `<span class="hsk-square">${esc(b.sourceMarker?.text || '')}</span>` : '<span></span>'}<span>${trio(n, '', b)}${track(b.track)}</span></p>`;
      case 'tip':
        return (b.avatar && assets[`tip-${n}`] ? `<img class="hsk-at hsk-tip-avatar" style="left:${pct(b.avatar.x)};top:${pct(b.avatar.y)};width:${pct(b.avatar.w)};z-index:5" src="${esc(assets[`tip-${n}`])}" alt="">` : '') +
          `<aside ${at} class="hsk-at hsk-tip" style="${pos(b, minH)}"><div class="hsk-tip-label">${b.label?.cn ? ed(n, 'label.cn', b.label.cn) : ''}${b.label?.en ? `<small class="en">${ed(n, 'label.en', b.label.en)}</small>` : ''}${b.label?.ru ? `<small class="ru">${ed(n, 'label.ru', b.label.ru)}</small>` : ''}</div><div>${trio(n, '', b)}</div></aside>`;
      case 'dialogue': {
        const pitch = b.turns.length ? (b.box.h * ratio * 100) / b.turns.length : 10;
        const bubble = Math.min(6.7, pitch * 0.62);
        const measured = b.turns.every(t => t.geometry?.bubble);
        return `<section ${at} class="hsk-at hsk-dialogue${measured ? ' hsk-dialogue-measured' : ''}" style="${pos(b, measured ? h : `grid-auto-rows:${pitch.toFixed(3)}cqw;--bubble-h:${bubble.toFixed(3)}cqw;`)}">` + b.turns.map((t, k) => {
          const src = assets[`ava-${n}-${k}`];
          const face = t.speaker.avatar === 'photo' && src ? `<img src="${esc(src)}" alt="">` : t.speaker.avatar !== 'none' ? GROUP_ICON : '';
          const local = box => `left:${pct((box.x-b.box.x)/b.box.w)};top:${pct((box.y-b.box.y)/b.box.h)};width:${pct(box.w/b.box.w)};height:${pct(box.h/b.box.h)};`;
          const geo = measured && t.geometry;
          const avatar = t.speaker.avatarBox || (geo?.name ? {x:geo.name.x+geo.name.w/2-0.028,y:geo.bubble.y,w:0.056,h:0.056/ratio} : null);
          const speaker = geo && avatar ? { x: avatar.x - 0.008, y: avatar.y, w: avatar.w + 0.016, h: (geo.name ? geo.name.y + geo.name.h : avatar.y + avatar.h + 0.04) - avatar.y } : null;
          const linePos = box => `position:absolute;left:${pct((box.x-geo.bubble.x)/geo.bubble.w)};top:${pct((box.y-geo.bubble.y)/geo.bubble.h)};width:${pct(box.w/geo.bubble.w)};height:${pct(box.h/geo.bubble.h)};`;
          const hz = geo ? `<span class="hz hsk-measured-text" style="${linePos(geo.hz)}font-size:${geo.hz.h*ratio*100*1.08}cqw"><span>${highlight(t.hz,t.highlight)}</span></span>` : `<span class="hz">${highlight(t.hz,t.highlight)}</span>`;
          const pyBox = geo?.pinyin?.length ? union(geo.pinyin) : null;
          const py = t.py ? `<span class="py${pyBox ? ' hsk-measured-text' : ''}"${pyBox ? ` style="${linePos(pyBox)}font-size:${pyBox.h*ratio*100*1.22}cqw"` : ''}><span>${esc(t.py)}</span></span>` : '';
          const nameStyle=geo?.name&&speaker?`position:absolute;left:${pct((geo.name.x-speaker.x)/speaker.w)};top:${pct((geo.name.y-speaker.y)/speaker.h)};width:${pct(geo.name.w/speaker.w)};margin:0;white-space:nowrap;font-size:${geo.name.h*ratio*100*1.08}cqw`:'';
          return `<div class="hsk-turn">` + `<figure class="hsk-speaker"${speaker ? ` style="${local(speaker)}"` : ''}>${face}${t.speaker.py ? `<span class="py">${esc(t.speaker.py)}</span>` : ''}<b${nameStyle?` style="${nameStyle}"`:''}>${ed(n, `turns.${k}.speaker.cn`, t.speaker.cn)}</b></figure><div class="hsk-bubble"${geo ? ` style="${local(geo.bubble)}"` : ''}>${py}${hz}</div></div>`;
        }).join('') + '</section>';
      }
      case 'image': {
        // Keep the illustration until a clip is saved; then replace only the
        // page's main story image and leave character portraits untouched.
        const clip = n === clipImage && assets.clip;
        const media = clip
          ? `<video controls playsinline preload="metadata" poster="${esc(assets.clipPoster || assets[`img-${n}`] || '')}" aria-label="${esc(b.alt || 'Видео страницы')}"><source src="${esc(assets.clip)}"${assets.clipType ? ` type="${esc(assets.clipType)}"` : ''}></video>${assets[`img-${n}`] ? `<img class="hsk-original-photo" src="${esc(assets[`img-${n}`])}" alt="${esc(b.alt)}">` : ''}`
          : assets[`img-${n}`] ? `<img src="${esc(assets[`img-${n}`])}" alt="${esc(b.alt)}">` : '';
        return `<figure ${at} class="hsk-at hsk-photo${clip ? ' hsk-clip' : ''}" style="${pos(b, h)}">${media}${n === clipImage && !clip ? videoButton : ''}</figure>`;
      }
      case 'card':
        return `<section ${at} class="hsk-at hsk-card" style="${pos(b, h)}"><div class="en">${(b.lines || []).map((l, k) => `<p>${ed(n, `lines.${k}.en`, l.en)}</p>`).join('')}</div><div class="ru">${(b.lines || []).map((l, k) => `<p>${ed(n, `lines.${k}.ru`, l.ru)}</p>`).join('')}</div></section>`;
      case 'words':
        return `<section ${at} class="hsk-at hsk-words" style="${pos(b, minH)}"><h3 class="hsk-words-tab">${trio(n, 'heading.', b.heading)}${track(b.track)}</h3>` + (b.rows || []).map((r, k) => r.group ? `<h4 class="hsk-words-group">${trio(n, `rows.${k}.group.`, r.group)}</h4>` :
          `<div class="hsk-word"><span class="i">${esc(r.i)}</span>${ed(n, `rows.${k}.hz`, r.hz, 'hz')}<span class="py">${esc(r.py)}</span><span class="pos">${ed(n, `rows.${k}.pos_en`, r.pos_en, 'en')}${ed(n, `rows.${k}.pos_ru`, r.pos_ru, 'ru')}</span>${ed(n, `rows.${k}.en`, r.en, 'en')}${ed(n, `rows.${k}.ru`, r.ru, 'ru')}</div>`).join('') + '</section>';
      case 'decor':
        return ''; // drawn in the graphics layer under the blocks
      case 'folio':
        return `<span ${at} class="hsk-at hsk-folio${b.box.x > 0.5 ? ' hsk-folio-right' : ''}" style="${pos(b, h)}">${esc(b.text)}</span>`;
      default: {
        const values = [b.cn, b.en, b.ru].filter(Boolean);
        const number = b.size === 'l' && values.length > 0 && values.every(value => value === values[0]) && /^\d+$/.test(values[0]);
        return `<p ${at} class="hsk-at hsk-text hsk-text-${b.size || 'm'}${number ? ' hsk-text-number' : ''}" style="${pos(b)}">${trio(n, '', b)}</p>`;
      }
    }
  }).join('');

  const theme = layout.theme || {};
  const style = `aspect-ratio:${layout.page?.width || 1171}/${layout.page?.height || 1595};background:${theme.paper || '#fff'};${theme.accent ? `--red:${theme.accent};` : ''}`;
  const bg = theme.background ? `<div class="hsk-at hsk-background" style="left:${pct(theme.background.box.x)};top:${pct(theme.background.box.y)};width:${pct(theme.background.box.w)};height:${pct(theme.background.box.h)};background:${theme.background.color}"></div>` : '';
  // Graphics layer; components.css lifts it above the blocks.
  const cut = (key, box, n) => assets[key] ? `<img class="hsk-at hsk-deco"${n != null ? ` data-block="${n}"` : ''} alt="" aria-hidden="true" src="${esc(assets[key])}" style="left:${pct(box.x)};top:${pct(box.y)};width:${pct(box.w)};height:${pct(box.h)}">` : '';
  const deco = layout.blocks.map((b, n) => b.type === 'decor' ? cut(`deco-b${n}`, b.box, n) : '').join('')
    + (layout.decorations || []).map((d, i) => cut(`deco-${i}`, d.box)).join('');
  const printed = layout.blocks.map((b, n) => {
    const marker = b.sourceMarker ? `<span class="hsk-at hsk-source-marker" style="left:${pct(b.sourceMarker.box.x)};top:${pct(b.sourceMarker.box.y)};width:${pct(b.sourceMarker.box.w)};height:${pct(b.sourceMarker.box.h)}">${esc(b.sourceMarker.text)}</span>` : '';
    return marker + (b.sourceLines || []).map((l, k) => {
      const box = { x: b.box.x + l.box.x*b.box.w, y: b.box.y + l.box.y*b.box.h, w: l.box.w*b.box.w, h: l.box.h*b.box.h };
      return `<div class="hsk-at hsk-source-line${l.pinyin ? ' hsk-source-pinyin' : ''}" data-block="${n}" data-source-verified="${l.verified}" style="left:${pct(box.x)};top:${pct(box.y)};width:${pct(box.w)};height:${pct(box.h)};${b.type==='runhead' ? 'color:var(--red);' : ''}font-weight:400;font-size:${l.fontSize}cqw;line-height:1;font-family:var(--${l.family});"><span${editable ? ` contenteditable="true" data-hsk-block="${n}" data-hsk-path="sourceLines.${k}.text"` : ''}>${esc(l.text)}</span></div>`;
    }).join('');
  }).join('');
  return `<div class="hsk-page"${lang ? ` data-lang="${lang === 'original' ? 'orig' : 'ru'}"` : ''} data-pinyin="${pinyin ? 'on' : 'off'}" style="${style}">${bg}${deco}${html}${printed}</div>`;
}

// ---- Fit (browser only) ------------------------------------------------

// Translated text is longer than the original. Shrink each block (CSS zoom
// scales its cqw font sizes, not its percentage box) until it neither runs
// into the block below nor spills sideways; flag blocks that still overflow.
// Self-contained so it can be embedded into exported pages as-is.
export function fit(page) {
  if (!page) return;
  for (const line of page.querySelectorAll('.hsk-source-line, .hsk-measured-text')) {
    const span = line.firstElementChild;
    span.style.transform = '';
    line.dataset.sourceFont ||= line.style.fontSize;
    line.style.fontSize = line.dataset.sourceFont;
    const width = span.getBoundingClientRect().width;
    if (width > 0 && line.getBoundingClientRect().width > 0) {
      const scale = line.getBoundingClientRect().width / width;
      line.style.fontSize = `calc(${line.dataset.sourceFont} * ${scale})`;
    }
  }
  const MIN_ZOOM = 0.7;
  const all = [...page.querySelectorAll(':scope > .hsk-at:not(.hsk-background)')].filter(el => el.offsetParent !== null);
  const blocks = all.filter(el => !el.matches('img, .hsk-photo, .hsk-folio, .hsk-source-line, .hsk-source-marker, .hsk-dialogue-measured') && !(page.dataset.lang === 'orig' && el.hasAttribute('data-source-lines')));
  blocks.forEach(el => { el.style.zoom = ''; el.removeAttribute('data-hsk-overflow'); });
  const pageRect = page.getBoundingClientRect();
  const rects = new Map(all.map(el => [el, el.getBoundingClientRect()]));
  const limitFor = (el, r) => {
    let limit = pageRect.bottom;
    const zIndex = Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
    for (const other of all) {
      if (other === el) continue;
      // Ignore lower layers: tip cards and cast portraits intentionally
      // overlap the scan photo beneath them.
      const otherZ = Number.parseInt(getComputedStyle(other).zIndex, 10) || 0;
      if (otherZ < zIndex) continue;
      const o = rects.get(other);
      if (o.left < r.right - 2 && o.right > r.left + 2 && o.top >= r.top + 4 && o.top < limit) limit = o.top;
    }
    return limit - 2;
  };
  for (const el of blocks) {
    // Fixed-height blocks may touch neighbours by design; only their own
    // content overflow matters. Text blocks must stop above the next block.
    const fixed = Boolean(el.style.height);
    const limit = fixed ? Infinity : limitFor(el, rects.get(el));
    let zoom = 1;
    const over = () => { const r = el.getBoundingClientRect(); return r.bottom > limit || r.right > pageRect.right + 1 || el.scrollWidth > el.clientWidth + 2 || (fixed && el.scrollHeight > el.clientHeight + 2); };
    while (over() && zoom > MIN_ZOOM) { zoom = Math.max(MIN_ZOOM, zoom - 0.03); el.style.zoom = zoom.toFixed(2); }
    if (over()) el.dataset.hskOverflow = 'true';
    rects.set(el, el.getBoundingClientRect());
  }
}

export function autoFit(page) {
  if (!page || page.__hskFit) return;
  page.__hskFit = true;
  const run = () => requestAnimationFrame(() => fit(page));
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
// LXGW WenKai ≈ KaiTi.
export const FONT_LINKS = [
  'https://fonts.googleapis.com/css2?family=Arimo:ital,wght@0,400;0,700;1,400&family=Noto+Sans+SC:wght@400;700&family=Noto+Serif+SC:wght@400;500;600;700&family=Tinos:ital,wght@0,400;0,700;1,400;1,700&display=swap',
  'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css'
];

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
  <button type="button" data-lang="orig">Оригинал</button><button type="button" data-lang="ru" aria-pressed="true">Русский</button><button type="button" data-pinyin>Пиньинь</button>
</div>
<main class="wb-sheet">
${render(layout, { assets, lang: 'russian' })}
</main>
${nav}
<script>
${fit.toString()}
const page=document.querySelector('.hsk-page');
const refit=()=>requestAnimationFrame(()=>fit(page));
document.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{page.dataset.lang=b.dataset.lang;document.querySelectorAll('[data-lang]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));refit()});
document.querySelector('[data-pinyin]').onclick=e=>{const on=page.dataset.pinyin!=='on';page.dataset.pinyin=on?'on':'off';e.currentTarget.setAttribute('aria-pressed',String(on));refit()};
refit();document.fonts&&document.fonts.ready.then(refit);addEventListener('resize',refit);
</script>
</body>
</html>`;
}



