import { translate, type MessageKey, type MessageParams } from './i18n/index.js';
import type { CapacityInfo } from './schemas.js';

function coded(code: MessageKey, params?: MessageParams): Pick<CapacityInfo, 'code' | 'params' | 'message'> {
  return { code, ...(params ? { params } : {}), message: translate('en', code, params) };
}

export interface CapacityInput {
  /** Measured upload in Mbps (undefined when no speed test yet). */
  uploadMbps?: number;
  /** Upload limit configured by the streamer, Mbps. */
  limitMbps: number;
  /** Real bitrate received from OBS, kbps. 0 when unknown. */
  bitrateKbps: number;
  /** Fraction (0..1) of video currently delivered by peers. */
  p2pShare: number;
  /** Whether the streamer also uploads the same stream elsewhere (e.g. Twitch). */
  alsoStreamingElsewhere: boolean;
  /** Viewers currently connected. */
  viewers: number;
}

/** Fraction of the measured upload we are willing to use (keeps headroom for jitter, other apps). */
export const UPLOAD_HEADROOM = 0.75;
/** Per-viewer overhead on top of the media bitrate (HTTP, TLS, playlists, retries). */
export const PER_VIEWER_OVERHEAD = 1.15;
/** Bitrate assumed before OBS connects, kbps (a typical 1080p30 stream). */
export const ASSUMED_BITRATE_KBPS = 6000;

export function estimateCapacity(input: CapacityInput): CapacityInfo {
  const bitrateKbps = input.bitrateKbps > 0 ? input.bitrateKbps : ASSUMED_BITRATE_KBPS;
  const bitrateMbps = bitrateKbps / 1000;
  const perViewerMbps = bitrateMbps * PER_VIEWER_OVERHEAD;

  if (input.uploadMbps === undefined || !Number.isFinite(input.uploadMbps)) {
    const direct = Math.floor(input.limitMbps / perViewerMbps);
    return {
      usableUploadMbps: 0,
      recommendedLimitMbps: 0,
      effectiveLimitMbps: input.limitMbps,
      directViewers: Math.max(0, direct),
      withP2PViewers: Math.max(0, direct),
      level: 'unknown',
      ...coded('capacity.unknown'),
    };
  }

  const reserved = input.alsoStreamingElsewhere ? bitrateMbps : 0;
  const usable = Math.max(0, input.uploadMbps * UPLOAD_HEADROOM - reserved);
  const effective = Math.min(input.limitMbps, usable);
  const directViewers = Math.max(0, Math.floor(effective / perViewerMbps));
  const share = Math.min(Math.max(input.p2pShare, 0), 0.95);
  const withP2PViewers = Math.max(0, Math.floor(effective / (perViewerMbps * (1 - share))));

  let level: CapacityInfo['level'] = 'ok';
  let text = coded('capacity.ok', { count: directViewers });
  if (directViewers === 0) {
    level = 'over';
    text = coded('capacity.tooLow');
  } else if (input.viewers > withP2PViewers) {
    level = 'over';
    text = coded('capacity.over');
  } else if (input.viewers >= withP2PViewers * 0.8) {
    level = 'near';
    text = coded('capacity.near');
  }

  return {
    usableUploadMbps: round1(usable),
    recommendedLimitMbps: Math.max(1, Math.floor(usable)),
    effectiveLimitMbps: round1(effective),
    directViewers,
    withP2PViewers,
    level,
    ...text,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
