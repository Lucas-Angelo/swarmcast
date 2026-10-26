/**
 * Playback profiles for hls.js + p2p-media-loader (docs/QUALITY.md explains every number).
 *
 * - "stable" (default): ~20 s behind live. A big buffer rides out Wi-Fi/4G hiccups and slow
 *   tunnel responses, and leaves room for peers to share segments before they are needed.
 * - "low-delay": ~8 s behind live. Chat feels closer, but short network hiccups become stalls
 *   and P2P helps much less.
 *
 * Wired into watch.ts as described in INTEGRATION.md.
 */
import type Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';
import type { DynamicCoreConfig, StreamSwarmIdBuilderContext } from 'p2p-media-loader-core';
import { variantStreamSwarmId } from '@swarmcast/shared';

export type PlaybackProfileId = 'stable' | 'low-delay';

export const DEFAULT_PROFILE: PlaybackProfileId = 'stable';

export interface PlaybackProfile {
  id: PlaybackProfileId;
  /** Target distance behind the live edge, seconds. */
  liveSyncDuration: number;
  /** Beyond this, hls.js jumps back to the target (only after long stalls). Must stay below the playlist window (40 s). */
  liveMaxLatencyDuration: number;
  /** Gentle catch-up after stalls (1 = never speed up). */
  maxLiveSyncPlaybackRate: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  /** ABR: keep a level while estimate × factor ≥ its bitrate. */
  abrBandWidthFactor: number;
  /** ABR: switch up only when estimate × upFactor ≥ the higher level's bitrate. */
  abrBandWidthUpFactor: number;
  abrEwmaFastLive: number;
  abrEwmaSlowLive: number;
  /** p2p-media-loader: segments closer than this to the playhead always come over HTTPS. */
  highDemandTimeWindow: number;
}

export const PROFILES: Record<PlaybackProfileId, PlaybackProfile> = {
  stable: {
    id: 'stable',
    liveSyncDuration: 20,
    liveMaxLatencyDuration: 36,
    maxLiveSyncPlaybackRate: 1.05,
    maxBufferLength: 30,
    maxMaxBufferLength: 40,
    backBufferLength: 10,
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.6,
    abrEwmaFastLive: 4,
    abrEwmaSlowLive: 12,
    highDemandTimeWindow: 8,
  },
  'low-delay': {
    id: 'low-delay',
    liveSyncDuration: 8,
    liveMaxLatencyDuration: 20,
    maxLiveSyncPlaybackRate: 1.1,
    maxBufferLength: 12,
    maxMaxBufferLength: 20,
    backBufferLength: 6,
    abrBandWidthFactor: 0.9,
    abrBandWidthUpFactor: 0.7,
    abrEwmaFastLive: 3,
    abrEwmaSlowLive: 9,
    highDemandTimeWindow: 4,
  },
};

/** Retry policy: 429 = tunnel concurrency limit, so back off and retry instead of failing. */
export const RETRY_POLICY = {
  maxTimeToFirstByteMs: 10_000,
  maxLoadTimeMs: 20_000,
  timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
  errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' as const },
};

const PROFILE_KEY = 'sc.playback-profile';
const ESTIMATE_KEY = 'sc.bandwidth-estimate';
const LEVEL_KEY = 'sc.quality-height';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode, blocked storage: the setting just is not remembered */
  }
}

export function loadProfile(): PlaybackProfileId {
  const v = storageGet(PROFILE_KEY);
  return v === 'low-delay' || v === 'stable' ? v : DEFAULT_PROFILE;
}

export function saveProfile(id: PlaybackProfileId): void {
  storageSet(PROFILE_KEY, id);
}

/** Last bandwidth estimate (bps) from a previous visit, so ABR starts at a sensible level. */
export function loadSavedEstimate(): number | undefined {
  const n = Number(storageGet(ESTIMATE_KEY));
  return Number.isFinite(n) && n > 100_000 ? n : undefined;
}

export function saveEstimate(hls: Pick<Hls, 'bandwidthEstimate'>): void {
  const e = hls.bandwidthEstimate;
  if (Number.isFinite(e) && e > 0) storageSet(ESTIMATE_KEY, String(Math.round(e)));
}

