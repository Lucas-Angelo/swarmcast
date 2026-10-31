import { describe, expect, it } from 'vitest';
import { computeUploadCeiling, defaultQualitySettings, planLadder, qualitySettingsUpdateSchema, rungKbps, variantStreamSwarmId, type EncoderProbeResult } from '@swarmcast/shared';
import { candidateEncoders, encoderArgs } from '../../src/quality/encoders.js';
import { buildLadderArgs, renderLadderMultivariant } from '../../src/quality/transcoder.js';
import { SOURCE_1080P, qualitySettings } from './helpers-b.js';

// The quality ladder plan (which renditions, with which encoder), the upload ceiling, the panel's
// settings schema, the per-variant P2P swarm ids and the ffmpeg arguments of the ladder.

const VT: EncoderProbeResult = { id: 'h264_videotoolbox', hardware: true, ok: true, fps: 400 };
const X264_FAST: EncoderProbeResult = { id: 'libx264', hardware: false, ok: true, fps: 220 };
const X264_SLOW: EncoderProbeResult = { id: 'libx264', hardware: false, ok: true, fps: 60 };

describe('planLadder', () => {
  it('auto with a hardware encoder: source + 720p + 480p + 360p', () => {
    // Act
    const p = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [VT, X264_FAST], ffmpegAvailable: true, cpuCores: 8 });
    // Assert
    expect(p.encoder).toBe('h264_videotoolbox');
    expect(p.rungs.map((r) => [r.name, r.width, r.height, r.kbps, r.source])).toEqual([
      ['v1080', 1920, 1080, 6000, true],
      ['v720', 1280, 720, 3000, false],
      ['v480', 854, 480, 1400, false],
      ['v360', 640, 360, 800, false],
    ]);
  });

  it('manual with a forced encoder: exactly her heights (below the source), with her encoder', () => {
    // Arrange
    const s = qualitySettings((x) => {
      x.ladder.mode = 'manual';
      x.ladder.heights = [360, 720];
      x.ladder.encoder = 'libx264';
    });
    // Act
    const p = planLadder({ source: SOURCE_1080P, settings: s, encoders: [VT, X264_SLOW], ffmpegAvailable: true, cpuCores: 4 });
    // Assert
    expect(p.rungs.map((r) => r.height)).toEqual([1080, 720, 360]);
    expect(p.encoder).toBe('libx264');
  });

  it('manual with no heights picked: the source only', () => {
    // Arrange
    const none = qualitySettings((x) => {
      x.ladder.mode = 'manual';
      x.ladder.heights = [];
    });
    // Act
    const p = planLadder({ source: SOURCE_1080P, settings: none, encoders: [VT], ffmpegAvailable: true, cpuCores: 8 });
    // Assert
    expect(p.rungs).toHaveLength(1);
  });

  it.each([
    ['there is no ffmpeg', SOURCE_1080P, false],
    ['the source is already small (360p)', { ...SOURCE_1080P, width: 640, height: 360 }, true],
  ])('source only when %s', (_what, source, ffmpegAvailable) => {
    // Act
    const p = planLadder({ source, settings: qualitySettings(), encoders: [VT], ffmpegAvailable, cpuCores: 8 });
    // Assert
    expect(p.rungs).toHaveLength(1);
  });

  it('a 720p source gets 480p and 360p below it', () => {
    // Act
    const p720 = planLadder({ source: { ...SOURCE_1080P, width: 1280, height: 720 }, settings: qualitySettings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8 });
    // Assert
    expect(p720.rungs.map((r) => r.height)).toEqual([720, 480, 360]);
  });

  it.each([
    ['720p at 60 fps (no source bitrate known)', 720, 60, 0, 4500],
    ['720p capped at 70 % of a 3000 kbps source', 720, 30, 3000, 2100],
    ['360p capped at 70 % of a 600 kbps source', 360, 30, 600, 400],
  ] as const)('scales bitrates for 60 fps and never above 70 %% of the source: %s', (_what, height, fps, sourceKbps, expected) => {
    // Act
    const kbps = rungKbps(height, fps, sourceKbps);
    // Assert
    expect(kbps).toBe(expected);
  });

  it('warns when the upload cannot carry one viewer at the source quality', () => {
    // Act
    const p = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8, uploadCeilingMbps: 4 });
    // Assert
    expect(p.reasons.map((r) => r.text).join(' ')).toMatch(/cannot carry even one viewer/);
    expect(p.reasons.map((r) => r.code)).toContain('quality.reason.uploadLow');
  });
});

describe('upload ceiling', () => {
  it.each([
    ['20 Mbps measured', 20, 9.5],
    ['no speed test', undefined, undefined],
    ['5 Mbps measured', 5, 0.5],
  ])('measured upload − headroom − other stream × 1.25: %s', (_what, measuredUploadMbps, expected) => {
    // Act
    const ceiling = computeUploadCeiling({ measuredUploadMbps, otherStreamKbps: 6000, headroomPercent: 15 });
    // Assert
    expect(ceiling).toBe(expected);
  });
});

