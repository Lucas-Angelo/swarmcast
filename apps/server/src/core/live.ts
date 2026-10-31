import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  QUICK_TUNNEL_CONCURRENCY_LIMIT,
  QUICK_TUNNEL_WARN_SHARE,
  estimateCapacity,
  type AccessMode,
  type AdminState,
  type CodedText,
  type LivePhase,
  type MessageKey,
  type MessageParams,
  type SecuritySettings,
  type Settings,
  type SpeedTestResult,
  type Step,
} from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';
import { chatSettingsSchema, countGraphemes, type AdminChatMessage, type ChatSettings } from '@swarmcast/shared';
import { AccessControl, type Session } from '../access/access.js';
import { EgressWatch, type EgressWatchOptions } from '../access/own-connection.js';
import type { GuardOptions } from '../chat/guard.js';
import { ChatHub } from '../chat/hub.js';
import { BrandingStore } from '../branding/store.js';
import { ControlChannel } from '../control/control.js';
import { DirectMode, ipChangeNotice } from '../direct/direct.js';
import { lookupPublicIps } from '../direct/publicip.js';
import { ManifestSigner } from '../hls/manifest.js';
import { HlsOrigin } from '../hls/origin.js';
import { BandwidthLimiter } from '../hls/throttle.js';
import { MediaMtx, streamPath } from '../media/mediamtx.js';
import { isAlive, type Reaper } from '../process/children.js';
import type { LoadGuard, LoadGuardOptions } from '../quality/load-guard.js';
import { QualityManager } from '../quality/manager.js';
import { chatReserveMbps } from '../quality/upload-controller.js';
import { createPublicServer, recentPeak, type HttpStats, type PublicDeps } from '../public/server.js';
import type { PublicBlocklists } from '../security/blocklists.js';
import { SecurityShield } from '../security/shield.js';
import { runSpeedTest, speedTestUrls } from '../speedtest/speedtest.js';
import { TrackerService } from '../tracker/tracker.js';
import { probeHealth, waitForReachable, type TunnelProvider } from '../tunnel/provider.js';
import { ActivityLog } from './activity.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { notify } from './notify.js';
import { firstFreePort, isListening, isPortFree } from './ports.js';
import { CodedError, codeOf, coded } from './messages.js';
import { abortable } from './retry.js';

export interface LiveDeps {
  config: AppConfig;
  saveConfig: (cfg: AppConfig) => void;
  streamKey: string;
  signer: ManifestSigner;
  mediamtx: MediaMtx;
  tunnel: TunnelProvider;
  direct: DirectMode;
  viewerDir: string;
  log: Logger;
  version: string;
  /** Cookies get the Secure attribute (false only for plain-HTTP local testing without a tunnel). */
  secureCookies: boolean;
  /** Replaces the real speed test (tests); `signal` aborts it when the app quits. */
  speedTest?: (signal: AbortSignal) => Promise<SpeedTestResult>;
  now?: () => number;
  /** In-memory activity log shown in the panel (a private one is created when omitted). */
  activity?: ActivityLog;
  /** Quality ladder / adaptive upload (docs/QUALITY.md). Omitted in logic tests: no ffmpeg, no ladder. */
  quality?: { binDir: string; dataDir: string; runDir: string; reaper: Reaper | null; loadGuard?: LoadGuard | Partial<LoadGuardOptions> };
  /** The chat's event-loop guard (tests): its sample source and period; omitted, it samples this process's event loop. */
  chatGuard?: GuardOptions;
  /** Public IP blocklists (downloaded by the app; none in logic tests). */
  blocklists?: PublicBlocklists;
  /** Key of the "browser already passed the check" cookie (secrets.json; random in logic tests). */
  browserCheckKey?: string;
  /** `<data>/branding` (docs/BRANDING.md); omitted in logic tests: images kept in memory only. */
  brandingDir?: string;
  /** Replaces parts of the own-public-address watch (tests: a fake lookup, fast ticks). */
  egress?: Partial<Omit<EgressWatchOptions, 'log'>>;
}

type StepDef = { id: string; labelKey: MessageKey };

const START_STEPS: StepDef[] = [
  { id: 'server', labelKey: 'step.server' },
  { id: 'mediamtx', labelKey: 'step.mediamtx' },
  { id: 'tunnel', labelKey: 'step.tunnel' },
];

const STOP_STEPS: StepDef[] = [
  { id: 'viewers', labelKey: 'step.stop.viewers' },
  { id: 'tunnel', labelKey: 'step.stop.tunnel' },
  { id: 'mediamtx', labelKey: 'step.stop.mediamtx' },
  { id: 'cache', labelKey: 'step.stop.cache' },
  { id: 'verify', labelKey: 'step.stop.verify' },
];

/** Viewer count pushes to viewers happen at most this often. */
export const VIEWER_COUNT_INTERVAL_MS = 3000;

/** Segments longer than this mean OBS keyframes are too far apart (target: 2 s). */
export const KEYFRAME_WARN_S = 3;

