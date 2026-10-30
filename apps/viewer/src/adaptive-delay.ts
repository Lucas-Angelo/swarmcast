/**
 * Wires the adaptive delay controller (latency-controller.ts, pure) to hls.js, p2p-media-loader
 * and the <video> element: collects segment loads, bandwidth, stalls and buffer level, and applies
 * the decisions (hls.targetLatency, playbackRate, a short hold inside a stall).
 *
 * watch.ts only calls attachAdaptiveDelay() once, passes `setProfile` to the latency toggle,
 * feeds `setCeiling` from its playlist-window fit, reads `delay` for the status line and checks
 * `holding` before showing "Paused" (the stall watchdog ignores the hold too).
 * This module owns hls.config.liveSyncDuration (through hls.targetLatency).
 */
import type Hls from 'hls.js';
import type { CoreEventMap } from 'p2p-media-loader-core';
import { DelayController, type DelayProfileId, type FragmentSample } from './latency-controller.js';

type HlsLike = Pick<Hls, 'on' | 'latency' | 'bandwidthEstimate' | 'levels' | 'currentLevel' | 'config'> & { targetLatency: number | null };
interface EngineLike {
  addEventListener<K extends keyof CoreEventMap>(eventName: K, listener: CoreEventMap[K]): void;
}

export interface AdaptiveDelay {
  /** Seconds behind live right now (rounded by the caller), null before playback. */
  readonly delay: number | null;
  readonly target: number;
  /** Playback is paused by us inside a stall (show "Buffering", not "Paused"). */
  readonly holding: boolean;
  setProfile(id: DelayProfileId): void;
  /** Hard upper limit from a playlist mismatch (player-config.ts latencyFor), null = none. */
  setCeiling(seconds: number | null): void;
  /** How far back the shortest live playlist reaches: no delay is built past it. */
  setGrowthLimit(seconds: number | null): void;
  /** Debug and test view (window.__swarmcast.delay). */
  snapshot(): Record<string, unknown>;
}

/** Test-only fast clock for the controller: `?delaySpeed=10` on the watch page (1–60). */
export function delaySpeedFromSearch(search: string): number {
  const n = Number(new URLSearchParams(search).get('delaySpeed'));
  return Number.isFinite(n) && n >= 1 ? Math.min(60, n) : 1;
}

/**
 * Test-only: `?delayRate=10` moves playbackRate 10× further from 1 (at most ±0.5, see
 * scaledTuning), so with the fast clock the delay itself changes 10× faster too (1–10).
 */
export function delayRateFromSearch(search: string): number {
  const n = Number(new URLSearchParams(search).get('delayRate'));
  return Number.isFinite(n) && n >= 1 ? Math.min(10, n) : 1;
}

/**
 * The test-only clock and rate flags of the watch page, honoured only when the server allows
 * them (`ViewerConfig.testHooks`, set by the E2E harness): for real viewers both stay 1, so a
 * link with `?delaySpeed=` or `?delayRate=` changes nothing.
 */
export function delayTestFlags(search: string, allowed: boolean): { speed: number; rateScale: number } {
  if (!allowed) return { speed: 1, rateScale: 1 };
  return { speed: delaySpeedFromSearch(search), rateScale: delayRateFromSearch(search) };
}

/** One-second latency samples whose median is the delay everyone uses. */
const LATENCY_SAMPLES = 5;

function forwardBuffer(video: HTMLVideoElement): number {
  const b = video.buffered;
  const t = video.currentTime;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t + 0.5 && t < b.end(i)) return b.end(i) - t;
  }
  return 0;
}

