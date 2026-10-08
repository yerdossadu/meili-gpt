// Forma "PDF → Web" console: the studio page that drives the conversion
// service (webbook/server.mjs) and edits its results. Pages are drawn with the
// same core renderer the exported site uses, so what you see is what ships.
import * as core from './core.mjs';
import { autoRequest, pageJobs, startRebuild, rebuiltPageUrl } from './rebuild-client.mjs';

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
  // A fresh browser has no cast to sync; preserve the saved book characters.
  if (!chars.length && !Object.keys(manual).length) return { changed: false };
  const signature = JSON.stringify([chars.map((c, i) => [c.id, c.names, files[i]?.size || 0, files[i]?.type || '']), manual]);
  const current = await call(`/books/${bookId}/cast`).catch(() => ({}));
  if (current.signature === signature) return { changed: false };
  const characters = await Promise.all(chars.map(async (c, i) => ({ ...c, image: files[i] ? await portraitDataUrl(files[i]).catch(() => '') : '' })));
  const result = await call(`/books/${bookId}/cast`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characters, manual, signature }) });
  return { changed: true, ...result };
}
window.formaWebbookSyncCast = syncCast;

const S = {
  view: null, books: [], book: null, page: 1,
  layout: null, assets: {}, dirty: false, selected: -1,
  mode: 'side', opacity: 50, lang: 'russian', pinyin: false,
  job: null, poll: 0, statePoll: 0
};

// ---- markup ----

