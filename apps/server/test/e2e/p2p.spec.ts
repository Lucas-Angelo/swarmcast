import { expect, test, type Page } from '@playwright/test';
import type { AdminState, QualityState } from '@swarmcast/shared';
import {
  admin,
  adminApi,
  adminState,
  currentTime,
  enableP2P,
  join,
  ladderUpdate,
  liveLink,
  reconnectObs,
  setPlaylistWindow,
  stallReport,
  startStallMonitor,
  stats,
  viewerByNick,
  waitPlaying,
} from './fixtures.js';

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

test('"Remove from P2P" disconnects the peer from others while it keeps watching', async ({ browser, browserName }, testInfo) => {
  // One nickname per attempt: on a retry, the previous attempt's session is still listed.
  const nickB = `revokeB-${browserName}-${testInfo.retry}`;
  const { pa, pb, close } = await connectedPair(browser, `revokeA-${browserName}-${testInfo.retry}`, nickB);
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

test('"Allow P2P for viewers" off in the panel stops P2P for everyone live; viewers keep watching', async ({ browser, browserName }) => {
  const { context, page } = await join(browser, `allp2p-${browserName}`);
  await waitPlaying(page);
  await enableP2P(page);
  const settings = (await adminState()).settings;
  try {
    await adminApi<AdminState['settings']>('PUT', '/api/settings', { ...settings, allowViewerP2P: false });
    await expect(page.locator('#p2p')).toBeDisabled();
    await expect(page.locator('#p2p')).not.toBeChecked();
    await expect(page.locator('#p2p-stats')).toContainText('turned off P2P for this live');
    expect((await stats(page)).p2pEnabled).toBe(false);
    expect((await adminState()).settings.allowViewerP2P).toBe(false);
    const t = await currentTime(page);
    await expect.poll(async () => (await currentTime(page)) - t, { timeout: 20_000 }).toBeGreaterThan(2);
  } finally {
    await adminApi('PUT', '/api/settings', { ...settings, allowViewerP2P: true });
  }
  // Back on: the viewer's own choice (on) applies again.
  await expect(page.locator('#p2p')).toBeEnabled();
  await expect(page.locator('#p2p')).toBeChecked();
  expect((await stats(page)).p2pEnabled).toBe(true);
  await context.close();
});

// Regression for the "frozen forever after one stall" bug (P2P on, quality ladder on):
// - the ladder's audio playlist held only 20 s (1 s segments, 20 entries) on v0.2.0 servers,
//   emulated here with a 20 s playlist window; the Stable profile played 20 s behind live;
// - p2p-media-loader kept requests for segments that slid out of the playlist pending forever;
// - after a stall hls.js jumped to before the oldest audio segment and never played again.
// Next to a peer that accepts the WebRTC connection but trickles data (one chunk every 1.8 s:
// just under the core's 2 s no-bytes timeout, so the core never gives up on it), with a P2P
// core that does not fall back to HTTPS by itself, a P2P viewer must keep playing, and must
// come back by itself after a forced stall (network throttled). The viewer before the fix
// froze here within seconds.
test('a peer that barely delivers never starves playback, even after a forced stall', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'network throttling needs CDP (Chromium)');
  test.skip(process.platform === 'win32', 'uses SIGUSR2 to reconnect the fake OBS');
  const q0 = await adminApi<QualityState>('GET', '/api/quality');
  test.skip(!q0.ffmpeg.available, 'no ffmpeg on this machine (set SWARMCAST_FFMPEG)');
  test.setTimeout(480_000);

  const contexts: Array<{ close(): Promise<void> }> = [];
  try {
    await setPlaylistWindow(20);
    await adminApi('PUT', '/api/quality', ladderUpdate(q0, { mode: 'manual', enabled: true, heights: [480, 360], encoder: 'libx264' }));
    reconnectObs({ size: '1280x720', kbps: 2500 });
    await expect
      .poll(async () => (await adminApi<QualityState>('GET', '/api/quality')).variants.map((v) => v.height), { timeout: 120_000, intervals: [1000] })
      .toEqual([720, 480, 360]);
    // Let the playlists fill up (the audio one to its 20 s window).
    await new Promise((r) => setTimeout(r, 25_000));

    // The bad peer joins first, so it holds segments the honest viewer will ask it for.
    // Both on 480p: one swarm per quality, so they are peers of each other.
    const same480 = (c: import('@playwright/test').BrowserContext) => c.addInitScript(() => localStorage.setItem('sc.quality-height', '480'));
    const slowCtx = await browser.newContext();
    contexts.push(slowCtx);
    await same480(slowCtx);
    await slowCtx.addInitScript(() => {
      const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: unknown) => void;
      let chain = Promise.resolve();
      RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
        // Every message goes through one queue so the protocol order is kept; only the data
        // chunks (> 1000 bytes) wait.
        const binary = (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) && data.byteLength > 1000;
        const copy =
          typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer
              ? data.slice(0)
              : new Uint8Array((data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength));
        chain = chain
          .then(() => new Promise((r) => setTimeout(r, binary ? 1800 : 0)))
          .then(() => {
            if (this.readyState === 'open') send.call(this, copy);
          })
          .catch(() => {});
      } as typeof RTCDataChannel.prototype.send;
    });
    const slow = await slowCtx.newPage();
    await slow.goto(await liveLink());
    await slow.fill('#nickname', `trickle-${browserName}`);
    await slow.click('#join');
    await waitPlaying(slow);
    await enableP2P(slow);
    await slow.waitForTimeout(8000);

    // The honest viewer is on a tunnel-like link (300 ms round trip), like real viewers.
    const TUNNEL = { offline: false, latency: 300, downloadThroughput: -1, uploadThroughput: -1 };
    const ctx = await browser.newContext();
    contexts.push(ctx);
    await same480(ctx);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', TUNNEL);
    await page.goto(await liveLink());
    await page.fill('#nickname', `steady-${browserName}`);
    await page.click('#join');
    await waitPlaying(page);
    await enableP2P(page);
    // Fault injection: the P2P core may no longer fetch anything over HTTPS by itself, only
    // from peers. That is the state seen live, where the core held a soon-needed segment
    // without ever starting it; here it holds every segment, waiting for the trickling peer.
    await page.evaluate(() => {
      const none = { simultaneousHttpDownloads: 0 };
      (window as unknown as { __hls: { p2pEngine: { applyDynamicConfig(c: unknown): void } } }).__hls.p2pEngine.applyDynamicConfig({ core: { ...none, mainStream: none, secondaryStream: none } });
    });
    await expect.poll(async () => (await stats(page)).peers.length, { timeout: 90_000 }).toBeGreaterThan(0);

    // 60 s of normal playback next to the trickling peer: no stall longer than a few seconds.
    await startStallMonitor(page);
    await page.waitForTimeout(60_000);
    const before = await stallReport(page);
    expect(before.maxStallMs, 'stall next to a slow peer').toBeLessThan(4000);

    // Forced stall: 25 s at 40 kbit/s drains the buffer and pushes the delay past the
    // catch-up limit, which is where the old player froze for good.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 5000, uploadThroughput: 5000 });
    await page.waitForTimeout(25_000);
    await cdp.send('Network.emulateNetworkConditions', TUNNEL);

    // It comes back by itself...
    await expect.poll(async () => (await stallReport(page)).currentStallMs, { timeout: 25_000, intervals: [1000] }).toBe(0);
    // ...and keeps playing smoothly.
    await startStallMonitor(page);
    await page.waitForTimeout(30_000);
    const after = await stallReport(page);
    // Media played, not currentTime − t0: the stall watchdog may reload the source, which
    // restarts the timeline (currentTime jumps back) without any loss of playback.
    expect(after.playedS, 'media played after the forced stall').toBeGreaterThan(25);
    expect(after.maxStallMs, 'stall after recovering').toBeLessThan(4000);
    const s = await stats(page);
    console.log(`steady viewer: ${s.httpFallbacks} HTTPS fallbacks, ${s.peersDropped} peers dropped, ${s.stallRecoveries} stall recoveries, ${Math.round(s.p2pDownBytes / 1024)} kB over P2P`);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await setPlaylistWindow(40);
    const q = await adminApi<QualityState>('GET', '/api/quality');
    await adminApi('PUT', '/api/quality', ladderUpdate(q, { mode: 'manual', enabled: false }));
    reconnectObs(null);
    await expect.poll(async () => (await adminApi<QualityState>('GET', '/api/quality')).variants.length, { timeout: 90_000, intervals: [1000] }).toBeLessThanOrEqual(1);
  }
});
