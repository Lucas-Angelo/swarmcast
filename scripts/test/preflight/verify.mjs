#!/usr/bin/env node
// Pre-release "clean machine" check. Run it on a fresh OS (CI runner or VM) with a real,
// locally built release directory:
//
//   node scripts/test/preflight/verify.mjs --release-dir release [--tunnel] [--chrome]
//
// It serves the release over HTTP, installs SwarmCast with the real start script into a
// temp data folder, starts it, streams a synthetic OBS-like feed with ffmpeg, watches with
// real browsers (Playwright), checks P2P, kick, link rotation, "Stop everything", quitting,
// and that no process or port is left behind. With --tunnel it repeats playback through a
// real Cloudflare quick tunnel.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

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

function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `abort()` returning a message ends the wait at once (e.g. the test feed died). */
async function until(fn, timeoutMs, what, abort = () => null) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const why = abort();
    if (why) throw new Error(`${what}: ${why}`);
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

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

// ---- 1. serve the release ----
function serve(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// ---- 2. installer ----
// Simulate a bare OS: the installer and the app only get the PATH a fresh install has
// (no Git, Node, Homebrew, Chocolatey or other CI tooling).
function barePath() {
  if (isWin) {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    return [`${root}\\System32`, root, `${root}\\System32\\Wbem`, `${root}\\System32\\WindowsPowerShell\\v1.0\\`].join(';');
  }
  return '/usr/bin:/bin:/usr/sbin:/sbin';
}

function startInstaller(releaseUrl, extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  Object.assign(env, { [isWin ? 'Path' : 'PATH']: barePath(), SWARMCAST_RELEASE_URL: releaseUrl, SWARMCAST_HOME: home, SWARMCAST_NO_PAUSE: '1', SWARMCAST_NO_OPEN: '1' });
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
  return { child, output: () => out };
}

async function adminLogin(output) {
  const m = await until(() => /Panel: (http:\/\/127\.0\.0\.1:(\d+))\/auth\/(\S+)/.exec(output()), 300_000, 'panel URL in installer output');
  const base = m[1];
  const res = await fetch(`${base}/auth/${m[3]}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  const api = async (p, body) => {
    const r = await fetch(base + p, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  return { base, api };
}

/**
 * The OBS-like feed: $FFMPEG_BIN (the pinned test build CI installs) or ffmpeg from PATH.
 * stderr is kept, so a feed that dies (no libx264, bad URL) fails the check with ffmpeg's reason.
 */
function pushStream(rtmpUrl, key) {
  const bin = process.env.FFMPEG_BIN || 'ffmpeg';
  const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', '1200k', '-c:a', 'aac', '-b:a', '96k', '-f', 'flv', `${rtmpUrl}/${key}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  let ended = null;
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => {
    err += `spawn ${bin} failed: ${e.message}\n`;
    ended ??= 'spawn failed';
  });
  child.on('exit', (code, signal) => (ended = signal ?? `code ${code}`));
  return {
    kill: () => child.kill(),
    /** null while the feed runs, else "test feed exited (…): <stderr tail>". */
    died: () => (ended ? `test feed ${bin} exited (${ended}): ${(key ? err.replaceAll(key, '[stream key]') : err).trim().slice(-1500) || '(no stderr)'}` : null),
  };
}

async function joinAndPlay(browser, link, nickname) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // A brand-new trycloudflare name may still be negatively cached by the OS resolver.
  for (let i = 0; ; i++) {
    try {
      await page.goto(link);
      break;
    } catch (e) {
      if (!/ERR_NAME_NOT_RESOLVED/.test(String(e)) || i >= 18) throw e;
      await sleep(5000);
    }
  }
  await page.waitForURL(/\/join$/, { timeout: 60_000 });
  await page.fill('#nickname', nickname);
  await page.click('#join');
  await page.waitForURL(/\/watch$/, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.currentTime > 1.5 && !v.paused;
  }, null, { timeout: 90_000 });
  return { context, page };
}

