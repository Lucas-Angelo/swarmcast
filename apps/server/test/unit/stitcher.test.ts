import { describe, expect, it } from 'vitest';
import { DiscontinuityClock, PlaylistStitcher, cleanMultivariant, parseMediaPlaylist, parseMultivariant, runKey } from '../../src/hls/playlist.js';
import { mediaPlaylist } from './helpers-b.js';

// The origin's playlist stitcher: it keeps a window of segments across upstream restarts (OBS
// reconnecting, a ladder ffmpeg restarting) and numbers each upstream run with discontinuities
// the way hls.js counts them. Regressions these tests guard:
// - OBS reconnected twice within seconds: run r2 reached the audio playlist (one segment) but was
//   gone before its first video segment was cached. Counted per playlist, audio was one run ahead
//   of video from then on, and hls.js never found audio for what it played. Every playlist of an
//   origin shares one DiscontinuityClock.
// - A quality added on reconnect (the ladder ran 720 + 480, OBS came back with 480 + 360): started
//   at 0, the new 360 playlist matched the old run of the others, so hls.js placed its segments a
//   minute back and a viewer switching to it never played again.
// - A ladder ffmpeg crash and restart (new run id, same playlist names), as in the ladder
//   integration test: the original OBS run (MediaMTX) is run 0, the ladder's first run starts at 1
//   (EXT-X-DISCONTINUITY-SEQUENCE:1, no tag), and after the crash its new run id is run 2, after
//   one tag, in 720p and 480p alike.
// - The ladder cuts audio every second and video every 2 s with the same 20-entry list. Counting
//   entries only gave audio half the video window (20 s vs 40 s): a player 20 s behind live sat on
//   the oldest audio segment and froze after any stall. The window is kept in seconds.

function feed(st: PlaylistStitcher, text: string): void {
  const p = parseMediaPlaylist(text);
  st.update(p, p.entries);
}

/** The discontinuity number a player gives each segment (hls.js `cc`: the sequence plus the tags before it). */
function ccs(text: string): Record<string, number> {
  let cc = Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0);
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (line === '#EXT-X-DISCONTINUITY') cc += 1;
    else if (line && !line.startsWith('#')) out[line] = cc;
  }
  return out;
}

