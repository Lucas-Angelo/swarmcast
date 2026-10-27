/**
 * Stall watchdog: hls.js must never stay stuck with the playhead outside anything it will load.
 *
 * Normally hls.js recovers from a stall by itself (nudges, gap jumps, the live catch-up jump).
 * It cannot when a track's loader is stuck, or when the catch-up jump lands where one track has
 * nothing (e.g. before the oldest audio segment): the playhead then sits past the buffered range
 * and jumps forward again every liveMaxLatency − liveSyncDuration seconds, forever.
 *
 * Every second while playback is stalled (not paused, readyState < HAVE_FUTURE_DATA) and the
 * buffered ranges stop changing (a slow network that still delivers is left alone):
 * - after 4 s, seek into buffered data just ahead if there is some, else restart loading at the
 *   playhead (or at the live sync position if the playhead is outside the playlists' window);
 * - every 5 s after that, restart loading at the live sync position;
 * - after 4 attempts, reload the source.
 */

export interface StallSnapshot {
  /** How long playback has been stalled, ms (0 = playing or paused). */
  stalledMs: number;
  /** Recovery attempts made during this stall. */
  attempts: number;
  currentTime: number;
  buffered: Array<[number, number]>;
  /** hls.liveSyncPosition (already fitted into the playlists' window). */
  liveSyncPosition: number | null;
  /** Oldest position every playlist in use (video and audio) still offers. */
  windowStart: number | null;
}

export type StallAction = { action: 'wait' } | { action: 'seek'; to: number } | { action: 'restart'; to: number } | { action: 'reload' };

export const FIRST_ATTEMPT_MS = 4000;
/** Before anything was buffered (start, or after a reload) give the first segments more time. */
export const FIRST_ATTEMPT_AT_START_MS = 8000;
export const ATTEMPT_EVERY_MS = 5000;
export const MAX_ATTEMPTS = 4;

export function planStallRecovery(s: StallSnapshot): StallAction {
  const first = s.buffered.length === 0 ? FIRST_ATTEMPT_AT_START_MS : FIRST_ATTEMPT_MS;
  if (s.stalledMs < first + s.attempts * ATTEMPT_EVERY_MS) return { action: 'wait' };
  if (s.attempts >= MAX_ATTEMPTS) return { action: 'reload' };
  const ahead = s.buffered.find(([start, end]) => start > s.currentTime && start - s.currentTime < 6 && end - start > 1);
  if (ahead && s.attempts === 0) return { action: 'seek', to: ahead[0] + 0.05 };
  // (Also at start: hls.js can lose its first fragment to a stop/start race and wait forever
  // in FRAG_LOADING with nothing in flight; the playhead is then still at 0.)
  const outsideWindow = s.windowStart !== null && s.currentTime < s.windowStart + 1;
  const to = (s.attempts > 0 || outsideWindow) && s.liveSyncPosition !== null ? s.liveSyncPosition : s.currentTime;
  return { action: 'restart', to };
}

export interface StallPlayer {
  liveSyncPosition: number | null;
  stopLoad(): void;
  startLoad(position?: number): void;
}

export interface StallRecoveryOptions {
  video: HTMLVideoElement;
  hls: StallPlayer;
  windowStart(): number | null;
  reload(): void;
  log?(msg: string): void;
  isEnded?(): boolean;
  /**
   * Playback is paused on purpose inside a stall (adaptive delay, adaptive-delay.ts). The hold
   * neither starts nor resets the watchdog: it still counts as the stall it extends, so a player
   * that is really stuck is recovered on time, and one whose data keeps arriving is left alone.
   */
  isHeld?(): boolean;
}

function ranges(v: HTMLMediaElement): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < v.buffered.length; i++) out.push([v.buffered.start(i), v.buffered.end(i)]);
  return out;
}

/** Starts the watchdog; returns a function that stops it. */
export function installStallRecovery(o: StallRecoveryOptions): () => void {
  const { video, hls } = o;
  let since = 0;
  let attempts = 0;
  let lastRanges = '';
  const tick = (): void => {
    // Not paused = playback was asked for (autoplay or the viewer), so this covers the start too.
    const stalled = !o.isEnded?.() && (!video.paused || !!o.isHeld?.()) && !video.ended && video.readyState < 3;
    if (!stalled) {
      since = 0;
      attempts = 0;
      return;
    }
    const now = performance.now();
    const buffered = ranges(video);
    const signature = buffered.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(',');
    // Data still arriving: not stuck, just slow; restart the clock.
    if (since === 0 || signature !== lastRanges) since = now;
    lastRanges = signature;
    const plan = planStallRecovery({
      stalledMs: now - since,
      attempts,
      currentTime: video.currentTime,
      buffered,
      liveSyncPosition: hls.liveSyncPosition,
      windowStart: o.windowStart(),
    });
    if (plan.action === 'wait') return;
    attempts += 1;
    o.log?.(`stall recovery #${attempts}: ${plan.action}${'to' in plan ? ` to ${plan.to.toFixed(1)}` : ''} (t=${video.currentTime.toFixed(1)})`);
    if (plan.action === 'seek') {
      video.currentTime = plan.to;
    } else if (plan.action === 'restart') {
      hls.stopLoad();
      if (video.readyState > 0 && Math.abs(video.currentTime - plan.to) > 0.5) video.currentTime = plan.to;
      hls.startLoad(plan.to);
    } else {
      since = 0;
      attempts = 0;
      o.reload();
    }
  };
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}
