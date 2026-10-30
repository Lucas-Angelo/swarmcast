// The built watch page (apps/viewer/dist) served by page.route under a fake origin, with /control
// answered by a MockHub through routeWebSocket: no server, no stream, no network. Shared by the
// mock UI spec (chat-ui.spec.ts) and the corpus rendering spec (chat-render.spec.ts).
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { viewerCsp } from '../../../server/src/public/security.js';
import type { MockHub } from './mock-hub.js';

export const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');
const ORIGIN = 'http://chat.test';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

export function requireBuild(): void {
  if (!fs.existsSync(path.join(DIST, 'watch.html'))) throw new Error('Build the viewer first: npm run build -w @swarmcast/viewer');
}

/** Emoji and the scripts the specs use: each one sends the engine to the system fonts. */
const WARM_TEXTS = ['Hi 😀👍🎉❤️', 'Привет', 'Ζωή', 'Nguyễn', 'नमस्ते', 'עדי', 'محمد', 'アナ 漢字', '한국어', 'ประเสริฐ', 'క్షమ'];
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

/** Opens /watch against `hub`; fails on any page error during load. Returns the page errors seen later. */
export async function openWatch(page: Page, hub: MockHub, o: { lang?: 'en' | 'pt-BR'; query?: string } = {}): Promise<string[]> {
  const browser = page.context().browser();
  if (browser && !warmed.has(browser)) await warmFontFallback(page);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/config') {
      return route.fulfill({
        json: { sessionId: 's1', nickname: hub.nickname, manifestPublicKey: 'AAAA', playlistUrl: '/hls/index.m3u8', manifestUrl: '/hls/manifest.json', trackerUrl: 'ws://chat.test/tracker', controlUrl: 'ws://chat.test/control', stunServers: [], swarmId: 'x', p2pAllowed: false, segmentDurationS: 2 },
      });
    }
    if (url.pathname === '/api/session/refresh') return route.fulfill({ status: 204 });
    const file = url.pathname === '/watch' ? 'watch.html' : url.pathname.slice(1);
    const full = path.resolve(DIST, file);
    if (!full.startsWith(DIST + path.sep)) return route.fulfill({ status: 404, body: 'not found' });
    // One read, no check first: a missing file or a folder simply fails here.
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
  await page.routeWebSocket(`ws://chat.test/control`, (ws) => {
    const send = (m: string): void => ws.send(m);
    const detach = hub.attach(send);
    ws.onMessage((m) => hub.onFrame(send, String(m)));
    ws.onClose(() => detach());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/watch?lang=${o.lang ?? 'en'}${o.query ?? ''}`);
  await expect(page.getByTestId('chat')).toBeVisible();
  expect(errors).toEqual([]);
  return errors;
}
