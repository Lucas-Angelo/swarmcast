// The built watch page (apps/viewer/dist) served by page.route under a fake origin, with /control
// answered by a MockHub through routeWebSocket: no server, no stream, no network. Shared by the
// mock UI spec (chat-ui.spec.ts) and the corpus rendering spec (chat-render.spec.ts).
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { viewerCsp } from '../../../server/src/public/security.js';
import type { MockHub } from './mock-hub.js';

export const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');
const ORIGIN = 'http://chat.test';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

export function requireBuild(): void {
  if (!fs.existsSync(path.join(DIST, 'watch.html'))) throw new Error('Build the viewer first: npm run build -w @swarmcast/viewer');
}

/** Opens /watch against `hub`; fails on any page error during load. Returns the page errors seen later. */
export async function openWatch(page: Page, hub: MockHub, o: { lang?: 'en' | 'pt-BR'; query?: string } = {}): Promise<string[]> {
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
