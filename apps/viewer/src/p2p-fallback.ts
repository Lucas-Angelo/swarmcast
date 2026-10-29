/**
 * HTTP fallback for the P2P fragment loader: P2P must never be able to starve playback.
 *
 * p2p-media-loader hands every fragment hls.js asks for to its core, which may wait for a peer,
 * download it slowly from one, or (in some states) never start it at all: a request for a
 * segment that already slid out of the playlist, or that sits behind the playhead after a seek,
 * stays pending forever. hls.js' own timeouts do not apply to that custom loader, so one stuck
 * request blocks the whole audio or video track.
 *
 * This wrapper watches every fragment the core is handling. As soon as the fragment is needed
 * soon (it starts less than `urgentS()` seconds after the playhead, or the playhead is already
 * past it) and the core is not already fetching it over HTTP, the core request is dropped and
 * the fragment is loaded with hls.js' normal HTTP loader (with its timeouts and retries).
 */
import type { FragmentLoaderContext, HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from 'hls.js';
import type { CoreEventMap } from 'p2p-media-loader-core';

export type CoreSource = 'http' | 'p2p';

export interface CoreAttempt {
  source: CoreSource;
  peerId?: string;
  since: number;
}

/**
 * What the core is doing per segment URL right now, from its public events
 * (onSegmentStart / Loaded / Error / Abort).
 */
export class CoreActivity {
  private readonly attempts = new Map<string, CoreAttempt>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  get(url: string): CoreAttempt | undefined {
    return this.attempts.get(url);
  }

  start(url: string, source: CoreSource, peerId?: string): void {
    this.attempts.set(url, { source, ...(peerId ? { peerId } : {}), since: this.now() });
  }

  end(url: string): void {
    this.attempts.delete(url);
  }

  /** Subscribe to a p2p-media-loader engine/core. */
  attach(target: { addEventListener<K extends keyof CoreEventMap>(name: K, listener: CoreEventMap[K]): void }): void {
    target.addEventListener('onSegmentStart', (d) => this.start(d.segment.url, d.downloadSource, d.peerId));
    target.addEventListener('onSegmentLoaded', (d) => this.end(d.segment.url));
    target.addEventListener('onSegmentError', (d) => this.end(d.segment.url));
    target.addEventListener('onSegmentAbort', (d) => this.end(d.segment.url));
  }
}

export interface FallbackState {
  /** ms since hls.js asked the core for the fragment. */
  pendingMs: number;
  /** Fragment start minus the playhead, in seconds (negative = the playhead is already past it). */
  secondsUntilNeeded: number | null;
  /** What the core is doing for this fragment, if anything. */
  attempt: CoreAttempt | undefined;
  urgentS: number;
  graceMs: number;
  maxPendingMs: number;
}

export type FallbackReason = 'urgent' | 'max-wait';

/** The playhead is inside a buffered range (with half a second of tolerance before it). */
export function playheadBuffered(media: Pick<HTMLMediaElement, 'buffered' | 'currentTime'>): boolean {
  const b = media.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= media.currentTime + 0.5 && media.currentTime < b.end(i)) return true;
  return false;
}

/**
 * Should the core request be dropped and the fragment fetched over HTTP right now?
 * - needed soon (or already late) and the core is not fetching it at all: yes, at once;
 * - needed soon and a peer is sending it: after `graceMs` (the peer may still make it);
 * - pending longer than `maxPendingMs` no matter what (a core HTTP fetch included): yes.
 */
export function fallbackReason(s: FallbackState): FallbackReason | null {
  if (s.pendingMs >= s.maxPendingMs) return 'max-wait';
  if (s.secondsUntilNeeded === null) return null;
  if (s.secondsUntilNeeded >= s.urgentS) return null;
  if (s.attempt?.source === 'http') return null;
  // The core is not fetching it at all: waiting for it helps nobody.
  if (!s.attempt) return 'urgent';
  return s.pendingMs >= s.graceMs ? 'urgent' : null;
}

export interface FallbackPolicy {
  media(): HTMLMediaElement | null;
  /** Seconds before it is needed under which a fragment must come over HTTP. */
  urgentS(): number;
  activity: CoreActivity;
  /** How long the core may still try once a fragment is urgent (default 750 ms). */
  graceMs?: number;
  /** Hard cap for any core request (default 20 s). */
  maxPendingMs?: number;
  /** Watchdog period (default 250 ms). */
  tickMs?: number;
  onFallback?(info: { url: string; type: string; reason: FallbackReason; waitedMs: number; attempt: CoreAttempt | undefined }): void;
  onFallbackLoaded?(bytes: number): void;
}

type LoaderCtor = new (config: HlsConfig) => Loader<FragmentLoaderContext>;

