// The buffer trend the adaptive delay measures (apps/viewer/src/adaptive-delay.ts feeding
// latency-controller.ts): on a live stream whose buffer always reaches the end of the playlist,
// the gap between the two never grows, so the trend must stay flat whatever playback does.
// It used to be the 5-sample median of hls.latency minus the buffer of the current second: the
// median trails the playhead, so catching up (1.5× with the E2E flags), and a playlist reload
// that lists two segments at once (the reload before came 30 ms too early for the newest one:
// hls.latency jumps by a segment, the buffer by two), read as a gap growing at up to +0.2 s/s.
// adaptive-delay.spec.ts on WebKit (macOS runner, 30 Mbps, no stall) then called the network
// unstable (pipeline run 41136895016); in passing runs the same trend reached +0.18 s/s and
// ended "firm" early. Both the E2E clock and rate flags are on here, as in that spec.
// The live edge is also the earliest of the playlists in use: the server's audio rendition has its
// own playlist, which hls.js reloads on its own timer, and the element plays only what both tracks
// have buffered. After a reload that found two segments at once, hls.js reloads the then unchanged
// video playlist half a target duration later, and for a while reads it 1 s before the audio one.
// Measured from the video playlist alone, the gap grew by 1 s there: a trend of +0.12 s/s that
// ended "firm" (Chromium, macOS, soak run 41940729001) and +0.15 s/s, called unstable (WebKit,
// Linux, pipeline run 41689801511), on a 30 Mbps link.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TUNING } from '../../src/latency-controller.js';
import { FakeLiveStream, LIVE_SEGMENT_S } from './player-doubles.js';

/** The E2E flags of adaptive-delay.spec.ts (`?delaySpeed=10&delayRate=10`). */
const E2E_FLAGS = { speed: 10, rateScale: 10 };
/** Where adaptive-delay.spec.ts starts watching: ~20 s behind live. */
const START_DELAY_S = 20;
/** Long enough to go firm, catch up to below 15 s and settle (the spec allows 2 min). */
const PLAY_S = 60;
/** How far a segment's listing is from the reload that would find it (encoder timing jitter). */
const JITTER_S = 0.03;

/** Each segment is listed just after the reload on its boundary (a reload 2 s later finds it) until `shiftAtS`, then just before it. */
const listedAround = (shiftAtS: number) => (k: number): number => {
  const end = (k + 1) * LIVE_SEGMENT_S;
  return end < shiftAtS ? end + JITTER_S : end - JITTER_S;
};
/** How much earlier the video playlist is reloaded once the two fall out of step: half a target duration. */
const VIDEO_LEAD_S = LIVE_SEGMENT_S / 2;
/** Each segment is listed just before the reload half a segment after its media ends: the reload of each playlist then finds it, at either phase. */
const listedLate = (k: number): number => (k + 1) * LIVE_SEGMENT_S + VIDEO_LEAD_S - JITTER_S;

describe('attachAdaptiveDelay: the buffer trend on a steady live stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['every reload finds one segment', Infinity],
    ['a reload finds two segments as the player starts', 3],
    ['a reload finds two segments while it catches up', 9],
    ['a reload finds two segments once it caught up', 15],
  ])('%s: the trend stays flat, the network firm, and the delay drifts below 15 s', (_name, shiftAtS) => {
    // Arrange
    const stream = new FakeLiveStream({ ...E2E_FLAGS, startDelayS: START_DELAY_S, publishedAt: listedAround(shiftAtS) });

    // Act
    const seconds = stream.play(PLAY_S);

    // Assert
    const slopes = seconds.map((s) => s.signals?.lagSlope ?? 0);
    expect(Math.max(...slopes.map(Math.abs))).toBeLessThanOrEqual(TUNING.stable.firm.maxLagSlope);
    expect(seconds.filter((s) => s.state === 'unstable')).toEqual([]);
    expect(seconds.findIndex((s) => s.state === 'firm')).toBeGreaterThan(0);
    expect(seconds.slice(seconds.findIndex((s) => s.state === 'firm')).every((s) => s.state === 'firm')).toBe(true);
    expect(Math.max(...seconds.map((s) => s.playbackRate))).toBe(1.5);
    expect(seconds.at(-1)!.delay!).toBeLessThan(15);
  });

  it.each([
    ['the start', 3],
    ['the catch-up', 9],
    ['the end of the catch-up', 15],
  ])('the video playlist is read 1 s before the audio one from %s on: the trend stays flat, the network firm, and the delay drifts below 15 s', (_name, videoLeadFromS) => {
    // Arrange
    const stream = new FakeLiveStream({ ...E2E_FLAGS, startDelayS: START_DELAY_S, publishedAt: listedLate, audio: { videoLeadFromS, leadS: VIDEO_LEAD_S } });

    // Act
    const seconds = stream.play(PLAY_S);

    // Assert
    const slopes = seconds.map((s) => s.signals?.lagSlope ?? 0);
    expect(Math.max(...slopes.map(Math.abs))).toBeLessThanOrEqual(TUNING.stable.firm.maxLagSlope);
    expect(seconds.filter((s) => s.state === 'unstable')).toEqual([]);
    expect(seconds.findIndex((s) => s.state === 'firm')).toBeGreaterThan(0);
    expect(seconds.slice(seconds.findIndex((s) => s.state === 'firm')).every((s) => s.state === 'firm')).toBe(true);
    expect(seconds.at(-1)!.delay!).toBeLessThan(15);
  });
});
