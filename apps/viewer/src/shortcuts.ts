/**
 * Keyboard shortcuts of the watch page, like the big video sites: Space or K play / pause, M sound
 * on / off, F full screen, T theater mode, G go live, I picture-in-picture, C the chat box, S stats
 * for nerds, ? the list of shortcuts.
 *
 * - Never while the viewer types: a key in a text field, a text area, a list, a menu, anything
 *   editable, the chat column or an open dialog is left alone, and so is every key of an IME
 *   composition (Japanese, Chinese, the dead keys of a Brazilian keyboard such as ´ + a).
 * - Keys with Ctrl, Cmd or Alt are the browser's and the system's. A held key does not repeat a
 *   toggle.
 * - Space keeps its own job on a button, a link or a switch (pressing it) and on the video itself
 *   (its own controls play / pause it): it plays / pauses only when nothing in particular has the
 *   focus (the page itself).
 * - The letters follow the viewer's keyboard layout (e.key, not the key's position).
 * - They can be turned off (WCAG 2.1.4, character key shortcuts: a speech-input user's words must
 *   not trigger them), in the list of shortcuts; the choice is remembered in this browser.
 */

export type ShortcutAction = 'play-pause' | 'mute' | 'fullscreen' | 'theater' | 'go-live' | 'pip' | 'chat' | 'stats' | 'help';

/** What the handler reads of a keydown event (KeyboardEvent has all of it). */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  /** 229 while an IME composes, in browsers that do not set isComposing on that keydown. */
  keyCode?: number;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

const KEYS: Record<string, ShortcutAction> = {
  ' ': 'play-pause',
  k: 'play-pause',
  m: 'mute',
  f: 'fullscreen',
  t: 'theater',
  g: 'go-live',
  i: 'pip',
  c: 'chat',
  s: 'stats',
  '?': 'help',
};

/** The action of a key, by the character it types (Caps Lock and Shift do not change a letter's action). */
export function actionForKey(key: string): ShortcutAction | null {
  return KEYS[key.length === 1 ? key.toLowerCase() : key] ?? null;
}

/**
 * Where the viewer is typing or working a control that takes keys of its own: text fields, text
 * areas, lists, editable text, menus and sliders, the whole chat column (its box, its pickers, its
 * menus) and any dialog.
 */
const OWN_KEYS = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  'dialog',
  '#chat',
].join(', ');

/** Controls that Space presses by itself. */
const PRESSABLE = 'button, a[href], summary, [role="button"], [role="link"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [tabindex]';

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

/** The key belongs to whatever has the focus (typing, a control with keys of its own). */
export function typingTarget(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  return el.closest(OWN_KEYS) !== null;
}

/**
 * The shortcut a keydown means, or null when the key is not one or is not ours to take: typing,
 * an IME composition, a modifier, a held key, an event handled already, or Space on a control
 * that Space presses or on the video (its own controls take it).
 */
export function shortcutFor(e: KeyEventLike): ShortcutAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.isComposing || e.keyCode === 229) return null;
  const action = actionForKey(e.key);
  if (!action || e.repeat) return null;
  if (typingTarget(e.target)) return null;
  if (e.key === ' ') {
    const el = asElement(e.target);
    if (el?.closest(PRESSABLE) || el?.tagName === 'VIDEO') return null;
  }
  return action;
}

/** The viewer's on / off choice, kept in localStorage (on unless they turned it off). */
export const SHORTCUTS_PREF_KEY = 'swarmcast.shortcuts';

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadShortcutsOn(storage: PrefStorage | undefined): boolean {
  try {
    return storage?.getItem(SHORTCUTS_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveShortcutsOn(storage: PrefStorage | undefined, on: boolean): void {
  try {
    storage?.setItem(SHORTCUTS_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

export interface ShortcutsDeps {
  /** Where keydown is listened for (the document). */
  target: { addEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void };
  storage: PrefStorage | undefined;
  /** Runs an action; returns false when it did nothing (no chat, no picture-in-picture…): the key then keeps its default. */
  run(action: ShortcutAction): boolean;
}

export interface Shortcuts {
  /** On (the default) or turned off by the viewer. */
  enabled: boolean;
}

/** Listens for the shortcuts; `enabled` turns them all off and on, and is remembered. */
export function installShortcuts(d: ShortcutsDeps): Shortcuts {
  let enabled = loadShortcutsOn(d.storage);
  d.target.addEventListener('keydown', (e) => {
    if (!enabled) return;
    const action = shortcutFor(e);
    if (!action) return;
    // Taken: no page scroll for Space, and no "c" typed into the chat box it focuses.
    if (d.run(action)) e.preventDefault();
  });
  return {
    get enabled() {
      return enabled;
    },
    set enabled(on: boolean) {
      enabled = on;
      saveShortcutsOn(d.storage, on);
    },
  };
}
