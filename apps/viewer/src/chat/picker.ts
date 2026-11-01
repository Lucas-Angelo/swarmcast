// Emoji and emote picker (plan §5.7). The SwarmCast emotes are there at once; the Unicode emoji
// (RGI, from emojibase-data, filtered at build time: scripts/emoji-data.mjs) come in a lazy
// chunk loaded the first time the picker opens. Emoji render in the system font.
//
// About 1,900 emoji buttons at once took the page's main thread for seconds on slow machines (and
// the first lay-out of the emoji font with them), so the picker builds only what is in view when it
// opens: each emoji category gets its heading and an empty grid of its final height (marked
// data-pending until it is complete), the rows in view are added at once, the rows a screen ahead
// as the list scrolls, and the rest in small steps when the page is idle (requestIdleCallback, a
// timer in Safari). An arrow key in the grid first adds whatever is still missing, so the arrows
// walk every emoji as before. Search is not affected: it shows at most SEARCH_MAX results.
import { isMessageKey, t, type MessageKey } from '@swarmcast/shared/i18n';
import type { Emote } from './emotes.js';
import { createPopover, type Popover } from './popover.js';
import { pagePrefs, RECENT_MAX, type PrefsStore } from './prefs.js';

/** [emoji, label, keywords, five one-tone variants?] */
export type EmojiRow = [string, string, string, string[]?];
export interface EmojiData {
  v: number;
  unicode: string;
  groups: Array<[number, EmojiRow[]]>;
}

export interface PickerDeps {
  /** Emotes usable now (empty when emotes are off). */
  emotes(): readonly Emote[];
  /** Emoji allowed now (content includes 'emotes': emoji count as emotes, plan Q7). */
  emojiAllowed(): boolean;
  load(): Promise<EmojiData>;
  onPick(text: string): void;
  /** Where the tone and the recent picks are kept (the page's chat prefs by default). */
  prefs?: PrefsStore;
}

const SEARCH_MAX = 200;
/** Emoji buttons added per step of the background fill: a small part of a frame on a slow phone. */
const FILL_STEP = 48;
/** The background fill runs at the latest this long after it was due, also on a page that is never idle (a busy chat). */
const IDLE_TIMEOUT_MS = 200;
/** One step of the background fill without requestIdleCallback (Safari): how long it may run. */
const SLICE_MS = 8;
const TONE_SWATCHES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

export interface Picker {
  popover: Popover;
  panel: HTMLElement;
  /** Resolves when the emoji data is in (tests). */
  ready(): Promise<void>;
}

/** An emoji category whose grid is built a part at a time: its rows, and how many of them are in. */
interface LazyGrid {
  grid: HTMLElement;
  list: EmojiRow[];
  next: number;
}

/**
 * Runs `step` when the page is idle (requestIdleCallback, at the latest after IDLE_TIMEOUT_MS) or
 * on a timer where there is no such thing (Safari). `more()` says whether the step may go on.
 * Returns the cancel.
 */
