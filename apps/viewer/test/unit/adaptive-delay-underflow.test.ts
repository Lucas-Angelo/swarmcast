// Which `waiting` events the adaptive delay (apps/viewer/src/adaptive-delay.ts) treats as a network
// stall. Only those where the media ran out (less than STARVED_BELOW_S buffered ahead) raise the
// target and hold playback. With more buffered, the browser's decoder or renderer fell behind on
// a busy machine: Chrome on the 3-vCPU macOS CI runners froze 2.6–3.0 s in 7 of 68 twenty-second
// windows with ~20 s buffered (chat-flood soak data), which was exactly this 3 s hold.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARVED_BELOW_S } from '../../src/adaptive-delay.js';
import { playingAdaptiveDelay } from './player-doubles.js';

/** Stable plays ~20 s behind live. */
const LATENCY_S = 20;

describe('attachAdaptiveDelay: a waiting with media buffered ahead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([STARVED_BELOW_S, 5, 20])('is not a stall with %s s buffered ahead: playback goes on and the target stays', (ahead) => {
    // Arrange
    const { video, delay } = playingAdaptiveDelay(LATENCY_S);
    const target = delay.target;
    video.bufferAhead(ahead);

    // Act
    video.dispatchEvent(new Event('waiting'));

    // Assert
    expect(delay.holding).toBe(false);
    expect(video.pause).not.toHaveBeenCalled();
    expect(delay.target).toBe(target);
    expect(delay.snapshot()).toMatchObject({ stalls: 0, holds: 0 });
  });

  it.each([0, 0.5, STARVED_BELOW_S - 0.01])('is a stall with %s s buffered ahead: the target rises and playback is held', (ahead) => {
    // Arrange
    const { video, delay } = playingAdaptiveDelay(LATENCY_S);
    const target = delay.target;
    video.bufferAhead(ahead);

    // Act
    video.dispatchEvent(new Event('waiting'));

    // Assert
    expect(delay.holding).toBe(true);
    expect(video.paused).toBe(true);
    expect(delay.target).toBeGreaterThan(target);
    expect(delay.snapshot()).toMatchObject({ stalls: 1, holds: 1 });
  });
});
