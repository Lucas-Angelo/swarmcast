// The GIF picker (plan 5.6). Before the viewer agrees, it only explains what happens and asks;
// no request goes to the provider. After that: the provider's attribution in the search box
// ("Search KLIPY", required by KLIPY) and under the grid, trending GIFs, search with a short
// debounce, and a pick sends a checked GIF reference.
import { t } from '@swarmcast/shared/i18n';
import { GIF_PROVIDERS, type GifRef } from './core/index.js';
import { searchGifs, type GifConfig, type GifResult } from './gif-api.js';
import { createPopover, type Popover } from './popover.js';
import { GIF_PROVIDER_NAMES } from './render.js';

export interface GifPickerDeps {
  /** The streamer's GIF settings, or null while GIFs are off. */
  config(): GifConfig | null;
  consented(): boolean;
  /** The viewer agreed (remembered by the caller). */
  consent(): void;
  onPick(ref: GifRef): void;
  /** Test seam. */
  search?: typeof searchGifs;
  debounceMs?: number;
}

export interface GifPicker {
  popover: Popover;
  panel: HTMLElement;
  /** Resolves when the running search is done (tests). */
  idle(): Promise<void>;
  /** Re-read settings and consent (shown or hidden, consent view or search). */
  update(): void;
}

export function createGifPicker(button: HTMLButtonElement, deps: GifPickerDeps): GifPicker {
  button.type = 'button';
  button.className = 'chat-tool gif-btn';
  button.textContent = t('chat.viewer.gif');
  button.setAttribute('aria-label', t('chat.viewer.gif.button'));
  button.title = t('chat.viewer.gif.button');
  button.dataset.testid = 'chat-gif-button';

  const panel = document.createElement('div');
  panel.className = 'chat-pop chat-gif';
  panel.setAttribute('aria-label', t('chat.viewer.gif.button'));
  panel.dataset.testid = 'chat-gif';
  const search = deps.search ?? searchGifs;
  let running: Promise<void> = Promise.resolve();
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const providerName = (): string => {
    const c = deps.config();
    return c ? GIF_PROVIDER_NAMES[c.provider] : '';
  };

  const consentView = (): void => {
    const p = document.createElement('p');
    p.className = 'gif-consent-text';
    p.textContent = t('chat.viewer.gif.consent', { provider: providerName() });
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.dataset.testid = 'chat-gif-allow';
    allow.textContent = t('chat.viewer.gif.allow', { provider: providerName() });
    allow.addEventListener('click', () => {
      deps.consent();
      render();
    });
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'secondary';
    later.textContent = t('chat.viewer.gif.notNow');
    later.addEventListener('click', () => popover.close());
    const row = document.createElement('div');
    row.className = 'gif-consent-actions';
    row.append(allow, later);
    panel.replaceChildren(p, row);
    allow.focus();
  };

  const grid = document.createElement('div');
  grid.className = 'gif-grid';
  const status = document.createElement('p');
  status.className = 'muted small gif-status';
  status.setAttribute('role', 'status');
  const input = document.createElement('input');
  input.type = 'search';
  input.dataset.testid = 'chat-gif-search';
  const attribution = document.createElement('p');
  attribution.className = 'muted small gif-attribution';

  const showResults = (results: GifResult[]): void => {
    status.textContent = results.length ? '' : t('chat.viewer.gif.none');
    grid.replaceChildren(
      ...results.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gif-pick';
        b.title = r.title;
        b.setAttribute('aria-label', r.title || t('chat.viewer.gif'));
        const img = document.createElement('img');
        img.src = r.url;
        img.alt = '';
        img.width = r.ref.w;
        img.height = r.ref.h;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        b.append(img);
        b.addEventListener('click', () => {
          deps.onPick(r.ref);
          popover.close();
        });
        return b;
      }),
    );
  };

  const run = (q: string): void => {
    const cfg = deps.config();
    if (!cfg || !deps.consented()) return;
    abort?.abort();
    const ctl = new AbortController();
    abort = ctl;
    status.textContent = t('chat.viewer.gif.loading');
    running = search(cfg, q, { signal: ctl.signal })
      .then((r) => {
        if (abort === ctl) showResults(r);
      })
      .catch(() => {
        if (abort === ctl && !ctl.signal.aborted) {
          grid.replaceChildren();
          status.textContent = t('chat.viewer.gif.failed');
        }
      });
  };

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => run(input.value), deps.debounceMs ?? 400);
  });

  const searchView = (): void => {
    const cfg = deps.config();
    if (!cfg) return;
    // The provider's own attribution text, as their terms ask (not translated).
    input.placeholder = cfg.provider === 'klipy' ? GIF_PROVIDERS.klipy.attribution : `Search ${GIF_PROVIDER_NAMES[cfg.provider]}`;
    input.setAttribute('aria-label', input.placeholder);
    attribution.textContent = cfg.provider === 'giphy' ? GIF_PROVIDERS.giphy.attribution : `Powered by ${GIF_PROVIDER_NAMES[cfg.provider]}`;
    panel.replaceChildren(input, status, grid, attribution);
    input.value = '';
    run('');
    input.focus();
  };

  const render = (): void => {
    if (!deps.config()) return;
    if (deps.consented()) searchView();
    else consentView();
  };

  const popover = createPopover(button, panel, { onOpen: render });
  return {
    popover,
    panel,
    idle: () => running,
    update() {
      const on = deps.config() !== null;
      button.hidden = !on;
      if (!on) popover.close();
    },
  };
}
