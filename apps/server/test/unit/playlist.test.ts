import { describe, expect, it } from 'vitest';
import { fileName, mediaPlaylistUris, parseMediaPlaylist, renderMediaPlaylist, rewriteMultivariant, SAFE_NAME } from '../../src/hls/playlist.js';

const MULTI = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=1569728,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-MAP:URI="732f968ad2f7_video1_init.mp4?session=abc"
#EXTINF:2.00000,
732f968ad2f7_video1_seg5.mp4?session=abc
#EXT-X-PROGRAM-DATE-TIME:2026-10-25T15:45:19.678-03:00
#EXTINF:2.00000,
732f968ad2f7_video1_seg6.mp4?session=abc
`;

describe('playlist helpers', () => {
  it('lists media playlists of a multivariant playlist', () => {
    expect(mediaPlaylistUris(MULTI).sort()).toEqual(['audio2_stream.m3u8', 'video1_stream.m3u8']);
  });
  it('parses media playlists (MediaMTX fMP4 output)', () => {
    const p = parseMediaPlaylist(MEDIA);
    expect(p.mapUri).toBe('732f968ad2f7_video1_init.mp4?session=abc');
    expect(p.entries).toHaveLength(2);
    expect(p.entries[1]!.tags[0]).toMatch(/PROGRAM-DATE-TIME/);
    expect(p.entries[0]!.duration).toBe(2);
  });
  it('renders playlists without MediaMTX session tokens', () => {
    const p = parseMediaPlaylist(MEDIA);
    const out = renderMediaPlaylist(p, p.entries.slice(0, 1));
    expect(out).not.toContain('session=');
    expect(out).toContain('#EXT-X-MAP:URI="732f968ad2f7_video1_init.mp4"');
    expect(out).toContain('732f968ad2f7_video1_seg5.mp4');
    expect(out).not.toContain('seg6');
    expect(rewriteMultivariant(MULTI)).toContain('URI="audio2_stream.m3u8"');
  });
  it('only accepts safe file names', () => {
    expect(fileName('../x/a_seg1.mp4?q=1')).toBe('a_seg1.mp4');
    expect(SAFE_NAME.test('a_seg1.mp4')).toBe(true);
    expect(SAFE_NAME.test('..%2fetc.mp4')).toBe(false);
    expect(SAFE_NAME.test('index.m3u8')).toBe(true);
    expect(SAFE_NAME.test('x.html')).toBe(false);
  });
});
