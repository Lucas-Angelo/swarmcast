// @vitest-environment happy-dom
// "Stats for nerds" (stats-overlay.ts, stats-toggle.ts): the lines from a fake hls.js, <video>,
// counters and adaptive delay; "—" where the browser's own HLS player has no such number; never
// a peer ID, an address or the host; refreshed once a second only while open; Esc and × close it
// (not an Esc meant for the chat); and the chunk is loaded only when the viewer opens it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bufferAhead, collectStats, mountStatsPanel, p2pShare, statsText, type StatsHls, type StatsRow, type StatsSource, type StatsVideo } from '../../src/stats-overlay.js';
import { createStatsToggle, type MountStatsPanel } from '../../src/stats-toggle.js';

/** A TimeRanges. */
const ranges = (...r: Array<[number, number]>): StatsVideo['buffered'] => ({ length: r.length, start: (i) => r[i]![0], end: (i) => r[i]![1] });

function fakeVideo(over: Partial<StatsVideo> = {}): StatsVideo & { dropped: number } {
  const v = {
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 100,
    playbackRate: 1.03,
    buffered: ranges([90, 112.4]),
    dropped: 3,
    getVideoPlaybackQuality(): { droppedVideoFrames: number; totalVideoFrames: number } {
      return { droppedVideoFrames: v.dropped, totalVideoFrames: 4512 };
    },
    ...over,
  };
  return v;
}

function fakeHls(over: Partial<StatsHls> = {}): StatsHls {
  return {
    levels: [
      { height: 360, bitrate: 800_000, frameRate: 30 },
      { height: 720, bitrate: 3_000_000, frameRate: 29.97 },
    ],
    currentLevel: 1,
    autoLevelEnabled: true,
    bandwidthEstimate: 8_400_000,
    latency: 15.2,
    ...over,
  };
}

const PEER_ID = 'peer-7f3a9c2b1d';

function source(over: Partial<StatsSource> = {}): StatsSource {
  return {
    video: fakeVideo(),
    hls: () => fakeHls(),
    counters: () => ({ httpBytes: 15_000_000, p2pDownBytes: 12_300_000, p2pUpBytes: 4_500_000, peers: 2, p2pEnabled: true }),
    delay: () => ({ delay: 14.24, target: 14 }),
    profile: () => 'stable',
    engine: () => 'mse',
    connection: () => ({ effectiveType: '4g', downlink: 10 }),
    ...over,
  };
}

const byId = (rows: StatsRow[]): Record<string, string> => Object.fromEntries(rows.map((r) => [r.id, r.value]));