describe('PlaylistStitcher', () => {
  it('passes a normal live playlist through with growing media sequence', () => {
    // Arrange
    const st = new PlaylistStitcher(5);
    // Act
    feed(st, mediaPlaylist('r1', 0, 3));
    feed(st, mediaPlaylist('r1', 1, 4));
    // Assert
    const out = st.render();
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(out).toContain('#EXT-X-MAP:URI="r1_init.mp4"');
    expect(out.match(/\.m4s/g)).toHaveLength(5);
  });

  it('trims the window to its size as new segments arrive, and never ends the playlist', () => {
    // Arrange
    const st = new PlaylistStitcher(5);
    feed(st, mediaPlaylist('r1', 0, 3));
    feed(st, mediaPlaylist('r1', 1, 4));
    // Act
    feed(st, mediaPlaylist('r1', 3, 4));
    // Assert
    const out = st.render();
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    expect(out).not.toContain('ENDLIST');
  });

  it('turns an upstream restart (new init, sequence back to 0) into a discontinuity', () => {
    // Arrange
    const st = new PlaylistStitcher(6);
    feed(st, mediaPlaylist('r1', 10, 4));
    // Act
    feed(st, mediaPlaylist('r2', 0, 2, { sequence: 0 }));
    // Assert
    const out = st.render();
    const lines = out.split('\n');
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    const disc = lines.indexOf('#EXT-X-DISCONTINUITY');
    expect(disc).toBeGreaterThan(0);
    expect(lines[disc + 1]).toBe('#EXT-X-MAP:URI="r2_init.mp4"');
    expect(lines.filter((l) => l.startsWith('#EXT-X-MAP'))).toHaveLength(2);
    expect(ccs(out)).toMatchObject({ 'r1_13.m4s': 0, 'r2_0.m4s': 1 });
  });

  it('once the old run has left, the discontinuity sequence says where the new one starts', () => {
    // Arrange
    const st = new PlaylistStitcher(6);
    feed(st, mediaPlaylist('r1', 10, 4));
    feed(st, mediaPlaylist('r2', 0, 2, { sequence: 0 }));
    // Act
    feed(st, mediaPlaylist('r2', 0, 6, { sequence: 0 }));
    // Assert
    const later = st.render();
    expect(later).not.toContain('r1_');
    expect(later).toContain('#EXT-X-MEDIA-SEQUENCE:4');
    expect(later).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(later).not.toContain('#EXT-X-DISCONTINUITY\n');
    expect(later).toContain('#EXT-X-MAP:URI="r2_init.mp4"');
    expect(ccs(later)['r2_0.m4s']).toBe(1);
  });

  describe('a run that reached the audio playlist only (OBS reconnected twice within seconds)', () => {
    /** Video and audio of one origin: run r2 reaches audio only, then r3 reaches both. */
    function reconnectedTwice() {
      const clock = new DiscontinuityClock();
      const video = new PlaylistStitcher(10, 0, clock);
      const audio = new PlaylistStitcher(10, 0, clock);
      feed(video, mediaPlaylist('r1_video', 0, 3));
      feed(audio, mediaPlaylist('r1_audio', 0, 3));
      feed(audio, mediaPlaylist('r2_audio', 0, 1, { sequence: 0 }));
      feed(video, mediaPlaylist('r3_video', 0, 2, { sequence: 0 }));
      feed(audio, mediaPlaylist('r3_audio', 0, 2, { sequence: 0 }));
      return { video, audio };
    }

    it('gets the same run number in every playlist of the origin', () => {
      // Act
      const { video, audio } = reconnectedTwice();
      // Assert
      const v = ccs(video.render());
      const a = ccs(audio.render());
      expect(a['r3_audio_0.m4s']).toBe(v['r3_video_0.m4s']);
      expect(v).toMatchObject({ 'r1_video_0.m4s': 0, 'r3_video_0.m4s': 2 });
      expect(a).toMatchObject({ 'r1_audio_0.m4s': 0, 'r2_audio_0.m4s': 1, 'r3_audio_0.m4s': 2 });
    });

    it('is skipped with two tags in the playlist that never saw it', () => {
      // Act
      const { video } = reconnectedTwice();
      // Assert
      expect(video.render()).toContain('#EXT-X-DISCONTINUITY\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="r3_video_init.mp4"');
    });

    it('stays counted right once the first run has left', () => {
      // Arrange
      const { video, audio } = reconnectedTwice();
      // Act
      feed(video, mediaPlaylist('r3_video', 0, 12, { sequence: 0 }));
      feed(audio, mediaPlaylist('r3_audio', 0, 12, { sequence: 0 }));
      // Assert
      expect(video.render()).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:2');
      expect(audio.render()).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:2');
    });
  });

  it('a playlist that appears later (a quality added on reconnect) gets the current run number', () => {
    // Arrange
    const clock = new DiscontinuityClock();
    const v480 = new PlaylistStitcher(10, 0, clock);
    feed(v480, mediaPlaylist('ra_v480', 0, 4));
    feed(v480, mediaPlaylist('rb_v480', 0, 2, { sequence: 0 }));
    const v360 = new PlaylistStitcher(10, 0, clock);
    // Act
    feed(v360, mediaPlaylist('rb_v360', 0, 2, { sequence: 0 }));
    // Assert
    expect(ccs(v360.render())['rb_v360_0.m4s']).toBe(ccs(v480.render())['rb_v480_0.m4s']);
    expect(v360.render()).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
  });

  describe('a ladder ffmpeg crash and restart (new run id, same playlist names)', () => {
    /** The source playlist (MediaMTX, run 0) and the ladder's 720p and 480p, first ladder run fed. */
    function ladder() {
      const clock = new DiscontinuityClock();
      const source = new PlaylistStitcher(10, 0, clock);
      feed(source, mediaPlaylist('m1_video1', 0, 3));
      const v720 = new PlaylistStitcher(10, 0, clock);
      const v480 = new PlaylistStitcher(10, 0, clock);
      feed(v720, mediaPlaylist('r1_v720', 0, 3));
      feed(v480, mediaPlaylist('r1_v480', 0, 3));
      return { v720, v480 };
    }

    it('the ladder\'s first run is run 1, with no tag', () => {
      // Act
      const { v720 } = ladder();
      // Assert
      const before = v720.render();
      expect(before).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
      expect(before).not.toMatch(/^#EXT-X-DISCONTINUITY$/m);
    });

    it('the restart is one discontinuity in every rendition, run 2', () => {
      // Arrange
      const { v720, v480 } = ladder();
      // Act
      feed(v720, mediaPlaylist('r2_v720', 0, 2, { sequence: 0 }));
      feed(v480, mediaPlaylist('r2_v480', 0, 2, { sequence: 0 }));
      // Assert
      for (const st of [v720, v480]) {
        const out = st.render();
        expect(out.match(/^#EXT-X-DISCONTINUITY$/gm)).toHaveLength(1);
        expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      }
      expect(ccs(v720.render())['r2_v720_0.m4s']).toBe(2);
      expect(ccs(v480.render())['r2_v480_0.m4s']).toBe(2);
    });
  });

  it.each([
    ['c450dcd44098_audio2_init.mp4', 'c450dcd44098'],
    ['r50c24b_v360_init.mp4', 'r50c24b'],
    ['init.mp4', undefined],
    [undefined, undefined],
  ])('the run of a segment is the prefix of its init segment name: %s → %s', (init, run) => {
    // Act
    const key = runKey(init);
    // Assert
    expect(key).toBe(run);
  });

  it('without run names (MPEG-TS, no init segment), a restart still counts as one discontinuity', () => {
    // Arrange
    const st = new PlaylistStitcher(10);
    const head = ['#EXTM3U', '#EXT-X-TARGETDURATION:2'];
    // Act
    feed(st, [...head, '#EXTINF:2.0,', 'seg0.ts', '#EXTINF:2.0,', 'seg1.ts'].join('\n'));
    feed(st, [...head, '#EXTINF:2.0,', 'seg1.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:2.0,', 'seg100.ts', '#EXTINF:2.0,', 'seg101.ts'].join('\n'));
    // Assert
    expect(ccs(st.render())).toEqual({ 'seg0.ts': 0, 'seg1.ts': 0, 'seg100.ts': 1, 'seg101.ts': 1 });
  });

  it('drops evicted segments from the old end and lists referenced files', () => {
    // Arrange
    const st = new PlaylistStitcher(10);
    feed(st, mediaPlaylist('r1', 0, 4));
    // Act
    st.prune((n) => n !== 'r1_0.m4s');
    // Assert
    expect(st.length).toBe(3);
    expect(st.names()).toEqual(expect.arrayContaining(['r1_init.mp4', 'r1_3.m4s']));
    expect(st.names()).not.toContain('r1_0.m4s');
  });

  it('keeps the upstream target duration as a floor and grows it for long segments', () => {
    // Arrange
    const st = new PlaylistStitcher(5);
    // Act
    feed(st, mediaPlaylist('r1', 0, 1, { segmentS: 3.933, targetDurationS: 2 }));
    // Assert
    expect(st.render()).toContain('#EXT-X-TARGETDURATION:4');
  });
});

describe('multivariant cleanup', () => {
  const FF = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_3",DEFAULT=YES,CHANNELS="1",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1543060,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_aud"',
    'v480.m3u8',
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=7570980,AVERAGE-BANDWIDTH=6197172,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"',
    'v1080.m3u8',
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=134168,AVERAGE-BANDWIDTH=131088,CODECS="mp4a.40.2",AUDIO="group_aud"',
    'audio.m3u8',
  ].join('\n');

  it('parses variants and audio renditions', () => {
    // Act
    const m = parseMultivariant(FF);
    // Assert
    expect(m.audio).toEqual(['audio.m3u8']);
    expect(m.variants.map((v) => [v.name, v.height, v.bandwidth])).toEqual([
      ['v480.m3u8', 480, 1543060],
      ['v1080.m3u8', 1080, 7570980],
      ['audio.m3u8', undefined, 134168],
    ]);
  });

  it('removes the audio-only variant and sorts highest first', () => {
    // Act
    const out = cleanMultivariant(FF);
    // Assert
    expect(out.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    expect(out.indexOf('v1080.m3u8')).toBeLessThan(out.indexOf('v480.m3u8'));
    expect(out).toContain('URI="audio.m3u8"');
  });
});

describe('PlaylistStitcher time window', () => {
  it('keeps at least minWindowS seconds, whatever the segment length', () => {
    // Arrange
    const audio = new PlaylistStitcher(20, 40);
    const video = new PlaylistStitcher(20, 40);
    // Act
    for (let n = 0; n < 60; n++) {
      feed(audio, mediaPlaylist('a', n, 20, { segmentS: 1 }));
      if (n % 2 === 0) feed(video, mediaPlaylist('v', n / 2, 20));
    }
    // Assert
    expect(audio.length).toBe(40);
    expect(audio.durationS()).toBe(40);
    expect(video.length).toBe(20);
    expect(video.durationS()).toBe(40);
  });

  it('counts entries only when no time window is set (old behaviour)', () => {
    // Arrange
    const st = new PlaylistStitcher(20);
    // Act
    for (let n = 0; n < 30; n++) feed(st, mediaPlaylist('a', n, 20, { segmentS: 1 }));
    // Assert
    expect(st.length).toBe(20);
  });
});
