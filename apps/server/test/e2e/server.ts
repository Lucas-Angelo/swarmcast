// Test server for Playwright: SwarmCast without tunnel + a synthetic OBS stream.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { SEGMENT_DURATION_S } from '@swarmcast/shared';
import { createApp } from '../../src/app.js';
import { ensureClip } from '../../../../scripts/test/lib/ffmpeg.mjs';
import { startFeed } from '../integration/helpers.js';

// Attack-reaction tests must not pop up real desktop notifications on the developer's machine.
process.env.SWARMCAST_NO_NOTIFY ??= '1';
// The watch page's test-only URL flags (?delaySpeed=, ?delayRate=: adaptive-delay.spec.ts) are
// ignored unless the server says so in /api/config; a real SwarmCast never does.
process.env.SWARMCAST_TEST_HOOKS ??= '1';

// Everything the app logs (pino JSON lines on stdout) goes to test-results/e2e-server.log, which
// CI uploads with the Playwright report. stderr goes there too and still reaches Playwright's
// output. Synchronous writes, so the last lines before a crash are kept. Playwright empties
// test-results/ before it starts this server.
fs.mkdirSync('test-results', { recursive: true });
const serverLog = fs.openSync(path.join('test-results', 'e2e-server.log'), 'w');
const toServerLog = (chunk: unknown): void => {
  try {
    if (typeof chunk === 'string') fs.writeSync(serverLog, chunk);
    else fs.writeSync(serverLog, chunk as Uint8Array);
  } catch {
    /* the log is evidence only */
  }
};
const lastCallback = (args: unknown[]): ((err?: Error | null) => void) | undefined => args.findLast((a) => typeof a === 'function') as ((err?: Error | null) => void) | undefined;
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  toServerLog(chunk);
  lastCallback(rest)?.();
  return true;
}) as typeof process.stdout.write;
const stderrWrite = process.stderr.write.bind(process.stderr) as (...a: unknown[]) => boolean;
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  toServerLog(chunk);
  return stderrWrite(chunk, ...rest);
}) as typeof process.stderr.write;

