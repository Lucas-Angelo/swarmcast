/**
 * The playback monitor the E2E specs run inside the page (fixtures.ts startStallMonitor): one
 * sample about every 200 ms. Kept free of imports and outer references, because fixtures.ts
 * injects its source into the page; unit tested in apps/server/test/unit/stall-monitor.test.ts.
 */

export interface StallState {
  /** Playhead and time (ms) at the previous sample. */
  prev: number;
  prevNow: number;
  /** When the current freeze began (or the last sample that played). */
  at: number;
  /** Longest freeze so far, ms. */
  max: number;
  /** Seconds of media played: playback steps only. */
  played: number;
  /** The last sample was frozen. */
  frozen: boolean;
}

export interface StallSample {
  now: number;
  currentTime: number;
  paused: boolean;
  /** The adaptive delay holds playback inside a stall: the viewer sees a freeze. */
  held: boolean;
}

/** Fastest playback a step can be (the adaptive delay's catch-up is at most 1.1x), plus slack. */
const MAX_RATE = 1.5;
const SLACK_S = 0.3;

/**
 * Playing means the playhead advanced like playback since the previous sample: more than a
 * nudge, and no more than the time that passed allows (timers fire late on a loaded runner, so
 * the step is measured against the real interval). A jump is not playback, whichever way it
 * goes: the stall watchdog seeking to buffered data or to the live position, a source reload
 * starting the timeline over. The old monitor took a forward jump for playback and capped each
 * step at 1 s: the watchdog's own seek made a frozen player look recovered (linux-docker arm64,
 * job 122719989311), and late timer ticks on a macOS runner lost a third of what played (job
 * 122719928808: 11.9 s of 20 counted while video and audio segments kept arriving).
 */
export function stallTick(st: StallState, s: StallSample): void {
  const step = s.currentTime - st.prev;
  const dt = Math.max(0, (s.now - st.prevNow) / 1000);
  st.prev = s.currentTime;
  st.prevNow = s.now;
  const playing = step > 0.05 && step <= MAX_RATE * dt + SLACK_S;
  if (playing) st.played += step;
  if ((s.paused && !s.held) || playing) {
    st.at = s.now;
    st.frozen = false;
  } else {
    st.frozen = true;
    st.max = Math.max(st.max, s.now - st.at);
  }
}

/** The freeze going on right now, ms (0 when the last sample played or the viewer paused). */
export function currentStall(st: StallState, now: number): number {
  return st.frozen ? now - st.at : 0;
}
