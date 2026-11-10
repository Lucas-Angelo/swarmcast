import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { HlsOrigin, type HlsSource } from '../../src/hls/origin.js';
import { silentLog } from './helpers.js';
import { fmp4Init, fmp4Segment } from './helpers-b.js';

// The audio and video playlists the origin serves date the same moment alike, whatever moment
// each of them first saw a segment. Seen on the iOS Simulator (Devices CI): a viewer who joined
// got no picture, ever. hls.js places the audio playlist against the video one by these dates
// (alignMediaPlaylistByPDT); the audio segments were dated 49.5 s later than the video segments
// of the same moments, so hls.js put the audio 49.5 s ahead, loaded one audio segment, never one
// for where the video was, and the video could not start without audio (no SourceBuffer, ever).
//
// Why the dates parted: MediaMTX (1.21.3) dates only the newest two segments of a playlist, and
// by the wall clock at which each arrived. The origin dated a run from MediaMTX's date for the
// first segment it saw, then each one as the previous plus its duration (the media's own clock).
// A segment first seen after it had lost its date broke that chain, and the next one started
// over from MediaMTX's arrival date. On a machine so loaded that the fake OBS fell behind real
// time (load average 267 while the simulator booted; ffmpeg's -re does not catch up at once) the
// arrival dates ran ahead of the media by the time lost, and a poll that came late for one
// playlist and not the other (they are read one after the other) started over in that one only.
// Real OBS falls behind the same way after a network hiccup.

/** The origin's poll interval here (ms): short, so each state of MediaMTX is read at once. */
const POLL_MS = 20;
/** Segments MediaMTX lists (hlsSegmentCount, PLAYLIST_WINDOW_S of 2 s segments). */
const WINDOW = 20;
/** Newest segments of a playlist MediaMTX 1.21.3 gives a PROGRAM-DATE-TIME (read from it). */
const DATED = 2;
const VIDEO_TIMESCALE = 90_000;
const AUDIO_TIMESCALE = 48_000;
/**
 * Where segment 0 of each track starts on the stream's media clock, ticks: what MediaMTX wrote
 * for the fake OBS (the audio track starts a frame, 21 ms, before the video one).
 */
const VIDEO_T0 = 1_084_230;
const AUDIO_T0 = 577_248;
const SEGMENT_S = 2;
/** When segment 0 reached MediaMTX. */
const ARRIVED_T0 = Date.parse('2026-11-08T22:20:00.000Z');
/** How far behind real time the fake OBS fell while the simulator booted (the dates of the CI run). */
const BEHIND_MS = 49_500;

/**
 * MediaMTX with one OBS connection (run `r1`): fMP4 video and audio playlists that list the
 * newest WINDOW segments and date the newest DATED by when each arrived.
 */
class FakeMediaMtx implements HlsSource {
  readonly kind = 'mediamtx';
  /** Arrival date of each segment so far, ms. */
  private arrived: number[] = [];
  private afterRead = new Map<string, () => void>();

  reset(): void {}

  /** The next segment of both tracks arrives, `behindMs` later than its media says. */
  append(behindMs = 0): void {
    const n = this.arrived.length;
    this.arrived.push(ARRIVED_T0 + n * SEGMENT_S * 1000 + behindMs);
  }

  get count(): number {
    return this.arrived.length;
  }

  /** Runs `fn` once, right after the origin next reads the playlist `name`. */
  onceRead(name: string, fn: () => void): void {
    this.afterRead.set(name, fn);
  }

  async fetch(uri: string): Promise<Response> {
    if (uri === 'index.m3u8') {
      return new Response(
        ['#EXTM3U', '#EXT-X-VERSION:9', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",DEFAULT=YES,AUTOSELECT=YES,URI="audio2_stream.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1300000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="avc1.64001e,mp4a.40.2",AUDIO="audio"', 'video1_stream.m3u8'].join('\n'),
      );
    }
    const track = uri.includes('audio2') ? 'audio2' : 'video1';
    if (uri.endsWith('_stream.m3u8')) {
      const text = this.playlist(track);
      this.afterRead.get(uri)?.();
      this.afterRead.delete(uri);
      return new Response(text);
    }
    if (uri === `r1_${track}_init.mp4`) return new Response(fmp4Init(track === 'audio2' ? AUDIO_TIMESCALE : VIDEO_TIMESCALE));
    const n = Number(/_seg(\d+)\.mp4$/.exec(uri)?.[1]);
    if (!(n < this.arrived.length)) return new Response(null, { status: 404 });
    return new Response(fmp4Segment(track === 'audio2' ? AUDIO_T0 + n * SEGMENT_S * AUDIO_TIMESCALE : VIDEO_T0 + n * SEGMENT_S * VIDEO_TIMESCALE));
  }

  private playlist(track: string): string {
    const from = Math.max(0, this.arrived.length - WINDOW);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:9', `#EXT-X-TARGETDURATION:${SEGMENT_S}`, `#EXT-X-MEDIA-SEQUENCE:${from}`, `#EXT-X-MAP:URI="r1_${track}_init.mp4"`];
    for (let n = from; n < this.arrived.length; n++) {
      if (n >= this.arrived.length - DATED) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(this.arrived[n]!).toISOString()}`);
      lines.push(`#EXTINF:${SEGMENT_S.toFixed(5)},`, `r1_${track}_seg${n}.mp4`);
    }
    return lines.join('\n') + '\n';
  }
}

