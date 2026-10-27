/**
 * Tracker-over-control multiplexing (docs/ARCHITECTURE.md, "One WebSocket per viewer").
 *
 * A Cloudflare quick tunnel allows 200 requests in flight, and an open WebSocket counts as
 * one for as long as it stays open (measured 2026-10-26, scripts/test/tunnel-limit). So each
 * viewer keeps ONE WebSocket, `/control`, and the WebTorrent tracker traffic rides on it as
 * numbered channels:
 *
 * - control messages are JSON objects, exactly as before (they start with `{`);
 * - tracker frames start with `~`: `~o<id>` opens channel `id` (viewer → server),
 *   `~d<id> <payload>` carries one tracker message (both ways) and `~c<id>` closes the
 *   channel (both ways).
 */

export const TRACKER_FRAME_PREFIX = '~';

/** Tracker channels one control socket may have open at once (p2p-media-loader uses one). */
export const MAX_TRACKER_CHANNELS = 2;

/** Highest channel id; ids are small positive integers chosen by the viewer. */
export const MAX_TRACKER_CHANNEL_ID = 9_999_999;

export type TrackerFrame = { op: 'open'; id: number } | { op: 'close'; id: number } | { op: 'data'; id: number; payload: string };

export function encodeTrackerFrame(frame: TrackerFrame): string {
  switch (frame.op) {
    case 'open':
      return `~o${frame.id}`;
    case 'close':
      return `~c${frame.id}`;
    case 'data':
      return `~d${frame.id} ${frame.payload}`;
  }
}

export function isTrackerFrame(text: string): boolean {
  return text.startsWith(TRACKER_FRAME_PREFIX);
}

/** Parse a `~…` frame; null when it is malformed. */
export function parseTrackerFrame(text: string): TrackerFrame | null {
  const m = /^~([ocd])([1-9]\d{0,6})/.exec(text);
  if (!m) return null;
  const id = Number(m[2]);
  const rest = text.slice(m[0].length);
  if (m[1] === 'd') return rest.startsWith(' ') ? { op: 'data', id, payload: rest.slice(1) } : null;
  if (rest !== '') return null;
  return { op: m[1] === 'o' ? 'open' : 'close', id };
}
