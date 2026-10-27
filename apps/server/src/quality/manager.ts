import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  ASSUMED_BITRATE_KBPS,
  TRANSCODE_HEIGHTS,
  assessPc,
  computeUploadCeiling,
  planLadder,
  rungKbps,
  shedRung,
  supportedHeights,
  viewersAt,
  type CpuTestResult,
  type EncoderProbeResult,
  type MessageKey,
  type MessageParams,
  type Rung,
  type LadderPlan,
  type OtherStreamSource,
  type QualitySettings,
  type QualitySettingsUpdate,
  type QualityState,
  type SourceInfo,
  type SpeedTestResult,
  type UploadSignals,
  type UploadState,
} from '@swarmcast/shared';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { DirectorySource, MediaMtxSource, type HlsOrigin } from '../hls/origin.js';
import type { BandwidthLimiter } from '../hls/throttle.js';
import type { Reaper } from '../process/children.js';
import type { TrackerService } from '../tracker/tracker.js';
import { cpuCores, probeEncoders, testCpu } from './encoders.js';
import { installFfmpeg, resolveFfmpeg, type InstallProgress } from './ffmpeg.js';
import { withRetries } from '../core/retry.js';
import { CpuSampler, LoadGuard, type LoadGuardOptions, type ShedReason } from './load-guard.js';
import { ObsWebsocketClient, tcpConnectRtt } from './signals.js';
import { Transcoder, renderLadderMultivariant } from './transcoder.js';
import { RttTracker, UploadController } from './upload-controller.js';

export interface QualityDeps {
  config: AppConfig;
  saveConfig: (cfg: AppConfig) => void;
  origin: HlsOrigin;
  limiter: BandwidthLimiter;
  tracker: TrackerService;
  log: Logger;
  reaper: Reaper | null;
  binDir: string;
  dataDir: string;
  runDir: string;
  /** rtmp://127.0.0.1:<port>/live/<key> (MediaMTX allows local reads of the stream path). */
  rtmpReadUrl: string;
  /** MediaMTX HLS base URL of the stream path. */
  mediamtxHlsUrl: string;
  streamKey: string;
  speedTest: () => SpeedTestResult | undefined;
  /** Aborted when the app quits: an ffmpeg download (and its retries) stops. */
  quitSignal?: AbortSignal;
  /** Panel warning + activity log line (translatable code). */
  warn: (code: MessageKey, params?: MessageParams) => void;
  now?: () => number;
  /** Overrides for tests. */
  rttProbe?: () => Promise<number | undefined>;
  probe?: typeof probeEncoders;
  installFfmpeg?: typeof installFfmpeg;
  cpuTest?: typeof testCpu;
  /** The load guard (tests): an instance, or options for the default one. */
  loadGuard?: LoadGuard | Partial<LoadGuardOptions>;
  /** Whole-machine CPU busy percent since the last call (tests). */
  cpuBusy?: () => number | undefined;
  tickMs?: number;
}

/** How long to wait for the ladder's first segments before falling back to the plain stream. */
const LADDER_READY_TIMEOUT_MS = 20_000;
/** How long to wait for MediaMTX to reveal the source resolution. */
const SOURCE_INFO_TIMEOUT_MS = 15_000;

/**
 * Owns everything about quality: encoder probing, the rendition plan, the ffmpeg ladder
 * process, which source the origin pulls from, the per-variant P2P allowlist, and the
 * adaptive upload cap (with its congestion signals).
 */
export class QualityManager extends EventEmitter<{ changed: [] }> {
  encoders: EncoderProbeResult[] = [];
  /** CPU fallback tests (null: not run because a hardware encoder works, or not probed yet). */
  cpuTests: CpuTestResult[] | null = null;
  probing = false;
  private probePromise: Promise<void> | null = null;
  private ffmpegPath: string | null;
  readonly transcoder: Transcoder;
  private plan: LadderPlan;
  private readonly controller = new UploadController();
  private readonly rtt = new RttTracker();
  private obs: ObsWebsocketClient | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private live = false;
  private publishing = false;
  private publishSeq = 0;
  private ladderTimer: NodeJS.Timeout | null = null;
  private signals: UploadSignals = { usedMbps: 0, demandLimited: false };
  private otherStream: { kbps: number; source: OtherStreamSource } = { kbps: 0, source: 'none' };
  private lastBackoff?: UploadState['lastBackoff'];
  private ceiling?: number;
  private mediamtxSource: MediaMtxSource;
  private readonly guard: LoadGuard;
  private readonly cpuSampler = new CpuSampler();
  private shed?: { reason: ShedReason; heights: number[]; at: number };
  private ladderSource: SourceInfo | null = null;
  install: InstallProgress | null = null;

