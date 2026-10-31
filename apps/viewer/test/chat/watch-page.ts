// The built viewer pages (apps/viewer/dist) served by page.route under a fake origin: /watch with
// /control answered by a MockHub through routeWebSocket, /join with the branding answered by the
// test. No server, no stream, no network. Shared by the mock UI spec (chat-ui.spec.ts), the corpus
// rendering spec (chat-render.spec.ts) and the join page spec (join-brand.spec.ts).
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type Page, type Route } from '@playwright/test';
import { viewerCsp } from '../../../server/src/public/security.js';
import type { MockHub } from './mock-hub.js';

export const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');
const ORIGIN = 'http://chat.test';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

export function requireBuild(): void {
  if (!fs.existsSync(path.join(DIST, 'watch.html'))) throw new Error('Build the viewer first: npm run build -w @swarmcast/viewer');
}

/** Emoji and the scripts the specs use: each one sends the engine to the system fonts. */
export const WARM_TEXTS = ['Hi 😀👍🎉❤️', 'Привет', 'Ζωή', 'Nguyễn', 'नमस्ते', 'עדי', 'محمد', 'アナ 漢字', '한국어', 'ประเสริฐ', 'క్షమ'];
const warmed = new WeakSet<Browser>();

/**
 * Lays out `texts` once on a blank page of the same origin, before the page under test. The first
 * emoji or text in a script the page fonts lack makes the browser load and scan the system fonts
 * for a fallback: once per browser process, but seconds on a fresh CI runner (7 s in Firefox on
 * Windows, and Chrome on macOS), during which the page does not paint. A real visitor's browser
 * has done it long before; a test that times the watch page would time this instead. openWatch
 * does it for the first page of each browser; a spec with other scripts can add its own texts.
 */
export async function warmFontFallback(page: Page, texts: readonly string[] = []): Promise<void> {
  await page.route(`${ORIGIN}/warm`, (route) => route.fulfill({ body: '<!doctype html><meta charset="utf-8"><title>warm</title>', contentType: 'text/html' }));
  await page.goto(`${ORIGIN}/warm`);
  await page.evaluate(async (list) => {
    for (const t of list) {
      const p = document.createElement('p');
      p.textContent = t;
      document.body.append(p);
    }
    document.body.getBoundingClientRect();
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, [...WARM_TEXTS, ...texts]);
  await page.unroute(`${ORIGIN}/warm`);
  const browser = page.context().browser();
  if (browser) warmed.add(browser);
}

/**
 * A screenshot for review (not a check), taken once the page looks finished: its fonts loaded,
 * every image in view decoded (emotes load lazily), CSS transitions and the caret frozen. Waits on
 * those conditions, never on a fixed delay.
 */
export async function reviewScreenshot(page: Page, options: { path?: string; fullPage?: boolean } = {}): Promise<Buffer> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images]
          .filter((img) => {
            const r = img.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
          })
          .every((img) => img.complete),
      ),
    )
    .toBe(true);
  return page.screenshot({ ...options, animations: 'disabled', caret: 'hide' });
}

/** Answers one request of the page to the server (an API route), or says it is not one (false). */
type ApiRoutes = (route: Route, url: URL) => Promise<void> | false;

/** The pages the server serves by path. */
const PAGES: Record<string, string> = { '/watch': 'watch.html', '/join': 'join.html' };

/**
 * Serves the built viewer under ORIGIN with the server's viewer CSP: `api` answers first, then
 * the pages and their files from apps/viewer/dist (404 for anything else).
 */
async function serveViewer(page: Page, api: ApiRoutes): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const answered = api(route, url);
    if (answered) return answered;
    const file = PAGES[url.pathname] ?? url.pathname.slice(1);
    const full = path.resolve(DIST, file);
    if (!full.startsWith(DIST + path.sep)) return route.fulfill({ status: 404, body: 'not found' });
    // One read, no check first: a missing file or a folder is a 404 here.
    let body: Buffer;
    try {
      body = fs.readFileSync(full);
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({
      body,
      headers: { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream', 'content-security-policy': viewerCsp('chat.test', false), 'referrer-policy': 'no-referrer' },
    });
  });
}

/** Watch page options: the page's language and extra query string (starting with "&"). */
type WatchOptions = { lang?: 'en' | 'pt-BR'; query?: string };

/** Opens /watch against `hub`; fails on any page error during load. Returns the page errors seen later. */
export async function openWatch(page: Page, hub: MockHub, o: WatchOptions = {}): Promise<string[]> {
  const browser = page.context().browser();
  if (browser && !warmed.has(browser)) await warmFontFallback(page);
  const errors = await loadWatch(page, hub, o);
  await expect(page.getByTestId('chat')).toBeVisible();
  expect(errors).toEqual([]);
  return errors;
}

/**
 * Serves /watch against `hub` and navigates to it, without checking anything (openWatch checks;
 * globalSetup only renders the page). Returns the page errors, collected from now on.
 */
