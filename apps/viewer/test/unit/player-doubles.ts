// Test doubles for the player around the adaptive delay (apps/viewer/src/adaptive-delay.ts): the
// parts of <video> it reads and drives, an attached delay already playing, and a live stream
// (playlist reloads, buffering, playback) for what the delay measures over time.
import { vi } from 'vitest';
import type Hls from 'hls.js';
import { attachAdaptiveDelay } from '../../src/adaptive-delay.js';

/** The parts of <video> the adaptive delay reads and drives. Buffered: one range, set with bufferAhead(). */
export class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  currentTime = 0;
  playbackRate = 1;
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 };
  readonly play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });

  /** Media buffered from the start of the stream to `seconds` past the playhead. */
  bufferAhead(seconds: number): void {
    const end = this.currentTime + seconds;
    this.buffered = { length: 1, start: () => 0, end: () => end };
  }

  /** One minute of media buffered, up to `end` (media time; a live stream's can be negative on the fake clock). */
  bufferTo(end: number): void {
    this.buffered = { length: 1, start: () => end - 60, end: () => end };
  }
}

/** The adaptive delay (Stable profile) on a FakeVideo that is playing, `latency` s behind live. */
export function playingAdaptiveDelay(latency: number): { video: FakeVideo; delay: ReturnType<typeof attachAdaptiveDelay> } {
  const hls = { on: () => {}, latency, bandwidthEstimate: 0, levels: [], currentLevel: -1, config: { liveSyncDuration: 20 }, targetLatency: 20 };
  const video = new FakeVideo();
  const delay = attachAdaptiveDelay(hls as unknown as Parameters<typeof attachAdaptiveDelay>[0], null, video as unknown as HTMLVideoElement, {
    profile: 'stable',
    events: { FRAG_LOADED: 'hlsFragLoaded' } as unknown as typeof Hls.Events,
    p2pEnabled: () => false,
  });
  void video.play();
  video.dispatchEvent(new Event('playing'));
  return { video, delay };
}

/** Segment length of the fake live stream, s (the server's HLS segments). */
export const LIVE_SEGMENT_S = 2;
/** Segments in the playlist (and buffered) when the player starts. */
const START_SEGMENTS = 10;
/** Model step: playback, playlist reloads and buffering move every 50 ms of fake time. */
const STEP_MS = 50;

/** When the server lists each segment of a fake live stream, and how the player joins it. */
export interface LiveStreamScript {
  /**
   * Second (from the start of the stream double) at which segment k, media [2k, 2k + 2), is
   * listed in the server's playlist; at the earliest when its media is over, 2k + 2.
   */
  publishedAt(k: number): number;
  /** Seconds behind the end of the playlist the player starts at. */
  startDelayS: number;
  /** Test-only clock and rate flags (`?delaySpeed=`, `?delayRate=`). */
  speed?: number;
  rateScale?: number;
}

/** What the adaptive delay showed at the end of each second (its debug snapshot). */
export interface DelaySnapshot {
  s: number;
  delay: number | null;
  state: string;
  playbackRate: number;
  signals: { lagSlope: number | null } | null;
}

/**
 * A live HLS stream on a fast, steady link, played by attachAdaptiveDelay on Vitest's fake clock
 * (call vi.useFakeTimers() first). hls.js is modelled where the adaptive delay reads it: the
 * player reloads the playlist every segment duration, 0, 2, 4… s after it started; a reload
 * lists every segment published by then, and when the playlist grew the "age" of its live edge
 * restarts at the reload (hls.js base-playlist-controller: advancedDateTime is the load time,
 * not the segment's), so hls.latency = edge + age − currentTime, as in hls.js, is off by the
 * time the newest segment waited for that reload. New segments are buffered at once (10 ms
 * loads: 30 Mbps for a 1.3 Mbps rendition). The video plays at its playbackRate.
 */
