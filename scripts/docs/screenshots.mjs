#!/usr/bin/env node
// Regenerates the panel and viewer screenshots in docs/img/ (used by docs/TUTORIAL_*.md and
// README.md), in English and Portuguese. Reproducible: it starts the Playwright e2e test server
// (SwarmCast without a tunnel + a synthetic ffmpeg "OBS" stream), joins a few viewers, and
// captures each page with Google Chrome. Secrets never appear: the stream key stays hidden and
// the live link is replaced by a placeholder before every capture.
//
//   npm run build && node scripts/docs/screenshots.mjs
//
// Needs: `npm ci`, `npm run fetch-bins`, `npm run build`, ffmpeg on PATH and Google Chrome.
// macOS/Linux only (the fake OBS is reconnected with SIGUSR2). Ports: the e2e ports moved by
// SWARMCAST_E2E_PORT_OFFSET (default 1500 here, so it can run next to the e2e suite).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'docs', 'img');
const OFFSET = Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 1500);
// Keep in sync with apps/server/test/e2e/server.ts.
const PORTS = { rtmp: 39935 + OFFSET, public: 38080 + OFFSET, admin: 38081 + OFFSET, mediamtxHls: 38888 + OFFSET };
const BASE = `http://127.0.0.1:${PORTS.public}`;
const ENV_FILE = path.join(ROOT, 'test-results', 'e2e-env.json');
const PUSH_FILE = path.join(ROOT, 'test-results', 'e2e-push.json');
const LOCALES = ['en', 'pt-BR'];
// What the screenshots show instead of the real values.
const LINK_PLACEHOLDER = 'https://example.trycloudflare.com/join/••••••';
const RTMP_SHOWN = 'rtmp://127.0.0.1:1935/live';
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
// iPhone 15 (portrait) in Chrome, at 1x like the desktop shots: the picture stays phone-sized
// in the guides instead of filling the page.
const PHONE = { ...devices['iPhone 15'], deviceScaleFactor: 1 };
const MAX_BYTES = 250 * 1024;

const log = (msg) => console.log(`[screenshots] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(what, fn, timeoutMs = 60_000, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// ---- e2e server -------------------------------------------------------------------------

function startServer() {
  fs.rmSync(ENV_FILE, { force: true });
  fs.rmSync(PUSH_FILE, { force: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/e2e/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, SWARMCAST_E2E_PORT_OFFSET: String(OFFSET) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => {
      output += d;
      if (output.includes('e2e server ready')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`e2e server exited (${code}):\n${output.slice(-2000)}`)));
  });
  const timeout = sleep(90_000).then(() => {
    throw new Error(`e2e server did not start in 90 s:\n${output.slice(-2000)}`);
  });
  return { child, ready: Promise.race([ready, timeout]) };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  // The server stops MediaMTX and ffmpeg itself; force it only if it hangs.
  if (await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}

// ---- admin API (same cookie login as apps/server/test/e2e/fixtures.ts) -------------------

let env = null;
let cookie = '';

async function adminLogin() {
  env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
  const res = await fetch(env.adminLoginUrl, { redirect: 'manual' });
  cookie = res.headers.getSetCookie()[0].split(';')[0];
}

async function adminApi(method, pathname, body) {
  const res = await fetch(`${env.adminUrl}${pathname}`, {
    method,
    headers: { cookie, origin: env.adminUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${pathname}: HTTP ${res.status}`);
  return res.json();
}

const state = () => adminApi('GET', '/api/state');

/** Turn on 480p + 360p and make the fake OBS reconnect at 720p, so viewers get a quality menu. */
async function enableQualityLadder() {
  const q = await adminApi('GET', '/api/quality');
  if (!q.ffmpeg.available) {
    log('ffmpeg not available to SwarmCast: one quality only (no quality menu)');
    return;
  }
  await adminApi('PUT', '/api/quality', {
    ...q.settings,
    ladder: { ...q.settings.ladder, mode: 'manual', enabled: true, heights: [480, 360], encoder: 'auto' },
    obsWebsocket: { enabled: q.settings.obsWebsocket.enabled, url: q.settings.obsWebsocket.url },
  });
  fs.writeFileSync(PUSH_FILE, JSON.stringify({ size: '1280x720', kbps: 2500 }));
  process.kill(env.pid, 'SIGUSR2');
  try {
    await poll('the 720p/480p/360p renditions', async () => (await adminApi('GET', '/api/quality')).variants.length >= 3, 120_000, 1000);
  } catch {
    log('the renditions did not start in time: continuing with what is there');
  }
}

/**
 * Quality ladder on, then one clean Stop/Turn on, so the activity console shows a normal start
 * (not the test setup) and the stream has a new link, as on every real live.
 */
async function prepareStream() {
  await enableQualityLadder();
  await adminApi('POST', '/api/live/stop', {});
  await poll('SwarmCast to stop', async () => (await state()).phase === 'off', 60_000);
  await adminApi('POST', '/api/activity/clear', {});
  await adminApi('POST', '/api/live/start', {});
  await poll('live again', async () => (await state()).phase === 'live', 90_000);
  await poll('the renditions again', async () => (await adminApi('GET', '/api/quality')).variants.length >= 3, 90_000, 1000).catch(() =>
    log('the renditions did not restart in time'),
  );
}

