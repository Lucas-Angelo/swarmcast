// @vitest-environment happy-dom
// The player's own controls (player-controls.ts) on a fake player: built over the video, the
// native controls removed only once built, LIVE and theater mode moved into the bar; play / pause,
// the big Play button, sound and volume (no slider where the volume cannot be set: iOS),
// picture-in-picture only where it exists, full screen of the container (iPhone: iOS's player),
// state read again after iOS's full screen; fading on a controlled clock, held by keyboard focus
// and reduced motion, not by a mouse click's focus; a touch on a faded control only shows them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROLS_HIDE_AFTER_MS } from '../../src/controls-visibility.js';
import { mountPlayerControls, type PlayerControlsDeps } from '../../src/player-controls.js';

const MARKUP = `
  <div class="player"><video id="video" controls muted playsinline autoplay></video><div id="overlay"></div></div>
  <button id="golive" type="button" hidden>LIVE</button>
  <button id="theater" type="button" class="secondary" hidden aria-pressed="false" data-i18n="watch.theater" title="A bigger video">Theater mode</button>
  <button id="elsewhere" type="button">Elsewhere</button>`;

/** A page clock for the fade-out timer, moved by hand. */
function fakeWindow(reducedMotion = false) {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners: Array<() => void> = [];
  const mq = {
    matches: reducedMotion,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  return {
    win: {
      setTimeout: ((fn: () => void, ms: number) => {
        timers.set(++seq, { at: t + ms, fn });
        return seq;
      }) as unknown as Window['setTimeout'],
      clearTimeout: ((id: number) => void timers.delete(id)) as unknown as Window['clearTimeout'],
      matchMedia: (() => mq) as unknown as Window['matchMedia'],
    },
    now: () => t,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    setReducedMotion(on: boolean) {
      mq.matches = on;
      for (const fn of listeners) fn();
    },
  };
}

interface Setup {
  volumeFixed?: boolean;
  reducedMotion?: boolean;
  iphone?: boolean;
  pip?: boolean;
  playRefused?: boolean;
  started?: boolean;
}

function setup(o: Setup = {}) {
  document.body.innerHTML = MARKUP;
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const video = $<HTMLVideoElement>('video');
  const player = document.querySelector<HTMLElement>('.player')!;
  // happy-dom plays nothing: play() and pause() flip `paused` and fire the events a browser fires.
  let paused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  video.play = vi.fn(async () => {
    if (o.playRefused) throw new DOMException('autoplay', 'NotAllowedError');
    paused = false;
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('playing'));
  });
  video.pause = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event('pause'));
  });
  if (o.volumeFixed) Object.defineProperty(video, 'volume', { configurable: true, get: () => 1, set: () => {} });
  const requestFullscreen = vi.fn(async () => {});
  if (o.iphone) Object.defineProperty(player, 'requestFullscreen', { configurable: true, value: undefined });
  else player.requestFullscreen = requestFullscreen;
  const webkitEnterFullscreen = vi.fn();
  if (o.iphone) Object.assign(video, { webkitEnterFullscreen });
  const requestPictureInPicture = vi.fn(async () => ({}) as PictureInPictureWindow);
  if (o.pip) {
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
    video.requestPictureInPicture = requestPictureInPicture;
  }
  const clock = fakeWindow(o.reducedMotion);
  const onPlayRefused = vi.fn();
  let started = o.started ?? false;
  const deps: PlayerControlsDeps = {
    player,
    video,
    doc: document,
    win: clock.win,
    now: clock.now,
    goLive: $('golive'),
    theater: $('theater'),
    started: () => started,
    onPlayRefused,
  };
  const controls = mountPlayerControls(deps);
  const byTestId = <T extends HTMLElement>(id: string): T => player.querySelector<T>(`[data-testid="${id}"]`)!;
  const nameOf = (el: HTMLElement): string => el.querySelector('.pc-sr')?.textContent ?? '';
  const idle = (): boolean => player.classList.contains('pc-idle');
  const pointer = (target: EventTarget, type: string, pointerType: string): void => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType }));
  };
  return {
    $,
    video,
    player,
    controls,
    clock,
    byTestId,
    nameOf,
    idle,
    pointer,
    onPlayRefused,
    requestFullscreen,
    webkitEnterFullscreen,
    requestPictureInPicture,
    setStarted: (on: boolean) => {
      started = on;
      controls.sync();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  for (const prop of ['pictureInPictureEnabled', 'fullscreenElement']) Reflect.deleteProperty(document, prop);
});

