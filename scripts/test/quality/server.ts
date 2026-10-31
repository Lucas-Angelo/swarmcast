// Quality-experiment server: SwarmCast without tunnel + a synthetic 1080p30 ~6 Mbps OBS
// stream, on its own fixed ports (scripts/test/lib/ports.mjs FIXED_PORTS.quality: 16080-16082,
// 16888, 16935), clear of the e2e suite's.
//   node --import tsx scripts/test/quality/server.ts            (ladder: 1080p copy + 720p + 480p)
//   LADDER=off node --import tsx scripts/test/quality/server.ts  (source only, like before)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createApp } from '../../../apps/server/src/app.js';
import { defaultConfig } from '../../../apps/server/src/core/config.js';
import { pushTestStream } from '../../../apps/server/test/integration/helpers.js';
import { assertFixedPorts, FIXED_PORTS } from '../lib/ports.mjs';

const { control: controlPort, ...appPorts } = FIXED_PORTS.quality;
export const QUALITY_PORTS = appPorts;
/** Test-only control port: GET /env, what bench.ts and menu-check.ts need to sign in to the panel. */
export const QUALITY_CONTROL_PORT = controlPort;
assertFixedPorts('quality', FIXED_PORTS.quality);
const ladderOn = process.env.LADDER !== 'off';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-quality-'));
const app = await createApp({
  dataDir,
  noTunnel: true,
  logToStdout: process.env.LOG === '1',
  configOverrides: {
    ports: QUALITY_PORTS,
    speedTest: { enabled: false, intervalMinutes: 15 },
    // The upload cap must not be the bottleneck in these experiments (the browser emulates the network).
    uploadLimitMbps: 1000,
    // bench.ts / menu-check.ts join with a plain POST (no browser check, which is on by default).
    security: { ...defaultConfig().security, requireBrowserCheck: false },
    ffmpegPath: process.env.FFMPEG ?? 'ffmpeg',
    quality: {
      // Same renditions as auto mode with a GPU encoder (override: LADDER_HEIGHTS=720,480).
      ladder: { mode: 'manual', heights: ladderOn ? ((process.env.LADDER_HEIGHTS ?? '720,480,360').split(',').map(Number) as Array<720 | 480 | 360>) : [], enabled: ladderOn, encoder: 'auto' },
      upload: { mode: 'manual', otherStreamKbps: null, headroomPercent: 15 },
      obsWebsocket: { enabled: false, url: 'ws://127.0.0.1:4455' },
    },
  },
});
await app.live.quality.probe();
await app.live.start();

let ffmpeg: ChildProcess | null = null;
let stopping = false;
const push = (): void => {
  ffmpeg = pushTestStream(`rtmp://127.0.0.1:${QUALITY_PORTS.rtmp}/live/${app.live.snapshot().streamKey}`, { size: '1920x1080', kbps: 6000, cbr: true });
  ffmpeg.on('exit', () => {
    if (!stopping) setTimeout(push, 1000);
  });
};
push();

const readyAt = Date.now();
const control = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/env') {
    const env = { adminUrl: app.adminUrl, adminLoginPath: new URL(app.adminLoginUrl).pathname, base: `http://127.0.0.1:${QUALITY_PORTS.public}`, readyAt };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(env));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve, reject) => {
  control.once('error', reject);
  control.listen(QUALITY_CONTROL_PORT, '127.0.0.1', resolve);
});
console.log(`quality server ready (ladder ${ladderOn ? 'on' : 'off'})`);

const shutdown = async (): Promise<void> => {
  stopping = true;
  control.close();
  ffmpeg?.kill('SIGKILL');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
