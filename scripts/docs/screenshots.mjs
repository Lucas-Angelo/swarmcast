#!/usr/bin/env node
// Regenerates the panel and viewer screenshots in docs/img/ (used by the website in site/ and
// README.md) and every website guide picture of SwarmCast's own screens
// (site/src/assets/guides/: start/ the panel, the setup tutorial and the splash; viewers/ the
// join, watch and "link not valid" pages; live/ the panel's cards, the chat and "Your page";
// app/ the Desktop app card; help/ the problem report), in English and Portuguese, with the
// numbered callouts the guide texts refer to. Pictures of OBS, the installers and the desktop
// app's native menu and dialogs stay hand-made. Reproducible: it starts the Playwright e2e test
// server (SwarmCast without a tunnel + a synthetic ffmpeg "OBS" stream), joins a few viewers,
// and captures each page with Google Chrome. Secrets never appear: the stream key stays hidden
// and the live link is replaced by a placeholder before every capture.
//
//   npm run build && node scripts/docs/screenshots.mjs
//
// Needs: `npm ci`, `npm run fetch-bins`, `npm run build`, ffmpeg on PATH and Google Chrome.
// macOS/Linux only (the fake OBS is reconnected with SIGUSR2). Ports: the e2e ports moved by
// SWARMCAST_E2E_PORT_OFFSET (default SCREENSHOTS_OFFSET here, so it can run next to the e2e suite;
// scripts/test/lib/ports.mjs).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, devices } from '@playwright/test';
import { loopbackBase, panelLogin } from '../test/lib/loopback.mjs';
import { e2ePorts, SCREENSHOTS_OFFSET } from '../test/lib/ports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'docs', 'img');
const OFFSET = Number(process.env.SWARMCAST_E2E_PORT_OFFSET ?? SCREENSHOTS_OFFSET);
// The e2e server's ports moved by OFFSET (the server refuses an offset that puts one out of place).
const PORTS = e2ePorts(OFFSET);
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
// Cards left out of the panel overview (each has its own picture or guide). The live chat at the
// top stays in it (with a few messages): it is the panel's main screen during a live; only the
// Chat card with the chat settings, further down, is left out.
const OVERVIEW_HIDDEN = ['.card-net', '[data-testid="security"]', '[data-testid="quality-card"]', '[data-testid="activity"]', '[data-testid="brand-card"]', '[data-testid="chat-card"]', '[data-testid="diagnostics"]', 'footer'];

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

/**
 * Turn the quality ladder on (the automatic choice, as SwarmCast starts) and make the fake OBS
 * reconnect at 720p, so viewers get a quality menu (720p, 480p, 360p).
 */
