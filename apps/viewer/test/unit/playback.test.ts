// Player configuration and the stall watchdog (player-config.ts, stall-recovery.ts). Background:
// - ladders from v0.2.0 and older serve a 20 s audio playlist next to a 40 s video one, so the
//   delay must fit the shorter one (target + the one target duration hls.js adds after stalls stays
//   inside the window);
// - after the stall watchdog's reload, hls.js loaded the 40 s video playlist before the 20 s audio
//   one; read as "no mismatch", the ceiling went and the restart landed 14 s before the oldest audio
//   segment, so the windows measured before must still hold until both are in;
// - at stream start both playlists are short and grow, refreshed at different moments: no
//   mismatch is read from that;
// - the watchdog's own seeks are not playback (job 122719989311: a player frozen after them was
//   never reloaded), hls.js nudging the playhead by 0.1-0.3 s does not hide a stall, and a stall
//   that is ending is not reloaded (barely-delivers on CI, 9 of 20 runs).
// The watchdog runs on Vitest's fake clock (its 1 s ticks and performance.now), on a fake <video>.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PLAYER_LIVE_DELAYS, PLAYLIST_WINDOW_S, SEGMENT_DURATION_S } from '@swarmcast/shared';
import { latencyFor, mismatchWindow, playlistsKnown, PROFILES, urgentSecondsFor } from '../../src/player-config.js';
import { installStallRecovery, planStallRecovery, type StallRecoveryOptions, type StallSnapshot } from '../../src/stall-recovery.js';

const PROFILE_IDS = ['stable', 'low-delay'] as const;
/** A playlist's duration and target duration, as hls.js reports them. */
const playlist = (totalduration: number, targetduration: number) => ({ totalduration, targetduration });

describe('latencyFor', () => {
  it.each(PROFILE_IDS)('%s: uses the delays the server sizes its playlists from, untouched in a full window', (id) => {
    // Act
    const fit = latencyFor(id, { windowS: PLAYLIST_WINDOW_S, targetDurationS: SEGMENT_DURATION_S });

    // Assert
    expect({ liveSyncDuration: PROFILES[id].liveSyncDuration, liveMaxLatencyDuration: PROFILES[id].liveMaxLatencyDuration }).toEqual(PLAYER_LIVE_DELAYS[id]);
    expect(fit).toEqual(PLAYER_LIVE_DELAYS[id]);
  });

  it.each([
    ['stable', { liveSyncDuration: 20, liveMaxLatencyDuration: 36 }],
    ['low-delay', { liveSyncDuration: 8, liveMaxLatencyDuration: 20 }],
  ] as const)('%s keeps its delays when every playlist holds 40 s', (id, delays) => {
    // Act
    const fit = latencyFor(id, { windowS: 40, targetDurationS: 2 });

    // Assert
    expect(fit).toEqual(delays);
  });

  it('keeps the profile when the windows are not known', () => {
    // Act
    const fit = latencyFor('stable', null);

    // Assert
    expect(fit).toEqual({ liveSyncDuration: PROFILES.stable.liveSyncDuration, liveMaxLatencyDuration: PROFILES.stable.liveMaxLatencyDuration });
  });

  it.each([19.99, 20, 20.01])('stable fits into a %s s audio playlist (ladder from v0.2.0 and older): the catch-up jump lands inside it', (windowS) => {
    // Act
    const fit = latencyFor('stable', { windowS, targetDurationS: 2 });

    // Assert
    expect(fit).toEqual({ liveSyncDuration: 12, liveMaxLatencyDuration: 16 });
    expect(fit.liveSyncDuration + 2).toBeLessThan(windowS - 2);
  });

  it('low-delay fits into a 20 s audio playlist', () => {
    // Act
    const fit = latencyFor('low-delay', { windowS: 20, targetDurationS: 2 });

    // Assert
    expect(fit).toEqual({ liveSyncDuration: 8, liveMaxLatencyDuration: 16 });
  });

  it('never goes below a sane floor on very short playlists (stream just started)', () => {
    // Act
    const fit = latencyFor('stable', { windowS: 4, targetDurationS: 2 });

    // Assert
    expect(fit).toEqual({ liveSyncDuration: 4, liveMaxLatencyDuration: 8 });
  });
});

describe('playlistsKnown', () => {
  const d = playlist(20, 2);

  it.each([
    ['not known: a mismatch was measured and only the video playlist is in (a source reload loads it first)', true, { video: d }, false],
    ['not known: a mismatch was measured and no playlist is in yet', true, {}, false],
    ['known: a mismatch was measured and both playlists are in', true, { video: d, audio: d }, true],
    ['known: no mismatch was measured and the video playlist is in', false, { video: d }, true],
  ])('%s', (_case, measured, details, known) => {
    // Act
    const got = playlistsKnown(measured, details);

    // Assert
    expect(got).toBe(known);
  });
});

describe('mismatchWindow', () => {
  it('fits when the audio playlist covers less than the video one', () => {
    // Act
    const fit = mismatchWindow(playlist(40, 2), playlist(20, 1));

    // Assert
    expect(fit).toEqual({ windowS: 20, targetDurationS: 2 });
  });

  it.each([
    ['both playlists cover the same', playlist(40, 2), playlist(40, 1)],
    ['the stream just started (both short, refreshed at different moments)', playlist(10, 2), playlist(9.5, 1)],
    ['the stream just started, 6 s and 4 s', playlist(6, 2), playlist(4, 1)],
    ['the stream just started, 10 s and 7 s', playlist(10, 2), playlist(7, 1)],
    ['the audio playlist is barely shorter', playlist(32, 2), playlist(29.99, 1)],
    ['there is no audio playlist', playlist(40, 2), undefined],
  ])('no fit when %s', (_case, video, audio) => {
    // Act
    const fit = mismatchWindow(video, audio);

    // Assert
    expect(fit).toBeNull();
  });
});

