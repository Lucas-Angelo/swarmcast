// @vitest-environment happy-dom
// "Audio only (saves data)" on the viewer (audio-only.ts, quality-menu.ts, player-config.ts):
// - the switch loads /hls/audio-only.m3u8 instead of index.m3u8 and back, every reload (stall
//   watchdog, vanished playlists, network errors) loads the playlist of the current choice, and
//   the choice is remembered per browser;
// - a 404 on the audio-only playlist (the stream has no separate audio) goes back to video for the
//   page and keeps the saved choice;
// - the quality menu offers "Audio only" only when the stream has separate audio, keeps the video
//   qualities on offer while audio only plays (hls.levels is then one level without a height), and
//   picking one of them goes back to video at that height;
// - audio-only playback joins the video viewers' audio swarm, never a video swarm;
// - the poster shows the streamer's name and picture as text and a same-origin image;
// - the state is observable (a screen wake lock subscribes to it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_ONLY_PLAYLIST, variantStreamSwarmId } from '@swarmcast/shared';
import type { StreamSwarmIdBuilderContext } from 'p2p-media-loader-core';
import { AUDIO_ONLY_BROKEN_WINDOW_MS, AUDIO_ONLY_GONE_AFTER, AUDIO_ONLY_URL, AudioOnlyState, createAudioOnlySwitch, fetchPosterBrand, mountAudioOnlyPoster, showPlayerNotice, type ParsedManifest } from '../../src/audio-only.js';
import { createManifestReloader, loadAudioOnly, loadPreferredHeight, saveAudioOnly, savePreferredHeight, swarmIdBuilderFor } from '../../src/player-config.js';
import { AUDIO_ONLY_OPTION, createQualityMenu, DEFAULT_QUALITY_LABELS } from '../../src/quality-menu.js';

// happy-dom has no `Option` constructor (browsers do): the menu builds its entries with it.
if (typeof globalThis.Option === 'undefined') {
  globalThis.Option = function Option(text = '', value = '') {
    const op = document.createElement('option');
    op.text = text;
    op.value = value;
    return op;
  } as unknown as typeof Option;
}

const EVENTS = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_SWITCHED: 'hlsLevelSwitched' } as const;

type Level = { height?: number; bitrate?: number };

/** The parts of hls.js the switch and the menu use, with `parsed()` standing for MANIFEST_PARSED. */
class FakeHls {
  levels: Level[] = [];
  audioTracks: unknown[] = [];
  currentLevel = -1;
  nextLevel = -1;
  autoLevelEnabled = true;
  private load = -1;
  /** Like hls.js: a level picked by hand turns automatic quality off, -1 turns it back on. */
  get loadLevel(): number {
    return this.load;
  }
  set loadLevel(i: number) {
    this.load = i;
    this.autoLevelEnabled = i < 0;
  }
  private readonly handlers = new Map<string, Array<(e: string, d: unknown) => void>>();
  on(e: string, fn: (e: string, d: unknown) => void): void {
    this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]);
  }
  off(e: string, fn: (e: string, d: unknown) => void): void {
    this.handlers.set(e, (this.handlers.get(e) ?? []).filter((f) => f !== fn));
  }
  /** New playlists parsed: the normal ones (`audioTracks` = a separate audio rendition) or the audio-only one. */
  parsed(levels: Level[], audioTracks: unknown[] = []): void {
    this.levels = levels;
    this.audioTracks = audioTracks;
    this.currentLevel = 0;
    const data: ParsedManifest = { levels, audioTracks };
    for (const fn of this.handlers.get(EVENTS.MANIFEST_PARSED) ?? []) fn(EVENTS.MANIFEST_PARSED, data);
  }
}

const VIDEO_LEVELS: Level[] = [{ height: 720, bitrate: 3e6 }, { height: 480, bitrate: 1.5e6 }, { height: 360, bitrate: 9e5 }];
const AUDIO_LEVEL: Level[] = [{ bitrate: 160_000 }];
const AUDIO_TRACK = [{ name: 'audio' }];

function setup(o: { saved?: boolean } = {}) {
  const hls = new FakeHls();
  const state = new AudioOnlyState();
  const load = vi.fn<(url: string, why: string) => void>();
  const save = vi.fn<(on: boolean) => void>();
  const onBroken = vi.fn();
  const clock = { t: 1_000_000 };
  const source = createAudioOnlySwitch({ hls, events: EVENTS, videoUrl: '/hls/index.m3u8', load, saved: o.saved ?? false, save, state, onBroken, now: () => clock.t });
  return { hls, state, load, save, source, onBroken, clock };
}

