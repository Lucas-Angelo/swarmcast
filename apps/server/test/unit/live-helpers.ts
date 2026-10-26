import { EventEmitter } from 'node:events';
import { defaultConfig } from '../../src/core/config.js';
import { LiveController, type LiveDeps } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import type { MediaMtx } from '../../src/media/mediamtx.js';
import type { ManifestSigner } from '../../src/hls/manifest.js';
import { NoTunnel } from '../../src/tunnel/provider.js';
import { silentLog } from './helpers.js';

/** LiveController with a fake MediaMTX and no tunnel, for logic tests (`over` replaces deps). */
export function makeController(direct: DirectMode, over: Partial<LiveDeps> = {}): { live: LiveController } {
  const mediamtx = Object.assign(new EventEmitter(), {
    onPublish: () => {},
    pid: undefined,
    start: async () => {},
    stop: async () => {},
  }) as unknown as MediaMtx;
  const config = defaultConfig();
  // Ports nothing listens on, so the stop verification passes.
  config.ports = { rtmp: 39351, public: 39352, admin: 39353, mediamtxHls: 39354 };
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
