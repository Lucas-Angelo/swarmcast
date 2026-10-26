import crypto from 'node:crypto';
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
import { ExternalTunnel, NoTunnel, type TunnelProvider } from './tunnel/provider.js';
import { QuickTunnel } from './tunnel/quick.js';
import { PublicBlocklists, blocklistSources } from './security/blocklists.js';

export interface AppOptions {
  dataDir?: string;
  noTunnel?: boolean;
  logToStdout?: boolean;
  /** Override config values (tests). */
  configOverrides?: Partial<AppConfig>;
  /** Disable the reaper watchdog (tests that spawn many apps). */
  noReaper?: boolean;
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
  direct: DirectMode;
  reaper: Reaper | null;
  close(): Promise<void>;
}

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

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const paths = resolvePaths(opts.dataDir);
  // In-memory activity log for the panel; warnings/errors from the logger feed it too.
  const activity = new ActivityLog();
  const log = createLogger({ logsDir: paths.logsDir, stdout: opts.logToStdout ?? true, sink: activity.logStream() });
  const config = { ...loadConfig(paths.configFile), ...opts.configOverrides };
  if (opts.noTunnel) config.tunnel = { provider: 'none' };
  const secrets = loadOrCreateSecrets(paths.secretsFile);
  const signer = await ManifestSigner.create(secrets.manifestPrivateKeyPem);
  const version = appVersion();

  let reaper: Reaper | null = null;
  if (!opts.noReaper) {
    const rc = reaperCommand();
    reaper = new Reaper(rc.command, rc.args, log);
    reaper.start();
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
    signer,
    mediamtx,
    tunnel,
    direct,
    viewerDir: paths.viewerDir,
    log,
    version,
    secureCookies: config.tunnel.provider !== 'none',
    quality: { binDir: paths.binDir, dataDir: paths.dataDir, runDir: paths.runDir, reaper },
  });
  // Probe the video encoders shortly after launch (a few 1-second test encodes), not during a live.
  setTimeout(() => {
    if (live.phase === 'off') void live.quality.probe();
  }, 3000).unref();

  // The panel and the local public server can live on any free port (the tunnel and the
  // browser follow them); only RTMP must stay fixed because OBS is configured with it.
  const adminPort = await firstFreePort(config.ports.admin);
  if (adminPort === null) {
    throw new Error(`Ports ${config.ports.admin}-${config.ports.admin + 19} are busy. Is SwarmCast already running? Close it (tray icon → Quit) and try again.`);
  }
  if (adminPort !== config.ports.admin) log.warn({ wanted: config.ports.admin, using: adminPort }, 'admin port busy, using another one');
  config.ports = { ...config.ports, admin: adminPort };
  const token = crypto.randomBytes(24).toString('base64url');
  let closing: Promise<void> | null = null;
  const app: App = {
    paths,
    config,
    log,
    live,
    direct,
    reaper,
    admin: undefined as unknown as FastifyInstance,
    adminUrl: `http://127.0.0.1:${config.ports.admin}`,
    adminLoginUrl: `http://127.0.0.1:${config.ports.admin}/auth/${token}`,
    close: () => {
      closing ??= (async () => {
        log.info('shutting down: stopping the live');
        await live.shutdown();
        blocklists.stop();
        log.info('shutting down: closing the panel server');
        // A browser or HTTP client can hold a keep-alive connection open; never let it block quitting.
        await Promise.race([app.admin.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);
        reaper?.stop();
        log.info('shutdown complete');
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
  });
  await app.admin.listen({ host: '127.0.0.1', port: config.ports.admin });
  void direct.init().catch(() => {});
  log.info({ version, dataDir: paths.dataDir }, 'SwarmCast ready');
  return app;
}