/** Orchestrates one live: start/stop with visible steps, link rotation, viewer control. */
export class LiveController extends EventEmitter<{ state: []; 'link-changed': [link: string]; chat: [msg: AdminChatMessage] }> {
  phase: LivePhase = 'off';
  mode: AccessMode = 'secure';
  steps: Step[] = [];
  readonly access = new AccessControl();
  readonly origin: HlsOrigin;
  readonly tracker: TrackerService;
  readonly control: ControlChannel;
  /** The chat of the live (docs/CHAT.md); rides on the control channel. */
  readonly chat: ChatHub;
  /** The streamer's page (docs/BRANDING.md). */
  readonly branding: BrandingStore;
  private brandingPush: NodeJS.Timeout | null = null;
  readonly limiter: BandwidthLimiter;
  readonly quality: QualityManager;
  private publicServer: FastifyInstance | null = null;
  private directServer: FastifyInstance | null = null;
  /** `config.ports.public` as configured: 0 (tests) means "any free port" on every start. */
  private readonly wantedPublicPort: number;
  private baseUrl: string | null = null;
  tunnelUrlChangedAt?: number;
  private obsConnected = false;
  private startedAt = 0;
  private autoStopTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  readonly httpStats: HttpStats = { inFlight: 0, served: 0, peak: 0, peakAt: 0 };
  speedTest?: SpeedTestResult;
  speedTestRunning = false;
  private speedTimer: NodeJS.Timeout | null = null;
  warnings: CodedText[] = [];
  readonly activity: ActivityLog;
  /** Attack detection, automatic reactions, join proof-of-work and public blocklists. */
  readonly shield: SecurityShield;
  /** Sessions whose control connection dropped (to log "is back" when they reconnect). */
  private away = new Set<string>();
  private keyframeWarned = false;
  private countTimer: NodeJS.Timeout | null = null;
  private lastCountAt = 0;
  /** Last count broadcast to viewers (undefined = nothing sent yet). */
  private sentCount: number | null | undefined;
  private tunnelDrops = 0;
  private busy: Promise<unknown> = Promise.resolve();
  /** Aborted when the app quits: running speed tests stop at once. */
  private readonly quitting = new AbortController();
  private originBytes = { http: 0 };
  private lastStepError?: string;
  /** The server's own public addresses, while a live runs in Secure mode (P2P privacy). */
  readonly egress: EgressWatch;
  /** Client addresses already checked per session (each one is checked once). */
  private seenIps = new WeakMap<Session, Set<string>>();

  constructor(private readonly d: LiveDeps) {
    super();
    this.activity = d.activity ?? new ActivityLog();
    const ports = d.config.ports;
    this.wantedPublicPort = ports.public;
    this.origin = new HlsOrigin(`http://127.0.0.1:${ports.mediamtxHls}/${streamPath(d.streamKey)}/`, d.log);
    this.limiter = BandwidthLimiter.fromMbps(d.config.uploadLimitMbps);
    this.access.p2pForAll = d.config.allowViewerP2P;
    this.tracker = new TrackerService(this.access, d.log);
    this.control = new ControlChannel(this.access, d.log);
    // Viewers' tracker traffic rides on their /control socket (one WebSocket per viewer).
    this.control.tracker = this.tracker;
    this.egress = new EgressWatch({ lookup: lookupPublicIps, now: d.now, ...d.egress, log: d.log });
    this.egress.on('changed', () => this.egressChanged());
    const q = d.quality ?? { binDir: '/nonexistent', dataDir: '/nonexistent', runDir: '/nonexistent', reaper: null };
    this.quality = new QualityManager({
      config: d.config,
      saveConfig: d.saveConfig,
      origin: this.origin,
      limiter: this.limiter,
      tracker: this.tracker,
      log: d.log,
      ...q,
      rtmpReadUrl: `rtmp://127.0.0.1:${ports.rtmp}/${streamPath(d.streamKey)}`,
      mediamtxHlsUrl: `http://127.0.0.1:${ports.mediamtxHls}/${streamPath(d.streamKey)}/`,
      streamKey: d.streamKey,
      speedTest: () => this.speedTest,
      quitSignal: this.quitting.signal,
      warn: (code, params) => this.warn(code, params),
      now: d.now,
    });
    this.quality.on('changed', () => this.changed());
    this.shield = new SecurityShield({
      settings: () => this.securitySettings(),
      limits: () => ({ maxViewers: d.config.maxViewers, maxSessionsPerDevice: d.config.maxSessionsPerDevice }),
      blocklists: d.blocklists,
      browserCheckKey: d.browserCheckKey,
      activity: this.activity,
      log: d.log,
      now: d.now,
      sample: () => ({
        viewers: this.connectedSessions().length,
        sessions: this.access.sessions.size,
        saturation: this.limiter.currentMbps() / Math.max(1, d.config.uploadLimitMbps),
      }),
      actions: {
        mode: () => this.mode,
        rotateLink: () => {
          this.rotateLink();
          this.tunnelUrlChangedAt = this.now();
          const link = this.liveLink;
          if (link) this.emit('link-changed', link);
        },
        backToSecure: async () => {
          await this.disableDirect();
        },
        stopAll: () => this.stop(),
        report: (code, params) => {
          this.warn(code, params);
          notify('SwarmCast: attack protection', translate('en', code, params));
        },
      },
      changed: () => this.changed(),
    });

    this.chat = new ChatHub({
      access: this.access,
      host: this.control,
      settings: () => this.d.config.chat,
      uploadCapMbps: () => this.d.config.uploadLimitMbps,
      viewers: () => this.connectedSessions().length,
      shieldLevel: () => {
        const st = this.shield.detector.state;
        return st === 'attack' ? 2 : st === 'suspicious' ? 1 : 0;
      },
      activity: this.activity,
      log: d.log,
      now: d.now,
      onAdmin: (m) => this.emit('chat', m),
      onState: () => this.changed(),
      onTick: (level, egress, budget) => {
        this.shield.chatSignal(level);
        this.limiter.setReserveMbps(chatReserveMbps(budget, egress));
      },
      ...(d.chatGuard ? { guard: d.chatGuard } : {}),
    });
    this.control.chat = this.chat;
    // ---- branding: store ----
    this.branding = new BrandingStore({
      dir: d.brandingDir,
      get: () => this.d.config.branding,
      save: (b) => {
        this.d.config.branding = b;
        this.d.saveConfig(this.d.config);
      },
      activity: this.activity,
      log: d.log,
    });
    this.branding.load();
    this.control.brandRev = () => (this.d.config.branding.enabled ? this.d.config.branding.rev : undefined);
    // ---- end branding ----

    this.access.on('kicked', (s) => {
      this.activity.action('log.kicked', { nickname: s.nickname });
      this.viewerCountChanged();
      this.control.kick(s.id);
      this.tracker.disconnectSession(s.id);
      this.control.blockPeers([...s.peerIds]);
      this.changed();
    });
    this.access.on('p2p-changed', (s) => {
      if (s.p2pAllowed) this.activity.action('log.p2pAllowed', { nickname: s.nickname });
      else if (!s.autoRemovedFromP2P) this.activity.action('log.p2pRemoved', { nickname: s.nickname });
      this.pushP2P(s);
      this.changed();
    });
    this.control.viewerCount = () => {
      const count = this.d.config.showViewerCount ? this.connectedSessions().length : null;
      // This viewer's hello carries a number other than the last broadcast one, so viewers no
      // longer all have `sentCount`: forget it, or a later push of that same number would be
      // skipped and this viewer would keep a stale count (e.g. 2 -> 0 -> 2 within one throttle
      // window: the viewer greeted with "1" in between never sees "2").
      if (count !== this.sentCount) {
        this.sentCount = undefined;
        this.viewerCountChanged();
      }
      return count;
    };
    this.access.on('session-created', (s) => {
      this.activity.add({ kind: 'viewer', code: 'log.viewerJoined', params: { nickname: s.nickname } });
      this.clientSeen(s, s.ip);
      this.viewerCountChanged();
      this.d.direct.noteViewer(s.id);
      this.changed();
    });
    this.control.onHashFailure = (_reporter, accused, auto) => {
      if (auto && accused) this.warn('warn.autoRemoved', { nickname: accused.nickname });
      this.changed();
    };
    this.control.onPresence = (s, connected) => {
      this.viewerCountChanged();
      if (connected && this.away.delete(s.id)) {
        this.activity.add({ kind: 'viewer', code: 'log.viewerBack', params: { nickname: s.nickname } });
      } else if (!connected && this.phase !== 'stopping' && this.access.sessions.get(s.id) === s) {
        this.away.add(s.id);
        this.activity.add({ kind: 'viewer', code: 'log.viewerLeft', params: { nickname: s.nickname } });
      }
    };
    this.origin.on('available', (v) => {
      if (this.phase === 'waiting-obs' && v) {
        this.phase = 'live';
        this.activity.action('log.live');
      } else if (this.phase === 'live' && !v) {
        this.phase = 'waiting-obs';
        this.activity.action('log.notLive');
      }
      this.changed();
    });
    d.mediamtx.onPublish = (e) => {
      const was = this.obsConnected;
      this.obsConnected = e === 'publishing';
      if (this.obsConnected !== was) this.activity.action(this.obsConnected ? 'log.obsConnected' : 'log.obsDisconnected');
      this.quality.onPublish(e);
      this.changed();
    };
    d.tunnel.on('url', (url) => this.onTunnelUrl(url));
    d.tunnel.on('down', (reason) => {
      this.tunnelDrops += 1;
      this.warn('warn.tunnelDropped', { reason });
    });
  }

