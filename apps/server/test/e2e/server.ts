// Test server for Playwright: SwarmCast without tunnel + a synthetic OBS stream.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { pushTestStream } from '../integration/helpers.js';

// Attack-reaction tests must not pop up real desktop notifications on the developer's machine.
process.env.SWARMCAST_NO_NOTIFY ??= '1';

// SWARMCAST_E2E_PORT_OFFSET moves every port (to run next to another copy of the suite).
const OFFSET = Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0);
export const E2E_PORTS = { rtmp: 39935 + OFFSET, public: 38080 + OFFSET, admin: 38081 + OFFSET, mediamtxHls: 38888 + OFFSET };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-'));
// "Export logs" writes here, never to the real Downloads folder (diagnostics.spec.ts).
process.env.SWARMCAST_DOWNLOADS_DIR = path.join(dataDir, 'downloads');
fs.mkdirSync(process.env.SWARMCAST_DOWNLOADS_DIR, { recursive: true });
const app = await createApp({
  dataDir,
  noTunnel: true,
  logToStdout: false,
  configOverrides: {
    ports: E2E_PORTS,
    speedTest: { enabled: false, intervalMinutes: 15 },
    // The setup tutorial would cover the panel in other specs; onboarding.spec.ts turns it back on via the API.
    onboardingDone: true,
    // The quality ladder uses the same ffmpeg that plays OBS here (SWARMCAST_FFMPEG overrides
    // it). Off at start, so the other specs see one quality; quality.spec.ts turns it on.
    ffmpegPath: 'ffmpeg',
    quality: {
      ladder: { mode: 'manual', enabled: false, heights: [480, 360], encoder: 'auto' },
      upload: { mode: 'manual', otherStreamKbps: null, headroomPercent: 15 },
      obsWebsocket: { enabled: false, url: 'ws://127.0.0.1:4455' },
    },
  },
});
await app.live.start();

let ffmpeg: ChildProcess | null = null;
let stopping = false;
// What the fake OBS sends; quality.spec.ts changes it (file + SIGUSR2) to make OBS reconnect
// with a bigger picture, which is when a new rendition plan applies.
const PUSH_FILE = path.join('test-results', 'e2e-push.json');
const pushOptions = (): { size?: string; kbps?: number } => {
  try {
    return JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8')) as { size?: string; kbps?: number };
  } catch {
    return {};
  }
};
const push = (): void => {
  const child = pushTestStream(`rtmp://127.0.0.1:${E2E_PORTS.rtmp}/live/${app.live.snapshot().streamKey}`, pushOptions());
  ffmpeg = child;
  child.on('exit', () => {
    if (!stopping && ffmpeg === child) setTimeout(push, 1000);
  });
};
fs.mkdirSync('test-results', { recursive: true });
fs.rmSync(PUSH_FILE, { force: true });
push();
process.on('SIGUSR2', () => {
  // Reconnect "OBS" with the options in PUSH_FILE.
  ffmpeg?.kill('SIGKILL');
});

// Test-only control port (127.0.0.1, random port, never part of the app): POST /pow-level/<0|1|2>
// sets the level the attack shield would choose by itself, without flooding the server.
// POST /playlist-window/<seconds> sets how many seconds every playlist keeps (p2p.spec.ts
// emulates v0.2.0 servers, whose ladder audio playlist held only 20 s).
const control = http.createServer((req, res) => {
  const w = /^\/playlist-window\/(\d+)$/.exec(req.url ?? '');
  if (req.method === 'POST' && w) {
    app.live.origin.windowSeconds = Number(w[1]);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ windowSeconds: app.live.origin.windowSeconds }));
  }
  const m = /^\/pow-level\/([012])$/.exec(req.url ?? '');
  if (req.method !== 'POST' || !m) return void res.writeHead(404).end();
  (app.live.shield as unknown as { setAutoPow(level: 0 | 1 | 2): void }).setAutoPow(Number(m[1]) as 0 | 1 | 2);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ browserCheck: app.live.shield.powLevel() }));
});
await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
const testControlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;

fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync(path.join('test-results', 'e2e-env.json'), JSON.stringify({ adminLoginUrl: app.adminLoginUrl, adminUrl: app.adminUrl, dataDir, downloadsDir: process.env.SWARMCAST_DOWNLOADS_DIR, pid: process.pid, testControlUrl }));
console.log('e2e server ready');

const shutdown = async (): Promise<void> => {
  stopping = true;
  control.close();
  ffmpeg?.kill('SIGKILL');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
