// The HTTP fallback of the P2P fragment loader (p2p-fallback.ts): P2P must never starve playback.
// Background for the cases below:
// - after the stall watchdog's reload the idle core held each start-up fragment for the whole
//   grace: 2 x 750 ms of the 2.7 s back to playing, then 750 ms on every 1 s audio segment, so an
//   urgent fragment the core is not fetching at all is taken at once;
// - 20 s behind live with a full buffer, hls.js asks for fragments well past urgentS: those stay
//   with P2P, idle core or not (no extra HTTP load);
// - the reload in barely-delivers left the playhead at 0 with the old timeline's buffers, and the
//   live fragment 27 s "ahead" waited on a P2P core that never delivered it, until the watchdog
//   moved the playhead again 8-10 s later: with nothing buffered at the playhead, every fragment is
//   needed now.
// The loader wrapper runs on Vitest's fake clock (its watchdog ticks), with fake hls.js loaders
// made fresh for each test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FragmentLoaderContext, HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderStats } from 'hls.js';
import { CoreActivity, fallbackReason, PeerStrikes, withHttpFallback, type FallbackState } from '../../src/p2p-fallback.js';

const base: FallbackState = { pendingMs: 0, secondsUntilNeeded: 20, attempt: undefined, urgentS: 6, graceMs: 750, maxPendingMs: 20_000 };
const fromPeer = { source: 'p2p' as const, peerId: 'x', since: 0 };
const loaderConfig = {} as LoaderConfiguration;

describe('fallbackReason', () => {
  it.each([
    ['leaves a fragment that is far ahead to P2P', { pendingMs: 10_000 }, null],
    ['takes an urgent fragment the core is not fetching at all (idle) at once', { secondsUntilNeeded: 2, pendingMs: 0 }, 'urgent'],
    ['takes a fragment needed right now that the core is not fetching', { secondsUntilNeeded: 0, pendingMs: 250 }, 'urgent'],
    ['gives a peer that is sending an urgent fragment the grace period first', { secondsUntilNeeded: 2, pendingMs: 500, attempt: fromPeer }, null],
    ['takes an urgent fragment from a peer once the grace period is over', { secondsUntilNeeded: 2, pendingMs: 800, attempt: fromPeer }, 'urgent'],
    ['treats a fragment the playhead already passed (slid out, after a seek) as urgent', { secondsUntilNeeded: -15, pendingMs: 1000 }, 'urgent'],
    ['does not race the core when it is already fetching over HTTP', { secondsUntilNeeded: 1, pendingMs: 5000, attempt: { source: 'http' as const, since: 0 } }, null],
    ['caps any core request, even without a media element', { secondsUntilNeeded: null, pendingMs: 20_000 }, 'max-wait'],
    ['without a media element, leaves a request under the cap alone', { secondsUntilNeeded: null, pendingMs: 5_000 }, null],
  ])('%s', (_case, state, reason) => {
    // Act
    const got = fallbackReason({ ...base, ...state });

    // Assert
    expect(got).toBe(reason);
  });

  it.each([6, 10, 18])('a healthy, buffered viewer leaves a fragment %s s ahead to P2P, idle core or not', (secondsUntilNeeded) => {
    // Act
    const reasons = [fallbackReason({ ...base, secondsUntilNeeded, pendingMs: 5_000 }), fallbackReason({ ...base, secondsUntilNeeded, pendingMs: 5_000, attempt: fromPeer })];

    // Assert
    expect(reasons).toEqual([null, null]);
  });
});

