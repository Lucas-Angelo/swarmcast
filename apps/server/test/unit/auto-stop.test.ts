import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { LiveController } from '../../src/core/live.js';
import { manualClock, type ManualClock } from './helpers.js';
import { startController } from './live-helpers.js';

// Auto-stop: a live with no video from OBS for `autoStopMinutes` (default 10) turns everything off
// by itself. The live checks every AUTO_STOP_CHECK_MS on its own clock (LiveDeps.now): here a
// manual clock for "now", and fake intervals for the check, advanced by hand.
//
// Stops are serialized: `await live.stop()` waits for the stop the live started itself, and then
// returns at once. Only a real stop logs "stopped", so one "stopped" after "autoStop" proves that
// the live stopped by itself.

/** How often the live checks for video (live.ts, startTimers). */
const AUTO_STOP_CHECK_MS = 5000;

/** A started live (waiting for OBS) on a manual clock, its check interval fake. */
async function liveOnClock(): Promise<{ live: LiveController; clock: ManualClock; minutes: number }> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => void vi.useRealTimers());
  const clock = manualClock(Date.UTC(2026, 9, 26, 12));
  const { live } = await startController(undefined, { now: clock.now });
  return { live, clock, minutes: live.snapshot().settings.autoStopMinutes };
}

const autoStopped = (live: LiveController): boolean => live.activity.list().some((e) => e.code === 'log.autoStop');

describe('auto-stop without video', () => {
  it('is due autoStopMinutes after the start while no video came', async () => {
    // Arrange
    const { live, clock, minutes } = await liveOnClock();
    // Act
    const at = live.autoStopAt;
    // Assert
    expect(live.phase).toBe('waiting-obs');
    expect(at).toBe(clock.now() + minutes * 60_000);
  });

  it('a check before that leaves the live on', async () => {
    // Arrange
    const { live, clock, minutes } = await liveOnClock();
    // Act
    clock.advance(minutes * 60_000 - 1);
    vi.advanceTimersByTime(AUTO_STOP_CHECK_MS);
    // Assert
    expect(autoStopped(live)).toBe(false);
    expect(live.phase).toBe('waiting-obs');
  });

  it('the first check once it is due stops everything, and says why', async () => {
    // Arrange
    const { live, clock, minutes } = await liveOnClock();
    // Act
    clock.advance(minutes * 60_000);
    vi.advanceTimersByTime(AUTO_STOP_CHECK_MS);
    await live.stop();
    // Assert
    expect(live.activity.list().find((e) => e.code === 'log.autoStop')).toMatchObject({ level: 'warn', params: { minutes } });
    const codes = live.activity.list().map((e) => e.code);
    expect(codes.filter((c) => c === 'log.stopped')).toHaveLength(1);
    expect(codes.indexOf('log.autoStop')).toBeLessThan(codes.indexOf('log.stopped'));
    expect(live.phase).toBe('off');
  });
});