  constructor(private readonly d: QualityDeps) {
    super();
    this.guard = d.loadGuard instanceof LoadGuard ? d.loadGuard : new LoadGuard(d.loadGuard);
    this.ffmpegPath = resolveFfmpeg({ configPath: d.config.ffmpegPath, binDir: d.binDir, dataDir: d.dataDir });
    this.transcoder = new Transcoder({ ffmpeg: this.ffmpegPath ?? 'ffmpeg', inputUrl: d.rtmpReadUrl, workDir: d.runDir, reaper: d.reaper, log: d.log, secret: d.streamKey });
    this.transcoder.on('status', (s) => {
      if (s === 'failed') this.fallBackToPlain('warn.quality.converterFailed', { count: this.transcoder.restarts });
      this.changed();
    });
    this.mediamtxSource = new MediaMtxSource(d.mediamtxHlsUrl);
    d.origin.setSource(this.mediamtxSource);
    d.origin.on('multivariant', () => {
      d.tracker.setVariants(d.origin.variants().map((v) => v.height));
      this.changed();
    });
    this.plan = this.computePlan();
  }

  private get settings(): QualitySettings {
    return this.d.config.quality;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private changed(): void {
    this.emit('changed');
  }

  get ffmpegAvailable(): boolean {
    return this.ffmpegPath !== null;
  }

  // ---- encoders ----

  /** Probe the encoders (once per app run, again after installing ffmpeg or on request). */
  probe(force = false): Promise<void> {
    if (!this.ffmpegPath) return Promise.resolve();
    if (this.probePromise && !force) return this.probePromise;
    this.probing = true;
    this.changed();
    const ffmpeg = this.ffmpegPath;
    const opts = { ffmpeg, reaper: this.d.reaper, log: this.d.log };
    this.encoders = [];
    this.cpuTests = null;
    this.probePromise = (this.d.probe ?? probeEncoders)(opts)
      .then(async (r) => {
        this.encoders = r;
        this.changed();
        // No hardware encoder: measure whether the CPU can make one low rendition.
        this.cpuTests = await (this.d.cpuTest ?? testCpu)(opts, r);
      })
      .catch((err: Error) => {
        this.d.log.warn({ err: err.message }, 'encoder probe failed');
      })
      .finally(() => {
        this.probing = false;
        this.plan = this.computePlan();
        this.changed();
      });
    return this.probePromise;
  }

  async installFfmpeg(retry?: { attempt: number; attempts: number }): Promise<void> {
    if (this.install && !['done', 'error'].includes(this.install.phase) && !(retry && this.install.phase === 'retrying')) {
      throw new Error('The video converter is already being installed.');
    }
    this.install = { phase: 'downloading', receivedBytes: 0, ...retry };
    this.changed();
    try {
      this.ffmpegPath = await (this.d.installFfmpeg ?? installFfmpeg)(
        this.d.dataDir,
        this.d.log,
        (p) => {
          this.install = { ...p, ...retry };
          this.changed();
        },
        { signal: this.d.quitSignal },
      );
      this.transcoder.setBinary(this.ffmpegPath);
      await this.probe(true);
    } catch (err) {
      this.install = { phase: 'error', receivedBytes: 0, message: (err as Error).message, ...retry };
      this.changed();
      throw err;
    }
  }

  /**
   * installFfmpeg with automatic retries after `delaysMs` (desktop first run). Between tries the
   * panel shows phase 'retrying' with the last error; after the last one, 'error' ("Try again").
   */
  installFfmpegWithRetries(delaysMs: readonly number[], sleep?: (ms: number) => Promise<void>): Promise<void> {
    const attempts = delaysMs.length + 1;
    return withRetries((attempt) => this.installFfmpeg({ attempt, attempts }), delaysMs, {
      sleep,
      signal: this.d.quitSignal,
      onRetry: (err, next) => {
        this.d.log.warn({ err: err.message, next }, 'video converter install failed; trying again');
        this.install = { phase: 'retrying', receivedBytes: 0, message: err.message, attempt: next, attempts };
        this.changed();
      },
    });
  }

  // ---- plan ----

  private computePlan(): LadderPlan {
    return planLadder({
      source: this.d.origin.sourceKind === 'mediamtx' ? this.d.origin.sourceInfo() : this.lastSource,
      settings: this.settings,
      encoders: this.encoders,
      ffmpegAvailable: this.ffmpegAvailable,
      cpuCores: cpuCores(),
      cpuTests: this.cpuTests,
      probing: this.probing,
      uploadCeilingMbps: this.ceiling,
    });
  }

  private lastSource: ReturnType<HlsOrigin['sourceInfo']> = null;

  // ---- live lifecycle (called by LiveController) ----

  onLiveStart(): void {
    this.live = true;
    this.d.origin.setSource(this.mediamtxSource);
    this.d.origin.hold(false);
    this.rtt.clear();
    this.refreshOtherStream();
    this.ceiling = this.computeCeiling();
    if (this.settings.upload.mode === 'auto') {
      this.controller.reset(this.ceiling, this.d.config.uploadLimitMbps);
      this.d.limiter.setMbps(this.controller.capMbps);
    } else {
      this.d.limiter.setMbps(this.d.config.uploadLimitMbps);
    }
    this.startObs();
    this.tickTimer = setInterval(() => void this.tick(), this.d.tickMs ?? 2000);
    this.tickTimer.unref();
    this.changed();
  }

  async onLiveStop(): Promise<void> {
    this.live = false;
    this.publishing = false;
    this.publishSeq += 1;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.ladderTimer) clearTimeout(this.ladderTimer);
    this.tickTimer = this.ladderTimer = null;
    this.obs?.stop();
    this.obs = null;
    await this.transcoder.stop();
    this.d.origin.hold(false);
    this.d.origin.setSource(this.mediamtxSource);
    this.d.tracker.setVariants([]);
    this.changed();
  }

