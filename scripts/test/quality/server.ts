// Quality-experiment server: SwarmCast without tunnel + a synthetic 1080p30 ~6 Mbps OBS
// stream, on ports that do not collide with the e2e suite (45080/45081/45888/45935).
//   node --import tsx scripts/test/quality/server.ts            (ladder: 1080p copy + 720p + 480p)
//   LADDER=off node --import tsx scripts/test/quality/server.ts  (source only, like before)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createApp } from '../../../apps/server/src/app.js';
import { pushTestStream } from '../../../apps/server/test/integration/helpers.js';

export const QUALITY_PORTS = { rtmp: 45935, public: 45080, admin: 45081, mediamtxHls: 45888 };
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

const out = path.join('test-results', 'quality');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'env.json'), JSON.stringify({ adminLoginUrl: app.adminLoginUrl, adminUrl: app.adminUrl, base: `http://127.0.0.1:${QUALITY_PORTS.public}`, readyAt: Date.now() }));
console.log(`quality server ready (ladder ${ladderOn ? 'on' : 'off'})`);

const shutdown = async (): Promise<void> => {
  stopping = true;
  ffmpeg?.kill('SIGKILL');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
