// Splash page: renders what the shell says (src-tauri/src/shell.rs, `Splash`). The shell
// pushes updates with window.swarmcastSplash(status); on load we ask for the current one.
// Texts come localized from the shell; the fallbacks below only cover the first paint.
(() => {
  const ipc = window.__TAURI_INTERNALS__;
  const invoke = (cmd) => (ipc ? ipc.invoke(cmd) : Promise.reject(new Error('no IPC')));
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('.splash');
  const spinner = document.querySelector('.spinner');
  const bar = document.querySelector('.bar');
  const fill = document.querySelector('.fill');
  const pct = document.querySelector('.pct');

  const pt = (navigator.language || '').toLowerCase().startsWith('pt');
  if (pt) {
    document.documentElement.lang = 'pt-BR';
    $('title').textContent = 'Abrindo o SwarmCast…';
    $('detail').textContent = 'Isso costuma levar só alguns segundos.';
    $('retry').textContent = 'Tentar de novo';
    $('logs').textContent = 'Abrir pasta de logs';
  }

  function render(s) {
    if (!s) return;
    root.dataset.state = s.state === 'error' ? 'error' : 'busy';
    if (typeof s.title === 'string') $('title').textContent = s.title;
    if (typeof s.detail === 'string') $('detail').textContent = s.detail;
    const hasProgress = typeof s.progress === 'number';
    spinner.hidden = hasProgress;
    bar.hidden = !hasProgress;
    pct.hidden = !hasProgress;
    if (hasProgress) {
      const p = Math.max(0, Math.min(1, s.progress));
      fill.style.width = `${(p * 100).toFixed(1)}%`;
      pct.textContent = `${Math.floor(p * 100)}%`;
    }
    document.title = s.title || 'SwarmCast';
  }

  window.swarmcastSplash = render;

  $('retry').addEventListener('click', () => void invoke('splash_retry').catch(() => {}));
  $('logs').addEventListener('click', () => void invoke('splash_open_logs').catch(() => {}));

  invoke('splash_status')
    .then((status) => {
      if (status.lang) document.documentElement.lang = status.lang;
      const texts = status.texts || {};
      if (texts.retry) $('retry').textContent = texts.retry;
      if (texts.open_logs) $('logs').textContent = texts.open_logs;
      render(status);
    })
    .catch(() => {});
})();