async function enableQualityLadder() {
  const q = await adminApi('GET', '/api/quality');
  if (!q.ffmpeg.available) {
    log('ffmpeg not available to SwarmCast: one quality only (no quality menu)');
    return;
  }
  await adminApi('PUT', '/api/quality', {
    ...q.settings,
    ladder: { ...q.settings.ladder, mode: 'auto', enabled: true, heights: [480, 360], encoder: 'auto' },
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
 * shows as the default 1935. `extra`: more [text, shown instead] pairs.
 */
async function sanitize(page, s, extra = []) {
  const token = s.liveLink ? new URL(s.liveLink).pathname.split('/').pop() : null;
  await page.evaluate(
    ({ link, token, key, rtmp, linkShown, rtmpShown, extra }) => {
      const swaps = [
        [link, linkShown],
        [rtmp, rtmpShown],
        [token, '••••••'],
        [key, '•'.repeat(18)],
        ...extra,
      ].filter(([from]) => from);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        let text = n.nodeValue;
        for (const [from, to] of swaps) text = text.split(from).join(to);
        if (text !== n.nodeValue) n.nodeValue = text;
      }
    },
    { link: s.liveLink, token, key: s.streamKey, rtmp: s.rtmpUrl, linkShown: LINK_PLACEHOLDER, rtmpShown: RTMP_SHOWN, extra },
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

/** A signed-in panel in `context`. */
async function openPanel(context) {
  const panel = await context.newPage();
  await panel.goto(admin.loginUrl.href);
  await panel.waitForSelector('[data-testid="status"]');
  return panel;
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

/** The box around every visible one of `locators`, or null. */
async function unionBox(locators) {
  const bs = (await Promise.all(locators.map((l) => l.boundingBox()))).filter(Boolean);
  if (bs.length === 0) return null;
  const x0 = Math.min(...bs.map((b) => b.x));
  const y0 = Math.min(...bs.map((b) => b.y));
  return { x: x0, y: y0, width: Math.max(...bs.map((b) => b.x + b.width)) - x0, height: Math.max(...bs.map((b) => b.y + b.height)) - y0 };
}

/**
 * One guide picture: `target` (a locator) with `pad` px of page around it, each callout target
 * outlined in amber with its number in a badge just outside the top-left corner, off the text
 * (CSSOM styles: allowed by every CSP here). A callout can be a list of locators (one outline
 * around them all). `viewport`: never below the bottom of the window (the app as it opens).
 */
async function guideShot(page, target, section, lang, name, { pad = 24, callouts = [], area = null, viewport = false } = {}) {
  await target.scrollIntoViewIfNeeded();
  const groups = callouts.map((c) => (Array.isArray(c) ? c : [c]));
  // Inside a scrolling box (the setup tutorial) the callouts are brought into view first.
  for (const loc of groups.flat()) if (await loc.isVisible()) await loc.scrollIntoViewIfNeeded();
  const boxes = [];
  for (const [n, group] of groups.entries()) {
    const b = await unionBox(group);
    if (b) boxes.push({ n: n + 1, ...b });
    else log(`${name}: callout ${n + 1} not visible`);
  }
  await page.evaluate((boxes) => {
    for (const b of boxes) {
      const ring = document.createElement('div');
      const badge = document.createElement('div');
      ring.dataset.guide = badge.dataset.guide = '1';
      Object.assign(ring.style, { position: 'absolute', left: `${b.x + scrollX - 3}px`, top: `${b.y + scrollY - 3}px`, width: `${b.width + 6}px`, height: `${b.height + 6}px`, border: '2.5px solid #e9a92c', borderRadius: '8px', zIndex: '2147483646', pointerEvents: 'none', boxSizing: 'border-box' });
      Object.assign(badge.style, { position: 'absolute', left: `${b.x + scrollX - 20}px`, top: `${b.y + scrollY - 20}px`, width: '22px', height: '22px', borderRadius: '50%', background: '#e9a92c', color: '#1d1a12', font: '700 13px/22px system-ui, sans-serif', textAlign: 'center', zIndex: '2147483647', pointerEvents: 'none', boxShadow: '0 0 0 2px #fff' });
      badge.textContent = String(b.n);
      document.body.append(ring, badge);
    }
  }, boxes);
  // `area`: crop to the union of these locators instead of the whole target.
  const box = area ? await unionBox(area) : await target.boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const height = Math.ceil(box.height + pad * 2);
  const clip = { x, y, width: Math.min(vp.width - x, Math.ceil(box.width + pad * 2)), height: viewport ? Math.min(vp.height - y, height) : height };
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
  en: {
    streamer: 'Welcome everyone! Starting in a minute :hi:',
    pedro: 'hi from my phone 👋',
    alex: 'great sound today :gg:',
    mariaHello: 'First time here, love the cosy vibe 😊',
    pedroAsks: 'what game is this?',
    answer: "It's Celeste! Chapter 3 tonight",
    maria: 'can you show the map again?',
  },
  'pt-BR': {
    streamer: 'Boa noite, pessoal! Já vamos começar :hi:',
    pedro: 'oi do celular 👋',
    alex: 'som tá ótimo hoje :gg:',
    mariaHello: 'Primeira vez aqui, adorei o clima 😊',
    pedroAsks: 'que jogo é esse?',
    answer: 'É Celeste! Hoje tem o capítulo 3',
    maria: 'mostra o mapa de novo?',
  },
};

/**
 * A short, made-up conversation (streamer and the three viewers), before any panel picture: the
 * live chat is on the panel's main screen during a live. Maria's next line stays typed, unsent,
 * for the viewer's chat picture.
 */
async function fillChat(lang, desktop, phone, third) {
  if ((await desktop.getByTestId('chat').count()) === 0) return;
  const lines = CHAT_LINES[lang];
  await adminApi('POST', '/api/chat/send', { text: lines.streamer });
  await say(phone, lines.pedro);
  await say(third, lines.alex);
  await say(desktop, lines.mariaHello);
  await say(phone, lines.pedroAsks);
  await adminApi('POST', '/api/chat/send', { text: lines.answer });
  await desktop.getByTestId('chat-list').getByText(lines.answer).waitFor({ timeout: 15_000 });
}

async function say(page, text) {
  const input = page.getByTestId('chat-input');
  await input.fill(text);
  await poll('Send enabled', () => page.getByTestId('chat-send').isEnabled(), 15_000, 200);
  await input.press('Enter');
}


/** A made-up streamer page (pictures made from the mascot, scripts/docs/brand-sample/). */
const BRAND_TEXT = {
  en: { tagline: 'Cosy games and a chat every Friday 🎮', about: 'Hi! I stream cosy indie games.\nGrab a tea and make yourself at home.\nLive every Friday at 8 pm.', ended: 'Thanks! Back on Friday at 8 pm 💙' },
  'pt-BR': { tagline: 'Jogos tranquilos e papo toda sexta 🎮', about: 'Oi! Eu transmito jogos indie e aconchegantes.\nPega um chá e fica à vontade.\nAs lives são toda sexta às 20h.', ended: 'Valeu! Volto sexta às 20h 💙' },
};

async function brandOn(browser, lang) {
  // The pictures go in through the panel's own picture fields, as a streamer adds them: the
  // panel crops and re-encodes them in the browser and uploads every size it needs.
  const ctx = await browser.newContext({ ...DESKTOP, locale: lang });
  const panel = await openPanel(ctx);
  await panel.waitForSelector('[data-testid="live-link"]');
  for (const [field, file] of [
    ['avatar', 'avatar.jpg'],
    ['banner', 'banner.jpg'],
  ]) {
    const input = panel.getByTestId(`brand-file-${field}`);
    if ((await input.count()) === 0) {
      log(`no ${field} picture field in the panel: the page shows no ${field}`);
      continue;
    }
    await input.setInputFiles(path.join(ROOT, 'scripts', 'docs', 'brand-sample', file));
    await panel.getByTestId(`brand-use-${field}`).click();
    await panel.getByTestId(`brand-thumb-${field}`).waitFor({ timeout: 15_000 });
  }
  await ctx.close();
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
  await brandOn(browser, lang);
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
  const s = await state();
  // The live chat as the desktop app's window shows it (its height follows the window's).
  const liveCtx = await browser.newContext({ ...APP_WINDOW, locale: lang });
  const livePanel = await openPanel(liveCtx);
  const live = livePanel.getByTestId('chat-live');
  if ((await live.count()) > 0) {
    await live.getByTestId('chat-msg').first().waitFor({ timeout: 15_000 }).catch(() => log('no chat messages in the panel'));
    await live.getByTestId('chat-input').fill(lang === 'en' ? 'Thanks for coming!' : 'Valeu por virem!');
    await sanitize(livePanel, s);
    // 1 the messages, 2 send as the streamer, 3 flood protection, 4 clear, 5 the chat settings.
    await guideShot(livePanel, live, 'live', lang, 'chat-panel', {
      pad: 16,
      callouts: [live.getByTestId('chat-feed'), live.locator('form.chat-send'), live.getByTestId('chat-protect'), live.getByTestId('chat-clear'), live.getByTestId('chat-settings-link')],
    });
    await live.getByTestId('chat-input').fill('');
    // A viewer's message with its moderation menu open.
    const msg = live.getByTestId('chat-msg').filter({ hasNot: livePanel.getByTestId('chat-badge') }).last();
    if ((await msg.count()) > 0) {
      await msg.getByTestId('chat-more').click();
      await live.getByTestId('chat-menu').waitFor({ timeout: 5_000 });
      await guideShot(livePanel, live.getByTestId('chat-feed'), 'live', lang, 'chat-moderation', { pad: 16, callouts: [live.getByTestId('chat-menu')] });
      await msg.getByTestId('chat-more').click();
    }
  } else log('no live chat in the panel: skipped');
  await liveCtx.close();

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 }, deviceScaleFactor: 1, locale: lang });
  const panel = await openPanel(ctx);
  await panel.waitForSelector('[data-testid="live-link"]');
  const card = panel.getByTestId('chat-card');
  if ((await card.count()) > 0) {
    await panel.getByTestId('chat-settings').waitFor({ timeout: 15_000 });
    // 1 the chat on/off switch, 2 Save chat settings.
    await guideShot(panel, card, 'live', lang, 'chat-settings', { pad: 16, callouts: [panel.getByTestId('chat-enabled'), panel.getByTestId('chat-save')] });
    const gifGroup = panel.locator('fieldset', { has: panel.getByTestId('chat-gif-key') });
    if ((await gifGroup.count()) > 0) {
      await guideShot(panel, gifGroup, 'live', lang, 'gif-settings', { pad: 16, callouts: [panel.getByTestId('chat-gif-key')] });
    }
  } else log('no chat card in the panel: skipped');

  const brandCard = panel.getByTestId('brand-card');
  if ((await brandCard.count()) > 0) {
    await brandOn(browser, lang);
    await panel.reload();
    await panel.getByTestId('brand-name').waitFor({ timeout: 15_000 });
    await sleep(1000);
    await guideShot(panel, brandCard, 'live', lang, 'your-page-card', { pad: 16 });
    await adminApi('POST', '/api/branding/reset', {});
  } else log('no "Your page" card in the panel: skipped');
  await ctx.close();
}

// ---- the app window, the panel's cards and the setup tutorial (guide pictures) ----------

/** The desktop app's window (apps/desktop/src-tauri/src/window.rs). */
const APP_WINDOW = { viewport: { width: 1200, height: 820 }, deviceScaleFactor: 1 };
/** Where "Export logs" says the file went (the e2e server saves it in its temporary folder). */
const DOWNLOADS_SHOWN = '/Users/••••/Downloads';

/** A panel card, found by something inside it (most cards have no test id of their own). */
const cardWith = (page, testid) => page.locator('section.card', { has: page.getByTestId(testid) });
/** The buttons in `loc`, without the (i) tooltips. */
const buttons = (loc) => loc.locator('button:not(.tip-btn)');

/**
 * What the desktop app's first start writes to system-check.json (buildSystemCheck in
 * apps/server/src/desktop/system-check.ts), on a made-up but typical Mac.
 */
function firstRunCheck(version) {
  const results = [
    ['os', 'macOS 15.6 (arm64)', 'macOS 12', ''],
    ['ram', '16.0 GB', '4 GB', '8 GB'],
    ['cpu', '10', '2', '4'],
    ['upload', '62.4 Mbps', '10 Mbps', '50 Mbps'],
    ['download', '312.8 Mbps', '-', '-'],
    ['disk', '212.5 GB', '500 MB', ''],
    ['ports', 'free', '', ''],
    ['obs', 'installed', '', ''],
    ['github', 'reachable', '', ''],
    ['release', `v${version} (desktop app)`, '', ''],
  ].map(([id, value, min, recommended]) => ({ id, status: 'ok', value, min, recommended, detail: '' }));
  const at = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { version: 1, at, os: 'macOS 15.6', arch: 'arm64', results, uploadMbps: 62.4, downloadMbps: 312.8, viewerEstimate: 5, belowMinimum: [], appVersion: version, source: 'desktop' };
}

/**
 * The panel as the desktop app shows it. The e2e server is a plain server, so `context` gets
 * the answers the app's server gives (apps/server/src/desktop/bridge.ts): GET /api/desktop (the
 * Desktop app card; the first-run check `running` or done), "Check for updates" finding nothing
 * newer, and with `check` the first-run check's result.
 */
async function asDesktopApp(context, version, { running = false, check = null } = {}) {
  const info = (update) => ({
    desktop: true,
    version,
    serverVersion: version,
    autostart: { supported: true, enabled: false },
    update,
    updateChecking: false,
    updateChannel: { choice: null, effective: /^\d+\.\d+\.\d+-/.test(version) ? 'beta' : 'stable' },
    systemCheck: running ? 'running' : 'done',
  });
  await context.unrouteAll();
  await context.route('**/api/desktop', (route) => route.fulfill({ json: info(null) }));
  await context.route('**/api/desktop/update/check', (route) => route.fulfill({ json: info({ status: 'none', current: version }) }));
  if (check) await context.route('**/api/system-check', (route) => route.fulfill({ json: check }));
}

/** The app's window: the panel during a live and the steps of the setup tutorial (start/ guides). */
async function captureAppWindow(browser, lang) {
  const s = await state();
  const ctx = await browser.newContext({ ...APP_WINDOW, locale: lang });
  await asDesktopApp(ctx, s.version, { running: true });
  const panel = await openPanel(ctx);
  await panel.waitForSelector('[data-testid="quality-pc"]', { timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  await sanitize(panel, s);
  // 1 status, 2 live link, 3 OBS settings, 4 Viewers & P2P help, 5 the live chat.
  const heading = (testid) => cardWith(panel, testid).locator('h2');
  await panel.getByTestId('chat-live').getByTestId('chat-msg').first().waitFor({ timeout: 15_000 }).catch(() => log('no messages in the live chat'));
  await guideShot(panel, panel.locator('body'), 'start', lang, 'panel', {
    pad: 0,
    viewport: true,
    callouts: [[panel.getByTestId('status'), panel.getByTestId('obs-status')], heading('live-link'), heading('rtmp-url'), heading('viewer-count'), panel.getByTestId('chat-live').locator('h2')],
  });

  const dialog = panel.getByTestId('onboarding');
  const next = () => panel.getByTestId('onb-next').click();
  const step = async (id, name, callouts) => {
    await panel.locator(`[data-testid="onboarding"][data-step="${id}"]`).waitFor();
    await sleep(500);
    await sanitize(panel, s);
    await guideShot(panel, dialog, 'start', lang, name, { pad: 0, callouts });
  };
  await panel.getByTestId('redo-tutorial').click();
  await step('welcome', 'welcome', [panel.getByTestId('onb-next')]);
  await next();
  // Step 2 while the app's first-run check runs, then with its result.
  await step('pc', 'checking', [panel.getByTestId('onb-sys-checking')]);
  await asDesktopApp(ctx, s.version, { check: firstRunCheck(s.version) });
  await panel.reload();
  await panel.getByTestId('redo-tutorial').click();
  await next();
  await panel.getByTestId('onb-syscheck').waitFor();
  await step('pc', 'pc-check', [panel.locator('.onb-sys-list'), panel.getByTestId('onb-next')]);
  await next();
  await next();
  await step('choose', 'where', [panel.getByTestId('onb-route-both'), panel.getByTestId('onb-route-only')]);
  await next();
  // The Copy buttons of the name, the server and the stream key.
  await step('connect', 'obs-step', ['name', 'server', 'key'].map((id) => panel.getByTestId(`onb-copy-${id}`)));
  await next();
  await panel.locator('[data-testid="onb-test-status"][data-status="ok"]').waitFor({ timeout: 30_000 });
  await step('test', 'test-it', [panel.locator('.onb-steps .ok')]);
  await next();
  await step('share', 'share-link', [panel.getByTestId('onb-copy-link')]);
  await next();
  await next();
  await step('finish', 'finish', [panel.getByTestId('onb-finish')]);
  await panel.getByTestId('onb-finish').click();
  await ctx.close();
}

/** The panel's cards for the live/, app/ and help/ guides, while the viewers watch. */
async function capturePanelCards(browser, lang) {
  const s = await state();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 }, deviceScaleFactor: 1, locale: lang });
  await asDesktopApp(ctx, s.version);
  const panel = await openPanel(ctx);
  await panel.waitForSelector('[data-testid="viewers"] tbody tr:nth-child(3)');
  await panel.waitForSelector('[data-testid="quality-pc"]', { timeout: 30_000 }).catch(() => {});
  await sleep(2500);
  await sanitize(panel, s);
  const shoot = (target, section, name, callouts) => guideShot(panel, target, section, lang, name, { pad: 16, callouts });
  const labelOf = (card, testid) => card.locator('label', { has: panel.getByTestId(testid) });

  await shoot(panel.locator('header.top'), 'live', 'status-live', [panel.getByTestId('obs-status'), panel.getByTestId('stop')]);
  // Copy link, Generate new link, Disconnect everyone.
  const link = cardWith(panel, 'live-link');
  await shoot(link, 'live', 'link-card', [0, 1, 2].map((i) => buttons(link).nth(i)));
  // Copy (server), Copy (stream key), "OBS is sending video".
  const obs = cardWith(panel, 'rtmp-url');
  await shoot(obs, 'live', 'obs-card', [buttons(obs).nth(0), buttons(obs).nth(2), obs.locator('.ok-dot')]);
  // Max upload, turn off after, viewers can share the link, allow P2P, max viewers.
  const net = cardWith(panel, 'max-viewers');
  const fields = net.locator('form .field label');
  await shoot(net, 'live', 'limits', [fields.nth(0), fields.nth(1), labelOf(net, 'allow-viewer-share'), labelOf(net, 'allow-viewer-p2p'), labelOf(net, 'max-viewers')]);
  const security = panel.getByTestId('security');
  await shoot(security, 'live', 'protection-card', [panel.getByTestId('threat'), labelOf(security, 'sec-requireBrowserCheck'), labelOf(security, 'sec-blockKnownBadIps')]);
  // Multiple qualities, "Viewers get", "Upload used by SwarmCast".
  const quality = panel.getByTestId('quality-card');
  await shoot(quality, 'live', 'quality-card', [
    labelOf(quality, 'quality-switch'),
    quality.locator('.now-line'),
    quality.locator('input[name="upload-mode"]').first().locator('xpath=preceding::h3[1]'),
  ]);

  // Viewers: Remove from P2P and Kick, then Pedro removed from P2P (and allowed again after).
  const viewers = cardWith(panel, 'viewers');
  const actions = (row) => row.locator('td .actions button');
  const firstRow = viewers.locator('tbody tr').first();
  await shoot(viewers, 'live', 'viewers', [actions(firstRow).first(), firstRow.locator('td .actions button.danger')]);
  const pedro = panel.getByTestId('viewer-Pedro');
  await actions(pedro).first().click();
  await pedro.locator('.badge.off').waitFor({ timeout: 10_000 });
  await sleep(300);
  await shoot(viewers, 'live', 'viewers-removed', [pedro.locator('.badge.off'), actions(pedro).first()]);
  await actions(pedro).first().click();

  const desktop = panel.getByTestId('desktop-card');
  await panel.getByTestId('check-updates').click();
  await panel.getByTestId('up-to-date').waitFor({ timeout: 10_000 });
  await shoot(desktop, 'app', 'desktop-card', [labelOf(desktop, 'autostart'), panel.getByTestId('check-updates')]);

  // "Export logs" and where the file went (the folder shown as a user's Downloads).
  const exported = panel.waitForResponse((r) => new URL(r.url()).pathname === '/api/diagnostics/export');
  await panel.getByTestId('export-logs').click();
  const zip = (await (await exported).json()).path;
  await panel.getByTestId('export-path').waitFor();
  await sanitize(panel, s, [[path.dirname(zip), DOWNLOADS_SHOWN]]);
  await shoot(panel.getByTestId('diagnostics'), 'help', 'export', [panel.getByTestId('export-logs'), panel.getByTestId('export-path'), panel.getByTestId('export-reveal')]);
  await ctx.close();
}

/** The top of the panel after "Stop everything" (go-live guide). SwarmCast stays off. */
async function captureStopped(browser, lang) {
  await adminApi('POST', '/api/live/stop', {});
  await poll('SwarmCast to stop', async () => (await state()).phase === 'off', 60_000);
  const ctx = await browser.newContext({ ...DESKTOP, locale: lang });
  const panel = await openPanel(ctx);
  await panel.getByTestId('start').waitFor();
  await guideShot(panel, panel.locator('header.top'), 'live', lang, 'stopped', { pad: 16, callouts: [panel.getByTestId('status'), panel.getByTestId('start')] });
  await ctx.close();
}

/**
 * The desktop app's window while it starts (first-run guide): its splash page
 * (apps/desktop/splash/) with the brand tokens the app's build puts next to it.
 */
async function captureSplash(browser, lang) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-splash-'));
  try {
    const src = path.join(ROOT, 'apps', 'desktop', 'splash');
    for (const f of ['index.html', 'splash.css', 'splash.js']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    fs.copyFileSync(path.join(ROOT, 'assets', 'brand', 'tokens.css'), path.join(dir, 'tokens.css'));
    const ctx = await browser.newContext({ ...APP_WINDOW, locale: lang });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
    await guideShot(page, page.locator('main.splash'), 'start', lang, 'splash', { pad: 120 });
    await ctx.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Make the window as tall as the page, so a guide picture shows all of it from the top, unfocused. */
async function fitViewport(page) {
  for (let i = 0; i < 3; i++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height <= page.viewportSize().height) break;
    await page.setViewportSize({ width: page.viewportSize().width, height });
  }
  await page.evaluate(() => {
    document.activeElement?.blur();
    scrollTo(0, 0);
  });
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
  await fillChat(lang, desktop.page, phone.page, third.page);

  // Panel.
  const adminCtx = await browser.newContext({ ...DESKTOP, locale: lang });
  const panel = await openPanel(adminCtx);
  await panel.waitForSelector('[data-testid="live-link"]');
  await panel.getByTestId('chat-live').getByText(CHAT_LINES[lang].answer).waitFor({ timeout: 15_000 }).catch(() => log('no live chat in the panel'));
  await panel.waitForSelector('[data-testid="viewers"] tbody tr:nth-child(3)');
  await panel.waitForSelector('[data-testid="quality-pc"]', { timeout: 30_000 }).catch(() => {});
  await sleep(2500);
  const s = await state();

  // (1) Overview: the panel as it opens, down to the viewers list: status, link, OBS, the viewer
  // numbers, connection mode and the viewers list (Phone/PC, P2P), with the live chat on the
  // right as tall as the picture (it fills the window), and the cards below left out. The window
  // is made exactly that tall, so the chat column ends with the list instead of leaving a blank.
  await sanitize(panel, s);
  await panel.evaluate((hidden) => {
    for (const sel of hidden) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
  }, OVERVIEW_HIDDEN);
  const listBottom = await panel.locator('.card-viewers').evaluate((el) => Math.ceil(el.getBoundingClientRect().bottom + scrollY));
  await panel.setViewportSize({ width: DESKTOP.viewport.width, height: Math.max(DESKTOP.viewport.height, listBottom + 24) });
  await panel.evaluate(() => scrollTo(0, 0));
  await sleep(300);
  await panel.screenshot({ path: path.join(OUT_DIR, `panel-overview-${lang}.png`), animations: 'disabled', caret: 'hide' });
  log(`captured panel-overview-${lang}.png`);
  await panel.setViewportSize(DESKTOP.viewport);
  await panel.evaluate((hidden) => {
    for (const sel of hidden) {
      const el = document.querySelector(sel);
      if (el) el.style.display = '';
    }
  }, OVERVIEW_HIDDEN);

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

  // (6b) The chat on the viewer page, for the "Chat" guide: the column with the messages of
  // fillChat (hide, settings, emoji, send), then the viewer's chat settings (name colour).
  if ((await desktop.page.getByTestId('chat').count()) > 0) {
    const lines = CHAT_LINES[lang];
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

  // (6c) The viewer pages for the "Watching" guide, whole: 1 Unmute, 2 the quality menu,
  // 3 Help the stream (P2P), 4 Share. On the phone the chat (40 % of the screen) is hidden, as a viewer
  // can, so the page fits.
  if ((await phone.page.getByTestId('chat-hide').count()) > 0) {
    await phone.page.getByTestId('chat-hide').click();
    // The video moves up under the pointer; away from it, its controls fade out.
    await phone.page.mouse.move(0, 0);
    await sleep(4000);
  }
  for (const [page, name] of [
    [desktop.page, 'watch-desktop'],
    [phone.page, 'watch-phone'],
  ]) {
    await fitViewport(page);
    await guideShot(page, page.locator('body'), 'viewers', lang, name, {
      pad: 0,
      callouts: [page.locator('#unmute'), page.locator('.quality-menu'), page.locator('label.toggle', { has: page.locator('#p2p') }), page.locator('#share')],
    });
  }

  // (6d) The panel's cards and the app's window with the setup tutorial (guide pictures).
  await capturePanelCards(browser, lang);
  await captureAppWindow(browser, lang);

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
  const withLogo = (page) => [page.locator('.site-head .sc-brand'), page.locator('main.card')];
  await guideShot(joinPage, joinPage.locator('main.card'), 'viewers', lang, 'invalid', { pad: 40, area: withLogo(joinPage) });

  // (8b) The join page for the "Watching" guide: 1 nickname, 2 Watch, 3 the browser check.
  // The check's worker is a stand-in here that reports 40 % and then waits, so "Checking your
  // browser…" stays up for the picture (it is gone after a second on a real join).
  const checkCtx = await browser.newContext({ ...DESKTOP, locale: lang });
  await checkCtx.addInitScript(() => {
    window.Worker = class {
      postMessage(challenge) {
        const max = Number(challenge.parameters.data?.max) || 0;
        setTimeout(() => this.onmessage?.({ data: { attempts: Math.round(max * 0.4) } }), 0);
      }
      terminate() {}
    };
  });
  const checkPage = await checkCtx.newPage();
  await checkPage.goto(s.liveLink);
  await checkPage.waitForURL(/\/join$/);
  await checkPage.fill('#nickname', 'Maria');
  await checkPage.locator('#check').waitFor({ timeout: 15_000 });
  await guideShot(checkPage, checkPage.locator('main.card'), 'viewers', lang, 'join', {
    pad: 40,
    area: withLogo(checkPage),
    callouts: [checkPage.locator('#nickname'), checkPage.locator('#join'), checkPage.locator('#check')],
  });

  for (const c of [checkCtx, joinCtx, adminCtx, desktop.context, phone.context, third.context]) await c.close();

  // (9) The streamer's page and GIFs on the viewer side (guide pictures).
  await captureBranding(browser, lang);
  // (10) The panel's chat and "Your page" cards (guide pictures).
  await capturePanelGuides(browser, lang);
  // (11) After "Stop everything", and the app's splash (guide pictures).
  await captureStopped(browser, lang);
  await captureSplash(browser, lang);
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
