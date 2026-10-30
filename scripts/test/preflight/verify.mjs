#!/usr/bin/env node
// Pre-release "clean machine" check. Run it on a fresh OS (CI runner or VM) with a real,
// locally built release directory:
//
//   node scripts/test/preflight/verify.mjs --release-dir release [--tunnel] [--chrome] [--junit FILE]
//
// It serves the release over HTTP, installs SwarmCast with the real start script into a
// temp data folder, starts it, streams a synthetic OBS-like feed with ffmpeg, watches with
// real browsers (Playwright), checks P2P, kick, link rotation, "Stop everything", quitting,
// and that no process or port is left behind. With --tunnel it repeats playback through a
// real Cloudflare quick tunnel.
//
// Every step runs once and stops the check at its first failure (no retry): waits are for their
// condition, with a deadline. The one infra recovery is the brand-new quick-tunnel name that the
// runner's resolver may not know yet (scripts/test/lib/viewer.mjs). The helpers are shared with
// the Windows suites (scripts/test/lib). --junit also writes the steps as JUnit XML.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { bareEnv, barePath, loginFromOutput, waitLiveLink } from '../lib/app.mjs';
import { ffmpegBin, liveFeedArgs } from '../lib/ffmpeg.mjs';
import { writeJunit } from '../lib/junit.mjs';
import { isListening } from '../lib/ports.mjs';
import { ownerOf, spawnTracked } from '../lib/proc.mjs';
import { serveDir } from '../lib/release-server.mjs';
import { joinIn, pageState, playerStats, probeHealth, waitPlaying, waitPlaylistCoversSync } from '../lib/viewer.mjs';
import { orTimeout, poll } from '../lib/wait.mjs';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const releaseDir = path.resolve(opt('release-dir') ?? 'release');
const useTunnel = args.includes('--tunnel');
const channel = args.includes('--chrome') ? 'chrome' : undefined;
const isWin = process.platform === 'win32';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-preflight-'));
const results = [];
const logFile = path.join(home, 'preflight-app.log');
/** Pages still open, for the page states printed when a step fails. */
const pages = new Set();

