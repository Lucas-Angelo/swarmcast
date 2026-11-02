import { describe, expect, it } from 'vitest';
import { DiscontinuityClock, PlaylistStitcher, parseMediaPlaylist } from '../../src/hls/playlist.js';

// The PROGRAM-DATE-TIME of each segment the origin serves agrees with the segment durations
// inside one upstream run. MediaMTX stamps a segment with the wall clock at which its first
// frame arrived, so when OBS sends its first seconds at once (a burst at connect, a reconnect
// that flushes a backlog) two 2 s segments get dates 1 ms apart. hls.js lines the audio
// playlist up with the video one by these dates (alignMediaPlaylistByPDT: the first audio
// segment of the run against the middle video one), so for the first ~40 s of such a run it
// placed every audio segment 2 s late: a new viewer loaded audio and video of different
// moments, filled the holes out of order and jumped to the start of the video, where there was
// no audio. Linux WebKit froze for good on that jump (its GStreamer media source deadlocks;
// e2e branding.spec on CI and in Docker, gdb: main thread in gst_pad_push_event, webkitmediasrc
// waiting on the main thread).

/** One MediaMTX-style fMP4 media playlist of run `run`: segments `[from, to)` with their dates. */
function playlist(run: string, from: number, to: number, dates: Record<number, string>, durations: Record<number, number> = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:9', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`, `#EXT-X-MAP:URI="${run}_video1_init.mp4"`];
  for (let i = from; i < to; i++) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${dates[i]}`, `#EXTINF:${(durations[i] ?? 2).toFixed(5)},`, `${run}_video1_seg${i}.mp4`);
  }
  return lines.join('\n') + '\n';
}

function feed(st: PlaylistStitcher, text: string): void {
  const p = parseMediaPlaylist(text);
  st.update(p, p.entries);
}

/** Each served segment's date in ms, by file name. */
function dates(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let pdt: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (line && !line.startsWith('#')) {
      if (pdt !== undefined) out[line] = pdt;
      pdt = undefined;
    }
  }
  return out;
}

// What MediaMTX served in the e2e suite right after the fake OBS connected with a 4 s burst
// (2 s segments): seg0 and seg1 1 ms apart, then real time.
const BURST = {
  0: '2026-11-01T18:22:47.051Z',
  1: '2026-11-01T18:22:47.052Z',
  2: '2026-11-01T18:22:49.049Z',
  3: '2026-11-01T18:22:51.049Z',
  4: '2026-11-01T18:22:53.075Z',
};
const BURST_DURATIONS = { 3: 2.026 };

describe('PROGRAM-DATE-TIME served by the origin', () => {
  it('a burst at the start of a run: every date follows from the next segment and its duration', () => {
    // Arrange
    const st = new PlaylistStitcher(20, 40);

    // Act
    feed(st, playlist('r1', 0, 5, BURST, BURST_DURATIONS));

    // Assert
    const d = dates(st.render());
    const gap = (i: number): number => d[`r1_video1_seg${i + 1}.mp4`]! - d[`r1_video1_seg${i}.mp4`]!;
    // Within a few ms (MediaMTX's own jitter is left alone), never the 1 ms of the burst.
    expect(Math.abs(gap(0) - 2000)).toBeLessThanOrEqual(5);
    expect(Math.abs(gap(1) - 2000)).toBeLessThanOrEqual(5);
    expect(Math.abs(gap(2) - 2000)).toBeLessThanOrEqual(5);
    expect(Math.abs(gap(3) - 2026)).toBeLessThanOrEqual(5);
    // The newest segment keeps MediaMTX's own date: the dates stay on the wall clock.
    expect(d['r1_video1_seg4.mp4']).toBe(Date.parse(BURST[4]));
  });

  it('the audio and video playlists of the run get the same dates for the same moments', () => {
    // Arrange: both playlists of one origin, the audio one listing one segment more (it was
    // fetched a moment later), as hls.js finds them when a viewer joins.
    const clock = new DiscontinuityClock();
    const video = new PlaylistStitcher(20, 40, clock);
    const audio = new PlaylistStitcher(20, 40, clock);
    const more = { ...BURST, 5: '2026-11-01T18:22:55.075Z' };

    // Act
    feed(video, playlist('r1', 0, 5, BURST, BURST_DURATIONS));
    feed(audio, playlist('r1', 0, 6, more, BURST_DURATIONS).replaceAll('video1', 'audio2'));

    // Assert
    const v = dates(video.render());
    const a = dates(audio.render());
    for (let i = 0; i < 5; i++) expect(a[`r1_audio2_seg${i}.mp4`], `seg${i}`).toBe(v[`r1_video1_seg${i}.mp4`]);
  });

  it('dates that already agree with the durations are served exactly as MediaMTX wrote them', () => {
    // Arrange
    const st = new PlaylistStitcher(20, 40);
    const text = playlist('r1', 10, 14, {
      10: '2026-11-01T18:30:00.000Z',
      11: '2026-11-01T18:30:02.003Z',
      12: '2026-11-01T18:30:04.001Z',
      13: '2026-11-01T18:30:06.002Z',
    });

    // Act
    feed(st, text);

    // Assert
    for (const line of text.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))) expect(st.render()).toContain(line);
  });

  it('a new run keeps its own dates: nothing is carried across a discontinuity', () => {
    // Arrange: run r1 ends, OBS reconnects 30 s later with a burst (run r2).
    const st = new PlaylistStitcher(20, 40);
    feed(st, playlist('r1', 0, 3, { 0: '2026-11-01T18:00:00.000Z', 1: '2026-11-01T18:00:02.000Z', 2: '2026-11-01T18:00:04.000Z' }));

    // Act
    feed(st, playlist('r2', 0, 3, { 0: '2026-11-01T18:00:36.000Z', 1: '2026-11-01T18:00:36.001Z', 2: '2026-11-01T18:00:38.000Z' }));

    // Assert
    const d = dates(st.render());
    expect(d['r1_video1_seg2.mp4']).toBe(Date.parse('2026-11-01T18:00:04.000Z'));
    expect(d['r2_video1_seg2.mp4']).toBe(Date.parse('2026-11-01T18:00:38.000Z'));
    expect(d['r2_video1_seg1.mp4']).toBe(Date.parse('2026-11-01T18:00:36.001Z'));
    expect(d['r2_video1_seg0.mp4']).toBe(Date.parse('2026-11-01T18:00:34.001Z'));
  });

  it('segments without a date stay without one', () => {
    // Arrange
    const st = new PlaylistStitcher(20, 40);
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MAP:URI="r1_init.mp4"', '#EXTINF:2.0,', 'r1_seg0.m4s', '#EXTINF:2.0,', 'r1_seg1.m4s'].join('\n');

    // Act
    feed(st, text);

    // Assert
    expect(st.render()).not.toContain('PROGRAM-DATE-TIME');
  });
});
