// Forma "PDF → Web" console: the studio page that drives the conversion
// service (webbook/server.mjs) and edits its results. Pages are drawn with the
// same core renderer the exported site uses, so what you see is what ships.
import * as core from './core.mjs?v=20260930-source1';

const API = '/local/webbook';
const PREF = 'forma.webbook.v1';
const TYPE_NAMES = { runhead: 'Колонтитул', lesson: 'Шапка урока', objectives: 'Цели', section: 'Ярлык раздела', para: 'Абзац', tip: 'Подсказка', dialogue: 'Диалог', image: 'Изображение', card: 'Карточка перевода', words: 'Новые слова', folio: 'Номер страницы', text: 'Текст', decor: 'Графика' };
const STEP_ICON = { wait: '○', running: '◌', done: '●', error: '✕' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const loadPref = () => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; } };
const savePref = p => { try { localStorage.setItem(PREF, JSON.stringify({ ...loadPref(), ...p })); } catch {} };
async function call(path, options = {}) {
  const r = await fetch(API + path, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---- cast: studio characters → server ----
// Characters (names + portraits) live in the studio's browser storage; the
// server needs them to publish pages with the new avatars. Sent whenever they
// change, detected by a cheap signature.
const STUDIO_KEY = 'forma.textbookStudio.v1';
function studioFile(key) {
  return new Promise(resolve => {
    const r = indexedDB.open('forma-hsk-script-workbench', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onerror = () => resolve(null);
    r.onsuccess = () => { const db = r.result; try { const q = db.transaction('files').objectStore('files').get(key); q.onsuccess = () => { resolve(q.result || null); db.close(); }; q.onerror = () => { resolve(null); db.close(); }; } catch { resolve(null); db.close(); } };
  });
}
async function portraitDataUrl(blob) {
  const bitmap = await createImageBitmap(blob);
  const s = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * s)); c.height = Math.max(1, Math.round(bitmap.height * s));
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height); bitmap.close();
  return c.toDataURL('image/webp', 0.9);
}
export async function syncCast(bookId) {
  if (!bookId) return null;
  let studio = {};
  try { studio = JSON.parse(localStorage.getItem(STUDIO_KEY)) || {}; } catch {}
  const chars = (studio.characters || []).map(c => ({ id: c.id, names: [c.nameZh, c.nameRu, c.name].map(s => String(s || '').trim()).filter(Boolean) })).filter(c => c.id && c.names.length);
  const files = await Promise.all(chars.map(c => studioFile('character:' + c.id)));
  const manual = studio.webbookSpeakers || {};
  const signature = JSON.stringify([chars.map((c, i) => [c.id, c.names, files[i]?.size || 0, files[i]?.type || '']), manual]);
  const current = await call(`/books/${bookId}/cast`).catch(() => ({}));
  // Forma Studio One uses a different localhost port (and therefore a
  // different browser storage origin) from the original project. An empty
  // local store must not erase portraits already imported into this copy.
  if (!chars.length && current.characters > 0) return { changed: false, retained: true };
  if (current.signature === signature) return { changed: false };
  // If browser storage lost its image records, keep the server's existing
  // cast instead of replacing all approved portraits with blank entries.
  if (current.characters > 0 && files.every(file => !file)) return { changed: false, retained: true };
  const characters = await Promise.all(chars.map(async (c, i) => ({ ...c, image: files[i] ? await portraitDataUrl(files[i]).catch(() => '') : '' })));
  const result = await call(`/books/${bookId}/cast`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characters, manual, signature }) });
  return { changed: true, ...result };
}
window.formaWebbookSyncCast = syncCast;

const S = {
  view: null, books: [], book: null, page: 1,
  layout: null, displayLayout: null, assets: {}, dirty: false, selected: -1,
  mode: 'side', opacity: 50, lang: 'russian', pinyin: false,
  job: null, poll: 0, statePoll: 0
};

// ---- markup ----

