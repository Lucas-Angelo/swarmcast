import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { HlsOrigin, type HlsSource } from '../../src/hls/origin.js';
import { silentLog } from './helpers.js';
import { mediaPlaylist } from './helpers-b.js';

// A playlist kept from an earlier source comes back without the history viewers could not get
// meanwhile. Seen on macOS and Linux CI (quality.spec, a 9 s freeze right after the ladder fell
// back to the original): before the ladder, the e2e gate's 2 s OBS connections had left runs in
// MediaMTX's playlists, one of them in the audio playlist only; back on MediaMTX, the origin
// served them again ahead of the current connection, and the viewer started on the oldest video
// segment and never found its audio. A playlist the stream kept serving (OBS reconnecting without
// the ladder) keeps its earlier runs: viewers on it play across them.

/** The origin's poll interval here (ms): short, so each source is read at once. */
const POLL_MS = 20;

/** MediaMTX before OBS connects: nothing to read. */
const NOT_STARTED: HlsSource = { kind: 'mediamtx', reset: () => {}, fetch: async () => new Response(null, { status: 404 }) };

/** An upstream with these video playlists (name → text) and one audio rendition [name, text]. */
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

/** MediaMTX with OBS connection `run`: `video` and `audio` segments of it so far. */
const mediamtx = (run: string, video: number, audio = video): HlsSource =>
  upstream('mediamtx', { 'video1_stream.m3u8': mediaPlaylist(`${run}_video1`, 0, video) }, ['audio2_stream.m3u8', mediaPlaylist(`${run}_audio2`, 0, audio)]);

const LADDER = upstream('ladder', { 'v720.m3u8': mediaPlaylist('lad_v720', 0, 3) }, ['audio.m3u8', mediaPlaylist('lad_audio', 0, 6, { segmentS: 1 })]);

/** An origin, started, stopped when the test finishes. */
function startedOrigin(): HlsOrigin {
  const origin = new HlsOrigin(NOT_STARTED, silentLog, POLL_MS);
  origin.start();
  onTestFinished(() => origin.stop());
  return origin;
}

/** Points `origin` at `source` and waits until viewers get it. */
async function serve(origin: HlsOrigin, source: HlsSource): Promise<void> {
  origin.setSource(source);
  await vi.waitFor(() => expect(origin.available).toBe(true), { timeout: 5000, interval: 10 });
}

/** The OBS connections (runs) a served playlist lists, oldest first. */
function runsOf(origin: HlsOrigin, name: string): string[] {
  const segments = (origin.getPlaylist(name) ?? '').split('\n').filter((l) => l && !l.startsWith('#'));
  return [...new Set(segments.map((s) => s.split('_')[0]!))];
}

describe('playlists across a source switch', () => {
  it('back from the ladder, the original lists only what came after it', async () => {
    // Arrange
    const origin = startedOrigin();
    await serve(origin, mediamtx('gateA', 2));
    await serve(origin, mediamtx('gateB', 0, 2));
    await serve(origin, mediamtx('obs', 2));
    await serve(origin, LADDER);
    // Act
    await serve(origin, mediamtx('obs', 8));
    // Assert
    expect(runsOf(origin, 'video1_stream.m3u8')).toEqual(['obs']);
    expect(runsOf(origin, 'audio2_stream.m3u8')).toEqual(['obs']);
    expect(origin.getPlaylist('video1_stream.m3u8')).toContain('obs_video1_0.m4s');
  });

  it('a playlist viewers kept getting keeps its earlier runs (OBS reconnecting)', async () => {
    // Arrange
    const origin = startedOrigin();
    await serve(origin, mediamtx('r1', 3));
    // Act
    await serve(origin, mediamtx('r2', 2));
    // Assert
    expect(runsOf(origin, 'video1_stream.m3u8')).toEqual(['r1', 'r2']);
    expect(runsOf(origin, 'audio2_stream.m3u8')).toEqual(['r1', 'r2']);
  });

  it('a ladder playlist viewers kept getting keeps its earlier runs while the original is only polled (ladder reconnect)', async () => {
    // Arrange
    const origin = startedOrigin();
    await serve(origin, upstream('ladder', { 'v720.m3u8': mediaPlaylist('l1_v720', 0, 3) }, ['audio.m3u8', mediaPlaylist('l1_audio', 0, 3)]));
    origin.hold(true);
    origin.setSource(mediamtx('obs', 2));
    await vi.waitFor(() => expect(origin.sourceInfo()).not.toBeNull(), { timeout: 5000, interval: 10 });
    // Act
    origin.setSource(upstream('ladder', { 'v720.m3u8': mediaPlaylist('l2_v720', 0, 2) }, ['audio.m3u8', mediaPlaylist('l2_audio', 0, 2)]));
    origin.hold(false);
    await vi.waitFor(() => expect(origin.available).toBe(true), { timeout: 5000, interval: 10 });
    // Assert
    expect(runsOf(origin, 'v720.m3u8')).toEqual(['l1', 'l2']);
    expect(runsOf(origin, 'audio.m3u8')).toEqual(['l1', 'l2']);
  });
});
