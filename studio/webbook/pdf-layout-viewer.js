window.addEventListener('load', () => {
  const toolbar = document.createElement('nav');
  toolbar.className = 'forma-pdf-toolbar'; toolbar.setAttribute('aria-label', 'Масштаб страницы');
  toolbar.innerHTML = '<button data-scale="0.8" aria-label="Уменьшить">−</button><button data-scale="1.25" aria-label="Увеличить">+</button><button data-fit>По ширине</button>';
  document.body.append(toolbar);
  const viewer = () => window.pdf2htmlEX?.defaultViewer;
  const fit = () => {
    const v = viewer(); if (!v?.pages?.length) return;
    // The native viewer can measure zero-sized frames while a dialog is hidden.
    // Recover the dimensions from the original content once it is visible.
    for (const p of v.pages) {
      if (!p.original_width || !p.original_height) {
        p.original_width = p.content_box.clientWidth;
        p.original_height = p.content_box.clientHeight;
        p.original_scale = 1;
      }
    }
    if (!v.pages.every(p => p.original_width && p.original_height)) return;
    v.rescale(1, false); v.fit_width(); v.rescale(0.96, true);
  };
  toolbar.querySelectorAll('[data-scale]').forEach(b => b.onclick = () => viewer()?.rescale(Number(b.dataset.scale), true));
  toolbar.querySelector('[data-fit]').onclick = fit;
  requestAnimationFrame(fit);
});
