(() => {
  window.createEbookPageHtml = async function createEbookPageHtml(root, pageNumber, videoUrl) {
    if (!root?.querySelector('.ebook-page-content')) throw new Error('Страница ещё не готова к экспорту.');

    // Export the page already rendered in the editor, rather than rebuilding its blocks.
    const copy = root.cloneNode(true);
    copy.removeAttribute('data-electronic-page-preview');
    copy.querySelector('.ebook-edit-hint')?.remove();
    copy.querySelector('.ebook-layout-tools')?.remove();
    copy.querySelector('.ebook-clone-layout-tools')?.remove();
    copy.querySelectorAll('.ebook-layout-handle').forEach(element => element.remove());
    copy.querySelectorAll('.ebook-png-qa-overlay, [data-editor-only]').forEach(element => element.remove());
    copy.querySelectorAll('[contenteditable]').forEach(element => element.removeAttribute('contenteditable'));

    const figure = copy.querySelector('.ebook-image-block, .ebook-clone-illustration');
    if (figure && videoUrl) {
      const video = document.createElement('video');
      video.className = 'ebook-video-overlay';
      video.src = videoUrl;
      video.controls = true;
      video.hidden = true;
      video.preload = 'metadata';
      video.style.cssText = 'position:absolute;inset:0;z-index:4;width:100%;height:100%;object-fit:cover;background:#000';
      figure.prepend(video);
    }

    // Object URLs are temporary and stop working after the editor tab is closed.
    // Inline page images and the optional short clip so the downloaded HTML is self-contained.
    const toDataUrl = blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Не удалось встроить изображение в HTML.'));
      reader.readAsDataURL(blob);
    });
    await Promise.all([...copy.querySelectorAll('video')].map(async video => {
      const source = video.getAttribute('src') || '';
      if (!source || source.startsWith('data:')) return;
      if (!source.startsWith('blob:') && !source.startsWith(location.origin + '/')) return;
      const response = await fetch(source);
      if (!response.ok) throw new Error('Не удалось встроить мини-клип в HTML-клон.');
      video.src = await toDataUrl(await response.blob());
    }));
    await Promise.all([...copy.querySelectorAll('img')].map(async image => {
      const source = image.getAttribute('src') || '';
      if (!source || source.startsWith('data:')) return;
      if (!source.startsWith('blob:') && !source.startsWith(location.origin + '/')) return;
      const response = await fetch(source);
      if (!response.ok) throw new Error('Не удалось встроить изображение в HTML-клон.');
      image.src = await toDataUrl(await response.blob());
    }));

    const response = await fetch('/script-workbench.css');
    if (!response.ok) throw new Error('Не удалось загрузить стили электронной страницы.');
    const components = await fetch('/webbook/components.css');
    if (!components.ok) throw new Error('Не удалось загрузить стили компонентов учебника.');
    const stylesheet = ((await response.text()) + '\n' + (await components.text())).replace(/<\/style/gi, '<\\/style');
    const safeTitle = String(pageNumber).replace(/[<>&"']/g, '');

    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HSK Course 1 — страница ${safeTitle}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;padding:20px;background:#e9e7e0;color:#2b2c27;font-family:Arial,sans-serif}
    .electronic-page-preview{display:block!important;width:min(600px,100%);min-height:0!important;margin:0 auto;padding:14px!important;background:#e9e7e0;border:0!important}
    .ebook-page-content{width:100%;margin-top:10px}
    .ebook-page-content [contenteditable]{cursor:default}
    video[hidden],img[hidden],button[hidden]{display:none!important}
  </style>
  <style>${stylesheet}</style>
</head>
<body>
  ${copy.outerHTML}
  <script>
    document.addEventListener('click', event => {
      const language = event.target.closest('[data-ebook-language]');
      if (language) {
        const page = document.querySelector('.ebook-page-content');
        page.dataset.languageMode = language.dataset.ebookLanguage;
        document.querySelectorAll('[data-ebook-language]').forEach(button => {
          button.setAttribute('aria-pressed', String(button === language));
        });
        return;
      }
      const cloneTrigger = event.target.closest('[data-ebook-play-clone]');
      const figure = cloneTrigger?.closest('.ebook-clone-illustration') || event.target.closest('.ebook-image-block');
      if (!figure || !(cloneTrigger || event.target.closest('[data-ebook-play],img[data-has-clip]'))) return;
      const video = figure.querySelector('video');
      if (!video) return;
      figure.querySelector('img')?.setAttribute('hidden', '');
      figure.querySelector('[data-ebook-play], [data-ebook-play-clone]')?.setAttribute('hidden', '');
      video.hidden = false;
      video.play().catch(() => {});
    });
  <\/script>
</body>
</html>`;
  };
})();