  /** OBS started or stopped publishing to MediaMTX. */
  onPublish(e: 'publishing' | 'unpublished'): void {
    if (!this.live) return;
    if (e === 'publishing') {
      const seq = ++this.publishSeq;
      this.shed = undefined;
      // A fresh source forgets what the previous connection looked like (resolution may change).
      this.mediamtxSource = new MediaMtxSource(this.d.mediamtxHlsUrl);
      this.lastSource = null;
      if (this.ladderTimer) clearTimeout(this.ladderTimer);
      this.ladderTimer = null;
      if (this.publishing) {
        // A new publisher replaced the old one without a "closed" first (MediaMTX lets a new
        // OBS connection take over the path): treat it as a reconnect.
        void this.transcoder.stop().then(() => {
          this.leaveStoppedLadder();
          if (seq !== this.publishSeq || !this.live) return;
          this.d.origin.setSource(this.mediamtxSource);
          this.d.origin.hold(false);
          void this.startLadderFlow(seq);
        });
        return;
      }
      this.publishing = true;
      this.d.origin.setSource(this.mediamtxSource);
      void this.startLadderFlow(seq);
    } else {
      if (!this.publishing) return;
      this.publishing = false;
      this.publishSeq += 1;
      if (this.ladderTimer) clearTimeout(this.ladderTimer);
      this.ladderTimer = null;
      const seq = this.publishSeq;
      void this.transcoder.stop().then(() => {
        this.leaveStoppedLadder();
        // OBS may be back already (a new publish during the stop): its own flow owns the origin.
        if (seq !== this.publishSeq) return;
        this.d.origin.setSource(this.mediamtxSource);
        this.d.origin.hold(false);
        this.changed();
      });
    }
  }

  /**
   * After a ladder stop: never keep serving the stopped ladder's (deleted) folder from cache.
   * A flow that started a new ladder meanwhile has its own folder (outDir set) and is left alone.
   */
  private leaveStoppedLadder(): void {
    if (this.d.origin.sourceKind !== 'ladder' || this.transcoder.outDir) return;
    this.d.origin.setSource(this.mediamtxSource);
    this.d.origin.hold(false);
    this.changed();
  }

  /** True when the current settings could give more than one rendition for a 1080p source. */
  private mightUseLadder(): boolean {
    if (!this.ffmpegAvailable) return false;
    const s = this.settings.ladder;
    return s.mode === 'manual' ? s.enabled && s.heights.length > 0 : true;
  }