function whenIdle(step: (more: () => boolean) => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback((d) => step(() => d.timeRemaining() > 1), { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => {
    const end = performance.now() + SLICE_MS;
    step(() => performance.now() < end);
  }, 0);
  return () => clearTimeout(id);
}

export function createPicker(button: HTMLButtonElement, deps: PickerDeps): Picker {
  button.type = 'button';
  button.className = 'chat-tool picker-btn';
  button.textContent = '☺';
  button.setAttribute('aria-label', t('chat.viewer.picker'));
  button.title = t('chat.viewer.picker');
  button.dataset.testid = 'chat-picker-button';
  const prefs = deps.prefs ?? pagePrefs;

  const panel = document.createElement('div');
  panel.className = 'chat-pop chat-picker';
  panel.setAttribute('aria-label', t('chat.viewer.picker'));
  panel.dataset.testid = 'chat-picker';
  const head = document.createElement('div');
  head.className = 'picker-head';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = t('chat.viewer.picker.search');
  search.setAttribute('aria-label', t('chat.viewer.picker.search'));
  search.dataset.testid = 'chat-picker-search';
  const tones = document.createElement('div');
  tones.className = 'tones';
  tones.setAttribute('role', 'radiogroup');
  tones.setAttribute('aria-label', t('chat.viewer.picker.tone'));
  head.append(search, tones);
  const body = document.createElement('div');
  body.className = 'picker-body';
  panel.append(head, body);

  let data: EmojiData | null = null;
  let loading: Promise<void> | null = null;
  let failed = false;
  /** emoji → its row, to show recent emoji in the current tone. */
  const rows = new Map<string, EmojiRow>();

  const withTone = (row: EmojiRow): string => {
    const tone = prefs.load().tone;
    return tone > 0 && row[3] ? (row[3][tone - 1] ?? row[0]) : row[0];
  };

  const pick = (insert: string, recentKey: string): void => {
    const recent = [recentKey, ...prefs.load().recent.filter((r) => r !== recentKey)].slice(0, RECENT_MAX);
    prefs.save({ recent });
    deps.onPick(insert);
  };

  const emojiButton = (row: EmojiRow): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.tabIndex = -1;
    const ch = withTone(row);
    b.textContent = ch;
    b.title = row[1];
    b.setAttribute('aria-label', row[1]);
    b.addEventListener('click', () => pick(ch, row[0]));
    return b;
  };

  const emoteButton = (e: Emote): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick emote';
    b.tabIndex = -1;
    const img = document.createElement('img');
    img.src = e.url;
    if (e.url2x) img.srcset = `${e.url2x} 2x`;
    img.alt = '';
    img.width = 28;
    img.height = 28;
    img.decoding = 'async';
    b.append(img);
    b.title = `:${e.code}:`;
    b.setAttribute('aria-label', `:${e.code}:`);
    b.dataset.code = e.code;
    b.addEventListener('click', () => pick(`:${e.code}: `, `:${e.code}:`));
    return b;
  };

  const section = (title: string, items: HTMLElement[], id?: string, pending = false): HTMLElement => {
    const s = document.createElement('section');
    if (id) s.dataset.group = id;
    const h = document.createElement('h4');
    h.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', title);
    if (pending) grid.dataset.pending = '';
    grid.append(...items);
    s.append(h, grid);
    return s;
  };

  const note = (key: MessageKey, retry = false): HTMLElement => {
    const p = document.createElement('p');
    p.className = 'muted small picker-note';
    p.textContent = t(key);
    if (retry) {
      p.tabIndex = 0;
      p.classList.add('retry');
      p.addEventListener('click', () => {
        failed = false;
        void ensureData();
      });
    }
    return p;
  };

  const recentButtons = (): HTMLElement[] => {
    const emotes = new Map(deps.emotes().map((e) => [`:${e.code}:`, e]));
    const out: HTMLElement[] = [];
    for (const r of prefs.load().recent) {
      const em = emotes.get(r);
      if (em) out.push(emoteButton(em));
      else if (deps.emojiAllowed() && rows.has(r)) out.push(emojiButton(rows.get(r)!));
    }
    return out;
  };

  /** The emoji categories of the current list still being built (null: all in). */
  let filling: { lazy: LazyGrid[]; stop: () => void } | null = null;

  const addRows = (lz: LazyGrid, count: number): void => {
    const end = Math.min(lz.list.length, lz.next + count);
    if (end <= lz.next) return;
    lz.grid.append(...lz.list.slice(lz.next, end).map(emojiButton));
    lz.next = end;
    if (end === lz.list.length) {
      delete lz.grid.dataset.pending;
      lz.grid.style.removeProperty('min-height');
    }
  };

  const stopFilling = (): void => {
    filling?.stop();
    filling = null;
  };

  /** Adds every emoji still missing (a key moves through the grid; no layout to measure). */
  const fillAll = (): void => {
    for (const lz of filling?.lazy ?? []) addRows(lz, Infinity);
    stopFilling();
  };

  /**
   * Builds the categories of `lazy` (just put in the list, their grids empty): sized to their
   * final height, the rows in view now, the rest as described at the top of this file.
   */
  const startFilling = (lazy: LazyGrid[]): void => {
    const first = lazy[0];
    if (!first) return;
    let frame = 0;
    let cancelIdle = (): void => {};
    const onScroll = (): void => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        fillInView(body.clientHeight);
      });
    };
    const current: NonNullable<typeof filling> = {
      lazy,
      stop: () => {
        body.removeEventListener('scroll', onScroll);
        cancelAnimationFrame(frame);
        cancelIdle();
      },
    };
    filling = current;
    addRows(first, 1);
    // Measured on the first emoji, laid out even when its category is out of view.
    first.grid.style.setProperty('content-visibility', 'visible');
    const probe = first.grid.firstElementChild as HTMLElement | null;
    const width = first.grid.clientWidth;
    const cell = probe?.offsetWidth ?? 0;
    const rowH = probe?.offsetHeight ?? 0;
    first.grid.style.removeProperty('content-visibility');
    if (!(width > 0 && cell > 0 && rowH > 0)) {
      fillAll();
      return;
    }
    const cols = Math.max(1, Math.round(width / cell));
    for (const lz of lazy) {
      const h = Math.ceil(lz.list.length / cols) * rowH;
      lz.grid.style.setProperty('min-height', `${h}px`);
      lz.grid.style.setProperty('contain-intrinsic-block-size', `auto ${h}px`);
    }
    /** Adds the rows from the top of each category down to `ahead` px below the visible part. */
    const fillInView = (ahead: number): void => {
      const open = lazy.filter((lz) => lz.next < lz.list.length);
      const view = body.getBoundingClientRect();
      const bottom = view.bottom + ahead;
      const rects = open.map((lz) => lz.grid.getBoundingClientRect());
      open.forEach((lz, i) => {
        const r = rects[i]!;
        if (r.bottom > view.top && r.top < bottom) addRows(lz, Math.ceil((bottom - r.top) / rowH) * cols - lz.next);
      });
    };
    fillInView(0);
    body.addEventListener('scroll', onScroll, { passive: true });
    const step = (more: () => boolean): void => {
      if (filling !== current) return;
      if (!popover.isOpen) {
        stopFilling();
        return;
      }
      do {
        const lz = lazy.find((l) => l.next < l.list.length);
        if (!lz) {
          stopFilling();
          return;
        }
        addRows(lz, FILL_STEP);
      } while (more());
      cancelIdle = whenIdle(step);
    };
    cancelIdle = whenIdle(step);
  };

  const render = (): void => {
    stopFilling();
    const q = search.value.trim().toLowerCase();
    const parts: HTMLElement[] = [];
    const lazy: LazyGrid[] = [];
    if (q) {
      const terms = q.split(/\s+/);
      const found: HTMLElement[] = [];
      for (const e of deps.emotes()) if (terms.every((term) => e.code.includes(term.replace(/:/g, '')))) found.push(emoteButton(e));
      if (data && deps.emojiAllowed()) {
        for (const [, list] of data.groups) {
          for (const row of list) {
            if (found.length >= SEARCH_MAX) break;
            if (terms.every((term) => row[2].includes(term))) found.push(emojiButton(row));
          }
        }
      }
      parts.push(found.length ? section(t('chat.viewer.picker.search'), found) : note('chat.viewer.picker.none'));
    } else {
      const recent = recentButtons();
      if (recent.length) parts.push(section(t('chat.viewer.picker.recent'), recent, 'recent'));
      const emotes = deps.emotes();
      if (emotes.length) parts.push(section(t('chat.viewer.picker.emotes'), emotes.map(emoteButton), 'emotes'));
      if (deps.emojiAllowed()) {
        if (data) {
          for (const [g, list] of data.groups) {
            const s = section(groupTitle(g), [], String(g), true);
            lazy.push({ grid: s.lastElementChild as HTMLElement, list, next: 0 });
            parts.push(s);
          }
        } else parts.push(failed ? note('chat.viewer.picker.failed', true) : note('chat.viewer.picker.loading'));
      }
    }
    body.replaceChildren(...parts);
    startFilling(lazy);
    const first = body.querySelector<HTMLButtonElement>('button.pick');
    if (first) first.tabIndex = 0;
  };

  const renderTones = (): void => {
    const current = prefs.load().tone;
    tones.replaceChildren(
      ...TONE_SWATCHES.map((sw, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tone';
        b.textContent = sw;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(i === current));
        b.setAttribute('aria-label', i === 0 ? t('chat.viewer.picker.tone.default') : `${t('chat.viewer.picker.tone')} ${i}`);
        b.addEventListener('click', () => {
          prefs.save({ tone: i });
          renderTones();
          render();
        });
        return b;
      }),
    );
    tones.hidden = !deps.emojiAllowed();
  };

  const ensureData = (): Promise<void> => {
    if (data || !deps.emojiAllowed()) return Promise.resolve();
    loading ??= deps
      .load()
      .then((d) => {
        data = d;
        for (const [, list] of d.groups) for (const row of list) rows.set(row[0], row);
      })
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        loading = null;
        if (popover.isOpen) render();
      });
    return loading;
  };

  // Arrow keys move between the buttons of the grid (one tab stop for the whole grid).
  body.addEventListener('keydown', (e) => {
    const cur = (e.target as HTMLElement).closest?.('button.pick');
    if (!cur || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (filling) fillAll();
    const all = [...body.querySelectorAll<HTMLButtonElement>('button.pick')];
    const i = all.indexOf(cur as HTMLButtonElement);
    const top = all[0]?.offsetTop ?? 0;
    const cols = Math.max(1, all.findIndex((b) => b.offsetTop !== top) === -1 ? all.length : all.findIndex((b) => b.offsetTop !== top));
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = all[Math.min(all.length - 1, Math.max(0, i + step))];
    if (next) {
      for (const b of all) b.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });
  search.addEventListener('input', render);

  const popover = createPopover(button, panel, {
    onOpen: () => {
      search.value = '';
      renderTones();
      render();
      void ensureData();
      search.focus();
    },
  });
  return { popover, panel, ready: () => loading ?? Promise.resolve() };
}

function groupTitle(g: number): string {
  const key = `chat.viewer.picker.group.${g}`;
  return isMessageKey(key) ? t(key) : '';
}