describe('collectStats', () => {
  it('every line from hls.js, the video, the counters and the adaptive delay', () => {
    // Act
    const rows = collectStats(source());
    // Assert
    expect(rows.map((r) => r.id)).toEqual(['resolution', 'quality', 'bandwidth', 'buffer', 'delay', 'playback', 'frames', 'p2p', 'fromPeers', 'shared', 'fromServer', 'connection', 'engine']);
    expect(byId(rows)).toEqual({
      resolution: '1280×720 at 30 fps',
      quality: '720p · 3 Mb/s · Auto',
      bandwidth: '8.4 Mb/s',
      buffer: '12.4 s',
      delay: '14.2 s (aiming for 14 s)',
      playback: 'Stable · 1.03× speed',
      frames: '3 of 4512',
      p2p: 'On · 2 peers',
      fromPeers: '12.3 MB (45% of the video)',
      shared: '4.5 MB',
      fromServer: '15 MB',
      connection: '4g · ~10 Mb/s',
      engine: 'hls.js · MediaSource',
    });
    expect(rows.find((r) => r.id === 'frames')?.label).toBe('Dropped frames');
  });

  it('a quality the viewer picked, Lower delay, P2P off, ManagedMediaSource', () => {
    // Act
    const rows = byId(
      collectStats(
        source({
          hls: () => fakeHls({ autoLevelEnabled: false, currentLevel: 0 }),
          profile: () => 'low-delay',
          counters: () => ({ httpBytes: 2_000_000, p2pDownBytes: 0, p2pUpBytes: 0, peers: 0, p2pEnabled: false }),
          engine: () => 'mms',
          connection: () => undefined,
        }),
      ),
    );
    // Assert
    expect(rows.quality).toBe('360p · 0.8 Mb/s · chosen by you');
    expect(rows.playback).toBe('Lower delay · 1.03× speed');
    expect(rows.p2p).toBe('Off');
    expect(rows.fromPeers).toBe('0 MB (0% of the video)');
    expect(rows.connection).toBe('—');
    expect(rows.engine).toBe('hls.js · ManagedMediaSource');
  });

  it("the browser's own HLS player (old iPhone): dashes where hls.js would answer, the rest still there", () => {
    // Act
    const rows = byId(
      collectStats(
        source({
          video: fakeVideo({ getVideoPlaybackQuality: undefined as unknown as StatsVideo['getVideoPlaybackQuality'] }),
          hls: () => null,
          delay: () => null,
          engine: () => 'native',
          connection: () => ({ type: 'wifi' }),
        }),
      ),
    );
    // Assert
    expect(rows.resolution).toBe('1280×720');
    expect(rows.quality).toBe('—');
    expect(rows.bandwidth).toBe('—');
    expect(rows.delay).toBe('—');
    expect(rows.frames).toBe('—');
    expect(rows.buffer).toBe('12.4 s');
    expect(rows.connection).toBe('wifi');
    expect(rows.engine).toBe("The browser's own player (no P2P)");
  });

  it('before the first picture: no size, no level, the delay from hls.js when the adaptive delay has none yet', () => {
    // Act
    const rows = byId(collectStats(source({ video: fakeVideo({ videoWidth: 0, videoHeight: 0, buffered: ranges() }), hls: () => fakeHls({ currentLevel: -1 }), delay: () => ({ delay: null, target: 0 }) })));
    // Assert
    expect(rows.resolution).toBe('—');
    expect(rows.quality).toBe('—');
    expect(rows.buffer).toBe('0 s');
    expect(rows.delay).toBe('15.2 s');
  });

  it('never shows a peer ID, an address, the host or the session', () => {
    // Arrange: whatever the page knows, only counts reach the panel
    const text = statsText(collectStats(source()));
    // Assert
    expect(text).not.toContain(PEER_ID);
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(text).not.toMatch(/https?:|trycloudflare|localhost|sessionId/i);
    expect(text.split('\n')).toHaveLength(13);
    expect(text.split('\n')[0]).toBe('Resolution: 1280×720 at 30 fps');
  });

  it('P2P share and buffer arithmetic', () => {
    // Act / Assert
    expect(p2pShare({ httpBytes: 0, p2pDownBytes: 0 })).toBe(0);
    expect(p2pShare({ httpBytes: 1, p2pDownBytes: 3 })).toBe(75);
    expect(p2pShare({ httpBytes: 0, p2pDownBytes: 10 })).toBe(100);
    expect(bufferAhead({ currentTime: 50, buffered: ranges([0, 10], [45, 58.5]) })).toBe(8.5);
    expect(bufferAhead({ currentTime: 20, buffered: ranges([0, 10], [45, 58.5]) })).toBe(0);
    // A playhead a hair before its range (just seeked to it) still counts that range.
    expect(bufferAhead({ currentTime: 44.95, buffered: ranges([45, 50]) })).toBeCloseTo(5.05);
  });
});