  private async startLadderFlow(seq: number): Promise<void> {
    if (!this.mightUseLadder()) return;
    // Keep viewers off the plain stream for the few seconds it takes to decide, so they do
    // not start on one set of playlists and have it swapped under them.
    this.d.origin.hold(true);
    this.changed();
    try {
      await this.probe();
      const deadline = this.now() + SOURCE_INFO_TIMEOUT_MS;
      while (this.publishing && seq === this.publishSeq && !this.d.origin.sourceInfo() && this.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (seq !== this.publishSeq || !this.publishing) return;
      this.lastSource = this.d.origin.sourceInfo();
      this.plan = this.computePlan();
      const source = this.lastSource;
      if (!source || this.plan.rungs.length < 2 || !this.plan.encoder) {
        this.d.origin.hold(false);
        this.changed();
        return;
      }
      this.launchLadder(seq, source, this.plan.rungs);
    } catch (err) {
      this.fallBackToPlain('warn.quality.failed', { error: (err as Error).message });
    }
  }

  /** Start ffmpeg with these rungs and point the origin at its output. */
  private launchLadder(seq: number, source: SourceInfo, rungs: Rung[]): void {
    if (!this.plan.encoder) return;
    this.ladderSource = source;
    this.guard.reset();
    this.transcoder.start(rungs, this.plan.encoder, source.hasAudio, this.plan.preset);
    const meta = { kbps: source.kbps, ...(source.codecs ? { codecs: source.codecs } : {}) };
    this.d.origin.setSource(
      new DirectorySource(this.transcoder.outDir!, (dir) => {
        let master: string | null = null;
        try {
          master = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
        } catch {
          /* not written yet */
        }
        return renderLadderMultivariant(rungs, source.hasAudio, master, (f) => fs.existsSync(path.join(dir, f)), meta);
      }),
    );
    this.d.origin.hold(false);
    if (this.ladderTimer) clearTimeout(this.ladderTimer);
    this.ladderTimer = setTimeout(() => {
      if (seq === this.publishSeq && this.d.origin.sourceKind === 'ladder' && !this.d.origin.available) {
        this.fallBackToPlain('warn.quality.notStarted');
      }
    }, LADDER_READY_TIMEOUT_MS);
    this.changed();
  }

  /**
   * Give CPU back to OBS: drop the most expensive rendition (restarting ffmpeg with the rest),
   * or go back to the original quality alone when it was the last one.
   */
  private async shedOne(reason: ShedReason): Promise<void> {
    const seq = this.publishSeq;
    const { rungs, dropped } = shedRung(this.transcoder.rungs);
    if (!dropped) return;
    this.guard.shed(this.now());
    this.shed = { reason, heights: [...(this.shed?.heights ?? []), dropped.height], at: this.now() };
    const rest = rungs.filter((r) => !r.source).map((r) => `${r.height}p`).join(', ');
    this.d.log.warn({ reason, dropped: dropped.height, rest }, 'quality: dropping a rendition to protect OBS');
    this.plan = { ...this.plan, rungs };
    if (rungs.length < 2) {
      this.d.warn(reason === 'behind' ? 'warn.quality.shedAllBehind' : 'warn.quality.shedAllCpu', { height: dropped.height });
      await this.transcoder.stop();
      this.leaveStoppedLadder();
      if (!this.live || seq !== this.publishSeq) return;
      this.d.origin.setSource(this.mediamtxSource);
      this.d.origin.hold(false);
      this.changed();
      return;
    }
    this.d.warn(reason === 'behind' ? 'warn.quality.shedBehind' : 'warn.quality.shedCpu', { height: dropped.height, rest });
    const source = this.ladderSource;
    await this.transcoder.stop();
    if (!this.live || !this.publishing || seq !== this.publishSeq || !source) {
      this.leaveStoppedLadder();
      return;
    }
    this.launchLadder(seq, source, rungs);
  }

  private fallBackToPlain(code: MessageKey, params?: MessageParams): void {
    this.d.warn(code, params);
    const seq = this.publishSeq;
    void this.transcoder.stop().then(() => {
      this.leaveStoppedLadder();
      // Only for the publish it was about: a reconnect meanwhile runs its own ladder flow.
      if (!this.live || seq !== this.publishSeq) return;
      this.d.origin.setSource(this.mediamtxSource);
      this.d.origin.hold(false);
      this.changed();
    });
  }

  // ---- upload controller ----

  private refreshOtherStream(): void {
    const s = this.settings.upload;
    if (s.otherStreamKbps !== null) {
      this.otherStream = { kbps: s.otherStreamKbps, source: 'manual' };
    } else if (!this.d.config.alsoStreamingElsewhere) {
      // Only streaming to SwarmCast: OBS's main output (and its obs-websocket bitrate) IS the
      // SwarmCast stream, which does not leave this computer.
      this.otherStream = { kbps: 0, source: 'none' };
    } else if (this.obs?.health?.active && this.obs.health.kbps) {
      this.otherStream = { kbps: this.obs.health.kbps, source: 'obs-websocket' };
    } else {
      const src = this.lastSource?.kbps || this.d.origin.bitrateKbps;
      this.otherStream = { kbps: src > 0 ? src : ASSUMED_BITRATE_KBPS, source: 'obs-bitrate' };
    }
  }

  private computeCeiling(): number | undefined {
    return computeUploadCeiling({
      measuredUploadMbps: this.d.speedTest()?.uploadMbps,
      otherStreamKbps: this.otherStream.kbps,
      headroomPercent: this.settings.upload.headroomPercent,
    });
  }

  private rttInFlight = false;

  /** One controller step (every 2 s while live). */
  async tick(): Promise<void> {
    const now = this.now();
    if (!this.rttInFlight) {
      this.rttInFlight = true;
      void (this.d.rttProbe ?? (() => tcpConnectRtt()))()
        .then((ms) => {
          if (ms !== undefined) this.rtt.add(this.now(), ms);
        })
        .finally(() => {
          this.rttInFlight = false;
        });
    }
    const obs = this.obs?.health;
    this.signals = {
      usedMbps: Math.round(this.d.limiter.currentMbps() * 10) / 10,
      demandLimited: this.d.limiter.throttledWithin((this.d.tickMs ?? 2000) + 500),
      rttMs: round(this.rtt.currentMs),
      baseRttMs: round(this.rtt.baseMs),
      queueDelayMs: round(this.rtt.queueDelayMs),
      ...(obs?.active ? { obsCongestion: obs.congestion, obsDroppedPercent: obs.droppedPercent, obsReconnecting: obs.reconnecting } : {}),
    };
    this.refreshOtherStream();
    this.ceiling = this.computeCeiling();
    if (this.settings.upload.mode === 'manual') {
      if (this.d.limiter.mbps !== this.d.config.uploadLimitMbps) this.d.limiter.setMbps(this.d.config.uploadLimitMbps);
    } else {
      const r = this.controller.tick({ now, ceilingMbps: this.ceiling, fallbackMaxMbps: this.d.config.uploadLimitMbps, signals: this.signals });
      if (r.backoff) {
        this.lastBackoff = { at: now, ...r.backoff };
        this.d.log.info({ ...r.backoff }, 'upload cap lowered');
      }
      if (Math.abs(this.d.limiter.mbps - r.capMbps) >= 0.05) this.d.limiter.setMbps(r.capMbps);
    }
    const cpuBusy = (this.d.cpuBusy ?? (() => this.cpuSampler.sample()))();
    if (this.transcoder.status === 'running' && this.transcoder.rungs.some((r) => !r.source)) {
      const reason = this.guard.check(now, { speed: this.transcoder.speed, speedSpanMs: this.transcoder.speedSpanMs, cpuBusyPercent: cpuBusy });
      if (reason) await this.shedOne(reason);
    }
    this.changed();
  }

  /** Cap currently enforced (Mbps). */
  effectiveCapMbps(): number {
    if (this.settings.upload.mode === 'manual') return this.d.config.uploadLimitMbps;
    return this.live ? this.controller.capMbps : Math.min(this.computeCeiling() ?? this.d.config.uploadLimitMbps, this.d.config.uploadLimitMbps);
  }

  /** Re-apply the manual limit after the classic settings changed. */
  applyManualLimit(): void {
    if (this.settings.upload.mode === 'manual' || !this.live) this.d.limiter.setMbps(this.d.config.uploadLimitMbps);
  }

  private startObs(): void {
    this.obs?.stop();
    this.obs = null;
    const o = this.settings.obsWebsocket;
    if (!o.enabled || !this.live) return;
    try {
      this.obs = new ObsWebsocketClient(o.url, o.password, this.d.log);
      this.obs.start();
    } catch (err) {
      this.d.warn('warn.quality.obsWebsocket', { error: (err as Error).message });
    }
  }

  // ---- settings & state ----

  updateSettings(u: QualitySettingsUpdate): void {
    const prev = this.settings;
    const password = u.obsWebsocket.password === undefined ? prev.obsWebsocket.password : u.obsWebsocket.password ?? undefined;
    const next: QualitySettings = { ...u, obsWebsocket: { enabled: u.obsWebsocket.enabled, url: u.obsWebsocket.url, ...(password ? { password } : {}) } };
    this.d.config.quality = next;
    this.d.saveConfig(this.d.config);
    if (prev.upload.mode !== next.upload.mode && this.live) {
      if (next.upload.mode === 'auto') this.controller.reset(this.ceiling, this.d.config.uploadLimitMbps);
      this.d.limiter.setMbps(next.upload.mode === 'auto' ? this.controller.capMbps : this.d.config.uploadLimitMbps);
    }
    if (JSON.stringify(prev.obsWebsocket) !== JSON.stringify(next.obsWebsocket)) this.startObs();
    // The ladder of a running stream is kept (changing it would swap playlists under the
    // viewers); the new plan applies the next time OBS connects.
    this.plan = this.publishing && this.transcoder.status !== 'off' ? this.plan : this.computePlan();
    this.changed();
  }

  state(): QualityState {
    const s = this.settings;
    const { password, ...obsPublic } = s.obsWebsocket;
    // The running ladder keeps its plan; otherwise show what would apply now.
    const plan = this.publishing && this.transcoder.status !== 'off' ? this.plan : this.computePlan();
    const threads = cpuCores();
    const pc = assessPc({ ffmpegAvailable: this.ffmpegAvailable, encoders: this.encoders, cpuCores: threads, cpuTests: this.cpuTests, probing: this.probing });
    const source = this.lastSource ?? this.d.origin.sourceInfo();
    const srcHeight = source?.height ?? 1080;
    const srcFps = source?.fps ?? 30;
    const srcKbps = source?.kbps || this.d.origin.bitrateKbps || 0;
    const cap = this.effectiveCapMbps();
    const supported = supportedHeights(pc, srcHeight);
    const totalKbps = srcKbps || ASSUMED_BITRATE_KBPS;
    const renditionCosts = [
      { height: srcHeight, source: true, kbps: Math.round(totalKbps), viewers: viewersAt(cap, Math.max(300, totalKbps - 128)) },
      ...TRANSCODE_HEIGHTS.filter((h) => supported.includes(h)).map((h) => {
        const kbps = rungKbps(h, srcFps, srcKbps);
        return { height: h, source: false, kbps, viewers: viewersAt(cap, kbps) };
      }),
    ];
    return {
      settings: { ...s, obsWebsocket: { ...obsPublic, hasPassword: !!password } },
      ffmpeg: { available: this.ffmpegAvailable, ...(this.ffmpegPath ? { path: this.ffmpegPath } : {}) },
      encoders: this.encoders,
      probing: this.probing,
      cpuCores: threads,
      ...(source ? { source } : {}),
      plan,
      pc,
      supportedHeights: supported,
      cpuTests: this.cpuTests,
      renditionCosts,
      ...(this.shed ? { shed: this.shed } : {}),
      transcoder: {
        status: this.transcoder.status,
        ...(this.transcoder.speed !== undefined ? { speed: this.transcoder.speed } : {}),
        restarts: this.transcoder.restarts,
        ...(this.transcoder.message ? { message: this.transcoder.message } : {}),
      },
      variants: this.d.origin.variants().map((v) => ({ name: v.name, height: v.height, bandwidthKbps: v.measuredKbps || v.bandwidthKbps })),
      upload: {
        mode: s.upload.mode,
        phase: s.upload.mode === 'manual' ? 'manual' : this.live ? this.controller.phase : 'starting',
        capMbps: Math.round(this.effectiveCapMbps() * 10) / 10,
        ...(this.ceiling !== undefined || this.computeCeiling() !== undefined ? { ceilingMbps: this.ceiling ?? this.computeCeiling() } : {}),
        ...(this.d.speedTest() ? { measuredUploadMbps: this.d.speedTest()!.uploadMbps } : {}),
        otherStreamKbps: this.otherStream.kbps,
        otherStreamSource: this.otherStream.source,
        ...(this.lastBackoff ? { lastBackoff: this.lastBackoff } : {}),
        signals: this.signals,
        obsWebsocket: { enabled: s.obsWebsocket.enabled, connected: this.obs?.connected ?? false, ...(this.obs?.error ? { error: this.obs.error } : {}) },
      },
    };
  }

  /** Pids that must be gone after Stop (checked by LiveController.verifyOff). */
  get childPid(): number | undefined {
    return this.transcoder.pid;
  }

  async shutdown(): Promise<void> {
    await this.onLiveStop();
  }
}

function round(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n);
}
