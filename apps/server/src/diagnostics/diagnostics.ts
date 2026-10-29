import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiagnosticsSettings, LogExportResult } from '@swarmcast/shared';
import versions from '../../../../scripts/build/versions.json' with { type: 'json' };
import type { AppConfig } from '../core/config.js';
import type { LiveController } from '../core/live.js';
import { LOGS_MAX_TOTAL_BYTES, pruneLogs, retentionDays, serverLogName } from '../core/log-files.js';
import type { Logger } from '../core/logger.js';
import { exe, type AppPaths } from '../core/paths.js';
import { Anonymizer } from './anonymize.js';
import { EXPORT_LOG_DAYS, buildLogExport, downloadsDir, exportFileName, revealCommand, writeExportFile } from './export.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DiagnosticsOptions {
  paths: AppPaths;
  config: AppConfig;
  /** Write config.json after a settings change. */
  persist: () => void;
  live: LiveController;
  log: Logger;
  version: string;
  /** Desktop mode: the shell's version. */
  desktopVersion?: string;
  /** Per-run panel token (never exported). */
  panelToken: string;
  /** The server log file being written now (never deleted by the retention). */
  currentLogFile?: () => string | undefined;
  /** Where exports go; default: the user's Downloads folder (SWARMCAST_DOWNLOADS_DIR overrides it). */
  downloadsDir?: () => Promise<string | null>;
  now?: () => number;
}

/**
 * Log retention (at start and once a day) and "Export logs": a ZIP with the recent logs,
 * about.txt, the sanitised config, system-check.json and the activity log, anonymised, written
 * to the Downloads folder (falling back to `<data>/exports`).
 */
export class Diagnostics {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<LogExportResult> | null = null;
  /** Exports written by this run: the only paths "Show in folder" opens. */
  private readonly exported = new Set<string>();
  readonly exportsDir: string;
  private readonly now: () => number;

  constructor(private readonly o: DiagnosticsOptions) {
    this.exportsDir = path.join(o.paths.dataDir, 'exports');
    this.now = o.now ?? Date.now;
  }

  settings(): DiagnosticsSettings {
    return { logRetentionDays: retentionDays(this.o.config.diagnostics?.logRetentionDays) };
  }

  updateSettings(s: DiagnosticsSettings): DiagnosticsSettings {
    this.o.config.diagnostics = { ...this.o.config.diagnostics, logRetentionDays: retentionDays(s.logRetentionDays) };
    this.o.persist();
    this.prune();
    return this.settings();
  }

  /** Delete old logs and exports now. */
  prune(): string[] {
    const current = this.o.currentLogFile?.();
    const today = serverLogName(this.now());
    const deleted = pruneLogs({
      dirs: [this.o.paths.logsDir, this.exportsDir],
      maxAgeDays: this.settings().logRetentionDays,
      maxTotalBytes: LOGS_MAX_TOTAL_BYTES,
      now: this.now(),
      // Files being written right now: the server's, and the desktop shell's own desktop.log.
      protect: (f) => f === current || path.basename(f) === today || path.basename(f) === 'desktop.log',
    });
    if (deleted.length) this.o.log.info({ count: deleted.length }, 'old log files deleted');
    return deleted;
  }

  /** Retention at start, then once a day. */
  start(): void {
    this.prune();
    this.timer = setInterval(() => this.prune(), DAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One export at a time: a second click while one runs gets the same result. */
  exportLogs(opts: { includeFullIps?: boolean } = {}): Promise<LogExportResult> {
    this.running ??= this.doExport(!!opts.includeFullIps).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doExport(includeFullIps: boolean): Promise<LogExportResult> {
    const now = this.now();
    const live = this.o.live;
    const snap = live.snapshot();
    const joinSecret = snap.liveLink?.split('/join/')[1];
    const anon = new Anonymizer({
      includeFullIps,
      homeDir: os.homedir(),
      secrets: [
        snap.streamKey,
        snap.liveLink,
        joinSecret,
        snap.tunnelUrl,
        this.o.panelToken,
        ...snap.viewers.flatMap((v) => [v.sessionId, ...v.peerIds]),
      ],
      nicknames: snap.viewers.map((v) => v.nickname),
      // A custom tunnel's address and this computer's name (it often carries the owner's name).
      hostnames: [this.o.config.tunnel.externalUrl, snap.tunnelUrl, os.hostname()],
    });
    const built = await buildLogExport({
      logsDir: this.o.paths.logsDir,
      systemCheckFile: path.join(this.o.paths.dataDir, 'system-check.json'),
      config: this.o.config,
      activity: live.activity.list(),
      about: this.about(now, includeFullIps),
      anonymizer: anon,
      now,
    });
    const dir = this.o.downloadsDir ? await this.o.downloadsDir() : process.env.SWARMCAST_DOWNLOADS_DIR ? path.resolve(process.env.SWARMCAST_DOWNLOADS_DIR) : await downloadsDir();
    const written = writeExportFile(built.zip, exportFileName(this.o.version, now), dir, this.exportsDir);
    this.exported.add(written.path);
    this.o.log.info({ bytes: built.zip.length, fallback: written.fallback, fullIps: includeFullIps }, 'log export written');
    return { path: written.path, name: path.basename(written.path), folder: path.dirname(written.path), bytes: built.zip.length, fallback: written.fallback };
  }

  /** Show an export of this run in the file manager. False when the path is unknown or gone. */
  reveal(file: string): boolean {
    if (!this.exported.has(file) || !fs.existsSync(file)) return false;
    const { command, args } = revealCommand(file);
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => this.o.log.warn({ err: err.message }, 'could not open the file manager'));
      child.unref();
      return true;
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, 'could not open the file manager');
      return false;
    }
  }