  private changed(): void {
    this.emit('state');
  }

  /** Tell a viewer whether it may use P2P now, and drop it from the swarm (and from peers) when not. */
  private pushP2P(s: Session): void {
    const allowed = this.access.p2pAllowed(s);
    const reason = this.access.p2pBlock(s);
    this.control.send(s.id, { t: 'p2p', allowed, forAll: this.access.p2pForAll, ...(reason ? { reason } : {}) });
    if (!allowed) {
      this.tracker.disconnectSession(s.id);
      this.control.blockPeers([...s.peerIds]);
    } else {
      this.control.unblockPeers([...s.peerIds]);
    }
  }

  // ---- P2P privacy: no P2P on the streamer's own connection (access/own-connection.ts) ----

  /**
   * Viewers' real addresses are known (CF-Connecting-IP from the local quick-tunnel connector),
   * so viewers on the streamer's own connection can be told apart. Direct mode needs none of
   * this: there the streamer's IP is public by design.
   */
  private get tunnelTrusted(): boolean {
    return this.mode === 'secure' && this.d.config.trustTunnelProxy && this.d.tunnel.name === 'cloudflare-quick';
  }

  /** Start or stop the own-address watch to match the mode, and apply its state. */
  private syncEgress(): void {
    if (this.tunnelTrusted && this.access.live) this.egress.start();
    else this.egress.stop();
    this.egressChanged();
  }

  /** The own addresses (or their status) changed: check every session again. */
  private egressChanged(): void {
    const checking = this.egress.active && this.egress.status === 'unknown';
    const flip = checking !== this.access.p2pChecking;
    this.access.p2pChecking = checking;
    for (const s of this.access.sessions.values()) {
      const flagged = this.recheck(s);
      if (flip && !flagged) {
        // Not this viewer's own doing: no peers to block, just "P2P waits" or "P2P may resume".
        const reason = this.access.p2pBlock(s);
        this.control.send(s.id, { t: 'p2p', allowed: this.access.p2pAllowed(s), forAll: this.access.p2pForAll, ...(reason ? { reason } : {}) });
        if (!this.access.p2pAllowed(s)) this.tracker.disconnectSession(s.id);
      }
    }
    if (flip) this.changed();
  }

  /** A session made a request from `ip`: remember it and check it once. */
  private clientSeen(s: Session, ip: string): void {
    if (!this.egress.active || s.ownConnection) return;
    let seen = this.seenIps.get(s);
    if (!seen) this.seenIps.set(s, (seen = new Set()));
    if (seen.has(ip)) return;
    // A handful is plenty (a phone moving between Wi-Fi and mobile data); drop the oldest.
    if (seen.size >= 8) seen.delete(seen.values().next().value!);
    seen.add(ip);
    if (this.egress.classify(ip) === 'own') this.markOwnConnection(s);
  }

  /** Check every address a session was seen with; true when it was just flagged. */
  private recheck(s: Session): boolean {
    if (!this.egress.active || s.ownConnection) return false;
    const ips = this.seenIps.get(s) ?? new Set([s.ip]);
    for (const ip of ips) {
      if (this.egress.classify(ip) === 'own') {
        this.markOwnConnection(s);
        return true;
      }
    }
    return false;
  }

