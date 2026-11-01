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
import { PLAYER_LIVE_DELAYS, variantStreamSwarmId } from '@swarmcast/shared';

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
    // Shared with the server, which sizes every playlist window from these (PLAYLIST_WINDOW_S).
    ...PLAYER_LIVE_DELAYS.stable,
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
    ...PLAYER_LIVE_DELAYS['low-delay'],
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
const AUDIO_ONLY_KEY = 'sc.audio-only';

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

/** The viewer picked "Audio only" (audio-only.ts): this browser starts on it next time too. */
export function loadAudioOnly(): boolean {
  return storageGet(AUDIO_ONLY_KEY) === 'on';
}

export function saveAudioOnly(on: boolean): void {
  storageSet(AUDIO_ONLY_KEY, on ? 'on' : null);
}

export interface PlayerConfigOptions {
  isMobile: boolean;
  /** Override the first ABR estimate (bps); defaults to the saved one, else 2 Mbps. */
  initialEstimate?: number;
  /** Current playlist window (see latencyFor); the profile's delays are fitted into it. */
  window?: () => PlaylistWindow | null;
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
    // +1 s per stall; hls.js caps the total at one target duration (PLAYER_STALL_INCREASE_S).
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

/**
 * Seconds before it plays under which a fragment the P2P core still holds is fetched over
 * HTTPS instead (p2p-fallback.ts). Inside the core's own high-demand window, so the core
 * normally gets there first; this is the safety net when it does not.
 */
export function urgentSecondsFor(id: PlaybackProfileId): number {
  return Math.max(3, PROFILES[id].highDemandTimeWindow * 0.75);
}

/** How much of the stream the playlists still offer (the shortest of video and audio). */
export interface PlaylistWindow {
  /** Seconds covered by the shortest live playlist in use. */
  windowS: number;
  /** Longest target duration among those playlists, seconds. */
  targetDurationS: number;
}

interface LiveDetails {
  totalduration: number;
  targetduration: number;
}

/**
 * The window to fit the live delay into, or null to keep the profile as is. Only a mismatch
 * matters: an audio playlist that covers less than the video one (servers up to v0.2.0 kept
 * 20 one-second audio segments next to 40 s of video). Playlists that are merely short
 * because the stream just started grow by themselves, and hls.js already handles them.
 */
/**
 * Whether every playlist in use is loaded: the video one, and the audio one when the stream
 * has separate audio. Until then, a missing playlist is not a short one.
 */
export function playlistsKnown(hasAudioTracks: boolean, d: { video?: LiveDetails; audio?: LiveDetails }): boolean {
  return !!d.video && (!hasAudioTracks || !!d.audio);
}

export function mismatchWindow(video: LiveDetails | undefined, audio: LiveDetails | undefined): PlaylistWindow | null {
  if (!video || !audio) return null;
  // The two playlists refresh at different moments, so while they grow (stream start) one is
  // briefly a segment or two ahead: only a clear, lasting gap counts.
  if (audio.totalduration > video.totalduration - Math.max(2 * video.targetduration, video.totalduration / 4)) return null;
  return { windowS: audio.totalduration, targetDurationS: Math.max(video.targetduration, audio.targetduration) };
}

/**
 * Fit the profile's live delay into what the playlists actually offer. The player must stay
 * well inside the shortest window (the audio playlist can be shorter than the video one):
 * a position older than the oldest audio segment never plays again, and hls.js' catch-up jump
 * (liveMaxLatencyDuration) would land there over and over.
 *
 * - liveMaxLatencyDuration ≤ window − 2 target durations (time to fetch the oldest segment);
 * - liveSyncDuration leaves room below that for stalls (hls.js adds up to one target duration
 *   after stalls, plus one of slack): ≤ max − 2 target durations.
 */
export function latencyFor(id: PlaybackProfileId, w?: PlaylistWindow | null): { liveSyncDuration: number; liveMaxLatencyDuration: number } {
  const p = PROFILES[id];
  if (!w || !(w.windowS > 0) || !(w.targetDurationS > 0)) {
    return { liveSyncDuration: p.liveSyncDuration, liveMaxLatencyDuration: p.liveMaxLatencyDuration };
  }
  const td = w.targetDurationS;
  const floorSync = 2 * td;
  // Whole seconds, so a window that wobbles by a few ms (19.99 / 20.01 s) does not retune hls.js.
  const max = Math.max(floorSync + 2 * td, Math.min(p.liveMaxLatencyDuration, Math.floor(Math.round(w.windowS) - 2 * td)));
  const sync = Math.max(floorSync, Math.min(p.liveSyncDuration, Math.floor(max - 2 * td)));
  return { liveSyncDuration: sync, liveMaxLatencyDuration: max };
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
 * streamSwarmIdBuilder, aware of "Audio only" (audio-only.ts). The audio-only playlist has one
 * variant, the stream's own audio rendition, which hls.js plays as its main level; its segments
 * are the very ones video viewers get as their alternate audio (same playlist, same names, same
 * media sequence numbers, the same hashes in the signed manifest). So that stream joins the
 * video viewers' audio swarm ("secondary", already on the tracker's allowlist) instead of
 * `main-0`, the swarm of a video variant without RESOLUTION: there a peer would answer a request
 * for audio segment N with video segment N, which fails the hash check and gets an honest peer
 * reported. `audioOnly` is read when the stream registers (after each hls.loadSource).
 */
export function swarmIdBuilderFor(audioOnly: () => boolean): (ctx: StreamSwarmIdBuilderContext) => string {
  return (ctx) => (ctx.streamType === 'main' && audioOnly() ? variantStreamSwarmId(ctx.swarmId, 'secondary') : streamSwarmIdBuilder(ctx));
}

/**
 * When OBS reconnects, the set of renditions can change (quality options turned on or off,
 * ffmpeg fell back to the original quality), so a media playlist the player knows may be
 * gone for good. Feed every hls.js ERROR to the returned function: after `threshold` 404s
 * on media playlists in a row it calls `reload` (hls.loadSource(playlistUrl)) to re-read the
 * multivariant playlist. Call `reset()` on LEVEL_LOADED. `threshold` may be a function, read at
 * each miss (watch.ts: 1 while audio only plays, AUDIO_ONLY_GONE_AFTER).
 */
export function createManifestReloader(reload: () => void, threshold: number | (() => number) = 3): { onError(details: string, httpCode?: number): void; reset(): void } {
  let misses = 0;
  return {
    onError(details, httpCode) {
      if (httpCode !== 404 || !/^(levelLoad|audioTrackLoad)(Error|TimeOut)$/.test(details)) return;
      misses += 1;
      if (misses >= (typeof threshold === 'function' ? threshold() : threshold)) {
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
  const fit = latencyFor(id, o.window?.());
  c.liveMaxLatencyDuration = fit.liveMaxLatencyDuration;
  c.maxLiveSyncPlaybackRate = p.maxLiveSyncPlaybackRate;
  c.maxBufferLength = p.maxBufferLength;
  c.maxMaxBufferLength = p.maxMaxBufferLength;
  c.backBufferLength = o.isMobile ? Math.min(6, p.backBufferLength) : p.backBufferLength;
  c.abrBandWidthFactor = p.abrBandWidthFactor;
  c.abrBandWidthUpFactor = p.abrBandWidthUpFactor;
  hls.targetLatency = fit.liveSyncDuration;
  engine?.applyDynamicConfig({ core: { highDemandTimeWindow: p.highDemandTimeWindow, mainStream: { highDemandTimeWindow: p.highDemandTimeWindow }, secondaryStream: { highDemandTimeWindow: p.highDemandTimeWindow } } });
  saveProfile(id);
  const media = hls.media;
  if (!media || media.paused) return;
  const latency = hls.latency;
  if (latency > fit.liveSyncDuration + 2) {
    media.currentTime += latency - fit.liveSyncDuration;
  } else if (latency < fit.liveSyncDuration - 2) {
    const waitMs = (fit.liveSyncDuration - latency) * 1000;
    media.pause();
    setTimeout(() => void media.play().catch(() => {}), waitMs);
  }
}
