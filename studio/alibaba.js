// Alibaba Model Studio (Token Plan subscription): image and video models that
// are called directly through the studio server instead of OpenRouter.
// Each model is described in the OpenRouter catalog shape, so the textbook
// section treats it like any other model; `provider: 'alibaba'` routes it here.
(function () {
  const SUB = 'Alibaba';
  const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
  const image = (model, name, maxRefs) => ({
    id: 'alibaba/' + model, model, provider: 'alibaba', name: `${SUB}: ${name}`,
    description: `${name} из подписки Alibaba Model Studio (Token Plan), напрямую без OpenRouter.`,
    supported_parameters: { input_references: { type: 'range', min: 0, max: maxRefs }, aspect_ratio: { values: RATIOS } }
  });
  const IMAGE = [
    image('wan2.7-image-pro', 'Wan 2.7 Image Pro', 9),
    image('wan2.7-image', 'Wan 2.7 Image', 9),
    image('qwen-image-3.0-pro', 'Qwen Image 3.0 Pro', 3)
  ];
  // HappyHorse 1.1 comes in three variants, each its own model in the list.
  const HH = { durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480p', '720p', '1080p'], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '21:9', '9:21'] };
  const video = (variant, name, about, extra) => ({
    id: 'alibaba/happyhorse-1.1-' + variant, model: 'happyhorse-1.1-' + variant, variant, provider: 'alibaba', name: `${SUB}: HappyHorse 1.1 · ${name}`,
    description: `HappyHorse 1.1 (${variant}) из подписки Alibaba Model Studio, напрямую без OpenRouter. ${about} Со звуком, 3–15 с.`,
    supported_parameters: {}, supported_durations: HH.durations, supported_resolutions: HH.resolutions, supported_aspect_ratios: HH.ratios,
    supported_frame_images: [], generate_audio: true, ...extra
  });
  const VIDEO = [
    video('r2v', 'по портретам героев', 'Reference images: до 9 портретов героев и рисунок страницы.', { supported_parameters: { input_references: { type: 'range', min: 1, max: 9 } } }),
    video('i2v', 'с первого кадра', 'Начинает клип с первого кадра; формат берётся из кадра.', { supported_frame_images: ['first_frame'], supported_aspect_ratios: [] }),
    video('t2v', 'по тексту', 'Только по тексту промпта, без картинок.', {})
  ];  // Canonical sizes for each frame format (Qwen Image's recommended ones; Wan accepts them too).
  const SIZES = { '16:9': '1664*928', '9:16': '928*1664', '1:1': '1328*1328', '4:3': '1472*1104', '3:4': '1104*1472' };

  let connected = false;
  async function status() {
    try { connected = Boolean((await (await fetch('/local/alibaba')).json()).connected); } catch { connected = false; }
    document.querySelector('#aliDot')?.classList.toggle('on', connected);
    const s = document.querySelector('#aliState'); if (s) s.textContent = connected ? 'Alibaba подключён' : 'Alibaba не подключён';
    return connected;
  }
  async function call(path, body, async) {
    const r = await fetch('/local/alibaba/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(async ? { 'x-dashscope-async': 'enable' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await r.text(); let data = {};
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    if (!r.ok || data.code) throw Error('Alibaba: ' + (data.message || data.error?.message || data.code || 'HTTP ' + r.status));
    return data;
  }
  // The server retries the download itself; here one more try, then the real reason is shown.
  const file = async url => {
    let why = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch('/local/alibaba/file?url=' + encodeURIComponent(url)).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
      if (r.ok) return r.blob();
      why = (await r.text().catch(() => '')).slice(0, 160) || 'HTTP ' + r.status;
      await new Promise(ok => setTimeout(ok, 1500));
    }
    throw Error('Alibaba: картинка создана, но скачать её не удалось: ' + why + '. Нажмите кнопку ещё раз (это новая генерация и новый расход кредитов подписки).');
  };
  const b64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(blob); });
  const refUrl = ref => ref?.image_url?.url || ref?.url || '';
  // Prompts are limited to 5000 Latin or 2500 Chinese characters; production
  // details go first when cutting.
  function fit(prompt) {
    const weight = s => [...s].reduce((n, c) => n + (/[㐀-鿿]/.test(c) ? 2 : 1), 0);
    let p = String(prompt || '');
    if (weight(p) > 4800) p = p.replace(/\n*Production details \(JSON\):[\s\S]*$/, '');
    while (weight(p) > 4800) p = p.slice(0, Math.floor(p.length * 0.9));
    return p;
  }

  // Same answer shape as OpenRouter's images endpoint: {data:[{b64_json, media_type}], usage}.
  async function images(meta, body) {
    const ctx = window.FormaAiLog?.context() || {}, refs = (body.input_references || []).map(refUrl).filter(Boolean).slice(0, meta.supported_parameters.input_references.max);
    const d = await call('api/v1/services/aigc/multimodal-generation/generation', {
      model: meta.model,
      input: { messages: [{ role: 'user', content: [...refs.map(image => ({ image })), { text: fit(body.prompt) }] }] },
      parameters: { size: SIZES[body.aspect_ratio] || SIZES['16:9'], n: 1, watermark: false }
    });
    const url = (d.output?.choices?.[0]?.message?.content || []).find(c => c.image)?.image;
    if (!url) throw Error('Alibaba не вернул изображение.');
    const blob = await file(url);
    window.FormaAiLog?.record({ kind: 'image', model: meta.id, provider: 'alibaba', subscription: true, cost: null, prompt: body.prompt, refs: refs.length, settings: { size: SIZES[body.aspect_ratio] || SIZES['16:9'], aspect_ratio: body.aspect_ratio || '16:9' }, ...ctx }, blob);
    return { data: [{ b64_json: await b64(blob), media_type: blob.type || 'image/png' }], usage: { cost: null, subscription: true } };
  }

  // A job with the same use as OpenRouter's videos API: poll() → {status, error, usage}, content() → Blob.
  async function startVideo(meta, body) {
    const ctx = window.FormaAiLog?.context() || {}, first = (body.frame_images || []).find(f => f.frame_type === 'first_frame'), refs = (body.input_references || []).map(refUrl).filter(Boolean).slice(0, 9), variant = meta.variant;
    if (variant === 'i2v' && !first) throw Error('Для HappyHorse «с первого кадра» нужен первый кадр: создайте его кнопкой «Создать первый кадр» или выберите вариант «по портретам героев».');
    if (variant === 'r2v' && !refs.length) throw Error('Для HappyHorse «по портретам героев» нужен хотя бы один портрет героя или рисунок страницы.');
    const media = variant === 'i2v' ? [{ type: 'first_frame', url: refUrl(first) }] : variant === 'r2v' ? refs.map(url => ({ type: 'reference_image', url })) : [];
    const parameters = { resolution: String(body.resolution || '720p').toUpperCase(), duration: Math.max(3, Math.min(15, Number(body.duration) || 10)), watermark: false, ...(variant !== 'i2v' && body.aspect_ratio ? { ratio: body.aspect_ratio } : {}) };
    const d = await call('api/v1/services/aigc/video-generation/video-synthesis', { model: meta.model, input: { prompt: fit(body.prompt), ...(media.length ? { media } : {}) }, parameters }, true);
    const id = d.output?.task_id; if (!id) throw Error('Alibaba не вернул номер задания.');
    return taskJob(meta, id, { variant, prompt: body.prompt, refs: variant === 'r2v' ? refs.length : 0, settings: { ...parameters, first_frame: variant === 'i2v' }, ctx });
  }
  // A created task lives on Alibaba (results are kept about a day): it can be polled again after a lost
  // connection or a restart of the studio, by its number.
  function taskJob(meta, id, info = {}) {
    let videoUrl = '';
    return {
      id, variant: info.variant,
      async poll() {
        const s = await call('api/v1/tasks/' + id), o = s.output || {}, st = String(o.task_status || '').toUpperCase();
        if (o.video_url) videoUrl = o.video_url;
        return { status: st === 'SUCCEEDED' ? 'completed' : ['FAILED', 'CANCELED', 'UNKNOWN'].includes(st) ? 'failed' : st.toLowerCase() || 'processing', error: o.message || o.code || '', usage: { cost: null, subscription: true } };
      },
      async content() {
        if (!videoUrl) throw Error('Alibaba не вернул ссылку на видео.');
        const blob = await file(videoUrl);
        window.FormaAiLog?.record({ kind: 'video', model: meta.id, provider: 'alibaba', subscription: true, cost: null, prompt: info.prompt || '(задание ' + id + ', забрано после обрыва связи)', refs: info.refs || 0, settings: info.settings || {}, ...(info.ctx || window.FormaAiLog?.context() || {}) }, blob);
        return blob;
      }
    };
  }
  const resumeVideo = (meta, id, info) => taskJob(meta, id, info);

  // Put the subscription models on top of the catalogs while the key is connected.
  async function extend(models) {
    await status();
    for (const [kind, list] of [['image', IMAGE], ['video', VIDEO]]) {
      const rest = (models[kind] || []).filter(m => m.provider !== 'alibaba');
      models[kind] = connected ? [...list, ...rest] : rest;
    }
    return connected;
  }

  // Key form in the connection window.
  function bindKeyForm() {
    const $ = s => document.querySelector(s), out = $('#aliKeyStatus'), save = $('#saveAliKey'), clear = $('#clearAliKey');
    if (!save || save.dataset.bound) return; save.dataset.bound = '1';
    const say = (text, bad) => { if (out) { out.textContent = text; out.style.color = bad ? '#ffb4a8' : ''; } };
    const refresh = async () => { await status(); window.formaKeysChanged?.(); };
    save.onclick = async () => {
      const key = ($('#aliKey')?.value || '').trim();
      if (!key) return say('Введите ключ.', true);
      if (/\s/.test(key)) return say('В ключе остались пробелы или переносы.', true);
      save.disabled = true; say('Проверяю ключ…');
      try {
        const r = await fetch('/local/alibaba', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }), d = await r.json().catch(() => ({}));
        if (!r.ok) throw Error(d.error?.message || 'HTTP ' + r.status);
        $('#aliKey').value = ''; await refresh(); say('Ключ проверен и подключён.'); window.getModels?.();
      } catch (e) { say(e.message, true); } finally { save.disabled = false; }
    };
    clear.onclick = async () => { await fetch('/local/alibaba', { method: 'DELETE' }); await refresh(); say('Ключ отключён.'); window.getModels?.(); };
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindKeyForm); else bindKeyForm();
  // The server forgets the key on restart: keep the side status honest.
  setInterval(status, 30000);

  window.FormaAlibaba = { status, extend, images, startVideo, resumeVideo, isAlibaba: meta => meta?.provider === 'alibaba', get connected() { return connected; } };
})();
