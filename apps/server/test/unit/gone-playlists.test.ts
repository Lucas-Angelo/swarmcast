import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@swarmcast/shared';
import type { LiveController } from '../../src/core/live.js';
import type { HlsSource } from '../../src/hls/origin.js';
import { joinViewer } from './helpers-b.js';
import { startController } from './live-helpers.js';

// GET /hls/<playlist>.m3u8 (public/server.ts) for a playlist the origin does not serve:
// - 503 + Retry-After while the stream is not there yet (OBS not started, reconnecting, the
//   quality ladder starting or switching): players retry it and pick the stream up when it comes;
// - 404 once the stream goes on without that playlist (the rendition the ladder dropped, every
//   ladder playlist after it fell back to the original quality): players do not retry a 4xx,
//   and the viewer loads the stream again (viewer player-config.ts createManifestReloader).
//   Answered 503, a viewer on the dropped rendition kept retrying it, frozen (quality.spec.ts).

const LADDER = { kind: 'ladder', video: ['v720.m3u8', 'v480.m3u8'], audio: 'audio.m3u8' } as const;
const ORIGINAL = { kind: 'mediamtx', video: ['video1_stream.m3u8'], audio: 'audio2_stream.m3u8' } as const;
type Layout = { kind: HlsSource['kind']; video: readonly string[]; audio: string };

const stem = (name: string): string => name.replace(/\.m3u8$/, '');

/** An upstream (ladder folder or MediaMTX) with these playlists, one segment each; `ready: false` = nothing yet (404). */
function source(l: Layout, o: { ready?: boolean } = {}): HlsSource {
  const multivariant = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,URI="${l.audio}"`,
    ...l.video.flatMap((v) => ['#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="aud"', v]),
  ].join('\n');
  const media = (name: string): string =>
    ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-MAP:URI="${stem(name)}_init.mp4"`, '#EXTINF:2.000000,', `${stem(name)}_00000.m4s`].join('\n');
  const playlists = new Set([...l.video, l.audio]);
  return {
    kind: l.kind,
    reset: () => {},
    fetch: async (uri) => {
      if (o.ready === false) return new Response(null, { status: 404 });
      if (uri === 'index.m3u8') return new Response(multivariant);
      if (playlists.has(uri)) return new Response(media(uri));
      return new Response(`bytes of ${uri}`);
    },
  };
}

/** A started live whose origin pulls from `upstream`, once it serves it (one origin poll, about a second). */
async function liveServing(upstream: HlsSource): Promise<LiveController> {
  const { live } = await startController();
  await serve(live, upstream);
  return live;
}

async function serve(live: LiveController, upstream: HlsSource): Promise<void> {
  live.origin.setSource(upstream);
  await vi.waitFor(() => expect(live.origin.available).toBe(true), { timeout: 5000, interval: 50 });
}

/** A viewer's GET of /hls/<name>: status and Retry-After. */
async function viewerGets(live: LiveController, name: string): Promise<{ status: number; retryAfter: string | null }> {
  const token = await live.access.issueSessionToken(joinViewer(live.access, 'viewer'));
  const res = await fetch(`http://127.0.0.1:${live.publicPort}/hls/${name}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  await res.body?.cancel();
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

describe('playlists the stream does not serve', () => {
  it('a rendition the ladder dropped is gone (404) once the stream goes on without it', async () => {
    // Arrange
    const live = await liveServing(source(LADDER));
    // Act
    await serve(live, source(ORIGINAL));
    // Assert
    expect(await viewerGets(live, 'v480.m3u8')).toEqual({ status: 404, retryAfter: null });
    expect(await viewerGets(live, 'audio.m3u8')).toEqual({ status: 404, retryAfter: null });
    expect((await viewerGets(live, 'video1_stream.m3u8')).status).toBe(200);
  });

  it('every playlist of the stream being served is there', async () => {
    // Act
    const live = await liveServing(source(LADDER));
    // Assert
    const statuses = await Promise.all(['index.m3u8', ...LADDER.video, LADDER.audio].map(async (n) => (await viewerGets(live, n)).status));
    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  it('before the stream exists, a playlist is not there yet (503, retry)', async () => {
    // Arrange
    const { live } = await startController();
    // Act
    live.origin.setSource(source(LADDER, { ready: false }));
    // Assert
    expect(await viewerGets(live, 'v480.m3u8')).toEqual({ status: 503, retryAfter: '2' });
    expect(await viewerGets(live, 'index.m3u8')).toEqual({ status: 503, retryAfter: '2' });
  });

  it('while the stream switches to another source, the old playlists may still come back (503)', async () => {
    // Arrange
    const live = await liveServing(source(LADDER));
    // Act
    live.origin.setSource(source(ORIGINAL, { ready: false }));
    // Assert
    expect(await viewerGets(live, 'v480.m3u8')).toEqual({ status: 503, retryAfter: '2' });
  });
});