function shell() {
  const pref = loadPref();
  S.mode = pref.mode || 'side'; S.opacity = pref.opacity ?? 50; S.lang = pref.lang || 'russian';
  S.view.innerHTML = `
  <div class="heading"><div><div class="eyebrow">Учебные материалы / PDF → Web</div><h1>PDF → Web</h1>
    <p>Постраничная конвертация учебника в веб-страницы для учебной платформы: структура от модели, геометрия, цвета и шрифты — со скана.</p></div>
    <span class="badge">LOCAL OCR + OPENROUTER</span></div>
  <section class="panel wb-toolbar">
    <label class="wb-field"><span>Книга</span><select id="wbBook"></select></label>
    <label class="btn-quiet wb-upload" title="PDF хранится локально в папке library">＋ Загрузить PDF<input id="wbFile" type="file" accept="application/pdf,.pdf" hidden></label>
    <label class="wb-field wb-grow"><span>Модель разметки (Vision)</span><select class="input" id="wbModel" data-kind="chat"></select></label>
    <div class="wb-pager"><button class="btn-quiet" data-go="-1" title="Предыдущая (←)">←</button><input id="wbPage" class="input" type="number" min="1" value="1"><span id="wbTotal">/ —</span><button class="btn-quiet" data-go="1" title="Следующая (→)">→</button></div>
  </section>
  <div class="wb-work">
    <aside class="panel wb-pages" aria-label="Страницы"><div class="wb-pages-head"><b>Страницы</b><span id="wbDone"></span></div><div id="wbList" class="wb-list"></div></aside>
    <section class="panel wb-stage-panel">
      <div class="wb-stagebar">
        <div class="wb-seg" role="group" aria-label="Режим сравнения">
          <button data-mode="side">Рядом</button><button data-mode="overlay">Наложение</button><button data-mode="diff">Разница</button>
        </div>
        <label class="wb-opacity" id="wbOpacityWrap">Оригинал <input id="wbOpacity" type="range" min="0" max="100"></label>
        <div class="wb-seg" role="group" aria-label="Язык"><button data-lang="original">Оригинал</button><button data-lang="russian">Русский</button></div>
        <button class="btn-quiet" id="wbPinyin" aria-pressed="false">Пиньинь</button>
      </div>
      <div id="wbStage" class="wb-stage"></div>
    </section>
    <aside class="panel wb-inspector">
      <div class="wb-actions">
        <button class="btn" id="wbConvert">Конвертировать страницу</button>
        <button class="btn-quiet" id="wbMeasure">Уточнить оригинал по скану</button>
        <button class="btn-quiet" id="wbCompare">Снимок и карта отличий</button>
        <div class="wb-hint">Уточнение использует сохранённый OCR, без запроса к модели. Предыдущая версия сохраняется.</div>
        <div class="wb-hint" id="wbCostHint"></div>
        <details class="wb-more"><summary>Ещё</summary>
          <button class="btn-quiet" id="wbRemodel" title="Новый платный запрос к модели для этой страницы">Запросить модель заново</button>
          <div class="wb-range"><span>Страницы</span><input class="input" id="wbFrom" type="number" min="1"><span>–</span><input class="input" id="wbTo" type="number" min="1"><button class="btn-quiet" id="wbBatch">Конвертировать</button></div>
        </details>
      </div>
      <div class="wb-block"><div class="wb-title">Конвейер</div><ol id="wbSteps" class="wb-steps"></ol><div class="status" id="wbStatus"></div></div>
      <div class="wb-block"><div class="wb-title">Блоки <span class="wb-muted">клик — выбрать, текст правится на странице</span></div><div id="wbBlocks" class="wb-blocks"></div><div id="wbGeom" class="wb-geom" hidden></div></div>
      <div class="wb-block" id="wbComparison" hidden></div>
      <div class="wb-block wb-save"><button class="btn" id="wbSave" disabled>Сохранить правки</button><a class="btn-quiet" id="wbOpen" target="_blank" rel="noopener">Открыть HTML</a></div>
      <div class="wb-block"><div class="wb-title">Выгрузка для платформы</div>
        <div class="wb-range"><span>Страницы</span><input class="input" id="wbExFrom" type="number" min="1"><span>–</span><input class="input" id="wbExTo" type="number" min="1"><button class="btn-quiet" id="wbExport">Собрать ZIP</button></div>
        <div class="status" id="wbExportStatus"></div></div>
    </aside>
  </div>`;
  window.fillSelects?.();
  watchModelSelect();
}

