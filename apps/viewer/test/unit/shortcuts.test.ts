// @vitest-environment happy-dom
// The watch page's keyboard shortcuts (shortcuts.ts): the key map (by the character typed, Caps
// Lock or not), never while typing (fields, text areas, editable text, the chat column, a dialog)
// or composing with an IME, never with Ctrl / Cmd / Alt or a held key, Space left to buttons and
// to the video's own controls, and the off switch (WCAG 2.1.4), remembered in this browser.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actionForKey, installShortcuts, loadShortcutsOn, SHORTCUTS_PREF_KEY, shortcutFor, typingTarget, type KeyEventLike, type PrefStorage, type ShortcutAction } from '../../src/shortcuts.js';

/** A keydown as the browser sends it (KeyboardEvent fields), on `target`. */
function key(k: string, target: EventTarget | null = document.body, over: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false, target, preventDefault: () => {}, ...over };
}

/** localStorage, or one that throws (storage blocked). */
class MemoryStorage implements PrefStorage {
  readonly map = new Map<string, string>();
  constructor(private readonly blocked = false) {}
  getItem(k: string): string | null {
    if (this.blocked) throw new Error('SecurityError');
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.blocked) throw new Error('SecurityError');
    this.map.set(k, v);
  }
}

/** Builds a piece of the watch page and returns its element with `id`. */
function el<T extends HTMLElement>(html: string, id: string): T {
  document.body.insertAdjacentHTML('beforeend', html);
  return document.getElementById(id) as T;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the key map', () => {
  it.each<[string, ShortcutAction]>([
    [' ', 'play-pause'],
    ['k', 'play-pause'],
    ['m', 'mute'],
    ['f', 'fullscreen'],
    ['t', 'theater'],
    ['g', 'go-live'],
    ['i', 'pip'],
    ['c', 'chat'],
    ['s', 'stats'],
    ['?', 'help'],
  ])('"%s" → %s', (k, action) => {
    // Act / Assert
    expect(actionForKey(k)).toBe(action);
    expect(shortcutFor(key(k))).toBe(action);
  });

  it('a capital letter (Caps Lock, Shift) does the same as the small one', () => {
    // Act / Assert
    expect(actionForKey('K')).toBe('play-pause');
    expect(actionForKey('M')).toBe('mute');
    expect(actionForKey('F')).toBe('fullscreen');
  });

  it('other keys are not shortcuts: no seeking in a live (j, l, arrows), Enter, Escape, digits', () => {
    // Act / Assert
    for (const k of ['j', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter', 'Escape', 'Tab', '0', '5', 'Home', 'End', 'Dead']) expect(shortcutFor(key(k))).toBeNull();
  });
});

describe('never while typing', () => {
  it.each([
    ['a text field', '<input id="x" type="text">'],
    ['a search field', '<input id="x" type="search">'],
    ['a checkbox (Space ticks it)', '<input id="x" type="checkbox">'],
    ['a text area', '<textarea id="x"></textarea>'],
    ['a list', '<select id="x"><option>Auto</option></select>'],
    ['editable text', '<div id="x" contenteditable="true">hi</div>'],
    ['an ARIA text box', '<div id="x" role="textbox" tabindex="0"></div>'],
    ['a menu item', '<div role="menu"><button id="x" role="menuitem">Delete</button></div>'],
    ['a button in the chat column', '<aside id="chat"><button id="x" type="button">😀</button></aside>'],
    ['a button in a dialog', '<dialog open><button id="x" type="button">Close</button></dialog>'],
  ])('%s', (_what, html) => {
    // Arrange
    const target = el(html, 'x');
    // Act / Assert: every key, letters and Space alike
    for (const k of ['k', 'm', 'f', 't', 'c', 's', '?', ' ']) expect(shortcutFor(key(k, target))).toBeNull();
    expect(typingTarget(target)).toBe(true);
  });

  it('text inside editable text counts too (the event target is a child)', () => {
    // Arrange
    const box = el<HTMLDivElement>('<div id="x" contenteditable=""><b id="y">bold</b></div>', 'x');
    // Act / Assert
    expect(shortcutFor(key('m', box.querySelector('#y')))).toBeNull();
  });

  it('an IME composition (isComposing, or keyCode 229 in the browsers that do not set it) is left alone', () => {
    // Act / Assert: e.g. the dead key ´ then "a" on a Brazilian keyboard, or Japanese input
    expect(shortcutFor(key('k', document.body, { isComposing: true }))).toBeNull();
    expect(shortcutFor(key('m', document.body, { keyCode: 229 }))).toBeNull();
    expect(shortcutFor(key('Process', document.body, { keyCode: 229 }))).toBeNull();
  });

  it('keys with Ctrl, Cmd or Alt belong to the browser and the system (Ctrl+F finds, Cmd+K…)', () => {
    // Act / Assert
    expect(shortcutFor(key('f', document.body, { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('k', document.body, { metaKey: true }))).toBeNull();
    expect(shortcutFor(key('m', document.body, { altKey: true }))).toBeNull();
  });

  it('a held key does not toggle again and again; an event handled already is not taken', () => {
    // Act / Assert
    expect(shortcutFor(key('t', document.body, { repeat: true }))).toBeNull();
    expect(shortcutFor(key('t', document.body, { defaultPrevented: true }))).toBeNull();
  });
});

describe('Space', () => {
  it('plays / pauses when the page itself has the focus', () => {
    // Act / Assert
    expect(shortcutFor(key(' ', document.body))).toBe('play-pause');
    expect(shortcutFor(key(' ', document.documentElement))).toBe('play-pause');
  });

  it('presses a focused button or link as always, while K still plays / pauses there', () => {
    // Arrange
    const button = el<HTMLButtonElement>('<button id="x" type="button">Share</button>', 'x');
    const link = el<HTMLAnchorElement>('<a id="y" href="#">site</a>', 'y');
    // Act / Assert
    expect(shortcutFor(key(' ', button))).toBeNull();
    expect(shortcutFor(key(' ', link))).toBeNull();
    expect(shortcutFor(key('k', button))).toBe('play-pause');
    expect(shortcutFor(key('m', link))).toBe('mute');
  });

  it("is left to the video's own controls when the video has the focus", () => {
    // Arrange
    const video = el<HTMLVideoElement>('<div class="player"><video id="x" controls></video></div>', 'x');
    // Act / Assert
    expect(shortcutFor(key(' ', video))).toBeNull();
    expect(shortcutFor(key('k', video))).toBe('play-pause');
    expect(shortcutFor(key('f', video))).toBe('fullscreen');
  });
});

describe('installShortcuts', () => {
  /** The page's listener on a fresh root of its own (the page puts it on the document). */
  function install(storage: PrefStorage | undefined = new MemoryStorage(), result = true) {
    const root = el<HTMLDivElement>('<div id="page"></div>', 'page');
    const run = vi.fn((_a: ShortcutAction) => result);
    const shortcuts = installShortcuts({ target: root, storage, run });
    const press = (k: string, target: Element = root, init: KeyboardEventInit = {}): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    };
    return { run, shortcuts, press, storage, root };
  }

  it('runs the action and takes the key (no page scroll for Space, no "c" typed into the box it focuses)', () => {
    // Arrange
    const { run, press } = install();
    // Act
    const space = press(' ');
    const m = press('m');
    // Assert
    expect(run.mock.calls.map((c) => c[0])).toEqual(['play-pause', 'mute']);
    expect(space.defaultPrevented).toBe(true);
    expect(m.defaultPrevented).toBe(true);
  });

  it('a key whose action did nothing (no chat, no picture-in-picture) keeps its default', () => {
    // Arrange
    const { run, press } = install(new MemoryStorage(), false);
    // Act
    const e = press('c');
    // Assert
    expect(run).toHaveBeenCalledWith('chat');
    expect(e.defaultPrevented).toBe(false);
  });

  it('typing "kmft" in the chat box runs nothing and types the letters', () => {
    // Arrange
    const { run, press, root } = install();
    root.innerHTML = '<aside id="chat"><textarea id="x"></textarea></aside>';
    const box = document.getElementById('x')!;
    // Act
    const events = [...'kmft '].map((k) => press(k, box));
    // Assert
    expect(run).not.toHaveBeenCalled();
    expect(events.every((e) => !e.defaultPrevented)).toBe(true);
  });

  it('a composition in a field outside the chat runs nothing either', () => {
    // Arrange
    const { run, press, root } = install();
    root.innerHTML = '<input id="x" type="text">';
    const field = document.getElementById('x')!;
    // Act
    press('k', root, { isComposing: true });
    press('m', field);
    // Assert
    expect(run).not.toHaveBeenCalled();
  });

  it('on by default; turned off, no key runs anything, and the choice is remembered', () => {
    // Arrange
    const storage = new MemoryStorage();
    const first = install(storage);
    expect(first.shortcuts.enabled).toBe(true);
    // Act
    first.shortcuts.enabled = false;
    const e = first.press('k');
    first.press('?');
    // Assert
    expect(first.run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(storage.map.get(SHORTCUTS_PREF_KEY)).toBe('off');

    // Act: the next visit (a reload) reads the choice
    document.body.innerHTML = '';
    const again = installShortcuts({ target: document.createElement('div'), storage, run: () => true });
    // Assert
    expect(again.enabled).toBe(false);
    expect(loadShortcutsOn(storage)).toBe(false);
  });

  it('turned back on, they work again and "on" is remembered', () => {
    // Arrange
    const storage = new MemoryStorage();
    storage.setItem(SHORTCUTS_PREF_KEY, 'off');
    const { run, shortcuts, press } = install(storage);
    // Act
    shortcuts.enabled = true;
    press('t');
    // Assert
    expect(run).toHaveBeenCalledWith('theater');
    expect(storage.map.get(SHORTCUTS_PREF_KEY)).toBe('on');
  });

  it('with storage blocked (private mode, settings) they are on and the switch still works for this page', () => {
    // Arrange
    const { run, shortcuts, press } = install(new MemoryStorage(true));
    // Act
    expect(shortcuts.enabled).toBe(true);
    shortcuts.enabled = false;
    press('k');
    // Assert
    expect(shortcuts.enabled).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(loadShortcutsOn(undefined)).toBe(true);
  });
});
