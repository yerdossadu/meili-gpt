const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let active, timer;
export const pdfLayoutPanel = () => `<section class="panel pdf-layout-panel" id="pdfLayoutPanel">
  <div><b>Эталон PDF для сравнения</b><p>Прямой перенос PDF в HTML. Скан остаётся изображением и не заменяет текстовую учебную страницу. Для выбора слов, перевода и озвучивания используйте учебную веб-версию ниже.</p></div>
  <div class="pdf-layout-actions"><button class="btn" id="pdfLayoutPage" disabled>Конвертировать эту страницу</button><label>От <input class="input" id="pdfLayoutFrom" type="number" min="1" value="1"></label><label>До <input class="input" id="pdfLayoutTo" type="number" min="1" value="1"></label><button class="btn-quiet" id="pdfLayoutRange" disabled>Конвертировать диапазон</button></div>
  <div id="pdfLayoutStatus" class="status" role="status" aria-live="polite">Проверяем конвертер…</div><div id="pdfLayoutResults"></div>
  <dialog class="pdf-layout-dialog" id="pdfLayoutPreview"><header><b>Оригинал и веб-версия</b><button class="btn-quiet" id="pdfLayoutClose">Закрыть</button></header><p>Слева первая выбранная страница PDF; справа веб-версия всего выбранного диапазона. Масштаб в правой панели регулируется кнопками.</p><div class="pdf-layout-compare"><figure><figcaption>Оригинал PDF</figcaption><div><img id="pdfLayoutScan" alt="Исходная страница PDF"></div></figure><figure><figcaption>Веб-версия</figcaption><iframe id="pdfLayoutFrame" title="Веб-версия учебного материала" sandbox="allow-scripts allow-downloads"></iframe></figure></div></dialog>
</section>`;
async function api(path, options) {
  const response = await fetch('/local/pdf-layout/' + path, options), data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить конвертацию.'); return data;
}
function current(context) { return active === context && context.panel.isConnected; }
function status(context, text) { if (current(context)) context.panel.querySelector('#pdfLayoutStatus').textContent = text; }
function results(context, jobs) {
  const list = context.panel.querySelector('#pdfLayoutResults');
  list.innerHTML = jobs.slice(0,10).map(job => `<div class="pdf-layout-result"><span>Стр. ${job.from}${job.to === job.from ? '' : '–' + job.to} · ${{queued:'В очереди',running:'Обрабатывается',done:'Готово',error:'Ошибка'}[job.state] || job.state}</span>${job.state === 'done' ? `<button class="btn-quiet" data-pdf-preview="${esc(job.id)}">Сравнить с оригиналом</button><a class="btn-quiet" href="${esc(job.html)}" target="_blank" rel="noopener">Открыть HTML</a><a class="btn-quiet" href="${esc(job.download)}" download>Скачать ZIP</a>` : job.state === 'error' ? `<span class="pdf-layout-error">${esc(job.error)}</span>` : ''}</div>`).join('');
  list.querySelectorAll('[data-pdf-preview]').forEach(button => button.onclick = () => {
    const job = jobs.find(j => j.id === button.dataset.pdfPreview), dialog = context.panel.querySelector('#pdfLayoutPreview');
    dialog.querySelector('#pdfLayoutScan').src = job.scan; dialog.querySelector('#pdfLayoutFrame').src = job.html;
    dialog.showModal();
  });
}
async function refresh(context) {
  try {
    const jobs = await api(context.book);
    if (!current(context)) return;
    results(context,jobs);
    const busy = jobs.some(j => ['queued','running'].includes(j.state));
    context.panel.querySelector('#pdfLayoutPage').disabled = !context.available || busy;
    context.panel.querySelector('#pdfLayoutRange').disabled = !context.available || busy;
    if (busy) { status(context,'Конвертация идёт локально. Можно продолжать работу в FS; результат сохранится в библиотеке.'); timer = setTimeout(()=>refresh(context),1500); }
    else if (context.available) status(context,'pdf2htmlEX подключён. Результаты сохраняются отдельно от существующих страниц. Для сканированных PDF текст останется изображением.');
  } catch (e) { status(context,e.message); }
}
export async function mountPdfLayout(view, book, page, pages) {
  clearTimeout(timer);
  const panel = view.querySelector('#pdfLayoutPanel'); if (!panel) return;
  // Stop outstanding requests from an earlier book/page updating this panel.
  const context = {panel,book,page,pages,available:false}; active = context;
  panel.querySelector('#pdfLayoutResults').innerHTML = '';
  panel.querySelector('#pdfLayoutPage').disabled = true; panel.querySelector('#pdfLayoutRange').disabled = true;
  status(context,'Проверяем конвертер…');
  panel.querySelector('#pdfLayoutFrom').value = page; panel.querySelector('#pdfLayoutTo').value = page;
  panel.querySelector('#pdfLayoutFrom').max = pages; panel.querySelector('#pdfLayoutTo').max = pages;
  panel.querySelector('#pdfLayoutClose').onclick = () => { panel.querySelector('#pdfLayoutPreview').close(); panel.querySelector('#pdfLayoutFrame').removeAttribute('src'); };
  async function convert(from,to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > pages) { status(context,`Выберите диапазон от 1 до ${pages}.`); return; }
    panel.querySelector('#pdfLayoutPage').disabled = true; panel.querySelector('#pdfLayoutRange').disabled = true;
    status(context,'Запускаем конвертацию…');
    try { await api(book,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from,to})}); if(current(context)) await refresh(context); }
    catch(e) { status(context,e.message); if(current(context)) { panel.querySelector('#pdfLayoutPage').disabled = !context.available; panel.querySelector('#pdfLayoutRange').disabled = !context.available; } }
  }
  panel.querySelector('#pdfLayoutPage').onclick = () => convert(page,page);
  panel.querySelector('#pdfLayoutRange').onclick = () => convert(Number(panel.querySelector('#pdfLayoutFrom').value),Number(panel.querySelector('#pdfLayoutTo').value));
  try { const info = await api('status'); if (!current(context)) return; context.available = info.available; if(!info.available) status(context,info.error); await refresh(context); }
  catch(e) { status(context,e.message); }
}
