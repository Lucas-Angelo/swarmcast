// @vitest-environment happy-dom
// The watch page's theater mode, shortcuts and stats link wired together (player-extras.ts): what
// each shortcut does to the player (play / pause, sound and the "Unmute" button, go live, the chat
// box, full screen through whichever API the browser has, picture-in-picture only where it
// exists), the list of shortcuts with its on / off switch, and T and S driving the theater mode
// and the stats panel like their buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPlayerExtras, pipSupported, toggleFullscreen, togglePip } from '../../src/player-extras.js';
import type { PrefStorage } from '../../src/shortcuts.js';
import type { StatsSource } from '../../src/stats-overlay.js';

class MemoryStorage implements PrefStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

/** The parts of watch.html the extras use. */
const MARKUP = `
  <div class="player"><video id="video" controls muted></video><div id="stats" hidden></div></div>
  <button id="golive" type="button" hidden>LIVE</button>
  <button id="unmute" type="button" hidden>Unmute</button>
  <button id="theater" type="button" hidden aria-pressed="false">Theater mode</button>
  <aside id="chat"><textarea id="box"></textarea></aside>
  <button id="keys-open" type="button">Keyboard shortcuts</button>
  <button id="stats-open" type="button">Stats for nerds</button>
  <dialog id="keys-help"><button id="keys-close" type="button">×</button><input id="keys-on" type="checkbox" checked>
    <dl><div data-key="pip"><dt>I</dt><dd>Picture-in-picture</dd></div></dl></dialog>`;

const statsSource = (video: HTMLVideoElement): StatsSource => ({
  video,
  hls: () => null,
  counters: () => ({ httpBytes: 0, p2pDownBytes: 0, p2pUpBytes: 0, peers: 0, p2pEnabled: false }),
  delay: () => null,
  profile: () => 'stable',
  engine: () => 'native',
  connection: () => undefined,
});

function setup(storage = new MemoryStorage()) {
  document.body.className = 'watch';
  document.body.innerHTML = MARKUP;
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const video = $<HTMLVideoElement>('video');
  // happy-dom plays nothing: play() and pause() only flip `paused`, as a browser does at once.
  let paused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  const play = vi.fn(async () => {
    paused = false;
  });
  const pause = vi.fn(() => {
    paused = true;
  });
  video.play = play;
  video.pause = pause;
  video.muted = true;
  const extras = installPlayerExtras({ doc: document, video, goLive: $('golive'), unmute: $('unmute'), chatRoot: $('chat'), storage, stats: statsSource(video) });
  const press = (key: string, target: Element = document.body): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  return { $, video, play, pause, extras, press, storage };
}

// Each test installs the page's listeners on the one document: they go again after it, as on a
// page that is closed.
let listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
beforeEach(() => {
  document.body.innerHTML = '';
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (!listener) return;
    listeners.push([type, listener]);
    add(type, listener, options);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [type, listener] of listeners) document.removeEventListener(type, listener);
  listeners = [];
});