function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`);
}

/** "pid command" of every process whose executable or command line is under `dir`. */
function processesUnder(dir) {
  try {
    if (isWin) {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)" }'], { encoding: 'utf8' });
      return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(dir.toLowerCase()));
    }
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.includes(dir) && !l.includes('preflight/verify.mjs'));
  } catch {
    return [];
  }
}

// ---- installer ----
// Simulate a bare OS: the installer and the app only get the PATH a fresh install has
// (no Git, Node, Homebrew, Chocolatey or other CI tooling).
function startInstaller(releaseUrl, extra) {
  const env = bareEnv({ home, releaseUrl });
  let child;
  if (isWin) {
    const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(releaseDir, 'start-windows.ps1'), '-Yes', '-SkipSpeedtest', ...extra.map((a) => (a === '--no-tunnel' ? '-NoTunnel' : a))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const script = process.platform === 'darwin' ? 'start-macos.sh' : 'start-linux.sh';
    child = spawn('/bin/bash', [path.join(releaseDir, script), '--yes', '--skip-speedtest', ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  let out = '';
  const onData = (d) => {
    out += d;
    fs.appendFileSync(logFile, d);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return { child, output: () => out, owner: ownerOf(child, 'start script', () => out) };
}

/**
 * The OBS-like feed (scripts/test/lib/ffmpeg.mjs, the same one the Windows suites send): its
 * output is kept with the stream key masked, so a feed that dies (no libx264, bad URL) fails
 * the wait for "live" at once with ffmpeg's reason.
 */
function pushStream(rtmpUrl, key) {
  return spawnTracked(ffmpegBin(), liveFeedArgs(`${rtmpUrl}/${key}`, { preset: 'veryfast', vbv: true }), {
    name: 'test feed',
    logFile: path.join(home, 'preflight-feed.log'),
    mask: (t) => (key ? t.replaceAll(key, '[stream key]') : t),
    describe: `${ffmpegBin()} 640x360 1200 kbps`,
  });
}

async function joinAndPlay(browser, link, nickname) {
  const context = await browser.newContext();
  const page = await context.newPage();
  pages.add({ page, label: nickname });
  await joinIn(page, link, nickname);
  await page.waitForURL(/\/watch$/, { timeout: 30_000, waitUntil: 'commit' });
  await waitPlaying(page);
  return { context, page };
}

async function runSession({ releaseUrl, tunnel, browser }) {
  const label = tunnel ? 'tunnel' : 'local';
  const t0 = Date.now();
  const inst = startInstaller(releaseUrl, tunnel ? [] : ['--no-tunnel']);
  const exited = new Promise((r) => inst.child.on('exit', (c) => r(c)));
  let ffmpeg;
  try {
    const app = await loginFromOutput(inst.output, { abortOn: [inst.owner] });
    step(`[${label}] installer installed and started the app`, true, `${Math.round((Date.now() - t0) / 1000)} s`);
    // The release publishes binaries.json (ffmpeg pins): the installer must have fetched ffmpeg
    // from its publisher into <data>/tools/ffmpeg, and the app must use it.
    if (fs.existsSync(path.join(releaseDir, 'binaries.json'))) {
      const q = await app.api('/api/quality');
      const want = path.join(home, 'tools', 'ffmpeg', isWin ? 'ffmpeg.exe' : 'ffmpeg');
      step(`[${label}] installer installed ffmpeg and the app uses it`, q.ffmpeg?.available === true && q.ffmpeg.path === want, q.ffmpeg?.path ?? 'not available');
    }
    const s0 = await waitLiveLink(app, 120_000, [inst.owner]);
    const pattern = tunnel ? /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/join\// : /^http:\/\/127\.0\.0\.1:\d+\/join\//;
    step(`[${label}] live link`, pattern.test(s0.liveLink), s0.liveLink.replace(/\/join\/.*/, '/join/…'));

    ffmpeg = pushStream(s0.rtmpUrl, s0.streamKey);
    await poll(async () => (await app.state()).phase === 'live', { timeoutMs: 90_000, what: 'phase live', abortOn: [ffmpeg, inst.owner] });
    step(`[${label}] OBS-like RTMP stream accepted (phase live)`, true);

    const a = await joinAndPlay(browser, s0.liveLink, `alice-${label}`);
    step(`[${label}] viewer plays the stream in ${browser.browserType().name()}${channel ? ` (${channel})` : ''}`, true);

    if (!tunnel) {
      // Bob must start on segments Alice already played, so peers can share them.
      await waitPlaylistCoversSync(a.page);
      const b = await joinAndPlay(browser, s0.liveLink, 'bob');
      await a.page.check('#p2p');
      await b.page.check('#p2p');
      await poll(async () => (await playerStats(a.page)).p2pDownBytes + (await playerStats(b.page)).p2pDownBytes > 0, { timeoutMs: 120_000, what: 'P2P bytes' });
      const sa = await playerStats(a.page);
      const sb = await playerStats(b.page);
      step('[local] P2P exchange between viewers (hash-verified)', sa.hashFailures + sb.hashFailures === 0, `${Math.round((sa.p2pDownBytes + sb.p2pDownBytes) / 1e3)} KB via peers`);

      const st = await app.state();
      const bob = st.viewers.find((v) => v.nickname === 'bob');
      await app.api(`/api/viewers/${bob.sessionId}/kick`, {});
      await b.page.waitForSelector('#ended:not([hidden])', { timeout: 20_000 });
      await b.page.goto(s0.liveLink);
      step('[local] kick stops playback and the same link is refused', /no longer valid/.test(await b.page.textContent('body')));

      const old = s0.liveLink;
      await app.api('/api/link/rotate', {});
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(old);
      step('[local] old link refused after "Generate new link"', /no longer valid/.test(await p.textContent('body')));
      await ctx.close();
      await b.context.close();
    }
    await a.context.close();

    const publicBase = s0.liveLink.replace(/\/join\/.*/, '');
    const stop = await app.api('/api/live/stop', {});
    step(`[${label}] "Stop everything" verified`, stop.verified === true);
    const stillUp = !!(await probeHealth(publicBase));
    step(`[${label}] public address no longer answers`, !stillUp);

    await ffmpeg.stop();
    await app.api('/api/app/quit', {});
    const code = await orTimeout(exited, 45_000, 'timeout');
    step(`[${label}] app quits cleanly`, code === 0 || code === null, `exit ${code}`);
    const left = await poll(() => (processesUnder(home).length === 0 ? [] : null), { timeoutMs: 15_000, what: 'no process left' }).catch(() => processesUnder(home));
    step(`[${label}] no SwarmCast/MediaMTX/cloudflared process left`, left.length === 0, left.join('; '));
    for (const port of [1935]) step(`[${label}] port ${port} closed`, !(await isListening(port)));
  } finally {
    await ffmpeg?.stop().catch((e) => console.log(`test feed: ${e.message}`));
    if (inst.child.exitCode === null) inst.child.kill();
  }
}

let failed = false;
const server = await serveDir(releaseDir);
const browser = await chromium.launch({ channel, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
try {
  await runSession({ releaseUrl: server.url, tunnel: false, browser });
  if (useTunnel) await runSession({ releaseUrl: server.url, tunnel: true, browser });
} catch (e) {
  failed = true;
  console.error(`\nPREFLIGHT FAILED: ${e.message}\n--- app/installer output (tail) ---\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-6000) : ''}`);
  for (const { page, label } of pages) if (!page.isClosed()) console.error(`--- page ${label}\n${await pageState(page)}`);
} finally {
  await browser.close();
  await server.close();
}
if (opt('junit')) {
  const cases = results.map((r) => ({ group: 'preflight', name: r.name, status: r.ok ? 'pass' : 'fail', detail: r.detail }));
  if (failed && results.every((r) => r.ok)) cases.push({ group: 'preflight', name: 'preflight (before a check)', status: 'fail', detail: 'failed before or between checks: see the output' });
  writeJunit(path.resolve(opt('junit')), `preflight ${os.platform()}-${os.arch()}`, cases);
}
console.log(`\nInstaller/app ran with a bare-OS PATH: ${barePath()}`);
console.log(`\nPreflight ${os.platform()}-${os.arch()}: ${results.filter((r) => r.ok).length} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