  private about(now: number, includeFullIps: boolean): string[] {
    const live = this.o.live;
    const snap = live.snapshot();
    const q = live.quality.state();
    const cpus = os.cpus();
    const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`;
    const dur = (s: number): string => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
    const has = (name: string): string => (fs.existsSync(path.join(this.o.paths.binDir, exe(name))) ? 'present' : 'missing');
    const v = versions as unknown as Record<string, { version?: string }>;
    let osVersion = '';
    try {
      osVersion = os.version();
    } catch {
      /* old kernels */
    }
    const systemCheck = fs.existsSync(path.join(this.o.paths.dataDir, 'system-check.json')) ? 'included' : 'not found';
    return [
      'SwarmCast log export',
      '====================',
      `Created: ${new Date(now).toISOString()}`,
      `Contents: about.txt, config.json (no stream key, links or passwords), system-check.json, activity.txt (the panel's Activity card), logs/ (last ${EXPORT_LOG_DAYS} days: server, desktop app, MediaMTX, cloudflared and ffmpeg lines)`,
      `Anonymised: ${includeFullIps ? 'nicknames masked; IP addresses KEPT (asked for by the user)' : 'yes, IP addresses and nicknames are replaced by labels that only mean something inside this export'}`,
      '',
      `SwarmCast version: ${this.o.version}`,
      `Mode: ${this.o.desktopVersion ? 'desktop app' : 'script'}`,
      ...(this.o.desktopVersion ? [`Desktop app version: ${this.o.desktopVersion}`] : []),
      `OS: ${os.type()} ${os.release()}${osVersion ? ` (${osVersion})` : ''}`,
      `Platform / arch: ${process.platform} / ${process.arch}`,
      `CPU: ${cpus[0]?.model?.trim() ?? 'unknown'} × ${cpus.length} threads`,
      `RAM: ${gb(os.totalmem())} total, ${gb(os.freemem())} free`,
      `Node.js: ${process.version}`,
      `MediaMTX: ${v.mediamtx?.version ?? '?'} (${has('mediamtx')})`,
      `cloudflared: ${v.cloudflared?.version ?? '?'} (${has('cloudflared')})`,
      `ffmpeg: ${q.ffmpeg.available ? 'available' : 'not installed'}${q.ffmpeg.path ? ` at ${q.ffmpeg.path}` : ''} (pinned ${v.ffmpeg?.version ?? '?'})`,
      `Video encoders: ${q.encoders.length ? q.encoders.map((e) => `${e.id}=${e.ok ? 'ok' : 'failed'}${e.fps ? ` ${Math.round(e.fps)} fps` : ''}`).join(', ') : q.probing ? 'testing…' : 'not tested yet'}`,
      `Transcoder: ${q.transcoder.status} (restarts ${q.transcoder.restarts})`,
      `Uptime: SwarmCast ${dur(process.uptime())}, computer ${dur(os.uptime())}`,
      '',
      `Live phase: ${snap.phase}`,
      `Connection mode: ${snap.mode}, tunnel ${this.o.config.tunnel.provider}`,
      `OBS connected: ${snap.obsConnected ? 'yes' : 'no'}${snap.obsBitrateKbps ? `, ${snap.obsBitrateKbps} kbps` : ''}`,
      `Viewers: ${snap.stats.viewersConnected} connected, ${snap.stats.viewersHelping} helping (P2P ${snap.stats.p2pSharePercent}%)`,
      `Speed test: ${snap.speedTest ? `upload ${snap.speedTest.uploadMbps} Mbps, download ${snap.speedTest.downloadMbps} Mbps` : 'none yet'}`,
      `Settings: ${JSON.stringify(snap.settings)}`,
      `Quality settings: ${JSON.stringify(q.settings)}`,
      `Quality plan: ${JSON.stringify(q.plan)}`,
      `Log retention: ${this.settings().logRetentionDays} days`,
      `system-check.json: ${systemCheck}`,
    ];
  }
}