function mountMenu(hls: FakeHls, source: ReturnType<typeof setup>['source']) {
  const container = document.createElement('div');
  document.body.append(container);
  const menu = createQualityMenu(hls as never, container, EVENTS, DEFAULT_QUALITY_LABELS, source);
  const options = (): string[] => [...menu.element.options].map((op) => op.text);
  const pick = (value: string): void => {
    menu.element.value = value;
    menu.element.dispatchEvent(new Event('change'));
  };
  return { menu, options, pick };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.replaceChildren();
});

describe('the audio-only switch', () => {
  it('loads the audio-only playlist, then the normal one again, saving each choice', () => {
    // Arrange
    const { source, load, save, state } = setup();
    // Act
    source.set(true);
    const onUrl = source.url();
    source.set(false);
    // Assert
    expect(onUrl).toBe(`/hls/${AUDIO_ONLY_PLAYLIST}`);
    expect(load.mock.calls).toEqual([
      [AUDIO_ONLY_URL, 'audio only'],
      ['/hls/index.m3u8', 'video again'],
    ]);
    expect(save.mock.calls).toEqual([[true], [false]]);
    expect(state.on).toBe(false);
    expect(source.url()).toBe('/hls/index.m3u8');
  });

  it('starts on the saved choice: the first load and every reload get the audio-only playlist', () => {
    // Act
    const { source, state, load } = setup({ saved: true });
    // Assert
    expect(state.on).toBe(true);
    expect(source.active).toBe(true);
    expect(source.available).toBe(true);
    expect(source.url()).toBe(AUDIO_ONLY_URL);
    expect(load).not.toHaveBeenCalled();
  });

  it('picking the choice already playing loads nothing again', () => {
    // Arrange
    const { source, load } = setup({ saved: true });
    // Act
    source.set(true);
    // Assert
    expect(load).not.toHaveBeenCalled();
  });

  it('is offered only when the normal playlists have a separate audio rendition', () => {
    // Arrange
    const { hls, source } = setup();
    // Act
    hls.parsed(VIDEO_LEVELS);
    const muxed = source.available;
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Assert
    expect(muxed).toBe(false);
    expect(source.available).toBe(true);
    expect(source.heights).toEqual([720, 480, 360]);
  });

  it('keeps the video qualities it knew while the audio-only playlist (one level, no height) plays', () => {
    // Arrange
    const { hls, source } = setup();
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Act
    source.set(true);
    hls.parsed(AUDIO_LEVEL);
    // Assert
    expect(source.heights).toEqual([720, 480, 360]);
    expect(source.available).toBe(true);
  });

  it('a 404 on the audio-only playlist (no separate audio) goes back to video for the page, the saved choice stays', () => {
    // Arrange
    const { source, state, save, load } = setup({ saved: true });
    // Act
    source.onError('manifestLoadError', 404);
    // Assert
    expect(state.on).toBe(false);
    expect(source.url()).toBe('/hls/index.m3u8');
    expect(source.available).toBe(false);
    expect(save).not.toHaveBeenCalled();
    // The player's own network-error reload loads it (watch.ts), with its back-off.
    expect(load).not.toHaveBeenCalled();
  });

  it('other errors keep audio only: not there yet (503), a vanished media playlist (the ladder changed)', () => {
    // Arrange
    const { source, state } = setup({ saved: true });
    // Act
    source.onError('manifestLoadError', 503);
    source.onError('levelLoadError', 404);
    // Assert
    expect(state.on).toBe(true);
    expect(source.url()).toBe(AUDIO_ONLY_URL);
  });
});