function shell() {
  const pref = loadPref();
  S.mode = pref.mode || 'side'; S.opacity = pref.opacity ?? 50; S.lang = pref.lang || 'russian';
  S.view.innerHTML = `
  <div class="heading"><div><div class="eyebrow">Учебные материалы / PDF → Web</div><h1>PDF → Web</h1>
    <p>Перенос исходного дизайна PDF в веб-версию или создание редактируемых учебных блоков через OCR и ИИ.</p></div>
    <span class="badge">PDF2HTMLEX · OCR + ИИ</span></div>
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
          <button data-mode="side">Рядом</button><button data-mode="overlay">Наложение</button><button data-mode="diff">Разница</button><button data-mode="map" title="Где веб-страница расходится со сканом">Карта</button>
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
        <div class="wb-hint" id="wbCostHint"></div>
        <details class="wb-more"><summary>Ещё</summary>
          <button class="btn-quiet" id="wbRemodel" title="Новый платный запрос к модели для этой страницы">Запросить модель заново</button>
          <div class="wb-range"><span>Страницы</span><input class="input" id="wbFrom" type="number" min="1"><span>–</span><input class="input" id="wbTo" type="number" min="1"><button class="btn-quiet" id="wbBatch">Конвертировать</button></div>
        </details>
      </div>
      <div class="wb-block"><div class="wb-title">Конвейер</div><ol id="wbSteps" class="wb-steps"></ol><div class="status" id="wbStatus"></div></div>
      <div class="wb-block"><div class="wb-title">Блоки <span class="wb-muted">клик — выбрать; ✥ — перетащить, уголки — размер, A−/A+ или Alt+колесо — шрифт; текст правится прямо на странице; Esc или клик по пустому месту — закончить</span></div><div id="wbBlocks" class="wb-blocks"></div><div id="wbGeom" class="wb-geom" hidden></div></div>
      <div class="wb-block wb-save"><button class="btn" id="wbSave" disabled>Сохранить правки</button><button class="btn-quiet" id="wbUndo" disabled title="Отменить последнее действие (Ctrl+Z)">↶ Шаг назад</button><button class="btn-quiet" id="wbDiscard" disabled title="Вернуть страницу к последнему сохранению">Отменить правки</button><a class="btn-quiet" id="wbOpen" target="_blank" rel="noopener">Открыть HTML</a></div>
      <div class="wb-block wb-fid"><div class="wb-title">Сходство со сканом <span class="wb-muted" id="wbFidWhen"></span></div>
        <div class="wb-fid-row"><b id="wbFidScore" data-level="">—</b><span id="wbFidParts" class="wb-muted"></span></div>
        <div class="wb-fid-btns"><button class="btn-quiet" id="wbFidMap">Карта</button><button class="btn-quiet" id="wbFidRun">Пересчитать</button>
          <label class="wb-check" title="Эталон: принятая страница. Конвертер проверяется по эталонам, чтобы улучшения не портили готовые страницы"><input type="checkbox" id="wbGolden"> ★ Эталон</label></div>
        <details class="wb-more"><summary>Проверка эталонов</summary>
          <button class="btn-quiet" id="wbGoldenCheck">Проверить все эталоны</button><div class="status wb-golden-out" id="wbGoldenOut"></div></details>
      </div>
      <div class="wb-block wb-publish"><div class="wb-title">Платформа Meili HSK Study <span class="wb-muted" id="wbPubState"></span></div>
        <button class="btn" id="wbPublish" disabled>Подтвердить и опубликовать</button>
        <div class="status" id="wbPubStatus"></div>
        <details class="wb-more" id="wbPubMore"><summary>Настройки и пакетная публикация</summary>
          <label class="wb-field"><span>Адрес платформы</span><input class="input" id="wbPlatUrl" placeholder="https://chao-hsk-study.onrender.com"></label>
          <label class="wb-field"><span>Токен публикации <small class="wb-muted">хранится только в памяти сервера студии</small></span><input class="input" id="wbPlatToken" type="password" autocomplete="off" placeholder="FORMA_PUBLISH_TOKEN"></label>
          <div class="wb-geom-grid"><label>Раздел<input class="input" id="wbPlatSection" placeholder="HSK 1 v3.0"></label><label>Уровень<input class="input" id="wbPlatLevel" placeholder="HSK 1"></label><label>Код книги<input class="input" id="wbPlatSlug" placeholder="hsk1-v3"></label></div>
          <button class="btn-quiet" id="wbPlatSave">Сохранить и проверить связь</button>
          <div class="wb-range"><span>Страницы</span><input class="input" id="wbPubFrom" type="number" min="1"><span>–</span><input class="input" id="wbPubTo" type="number" min="1"><button class="btn-quiet" id="wbPubBatch">Опубликовать</button></div>
          <button class="btn-quiet" id="wbUnpublish" disabled>Снять страницу с платформы</button>
        </details>
      </div>
      <div class="wb-block wb-kz"><div class="wb-title">Қазақша <span class="wb-muted">перевод русского слоя через Qwen (подписка Alibaba)</span></div>
        <div class="wb-fid-btns"><button class="btn-quiet" id="wbKz">Перевести страницу</button><button class="btn-quiet" id="wbKzAll" title="Все опубликованные страницы: только непереведённые строки">Все опубликованные</button></div>
        <div class="status" id="wbKzStatus"></div></div>
      <div class="wb-block wb-audio"><div class="wb-title">Аудио учебника <span class="wb-muted" id="wbAudioState"></span></div>
        <p class="wb-muted wb-audio-hint">Значки 🔊 с номером («1-3») становятся кнопками, когда в книге есть эта дорожка. Укажите папку с аудио учебника — файлы с номерами вида «1-3», «01_03», «Track 1-3» разложатся сами.</p>
        <div class="wb-range"><input class="input" id="wbAudioFolder" placeholder="C:\Users\…\Desktop\HSK1 учебник аудио" aria-label="Папка с аудио учебника"><button class="btn-quiet" id="wbAudioImport">Импортировать</button></div>
        <div class="status" id="wbAudioStatus"></div>
        <details class="wb-more" id="wbAudioMissing" hidden><summary>Каких дорожек не хватает</summary><div class="wb-audio-list" id="wbAudioList"></div></details></div>
      <div class="wb-block"><div class="wb-title">Выгрузка ZIP</div>
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
  loadPlatform();
  const folder = S.view.querySelector('#wbAudioFolder'); if (folder && !folder.value) folder.value = loadPref().audioFolder || '';
  loadAudio();
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
  S.view.querySelector('#wbDone').textContent = `${states.filter(p => p.state === 'done').length} готово`;
  list.innerHTML = states.map(p => `<button class="wb-thumb${p.n === S.page ? ' on' : ''}" data-n="${p.n}" data-state="${p.state}" title="Страница ${p.n}">
    <img loading="lazy" src="${API}/books/${S.book.id}/pages/${p.n}/thumb.png" alt=""><span>${p.n}</span><i class="wb-dot" title="${{ none: 'не сконвертирована', done: 'готова', error: 'ошибка', queued: 'в очереди', running: 'обрабатывается' }[p.state]}${p.edited ? ', есть правки' : ''}"></i>${p.score != null && p.state === 'done' ? `<b class="wb-score" data-level="${scoreLevel(p.score)}" title="Сходство со сканом">${Math.round(p.score)}</b>` : ''}${p.golden ? '<em class="wb-gold" title="Эталон">★</em>' : ''}${p.published ? `<em class="wb-pub${p.stale ? ' stale' : ''}" title="${p.stale ? 'Опубликована, но изменена после публикации' : 'Опубликована на платформе'}">${p.stale ? '↻' : '✓'}</em>` : ''}</button>`).join('');
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

async function openPage(n) {
  if (!S.book) return;
  if (S.dirty && !confirm('Есть несохранённые правки. Перейти без сохранения?')) return;
  S.page = Math.min(S.book.pages, Math.max(1, n));
  savePref({ pages: { ...(loadPref().pages || {}), [S.book.id]: S.page } });
  S.view.querySelector('#wbPage').value = S.page;
  S.layout = null; S.dirty = false; S.selected = -1;
  S.autoJob = null; S.autoResult = null; clearTimeout(S.autoPoll);
  S.view.querySelectorAll('.wb-thumb').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === S.page));
  S.view.querySelector('.wb-thumb.on')?.scrollIntoView({ block: 'nearest' });
  const [job, layout] = await Promise.all([call(`/books/${S.book.id}/pages/${S.page}/job`).catch(() => null), call(`/books/${S.book.id}/pages/${S.page}/layout`).catch(() => null)]);
  S.job = job; S.fid = null;
  if (layout) { S.layout = layout.layout; S.layout.sourceLines = layout.view?.sourceLines; S.layout.phonetics = layout.view?.phonetics; S.layout.sourceRegions = layout.view?.sourceRegions; S.assets = layout.assets; S.html = layout.html; }
  resetHistory();
  renderSteps(); renderStage(); renderBlocks(); renderActions();
  loadFidelity();
  if (S.castNote) { S.view.querySelector('#wbStatus').textContent = S.castNote; S.castNote = ''; }
  if (job && ['queued', 'running'].includes(job.state)) watchJob();
  await loadRebuiltPage(S.book.id, S.page);
}

// ---- stage ----

function renderStage() {
  const stage = S.view.querySelector('#wbStage'), scan = `${API}/books/${S.book.id}/pages/${S.page}/scan.png`;
  // Speakers whose avatar the server replaced with a cast portrait are drawn
  // as photos; the stored layout itself stays as converted.
  const shown = S.layout && { ...S.layout, blocks: S.layout.blocks.map((b, n) => b.type !== 'dialogue' ? b : { ...b, turns: b.turns.map((t, k) => String(S.assets?.[`ava-${n}-${k}`] || '').includes('/cast/') ? { ...t, speaker: { ...t.speaker, avatar: 'photo' } } : t) }) };
  const web = S.layout ? core.render(shown, { assets: S.assets, editable: true, pinyin: S.pinyin, lang: S.lang }) :`<div class="wb-empty-page">Страница ещё не сконвертирована.<br>Нажмите «Конвертировать страницу».</div>`;
  stage.dataset.mode = S.mode;
  const map = S.fid?.at ? `/library/${S.book.id}/pages/${String(S.page).padStart(3, '0')}/fidelity.png?v=${Date.parse(S.fid.at)}` : '';
  stage.innerHTML = S.mode === 'map'
    ? `<figure class="wb-frame"><figcaption>Веб-версия</figcaption><div class="wb-sheet wb-web">${web}</div></figure>
       <figure class="wb-frame"><figcaption>Карта: <span class="wb-key r">нет на веб-странице</span> <span class="wb-key b">лишнее</span> <span class="wb-key y">другой цвет</span> <span class="wb-key f">худшие участки</span></figcaption>
       <div class="wb-sheet">${map ? `<img class="wb-scan" src="${map}" alt="Карта расхождений страницы ${S.page}">` : '<div class="wb-empty-page">Карты ещё нет.<br>Нажмите «Пересчитать» справа.</div>'}</div></figure>`
    : S.mode === 'side'
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
  drawFrame();
}

// ---- mouse editor ----
// The selected block gets a frame over the web page: drag the grip to move
// it, the handles to resize it, and A− / A+ (or Alt+wheel) to change its
// type size. Text inside stays editable by clicking it.

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function pageOf() { return S.view.querySelector('#wbStage .wb-web .hsk-page'); }

function placeFrame(frame, box, page) {
  frame.style.left = page.offsetLeft + box.x * page.offsetWidth + 'px';
  frame.style.top = page.offsetTop + box.y * page.offsetHeight + 'px';
  frame.style.width = box.w * page.offsetWidth + 'px';
  frame.style.height = box.h * page.offsetHeight + 'px';
}

function drawFrame() {
  const page = pageOf();
  S.view.querySelector('#wbStage .wb-edit')?.remove();
  const b = S.layout?.blocks[S.selected];
  if (!page || !b) return;
  const frame = document.createElement('div');
  frame.className = 'wb-edit';
  const sized = b.type !== 'image' && b.type !== 'decor';
  frame.innerHTML = `<button type="button" class="wb-grip" data-drag="move" title="Перетащить блок">✥</button>${HANDLES.map(h => `<i data-drag="${h}"></i>`).join('')}`
    + (sized ? `<div class="wb-edit-bar"><button type="button" data-font="-1" title="Шрифт меньше (Alt+колесо)">A−</button><span>${Math.round((b.k || 1) * 100)}%</span><button type="button" data-font="1" title="Шрифт больше (Alt+колесо)">A+</button>${b.kManual ? '<button type="button" data-font="0" title="Вернуть автоматический размер">↺</button>' : ''}<button type="button" data-bold class="${b.bold ? 'on' : ''}" title="Жирный шрифт (Ctrl+B)"><b>B</b></button></div>` : '');
  placeFrame(frame, b.box, page);
  page.parentElement.append(frame);
}

// Every box nested in a block (avatars, bubbles, names, pictures) follows
// the block: moved with it and scaled when it is resized.
function carry(b, from, to) {
  const sx = to.w / from.w, sy = to.h / from.h;
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (o !== b.box && ['x', 'y', 'w', 'h'].every(k => typeof o[k] === 'number')) {
      o.x = to.x + (o.x - from.x) * sx; o.y = to.y + (o.y - from.y) * sy; o.w *= sx; o.h *= sy;
      return;
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'box' && v && typeof v === 'object') walk(v);
  };
  walk(b);
  b.box = to;
}

function startDrag(e, mode) {
  const n = S.selected, b = S.layout?.blocks[n], page = pageOf();
  if (!b || !page) return;
  e.preventDefault();
  const start = { ...b.box }, pw = page.offsetWidth, ph = page.offsetHeight, sx = e.clientX, sy = e.clientY;
  const frame = S.view.querySelector('#wbStage .wb-edit');
  const els = [...page.querySelectorAll(`[data-block="${n}"]`)];
  let moved = false;
  const onMove = ev => {
    const dx = (ev.clientX - sx) / pw, dy = (ev.clientY - sy) / ph, r = { ...start }, min = 0.01;
    if (mode === 'move') { r.x += dx; r.y += dy; }
    if (mode.includes('w')) { r.x = Math.min(start.x + start.w - min, start.x + dx); r.w = start.x + start.w - r.x; }
    if (mode.includes('e')) r.w = Math.max(min, start.w + dx);
    if (mode.includes('n')) { r.y = Math.min(start.y + start.h - min, start.y + dy); r.h = start.y + start.h - r.y; }
    if (mode.includes('s')) r.h = Math.max(min, start.h + dy);
    r.x = Math.max(0, Math.min(1 - r.w, r.x)); r.y = Math.max(0, Math.min(1 - r.h, r.y));
    moved = true;
    carry(b, b.box, r);
    for (const el of els) {
      el.style.left = (r.x * 100).toFixed(3) + '%'; el.style.top = (r.y * 100).toFixed(3) + '%'; el.style.width = (r.w * 100).toFixed(3) + '%';
      if (el.style.height) el.style.height = (r.h * 100).toFixed(3) + '%';
    }
    placeFrame(frame, r, page);
  };
  const onUp = () => {
    removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
    if (moved) { markDirty(); renderStage(); renderGeom(); }
  };
  addEventListener('pointermove', onMove); addEventListener('pointerup', onUp);
}

function toggleBold() {
  const b = S.layout?.blocks[S.selected];
  if (!b || b.type === 'image' || b.type === 'decor') return;
  if (b.bold) delete b.bold; else b.bold = true;
  markDirty(); renderStage();
}

function changeFont(dir) {
  const b = S.layout?.blocks[S.selected];
  if (!b) return;
  if (dir === 0) { if (b.kAuto !== undefined) { if (b.kAuto == null) delete b.k; else b.k = b.kAuto; } delete b.kAuto; delete b.kManual; }
  else {
    if (!b.kManual) b.kAuto = b.k ?? null;
    b.k = +Math.max(0.5, Math.min(2.5, (b.k || 1) + dir * 0.05)).toFixed(2);
    b.kManual = true;
  }
  markDirty(); renderStage(); renderGeom();
}

// ---- inspector ----

function renderSteps() {
  if (S.autoJob) {
    S.view.querySelector('#wbSteps').innerHTML = '<li>PDF → распознавание структуры → повторное OCR → проверка пиньиня и пропусков → HTML/CSS и отдельные иллюстрации</li>';
    const status = S.view.querySelector('#wbStatus');
    status.dataset.state = S.autoJob.state;
    status.textContent = S.autoJob.state === 'done' ? `HTML/CSS создан.${S.layout?.validation?.state==='review' ? ' Есть сомнительные фрагменты: '+S.layout.validation.warnings.length+'.' : ''} Требуется сравнение с оригиналом.` : S.autoJob.state === 'error' ? 'Ошибка: ' + S.autoJob.error : S.autoJob.state === 'queued' ? 'Конвертация в очереди.' : 'Идёт локальное распознавание и сборка HTML/CSS. Для одной страницы это может занять несколько минут.';
    return;
  }
  const steps = S.job?.steps || [['render', 'Рендер страницы PDF'], ['ocr', 'Локальный OCR'], ['model', 'Разметка моделью'], ['layout', 'Привязка к скану'], ['assets', 'Картинки'], ['html', 'HTML-страница']].map(([key, label]) => ({ key, label, status: 'wait' }));
  S.view.querySelector('#wbSteps').innerHTML = steps.map(s => `<li data-status="${s.status}"><i>${STEP_ICON[s.status] || '○'}</i><span>${esc(s.label)}</span><em>${s.ms != null && s.status !== 'wait' ? (s.ms / 1000).toFixed(1) + ' с' : ''}</em>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('');
  const status = S.view.querySelector('#wbStatus');
  const st = S.job?.state;
  status.textContent = st === 'queued' ? 'В очереди…' : st === 'running' ? 'Идёт конвертация…' : st === 'error' ? 'Ошибка: ' + (S.job.error || '') : st === 'done' ? `Готово${S.layout?.cost != null ? ` · модель $${Number(S.layout.cost).toFixed(4)}` : ''}${S.layout?.editedAt ? ' · есть правки' : ''}` : '';
  status.dataset.state = st || '';
}

