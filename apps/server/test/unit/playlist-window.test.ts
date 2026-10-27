import { describe, expect, it } from 'vitest';
import { MAX_PLAYER_DELAY_S, PLAYER_LIVE_DELAYS, PLAYER_STALL_INCREASE_S, PLAYLIST_SAFETY_MARGIN_S, PLAYLIST_WINDOW_S, SEGMENT_DURATION_S, playlistEntries, type Rung } from '@swarmcast/shared';
import { PlaylistStitcher, parseMediaPlaylist } from '../../src/hls/playlist.js';
import { renderMediaMtxConfig } from '../../src/media/mediamtx.js';
import { buildLadderArgs } from '../../src/quality/transcoder.js';

// Invariant: every live playlist a viewer can get covers at least the furthest a player sits
// behind live plus a margin, so neither video nor audio runs out under a delayed player.
const NEEDED_S = MAX_PLAYER_DELAY_S + PLAYLIST_SAFETY_MARGIN_S;

function playlist(prefix: string, from: number, count: number, segS: number): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(segS)}`, `#EXT-X-MEDIA-SEQUENCE:${from}`, `#EXT-X-MAP:URI="${prefix}_init.mp4"`];
  for (let i = from; i < from + count; i++) lines.push(`#EXTINF:${segS.toFixed(6)},`, `${prefix}_${i}.m4s`);
  return lines.join('\n');
}

describe('playlist windows follow the player delays', () => {
  it('derives the window from the profiles (furthest delay + margin)', () => {
    for (const d of Object.values(PLAYER_LIVE_DELAYS)) {
      expect(MAX_PLAYER_DELAY_S).toBeGreaterThanOrEqual(d.liveMaxLatencyDuration);
      expect(MAX_PLAYER_DELAY_S).toBeGreaterThanOrEqual(d.liveSyncDuration + PLAYER_STALL_INCREASE_S);
    }
    expect(PLAYLIST_WINDOW_S).toBeGreaterThanOrEqual(NEEDED_S);
    expect(playlistEntries(SEGMENT_DURATION_S) * SEGMENT_DURATION_S).toBeGreaterThanOrEqual(NEEDED_S);
    expect(playlistEntries(1) * 1).toBeGreaterThanOrEqual(NEEDED_S);
  });

  it('MediaMTX (original quality) lists enough segments', () => {
    const cfg = renderMediaMtxConfig({ rtmpPort: 1, hlsPort: 2, streamKey: 'streamkey12' });
    const count = Number(/hlsSegmentCount: (\d+)/.exec(cfg)![1]);
    expect(count * SEGMENT_DURATION_S).toBeGreaterThanOrEqual(NEEDED_S);
  });

  it('the ladder lists enough 2 s video segments', () => {
    const rung: Rung = { name: 'v720', height: 720, width: 1280, fps: 30, kbps: 0, source: true };
    const args = buildLadderArgs({ inputUrl: 'rtmp://x', outDir: '/tmp/x', runId: 'r', rungs: [rung], encoder: 'x264' as Parameters<typeof buildLadderArgs>[0]['encoder'], hasAudio: true });
    const size = Number(args[args.indexOf('-hls_list_size') + 1]);
    expect(size * SEGMENT_DURATION_S).toBeGreaterThanOrEqual(NEEDED_S);
  });

  // The ladder's audio is cut every second with the same list size, so upstream only offers
  // half the window; the origin's stitcher (as HlsOrigin builds it) keeps the rest from cache.
  for (const [what, segS] of [['ladder audio (1 s)', 1], ['video (2 s)', SEGMENT_DURATION_S], ['odd 1.5 s segments', 1.5]] as const) {
    it(`the origin keeps at least ${NEEDED_S} s of ${what}`, () => {
      const st = new PlaylistStitcher(0, PLAYLIST_WINDOW_S);
      const upstream = playlistEntries(SEGMENT_DURATION_S);
      for (let n = 0; n < 120; n++) {
        const p = parseMediaPlaylist(playlist('s', n, upstream, segS));
        st.update(p, p.entries);
      }
      expect(st.durationS()).toBeGreaterThanOrEqual(NEEDED_S - 0.5);
      // ...and not much more than that (memory)
      expect(st.durationS()).toBeLessThanOrEqual(Math.max(NEEDED_S, upstream * segS) + segS);
    });
  }
});
