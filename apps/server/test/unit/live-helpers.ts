import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { onTestFinished, vi } from 'vitest';
import { ADMIN_COOKIE } from '@swarmcast/shared';
import { createAdminServer, type AdminOptions } from '../../src/admin/server.js';
import { defaultConfig } from '../../src/core/config.js';
import { LiveController, type LiveDeps } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { MediaMtx } from '../../src/media/mediamtx.js';
import type { ManifestSigner } from '../../src/hls/manifest.js';
import { NoTunnel } from '../../src/tunnel/provider.js';
import { silentLog } from './helpers.js';

/**
 * Direct mode of a live that never turns it on: nobody seen through it. The real one talks to the
 * router (UPnP, NAT-PMP) and to public-address services: systems outside this machine, not a
 * test's to call. The one Direct mode stand-in of the unit and integration tests.
 */
export function inactiveDirect(): DirectMode {
  return { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
}

/** LiveController with a fake MediaMTX and no tunnel, for logic tests (`over` replaces deps). */
export function makeController(direct: DirectMode = inactiveDirect(), over: Partial<LiveDeps> = {}): { live: LiveController } {
  const mediamtx = Object.assign(new EventEmitter(), {
    onPublish: () => {},
    pid: undefined,
    start: async () => {},
    stop: async () => {},
  }) as unknown as MediaMtx;
  const config = defaultConfig();
  // Port 0: the public server gets a port from the OS when the live starts (`live.publicPort`),
  // and the fake MediaMTX binds nothing. No program can listen on port 0, so "Stop everything"
  // never mistakes another program's port (or another test file's) for a leftover of ours.
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  const live = new LiveController({
    config,
    saveConfig: () => {},
    streamKey: 'sc_testtesttesttest',
    signer: { publicKeyRaw: 'x' } as unknown as ManifestSigner,
    mediamtx,
    tunnel: new NoTunnel(),
    direct,
    viewerDir: '/nonexistent',
    log: silentLog,
    version: 'test',
    secureCookies: false,
    ...over,
  });
  return { live };
}

/**
 * makeController, then `live.start()`: the public server really listens (127.0.0.1, a port the
 * OS picks, `live.publicPort`). Stopped when the test finishes; a stop that throws fails the test.
 */
export async function startController(direct: DirectMode = inactiveDirect(), over: Partial<LiveDeps> = {}): Promise<{ live: LiveController }> {
  const { live } = makeController(direct, over);
  onTestFinished(async () => void (await live.stop()));
  await live.start();
  return { live };
}

/**
 * The panel's port in `app.inject()` tests. The panel never listens there: the number only names
 * the Host and Origin the panel accepts (`127.0.0.1:<port>`), so every file can use the same one.
 */
export const PANEL_PORT = 39_400;
export const PANEL_TOKEN = 'panel-test-token_123';

/** What a panel tab sends: `get` for reads, `json` (plus Origin and a JSON body type) for writes. */
export interface PanelHeaders {
  host: string;
  origin: string;
  cookie: string;
  get: Record<string, string>;
  json: Record<string, string>;
}

export function panelHeaders(token = PANEL_TOKEN, port = PANEL_PORT): PanelHeaders {
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const cookie = `${ADMIN_COOKIE}=${token}`;
  return { host, origin, cookie, get: { host, cookie }, json: { host, origin, cookie, 'content-type': 'application/json' } };
}

/**
 * The panel (admin) server of `live`, for `app.inject()`: no socket, closed when the test finishes.
 * Defaults: PANEL_PORT, PANEL_TOKEN, no panel build ('/nonexistent'), silent log, no-op actions.
 */
export async function panelServer(o: Partial<AdminOptions> & { live: LiveController }): Promise<{ app: FastifyInstance; headers: PanelHeaders }> {
  const options: AdminOptions = {
    port: PANEL_PORT,
    adminDir: '/nonexistent',
    log: silentLog,
    token: PANEL_TOKEN,
    onQuit: vi.fn(),
    checkDirect: vi.fn(),
    cleanupStale: vi.fn(),
    ...o,
  };
  const app = await createAdminServer(options);
  onTestFinished(() => app.close());
  return { app, headers: panelHeaders(options.token, options.port) };
}
