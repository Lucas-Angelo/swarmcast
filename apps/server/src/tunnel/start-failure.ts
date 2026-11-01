/**
 * Why a cloudflared quick tunnel failed to start, read from its last output lines.
 *
 * cloudflared asks `https://api.trycloudflare.com/tunnel` for a new quick tunnel before anything
 * else; when that request fails, it prints the error as a bare line on stderr (no timestamp, no
 * level: urfave/cli's exit message) and exits with code 1. Measured with cloudflared 2026.10.3 and
 * the code of 2026.10.4 (`cmd/cloudflared/tunnel/quick_tunnel.go`) against a fake quick-tunnel
 * service:
 *
 *   quick tunnel provisioning failed with status 429
 *   quick tunnel provisioning failed with status 429: [1015] You are being rate limited
 *   quick tunnel provisioning failed with status 503
 *   failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": … timeout …
 *
 * Older releases logged `ERR Error unmarshaling QuickTunnel response: … status_code="429 Too Many
 * Requests"` first. cloudflared never prints the response's Retry-After header (2026.10.x); one
 * is honoured if a future release does.
 */

/** busy: Cloudflare refused (429); unavailable: it failed or did not answer (5xx, timeout). */
export type TransientCause = 'busy' | 'unavailable';

export interface StartFailure {
  /** Set when trying again later may work: a refusal or failure of Cloudflare's free service. */
  transient: TransientCause | null;
  /** cloudflared's own message (one line, at most REASON_MAX characters), or null if it said nothing. */
  reason: string | null;
  /** Seconds Cloudflare asked to wait, when cloudflared reports it. */
  retryAfterS?: number;
}

export const REASON_MAX = 200;

/** `2026-11-01T02:58:54Z ERR ` (cloudflared's log prefix). */
const LOG_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(INF|ERR|WRN|DBG|FTL)\s+/;

const BUSY = [/provisioning failed with status 429\b/i, /\b429 Too Many Requests\b/i, /\brate[- ]limit/i, /\berror code:?\s*1015\b/i];
const UNAVAILABLE = [
  /provisioning failed with status 5\d\d\b/i,
  /status_code="5\d\d\b/i,
  /failed to read quick-tunnel response/i,
  /failed to request quick Tunnel:.*(timeout|deadline exceeded|connection reset|EOF|TLS handshake)/i,
];

/**
 * An error line of cloudflared: logged as ERR/FTL, or bare (its exit message has no prefix).
 * Indented lines are its help text (printed after "Incorrect Usage."), not errors.
 */
export function isErrorLine(line: string): boolean {
  if (line.trim() === '' || /^\s/.test(line)) return false;
  const m = LOG_PREFIX.exec(line);
  return !m || m[1] === 'ERR' || m[1] === 'FTL';
}

/**
 * The one line that says why cloudflared stopped: "Incorrect Usage…" (a bad flag: it then prints
 * its help text on stdout and exits with code 0), else its last error line, else its last line.
 */
export function cloudflaredReason(lines: readonly string[]): string | null {
  const pick =
    lines.find((l) => /^Incorrect Usage\b/.test(l)) ??
    lines.findLast(isErrorLine) ??
    lines.findLast((l) => l.trim() !== '');
  if (pick === undefined) return null;
  const text = pick.trim().replace(LOG_PREFIX, '');
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

/** Classify a failed start from cloudflared's last output lines (oldest first). */
export function classifyStartFailure(lines: readonly string[]): StartFailure {
  const all = lines.join('\n');
  const transient: TransientCause | null = BUSY.some((re) => re.test(all)) ? 'busy' : UNAVAILABLE.some((re) => re.test(all)) ? 'unavailable' : null;
  const retryAfter = /retry[-_ ]after\D{0,4}(\d{1,5})/i.exec(all);
  return {
    transient,
    reason: cloudflaredReason(lines),
    ...(transient && retryAfter ? { retryAfterS: Number(retryAfter[1]) } : {}),
  };
}

/** Attempts in total when Cloudflare refuses or fails: the first one plus START_RETRY_DELAYS_MS.length. */
export const START_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;
/** Random extra wait, as a share of the delay, so several computers refused together do not retry together. */
export const START_RETRY_JITTER = 0.25;
/** A Retry-After longer than this is not waited for: the streamer gets the error and can try later. */
export const START_RETRY_AFTER_MAX_MS = 60_000;

/**
 * How long to wait before attempt `attempt + 1`: the planned delay plus jitter, or Retry-After when
 * Cloudflare asked for longer (capped). `random` is Math.random in the app, fixed in tests.
 */
export function retryDelayMs(attempt: number, failure: StartFailure, random: () => number): number {
  const base = START_RETRY_DELAYS_MS[attempt - 1] ?? START_RETRY_DELAYS_MS.at(-1)!;
  const planned = Math.round(base * (1 + START_RETRY_JITTER * random()));
  const asked = failure.retryAfterS !== undefined ? Math.min(failure.retryAfterS * 1000, START_RETRY_AFTER_MAX_MS) : 0;
  return Math.max(planned, asked);
}
