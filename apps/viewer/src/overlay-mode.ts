/**
 * The chat over the video (docs/CHAT.md, "Chat over the video"): the viewer's on / off choice
 * (off by default, remembered in this browser), whether the player fills the screen now, and the
 * two switches for it, a button in the player's bar while it fills the screen and a toggle in the
 * Settings menu. The chat chunk draws the overlay itself (chat/overlay.ts) and tells this module
 * whether there is a chat to show (`setAvailable`); the player and its bar never depend on it.
 *
 * "Fills the screen": the player container is full screen (player-caps.ts), or, on an iPhone whose
 * Safari has no element full screen, the page's own "fill the screen" mode (player-controls.ts
 * `pc-fill`), which the full-screen button uses instead of iOS's own player while this is on
 * (that player shows nothing of the page over the video).
 */
import type { PrefStorage } from './shortcuts.js';

export const OVERLAY_PREF_KEY = 'swarmcast.chatOverlay';

export function loadOverlayPref(storage: PrefStorage | undefined): boolean {
  try {
    return storage?.getItem(OVERLAY_PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveOverlayPref(storage: PrefStorage | undefined, on: boolean): void {
  try {
    storage?.setItem(OVERLAY_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

export interface OverlayLabels {
  /** The bar button's name ("Chat on the video") and its tooltip. */
  button: string;
  tip: string;
}

export interface OverlayModeDeps {
  /** The player container (`.player`). */
  player: HTMLElement;
  doc: Document;
  storage: PrefStorage | undefined;
  /** The Settings menu's toggle (absent: none). */
  setting?: { row: HTMLElement; box: HTMLInputElement } | null;
  labels: OverlayLabels;
}

/** What the chat chunk sees of the overlay mode (chat/overlay.ts). */
export interface OverlayHost {
  /** The overlay should be drawn now: the viewer wants it, the player fills the screen and there is a chat. */
  readonly active: boolean;
  /** There is a chat to show (on, and not hidden by the viewer). */
  setAvailable(available: boolean): void;
  /** Called when `active` may have changed. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** The chat chunk's way to open its message box over the video (the C key while it is active). */
  setInputOpener(fn: (() => boolean) | null): void;
}

export interface OverlayMode extends OverlayHost {
  /** The viewer's choice. */
  readonly on: boolean;
  /** The player fills the screen now (full screen, or the page's own fill mode). */
  readonly fills: boolean;
  /** The bar button: watch.ts puts it in the player's bar (PlayerControls.addButton). */
  readonly button: HTMLButtonElement;
  set(on: boolean): void;
  toggle(): void;
  /** The C key: opens the message box over the video when the overlay shows; false otherwise. */
  openInput(): boolean;
  /** The full-screen state may have changed (fill mode, a full-screen event). */
  sync(): void;
}

interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
}

export function createOverlayMode(d: OverlayModeDeps): OverlayMode {
  const { player, doc } = d;
  let on = loadOverlayPref(d.storage);
  let available = false;
  let fills = false;
  let opener: (() => boolean) | null = null;
  const listeners = new Set<() => void>();

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'pc-btn pc-ico-chat';
  button.dataset.testid = 'chat-overlay-button';
  const label = doc.createElement('span');
  label.className = 'pc-sr';
  label.textContent = d.labels.button;
  button.append(label);
  button.title = d.labels.tip;

  const isActive = (): boolean => on && fills && available;
  const render = (): void => {
    button.hidden = !(available && fills);
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('active', on);
    if (d.setting) {
      d.setting.row.hidden = !available;
      d.setting.box.checked = on;
    }
  };
  let last = isActive();
  const changed = (): void => {
    render();
    const now = isActive();
    if (now === last) return;
    last = now;
    for (const fn of [...listeners]) fn();
  };
  const sync = (): void => {
    const fsEl = doc.fullscreenElement ?? (doc as WebkitDocument).webkitFullscreenElement ?? null;
    fills = fsEl === player || player.classList.contains('pc-fill');
    changed();
  };
  const set = (next: boolean): void => {
    on = next;
    saveOverlayPref(d.storage, next);
    changed();
  };

  button.addEventListener('click', () => set(!on));
  d.setting?.box.addEventListener('change', () => set(d.setting!.box.checked));
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) doc.addEventListener(ev, sync);
  player.addEventListener('sc-fillchange', sync);
  sync();
  render();

  return {
    get on() {
      return on;
    },
    get fills() {
      return fills;
    },
    get active() {
      return isActive();
    },
    button,
    set,
    toggle: () => set(!on),
    setAvailable(next) {
      available = next;
      changed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setInputOpener(fn) {
      opener = fn;
    },
    openInput: () => (isActive() && opener ? opener() : false),
    sync,
  };
}
