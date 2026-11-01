// Real end-to-end test of SwarmCast on macOS:
//   real OBS Studio (driven over obs-websocket) → SwarmCast (dev mode) → real Cloudflare quick tunnel
//   → real browsers (Playwright: Google Chrome, Firefox, WebKit, iPhone 15 / Pixel 7 emulation).
//
// Usage (from the repo root):  node scripts/test/obs-e2e/run.mjs [--skip-bonus] [--keep-obs-config]
// See README.md in this directory for prerequisites and what is checked.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { LIVE_LINK_WAIT_MS } from '../lib/app.mjs';
import { firefoxEnv, firefoxPrefs } from '../lib/firefox.mjs';
import { assertFixedPorts, FIXED_PORTS } from '../lib/ports.mjs';
import { setupObs, ensureMediaFile, OBS_DIR, SCENE } from './setup-obs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { OBSWebSocket } = require('obs-websocket-js');
// Playwright comes from the repo's own devDependencies (root node_modules).
const { chromium, firefox, webkit, devices } = createRequire(path.join(repoRoot, 'package.json'))('playwright');

const ARGS = new Set(process.argv.slice(2));
const ARTIFACTS = path.join(here, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

export const PORTS = FIXED_PORTS.obsE2e;
assertFixedPorts('obsE2e', PORTS);
const OBS_BIN = process.env.OBS_BIN ?? '/Applications/OBS.app/Contents/MacOS/OBS';
const OBS_FLAGS = ['--disable-updater', '--disable-missing-files-check', '--minimize-to-tray', '--profile', 'SwarmCast', '--collection', 'SwarmCast', '--scene', SCENE];
const INPUT_NAME = 'Test video';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(ts(), ...a);

// ---------------------------------------------------------------- results
const results = {
  startedAt: new Date().toISOString(),
  machine: `${os.type()} ${os.release()} ${os.arch()}`,
  steps: [],
  ttffMs: {},
  joinToPlayMs: {},
  consoleErrors: {},
  pageErrors: {},
  failedResponses: {},
  thirdPartyRequests: [],
  websockets: [],
  p2p: {},
  obs: {},
  playlist: {},
  http429: { viewers: 0, server: 0 },
  createdOutsideRepo: [],
};
async function step(name, fn) {
  const s = { name, status: 'pass', startedAt: ts() };
  results.steps.push(s);
  log(`▶ ${name}`);
  try {
    const details = await fn();
    if (details !== undefined) s.details = details;
    log(`✓ ${name}`, details !== undefined ? JSON.stringify(details) : '');
  } catch (err) {
    s.status = err?.blocked ? 'blocked' : 'fail';
    const code = err?.code !== undefined ? ` [code ${err.code}]` : '';
    s.error = `${code}${err?.stack ?? String(err)}`;
    log(`${err?.blocked ? '⚠ BLOCKED' : '✗'} ${name}:${code} ${err?.message ?? err}`);
  }
  s.endedAt = ts();
  return s.status === 'pass';
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function poll(fn, { timeout = 60_000, interval = 1000, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      if (err?.fatal) throw err;
      last = err;
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(interval);
  }
}

// ---------------------------------------------------------------- SwarmCast
const dataDir = process.env.SC_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sc-obs-e2e-'));
let sc = null;
let loginUrl = '';
let adminCookie = '';
const adminBase = `http://127.0.0.1:${PORTS.admin}`;

function startSwarmCast({ shim = false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ ports: PORTS, autoStopMinutes: 30, speedTest: { enabled: false, intervalMinutes: 15 } }, null, 2),
  );
  // stdout/stderr go straight to a file, not a pipe: if this runner dies, SwarmCast must not get
  // EPIPE on every log write (see README: that makes it loop forever instead of shutting down).
  const logFile = path.join(ARTIFACTS, shim ? 'swarmcast.log' : 'swarmcast-noshim.log');
  const fd = fs.openSync(logFile, 'w');
  const preload = shim ? ['--import', path.join(here, 'dns-negative-cache-shim.mjs')] : [];
  sc = spawn(process.execPath, [...preload, '--import', 'tsx', 'apps/server/src/main.ts', '--data-dir', dataDir, '--no-open', '--no-tray'], {
    cwd: repoRoot,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const child = sc;
  return poll(
    () => {
      if (child.exitCode !== null) throw Object.assign(new Error(`SwarmCast exited early (code ${child.exitCode})`), { fatal: true });
      return /Panel: (http:\/\/127\.0\.0\.1:\d+\/auth\/\S+)/.exec(fs.readFileSync(logFile, 'utf8'))?.[1] ?? null;
    },
    { timeout: 60_000, interval: 250, what: 'the panel URL on SwarmCast stdout' },
  );
}

async function adminLogin() {
  const res = await fetch(loginUrl, { redirect: 'manual' });
  assert(res.status === 200, `/auth/<token> answered ${res.status}`);
  adminCookie = res.headers.getSetCookie()[0].split(';')[0];
}
async function state() {
  const res = await fetch(`${adminBase}/api/state`, { headers: { cookie: adminCookie } });
  assert(res.ok, `/api/state ${res.status}`);
  return res.json();
}
async function admin(pathname, body = {}) {
  const res = await fetch(`${adminBase}${pathname}`, {
    method: 'POST',
    headers: { cookie: adminCookie, origin: adminBase, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  assert(res.ok, `${pathname} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const viewerByNick = async (nick) => (await state()).viewers.find((v) => v.nickname === nick);

// ---------------------------------------------------------------- OBS
let obsProc = null;
const obs = new OBSWebSocket();
let obsWsPassword = '';
/** obs-websocket request with a timeout (a wedged OBS must fail the step, not hang the run). */
async function obsCall(type, data, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([
      obs.call(type, data),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`obs-websocket ${type} did not answer within ${timeoutMs / 1000} s (OBS hung?)`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** SetCurrentProfile answers before OBS has switched (queued on its UI thread): wait for it. */
async function switchProfile(name) {
  await obsCall('SetCurrentProfile', { profileName: name });
  await poll(async () => (await obsCall('GetProfileList')).currentProfileName === name, { timeout: 15_000, interval: 250, what: `profile ${name}` });
  await sleep(2000);
}

/**
 * Second profile for the Simple-output-mode check, created as files before OBS starts (creating it
 * over obs-websocket and resetting video right after made OBS 33.0.0 deadlock in obs_reset_video).
 */
function ensureSimpleProfile() {
  const dir = path.join(OBS_DIR, 'basic', 'profiles', 'SwarmCastSimple');
  const src = path.join(OBS_DIR, 'basic', 'profiles', 'SwarmCast', 'basic.ini');
  if (fs.existsSync(path.join(dir, 'basic.ini')) || !fs.existsSync(src)) return;
  const ini = fs
    .readFileSync(src, 'utf8')
    .replace(/^Name=.*$/m, 'Name=SwarmCastSimple')
    .replace(/^Mode=.*$/m, 'Mode=Simple');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'basic.ini'), ini);
  results.createdOutsideRepo.push(path.join(dir, 'basic.ini'));
}

/**
 * OBS writes .sentinel/run_<uuid> while running and removes it on a clean exit; if one is left
 * (crash), the next start asks "launch in Safe Mode?" and blocks. Clear stale ones (OBS not running).
 */
function clearStaleObsSentinels() {
  const dir = path.join(OBS_DIR, '.sentinel');
  let running = false;
  try {
    running = execFileSync('pgrep', ['-f', 'OBS.app/Contents/MacOS/OBS'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    /* none */
  }
  if (running || !fs.existsSync(dir)) return [];
  const removed = fs.readdirSync(dir).filter((f) => f.startsWith('run_'));
  for (const f of removed) fs.rmSync(path.join(dir, f));
  return removed;
}

function runningObsPids() {
  try {
    return execFileSync('pgrep', ['-f', 'OBS.app/Contents/MacOS/OBS'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function launchObs() {
  const already = runningObsPids();
  // OBS is single-instance: a second copy would exit and we would silently drive the old one.
  assert(already.length === 0, `OBS is already running (pid ${already.join(', ')}). Quit it first.`);
  const stale = clearStaleObsSentinels();
  if (stale.length) log(`  removed stale OBS crash sentinel(s): ${stale.join(', ')}`);
  ensureSimpleProfile();
  const fd = fs.openSync(path.join(ARTIFACTS, 'obs.log'), 'w');
  obsProc = spawn(OBS_BIN, OBS_FLAGS, { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  obsProc.on('exit', (code, sig) => log(`OBS exited (code ${code}, signal ${sig})`));
  await poll(
    async () => {
      if (obsProc.exitCode !== null) throw Object.assign(new Error(`OBS exited during startup (code ${obsProc.exitCode})`), { fatal: true });
      await obs.connect('ws://127.0.0.1:4455', obsWsPassword, { rpcVersion: 1 });
      return true;
    },
    { timeout: 60_000, interval: 1000, what: 'obs-websocket on 127.0.0.1:4455' },
  );
  const v = await obsCall('GetVersion');
  return { obsVersion: v.obsVersion, obsWebSocketVersion: v.obsWebSocketVersion, platform: v.platformDescription };
}

async function configureObs(rtmpUrl, streamKey) {
  const media = ensureMediaFile();
  const set = [];
  // Video: 1280x720 @ 30 fps (only possible while no output is active).
  await obsCall('SetVideoSettings', { baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 });
  set.push('Video 1280x720@30');
  // Scene + Media Source looping the test mp4 (needs no macOS permission).
  const { inputs } = await obsCall('GetInputList');
  const inputSettings = { is_local_file: true, local_file: media, looping: true, restart_on_activate: false, close_when_inactive: false };
  if (inputs.some((i) => i.inputName === INPUT_NAME)) {
    await obsCall('SetInputSettings', { inputName: INPUT_NAME, inputSettings });
  } else {
    await obsCall('CreateInput', { sceneName: SCENE, inputName: INPUT_NAME, inputKind: 'ffmpeg_source', inputSettings, sceneItemEnabled: true });
  }
  await obsCall('SetCurrentProgramScene', { sceneName: SCENE });
  set.push(`Scene "${SCENE}" with Media Source "${INPUT_NAME}" (ffmpeg_source, looping)`);
  const modeBefore = (await obsCall('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })).parameterValue;
  // Output: Advanced mode, x264. (Bitrate/keyframe interval/preset of the Advanced streaming encoder
  // live in the profile's streamEncoder.json, which obs-websocket cannot edit; setup-obs.mjs wrote it.)
  for (const [cat, name, value] of [
    ['Output', 'Mode', 'Advanced'],
    ['AdvOut', 'Encoder', 'obs_x264'],
    // Simple-mode equivalents, in case somebody switches the profile to Simple.
    ['SimpleOutput', 'StreamEncoder', 'x264'],
    ['SimpleOutput', 'VBitrate', '2500'],
    ['SimpleOutput', 'Preset', 'veryfast'],
  ]) {
    await obsCall('SetProfileParameter', { parameterCategory: cat, parameterName: name, parameterValue: value });
    set.push(`${cat}/${name}=${value}`);
  }
  const encoderJson = JSON.parse(fs.readFileSync(path.join(OBS_DIR, 'basic', 'profiles', 'SwarmCast', 'streamEncoder.json'), 'utf8'));
  // Stream: Custom server + key, exactly what the panel shows.
  await obsCall('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: { server: rtmpUrl, key: streamKey, use_auth: false, bwtest: false },
  });
  const svc = await obsCall('GetStreamServiceSettings');
  assert(svc.streamServiceType === 'rtmp_custom' && svc.streamServiceSettings.server === rtmpUrl, 'stream service not applied');
  set.push(`Stream: Custom, server=${rtmpUrl}, key=<streamKey from panel>`);
  if (modeBefore !== 'Advanced') {
    // OBS builds its output (Simple/Advanced) when a profile loads; editing the parameter alone does
    // not rebuild it. Re-load the profile (what Settings → Apply does).
    await switchProfile('SwarmCastSimple');
    await switchProfile('SwarmCast');
    await obsCall('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: rtmpUrl, key: streamKey, use_auth: false, bwtest: false } });
    set.push(`profile was in ${modeBefore} mode: reloaded it so the Advanced output is used`);
  }
  const mode = await obsCall('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' });
  return { set, streamEncoderJson: encoderJson, outputMode: mode.parameterValue, outputModeBefore: modeBefore };
}

async function quitObs() {
  if (!obsProc || obsProc.exitCode !== null) return 'not running';
  try {
    const st = await obsCall('GetStreamStatus');
    if (st.outputActive || st.outputReconnecting) await obsCall('StopStream').catch(() => {});
    // OBS 33.0.0 can segfault on quit inside the Media Source thread (mp_media_thread →
    // obs_source_output_audio → copy_audio_data). Stop the media source first.
    await obsCall('TriggerMediaInputAction', { inputName: INPUT_NAME, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => {});
    await obsCall('SetInputMute', { inputName: INPUT_NAME, inputMuted: true }).catch(() => {});
    await sleep(1500);
  } catch {
    /* ignore */
  }
  await obs.disconnect().catch(() => {});
  // Ask exactly our OBS process to quit (the standard macOS "quit" event). Do NOT use
  // `osascript -e 'quit app "OBS"'`: it was seen to quit OBS and then relaunch it via LaunchServices.
  try {
    execFileSync(
      'osascript',
      ['-l', 'JavaScript', '-e', `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${obsProc.pid}).terminate`],
      { stdio: 'ignore', timeout: 20_000 },
    );
  } catch {
    /* fall through to the signal fallback below */
  }
  const exited = await poll(() => obsProc.exitCode !== null || obsProc.signalCode !== null, { timeout: 30_000, interval: 500, what: 'OBS to exit' }).catch(() => false);
  if (!exited) {
    obsProc.kill('SIGTERM');
    const gone = await poll(() => obsProc.exitCode !== null || obsProc.signalCode !== null, { timeout: 10_000, interval: 500, what: 'OBS to exit after SIGTERM' }).catch(() => false);
    if (!gone) obsProc.kill('SIGKILL');
    return gone ? 'did not quit; forced with SIGTERM' : 'did not quit; forced with SIGKILL';
  }
  return obsProc.signalCode ? `CRASHED on quit (signal ${obsProc.signalCode}) — OBS bug, see ~/Library/Logs/DiagnosticReports/OBS-*.ips` : `exited with code ${obsProc.exitCode}`;
}

// ---------------------------------------------------------------- browsers
let tunnelHost = '';
const browsers = {};
const pagesByLabel = {};
const joinTimes = [];

/** /api/join allows 10 joins per minute per client IP; every browser here shares one public IP. */
async function joinSlot() {
  for (;;) {
    const now = Date.now();
    while (joinTimes.length && now - joinTimes[0] > 61_000) joinTimes.shift();
    if (joinTimes.length < 8) break;
    const wait = 61_000 - (now - joinTimes[0]) + 500;
    log(`  (waiting ${Math.round(wait / 1000)} s: join rate limit is 10/min per IP)`);
    await sleep(wait);
  }
  joinTimes.push(Date.now());
}

async function getBrowser(kind) {
  if (browsers[kind]) return browsers[kind];
  const launch = {
    chrome: () => chromium.launch({ channel: 'chrome', headless: true }),
    chromium: () => chromium.launch({ headless: true }),
    firefox: () =>
      firefox.launch({
        headless: true,
        // Its startup cache stays in memory: writing it can freeze the browser (lib/firefox.mjs).
        env: firefoxEnv(),
        // Let Firefox autoplay muted media and use WebRTC without prompts; form history off (lib/firefox.mjs).
        firefoxUserPrefs: firefoxPrefs({ 'media.autoplay.default': 0, 'media.navigator.permission.disabled': true }),
      }),
    webkit: () => webkit.launch({ headless: true }),
  }[kind];
  try {
    browsers[kind] = await launch();
  } catch (err) {
    // E.g. Playwright's Firefox build does not start at all on some macOS versions
    // ("Could not find profile folder."): an environment problem, not a SwarmCast one.
    const msg = String(err?.message ?? err).split('\n').filter((l) => /Failed to launch|err\]/.test(l)).join(' | ');
    throw Object.assign(new Error(`${kind} could not be launched by Playwright: ${msg}`), { blocked: true });
  }
  return browsers[kind];
}

function instrument(label, context, page) {
  results.consoleErrors[label] ??= [];
  results.pageErrors[label] ??= [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') results.consoleErrors[label].push(`${m.type()}: ${m.text()}`.slice(0, 400));
  });
  page.on('pageerror', (e) => results.pageErrors[label].push(String(e).slice(0, 400)));
  results.failedResponses[label] ??= [];
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const u = new URL(r.url());
      results.failedResponses[label].push(`${r.status()} ${r.request().method()} ${u.host === tunnelHost ? '' : u.host}${u.pathname}`);
    }
  });
  context.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank') return;
    const host = new URL(u).host;
    if (host !== tunnelHost) results.thirdPartyRequests.push({ label, url: u });
  });
  page.on('websocket', (ws) => {
    const rec = { label, url: ws.url().replace(/\?.*$/, ''), framesIn: 0, framesOut: 0, closed: false, error: null };
    results.websockets.push(rec);
    if (new URL(ws.url()).host !== tunnelHost) results.thirdPartyRequests.push({ label, url: ws.url() });
    ws.on('framereceived', () => rec.framesIn++);
    ws.on('framesent', () => rec.framesOut++);
    ws.on('close', () => (rec.closed = true));
    ws.on('socketerror', (e) => (rec.error = String(e)));
  });
}

/** Opens the live link like a person: page → nickname → Watch → wait for moving video. */
async function joinAndPlay({ label, kind, contextOptions = {}, link, nickname = label }) {
  const browser = await getBrowser(kind);
  const context = await browser.newContext({ ...contextOptions });
  const page = await context.newPage();
  instrument(label, context, page);
  pagesByLabel[label] = { context, page, kind, nickname };
  await joinSlot();
  const start = Date.now();
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert(/\/join$/.test(page.url()), `${label}: expected /join, got ${page.url()} — ${(await page.textContent('body'))?.slice(0, 200)}`);
  // Typed once Watch is enabled: a join page that lost a script on the way reloads itself first.
  await page.locator('#join:enabled').waitFor({ timeout: 30_000 });
  await page.fill('#nickname', nickname);
  const clickAt = Date.now();
  await page.click('#join');
  await page.waitForURL(/\/watch$/, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!v && v.currentTime > 0.05 && v.readyState >= 2;
  }, null, { timeout: 90_000, polling: 100 });
  const firstFrame = Date.now();
  results.ttffMs[label] = firstFrame - start;
  results.joinToPlayMs[label] = firstFrame - clickAt;
  // …and it keeps advancing.
  const a = await currentTime(page);
  await sleep(3000);
  const b = await currentTime(page);
  assert(b > a + 2, `${label}: video not advancing (${a.toFixed(2)} → ${b.toFixed(2)})`);
  const status = await page.textContent('#status');
  return { label, ttffMs: firstFrame - start, joinToPlayMs: firstFrame - clickAt, advanced: +(b - a).toFixed(2), status };
}
const currentTime = (page) => page.evaluate(() => document.querySelector('video').currentTime);
const viewerStats = (page) => page.evaluate(() => window.__swarmcast.stats);
async function enableP2P(page) {
  await page.check('#p2p');
  assert(await page.isChecked('#p2p'), 'P2P toggle did not stay on');
}
const invalidText = /no longer valid/;
async function expectInvalid(page, link) {
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // A Cloudflare 502/503/504 is a transient tunnel hiccup (seen once: QUIC "no recent network
    // activity" on cloudflared's single connection), not SwarmCast's answer: retry.
    if (![502, 503, 504].includes(res?.status()) || attempt >= 4) break;
    log(`  tunnel answered ${res.status()}, retrying (${attempt})`);
    await sleep(3000);
  }
  const body = (await page.textContent('body')) ?? '';
  assert(invalidText.test(body), `expected "no longer valid", got HTTP ${res?.status()} ${page.url()} "${body.slice(0, 120)}"`);
  return res?.status();
}

/** Reads the media playlist the viewer gets and returns the segment durations. */
async function playlistInfo(page) {
  return page.evaluate(async () => {
    const get = async (u) => (await fetch(u, { cache: 'no-store' })).text();
    let url = '/hls/index.m3u8';
    let text = await get(url);
    const variant = text.split('\n').find((l) => l && !l.startsWith('#') && l.includes('.m3u8'));
    if (text.includes('#EXT-X-STREAM-INF') && variant) {
      url = new URL(variant.trim(), new URL(url, location.href)).pathname;
      text = await get(url);
    }
    const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    return { url, segments: durations.length, durations, targetDuration: Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1]) };
  });
}

// ---------------------------------------------------------------- the test
let liveLink = '';
let rtmpUrl = '';
let streamKey = '';
let obsStreamStartedAt = 0;

async function main() {
  log(`Data dir: ${dataDir}`);
  log(`Artifacts: ${ARTIFACTS}`);

  const startOnce = async (shim) => {
    const started = Date.now();
    loginUrl = await startSwarmCast({ shim });
    await adminLogin();
    const s = await poll(
      async () => {
        const st = await state();
        if (st.phase === 'off' && st.steps.some((x) => x.status === 'error')) {
          throw Object.assign(new Error(`start failed: ${st.steps.map((x) => `${x.id}:${x.status}${x.error ? `(${x.error})` : ''}`).join(' ')}`), { fatal: true });
        }
        return st.liveLink && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/join\/\S+$/.test(st.liveLink) && st.phase === 'waiting-obs' ? st : null;
      },
      // As long as the app's own tunnel step may take; a failed start ends the wait at once (above).
      { timeout: LIVE_LINK_WAIT_MS, interval: 1000, what: 'a trycloudflare live link and phase waiting-obs' },
    );
    liveLink = s.liveLink;
    rtmpUrl = s.rtmpUrl;
    streamKey = s.streamKey;
    tunnelHost = new URL(liveLink).host;
    return { tunnelHost, rtmpUrl, phase: s.phase, startMs: Date.now() - started, steps: s.steps.map((x) => `${x.id}:${x.status}`).join(' ') };
  };
  const stopSc = async () => {
    if (sc && sc.exitCode === null) {
      sc.kill('SIGINT');
      await poll(() => sc.exitCode !== null, { timeout: 30_000, interval: 500, what: 'SwarmCast exit' });
    }
  };

  let okStart = false;
  if (!ARGS.has('--dns-shim')) {
    okStart = await step('Start SwarmCast (dev mode, real Cloudflare quick tunnel), unmodified', () => startOnce(false));
    if (!okStart) await stopSc();
  }
  if (!okStart && !ARGS.has('--no-dns-shim')) {
    okStart = await step('Start SwarmCast with the DNS negative-cache shim (first tunnel probe delayed 4 s)', () => startOnce(true));
  }
  if (!okStart) return;

  await step('Tunnel /healthz answers with X-SwarmCast header', async () => {
    const res = await fetch(`https://${tunnelHost}/healthz`);
    const marker = res.headers.get('x-swarmcast');
    assert(res.ok && marker, `status ${res.status}, x-swarmcast=${marker}`);
    return { status: res.status, xSwarmCast: marker, cfRay: res.headers.get('cf-ray') };
  });

  const okObs = await step('Launch OBS and configure it over obs-websocket', async () => {
    const r = setupObs({ force: false });
    obsWsPassword = r.password;
    results.createdOutsideRepo.push(...r.created);
    const v = await launchObs();
    const c = await configureObs(rtmpUrl, streamKey);
    results.obs = { ...v, ...c, launchFlags: OBS_FLAGS };
    return { ...v, outputMode: c.outputMode };
  });
  if (!okObs) return finish();

  await step('Early viewer opens the link before OBS streams → "Waiting for the stream…"', async () => {
    const browser = await getBrowser('chrome');
    const context = await browser.newContext();
    const page = await context.newPage();
    instrument('early-viewer', context, page);
    pagesByLabel['early-viewer'] = { context, page, kind: 'chrome', nickname: 'early-viewer' };
    await joinSlot();
    await page.goto(liveLink, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('#join:enabled').waitFor({ timeout: 30_000 });
    await page.fill('#nickname', 'early-viewer');
    await page.click('#join');
    await page.waitForURL(/\/watch$/, { timeout: 30_000 });
    await sleep(5000);
    return { overlay: await page.textContent('#overlay'), status: await page.textContent('#status'), phase: (await state()).phase };
  });

  const okLive = await step('OBS StartStream → panel shows obsConnected, bitrate > 0, phase live', async () => {
    await obsCall('StartStream');
    obsStreamStartedAt = Date.now();
    await poll(async () => (await obsCall('GetStreamStatus')).outputActive, { timeout: 30_000, what: 'OBS outputActive' });
    const s = await poll(
      async () => {
        const st = await state();
        return st.obsConnected && st.obsBitrateKbps > 0 && st.phase === 'live' ? st : null;
      },
      { timeout: 60_000, what: 'panel obsConnected + bitrate + live' },
    );
    const os_ = await obsCall('GetStreamStatus');
    results.obs.timeToLiveMs = Date.now() - obsStreamStartedAt;
    return { obsConnected: s.obsConnected, obsBitrateKbps: s.obsBitrateKbps, phase: s.phase, timeToLiveMs: results.obs.timeToLiveMs, obsBytes: os_.outputBytes, skippedFrames: os_.outputSkippedFrames };
  });
  if (!okLive) return finish();

  // Viewers normally join a stream that has been running for a while; let the playlist fill.
  const wait = 35_000 - (Date.now() - obsStreamStartedAt);
  if (wait > 0) {
    log(`Waiting ${Math.round(wait / 1000)} s so the live playlist fills up…`);
    await sleep(wait);
  }
  const st = await state();
  results.obs.bitrateAfter35s = st.obsBitrateKbps;

  await step('Early viewer starts playing once OBS is live (no reload)', async () => {
    const page = pagesByLabel['early-viewer']?.page;
    assert(page, 'no early viewer');
    const ok = await poll(
      async () => {
        const a = await currentTime(page);
        await sleep(2000);
        return (await currentTime(page)) > a + 1;
      },
      { timeout: 45_000, interval: 500, what: 'early viewer playback' },
    ).catch(() => false);
    const info = {
      currentTime: await currentTime(page),
      overlay: (await page.isVisible('#overlay')) ? await page.textContent('#overlay') : null,
      status: await page.textContent('#status'),
      failedResponses: [...new Set(results.failedResponses['early-viewer'])],
      secondsSinceObsStart: Math.round((Date.now() - obsStreamStartedAt) / 1000),
    };
    assert(ok, `early viewer never started playing: ${JSON.stringify(info)}`);
    return info;
  });

  // ---- 1. every browser reaches playback through the tunnel
  const viewers = [
    { label: 'chrome-desktop', kind: 'chrome' },
    { label: 'firefox-desktop', kind: 'firefox' },
    { label: 'webkit-desktop', kind: 'webkit' },
    { label: 'iphone15-webkit', kind: 'webkit', contextOptions: { ...devices['iPhone 15'] } },
    { label: 'pixel7-chrome', kind: 'chrome', contextOptions: { ...devices['Pixel 7'] } },
  ];
  for (const v of viewers) {
    await step(`Viewer plays through the tunnel: ${v.label}`, () => joinAndPlay({ ...v, link: liveLink }));
  }
  await step('Panel lists the viewers (device type detected)', async () => {
    const s = await state();
    const list = s.viewers.map((v) => `${v.nickname}:${v.device}:${v.connected ? 'connected' : 'not-connected'}`);
    for (const v of viewers) {
      if (!results.ttffMs[v.label]) continue; // that browser did not get to play (see its own step)
      assert(s.viewers.some((x) => x.nickname === v.label && x.connected), `${v.label} not connected in panel`);
    }
    const mobile = s.viewers.filter((v) => v.device === 'mobile').map((v) => v.nickname);
    return { viewers: list, mobile, connected: s.stats.viewersConnected };
  });
  await step('Playlist segments are ~2 s (OBS keyframe interval 2 s)', async () => {
    const page = pagesByLabel['chrome-desktop']?.page;
    assert(page, 'no chrome page');
    const p = await playlistInfo(page);
    results.playlist = p;
    const bad = p.durations.filter((d) => d < 1.5 || d > 2.6);
    assert(p.segments >= 5, `only ${p.segments} segments`);
    assert(bad.length === 0, `segments not ~2 s: ${p.durations.join(', ')}`);
    return { segments: p.segments, targetDuration: p.targetDuration, min: Math.min(...p.durations), max: Math.max(...p.durations) };
  });
  await step('Screenshot of a viewer page', async () => {
    const files = [];
    for (const label of ['chrome-desktop', 'iphone15-webkit']) {
      const p = pagesByLabel[label]?.page;
      if (!p) continue;
      const f = path.join(ARTIFACTS, `viewer-${label}.png`);
      await p.screenshot({ path: f });
      files.push(path.relative(repoRoot, f));
    }
    return files;
  });

  // ---- 3. P2P over the tunnel
  await step('P2P: two Google Chrome viewers exchange video over WebRTC', async () => {
    const a = await joinAndPlay({ label: 'p2p-chrome-A', kind: 'chrome', link: liveLink });
    await enableP2P(pagesByLabel['p2p-chrome-A'].page);
    const b = await joinAndPlay({ label: 'p2p-chrome-B', kind: 'chrome', link: liveLink });
    await enableP2P(pagesByLabel['p2p-chrome-B'].page);
    return p2pCheck('chrome↔chrome', 'p2p-chrome-A', 'p2p-chrome-B', { a: a.ttffMs, b: b.ttffMs });
  });
  const crossEngine = (kind, name) => async () => {
    await getBrowser(kind); // fail fast (blocked) before touching the Chrome pair
    // Take Chrome A out of P2P so the other engine can only pair with Chrome B.
    const pA = pagesByLabel['p2p-chrome-A'].page;
    const pB = pagesByLabel['p2p-chrome-B'].page;
    if (await pA.isChecked('#p2p')) await pA.uncheck('#p2p');
    await poll(async () => (await viewerStats(pB)).peers.length === 0, { timeout: 20_000, what: 'Chrome B to drop its other peers' });
    const baseB = (await viewerStats(pB)).p2pDownBytes;
    const labelC = `p2p-${kind}-C`;
    await joinAndPlay({ label: labelC, kind, link: liveLink });
    const pC = pagesByLabel[labelC].page;
    await enableP2P(pC);
    const startedAt = Date.now();
    await poll(async () => (await viewerStats(pC)).peers.length > 0 && (await viewerStats(pB)).peers.length > 0, { timeout: 90_000, interval: 2000, what: `${name} peers > 0` });
    const peersAfterMs = Date.now() - startedAt;
    await poll(async () => (await viewerStats(pC)).p2pDownBytes > 0 || (await viewerStats(pB)).p2pDownBytes > baseB, { timeout: 90_000, interval: 2000, what: `${name} P2P bytes` });
    const bytesAfterMs = Date.now() - startedAt;
    await sleep(10_000);
    const sB = await viewerStats(pB);
    const sC = await viewerStats(pC);
    const share = (s) => Math.round((100 * s.p2pDownBytes) / Math.max(1, s.httpBytes + s.p2pDownBytes));
    const out = {
      peersAfterMs,
      firstP2PBytesAfterMs: bytesAfterMs,
      [labelC]: { peers: sC.peers.length, p2pDownBytes: sC.p2pDownBytes, p2pUpBytes: sC.p2pUpBytes, httpBytes: sC.httpBytes, sharePct: share(sC), hashFailures: sC.hashFailures },
      [`p2p-chrome-B (since ${kind} joined)`]: { peers: sB.peers.length, p2pDownBytes: sB.p2pDownBytes - baseB, p2pUpBytes: sB.p2pUpBytes, hashFailures: sB.hashFailures },
    };
    results.p2p[name] = out;
    assert(sB.hashFailures + sC.hashFailures === 0, 'hash failures');
    return out;
  };
  const ffOk = await step('P2P: Firefox ↔ Google Chrome', crossEngine('firefox', 'firefox↔chrome'));
  if (!ffOk && results.steps.at(-1).status === 'blocked') {
    await step('P2P: WebKit ↔ Google Chrome (cross-engine fallback, Firefox unavailable)', crossEngine('webkit', 'webkit↔chrome'));
  }
  await step('Panel shows viewers helping / P2P share', async () => {
    const s = await state();
    return { viewersHelping: s.stats.viewersHelping, p2pSharePercent: s.stats.p2pSharePercent, originUploadMbps: s.stats.originUploadMbps };
  });

  // ---- 4. WebSockets over the quick tunnel
  await step('WebSockets work over the quick tunnel (control + tracker)', async () => {
    const control = results.websockets.filter((w) => w.url === `wss://${tunnelHost}/control`);
    const tracker = results.websockets.filter((w) => w.url === `wss://${tunnelHost}/tracker`);
    assert(control.length > 0, 'no /control websocket seen');
    assert(control.some((w) => w.framesIn > 0), 'no frames received on /control');
    assert(tracker.length > 0, 'no /tracker websocket seen');
    assert(tracker.some((w) => w.framesIn > 0), 'no frames received on /tracker');
    return {
      control: control.map((w) => `${w.label}: in=${w.framesIn} out=${w.framesOut}${w.error ? ` err=${w.error}` : ''}`),
      tracker: tracker.map((w) => `${w.label}: in=${w.framesIn} out=${w.framesOut}${w.error ? ` err=${w.error}` : ''}`),
    };
  });

  // ---- 2. no third-party requests
  await step('Viewer pages only talk to the tunnel host', async () => {
    const uniq = [...new Set(results.thirdPartyRequests.map((r) => `${r.label} ${r.url}`))];
    assert(uniq.length === 0, `third-party requests:\n${uniq.join('\n')}`);
    return { requestsToOtherHosts: 0, tunnelHost };
  });

  // ---- 6. panel screenshot
  await step('Admin panel renders in Google Chrome (screenshot)', async () => {
    const browser = await getBrowser('chrome');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(loginUrl);
    assert(page.url() === `${adminBase}/`, `panel URL ${page.url()}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2500);
    const text = (await page.textContent('body')) ?? '';
    assert(text.includes(tunnelHost) || text.includes('trycloudflare') || /live/i.test(text), 'panel text does not mention the link / live');
    const f = path.join(ARTIFACTS, 'panel-chrome.png');
    await page.screenshot({ path: f, fullPage: true });
    results.consoleErrors['admin-panel'] = errs;
    await ctx.close();
    return { screenshot: path.relative(repoRoot, f), consoleErrors: errs.length, mentionsTunnelHost: text.includes(tunnelHost) };
  });

  // ---- 8 (bonus). OBS stop/start during the live
  if (!ARGS.has('--skip-bonus')) {
    await step('Bonus: OBS stops and restarts streaming → viewers recover', async () => {
      const watchers = ['chrome-desktop', 'firefox-desktop', 'webkit-desktop'].filter((l) => pagesByLabel[l]);
      await obsCall('StopStream');
      await poll(async () => !(await obsCall('GetStreamStatus')).outputActive, { timeout: 20_000, what: 'OBS stream stopped' });
      const stopAt = Date.now();
      const waiting = await poll(async () => ((await state()).phase === 'waiting-obs' ? true : null), { timeout: 90_000, what: 'phase waiting-obs' }).catch(() => false);
      const phaseAfterStop = (await state()).phase;
      const stopToWaitingMs = Date.now() - stopAt;
      await sleep(5000);
      await obsCall('StartStream');
      const restartAt = Date.now();
      await poll(async () => (await state()).phase === 'live', { timeout: 60_000, what: 'phase live again' });
      const recovered = {};
      for (const l of watchers) {
        const page = pagesByLabel[l].page;
        try {
          await poll(
            async () => {
              const a = await currentTime(page);
              await sleep(2500);
              const b = await currentTime(page);
              return b > a + 1.5;
            },
            { timeout: 120_000, interval: 500, what: `${l} playing again` },
          );
          recovered[l] = `${Math.round((Date.now() - restartAt) / 1000)} s after StartStream`;
        } catch (e) {
          recovered[l] = `NOT recovered: ${e.message} | overlay="${await page.textContent('#overlay').catch(() => '')}" status="${await page.textContent('#status').catch(() => '')}" ended=${await page.isVisible('#ended').catch(() => '')}`;
        }
      }
      const failed = Object.entries(recovered).filter(([, v]) => v.startsWith('NOT'));
      assert(failed.length === 0, `viewers did not recover: ${JSON.stringify(recovered)}`);
      return { reachedWaitingObs: !!waiting, phaseAfterStop, stopToWaitingMs, recovered };
    });
  }

  // ---- tutorial check: what does OBS *Simple* output mode send?
  if (!ARGS.has('--skip-bonus')) {
    await step('Tutorial check: OBS Simple output mode (x264, 2500 kbps, veryfast) → keyframe interval / segment length', async () => {
      const page = pagesByLabel['chrome-desktop']?.page;
      assert(page, 'no chrome viewer page');
      const restoreAdvanced = async () => {
        const st = await obsCall('GetStreamStatus');
        if (st.outputActive) {
          await obsCall('StopStream');
          await poll(async () => !(await obsCall('GetStreamStatus')).outputActive, { timeout: 20_000, what: 'OBS stream stopped' });
          await poll(async () => (await state()).phase === 'waiting-obs', { timeout: 60_000, what: 'panel to notice OBS stopped' });
        }
        if ((await obsCall('GetProfileList')).currentProfileName !== 'SwarmCast') await switchProfile('SwarmCast');
        await obsCall('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: rtmpUrl, key: streamKey, use_auth: false, bwtest: false } });
        await obsCall('StartStream');
        await poll(async () => (await state()).phase === 'live', { timeout: 60_000, what: 'phase live (advanced again)' });
        await sleep(15_000); // let a few new segments arrive before the next steps
      };
      let out;
      try {
        await obsCall('StopStream');
        await poll(async () => !(await obsCall('GetStreamStatus')).outputActive, { timeout: 20_000, what: 'OBS stream stopped' });
        await poll(async () => (await state()).phase === 'waiting-obs', { timeout: 60_000, what: 'panel to notice OBS stopped' });
        const { profiles } = await obsCall('GetProfileList');
        assert(profiles.includes('SwarmCastSimple'), 'profile SwarmCastSimple missing (written by ensureSimpleProfile before OBS starts)');
        await switchProfile('SwarmCastSimple');
        for (const [cat, name, value] of [
          ['Output', 'Mode', 'Simple'],
          ['SimpleOutput', 'StreamEncoder', 'x264'],
          ['SimpleOutput', 'VBitrate', '2500'],
          ['SimpleOutput', 'Preset', 'veryfast'],
          ['SimpleOutput', 'ABitrate', '160'],
        ]) {
          await obsCall('SetProfileParameter', { parameterCategory: cat, parameterName: name, parameterValue: value });
        }
        await obsCall('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: rtmpUrl, key: streamKey, use_auth: false, bwtest: false } });
        const mode = (await obsCall('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })).parameterValue;
        const logBefore = fs.readFileSync(path.join(ARTIFACTS, 'obs.log'), 'utf8').length;
        await obsCall('StartStream');
        await poll(async () => (await state()).phase === 'live', { timeout: 60_000, what: 'phase live (simple mode)' });
        await sleep(30_000);
        const p = await playlistInfo(page);
        const obsLog = fs.readFileSync(path.join(ARTIFACTS, 'obs.log'), 'utf8').slice(logBefore);
        const keyint = /keyint:\s+(\d+)/.exec(obsLog)?.[1];
        const bitrate = /bitrate:\s+(\d+)/.exec(obsLog)?.[1];
        const encoderName = /\[x264 encoder: '([^']+)'\]/.exec(obsLog)?.[1];
        const s = await state();
        const vs = await obsCall('GetVideoSettings');
        const fps = vs.fpsNumerator / vs.fpsDenominator;
        out = { outputMode: mode, encoder: encoderName, keyintFrames: keyint ? Number(keyint) : null, keyintSeconds: keyint ? +(Number(keyint) / fps).toFixed(2) : null, fps, bitrate: bitrate ? Number(bitrate) : null, obsBitrateKbps: s.obsBitrateKbps, segmentDurations: p.durations };
      } finally {
        await restoreAdvanced();
      }
      results.obs.simpleMode = out;
      return out;
    });
  }

  // ---- 5. kick + link rotation
  await step('Kick a viewer → "You were removed", link no longer works for them', async () => {
    const label = 'pixel7-chrome';
    const { page } = pagesByLabel[label];
    const v = await viewerByNick(label);
    assert(v, 'viewer not in panel');
    await admin(`/api/viewers/${v.sessionId}/kick`);
    await page.waitForSelector('#ended', { state: 'visible', timeout: 20_000 });
    const title = await page.textContent('#ended-title');
    assert(title === 'You were removed', `ended title "${title}"`);
    const t = await currentTime(page);
    await sleep(2500);
    const t2 = await currentTime(page);
    assert(t2 <= t + 0.3, 'video kept playing after kick');
    const status = await expectInvalid(page, liveLink);
    return { endedTitle: title, reopenStatus: status, bannedCount: (await state()).bannedCount };
  });
  await step('Generate new link → old link fails, new link works', async () => {
    const old = liveLink;
    const r = await admin('/api/link/rotate');
    assert(r.liveLink && r.liveLink !== old, 'rotate did not return a new link');
    liveLink = r.liveLink;
    const browser = await getBrowser('chrome');
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    instrument('rotate-old-link', ctx, p);
    const status = await expectInvalid(p, old);
    await ctx.close();
    const fresh = await joinAndPlay({ label: 'chrome-new-link', kind: 'chrome', link: liveLink });
    return { oldLinkStatus: status, newLinkTtffMs: fresh.ttffMs };
  });

  // ---- 429 tally
  await step('No tunnel/origin 429 at this scale', async () => {
    let viewers429 = 0;
    for (const [label, { page }] of Object.entries(pagesByLabel)) {
      const s = await viewerStats(page).catch(() => null);
      if (s) viewers429 += s.http429;
      if (s?.http429) log(`  ${label}: http429=${s.http429}`);
    }
    const s = await state();
    results.http429 = { viewers: viewers429, server: s.stats.rateLimited429 };
    assert(viewers429 === 0 && s.stats.rateLimited429 === 0, `429s seen: ${JSON.stringify(results.http429)}`);
    return results.http429;
  });

  // ---- 7. stop everything
  await step('"Stop everything" → verified, tunnel URL stops answering, viewers see the end', async () => {
    const watcher = pagesByLabel['chrome-desktop']?.page;
    const r = await admin('/api/live/stop');
    const s = await state();
    let tunnel;
    try {
      const res = await fetch(`https://${tunnelHost}/healthz`, { signal: AbortSignal.timeout(10_000) });
      tunnel = `HTTP ${res.status}, x-swarmcast=${res.headers.get('x-swarmcast')}`;
      assert(!res.headers.get('x-swarmcast'), `tunnel still answers: ${tunnel}`);
    } catch (e) {
      if (e.message.startsWith('tunnel still answers')) throw e;
      tunnel = `fetch failed (${e.cause?.code ?? e.message})`;
    }
    let viewerEnded = null;
    if (watcher) {
      await watcher.waitForSelector('#ended', { state: 'visible', timeout: 20_000 }).catch(() => {});
      viewerEnded = (await watcher.isVisible('#ended')) ? await watcher.textContent('#ended-title') : 'no end screen';
    }
    assert(r.verified === true, `verified=${r.verified}; steps: ${s.steps.map((x) => `${x.id}:${x.status}${x.error ? `(${x.error})` : ''}`).join(' ')}`);
    return { verified: r.verified, phase: s.phase, steps: s.steps.map((x) => `${x.id}:${x.status}`).join(' '), tunnel, viewerEnded };
  });
  await step('OBS notices the lost connection; stop streaming and quit OBS', async () => {
    const seen = await poll(
      async () => {
        const st = await obsCall('GetStreamStatus');
        return st.outputReconnecting || !st.outputActive ? st : null;
      },
      { timeout: 60_000, what: 'OBS to notice the RTMP server is gone' },
    ).catch((e) => ({ error: e.message }));
    const quit = await quitObs();
    return { obsAfterStop: { outputActive: seen.outputActive, outputReconnecting: seen.outputReconnecting, error: seen.error }, quit };
  });

  return finish();
}

async function p2pCheck(name, la, lb, ttff) {
  const pa = pagesByLabel[la].page;
  const pb = pagesByLabel[lb].page;
  const startedAt = Date.now();
  await poll(async () => (await viewerStats(pa)).peers.length > 0 && (await viewerStats(pb)).peers.length > 0, {
    timeout: 90_000,
    interval: 2000,
    what: `${name}: peers > 0`,
  });
  const peersAfterMs = Date.now() - startedAt;
  await poll(async () => (await viewerStats(pa)).p2pDownBytes + (await viewerStats(pb)).p2pDownBytes > 0, {
    timeout: 90_000,
    interval: 2000,
    what: `${name}: p2pDownBytes > 0`,
  });
  const bytesAfterMs = Date.now() - startedAt;
  await sleep(10_000); // let some more segments flow
  const sa = await viewerStats(pa);
  const sb = await viewerStats(pb);
  const share = (s) => (s.httpBytes + s.p2pDownBytes > 0 ? Math.round((100 * s.p2pDownBytes) / (s.httpBytes + s.p2pDownBytes)) : 0);
  const out = {
    peersAfterMs,
    firstP2PBytesAfterMs: bytesAfterMs,
    [la]: { peers: sa.peers.length, p2pDownBytes: sa.p2pDownBytes, p2pUpBytes: sa.p2pUpBytes, httpBytes: sa.httpBytes, sharePct: share(sa), hashFailures: sa.hashFailures },
    [lb]: { peers: sb.peers.length, p2pDownBytes: sb.p2pDownBytes, p2pUpBytes: sb.p2pUpBytes, httpBytes: sb.httpBytes, sharePct: share(sb), hashFailures: sb.hashFailures },
    ttff,
  };
  results.p2p[name] = out;
  assert(sa.hashFailures + sb.hashFailures === 0, 'hash failures');
  return out;
}

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
  await quitObs().catch(() => {});
  if (sc && sc.exitCode === null) {
    sc.kill('SIGINT');
    await poll(() => sc.exitCode !== null, { timeout: 30_000, interval: 500, what: 'SwarmCast exit' }).catch(() => sc.kill('SIGKILL'));
  }
  // Leftover child processes started for this data dir?
  let leftovers = '';
  try {
    leftovers = execFileSync('pgrep', ['-fl', 'mediamtx|cloudflared'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(dataDir) || l.includes(String(PORTS.public)))
      .join('\n');
  } catch {
    /* pgrep exits 1 when nothing matches */
  }
  results.leftoverProcesses = leftovers || 'none';
  results.tunnel5xx = Object.values(results.failedResponses).flat().filter((r) => /^5\d\d /.test(r)).length;
  results.finishedAt = new Date().toISOString();
  results.dataDir = dataDir;
  const failed = results.steps.filter((s) => s.status === 'fail');
  fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), JSON.stringify(results, null, 2));
  console.log('\n================ SUMMARY ================');
  for (const s of results.steps) console.log(`${s.status.toUpperCase().padEnd(7)}  ${s.name}`);
  console.log('TTFF (page open → first frame, ms):', results.ttffMs);
  console.log('Join click → first frame (ms):', results.joinToPlayMs);
  console.log('Leftover processes:', results.leftoverProcesses);
  console.log('Failed responses (status >= 400):', JSON.stringify(results.failedResponses));
  console.log(`Report: ${path.join(ARTIFACTS, 'report.json')}`);
  process.exitCode = failed.length ? 1 : 0;
}

process.on('SIGINT', () => void finish().then(() => process.exit(130)));
process.on('exit', () => {
  // Never leave SwarmCast or OBS running behind us.
  if (sc && sc.exitCode === null && sc.signalCode === null) sc.kill('SIGKILL');
  if (obsProc && obsProc.exitCode === null && obsProc.signalCode === null) obsProc.kill('SIGKILL');
});
main()
  .catch((err) => {
    console.error(err);
    results.fatal = String(err?.stack ?? err);
  })
  .finally(() => finish());
