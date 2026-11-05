// @vitest-environment happy-dom
// "Audio only (saves data)" on the viewer (audio-only.ts, quality-menu.ts, player-config.ts):
// - the switch loads /hls/audio-only.m3u8 instead of index.m3u8 and back, every reload (stall
//   watchdog, vanished playlists, network errors) loads the playlist of the current choice, and
//   the choice is remembered per browser;
// - a 404 on the audio-only playlist (the stream has no separate audio) goes back to video for the
//   page and keeps the saved choice;
// - reading the audio-only playlist again because a media playlist it listed went away keeps the
//   element's MediaSource (a new one for sound alone can crash Linux WebKit), plays on what it
//   holds until the first segment of the new read is buffered, then moves into it and flushes the
//   rest (the old buffer and playhead sit on the timeline of the window the viewer joined); the
//   playlist read again never makes an element that plays on start over from 0 (play() on one
//   that played out its old buffer), and hls.js's interstitials controller, which loaded and
//   appended the first new segment twice while hls.js seeked into it, is off;
// - the quality menu offers "Audio only" only when the stream has separate audio, keeps the video
//   qualities on offer while audio only plays (hls.levels is then one level without a height), and
//   picking one of them goes back to video at that height;
// - audio-only playback joins the video viewers' audio swarm, never a video swarm;
// - the poster shows the streamer's name and picture as text and a same-origin image;
// - the state is observable (a screen wake lock subscribes to it);
// - on Linux WebKit (GStreamer), sound alone on a new MediaSource starts at the first segment of
//   the live window and moves to live only once it plays: a seek before the new sound-only
//   pipeline played anything kills the page's process there (hls.js seeks right after its first
//   append on every live start).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_ONLY_PLAYLIST, variantStreamSwarmId } from '@swarmcast/shared';
import type { StreamSwarmIdBuilderContext } from 'p2p-media-loader-core';
import { AUDIO_ONLY_BROKEN_WINDOW_MS, AUDIO_ONLY_GONE_AFTER, AUDIO_ONLY_URL, AudioOnlyState, createAudioOnlySwitch, createWindowStart, fetchPosterBrand, mountAudioOnlyPoster, reloadAudioOnlyInPlace, showPlayerNotice, usesGStreamer, WINDOW_START_PLAY_S, type ParsedManifest } from '../../src/audio-only.js';
import { createManifestReloader, hlsConfigFor, loadAudioOnly, loadPreferredHeight, playOnLoad, saveAudioOnly, savePreferredHeight, swarmIdBuilderFor } from '../../src/player-config.js';
import { AUDIO_ONLY_OPTION, createQualityMenu, DEFAULT_QUALITY_LABELS } from '../../src/quality-menu.js';

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
  const entries = (): HTMLElement[] => [...menu.menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const options = (): string[] => entries().map((item) => item.textContent ?? '');
  /** The entry the menu marks as in use (aria-checked). */
  const checked = (): HTMLElement | undefined => entries().find((item) => item.getAttribute('aria-checked') === 'true');
  const value = (): string | undefined => checked()?.dataset.value;
  /** As a viewer does: open the menu, click the entry. */
  const pick = (v: string): void => {
    menu.button.click();
    entries()
      .find((item) => item.dataset.value === v)!
      .click();
  };
  return { menu, options, pick, value, checked };
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

/**
 * The parts of hls.js a reload uses, recording the calls. `loadSource` with the media attached
 * detaches it and gives the element a new MediaSource (hls.js loadSource), which Linux WebKit
 * can crash on for sound alone; `transferMedia` hands the MediaSource over instead.
 */
/** Time ranges from [start, end] pairs. */
const ranges = (r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

/** The element hls.js hands over: what it holds (the read before: 46-70 s), its playhead (66 s) and the seeks made. */
class KeptElement {
  held: Array<[number, number]> = [[46, 70]];
  seeking = false;
  seeks: number[] = [];
  private t = 66;
  get buffered() {
    return ranges(this.held);
  }
  get currentTime(): number {
    return this.t;
  }
  /** Like an element: setting the time starts a seek, which `seeked()` ends. */
  set currentTime(t: number) {
    this.seeks.push(t);
    this.t = t;
    this.seeking = true;
  }
  private onSeeked: Array<() => void> = [];
  addEventListener(type: 'seeked', fn: () => void): void {
    if (type === 'seeked') this.onSeeked.push(fn);
  }
  seeked(): void {
    this.seeking = false;
    const fns = this.onSeeked;
    this.onSeeked = [];
    for (const fn of fns) fn();
  }
}

class ReloadHls {
  calls: string[] = [];
  mediaSources = 1;
  startPosition = -1;
  readonly element = new KeptElement();
  attached: unknown = 'media';
  readonly flushes: Array<{ startOffset: number; endOffset: number; type: null }> = [];
  private readonly handlers = new Map<string, Array<(e: string, d: unknown) => void>>();
  constructor(
    public url: string | null,
    private readonly canTransfer = true,
  ) {}
  on(e: string, fn: (e: string, d: unknown) => void): void {
    this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]);
  }
  off(e: string, fn: (e: string, d: unknown) => void): void {
    this.handlers.set(e, (this.handlers.get(e) ?? []).filter((f) => f !== fn));
  }
  trigger(e: string, d: { startOffset: number; endOffset: number; type: null }): boolean {
    if (e === RELOAD_EVENTS.BUFFER_FLUSHING) this.flushes.push(d);
    return true;
  }
  /** hls.js buffered a fragment (`type` main) of the playlist it read, at [start, end]. */
  buffered(start: number, end: number, type = 'main'): void {
    this.element.held.push([start, end]);
    for (const fn of this.handlers.get(RELOAD_EVENTS.FRAG_BUFFERED) ?? []) fn(RELOAD_EVENTS.FRAG_BUFFERED, { frag: { type, start, end } });
  }
  listeners(): number {
    return (this.handlers.get(RELOAD_EVENTS.FRAG_BUFFERED) ?? []).length;
  }
  loadSource(url: string): void {
    if (this.attached) {
      // hls.js: remove and re-create the MediaSource.
      this.mediaSources += 1;
    }
    this.url = new URL(url, BASE).href;
    this.calls.push(`loadSource ${new URL(url, BASE).pathname}`);
  }
  transferMedia() {
    this.calls.push('transferMedia');
    if (!this.canTransfer) return null;
    const kept = { media: this.element, mediaSource: 'kept' };
    this.attached = null;
    return kept;
  }
  attachMedia(m: never): void {
    this.calls.push('attachMedia');
    this.attached = m;
  }
}