// ---- browser helpers --------------------------------------------------------------------

/**
 * Replace secrets in the page before a capture: the live link (and its token, wherever it
 * shows up) becomes a placeholder, the stream key is never revealed, and the test RTMP port
 * shows as the default 1935.
 */
async function sanitize(page, s) {
  const token = s.liveLink ? new URL(s.liveLink).pathname.split('/').pop() : null;
  await page.evaluate(
    ({ link, token, key, rtmp, linkShown, rtmpShown }) => {
      const swaps = [
        [link, linkShown],
        [rtmp, rtmpShown],
        [token, '••••••'],
        [key, '•'.repeat(18)],
      ].filter(([from]) => from);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        let text = n.nodeValue;
        for (const [from, to] of swaps) text = text.split(from).join(to);
        if (text !== n.nodeValue) n.nodeValue = text;
      }
    },
    { link: s.liveLink, token, key: s.streamKey, rtmp: s.rtmpUrl, linkShown: LINK_PLACEHOLDER, rtmpShown: RTMP_SHOWN },
  );
}

/**
 * The test setup (switching the quality ladder on and reconnecting the synthetic "OBS") leaves
 * raw ffmpeg stderr lines and a keyframe warning in the activity console that a normal live does
 * not show; hide just those lines, then follow the end of the log as the panel does.
 */
async function hideHarnessLines(page) {
  await page.evaluate(() => {
    for (const line of document.querySelectorAll('[data-testid="activity"] .console-line.lvl-warn')) {
      if (/ffmpeg ladder|keyframe/i.test(line.textContent)) line.style.display = 'none';
    }
    const box = document.querySelector('[data-testid="activity"] .console');
    if (box) box.scrollTop = box.scrollHeight;
  });
}

async function shot(target, name) {
  const file = path.join(OUT_DIR, name);
  await target.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  log(`captured ${name}`);
  return file;
}

/** The page's centered card with some background around it (the rest of the page is empty). */
async function shotCard(page, name, pad = 48) {
  const box = await page.locator('main.card').boundingBox();
  const width = page.viewportSize().width;
  const x = Math.max(0, Math.floor(box.x - pad * 4));
  const clip = { x, y: 0, width: Math.min(width - x, Math.ceil(box.width + pad * 8)), height: Math.ceil(box.y + box.height + pad) };
  await page.screenshot({ path: path.join(OUT_DIR, name), clip, animations: 'disabled', caret: 'hide' });
  log(`captured ${name}`);
}

async function waitPlaying(page, seconds = 2) {
  await page.waitForFunction(
    (s) => {
      const v = document.querySelector('video');
      return !!v && v.currentTime > s && !v.paused;
    },
    seconds,
    { timeout: 60_000 },
  );
}

async function joinViewer(browser, locale, nickname, contextOptions) {
  const context = await browser.newContext({ ...contextOptions, locale });
  const page = await context.newPage();
  await page.goto((await state()).liveLink);
  await page.waitForURL(/\/join$/);
  await page.fill('#nickname', nickname);
  await page.click('#join');
  await page.waitForURL(/\/watch$/);
  await waitPlaying(page);
  return { context, page };
}

// ---- captures ---------------------------------------------------------------------------

