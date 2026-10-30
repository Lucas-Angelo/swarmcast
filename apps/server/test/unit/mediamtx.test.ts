import { describe, expect, it } from 'vitest';
import { renderMediaMtxConfig, streamPath } from '../../src/media/mediamtx.js';

// The MediaMTX config SwarmCast writes: RTMP in and HLS out on localhost only, behind the
// stream key's path, with every other protocol off.

const STREAM_KEY = 'sc_abcdefghijklmnop';

describe('MediaMTX config', () => {
  const cfg = renderMediaMtxConfig({ rtmpPort: 1935, hlsPort: 8888, streamKey: STREAM_KEY });

  it('listens on localhost only', () => {
    // Assert
    expect(cfg).toContain('rtmpAddress: 127.0.0.1:1935');
    expect(cfg).toContain('hlsAddress: 127.0.0.1:8888');
  });

  it('requires the stream key path and has no catch-all path', () => {
    // Assert
    expect(cfg).toContain(`  ${streamPath(STREAM_KEY)}:`);
    expect(cfg).not.toMatch(/all_others|~\^/);
  });

  it('uses plain fMP4 HLS (not LL-HLS)', () => {
    // Assert
    expect(cfg).toContain('hlsVariant: fmp4');
  });

  it.each(['rtsp', 'webrtc', 'srt', 'moq', 'api', 'metrics', 'pprof', 'playback'])('disables %s', (protocol) => {
    // Assert
    expect(cfg).toContain(`${protocol}: false`);
  });

  it('refuses unsafe stream keys', () => {
    // Act
    const render = () => renderMediaMtxConfig({ rtmpPort: 1, hlsPort: 2, streamKey: 'bad key' });
    // Assert
    expect(render).toThrow();
  });
});