describe('what the shortcuts do', () => {
  it('K and Space play, then pause', async () => {
    // Arrange
    const { video, play, pause, press } = setup();
    // Act
    press('k');
    // Assert
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
    // Act
    press(' ');
    // Assert
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(true);
  });

  it('M turns the sound on (the "Unmute" button goes) and off again (it comes back)', () => {
    // Arrange
    const { video, $, press } = setup();
    $('unmute').hidden = false;
    // Act
    press('m');
    // Assert
    expect(video.muted).toBe(false);
    expect($('unmute').hidden).toBe(true);
    // Act
    press('M');
    // Assert
    expect(video.muted).toBe(true);
    expect($('unmute').hidden).toBe(false);
  });

  it('G clicks "Go live" when it shows, and leaves the key alone when it does not', () => {
    // Arrange
    const { $, press } = setup();
    const clicks = vi.fn();
    $('golive').addEventListener('click', clicks);
    // Act
    const hidden = press('g');
    $('golive').hidden = false;
    const shown = press('g');
    // Assert
    expect(hidden.defaultPrevented).toBe(false);
    expect(shown.defaultPrevented).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('C puts the focus in the chat box; typing there then runs no shortcut', () => {
    // Arrange
    const { $, video, press } = setup();
    // happy-dom lays nothing out: the box counts as shown when it has an offsetParent.
    Object.defineProperty($('box'), 'offsetParent', { configurable: true, get: () => document.body });
    // Act
    const e = press('c');
    // Assert
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('box'));
    // Act
    press('m', $('box'));
    // Assert
    expect(video.muted).toBe(true);
  });

  it('C does nothing while the chat is hidden', () => {
    // Arrange
    const { $, press } = setup();
    $('chat').hidden = true;
    // Act
    const e = press('c');
    // Assert
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe($('box'));
  });

  it('T toggles the theater mode like its button, and it is remembered', () => {
    // Arrange
    const storage = new MemoryStorage();
    const { $, extras, press } = setup(storage);
    // Act
    press('t');
    // Assert
    expect(extras.theater.on).toBe(true);
    expect(document.body.classList.contains('theater')).toBe(true);
    expect($('theater').getAttribute('aria-pressed')).toBe('true');
    // Act: a reload
    for (const [type, listener] of listeners) document.removeEventListener(type, listener);
    const again = setup(storage);
    // Assert
    expect(again.extras.theater.on).toBe(true);
  });

  it('S opens the stats panel and closes it', async () => {
    // Arrange
    const { $, extras, press } = setup();
    // Act
    press('s');
    // Assert
    expect(extras.stats.open).toBe(true);
    await vi.waitFor(() => expect($('stats').hidden).toBe(false));
    expect($('stats').querySelectorAll('dl > div').length).toBeGreaterThan(5);
    // Act
    press('s');
    // Assert
    expect(extras.stats.open).toBe(false);
    expect($('stats').hidden).toBe(true);
  });
});

describe('the list of shortcuts', () => {
  it('? and the link open it; its switch turns every shortcut off, remembered', () => {
    // Arrange
    const storage = new MemoryStorage();
    const { $, video, press } = setup(storage);
    const dialog = $<HTMLDialogElement>('keys-help');
    // Act
    press('?');
    // Assert
    expect(dialog.open).toBe(true);
    // Act: the switch, then close it
    const sw = $<HTMLInputElement>('keys-on');
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    $('keys-close').click();
    press('m');
    press('?');
    // Assert
    expect(dialog.open).toBe(false);
    expect(video.muted).toBe(true);
    expect(storage.map.get('swarmcast.shortcuts')).toBe('off');
    // Act: the link still opens it (the way back), showing the switch off
    $('keys-open').click();
    // Assert
    expect(dialog.open).toBe(true);
    expect(sw.checked).toBe(false);
  });

  it('the picture-in-picture line shows only where the browser has it', () => {
    // Arrange / Act: happy-dom has no picture-in-picture
    const { $ } = setup();
    // Assert
    expect($('keys-help').querySelector('[data-key="pip"]')?.hasAttribute('hidden')).toBe(true);
  });
});

describe('full screen and picture-in-picture', () => {
  const doc = (o: Record<string, unknown> = {}): Document => ({ fullscreenElement: null, pictureInPictureEnabled: false, pictureInPictureElement: null, ...o }) as unknown as Document;

  it('full screen: the standard API, else the WebKit ones (iPhone: the native player)', () => {
    // Arrange
    const standard = { requestFullscreen: vi.fn(async () => {}) } as unknown as HTMLVideoElement;
    const iphone = { webkitEnterFullscreen: vi.fn() } as unknown as HTMLVideoElement;
    const oldSafari = { webkitRequestFullscreen: vi.fn() } as unknown as HTMLVideoElement;
    // Act / Assert
    expect(toggleFullscreen(standard, doc())).toBe(true);
    expect((standard as unknown as { requestFullscreen: ReturnType<typeof vi.fn> }).requestFullscreen).toHaveBeenCalled();
    expect(toggleFullscreen(iphone, doc())).toBe(true);
    expect((iphone as unknown as { webkitEnterFullscreen: ReturnType<typeof vi.fn> }).webkitEnterFullscreen).toHaveBeenCalled();
    expect(toggleFullscreen(oldSafari, doc())).toBe(true);
    expect((oldSafari as unknown as { webkitRequestFullscreen: ReturnType<typeof vi.fn> }).webkitRequestFullscreen).toHaveBeenCalled();
    expect(toggleFullscreen({} as HTMLVideoElement, doc())).toBe(false);
  });

  it('full screen already: F leaves it; a refused request is swallowed', async () => {
    // Arrange
    const exitFullscreen = vi.fn(async () => {});
    const refused = { requestFullscreen: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) } as unknown as HTMLVideoElement;
    // Act / Assert
    expect(toggleFullscreen({} as HTMLVideoElement, doc({ fullscreenElement: {}, exitFullscreen }))).toBe(true);
    expect(exitFullscreen).toHaveBeenCalled();
    const webkitExitFullscreen = vi.fn();
    expect(toggleFullscreen({} as HTMLVideoElement, doc({ fullscreenElement: undefined, webkitFullscreenElement: {}, webkitExitFullscreen }))).toBe(true);
    expect(webkitExitFullscreen).toHaveBeenCalled();
    expect(toggleFullscreen(refused, doc())).toBe(true);
    await Promise.resolve();
  });

  it('picture-in-picture: the standard API or Safari presentation mode; nothing elsewhere', () => {
    // Arrange
    const requestPictureInPicture = vi.fn(async () => {});
    const exitPictureInPicture = vi.fn(async () => {});
    const chrome = { requestPictureInPicture } as unknown as HTMLVideoElement;
    const safari = { webkitSupportsPresentationMode: () => true, webkitSetPresentationMode: vi.fn(), webkitPresentationMode: 'inline' } as unknown as HTMLVideoElement & { webkitSetPresentationMode: ReturnType<typeof vi.fn> };
    // Act / Assert
    expect(pipSupported(chrome, doc({ pictureInPictureEnabled: true }))).toBe(true);
    expect(pipSupported(chrome, doc())).toBe(false);
    expect(pipSupported(safari, doc())).toBe(true);
    expect(pipSupported({} as HTMLVideoElement, doc())).toBe(false);
    expect(togglePip(chrome, doc({ pictureInPictureEnabled: true }))).toBe(true);
    expect(requestPictureInPicture).toHaveBeenCalled();
    expect(togglePip(chrome, doc({ pictureInPictureEnabled: true, pictureInPictureElement: {}, exitPictureInPicture }))).toBe(true);
    expect(exitPictureInPicture).toHaveBeenCalled();
    expect(togglePip(safari, doc())).toBe(true);
    expect(safari.webkitSetPresentationMode).toHaveBeenCalledWith('picture-in-picture');
    expect(togglePip({} as HTMLVideoElement, doc())).toBe(false);
  });
});