// ---- model choice ----
// The studio refills model lists whenever the catalogue loads and assigns its
// own onchange; keep the user's choice in prefs and put it back after every
// refill. Models that cannot read images are marked and disabled.
const modelInfo = id => (typeof models !== 'undefined' ? models.chat || [] : []).find(m => m.id === id);
const acceptsImages = id => { const mods = modelInfo(id)?.architecture?.input_modalities; return !Array.isArray(mods) || mods.includes('image'); };
function restoreModel() {
  const sel = S.view?.querySelector('#wbModel');
  if (!sel) return;
  for (const o of sel.options) if (o.value && !acceptsImages(o.value) && !o.dataset.noImages) { o.dataset.noImages = '1'; o.disabled = true; o.textContent += ' — без изображений'; }
  const want = loadPref().model;
  if (want && [...sel.options].some(o => o.value === want && !o.disabled)) sel.value = want;
  else if (sel.selectedOptions[0]?.disabled) { const first = [...sel.options].find(o => o.value && !o.disabled); if (first) sel.value = first.value; }
}
function watchModelSelect() {
  const sel = S.view.querySelector('#wbModel');
  sel.addEventListener('change', () => { if (sel.value) savePref({ model: sel.value }); });
  new MutationObserver(restoreModel).observe(sel, { childList: true });
  restoreModel();
}
function chosenModel() {
  const model = S.view.querySelector('#wbModel').value;
  if (model && !acceptsImages(model)) throw new Error(`Модель ${model} не принимает изображения. Выберите Vision-модель.`);
  return model;
}

// ---- books & pages ----

async function loadBooks(selectId) {
  S.books = await call('/books');
  const sel = S.view.querySelector('#wbBook');
  sel.innerHTML = S.books.length ? S.books.map(b => `<option value="${b.id}">${esc(b.name)} · ${b.pages} стр.</option>`).join('') : '<option value="">Нет книг — загрузите PDF</option>';
  const want = selectId || loadPref().book;
  const book = S.books.find(b => b.id === want) || S.books[0];
  if (book) { sel.value = book.id; await openBook(book.id); } else renderEmpty();
}

function renderEmpty() {
  S.view.querySelector('#wbStage').innerHTML = `<label class="wb-drop">Перетащите PDF учебника сюда или нажмите «Загрузить PDF».<br><small>Файл остаётся на этом компьютере, в папке library.</small><input type="file" accept="application/pdf,.pdf" hidden></label>`;
  S.view.querySelector('.wb-drop input').onchange = e => upload(e.target.files[0]);
}