// SWARMCAST_E2E_PORT_OFFSET moves every port (to run next to another copy of the suite).
const OFFSET = Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 0);
export const E2E_PORTS = { rtmp: 39935 + OFFSET, public: 38080 + OFFSET, admin: 38081 + OFFSET, mediamtxHls: 38888 + OFFSET };
/** The test control port below (fixtures.ts computes it the same way: no URL read from a file). */
const CONTROL_PORT = 38082 + OFFSET;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-'));
// "Export logs" writes here, never to the real Downloads folder (diagnostics.spec.ts).
process.env.SWARMCAST_DOWNLOADS_DIR = path.join(dataDir, 'downloads');
fs.mkdirSync(process.env.SWARMCAST_DOWNLOADS_DIR, { recursive: true });
const app = await createApp({
  dataDir,
  noTunnel: true,
  // The quality ladder's load guard drops a rendition when the whole machine's CPU is saturated,
  // to protect OBS. Here the CPU goes to the test's own browsers, not to an OBS: on macos-latest
  // (3 vCPU) it dropped 480p 12 s after the ladder started, and barely-delivers then waited in
  // vain for its two qualities (PR #21, run 40917266795). The guard keeps its other trigger
  // (the ladder falling behind real time); unit and integration tests cover the CPU one.
  loadGuard: { cpuSaturatedPercent: 101 },
  // stdout is test-results/e2e-server.log (above).
  logToStdout: true,
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
// What the fake OBS sends; quality.spec.ts changes it (POST /obs) to make OBS reconnect with a
// bigger picture, which is when a new rendition plan applies. Kept in a file so a restarted
// fake OBS (it restarts by itself, like OBS's own reconnect) uses the same options.
const PUSH_FILE = path.join('test-results', 'e2e-push.json');
type PushOptions = { size?: string; kbps?: number };
/** The 720p feed the ladder scenarios ask for (quality.spec, barely-delivers). */
export const HD_FEED = { size: '1280x720', kbps: 2500 } as const;
/** How long the fake OBS waits before it publishes again after its ffmpeg exited, like OBS's reconnect delay. */
const OBS_RECONNECT_MS = 1000;
const pushOptions = (): PushOptions => {
  try {
    return JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8')) as PushOptions;
  } catch {
    return {};
  }
};
// The fake OBS sends a clip encoded once (scripts/test/lib/ffmpeg.mjs) in a loop with -c copy:
// next to no CPU, so the runner's cores go to the browsers and the quality ladder. Both clips
// are encoded before the first test.
await Promise.all([ensureClip({}), ensureClip(HD_FEED)]);
const push = (): void => {
  const { child } = startFeed(`rtmp://127.0.0.1:${E2E_PORTS.rtmp}/live/${app.live.snapshot().streamKey}`, pushOptions());
  ffmpeg = child;
  child.on('exit', () => {
    if (!stopping && ffmpeg === child) setTimeout(push, OBS_RECONNECT_MS);
  });
};
fs.mkdirSync('test-results', { recursive: true });
fs.rmSync(PUSH_FILE, { force: true });
push();
/** Reconnect "OBS" (it restarts with the options in PUSH_FILE). */
const reconnectObs = (options: PushOptions | null): void => {
  if (options) fs.writeFileSync(PUSH_FILE, JSON.stringify(options));
  else fs.rmSync(PUSH_FILE, { force: true });
  ffmpeg?.kill('SIGKILL');
};
// scripts/docs/screenshots.mjs writes PUSH_FILE itself, then sends SIGUSR2.
process.on('SIGUSR2', () => ffmpeg?.kill('SIGKILL'));

// ---- the state every test starts from (POST /reset) ----
const initial = {
  settings: structuredClone(app.live.snapshot().settings),
  security: structuredClone(app.live.securitySettings()),
  quality: structuredClone(app.config.quality),
  diagnostics: structuredClone(app.diagnostics.settings()),
  windowSeconds: app.live.origin.windowSeconds,
  chat: structuredClone(app.live.chatSettings()),
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const shield = app.live.shield as unknown as { setAutoPow(level: 0 | 1 | 2): void; detector: { state: string } };
/** The test that ran before the current one (an unhealthy stream names it). */
let previousTest = '(none: first test on this server)';
let currentTest = previousTest;

/**
 * Back to the state the server started in. Only what differs is reset, so after a test that
 * changed nothing this costs a few milliseconds. The fake OBS reconnects only when it has to
 * (ladder on, other push options) or with `hard` (which also starts the live again if it
 * stopped). Returns what was reset.
 */
async function reset(o: { hard?: boolean; test?: string }): Promise<{ previous: string; did: string[] }> {
  if (o.test !== undefined && o.test !== currentTest) {
    previousTest = currentTest;
    currentTest = o.test;
  }
  const L = app.live;
  const did: string[] = [];
  if (L.phase === 'off') {
    await L.start();
    did.push('live started');
  }
  if (L.access.sessions.size > 0) {
    L.disconnectAll();
    did.push('viewers disconnected');
  }
  if (L.access.bannedCount > 0) {
    L.clearBans();
    did.push('bans cleared');
  }
  app.resetRateLimits();
  shield.setAutoPow(0);
  if (shield.detector.state !== 'normal') {
    L.clearAttackAlert();
    did.push('attack alert ended');
  }
  // The panel's warnings last for the live: a test that checks one sees its own, not an earlier test's.
  if (L.warnings.length > 0) {
    L.warnings = [];
    did.push('panel warnings');
  }
  if (!same(L.securitySettings(), initial.security)) {
    L.updateSecurity(structuredClone(initial.security));
    did.push('security settings');
  }
  if (!same(L.snapshot().settings, initial.settings)) {
    L.updateSettings(structuredClone(initial.settings));
    did.push('settings');
  }
  if (!L.onboardingDone) {
    L.setOnboardingDone(true);
    did.push('onboarding');
  }
  if (!same(app.diagnostics.settings(), initial.diagnostics)) {
    app.diagnostics.updateSettings(structuredClone(initial.diagnostics));
    did.push('diagnostics settings');
  }
  if (L.origin.windowSeconds !== initial.windowSeconds) {
    L.origin.windowSeconds = initial.windowSeconds;
    did.push('playlist window');
  }
  // The chat: its settings, and the flood protection a chat test may have switched on.
  if (!same(L.chatSettings(), initial.chat)) {
    L.updateChatSettings(structuredClone(initial.chat));
    did.push('chat settings');
  }
  if (L.chat.protection !== 'off') {
    L.chat.setProtect('off');
    did.push('chat protection off');
  }
  // "Your page": back to the stock SwarmCast page when a test left the streamer's page on.
  const b = L.branding.branding;
  if (b.name || b.tagline || b.about || b.links.length > 0 || b.tags.length > 0 || b.support.enabled || Object.keys(b.images).length > 0) {
    L.branding.reset();
    L.brandingChanged();
    did.push('branding');
  }
  let obs = !!o.hard;
  if (!same(app.config.quality, initial.quality)) {
    L.quality.updateSettings({ ...structuredClone(initial.quality), obsWebsocket: { ...initial.quality.obsWebsocket } });
    did.push('quality settings');
  }
  // A running ladder stops only when OBS reconnects.
  if (L.quality.state().transcoder.status !== 'off' || L.origin.variants().length > 1) obs = true;
  if (fs.existsSync(PUSH_FILE)) obs = true;
  if (obs) {
    reconnectObs(null);
    did.push('fake OBS reconnected');
  }
  return { previous: previousTest, did };
}

// ---- stream health (GET /health) ----

/**
 * Every media playlist (video and audio) viewers get: the seconds it covers, and the
 * discontinuity number a player gives its newest segment (the sequence plus the tags before it).
 */
function mediaPlaylists(): Array<{ name: string; seconds: number; lastCc: number }> {
  const multivariant = app.live.origin.getPlaylist('index.m3u8') ?? '';
  const names = new Set<string>();
  for (const line of multivariant.split('\n')) {
    const uri = line.startsWith('#') ? /URI="([^"]+)"/.exec(line)?.[1] : line.trim();
    if (uri) names.add(uri.split('?')[0]!.split('/').pop()!);
  }
  return [...names].map((name) => {
    const text = app.live.origin.getPlaylist(name) ?? '';
    let seconds = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) seconds += Number(m[1]);
    const lastCc = Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0) + (text.match(/^#EXT-X-DISCONTINUITY$/gm)?.length ?? 0);
    return { name, seconds: Math.round(seconds * 10) / 10, lastCc };
  });
}

interface Health {
  ok: boolean;
  problems: string[];
  phase: string;
  available: boolean;
  variants: number[];
  sinceSegmentMs: number | null;
  playlistS: number;
  playlists: Array<{ name: string; seconds: number; lastCc: number }>;
  windowSeconds: number;
  ladder: string;
  threat: string;
  fakeObs: { pid: number | null; running: boolean; options: PushOptions };
  previousTest: string;
}

/**
 * Healthy: live, `qualities` variants (1: the ladder is off), a new segment within 2.5 segment
 * durations, and every media playlist holding at least `minPlaylistS`.
 */
function healthNow(minPlaylistS: number, qualities: number): Health {
  const L = app.live;
  const variants = L.origin.variants().map((v) => v.height);
  const since = L.origin.lastSegmentAt ? Date.now() - L.origin.lastSegmentAt : null;
  const playlists = mediaPlaylists();
  const playlistS = playlists.length ? Math.min(...playlists.map((p) => p.seconds)) : 0;
  const problems: string[] = [];
  // A player matches audio to video (and one quality to another) by discontinuity number: if
  // the newest segments disagree, nothing new ever plays (seen when OBS reconnected twice
  // within seconds: playlist.ts DiscontinuityClock).
  if (new Set(playlists.map((p) => p.lastCc)).size > 1) problems.push(`discontinuity numbers differ: ${playlists.map((p) => `${p.name} ${p.lastCc}`).join(', ')}`);
  if (L.phase !== 'live') problems.push(`phase is ${L.phase}`);
  if (!L.origin.available) problems.push('the origin serves no playlist');
  if (variants.length !== qualities) problems.push(`${variants.length} qualities (${variants.join(', ')}), expected ${qualities}`);
  if (since === null) problems.push('no segment yet');
  else if (since > 2.5 * SEGMENT_DURATION_S * 1000) problems.push(`no new segment for ${since} ms`);
  if (playlistS < minPlaylistS) problems.push(`the playlist holds ${playlistS} s, ${minPlaylistS} s wanted`);
  return {
    ok: problems.length === 0,
    problems,
    phase: L.phase,
    available: L.origin.available,
    variants,
    sinceSegmentMs: since,
    playlistS,
    playlists,
    windowSeconds: L.origin.windowSeconds,
    ladder: L.quality.state().transcoder.status,
    threat: shield.detector.state,
    fakeObs: { pid: ffmpeg?.pid ?? null, running: !!ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null, options: pushOptions() },
    previousTest,
  };
}

/**
 * Resolves at the next change that can make the stream healthy, or after `ms`: every problem
 * healthNow() reports ends with a playlist update, a change of availability or of the live's
 * state (a new segment, a new variant, the live started).
 */
function nextStreamChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const { origin } = app.live;
    const done = (): void => {
      clearTimeout(deadline);
      origin.off('updated', done);
      origin.off('available', done);
      app.live.off('state', done);
      resolve();
    };
    const deadline = setTimeout(done, ms);
    origin.on('updated', done);
    origin.on('available', done);
    app.live.on('state', done);
  });
}