function renderActions() {
  const state = S.book?.pageStates.find(p => p.n === S.page) || {};
  const busy = ['queued', 'running'].includes(S.autoJob?.state) || ['queued', 'running'].includes(S.job?.state);
  const btn = S.view.querySelector('#wbConvert');
  btn.disabled = busy || !S.book;
  btn.textContent = busy ? 'Конвертация…' : state.state === 'done' ? 'Пересобрать страницу' : 'Конвертировать страницу';
  S.view.querySelector('#wbCostHint').textContent = 'Пересборка использует улучшенный локальный OCR → HTML/CSS-конвейер; предыдущая версия сохраняется.';
  S.view.querySelector('#wbRemodel').disabled = busy || !state.model;
  const open = S.view.querySelector('#wbOpen');
  const shownHtml = S.html;
  open.hidden = !shownHtml; if (shownHtml) open.href = shownHtml + '?t=' + Date.now();
  S.view.querySelector('#wbSave').disabled = !S.dirty;
  S.view.querySelector('#wbSave').textContent = S.dirty ? 'Сохранить правки' : 'Правок нет';
  S.view.querySelector('#wbUndo').disabled = !S.history?.length;
  renderPublish();
  S.view.querySelector('#wbDiscard').disabled = !S.dirty;
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

// Done with a block: no frame, no highlighted text field.
function deselect() {
  if (document.activeElement?.isContentEditable) document.activeElement.blur();
  select(-1);
}

// ---- undo ----
// Snapshots of the page's blocks: `saved` is the last saved state, `history`
// the states before each edit. Typing in one text is one step, not one per key.

function resetHistory() {
  S.history = [];
  S.saved = S.snap = S.layout ? JSON.stringify(S.layout.blocks) : null;
  S.lastTyping = 0;
}

function markDirty(typing = false) {
  if (S.layout) {
    const now = JSON.stringify(S.layout.blocks);
    const merge = typing && Date.now() - S.lastTyping < 1500;
    if (now !== S.snap) { if (!merge && S.snap != null) S.history.push(S.snap); if (S.history.length > 200) S.history.shift(); S.snap = now; }
    S.lastTyping = typing ? Date.now() : 0;
    S.dirty = now !== S.saved;
  } else S.dirty = true;
  renderActions();
}

function restore(json) {
  S.layout.blocks = JSON.parse(json);
  S.snap = json; S.dirty = json !== S.saved;
  if (S.selected >= S.layout.blocks.length) S.selected = -1;
  renderStage(); renderBlocks(); renderActions();
}

function undo() {
  if (!S.layout || !S.history?.length) return;
  restore(S.history.pop());
}

function discard() {
  if (!S.layout || !S.dirty || S.saved == null) return;
  if (!confirm('Отменить все несохранённые правки этой страницы?')) return;
  S.history = [];
  restore(S.saved);
}

function setBox(n, patch) {
  const b = S.layout.blocks[n], r = { ...b.box, ...patch };
  for (const k of ['x', 'y']) r[k] = Math.max(0, Math.min(0.99, r[k]));
  for (const k of ['w', 'h']) r[k] = Math.max(0.005, Math.min(1, r[k]));
  carry(b, b.box, r);
  markDirty(); renderStage(); renderGeom();
}

// ---- conversion ----

async function convert(opts = {}) {
  if (!S.book) return;
  if (!opts.forceModel) {
    const book = S.book.id, page = S.page;
    try {
      if (S.dirty) { S.view.querySelector('#wbStatus').textContent = 'Сначала сохраните или отмените несохранённые правки.'; return; }
      S.autoJob = {state: 'queued'}; renderSteps(); renderActions();
      const job = await startRebuild(book, page);
      if (S.book?.id !== book || S.page !== page) return;
      S.autoJob = job;
      savePref({legacyPages: {...loadPref().legacyPages, [book + ':' + page]: false}});
      await loadRebuiltPage(book, page);
    } catch (error) {
      if (S.book?.id !== book || S.page !== page) return;
      S.autoJob = {state: 'error', error: error.message}; renderSteps(); renderActions();
    }
    return;
  }
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

async function loadRebuiltPage(book, page) {
  clearTimeout(S.autoPoll);
  try {
    const jobs = pageJobs(await autoRequest(book), page);
    if (S.book?.id !== book || S.page !== page) return;
    if (loadPref().legacyPages?.[book + ':' + page]) return;
    const latest = jobs[0];
    if (!latest) return;
    S.autoJob = latest;
    const completed = jobs.find(j => j.state === 'done' && j.canonical?.[page]) || null;
    S.autoResult = null;
    if (completed && !S.dirty) {
      const current = await call(`/books/${book}/pages/${page}/layout`);
      if (S.book?.id !== book || S.page !== page) return;
      if (current.layout.conversionId !== S.layout?.conversionId) {
        S.layout=current.layout;S.assets=current.assets;S.html=current.html;
        S.layout.sourceLines=current.view?.sourceLines;S.layout.phonetics=current.view?.phonetics;
        resetHistory();await refreshBook();renderStage();renderBlocks();
      }
    }
    renderSteps(); renderActions();
    if (['queued','running'].includes(latest.state)) S.autoPoll = setTimeout(() => loadRebuiltPage(book, page), 2000);
  } catch (error) {
    if (S.book?.id === book && S.page === page) {
      S.view.querySelector('#wbStatus').textContent = 'Не удалось проверить HTML/CSS: ' + error.message;
      if (['queued','running'].includes(S.autoJob?.state)) S.autoPoll = setTimeout(() => loadRebuiltPage(book, page), 4000);
    }
  }
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
      if (layout) { S.layout = layout.layout; S.assets = layout.assets; S.html = layout.html; }
      resetHistory();
      renderStage(); renderBlocks(); renderSteps(); renderActions();
      awaitFidelity();
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
    S.saved = S.snap = JSON.stringify(S.layout.blocks);
    deselect();
    // A published page is sent to the platform after saving: refresh its
    // status once the upload has had time to finish.
    if (S.book.pageStates.find(p => p.n === S.page)?.published) { setTimeout(() => refreshBook().then(renderPublish), 4000); setTimeout(() => refreshBook().then(renderPublish), 12000); }
    renderActions(); renderSteps(); refreshBook(); awaitFidelity();
  } catch (e) { btn.disabled = false; btn.textContent = 'Сохранить правки'; S.view.querySelector('#wbStatus').textContent = 'Не удалось сохранить: ' + e.message; }
}

// ---- fidelity & golden pages ----
// The server scores every page against its scan a moment after it is
// converted or saved; the console shows the score and the map of
// differences, and marks approved pages as golden (see regress.mjs).

const scoreLevel = s => s >= 85 ? 'good' : s >= 75 ? 'mid' : 'low';
const pct = v => Math.round(v * 100) + '%';

async function loadFidelity() {
  if (!S.book) return;
  const page = S.page, fid = await call(`/books/${S.book.id}/pages/${page}/fidelity`).catch(() => ({}));
  if (page !== S.page) return;
  const changed = (fid.at || '') !== (S.fid?.at || '');
  S.fid = fid.at ? fid : null;
  renderFidelity();
  if (changed && S.mode === 'map') renderStage();
}

// After a conversion or a save the new score arrives a few seconds later.
function awaitFidelity() {
  clearTimeout(S.fidPoll);
  const page = S.page, since = Date.now(); let tries = 0;
  const tick = async () => {
    if (page !== S.page) return;
    await loadFidelity();
    if ((!S.fid || Date.parse(S.fid.at) < since - 1000) && ++tries < 10) S.fidPoll = setTimeout(tick, 2500);
    else refreshBook();
  };
  renderFidelity(true);
  S.fidPoll = setTimeout(tick, 3500);
}

function renderFidelity(pending = false) {
  const v = S.view, f = S.fid, st = S.book?.pageStates.find(p => p.n === S.page) || {};
  const score = v.querySelector('#wbFidScore');
  score.textContent = f ? Math.round(f.score) : '—';
  score.dataset.level = f ? scoreLevel(f.score) : '';
  v.querySelector('#wbFidParts').textContent = f ? `структура ${pct(f.ssim)} · знаки ${pct(f.ink)} · цвет ${pct(f.colour)}` : st.state === 'done' ? 'ещё не считалось' : '';
  const old = f && S.layout?.editedAt && Date.parse(S.layout.editedAt) > Date.parse(f.at) + 2000;
  v.querySelector('#wbFidWhen').textContent = pending ? '· считается…' : old ? '· до последних правок' : f ? '· ' + new Date(f.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '';
  v.querySelector('#wbFidRun').disabled = st.state !== 'done';
  v.querySelector('#wbFidMap').disabled = !f;
  const g = v.querySelector('#wbGolden');
  g.checked = Boolean(st.golden); g.disabled = st.state !== 'done';
}

async function runFidelity() {
  const btn = S.view.querySelector('#wbFidRun');
  btn.disabled = true; renderFidelity(true);
  try { S.fid = await call(`/books/${S.book.id}/pages/${S.page}/fidelity`, { method: 'POST' }); }
  catch (e) { S.view.querySelector('#wbFidWhen').textContent = '· ошибка: ' + e.message; }
  renderFidelity(); refreshBook();
  if (S.mode === 'map') renderStage();
}

async function toggleGolden(on) {
  try { await call(`/books/${S.book.id}/pages/${S.page}/golden`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) }); }
  catch (e) { S.view.querySelector('#wbGoldenOut').textContent = e.message; }
  await refreshBook(); renderFidelity();
}

