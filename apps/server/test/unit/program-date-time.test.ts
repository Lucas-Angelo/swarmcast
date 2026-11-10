import { describe, expect, it } from 'vitest';
import { DiscontinuityClock, PlaylistStitcher, parseMediaPlaylist, type MediaEntry } from '../../src/hls/playlist.js';

// The PROGRAM-DATE-TIME of each segment the origin serves is, inside one upstream run, the
// previous segment's date plus its duration, exactly. MediaMTX stamps a segment with the wall
// clock at which its first frame arrived: when OBS sends its first seconds at once (a burst at
// connect, a reconnect that flushes a backlog) two 2 s segments get dates 1 ms apart, and
// otherwise the dates wander by a few ms. hls.js lines the audio playlist up with the video one
// by these dates (alignMediaPlaylistByPDT: the first audio segment of the run against the middle
// video one) and shifts the audio by whatever dates and durations disagree on in between. A
// viewer whose start fell near a segment boundary (always early in a run) loaded audio and video
// of neighbouring segments and jumped to where the video started and the audio did not: Linux
// WebKit froze for good (its GStreamer media source deadlocks; e2e branding.spec on CI and in
// Docker, gdb: main thread in gst_pad_push_event, webkitmediasrc waiting on the main thread).
// A tolerance of 250 ms was tried first: the few ms it left still froze 4 starts in 5.

/** One MediaMTX-style fMP4 media playlist of run `run`: segments `[from, to)` with their dates (none where `dates` has none). */
function playlist(run: string, from: number, to: number, dates: Record<number, string>, durations: Record<number, number> = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:9', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`, `#EXT-X-MAP:URI="${run}_video1_init.mp4"`];
  for (let i = from; i < to; i++) {
    if (dates[i] !== undefined) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${dates[i]}`);
    lines.push(`#EXTINF:${(durations[i] ?? 2).toFixed(5)},`, `${run}_video1_seg${i}.mp4`);
  }
  return lines.join('\n') + '\n';
}

