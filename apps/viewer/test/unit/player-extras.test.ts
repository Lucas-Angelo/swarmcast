// @vitest-environment happy-dom
// The watch page's theater mode, shortcuts and stats link wired together (player-extras.ts): what
// each shortcut does to the player (play / pause, sound and the "Unmute" button, go live, the chat
// box, full screen of the player container, picture-in-picture only where it exists; the
// capability checks themselves are in player-caps.test.ts), the list of shortcuts with its on / off switch, and T and S driving the theater mode
// and the stats panel like their buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPlayerExtras } from '../../src/player-extras.js';
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
  const onAction = vi.fn();
  const extras = installPlayerExtras({ doc: document, video, player: document.querySelector<HTMLElement>('.player')!, goLive: $('golive'), unmute: $('unmute'), chatRoot: $('chat'), storage, stats: statsSource(video), onAction });
  const press = (key: string, target: Element = document.body): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  return { $, video, play, pause, extras, press, storage, onAction };
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

  it('F puts the player container (video and its controls) in full screen, not the video alone; the controls are told', () => {
    // Arrange
    const { video, press, onAction } = setup();
    const player = document.querySelector<HTMLElement>('.player')!;
    const containerRequest = vi.fn(async () => {});
    const videoRequest = vi.fn(async () => {});
    player.requestFullscreen = containerRequest;
    video.requestFullscreen = videoRequest;
    // Act
    const e = press('f');
    // Assert
    expect(e.defaultPrevented).toBe(true);
    expect(containerRequest).toHaveBeenCalledTimes(1);
    expect(videoRequest).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith('fullscreen');
  });

  it('a shortcut that does nothing (I without picture-in-picture) is not reported to the controls', () => {
    // Arrange
    const { press, onAction } = setup();
    // Act
    const e = press('i');
    // Assert
    expect(e.defaultPrevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
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
