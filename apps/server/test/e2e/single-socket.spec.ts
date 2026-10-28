import { enableP2P, expect, liveLink, test, uid, waitPlaying } from './fixtures.js';

// A Cloudflare quick tunnel counts every open WebSocket against its 200-requests-in-flight
// limit (docs/ARCHITECTURE.md), so a viewer keeps exactly one: /control, which also carries the
// WebTorrent tracker (apps/viewer/src/tracker-mux.ts). That the tracker really works over it
// is covered by p2p.spec.ts (peers find each other through it).
test('a viewer holds one WebSocket; the tracker rides on /control', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(new URL(ws.url()).pathname));
  await page.goto(await liveLink());
  await expect(page).toHaveURL(/\/join$/);
  await page.fill('#nickname', uid('onesocket'));
  await page.click('#join');
  await expect(page).toHaveURL(/\/watch$/);
  await waitPlaying(page);
  await enableP2P(page);
  // p2p-media-loader opened its tracker connection: as a channel, not a socket.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __swarmcast: { trackerChannels: number } }).__swarmcast.trackerChannels), { timeout: 30_000 })
    .toBe(1);
  await page.waitForTimeout(3000);
  expect(sockets).toEqual(['/control']);
  await context.close();
});
