/**
 * Live-delay bounds shared by the viewer player and the server (docs/QUALITY.md, "Adaptive delay").
 *
 * The server's live playlists must always reach back further than any player sits behind live,
 * or a player that fell behind is pushed off the playlist. MAX_PLAYER_DELAY_S (constants.ts) is
 * that limit and sizes every playlist window (PLAYLIST_WINDOW_S); the viewer's adaptive delay
 * controller (apps/viewer/src/latency-controller.ts) derives its upper bound from it, so the delay
 * can never grow past the playlist window. The highest target plus hls.js' stall increase
 * (PLAYER_STALL_INCREASE_S) stays below MAX_PLAYER_DELAY_S (unit tested).
 */
import { MAX_PLAYER_DELAY_S, SEGMENT_DURATION_S } from './constants.js';

/**
 * Room kept between the highest adaptive target and MAX_PLAYER_DELAY_S: one long stall (6 s) at
 * the highest target still stays inside the window instead of making hls.js jump.
 */
export const ADAPTIVE_DELAY_HEADROOM_S = 3 * SEGMENT_DURATION_S;

export interface AdaptiveDelayBounds {
  /** Where every viewer starts (the profile's fixed delay before v0.2.1). */
  initial: number;
  /** Lowest target on a firm network. */
  min: number;
  /** Lowest target while this viewer gets video from peers (leaves time for peers to share). */
  p2pMin: number;
  /** Highest target on an unstable network. */
  max: number;
}

/** Target delay bounds per playback profile, seconds behind live. */
export const ADAPTIVE_DELAY: Record<'stable' | 'low-delay', AdaptiveDelayBounds> = {
  stable: { initial: 20, min: 10, p2pMin: 12, max: Math.min(30, MAX_PLAYER_DELAY_S - ADAPTIVE_DELAY_HEADROOM_S) },
  'low-delay': { initial: 8, min: 6, p2pMin: 6, max: Math.min(10, MAX_PLAYER_DELAY_S - ADAPTIVE_DELAY_HEADROOM_S) },
};