/** An origin reading `source`, stopped when the test finishes. */
function startedOrigin(source: HlsSource): HlsOrigin {
  const origin = new HlsOrigin(source, silentLog, POLL_MS);
  origin.start();
  onTestFinished(() => origin.stop());
  return origin;
}

/** Each served segment's date in ms (undefined when it has none), by segment number. */
function servedDates(origin: HlsOrigin, name: string): Map<number, number | undefined> {
  const out = new Map<number, number | undefined>();
  let date: number | undefined;
  for (const line of (origin.getPlaylist(name) ?? '').split('\n')) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) date = Date.parse(line.slice(25));
    else if (line && !line.startsWith('#')) {
      out.set(Number(/_seg(\d+)\.mp4$/.exec(line)?.[1]), date);
      date = undefined;
    }
  }
  return out;
}

/** Waits until the origin serves segments up to `last` in both playlists. */
async function servedUpTo(origin: HlsOrigin, last: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(servedDates(origin, 'video1_stream.m3u8').has(last)).toBe(true);
      expect(servedDates(origin, 'audio2_stream.m3u8').has(last)).toBe(true);
    },
    { timeout: 5000, interval: 10 },
  );
}

/** For every segment both playlists list: how far the audio one's date is from the video one's, ms (null: one has none). */
function datesApart(origin: HlsOrigin): Array<{ segment: number; apartMs: number | null }> {
  const video = servedDates(origin, 'video1_stream.m3u8');
  const audio = servedDates(origin, 'audio2_stream.m3u8');
  return [...video.keys()]
    .filter((n) => audio.has(n))
    .map((n) => {
      const v = video.get(n);
      const a = audio.get(n);
      return { segment: n, apartMs: v === undefined || a === undefined ? null : a - v };
    });
}

/** The same segments, dated alike. */
const alike = (apart: Array<{ segment: number }>): Array<{ segment: number; apartMs: number }> => apart.map((s) => ({ segment: s.segment, apartMs: 0 }));

describe('PROGRAM-DATE-TIME of the audio and video playlists', () => {
  it('after OBS fell behind real time, a poll late for one playlist dates it like the other', async () => {
    // Arrange: a stream in step with real time, then OBS 49.5 s behind (MediaMTX dates by arrival).
    const mtx = new FakeMediaMtx();
    const origin = startedOrigin(mtx);
    for (let n = 0; n < 4; n++) {
      mtx.append();
      await servedUpTo(origin, n);
    }
    mtx.append(BEHIND_MS);
    await servedUpTo(origin, 4);
    // Act: a segment lands between the reads of the audio and the video playlist, and two more
    // before the next poll: the audio playlist first sees it once MediaMTX no longer dates it.
    mtx.onceRead('audio2_stream.m3u8', () => {
      mtx.append(BEHIND_MS);
      mtx.onceRead('video1_stream.m3u8', () => {
        mtx.append(BEHIND_MS);
        mtx.append(BEHIND_MS);
      });
    });
    await servedUpTo(origin, 7);
    // Assert
    const apart = datesApart(origin);
    expect(apart.map((s) => s.segment)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(apart).toEqual(alike(apart));
  });

  it('read while a stream is under way: each playlist starts from a different segment, both date the moments alike', async () => {
    // Arrange: MediaMTX holds a full window when the origin first reads it; OBS stalled 1.5 s
    // before the newest two segments, and the newest lands between the two reads, so the video
    // playlist's oldest dated segment is one the audio playlist's dates do not reach.
    const mtx = new FakeMediaMtx();
    for (let n = 0; n < WINDOW + 3; n++) mtx.append();
    mtx.append(1500);
    mtx.onceRead('audio2_stream.m3u8', () => mtx.append(1500));
    const last = WINDOW + 4;
    // Act
    const origin = startedOrigin(mtx);
    await servedUpTo(origin, last);
    // Assert
    const apart = datesApart(origin);
    expect(apart.length).toBeGreaterThanOrEqual(WINDOW - 1);
    expect(apart).toEqual(alike(apart));
  });
});
