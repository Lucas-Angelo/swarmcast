import { describe, expect, it } from 'vitest';
import { DiscontinuityClock, PlaylistStitcher, cleanMultivariant, parseMediaPlaylist, parseMultivariant, runKey } from '../../src/hls/playlist.js';

function media(prefix: string, from: number, count: number, seq = from): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="${prefix}_init.mp4"`];
  for (let i = from; i < from + count; i++) lines.push('#EXTINF:2.000000,', `${prefix}_${i}.m4s`);
  return lines.join('\n');
}

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
    const st = new PlaylistStitcher(5);
    feed(st, media('r1', 0, 3));
    feed(st, media('r1', 1, 4));
    const out = st.render();
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(out).toContain('#EXT-X-MAP:URI="r1_init.mp4"');
    expect(out.match(/\.m4s/g)).toHaveLength(5);
    feed(st, media('r1', 3, 4)); // r1_5, r1_6 new → window trims to 5
    expect(st.render()).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    expect(st.render()).not.toContain('ENDLIST');
  });

  it('turns an upstream restart (new init, sequence back to 0) into a discontinuity', () => {
    const st = new PlaylistStitcher(6);
    feed(st, media('r1', 10, 4));
    feed(st, media('r2', 0, 2, 0));
    const out = st.render();
    const lines = out.split('\n');
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    const disc = lines.indexOf('#EXT-X-DISCONTINUITY');
    expect(disc).toBeGreaterThan(0);
    expect(lines[disc + 1]).toBe('#EXT-X-MAP:URI="r2_init.mp4"');
    expect(lines.filter((l) => l.startsWith('#EXT-X-MAP'))).toHaveLength(2);
    expect(ccs(out)).toMatchObject({ 'r1_13.m4s': 0, 'r2_0.m4s': 1 });
    // Once the old run has left, the discontinuity sequence says where the new one starts.
    feed(st, media('r2', 0, 6, 0));
    const later = st.render();
    expect(later).not.toContain('r1_');
    expect(later).toContain('#EXT-X-MEDIA-SEQUENCE:4');
    expect(later).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(later).not.toContain('#EXT-X-DISCONTINUITY\n');
    expect(later).toContain('#EXT-X-MAP:URI="r2_init.mp4"');
    expect(ccs(later)['r2_0.m4s']).toBe(1);
  });

  it('numbers each upstream run the same in every playlist of an origin, even a run one playlist missed', () => {
    // OBS reconnected twice within seconds: run r2 reached the audio playlist (one segment) but
    // was gone before its first video segment was cached. Counted per playlist, audio was one
    // ahead of video from then on, and hls.js never found audio for what it played.
    const clock = new DiscontinuityClock();
    const video = new PlaylistStitcher(10, 0, clock);
    const audio = new PlaylistStitcher(10, 0, clock);
    feed(video, media('r1_video', 0, 3));
    feed(audio, media('r1_audio', 0, 3));
    feed(audio, media('r2_audio', 0, 1, 0));
    feed(video, media('r3_video', 0, 2, 0));
    feed(audio, media('r3_audio', 0, 2, 0));
    const v = ccs(video.render());
    const a = ccs(audio.render());
    expect(a['r3_audio_0.m4s']).toBe(v['r3_video_0.m4s']);
    expect(v).toMatchObject({ 'r1_video_0.m4s': 0, 'r3_video_0.m4s': 2 });
    expect(a).toMatchObject({ 'r1_audio_0.m4s': 0, 'r2_audio_0.m4s': 1, 'r3_audio_0.m4s': 2 });
    // The run video never saw is skipped with two tags, and stays right once r1 has left.
    expect(video.render()).toContain('#EXT-X-DISCONTINUITY\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="r3_video_init.mp4"');
    feed(video, media('r3_video', 0, 12, 0));
    feed(audio, media('r3_audio', 0, 12, 0));
    expect(video.render()).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:2');
    expect(audio.render()).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:2');
  });

  it('a playlist that appears later (a quality added on reconnect) gets the current run number', () => {
    // The ladder ran 720 + 480, OBS reconnected with 480 + 360 on: 360 is new, the others carry
    // the old run first. Started at 0, 360 matched the old run of the others, so hls.js placed
    // its segments a minute back and a viewer switching to it never played again.
    const clock = new DiscontinuityClock();
    const v480 = new PlaylistStitcher(10, 0, clock);
    feed(v480, media('ra_v480', 0, 4));
    feed(v480, media('rb_v480', 0, 2, 0));
    const v360 = new PlaylistStitcher(10, 0, clock);
    feed(v360, media('rb_v360', 0, 2, 0));
    expect(ccs(v360.render())['rb_v360_0.m4s']).toBe(ccs(v480.render())['rb_v480_0.m4s']);
    expect(v360.render()).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
  });

  it('the run of a segment is the prefix of its init segment name', () => {
    expect(runKey('c450dcd44098_audio2_init.mp4')).toBe('c450dcd44098');
    expect(runKey('r50c24b_v360_init.mp4')).toBe('r50c24b');
    expect(runKey('init.mp4')).toBeUndefined();
    expect(runKey(undefined)).toBeUndefined();
  });

  it('without run names (MPEG-TS, no init segment), a restart still counts as one discontinuity', () => {
    const st = new PlaylistStitcher(10);
    const head = ['#EXTM3U', '#EXT-X-TARGETDURATION:2'];
    feed(st, [...head, '#EXTINF:2.0,', 'seg0.ts', '#EXTINF:2.0,', 'seg1.ts'].join('\n'));
    feed(st, [...head, '#EXTINF:2.0,', 'seg1.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:2.0,', 'seg100.ts', '#EXTINF:2.0,', 'seg101.ts'].join('\n'));
    expect(ccs(st.render())).toEqual({ 'seg0.ts': 0, 'seg1.ts': 0, 'seg100.ts': 1, 'seg101.ts': 1 });
  });

  it('drops evicted segments from the old end and lists referenced files', () => {
    const st = new PlaylistStitcher(10);
    feed(st, media('r1', 0, 4));
    st.prune((n) => n !== 'r1_0.m4s');
    expect(st.length).toBe(3);
    expect(st.names()).toEqual(expect.arrayContaining(['r1_init.mp4', 'r1_3.m4s']));
    expect(st.names()).not.toContain('r1_0.m4s');
  });

  it('keeps the upstream target duration as a floor and grows it for long segments', () => {
    const st = new PlaylistStitcher(5);
    const text = media('r1', 0, 1).replace('#EXTINF:2.000000,', '#EXTINF:3.933,');
    feed(st, text);
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
    const m = parseMultivariant(FF);
    expect(m.audio).toEqual(['audio.m3u8']);
    expect(m.variants.map((v) => [v.name, v.height, v.bandwidth])).toEqual([
      ['v480.m3u8', 480, 1543060],
      ['v1080.m3u8', 1080, 7570980],
      ['audio.m3u8', undefined, 134168],
    ]);
  });

  it('removes the audio-only variant and sorts highest first', () => {
    const out = cleanMultivariant(FF);
    expect(out.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
    expect(out.indexOf('v1080.m3u8')).toBeLessThan(out.indexOf('v480.m3u8'));
    expect(out).toContain('URI="audio.m3u8"');
  });
});

describe('PlaylistStitcher time window', () => {
  // The ladder cuts audio every second and video every 2 s, with the same 20-entry list.
  // Counting entries only gave audio half the video window (20 s vs 40 s): a player 20 s
  // behind live sat on the oldest audio segment and froze after any stall.
  it('keeps at least minWindowS seconds, whatever the segment length', () => {
    const audio = new PlaylistStitcher(20, 40);
    const video = new PlaylistStitcher(20, 40);
    for (let n = 0; n < 60; n++) {
      feed(audio, media('a', n, 20).replaceAll('#EXTINF:2.000000,', '#EXTINF:1.000000,'));
      if (n % 2 === 0) feed(video, media('v', n / 2, 20));
    }
    expect(audio.length).toBe(40);
    expect(audio.durationS()).toBe(40);
    expect(video.length).toBe(20);
    expect(video.durationS()).toBe(40);
  });

  it('counts entries only when no time window is set (old behaviour)', () => {
    const st = new PlaylistStitcher(20);
    for (let n = 0; n < 30; n++) feed(st, media('a', n, 20).replaceAll('#EXTINF:2.000000,', '#EXTINF:1.000000,'));
    expect(st.length).toBe(20);
  });
});
