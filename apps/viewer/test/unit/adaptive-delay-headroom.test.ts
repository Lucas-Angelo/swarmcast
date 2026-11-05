// The bandwidth headroom the adaptive delay measures (apps/viewer/src/adaptive-delay.ts feeding
// latency-controller.ts) as a player starts on a fast link. Until hls.js has timed a segment, which
// it does when the first one is buffered (abr-controller onFragBuffered), not when it is loaded,
// hls.bandwidthEstimate is its starting guess (abrEwmaDefaultEstimate: the last visit's estimate
// or 2 Mbps, player-config.ts). That guess used to go into the headroom statistics as if
// measured: 2 Mbps over a 1.28 Mbps rendition is a headroom of 1.57 next to the measured 4 (the
// cap), and two such ticks kept its coefficient of variation at 0.39 in a 60 s window, above the
// "unstable" threshold (0.35). adaptive-delay.spec.ts (Chromium on a macOS runner, the first segment
// buffered 1.2 s after its download) then called a 30 Mbps link unstable for its first 5 s
// (pipeline run 41936649478). In real time, a 6 Mbps rendition behind the 2 Mbps guess does the
// same for a viewer whose first segment takes 2 s to buffer: it raised their delay for ~40 s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TUNING } from '../../src/latency-controller.js';
import { FakePlayerStart, type PlayerStartScript } from './player-doubles.js';

/** The E2E flags of adaptive-delay.spec.ts (`?delaySpeed=10&delayRate=10`). */
const E2E_FLAGS = { speed: 10, rateScale: 10 };
/** hls.js' starting guess without a saved estimate (player-config.ts). */
const FIRST_GUESS_BPS = 2_000_000;
/** Long enough for the startup samples to leave any dwell time behind (real-time unstable.enterS is 5 s). */
const PLAY_S = 60;

interface HeadroomSignals {
  headroom: number | null;
  headroomCov: number | null;
}

const SCRIPTS: Array<[string, PlayerStartScript]> = [
  [
    'the E2E clock, the test stream on 30 Mbps, first segment buffered 2.5 s after its download',
    { ...E2E_FLAGS, guessBps: FIRST_GUESS_BPS, measuredBps: 17_000_000, renditionBps: 1_276_000, bufferedAfterS: 2.5 },
  ],
  ['real time, a 6 Mbps rendition on 40 Mbps, first segment buffered 2 s after its download', { guessBps: FIRST_GUESS_BPS, measuredBps: 40_000_000, renditionBps: 6_000_000, bufferedAfterS: 2 }],
  ['real time, a 6 Mbps rendition, a slow link saved from the last visit', { guessBps: 3_000_000, measuredBps: 40_000_000, renditionBps: 6_000_000, bufferedAfterS: 2 }],
];

describe('attachAdaptiveDelay: bandwidth headroom while the player starts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SCRIPTS)('%s: no headroom before hls.js measured one', (_name, script) => {
    // Arrange
    const player = new FakePlayerStart(script);

    // Act
    const seconds = player.play(script.bufferedAfterS);

    // Assert
    expect(seconds.map((s) => (s.signals as HeadroomSignals | null)?.headroom ?? null)).toEqual(seconds.map(() => null));
  });

  it.each(SCRIPTS)('%s: the network never looks unstable and its headroom stays steady', (_name, script) => {
    // Arrange
    const player = new FakePlayerStart(script);

    // Act
    const seconds = player.play(PLAY_S);

    // Assert
    expect(seconds.filter((s) => s.state === 'unstable')).toEqual([]);
    const covs = seconds.map((s) => (s.signals as HeadroomSignals | null)?.headroomCov ?? 0);
    expect(Math.max(...covs)).toBeLessThanOrEqual(TUNING.stable.firm.maxCov);
  });
});