async function upload(file) {
  if (!file) return;
  const status = S.view.querySelector('#wbStatus');
  status.textContent = `Загружаю «${file.name}» (${(file.size / 1048576).toFixed(1)} МБ)…`;
  try {
    const book = await call(`/books?name=${encodeURIComponent(file.name.replace(/\.pdf$/i, ''))}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file });
    status.textContent = `Книга загружена: ${book.pages} стр.`;
    await loadBooks(book.id);
  } catch (e) { status.textContent = 'Не удалось загрузить PDF: ' + e.message; }
}

async function openBook(id) {
  const cast = await syncCast(id).catch(e => ({ error: e.message }));
  S.castNote = cast?.error ? 'Не удалось передать персонажей: ' + cast.error : cast?.changed ? `Персонажи обновлены: ${cast.withPortrait} с аватаром, страниц перевыпущено: ${cast.pages}.` : '';
  S.book = await call(`/books/${id}`);
  savePref({ book: id });
  const pref = loadPref();
  S.page = Math.min(S.book.pages, Math.max(1, (pref.pages || {})[id] || 1));
  S.view.querySelector('#wbTotal').textContent = `/ ${S.book.pages}`;
  const ex = S.view.querySelector('#wbExFrom'), et = S.view.querySelector('#wbExTo');
  if (!ex.value) ex.value = 1; if (!et.value) et.value = S.book.pages;
  renderList();
  await openPage(S.page);
}

async function refreshBook() {
  if (!S.book) return;
  S.book = await call(`/books/${S.book.id}`);
  renderList();
  const busy = S.book.pageStates.some(p => ['queued', 'running'].includes(p.state));
  clearTimeout(S.statePoll);
  if (busy) S.statePoll = setTimeout(refreshBook, 3000);
}

function renderList() {
  const list = S.view.querySelector('#wbList'), states = S.book.pageStates;
  S.view.querySelector('#wbDone').textContent = `${states.filter(p => p.state === 'done').length} построено`;
  list.innerHTML = states.map(p => `<button class="wb-thumb${p.n === S.page ? ' on' : ''}" data-n="${p.n}" data-state="${p.state}" title="Страница ${p.n}">
    <img loading="lazy" src="${API}/books/${S.book.id}/pages/${p.n}/thumb.png" alt=""><span>${p.n}</span><i class="wb-dot" title="${{ none: 'не сконвертирована', done: 'готова', error: 'ошибка', queued: 'в очереди', running: 'обрабатывается' }[p.state]}${p.edited ? ', есть правки' : ''}"></i></button>`).join('');
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

async function openPage(n) {
  if (!S.book) return;
  if (S.dirty && !confirm('Есть несохранённые правки. Перейти без сохранения?')) return;
  S.page = Math.min(S.book.pages, Math.max(1, n));
  savePref({ pages: { ...(loadPref().pages || {}), [S.book.id]: S.page } });
  S.view.querySelector('#wbPage').value = S.page;
  S.layout = null; S.dirty = false; S.selected = -1;
  S.displayLayout = null; S.assets = {}; S.html = '';
  S.view.querySelector('#wbComparison').hidden = true;
  S.view.querySelectorAll('.wb-thumb').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === S.page));
  S.view.querySelector('.wb-thumb.on')?.scrollIntoView({ block: 'nearest' });
  const [job, layout] = await Promise.all([call(`/books/${S.book.id}/pages/${S.page}/job`).catch(() => null), call(`/books/${S.book.id}/pages/${S.page}/layout`).catch(() => null)]);
  S.job = job;
  if (layout) { S.layout = layout.layout; S.displayLayout = layout.view || layout.layout; S.assets = layout.assets; S.html = layout.html; }
  renderSteps(); renderStage(); renderBlocks(); renderActions();
  if (S.castNote) { S.view.querySelector('#wbStatus').textContent = S.castNote; S.castNote = ''; }
  if (job && ['queued', 'running'].includes(job.state)) watchJob();
}

// ---- stage ----

function renderStage() {
  const stage = S.view.querySelector('#wbStage'), scan = `${API}/books/${S.book.id}/pages/${S.page}/scan.png`;
  // Speakers whose avatar the server replaced with a cast portrait are drawn
  // as photos; the stored layout itself stays as converted.
  const shown = S.layout && { ...S.layout, blocks: S.layout.blocks.map((b, n) => {
    const presented = S.displayLayout?.blocks?.[n];
    if (b.type === 'tip' && presented?.type === 'tip') return { ...b, avatar: presented.avatar };
    if (b.type !== 'dialogue' || presented?.type !== 'dialogue') return b;
    return { ...b, turns: b.turns.map((t, k) => ({ ...t, speaker: { ...t.speaker, avatar: presented.turns?.[k]?.speaker?.avatar || t.speaker.avatar } })) };
  }) };
  const web = S.layout ? core.render(shown, { assets: S.assets, editable: true, pinyin: S.pinyin, lang: S.lang }) :`<div class="wb-empty-page">Страница ещё не сконвертирована.<br>Нажмите «Конвертировать страницу».</div>`;
  stage.dataset.mode = S.mode;
  stage.innerHTML = S.mode === 'side'
    ? `<figure class="wb-frame"><figcaption>Оригинал · скан</figcaption><div class="wb-sheet"><img class="wb-scan" src="${scan}" alt="Скан страницы ${S.page}"></div></figure>
       <figure class="wb-frame"><figcaption>Веб-версия</figcaption><div class="wb-sheet wb-web">${web}</div></figure>`
    : `<figure class="wb-frame wb-single"><figcaption>${S.mode === 'diff' ? 'Разница: светлое — расхождение со сканом' : 'Наложение скана на веб-версию'}</figcaption>
       <div class="wb-sheet wb-web">${web}<img class="wb-scan wb-layer" src="${scan}" alt="" style="opacity:${S.mode === 'diff' ? 1 : S.opacity / 100}"></div></figure>`;
  S.view.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
  S.view.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === S.lang)));
  S.view.querySelector('#wbOpacityWrap').hidden = S.mode !== 'overlay';
  S.view.querySelector('#wbOpacity').value = S.opacity;
  S.view.querySelector('#wbPinyin').setAttribute('aria-pressed', String(S.pinyin));
  const page = stage.querySelector('.hsk-page');
  if (page) { core.autoFit(page); markSelected(); }
}

function markSelected() {
  S.view.querySelectorAll('#wbStage .hsk-at').forEach(el => el.classList.toggle('wb-selected', Number(el.dataset.block) === S.selected));
  S.view.querySelectorAll('.wb-blocks button').forEach(el => el.classList.toggle('on', Number(el.dataset.block) === S.selected));
}

// ---- inspector ----

function renderSteps() {
  const steps = S.job?.steps || [['render', 'Рендер страницы PDF'], ['ocr', 'Локальный OCR'], ['model', 'Разметка моделью'], ['layout', 'Привязка к скану'], ['assets', 'Картинки'], ['html', 'HTML-страница']].map(([key, label]) => ({ key, label, status: 'wait' }));
  S.view.querySelector('#wbSteps').innerHTML = steps.map(s => `<li data-status="${s.status}"><i>${STEP_ICON[s.status] || '○'}</i><span>${esc(s.label)}</span><em>${s.ms != null && s.status !== 'wait' ? (s.ms / 1000).toFixed(1) + ' с' : ''}</em>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('');
  const status = S.view.querySelector('#wbStatus');
  const st = S.job?.state;
  status.textContent = st === 'queued' ? 'В очереди…' : st === 'running' ? 'Идёт конвертация…' : st === 'error' ? 'Ошибка: ' + (S.job.error || '') : st === 'done' ? `Построено · сходство требует проверки${S.layout?.cost != null ? ` · модель $${Number(S.layout.cost).toFixed(4)}` : ''}${S.layout?.editedAt ? ' · есть правки' : ''}` : '';
  status.dataset.state = st || '';
}

function renderActions() {
  S.view.querySelector('#wbMeasure').disabled = !S.layout || S.dirty || ['queued', 'running'].includes(S.job?.state);
  S.view.querySelector('#wbCompare').disabled = !S.layout || S.dirty || ['queued', 'running'].includes(S.job?.state);
  const state = S.book?.pageStates.find(p => p.n === S.page) || {};
  const busy = ['queued', 'running'].includes(S.job?.state);
  const btn = S.view.querySelector('#wbConvert');
  btn.disabled = busy || !S.book;
  btn.textContent = busy ? 'Конвертация…' : state.state === 'done' ? 'Пересобрать страницу' : 'Конвертировать страницу';
  S.view.querySelector('#wbCostHint').textContent = !S.book ? '' : state.model ? 'Ответ модели уже есть — пересборка бесплатна.' : 'Будет один платный запрос к модели (обычно $0,02–0,05).';
  S.view.querySelector('#wbRemodel').disabled = busy || !state.model;
  const open = S.view.querySelector('#wbOpen');
  open.hidden = !S.html; if (S.html) open.href = S.html + '?t=' + Date.now();
  S.view.querySelector('#wbSave').disabled = !S.dirty;
  S.view.querySelector('#wbSave').textContent = S.dirty ? 'Сохранить правки' : 'Правок нет';
}

function blockLabel(b) {
  const text = b.cn || b.en || b.text || b.heading?.cn || b.alt || b.turns?.[0]?.hz || b.rows?.[0]?.hz || b.lines?.[0]?.en || '';
  return `${TYPE_NAMES[b.type] || b.type}${text ? ' · ' + text.slice(0, 22) : ''}`;
}

function renderBlocks() {
  const list = S.view.querySelector('#wbBlocks');
  list.innerHTML = S.layout ? S.layout.blocks.map((b, n) => `<button data-block="${n}">${esc(blockLabel(b))}</button>`).join('') : '<span class="wb-muted">Появятся после конвертации.</span>';
  renderGeom();
}

function renderGeom() {
  const box = S.view.querySelector('#wbGeom'), b = S.layout?.blocks[S.selected];
  box.hidden = !b;
  if (!b) return;
  const f = v => (v * 100).toFixed(2);
  box.innerHTML = `<div class="wb-title">${esc(TYPE_NAMES[b.type] || b.type)} <span class="wb-muted">положение в % страницы · Alt+стрелки — сдвиг</span></div>
    <div class="wb-geom-grid">${['x', 'y', 'w', 'h'].map(k => `<label>${{ x: 'Слева', y: 'Сверху', w: 'Ширина', h: 'Высота' }[k]}<input class="input" type="number" step="0.1" data-geom="${k}" value="${f(b.box[k])}"></label>`).join('')}
    ${b.k != null || ['para', 'text', 'card', 'objectives', 'tip', 'words', 'runhead'].includes(b.type) ? `<label>Кегль ×<input class="input" type="number" step="0.02" min="0.5" max="2" data-scale value="${(b.k || 1).toFixed(2)}"></label>` : ''}</div>`;
}

function select(n) { S.selected = n; markSelected(); renderGeom(); }

function markDirty() { S.dirty = true; renderActions(); }

function setBox(n, patch) {
  const b = S.layout.blocks[n];
  b.box = { ...b.box, ...patch };
  for (const k of ['x', 'y']) b.box[k] = Math.max(0, Math.min(0.99, b.box[k]));
  for (const k of ['w', 'h']) b.box[k] = Math.max(0.005, Math.min(1, b.box[k]));
  markDirty(); renderStage(); renderGeom();
}

// ---- conversion ----

async function convert(opts = {}) {
  if (!S.book) return;
  let model;
  try { model = chosenModel(); } catch (e) { const st = S.view.querySelector('#wbStatus'); st.textContent = e.message; st.dataset.state = 'error'; return; }
  const state = S.book.pageStates.find(p => p.n === S.page) || {};
  if (!state.model && !model) { S.view.querySelector('#wbStatus').textContent = 'Выберите модель с поддержкой изображений.'; return; }
  if (S.dirty && !confirm('Пересборка заменит несохранённые правки. Продолжить?')) return;
  if (state.edited && !opts.batch && !confirm('У страницы есть сохранённые правки. Пересборка заменит их. Продолжить?')) return;
  S.job = await call(`/books/${S.book.id}/pages/${S.page}/convert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, ...opts }) });
  S.dirty = false;
  renderSteps(); renderActions(); watchJob(); refreshBook();
}

function watchJob() {
  clearTimeout(S.poll);
  const page = S.page, id = S.book.id;
  const tick = async () => {
    if (S.page !== page || S.book?.id !== id) return;
    S.job = await call(`/books/${id}/pages/${page}/job`).catch(() => S.job);
    renderSteps(); renderActions();
    if (['queued', 'running'].includes(S.job?.state)) { S.poll = setTimeout(tick, 1200); return; }
    await refreshBook();
    if (S.job?.state === 'done') {
      const layout = await call(`/books/${id}/pages/${page}/layout`).catch(() => null);
      if (layout) { S.layout = layout.layout; S.displayLayout = layout.view || layout.layout; S.assets = layout.assets; S.html = layout.html; }
      renderStage(); renderBlocks(); renderSteps(); renderActions();
    }
  };
  S.poll = setTimeout(tick, 800);
}

async function batch() {
  const from = Number(S.view.querySelector('#wbFrom').value), to = Number(S.view.querySelector('#wbTo').value);
  if (!S.book || !(from >= 1 && to >= from && to <= S.book.pages)) { S.view.querySelector('#wbStatus').textContent = 'Укажите диапазон страниц книги.'; return; }
  let model;
  try { model = chosenModel(); } catch (e) { S.view.querySelector('#wbStatus').textContent = e.message; return; }
  const paid = S.book.pageStates.filter(p => p.n >= from && p.n <= to && !p.model).length;
  if (paid && !model) { S.view.querySelector('#wbStatus').textContent = 'Выберите модель для страниц без готовой разметки.'; return; }
  if (!confirm(`Поставить в очередь страницы ${from}–${to}? Платных запросов к модели: ${paid} (обычно $0,02–0,05 за страницу). Страницы с правками будут пересобраны.`)) return;
  for (let n = from; n <= to; n++) await call(`/books/${S.book.id}/pages/${n}/convert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
  S.view.querySelector('#wbStatus').textContent = `В очереди страницы ${from}–${to}. Список слева обновляется сам.`;
  refreshBook(); openPage(S.page);
}

async function save() {
  if (!S.layout || !S.dirty) return;
  const btn = S.view.querySelector('#wbSave');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  try {
    await call(`/books/${S.book.id}/pages/${S.page}/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: { blocks: S.layout.blocks, theme: S.layout.theme } }) });
    S.dirty = false; S.layout.editedAt = new Date().toISOString();
    renderActions(); renderSteps(); refreshBook();
  } catch (e) { btn.disabled = false; btn.textContent = 'Сохранить правки'; S.view.querySelector('#wbStatus').textContent = 'Не удалось сохранить: ' + e.message; }
}

async function exportBook() {
  const out = S.view.querySelector('#wbExportStatus');
  const from = Number(S.view.querySelector('#wbExFrom').value) || 1, to = Number(S.view.querySelector('#wbExTo').value) || S.book.pages;
  out.textContent = 'Собираю страницы…';
  try {
    const r = await call(`/books/${S.book.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) });
    out.innerHTML = `Готово: ${r.pages} стр. <a href="${r.zip}" download>Скачать ZIP</a><br><small>Папка: ${esc(r.folder)}</small>`;
  } catch (e) { out.textContent = 'Не удалось собрать: ' + e.message; }
}

// ---- events ----

async function comparePage() {
  const id = S.book.id, n = S.page, button = S.view.querySelector('#wbCompare'), out = S.view.querySelector('#wbComparison');
  button.disabled = true; out.hidden = false; out.textContent = 'Снимаю отрисованный DOM и сравниваю со сканом…';
  try {
    if (!window.FormaCloneReview?.snapshot) throw new Error('Не загружен модуль снимка страницы. Обновите Forma.');
    S.lang = 'original'; S.mode = 'side'; renderStage();
    const page = S.view.querySelector('.hsk-page');
    await document.fonts.ready;
    await Promise.all([...page.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
    core.fit(page);
    const rendered = new Image(); rendered.src = await window.FormaCloneReview.snapshot(page); await rendered.decode();
    const scan = new Image(); scan.src = `${API}/books/${id}/pages/${n}/scan.png`; await scan.decode();
    const W = rendered.width, H = rendered.height;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(scan, 0, 0, W, H); const a = ctx.getImageData(0, 0, W, H).data;
    ctx.clearRect(0, 0, W, H); ctx.drawImage(rendered, 0, 0, W, H); const renderPng = canvas.toDataURL('image/png'), b = ctx.getImageData(0, 0, W, H).data;
    const diff = ctx.createImageData(W, H); let sum = 0, inkUnion = 0, inkIntersection = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = (Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2])) / 3;
      sum += d;
      const ia = Math.min(a[i],a[i+1],a[i+2]) < 180, ib = Math.min(b[i],b[i+1],b[i+2]) < 180;
      if (ia || ib) inkUnion++; if (ia && ib) inkIntersection++;
      diff.data[i] = 255; diff.data[i+1] = diff.data[i+2] = Math.max(0, 255 - d*3); diff.data[i+3] = 255;
    }
    ctx.putImageData(diff, 0, 0);
    const diffPng = canvas.toDataURL('image/png'), metrics = { width: W, height: H, meanRgbDifference: +(sum/(W*H)).toFixed(3), inkIntersectionOverUnion: inkUnion ? +(inkIntersection/inkUnion).toFixed(4) : 1, pinyin: S.pinyin, original: true, capture: 'computed-style DOM via SVG foreignObject', status: 'needs-review', at: new Date().toISOString() };
    const saved = await call(`/books/${id}/pages/${n}/comparison`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({renderPng,diffPng,metrics}) });
    if (S.book.id !== id || S.page !== n) return;
    out.hidden = false;
    out.innerHTML = `<div class="wb-title">Карта отличий · оригинал</div><a href="${saved.diff}" target="_blank"><img src="${saved.diff}" style="width:100%" alt="Красным отмечены отличия от скана"></a><div class="wb-hint">Красное — различия. Средняя разница RGB: ${metrics.meanRgbDifference} из 255. Это разница пикселей, не процент качества; скрытый пиньинь и заменённые портреты тоже дают отличия.</div><a class="btn-quiet" href="${saved.render}" target="_blank">Открыть снимок HTML</a> <a class="btn-quiet" href="${saved.diff}" download="page-${n}-difference.png">Скачать карту</a>`;
  } catch(e) { if (S.book?.id === id && S.page === n) { out.hidden = false; out.textContent = 'Сравнение не выполнено: ' + e.message; } }
  finally { renderActions(); }
}