export class FakeLiveStream {
  readonly video = new FakeVideo();
  readonly delay: ReturnType<typeof attachAdaptiveDelay>;
  private readonly startedAt = performance.now() / 1000;
  private readonly fragLoaded: Array<(event: string, data: unknown) => void> = [];
  private edgeIndex: number;
  private advancedAt = 0;
  private nextReload = LIVE_SEGMENT_S;

  constructor(private readonly script: LiveStreamScript) {
    const video = this.video;
    const edge = (): number => this.edge;
    const age = (): number => this.now() - this.advancedAt;
    const details = {
      live: true,
      get edge() {
        return edge();
      },
      get age() {
        return age();
      },
    };
    const hls = {
      on: (event: string, handler: (event: string, data: unknown) => void) => {
        if (event === 'hlsFragLoaded') this.fragLoaded.push(handler);
      },
      get latency() {
        return details.edge + details.age - video.currentTime;
      },
      bandwidthEstimate: 30_000_000,
      levels: [{ bitrate: 1_300_000 }],
      currentLevel: 0,
      config: { liveSyncDuration: script.startDelayS },
      latestLevelDetails: details,
      set targetLatency(v: number) {
        hls.config.liveSyncDuration = v;
      },
    };
    this.delay = attachAdaptiveDelay(hls as unknown as Parameters<typeof attachAdaptiveDelay>[0], null, video as unknown as HTMLVideoElement, {
      profile: 'stable',
      events: { FRAG_LOADED: 'hlsFragLoaded' } as unknown as typeof Hls.Events,
      p2pEnabled: () => false,
      speed: script.speed,
      rateScale: script.rateScale,
    });
    this.edgeIndex = this.lastPublished(0) - START_SEGMENTS;
    this.reload();
    video.currentTime = this.edge - script.startDelayS;
    video.bufferTo(this.edge);
    void video.play();
    video.dispatchEvent(new Event('playing'));
  }

  /** Plays `seconds` of fake time; returns the adaptive delay's snapshot at the end of each second. */
  play(seconds: number): DelaySnapshot[] {
    const out: DelaySnapshot[] = [];
    const steps = (seconds * 1000) / STEP_MS;
    for (let i = 1; i <= steps; i++) {
      const v = this.video;
      if (!v.paused) v.currentTime = Math.min(this.edge, v.currentTime + (v.playbackRate * STEP_MS) / 1000);
      vi.advanceTimersByTime(STEP_MS);
      if (this.now() >= this.nextReload - 1e-9) {
        this.reload();
        this.nextReload += LIVE_SEGMENT_S;
      }
      v.bufferTo(this.edge);
      if (i % (1000 / STEP_MS) === 0) out.push({ s: Math.round(this.now()), ...(this.delay.snapshot() as unknown as Omit<DelaySnapshot, 's'>) });
    }
    return out;
  }

  /** End of the newest segment in the player's playlist (and buffer), media time. */
  private get edge(): number {
    return (this.edgeIndex + 1) * LIVE_SEGMENT_S;
  }

  private now(): number {
    return performance.now() / 1000 - this.startedAt;
  }

  private lastPublished(at: number): number {
    let k = Math.floor(at / LIVE_SEGMENT_S);
    while (this.script.publishedAt(k + 1) <= at) k++;
    while (this.script.publishedAt(k) > at) k--;
    return k;
  }

  /** The player reloads the playlist and buffers what is new (hls.js FRAG_LOADED for each segment). */
  private reload(): void {
    const now = this.now();
    const last = this.lastPublished(now);
    if (last <= this.edgeIndex) return;
    const ms = performance.now();
    for (let k = this.edgeIndex + 1; k <= last; k++) {
      const frag = { type: 'main', duration: LIVE_SEGMENT_S, url: `seg${k}.mp4`, stats: { loading: { start: ms - 10, end: ms }, loaded: 325_000 } };
      for (const h of this.fragLoaded) h('hlsFragLoaded', { frag });
    }
    this.edgeIndex = last;
    this.advancedAt = now;
  }
}
