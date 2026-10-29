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
