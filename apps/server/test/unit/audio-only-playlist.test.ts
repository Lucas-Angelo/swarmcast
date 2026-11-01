import { describe, expect, it, vi } from 'vitest';
import { AUDIO_ONLY_DEFAULT_BPS, AUDIO_ONLY_PLAYLIST, SESSION_COOKIE, type Rung } from '@swarmcast/shared';
import type { LiveController } from '../../src/core/live.js';
import type { HlsSource } from '../../src/hls/origin.js';
import { audioRendition, cleanMultivariant, mediaPlaylistUris, parseMultivariant, renderAudioOnlyMultivariant } from '../../src/hls/playlist.js';
import { renderLadderMultivariant } from '../../src/quality/transcoder.js';
import { joinViewer } from './helpers-b.js';
import { startController } from './live-helpers.js';

// "Audio only" (docs/QUALITY.md): the server writes /hls/audio-only.m3u8, a multivariant playlist
// with one audio-only STREAM-INF that points at the stream's own audio rendition, for the original
// (MediaMTX) and for the quality ladder (ffmpeg copies the audio once into audio.m3u8). A viewer
// who picks "Audio only" loads it instead of index.m3u8 and gets the same audio segments (same
// names, hashes and live window) as everyone else, and no video.

/** MediaMTX's multivariant (fMP4, as it writes it, session tokens included). */
const MEDIAMTX = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=abc"

