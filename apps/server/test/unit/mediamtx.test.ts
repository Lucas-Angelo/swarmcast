import { describe, expect, it } from 'vitest';
import { renderMediaMtxConfig, streamPath } from '../../src/media/mediamtx.js';

describe('MediaMTX config', () => {
  const cfg = renderMediaMtxConfig({ rtmpPort: 1935, hlsPort: 8888, streamKey: 'sc_abcdefghijklmnop' });
  it('listens on localhost only and requires the stream key path', () => {
    expect(cfg).toContain('rtmpAddress: 127.0.0.1:1935');
    expect(cfg).toContain('hlsAddress: 127.0.0.1:8888');
    expect(cfg).toContain(`  ${streamPath('sc_abcdefghijklmnop')}:`);
    expect(cfg).not.toMatch(/all_others|~\^/);
  });
  it('uses plain fMP4 HLS (not LL-HLS) and disables every other protocol', () => {
    expect(cfg).toContain('hlsVariant: fmp4');
    for (const k of ['rtsp', 'webrtc', 'srt', 'moq', 'api', 'metrics', 'pprof', 'playback']) expect(cfg).toContain(`${k}: false`);
  });
  it('refuses unsafe stream keys', () => {
    expect(() => renderMediaMtxConfig({ rtmpPort: 1, hlsPort: 2, streamKey: 'bad key' })).toThrow();
  });
});
