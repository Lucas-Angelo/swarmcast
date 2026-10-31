import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { HlsOrigin, type HlsSource } from '../../src/hls/origin.js';
import { silentLog } from './helpers.js';
import { mediaPlaylist as upstreamPlaylist } from './helpers-b.js';

// The oldest segment of every video playlist the origin serves has its audio, and the other way
// round. A player starts at the oldest segment when the window is short and only plays a segment
// with the audio of the same upstream run (hls.js `cc`). Seen on macOS CI (quality.spec, a 9 s
// freeze): the fake OBS connected for 2 s (one video segment, no audio segment), reconnected with
// a bigger picture, the ladder ran on it, then fell back to the original. MediaMTX's video
// playlist, left over from before the ladder, still began with that lone segment; the audio one
// began with the current run. The viewer loaded that video segment and waited for its audio.

/** The origin's poll interval here (ms): short, so each source is read at once. */
const POLL_MS = 20;

/** An upstream with these media playlists (name → its text) and audio rendition `audio`. */
function upstream(kind: HlsSource['kind'], video: Record<string, string>, audio: [string, string]): HlsSource {
  const multivariant = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,URI="${audio[0]}"`, ...Object.keys(video).flatMap((v) => ['#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="aud"', v])].join('\n');
  const playlists: Record<string, string> = { ...video, [audio[0]]: audio[1] };
  return {
    kind,
    reset: () => {},
    fetch: async (uri) => {
      if (uri === 'index.m3u8') return new Response(multivariant);
      const text = playlists[uri];
      return text === undefined ? new Response(`bytes of ${uri}`) : new Response(text);
    },
  };
}

/** MediaMTX before OBS connects: nothing to read. */
const NOT_STARTED: HlsSource = { kind: 'mediamtx', reset: () => {}, fetch: async () => new Response(null, { status: 404 }) };

/** Points `origin` at `source` and waits until it serves it. */
async function serve(origin: HlsOrigin, source: HlsSource): Promise<void> {
  origin.setSource(source);
  await vi.waitFor(() => expect(origin.available).toBe(true), { timeout: 5000, interval: 10 });
}

/** Run number (hls.js cc) and name of the oldest segment of a rendered playlist. */
function oldest(text: string | undefined): { cc: number; segment: string | undefined } {
  const lines = (text ?? '').split('\n');
  return { cc: Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text ?? '')?.[1] ?? 0), segment: lines.find((l) => l && !l.startsWith('#')) };
}

describe('every playlist starts in a run its companion has', () => {
  it('after the ladder falls back to the original, video and audio start in the same run', async () => {
    // Arrange
    const origin = new HlsOrigin(NOT_STARTED, silentLog, POLL_MS);
    origin.start();
    onTestFinished(() => origin.stop());
    await serve(origin, upstream('mediamtx', { 'video1_stream.m3u8': upstreamPlaylist('short_video1', 0, 1) }, ['audio2_stream.m3u8', upstreamPlaylist('short_audio2', 0, 0)]));
    await serve(origin, upstream('ladder', { 'v720.m3u8': upstreamPlaylist('lad_v720', 0, 3) }, ['audio.m3u8', upstreamPlaylist('lad_audio', 0, 6, { segmentS: 1 })]));
    // Act
    await serve(origin, upstream('mediamtx', { 'video1_stream.m3u8': upstreamPlaylist('obs_video1', 0, 6) }, ['audio2_stream.m3u8', upstreamPlaylist('obs_audio2', 0, 6)]));
    // Assert
    const video = oldest(origin.getPlaylist('video1_stream.m3u8'));
    const audio = oldest(origin.getPlaylist('audio2_stream.m3u8'));
    expect(video.segment).toBe('obs_video1_0.m4s');
    expect(audio.segment).toBe('obs_audio2_0.m4s');
    expect(video.cc).toBe(audio.cc);
  });

  it('a run that reached both playlists stays, however old', async () => {
    // Arrange
    const origin = new HlsOrigin(NOT_STARTED, silentLog, POLL_MS);
    origin.start();
    onTestFinished(() => origin.stop());
    await serve(origin, upstream('mediamtx', { 'video1_stream.m3u8': upstreamPlaylist('r1_video1', 0, 3) }, ['audio2_stream.m3u8', upstreamPlaylist('r1_audio2', 0, 3)]));
    // Act
    await serve(origin, upstream('mediamtx', { 'video1_stream.m3u8': upstreamPlaylist('r2_video1', 0, 2) }, ['audio2_stream.m3u8', upstreamPlaylist('r2_audio2', 0, 2)]));
    // Assert
    expect(oldest(origin.getPlaylist('video1_stream.m3u8')).segment).toBe('r1_video1_0.m4s');
    expect(oldest(origin.getPlaylist('audio2_stream.m3u8')).segment).toBe('r1_audio2_0.m4s');
  });
});
