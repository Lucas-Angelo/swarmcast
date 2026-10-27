import { describe, expect, it } from 'vitest';
import { PLAYER_LIVE_DELAYS, PLAYLIST_WINDOW_S, SEGMENT_DURATION_S } from '@swarmcast/shared';
import { latencyFor, mismatchWindow, PROFILES, urgentSecondsFor } from '../../src/player-config.js';
import { planStallRecovery, type StallSnapshot } from '../../src/stall-recovery.js';

describe('latencyFor', () => {
  it('uses the delays the server sizes its playlists from, untouched in a full window', () => {
    for (const id of ['stable', 'low-delay'] as const) {
      expect({ liveSyncDuration: PROFILES[id].liveSyncDuration, liveMaxLatencyDuration: PROFILES[id].liveMaxLatencyDuration }).toEqual(PLAYER_LIVE_DELAYS[id]);
      expect(latencyFor(id, { windowS: PLAYLIST_WINDOW_S, targetDurationS: SEGMENT_DURATION_S })).toEqual(PLAYER_LIVE_DELAYS[id]);
    }
  });

  it('keeps the profile when every playlist holds 40 s', () => {
    expect(latencyFor('stable', { windowS: 40, targetDurationS: 2 })).toEqual({ liveSyncDuration: 20, liveMaxLatencyDuration: 36 });
    expect(latencyFor('low-delay', { windowS: 40, targetDurationS: 2 })).toEqual({ liveSyncDuration: 8, liveMaxLatencyDuration: 20 });
    expect(latencyFor('stable', null)).toEqual({ liveSyncDuration: PROFILES.stable.liveSyncDuration, liveMaxLatencyDuration: PROFILES.stable.liveMaxLatencyDuration });
  });

  it('fits into a 20 s audio playlist (ladder from v0.2.0 and older): the catch-up jump lands inside it', () => {
    for (const windowS of [19.99, 20, 20.01]) {
      const fit = latencyFor('stable', { windowS, targetDurationS: 2 });
      expect(fit).toEqual({ liveSyncDuration: 12, liveMaxLatencyDuration: 16 });
      // target + the most hls.js adds after stalls (one target duration) stays inside the window
      expect(fit.liveSyncDuration + 2).toBeLessThan(windowS - 2);
    }
    expect(latencyFor('low-delay', { windowS: 20, targetDurationS: 2 })).toEqual({ liveSyncDuration: 8, liveMaxLatencyDuration: 16 });
  });

  it('never goes below a sane floor on very short playlists (stream just started)', () => {
    const fit = latencyFor('stable', { windowS: 4, targetDurationS: 2 });
    expect(fit.liveSyncDuration).toBe(4);
    expect(fit.liveMaxLatencyDuration).toBe(8);
  });
});

describe('mismatchWindow', () => {
  it('fits only when the audio playlist covers less than the video one', () => {
    expect(mismatchWindow({ totalduration: 40, targetduration: 2 }, { totalduration: 20, targetduration: 1 })).toEqual({ windowS: 20, targetDurationS: 2 });
    expect(mismatchWindow({ totalduration: 40, targetduration: 2 }, { totalduration: 40, targetduration: 1 })).toBeNull();
    // stream just started: both short and growing, refreshed at different moments
    expect(mismatchWindow({ totalduration: 10, targetduration: 2 }, { totalduration: 9.5, targetduration: 1 })).toBeNull();
    expect(mismatchWindow({ totalduration: 6, targetduration: 2 }, { totalduration: 4, targetduration: 1 })).toBeNull();
    expect(mismatchWindow({ totalduration: 10, targetduration: 2 }, { totalduration: 7, targetduration: 1 })).toBeNull();
    expect(mismatchWindow({ totalduration: 32, targetduration: 2 }, { totalduration: 29.99, targetduration: 1 })).toBeNull();
    expect(mismatchWindow({ totalduration: 40, targetduration: 2 }, undefined)).toBeNull();
  });
});

describe('urgentSecondsFor', () => {
  it('sits inside the core high-demand window', () => {
    expect(urgentSecondsFor('stable')).toBe(6);
    expect(urgentSecondsFor('low-delay')).toBe(3);
    for (const id of ['stable', 'low-delay'] as const) expect(urgentSecondsFor(id)).toBeLessThanOrEqual(PROFILES[id].highDemandTimeWindow);
  });
});

describe('planStallRecovery', () => {
  const s: StallSnapshot = { stalledMs: 0, attempts: 0, currentTime: 39, buffered: [[20, 22]], liveSyncPosition: 50, windowStart: 41 };

  it('waits a few seconds first (hls.js usually recovers by itself)', () => {
    expect(planStallRecovery({ ...s, stalledMs: 3000 })).toEqual({ action: 'wait' });
  });

  it('playhead past the buffer and before the oldest audio segment: restart at the live sync position', () => {
    expect(planStallRecovery({ ...s, stalledMs: 4000 })).toEqual({ action: 'restart', to: 50 });
  });

  it('playhead inside the window: restart loading right there', () => {
    expect(planStallRecovery({ ...s, stalledMs: 4000, windowStart: 30 })).toEqual({ action: 'restart', to: 39 });
  });

  it('buffered data just ahead: seek into it', () => {
    expect(planStallRecovery({ ...s, stalledMs: 4000, buffered: [[20, 22], [40, 48]] })).toEqual({ action: 'seek', to: 40.05 });
  });

  it('at start (nothing buffered yet) waits longer, then restarts at the live sync position', () => {
    const start = { ...s, currentTime: 0, buffered: [], windowStart: 10 };
    expect(planStallRecovery({ ...start, stalledMs: 6000 })).toEqual({ action: 'wait' });
    expect(planStallRecovery({ ...start, stalledMs: 8000 })).toEqual({ action: 'restart', to: 50 });
  });

  it('escalates: live sync restarts every 5 s, then reloads the source', () => {
    expect(planStallRecovery({ ...s, stalledMs: 8000, attempts: 1, windowStart: 30 })).toEqual({ action: 'wait' });
    expect(planStallRecovery({ ...s, stalledMs: 9000, attempts: 1, windowStart: 30 })).toEqual({ action: 'restart', to: 50 });
    expect(planStallRecovery({ ...s, stalledMs: 24_000, attempts: 4 })).toEqual({ action: 'reload' });
  });
});
