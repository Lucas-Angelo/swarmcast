import { describe, expect, it } from 'vitest';
import { currentStall, stallTick, type StallState } from '../e2e/stall-monitor.js';

// The playback monitor the E2E specs run inside the page (stall-monitor.ts), on recorded runs:
// - job 122719989311 (linux-docker arm64): the player froze at 40 s for 19 s, the stall watchdog
//   restarted it at the live position (+6 s jump), the player stayed frozen there, and 5 s later
//   the watchdog reloaded the source (back to 0). Those seeks are not a recovery.
// - job 122719928808 (macOS): timer ticks came 1–2 s apart on a loaded runner, and the old monitor
//   lost a third of what played.
// - fixtures.ts injects the functions' source into the page: a constant left outside the
//   function was undefined there, and nothing ever "played".

/** Sample interval of the monitor in the page, ms. */
const EVERY_MS = 200;

/** Feed `count` samples `every` ms apart from `from` on; `pos(i)` is the playhead at sample i. Returns the last sample's time. */
function run(st: StallState, from: number, count: number, pos: (i: number) => number, o: { paused?: boolean; held?: boolean; every?: number } = {}): number {
  let now = from;
  for (let i = 0; i < count; i++) {
    now = from + i * (o.every ?? EVERY_MS);
    stallTick(st, { now, currentTime: pos(i), paused: !!o.paused, held: !!o.held });
  }
  return now;
}

/** A monitor that just started, with the playhead at `t` seconds. */
const fresh = (t: number, now = 0): StallState => ({ prev: t, prevNow: now, at: now, max: 0, played: 0, frozen: false });

/** The playhead advancing at 1×, one sample interval per sample, from `t0` seconds on. */
const playingFrom = (t0: number) => (i: number) => t0 + (i + 1) * (EVERY_MS / 1000);

/** Frozen at 40 s for 19 s, then the watchdog's live restart (+6 s, still frozen) and its source reload (to 0.5 s). */
function frozenThroughWatchdogSeeks(): { st: StallState; now: number; stallAt: number[] } {
  const st = fresh(40);
  const stallAt: number[] = [];
  let now = run(st, EVERY_MS, 95, () => 40);
  stallAt.push(currentStall(st, now));
  now = run(st, now + EVERY_MS, 25, () => 46);
  stallAt.push(currentStall(st, now));
  now = run(st, now + EVERY_MS, 5, () => 0.5);
  stallAt.push(currentStall(st, now));
  return { st, now, stallAt };
}

describe('E2E stall monitor (stall-monitor.ts)', () => {
  it('playback at 1x is playing; its seconds count as played', () => {
    // Arrange
    const st = fresh(10);
    // Act
    const now = run(st, EVERY_MS, 50, playingFrom(10));
    // Assert
    expect(currentStall(st, now)).toBe(0);
    expect(st.max).toBe(0);
    expect(st.played).toBeCloseTo(10, 5);
  });

  it("the stall watchdog's seeks while the player is still frozen are not a recovery (job 122719989311)", () => {
    // Act
    const { st, stallAt } = frozenThroughWatchdogSeeks();
    // Assert
    expect(stallAt[0]).toBeGreaterThan(18_000);
    expect(stallAt[1]).toBeGreaterThan(23_000);
    expect(stallAt[2]).toBeGreaterThan(24_000);
    expect(st.played).toBe(0);
  });

  it('playing again ends the freeze and keeps its length as the longest', () => {
    // Arrange
    const { st, now: frozenUntil } = frozenThroughWatchdogSeeks();
    // Act
    const now = run(st, frozenUntil + EVERY_MS, 10, playingFrom(0.5));
    // Assert
    expect(currentStall(st, now)).toBe(0);
    expect(st.max).toBeGreaterThan(24_000);
    expect(st.played).toBeCloseTo(2, 5);
  });

  it('late timer ticks on a loaded runner (1-2 s apart) still count everything that played (job 122719928808)', () => {
    // Arrange
    const st = fresh(10);
    let now = 0;
    let t = 10;
    // Act
    for (const gap of [200, 1500, 200, 2000, 900, 1800, 200, 200, 1200, 2000]) {
      now += gap;
      t += gap / 1000;
      stallTick(st, { now, currentTime: t, paused: false, held: false });
    }
    // Assert
    expect(st.played).toBeCloseTo(10.2, 5);
    expect(st.max).toBe(0);
    expect(currentStall(st, now)).toBe(0);
  });

  it('works from its source alone, as fixtures.ts injects it into the page (no outer references)', () => {
    // Arrange
    const tick = new Function(`return ${stallTick.toString()}`)() as typeof stallTick;
    const stall = new Function(`return ${currentStall.toString()}`)() as typeof currentStall;
    const st = fresh(10);
    let now = 0;
    // Act
    for (let i = 1; i <= 10; i++) {
      now = i * EVERY_MS;
      tick(st, { now, currentTime: 10 + i * 0.2, paused: false, held: false });
    }
    // Assert
    expect(st.played).toBeCloseTo(2, 5);
    expect(stall(st, now)).toBe(0);
  });

  it('a viewer pause is not a freeze', () => {
    // Arrange
    const paused = fresh(10);
    // Act
    const now = run(paused, EVERY_MS, 20, () => 10, { paused: true });
    // Assert
    expect(currentStall(paused, now)).toBe(0);
  });

  it('an adaptive-delay hold is a freeze (the viewer sees one)', () => {
    // Arrange
    const held = fresh(10);
    // Act
    const now = run(held, EVERY_MS, 20, () => 10, { paused: true, held: true });
    // Assert
    expect(currentStall(held, now)).toBeGreaterThan(3500);
  });
});