/** Feeds `text`; `start(n)` is where segment n starts on the media clock, as the origin reads it from the segment (fmp4.ts). */
function feed(st: PlaylistStitcher, text: string, start?: (n: number) => number): void {
  const p = parseMediaPlaylist(text);
  const timed = (e: MediaEntry): MediaEntry => (start ? { ...e, start: start(Number(/seg(\d+)\.mp4$/.exec(e.uri)?.[1])) } : e);
  st.update(p, p.entries.map(timed));
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
  it('a burst at the start of a run: every date is the previous one plus its duration', () => {
    // Arrange
    const st = new PlaylistStitcher(20, 40);

    // Act
    feed(st, playlist('r1', 0, 5, BURST, BURST_DURATIONS));

    // Assert
    const d = dates(st.render());
    expect(d['r1_video1_seg0.mp4']).toBe(Date.parse(BURST[0]));
    expect(d['r1_video1_seg1.mp4']! - d['r1_video1_seg0.mp4']!).toBe(2000);
    expect(d['r1_video1_seg2.mp4']! - d['r1_video1_seg1.mp4']!).toBe(2000);
    expect(d['r1_video1_seg3.mp4']! - d['r1_video1_seg2.mp4']!).toBe(2000);
    expect(d['r1_video1_seg4.mp4']! - d['r1_video1_seg3.mp4']!).toBe(2026);
  });

  it('a date once served never moves: the same dates on the next reload, and after the run start left the window', () => {
    // Arrange
    const st = new PlaylistStitcher(3);
    feed(st, playlist('r1', 0, 3, BURST));
    const first = dates(st.render());

    // Act: upstream moved on; seg0 and seg1 (the burst) left both windows.
    feed(st, playlist('r1', 2, 5, BURST, BURST_DURATIONS));

    // Assert
    const later = dates(st.render());
    expect(later['r1_video1_seg2.mp4']).toBe(first['r1_video1_seg2.mp4']);
    expect(later['r1_video1_seg0.mp4']).toBeUndefined();
    expect(later['r1_video1_seg4.mp4']! - later['r1_video1_seg2.mp4']!).toBe(4026);
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

  it("MediaMTX's few ms of wander are gone too: hls.js would shift the audio by them", () => {
    // Arrange
    const st = new PlaylistStitcher(20, 40);

    // Act
    feed(st, playlist('r1', 10, 14, { 10: '2026-11-01T18:30:00.000Z', 11: '2026-11-01T18:30:02.003Z', 12: '2026-11-01T18:30:03.974Z', 13: '2026-11-01T18:30:06.002Z' }));

    // Assert
    expect(Object.values(dates(st.render()))).toEqual([0, 2000, 4000, 6000].map((ms) => Date.parse('2026-11-01T18:30:00.000Z') + ms));
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
    expect(d['r2_video1_seg0.mp4']).toBe(Date.parse('2026-11-01T18:00:36.000Z'));
    expect(d['r2_video1_seg1.mp4']).toBe(Date.parse('2026-11-01T18:00:38.000Z'));
    expect(d['r2_video1_seg2.mp4']).toBe(Date.parse('2026-11-01T18:00:40.000Z'));
  });

  it('a segment MediaMTX no longer dates (a late read) keeps the date of its moment', () => {
    // Arrange: MediaMTX dates only the newest two segments of a playlist, by when each arrived;
    // OBS fell 5 s behind real time before segment 1.
    const st = new PlaylistStitcher(20, 40);
    feed(st, playlist('r1', 0, 1, { 0: '2026-11-01T18:00:00.000Z' }));

    // Act
    feed(st, playlist('r1', 0, 4, { 2: '2026-11-01T18:00:09.000Z', 3: '2026-11-01T18:00:11.000Z' }));

    // Assert
    expect(Object.values(dates(st.render()))).toEqual([0, 2000, 4000, 6000].map((ms) => Date.parse('2026-11-01T18:00:00.000Z') + ms));
  });

  it("the ladder's 1 s audio, first read from a later segment, dates each cut like the 2 s video", () => {
    // Arrange: the video playlist dated from MediaMTX's first date; the audio playlist's first
    // read starts 6 s into the run with a segment no longer dated, then dates 3 s behind.
    const clock = new DiscontinuityClock();
    const video = new PlaylistStitcher(20, 40, clock);
    const audio = new PlaylistStitcher(40, 40, clock);
    feed(video, playlist('r1', 0, 6, { 0: '2026-11-01T18:00:00.000Z' }), (n) => 100 + 2 * n);
    const audioText = playlist('r1', 6, 10, { 8: '2026-11-01T18:00:05.000Z', 9: '2026-11-01T18:00:06.000Z' }, { 6: 1, 7: 1, 8: 1, 9: 1 }).replaceAll('video1', 'audio2');

    // Act
    feed(audio, audioText, (n) => 100 + n - 0.021);

    // Assert
    const v = dates(video.render());
    const a = dates(audio.render());
    expect(a['r1_audio2_seg6.mp4']).toBe(v['r1_video1_seg3.mp4']);
    expect(a['r1_audio2_seg8.mp4']).toBe(v['r1_video1_seg4.mp4']);
    expect([7, 8, 9].map((n) => a[`r1_audio2_seg${n}.mp4`]! - a['r1_audio2_seg6.mp4']!)).toEqual([1000, 2000, 3000]);
  });

  it('after segments it never got, a playlist dates the next ones by the media time in between', () => {
    // Arrange: segments 3 and 4 left MediaMTX before the origin read them (a stalled poll).
    const st = new PlaylistStitcher(20, 40);
    feed(st, playlist('r1', 0, 3, { 0: '2026-11-01T18:00:00.000Z' }), (n) => 50 + 2 * n);

    // Act
    feed(st, playlist('r1', 5, 7, { 5: '2026-11-01T18:00:17.000Z', 6: '2026-11-01T18:00:19.000Z' }), (n) => 50 + 2 * n);

    // Assert
    const d = dates(st.render());
    expect(d['r1_video1_seg5.mp4']! - d['r1_video1_seg0.mp4']!).toBe(10_000);
    expect(d['r1_video1_seg6.mp4']! - d['r1_video1_seg0.mp4']!).toBe(12_000);
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
