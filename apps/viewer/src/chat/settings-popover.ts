// The chat's gear menu: your name colour (when the streamer lets viewers choose and has not
// locked yours), show times, text size. Choices about this device are kept in prefs.ts; the
// colour goes to the server (chat.color), which tells everyone.
import { t } from '@swarmcast/shared/i18n';
import { createColorChooser } from './color-ui.js';
import { createPopover, type Popover } from './popover.js';
import { loadPrefs, savePrefs, type ChatPrefs } from './prefs.js';

export interface SettingsPopover {
  popover: Popover;
  /** Colour section: shown with the current colour and nickname, or hidden (null). */
  setColor(state: { color: string; nick: string; locked: boolean } | null): void;
}

export function createSettingsPopover(button: HTMLButtonElement, opts: { onColor(color: string): void; onPrefs(p: ChatPrefs): void }): SettingsPopover {
  const panel = document.createElement('div');
  panel.className = 'chat-pop chat-settings';
  panel.setAttribute('aria-label', t('chat.viewer.settings'));
  panel.dataset.testid = 'chat-settings';

  const colorSection = document.createElement('section');
  const colorTitle = document.createElement('h3');
  colorTitle.textContent = t('chat.viewer.color');
  const colorNote = document.createElement('p');
  colorNote.className = 'muted small';
  const chooser = createColorChooser((c) => opts.onColor(c));
  colorSection.append(colorTitle, chooser.element, colorNote);

  const prefs = loadPrefs();
  const times = document.createElement('label');
  times.className = 'check-row';
  const timesBox = document.createElement('input');
  timesBox.type = 'checkbox';
  timesBox.checked = prefs.times;
  timesBox.dataset.testid = 'chat-times';
  const timesText = document.createElement('span');
  timesText.textContent = t('chat.viewer.times');
  times.append(timesBox, timesText);
  timesBox.addEventListener('change', () => opts.onPrefs(savePrefs({ times: timesBox.checked })));

  const size = document.createElement('fieldset');
  size.className = 'size-row';
  const legend = document.createElement('legend');
  legend.textContent = t('chat.viewer.textSize');
  size.append(legend);
  for (const large of [false, true]) {
    const l = document.createElement('label');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'chat-size';
    r.checked = prefs.large === large;
    r.addEventListener('change', () => {
      if (r.checked) opts.onPrefs(savePrefs({ large }));
    });
    const s = document.createElement('span');
    s.textContent = t(large ? 'chat.viewer.textSize.large' : 'chat.viewer.textSize.normal');
    l.append(r, s);
    size.append(l);
  }
  panel.append(colorSection, times, size);
  const popover = createPopover(button, panel);

  return {
    popover,
    setColor(state) {
      colorSection.hidden = state === null;
      if (!state) return;
      chooser.element.hidden = state.locked;
      colorNote.textContent = state.locked ? t('chat.viewer.color.locked') : t('chat.viewer.color.tip');
      chooser.set(state.color, state.nick);
    },
  };
}
