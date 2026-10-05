// Component-based page rebuild: the vision model returns a list of known HSK
// textbook blocks (see pages/hsk-components.css); this module validates that
// JSON and renders it. The model never produces HTML or free-form geometry.
(() => {
  const TYPES = ['runhead', 'lesson', 'objectives', 'section', 'para', 'tip', 'dialogue', 'image', 'card', 'words', 'folio', 'text'];

  const PROMPT = `Ты размечаешь скан страницы китайского учебника HSK для пересборки в HTML из готовых компонентов.
Верни ТОЛЬКО JSON вида {"background":...,"blocks":[...]} без пояснений.
background — цветная подложка страницы, если основная область не белая: {"color":"#rrggbb","box":{...}}; иначе null. Каждый блок: {"type":..., "box":{"x","y","w","h"}, ...поля типа}.
box — рамка блока в ДОЛЯХ страницы от 0 до 1: x,y — левый верхний угол, w,h — ширина и высота. Не проценты и не пиксели.
Пример: блок, который начинается на 12% ширины и 15% высоты страницы, шириной 72% и высотой 4%: {"x":0.12,"y":0.15,"w":0.72,"h":0.04}.
Измеряй по скану как можно точнее: левый край, верх, ширину и высоту каждого блока.
Для каждого текста дай: cn (китайский дословно, без пиньиня), en (английский дословно), ru (точный русский перевод английского), py (пиньинь, если он напечатан).
Типы блоков:
- runhead: колонтитул вверху. cn, en, ru.
- lesson: крупная шапка урока. number, cn, en, ru, label (напр. "Lesson").
- objectives: блок целей. heading{cn,en,ru}, items[{cn,en,ru}].
- section: ярлык раздела, напр. "课文 2 | Text 2". cn, en, ru.
- para: абзац или задание. icon: "pin" | "square" | "none"; cn, en, ru; track (номер аудио, напр. "1-3", если есть).
- tip: розовая плашка-подсказка. label{cn,en,ru}; cn, en, ru; avatar: box картинки персонажа над плашкой или null.
- dialogue: столбец реплик с аватарами слева и пузырями справа. box охватывает все реплики. turns[{speaker{cn,py,avatar:"photo"|"group"|"none",avatarBox}, py, hz, highlight}]. hz — иероглифы реплики; highlight — символы, выделенные цветом (или ""). avatarBox — рамка круглого портрета, если avatar="photo".
- image: фотография или иллюстрация (будет вырезана из скана). alt по-русски.
- card: розовая карточка с переводом диалога. lines[{en,ru}].
- words: таблица новых слов. heading{cn,en,ru}; track; rows[{i (номер в кружке, напр. "②"), hz, py, pos_en, pos_ru, en, ru}]. Подзаголовок внутри таблицы (напр. "专有名词 Proper Noun") — отдельная строка {"group":{cn,en,ru}}.
- folio: номер страницы. text.
- text: любой иной текст. cn, en, ru; size ("s"|"m"|"l").
Не выдумывай блоки, не дублируй. Порядок — сверху вниз.`;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const num = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(value) || 0));
  const str = value => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());

  // Bumped whenever box normalisation changes; saved layouts with an older
  // version are re-normalised from their stored model output (or rebuilt).
  const NORM_VERSION = 2;
  const rawVals = raw => raw && typeof raw === 'object' ? [raw.x, raw.y, raw.w ?? raw.width, raw.h ?? raw.height].map(Number) : null;

  // Models return boxes as fractions, percents, source pixels or a 0..1000
  // grid regardless of the prompt. Detect the unit once for the whole page
  // from the furthest right/bottom edges so every box uses the same scale.
  function detectScale(parsed, width, height) {
    const boxes = [];
    const add = raw => { const v = rawVals(raw); if (v && v.every(Number.isFinite)) boxes.push(v); };
    add(parsed?.background?.box);
    for (const b of (Array.isArray(parsed) ? parsed : parsed?.blocks) || []) {
      add(b?.box); add(b?.avatar);
      for (const t of b?.turns || []) add(t?.speaker?.avatarBox);
    }
    if (!boxes.length) return { sx: 1, sy: 1, unit: 'fraction' };
    const maxX = Math.max(...boxes.map(([x, , w]) => x + w)), maxY = Math.max(...boxes.map(([, y, , h]) => y + h));
    if (maxX <= 1.05 && maxY <= 1.05) return { sx: 1, sy: 1, unit: 'fraction' };
    if (maxX <= 101 && maxY <= 101) return { sx: 0.01, sy: 0.01, unit: 'percent' };
    // Page content almost always reaches the lower third, so on a scan taller
    // than 1000 px a bottom edge that stays within 1000 means a 0..1000 grid.
    const grid = maxX <= 1001 && maxY <= 1001 && (!(height > 1050) || maxY < height * 0.66);
    if (grid) return { sx: 0.001, sy: 0.001, unit: 'grid1000' };
    if (width > 0 && height > 0) return { sx: 1 / Math.max(width, maxX), sy: 1 / Math.max(height, maxY), unit: 'pixels' };
    return { sx: 1 / maxX, sy: 1 / maxY, unit: 'scaled' };
  }

  function normBox(raw, scale = { sx: 1, sy: 1 }) {
    const vals = rawVals(raw);
    if (!vals || vals.some(v => !Number.isFinite(v))) return null;
    const x = vals[0] * scale.sx, y = vals[1] * scale.sy, w = vals[2] * scale.sx, h = vals[3] * scale.sy;
    if (w <= 0.002 || h <= 0.002) return null;
    return { x: num(x), y: num(y), w: num(w, 0.002, 1 - num(x)), h: num(h, 0.002, 1 - num(y)) };
  }
  const normBackground = (raw, scale) => {
    const color = /^#[0-9a-f]{6}$/i.test(str(raw?.color)) ? str(raw.color) : '';
    const box = normBox(raw?.box, scale);
    return color && color.toLowerCase() !== '#ffffff' && box ? { color, box } : null;
  };
  const tri = obj => ({ cn: str(obj?.cn), en: str(obj?.en), ru: str(obj?.ru), py: str(obj?.py) });

  function normalize(parsed, scale = { sx: 1, sy: 1 }) {
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blocks) ? parsed.blocks : [];
    const blocks = [];
    for (const raw of list.slice(0, 60)) {
      const type = str(raw?.type);
      const box = normBox(raw?.box, scale);
      if (!TYPES.includes(type) || !box) continue;
      const b = { type, box, ...tri(raw) };
      if (type === 'lesson') Object.assign(b, { number: str(raw.number), label: str(raw.label) || 'Lesson' });
      if (type === 'objectives') Object.assign(b, { heading: tri(raw.heading), items: (raw.items || []).slice(0, 8).map(tri) });
      if (type === 'para') Object.assign(b, { icon: ['pin', 'square'].includes(raw.icon) ? raw.icon : 'none', track: str(raw.track) });
      if (type === 'tip') Object.assign(b, { label: tri(raw.label), avatar: normBox(raw.avatar, scale) });
      if (type === 'dialogue') b.turns = (raw.turns || []).slice(0, 12).map(t => ({
        speaker: { cn: str(t?.speaker?.cn), py: str(t?.speaker?.py), avatar: ['photo', 'group'].includes(t?.speaker?.avatar) ? t.speaker.avatar : 'none', avatarBox: normBox(t?.speaker?.avatarBox, scale) },
        py: str(t?.py), hz: str(t?.hz), highlight: str(t?.highlight)
      })).filter(t => t.hz);
      if (type === 'image') b.alt = str(raw.alt);
      if (type === 'card') b.lines = (raw.lines || []).slice(0, 12).map(l => ({ en: str(l?.en), ru: str(l?.ru) }));
      if (type === 'words') Object.assign(b, { heading: tri(raw.heading), track: str(raw.track), rows: (raw.rows || []).slice(0, 20).map(r => r?.group ? { group: tri(r.group) } : ({ i: str(r?.i), hz: str(r?.hz), py: str(r?.py), pos_en: str(r?.pos_en), pos_ru: str(r?.pos_ru), en: str(r?.en), ru: str(r?.ru) })) });
      if (type === 'folio') b.text = str(raw.text);
      if (type === 'text') b.size = ['s', 'm', 'l'].includes(raw.size) ? raw.size : 'm';
      blocks.push(b);
    }
    return blocks;
  }

  async function build({ rasterUrl, width, height, model, requestJson, parse }) {
    const d = await requestJson('chat/completions', {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: rasterUrl } }] }],
      temperature: 0.1, reasoning: { max_tokens: 2048 }, max_tokens: 16000
    });
    if (d.choices?.[0]?.finish_reason === 'length') throw new Error('Ответ модели обрезан. Попробуйте ещё раз или выберите другую модель.');
    const parsed = parse(d.choices?.[0]?.message?.content);
    const layout = fromModel(parsed, width, height);
    if (!layout.blocks.length) throw new Error('Модель не вернула ни одного распознаваемого блока страницы.');
    layout.cost = d.usage?.cost ?? null;
    return layout;
  }

  // Build a layout from raw model output. The raw output is kept so a later
  // fix to normalisation can re-derive the boxes without a paid request.
  function fromModel(parsed, width, height) {
    const scale = detectScale(parsed, width, height);
    return { version: 1, normVersion: NORM_VERSION, unit: scale.unit, page: { width, height }, background: normBackground(parsed?.background, scale), blocks: normalize(parsed, scale), source: parsed };
  }

  // Re-derive boxes for layouts saved by an older normaliser. Text edits made
  // in the studio live in `blocks`, so they are carried over by position.
  function upgrade(layout) {
    if (!layout || layout.normVersion === NORM_VERSION || !layout.source) return layout;
    const fresh = fromModel(layout.source, layout.page?.width, layout.page?.height);
    if (fresh.blocks.length === layout.blocks.length) fresh.blocks = fresh.blocks.map((b, n) => ({ ...layout.blocks[n], box: b.box, ...(b.avatar ? { avatar: b.avatar } : {}), ...(b.turns ? { turns: b.turns.map((t, k) => ({ ...layout.blocks[n].turns?.[k], speaker: { ...layout.blocks[n].turns?.[k]?.speaker, avatarBox: t.speaker.avatarBox } })) } : {}) }));
    fresh.cost = layout.cost;
    return fresh;
  }

  // ---- Snap model boxes to the scan -------------------------------------
  // Vision models get the structure and text right but misplace boxes by
  // several percent. Local OCR line boxes and the scan's own pixels are exact,
  // so each block is re-measured from them.
  const SNAP_VERSION = 1;
  const PANEL_TYPES = new Set(['lesson', 'objectives', 'section', 'tip', 'words', 'card', 'folio']);
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
  const centerDist = (a, b) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
  const insideGrown = (p, box, gx, gy) => p.x >= box.x - gx && p.x <= box.x + box.w + gx && p.y >= box.y - gy && p.y <= box.y + box.h + gy;

  // Assign every OCR line to the block whose text it matches, preferring the
  // closest block when a phrase repeats (e.g. the title and the dialogue).
  function assignLines(layout, ocrLines) {
    const texts = layout.blocks.map(blockStrings);
    const hits = layout.blocks.map(() => []);
    for (const line of ocrLines) {
      const t = plain(line.text);
      if (t.length < 2) continue;
      const c = { x: line.box.x + line.box.w / 2, y: line.box.y + line.box.h / 2 };
      let best = null;
      layout.blocks.forEach((b, n) => {
        if (b.type === 'image') return;
        const score = matchScore(t, texts[n]);
        if (score < 0.6 || !insideGrown(c, b.box, 0.15, 0.1)) return;
        const rank = score - centerDist(line.box, b.box) * 1.5;
        if (!best || rank > best.rank) best = { n, rank };
      });
      if (best) hits[best.n].push(line);
    }
    return hits;
  }

  // Pixel helpers over a downscaled copy of the scan.
  function pixelGrid(img, maxW = 700) {
    const scale = Math.min(1, maxW / img.naturalWidth), W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const at = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    // Page background = most common colour along the right edge strip.
    const counts = new Map();
    for (let y = 0; y < H; y += 2) for (let x = W - 6; x < W - 1; x++) { const [r, g, b] = at(x, y), k = (r >> 3) + ',' + (g >> 3) + ',' + (b >> 3); counts.set(k, (counts.get(k) || 0) + 1); }
    const bgKey = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(v => Number(v) * 8 + 4);
    return { W, H, at, bg: bgKey };
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Flood-fill pixels accepted by `ok` from the seeds, limited to a window;
  // returns the filled bounding box in page fractions.
  function flood(grid, seeds, win, ok) {
    const { W, H } = grid, x0 = Math.max(0, Math.floor(win.x * W)), y0 = Math.max(0, Math.floor(win.y * H));
    const x1 = Math.min(W - 1, Math.ceil((win.x + win.w) * W)), y1 = Math.min(H - 1, Math.ceil((win.y + win.h) * H));
    const seen = new Uint8Array(W * H), stack = [];
    const rows = new Uint32Array(H), cols = new Uint32Array(W);
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
    // A fill can leak along thin borders of a touching panel. Trim edge rows
    // and columns that are only sparsely filled compared with the panel body.
    // Leaks run down thin vertical borders, so rows are trimmed firmly; columns
    // only lightly, because a banner can be thin above a card it wraps.
    const span = (arr, lo, hi, share) => {
      let max = 0; for (let i = lo; i <= hi; i++) if (arr[i] > max) max = arr[i];
      const min = max * share; let a = lo, b = hi;
      while (a < b && arr[a] < min) a++; while (b > a && arr[b] < min) b--;
      return [a, b];
    };
    const [minX, maxX] = span(cols, x0, x1, 0.04), [minY, maxY] = span(rows, y0, y1, 0.25);
    return { x: minX / W, y: minY / H, w: (maxX - minX + 1) / W, h: (maxY - minY + 1) / H };
  }
  const overlapShare = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / (b.w * b.h) : 0;
  };

  // Panel fill = most common colour on a thin ring just outside the text.
  // Sampling inside the text box would pick up the glyphs themselves (white
  // title text on a red banner), so the ring looks at what surrounds them.
  function fillColor(grid, box) {
    const counts = new Map(), pad = 3;
    const x0 = Math.max(0, Math.floor(box.x * grid.W) - pad), x1 = Math.min(grid.W - 1, Math.ceil((box.x + box.w) * grid.W) + pad);
    const y0 = Math.max(0, Math.floor(box.y * grid.H) - pad), y1 = Math.min(grid.H - 1, Math.ceil((box.y + box.h) * grid.H) + pad);
    // OCR boxes are loose, so part of the ring lands on the page background;
    // ignore it and take the dominant remaining colour if it is substantial.
    let total = 0;
    const count = (x, y) => { total++; const p = grid.at(x, y); if (dist(p, grid.bg) < 24) return; const k = (p[0] >> 4) + ',' + (p[1] >> 4) + ',' + (p[2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); };
    for (let x = x0; x <= x1; x++) { count(x, y0); count(x, y1); }
    for (let y = y0; y <= y1; y++) { count(x0, y); count(x1, y); }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= total * 0.12 ? top[0].split(',').map(v => Number(v) * 16 + 8) : null;
  }
  const seedsIn = (grid, box, step = 3) => {
    const s = [];
    for (let y = Math.floor(box.y * grid.H); y <= (box.y + box.h) * grid.H; y += step) for (let x = Math.floor(box.x * grid.W); x <= (box.x + box.w) * grid.W; x += step) s.push([Math.min(grid.W - 1, x), Math.min(grid.H - 1, y)]);
    return s;
  };
  const grow = (b, gx, gy) => ({ x: b.x - gx, y: b.y - gy, w: b.w + 2 * gx, h: b.h + 2 * gy });
  const clampBox = b => { const x = num(b.x), y = num(b.y); return { x, y, w: num(b.w, 0.002, 1 - x), h: num(b.h, 0.002, 1 - y) }; };

  async function snap(layout, rasterUrl, ocr) {
    if (!layout || !ocr?.lines?.length) return layout;
    const ocrLines = ocr.lines.map(l => ({ text: String(l.text || ''), box: { x: +l.position.x, y: +l.position.y, w: +(l.position.width ?? l.position.w), h: +(l.position.height ?? l.position.h) } })).filter(l => l.text && Number.isFinite(l.box.w));
    const hits = assignLines(layout, ocrLines);
    const img = rasterUrl ? await new Promise(r => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = rasterUrl; }) : null;
    const grid = img ? pixelGrid(img) : null;
    const ratio = (layout.page?.width || 1) / (layout.page?.height || 1);
    const snapped = layout.blocks.map((b, n) => {
      const lines = hits[n], next = { ...b };
      const text = lines.length ? union(lines.map(l => l.box)) : null;
      if (b.type === 'image' && grid) {
        const seeds = seedsIn(grid, grow(b.box, -b.box.w * 0.3, -b.box.h * 0.3), 4);
        const found = flood(grid, seeds, grow(b.box, 0.06, 0.05), p => dist(p, grid.bg) > 30);
        if (found && found.w > b.box.w * 0.5 && found.h > b.box.h * 0.5) next.box = found;
      } else if (PANEL_TYPES.has(b.type) && text && grid) {
        // Search window scales with the block so wide banners can reach their
        // real edges; the model box is included because it covers padding.
        const fill = fillColor(grid, text);
        const win = union([grow(text, Math.max(0.09, text.w * 0.5), Math.max(0.05, text.h * 0.5)), b.box]);
        const found = fill && dist(fill, grid.bg) > 18 ? flood(grid, seedsIn(grid, grow(text, 0.004, 0.003)), win, p => dist(p, fill) < 30) : null;
        // Tabs and pills stick out of their panel, and loose OCR boxes do too:
        // trust the found panel when it already holds most of the text.
        // The section tag ("Text 1") sits beside the red tab, so keep both.
        next.box = !found ? grow(text, 0.01, 0.006) : b.type !== 'section' && overlapShare(found, text) >= 0.8 ? found : union([found, text]);
        if (window.FormaHskPage?.debug) window.FormaHskPage.debug.push({ type: b.type, bg: grid.bg, fill, text, win, found });
        // The "New Words" tab straddles the table's top edge.
        if (b.type === 'words') {
          const tab = lines.find(l => b.heading && matchScore(plain(l.text), plain([b.heading.cn, b.heading.en].join(''))) >= 0.6);
          if (tab) { const top = tab.box.y + tab.box.h / 2, bottom = next.box.y + next.box.h; if (top > next.box.y) next.box = { ...next.box, y: top, h: bottom - top }; }
        }
      } else if (text) {
        next.box = grow(text, 0.003, 0.003);
        if (b.type === 'para' && b.icon === 'square') { next.box.x -= 0.025; next.box.w += 0.025; }
      }
      if (b.type === 'dialogue' && text) {
        // Rows run from the first avatar to the last speaker label; bubbles keep
        // the model's right edge, which is stable for fixed-width bubbles.
        const right = Math.max(text.x + text.w + 0.03, b.box.x + b.box.w);
        const names = b.turns.map(t => lines.filter(l => plain(l.text) === plain(t.speaker.cn)).sort((p, q) => p.box.y - q.box.y)).map(list => list[0]?.box);
        const avatarH = 0.056 * ratio;
        next.turns = b.turns.map((t, k) => {
          const name = names[k];
          if (!name || t.speaker.avatar !== 'photo') return t;
          const cx = name.x + name.w / 2, bottom = name.y - 0.012;
          return { ...t, speaker: { ...t.speaker, avatarBox: clampBox({ x: cx - 0.028, y: bottom - avatarH, w: 0.056, h: avatarH }) } };
        });
        const firstTop = Math.min(text.y, ...next.turns.map(t => t.speaker.avatarBox?.y ?? 1));
        next.box = { x: Math.min(text.x, b.box.x), y: firstTop, w: right - Math.min(text.x, b.box.x), h: text.y + text.h - firstTop };
      }
      next.box = clampBox(next.box);
      return next;
    });
    return { ...layout, blocks: snapped, snapVersion: SNAP_VERSION };
  }

  // Crop every image/avatar referenced by the layout from the source PNG.
  async function cropImages(layout, rasterUrl) {
    const out = {};
    if (!rasterUrl) return out;
    const img = await new Promise(resolve => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => resolve(null); im.src = rasterUrl; });
    if (!img) return out;
    const crop = box => {
      const x = Math.round(box.x * img.naturalWidth), y = Math.round(box.y * img.naturalHeight);
      const w = Math.round(box.w * img.naturalWidth), h = Math.round(box.h * img.naturalHeight);
      if (w < 2 || h < 2) return '';
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      return c.toDataURL('image/png');
    };
    layout.blocks.forEach((b, n) => {
      if (b.type === 'image') out[n] = crop(b.box);
      if (b.type === 'tip' && b.avatar) out[n + ':avatar'] = crop(b.avatar);
      if (b.type === 'dialogue') b.turns.forEach((t, k) => { if (t.speaker.avatar === 'photo' && t.speaker.avatarBox) out[n + ':' + k] = crop(t.speaker.avatarBox); });
    });
    return out;
  }

  const GROUP_ICON = '<svg viewBox="0 0 60 40" aria-hidden="true"><circle cx="15" cy="10" r="7"/><circle cx="45" cy="10" r="7"/><circle cx="30" cy="14" r="8"/><path d="M2 32c0-9 6-13 13-13s10 3 11 6c-4 3-6 7-6 11H4a2 2 0 0 1-2-2ZM58 32c0-9-6-13-13-13s-10 3-11 6c4 3 6 7 6 11h16a2 2 0 0 0 2-2Z"/><path d="M16 38c0-10 6-15 14-15s14 5 14 15a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2Z"/></svg>';
  const TRACK_ICON = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3Zm12-1c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/></svg>';
  const PIN_ICON = '<svg class="hsk-pin" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 29S2 17.5 2 10.5a10 10 0 0 1 20 0C22 17.5 12 29 12 29Z"/><circle cx="12" cy="10.5" r="3.6" fill="#fff"/></svg>';

  // `lang` is only for standalone use; inside the studio the ancestor
  // .ebook-page-content[data-language-mode] switches languages.
  function render(layout, { images = {}, pinyin = false, lang = '', videoButton = '' } = {}) {
    const ratio = (layout.page?.height || 1595) / (layout.page?.width || 1171);
    const pos = (b, extra = '') => `left:${(b.box.x * 100).toFixed(2)}%;top:${(b.box.y * 100).toFixed(2)}%;width:${(b.box.w * 100).toFixed(2)}%;${extra}`;
    const ed = (n, path, value, cls = '') => `<span class="${cls}" contenteditable="true" data-hsk-block="${n}" data-hsk-path="${esc(path)}">${esc(value)}</span>`;
    const trio = (n, prefix, o) => (o.cn ? ed(n, prefix + 'cn', o.cn, 'cn') : '') + (o.en ? ed(n, prefix + 'en', o.en, 'en') : '') + (o.ru ? ed(n, prefix + 'ru', o.ru, 'ru') : '');
    const track = t => t ? `<span class="hsk-track">${TRACK_ICON} ${esc(t)}</span>` : '';
    const highlight = (hz, mark) => mark ? esc(hz).split(esc(mark)).join(`<em>${esc(mark)}</em>`) : esc(hz);

    const html = layout.blocks.map((b, n) => {
      switch (b.type) {
        case 'runhead':
          return `<header class="hsk-at hsk-runhead" style="${pos(b)}"><b>${ed(n, 'cn', b.cn)}</b><span>${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</span></header>`;
        case 'lesson':
          return `<header class="hsk-at hsk-lesson" style="${pos(b, `height:${(b.box.h * 100).toFixed(2)}%`)}"><div class="hsk-lesson-no">${esc(b.number)}</div><div class="hsk-lesson-title"><small>${esc(b.label)}</small>${ed(n, 'cn', b.cn, 'cn')}${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</div></header>`;
        case 'objectives':
          return `<section class="hsk-at hsk-objectives" style="${pos(b, `min-height:${(b.box.h * 100).toFixed(2)}%`)}"><h3>${trio(n, 'heading.', b.heading)}</h3>${b.items.map((it, k) => `<div class="hsk-objective"><span class="hsk-check"></span><span>${trio(n, `items.${k}.`, it)}</span></div>`).join('')}</section>`;
        case 'section':
          return `<h2 class="hsk-at hsk-section" style="${pos(b, `height:${(b.box.h * 100).toFixed(2)}%`)}">${ed(n, 'cn', b.cn, 'cn')}<span class="tag">${b.en ? ed(n, 'en', b.en, 'en') : ''}${b.ru ? ed(n, 'ru', b.ru, 'ru') : ''}</span></h2>`;
        case 'para':
          return `<p class="hsk-at hsk-para" style="${pos(b)}">${b.icon === 'pin' ? PIN_ICON + '<span></span>' : b.icon === 'square' ? '<span class="hsk-square"></span>' : '<span></span>'}<span>${trio(n, '', b)}${track(b.track)}</span></p>`;
        case 'tip':
          return (images[n + ':avatar'] ? `<img class="hsk-at hsk-tip-avatar" style="${pos({ box: b.avatar }, 'z-index:2')}" src="${images[n + ':avatar']}" alt="">` : '') +
            `<aside class="hsk-at hsk-tip" style="${pos(b, `min-height:${(b.box.h * 100).toFixed(2)}%`)}"><div class="hsk-tip-label">${b.label.cn ? ed(n, 'label.cn', b.label.cn) : ''}${b.label.en ? `<small class="en">${ed(n, 'label.en', b.label.en)}</small>` : ''}${b.label.ru ? `<small class="ru">${ed(n, 'label.ru', b.label.ru)}</small>` : ''}</div><div>${trio(n, '', b)}</div></aside>`;
        case 'dialogue': {
          const pitch = b.turns.length ? (b.box.h * ratio * 100) / b.turns.length : 10;
          const bubble = Math.min(6.7, pitch * 0.62);
          return `<section class="hsk-at hsk-dialogue" style="${pos(b, `grid-auto-rows:${pitch.toFixed(3)}cqw;--bubble-h:${bubble.toFixed(3)}cqw`)}">` + b.turns.map((t, k) => {
            const face = t.speaker.avatar === 'photo' && images[n + ':' + k] ? `<img src="${images[n + ':' + k]}" alt="">` : t.speaker.avatar === 'group' || t.speaker.avatar === 'photo' ? GROUP_ICON : '';
            return `<div class="hsk-turn"><figure class="hsk-speaker">${face}${t.speaker.py ? `<span class="py">${esc(t.speaker.py)}</span>` : ''}<b>${ed(n, `turns.${k}.speaker.cn`, t.speaker.cn)}</b></figure><div class="hsk-bubble">${t.py ? `<span class="py">${esc(t.py)}</span>` : ''}<span class="hz">${highlight(t.hz, t.highlight)}</span></div></div>`;
          }).join('') + '</section>';
        }
        case 'image':
          return `<figure class="hsk-at hsk-photo ebook-clone-illustration" style="${pos(b, `height:${(b.box.h * 100).toFixed(2)}%`)}">${images[n] ? `<img src="${images[n]}" alt="${esc(b.alt)}">` : ''}${n === layout.blocks.findIndex(x => x.type === 'image') ? videoButton : ''}</figure>`;
        case 'card':
          return `<section class="hsk-at hsk-card" style="${pos(b, `height:${(b.box.h * 100).toFixed(2)}%`)}"><div class="en">${b.lines.map((l, k) => `<p>${ed(n, `lines.${k}.en`, l.en)}</p>`).join('')}</div><div class="ru">${b.lines.map((l, k) => `<p>${ed(n, `lines.${k}.ru`, l.ru)}</p>`).join('')}</div></section>`;
        case 'words':
          return `<section class="hsk-at hsk-words" style="${pos(b, `min-height:${(b.box.h * 100).toFixed(2)}%`)}"><h3 class="hsk-words-tab">${trio(n, 'heading.', b.heading)}${track(b.track)}</h3>` + b.rows.map((r, k) => r.group ? `<h4 class="hsk-words-group">${trio(n, `rows.${k}.group.`, r.group)}</h4>` :
            `<div class="hsk-word"><span class="i">${esc(r.i)}</span>${ed(n, `rows.${k}.hz`, r.hz, 'hz')}<span class="py">${esc(r.py)}</span><span class="pos">${ed(n, `rows.${k}.pos_en`, r.pos_en, 'en')}${ed(n, `rows.${k}.pos_ru`, r.pos_ru, 'ru')}</span>${ed(n, `rows.${k}.en`, r.en, 'en')}${ed(n, `rows.${k}.ru`, r.ru, 'ru')}</div>`).join('') + '</section>';
        case 'folio':
          return `<span class="hsk-at hsk-folio${b.box.x > 0.5 ? ' hsk-folio-right' : ''}" style="${pos(b, `height:${(b.box.h * 100).toFixed(2)}%`)}">${esc(b.text)}</span>`;
        default:
          return `<p class="hsk-at hsk-text hsk-text-${b.size || 'm'}" style="${pos(b)}">${trio(n, '', b)}</p>`;
      }
    });

    // Tag each block with the bottom edge of its source box so fit() only
    // reacts to text growing past that box, not to blocks that touch by design.
    const CLASS = { image: 'photo' };
    const tagged = html.map((chunk, n) => {
      const b = layout.blocks[n], cls = `class="hsk-at hsk-${CLASS[b.type] || b.type}`;
      return chunk.replace(cls, `data-hsk-bottom="${(b.box.y + b.box.h).toFixed(4)}" ${cls}`);
    }).join('');
    const bg = layout.background ? `<div class="hsk-at hsk-background" style="${pos(layout.background, `height:${(layout.background.box.h * 100).toFixed(2)}%;background:${layout.background.color}`)}"></div>` : '';
    return `<div class="hsk-page"${lang ? ` data-lang="${lang === 'original' ? 'orig' : 'ru'}"` : ''} data-pinyin="${pinyin ? 'on' : 'off'}" style="aspect-ratio:${layout.page?.width || 1171}/${layout.page?.height || 1595}">${bg}${tagged}</div>`;
  }

  // Blocks keep the source coordinates, but translated text is longer than the
  // original. Shrink each block (CSS zoom scales its cqw font sizes, not its
  // percentage box) until it neither runs into the next block below it nor
  // spills sideways. Blocks that still do not fit are flagged for manual edit.
  const MIN_ZOOM = 0.7;
  function fit(page) {
    if (!page) return;
    const blocks = [...page.querySelectorAll(':scope > .hsk-at')].filter(el => !el.matches('img, .hsk-photo, .hsk-folio, .hsk-background') && el.offsetParent !== null);
    blocks.forEach(el => { el.style.zoom = ''; el.removeAttribute('data-hsk-overflow'); });
    const pageRect = page.getBoundingClientRect();
    const rects = new Map(blocks.map(el => [el, el.getBoundingClientRect()]));
    const others = [...page.querySelectorAll(':scope > .hsk-at:not(.hsk-background)')].filter(el => el.offsetParent !== null);
    const limitFor = (el, r) => {
      let limit = pageRect.bottom;
      for (const other of others) {
        if (other === el) continue;
        const o = rects.get(other) || other.getBoundingClientRect();
        const overlapsX = o.left < r.right - 2 && o.right > r.left + 2;
        if (overlapsX && o.top >= r.top + 4 && o.top < limit) limit = o.top;
      }
      return limit - 2;
    };
    const spills = el => el.scrollWidth > el.clientWidth + 2;
    for (const el of blocks) {
      // Fixed-height blocks (header, section tab, card) may touch neighbours by
      // design; only their own content overflow matters. Text blocks grow with
      // their content and must stop above the next block below.
      const fixed = Boolean(el.style.height);
      const limit = fixed ? Infinity : limitFor(el, rects.get(el));
      let zoom = 1;
      const overflowing = () => { const r = el.getBoundingClientRect(); return r.bottom > limit || r.right > pageRect.right + 1 || spills(el) || (fixed && el.scrollHeight > el.clientHeight + 2); };
      while (overflowing() && zoom > MIN_ZOOM) { zoom = Math.max(MIN_ZOOM, zoom - 0.03); el.style.zoom = zoom.toFixed(2); }
      if (overflowing()) el.dataset.hskOverflow = 'true';
      rects.set(el, el.getBoundingClientRect());
    }
  }
  // Fit after web fonts settle and whenever the page width changes.
  function autoFit(page) {
    if (!page || page.__hskFit) return;
    page.__hskFit = true;
    const run = () => requestAnimationFrame(() => fit(page));
    run();
    document.fonts?.ready.then(run);
    let width = page.clientWidth;
    new ResizeObserver(() => { if (Math.abs(page.clientWidth - width) > 1) { width = page.clientWidth; run(); } }).observe(page);
  }

  // Write an edited value back into the layout by its dotted path.
  function setField(layout, blockIndex, path, value) {
    const keys = path.split('.');
    let target = layout.blocks[blockIndex];
    for (const key of keys.slice(0, -1)) { if (target == null) return; target = target[key]; }
    if (target && typeof target === 'object') target[keys.at(-1)] = value;
  }

  window.FormaHskPage = { build, render, cropImages, setField, normalize, fromModel, upgrade, detectScale, snap, fit, autoFit, NORM_VERSION, SNAP_VERSION, PROMPT };
})();
