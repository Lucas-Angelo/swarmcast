// Manual debugging aid: start SwarmCast (no tunnel) with the ladder, push a 1080p test
// stream and print what ffmpeg writes. Usage: node --import tsx scripts/test/quality/debug-ladder.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../apps/server/src/app.js';
import { pushTestStream } from '../../../apps/server/test/integration/helpers.js';

const PORTS = { rtmp: 46935, public: 46080, admin: 46081, mediamtxHls: 46888 };
const app = await createApp({
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dbg-')),
  noTunnel: true,
  noReaper: true,
  logToStdout: process.env.LOG === '1',
  configOverrides: {
    ports: PORTS,
    speedTest: { enabled: false, intervalMinutes: 15 },
    ffmpegPath: 'ffmpeg',
    quality: {
      ladder: { mode: 'manual', enabled: true, heights: [720, 480], encoder: 'auto' },
      upload: { mode: 'manual', otherStreamKbps: null, headroomPercent: 15 },
      obsWebsocket: { enabled: false, url: 'ws://127.0.0.1:4455' },
    },
  },
});
await app.live.quality.probe();
console.log(JSON.stringify(app.live.quality.state().encoders));
await app.live.start();
const ff = pushTestStream(`rtmp://127.0.0.1:${PORTS.rtmp}/live/${app.live.snapshot().streamKey}`, { size: '1920x1080', kbps: 6000, cbr: true });
await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 15000)));
const q = app.live.quality.state();
console.log(JSON.stringify({ transcoder: q.transcoder, plan: q.plan, source: q.source, variants: q.variants }, null, 1));
const dir = app.live.quality.transcoder.outDir;
if (dir) {
  console.log(fs.readdirSync(dir).join(' '));
  for (const f of ['index.m3u8', 'v1080.m3u8', 'v720.m3u8']) {
    if (fs.existsSync(path.join(dir, f))) console.log(`--- ${f}\n${fs.readFileSync(path.join(dir, f), 'utf8')}`);
  }
}
console.log('--- served index\n' + app.live.origin.getPlaylist('index.m3u8'));
console.log('--- served v1080\n' + app.live.origin.getPlaylist('v1080.m3u8'));
ff.kill('SIGKILL');
await app.close();
process.exit(0);
