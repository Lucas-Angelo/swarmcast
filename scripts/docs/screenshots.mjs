#!/usr/bin/env node
// Regenerates the panel and viewer screenshots in docs/img/ (used by the website in site/ and
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
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
import { loopbackBase, panelLogin } from '../test/lib/loopback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'docs', 'img');
const OFFSET = Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? 1500);
// Keep in sync with apps/server/test/e2e/server.ts.
const PORTS = { rtmp: 39935 + OFFSET, public: 38080 + OFFSET, admin: 38081 + OFFSET, control: 38082 + OFFSET, mediamtxHls: 38888 + OFFSET };
const BASE = `http://127.0.0.1:${PORTS.public}`;
// The e2e server's test control port: GET /env gives the panel's address and login path.
const CONTROL = loopbackBase(`http://127.0.0.1:${PORTS.control}`);
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
// The website's guide pictures (site/src/assets/guides/<section>/<en|pt-br>/<name>.webp), with
// numbered callouts like the hand-made ones. WebP through sharp, a dependency of the site
// (`npm ci --prefix site` first).
const GUIDES = path.join(ROOT, 'site', 'src', 'assets', 'guides');
const guideDir = (lang) => (lang === 'en' ? 'en' : 'pt-br');

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
  fs.rmSync(PUSH_FILE, { force: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/e2e/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, SWARMCAST_E2E_PORT_OFFSET: String(OFFSET) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    // The server sends its own stdout (and "e2e server ready") to test-results/e2e-server.log, so
    // ready means its test control port answers.
    const onData = (d) => {
      output += d;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`e2e server exited (${code}):\n${output.slice(-2000)}`)));
    void poll('the test control port', async () => (await fetch(new URL('/env', CONTROL))).ok, 90_000, 500).then(resolve, () => {});
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

/** The panel's checked loopback base and login URL (from the control port, not from a file). */
let admin = null;
let cookie = '';

async function adminLogin() {
  const res = await fetch(new URL('/env', CONTROL));
  if (!res.ok) throw new Error(`test control /env: HTTP ${res.status}`);
  admin = panelLogin(await res.json());
  const login = await fetch(admin.loginUrl, { redirect: 'manual' });
  cookie = login.headers.getSetCookie()[0].split(';')[0];
}