async function captureLocale(browser, lang) {
  log(`--- ${lang} ---`);
  const desktop = await joinViewer(browser, lang, 'Maria', DESKTOP);
  await desktop.page.check('#p2p');
  const phone = await joinViewer(browser, lang, 'Pedro', PHONE);
  await phone.page.check('#p2p');
  const third = await joinViewer(browser, lang, 'Alex', DESKTOP);
  await third.page.uncheck('#p2p');
  await poll('3 viewers in the panel', async () => (await state()).viewers.length === 3, 30_000);
  // Give P2P a moment to connect, so "helping" and the peer stats have numbers.
  await poll('P2P helpers', async () => (await state()).stats.viewersHelping >= 1, 30_000).catch(() => log('no P2P helper yet'));
  await sleep(8000);

  // Panel.
  const adminCtx = await browser.newContext({ ...DESKTOP, locale: lang });
  const panel = await adminCtx.newPage();
  await panel.goto(env.adminLoginUrl);
  await panel.waitForSelector('[data-testid="live-link"]');
  await panel.waitForSelector('[data-testid="viewers"] tbody tr:nth-child(3)');
  await panel.waitForSelector('[data-testid="quality-pc"]', { timeout: 30_000 }).catch(() => {});
  await sleep(2500);
  const s = await state();

  // (1) Overview: the top of the panel (status, OBS pill, live link) and the viewers list
  // (Phone/PC, P2P), with the cards in between left out of this one picture.
  await sanitize(panel, s);
  await panel.evaluate(() => {
    for (const sel of ['[data-testid="quality-card"]', '[data-testid="activity"]', 'footer']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
  });
  await panel.screenshot({ path: path.join(OUT_DIR, `panel-overview-${lang}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  log(`captured panel-overview-${lang}.png`);
  await panel.evaluate(() => {
    for (const sel of ['[data-testid="quality-card"]', '[data-testid="activity"]', 'footer']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = '';
    }
  });

  // (2) Quality card ("Your PC"), (3) protection, (4) activity console.
  for (const [testid, name] of [
    ['quality-card', 'panel-quality'],
    ['security', 'panel-protection'],
    ['activity', 'panel-activity'],
  ]) {
    const el = panel.locator(`[data-testid="${testid}"]`);
    if ((await el.count()) === 0) {
      log(`no ${testid} card: skipped`);
      continue;
    }
    await el.scrollIntoViewIfNeeded();
    await sanitize(panel, s);
    if (testid === 'activity') await hideHarnessLines(panel);
    await shot(el, `${name}-${lang}.png`);
  }

  // (5) Viewer page on a desktop: LIVE badge, viewer count, quality menu, P2P switch.
  await desktop.page.waitForSelector('#viewer-count-wrap:not([hidden])', { timeout: 15_000 }).catch(() => {});
  await desktop.page.waitForSelector('.quality-menu', { timeout: 15_000 }).catch(() => log('no quality menu'));
  await waitPlaying(desktop.page, 6);
  await desktop.page.screenshot({ path: path.join(OUT_DIR, `viewer-desktop-${lang}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
  log(`captured viewer-desktop-${lang}.png`);

  // (6) Viewer page on a phone (portrait).
  await waitPlaying(phone.page, 6);
  await shot(phone.page, `viewer-phone-${lang}.png`);

  // (7) Join page with a nickname typed (not submitted).
  const joinCtx = await browser.newContext({ ...DESKTOP, locale: lang });
  const joinPage = await joinCtx.newPage();
  await joinPage.goto(s.liveLink);
  await joinPage.waitForURL(/\/join$/);
  await joinPage.fill('#nickname', 'Maria');
  await shotCard(joinPage, `join-${lang}.png`);

  // (8) "Link not valid" (an old or wrong link).
  await joinPage.goto(`${BASE}/join/not-the-current-link`);
  await joinPage.waitForSelector('#invalid-message');
  await shotCard(joinPage, `link-invalid-${lang}.png`);

  for (const c of [joinCtx, adminCtx, desktop.context, phone.context, third.context]) await c.close();
}

// ---- PNG size ---------------------------------------------------------------------------

function has(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Shrink a PNG with pngquant, or ffmpeg's 256-color palette as a fallback; keep it only if smaller. */
function optimize(file) {
  const before = fs.statSync(file).size;
  const tmp = path.join(os.tmpdir(), `sc-shot-${process.pid}-${path.basename(file)}`);
  try {
    if (has('pngquant')) {
      execFileSync('pngquant', ['--force', '--quality=70-95', '--speed=1', '--output', tmp, file], { stdio: 'ignore' });
    } else {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none', '-pred', 'mixed', tmp]);
    }
    if (fs.existsSync(tmp) && fs.statSync(tmp).size < before) fs.copyFileSync(tmp, file);
  } catch (err) {
    log(`could not optimize ${path.basename(file)}: ${err.message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return fs.statSync(file).size;
}

// ---- main -------------------------------------------------------------------------------

for (const [name, port] of Object.entries(PORTS)) {
  if (!(await portFree(port))) {
    console.error(`[screenshots] port ${port} (${name}) is busy. Stop what uses it or set SWARMCAST_E2E_PORT_OFFSET.`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let server = null;
let browser = null;
let failed = false;
const onSignal = () => {
  void (server ? stopServer(server) : Promise.resolve()).finally(() => process.exit(130));
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  browser = await chromium.launch({
    channel: process.env.PW_CHROMIUM_CHANNEL ?? 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  // A fresh server per language: same starting point, and no viewers left over from the other.
  for (const lang of LOCALES) {
    await poll('the e2e ports to be free', async () => (await Promise.all(Object.values(PORTS).map(portFree))).every(Boolean), 30_000);
    const started = startServer();
    server = started.child;
    await started.ready;
    await adminLogin();
    log(`server up (${lang}), waiting for the stream to go live`);
    await poll('the stream to go live', async () => (await state()).phase === 'live', 90_000);
    await prepareStream();
    await captureLocale(browser, lang);
    await stopServer(server);
    server = null;
  }
} catch (err) {
  failed = true;
  console.error(`[screenshots] ${err.stack ?? err}`);
} finally {
  await browser?.close().catch(() => {});
  if (server) await stopServer(server);
  fs.rmSync(PUSH_FILE, { force: true });
  log('server stopped');
}

if (!failed) {
  let total = 0;
  for (const f of fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).sort()) {
    const size = optimize(path.join(OUT_DIR, f));
    total += size;
    log(`${f}: ${Math.round(size / 1024)} KB${size > MAX_BYTES ? '  (over 250 KB)' : ''}`);
  }
  log(`total: ${(total / 1024 / 1024).toFixed(2)} MB`);
}
process.exit(failed ? 1 : 0);