describe('urgentSecondsFor', () => {
  it.each([
    ['stable', 6],
    ['low-delay', 3],
  ] as const)('%s: %s s, inside the core high-demand window', (id, seconds) => {
    // Act
    const urgent = urgentSecondsFor(id);

    // Assert
    expect(urgent).toBe(seconds);
    expect(urgent).toBeLessThanOrEqual(PROFILES[id].highDemandTimeWindow);
  });
});

describe('planStallRecovery', () => {
  /** Stalled with the playhead (39 s) past the buffer and before the oldest audio segment (41 s). */
  const s: StallSnapshot = { stalledMs: 0, attempts: 0, currentTime: 39, buffered: [[20, 22]], liveSyncPosition: 50, windowStart: 41 };
  const atStart = { ...s, currentTime: 0, buffered: [], windowStart: 10 };

  it.each([
    ['waits a few seconds first (hls.js usually recovers by itself)', { ...s, stalledMs: 3000 }, { action: 'wait' }],
    ['playhead past the buffer and before the oldest audio segment: restarts at the live sync position', { ...s, stalledMs: 4000 }, { action: 'restart', to: 50 }],
    ['playhead inside the window: restarts loading right there', { ...s, stalledMs: 4000, windowStart: 30 }, { action: 'restart', to: 39 }],
    ['buffered data just ahead: seeks into it', { ...s, stalledMs: 4000, buffered: [[20, 22], [40, 48]] as Array<[number, number]> }, { action: 'seek', to: 40.05 }],
    ['at start (nothing buffered yet) waits longer', { ...atStart, stalledMs: 6000 }, { action: 'wait' }],
    ['at start, then restarts at the live sync position', { ...atStart, stalledMs: 8000 }, { action: 'restart', to: 50 }],
    ['after an attempt, waits 5 s', { ...s, stalledMs: 8000, attempts: 1, windowStart: 30 }, { action: 'wait' }],
    ['after an attempt, restarts at the live sync position every 5 s', { ...s, stalledMs: 9000, attempts: 1, windowStart: 30 }, { action: 'restart', to: 50 }],
    ['after 4 attempts, reloads the source', { ...s, stalledMs: 24_000, attempts: 4 }, { action: 'reload' }],
  ])('%s', (_case, snapshot, action) => {
    // Act
    const plan = planStallRecovery(snapshot);

    // Assert
    expect(plan).toEqual(action);
  });
});

describe('installStallRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stalled player: playing (not paused), readyState 2, at 10 s, nothing buffered. */
  const fakeVideo = (): HTMLVideoElement & { paused: boolean } =>
    ({ paused: false, ended: false, readyState: 2, currentTime: 10, buffered: { length: 0, start: () => 0, end: () => 0 } }) as unknown as HTMLVideoElement & { paused: boolean };

  /** The watchdog on `video`, stopped when the test ends; `hls` and `reload` record what it does. */
  function watchdog(video = fakeVideo(), o: Partial<StallRecoveryOptions> = {}) {
    const hls = { liveSyncPosition: 20, stopLoad: vi.fn(), startLoad: vi.fn() };
    const reload = vi.fn();
    onTestFinished(installStallRecovery({ video, hls, windowStart: () => null, reload, ...o }));
    return { video, hls, reload };
  }

  it('the adaptive delay hold neither resets nor delays it: nothing buffered, the first attempt comes 8 s into the stall, hold included', () => {
    // Arrange
    let held = false;
    const { video, hls } = watchdog(fakeVideo(), { isHeld: () => held });
    vi.advanceTimersByTime(2000);
    held = true;
    video.paused = true;
    vi.advanceTimersByTime(5000);
    const attemptsBefore = hls.startLoad.mock.calls.length;

    // Act
    vi.advanceTimersByTime(2000);

    // Assert
    expect(attemptsBefore).toBe(0);
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
  });

  it('a stall that is ending (the playhead moves again at the edge of a thin buffer) is not reloaded, even when the reload was due', () => {
    // Arrange
    const { video, hls, reload } = watchdog();
    vi.advanceTimersByTime(24_000);
    const attemptsBefore = hls.startLoad.mock.calls.length;

    // Act
    for (let i = 0; i < 10; i++) {
      video.currentTime += 1;
      vi.advanceTimersByTime(1000);
    }

    // Assert
    expect(attemptsBefore).toBe(4);
    expect(reload).not.toHaveBeenCalled();
    expect(hls.startLoad).toHaveBeenCalledTimes(4);
  });

  it('its own seeks are not playback: a player that stays frozen after them is reloaded on time', () => {
    // Arrange
    const { video, hls, reload } = watchdog();
    hls.startLoad.mockImplementation((to?: number) => void (to !== undefined && (video.currentTime = to)));

    // Act
    for (let i = 0; i < 30; i++) {
      hls.liveSyncPosition += 1;
      vi.advanceTimersByTime(1000);
    }

    // Assert
    expect(hls.startLoad).toHaveBeenCalledTimes(4);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still stuck: hls.js nudging the playhead (0.1-0.3 s) does not hide the stall, and the reload comes', () => {
    // Arrange
    const { video, reload } = watchdog();

    // Act
    for (let i = 0; i < 30; i++) {
      video.currentTime += 0.1 * ((i % 3) + 1);
      vi.advanceTimersByTime(1000);
    }

    // Assert
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a viewer pause is not a stall', () => {
    // Arrange
    const video = fakeVideo();
    video.paused = true;
    const { hls } = watchdog(video, { isHeld: () => false });

    // Act
    vi.advanceTimersByTime(30_000);

    // Assert
    expect(hls.startLoad).not.toHaveBeenCalled();
  });
});