// Health probe that resolves trycloudflare hosts through DNS-over-HTTPS (bypasses OS negative caching).
async function probe(base) {
  const u = new URL('/healthz', base);
  let lookup;
  if (u.protocol === 'https:') {
    const r = await fetch(`https://1.1.1.1/dns-query?name=${u.hostname}&type=A`, { headers: { accept: 'application/dns-json' } }).then((x) => x.json(), () => ({}));
    const ip = r.Answer?.find((a) => a.type === 1)?.data;
    if (ip) lookup = (_h, o, cb) => (o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
  }
  const mod = await import(u.protocol === 'https:' ? 'node:https' : 'node:http');
  return new Promise((resolve) => {
    const req = mod.get(u, { lookup, timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? res.headers['x-swarmcast'] ?? null : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const stats = (page) => page.evaluate(() => window.__swarmcast.stats);

async function runSession({ releaseUrl, tunnel, browser }) {
  const label = tunnel ? 'tunnel' : 'local';
  const t0 = Date.now();
  const inst = startInstaller(releaseUrl, tunnel ? [] : ['--no-tunnel']);
  const exited = new Promise((r) => inst.child.on('exit', (c) => r(c)));
  let ffmpeg;
  try {
    const { api } = await adminLogin(inst.output);
    step(`[${label}] installer installed and started the app`, true, `${Math.round((Date.now() - t0) / 1000)} s`);
    // The release publishes binaries.json (ffmpeg pins): the installer must have fetched ffmpeg
    // from its publisher into <data>/tools/ffmpeg, and the app must use it.
    if (fs.existsSync(path.join(releaseDir, 'binaries.json'))) {
      const q = await api('/api/quality');
      const want = path.join(home, 'tools', 'ffmpeg', isWin ? 'ffmpeg.exe' : 'ffmpeg');
      step(`[${label}] installer installed ffmpeg and the app uses it`, q.ffmpeg?.available === true && q.ffmpeg.path === want, q.ffmpeg?.path ?? 'not available');
    }
    const s0 = await until(async () => {
      const s = await api('/api/state');
      return s.liveLink && (s.phase === 'waiting-obs' || s.phase === 'live') ? s : null;
    }, 120_000, 'live link');
    const pattern = tunnel ? /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/join\// : /^http:\/\/127\.0\.0\.1:\d+\/join\//;
    step(`[${label}] live link`, pattern.test(s0.liveLink), s0.liveLink.replace(/\/join\/.*/, '/join/…'));

    ffmpeg = pushStream(s0.rtmpUrl, s0.streamKey);
    await until(async () => (await api('/api/state')).phase === 'live', 90_000, 'phase live', () => ffmpeg.died());
    step(`[${label}] OBS-like RTMP stream accepted (phase live)`, true);

    const a = await joinAndPlay(browser, s0.liveLink, `alice-${label}`);
    step(`[${label}] viewer plays the stream in ${browser.browserType().name()}${channel ? ` (${channel})` : ''}`, true);

    if (!tunnel) {
      // Let the playlist fill so peers sit behind the live edge (see docs/ARCHITECTURE.md).
      await sleep(25_000);
      const b = await joinAndPlay(browser, s0.liveLink, 'bob');
      await a.page.check('#p2p');
      await b.page.check('#p2p');
      await until(async () => (await stats(a.page)).p2pDownBytes + (await stats(b.page)).p2pDownBytes > 0, 120_000, 'P2P bytes');
      const sa = await stats(a.page);
      const sb = await stats(b.page);
      step('[local] P2P exchange between viewers (hash-verified)', sa.hashFailures + sb.hashFailures === 0, `${Math.round((sa.p2pDownBytes + sb.p2pDownBytes) / 1e3)} KB via peers`);

      const st = await api('/api/state');
      const bob = st.viewers.find((v) => v.nickname === 'bob');
      await api(`/api/viewers/${bob.sessionId}/kick`, {});
      await b.page.waitForSelector('#ended:not([hidden])', { timeout: 20_000 });
      await b.page.goto(s0.liveLink);
      step('[local] kick stops playback and the same link is refused', /no longer valid/.test(await b.page.textContent('body')));

      const old = s0.liveLink;
      await api('/api/link/rotate', {});
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(old);
      step('[local] old link refused after "Generate new link"', /no longer valid/.test(await p.textContent('body')));
      await ctx.close();
      await b.context.close();
    }
    await a.context.close();

    const publicBase = s0.liveLink.replace(/\/join\/.*/, '');
    const stop = await api('/api/live/stop', {});
    step(`[${label}] "Stop everything" verified`, stop.verified === true);
    const stillUp = !!(await probe(publicBase));
    step(`[${label}] public address no longer answers`, !stillUp);

    ffmpeg.kill();
    await api('/api/app/quit', {});
    const code = await Promise.race([exited, sleep(45_000).then(() => 'timeout')]);
    step(`[${label}] app quits cleanly`, code === 0 || code === null, `exit ${code}`);
    await sleep(2000);
    const left = processesUnder(home);
    step(`[${label}] no SwarmCast/MediaMTX/cloudflared process left`, left.length === 0, left.join('; '));
    for (const port of [1935]) step(`[${label}] port ${port} closed`, !(await listening(port)));
  } finally {
    ffmpeg?.kill();
    if (inst.child.exitCode === null) inst.child.kill();
  }
}

let failed = false;
const { srv, url } = await serve(releaseDir);
const browser = await chromium.launch({ channel, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
try {
  await runSession({ releaseUrl: url, tunnel: false, browser });
  if (useTunnel) {
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        await runSession({ releaseUrl: url, tunnel: true, browser });
        ok = true;
      } catch (e) {
        console.log(`tunnel attempt ${attempt} failed: ${e.message}`);
        if (attempt === 2) throw e;
        await sleep(15_000);
      }
    }
  }
} catch (e) {
  failed = true;
  console.error(`\nPREFLIGHT FAILED: ${e.message}\n--- app/installer output (tail) ---\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-6000) : ''}`);
} finally {
  await browser.close();
  srv.close();
}
console.log(`\nInstaller/app ran with a bare-OS PATH: ${barePath()}`);
console.log(`\nPreflight ${os.platform()}-${os.arch()}: ${results.filter((r) => r.ok).length} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
