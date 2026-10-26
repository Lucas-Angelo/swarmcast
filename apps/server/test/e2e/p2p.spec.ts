import { expect, test, type Page } from '@playwright/test';
import { admin, adminState, currentTime, enableP2P, join, stats, viewerByNick, waitPlaying } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

// Playwright's WebKit build gathers neither STUN (srflx) candidates nor resolvable mDNS
// host candidates, so two WebKit contexts cannot connect over WebRTC. Real Safari can.
test.skip(({ browserName }) => browserName === 'webkit', 'Playwright WebKit has no usable ICE candidates for WebRTC');

// Viewers normally join a stream that has been running for a while. Right after OBS starts
// the playlist is short, players sit at the live edge and every segment is "urgent"
// (fetched over HTTPS), so give the playlist time to fill up first.
test.beforeAll(async () => {
  const { liveLink } = await import('./fixtures.js');
  await liveLink();
  const since = (globalThis as { __scLiveSince?: number }).__scLiveSince ?? Date.now();
  (globalThis as { __scLiveSince?: number }).__scLiveSince = since;
  const wait = 32_000 - (Date.now() - since);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
});

async function connectedPair(browser: import('@playwright/test').Browser, a: string, b: string): Promise<{ pa: Page; pb: Page; close: () => Promise<void> }> {
  const A = await join(browser, a);
  await waitPlaying(A.page);
  await enableP2P(A.page);
  const B = await join(browser, b);
  await waitPlaying(B.page);
  await enableP2P(B.page);
  await expect.poll(async () => (await stats(A.page)).peers.length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await stats(B.page)).peers.length, { timeout: 60_000 }).toBeGreaterThan(0);
  return {
    pa: A.page,
    pb: B.page,
    close: async () => {
      await A.context.close();
      await B.context.close();
    },
  };
}

test('viewers who opt in exchange video over P2P (verified by hash)', async ({ browser, browserName }) => {
  const { pa, pb, close } = await connectedPair(browser, `p2pA-${browserName}`, `p2pB-${browserName}`);
  await expect
    .poll(async () => (await stats(pa)).p2pDownBytes + (await stats(pb)).p2pDownBytes, { timeout: 90_000, intervals: [2000] })
    .toBeGreaterThan(0);
  expect((await stats(pa)).hashFailures + (await stats(pb)).hashFailures).toBe(0);
  await expect.poll(async () => (await adminState()).stats.viewersHelping, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await close();
});

test('"Remove from P2P" disconnects the peer from others while it keeps watching', async ({ browser, browserName }) => {
  const nickB = `revokeB-${browserName}`;
  const { pa, pb, close } = await connectedPair(browser, `revokeA-${browserName}`, nickB);
  const b = await viewerByNick(nickB);
  await admin(`/api/viewers/${b!.sessionId}/p2p`, { allowed: false });
  // A drops every connection to B…
  await expect.poll(async () => (await stats(pa)).peers.length, { timeout: 20_000 }).toBe(0);
  // …B is told it may not use P2P anymore…
  await expect(pb.locator('#p2p')).toBeDisabled();
  await expect.poll(async () => (await stats(pb)).p2pAllowed).toBe(false);
  // …and keeps watching over HTTPS.
  // (polled, so a brief stall on a busy machine doesn't fail the check)
  const t = await currentTime(pb);
  await expect.poll(async () => (await currentTime(pb)) - t, { timeout: 20_000 }).toBeGreaterThan(2);
  // Over the next tracker announce B does not come back.
  await pa.waitForTimeout(15_000);
  expect((await stats(pa)).peers.length).toBe(0);
  expect((await stats(pb)).peers.length).toBe(0);
  await close();
});

test('a malicious peer sending altered data is rejected and removed from P2P', async ({ browser, browserName }) => {
  test.slow();
  const evilNick = `evil-${browserName}`;
  // The malicious viewer joins first so it holds segments the honest one will ask for.
  const evilCtx = await browser.newContext();
  await evilCtx.addInitScript(() => {
    // Corrupt every binary chunk this browser uploads to other peers.
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: unknown) => void;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
      if (data instanceof ArrayBuffer && data.byteLength > 1000) {
        const copy = new Uint8Array(data.slice(0));
        for (let i = 200; i < copy.length; i += 97) copy[i] = copy[i]! ^ 0xff;
        return send.call(this, copy.buffer);
      }
      if (ArrayBuffer.isView(data) && data.byteLength > 1000) {
        const copy = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        for (let i = 200; i < copy.length; i += 97) copy[i] = copy[i]! ^ 0xff;
        return send.call(this, copy);
      }
      return send.call(this, data);
    } as typeof RTCDataChannel.prototype.send;
  });
  const evil = await evilCtx.newPage();
  const { liveLink } = await import('./fixtures.js');
  await evil.goto(await liveLink());
  await evil.fill('#nickname', evilNick);
  await evil.click('#join');
  await waitPlaying(evil);
  await enableP2P(evil);
  await evil.waitForTimeout(6000);

  const honest = await join(browser, `honest-${browserName}`);
  await waitPlaying(honest.page);
  await enableP2P(honest.page);

  await expect.poll(async () => (await stats(honest.page)).hashFailures, { timeout: 120_000, intervals: [2000] }).toBeGreaterThan(0);
  await expect
    .poll(async () => (await viewerByNick(evilNick))?.autoRemovedFromP2P, { timeout: 150_000, intervals: [3000] })
    .toBe(true);
  // The honest viewer never played bad data and keeps watching.
  const t = await currentTime(honest.page);
  await honest.page.waitForTimeout(3000);
  expect(await currentTime(honest.page)).toBeGreaterThan(t + 1.5);
  expect((await adminState()).warnings.join(' ')).toMatch(/removed from P2P automatically/);
  await honest.context.close();
  await evilCtx.close();
});