describe('built over the video', () => {
  it('removes the native controls once built, and names the bar for screen readers', () => {
    // Act
    const { video, player, controls } = setup();
    // Assert
    expect(video.hasAttribute('controls')).toBe(false);
    expect(player.classList.contains('pc-on')).toBe(true);
    expect(controls.bar.getAttribute('role')).toBe('group');
    expect(controls.bar.getAttribute('aria-label')).toBe('Video controls');
    expect(player.contains(controls.bar)).toBe(true);
  });

  it('a bar that cannot be built leaves the native controls (the attribute goes last)', () => {
    // Arrange
    document.body.innerHTML = MARKUP;
    const video = document.querySelector('video')!;
    // Act: no player container to build into
    const build = (): unknown => mountPlayerControls({ player: null as unknown as HTMLElement, video, doc: document, win: fakeWindow().win });
    // Assert
    expect(build).toThrow();
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('moves LIVE / Go live and theater mode into the bar; theater keeps its name, its tooltip and its pressed state', () => {
    // Act
    const { $, controls, nameOf } = setup();
    // Assert
    expect(controls.bar.contains($('golive'))).toBe(true);
    expect(controls.bar.contains($('theater'))).toBe(true);
    expect(nameOf($('theater'))).toBe('Theater mode');
    expect($('theater').title).toBe('A bigger video');
    expect($('theater').getAttribute('aria-pressed')).toBe('false');
    expect($('theater').hasAttribute('data-i18n')).toBe(false);
  });

  it('every control is a real button with a name, and its shortcut in the tooltip', () => {
    // Act
    const { byTestId, nameOf } = setup();
    // Assert
    for (const [id, label, tip] of [
      ['play', 'Play', 'Play (K)'],
      ['mute', 'Unmute', 'Unmute (M)'],
      ['fullscreen', 'Full screen', 'Full screen (F)'],
    ] as const) {
      const b = byTestId<HTMLButtonElement>(id);
      expect(b.tagName).toBe('BUTTON');
      expect(b.type).toBe('button');
      expect(nameOf(b)).toBe(label);
      expect(b.title).toBe(tip);
    }
  });
});

describe('play, pause and sound', () => {
  it('Play plays and becomes Pause; Pause pauses', async () => {
    // Arrange
    const { byTestId, nameOf, video } = setup();
    // Act
    byTestId('play').click();
    await vi.waitFor(() => expect(video.paused).toBe(false));
    // Assert
    expect(nameOf(byTestId('play'))).toBe('Pause');
    // Act
    byTestId('play').click();
    // Assert
    expect(video.paused).toBe(true);
    expect(nameOf(byTestId('play'))).toBe('Play');
  });

  it('the big Play button shows only while paused once the stream has started, and plays', async () => {
    // Arrange
    const { byTestId, setStarted, video } = setup();
    const big = byTestId('big-play');
    const beforeStart = big.hidden;
    // Act
    setStarted(true);
    // Assert
    expect(beforeStart).toBe(true);
    expect(big.hidden).toBe(false);
    // Act
    big.click();
    await vi.waitFor(() => expect(video.paused).toBe(false));
    // Assert
    expect(big.hidden).toBe(true);
  });

  it('a play the browser refuses (autoplay rules, Low Power Mode) is reported, so the page can offer Unmute', async () => {
    // Arrange
    const { byTestId, onPlayRefused } = setup({ playRefused: true });
    // Act
    byTestId('play').click();
    // Assert
    await vi.waitFor(() => expect(onPlayRefused).toHaveBeenCalledTimes(1));
  });

  it('Mute / Unmute flips the sound; the slider follows it and says the value in words', () => {
    // Arrange
    const { byTestId, nameOf, video } = setup();
    const volume = byTestId<HTMLInputElement>('volume');
    // Act
    byTestId('mute').click();
    video.dispatchEvent(new Event('volumechange'));
    // Assert
    expect(video.muted).toBe(false);
    expect(nameOf(byTestId('mute'))).toBe('Mute');
    expect(volume.hidden).toBe(false);
    expect(volume.value).toBe(String(Math.round(video.volume * 100)));
    expect(volume.getAttribute('aria-valuetext')).toBe(`${Math.round(video.volume * 100)}%`);
    // Act
    byTestId('mute').click();
    video.dispatchEvent(new Event('volumechange'));
    // Assert
    expect(video.muted).toBe(true);
    expect(volume.value).toBe('0');
  });

  it('the slider sets the volume; at 0 it mutes, and Unmute then gives some sound back', () => {
    // Arrange
    const { byTestId, video } = setup();
    const volume = byTestId<HTMLInputElement>('volume');
    video.muted = false;
    // Act
    volume.value = '40';
    volume.dispatchEvent(new Event('input'));
    // Assert
    expect(video.volume).toBeCloseTo(0.4);
    expect(video.muted).toBe(false);
    // Act
    volume.value = '0';
    volume.dispatchEvent(new Event('input'));
    byTestId('mute').click();
    // Assert
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.5);
  });

  it('iOS (volume read-only): no slider, only Mute', () => {
    // Act
    const { byTestId } = setup({ volumeFixed: true });
    // Assert
    expect(byTestId('volume').hidden).toBe(true);
    expect(byTestId('mute').hidden).toBe(false);
  });
});

describe('full screen and picture-in-picture', () => {
  it('full screen takes the player container, and the button then says Exit full screen', () => {
    // Arrange
    const { byTestId, nameOf, player, requestFullscreen, controls } = setup();
    // Act
    byTestId('fullscreen').click();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: player });
    document.dispatchEvent(new Event('fullscreenchange'));
    // Assert
    expect(controls.fullscreenMode).toBe('element');
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(player.classList.contains('is-fullscreen')).toBe(true);
    expect(nameOf(byTestId('fullscreen'))).toBe('Exit full screen');
  });

  it("iPhone: the button opens iOS's own player; leaving it, the controls read the video's state again", async () => {
    // Arrange
    const { byTestId, nameOf, video, webkitEnterFullscreen, controls } = setup({ iphone: true });
    // Act
    byTestId('fullscreen').click();
    // iOS's player played the video meanwhile; the viewer leaves it.
    await video.play();
    video.dispatchEvent(new Event('webkitendfullscreen'));
    // Assert
    expect(controls.fullscreenMode).toBe('video-native');
    expect(webkitEnterFullscreen).toHaveBeenCalledTimes(1);
    expect(nameOf(byTestId('play'))).toBe('Pause');
  });

  it('picture-in-picture: no button where the browser has none', () => {
    // Act
    const { byTestId, controls } = setup();
    // Assert
    expect(controls.pipMode).toBe('none');
    expect(byTestId('pip').hidden).toBe(true);
    expect(controls.togglePip()).toBe(false);
  });

  it('picture-in-picture where the browser has it: the button opens the floating window', () => {
    // Arrange
    const { byTestId, requestPictureInPicture } = setup({ pip: true });
    // Act
    byTestId('pip').click();
    // Assert
    expect(byTestId('pip').hidden).toBe(false);
    expect(requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it('a browser that announces picture-in-picture but refuses it as not supported loses the button', async () => {
    // Arrange
    const { byTestId, video, controls } = setup({ pip: true });
    video.requestPictureInPicture = vi.fn(() => Promise.reject(new DOMException('no', 'NotSupportedError')));
    // Act
    byTestId('pip').click();
    // Assert
    await vi.waitFor(() => expect(byTestId('pip').hidden).toBe(true));
    expect(controls.togglePip()).toBe(false);
  });

  it('a refusal for another reason (no user gesture) keeps the button', async () => {
    // Arrange
    const { byTestId, video } = setup({ pip: true });
    const request = vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    video.requestPictureInPicture = request;
    // Act
    byTestId('pip').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await Promise.resolve();
    // Assert
    expect(byTestId('pip').hidden).toBe(false);
  });

  it('the delay behind live shows in the bar on request (full screen hides the status line)', () => {
    // Arrange
    const { byTestId, controls } = setup();
    // Act
    controls.setDelay('~14 s behind live');
    // Assert
    expect(byTestId('controls-delay').hidden).toBe(false);
    expect(byTestId('controls-delay').textContent).toBe('~14 s behind live');
    expect(byTestId('controls-delay').getAttribute('aria-hidden')).toBe('true');
    // Act
    controls.setDelay(null);
    // Assert
    expect(byTestId('controls-delay').hidden).toBe(true);
  });
});

describe('fading', () => {
  async function playing(s: ReturnType<typeof setup>): Promise<void> {
    await s.video.play();
  }

  it('fades while playing after the hide delay; the mouse moving over the player brings it back', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    // Act
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Assert
    expect(s.idle()).toBe(true);
    // Act
    s.pointer(s.player, 'pointermove', 'mouse');
    // Assert
    expect(s.idle()).toBe(false);
  });

  it('the mouse leaving the player hides it at once; resting on the bar holds it', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    // Act
    s.pointer(s.controls.bar, 'pointerenter', 'mouse');
    s.clock.advance(CONTROLS_HIDE_AFTER_MS * 3);
    const held = !s.idle();
    s.pointer(s.controls.bar, 'pointerleave', 'mouse');
    s.pointer(s.player, 'pointerleave', 'mouse');
    // Assert
    expect(held).toBe(true);
    expect(s.idle()).toBe(true);
  });

  it('a keyboard focus inside the bar holds it; a focus a mouse press gave does not', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Act: Tab into the bar
    s.byTestId('mute').focus();
    s.clock.advance(CONTROLS_HIDE_AFTER_MS * 3);
    // Assert
    expect(s.idle()).toBe(false);
    // Act: the focus leaves it
    s.$('elsewhere').focus();
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Assert
    expect(s.idle()).toBe(true);
    // Act: a mouse press on a button, which focuses it
    s.pointer(s.byTestId('mute'), 'pointerdown', 'mouse');
    s.byTestId('mute').focus();
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Assert
    expect(s.idle()).toBe(true);
  });

  it('reduced motion: never fades (and follows the setting when it changes)', async () => {
    // Arrange
    const s = setup({ reducedMotion: true });
    await playing(s);
    // Act
    s.clock.advance(CONTROLS_HIDE_AFTER_MS * 5);
    // Assert
    expect(s.idle()).toBe(false);
    // Act
    s.clock.setReducedMotion(false);
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Assert
    expect(s.idle()).toBe(true);
  });

  it('a touch on a faded control only shows the controls: its click is dropped; the next touch presses it', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    const mute = s.byTestId('mute');
    // Act
    s.pointer(mute, 'pointerdown', 'touch');
    mute.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    // Assert
    expect(s.idle()).toBe(false);
    expect(s.video.muted).toBe(true);
    // Act
    s.pointer(mute, 'pointerdown', 'touch');
    mute.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    // Assert
    expect(s.video.muted).toBe(false);
  });

  it('a keyboard press of a faded control is never dropped', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    s.pointer(s.byTestId('mute'), 'pointerdown', 'touch');
    // Act: Enter on the button (a click with detail 0)
    s.byTestId('mute').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    // Assert
    expect(s.video.muted).toBe(false);
  });

  it('on the picture: a mouse click plays / pauses; a touch shows or hides the controls without pausing', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    // Act: touch while shown
    s.pointer(s.video, 'pointerdown', 'touch');
    s.video.click();
    // Assert
    expect(s.idle()).toBe(true);
    expect(s.video.paused).toBe(false);
    // Act: touch while faded
    s.pointer(s.video, 'pointerdown', 'touch');
    s.video.click();
    // Assert
    expect(s.idle()).toBe(false);
    // Act: mouse click
    s.pointer(s.video, 'pointerdown', 'mouse');
    s.video.click();
    // Assert
    expect(s.video.paused).toBe(true);
    expect(s.idle()).toBe(false);
  });

  it('reveal() (a shortcut was used) brings the faded controls back for the usual time', async () => {
    // Arrange
    const s = setup();
    await playing(s);
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Act
    s.controls.reveal();
    // Assert
    expect(s.idle()).toBe(false);
    s.clock.advance(CONTROLS_HIDE_AFTER_MS);
    expect(s.idle()).toBe(true);
  });
});
