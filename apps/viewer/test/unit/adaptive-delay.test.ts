// The adaptive delay's hold inside a stall (adaptive-delay.ts): playback frozen by a stall is kept
// frozen a little longer so the delay reaches its new target at once, then plays again by itself.
// A profile switch during the hold must play again: it used to only clear the hold and leave the
// video paused for good under "Buffering…" (quality.spec in Docker: a source reload met a hold,
// "Lower delay" came a few ms later, and nothing else resumes a paused video). Time is Vitest's
// fake clock (timers and performance.now), so the hold lasts exactly its fake seconds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Hls from 'hls.js';
import { attachAdaptiveDelay } from '../../src/adaptive-delay.js';

/** Seconds behind live in the setup: well under the stable profile's target, so a stall holds. */
const LOW_LATENCY_S = 5;
/** Longer than any hold of the stable profile. */
const LONGER_THAN_A_HOLD_MS = 5000;

/** The parts of <video> the adaptive delay reads and drives. */
class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  currentTime = 0;
  playbackRate = 1;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  readonly play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
}

/** The adaptive delay on a video that is playing (stable profile, no P2P), `play` calls not yet counted. */
function playing(): { video: FakeVideo; delay: ReturnType<typeof attachAdaptiveDelay> } {
  const hls = { on: () => {}, latency: LOW_LATENCY_S, bandwidthEstimate: 0, levels: [], currentLevel: -1, config: { liveSyncDuration: 20 }, targetLatency: 20 };
  const video = new FakeVideo();
  const delay = attachAdaptiveDelay(hls as unknown as Parameters<typeof attachAdaptiveDelay>[0], null, video as unknown as HTMLVideoElement, {
    profile: 'stable',
    events: { FRAG_LOADED: 'hlsFragLoaded' } as unknown as typeof Hls.Events,
    p2pEnabled: () => false,
  });
  void video.play();
  video.dispatchEvent(new Event('playing'));
  video.play.mockClear();
  return { video, delay };
}

/** playing(), then a stall: the controller holds playback. */
function holding() {
  const s = playing();
  s.video.dispatchEvent(new Event('waiting'));
  return s;
}

describe('attachAdaptiveDelay: the hold inside a stall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses inside a stall', () => {
    // Arrange
    const { video, delay } = playing();

    // Act
    video.dispatchEvent(new Event('waiting'));

    // Assert
    expect(delay.holding).toBe(true);
    expect(video.paused).toBe(true);
  });

  it('plays again by itself when the hold is over', () => {
    // Arrange
    const { video, delay } = holding();

    // Act
    vi.advanceTimersByTime(LONGER_THAN_A_HOLD_MS);

    // Assert
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(delay.holding).toBe(false);
    expect(video.paused).toBe(false);
  });

  it('a profile switch during the hold plays again at once', () => {
    // Arrange
    const { video, delay } = holding();

    // Act
    delay.setProfile('low-delay');

    // Assert
    expect(delay.holding).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
  });

  it('the hold a profile switch ended does not fire later', () => {
    // Arrange
    const { video, delay } = holding();
    delay.setProfile('low-delay');

    // Act
    vi.advanceTimersByTime(2 * LONGER_THAN_A_HOLD_MS);

    // Assert
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('a profile switch without a hold leaves playback alone (a viewer pause stays a pause)', () => {
    // Arrange
    const { video, delay } = playing();
    video.pause();

    // Act
    delay.setProfile('low-delay');

    // Assert
    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
  });
});
