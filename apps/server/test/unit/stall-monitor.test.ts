import { describe, expect, it } from 'vitest';
import { currentStall, stallTick, type StallState } from '../e2e/stall-monitor.js';

/** Feed samples every `every` ms (200 by default); `pos(i)` is the playhead at sample i. */
function run(st: StallState, from: number, count: number, pos: (i: number) => number, o: { paused?: boolean; held?: boolean; every?: number } = {}): number {
  let now = from;
  for (let i = 0; i < count; i++) {
    now = from + i * (o.every ?? 200);
    stallTick(st, { now, currentTime: pos(i), paused: !!o.paused, held: !!o.held });
  }
  return now;
}

const fresh = (t: number, now = 0): StallState => ({ prev: t, prevNow: now, at: now, max: 0, played: 0, frozen: false });

describe('E2E stall monitor (stall-monitor.ts)', () => {
  it('playback at 1x is playing; its seconds count as played', () => {
    const st = fresh(10);
    const now = run(st, 200, 50, (i) => 10 + (i + 1) * 0.2);
    expect(currentStall(st, now)).toBe(0);
    expect(st.max).toBe(0);
    expect(st.played).toBeCloseTo(10, 5);
  });

  it("the stall watchdog's seeks while the player is still frozen are not a recovery (job 122719989311)", () => {
    // Frozen at 40 s for 19 s, then the watchdog restarts at the live position (+6 s jump), the
    // player stays frozen there, and 5 s later the watchdog reloads the source (back to 0).
    const st = fresh(40);
    let now = run(st, 200, 95, () => 40);
    expect(currentStall(st, now)).toBeGreaterThan(18_000);
    now = run(st, now + 200, 25, () => 46);
    expect(currentStall(st, now)).toBeGreaterThan(23_000);
    now = run(st, now + 200, 5, () => 0.5);
    expect(currentStall(st, now)).toBeGreaterThan(24_000);
    expect(st.played).toBe(0);
    // Playing again: the freeze is over, and its length is kept as the longest.
    now = run(st, now + 200, 10, (i) => 0.5 + (i + 1) * 0.2);
    expect(currentStall(st, now)).toBe(0);
    expect(st.max).toBeGreaterThan(24_000);
    expect(st.played).toBeCloseTo(2, 5);
  });

  it('late timer ticks on a loaded runner (1-2 s apart) still count everything that played (job 122719928808)', () => {
    const st = fresh(10);
    let now = 0;
    let t = 10;
    for (const gap of [200, 1500, 200, 2000, 900, 1800, 200, 200, 1200, 2000]) {
      now += gap;
      t += gap / 1000;
      stallTick(st, { now, currentTime: t, paused: false, held: false });
    }
    expect(st.played).toBeCloseTo(10.2, 5);
    expect(st.max).toBe(0);
    expect(currentStall(st, now)).toBe(0);
  });

  it('a viewer pause is not a freeze; an adaptive-delay hold is', () => {
    const paused = fresh(10);
    expect(currentStall(paused, run(paused, 200, 20, () => 10, { paused: true }))).toBe(0);
    const held = fresh(10);
    expect(currentStall(held, run(held, 200, 20, () => 10, { paused: true, held: true }))).toBeGreaterThan(3500);
  });
});