export async function loadWatch(page: Page, hub: MockHub, o: WatchOptions = {}): Promise<string[]> {
  await serveViewer(page, (route, url) => {
    if (url.pathname === '/api/config') {
      return route.fulfill({
        json: { sessionId: 's1', nickname: hub.nickname, manifestPublicKey: 'AAAA', playlistUrl: '/hls/index.m3u8', manifestUrl: '/hls/manifest.json', trackerUrl: 'ws://chat.test/tracker', controlUrl: 'ws://chat.test/control', stunServers: [], swarmId: 'x', p2pAllowed: false, segmentDurationS: 2 },
      });
    }
    if (url.pathname === '/api/session/refresh') return route.fulfill({ status: 204 });
    return false;
  });
  await page.routeWebSocket(`ws://chat.test/control`, (ws) => {
    const send = (m: string): void => ws.send(m);
    const detach = hub.attach(send);
    ws.onMessage((m) => hub.onFrame(send, String(m)));
    ws.onClose(() => detach());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/watch?lang=${o.lang ?? 'en'}${o.query ?? ''}`);
  return errors;
}

/**
 * A stylesheet openJoin adds to the join page: CSS animations stand still, like the scripts' time
 * under page.clock, and move only when a test sets their time (document.getAnimations()).
 */
const PAUSED_ANIMATIONS = '/__test__/paused-animations.css';
const joinHtml = (): string => fs.readFileSync(path.join(DIST, 'join.html'), 'utf8');

/** A 1×1 PNG for the streamer's pictures (/brand/<hash>.png). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/**
 * Opens /join (English) with /api/brand answered by `brand` once it settles (a test holds it to
 * see the page before and after its branding), the theme empty, the streamer's pictures 1×1, no
 * browser check and its CSS animations paused (PAUSED_ANIMATIONS). `withoutScripts`: the page's
 * scripts fail to load (and the page reloads itself, its startup guard). Fails on any page error
 * during load. `joins` collects the POST /api/join bodies the page sends; each one is answered
 * with a redirect to /watch. `loads()` counts the join pages the browser has shown (commits).
 */
export async function openJoin(page: Page, o: { brand: Promise<unknown>; withoutScripts?: boolean }): Promise<{ joins: unknown[]; loads: () => number }> {
  const joins: unknown[] = [];
  let loads = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname === '/join') loads++;
  });
  await serveViewer(page, (route, url) => {
    if (url.pathname === PAUSED_ANIMATIONS) return route.fulfill({ body: '*, *::before, *::after { animation-play-state: paused !important; }', contentType: 'text/css' });
    if (url.pathname === '/join') return route.fulfill({ body: joinHtml().replace('</head>', `<link rel="stylesheet" href="${PAUSED_ANIMATIONS}" /></head>`), contentType: 'text/html', headers: { 'content-security-policy': viewerCsp('chat.test', false) } });
    if (o.withoutScripts && url.pathname.endsWith('.js')) return route.fulfill({ status: 404, body: 'not found' });
    if (url.pathname === '/api/brand') return o.brand.then((json) => route.fulfill({ json }));
    if (url.pathname === '/api/join/challenge') return route.fulfill({ json: { required: false } });
    if (url.pathname === '/api/join') {
      joins.push(route.request().postDataJSON());
      return route.fulfill({ json: { redirect: '/watch' } });
    }
    if (url.pathname === '/brand/theme.css') return route.fulfill({ body: '/* */', contentType: 'text/css' });
    if (/^\/brand\/[0-9a-f]{64}\.png$/.test(url.pathname)) return route.fulfill({ body: PNG, contentType: 'image/png' });
    return false;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/join?lang=en`);
  expect(errors).toEqual([]);
  return { joins, loads: () => loads };
}

/** The one built file of `dir` (under DIST) whose name matches `pattern`, as a URL path. */
function builtFile(dir: string, pattern: RegExp): string {
  const found = fs.readdirSync(path.join(DIST, dir)).filter((f) => pattern.test(f));
  if (found.length !== 1) throw new Error(`expected one ${pattern} in ${dir}, found ${found.join(', ') || 'none'}`);
  return `/${dir}/${found[0]}`;
}

/**
 * Opens /watch with only its branding running: the page's markup and styles, the real branding
 * chunk and stylesheet, and /api/brand answered by `brand`. The player stays as the markup and
 * styles make it (no stream behind the mock), and the test plays the player's part: the page's
 * `window.__stage.firstFrame()` is what the player calls on its first fragment (watch.ts). The
 * streamer's pictures are a small real WebP.
 */
export async function openBrandedStage(page: Page, o: { brand: unknown }): Promise<void> {
  const html = fs.readFileSync(path.join(DIST, 'watch.html'), 'utf8');
  const entry = /<script type="module"[^>]*src="(\/assets\/watch-[^"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error('no watch entry script in dist/watch.html');
  const brandJs = builtFile('assets', /^brand-[\w-]+\.js$/);
  const brandCss = builtFile('assets', /^brand-[\w-]+\.css$/);
  const picture = fs.readFileSync(path.resolve(DIST, '..', '..', '..', 'assets', 'brand', 'emotes', 'bee@2x.webp'));
  const driver = `
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = ${JSON.stringify(brandCss)};
    const loaded = new Promise((resolve) => css.addEventListener('load', resolve, { once: true }));
    document.head.append(css);
    await loaded;
    const { startBrand } = await import(${JSON.stringify(brandJs)});
    const brand = startBrand('watch');
    await brand.refresh();
    window.__stage = { firstFrame: () => brand.firstFrame() };
    document.body.dataset.stage = 'branded';
  `;
  await serveViewer(page, (route, url) => {
    if (url.pathname === entry) return route.fulfill({ body: driver, contentType: 'text/javascript' });
    if (url.pathname === '/api/brand') return route.fulfill({ json: o.brand });
    if (url.pathname === '/brand/theme.css') return route.fulfill({ body: '/* */', contentType: 'text/css' });
    if (/^\/brand\/[0-9a-f]{64}\.webp$/.test(url.pathname)) return route.fulfill({ body: picture, contentType: 'image/webp' });
    return false;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/watch?lang=en`);
  await expect(page.locator('body')).toHaveAttribute('data-stage', 'branded');
  expect(errors).toEqual([]);
}
