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

/** Cloudflare quick tunnels reject above ~200 concurrent in-flight requests. */
export const QUICK_TUNNEL_CONCURRENCY_LIMIT = 200;

export const SESSION_COOKIE = 'sc_session';
export const TICKET_COOKIE = 'sc_ticket';
export const DEVICE_COOKIE = 'sc_device';
export const ADMIN_COOKIE = 'sc_admin';