describe('CoreActivity', () => {
  /** A CoreActivity attached to a fake core whose events the test fires (`emit`), at time 42. */
  function activity() {
    const listeners = new Map<string, (d: unknown) => void>();
    const a = new CoreActivity(() => 42);
    a.attach({ addEventListener: (name, l) => void listeners.set(name, l as (d: unknown) => void) });
    return { a, emit: (name: string, d: unknown) => listeners.get(name)!(d) };
  }

  it('tracks the current core attempt per segment URL from core events', () => {
    // Arrange
    const { a, emit } = activity();

    // Act
    emit('onSegmentStart', { segment: { url: 'u1' }, downloadSource: 'p2p', peerId: 'peer' });

    // Assert
    expect(a.get('u1')).toEqual({ source: 'p2p', peerId: 'peer', since: 42 });
  });

  it('forgets the attempt when the core aborts it', () => {
    // Arrange
    const { a, emit } = activity();
    emit('onSegmentStart', { segment: { url: 'u1' }, downloadSource: 'p2p', peerId: 'peer' });

    // Act
    emit('onSegmentAbort', { segment: { url: 'u1' } });

    // Assert
    expect(a.get('u1')).toBeUndefined();
  });
});

describe('PeerStrikes', () => {
  it('drops a peer after 2 strikes within a minute, not when they are far apart', () => {
    // Arrange
    let t = 0;
    const s = new PeerStrikes(2, 60_000, () => t);

    // Act
    const verdicts = [s.strike('a')];
    t = 70_000;
    verdicts.push(s.strike('a'));
    t = 80_000;
    verdicts.push(s.strike('a'));

    // Assert
    expect(verdicts).toEqual([false, false, true]);
  });
});

// ---- the loader wrapper, with fake hls.js loaders -------------------------------------------

