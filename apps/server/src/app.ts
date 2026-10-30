import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createAdminServer } from './admin/server.js';
import { loadConfig, persistableConfig, saveConfig, type AppConfig } from './core/config.js';
import { LiveController } from './core/live.js';
import { ActivityLog } from './core/activity.js';
import { createLogger, type Logger } from './core/logger.js';
import { exe, resolvePaths, type AppPaths } from './core/paths.js';
import { firstFreePort } from './core/ports.js';
import { loadOrCreateSecrets } from './core/secrets.js';
import { FileStateStore } from './core/state.js';
import { appVersion } from './core/version.js';
import { FallbackIssuer, LetsEncryptIpIssuer, SelfSignedIssuer } from './direct/certs.js';
import { routerDeps } from './direct/cleanup.js';
import { DirectMode } from './direct/direct.js';
import { defaultGateway, localAddressTowards } from './direct/mapper.js';
import { lookupPublicIps } from './direct/publicip.js';
import { ManifestSigner } from './hls/manifest.js';
import { MediaMtx } from './media/mediamtx.js';
import { Reaper } from './process/children.js';
import type { LoadGuard, LoadGuardOptions } from './quality/load-guard.js';
import { ExternalTunnel, NoTunnel, type TunnelProvider } from './tunnel/provider.js';
import { QuickTunnel } from './tunnel/quick.js';
import { PublicBlocklists, blocklistSources } from './security/blocklists.js';
import type { DesktopBridge } from './desktop/bridge.js';
import { desktopPreflight } from './desktop/preflight.js';
import { Diagnostics } from './diagnostics/diagnostics.js';
import type { RotatingLogFile } from './core/log-files.js';
import { StartupError } from './desktop/protocol.js';

export interface AppOptions {
  dataDir?: string;
  noTunnel?: boolean;
  logToStdout?: boolean;
  /** Override config values (tests). */
  configOverrides?: Partial<AppConfig>;
  /** Disable the reaper watchdog (tests that spawn many apps). */
  noReaper?: boolean;
  /**
   * Desktop mode (`--desktop`): the panel gets the desktop API, and startup fails (StartupError)
   * when another SwarmCast is running or the RTMP port is busy.
   */
  desktop?: DesktopBridge;
  /**
   * The quality ladder's load guard (tests): a guard instance, or options for the default one.
   * Tests about the ladder itself pass thresholds that never drop a rendition.
   */
  loadGuard?: LoadGuard | Partial<LoadGuardOptions>;
}

export interface App {
  paths: AppPaths;
  config: AppConfig;
  log: Logger;
  live: LiveController;
  admin: FastifyInstance;
  adminUrl: string;
  /** URL that logs the browser into the admin panel. */
  adminLoginUrl: string;
  /**
   * The port the panel really listens on. `config.ports.admin: 0` (tests) lets the OS pick a
   * free one; `config.ports` always holds the real ports once they are bound (the public port
   * from the moment the live starts: `live.publicPort`).
   */
  adminPort: number;
  direct: DirectMode;
  /** The MediaMTX process of the live (its pid while it runs). */
  mediamtx: MediaMtx;
  reaper: Reaper | null;
  /** Log retention and "Export logs". */
  diagnostics: Diagnostics;
  /** Test hook: forget every rate-limit counter of the panel and of the public server. */
  resetRateLimits(): void;
  close(): Promise<void>;
}

/** The encoder probe runs this long after start (a few 1-second test encodes), unless the app closed first. */
export const ENCODER_PROBE_DELAY_MS = 3000;

export function reaperCommand(): { command: string; args: string[] } {
  // Packaged (pkg): re-running our own executable requires the embedded entry script as the
  // first argument (pkg sets PKG_EXECPATH for children, which makes them behave like node).
  const isPkg = !!(process as unknown as { pkg?: unknown }).pkg;
  if (isPkg) return { command: process.execPath, args: [process.argv[1]!, '--reaper', String(process.pid)] };
  // Bundled (node dist/swarmcast.cjs) or source (tsx): always point at the real entry,
  // not process.argv[1], which is a test runner or another script when embedded (e2e, CI).
  const entry =
    typeof __filename !== 'undefined' && __filename.endsWith('.cjs')
      ? __filename
      : path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts');
  return { command: process.execPath, args: [...process.execArgv, entry, '--reaper', String(process.pid)] };
}

/** What a start has set up so far, undone newest first when the start fails. */
class StartupSteps {
  private readonly steps: Array<() => unknown> = [];
  /** Where a step that cannot be undone is reported (once the logger exists). */
  log: Logger | null = null;

