import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FragmentLoaderContext, HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderStats } from 'hls.js';
import { CoreActivity, fallbackReason, PeerStrikes, withHttpFallback, type FallbackState } from '../../src/p2p-fallback.js';

const base: FallbackState = { pendingMs: 0, secondsUntilNeeded: 20, attempt: undefined, urgentS: 6, graceMs: 750, maxPendingMs: 20_000 };

describe('fallbackReason', () => {
  it('leaves fragments that are far ahead to P2P', () => {
    expect(fallbackReason({ ...base, pendingMs: 10_000 })).toBeNull();
  });
  it('takes an urgent fragment the core is not fetching at all (idle) at once', () => {
    // After the stall watchdog's reload the idle core held each start-up fragment for the whole
    // grace: 2 x 750 ms of the 2.7 s back to playing, then 750 ms on every 1 s audio segment.
    expect(fallbackReason({ ...base, secondsUntilNeeded: 2, pendingMs: 0 })).toBe('urgent');
    expect(fallbackReason({ ...base, secondsUntilNeeded: 0, pendingMs: 250 })).toBe('urgent');
  });
  it('gives a peer that is sending an urgent fragment the grace period first', () => {
    const p2p = { source: 'p2p' as const, peerId: 'x', since: 0 };
    expect(fallbackReason({ ...base, secondsUntilNeeded: 2, pendingMs: 500, attempt: p2p })).toBeNull();
    expect(fallbackReason({ ...base, secondsUntilNeeded: 2, pendingMs: 800, attempt: p2p })).toBe('urgent');
  });
  it('a healthy, buffered viewer leaves what it fetches ahead to P2P, idle core or not (no extra HTTP load)', () => {
    // 20 s behind live with a full buffer, hls.js asks for fragments well past urgentS.
    for (const secondsUntilNeeded of [6, 10, 18]) {
      expect(fallbackReason({ ...base, secondsUntilNeeded, pendingMs: 5_000 })).toBeNull();
      expect(fallbackReason({ ...base, secondsUntilNeeded, pendingMs: 5_000, attempt: { source: 'p2p', peerId: 'x', since: 0 } })).toBeNull();
    }
  });
  it('treats a fragment the playhead already passed (slid out, after a seek) as urgent', () => {
    expect(fallbackReason({ ...base, secondsUntilNeeded: -15, pendingMs: 1000 })).toBe('urgent');
  });
  it('does not race the core when it is already fetching over HTTP', () => {
    expect(fallbackReason({ ...base, secondsUntilNeeded: 1, pendingMs: 5000, attempt: { source: 'http', since: 0 } })).toBeNull();
  });
  it('caps any core request, even without a media element', () => {
    expect(fallbackReason({ ...base, secondsUntilNeeded: null, pendingMs: 20_000 })).toBe('max-wait');
    expect(fallbackReason({ ...base, secondsUntilNeeded: null, pendingMs: 5_000 })).toBeNull();
  });
});

describe('CoreActivity', () => {
  it('tracks the current core attempt per segment URL from core events', () => {
    const listeners = new Map<string, (d: unknown) => void>();
    const a = new CoreActivity(() => 42);
    a.attach({ addEventListener: (name, l) => void listeners.set(name, l as (d: unknown) => void) });
    listeners.get('onSegmentStart')!({ segment: { url: 'u1' }, downloadSource: 'p2p', peerId: 'peer' });
    expect(a.get('u1')).toEqual({ source: 'p2p', peerId: 'peer', since: 42 });
    listeners.get('onSegmentAbort')!({ segment: { url: 'u1' } });
    expect(a.get('u1')).toBeUndefined();
  });
});

describe('PeerStrikes', () => {
  it('drops a peer after 2 strikes within a minute, not when they are far apart', () => {
    let t = 0;
    const s = new PeerStrikes(2, 60_000, () => t);
    expect(s.strike('a')).toBe(false);
    t = 70_000;
    expect(s.strike('a')).toBe(false);
    t = 80_000;
    expect(s.strike('a')).toBe(true);
  });
});

// --- the loader wrapper, with fake hls.js loaders -------------------------------------------