describe('a vanished media playlist while audio only plays', () => {
  it('reloads on the first 404 (the server says 404 only for a playlist the stream no longer lists); video still waits for 3', () => {
    // Arrange
    let audioOnly = true;
    const reload = vi.fn();
    const reloader = createManifestReloader(reload, () => (audioOnly ? AUDIO_ONLY_GONE_AFTER : 3));
    // Act
    reloader.onError('levelLoadError', 404);
    const afterAudio = reload.mock.calls.length;
    audioOnly = false;
    reloader.onError('levelLoadError', 404);
    reloader.onError('audioTrackLoadError', 404);
    const afterTwoVideo = reload.mock.calls.length;
    reloader.onError('levelLoadError', 404);
    // Assert
    expect(afterAudio).toBe(1);
    expect(afterTwoVideo).toBe(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('a playlist not there yet (503) is no reason to reload', () => {
    // Arrange
    const reload = vi.fn();
    const reloader = createManifestReloader(reload, () => AUDIO_ONLY_GONE_AFTER);
    // Act
    reloader.onError('levelLoadError', 503);
    // Assert
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a device that cannot play the sound alone', () => {
  it('goes back to video at once after the MediaSource is reset twice in a row, and stops offering audio only', () => {
    // Arrange: Firefox without an audio output fails the element as soon as it is unmuted, and hls.js resets the MediaSource
    const { hls, source, state, load, save, onBroken, clock } = setup();
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    source.set(true);
    load.mockClear();
    save.mockClear();
    // Act
    source.onError('mediaSourceRequiresReset');
    clock.t += 2000;
    source.onError('mediaSourceRequiresReset');
    // Assert
    expect(state.on).toBe(false);
    expect(load.mock.calls).toEqual([['/hls/index.m3u8', 'audio only cannot play here']]);
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(source.available).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('one reset is a one-off: audio only goes on', () => {
    // Arrange
    const { source, state, load, clock } = setup({ saved: true });
    // Act
    source.onError('mediaSourceRequiresReset');
    clock.t += AUDIO_ONLY_BROKEN_WINDOW_MS;
    source.onError('mediaSourceRequiresReset');
    // Assert
    expect(state.on).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it('resets while video plays are hls.js own business', () => {
    // Arrange
    const { source, load, onBroken } = setup();
    // Act
    source.onError('mediaSourceRequiresReset');
    source.onError('mediaSourceRequiresReset');
    // Assert
    expect(load).not.toHaveBeenCalled();
    expect(onBroken).not.toHaveBeenCalled();
  });

  it('the notice says why, as a status, and goes away by itself', () => {
    // Arrange
    vi.useFakeTimers();
    const p = document.createElement('div');
    document.body.append(p);
    // Act
    const el = showPlayerNotice(p, 'Audio only does not work on this device, so the video is back.', 8000);
    const shown = !el.hidden;
    vi.advanceTimersByTime(8000);
    // Assert
    expect(shown).toBe(true);
    expect(el.getAttribute('role')).toBe('status');
    expect(el.hidden).toBe(true);
    vi.useRealTimers();
  });
});

describe('the audio-only state', () => {
  it('tells a subscriber the current value at once, then every change, until it unsubscribes', () => {
    // Arrange
    const state = new AudioOnlyState();
    const seen: boolean[] = [];
    // Act
    const stop = state.subscribe((on) => seen.push(on));
    state.set(true);
    state.set(true);
    state.set(false);
    stop();
    state.set(true);
    // Assert
    expect(seen).toEqual([false, true, false]);
  });
});

describe('the remembered choice', () => {
  it('is saved per browser and cleared when the viewer goes back to video', () => {
    // Act
    saveAudioOnly(true);
    const on = loadAudioOnly();
    saveAudioOnly(false);
    // Assert
    expect(on).toBe(true);
    expect(loadAudioOnly()).toBe(false);
    expect(localStorage.getItem('sc.audio-only')).toBeNull();
  });

  it('is off when storage is blocked', () => {
    // Arrange
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    // Act
    const on = loadAudioOnly();
    // Assert
    expect(on).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('the quality menu with audio only', () => {
  it('adds "Audio only" after the video qualities when the stream has separate audio', () => {
    // Arrange
    const { hls, source } = setup();
    const { menu, options } = mountMenu(hls, source);
    // Act
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Assert
    expect(options()).toEqual(['Auto (720p)', '720p', '480p', '360p', 'Audio only (saves data)']);
    expect(menu.element.hidden).toBe(false);
  });

  it('offers no "Audio only" when the audio is muxed into the video', () => {
    // Arrange
    const { hls, source } = setup();
    const { menu, options } = mountMenu(hls, source);
    // Act
    hls.parsed(VIDEO_LEVELS);
    // Assert
    expect(options()).toEqual(['Auto (720p)', '720p', '480p', '360p']);
    expect(menu.element.hidden).toBe(false);
  });

  it('with one video quality, shows it and "Audio only" (no "Auto" with nothing to choose), and hides when there is no audio either', () => {
    // Arrange
    const { hls, source } = setup();
    const { menu, options } = mountMenu(hls, source);
    // Act
    hls.parsed([{ height: 1080 }], AUDIO_TRACK);
    const withAudio = { options: options(), hidden: menu.element.hidden, value: menu.element.value };
    hls.parsed([{ height: 1080 }]);
    // Assert
    expect(withAudio).toEqual({ options: ['1080p', 'Audio only (saves data)'], hidden: false, value: '-1' });
    expect(menu.element.hidden).toBe(true);
  });

  it('picking "Audio only" switches to it; the menu keeps the video qualities and shows "Audio only" picked', () => {
    // Arrange
    const { hls, source, load } = setup();
    const { menu, options, pick } = mountMenu(hls, source);
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Act
    pick(AUDIO_ONLY_OPTION);
    hls.parsed(AUDIO_LEVEL);
    // Assert
    expect(load).toHaveBeenCalledWith(AUDIO_ONLY_URL, 'audio only');
    expect(options()).toEqual(['Auto', '720p', '480p', '360p', 'Audio only (saves data)']);
    expect(menu.element.value).toBe(AUDIO_ONLY_OPTION);
    expect(menu.element.selectedOptions[0]?.text).toBe('Audio only (saves data)');
    expect(hls.loadLevel).toBe(-1);
  });

  it('picking a video quality while audio only plays goes back to video at that height', () => {
    // Arrange
    const { hls, source, load } = setup();
    const { menu, pick } = mountMenu(hls, source);
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    pick(AUDIO_ONLY_OPTION);
    hls.parsed(AUDIO_LEVEL);
    // Act
    pick('h480');
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Assert
    expect(load).toHaveBeenLastCalledWith('/hls/index.m3u8', 'video again');
    expect(loadPreferredHeight()).toBe(480);
    expect(hls.loadLevel).toBe(1);
    expect(source.active).toBe(false);
    expect(menu.element.value).toBe('1');
  });

  it('picking "Auto" while audio only plays goes back to video on automatic quality', () => {
    // Arrange
    savePreferredHeight(360);
    const { hls, source } = setup();
    const { menu, pick } = mountMenu(hls, source);
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    pick(AUDIO_ONLY_OPTION);
    hls.parsed(AUDIO_LEVEL);
    hls.loadLevel = -1;
    // Act
    pick('-1');
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Assert
    expect(loadPreferredHeight()).toBeNull();
    expect(hls.loadLevel).toBe(-1);
    expect(menu.element.value).toBe('-1');
  });

  it('started on audio only (nothing known about the video yet): "Auto" and "Audio only", shown before the playlists load', () => {
    // Arrange
    const { hls, source } = setup({ saved: true });
    // Act
    const { menu, options } = mountMenu(hls, source);
    // Assert
    expect(options()).toEqual(['Auto', 'Audio only (saves data)']);
    expect(menu.element.hidden).toBe(false);
    expect(menu.element.value).toBe(AUDIO_ONLY_OPTION);
  });

  it('never applies the remembered height to the audio-only level', () => {
    // Arrange
    savePreferredHeight(480);
    const { hls, source } = setup({ saved: true });
    mountMenu(hls, source);
    // Act
    hls.parsed(AUDIO_LEVEL);
    // Assert
    expect(hls.loadLevel).toBe(-1);
  });

  it('goes back to the video list when the audio-only playlist is gone (404)', () => {
    // Arrange
    const { hls, source } = setup({ saved: true });
    const { options } = mountMenu(hls, source);
    // Act
    source.onError('manifestLoadError', 404);
    hls.parsed([{ height: 720 }, { height: 360 }]);
    // Assert
    expect(options()).toEqual(['Auto (720p)', '720p', '360p']);
  });
});

describe('P2P swarm of audio-only playback', () => {
  const ctx = (streamType: 'main' | 'secondary', height?: number): StreamSwarmIdBuilderContext =>
    ({ swarmId: 'live1', streamType, properties: height ? { height } : { bitrate: 160_000 }, runtimeId: 'x', identityHash: 'h', defaultStreamSwarmId: 'd', peerProtocolVersion: 'v' }) as unknown as StreamSwarmIdBuilderContext;

  it('joins the audio swarm video viewers share their audio track in, never a video swarm', () => {
    // Arrange
    const build = swarmIdBuilderFor(() => true);
    // Act
    const id = build(ctx('main'));
    // Assert
    expect(id).toBe(variantStreamSwarmId('live1', 'secondary'));
    expect(id).toBe('swarmcast-live1-secondary');
    expect(id).not.toBe(variantStreamSwarmId('live1', 'main', 0));
  });

  it('video playback keeps one swarm per height and the audio track its own', () => {
    // Arrange
    const build = swarmIdBuilderFor(() => false);
    // Act
    const ids = [build(ctx('main', 720)), build(ctx('main')), build(ctx('secondary'))];
    // Assert
    expect(ids).toEqual(['swarmcast-live1-main-720', 'swarmcast-live1-main-0', 'swarmcast-live1-secondary']);
  });
});

describe('the audio-only poster', () => {
  function player(): HTMLElement {
    const p = document.createElement('div');
    p.className = 'player';
    const v = document.createElement('video');
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    p.append(v, overlay);
    document.body.append(p);
    return p;
  }

  it('shows while audio only plays, under the status overlay, with the streamer name and picture', async () => {
    // Arrange
    const p = player();
    const state = new AudioOnlyState();
    const brand = vi.fn(async () => ({ name: '<b>Ana</b>', avatar: `/brand/${'a'.repeat(64)}.webp` }));
    const el = mountAudioOnlyPoster(p, { state, labels: { title: 'Audio only', hint: 'hint' }, brand });
    const hiddenAtFirst = el.hidden;
    // Act
    state.set(true);
    await vi.waitFor(() => expect(el.querySelector('img')).not.toBeNull());
    // Assert
    expect(hiddenAtFirst).toBe(true);
    expect(el.hidden).toBe(false);
    expect(el.nextElementSibling?.className).toBe('overlay');
    expect(p.classList.contains('audio-only-on')).toBe(true);
    expect(el.querySelector('.audio-only-name')?.textContent).toBe('<b>Ana</b>');
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('img')?.getAttribute('src')).toBe(`/brand/${'a'.repeat(64)}.webp`);
    expect(el.querySelector('.audio-only-title')?.textContent).toBe('Audio only');
  });

  it('without "Your page": "Audio only" and a speaker icon, no name', async () => {
    // Arrange
    const p = player();
    const state = new AudioOnlyState();
    const brand = vi.fn(async () => null);
    const el = mountAudioOnlyPoster(p, { state, labels: { title: 'Audio only', hint: 'hint' }, brand });
    // Act
    state.set(true);
    await vi.waitFor(() => expect(brand).toHaveBeenCalled());
    await Promise.resolve();
    // Assert
    expect(el.querySelector('.audio-only-name')?.hasAttribute('hidden')).toBe(true);
    expect(el.querySelector('.sc-ico-volume')).not.toBeNull();
    expect(el.querySelector('img')).toBeNull();
  });

  it('hides when video comes back', () => {
    // Arrange
    const p = player();
    const state = new AudioOnlyState();
    const el = mountAudioOnlyPoster(p, { state, labels: { title: 'Audio only', hint: 'hint' } });
    state.set(true);
    // Act
    state.set(false);
    // Assert
    expect(el.hidden).toBe(true);
    expect(p.classList.contains('audio-only-on')).toBe(false);
  });
});

describe('the poster branding', () => {
  it('keeps the name and a same-origin picture from /api/brand; anything else is dropped', async () => {
    // Arrange
    const f = vi.fn(async () => new Response(JSON.stringify({ rev: 3, name: 'Ana', avatar: { s256: 'https://evil.example/x.png' } })));
    // Act
    const b = await fetchPosterBrand(f as unknown as typeof fetch);
    // Assert
    expect(b).toEqual({ name: 'Ana' });
    expect(f).toHaveBeenCalledWith('/api/brand', { credentials: 'same-origin', cache: 'no-cache' });
  });

  it('is null when branding is off or the request fails', async () => {
    // Act
    const off = await fetchPosterBrand((async () => new Response(JSON.stringify({ off: true }))) as unknown as typeof fetch);
    const failed = await fetchPosterBrand((async () => new Response('', { status: 401 })) as unknown as typeof fetch);
    const thrown = await fetchPosterBrand((async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch);
    // Assert
    expect([off, failed, thrown]).toEqual([null, null, null]);
  });
});
