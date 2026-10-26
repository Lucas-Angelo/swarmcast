import { describe, expect, it } from 'vitest';
import {
  computeUploadCeiling,
  defaultQualitySettings,
  planLadder,
  qualitySettingsUpdateSchema,
  rungKbps,
  variantStreamSwarmId,
  type EncoderProbeResult,
  type QualitySettings,
  type SourceInfo,
} from '@swarmcast/shared';
import { candidateEncoders, encoderArgs } from '../../src/quality/encoders.js';
import { buildLadderArgs, renderLadderMultivariant } from '../../src/quality/transcoder.js';

const SRC: SourceInfo = { width: 1920, height: 1080, fps: 30, kbps: 6000, hasAudio: true };
const VT: EncoderProbeResult = { id: 'h264_videotoolbox', hardware: true, ok: true, fps: 400 };
const X264_FAST: EncoderProbeResult = { id: 'libx264', hardware: false, ok: true, fps: 220 };
const X264_SLOW: EncoderProbeResult = { id: 'libx264', hardware: false, ok: true, fps: 60 };

function settings(patch: (s: QualitySettings) => void = () => {}): QualitySettings {
  const s = defaultQualitySettings();
  patch(s);
  return s;
}

describe('planLadder', () => {
  it('auto with a hardware encoder: source + 720p + 480p + 360p', () => {
    const p = planLadder({ source: SRC, settings: settings(), encoders: [VT, X264_FAST], ffmpegAvailable: true, cpuCores: 8 });
    expect(p.encoder).toBe('h264_videotoolbox');
    expect(p.rungs.map((r) => [r.name, r.width, r.height, r.kbps, r.source])).toEqual([
      ['v1080', 1920, 1080, 6000, true],
      ['v720', 1280, 720, 3000, false],
      ['v480', 854, 480, 1400, false],
      ['v360', 640, 360, 800, false],
    ]);
  });

  it('manual with a forced encoder: exactly her heights (below the source), with her encoder', () => {
    const s = settings((x) => {
      x.ladder.mode = 'manual';
      x.ladder.heights = [360, 720];
      x.ladder.encoder = 'libx264';
    });
    const p = planLadder({ source: SRC, settings: s, encoders: [VT, X264_SLOW], ffmpegAvailable: true, cpuCores: 4 });
    expect(p.rungs.map((r) => r.height)).toEqual([1080, 720, 360]);
    expect(p.encoder).toBe('libx264');
    const none = settings((x) => {
      x.ladder.mode = 'manual';
      x.ladder.heights = [];
    });
    expect(planLadder({ source: SRC, settings: none, encoders: [VT], ffmpegAvailable: true, cpuCores: 8 }).rungs).toHaveLength(1);
  });

  it('source only when there is no ffmpeg or the source is already small', () => {
    expect(planLadder({ source: SRC, settings: settings(), encoders: [VT], ffmpegAvailable: false, cpuCores: 8 }).rungs).toHaveLength(1);
    const small = { ...SRC, width: 640, height: 360 };
    expect(planLadder({ source: small, settings: settings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8 }).rungs).toHaveLength(1);
    const p720 = planLadder({ source: { ...SRC, width: 1280, height: 720 }, settings: settings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8 });
    expect(p720.rungs.map((r) => r.height)).toEqual([720, 480, 360]);
  });

  it('scales bitrates for 60 fps and never above 70 % of the source', () => {
    expect(rungKbps(720, 60, 0)).toBe(4500);
    expect(rungKbps(720, 30, 3000)).toBe(2100);
    expect(rungKbps(360, 30, 600)).toBe(400);
  });

  it('warns when the upload cannot carry one viewer at the source quality', () => {
    const p = planLadder({ source: SRC, settings: settings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8, uploadCeilingMbps: 4 });
    expect(p.reasons.map((r) => r.text).join(' ')).toMatch(/cannot carry even one viewer/);
    expect(p.reasons.map((r) => r.code)).toContain('quality.reason.uploadLow');
  });
});