function newStats(): LoaderStats {
  return { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
}

/** Stands in for the P2P engine's fragment loader: hands the request to a "core" that never answers. */
class StuckP2PLoader implements Loader<FragmentLoaderContext> {
  static instances: StuckP2PLoader[] = [];
  stats = newStats();
  context: FragmentLoaderContext | null = null;
  callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
  aborted = false;
  constructor() {
    StuckP2PLoader.instances.push(this);
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

/** Stands in for hls.js' HTTP loader: answers right away. */
class FakeHttpLoader implements Loader<FragmentLoaderContext> {
  static loads = 0;
  stats = newStats();
  context: FragmentLoaderContext | null = null;
  load(context: FragmentLoaderContext, _c: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
    FakeHttpLoader.loads += 1;
    if (this.stats.loading.start) throw new Error('Loader can only be used once.');
    this.stats.loading.start = 1;
    this.context = context;
    queueMicrotask(() => callbacks.onSuccess({ url: context.url, data: new ArrayBuffer(100) }, this.stats, context, null));
  }
  abort(): void {}
  destroy(): void {}
}

function context(start: number): FragmentLoaderContext {
  return { url: 'https://x/hls/a_00001.m4s', frag: { sn: 1, start, type: 'audio' }, part: null, responseType: 'arraybuffer' } as unknown as FragmentLoaderContext;
}

/** A media element whose buffered ranges are `ranges`. */
const mediaAt = (currentTime: number, ...ranges: Array<[number, number]>): HTMLMediaElement =>
  ({ currentTime, buffered: { length: ranges.length, start: (i: number) => ranges[i]![0], end: (i: number) => ranges[i]![1] } }) as unknown as HTMLMediaElement;

describe('withHttpFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    StuckP2PLoader.instances = [];
    FakeHttpLoader.loads = 0;
  });
  afterEach(() => vi.useRealTimers());

  const config = { loader: FakeHttpLoader } as unknown as HlsConfig;
  const loaderConfig = {} as LoaderConfiguration;

  it('fetches a fragment the core sits on over HTTP once it is needed soon, exactly once', async () => {
    const media = mediaAt(0, [0, 30]);
    const onFallback = vi.fn();
    const Loader = withHttpFallback(StuckP2PLoader, { media: () => media, urgentS: () => 6, activity: new CoreActivity(), onFallback });
    const l = new Loader(config);
    const onSuccess = vi.fn();
    const onAbort = vi.fn();
    l.load(context(20), loaderConfig, { onSuccess, onError: vi.fn(), onTimeout: vi.fn(), onAbort });
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeHttpLoader.loads).toBe(0); // 20 s ahead: P2P may take its time
    media.currentTime = 15; // now 5 s ahead
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeHttpLoader.loads).toBe(1);
    expect(StuckP2PLoader.instances[0]!.aborted).toBe(true);
    expect(onAbort).not.toHaveBeenCalled(); // hls.js never hears about the core's abort
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'urgent', type: 'audio' }));
    // a late answer from the core is ignored
    StuckP2PLoader.instances[0]!.callbacks!.onSuccess({ url: 'x', data: new ArrayBuffer(1) }, newStats(), context(20), null);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('at start (nothing buffered) any fragment the core holds is needed now', async () => {
    const media = mediaAt(0);
    const Loader = withHttpFallback(StuckP2PLoader, { media: () => media, urgentS: () => 6, activity: new CoreActivity() });
    const onSuccess = vi.fn();
    new Loader(config).load(context(30), loaderConfig, { onSuccess, onError: vi.fn(), onTimeout: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeHttpLoader.loads).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('after a source reload (old buffers kept, playhead at 0 before the new start) the new fragments are needed now', async () => {
    // The stall watchdog's reload in barely-delivers: the playhead sat at 0, buffers of the old
    // timeline stayed, and the live fragment 27 s "ahead" was left to a P2P core that never
    // delivered it, until the watchdog moved the playhead again 8-10 s later.
    const media = mediaAt(0, [30, 32], [36, 38]);
    const Loader = withHttpFallback(StuckP2PLoader, { media: () => media, urgentS: () => 6, activity: new CoreActivity() });
    const onSuccess = vi.fn();
    new Loader(config).load(context(27), loaderConfig, { onSuccess, onError: vi.fn(), onTimeout: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeHttpLoader.loads).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not touch loads that already went to plain HTTP inside the P2P loader', async () => {
    class InnerHttp extends FakeHttpLoader {}
    const Loader = withHttpFallback(InnerHttp, { media: () => mediaAt(100, [90, 110]), urgentS: () => 6, activity: new CoreActivity() });
    const onSuccess = vi.fn();
    new Loader(config).load(context(0), loaderConfig, { onSuccess, onError: vi.fn(), onTimeout: vi.fn() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeHttpLoader.loads).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('passes a core success straight through', async () => {
    const Loader = withHttpFallback(StuckP2PLoader, { media: () => mediaAt(0, [0, 30]), urgentS: () => 6, activity: new CoreActivity() });
    const onSuccess = vi.fn();
    new Loader(config).load(context(2), loaderConfig, { onSuccess, onError: vi.fn(), onTimeout: vi.fn() });
    StuckP2PLoader.instances[0]!.callbacks!.onSuccess({ url: 'x', data: new ArrayBuffer(1) }, newStats(), context(2), null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(FakeHttpLoader.loads).toBe(0);
  });
});
