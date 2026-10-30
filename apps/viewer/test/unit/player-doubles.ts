// Test doubles for the player around the adaptive delay (apps/viewer/src/adaptive-delay.ts): the
// parts of <video> it reads and drives, and an attached delay already playing.
import { vi } from 'vitest';
import type Hls from 'hls.js';
import { attachAdaptiveDelay } from '../../src/adaptive-delay.js';

/** The parts of <video> the adaptive delay reads and drives. Buffered: one range, set with bufferAhead(). */
export class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  currentTime = 0;
  playbackRate = 1;
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 };
  readonly play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });

  /** Media buffered from the start of the stream to `seconds` past the playhead. */
  bufferAhead(seconds: number): void {
    const end = this.currentTime + seconds;
    this.buffered = { length: 1, start: () => 0, end: () => end };
  }
}

/** The adaptive delay (Stable profile) on a FakeVideo that is playing, `latency` s behind live. */
export function playingAdaptiveDelay(latency: number): { video: FakeVideo; delay: ReturnType<typeof attachAdaptiveDelay> } {
  const hls = { on: () => {}, latency, bandwidthEstimate: 0, levels: [], currentLevel: -1, config: { liveSyncDuration: 20 }, targetLatency: 20 };
  const video = new FakeVideo();
  const delay = attachAdaptiveDelay(hls as unknown as Parameters<typeof attachAdaptiveDelay>[0], null, video as unknown as HTMLVideoElement, {
    profile: 'stable',
    events: { FRAG_LOADED: 'hlsFragLoaded' } as unknown as typeof Hls.Events,
    p2pEnabled: () => false,
  });
  void video.play();
  video.dispatchEvent(new Event('playing'));
  return { video, delay };
}
