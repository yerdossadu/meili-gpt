(function () {
  'use strict';
  const toolbar = document.querySelector('.toolbar'), tabs = document.querySelector('.tab-switcher');
  const nav = document.createElement('nav'); nav.className = 'workspace-nav'; nav.setAttribute('aria-label', 'Режим занятия');
  const read = document.createElement('button'); read.id = 'tabRead'; read.type = 'button'; read.className = 'tab-btn'; read.textContent = 'Учебник';
  const vocab = document.createElement('button'); vocab.id = 'tabVocab'; vocab.type = 'button'; vocab.className = 'tab-btn'; vocab.textContent = 'Словарь';
  tabs.prepend(read); tabs.insertBefore(vocab, document.getElementById('tabTutor'));
  tabs.removeAttribute('role'); nav.append(tabs);
  const note = document.createElement('span'); note.className = 'workspace-note'; note.textContent = 'Читайте, практикуйтесь, возвращайтесь к словам'; nav.append(note);
  toolbar.after(nav);
  const classic = document.createElement('a'); classic.href = '/?design=classic'; classic.className = 'classic-link'; classic.textContent = 'Старая версия';
  classic.title = 'Открыть прежний интерфейс с теми же уроками и прогрессом'; toolbar.querySelector('.brand-group').append(classic);
  const modes = { tabRead: 'read', tabVocab: 'vocab', tabTutor: 'tutor', tabCards: 'cards', tabWrite: 'write', tabStudio: 'record' };
  const studio = document.getElementById('tabStudio'); studio.textContent = 'Запись'; studio.title = 'Записать ответ в учебной платформе';
  function setMode(id) {
    const mode = modes[id]; document.body.dataset.studyMode = mode;
    Object.keys(modes).forEach(key => {
      const button = document.getElementById(key), active = key === id;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('mainStageGrid').style.removeProperty('--book-col');
    if (mode === 'read' || mode === 'vocab') {
      if (typeof cleanupAllMedia === 'function') cleanupAllMedia();
      document.getElementById('gymSection').classList.remove('active');
    }
    window.dispatchEvent(new Event('resize'));
  }
  Object.keys(modes).forEach(id => document.getElementById(id).addEventListener('click', () => setMode(id)));
  setMode('tabRead');
  const card = document.getElementById('cardStage'); card.tabIndex = 0; card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Карточка слова. Enter или пробел — перевернуть');
  card.addEventListener('keydown', event => {
    if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); card.click(); }
  });
  const syncCard = () => {
    const flipped = card.classList.contains('flipped');
    const front = card.querySelector('.front'), back = card.querySelector('.back');
    front.setAttribute('aria-hidden', String(flipped)); back.setAttribute('aria-hidden', String(!flipped));
    front.inert = flipped; back.inert = !flipped;
  };
  new MutationObserver(syncCard).observe(card, { attributes: true, attributeFilter: ['class'] }); syncCard();
  ['prevPageBtn', 'nextPageBtn', 'fcPrevBtn', 'fcNextBtn', 'closeModalBtn'].forEach((id, i) => document.getElementById(id).setAttribute('aria-label', ['Предыдущая страница', 'Следующая страница', 'Предыдущее слово', 'Следующее слово', 'Закрыть отчёт'][i]));
  const modal = document.getElementById('parentModal'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Прогресс и отчёт');
  let previousFocus;
  const observer = new MutationObserver(() => {
    if (modal.classList.contains('active')) { previousFocus = document.activeElement; document.getElementById('closeModalBtn').focus(); }
    else if (previousFocus?.isConnected) previousFocus.focus();
  }); observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { document.getElementById('closeModalBtn').click(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(modal.querySelectorAll('button,a,input,select,textarea,[tabindex="0"]')).filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
})();