export function attachAdaptiveDelay(
  hls: HlsLike,
  engine: EngineLike | null,
  video: HTMLVideoElement,
  o: { profile: DelayProfileId; events: typeof Hls.Events; p2pEnabled: () => boolean; speed?: number; rateScale?: number },
): AdaptiveDelay {
  const clock = (): number => performance.now() / 1000;
  const ctl = new DelayController({ profile: o.profile, speed: o.speed ?? 1, rateScale: o.rateScale ?? 1, now: clock() });
  let started = false;
  let holding = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let stallAt: number | null = null;
  let lastSeekAt = -Infinity;
  let lastRateSet = 1;
  let userRate = false;
  const counters = { stalls: 0, stalledS: 0, holds: 0, heldS: 0 };

  const rawLatency = (): number | null => {
    const l = hls.latency;
    return Number.isFinite(l) && l > 0 ? l : null;
  };
  // hls.latency = playlist edge + its age − currentTime, and the age comes from the wall clock
  // (Date.now()): a clock step (NTP on a CI runner, a laptop waking up) shows a delay of 37 s for
  // a second or two. The controller, the status line and the panel all use the median of the
  // last few one-second samples instead: one source of truth that ignores such a blip.
  const recent: number[] = [];
  const sampleLatency = (): void => {
    const l = rawLatency();
    if (l === null) return;
    recent.push(l);
    if (recent.length > LATENCY_SAMPLES) recent.shift();
  };
  const latency = (): number | null => {
    if (recent.length === 0) return rawLatency();
    const sorted = [...recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };

  // p2p-media-loader knows where each segment came from and how long the real download took
  // (a segment fetched ahead is then handed to hls.js from memory almost instantly).
  const starts = new Map<string, number>();
  const loaded = new Map<string, { source: 'http' | 'p2p'; netS: number }>();
  const trim = (m: Map<string, unknown>): void => {
    while (m.size > 200) m.delete(m.keys().next().value as string);
  };
  engine?.addEventListener('onSegmentStart', (d) => {
    if (d.streamType !== 'main') return;
    starts.set(d.segment.runtimeId, clock());
    trim(starts);
  });
  engine?.addEventListener('onSegmentLoaded', (d) => {
    if (d.streamType !== 'main') return;
    const t0 = starts.get(d.segment.runtimeId);
    starts.delete(d.segment.runtimeId);
    loaded.set(d.segment.url, { source: d.downloadSource === 'p2p' ? 'p2p' : 'http', netS: t0 === undefined ? NaN : clock() - t0 });
    trim(loaded);
  });
  hls.on(o.events.FRAG_LOADED, (_e, data) => {
    const frag = data.frag;
    if (frag.type !== 'main' || !(frag.duration > 0)) return;
    const rec = loaded.get(frag.url);
    loaded.delete(frag.url);
    const s = frag.stats;
    const hlsS = (s.loading.end - s.loading.start) / 1000;
    const sample: FragmentSample = {
      at: clock(),
      durationS: frag.duration,
      loadS: rec && Number.isFinite(rec.netS) ? rec.netS : hlsS,
      source: rec?.source ?? 'http',
      bytes: s.loaded,
    };
    ctl.onFragment(sample);
  });

  const endHold = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    holding = false;
  };
  const resume = (): void => {
    endHold();
    void video.play().catch(() => {
      // Autoplay refused (should not happen: the video was playing). Let the page show "Paused".
      video.dispatchEvent(new Event('pause'));
    });
  };

  video.addEventListener('playing', () => {
    started = true;
    if (stallAt !== null && !holding) {
      const now = clock();
      const d = now - stallAt;
      counters.stalledS += d;
      // Right after the freeze the median still holds pre-stall samples: use the live value.
      recent.length = 0;
      sampleLatency();
      ctl.onStallEnd(now, latency(), d);
      stallAt = null;
    }
  });
  video.addEventListener('waiting', () => {
    const now = clock();
    // Not a network stall: before the first frame, while seeking (Go live, profile switch), or
    // while paused / already held.
    if (!started || holding || stallAt !== null || video.paused || video.seeking || now - lastSeekAt < 1.5) return;
    stallAt = now;
    counters.stalls += 1;
    const d = ctl.onStallStart(now, latency());
    applyTarget();
    if (d.holdS > 0) {
      // Playback is frozen anyway: keep it frozen a little longer so the delay reaches the new
      // target now, instead of another freeze later. hls.js keeps loading meanwhile.
      holding = true;
      counters.holds += 1;
      counters.heldS += d.holdS;
      video.pause();
      holdTimer = setTimeout(resume, d.holdS * 1000);
    }
  });
  video.addEventListener('seeking', () => {
    lastSeekAt = clock();
    // Go live, a profile switch, the stall watchdog: the old samples no longer apply.
    recent.length = 0;
    stallAt = null;
    if (holding) resume();
  });
  video.addEventListener('play', () => {
    // The viewer pressed play during a hold: they win.
    if (holding) endHold();
  });
  video.addEventListener('pause', () => {
    if (!holding) stallAt = null;
  });

  const applyTarget = (): void => {
    const t = Math.round(ctl.syncTarget * 10) / 10;
    if (Math.abs((hls.config.liveSyncDuration ?? 0) - t) >= 0.1) hls.targetLatency = t;
  };

  let last = ctl.tick({ now: clock(), latency: null, forwardBuffer: 0, bandwidthEstimate: 0, levelBitrate: 0, playing: false });
  setInterval(() => {
    sampleLatency();
    const level = hls.levels[hls.currentLevel];
    last = ctl.tick({
      now: clock(),
      latency: latency(),
      forwardBuffer: forwardBuffer(video),
      bandwidthEstimate: hls.bandwidthEstimate,
      levelBitrate: level?.bitrate ?? 0,
      playing: started && !video.paused && !holding && stallAt === null && !video.seeking && video.readyState >= 3,
      p2pEnabled: o.p2pEnabled(),
    });
    applyTarget();
    // The viewer picked a speed in the browser's own controls: leave it alone until it is 1× again.
    if (video.playbackRate !== lastRateSet) {
      userRate = video.playbackRate !== 1;
      lastRateSet = video.playbackRate;
    }
    if (!userRate && !holding && video.playbackRate !== last.playbackRate) {
      video.playbackRate = last.playbackRate;
      lastRateSet = last.playbackRate;
    }
  }, 1000);

  return {
    get delay() {
      const l = started ? latency() : null;
      return l === null ? null : Math.max(0, l);
    },
    get target() {
      return ctl.target;
    },
    get holding() {
      return holding;
    },
    setProfile(id) {
      // A hold is our own pause: ending it must play again. Only clearing it left the video
      // paused for good, still showing "Buffering": the hold timer was gone, the profile switch
      // (applyProfile) leaves a paused video alone, and so does the stall watchdog (seen in
      // quality.spec in Docker: "Lower delay" a few ms after a source reload, which a hold met).
      if (holding) resume();
      else endHold();
      ctl.reset(id, clock());
      applyTarget();
    },
    setCeiling(seconds) {
      ctl.setCeiling(seconds);
      applyTarget();
    },
    setGrowthLimit(seconds) {
      ctl.setGrowthLimit(seconds);
      applyTarget();
    },
    snapshot() {
      return {
        delay: latency(),
        target: ctl.target,
        syncTarget: ctl.syncTarget,
        state: last.state,
        rateMode: last.rateMode,
        playbackRate: video.playbackRate,
        rates: ctl.rates,
        holding,
        bounds: ctl.currentBounds,
        signals: ctl.signals,
        ...counters,
      };
    },
  };
}
