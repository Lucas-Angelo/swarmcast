import './zod-config.js';
import { z } from 'zod';
import { translate, type MessageKey, type MessageParams } from './i18n/index.js';
import type { CodedText } from './schemas.js';

/**
 * Quality ladder, encoder and upload-budget types shared by the server, the admin panel
 * and the viewer. Pure functions only (no I/O) so they are easy to unit test.
 * See docs/QUALITY.md for the reasoning behind every number here.
 */

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

export const ENCODER_IDS = [
  'h264_videotoolbox',
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_vaapi',
  'libx264',
  'libopenh264',
] as const;
export type EncoderId = (typeof ENCODER_IDS)[number];

export const HARDWARE_ENCODERS: ReadonlySet<EncoderId> = new Set(['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi']);

/** Preference order when several encoders work (dedicated GPU blocks first, x264 last). */
export const ENCODER_PREFERENCE: readonly EncoderId[] = [
  'h264_nvenc',
  'h264_videotoolbox',
  'h264_qsv',
  'h264_amf',
  'h264_vaapi',
  'libx264',
  'libopenh264',
];

export interface EncoderProbeResult {
  id: EncoderId;
  hardware: boolean;
  ok: boolean;
  /** Frames per second encoded in the 1-second 720p30 test (30 frames). Higher = cheaper. */
  fps?: number;
  /** User + system CPU seconds the test used (`-benchmark`), for the cost estimate. */
  cpuSeconds?: number;
  /** Seconds of video the test encoded. */
  videoSeconds?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Settings (editable from the admin panel)
// ---------------------------------------------------------------------------

/** Heights SwarmCast can add below the source. The source itself is always passed through. */
export const TRANSCODE_HEIGHTS = [720, 480, 360] as const;
export type TranscodeHeight = (typeof TRANSCODE_HEIGHTS)[number];

export const qualitySettingsSchema = z.object({
  ladder: z
    .object({
      /**
       * auto: SwarmCast decides from what it detected on this PC (on with the safe renditions,
       * or off with the reason). manual: the streamer's own choice (`enabled` + `heights`),
       * which always wins over the automatic default on later runs.
       */
      mode: z.enum(['auto', 'manual']).default('auto'),
      /** Manual mode: "Stream in multiple qualities" on/off. */
      enabled: z.boolean().default(true),
      /** Manual mode: renditions to add below the source. */
      heights: z.array(z.union([z.literal(720), z.literal(480), z.literal(360)])).max(3).default([720, 480, 360]),
      /** Encoder to use; "auto" picks the best working one (hardware first, then the CPU fallback). */
      encoder: z.enum(['auto', ...ENCODER_IDS]).default('auto'),
    })
    .default({ mode: 'auto', enabled: true, heights: [720, 480, 360], encoder: 'auto' }),
  upload: z
    .object({
      /** auto: adaptive cap (never above measured upload − other stream − headroom); manual: Settings.uploadLimitMbps. */
      mode: z.enum(['auto', 'manual']).default('auto'),
      /** Bitrate of the stream she sends to another platform (e.g. Twitch, YouTube), kbps. null = detect (obs-websocket, else the OBS bitrate). */
      otherStreamKbps: z.number().int().min(0).max(100_000).nullable().default(null),
      /** Share of the measured upload never used by SwarmCast (jitter, other apps, the speed test's optimism). */
      headroomPercent: z.number().min(5).max(60).default(15),
    })
    .default({ mode: 'auto', otherStreamKbps: null, headroomPercent: 15 }),
  obsWebsocket: z
    .object({
      /** Opt-in: read OBS's own stream health (congestion, dropped frames) from obs-websocket on this PC. */
      enabled: z.boolean().default(false),
      /** Only loopback addresses are accepted. */
      url: z
        .string()
        .regex(/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/, 'Use ws://127.0.0.1:<port> (obs-websocket on this PC).')
        .default('ws://127.0.0.1:4455'),
      /** obs-websocket server password (stored in the private config file, never sent back to the panel). */
      password: z.string().max(200).optional(),
    })
    .default({ enabled: false, url: 'ws://127.0.0.1:4455' }),
});
export type QualitySettings = z.infer<typeof qualitySettingsSchema>;

/** What the panel sends: like QualitySettings, but an absent password keeps the stored one. */
export const qualitySettingsUpdateSchema = qualitySettingsSchema.extend({
  obsWebsocket: qualitySettingsSchema.shape.obsWebsocket.unwrap().extend({
    password: z.string().max(200).nullable().optional(),
  }),
});
export type QualitySettingsUpdate = z.infer<typeof qualitySettingsUpdateSchema>;

export function defaultQualitySettings(): QualitySettings {
  return qualitySettingsSchema.parse({});
}

// ---------------------------------------------------------------------------
// CPU fallback (no hardware encoder)
// ---------------------------------------------------------------------------

export type SoftwareEncoderId = 'libx264' | 'libopenh264';
export type X264Preset = 'veryfast' | 'superfast';

/** One short test encode used to decide whether the CPU can make a rendition. */
export interface CpuTestResult {
  encoder: SoftwareEncoderId;
  height: 480 | 360;
  /** x264 only. */
  preset?: X264Preset;
  /** Seconds of video encoded. */
  videoSeconds: number;
  /** Wall-clock seconds the test took. */
  realSeconds: number;
  /** User + system CPU seconds ffmpeg used (`-benchmark`). */
  cpuSeconds: number;
  ok: boolean;
  error?: string;
}

/** Tests to try, best first; the probe stops at the first one that passes. */
export const CPU_TEST_PLAN: Record<SoftwareEncoderId, ReadonlyArray<{ height: 480 | 360; preset?: X264Preset }>> = {
  libx264: [
    { height: 480, preset: 'veryfast' },
    { height: 480, preset: 'superfast' },
    { height: 360, preset: 'superfast' },
  ],
  libopenh264: [{ height: 480 }, { height: 360 }],
};

/** The CPU fallback is only considered on machines with at least this many hardware threads. */
export const SOFTWARE_MIN_THREADS = 6;
/** Most CPU the fallback rendition may use, in cores (OBS and the game need the rest). */
export const SOFTWARE_CORE_BUDGET = 1;
/** The test encode must run at least this much faster than real time (clear margin). */
export const SOFTWARE_MIN_SPEED = 1.5;
/** Real content is harder to encode than the test pattern, and the source must be decoded too. */
export const SOFTWARE_CONTENT_FACTOR = 1.3;

export interface SoftwareDecision {
  /** The rendition the CPU can make, or null. */
  pick: { encoder: SoftwareEncoderId; height: 480 | 360; preset?: X264Preset } | null;
  /** Estimated cores the pick (or the cheapest test, when none passed) needs while live. */
  coresNeeded?: number;
  /** Speed of that test, × real time. */
  speed?: number;
  budgetCores: number;
  reason: CodedText;
}

function coded(code: MessageKey, params?: MessageParams): CodedText {
  return { code, ...(params ? { params } : {}), text: translate('en', code, params) };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Cores one test needs at real time, with the content margin. */
export function cpuTestCores(t: CpuTestResult): number {
  return (t.cpuSeconds / Math.max(t.videoSeconds, 0.001)) * SOFTWARE_CONTENT_FACTOR;
}

export function cpuTestSpeed(t: CpuTestResult): number {
  return t.videoSeconds / Math.max(t.realSeconds, 0.001);
}

/**
 * Can this PC make one low rendition on the CPU without hurting OBS? Only with ≥ 6 threads,
 * and only when a test encode ran ≥ 1.5× real time while needing ≤ 1 core (with margin).
 * `tests` are the results of the CPU test plan, in order; `null` = not tested yet.
 */
export function decideSoftware(cpuThreads: number, compiled: SoftwareEncoderId[], tests: CpuTestResult[] | null): SoftwareDecision {
  const budgetCores = SOFTWARE_CORE_BUDGET;
  const none = (reason: CodedText, extra: Partial<SoftwareDecision> = {}): SoftwareDecision => ({ pick: null, budgetCores, reason, ...extra });
  if (compiled.length === 0) return none(coded('quality.reason.cpuNoEncoder'));
  if (cpuThreads < SOFTWARE_MIN_THREADS) return none(coded('quality.reason.cpuFewThreads', { threads: cpuThreads, min: SOFTWARE_MIN_THREADS }));
  if (!tests || tests.length === 0) return none(coded('quality.reason.cpuNotTested'));
  for (const t of tests) {
    if (!t.ok) continue;
    const cores = cpuTestCores(t);
    const speed = cpuTestSpeed(t);
    if (cores <= budgetCores && speed >= SOFTWARE_MIN_SPEED) {
      return {
        pick: { encoder: t.encoder, height: t.height, ...(t.preset ? { preset: t.preset } : {}) },
        coresNeeded: round1(cores),
        speed: round1(speed),
        budgetCores,
        reason: coded('quality.reason.cpuOk', { height: t.height, cores: round1(Math.max(cores, 0.1)) }),
      };
    }
  }
  const okTests = tests.filter((t) => t.ok);
  if (okTests.length === 0) return none(coded('quality.reason.cpuTestFailed'));
  const cheapest = okTests.reduce((a, b) => (cpuTestCores(b) < cpuTestCores(a) ? b : a));
  const cores = round1(cpuTestCores(cheapest));
  return none(coded('quality.reason.cpuTooSlow', { cores, budget: budgetCores }), { coresNeeded: cores, speed: round1(cpuTestSpeed(cheapest)) });
}

// ---------------------------------------------------------------------------
// What this PC can do (drives the automatic default and the panel's "Your PC" block)
// ---------------------------------------------------------------------------

export interface PcInput {
  ffmpegAvailable: boolean;
  encoders: EncoderProbeResult[];
  /** True while the encoder test runs (nothing known yet). */
  probing?: boolean;
  /** Hardware threads (os.availableParallelism). */
  cpuCores: number;
  /** CPU fallback tests (only run when no hardware encoder works). */
  cpuTests: CpuTestResult[] | null;
}

export interface PcAssessment {
  ffmpeg: boolean;
  /** Best working hardware encoder. */
  hardware: EncoderId | null;
  /** CPU fallback decision (only when there is no hardware encoder). */
  software: SoftwareDecision | null;
  /** Renditions below a 1080p source this PC can make safely (the automatic selection). */
  safeHeights: TranscodeHeight[];
  /** Encoder for them. */
  encoder: EncoderId | null;
  preset?: X264Preset;
  /** Estimated CPU cost of making `safeHeights` while live, in cores and % of the machine. */
  costCores?: number;
  costPercent?: number;
  /** Plain-words summary. */
  reason: CodedText;
}

/** Software encoders that passed the probe (candidates for the CPU fallback test). */
export function softwareEncodersIn(encoders: EncoderProbeResult[]): SoftwareEncoderId[] {
  return (['libx264', 'libopenh264'] as const).filter((id) => encoders.some((e) => e.id === id && e.ok));
}

/** CPU used by one hardware rendition (decode + scale + driver), from the probe's benchmark. */
function hardwareCoresPerRendition(e: EncoderProbeResult): number | undefined {
  if (e.cpuSeconds === undefined || !e.videoSeconds) return undefined;
  return e.cpuSeconds / e.videoSeconds;
}

export function assessPc(i: PcInput): PcAssessment {
  const base = { ffmpeg: i.ffmpegAvailable, hardware: null, software: null, safeHeights: [], encoder: null } as const;
  if (!i.ffmpegAvailable) return { ...base, safeHeights: [], reason: coded('quality.reason.noFfmpeg') };
  // A finished probe always lists every candidate encoder; none yet = running or not run.
  if (i.encoders.length === 0) return { ...base, safeHeights: [], reason: coded(i.probing ? 'quality.reason.probing' : 'quality.reason.notProbed') };
  const hw = pickEncoder(i.encoders.filter((e) => e.hardware), 'auto');
  if (hw) {
    const per = hardwareCoresPerRendition(hw);
    const heights = [...TRANSCODE_HEIGHTS];
    const cores = per !== undefined ? round1(Math.max(per * heights.length, 0.05)) : undefined;
    return {
      ...base,
      hardware: hw.id,
      safeHeights: heights,
      encoder: hw.id,
      ...(cores !== undefined ? { costCores: cores, costPercent: Math.max(1, Math.round((cores / Math.max(1, i.cpuCores)) * 100)) } : {}),
      reason: coded('quality.reason.hardware', { encoderKey: encoderLabelKey(hw.id) }),
    };
  }
  const software = decideSoftware(i.cpuCores, softwareEncodersIn(i.encoders), i.cpuTests);
  if (!software.pick) return { ...base, software, safeHeights: [], reason: software.reason };
  return {
    ...base,
    software,
    safeHeights: [software.pick.height],
    encoder: software.pick.encoder,
    ...(software.pick.preset ? { preset: software.pick.preset } : {}),
    ...(software.coresNeeded !== undefined ? { costCores: software.coresNeeded, costPercent: Math.max(1, Math.round((software.coresNeeded / Math.max(1, i.cpuCores)) * 100)) } : {}),
    reason: software.reason,
  };
}

/** Message key with the friendly name of an encoder (NVIDIA NVENC, Intel Quick Sync…). */
export function encoderLabelKey(id: EncoderId): MessageKey {
  return `quality.encoder.${id}` as MessageKey;
}

// ---------------------------------------------------------------------------
// Ladder planning
// ---------------------------------------------------------------------------

export interface SourceInfo {
  width: number;
  height: number;
  /** Frames per second; 30 when unknown. */
  fps: number;
  /** Measured bitrate of the source (video + audio), kbps; 0 when unknown. */
  kbps: number;
  hasAudio: boolean;
  /** CODECS attribute advertised for the source, when known. */
  codecs?: string;
}

export interface Rung {
  /** Playlist base name served under /hls (`<name>.m3u8`). */
  name: string;
  width: number;
  height: number;
  /** Target video bitrate, kbps (source: measured). */
  kbps: number;
  fps: number;
  /** True for the pass-through copy of what OBS sends. */
  source: boolean;
}

export interface LadderPlan {
  rungs: Rung[];
  /** Encoder for the transcoded rungs; null when the ladder is source-only. */
  encoder: EncoderId | null;
  /** x264 preset when the CPU fallback is used. */
  preset?: X264Preset;
  /** Plain-language explanation for the panel (translatable). */
  reasons: CodedText[];
}

/** Video bitrates for 30 fps (kbps); 60 fps uses 1.5×. Close to Apple's HLS authoring spec and Twitch guidance. */
export const RUNG_KBPS_30FPS: Record<TranscodeHeight, number> = { 720: 3000, 480: 1400, 360: 800 };

export interface PlanInput {
  source: SourceInfo | null;
  settings: QualitySettings;
  encoders: EncoderProbeResult[];
  /** False when no ffmpeg binary is available. */
  ffmpegAvailable: boolean;
  cpuCores: number;
  /** CPU fallback test results (null = not run). */
  cpuTests?: CpuTestResult[] | null;
  probing?: boolean;
  /** Upload ceiling (Mbps) from computeUploadCeiling; undefined when unknown. */
  uploadCeilingMbps?: number;
}

const evenWidth = (h: number, src: SourceInfo): number => {
  const aspect = src.width > 0 && src.height > 0 ? src.width / src.height : 16 / 9;
  return Math.max(2, Math.round((h * aspect) / 2) * 2);
};

export function rungKbps(height: TranscodeHeight, fps: number, sourceKbps: number): number {
  const base = RUNG_KBPS_30FPS[height] * (fps > 40 ? 1.5 : 1);
  // Never spend more than ~70 % of the source on a smaller copy of it.
  const capped = sourceKbps > 0 ? Math.min(base, Math.round(sourceKbps * 0.7)) : base;
  return Math.max(300, Math.round(capped / 50) * 50);
}

export function pickEncoder(encoders: EncoderProbeResult[], wanted: QualitySettings['ladder']['encoder']): EncoderProbeResult | null {
  const ok = encoders.filter((e) => e.ok);
  if (wanted !== 'auto') return ok.find((e) => e.id === wanted) ?? null;
  for (const id of ENCODER_PREFERENCE) {
    const e = ok.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
}

/** Heights below a source of this height (at least 120 lines smaller). */
export function heightsBelow(sourceHeight: number): TranscodeHeight[] {
  return TRANSCODE_HEIGHTS.filter((h) => h <= sourceHeight - 120);
}

/**
 * Renditions the streamer may tick in the panel, with why the others are disabled.
 * Hardware encoder: everything below the source. CPU only: the one rendition the test allows.
 */
export function supportedHeights(pc: PcAssessment, sourceHeight: number): TranscodeHeight[] {
  const below = heightsBelow(sourceHeight);
  if (pc.hardware) return below;
  return below.filter((h) => pc.safeHeights.includes(h));
}

/**
 * Decide the renditions for the current source.
 * - The source is always served as-is (no generation loss, no CPU).
 * - Auto (default): on with the renditions this PC can make safely (hardware encoder: 720p,
 *   480p and 360p; CPU only: the one rendition the CPU test allows), off with the reason otherwise.
 * - Manual: the streamer's switch and selection, limited to what this PC supports (an explicit
 *   encoder choice is honored as-is, for experts).
 */
export function planLadder(input: PlanInput): LadderPlan {
  const reasons: CodedText[] = [];
  const src: SourceInfo = input.source ?? { width: 1920, height: 1080, fps: 30, kbps: 0, hasAudio: true };
  const sourceRung: Rung = { name: `v${src.height}`, width: src.width, height: src.height, kbps: src.kbps, fps: src.fps, source: true };
  const below = heightsBelow(src.height);
  const sourceOnly = (why: CodedText): LadderPlan => {
    reasons.push(why);
    return { rungs: [sourceRung], encoder: null, reasons };
  };
  if (!input.source) reasons.push(coded('quality.reason.waitingSource'));
  const pc = assessPc({ ffmpegAvailable: input.ffmpegAvailable, encoders: input.encoders, cpuCores: input.cpuCores, cpuTests: input.cpuTests ?? null, probing: input.probing });
  if (!input.ffmpegAvailable) return sourceOnly(pc.reason);

  const { ladder } = input.settings;
  let heights: TranscodeHeight[];
  let encoder: EncoderId;
  let preset: X264Preset | undefined = pc.preset;
  if (ladder.mode === 'manual') {
    if (!ladder.enabled) return sourceOnly(coded('quality.reason.manualOff'));
    const picked = below.filter((h) => ladder.heights.includes(h));
    if (picked.length === 0) return sourceOnly(below.length === 0 ? coded('quality.reason.sourceSmall', { height: src.height }) : coded('quality.reason.manualNone'));
    if (ladder.encoder !== 'auto') {
      const forced = pickEncoder(input.encoders, ladder.encoder);
      if (!forced) return sourceOnly(coded('quality.reason.encoderFailed', { encoder: ladder.encoder }));
      encoder = forced.id;
      heights = picked;
      if (encoder === 'libx264') preset = 'superfast';
      reasons.push(coded('quality.reason.manualForced', { heights: heights.map((h) => `${h}p`).join(' + '), encoder }));
    } else {
      if (!pc.encoder) return sourceOnly(pc.reason);
      const allowed = supportedHeights(pc, src.height);
      heights = picked.filter((h) => allowed.includes(h));
      if (heights.length === 0) return sourceOnly(coded('quality.reason.manualUnsupported', { heights: picked.map((h) => `${h}p`).join(' + ') }));
      encoder = pc.encoder;
      reasons.push(coded('quality.reason.manual', { heights: heights.map((h) => `${h}p`).join(' + ') }));
      const dropped = picked.filter((h) => !heights.includes(h));
      if (dropped.length) reasons.push(coded('quality.reason.manualDropped', { heights: dropped.map((h) => `${h}p`).join(' + ') }));
    }
  } else {
    if (below.length === 0) return sourceOnly(coded('quality.reason.sourceSmall', { height: src.height }));
    if (!pc.encoder) return sourceOnly(pc.reason);
    encoder = pc.encoder;
    heights = supportedHeights(pc, src.height);
    if (heights.length === 0) {
      // CPU only and its rendition is not below this source: nothing to add.
      return sourceOnly(coded('quality.reason.sourceSmall', { height: src.height }));
    }
    reasons.push(pc.hardware ? coded('quality.reason.autoHardware', { heights: heights.map((h) => `${h}p`).join(', '), encoderKey: encoderLabelKey(pc.hardware) }) : pc.reason);
  }

  const rungs: Rung[] = [sourceRung];
  for (const h of heights) {
    rungs.push({ name: `v${h}`, width: evenWidth(h, src), height: h, kbps: rungKbps(h, src.fps, src.kbps), fps: src.fps, source: false });
  }
  if (input.uploadCeilingMbps !== undefined && src.kbps > 0 && input.uploadCeilingMbps * 1000 < src.kbps * 1.15) {
    reasons.push(coded('quality.reason.uploadLow'));
  }
  return { rungs, encoder, ...(encoder === 'libx264' && preset ? { preset } : {}), reasons };
}

/**
 * The ladder after dropping one rendition to give CPU back: the largest encoded one goes first
 * (it costs the most); the source copy is never dropped. Returns the source alone at the end.
 */
export function shedRung(rungs: Rung[]): { rungs: Rung[]; dropped: Rung | null } {
  const encoded = rungs.filter((r) => !r.source);
  if (encoded.length === 0) return { rungs, dropped: null };
  const dropped = encoded.reduce((a, b) => (b.height > a.height ? b : a));
  return { rungs: rungs.filter((r) => r !== dropped), dropped };
}

/** Estimated viewers the upload cap can serve at one rendition (video + 128 kbps audio, +10 % overhead). */
export function viewersAt(capMbps: number, videoKbps: number): number {
  if (!(capMbps > 0) || !(videoKbps > 0)) return 0;
  return Math.floor((capMbps * 1000) / ((videoKbps + 128) * 1.1));
}

// ---------------------------------------------------------------------------
// Upload budget
// ---------------------------------------------------------------------------

/** Margin on top of the other stream's nominal bitrate (encoder bursts, RTMP/TCP overhead). */
export const OTHER_STREAM_MARGIN = 1.25;

export interface CeilingInput {
  /** Measured upload (speed test), Mbps. */
  measuredUploadMbps?: number;
  /** Bitrate she streams to other platforms (e.g. Twitch, YouTube), kbps; 0 if none. */
  otherStreamKbps: number;
  headroomPercent: number;
}

/**
 * The most SwarmCast may ever use: measured upload, minus headroom, minus the other stream
 * (with a margin). Undefined when there is no measurement yet.
 */
export function computeUploadCeiling(i: CeilingInput): number | undefined {
  if (i.measuredUploadMbps === undefined || !Number.isFinite(i.measuredUploadMbps) || i.measuredUploadMbps <= 0) return undefined;
  const usable = i.measuredUploadMbps * (1 - i.headroomPercent / 100) - (i.otherStreamKbps / 1000) * OTHER_STREAM_MARGIN;
  return Math.max(0.5, Math.round(usable * 10) / 10);
}

// ---------------------------------------------------------------------------
// State reported to the admin panel (GET /api/quality)
// ---------------------------------------------------------------------------

export type UploadControllerPhase = 'manual' | 'starting' | 'increasing' | 'holding' | 'backing-off';
export type OtherStreamSource = 'obs-websocket' | 'manual' | 'obs-bitrate' | 'none';

export interface UploadSignals {
  /** Bytes SwarmCast actually sent, Mbps (last ~2 s). */
  usedMbps: number;
  /** True when viewers wanted more than the cap (the limiter had a queue). */
  demandLimited: boolean;
  rttMs?: number;
  baseRttMs?: number;
  /** rttMs − baseRttMs: queueing delay on the uplink (bufferbloat). */
  queueDelayMs?: number;
  /** obs-websocket outputCongestion (0..1) of her main OBS output (her stream to another platform, if any). */
  obsCongestion?: number;
  /** Share of frames OBS dropped for network reasons in the last interval, percent. */
  obsDroppedPercent?: number;
  obsReconnecting?: boolean;
}

export interface UploadState {
  mode: 'auto' | 'manual';
  phase: UploadControllerPhase;
  capMbps: number;
  ceilingMbps?: number;
  measuredUploadMbps?: number;
  otherStreamKbps: number;
  otherStreamSource: OtherStreamSource;
  lastBackoff?: { at: number; reason: string; code?: MessageKey; params?: MessageParams; fromMbps: number; toMbps: number };
  signals: UploadSignals;
  obsWebsocket: { enabled: boolean; connected: boolean; error?: string };
}

export type TranscoderStatus = 'off' | 'waiting-source' | 'starting' | 'running' | 'restarting' | 'failed';

export interface QualityState {
  settings: Omit<QualitySettings, 'obsWebsocket'> & { obsWebsocket: Omit<QualitySettings['obsWebsocket'], 'password'> & { hasPassword: boolean } };
  ffmpeg: { available: boolean; path?: string };
  encoders: EncoderProbeResult[];
  probing: boolean;
  cpuCores: number;
  source?: SourceInfo;
  plan: LadderPlan;
  /** What this PC can do (detection), for the "Your PC" block and the automatic default. */
  pc: PcAssessment;
  /** Renditions the streamer may pick for the current (or a 1080p) source. */
  supportedHeights: TranscodeHeight[];
  /** CPU fallback test results (null = not run: a hardware encoder works, or not tested yet). */
  cpuTests: CpuTestResult[] | null;
  /** Upload cost per rendition with the current cap (source + every height this PC supports). */
  renditionCosts: Array<{ height: number; source: boolean; kbps: number; viewers: number }>;
  /** Renditions dropped during this stream to give CPU back to OBS (cleared when OBS reconnects). */
  shed?: { reason: 'behind' | 'cpu'; heights: number[]; at: number };
  /** speed: × real time over the last ~10 s (1.0 = keeping up). */
  transcoder: { status: TranscoderStatus; speed?: number; restarts: number; message?: CodedText };
  /** Variants viewers currently get (name, height, advertised bandwidth). */
  variants: Array<{ name: string; height: number; bandwidthKbps: number }>;
  upload: UploadState;
}

// ---------------------------------------------------------------------------
// P2P swarm ids per variant
// ---------------------------------------------------------------------------

/**
 * Swarm id of one stream for p2p-media-loader's `streamSwarmIdBuilder`. Each video variant
 * gets its own swarm (peers on 720p must never offer 720p bytes to someone asking for 1080p),
 * keyed by height; the shared audio rendition keeps the plain "secondary" id.
 * The server allowlists exactly these ids (apps/server/src/tracker/tracker.ts).
 */
export function variantStreamSwarmId(swarmId: string, streamType: string, height?: number | null): string {
  if (streamType !== 'main') return `swarmcast-${swarmId}-${streamType}`;
  return `swarmcast-${swarmId}-main-${height && height > 0 ? Math.round(height) : 0}`;
}