  /** For the rest of the live: no P2P for this session, and every peer drops it. */
  private markOwnConnection(s: Session): void {
    s.ownConnection = true;
    // The nickname only (the log export anonymises it); never the address.
    this.d.log.info({ viewer: s.nickname }, 'viewer on the streamer\'s own internet connection: P2P off for it, to keep the streamer\'s IP private');
    this.activity.action('log.p2pOwnConnection', { nickname: s.nickname });
    this.pushP2P(s);
    this.changed();
  }

  private warn(code: MessageKey, params?: MessageParams): void {
    const w = coded(code, params);
    this.warnings = [w, ...this.warnings.filter((x) => x.text !== w.text)].slice(0, 5);
    // `panel: true`: already in the activity log with its code, so the log stream skips it.
    this.d.log.warn({ panel: true }, w.text);
    this.activity.add({ level: 'warn', kind: 'system', code, params });
    this.changed();
  }

  /** Serialize start/stop/mode changes. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  get liveLink(): string | undefined {
    if (!this.baseUrl || !this.access.live) return undefined;
    return `${this.baseUrl}/join/${this.access.currentSecret}`;
  }

  private setSteps(defs: StepDef[]): void {
    this.steps = defs.map((s) => ({ id: s.id, label: translate('en', s.labelKey), labelKey: s.labelKey, status: 'pending' }));
    this.changed();
  }

  private async step<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const s = this.steps.find((x) => x.id === id)!;
    s.status = 'running';
    delete s.error;
    delete s.errorCode;
    delete s.errorParams;
    this.changed();
    try {
      const r = await fn();
      s.status = 'ok';
      this.activity.action('log.stepOk', { stepKey: s.labelKey });
      this.changed();
      return r;
    } catch (err) {
      s.status = 'error';
      s.error = (err as Error).message;
      const c = codeOf(err);
      if (c.code) s.errorCode = c.code;
      if (c.params) s.errorParams = c.params;
      this.lastStepError = s.error;
      this.activity.action('log.stepFailed', { stepKey: s.labelKey, error: s.error }, 'error');
      this.changed();
      throw err;
    }
  }

  start(): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase !== 'off') return;
      this.phase = 'starting';
      this.mode = 'secure';
      this.warnings = [];
      this.away.clear();
      this.keyframeWarned = false;
      this.tunnelDrops = 0;
      this.setSteps(START_STEPS);
      try {
        await this.step('server', async () => {
          // Port 0: the OS picks a free port at listen time (no probe-then-bind race).
          const port = this.wantedPublicPort === 0 ? 0 : await firstFreePort(this.wantedPublicPort);
          if (port === null) throw new CodedError('err.portsBusy', { port: this.wantedPublicPort });
          this.d.config.ports.public = port;
          if (!(await isPortFree(this.d.config.ports.rtmp))) {
            throw new CodedError('err.rtmpBusy', { port: this.d.config.ports.rtmp });
          }
          this.access.begin();
          this.chat.begin();
          // Look up our own public address while the tunnel opens (P2P privacy).
          this.syncEgress();
          this.shield.start();
          this.tracker.setSwarm(this.access.liveId);
          this.publicServer = await this.createServer('secure');
          await this.publicServer.listen({ host: '127.0.0.1', port: this.d.config.ports.public });
          this.d.config.ports.public = (this.publicServer.server.address() as AddressInfo).port;
        });
        await this.step('mediamtx', async () => {
          await this.d.mediamtx.start();
          this.quality.onLiveStart();
          this.origin.start();
        });
        await this.step('tunnel', async () => {
          this.baseUrl = await this.openTunnel();
        });
        this.startedAt = this.now();
        this.phase = this.origin.available ? 'live' : 'waiting-obs';
        this.startTimers();
        this.d.log.info('live started; waiting for OBS');
        this.activity.action('log.started');
        this.changed();
      } catch (err) {
        if (this.quitting.signal.aborted) this.d.log.info('start cancelled: SwarmCast is quitting');
        else this.d.log.error({ err: (err as Error).message }, 'start failed');
        await this.teardown(false);
        this.phase = 'off';
        this.changed();
        throw err;
      }
    });
  }

  /** The tunnel step can take minutes (new quick-tunnel names need DNS): quitting gives up at once. */
  private async openTunnel(): Promise<string> {
    const signal = this.quitting.signal;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // On abort, the start's teardown stops cloudflared, which ends tunnel.start().
      const url = await abortable(this.d.tunnel.start(this.d.config.ports.public), signal);
      if (this.d.tunnel.name === 'none') return url;
      if (await waitForReachable(url, this.access.liveId, { timeoutMs: 60_000, signal, probe: this.access.probeToken() })) return url;
      this.d.log.warn({ attempt }, 'tunnel address not reachable yet, retrying with a new tunnel');
      await this.d.tunnel.stop();
    }
    throw new CodedError('err.tunnelNoAnswer');
  }

  private async onTunnelUrl(url: string): Promise<void> {
    if (this.mode !== 'secure' || !this.access.live) return;
    const ok = await waitForReachable(url, this.access.liveId, { timeoutMs: 60_000, signal: this.quitting.signal, probe: this.access.probeToken() }).catch(() => false);
    if (this.quitting.signal.aborted) return;
    this.baseUrl = url;
    this.tunnelUrlChangedAt = this.now();
    this.warn(ok ? 'warn.tunnelNewAddress' : 'warn.tunnelNotAnswering');
    const link = this.liveLink;
    if (link) {
      notify('SwarmCast: new stream link', 'The tunnel address changed. Open the panel and send the new link.');
      this.emit('link-changed', link);
    }
  }

  private createServer(mode: 'secure' | 'direct', https?: Parameters<typeof createPublicServer>[1]['https']): Promise<FastifyInstance> {
    const deps: PublicDeps = {
      access: this.access,
      origin: this.origin,
      signer: this.d.signer,
      tracker: this.tracker,
      control: this.control,
      limiter: this.limiter,
      viewerDir: this.d.viewerDir,
      log: this.d.log,
      stunServers: () => this.d.config.stunServers,
      swarmId: () => this.access.liveId,
      limits: () => this.shield.effectiveLimits(),
      stats: this.httpStats,
      security: this.shield,
      clientSeen: (s, ip) => this.clientSeen(s, ip),
      reservedNames: () => [this.d.config.chat.streamerName],
      gifProvider: () => this.chat.effective.public.gif?.provider,
      branding: this.branding,
      brandingLite: () => this.shield.detector.state !== 'normal' || this.limiter.throttledWithin(10_000),
    };
    return createPublicServer(deps, {
      mode,
      secureCookies: mode === 'direct' ? true : this.d.secureCookies,
      trustTunnel: mode === 'secure' && this.tunnelTrusted,
      https,
    });
  }

  /** Used by DirectMode to start the internet-facing HTTPS server. */
  async startDirectServer(
    port: number,
    host: string,
    sni: NonNullable<Parameters<typeof createPublicServer>[1]['https']>['SNICallback'],
    defaultCert: { key: string; cert: string },
  ): Promise<{ close(): Promise<void> }> {
    const app = await this.createServer('direct', { key: defaultCert.key, cert: defaultCert.cert, SNICallback: sni });
    app.server.maxConnections = 300;
    await app.listen({ host, port });
    this.directServer = app;
    return {
      close: async () => {
        if (this.directServer === app) this.directServer = null;
        await app.close();
      },
    };
  }

  /** The port the local public server listens on (null while the live is off). */
  get publicPort(): number | null {
    const addr = this.publicServer?.server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  /** Test hook: forget the rate-limit counters of the public server (and of Direct mode's). */
  resetRateLimits(): void {
    this.publicServer?.resetRateLimits();
    this.directServer?.resetRateLimits();
  }

  private startTimers(): void {
    this.lastVideoCheck();
    this.autoStopTimer = setInterval(() => this.lastVideoCheck(), 5000);
    this.statsTimer = setInterval(() => {
      this.changed();
      // Sessions also stop counting 30 s after their last sign of life.
      this.viewerCountChanged();
    }, 2000);
  }

  /** Sessions that count as watching (same definition as the panel's "Watching"). */
  connectedSessions(): Session[] {
    const now = this.now();
    return [...this.access.sessions.values()].filter((s) => s.connections > 0 || now - s.lastSeenAt < 30_000);
  }

  /** Schedule a viewer-count push (throttled to one every VIEWER_COUNT_INTERVAL_MS, only on change). */
  viewerCountChanged(): void {
    if (this.countTimer) return;
    const wait = Math.max(0, this.lastCountAt + VIEWER_COUNT_INTERVAL_MS - this.now());
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.pushViewerCount();
    }, wait);
    this.countTimer.unref?.();
  }

  private pushViewerCount(): void {
    const count = this.d.config.showViewerCount ? this.connectedSessions().length : null;
    if (count === this.sentCount) return;
    this.sentCount = count;
    this.lastCountAt = this.now();
    this.control.broadcast({ t: 'viewers', count });
  }

  private stopTimers(): void {
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countTimer = null;
    this.sentCount = undefined;
    if (this.autoStopTimer) clearInterval(this.autoStopTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.autoStopTimer = this.statsTimer = null;
  }

  get autoStopAt(): number | undefined {
    if (this.phase !== 'live' && this.phase !== 'waiting-obs') return undefined;
    const last = Math.max(this.origin.lastSegmentAt, this.startedAt);
    return last + this.d.config.autoStopMinutes * 60_000;
  }

  private lastVideoCheck(): void {
    const at = this.autoStopAt;
    if (at !== undefined && this.now() >= at) {
      this.d.log.info('no video from OBS for too long, stopping automatically');
      this.activity.action('log.autoStop', { minutes: this.d.config.autoStopMinutes }, 'warn');
      notify('SwarmCast stopped', `No video from OBS for ${this.d.config.autoStopMinutes} minutes, so everything was turned off.`);
      void this.stop().catch(() => {});
    }
  }

  stop(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.phase === 'off') return true;
      this.phase = 'stopping';
      this.setSteps(STOP_STEPS);
      const verified = await this.teardown(true);
      this.activity.add(verified ? { kind: 'action', code: 'log.stopped' } : { kind: 'action', level: 'warn', code: 'log.stoppedUnverified' });
      this.phase = 'off';
      this.changed();
      return verified;
    });
  }

  /** Shut everything down. With `withSteps`, report each step and verify at the end. */
  private async teardown(withSteps: boolean): Promise<boolean> {
    const run = async (id: string, fn: () => Promise<void>): Promise<void> => {
      if (withSteps) {
        await this.step(id, fn).catch(() => {});
      } else {
        await fn().catch((e) => this.d.log.warn({ err: (e as Error).message, step: id }, 'teardown step failed'));
      }
    };
    this.stopTimers();
    const tunnelUrl = this.baseUrl;
    const directWasOn = this.d.direct.active;
    await run('viewers', async () => {
      this.shield.stop();
      this.control.closeAll('ended');
      this.tracker.disconnectAll();
      this.access.reset();
      // Chat history, mutes and colours are wiped with everything else.
      this.chat.reset();
      this.limiter.setReserveMbps(0);
      this.syncEgress();
      await this.publicServer?.close();
      this.publicServer = null;
    });
    await run('tunnel', async () => {
      await this.d.tunnel.stop();
      if (directWasOn) {
        const r = await this.d.direct.disable();
        if (!r.verified) throw new CodedError('err.directPortOpen', { details: r.details.join(', ') });
      }
      this.baseUrl = null;
      this.mode = 'secure';
    });
    await run('mediamtx', async () => {
      await this.quality.onLiveStop();
      this.origin.stop();
      await this.d.mediamtx.stop();
      this.obsConnected = false;
    });
    await run('cache', async () => {
      this.origin.clear();
      if (this.origin.cachedFileCount !== 0) throw new CodedError('err.cacheNotEmpty');
    });
    if (!withSteps) return true;
    let verified = true;
    await run('verify', async () => {
      const problems = await this.verifyOff(tunnelUrl && tunnelUrl.startsWith('https://') ? tunnelUrl : null);
      if (problems.length) {
        verified = false;
        throw new CodedError('err.leftovers', { problems: problems.join('; ') });
      }
    });
    return verified;
  }

  /** Confirm no child process, local port or public URL is left. */
  async verifyOff(publicUrl: string | null): Promise<string[]> {
    const problems: string[] = [];
    const deadline = this.now() + 15_000;
    const ports = this.d.config.ports;
    for (;;) {
      problems.length = 0;
      if (this.d.mediamtx.pid && isAlive(this.d.mediamtx.pid)) problems.push('MediaMTX is still running');
      if (this.d.tunnel.pid && isAlive(this.d.tunnel.pid)) problems.push('cloudflared is still running');
      if (this.quality.childPid && isAlive(this.quality.childPid)) problems.push('the video converter (ffmpeg) is still running');
      for (const [name, port] of [
        ['RTMP', ports.rtmp],
        ['HLS', ports.mediamtxHls],
        ['public server', ports.public],
      ] as const) {
        if (await isListening(port)) problems.push(`port ${port} (${name}) is still open`);
      }
      if (publicUrl) {
        // Resolve via DoH like the readiness check, so a cached NXDOMAIN cannot fake "gone".
        const marker = await probeHealth(publicUrl).catch(() => null);
        if (marker) problems.push('the public address still answers');
      }
      if (problems.length === 0 || this.now() > deadline) return problems;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  rotateLink(): string | undefined {
    if (!this.access.live) return undefined;
    this.access.rotateLink();
    this.activity.action('log.linkRotated');
    this.changed();
    return this.liveLink;
  }

  disconnectAll(): void {
    this.control.closeAll('disconnected');
    this.tracker.disconnectAll();
    this.access.disconnectAll();
    this.away.clear();
    this.activity.action('log.disconnectAll');
    this.viewerCountChanged();
    this.changed();
  }

  kick(sessionId: string): boolean {
    return !!this.access.kick(sessionId);
  }

  setP2P(sessionId: string, allowed: boolean): boolean {
    return !!this.access.setP2PAllowed(sessionId, allowed);
  }

  /**
   * "Allow P2P for viewers" (panel): off is the emergency switch. Every viewer is told over the
   * control channel (P2P off live, playback goes on over HTTPS) and dropped from the tracker;
   * back on, viewers who were not removed one by one may use P2P again.
   */
  private setP2PForAll(on: boolean): void {
    this.d.config.allowViewerP2P = on;
    this.access.p2pForAll = on;
    this.activity.action(on ? 'log.p2pForAllOn' : 'log.p2pForAllOff');
    for (const s of this.access.sessions.values()) {
      const reason = this.access.p2pBlock(s);
      this.control.send(s.id, { t: 'p2p', allowed: this.access.p2pAllowed(s), forAll: on, ...(reason ? { reason } : {}) });
      if (!on) this.tracker.disconnectSession(s.id);
    }
  }

  clearBans(): void {
    this.access.clearBans();
    this.activity.action('log.bansCleared');
    this.changed();
  }

  updateSettings(s: Settings): void {
    this.d.config.uploadLimitMbps = s.uploadLimitMbps;
    this.d.config.autoStopMinutes = s.autoStopMinutes;
    this.d.config.alsoStreamingElsewhere = s.alsoStreamingElsewhere;
    const countChanged = this.d.config.showViewerCount !== s.showViewerCount;
    this.d.config.showViewerCount = s.showViewerCount;
    // Applies to new joins only: lowering the cap never drops anyone already watching.
    if (s.maxViewers !== undefined) this.d.config.maxViewers = s.maxViewers;
    if (s.maxSessionsPerDevice !== undefined) this.d.config.maxSessionsPerDevice = s.maxSessionsPerDevice;
    if (countChanged) this.viewerCountChanged();
    if (s.allowViewerP2P !== this.access.p2pForAll) this.setP2PForAll(s.allowViewerP2P);
    // In automatic upload mode the adaptive controller owns the limiter.
    this.quality.applyManualLimit();
    this.d.saveConfig(this.d.config);
    this.activity.action('log.settingsSaved', { upload: s.uploadLimitMbps, autoStop: s.autoStopMinutes });
    this.changed();
  }

  // ---- attack protection ----

  securitySettings(): SecuritySettings {
    const c = this.d.config.security;
    return {
      blockKnownBadIps: c.blockKnownBadIps,
      requireBrowserCheck: c.requireBrowserCheck,
      autoTighten: c.autoTighten,
      autoBrowserCheck: c.autoBrowserCheck,
      autoNewLink: c.autoNewLink,
      autoSecureFromDirect: c.autoSecureFromDirect,
      autoStopIfDirectFails: c.autoStopIfDirectFails,
      stopOnAttack: c.stopOnAttack,
    };
  }

  updateSecurity(s: SecuritySettings): void {
    const wasBlocking = this.d.config.security.blockKnownBadIps;
    this.d.config.security = { ...this.d.config.security, ...s };
    if (s.blockKnownBadIps && !wasBlocking) this.d.blocklists?.start();
    if (!s.blockKnownBadIps && wasBlocking) this.d.blocklists?.stop();
    this.d.saveConfig(this.d.config);
    this.activity.action('log.securitySaved');
    this.changed();
  }

  // ---- branding ----

  /** The page changed (panel): tell open viewer pages, at most once every 2 s. */
  brandingChanged(): void {
    this.changed();
    if (this.brandingPush) return;
    this.brandingPush = setTimeout(() => {
      this.brandingPush = null;
      this.control.broadcast({ t: 'branding', rev: this.d.config.branding.rev });
    }, 2000);
    this.brandingPush.unref();
  }

  // ---- chat ----

  chatSettings(): ChatSettings {
    return this.d.config.chat;
  }

  /**
   * Save the chat settings (panel). Throws a CodedError for values the schema cannot check:
   * the streamer's chat name follows the nickname rules, blocked words have 1 to 40 characters,
   * and GIFs need the streamer's own key.
   */
  updateChatSettings(input: unknown): ChatSettings {
    const s = chatSettingsSchema.parse(input);
    const name = ChatHub.validStreamerName(s.streamerName);
    if (name === null) throw new CodedError('admin.chat.err.streamerName');
    s.streamerName = name;
    if (s.blockedWords.some((w) => countGraphemes(w) > 40)) throw new CodedError('admin.chat.err.blockedWord');
    if (s.content.gifs && !s.gif.key) throw new CodedError('admin.chat.err.gifKey');
    this.d.config.chat = s;
    this.d.saveConfig(this.d.config);
    this.activity.action('log.chat.settingsSaved');
    this.chat.refresh();
    this.changed();
    return s;
  }

  /** "End alert": the streamer says the attack is over (or was a false alarm). */
  clearAttackAlert(): void {
    this.shield.clearAlert();
  }

  // ---- direct mode ----

  async enableDirect(opts: { manualPortForward?: boolean }): Promise<string> {
    return this.exclusive(async () => {
      if (!this.access.live) throw new CodedError('err.startFirst');
      if (this.mode === 'direct') throw new CodedError('err.directAlreadyOn');
      const base = await this.d.direct.enable(opts);
      // Switching modes changes the address: new link, old sessions dropped.
      await this.d.tunnel.stop();
      this.mode = 'direct';
      this.baseUrl = base;
      this.disconnectAll();
      this.syncEgress();
      this.access.rotateLink();
      this.tunnelUrlChangedAt = this.now();
      this.activity.action('log.directOn', undefined, 'warn');
      this.changed();
      return this.liveLink!;
    });
  }

  async disableDirect(): Promise<string | undefined> {
    return this.exclusive(async () => {
      if (this.mode !== 'direct') return this.liveLink;
      this.disconnectAll();
      const r = await this.d.direct.disable();
      if (!r.verified) this.warn('warn.routerPortUnconfirmed', { details: r.details.join(', ') });
      this.mode = 'secure';
      this.syncEgress();
      this.baseUrl = null;
      this.baseUrl = await this.openTunnel();
      this.access.rotateLink();
      this.tunnelUrlChangedAt = this.now();
      this.activity.action('log.directOff');
      this.changed();
      return this.liveLink;
    });
  }

  // ---- speed test ----

  async runSpeedTest(): Promise<SpeedTestResult | undefined> {
    if (this.speedTestRunning) return this.speedTest;
    this.speedTestRunning = true;
    this.activity.action('log.speedTestStarted');
    this.changed();
    try {
      this.speedTest = await (this.d.speedTest ?? ((signal) => runSpeedTest({ ...speedTestUrls(), signal })))(this.quitting.signal);
      this.d.log.info({ up: this.speedTest.uploadMbps, down: this.speedTest.downloadMbps }, 'speed test done');
      this.activity.action('log.speedTestDone', { up: this.speedTest.uploadMbps, down: this.speedTest.downloadMbps, ping: this.speedTest.latencyMs });
      return this.speedTest;
    } catch (err) {
      if (!this.quitting.signal.aborted) this.warn('warn.speedTestFailed', { error: (err as Error).message });
      return undefined;
    } finally {
      this.speedTestRunning = false;
      this.changed();
    }
  }

  /** Automatic tests only while not live, so they never compete with the stream. */
  scheduleSpeedTests(): void {
    if (!this.d.config.speedTest.enabled) return;
    void this.runSpeedTest();
    this.speedTimer = setInterval(() => {
      if (this.phase === 'off') void this.runSpeedTest();
    }, this.d.config.speedTest.intervalMinutes * 60_000);
    this.speedTimer.unref();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // ---- first-run setup tutorial (admin panel) ----

  get onboardingDone(): boolean {
    return this.d.config.onboardingDone;
  }

  setOnboardingDone(done: boolean): void {
    this.d.config.onboardingDone = done;
    this.d.saveConfig(this.d.config);
  }

  // ---- state for the admin panel ----

  /**
   * What a quick tunnel counts against its 200-in-flight limit: open WebSockets (/control, plus
   * any plain /tracker socket) and HTTP requests in progress (the peak of the last ~10 s).
   */
  tunnelInFlight(): number {
    return this.control.connectionCount + this.tracker.plainSocketCount + recentPeak(this.httpStats);
  }

  snapshot(): AdminState {
    const sessions = [...this.access.sessions.values()];
    const connected = this.connectedSessions();
    const helping = connected.filter((s) => s.p2pEnabled && this.access.p2pAllowed(s));
    const totalHttp = connected.reduce((a, s) => a + s.stats.httpBytes, 0);
    const totalP2P = connected.reduce((a, s) => a + s.stats.p2pDownBytes, 0);
    const share = totalHttp + totalP2P > 0 ? totalP2P / (totalHttp + totalP2P) : 0;
    const http429 = connected.reduce((a, s) => a + s.http429, 0);
    const capacity = estimateCapacity({
      uploadMbps: this.speedTest?.uploadMbps,
      limitMbps: this.quality.effectiveCapMbps(),
      bitrateKbps: this.origin.bitrateKbps,
      p2pShare: share,
      alsoStreamingElsewhere: this.d.config.alsoStreamingElsewhere,
      viewers: connected.length,
    });
    const warnings: CodedText[] = [...this.warnings];
    const withoutP2P = connected.length - helping.length;
    const tunnelInFlight = this.tunnelInFlight();
    if (this.mode === 'secure' && this.d.tunnel.name === 'cloudflare-quick') {
      // The quick tunnel counts every open WebSocket (one per viewer) and every HTTP request in
      // progress. Measured peaks, or an estimate: a viewer without P2P keeps about 1.5 video
      // requests in flight at peaks, one with P2P about 0.5.
      const estimate = Math.round(connected.length + withoutP2P * 1.5 + helping.length * 0.5);
      const used = Math.max(tunnelInFlight, estimate);
      if (used >= QUICK_TUNNEL_CONCURRENCY_LIMIT * QUICK_TUNNEL_WARN_SHARE) {
        warnings.push(coded('warn.tunnelLimit', { used: Math.min(used, QUICK_TUNNEL_CONCURRENCY_LIMIT), limit: QUICK_TUNNEL_CONCURRENCY_LIMIT }));
      }
    }
    const keyframes = this.keyframeWarning();
    if (keyframes) warnings.push(keyframes);
    if (this.access.p2pChecking && this.egress.failing) warnings.push(coded('warn.p2pChecking'));
    const attack = this.phase !== 'off' ? this.shield.warning() : undefined;
    if (attack) warnings.unshift(attack);
    const suggestion = this.mode === 'secure' && (http429 > 20 || this.tunnelDrops >= 2) ? coded('warn.tunnelStruggling') : undefined;
    const ipMsg = ipChangeNotice(this.d.direct.ipChanged);
    const allWarnings = ipMsg && this.phase === 'off' ? [...warnings, ipMsg] : warnings;
    return {
      version: this.d.version,
      phase: this.phase,
      mode: this.mode,
      steps: this.steps,
      liveLink: this.liveLink,
      linkGeneration: this.access.linkGeneration,
      tunnelUrl: this.baseUrl ?? undefined,
      tunnelUrlChangedAt: this.tunnelUrlChangedAt,
      rtmpUrl: `rtmp://127.0.0.1:${this.d.config.ports.rtmp}/live`,
      streamKey: this.d.streamKey,
      obsConnected: this.obsConnected || this.origin.available,
      obsBitrateKbps: this.origin.bitrateKbps,
      lastVideoAt: this.origin.lastSegmentAt || undefined,
      autoStopAt: this.autoStopAt,
      viewers: sessions.map((s) => ({
        sessionId: s.id,
        nickname: s.nickname,
        device: s.device,
        joinedAt: s.joinedAt,
        connected: connected.includes(s),
        p2pAllowed: s.p2pAllowed,
        p2pEnabled: s.p2pEnabled,
        peerIds: [...s.peerIds],
        p2pUpBytes: s.stats.p2pUpBytes,
        p2pDownBytes: s.stats.p2pDownBytes,
        httpBytes: s.stats.httpBytes,
        hashFailures: s.hashFailures,
        autoRemovedFromP2P: s.autoRemovedFromP2P,
        ...(s.ownConnection ? { ownConnection: true } : {}),
        delayS: s.delayS,
      })),
      stats: {
        viewersConnected: connected.length,
        viewersHelping: helping.length,
        p2pSharePercent: Math.round(share * 100),
        originUploadMbps: Math.round(this.limiter.currentMbps() * 10) / 10,
        httpInFlight: this.httpStats.inFlight,
        tunnelInFlight,
        rateLimited429: http429,
      },
      warnings: allWarnings.map((w) => w.text),
      warningCodes: allWarnings.map((w) => ({ code: w.code, ...(w.params ? { params: w.params } : {}) })),
      settings: {
        uploadLimitMbps: this.d.config.uploadLimitMbps,
        autoStopMinutes: this.d.config.autoStopMinutes,
        alsoStreamingElsewhere: this.d.config.alsoStreamingElsewhere,
        showViewerCount: this.d.config.showViewerCount,
        allowViewerP2P: this.d.config.allowViewerP2P,
        maxViewers: this.d.config.maxViewers,
        maxSessionsPerDevice: this.d.config.maxSessionsPerDevice,
      },
      speedTest: this.speedTest,
      speedTestRunning: this.speedTestRunning,
      capacity,
      direct: { ...this.d.direct.snapshot(), suggestion: suggestion?.text, suggestionCode: suggestion?.code },
      bannedCount: this.access.bannedCount,
      security: this.shield.snapshot(),
      chatEnabled: this.d.config.chat.enabled,
    };
  }

  /** Warning while the newest segments show OBS keyframes too far apart (logged once per stream). */
  keyframeWarning(): CodedText | undefined {
    const max = this.origin.maxSegmentDurationS;
    if (this.phase !== 'live' || max <= KEYFRAME_WARN_S) return undefined;
    const w = coded('warn.keyframes', { seconds: Math.round(max) });
    if (!this.keyframeWarned) {
      this.keyframeWarned = true;
      this.d.log.warn({ panel: true }, w.text);
      this.activity.add({ level: 'warn', kind: 'system', code: w.code, params: w.params });
    }
    return w;
  }

  get lastError(): string | undefined {
    return this.lastStepError;
  }

  /**
   * Aborted when the app quits (shutdown): the speed test, a start still opening the tunnel,
   * the desktop first-run check and the ffmpeg download give up instead of delaying the exit.
   */
  get quitSignal(): AbortSignal {
    return this.quitting.signal;
  }

  /** Final shutdown when the app exits. */
  async shutdown(): Promise<void> {
    this.quitting.abort();
    await this.stop().catch(() => {});
    this.d.log.debug('live stopped; closing control channel and tracker');
    if (this.speedTimer) clearInterval(this.speedTimer);
    await this.quality.shutdown();
    this.chat.reset();
    this.control.close();
    this.tracker.close();
    this.limiter.close();
  }
}