async function checkGolden() {
  const out = S.view.querySelector('#wbGoldenOut'), btn = S.view.querySelector('#wbGoldenCheck');
  btn.disabled = true; out.dataset.state = 'running';
  out.textContent = 'Пересобираю эталонные страницы в песочнице и сравниваю (≈5 с на страницу)…';
  try {
    const r = await call(`/books/${S.book.id}/golden-check`, { method: 'POST' });
    out.innerHTML = r.lines.map(esc).join('<br>');
    out.dataset.state = r.regressions ? 'error' : 'done';
  } catch (e) { out.textContent = e.message; out.dataset.state = 'error'; }
  btn.disabled = false;
}

// ---- publishing to the platform ----

async function loadPlatform() {
  const v = S.view;
  const [settings, book] = await Promise.all([call('/platform').catch(() => ({})), S.book ? call(`/books/${S.book.id}/platform`).catch(() => ({})) : {}]);
  S.platform = settings;
  v.querySelector('#wbPlatUrl').value = settings.url || '';
  v.querySelector('#wbPlatToken').placeholder = settings.hasToken ? 'токен введён — можно заменить' : 'FORMA_PUBLISH_TOKEN';
  v.querySelector('#wbPlatSection').value = book.section || 'HSK 1 v3.0';
  v.querySelector('#wbPlatLevel').value = book.level || 'HSK 1';
  v.querySelector('#wbPlatSlug').value = book.slug || 'hsk1-v3';
  const from = v.querySelector('#wbPubFrom'), to = v.querySelector('#wbPubTo');
  if (!from.value) from.value = S.page || 1; if (!to.value) to.value = S.page || 1;
  if (!settings.url || !settings.hasToken) v.querySelector('#wbPubMore').open = true;
  renderPublish();
}