const BASE = 'https://viewer.test/watch';
const RELOAD_EVENTS = { FRAG_BUFFERED: 'hlsFragBuffered', BUFFER_FLUSHING: 'hlsBufferFlushing' } as const;
const reload = (hls: ReloadHls, url: string) => reloadAudioOnlyInPlace(hls, url, { base: BASE, events: RELOAD_EVENTS });
const audioOnly = () => new ReloadHls(new URL(AUDIO_ONLY_URL, BASE).href);

describe('reading the audio-only playlist again (a media playlist it listed went away)', () => {
  it('keeps the MediaSource: hands it over, reads the playlist, takes it back, and plays on what it holds meanwhile', () => {
    // Arrange
    const hls = audioOnly();
    // Act
    const done = reload(hls, AUDIO_ONLY_URL);
    // Assert: emptied now, the element would wait with nothing buffered (the adaptive delay holds playback for that)
    expect(done).toBe(true);
    expect(hls.calls).toEqual(['transferMedia', `loadSource ${AUDIO_ONLY_URL}`, 'attachMedia']);
    expect(hls.mediaSources).toBe(1);
    expect(hls.attached).toMatchObject({ media: hls.element, mediaSource: 'kept' });
    expect([hls.element.seeks, hls.flushes]).toEqual([[], []]);
  });

  it('once the first segment of the playlist read again is buffered, moves the playhead into it, where hls.js starts, and flushes what the read before left once that seek is over', () => {
    // Arrange: the playhead at 66 s on the timeline of the window the viewer joined; the window
    // read again starts at 0, hls.js at its live sync position 21.7 s
    const hls = audioOnly();
    reload(hls, AUDIO_ONLY_URL);
    hls.startPosition = 21.7;
    // Act
    hls.buffered(20.05, 22.04, 'audio');
    hls.buffered(20.05, 22.04);
    hls.buffered(22.04, 24.06);
    hls.element.seeked();
    hls.buffered(24.06, 26.07);
    // Assert: once, for the first segment of the main playlist
    expect(hls.element.seeks).toEqual([21.7]);
    expect(hls.flushes).toEqual([{ startOffset: 46, endOffset: 70, type: null }]);
    expect(hls.listeners()).toBe(0);
  });

  it('flushes nothing while the seek into the new segment runs (Linux WebKit then plays with no clock)', () => {
    // Arrange
    const hls = audioOnly();
    reload(hls, AUDIO_ONLY_URL);
    hls.startPosition = 21.7;
    // Act
    hls.buffered(20.05, 22.04);
    hls.buffered(22.04, 24.06);
    // Assert
    expect(hls.element.seeking).toBe(true);
    expect(hls.flushes).toEqual([]);
  });

  it('flushes what the read before left on both sides of the new segment, but not the segments of the new read buffered during the seek', () => {
    // Arrange: the window had moved on a little, so the old media spans the new segment and the next ones
    const hls = audioOnly();
    hls.element.held = [[10, 34]];
    reload(hls, AUDIO_ONLY_URL);
    hls.startPosition = 26.2;
    // Act
    hls.buffered(26, 28);
    hls.buffered(28, 30);
    hls.buffered(30, 32);
    hls.element.seeked();
    // Assert
    expect(hls.element.seeks).toEqual([26.2]);
    expect(hls.flushes).toEqual([
      { startOffset: 10, endOffset: 26, type: null },
      { startOffset: 32, endOffset: 34, type: null },
    ]);
  });

  it('moves the playhead to the start of the segment when hls.js starts a little before it', () => {
    // Arrange
    const hls = audioOnly();
    reload(hls, AUDIO_ONLY_URL);
    hls.startPosition = 20;
    // Act
    hls.buffered(20.05, 22.04);
    // Assert
    expect(hls.element.seeks).toEqual([20.05]);
  });

  it('leaves the playhead alone when hls.js moved it itself or it is in the new segment, and still flushes the rest, after the seek', () => {
    // Arrange: hls.js seeks a playhead that is before its start position (stream-controller seekToStartPos)
    const seeking = audioOnly();
    const inside = audioOnly();
    for (const hls of [seeking, inside]) {
      reload(hls, AUDIO_ONLY_URL);
      hls.startPosition = 21.7;
    }
    seeking.element.seeking = true;
    // Act
    seeking.buffered(20.05, 22.04);
    inside.buffered(64.1, 68.13);
    const whileSeeking = [...seeking.flushes];
    seeking.element.seeked();
    // Assert
    expect([seeking.element.seeks, inside.element.seeks]).toEqual([[], []]);
    expect(whileSeeking).toEqual([]);
    expect(seeking.flushes).toEqual([{ startOffset: 46, endOffset: 70, type: null }]);
    expect(inside.flushes).toEqual([
      { startOffset: 46, endOffset: 64.1, type: null },
      { startOffset: 68.13, endOffset: 70, type: null },
    ]);
  });

  it('the playlist read again does not start an element over that still plays: play() on one that played out its old buffer seeks to 0', () => {
    // Arrange: the old buffer ran out while the reload ran (the playhead at the end of the media,
    // which the browser counts as ended), and a page whose first load is still paused
    const played: string[] = [];
    const element = (paused: boolean, name: string) => ({
      paused,
      play: () => {
        played.push(name);
        return Promise.resolve();
      },
    });
    const blocked = vi.fn();
    // Act
    playOnLoad(element(false, 'kept, playing'), blocked);
    playOnLoad(element(true, 'new MediaSource, paused'), blocked);
    // Assert
    expect(played).toEqual(['new MediaSource, paused']);
  });

  it('a start blocked by the browser (autoplay) is reported', async () => {
    // Arrange
    const blocked = vi.fn();
    const media = { paused: true, play: () => Promise.reject(new DOMException('not allowed', 'NotAllowedError')) };
    // Act
    playOnLoad(media, blocked);
    await Promise.resolve();
    await Promise.resolve();
    // Assert
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it('hls.js plays no interstitials: its controller loaded and appended the first segment of the read again twice, during the seek into it', () => {
    // Act
    const configs = (['stable', 'low-delay'] as const).map((id) => hlsConfigFor(id, { isMobile: false }));
    // Assert
    expect(configs.map((c) => c.enableInterstitialPlayback)).toEqual([false, false]);
  });

  it('does nothing for video, for a switch between video and audio only, or when hls.js cannot hand the media over', () => {
    // Arrange
    const video = new ReloadHls(new URL('/hls/index.m3u8', BASE).href);
    const toAudio = new ReloadHls(new URL('/hls/index.m3u8', BASE).href);
    const toVideo = audioOnly();
    const noTransfer = new ReloadHls(new URL(AUDIO_ONLY_URL, BASE).href, false);
    // Act
    const done = [reload(video, '/hls/index.m3u8'), reload(toAudio, AUDIO_ONLY_URL), reload(toVideo, '/hls/index.m3u8'), reload(noTransfer, AUDIO_ONLY_URL)];
    // Assert: the caller loads those as usual.
    expect(done).toEqual([false, false, false, false]);
    expect([video.calls, toAudio.calls, toVideo.calls]).toEqual([[], [], []]);
    expect(noTransfer.calls).toEqual(['transferMedia']);
    expect([video, toAudio, toVideo, noTransfer].map((h) => h.listeners())).toEqual([0, 0, 0, 0]);
  });
});

/** The element a sound-only start drives: its playhead, seeks, and the timeupdate it sends. */
class StartMedia {
  seeking = false;
  paused = true;
  seeks: number[] = [];
  private t = 0;
  private listeners: Array<() => void> = [];
  get currentTime(): number {
    return this.t;
  }
  set currentTime(t: number) {
    this.seeks.push(t);
    this.t = t;
  }
  addEventListener(_type: 'timeupdate', fn: () => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_type: 'timeupdate', fn: () => void): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
  get listening(): number {
    return this.listeners.length;
  }
  /** A timeupdate before playback started (the element still paused). */
  timeupdateWhilePaused(): void {
    for (const fn of [...this.listeners]) fn();
  }
  /** Playback reached `t` on its own (the pipeline's clock), as a timeupdate reports it. */
  playedTo(t: number): void {
    this.paused = false;
    this.t = t;
    for (const fn of [...this.listeners]) fn();
  }
}

const LINUX_WEBKIT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const startPlayer = () => ({ config: { startPosition: -1 }, liveSyncPosition: 21.7 as number | null });

describe('sound alone on a new MediaSource on Linux WebKit (GStreamer)', () => {
  it('starts at the first segment of the live window, where its media begins, so hls.js does not seek before the pipeline plays', () => {
    // Arrange
    const hls = startPlayer();
    const media = new StartMedia();
    const start = createWindowStart(hls, media, { enabled: true, base: BASE });
    // Act
    start.beforeLoad(AUDIO_ONLY_URL);
    // Assert: a live start elsewhere seeks to the live sync position right after the first append
    expect(hls.config.startPosition).toBe(0);
    expect(start.active).toBe(true);
    expect(media.seeks).toEqual([]);
  });

  it(`moves to live only once playback has run ${WINDOW_START_PLAY_S} s from where it started, and lets hls.js start live again afterwards`, () => {
    // Arrange
    const hls = startPlayer();
    const media = new StartMedia();
    const start = createWindowStart(hls, media, { enabled: true, base: BASE });
    start.beforeLoad(AUDIO_ONLY_URL);
    // Act: the first timeupdates (paused, then at its start) are not playback yet
    media.timeupdateWhilePaused();
    media.playedTo(0.04);
    media.playedTo(0.2);
    const before = [...media.seeks];
    media.playedTo(0.3);
    // Assert
    expect(before).toEqual([]);
    expect(media.seeks).toEqual([21.7]);
    expect([start.active, media.listening, hls.config.startPosition]).toEqual([false, 0, -1]);
  });

  it('does not move a playhead that is at live already, and does nothing while the element seeks', () => {
    // Arrange
    const hls = startPlayer();
    const media = new StartMedia();
    const start = createWindowStart(hls, media, { enabled: true, base: BASE });
    start.beforeLoad(AUDIO_ONLY_URL);
    hls.liveSyncPosition = 1;
    // Act
    media.playedTo(0);
    media.seeking = true;
    media.playedTo(0.5);
    media.seeking = false;
    media.playedTo(0.6);
    // Assert: the seek (not ours) was skipped; the playhead is within a second of live
    expect(media.seeks).toEqual([]);
    expect(start.active).toBe(false);
  });

  it('video, and every engine but Linux WebKit, start where hls.js picks (live); a new load drops a start still waiting', () => {
    // Arrange
    const hls = startPlayer();
    const media = new StartMedia();
    const elsewhere = createWindowStart(hls, media, { enabled: false, base: BASE });
    const linux = createWindowStart(hls, media, { enabled: true, base: BASE });
    // Act
    elsewhere.beforeLoad(AUDIO_ONLY_URL);
    const elsewhereStart = hls.config.startPosition;
    linux.beforeLoad(AUDIO_ONLY_URL);
    linux.beforeLoad('/hls/index.m3u8');
    media.playedTo(0);
    media.playedTo(1);
    // Assert
    expect([elsewhereStart, elsewhere.active]).toEqual([-1, false]);
    expect([hls.config.startPosition, linux.active, media.listening, media.seeks]).toEqual([-1, false, 0, []]);
  });

  it('tells Linux WebKit browsers from the rest by their user agent', () => {
    // Arrange
    const agents = {
      'GNOME Web': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 Epiphany/605.1.15',
      'Playwright WebKit, Linux': LINUX_WEBKIT,
      'Chrome, Linux': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome, Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Safari, macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Firefox, Linux': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    };
    // Act
    const picked = Object.entries(agents).filter(([, ua]) => usesGStreamer(ua)).map(([name]) => name);
    // Assert
    expect(picked).toEqual(['GNOME Web', 'Playwright WebKit, Linux']);
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
    const { menu, options, value } = mountMenu(hls, source);
    // Act
    hls.parsed([{ height: 1080 }], AUDIO_TRACK);
    const withAudio = { options: options(), hidden: menu.element.hidden, value: value() };
    hls.parsed([{ height: 1080 }]);
    // Assert
    expect(withAudio).toEqual({ options: ['1080p', 'Audio only (saves data)'], hidden: false, value: '-1' });
    expect(menu.element.hidden).toBe(true);
  });

  it('picking "Audio only" switches to it; the menu keeps the video qualities and shows "Audio only" picked', () => {
    // Arrange
    const { hls, source, load } = setup();
    const { menu, options, pick, value, checked } = mountMenu(hls, source);
    hls.parsed(VIDEO_LEVELS, AUDIO_TRACK);
    // Act
    pick(AUDIO_ONLY_OPTION);
    hls.parsed(AUDIO_LEVEL);
    // Assert
    expect(load).toHaveBeenCalledWith(AUDIO_ONLY_URL, 'audio only');
    expect(options()).toEqual(['Auto', '720p', '480p', '360p', 'Audio only (saves data)']);
    expect(value()).toBe(AUDIO_ONLY_OPTION);
    expect(checked()?.textContent).toBe('Audio only (saves data)');
    expect(menu.button.getAttribute('aria-label')).toBe('Video quality: Audio only (saves data)');
    expect(hls.loadLevel).toBe(-1);
  });

  it('picking a video quality while audio only plays goes back to video at that height', () => {
    // Arrange
    const { hls, source, load } = setup();
    const { pick, value } = mountMenu(hls, source);
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
    expect(value()).toBe('1');
  });

  it('picking "Auto" while audio only plays goes back to video on automatic quality', () => {
    // Arrange
    savePreferredHeight(360);
    const { hls, source } = setup();
    const { pick, value } = mountMenu(hls, source);
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
    expect(value()).toBe('-1');
  });

  it('started on audio only (nothing known about the video yet): "Auto" and "Audio only", shown before the playlists load', () => {
    // Arrange
    const { hls, source } = setup({ saved: true });
    // Act
    const { menu, options, value } = mountMenu(hls, source);
    // Assert
    expect(options()).toEqual(['Auto', 'Audio only (saves data)']);
    expect(menu.element.hidden).toBe(false);
    expect(value()).toBe(AUDIO_ONLY_OPTION);
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
