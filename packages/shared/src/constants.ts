/** Shared constants. Keep in sync with docs/ARCHITECTURE.md. */

export const APP_NAME = 'SwarmCast';

export const DEFAULT_PORTS = {
  rtmp: 1935,
  public: 8080,
  admin: 8081,
  /** Internal MediaMTX HLS port (127.0.0.1 only, never exposed). */
  mediamtxHls: 8888,
} as const;

/** Target HLS segment duration in seconds. OBS keyframe interval must match. */
export const SEGMENT_DURATION_S = 2;

/**
 * Live delays of the viewer's playback profiles (hls.js liveSyncDuration /
 * liveMaxLatencyDuration, seconds). apps/viewer/src/player-config.ts builds its profiles from
 * these, and the server sizes every playlist window from them (PLAYLIST_WINDOW_S), so the two
 * cannot drift apart.
 */
export const PLAYER_LIVE_DELAYS = {
  stable: { liveSyncDuration: 20, liveMaxLatencyDuration: 36 },
  'low-delay': { liveSyncDuration: 8, liveMaxLatencyDuration: 20 },
} as const;

/** hls.js raises the target delay after stalls, by at most one target duration. */
export const PLAYER_STALL_INCREASE_S = SEGMENT_DURATION_S;

/**
 * The furthest behind live a player ever sits: hls.js jumps back to liveSyncDuration (+ stall
 * increase) as soon as the delay passes liveMaxLatencyDuration, so it never needs anything older.
 */
export const MAX_PLAYER_DELAY_S = Math.max(
  ...Object.values(PLAYER_LIVE_DELAYS).map((d) => Math.max(d.liveMaxLatencyDuration, d.liveSyncDuration + PLAYER_STALL_INCREASE_S)),
);

/** Room to fetch the oldest segment a player at MAX_PLAYER_DELAY_S still needs. */
export const PLAYLIST_SAFETY_MARGIN_S = 2 * SEGMENT_DURATION_S;

/** Seconds every live playlist (video and audio, original and ladder) must cover. */
export const PLAYLIST_WINDOW_S = MAX_PLAYER_DELAY_S + PLAYLIST_SAFETY_MARGIN_S;

/** Entries a playlist of `segmentDurationS` segments needs to cover PLAYLIST_WINDOW_S. */
export function playlistEntries(segmentDurationS: number): number {
  return Math.ceil(PLAYLIST_WINDOW_S / segmentDurationS);
}

/** Lifetime of a viewer session JWT. Renewed while the stream is live. */
export const SESSION_TTL_S = 10 * 60;

/** Lifetime of the join ticket that carries the user from /join/<secret> to the nickname form. */
export const JOIN_TICKET_TTL_S = 10 * 60;

export const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';

export const NICKNAME_MAX = 24;

/** Max size of a control-channel message (bytes). */
export const CONTROL_MAX_MESSAGE = 4096;

/** Max size of a tracker message (bytes). WebRTC offers are a few KB. */
export const TRACKER_MAX_MESSAGE = 64 * 1024;

/** Hash failures from one session before it is removed from P2P automatically. */
export const HASH_FAILURE_THRESHOLD = 3;

/**
 * WebSocket close codes of `/control` (4000-4999: application codes, RFC 6455 §7.4.2). The watch
 * page shows its end screen after `ended` and `kicked`, and tries to reconnect after the others.
 */
export const CONTROL_CLOSE = { ended: 4000, sessionEnded: 4001, disconnected: 4002, kicked: 4003 } as const;

/**
 * A Cloudflare quick tunnel answers 429 above 200 requests in flight, and every open
 * WebSocket counts as one until it closes (measured 2026-10-26, docs/ARCHITECTURE.md).
 */
export const QUICK_TUNNEL_CONCURRENCY_LIMIT = 200;

/**
 * Viewers one quick tunnel holds with headroom: each keeps one WebSocket open (/control, which
 * also carries the tracker) and, at peaks, about half a video request in flight on average.
 * Default of `maxViewers`.
 */
export const QUICK_TUNNEL_MAX_VIEWERS = 120;

/** Share of QUICK_TUNNEL_CONCURRENCY_LIMIT in use at which the panel warns. */
export const QUICK_TUNNEL_WARN_SHARE = 0.8;

/**
 * How long a browser that passed the join browser check (proof-of-work) is remembered: it is not
 * asked again until then, unless the attack shield raises the level above the one it solved.
 */
export const BROWSER_CHECK_TTL_S = 30 * 24 * 3600;

export const SESSION_COOKIE = 'sc_session';
export const TICKET_COOKIE = 'sc_ticket';
export const DEVICE_COOKIE = 'sc_device';
/** Signed "this browser passed the browser check" cookie (bound to the device cookie). */
export const VERIFIED_COOKIE = 'sc_verified';
export const ADMIN_COOKIE = 'sc_admin';