  add(step: () => unknown): void {
    this.steps.push(step);
  }

  /** Every step runs, also after one that fails (that one is logged): the start's own error is what the caller gets. */
  async undo(): Promise<void> {
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step();
      } catch (err) {
        this.log?.warn({ err: (err as Error).message }, 'could not undo a step of the failed start');
      }
    }
  }
}

/**
 * Starts SwarmCast (everything but the live itself). When the start fails part-way (ports busy,
 * the panel cannot listen), everything it already started is stopped before the error comes out:
 * the reaper, the panel, the timers, the live's channels and the log file.
 */
export async function createApp(opts: AppOptions = {}): Promise<App> {
  const started = new StartupSteps();
  try {
    return await assembleApp(opts, started);
  } catch (err) {
    await started.undo();
    throw err;
  }
}

async function assembleApp(opts: AppOptions, started: StartupSteps): Promise<App> {
  const paths = resolvePaths(opts.dataDir);
  // In-memory activity log for the panel; warnings/errors from the logger feed it too.
  const activity = new ActivityLog();
  let logFile: RotatingLogFile | undefined;
  const log = createLogger({ logsDir: paths.logsDir, stdout: opts.logToStdout ?? true, sink: activity.logStream(), onFile: (f) => (logFile = f) });
  started.add(() => logFile?.end());
  started.log = log;
  const config = { ...loadConfig(paths.configFile), ...opts.configOverrides };
  if (opts.noTunnel) config.tunnel = { provider: 'none' };
  if (opts.desktop) await desktopPreflight(config.ports);
  const secrets = loadOrCreateSecrets(paths.secretsFile);
  const signer = await ManifestSigner.create(secrets.manifestPrivateKeyPem);
  const version = appVersion();

  let reaper: Reaper | null = null;
  if (!opts.noReaper) {
    const rc = reaperCommand();
    reaper = new Reaper(rc.command, rc.args, log);
    reaper.start();
    started.add(() => reaper?.stop());
  }

  const mediamtx = new MediaMtx(
    {
      binary: path.join(paths.binDir, exe('mediamtx')),
      runDir: paths.runDir,
      rtmpPort: config.ports.rtmp,
      hlsPort: config.ports.mediamtxHls,
      streamKey: secrets.streamKey,
    },
    reaper,
    log,
  );

  let tunnel: TunnelProvider;
  switch (config.tunnel.provider) {
    case 'none':
      tunnel = new NoTunnel();
      break;
    case 'external':
      if (!config.tunnel.externalUrl) throw new Error('tunnel.externalUrl is required for the "external" provider');
      tunnel = new ExternalTunnel(config.tunnel.externalUrl);
      break;
    default:
      tunnel = new QuickTunnel(path.join(paths.binDir, exe('cloudflared')), paths.runDir, reaper, log);
  }

  // Free public IP blocklists: cached in the data folder, refreshed every 24 h while running.
  const blocklists = new PublicBlocklists({
    dir: path.join(paths.dataDir, 'blocklists'),
    log,
    sources: () => blocklistSources(config.security.blocklists, config.security.extraBlocklistUrls),
  });
  if (config.security.blockKnownBadIps) blocklists.start();
  started.add(() => blocklists.stop());

  const stateStore = new FileStateStore(paths.stateFile);
  // eslint-disable-next-line prefer-const
  let live: LiveController;
  const direct = new DirectMode({
    log,
    state: stateStore,
    ...routerDeps(),
    publicIps: lookupPublicIps,
    localAddress: async () => localAddressTowards((await defaultGateway()) ?? '1.1.1.1'),
    localAddresses: () =>
      Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i)
        .map((i) => i.address),
    issuer: new FallbackIssuer(new LetsEncryptIpIssuer(log), new SelfSignedIssuer(), log),
    startServer: (port, host, sni, defaultCert) => live.startDirectServer(port, host, sni, defaultCert),
  });

  live = new LiveController({
    activity,
    blocklists,
    config,
    // Never persist ports chosen at runtime as a fallback.
    saveConfig: (c) => saveConfig(paths.configFile, persistableConfig(c, loadConfig(paths.configFile), { noTunnel: opts.noTunnel })),
    streamKey: secrets.streamKey,
    browserCheckKey: secrets.browserCheckKey,
    signer,
    mediamtx,
    tunnel,
    direct,
    viewerDir: paths.viewerDir,
    log,
    version,
    secureCookies: config.tunnel.provider !== 'none',
    quality: { binDir: paths.binDir, dataDir: paths.dataDir, runDir: paths.runDir, reaper, ...(opts.loadGuard ? { loadGuard: opts.loadGuard } : {}) },
    brandingDir: path.join(paths.dataDir, 'branding'),
  });
  started.add(() => live.shutdown());
  // Probe the video encoders shortly after launch (a few 1-second test encodes), not during a live.
  const encoderProbe = setTimeout(() => {
    if (live.phase === 'off') void live.quality.probe();
  }, ENCODER_PROBE_DELAY_MS);
  encoderProbe.unref();
  started.add(() => clearTimeout(encoderProbe));

  // The panel and the local public server can live on any free port (the tunnel and the
  // browser follow them); only RTMP must stay fixed because OBS is configured with it.
  // Port 0 (tests): the OS picks a free port at listen time, never probe-then-bind.
  const adminPort = config.ports.admin === 0 ? 0 : await firstFreePort(config.ports.admin);
  if (adminPort === null) {
    throw new StartupError('ports-busy', `Ports ${config.ports.admin}-${config.ports.admin + 19} are busy. Is SwarmCast already running? Close it (tray icon → Quit) and try again.`);
  }
  if (adminPort !== config.ports.admin) log.warn({ wanted: config.ports.admin, using: adminPort }, 'admin port busy, using another one');
  config.ports = { ...config.ports, admin: adminPort };
  const token = crypto.randomBytes(24).toString('base64url');
  // Log retention runs now and once a day; the panel's "Export logs" writes a ZIP to Downloads.
  const diagnostics = new Diagnostics({
    paths,
    config,
    persist: () => saveConfig(paths.configFile, persistableConfig(config, loadConfig(paths.configFile), { noTunnel: opts.noTunnel })),
    live,
    log,
    version,
    desktopVersion: opts.desktop ? opts.desktop.snapshot().version : undefined,
    panelToken: token,
    currentLogFile: () => logFile?.file,
  });
  diagnostics.start();
  started.add(() => diagnostics.stop());
  // Desktop app: "Get beta versions" lives in config.json (`updates.channel`).
  opts.desktop?.useUpdateChannel({
    get: () => config.updates.channel,
    save: (channel) => {
      config.updates = { ...config.updates, channel };
      saveConfig(paths.configFile, persistableConfig(config, loadConfig(paths.configFile), { noTunnel: opts.noTunnel }));
    },
  });
  let closing: Promise<void> | null = null;
  const app: App = {
    paths,
    config,
    log,
    live,
    direct,
    mediamtx,
    reaper,
    diagnostics,
    admin: undefined as unknown as FastifyInstance,
    adminUrl: '',
    adminLoginUrl: '',
    adminPort: 0,
    resetRateLimits: () => {
      app.admin.resetRateLimits();
      live.resetRateLimits();
    },
    close: () => {
      closing ??= (async () => {
        clearTimeout(encoderProbe);
        log.info('shutting down: stopping the live');
        await live.shutdown();
        blocklists.stop();
        diagnostics.stop();
        log.info('shutting down: closing the panel server');
        // A browser or HTTP client can hold a keep-alive connection open; never let it block quitting.
        let cap: NodeJS.Timeout | undefined;
        await Promise.race([app.admin.close().catch(() => {}), new Promise((r) => (cap = setTimeout(r, 3000)).unref())]);
        clearTimeout(cap);
        reaper?.stop();
        log.info('shutdown complete');
        // Last: the server log file is closed (lines from late background work are dropped).
        await logFile?.end();
      })();
      return closing;
    },
  };
  app.admin = await createAdminServer({
    port: config.ports.admin,
    adminDir: paths.adminDir,
    live,
    log,
    token,
    onQuit: () => process.emit('SIGTERM'),
    checkDirect: () => direct.check(),
    cleanupStale: () => direct.cleanupStale(),
    systemCheckFile: path.join(paths.dataDir, 'system-check.json'),
    desktop: opts.desktop,
    diagnostics,
  });
  started.add(() => app.admin.close());
  await app.admin.listen({ host: '127.0.0.1', port: config.ports.admin });
  app.adminPort = (app.admin.server.address() as AddressInfo).port;
  config.ports = { ...config.ports, admin: app.adminPort };
  app.adminUrl = `http://127.0.0.1:${app.adminPort}`;
  app.adminLoginUrl = `${app.adminUrl}/auth/${token}`;
  void direct.init().catch(() => {});
  log.info({ version, dataDir: paths.dataDir }, 'SwarmCast ready');
  return app;
}
