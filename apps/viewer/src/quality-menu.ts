/**
 * Viewer quality menu: "Auto (720p)" / 1080p / 720p / 480p / "Audio only (saves data)", built
 * from hls.levels. Manual picks switch at the next segment (no buffer flush, so no stall); "Auto"
 * hands control back to hls.js ABR. The pick is remembered by height for the next visit.
 * "Audio only" (audio-only.ts) loads the audio-only playlist instead; while it plays, the menu
 * offers the video qualities of the last normal playlists, and picking one loads them again.
 *
 * A WAI-ARIA menu button (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) in the player's
 * control bar (player-controls.ts), the same in every browser: a button that says the quality in
 * use and opens a menu of `menuitemradio` entries (arrow keys, Home / End, Enter / Space, Esc).
 * Not a native <select>: WebKit's own inner parts of every <select> carry an inline style that the
 * viewer CSP (style-src 'self', no 'unsafe-inline') refuses, a `style-src-attr` violation on each
 * page load in Safari (the element alone does it, even never attached to the page).
 */
import type Hls from 'hls.js';
import './quality.css';
import { loadPreferredHeight, savePreferredHeight } from './player-config.js';
import type { AudioOnlySwitch } from './audio-only.js';

export interface QualityMenuLabels {
  auto: string;
  /** Shown next to "Auto" with the level currently playing, e.g. "Auto (720p)". */
  autoWith: (label: string) => string;
  title: string;
  /** The audio-only entry, e.g. "Audio only (saves data)". */
  audioOnly: string;
  /** What the choices mean, under the menu (optional). */
  hint?: string;
}

export const DEFAULT_QUALITY_LABELS: QualityMenuLabels = {
  auto: 'Auto',
  autoWith: (l) => `Auto (${l})`,
  title: 'Video quality',
  audioOnly: 'Audio only (saves data)',
};

/** Option value of the audio-only entry (the others are level indexes, or `h<height>` while audio only is on). */
export const AUDIO_ONLY_OPTION = 'audio';

type HlsLike = Pick<Hls, 'levels' | 'currentLevel' | 'loadLevel' | 'nextLevel' | 'autoLevelEnabled' | 'on' | 'off'>;

export function levelLabel(level: { height?: number; bitrate?: number }): string {
  if (level.height) return `${level.height}p`;
  return level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : '?';
}

/** Index of the level whose height is closest to `height` (at or below it when possible). */
export function levelForHeight(levels: Array<{ height?: number }>, height: number): number {
  let best = -1;
  levels.forEach((l, i) => {
    const h = l.height ?? 0;
    const bh = best >= 0 ? (levels[best]!.height ?? 0) : -1;
    if (h <= height && h > bh) best = i;
  });
  if (best >= 0) return best;
  // Everything is above the wish: take the smallest.
  let min = 0;
  levels.forEach((l, i) => {
    if ((l.height ?? 0) < (levels[min]!.height ?? 0)) min = i;
  });
  return levels.length ? min : -1;
}

export interface QualityMenu {
  /** The menu's root: the button and its popup. Hidden when there is nothing to choose. */
  element: HTMLElement;
  button: HTMLButtonElement;
  /** The role="menu" list of entries (`[role=menuitemradio]`, `data-value`, `aria-checked`). */
  menu: HTMLElement;
  readonly open: boolean;
  /** Rebuild from hls.levels (call on MANIFEST_PARSED). */
  refresh(): void;
  close(focusButton?: boolean): void;
  destroy(): void;
}

export interface QualityMenuOptions {
  /** The menu opened or closed (player-controls.ts keeps the bar shown while it is open). */
  onOpenChange?(open: boolean): void;
}

let menuSeq = 0;

/**
 * Create the menu inside `container`. `events` are hls.js event names (pass Hls.Events) so
 * this module does not import hls.js at runtime.
 */