#EXT-X-STREAM-INF:BANDWIDTH=1569728,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8?session=abc
`;

/** The ladder's multivariant, as the server writes it from the plan and ffmpeg's own master. */
function ladderMultivariant(): string {
  const rungs: Rung[] = [
    { name: 'v720', height: 720, width: 1280, fps: 30, kbps: 0, source: true },
    { name: 'v480', height: 480, width: 854, fps: 30, kbps: 1400, source: false },
  ];
  const ffMaster = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_2",DEFAULT=YES,CHANNELS="2",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1650000,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_aud"',
    'v480.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=134168,CODECS="mp4a.40.2",AUDIO="group_aud"',
    'audio.m3u8',
  ].join('\n');
  return renderLadderMultivariant(rungs, true, ffMaster, () => true, { kbps: 3000, codecs: 'avc1.64001f,mp4a.40.2' })!;
}

/** The STREAM-INF lines of a multivariant and the URI under each. */
function streams(text: string): Array<{ inf: string; uri: string }> {
  const lines = text.split('\n');
  return lines.flatMap((l, i) => (l.startsWith('#EXT-X-STREAM-INF:') ? [{ inf: l, uri: lines[i + 1]! }] : []));
}

describe('the audio-only multivariant playlist', () => {
  it('points at MediaMTX audio rendition, by bare file name, with its codec and no video', () => {
    // Act
    const out = renderAudioOnlyMultivariant(MEDIAMTX, 128_000)!;
    // Assert
    expect(streams(out)).toEqual([{ inf: '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"', uri: 'audio2_stream.m3u8' }]);
    expect(out).toMatch(/^#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-INDEPENDENT-SEGMENTS\n/);
    expect(out).not.toContain('session=');
    expect(out).not.toMatch(/RESOLUTION|avc1|#EXT-X-MEDIA:/);
  });

  it('points at the ladder audio rendition (audio.m3u8, copied once by ffmpeg)', () => {
    // Arrange
    const ladder = ladderMultivariant();
    // Act
    const out = renderAudioOnlyMultivariant(ladder, 140_000)!;
    // Assert
    expect(streams(out)).toEqual([{ inf: '#EXT-X-STREAM-INF:BANDWIDTH=140000,CODECS="mp4a.40.2"', uri: 'audio.m3u8' }]);
    expect(mediaPlaylistUris(ladder)).toContain('audio.m3u8');
  });

  it('is parsed as one variant without video, which index.m3u8 leaves out for video viewers', () => {
    // Act
    const out = renderAudioOnlyMultivariant(MEDIAMTX, 128_000)!;
    // Assert
    expect(parseMultivariant(out).variants).toEqual([{ name: 'audio2_stream.m3u8', bandwidth: 128_000, codecs: 'mp4a.40.2' }]);
    expect(cleanMultivariant(MEDIAMTX)).not.toContain(AUDIO_ONLY_PLAYLIST);
  });

  it('advertises the default bitrate until the audio is measured', () => {
    // Act
    const out = renderAudioOnlyMultivariant(MEDIAMTX, AUDIO_ONLY_DEFAULT_BPS)!;
    // Assert
    expect(out).toContain(`BANDWIDTH=${AUDIO_ONLY_DEFAULT_BPS},`);
  });

  it('is not written when the audio is muxed into the video playlist (no separate rendition)', () => {
    // Arrange
    const muxed = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720', 'video.m3u8'].join('\n');
    // Act
    const out = renderAudioOnlyMultivariant(muxed, 128_000);
    // Assert
    expect(out).toBeNull();
  });

  it('takes the DEFAULT rendition of the group the variants use, and its declared codec', () => {
    // Arrange
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",NAME="x",DEFAULT=YES,URI="unused.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="second.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES,URI="main.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,opus",RESOLUTION=1280x720,AUDIO="aud"',
      'video.m3u8',
    ].join('\n');
    // Act
    const audio = audioRendition(text);
    // Assert
    expect(audio).toEqual({ name: 'main.m3u8', codecs: 'opus' });
  });

  it('declares AAC-LC when no variant says which audio codec it uses', () => {
    // Arrange
    const text = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="a",URI="a.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="aud"', 'v.m3u8'].join('\n');
    // Act
    const out = renderAudioOnlyMultivariant(text, 96_000)!;
    // Assert
    expect(streams(out)).toEqual([{ inf: '#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"', uri: 'a.m3u8' }]);
    expect(out).toContain('#EXT-X-VERSION:7');
  });

  it('never points at a name the server does not serve under /hls', () => {
    // Arrange
    const text = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="a",DEFAULT=YES,URI="../../secrets.json"', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"', 'v.m3u8'].join('\n');
    // Act
    const out = renderAudioOnlyMultivariant(text, 96_000);
    // Assert
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Served by the public server (real HlsOrigin, real routes, a fake upstream)
// ---------------------------------------------------------------------------------------------

const LADDER = { kind: 'ladder', video: ['v720.m3u8', 'v480.m3u8'], audio: 'audio.m3u8' } as const;
const ORIGINAL = { kind: 'mediamtx', video: ['video1_stream.m3u8'], audio: 'audio2_stream.m3u8' } as const;
type Layout = { kind: HlsSource['kind']; video: readonly string[]; audio: string | null };

const stem = (name: string): string => name.replace(/\.m3u8$/, '');

/** An upstream with these playlists, one 2 s segment each (`audio: null` = audio muxed into the video). */
function source(l: Layout, o: { ready?: boolean } = {}): HlsSource {
  const multivariant = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    ...(l.audio ? [`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,URI="${l.audio}"`] : []),
    ...l.video.flatMap((v) => [`#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720${l.audio ? ',AUDIO="aud"' : ''}`, v]),
  ].join('\n');
  const media = (name: string): string =>
    ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-MAP:URI="${stem(name)}_init.mp4"`, '#EXTINF:2.000000,', `${stem(name)}_00000.m4s`].join('\n');
  const playlists = new Set([...l.video, ...(l.audio ? [l.audio] : [])]);
  return {
    kind: l.kind,
    reset: () => {},
    fetch: async (uri) => {
      if (o.ready === false) return new Response(null, { status: 404 });
      if (uri === 'index.m3u8') return new Response(multivariant);
      if (playlists.has(uri)) return new Response(media(uri));
      // 4000 bytes per 2 s segment: 16 kbps measured.
      return new Response(Buffer.alloc(4000, 1));
    },
  };
}

async function serve(live: LiveController, upstream: HlsSource): Promise<void> {
  live.origin.setSource(upstream);
  await vi.waitFor(() => expect(live.origin.available).toBe(true), { timeout: 5000, interval: 50 });
}

/** A GET of /hls/<name>, as a viewer (session cookie) or as anyone else (`cookie: false`). */
async function get(live: LiveController, name: string, o: { cookie?: boolean } = {}): Promise<{ status: number; body: string; type: string | null; retryAfter: string | null }> {
  const headers: Record<string, string> = {};
  if (o.cookie !== false) headers.cookie = `${SESSION_COOKIE}=${await live.access.issueSessionToken(joinViewer(live.access, 'viewer'))}`;
  const res = await fetch(`http://127.0.0.1:${live.publicPort}/hls/${name}`, { headers });
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type'), retryAfter: res.headers.get('retry-after') };
}