/** Height the viewer picked by hand (null = Auto). */
export function loadPreferredHeight(): number | null {
  const n = Number(storageGet(LEVEL_KEY));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function savePreferredHeight(height: number | null): void {
  storageSet(LEVEL_KEY, height === null ? null : String(height));
}

export interface PlayerConfigOptions {
  isMobile: boolean;
  /** Override the first ABR estimate (bps); defaults to the saved one, else 2 Mbps. */
  initialEstimate?: number;
}

/**
 * hls.js options for a profile. Uses durations (seconds), not counts: do not also pass
 * liveSyncDurationCount / liveMaxLatencyDurationCount (hls.js rejects mixing them).
 */
export function hlsConfigFor(id: PlaybackProfileId, o: PlayerConfigOptions): Partial<HlsConfig> {
  const p = PROFILES[id];
  return {
    lowLatencyMode: false,
    liveSyncDuration: p.liveSyncDuration,
    liveMaxLatencyDuration: p.liveMaxLatencyDuration,
    maxLiveSyncPlaybackRate: p.maxLiveSyncPlaybackRate,
    liveSyncOnStallIncrease: 1,
    maxBufferLength: p.maxBufferLength,
    maxMaxBufferLength: p.maxMaxBufferLength,
    backBufferLength: o.isMobile ? Math.min(6, p.backBufferLength) : p.backBufferLength,
    // ABR: start from what worked last time (or a 480p-friendly guess), smooth estimates,
    // conservative up-switches. Fewer up/down oscillations = fewer stalls.
    abrEwmaDefaultEstimate: o.initialEstimate ?? loadSavedEstimate() ?? 2_000_000,
    abrBandWidthFactor: p.abrBandWidthFactor,
    abrBandWidthUpFactor: p.abrBandWidthUpFactor,
    abrEwmaFastLive: p.abrEwmaFastLive,
    abrEwmaSlowLive: p.abrEwmaSlowLive,
    // No 1080p into a phone-sized player; drop a level if the device drops frames.
    capLevelToPlayerSize: true,
    maxDevicePixelRatio: 2,
    capLevelOnFPSDrop: true,
    startFragPrefetch: true,
    // Ride over small gaps (e.g. at a stream restart) instead of stalling.
    maxBufferHole: 0.5,
    nudgeMaxRetry: 5,
    fragLoadPolicy: { default: RETRY_POLICY },
    playlistLoadPolicy: { default: RETRY_POLICY },
    manifestLoadPolicy: { default: RETRY_POLICY },
  };
}

/** p2p-media-loader core options that depend on the profile. */
export function p2pCoreConfigFor(id: PlaybackProfileId): Pick<DynamicCoreConfig, 'highDemandTimeWindow'> {
  return { highDemandTimeWindow: PROFILES[id].highDemandTimeWindow };
}

/**
 * Swarm id per stream: one swarm per video variant (keyed by height) so peers watching 720p
 * never offer 720p bytes to someone playing 1080p. Must match apps/server/src/tracker/tracker.ts.
 */
export function streamSwarmIdBuilder(ctx: StreamSwarmIdBuilderContext): string {
  return variantStreamSwarmId(ctx.swarmId, ctx.streamType, ctx.properties.height);
}

/**
 * When OBS reconnects, the set of renditions can change (quality options turned on or off,
 * ffmpeg fell back to the original quality), so a media playlist the player knows may be
 * gone for good. Feed every hls.js ERROR to the returned function: after `threshold` 404s
 * on media playlists in a row it calls `reload` (hls.loadSource(playlistUrl)) to re-read the
 * multivariant playlist. Call `reset()` on LEVEL_LOADED.
 */
export function createManifestReloader(reload: () => void, threshold = 3): { onError(details: string, httpCode?: number): void; reset(): void } {
  let misses = 0;
  return {
    onError(details, httpCode) {
      if (httpCode !== 404 || !/^(levelLoad|audioTrackLoad)(Error|TimeOut)$/.test(details)) return;
      misses += 1;
      if (misses >= threshold) {
        misses = 0;
        reload();
      }
    },
    reset() {
      misses = 0;
    },
  };
}

interface HlsLike {
  config: HlsConfig;
  targetLatency: number | null;
  latency: number;
  readonly media: HTMLMediaElement | null;
}

interface EngineLike {
  applyDynamicConfig(c: { core: DynamicCoreConfig }): void;
}

/**
 * Switch profile while playing. Moving closer to live jumps forward to the new target;
 * moving to "stable" pauses briefly so the buffer (and the delay) grow without a stall later.
 */
export function applyProfile(hls: HlsLike, engine: EngineLike | null, id: PlaybackProfileId, o: PlayerConfigOptions): void {
  const p = PROFILES[id];
  const c = hls.config;
  c.liveMaxLatencyDuration = p.liveMaxLatencyDuration;
  c.maxLiveSyncPlaybackRate = p.maxLiveSyncPlaybackRate;
  c.maxBufferLength = p.maxBufferLength;
  c.maxMaxBufferLength = p.maxMaxBufferLength;
  c.backBufferLength = o.isMobile ? Math.min(6, p.backBufferLength) : p.backBufferLength;
  c.abrBandWidthFactor = p.abrBandWidthFactor;
  c.abrBandWidthUpFactor = p.abrBandWidthUpFactor;
  hls.targetLatency = p.liveSyncDuration;
  engine?.applyDynamicConfig({ core: { highDemandTimeWindow: p.highDemandTimeWindow, mainStream: { highDemandTimeWindow: p.highDemandTimeWindow }, secondaryStream: { highDemandTimeWindow: p.highDemandTimeWindow } } });
  saveProfile(id);
  const media = hls.media;
  if (!media || media.paused) return;
  const latency = hls.latency;
  if (latency > p.liveSyncDuration + 2) {
    media.currentTime += latency - p.liveSyncDuration;
  } else if (latency < p.liveSyncDuration - 2) {
    const waitMs = (p.liveSyncDuration - latency) * 1000;
    media.pause();
    setTimeout(() => void media.play().catch(() => {}), waitMs);
  }
}