async function adminApi(method, pathname, body) {
  const res = await fetch(new URL(pathname, admin.base), {
    method,
    headers: { cookie, origin: admin.base.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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
  server.kill('SIGUSR2');
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

// ---- guide pictures ---------------------------------------------------------------------

let sharp = null;
async function toWebp(png, out) {
  sharp ??= createRequire(path.join(ROOT, 'site', 'package.json'))('sharp');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(png).webp({ quality: 82, effort: 6 }).toFile(out);
}

/**
 * One guide picture: `target` (a locator) with `pad` px of page around it, each callout target
 * outlined in amber with its number in a badge (CSSOM styles: allowed by every CSP here).
 */
async function guideShot(page, target, section, lang, name, { pad = 24, callouts = [] } = {}) {
  await target.scrollIntoViewIfNeeded();
  const boxes = [];
  for (const [n, loc] of callouts.entries()) {
    const b = await loc.boundingBox();
    if (b) boxes.push({ n: n + 1, ...b });
    else log(`${name}: callout ${n + 1} not visible`);
  }
  await page.evaluate((boxes) => {
    for (const b of boxes) {
      const ring = document.createElement('div');
      const badge = document.createElement('div');
      ring.dataset.guide = badge.dataset.guide = '1';
      Object.assign(ring.style, { position: 'absolute', left: `${b.x + scrollX - 3}px`, top: `${b.y + scrollY - 3}px`, width: `${b.width + 6}px`, height: `${b.height + 6}px`, border: '2.5px solid #e9a92c', borderRadius: '8px', zIndex: '2147483646', pointerEvents: 'none', boxSizing: 'border-box' });
      Object.assign(badge.style, { position: 'absolute', left: `${b.x + scrollX - 13}px`, top: `${b.y + scrollY - 13}px`, width: '22px', height: '22px', borderRadius: '50%', background: '#e9a92c', color: '#1d1a12', font: '700 13px/22px system-ui, sans-serif', textAlign: 'center', zIndex: '2147483647', pointerEvents: 'none', boxShadow: '0 0 0 2px #fff' });
      badge.textContent = String(b.n);
      document.body.append(ring, badge);
    }
  }, boxes);
  const box = await target.boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const clip = { x, y, width: Math.min(vp.width - x, Math.ceil(box.width + pad * 2)), height: Math.ceil(box.height + pad * 2) };
  const png = path.join(os.tmpdir(), `sc-guide-${process.pid}-${name}.png`);
  await page.screenshot({ path: png, clip, animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => document.querySelectorAll('[data-guide]').forEach((e) => e.remove()));
  const out = path.join(GUIDES, section, guideDir(lang), `${name}.webp`);
  await toWebp(png, out);
  fs.rmSync(png, { force: true });
  log(`guide picture ${path.relative(ROOT, out)}`);
  return out;
}

/** What the viewers and the streamer say in the pictures (made-up people, both languages). */
const CHAT_LINES = {
  en: { streamer: 'Welcome everyone! Starting in a minute :hi:', pedro: 'hi from my phone 👋', alex: 'great sound today :gg:', maria: 'can you show the map again?' },
  'pt-BR': { streamer: 'Boa noite, pessoal! Já vamos começar :hi:', pedro: 'oi do celular 👋', alex: 'som tá ótimo hoje :gg:', maria: 'mostra o mapa de novo?' },
};

async function say(page, text) {
  const input = page.getByTestId('chat-input');
  await input.fill(text);
  await poll('Send enabled', () => page.getByTestId('chat-send').isEnabled(), 15_000, 200);
  await input.press('Enter');
}


/** A raw image upload to the panel's "Your page" image route. */
async function adminUpload(slot, file, type) {
  const res = await fetch(new URL(`/api/branding/image/${slot}`, admin.base), {
    method: 'PUT',
    headers: { cookie, origin: admin.base.origin, 'content-type': type },
    body: fs.readFileSync(path.join(ROOT, 'scripts', 'docs', 'brand-sample', file)),
  });
  if (!res.ok) throw new Error(`upload ${slot}: HTTP ${res.status} ${await res.text()}`);
}

/** A made-up streamer page (pictures made from the mascot, scripts/docs/brand-sample/). */
const BRAND_TEXT = {
  en: { tagline: 'Cosy games and a chat every Friday 🎮', about: 'Hi! I stream cosy indie games.\nGrab a tea and make yourself at home.\nLive every Friday at 8 pm.', ended: 'Thanks! Back on Friday at 8 pm 💙' },
  'pt-BR': { tagline: 'Jogos tranquilos e papo toda sexta 🎮', about: 'Oi! Eu transmito jogos indie e aconchegantes.\nPega um chá e fica à vontade.\nAs lives são toda sexta às 20h.', ended: 'Valeu! Volto sexta às 20h 💙' },
};

async function brandOn(lang) {
  for (const [slot, file, type] of [
    ['avatar', 'avatar.jpg', 'image/jpeg'],
    ['avatar128', 'avatar128.png', 'image/png'],
    ['fav32', 'fav32.png', 'image/png'],
    ['fav180', 'fav180.jpg', 'image/jpeg'],
    ['banner', 'banner.jpg', 'image/jpeg'],
    ['banner640', 'banner640.jpg', 'image/jpeg'],
  ]) {
    await adminUpload(slot, file, type);
  }
  const text = BRAND_TEXT[lang];
  await adminApi('PUT', '/api/branding', {
    enabled: true,
    name: 'Ana Plays',
    tagline: text.tagline,
    about: text.about,
    tags: ['cozy', 'indie'],
    links: [
      { label: 'YouTube', url: 'https://www.youtube.com/@anaplays' },
      { label: 'Instagram', url: 'https://instagram.com/anaplays' },
    ],
    // A random EVP key (no real person); the name is made up.
    support: { enabled: true, label: 'pix', mode: 'pix', pix: { type: 'evp', key: '123e4567-e89b-12d3-a456-426614174000', name: 'Ana Souza', city: 'Sao Paulo' } },
    theme: { preset: 'ocean', corners: 'soft' },
    endedMessage: text.ended,
    showCredit: true,
  });
}

/** "Your page" and GIFs on the viewer side, for the "Customise your page" and "Get a GIF key" guides. */
async function captureBranding(browser, lang) {
  await brandOn(lang);
  const chatBefore = (await adminApi('GET', '/api/chat')).settings;
  await adminApi('PUT', '/api/chat/settings', { ...chatBefore, content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy', key: 'guide_screenshot_key', rating: 'pg', consent: 'ask' } });
  try {
    // Join page with the streamer's name and picture.
    const joinCtx = await browser.newContext({ ...DESKTOP, locale: lang });
    const joinPage = await joinCtx.newPage();
    await joinPage.goto((await state()).liveLink);
    await joinPage.waitForURL(/\/join$/);
    await joinPage.locator('#brand-head .sc-brand-name').waitFor({ timeout: 15_000 });
    await joinPage.fill('#nickname', 'Maria');
    // The browser check (proof of work) finishes first, as it does while a viewer types.
    await joinPage.locator('#check').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => log('browser check still showing'));
    await guideShot(joinPage, joinPage.locator('main.card'), 'live', lang, 'your-page-join', { pad: 130 });
    await joinCtx.close();

    // Watch page: header (1), support button (2), banner (3), About card with links (4).
    const v = await joinViewer(browser, lang, 'Bia', { viewport: { width: 1280, height: 1500 }, deviceScaleFactor: 1 });
    const p = v.page;
    await p.locator('#brand-head .sc-brand-name').waitFor({ timeout: 15_000 });
    await p.locator('#brand-banner img').waitFor({ timeout: 30_000 }).catch(() => log('no banner'));
    await adminApi('POST', '/api/chat/send', { text: lang === 'en' ? 'Good evening, chat! :hi:' : 'Boa noite, chat! :hi:' });
    // The provider is never contacted for these pictures: viewers see the consent placeholder.
    await adminApi('POST', '/api/chat/send', { gif: { p: 'klipy', id: 'happy-dance', w: 220, h: 220, m: '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp' } });
    await p.getByTestId('chat-list').locator('button.gif-consent').waitFor({ timeout: 10_000 });
    await sleep(800);
    await guideShot(p, p.locator('body'), 'live', lang, 'your-page-watch', {
      pad: 0,
      callouts: [p.locator('#brand-head'), p.getByTestId('brand-support'), p.locator('#brand-banner'), p.getByTestId('brand-about')],
    });
    // The GIF placeholder (nothing loads before the viewer agrees) and the GIF button.
    await guideShot(p, p.getByTestId('chat'), 'live', lang, 'gif-consent', {
      pad: 12,
      callouts: [p.getByTestId('chat-list').locator('button.gif-consent').last(), p.getByTestId('chat-gif-button')],
    });
    // The Pix sheet.
    await p.getByTestId('brand-support').click();
    const sheet = p.locator('[data-testid="pix-sheet"]');
    await sheet.waitFor({ timeout: 5_000 });
    await sleep(400);
    await guideShot(p, sheet, 'live', lang, 'your-page-pix', { pad: 16 });
    await p.keyboard.press('Escape');
    await v.context.close();
  } finally {
    await adminApi('PUT', '/api/chat/settings', chatBefore);
    await adminApi('POST', '/api/branding/reset', {});
  }
}


/** The panel's chat and "Your page" cards, for the guides (skipped while the panel has no such card). */
async function capturePanelGuides(browser, lang) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 }, deviceScaleFactor: 1, locale: lang });
  const panel = await ctx.newPage();
  await panel.goto(admin.loginUrl.href);
  await panel.waitForSelector('[data-testid="live-link"]');
  const s = await state();

  const card = panel.getByTestId('chat-card');
  if ((await card.count()) > 0) {
    await panel.getByTestId('chat-feed').locator('[data-testid="chat-msg"]').first().waitFor({ timeout: 15_000 }).catch(() => log('no chat messages in the panel'));
    await panel.getByTestId('chat-input').fill(lang === 'en' ? 'Thanks for coming!' : 'Valeu por virem!');
    await sanitize(panel, s);
    // 1 on/off, 2 the messages, 3 send as the streamer, 4 flood protection, 5 clear.
    await guideShot(panel, card, 'live', lang, 'chat-panel', {
      callouts: [panel.getByTestId('chat-enabled'), panel.getByTestId('chat-feed'), panel.getByTestId('chat-send'), panel.getByTestId('chat-protect'), panel.getByTestId('chat-clear')],
    });
    await panel.getByTestId('chat-input').fill('');
    // A viewer's message with its moderation menu open.
    const msg = panel.getByTestId('chat-feed').locator('[data-testid="chat-msg"]').filter({ hasNot: panel.getByTestId('chat-badge') }).last();
    if ((await msg.count()) > 0) {
      await msg.getByTestId('chat-more').click();
      await panel.getByTestId('chat-menu').waitFor({ timeout: 5_000 });
      await guideShot(panel, panel.getByTestId('chat-feed'), 'live', lang, 'chat-moderation', { pad: 16, callouts: [panel.getByTestId('chat-menu')] });
      await panel.keyboard.press('Escape');
      await msg.getByTestId('chat-more').click().catch(() => {});
    }
    const settings = panel.getByTestId('chat-settings');
    await guideShot(panel, settings, 'live', lang, 'chat-settings', { pad: 16 });
    const gifGroup = panel.locator('fieldset', { has: panel.getByTestId('chat-gif-key') });
    if ((await gifGroup.count()) > 0) {
      await guideShot(panel, gifGroup, 'live', lang, 'gif-settings', { pad: 16, callouts: [panel.getByTestId('chat-gif-key')] });
    }
  } else log('no chat card in the panel: skipped');

  const brandCard = panel.getByTestId('brand-card');
  if ((await brandCard.count()) > 0) {
    await brandOn(lang);
    await panel.reload();
    await panel.getByTestId('brand-name').waitFor({ timeout: 15_000 });
    await sleep(1000);
    await guideShot(panel, brandCard, 'live', lang, 'your-page-card', { pad: 16 });
    await adminApi('POST', '/api/branding/reset', {});
  } else log('no "Your page" card in the panel: skipped');
  await ctx.close();
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
  await panel.goto(admin.loginUrl.href);
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

  // (6b) The chat on the viewer page, for the "Chat" guide: the column with a few messages
  // (hide, settings, emoji, send), then the viewer's chat settings (name colour).
  if ((await desktop.page.getByTestId('chat').count()) > 0) {
    const lines = CHAT_LINES[lang];
    await adminApi('POST', '/api/chat/send', { text: lines.streamer });
    await say(phone.page, lines.pedro);
    await say(third.page, lines.alex);
    await desktop.page.getByTestId('chat-list').getByText(lines.alex.split(' :')[0]).waitFor({ timeout: 10_000 });
    await desktop.page.getByTestId('chat-input').fill(lines.maria);
    const chat = desktop.page.getByTestId('chat');
    await guideShot(desktop.page, chat, 'live', lang, 'chat-viewer', {
      pad: 12,
      callouts: [desktop.page.getByTestId('chat-settings-button'), desktop.page.getByTestId('chat-hide'), desktop.page.getByTestId('chat-picker-button'), desktop.page.getByTestId('chat-send')],
    });
    await desktop.page.getByTestId('chat-settings-button').click();
    await guideShot(desktop.page, desktop.page.getByTestId('chat-settings'), 'live', lang, 'chat-viewer-settings', { pad: 12 });
    await desktop.page.keyboard.press('Escape');
    await desktop.page.getByTestId('chat-input').fill('');
  }

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

  // (9) The streamer's page and GIFs on the viewer side (guide pictures).
  await captureBranding(browser, lang);
  // (10) The panel's chat and "Your page" cards (guide pictures).
  await capturePanelGuides(browser, lang);
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