function renderPublish() {
  const v = S.view, st = S.book?.pageStates.find(p => p.n === S.page) || {};
  const ready = st.state === 'done' && !['queued', 'running'].includes(S.job?.state) && !['queued', 'running'].includes(S.autoJob?.state);
  v.querySelector('#wbPublish').disabled = !ready || S.dirty;
  v.querySelector('#wbPublish').title = S.dirty ? 'Сначала сохраните правки' : '';
  v.querySelector('#wbPublish').textContent = st.published ? (st.stale ? 'Опубликовать изменения' : 'Опубликовать заново') : 'Подтвердить и опубликовать';
  v.querySelector('#wbUnpublish').disabled = !st.published;
  const when = st.published ? new Date(st.published).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '';
  // Published pages follow studio edits on their own (see autoRepublish on
  // the server); a failed automatic update is shown here.
  v.querySelector('#wbPubState').textContent = !st.published ? '· не опубликована'
    : st.pubError ? `· автообновление не прошло: ${st.pubError}`
    : st.stale ? `· опубликована ${when}, обновляется…` : `· опубликована ${when}, обновляется автоматически`;
}

async function savePlatform() {
  const v = S.view, out = v.querySelector('#wbPubStatus');
  out.textContent = 'Проверяю связь с платформой…'; out.dataset.state = '';
  try {
    const token = v.querySelector('#wbPlatToken').value.trim();
    const settings = await call('/platform', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: v.querySelector('#wbPlatUrl').value, ...(token ? { token } : {}) }) });
    v.querySelector('#wbPlatToken').value = '';
    if (S.book) await call(`/books/${S.book.id}/platform`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: v.querySelector('#wbPlatSection').value, level: v.querySelector('#wbPlatLevel').value, slug: v.querySelector('#wbPlatSlug').value }) });
    S.platform = settings;
    out.textContent = !settings.url ? 'Укажите адрес платформы.' : !settings.hasToken ? 'Введите токен публикации.' : settings.check === 'ok' ? 'Связь с платформой есть, публикация доступна.' : 'Платформа не приняла подключение: ' + settings.check;
    out.dataset.state = settings.check === 'ok' ? 'done' : 'error';
    await loadPlatform();
  } catch (e) { out.textContent = e.message; out.dataset.state = 'error'; }
}

