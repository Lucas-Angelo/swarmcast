import { describe, expect, it } from 'vitest';
import { PlaylistStitcher, cleanMultivariant, parseMediaPlaylist, parseMultivariant } from '../../src/hls/playlist.js';

function media(prefix: string, from: number, count: number, seq = from): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="${prefix}_init.mp4"`];
  for (let i = from; i < from + count; i++) lines.push('#EXTINF:2.000000,', `${prefix}_${i}.m4s`);
  return lines.join('\n');
}

function feed(st: PlaylistStitcher, text: string): void {
  const p = parseMediaPlaylist(text);
  st.update(p, p.entries);
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
    // The old run leaves; the tag stays with the first new segment until that one leaves too,
    // and only then does the discontinuity sequence count it.
    feed(st, media('r2', 0, 6, 0));
    const later = st.render();
    expect(later).not.toContain('r1_');
    expect(later).toContain('#EXT-X-MEDIA-SEQUENCE:4');
    expect(later).toContain('#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="r2_init.mp4"');
    expect(later).not.toContain('DISCONTINUITY-SEQUENCE');
    feed(st, media('r2', 2, 6, 2));
    const latest = st.render();
    expect(latest).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(latest).not.toContain('#EXT-X-DISCONTINUITY\n');
    expect(latest).toContain('#EXT-X-MAP:URI="r2_init.mp4"');
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
