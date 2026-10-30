// A Cloudflare quick tunnel counts every open WebSocket against its 200-requests-in-flight
// limit (docs/ARCHITECTURE.md), so a viewer keeps exactly one: /control, which also carries the
// WebTorrent tracker (apps/viewer/src/tracker-mux.ts) as a channel, not a socket. Once the
// tracker has answered an announce over that channel, p2p-media-loader has set up every tracker
// connection it uses. That the tracker really works over it is covered by p2p.spec.ts (peers
// find each other through it).
import { enableP2P, expect, test, trackerTraffic, uid, waitPlaying, webSockets } from './fixtures.js';

test('a viewer holds one WebSocket; the tracker rides on /control', { tag: '@ui' }, async ({ viewers }) => {
  // Arrange
  let sockets: string[] = [];
  let tracker: ReturnType<typeof trackerTraffic> | undefined;
  const { page } = await viewers.join(uid('onesocket'), {
    setup: async (context) => {
      sockets = webSockets(context);
      tracker = trackerTraffic(context);
    },
  });
  await waitPlaying(page);

  // Act
  await enableP2P(page);

  // Assert
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __swarmcast: { trackerChannels: number } }).__swarmcast.trackerChannels), { timeout: 30_000 })
    .toBe(1);
  await expect.poll(() => tracker!.received.some((m) => m.body.action === 'announce' && m.body.interval !== undefined), { message: 'an announce answered over the channel' }).toBe(true);
  expect(sockets).toEqual(['/control']);
});
