import { describe, expect, it } from 'vitest';
import { fileName, mediaPlaylistUris, parseMediaPlaylist, renderMediaPlaylist, rewriteMultivariant, SAFE_NAME } from '../../src/hls/playlist.js';

// The M3U8 helpers of the origin, on MediaMTX's own output (fMP4, session tokens in every URI).
// Playlist lines end with LF or CRLF (RFC 8216, section 4.1): a playlist written with Windows line
// endings must parse the same.

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
    // Act
    const uris = mediaPlaylistUris(MULTI);
    // Assert
    expect(uris.sort()).toEqual(['audio2_stream.m3u8', 'video1_stream.m3u8']);
  });

  it('parses media playlists (MediaMTX fMP4 output)', () => {
    // Act
    const p = parseMediaPlaylist(MEDIA);
    // Assert
    expect(p.mapUri).toBe('732f968ad2f7_video1_init.mp4?session=abc');
    expect(p.entries).toHaveLength(2);
    expect(p.entries[1]!.tags[0]).toMatch(/PROGRAM-DATE-TIME/);
    expect(p.entries[0]!.duration).toBe(2);
  });

  it('parses a playlist with CRLF line endings the same', () => {
    // Act
    const p = parseMediaPlaylist(MEDIA.replaceAll('\n', '\r\n'));
    // Assert
    expect(p).toEqual(parseMediaPlaylist(MEDIA));
  });

  it('renders playlists without MediaMTX session tokens', () => {
    // Arrange
    const p = parseMediaPlaylist(MEDIA);
    // Act
    const out = renderMediaPlaylist(p, p.entries.slice(0, 1));
    // Assert
    expect(out).not.toContain('session=');
    expect(out).toContain('#EXT-X-MAP:URI="732f968ad2f7_video1_init.mp4"');
    expect(out).toContain('732f968ad2f7_video1_seg5.mp4');
    expect(out).not.toContain('seg6');
  });

  it('rewrites the multivariant playlist to plain file names', () => {
    // Act
    const out = rewriteMultivariant(MULTI);
    // Assert
    expect(out).toContain('URI="audio2_stream.m3u8"');
  });

  it('reduces a URI to its file name, without directories or query', () => {
    // Act
    const name = fileName('../x/a_seg1.mp4?q=1');
    // Assert
    expect(name).toBe('a_seg1.mp4');
  });

  it.each([
    ['a_seg1.mp4', true],
    ['index.m3u8', true],
    ['..%2fetc.mp4', false],
    ['x.html', false],
  ])('only accepts safe file names: %s → %s', (name, safe) => {
    // Act
    const ok = SAFE_NAME.test(name);
    // Assert
    expect(ok).toBe(safe);
  });
});