export function createQualityMenu(
  hls: HlsLike,
  container: HTMLElement,
  events: { MANIFEST_PARSED: string; LEVEL_SWITCHED: string },
  labels: QualityMenuLabels = DEFAULT_QUALITY_LABELS,
  audio?: Pick<AudioOnlySwitch, 'active' | 'available' | 'heights' | 'set' | 'subscribe'>,
  options: QualityMenuOptions = {},
): QualityMenu {
  const doc = container.ownerDocument;
  const id = `quality-menu-${++menuSeq}`;
  const root = doc.createElement('div');
  root.className = 'quality';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'pc-btn quality-btn';
  button.dataset.testid = 'quality';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  const buttonText = doc.createElement('span');
  buttonText.className = 'quality-current';
  button.append(buttonText);
  const pop = doc.createElement('div');
  pop.className = 'quality-pop';
  pop.hidden = true;
  const heading = doc.createElement('p');
  heading.className = 'quality-title';
  heading.textContent = labels.title;
  heading.setAttribute('aria-hidden', 'true');
  const menu = doc.createElement('div');
  menu.className = 'quality-menu';
  menu.id = id;
  menu.dataset.testid = 'quality-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', labels.title);
  pop.append(heading, menu);
  if (labels.hint) {
    const hint = doc.createElement('p');
    hint.className = 'quality-hint';
    hint.id = `${id}-hint`;
    hint.textContent = labels.hint;
    menu.setAttribute('aria-describedby', hint.id);
    pop.append(hint);
  }
  root.append(button, pop);
  container.appendChild(root);

  let current = '-1';
  const items = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  const add = (text: string, value: string): void => {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'quality-item';
    item.setAttribute('role', 'menuitemradio');
    item.tabIndex = -1;
    item.dataset.value = value;
    item.textContent = text;
    menu.append(item);
  };
  /** Marks the entry in use and puts its name on the button. */
  const check = (value: string): void => {
    current = value;
    let text = '';
    for (const item of items()) {
      const on = item.dataset.value === value;
      item.setAttribute('aria-checked', String(on));
      if (on) text = item.textContent ?? '';
    }
    buttonText.textContent = text;
    button.title = text ? `${labels.title}: ${text}` : labels.title;
    button.setAttribute('aria-label', button.title);
  };

  /** While audio only plays, hls.levels is its one audio level: the menu lists the video qualities known from before. */
  const renderAudioOnly = (heights: readonly number[]): void => {
    add(heights.length === 1 ? `${heights[0]}p` : labels.auto, '-1');
    if (heights.length > 1) for (const h of heights) add(`${h}p`, `h${h}`);
    add(labels.audioOnly, AUDIO_ONLY_OPTION);
    check(AUDIO_ONLY_OPTION);
    root.hidden = false;
  };

  const render = (): void => {
    const levels = hls.levels;
    const focusedValue = open ? (doc.activeElement as HTMLElement | null)?.dataset?.value : undefined;
    menu.replaceChildren();
    if (audio?.active) renderAudioOnly(audio.heights);
    else {
      const playing = levels[hls.currentLevel];
      if (levels.length === 1) {
        // One quality: nothing to choose but audio only, so no "Auto" next to it.
        add(levelLabel(levels[0]!), '-1');
      } else {
        add(playing && hls.autoLevelEnabled ? labels.autoWith(levelLabel(playing)) : labels.auto, '-1');
        levels
          .map((l, i) => ({ l, i }))
          .sort((a, b) => (b.l.height ?? 0) - (a.l.height ?? 0) || (b.l.bitrate ?? 0) - (a.l.bitrate ?? 0))
          .forEach(({ l, i }) => add(levelLabel(l), String(i)));
      }
      const offerAudio = !!audio?.available && levels.length > 0;
      if (offerAudio) add(labels.audioOnly, AUDIO_ONLY_OPTION);
      check(hls.autoLevelEnabled || levels.length === 1 ? '-1' : String(hls.loadLevel));
      root.hidden = levels.length < 2 && !offerAudio;
    }
    if (root.hidden) close(false);
    // A rebuild while the menu is open (a level switch) keeps the focus on the same entry.
    else if (focusedValue !== undefined) (items().find((i) => i.dataset.value === focusedValue) ?? items()[0])?.focus();
  };

  const pick = (value: string): void => {
    if (value === AUDIO_ONLY_OPTION) {
      audio?.set(true);
      return render();
    }
    if (audio?.active) {
      // Back to video: at the height picked (the menu applies it once the playlists are parsed), or Auto.
      savePreferredHeight(value.startsWith('h') ? Number(value.slice(1)) : null);
      audio.set(false);
      return render();
    }
    const idx = Number(value);
    if (idx < 0) {
      hls.loadLevel = -1;
      savePreferredHeight(null);
    } else {
      // nextLevel: switch at the next segment boundary; keeps what is already buffered.
      hls.nextLevel = idx;
      savePreferredHeight(hls.levels[idx]?.height ?? null);
    }
    render();
  };

  // ---- open / close and the keyboard (APG menu button) ----
  let open = false;
  const setOpen = (next: boolean): void => {
    if (next === open) return;
    open = next;
    pop.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    options.onOpenChange?.(next);
  };
  const focusItem = (which: 'checked' | 'first' | 'last'): void => {
    const list = items();
    const target = which === 'first' ? list[0] : which === 'last' ? list[list.length - 1] : (list.find((i) => i.dataset.value === current) ?? list[0]);
    target?.focus();
  };
  const openMenu = (which: 'checked' | 'first' | 'last'): void => {
    setOpen(true);
    focusItem(which);
  };
  function close(focusButton = true): void {
    if (!open) return;
    setOpen(false);
    if (focusButton) button.focus();
  }

  button.addEventListener('click', () => (open ? close() : openMenu('checked')));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(e.key === 'ArrowDown' ? 'first' : 'last');
    }
  });
  menu.addEventListener('click', (e) => {
    const item = (e.target as Element | null)?.closest<HTMLElement>('[role="menuitemradio"]');
    if (!item?.dataset.value) return;
    const value = item.dataset.value;
    close();
    if (value !== current) pick(value);
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(doc.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = list[(at + 1) % list.length];
        break;
      case 'ArrowUp':
        next = list[(at - 1 + list.length) % list.length];
        break;
      case 'Home':
        next = list[0];
        break;
      case 'End':
        next = list[list.length - 1];
        break;
      case 'Escape':
        e.preventDefault();
        // Esc closes the menu only, not full screen or a dialog around it.
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    next?.focus();
  });
  // A click anywhere else, or the focus leaving the menu and its button, closes it.
  const outside = (e: Event): void => {
    if (open && !root.contains(e.target as Node)) close(false);
  };
  doc.addEventListener('pointerdown', outside, true);
  root.addEventListener('focusout', (e) => {
    if (open && !root.contains(e.relatedTarget as Node | null) && e.relatedTarget !== null) close(false);
  });

  const onParsed = (): void => {
    if (audio?.active) return render();
    const wanted = loadPreferredHeight();
    if (wanted !== null && hls.levels.length > 1) {
      const idx = levelForHeight(hls.levels, wanted);
      if (idx >= 0) hls.loadLevel = idx;
    }
    render();
  };
  const onSwitched = (): void => render();

  hls.on(events.MANIFEST_PARSED as never, onParsed as never);
  hls.on(events.LEVEL_SWITCHED as never, onSwitched as never);
  const unsubscribe = audio?.subscribe(render);
  if (hls.levels.length) onParsed();
  else render();
  return {
    element: root,
    button,
    menu,
    get open() {
      return open;
    },
    refresh: render,
    close,
    destroy: () => {
      hls.off(events.MANIFEST_PARSED as never, onParsed as never);
      hls.off(events.LEVEL_SWITCHED as never, onSwitched as never);
      doc.removeEventListener('pointerdown', outside, true);
      unsubscribe?.();
      root.remove();
    },
  };
}
