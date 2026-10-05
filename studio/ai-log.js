// «Анализ AI»: every image and video an AI model made for the studio, with its
// model, provider, price and purpose, and the user's rating and note — to pick
// the best tools. Recording happens where requests go out (OpenRouter calls in
// index.html, Alibaba calls in alibaba.js), so nothing depends on a section
// remembering to log; the journal lives on the studio server (ailog.mjs).
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // What the next generation is for; set by the section that starts it.
  let current = null;
  const section = () => document.querySelector('#crumb')?.textContent?.trim() || '';
  // A purpose set in one section never leaks into generations made in another.
  function context(ctx) {
    if (ctx !== undefined) current = ctx ? { ...ctx, at: section() } : null;
    const { at, ...rest } = current && current.at === section() ? current : {};
    return { ...rest, section: section() };
  }

  async function record(meta, blob) {
    try {
      const body = blob || null;
      // The description goes first in the body (a header overflows with long prompts), then the file.
      const head = new TextEncoder().encode(JSON.stringify({ at: new Date().toISOString(), ...meta }));
      const r = await fetch('/local/ailog', { method: 'POST', headers: { 'x-ailog-meta-bytes': String(head.length), 'content-type': body?.type || 'application/octet-stream' }, body: new Blob([head, ...(body ? [body] : [])]) });
      if (!r.ok) console.warn('Анализ AI: запись не сохранена', r.status, await r.text().catch(() => ''));
    } catch { /* the journal never breaks a generation */ }
  }
  const b64blob = (b64, type) => new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: type || 'image/png' });
  const settingsOf = body => Object.fromEntries(['aspect_ratio', 'duration', 'resolution', 'generate_audio', 'size'].filter(k => body?.[k] != null).map(k => [k, body[k]]));

  // OpenRouter images: the answer carries the pictures (base64) and the cost.
  function fromOpenRouter(path, body, answer, ctx) {
    if (path === 'images') {
      for (const im of answer?.data || []) if (im?.b64_json) record({ kind: 'image', model: body?.model, provider: 'openrouter', cost: answer?.usage?.cost ?? null, prompt: body?.prompt, refs: body?.input_references?.length || 0, settings: settingsOf(body), ...ctx }, b64blob(im.b64_json, im.media_type));
    }
    if (path === 'videos' && answer?.id) videos.set(answer.id, { model: body?.model, prompt: body?.prompt, refs: body?.input_references?.length || 0, settings: { ...settingsOf(body), first_frame: Boolean(body?.frame_images?.length) }, ctx, cost: null });
  }
  // OpenRouter videos: the price comes with the status, the file with /content.
  const videos = new Map();
  function watch(path, response) {
    const m = String(path).match(/^videos\/([^/?]+)(\/content)?/);
    if (!m || !videos.has(decodeURIComponent(m[1]))) return;
    const job = videos.get(decodeURIComponent(m[1]));
    if (!m[2]) response.clone().json().then(s => { if (s?.usage?.cost != null) job.cost = s.usage.cost; }).catch(() => {});
    else response.clone().blob().then(blob => { videos.delete(decodeURIComponent(m[1])); record({ kind: 'video', model: job.model, provider: 'openrouter', cost: job.cost, prompt: job.prompt, refs: job.refs, settings: job.settings, ...job.ctx }, blob); }).catch(() => {});
  }

  // ---- the section ----
  const S = { entries: [], kind: 'all', model: '', only: 'all', sort: (() => { try { return localStorage.getItem('forma.ailog.sort') || 'new'; } catch { return 'new'; } })(), /* newest first unless chosen otherwise */ shown: 60, lesson: null, pageLesson: {} };
  // Lessons: each page's lesson comes from the studio (PDF → Web context); entries without a page stay apart.
  const groupOf = e => e.page != null && S.pageLesson[e.page] ? 'L' + S.pageLesson[e.page].number : 'none';
  function groups() {
    const map = new Map();
    for (const e of S.entries) { const k = groupOf(e), g = map.get(k) || { key: k, n: 0, last: 0, label: k === 'none' ? 'Без урока' : 'Урок ' + S.pageLesson[e.page].number, title: k === 'none' ? 'герои, локации и прочее' : S.pageLesson[e.page].title || '' }; g.n++; g.last = Math.max(g.last, e.no || 0); map.set(k, g); }
    return [...map.values()].sort((a, b) => a.key === 'none' ? 1 : b.key === 'none' ? -1 : Number(a.key.slice(1)) - Number(b.key.slice(1)));
  }
  async function loadLessons() {
    const pages = [...new Set(S.entries.map(e => e.page).filter(p => p != null && !(p in S.pageLesson)))];
    if (!pages.length) return;
    let book = ''; try { book = JSON.parse(localStorage.getItem('forma.webbook.v1') || '{}').book || ''; } catch {}
    if (!book) { try { book = (await (await fetch('/local/webbook/books')).json())[0]?.id || ''; } catch {} }
    if (!book) return;
    await Promise.all(pages.map(async p => { try { const c = await (await fetch(`/local/webbook/books/${book}/pages/${p}/context`)).json(); if (c?.lesson?.number) S.pageLesson[p] = { number: c.lesson.number, title: c.lesson.title || '' }; } catch {} }));
  }
  const money = v => v == null ? '—' : '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2));
  const price = e => e.subscription ? 'подписка' : money(e.cost);
  const stars = (r, id) => `<span class="ail-stars" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-ail-rate="${id}" data-n="${n}" class="${r >= n ? 'on' : ''}" aria-label="${n} из 5" title="${n} из 5">★</button>`).join('')}</span>`;
  const provName = p => p === 'alibaba' ? 'Alibaba · подписка' : 'OpenRouter';

  function byModel(list) {
    const map = new Map();
    for (const e of list) {
      const k = e.provider + '|' + e.model, m = map.get(k) || { model: e.model, provider: e.provider, kinds: new Set(), n: 0, cost: 0, costed: 0, sub: 0, rated: 0, sum: 0 };
      m.kinds.add(e.kind); m.n++; if (e.subscription) m.sub++; else if (e.cost != null) { m.cost += e.cost; m.costed++; }
      if (e.rating) { m.rated++; m.sum += e.rating; }
      map.set(k, m);
    }
    return [...map.values()].map(m => ({ ...m, avg: m.rated ? m.sum / m.rated : null })).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.n - a.n);
  }

  function filtered() {
    let l = S.entries.filter(e => (!S.lesson || groupOf(e) === S.lesson) && (S.kind === 'all' || e.kind === S.kind) && (!S.model || e.provider + '|' + e.model === S.model) && (S.only === 'all' || (S.only === 'unrated' ? !e.rating : e.rating)));
    l = l.sort((a, b) => S.sort === 'rating' ? (b.rating || 0) - (a.rating || 0) || a.no - b.no : S.sort === 'cost' ? (b.cost || 0) - (a.cost || 0) : S.sort === 'new' ? b.no - a.no : a.no - b.no);
    return l;
  }

  function draw(view) {
    const all = S.entries, models = byModel(all), list = filtered();
    const total = all.reduce((s, e) => s + (e.subscription ? 0 : e.cost || 0), 0), imgs = all.filter(e => e.kind === 'image').length, vids = all.length - imgs, rated = all.filter(e => e.rating).length;
    const box = view.querySelector('#ailBody');
    box.innerHTML = `
      <div class="ail-sum">
        <div><b>${all.length}</b><span>генераций</span></div><div><b>${imgs}</b><span>картинок</span></div><div><b>${vids}</b><span>видео</span></div>
        <div><b>${money(total)}</b><span>через OpenRouter</span></div><div><b>${all.filter(e => e.subscription).length}</b><span>по подписке Alibaba</span></div><div><b>${rated}</b><span>оценено</span></div>
      </div>
      <section class="ail-card"><h3>Модели <small>лучшие по вашей оценке — сверху</small></h3>
        ${models.length ? `<div class="ail-table" role="table"><div class="ail-tr ail-th" role="row"><span>Модель</span><span>Что делала</span><span>Создано</span><span>Потрачено</span><span>В среднем</span><span>Оценка</span></div>
        ${models.map(m => `<button type="button" class="ail-tr${S.model === m.provider + '|' + m.model ? ' on' : ''}" data-ail-model="${esc(m.provider + '|' + m.model)}" title="Показать только эту модель"><span><b>${esc(m.model)}</b><small>${provName(m.provider)}</small></span><span>${[...m.kinds].map(k => k === 'video' ? 'видео' : 'картинки').join(', ')}</span><span>${m.n}</span><span>${m.sub && !m.costed ? 'подписка' : money(m.cost)}</span><span>${m.sub && !m.costed ? '—' : m.costed ? money(m.cost / m.costed) : '—'}</span><span>${m.avg ? `<b class="ail-avg">★ ${m.avg.toFixed(1)}</b><small>${m.rated} оцен.</small>` : '<small>нет оценок</small>'}</span></button>`).join('')}</div>` : '<p class="ail-empty">Пока ничего не создано. Картинки и видео попадут сюда сами, как только модель их вернёт.</p>'}
      </section>
      <section class="ail-card"><h3>Генерации по урокам <small>включая удалённые в студии · номер — порядок генерации</small></h3>
        <div class="ail-lessons" role="tablist">${groups().map(g => `<button type="button" role="tab" data-ail-lesson="${g.key}" aria-selected="${S.lesson === g.key}"><b>${esc(g.label)}</b><small>${esc(g.title)}</small><span>${g.n}</span></button>`).join('')}</div>
        <div class="ail-filters">
          <label class="ail-find">№ <input id="ailFind" type="number" min="1" inputmode="numeric" placeholder="номер" aria-label="Открыть генерацию по номеру"></label>
          <div class="ail-seg" role="group" aria-label="Тип">${[['all', 'Все'], ['image', 'Картинки'], ['video', 'Видео']].map(([v, t]) => `<button type="button" data-ail-kind="${v}" aria-pressed="${S.kind === v}">${t}</button>`).join('')}</div>
          <div class="ail-seg" role="group" aria-label="Оценка">${[['all', 'Все'], ['unrated', 'Без оценки'], ['rated', 'Оценённые']].map(([v, t]) => `<button type="button" data-ail-only="${v}" aria-pressed="${S.only === v}">${t}</button>`).join('')}</div>
          <label class="ail-sort">Сначала <select id="ailSort"><option value="new"${S.sort === 'new' ? ' selected' : ''}>новые</option><option value="no"${S.sort === 'no' ? ' selected' : ''}>старые (по номеру)</option><option value="rating"${S.sort === 'rating' ? ' selected' : ''}>лучшие</option><option value="cost"${S.sort === 'cost' ? ' selected' : ''}>дорогие</option></select></label>
          ${S.model ? `<button type="button" class="ail-chip" data-ail-model="">${esc(S.model.split('|')[1])} ✕</button>` : ''}
        </div>
        <div class="ail-grid">${list.slice(0, S.shown).map(e => `
          <article class="ail-item" data-id="${e.id}">
            <button type="button" class="ail-media" data-ail-open="${e.id}" title="Открыть просмотр"${e.file ? '' : ' disabled'}><span class="ail-no">№${e.no}</span>${!e.file ? '<span class="ail-nofile">файл не сохранён</span>' : e.kind === 'video' ? `<video src="/local/ailog/media/${e.file}" preload="metadata" muted playsinline></video><span class="ail-vid">▶ видео</span>` : `<img src="/local/ailog/media/${e.file}" alt="" loading="lazy">`}</button>
            <div class="ail-meta"><b title="${esc(e.model)}">${esc(e.model)}</b><span>${provName(e.provider)} · ${price(e)}</span>
              <span>${esc([e.purpose, e.page ? 'стр. ' + e.page : '', e.section].filter(Boolean).join(' · '))}</span>
              <span class="ail-when">${new Date(e.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${e.refs ? ' · образцов: ' + e.refs : ''}${e.imported ? ' · из галереи' : ''}</span></div>
            ${stars(e.rating || 0, e.id)}
            <textarea class="ail-note" data-ail-note="${e.id}" rows="2" placeholder="Комментарий: что получилось, что нет">${esc(e.comment)}</textarea>
            ${e.prompt ? `<details class="ail-prompt"><summary>Промпт</summary><p>${esc(e.prompt)}</p></details>` : ''}
          </article>`).join('') || '<p class="ail-empty">Под эти фильтры ничего не подходит.</p>'}</div>
        ${list.length > S.shown ? `<button type="button" class="btn-quiet ail-more" data-ail-more>Показать ещё (${list.length - S.shown})</button>` : ''}
      </section>`;
  }

  // A star lights up at once; «сохранено» confirms it, and a failed save puts the old rating back and says so.
  async function rate(id, n, group) {
    const e = S.entries.find(x => x.id === id), prev = e?.rating || null, next = prev === n ? null : n;
    const paint = r => group.querySelectorAll('button').forEach(b => b.classList.toggle('on', (r || 0) >= Number(b.dataset.n)));
    const note = (text, bad) => { group.parentElement.querySelector('.ail-flash')?.remove(); const s = document.createElement('span'); s.className = 'ail-flash' + (bad ? ' bad' : ''); s.textContent = text; group.after(s); setTimeout(() => s.remove(), bad ? 4000 : 1400); };
    paint(next);
    try {
      const r = await fetch('/local/ailog/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: next }) });
      if (!r.ok) throw Error();
      const upd = await r.json(), i = S.entries.findIndex(x => x.id === id); if (i >= 0) S.entries[i] = upd;
      note(next ? 'сохранено' : 'оценка снята');
      return upd;
    } catch { paint(prev); note('не сохранилось — сервер студии недоступен, попробуйте ещё раз', true); return null; }
  }

  // Large preview inside the section: pictures full size, clips with player controls; ← → walk the current list.
  function openViewer(view, id) {
    const list = filtered().filter(e => e.file);
    let k = list.findIndex(e => e.id === id); if (k < 0) return;
    view.querySelector('.ail-viewer')?.remove();
    const box = document.createElement('div'); box.className = 'ail-viewer'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const show = () => {
      const e = list[k], src = '/local/ailog/media/' + e.file;
      box.innerHTML = `<div class="ail-v-stage">${e.kind === 'video' ? `<video src="${src}" controls autoplay playsinline></video>` : `<img src="${src}" alt="">`}</div>
        <div class="ail-v-bar"><button type="button" class="ail-v-nav" data-v="-1" aria-label="Предыдущая"${k ? '' : ' disabled'}>←</button>
          <div class="ail-v-cap"><b>№${e.no} · ${esc(e.model)}</b><span>${provName(e.provider)} · ${price(e)} · ${esc([e.purpose, e.page ? 'стр. ' + e.page : ''].filter(Boolean).join(' · '))}</span></div>
          ${stars(e.rating || 0, e.id)}<span class="ail-v-count">${k + 1} / ${list.length}</span>
          <button type="button" class="ail-v-nav" data-v="1" aria-label="Следующая"${k < list.length - 1 ? '' : ' disabled'}>→</button>
          <button type="button" class="btn-quiet ail-v-close" aria-label="Закрыть">Закрыть ✕</button></div>`;
    };
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); draw(view); };
    const go = d => { const n = k + d; if (n >= 0 && n < list.length) { k = n; show(); } };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
    box.addEventListener('click', async e => {
      if (e.target === box || e.target.closest('.ail-v-close')) return close();
      const nav = e.target.closest('[data-v]'); if (nav) return go(Number(nav.dataset.v));
      const st = e.target.closest('[data-ail-rate]');
      if (st) { const upd = await rate(list[k].id, Number(st.dataset.n), st.closest('.ail-stars')); if (upd) list[k] = upd; }
    });
    document.addEventListener('keydown', onKey, true);
    show(); view.append(box); box.querySelector('.ail-v-close')?.focus();
  }

  async function load(view) {
    try { S.entries = await (await fetch('/local/ailog', { cache: 'no-store' })).json(); } catch { S.entries = []; }
    await loadLessons();
    // Open on the lesson of the latest generation the first time.
    const g = groups(); if (!g.some(x => x.key === S.lesson)) S.lesson = g.sort((a, b) => b.last - a.last)[0]?.key || null;
    draw(view);
  }

  // Pictures and clips made before the journal existed: taken from the textbook section's gallery (model unknown unless the page recorded it).
  async function importGallery(view, out) {
    out.textContent = 'Ищу созданное раньше в галерее «Учебника HSK»…';
    let state = {}; try { state = JSON.parse(localStorage.getItem('forma.textbookStudio.v1') || '{}'); } catch {}
    const db = await new Promise((ok, no) => { const r = indexedDB.open('forma-hsk-script-workbench'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const get = key => new Promise(ok => { try { const r = db.transaction('files').objectStore('files').get(key); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); } catch { ok(null); } });
    let n = 0;
    for (const p of state.pages || []) {
      for (const im of p.images || []) {
        const key = im.key || 'page-image:' + p.id + ':' + im.id, blob = await get(key);
        if (blob) { await record({ kind: 'image', model: 'неизвестно (до журнала)', provider: 'openrouter', page: Number(p.pageNumber) || null, purpose: /кадр/i.test(im.name || '') ? 'Первый кадр' : 'Иллюстрация страницы', section: 'Учебник HSK', sourceKey: key, imported: true }, blob); n++; }
      }
      const clip = await get('page-video:' + p.id);
      if (clip) { await record({ kind: 'video', model: p.videoModel || 'неизвестно (до журнала)', provider: String(p.videoModel || '').startsWith('alibaba/happyhorse-1.1-') ? 'alibaba' : 'openrouter', cost: typeof p.videoCost === 'number' ? p.videoCost : null, page: Number(p.pageNumber) || null, purpose: 'Клип страницы', section: 'Учебник HSK', sourceKey: 'page-video:' + p.id, imported: true }, clip); n++; }
    }
    // Character portraits (face, full body, emotions) and recurring locations made in the «Персонажи» tab.
    const add = async (key, purpose) => { const blob = await get(key); if (blob && /^image\//.test(blob.type || 'image/png')) { await record({ kind: 'image', model: 'неизвестно (до журнала)', provider: 'openrouter', purpose, section: 'Учебник HSK', sourceKey: key, imported: true }, blob); n++; } };
    for (const c of state.characters || []) {
      const who = c.name ? ': ' + c.name : '';
      await add('character:' + c.id, 'Портрет героя' + who);
      await add('character-body:' + c.id, 'Герой в полный рост' + who);
      for (const em of c.emotionReferences || []) await add('character-emotion:' + c.id + ':' + em.id, 'Эмоция героя' + who + (em.name ? ' — ' + em.name : ''));
    }
    for (const l of state.locations || []) await add('location:' + l.id, 'Локация' + (l.name ? ': ' + l.name : ''));
    db.close();
    out.textContent = n ? `Проверено файлов в галерее: ${n}. Новые добавлены, уже знакомые дополнены сведениями (модель, цена) — дубликатов не бывает.` : 'В галерее браузера ничего не нашлось.';
    await load(view);
  }

  function render(view) {
    view.innerHTML = `<section class="ail" aria-label="Анализ AI">
      <div class="ail-head"><p>Каждая картинка и каждое видео от моделей ИИ попадает сюда сразу, когда модель его вернула: модель, через кого шёл запрос, цена, страница и промпт. Удаление в студии журнал не трогает. Ставьте звёзды и пишите комментарии — сводка по моделям покажет, какой инструмент лучше.</p>
        <div class="ail-actions"><button type="button" class="btn-quiet" id="ailImport" title="Картинки и клипы, созданные до появления журнала, из галереи «Учебника HSK»">Добавить созданное раньше</button><button type="button" class="btn-quiet" id="ailReload">Обновить</button></div>
        <div class="status" id="ailStatus" role="status"></div></div>
      <div id="ailBody"><p class="ail-empty">Загружаю журнал…</p></div></section>`;
    view.querySelector('#ailReload').onclick = () => load(view);
    view.querySelector('#ailImport').onclick = e => { e.currentTarget.disabled = true; importGallery(view, view.querySelector('#ailStatus')).finally(() => { e.currentTarget.disabled = false; }); };
    const body = view.querySelector('#ailBody');
    const patch = async (id, data) => { const r = await fetch('/local/ailog/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); if (r.ok) { const e = await r.json(), i = S.entries.findIndex(x => x.id === id); if (i >= 0) S.entries[i] = e; } return r.ok; };
    body.addEventListener('click', async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.ailLesson) { S.lesson = t.dataset.ailLesson; S.shown = 60; return draw(view); }
      if (t.dataset.ailKind) { S.kind = t.dataset.ailKind; S.shown = 60; return draw(view); }
      if (t.dataset.ailOnly) { S.only = t.dataset.ailOnly; S.shown = 60; return draw(view); }
      if ('ailModel' in t.dataset) { S.model = S.model === t.dataset.ailModel ? '' : t.dataset.ailModel; S.shown = 60; draw(view); return view.querySelector('.ail-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      if ('ailMore' in t.dataset) { S.shown += 60; return draw(view); }
      if (t.dataset.ailOpen) return openViewer(view, t.dataset.ailOpen);
      if (t.dataset.ailRate) {
        // Clicking the same star again clears the rating.
        // In place: the grid is not redrawn, so clips and half-typed notes stay as they are.
        return rate(t.dataset.ailRate, Number(t.dataset.n), t.closest('.ail-stars'));
      }
    });
    body.addEventListener('change', e => { if (e.target.id === 'ailSort') { S.sort = e.target.value; try { localStorage.setItem('forma.ailog.sort', S.sort); } catch {} draw(view); } });
    // «№ 12» + Enter opens that generation, wherever it is (its lesson, filters cleared).
    body.addEventListener('keydown', e => {
      if (e.target.id !== 'ailFind' || e.key !== 'Enter') return;
      const no = Number(e.target.value), hit = S.entries.find(x => x.no === no);
      if (!hit) { e.target.setCustomValidity('Нет генерации с таким номером'); e.target.reportValidity(); setTimeout(() => e.target.setCustomValidity(''), 1500); return; }
      Object.assign(S, { lesson: groupOf(hit), kind: 'all', model: '', only: 'all', shown: Math.max(60, S.entries.length) });
      draw(view);
      if (hit.file) openViewer(view, hit.id); else view.querySelector(`.ail-item[data-id="${hit.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    // Notes save on their own when the field is left.
    body.addEventListener('focusout', async e => {
      const ta = e.target.closest?.('[data-ail-note]'); if (!ta) return;
      const id = ta.dataset.ailNote, old = S.entries.find(x => x.id === id)?.comment || '';
      if (ta.value !== old && await patch(id, { comment: ta.value })) { ta.classList.add('saved'); setTimeout(() => ta.classList.remove('saved'), 1200); }
    });
    body.addEventListener('mouseover', e => { const v = e.target.closest?.('.ail-media video'); if (v) v.play().catch(() => {}); });
    body.addEventListener('mouseout', e => { const v = e.target.closest?.('.ail-media video'); if (v) { v.pause(); v.currentTime = 0; } });
    load(view);
  }

  window.FormaAiLog = { record, context, fromOpenRouter, watch };
  window.renderAiLog = render;
})();