describe('GET /hls/audio-only.m3u8', () => {
  it('serves the ladder audio rendition to a viewer, at its measured bitrate', async () => {
    // Arrange
    const { live } = await startController();
    await serve(live, source(LADDER));
    // Act
    const res = await get(live, AUDIO_ONLY_PLAYLIST);
    const audio = await get(live, streams(res.body)[0]!.uri);
    // Assert
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/vnd.apple.mpegurl');
    expect(streams(res.body)).toEqual([{ inf: '#EXT-X-STREAM-INF:BANDWIDTH=16000,CODECS="mp4a.40.2"', uri: 'audio.m3u8' }]);
    expect(audio.status).toBe(200);
    expect(audio.body).toContain('audio_00000.m4s');
  });

  it('serves the original (MediaMTX) audio rendition, and follows the stream when the ladder falls back to it', async () => {
    // Arrange
    const { live } = await startController();
    await serve(live, source(LADDER));
    // Act
    await serve(live, source(ORIGINAL));
    const res = await get(live, AUDIO_ONLY_PLAYLIST);
    // Assert
    expect(res.status).toBe(200);
    expect(streams(res.body).map((s) => s.uri)).toEqual(['audio2_stream.m3u8']);
    expect((await get(live, 'audio.m3u8')).status).toBe(404);
    expect((await get(live, 'audio2_stream.m3u8')).status).toBe(200);
  });

  it('refuses anyone without a session (401), like every other playlist', async () => {
    // Arrange
    const { live } = await startController();
    await serve(live, source(ORIGINAL));
    // Act
    const res = await get(live, AUDIO_ONLY_PLAYLIST, { cookie: false });
    // Assert
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('#EXTM3U');
  });

  it('is not there yet (503, retried) before the stream exists', async () => {
    // Arrange
    const { live } = await startController();
    // Act
    live.origin.setSource(source(LADDER, { ready: false }));
    // Assert
    const res = await get(live, AUDIO_ONLY_PLAYLIST);
    expect({ status: res.status, retryAfter: res.retryAfter }).toEqual({ status: 503, retryAfter: '2' });
  });

  it('is gone (404) while the stream has no separate audio, so the player goes back to video', async () => {
    // Arrange
    const { live } = await startController();
    // Act
    await serve(live, source({ kind: 'mediamtx', video: ['video1_stream.m3u8'], audio: null }));
    // Assert
    expect((await get(live, AUDIO_ONLY_PLAYLIST)).status).toBe(404);
    expect((await get(live, 'index.m3u8')).status).toBe(200);
  });

  it('changes nothing for video viewers: index.m3u8 never lists it', async () => {
    // Arrange
    const { live } = await startController();
    await serve(live, source(LADDER));
    // Act
    const index = await get(live, 'index.m3u8');
    // Assert
    expect(index.body).not.toContain(AUDIO_ONLY_PLAYLIST);
    expect(streams(index.body).map((s) => s.uri)).toEqual(['v720.m3u8', 'v480.m3u8']);
  });
});
