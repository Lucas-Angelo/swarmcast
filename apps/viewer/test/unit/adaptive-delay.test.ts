import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Hls from 'hls.js';
import { attachAdaptiveDelay } from '../../src/adaptive-delay.js';

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

function setup(latency: number): { video: FakeVideo; delay: ReturnType<typeof attachAdaptiveDelay> } {
  const hls = { on: () => {}, latency, bandwidthEstimate: 0, levels: [], currentLevel: -1, config: { liveSyncDuration: 20 }, targetLatency: 20 };
  const video = new FakeVideo();
  const delay = attachAdaptiveDelay(hls as unknown as Parameters<typeof attachAdaptiveDelay>[0], null, video as unknown as HTMLVideoElement, {
    profile: 'stable',
    events: { FRAG_LOADED: 'hlsFragLoaded' } as unknown as typeof Hls.Events,
    p2pEnabled: () => false,
  });
  // Playing, then a stall well under the stable target: the controller holds playback.
  void video.play();
  video.dispatchEvent(new Event('playing'));
  return { video, delay };
}

describe('attachAdaptiveDelay: the hold inside a stall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses inside a stall and plays again by itself', () => {
    const { video, delay } = setup(5);
    video.dispatchEvent(new Event('waiting'));
    expect(delay.holding).toBe(true);
    expect(video.paused).toBe(true);
    video.play.mockClear();
    vi.advanceTimersByTime(5000);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(delay.holding).toBe(false);
    expect(video.paused).toBe(false);
  });

  it('a profile switch during the hold plays again (it used to leave the video paused for good)', () => {
    // quality.spec in Docker: a source reload met a hold, "Lower delay" came a few ms later,
    // and the video stayed paused under "Buffering…" (nothing else resumes a paused video).
    const { video, delay } = setup(5);
    video.dispatchEvent(new Event('waiting'));
    expect(delay.holding).toBe(true);
    video.play.mockClear();
    delay.setProfile('low-delay');
    expect(delay.holding).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
    // The cancelled hold timer does not fire later.
    vi.advanceTimersByTime(10_000);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('a profile switch without a hold leaves playback alone (a viewer pause stays a pause)', () => {
    const { video, delay } = setup(5);
    video.pause();
    video.play.mockClear();
    delay.setProfile('low-delay');
    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
  });
});