describe('settings schema', () => {
  it('accepts the panel update: a null password clears it', () => {
    // Act
    const ok = qualitySettingsUpdateSchema.parse({ ...defaultQualitySettings(), obsWebsocket: { enabled: true, url: 'ws://127.0.0.1:4455', password: null } });
    // Assert
    expect(ok.obsWebsocket.password).toBeNull();
  });

  it('accepts only a loopback obs-websocket', () => {
    // Act
    const parse = () => qualitySettingsUpdateSchema.parse({ ...defaultQualitySettings(), obsWebsocket: { enabled: true, url: 'ws://192.168.0.5:4455' } });
    // Assert
    expect(parse).toThrow();
  });
});

describe('per-variant swarm ids', () => {
  it.each([
    ['a video variant is keyed by its height', 'main', 720, 'swarmcast-abc-main-720'],
    ['a video variant without a height is height 0', 'main', undefined, 'swarmcast-abc-main-0'],
    ['audio keeps its plain id', 'secondary', 0, 'swarmcast-abc-secondary'],
  ] as const)('%s', (_what, type, height, expected) => {
    // Act
    const id = variantStreamSwarmId('abc', type, height);
    // Assert
    expect(id).toBe(expected);
  });
});

describe('ffmpeg ladder arguments', () => {
  /** Source + 720p + 480p (360p left out to keep the expectations short). */
  const rungs = planLadder({ source: SOURCE_1080P, settings: qualitySettings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8 }).rungs.slice(0, 3);

  it('copies the source, encodes the rest with keyframes at the source keyframes, one shared audio', () => {
    // Act
    const a = buildLadderArgs({ inputUrl: 'rtmp://127.0.0.1:1935/live/k', outDir: '/tmp/x', runId: 'r1', rungs, encoder: 'h264_videotoolbox', hasAudio: true });
    // Assert
    const s = a.join(' ');
    expect(s).toContain('-c:v:0 copy');
    expect(s).toContain('-filter:v:1 scale=-2:720');
    expect(s).toContain('-c:v:1 h264_videotoolbox');
    expect(s).toContain('-force_key_frames:v:2 source');
    expect(s).toContain('-c:a copy');
    expect(a[a.indexOf('-var_stream_map') + 1]).toBe('v:0,agroup:aud,name:v1080 v:1,agroup:aud,name:v720 v:2,agroup:aud,name:v480 a:0,agroup:aud,name:audio');
    expect(s).toContain('-hls_segment_type fmp4');
    expect(s).toContain('temp_file');
    expect(a.filter((x) => x === '-map')).toHaveLength(4);
  });

  it.each([
    ['macOS starts with VideoToolbox', () => candidateEncoders('darwin')[0], 'h264_videotoolbox'],
    ['Windows tries AMF', () => candidateEncoders('win32').includes('h264_amf'), true],
  ])('has per-OS encoder candidates: %s', (_what, pick, expected) => {
    // Act
    const got = pick();
    // Assert
    expect(got).toBe(expected);
  });

  it('sets up the VAAPI device', () => {
    // Act
    const { filter } = encoderArgs('h264_vaapi', 'v:1', { kbps: 1000, height: 480, fps: 30 });
    // Assert
    expect(filter).toContain('hwupload');
  });

  it('passes the thread count to x264', () => {
    // Act
    const { args } = encoderArgs('libx264', '', { kbps: 1000, height: 480, fps: 30, threads: 2 });
    // Assert
    expect(args.join(' ')).toContain('threads=2');
  });

  describe('the multivariant written from the plan (ffmpeg leaves out the copied source)', () => {
    const ffMaster = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_3",DEFAULT=YES,CHANNELS="1",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3300000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_aud"',
      'v720.m3u8',
    ].join('\n');

    it('is not written while a rendition playlist is missing', () => {
      // Act
      const out = renderLadderMultivariant(rungs, true, ffMaster, (f) => f !== 'v480.m3u8', { kbps: 6000 });
      // Assert
      expect(out).toBeNull();
    });

    it('lists every rendition, the source with its own codecs and bandwidth', () => {
      // Act
      const out = renderLadderMultivariant(rungs, true, ffMaster, () => true, { kbps: 6000, codecs: 'avc1.640028,mp4a.40.2' })!;
      // Assert
      const infs = out.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
      expect(infs).toHaveLength(3);
      expect(infs[0]).toContain('RESOLUTION=1920x1080');
      expect(infs[0]).toContain('CODECS="avc1.640028,mp4a.40.2"');
      expect(infs[0]).toContain('BANDWIDTH=7200000');
      expect(infs[1]).toContain('CODECS="avc1.64001f,mp4a.40.2"');
      expect(out).toContain('URI="audio.m3u8"');
    });
  });
});