/** Wrap the P2P engine's fLoader class (engine.getConfigForHlsJs().fLoader). */
export function withHttpFallback(P2PLoader: LoaderCtor, policy: FallbackPolicy): LoaderCtor {
  const graceMs = policy.graceMs ?? 750;
  const maxPendingMs = policy.maxPendingMs ?? 20_000;
  const tickMs = policy.tickMs ?? 250;

  return class HttpFallbackFragmentLoader implements Loader<FragmentLoaderContext> {
    context: FragmentLoaderContext | null = null;
    private readonly hlsConfig: HlsConfig;
    private readonly inner: Loader<FragmentLoaderContext>;
    private http: Loader<LoaderContext> | null = null;
    private timer: ReturnType<typeof setInterval> | undefined;
    private switched = false;
    private done = false;

    constructor(config: HlsConfig) {
      this.hlsConfig = config;
      this.inner = new P2PLoader(config);
    }

    get stats(): LoaderStats {
      return this.inner.stats;
    }

    set stats(value: LoaderStats) {
      this.inner.stats = value;
    }

    load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
      this.context = context;
      const finish = <A extends unknown[]>(fn: ((...a: A) => void) | undefined) =>
        (...args: A): void => {
          if (this.switched || this.done) return;
          this.done = true;
          this.stopWatch();
          fn?.(...args);
        };
      const wrapped: LoaderCallbacks<FragmentLoaderContext> = {
        onSuccess: finish(callbacks.onSuccess),
        onError: finish(callbacks.onError),
        onTimeout: finish(callbacks.onTimeout),
        ...(callbacks.onAbort ? { onAbort: finish(callbacks.onAbort) } : {}),
        ...(callbacks.onProgress
          ? {
              onProgress: (...args: Parameters<NonNullable<typeof callbacks.onProgress>>) => {
                if (!this.switched) callbacks.onProgress?.(...args);
              },
            }
          : {}),
      };
      const startedAt = performance.now();
      this.inner.load(context, config, wrapped);
      // The inner loader already went to plain HTTP (P2P off, init segment, unknown segment):
      // hls.js' loader sets loading.start synchronously, the core path leaves it at 0.
      if (this.done || this.stats.loading.start > 0) return;
      const frag = context.frag;
      if (typeof frag.sn !== 'number') return;
      this.timer = setInterval(() => {
        if (this.done || this.switched) return this.stopWatch();
        const media = policy.media();
        // Nothing buffered at the playhead (start, after a seek or a reload, a stall): whatever
        // hls.js asks for is needed now. After a source reload the old buffers stay and the
        // playhead sits at 0 until the new start position has data, so "how far ahead" read the
        // new live fragments as 27 s away and left them to the P2P core.
        const secondsUntilNeeded = !media ? null : !playheadBuffered(media) ? 0 : frag.start - media.currentTime;
        const attempt = policy.activity.get(context.url);
        const waitedMs = performance.now() - startedAt;
        const reason = fallbackReason({ pendingMs: waitedMs, secondsUntilNeeded, attempt, urgentS: policy.urgentS(), graceMs, maxPendingMs });
        if (!reason) return;
        policy.onFallback?.({ url: context.url, type: frag.type, reason, waitedMs, attempt });
        this.switchToHttp(context, config, callbacks);
      }, tickMs);
    }

    private switchToHttp(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
      this.stopWatch();
      this.switched = true;
      // Releases the core's engine request; its callbacks are muted by `switched`.
      this.inner.abort();
      const stats = this.stats;
      stats.aborted = false;
      stats.loaded = 0;
      stats.total = 0;
      stats.chunkCount = 0;
      stats.loading = { start: 0, first: 0, end: 0 };
      const http = new this.hlsConfig.loader(this.hlsConfig);
      http.stats = stats;
      this.http = http;
      http.load(context, config, {
        ...callbacks,
        onSuccess: (response, s, ctx, details) => {
          const data = response.data;
          if (data instanceof ArrayBuffer) policy.onFallbackLoaded?.(data.byteLength);
          callbacks.onSuccess(response, s, ctx as FragmentLoaderContext, details);
        },
      } as LoaderCallbacks<LoaderContext>);
    }

    private stopWatch(): void {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
    }

    abort(): void {
      this.stopWatch();
      if (this.http) this.http.abort();
      else this.inner.abort();
    }

    destroy(): void {
      this.stopWatch();
      this.done = true;
      if (this.http) this.http.destroy();
      else this.inner.destroy();
      this.http = null;
    }
  };
}

/**
 * Counts failures per peer (a fragment we had to take back from it, a bytes-receiving timeout).
 * `strike` returns true when the peer reached `limit` strikes inside `windowMs`: drop it.
 */
export class PeerStrikes {
  private readonly strikes = new Map<string, number[]>();

  constructor(
    private readonly limit = 2,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  strike(peerId: string): boolean {
    const t = this.now();
    const recent = (this.strikes.get(peerId) ?? []).filter((at) => t - at < this.windowMs);
    recent.push(t);
    if (recent.length >= this.limit) {
      this.strikes.delete(peerId);
      return true;
    }
    this.strikes.set(peerId, recent);
    return false;
  }
}