describe('upload ceiling', () => {
  it('measured upload − headroom − other stream × 1.25', () => {
    expect(computeUploadCeiling({ measuredUploadMbps: 20, otherStreamKbps: 6000, headroomPercent: 15 })).toBe(9.5);
    expect(computeUploadCeiling({ measuredUploadMbps: undefined, otherStreamKbps: 6000, headroomPercent: 15 })).toBeUndefined();
    expect(computeUploadCeiling({ measuredUploadMbps: 5, otherStreamKbps: 6000, headroomPercent: 15 })).toBe(0.5);
  });
});

describe('settings schema', () => {
  it('accepts the panel update (null password clears, absent keeps) and only loopback obs-websocket', () => {
    const ok = qualitySettingsUpdateSchema.parse({ ...defaultQualitySettings(), obsWebsocket: { enabled: true, url: 'ws://127.0.0.1:4455', password: null } });
    expect(ok.obsWebsocket.password).toBeNull();
    expect(() => qualitySettingsUpdateSchema.parse({ ...defaultQualitySettings(), obsWebsocket: { enabled: true, url: 'ws://192.168.0.5:4455' } })).toThrow();
  });
});

describe('per-variant swarm ids', () => {
  it('video variants are keyed by height, audio keeps its plain id', () => {
    expect(variantStreamSwarmId('abc', 'main', 720)).toBe('swarmcast-abc-main-720');
    expect(variantStreamSwarmId('abc', 'main', undefined)).toBe('swarmcast-abc-main-0');
    expect(variantStreamSwarmId('abc', 'secondary', 0)).toBe('swarmcast-abc-secondary');
  });
});

describe('ffmpeg ladder arguments', () => {
  // Source + 720p + 480p (drop 360p to keep the expectations short).
  const rungs = planLadder({ source: SRC, settings: settings(), encoders: [VT], ffmpegAvailable: true, cpuCores: 8 }).rungs.slice(0, 3);

  it('copies the source, encodes the rest with keyframes at the source keyframes, one shared audio', () => {
    const a = buildLadderArgs({ inputUrl: 'rtmp://127.0.0.1:1935/live/k', outDir: '/tmp/x', runId: 'r1', rungs, encoder: 'h264_videotoolbox', hasAudio: true });
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

  it('has per-OS encoder candidates and VAAPI device setup', () => {
    expect(candidateEncoders('darwin')[0]).toBe('h264_videotoolbox');
    expect(candidateEncoders('win32')).toContain('h264_amf');
    expect(encoderArgs('h264_vaapi', 'v:1', { kbps: 1000, height: 480, fps: 30 }).filter).toContain('hwupload');
    expect(encoderArgs('libx264', '', { kbps: 1000, height: 480, fps: 30, threads: 2 }).args.join(' ')).toContain('threads=2');
  });

  it('writes the multivariant from the plan (ffmpeg leaves out the copied source)', () => {
    const ffMaster = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_3",DEFAULT=YES,CHANNELS="1",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3300000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_aud"',
      'v720.m3u8',
    ].join('\n');
    expect(renderLadderMultivariant(rungs, true, ffMaster, (f) => f !== 'v480.m3u8', { kbps: 6000 })).toBeNull();
    const out = renderLadderMultivariant(rungs, true, ffMaster, () => true, { kbps: 6000, codecs: 'avc1.640028,mp4a.40.2' })!;
    const infs = out.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
    expect(infs).toHaveLength(3);
    expect(infs[0]).toContain('RESOLUTION=1920x1080');
    expect(infs[0]).toContain('CODECS="avc1.640028,mp4a.40.2"');
    expect(infs[0]).toContain('BANDWIDTH=7200000');
    expect(infs[1]).toContain('CODECS="avc1.64001f,mp4a.40.2"');
    expect(out).toContain('URI="audio.m3u8"');
  });
});