describe('the panel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    document.body.innerHTML = '<div class="player"><div id="stats" hidden></div></div><aside id="chat"><textarea id="box"></textarea></aside><button id="open" type="button">Stats for nerds</button>';
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const host = (): HTMLElement => document.getElementById('stats')!;
  const value = (id: string): string | null | undefined => host().querySelector(`[data-stat="${id}"] dd`)?.textContent;

  it('a labelled region with a heading and one term per line; the focus moves to its close button', () => {
    // Act
    const onClose = vi.fn();
    mountStatsPanel({ host: host(), source: source(), onClose });
    // Assert
    expect(host().getAttribute('role')).toBe('region');
    expect(document.getElementById(host().getAttribute('aria-labelledby')!)?.textContent).toBe('Stats for nerds');
    expect(host().querySelectorAll('dl > div')).toHaveLength(13);
    expect(value('resolution')).toBe('1280×720 at 30 fps');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close stats for nerds');
  });

  it('refreshes once a second, and stops when destroyed', () => {
    // Arrange
    const video = fakeVideo();
    const panel = mountStatsPanel({ host: host(), source: source({ video }), onClose: () => {} });
    // Act
    video.dropped = 9;
    vi.advanceTimersByTime(999);
    // Assert
    expect(value('frames')).toBe('3 of 4512');
    // Act
    vi.advanceTimersByTime(1);
    // Assert
    expect(value('frames')).toBe('9 of 4512');
    // Act
    panel.destroy();
    // Assert
    expect(host().childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Esc and × close it; an Esc in the chat box is the chat\'s', () => {
    // Arrange
    const onClose = vi.fn();
    mountStatsPanel({ host: host(), source: source(), onClose });
    // Act
    document.getElementById('box')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Assert
    expect(onClose).not.toHaveBeenCalled();
    // Act
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    host().querySelector<HTMLButtonElement>('[data-testid="stats-close"]')!.click();
    // Assert
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Copy puts the same lines on the clipboard and says so', async () => {
    // Arrange
    const writeText = vi.fn(async (_t: string) => {});
    mountStatsPanel({ host: host(), source: source(), onClose: () => {}, clipboard: { writeText } });
    // Act
    host().querySelector<HTMLButtonElement>('[data-testid="stats-copy"]')!.click();
    await vi.waitFor(() => expect(host().querySelector('[role="status"]')?.textContent).toBe('Copied'));
    // Assert
    expect(writeText).toHaveBeenCalledWith(statsText(collectStats(source())));
    // Act
    vi.advanceTimersByTime(3000);
    // Assert
    expect(host().querySelector('[role="status"]')?.textContent).toBe('');
  });
});

describe('the "Stats for nerds" link', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="stats" hidden></div><button id="open" type="button">Stats for nerds</button>';
  });
  const els = () => ({ button: document.getElementById('open') as HTMLButtonElement, host: document.getElementById('stats')! });

  /** The chunk: `gate` holds its load (default: loads at once); `mounted` are the panels it made. */
  function setup(gate: Promise<void> = Promise.resolve()) {
    const destroy = vi.fn();
    const mounted: Array<Parameters<MountStatsPanel>[0]> = [];
    const mount: MountStatsPanel = (d) => {
      mounted.push(d);
      return { destroy };
    };
    const loader = vi.fn(() => gate.then(() => mount));
    return { ...els(), toggle: createStatsToggle({ ...els(), source: source(), load: loader }), loader, destroy, mounted };
  }

  it('loads nothing until opened; opening loads the chunk and shows the panel', async () => {
    // Arrange
    const { button, host, toggle, loader, mounted, destroy } = setup();
    // Assert
    expect(loader).not.toHaveBeenCalled();
    expect(host.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Act
    button.click();
    await vi.waitFor(() => expect(mounted).toHaveLength(1));
    // Assert
    expect(loader).toHaveBeenCalledTimes(1);
    expect(toggle.open).toBe(true);
    expect(host.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // Act: closed by the link
    button.click();
    // Assert
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(host.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closed with Esc or × (the panel calls onClose): the focus goes back to the link', async () => {
    // Arrange
    const { button, host, toggle, mounted } = setup();
    toggle.toggle();
    await vi.waitFor(() => expect(mounted).toHaveLength(1));
    // Act
    mounted[0]!.onClose();
    // Assert
    expect(toggle.open).toBe(false);
    expect(host.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('closed again while the chunk still loads: it never shows', async () => {
    // Arrange
    let release!: () => void;
    const { host, toggle, mounted, loader } = setup(new Promise<void>((resolve) => (release = resolve)));
    // Act
    toggle.toggle();
    toggle.toggle();
    release();
    await vi.waitFor(() => expect(loader.mock.results[0]?.value).toBeDefined());
    await loader.mock.results[0]!.value;
    // Assert
    expect(mounted).toHaveLength(0);
    expect(host.hidden).toBe(true);
    expect(toggle.open).toBe(false);
  });

  it('a chunk that fails to load leaves the page as it was', async () => {
    // Arrange
    const debug = vi.fn();
    const { button, host } = els();
    const toggle = createStatsToggle({ button, host, source: source(), load: () => Promise.reject(new Error('offline')), debug });
    // Act
    button.click();
    await vi.waitFor(() => expect(debug).toHaveBeenCalled());
    // Assert
    expect(toggle.open).toBe(false);
    expect(host.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
