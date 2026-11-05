// A source read again (watch.ts reloadSource) is no network stall for the adaptive delay
// (apps/viewer/src/adaptive-delay.ts sourceReloaded). When the quality ladder falls back to the
// original quality, audio only reads its playlist again in place just as its ~2 s of buffer runs
// out: the element waits a few ms into the reload, 20-50 ms before the new read's first segment
// is appended. Taken for a stall, that wait was held 4 s, and only a seek ended the hold: on Linux
// WebKit the sound froze 3.9-4.1 s in about one ladder fallback in six (audio-only.spec "drops its
// last converted quality"; logged soak run 42131529290). Time is Vitest's fake clock (timers and
// performance.now).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playingAdaptiveDelay } from './player-doubles.js';

/** A viewer on a young ladder stream: about 2 s behind live, far under the Stable target, so a real stall holds. */
const LATENCY_S = 2;
/** Longer than the grace a seek gets (adaptive-delay.ts: 1.5 s). */
const AFTER_THE_GRACE_MS = 2000;

describe('attachAdaptiveDelay: a source read again', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the media running out right after it for the old read ending, not a stall: no hold, the target stays', () => {
    // Arrange
    const { video, delay } = playingAdaptiveDelay(LATENCY_S);
    const target = delay.target;
    video.bufferAhead(0);

    // Act
    delay.sourceReloaded();
    video.dispatchEvent(new Event('waiting'));

    // Assert
    expect(delay.holding).toBe(false);
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.paused).toBe(false);
    expect(delay.target).toBe(target);
    expect(delay.snapshot()).toMatchObject({ stalls: 0, holds: 0 });
  });

  it('ends a hold in progress and plays again', () => {
    // Arrange
    const { video, delay } = playingAdaptiveDelay(LATENCY_S);
    video.bufferAhead(0);
    video.dispatchEvent(new Event('waiting'));
    video.play.mockClear();

    // Act
    delay.sourceReloaded();

    // Assert
    expect(delay.holding).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
  });

  it('still counts a stall that comes once the new read plays', () => {
    // Arrange
    const { video, delay } = playingAdaptiveDelay(LATENCY_S);
    delay.sourceReloaded();
    vi.advanceTimersByTime(AFTER_THE_GRACE_MS);
    video.bufferAhead(0);

    // Act
    video.dispatchEvent(new Event('waiting'));

    // Assert
    expect(delay.holding).toBe(true);
    expect(delay.snapshot()).toMatchObject({ stalls: 1, holds: 1 });
  });
});
