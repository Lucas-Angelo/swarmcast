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
  /** GIF section (consent, animation): shown while the streamer has GIFs on. */
  setGifs(state: { provider: string; consented: boolean; animate: boolean } | null): void;
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
  const gifs = document.createElement('div');
  gifs.className = 'gif-settings';
  const check = (testid: string, onChange: (on: boolean) => void): { label: HTMLLabelElement; box: HTMLInputElement; text: HTMLSpanElement } => {
    const label = document.createElement('label');
    label.className = 'check-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.testid = testid;
    const text = document.createElement('span');
    label.append(box, text);
    box.addEventListener('change', () => onChange(box.checked));
    return { label, box, text };
  };
  const gifConsent = check('chat-gif-consent', (on) => opts.onPrefs(savePrefs({ gifs: on })));
  const gifAnimate = check('chat-gif-animate', (on) => opts.onPrefs(savePrefs({ animate: on })));
  gifAnimate.text.textContent = t('chat.viewer.animate');
  gifs.append(gifConsent.label, gifAnimate.label);
  gifs.hidden = true;
  panel.append(colorSection, times, size, gifs);
  const popover = createPopover(button, panel);

  return {
    popover,
    setGifs(state) {
      gifs.hidden = state === null;
      if (!state) return;
      gifConsent.text.textContent = t('chat.viewer.gif.setting', { provider: state.provider });
      gifConsent.box.checked = state.consented;
      gifAnimate.box.checked = state.animate;
      gifAnimate.label.hidden = !state.consented;
    },
    setColor(state) {
      colorSection.hidden = state === null;
      if (!state) return;
      chooser.element.hidden = state.locked;
      colorNote.textContent = state.locked ? t('chat.viewer.color.locked') : t('chat.viewer.color.tip');
      chooser.set(state.color, state.nick);
    },
  };
}