async function publishPages(from, to) {
  const out = S.view.querySelector('#wbPubStatus');
  const pages = S.book.pageStates.filter(p => p.n >= from && p.n <= to && p.state === 'done').map(p => p.n);
  if (!pages.length) { out.textContent = 'В диапазоне нет готовых страниц.'; out.dataset.state = 'error'; return; }
  const errors = [];
  for (const [i, n] of pages.entries()) {
    out.textContent = `Публикую страницу ${n} (${i + 1} из ${pages.length})…`; out.dataset.state = 'running';
    try {
      const current=n===S.page?S.layout:(await call(`/books/${S.book.id}/pages/${n}/layout`)).layout;
      await call(`/books/${S.book.id}/pages/${n}/publish`, { method: 'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversionId:current?.conversionId}) });
    }
    catch (e) { errors.push(`стр. ${n}: ${e.message}`); if (/токен|адрес|не отвечает/i.test(e.message)) break; }
  }
  await refreshBook(); renderPublish();
  out.textContent = errors.length ? 'Не всё опубликовано — ' + errors.join('; ') : pages.length === 1 ? `Страница ${pages[0]} опубликована на платформе.` : `Опубликовано страниц: ${pages.length}.`;
  out.dataset.state = errors.length ? 'error' : 'done';
}

async function unpublish() {
  if (!confirm(`Снять страницу ${S.page} с платформы? Ученики перестанут её видеть.`)) return;
  const out = S.view.querySelector('#wbPubStatus');
  try { await call(`/books/${S.book.id}/pages/${S.page}/publish`, { method: 'DELETE' }); out.textContent = `Страница ${S.page} снята с платформы.`; out.dataset.state = 'done'; }
  catch (e) { out.textContent = e.message; out.dataset.state = 'error'; }
  await refreshBook(); renderPublish();
}

// Kazakh layer: Qwen translates the page's Russian texts; published pages are re-sent by the server.
async function translateKz(pages) {
  const out = S.view.querySelector('#wbKzStatus'), done = [], errors = [];
  for (const [i, n] of pages.entries()) {
    out.textContent = `Перевожу страницу ${n} на казахский (${i + 1} из ${pages.length})…`; out.dataset.state = 'running';
    try { const r = await call(`/books/${S.book.id}/pages/${n}/kazakh`, { method: 'POST' }); done.push(`${n}: ${r.translated}/${r.texts}`); }
    catch (e) { errors.push(`стр. ${n}: ${e.message}`); if (/ключ/i.test(e.message)) { document.querySelector('#openKey')?.click(); break; } }
  }
  out.textContent = (done.length ? 'Переведено (строк/всего): ' + done.join(', ') + '. Кнопка «Қазақша» — в «Открыть HTML» и на платформе.' : '') + (errors.length ? ' Ошибки — ' + errors.join('; ') : '');
  out.dataset.state = errors.length ? 'error' : 'done';
  if (pages.includes(S.page)) openPage(S.page);
}

// Textbook recordings: what the book marks, what it has, and importing a folder of tracks.
async function loadAudio() {
  const v = S.view; if (!S.book) return;
  try {
    const a = await call(`/books/${S.book.id}/audio`);
    v.querySelector('#wbAudioState').textContent = a.marked ? `— звучат ${a.playable.length} из ${a.marked} отмеченных дорожек` : '— на сконвертированных страницах нет значков аудио';
    const miss = v.querySelector('#wbAudioMissing'); miss.hidden = !a.missing.length;
    v.querySelector('#wbAudioList').innerHTML = a.missing.map(m => `<span title="страницы ${m.pages.join(', ')}">${esc(m.track)} <small>стр. ${m.pages.join(', ')}</small></span>`).join('');
  } catch (e) { v.querySelector('#wbAudioState').textContent = ''; }
}
async function importAudio() {
  const v = S.view, out = v.querySelector('#wbAudioStatus'), folder = v.querySelector('#wbAudioFolder').value.trim();
  if (!folder) { out.textContent = 'Укажите путь к папке с аудио учебника.'; out.dataset.state = 'error'; return; }
  savePref({ audioFolder: folder });
  out.textContent = 'Ищу аудиофайлы и раскладываю по номерам…'; out.dataset.state = 'running';
  try {
    const r = await call(`/books/${S.book.id}/audio/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder }) });
    out.textContent = r.imported.length ? `Импортировано дорожек: ${r.imported.length} (${r.imported.slice(0, 12).join(', ')}${r.imported.length > 12 ? '…' : ''}). Обновлено страниц: ${r.pages}.${r.skipped.length ? ` Без номера «урок-дорожка», пропущено: ${r.skipped.length}.` : ''}` : `Файлов найдено: ${r.found}, но ни в одном имени нет номера вида «1-3». Пришлите пример имени — научу студию его понимать.`;
    out.dataset.state = r.imported.length ? 'done' : 'error';
    await loadAudio(); if (r.pages) openPage(S.page);
  } catch (e) { out.textContent = e.message; out.dataset.state = 'error'; }
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
  v.querySelector('#wbRemodel').onclick = () => confirm('Сделать новый платный запрос к модели для этой страницы?') && convert({ forceModel: true });
  v.querySelector('#wbBatch').onclick = batch;
  v.querySelector('#wbSave').onclick = save;
  v.querySelector('#wbUndo').onclick = undo;
  v.querySelector('#wbPublish').onclick = () => publishPages(S.page, S.page);
  v.querySelector('#wbPubBatch').onclick = () => {
    const from = Number(v.querySelector('#wbPubFrom').value), to = Number(v.querySelector('#wbPubTo').value);
    if (!(from >= 1 && to >= from)) return;
    if (confirm(`Опубликовать готовые страницы ${from}–${to} на платформе?`)) publishPages(from, to);
  };
  v.querySelector('#wbUnpublish').onclick = unpublish;
  v.querySelector('#wbKz').onclick = () => translateKz([S.page]);
  v.querySelector('#wbAudioImport').onclick = importAudio;
  v.querySelector('#wbAudioFolder').addEventListener('keydown', e => { if (e.key === 'Enter') importAudio(); });
  v.querySelector('#wbKzAll').onclick = () => { const pages = S.book.pageStates.filter(p => p.published).map(p => p.n); if (pages.length && confirm('Перевести на казахский опубликованные страницы ' + pages.join(', ') + '?')) translateKz(pages); };
  v.querySelector('#wbPlatSave').onclick = savePlatform;
  v.querySelector('#wbDiscard').onclick = discard;
  v.querySelector('#wbExport').onclick = exportBook;
  v.querySelector('#wbFidRun').onclick = runFidelity;
  v.querySelector('#wbFidMap').onclick = () => { S.mode = 'map'; savePref({ mode: S.mode }); renderStage(); };
  v.querySelector('#wbGolden').onchange = e => toggleGolden(e.target.checked);
  v.querySelector('#wbGoldenCheck').onclick = checkGolden;
  v.querySelector('#wbBlocks').onclick = e => { const b = e.target.closest('[data-block]'); if (b) select(Number(b.dataset.block)); };
  const stage = v.querySelector('#wbStage');
  stage.addEventListener('click', e => {
    const el = e.target.closest('.hsk-at[data-block]');
    if (el && !e.target.isContentEditable) select(Number(el.dataset.block));
    // A click on empty page or around it ends the editing of a block.
    else if (!el && !e.target.closest('.wb-edit') && S.selected >= 0) deselect();
  });
  stage.addEventListener('pointerdown', e => { const h = e.target.closest('.wb-edit [data-drag]'); if (h) startDrag(e, h.dataset.drag); });
  stage.addEventListener('click', e => { const f = e.target.closest('.wb-edit [data-font]'); if (f) changeFont(Number(f.dataset.font)); if (e.target.closest('.wb-edit [data-bold]')) toggleBold(); });
  // Ctrl+B makes the selected block bold (also while its text is being
  // edited: the browser's own bold would not be saved).
  stage.addEventListener('keydown', e => { if (e.target.isContentEditable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && S.selected >= 0) { e.preventDefault(); toggleBold(); } });
  stage.addEventListener('wheel', e => { if (!e.altKey || S.selected < 0) return; e.preventDefault(); changeFont(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  stage.addEventListener('focusin', e => { const el = e.target.closest('.hsk-at[data-block]'); if (el) select(Number(el.dataset.block)); });
  stage.addEventListener('input', e => {
    const f = e.target.closest('[data-hsk-path]');
    if (!f || !S.layout) return;
    core.setField(S.layout, Number(f.dataset.hskBlock), f.dataset.hskPath, f.textContent.trim());
    markDirty(true);
  });
  stage.addEventListener('dragover', e => { if (!S.book) e.preventDefault(); });
  stage.addEventListener('drop', e => { if (S.book) return; e.preventDefault(); upload(e.dataTransfer.files[0]); });
  v.querySelector('#wbGeom').addEventListener('change', e => {
    const n = S.selected, b = S.layout?.blocks[n];
    if (!b) return;
    if (e.target.dataset.geom) setBox(n, { [e.target.dataset.geom]: Number(e.target.value) / 100 });
    if (e.target.dataset.scale != null) { if (!b.kManual) b.kAuto = b.k ?? null; b.k = Math.max(0.5, Math.min(2.5, Number(e.target.value) || 1)); b.kManual = true; markDirty(); renderStage(); }
  });
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (!S.view?.isConnected) { document.removeEventListener('keydown', onKey); return; }
  // Esc finishes editing, also from inside a text.
  if (e.key === 'Escape' && S.selected >= 0) { e.preventDefault(); deselect(); return; }
  if (e.target.closest?.('input, select, textarea, [contenteditable=true]')) return;
  if (e.altKey && S.selected >= 0 && S.layout && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 0.005 : 0.001, blk = S.layout.blocks[S.selected], b = blk.box;
    carry(blk, b, { ...b, ...{ ArrowLeft: { x: b.x - step }, ArrowRight: { x: b.x + step }, ArrowUp: { y: b.y - step }, ArrowDown: { y: b.y + step } }[e.key] });
    markDirty(); renderStage(); renderGeom();
    return;
  }
  if (e.key === 'ArrowLeft') openPage(S.page - 1);
  if (e.key === 'ArrowRight') openPage(S.page + 1);
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && S.layout) { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && S.selected >= 0 && S.layout) { e.preventDefault(); toggleBold(); }
}

// Entry point called by the studio router (index.html).
window.renderWebBook = async function renderWebBook(view) {
  clearTimeout(S.poll); clearTimeout(S.statePoll);
  S.view = view;
  shell(); bind();
  try { await loadBooks(); }
  catch (e) { view.querySelector('#wbStatus').textContent = 'Конвертер недоступен: ' + e.message + '. Перезапустите студию.'; }
};