/** Waits up to `waitMs` for a healthy stream; answers with the last state seen. */
async function health(waitMs: number, minPlaylistS: number, qualities: number): Promise<Health> {
  const end = Date.now() + waitMs;
  for (;;) {
    const h = healthNow(minPlaylistS, qualities);
    const left = end - Date.now();
    if (h.ok || left <= 0) return h;
    await nextStreamChange(left);
  }
}

// Test-only control port (127.0.0.1:CONTROL_PORT, never part of the app):
// - GET /env: the panel's address and login path (fixtures.ts signs in with them);
// - POST /reset[?hard=1] {test?}: back to the starting state (reset() above);
// - GET /health?waitMs=&minPlaylistS=&qualities=: the stream's health, waiting up to waitMs for it;
// - POST /obs {options | null}: the fake OBS reconnects with these push options;
// - POST /pow-level/<0|1|2>: the level the attack shield would choose by itself, without
//   flooding the server;
// - POST /playlist-window/<seconds>: how many seconds every playlist keeps (p2p.spec.ts
//   emulates v0.2.0 servers, whose ladder audio playlist held only 20 s).
const json = (res: http.ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}
const control = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const post = req.method === 'POST';
    if (post && url.pathname === '/reset') {
      const body = (await readJson(req)) as { test?: unknown } | null;
      const r = await reset({ hard: url.searchParams.get('hard') === '1', ...(typeof body?.test === 'string' ? { test: body.test } : {}) });
      if (r.did.length) app.log.info({ test: currentTest, did: r.did }, 'e2e reset');
      return json(res, 200, r);
    }
    if (req.method === 'GET' && url.pathname === '/env') {
      return json(res, 200, { adminUrl: app.adminUrl, adminLoginPath: new URL(app.adminLoginUrl).pathname });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const h = await health(Math.min(120_000, Number(url.searchParams.get('waitMs') ?? 0)), Number(url.searchParams.get('minPlaylistS') ?? 0), Number(url.searchParams.get('qualities') ?? 1));
      if (!h.ok) app.log.warn({ test: currentTest, health: h }, 'e2e stream unhealthy');
      return json(res, 200, h);
    }
    if (post && url.pathname === '/obs') {
      reconnectObs(((await readJson(req)) as PushOptions | null) ?? null);
      return json(res, 200, { options: pushOptions() });
    }
    const w = /^\/playlist-window\/(\d+)$/.exec(url.pathname);
    if (post && w) {
      app.live.origin.windowSeconds = Number(w[1]);
      return json(res, 200, { windowSeconds: app.live.origin.windowSeconds });
    }
    const m = /^\/pow-level\/([012])$/.exec(url.pathname);
    if (post && m) {
      shield.setAutoPow(Number(m[1]) as 0 | 1 | 2);
      return json(res, 200, { browserCheck: app.live.shield.powLevel() });
    }
    res.writeHead(404).end();
  })().catch((err: unknown) => json(res, 500, { error: (err as Error).message }));
});
await new Promise<void>((resolve, reject) => {
  control.once('error', reject);
  control.listen(CONTROL_PORT, '127.0.0.1', resolve);
});
const testControlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;

fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync(path.join('test-results', 'e2e-env.json'), JSON.stringify({ adminLoginUrl: app.adminLoginUrl, adminUrl: app.adminUrl, dataDir, downloadsDir: process.env.SWARMCAST_DOWNLOADS_DIR, pid: process.pid, testControlUrl }));
console.log('e2e server ready');

const shutdown = async (): Promise<void> => {
  stopping = true;
  control.close();
  ffmpeg?.kill('SIGKILL');
  await app.close();
  // The data folder is this run's only (mkdtemp above); the app has closed every file in it.
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