function bind() {
  const v = S.view;
  v.querySelector('#wbBook').onchange = e => e.target.value && openBook(e.target.value);
  v.querySelector('#wbFile').onchange = e => upload(e.target.files[0]);
  v.querySelector('#wbPage').onchange = e => openPage(Number(e.target.value));
  v.querySelectorAll('[data-go]').forEach(b => b.onclick = () => openPage(S.page + Number(b.dataset.go)));
  v.querySelector('#wbList').onclick = e => { const t = e.target.closest('.wb-thumb'); if (t) openPage(Number(t.dataset.n)); };
  v.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; savePref({ mode: S.mode }); renderStage(); });
  v.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => { S.lang = b.dataset.lang; savePref({ lang: S.lang }); renderStage(); });
  v.querySelector('#wbOpacity').oninput = e => { S.opacity = Number(e.target.value); const l = v.querySelector('.wb-layer'); if (l) l.style.opacity = S.opacity / 100; };
  v.querySelector('#wbOpacity').onchange = () => savePref({ opacity: S.opacity });
  v.querySelector('#wbPinyin').onclick = () => { S.pinyin = !S.pinyin; renderStage(); };
  v.querySelector('#wbConvert').onclick = () => convert();
  v.querySelector('#wbCompare').onclick = comparePage;
  v.querySelector('#wbMeasure').onclick = async () => {
    const btn = v.querySelector('#wbMeasure'); btn.disabled = true;
    try { const r = await call(`/books/${S.book.id}/pages/${S.page}/measure`, { method: 'POST' }); await openPage(S.page); v.querySelector('#wbStatus').textContent = `Уточнено по OCR: ${r.lines} строк, ${r.dialogueTurns} реплик. Проверьте оригинал рядом со сканом.`; }
    catch (e) { v.querySelector('#wbStatus').textContent = 'Не удалось уточнить: ' + e.message; }
    finally { renderActions(); }
  };
  v.querySelector('#wbRemodel').onclick = () => confirm('Сделать новый платный запрос к модели для этой страницы?') && convert({ forceModel: true });
  v.querySelector('#wbBatch').onclick = batch;
  v.querySelector('#wbSave').onclick = save;
  v.querySelector('#wbExport').onclick = exportBook;
  v.querySelector('#wbBlocks').onclick = e => { const b = e.target.closest('[data-block]'); if (b) select(Number(b.dataset.block)); };
  const stage = v.querySelector('#wbStage');
  stage.addEventListener('click', e => { const el = e.target.closest('.hsk-at[data-block]'); if (el && !e.target.isContentEditable) select(Number(el.dataset.block)); });
  stage.addEventListener('focusin', e => { const el = e.target.closest('.hsk-at[data-block]'); if (el) select(Number(el.dataset.block)); });
  stage.addEventListener('input', e => {
    const f = e.target.closest('[data-hsk-path]');
    if (!f || !S.layout) return;
    core.setField(S.layout, Number(f.dataset.hskBlock), f.dataset.hskPath, f.textContent.trim());
    markDirty();
  });
  stage.addEventListener('dragover', e => { if (!S.book) e.preventDefault(); });
  stage.addEventListener('drop', e => { if (S.book) return; e.preventDefault(); upload(e.dataTransfer.files[0]); });
  v.querySelector('#wbGeom').addEventListener('change', e => {
    const n = S.selected, b = S.layout?.blocks[n];
    if (!b) return;
    if (e.target.dataset.geom) setBox(n, { [e.target.dataset.geom]: Number(e.target.value) / 100 });
    if (e.target.dataset.scale != null) { b.k = Math.max(0.5, Math.min(2, Number(e.target.value) || 1)); markDirty(); renderStage(); }
  });
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (!S.view?.isConnected) { document.removeEventListener('keydown', onKey); return; }
  if (e.target.closest?.('input, select, textarea, [contenteditable=true]')) return;
  if (e.altKey && S.selected >= 0 && S.layout && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 0.005 : 0.001, b = S.layout.blocks[S.selected].box;
    setBox(S.selected, { ArrowLeft: { x: b.x - step }, ArrowRight: { x: b.x + step }, ArrowUp: { y: b.y - step }, ArrowDown: { y: b.y + step } }[e.key]);
    return;
  }
  if (e.key === 'ArrowLeft') openPage(S.page - 1);
  if (e.key === 'ArrowRight') openPage(S.page + 1);
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
}

// Entry point called by the studio router (index.html).
window.renderWebBook = async function renderWebBook(view) {
  clearTimeout(S.poll); clearTimeout(S.statePoll);
  S.view = view;
  shell(); bind();
  try { await loadBooks(); }
  catch (e) { view.querySelector('#wbStatus').textContent = 'Конвертер недоступен: ' + e.message + '. Перезапустите студию.'; }
};