function newStats(): LoaderStats {
  return { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
}

/**
 * Fake hls.js loaders of one test: `StuckP2PLoader` stands in for the P2P engine's fragment loader
 * and hands the request to a "core" that never answers (`p2p` lists them); `FakeHttpLoader` stands
 * in for hls.js' HTTP loader and answers right away (`httpLoads()` counts them).
 */
function fakeLoaders() {
  const p2p: StuckP2PLoader[] = [];
  let httpLoads = 0;
  class StuckP2PLoader implements Loader<FragmentLoaderContext> {
    stats = newStats();
    context: FragmentLoaderContext | null = null;
    callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
    aborted = false;
    constructor() {
      p2p.push(this);
    }
    load(context: FragmentLoaderContext, _c: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
      this.context = context;
      this.callbacks = callbacks;
    }
    abort(): void {
      this.aborted = true;
      this.stats.aborted = true;
      this.callbacks?.onAbort?.(this.stats, this.context!, null);
    }
    destroy(): void {}
  }
  class FakeHttpLoader implements Loader<FragmentLoaderContext> {
    stats = newStats();
    context: FragmentLoaderContext | null = null;
    load(context: FragmentLoaderContext, _c: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
      httpLoads += 1;
      if (this.stats.loading.start) throw new Error('Loader can only be used once.');
      this.stats.loading.start = 1;
      this.context = context;
      queueMicrotask(() => callbacks.onSuccess({ url: context.url, data: new ArrayBuffer(100) }, this.stats, context, null));
    }
    abort(): void {}
    destroy(): void {}
  }
  return { StuckP2PLoader, FakeHttpLoader, p2p, httpLoads: () => httpLoads, config: { loader: FakeHttpLoader } as unknown as HlsConfig };
}

/** hls.js' context for the audio fragment that starts at `start` seconds. */
function context(start: number): FragmentLoaderContext {
  return { url: 'https://x/hls/a_00001.m4s', frag: { sn: 1, start, type: 'audio' }, part: null, responseType: 'arraybuffer' } as unknown as FragmentLoaderContext;
}

/** A media element whose buffered ranges are `ranges`. */
const mediaAt = (currentTime: number, ...ranges: Array<[number, number]>): HTMLMediaElement =>
  ({ currentTime, buffered: { length: ranges.length, start: (i: number) => ranges[i]![0], end: (i: number) => ranges[i]![1] } }) as unknown as HTMLMediaElement;

/** Callbacks of hls.js for one load, as spies. */
const hlsCallbacks = () => ({ onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn() });

describe('withHttpFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fragment 20 s ahead of the playhead (buffered up to 30 s), with the core sitting on it for 5 s. */
  async function farAheadAndStuck() {
    const fakes = fakeLoaders();
    const media = mediaAt(0, [0, 30]);
    const onFallback = vi.fn();
    const Loader = withHttpFallback(fakes.StuckP2PLoader, { media: () => media, urgentS: () => 6, activity: new CoreActivity(), onFallback });
    const callbacks = hlsCallbacks();
    new Loader(fakes.config).load(context(20), loaderConfig, callbacks);
    await vi.advanceTimersByTimeAsync(5000);
    return { ...fakes, media, onFallback, callbacks };
  }

  it('leaves a fragment that is far ahead to the core, however long it takes', async () => {
    // Act
    const { httpLoads, p2p } = await farAheadAndStuck();

    // Assert
    expect(httpLoads()).toBe(0);
    expect(p2p[0]!.aborted).toBe(false);
  });

  it('once the fragment is needed soon, fetches it over HTTP exactly once and drops the core request quietly', async () => {
    // Arrange
    const { media, httpLoads, p2p, onFallback, callbacks } = await farAheadAndStuck();

    // Act
    media.currentTime = 15;
    await vi.advanceTimersByTimeAsync(300);

    // Assert
    expect(httpLoads()).toBe(1);
    expect(p2p[0]!.aborted).toBe(true);
    expect(callbacks.onAbort).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'urgent', type: 'audio' }));
  });

  it('after the switch, a late answer from the core is ignored', async () => {
    // Arrange
    const { media, p2p, callbacks } = await farAheadAndStuck();
    media.currentTime = 15;
    await vi.advanceTimersByTimeAsync(300);

    // Act
    p2p[0]!.callbacks!.onSuccess({ url: 'x', data: new ArrayBuffer(1) }, newStats(), context(20), null);

    // Assert
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['at start (nothing buffered) any fragment the core holds', mediaAt(0), 30],
    ['after a source reload (old buffers kept, playhead at 0 before the new start) the new fragments', mediaAt(0, [30, 32], [36, 38]), 27],
  ])('%s are needed now', async (_case, media, start) => {
    // Arrange
    const fakes = fakeLoaders();
    const Loader = withHttpFallback(fakes.StuckP2PLoader, { media: () => media, urgentS: () => 6, activity: new CoreActivity() });
    const callbacks = hlsCallbacks();

    // Act
    new Loader(fakes.config).load(context(start), loaderConfig, callbacks);
    await vi.advanceTimersByTimeAsync(1000);

    // Assert
    expect(fakes.httpLoads()).toBe(1);
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not touch loads that already went to plain HTTP inside the P2P loader', async () => {
    // Arrange
    const fakes = fakeLoaders();
    const Loader = withHttpFallback(class InnerHttp extends fakes.FakeHttpLoader {}, { media: () => mediaAt(100, [90, 110]), urgentS: () => 6, activity: new CoreActivity() });
    const callbacks = hlsCallbacks();

    // Act
    new Loader(fakes.config).load(context(0), loaderConfig, callbacks);
    await vi.advanceTimersByTimeAsync(3000);

    // Assert
    expect(fakes.httpLoads()).toBe(1);
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('passes a core success straight through', async () => {
    // Arrange
    const fakes = fakeLoaders();
    const Loader = withHttpFallback(fakes.StuckP2PLoader, { media: () => mediaAt(0, [0, 30]), urgentS: () => 6, activity: new CoreActivity() });
    const callbacks = hlsCallbacks();
    new Loader(fakes.config).load(context(2), loaderConfig, callbacks);

    // Act
    fakes.p2p[0]!.callbacks!.onSuccess({ url: 'x', data: new ArrayBuffer(1) }, newStats(), context(2), null);
    await vi.advanceTimersByTimeAsync(3000);

    // Assert
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
    expect(fakes.httpLoads()).toBe(0);
  });
});
