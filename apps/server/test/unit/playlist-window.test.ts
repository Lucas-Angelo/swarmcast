import { describe, expect, it } from 'vitest';
import { MAX_PLAYER_DELAY_S, PLAYER_LIVE_DELAYS, PLAYER_STALL_INCREASE_S, PLAYLIST_SAFETY_MARGIN_S, PLAYLIST_WINDOW_S, SEGMENT_DURATION_S, playlistEntries, type Rung } from '@swarmcast/shared';
import { PlaylistStitcher, parseMediaPlaylist } from '../../src/hls/playlist.js';
import { renderMediaMtxConfig } from '../../src/media/mediamtx.js';
import { buildLadderArgs } from '../../src/quality/transcoder.js';
import { mediaPlaylist } from './helpers-b.js';

// Invariant: every live playlist a viewer can get covers at least the furthest a player sits
// behind live plus a margin, so neither video nor audio runs out under a delayed player. The
// ladder's audio is cut every second with the same list size as its 2 s video, so upstream only
// offers half the window there: the origin's stitcher (as HlsOrigin builds it) keeps the rest from
// its cache, and no more than that (memory).

const NEEDED_S = MAX_PLAYER_DELAY_S + PLAYLIST_SAFETY_MARGIN_S;

/** Upstream playlists fed to the stitcher, one per new segment: enough to fill any window. */
const UPDATES = 120;

describe('playlist windows follow the player delays', () => {
  it.each(Object.entries(PLAYER_LIVE_DELAYS))('the furthest player delay covers the %s profile', (_name, d) => {
    // Assert
    expect(MAX_PLAYER_DELAY_S).toBeGreaterThanOrEqual(d.liveMaxLatencyDuration);
    expect(MAX_PLAYER_DELAY_S).toBeGreaterThanOrEqual(d.liveSyncDuration + PLAYER_STALL_INCREASE_S);
  });

  it('derives the window from the profiles (furthest delay + margin)', () => {
    // Act
    const entries2s = playlistEntries(SEGMENT_DURATION_S);
    const entries1s = playlistEntries(1);
    // Assert
    expect(PLAYLIST_WINDOW_S).toBeGreaterThanOrEqual(NEEDED_S);
    expect(entries2s * SEGMENT_DURATION_S).toBeGreaterThanOrEqual(NEEDED_S);
    expect(entries1s * 1).toBeGreaterThanOrEqual(NEEDED_S);
  });

  it('MediaMTX (original quality) lists enough segments', () => {
    // Act
    const cfg = renderMediaMtxConfig({ rtmpPort: 1, hlsPort: 2, streamKey: 'streamkey12' });
    // Assert
    const count = Number(/hlsSegmentCount: (\d+)/.exec(cfg)![1]);
    expect(count * SEGMENT_DURATION_S).toBeGreaterThanOrEqual(NEEDED_S);
  });

  it('the ladder lists enough 2 s video segments', () => {
    // Arrange
    const rung: Rung = { name: 'v720', height: 720, width: 1280, fps: 30, kbps: 0, source: true };
    // Act
    const args = buildLadderArgs({ inputUrl: 'rtmp://x', outDir: '/tmp/x', runId: 'r', rungs: [rung], encoder: 'libx264', hasAudio: true });
    // Assert
    const size = Number(args[args.indexOf('-hls_list_size') + 1]);
    expect(size * SEGMENT_DURATION_S).toBeGreaterThanOrEqual(NEEDED_S);
  });

  it.each([
    ['ladder audio (1 s)', 1],
    ['video (2 s)', SEGMENT_DURATION_S],
    ['odd 1.5 s segments', 1.5],
  ])(`the origin keeps at least ${NEEDED_S} s of %s, and not much more`, (_what, segmentS) => {
    // Arrange
    const st = new PlaylistStitcher(0, PLAYLIST_WINDOW_S);
    const upstream = playlistEntries(SEGMENT_DURATION_S);
    // Act
    for (let n = 0; n < UPDATES; n++) {
      const p = parseMediaPlaylist(mediaPlaylist('s', n, upstream, { segmentS }));
      st.update(p, p.entries);
    }
    // Assert
    expect(st.durationS()).toBeGreaterThanOrEqual(NEEDED_S - 0.5);
    expect(st.durationS()).toBeLessThanOrEqual(Math.max(NEEDED_S, upstream * segmentS) + segmentS);
  });
});
