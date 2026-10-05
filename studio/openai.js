// OpenAI direct (the user's own key and balance). Used as the clip «director»: it reads the page,
// the first frame and the lines, and writes the clip prompt. The key lives only in the local server.
(function () {
  const $ = s => document.querySelector(s);
  const MODEL_KEY = 'forma.openai.model';
  let connected = false, models = [], imageModels = [];
  const pick = () => { try { const m = localStorage.getItem(MODEL_KEY); if (m && models.includes(m)) return m; } catch {} return bestModel(); };
  // The newest general GPT the key offers (mini / nano variants are cheaper but weaker directors).
  function bestModel() {
    const full = models.filter(m => /^gpt-\d/.test(m) && !/(mini|nano|chat|codex|oss)/.test(m));
    const ver = m => (m.match(/^gpt-(\d+(?:\.\d+)?)/) || [])[1] * 1 || 0;
    return full.sort((a, b) => ver(b) - ver(a) || a.length - b.length)[0] || models[0] || '';
  }
  function paint() {
    const dot = $('#oaDot'), state = $('#oaState'), badge = $('#oaBadge');
    dot?.classList.toggle('on', connected);
    if (state) state.textContent = connected ? 'OpenAI подключён' : 'OpenAI не подключён';
    if (badge) { badge.textContent = connected ? 'подключён' : 'не подключён'; badge.classList.toggle('on', connected); }
    const sel = $('#oaModel');
    if (sel) { sel.innerHTML = models.length ? models.map(m => `<option value="${m}">${m}</option>`).join('') : '<option value="">— сначала подключите ключ —</option>'; sel.value = pick(); sel.disabled = !models.length; }
  }
  async function status() {
    try { const s = await fetch('/local/openai').then(r => r.json()); connected = Boolean(s.connected); models = s.models || []; imageModels = s.imageModels || []; } catch { connected = false; }
    paint(); return connected;
  }
  // Chat completion through the local server; returns the answer text.
  async function chat(messages, { model = pick(), maxTokens = 2000, json = false } = {}) {
    if (!connected && !(await status())) throw Error('OpenAI не подключён: добавьте ключ в окне «Ключи сервисов ИИ».');
    const body = { model, messages, max_completion_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) };
    const r = await fetch('/local/openai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error?.message || 'OpenAI: HTTP ' + r.status);
    return { text: d.choices?.[0]?.message?.content || '', usage: d.usage || null, model };
  }
  // GPT Image (own key): listed with the image models; reference pictures go to the «edits» endpoint.
  const RATIO_SIZE = { '1:1': '1024x1024', '16:9': '1536x1024', '3:2': '1536x1024', '4:3': '1536x1024', '9:16': '1024x1536', '2:3': '1024x1536', '3:4': '1024x1536' };
  const imageMeta = id => ({ id: 'openai-direct/' + id, model: id, provider: 'openai-direct', name: 'OpenAI (ваш ключ): ' + id, description: id + ' напрямую через ваш ключ OpenAI. Принимает рисунок страницы и портреты как образцы.', supported_parameters: { input_references: { type: 'range', min: 0, max: 16 }, aspect_ratio: { values: Object.keys(RATIO_SIZE) } } });
  async function extend(list) {
    await status();
    list.image = (list.image || []).filter(m => m.provider !== 'openai-direct');
    if (connected && imageModels.length) list.image = [...imageModels.map(imageMeta), ...list.image];
    return connected;
  }
  async function images(meta, body) {
    const ctx = window.FormaAiLog?.context() || {};
    const refs = (body.input_references || []).map(r => r?.image_url?.url || r?.url || r).filter(u => typeof u === 'string' && u.startsWith('data:'));
    const size = RATIO_SIZE[body.aspect_ratio] || '1536x1024';
    const r = await fetch('/local/openai/images', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: meta.model, prompt: body.prompt, images: refs, size }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error('OpenAI: ' + (d.error?.message || 'HTTP ' + r.status));
    const b64 = d.data?.[0]?.b64_json; if (!b64) throw Error('OpenAI не вернул изображение.');
    const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/png' });
    window.FormaAiLog?.record({ kind: 'image', model: meta.id, provider: 'openai', cost: null, prompt: body.prompt, refs: refs.length, settings: { size }, ...ctx }, blob);
    return { data: [{ b64_json: b64, media_type: 'image/png' }], usage: d.usage || null };
  }  function bindKeyForm() {
    const out = $('#oaKeyStatus'), save = $('#saveOaKey'), clear = $('#clearOaKey'), sel = $('#oaModel');
    if (!save || save.dataset.bound) return; save.dataset.bound = '1';
    const say = (text, bad) => { if (out) { out.textContent = text; out.style.color = bad ? '#ffb4a8' : ''; } };
    save.onclick = async () => {
      const key = ($('#oaKey')?.value || '').trim();
      if (!key) return say('Введите ключ.', true);
      if (/\s/.test(key)) return say('В ключе остались пробелы или переносы.', true);
      save.disabled = true; say('Проверяю ключ…');
      try {
        const r = await fetch('/local/openai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }), d = await r.json().catch(() => ({}));
        if (!r.ok) throw Error(d.error?.message || 'HTTP ' + r.status);
        $('#oaKey').value = ''; await status(); window.getModels?.(); say('Ключ проверен и подключён. Режиссёр: ' + pick() + '.'); window.formaKeysChanged?.();
      } catch (e) { say(e.message, true); } finally { save.disabled = false; }
    };
    clear.onclick = async () => { await fetch('/local/openai', { method: 'DELETE' }); await status(); say('Ключ отключён.'); };
    sel?.addEventListener('change', () => { try { localStorage.setItem(MODEL_KEY, sel.value); } catch {} say('Модель режиссёра: ' + sel.value + '.'); });
    status();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindKeyForm); else bindKeyForm();
  setInterval(status, 30000);   // the server forgets the key on restart
  window.FormaOpenAI = { status, chat, get connected() { return connected; }, get model() { return pick(); }, get models() { return models; }, get imageModels() { return imageModels; }, extend, images, isOpenAI: meta => meta?.provider === 'openai-direct', setModel(m) { try { localStorage.setItem(MODEL_KEY, m); } catch {} const sel = document.querySelector('#oaModel'); if (sel) sel.value = m; } };
})();
