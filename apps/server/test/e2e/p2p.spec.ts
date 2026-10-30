// P2P between viewers who opt in (Chromium and Firefox): segments travel between peers verified
// by hash; "Remove from P2P" disconnects a peer from the others while it keeps watching over
// HTTPS, and the tracker no longer pairs it (the tracker's next answer to the other viewer
// counts a swarm of one); a malicious peer that alters what it uploads is caught by the hash
// check and removed from P2P automatically while the honest viewer keeps watching; the panel's
// "Allow P2P for viewers" stops P2P for everyone live, and the viewers' own choice applies again
// when it is back on. Playwright's WebKit build gathers neither STUN (srflx) candidates nor
// resolvable mDNS host candidates, so two WebKit contexts cannot connect over WebRTC (real Safari
// can). Viewers normally join a stream that has run for a while, so every test waits until the
// playlist holds 32 s (at once when it does): right after OBS starts, players sit at the live
// edge and every segment is urgent (fetched over HTTPS). A peer joins first when it must hold
// the segments the other viewer will ask it for.
//
// "A peer that barely delivers" is the regression test for "frozen forever after one stall" (P2P
// on, quality ladder on): the ladder's audio playlist held only 20 s (1 s segments, 20 entries)
// on v0.2.0 servers, emulated with a 20 s playlist window, and the Stable profile played 20 s
// behind live; p2p-media-loader kept requests for segments that slid out of the playlist pending
// forever; after a stall hls.js jumped to before the oldest audio segment and never played
// again. Next to a peer that accepts the WebRTC connection but trickles data (one chunk every
// 1.8 s: just under the core's 2 s no-bytes timeout, so the core never gives up on it), with a
// P2P core that does not fall back to HTTPS by itself, a P2P viewer must keep playing, and must
// come back by itself after a forced stall (network throttled). The viewer before the fix froze
// here within seconds. Fault injection: the P2P core may no longer fetch anything over HTTPS by
// itself, only from peers, the state seen live, where the core held a soon-needed segment
// without ever starting it; here it holds every segment, waiting for the trickling peer. Load:
// one transcoded rung (480p; both viewers watch it: one swarm per quality, so they are peers of
// each other) from a pre-encoded 720p feed, so a 4-vCPU runner encodes as little as the scenario
// needs next to Chrome and the throttle. The honest viewer is on a tunnel-like link (300 ms
// round trip), like real viewers. Media played is measured, not currentTime − t0: the stall
// watchdog may reload the source, which restarts the timeline without any loss of playback.
// This link (300 ms RTT, a trickling peer, the CPU ladder) has many short stalls by design:
// measured locally, the player plays 25–27 s of 30 s with or without the adaptive delay, so the
// bar is two thirds; starvation itself is the longest stall. Recovered for real means playing
// on, not starting over (a source reload restarts the timeline). The server goes back to one
// quality, a 40 s window and the default feed at the next test's gate.
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import type { AdminState, QualityState } from '@swarmcast/shared';
import {
  admin,
  adminApi,
  adminState,
  enableP2P,
  expect,
  ladderUpdate,
  measuredWindow,
  playsOn,
  reconnectObs,
  setPlaylistWindow,
  stallReport,
  startStallMonitor,
  stats,
  test,
  trackerTraffic,
  uid,
  unmute,
  viewerByNick,
  waitForPlaylist,
  waitPlaying,
  type Audience,
  type TrackerMessage,
  type Viewer,
} from './fixtures.js';

test.skip(({ browserName }) => browserName === 'webkit', 'Playwright WebKit has no usable ICE candidates for WebRTC');

test.beforeEach(async () => {
  await waitForPlaylist(32);
});

/** Normal playback next to the trickling peer, then after the recovery: measured windows. */
const SOAK_BEFORE_MS = 40_000;
const SOAK_AFTER_MS = 20_000;
/** The forced stall: 25 s at 40 kbit/s drains the buffer and pushes the delay past the catch-up limit, where the old player froze for good. */
const FORCED_STALL_MS = 25_000;
const STARVED = { offline: false, latency: 300, downloadThroughput: 5000, uploadThroughput: 5000 } as const;
const TUNNEL = { offline: false, latency: 300, downloadThroughput: -1, uploadThroughput: -1 } as const;
/** How long the trickling peer holds each data chunk: just under the P2P core's 2 s no-bytes timeout. */
const TRICKLE_MS = 1800;

/** Seconds of video buffered ahead of the playhead (what a peer can share right now). */
function bufferAhead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector('video')!;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5 && v.currentTime < v.buffered.end(i)) return v.buffered.end(i) - v.currentTime;
    return 0;
  });
}

const peerCount = async (page: Page): Promise<number> => (await stats(page)).peers.length;

/** The tracker's answer to an announce (it carries the swarm's size and the next interval). */
const isAnnounceAnswer = (m: TrackerMessage): boolean => m.body.action === 'announce' && typeof m.body.interval === 'number';
const swarmSize = (m: TrackerMessage): number => (m.body.complete ?? 0) + (m.body.incomplete ?? 0);

/** A viewer who joined and opted in to P2P; its tracker messages are recorded from the start. */
async function p2pViewer(viewers: Audience, nickname: string): Promise<Viewer & { tracker: ReturnType<typeof trackerTraffic> }> {
  let tracker: ReturnType<typeof trackerTraffic> | undefined;
  const v = await viewers.join(nickname, {
    setup: async (c) => {
      tracker = trackerTraffic(c);
    },
  });
  await waitPlaying(v.page);
  await enableP2P(v.page);
  return { ...v, tracker: tracker! };
}

/** Two viewers who opted in to P2P and see each other as peers. */
async function connectedPair(viewers: Audience, a: string, b: string): Promise<[Awaited<ReturnType<typeof p2pViewer>>, Awaited<ReturnType<typeof p2pViewer>>]> {
  const A = await p2pViewer(viewers, a);
  const B = await p2pViewer(viewers, b);
  await expect.poll(() => peerCount(A.page), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => peerCount(B.page), { timeout: 60_000 }).toBeGreaterThan(0);
  return [A, B];
}

/** In `context`, every binary chunk the page uploads to other peers has bytes flipped. */
async function corruptUploads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
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
}

/**
 * In `context`, every data chunk (> 1000 bytes) the page uploads waits `ms` before it goes out;
 * every message goes through one queue, so the protocol order is kept.
 */
async function trickleUploads(context: BrowserContext, ms: number): Promise<void> {
  await context.addInitScript((delay) => {
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: unknown) => void;
    let chain = Promise.resolve();
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
      const binary = (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) && data.byteLength > 1000;
      const copy =
        typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
            ? data.slice(0)
            : new Uint8Array((data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength));
      chain = chain
        .then(() => new Promise((r) => setTimeout(r, binary ? delay : 0)))
        .then(() => {
          if (this.readyState === 'open') send.call(this, copy);
        })
        // A channel that closes while chunks wait: the peer is gone, the queue goes on.
        .catch(() => {});
    } as typeof RTCDataChannel.prototype.send;
  }, ms);
}

/** In `context`, the player starts on the 480p rendition (the remembered pick). */
async function watch480(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => localStorage.setItem('sc.quality-height', '480'));
}

test('viewers who opt in exchange video over P2P (verified by hash)', { tag: '@media' }, async ({ viewers }) => {
  // Act
  const [A, B] = await connectedPair(viewers, uid('p2pA'), uid('p2pB'));

  // Assert
  await expect.poll(async () => (await stats(A.page)).p2pDownBytes + (await stats(B.page)).p2pDownBytes, { timeout: 90_000, intervals: [2000] }).toBeGreaterThan(0);
  expect((await stats(A.page)).hashFailures + (await stats(B.page)).hashFailures).toBe(0);
  await expect.poll(async () => (await adminState()).stats.viewersHelping, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
});

test('"Remove from P2P" disconnects the peer from others while it keeps watching', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const nickB = uid('revokeB');
  const [A, B] = await connectedPair(viewers, uid('revokeA'), nickB);
  const b = await viewerByNick(nickB);

  // Act
  const revokedAt = Date.now();
  await admin(`/api/viewers/${b!.sessionId}/p2p`, { allowed: false });

  // Assert
  await expect.poll(() => peerCount(A.page), { timeout: 20_000 }).toBe(0);
  await expect(B.page.locator('#p2p')).toBeDisabled();
  await expect.poll(async () => (await stats(B.page)).p2pAllowed).toBe(false);
  await playsOn(B.page, 2, { timeout: 20_000 });
  await expect
    .poll(() => A.tracker.received.some((m) => m.at > revokedAt && isAnnounceAnswer(m) && swarmSize(m) === 1), { message: "the tracker's next answer to A counts a swarm of one" })
    .toBe(true);
  expect(await peerCount(A.page)).toBe(0);
  expect(await peerCount(B.page)).toBe(0);
});

test('a malicious peer sending altered data is rejected and removed from P2P', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  test.slow();
  const evilNick = uid('evil');
  const evil = await viewers.join(evilNick, { setup: corruptUploads });
  await waitPlaying(evil.page);
  await enableP2P(evil.page);
  await expect.poll(() => bufferAhead(evil.page), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(6);

  // Act
  const honest = await viewers.join(uid('honest'));
  await waitPlaying(honest.page);
  await enableP2P(honest.page);

  // Assert
  await expect.poll(async () => (await stats(honest.page)).hashFailures, { timeout: 120_000, intervals: [2000] }).toBeGreaterThan(0);
  await expect.poll(async () => (await viewerByNick(evilNick))?.autoRemovedFromP2P, { timeout: 150_000, intervals: [3000] }).toBe(true);
  await playsOn(honest.page, 1.5, { timeout: 15_000 });
  expect((await adminState()).warnings.join(' ')).toMatch(/removed from P2P automatically/);
});

test('"Allow P2P for viewers" off in the panel stops P2P for everyone live; viewers keep watching', { tag: '@media' }, async ({ viewers }) => {
  // Arrange
  const { page } = await p2pViewer(viewers, uid('allp2p'));
  const settings = (await adminState()).settings;

  // Act
  await adminApi<AdminState['settings']>('PUT', '/api/settings', { ...settings, allowViewerP2P: false });

  // Assert
  await expect(page.locator('#p2p')).toBeDisabled();
  await expect(page.locator('#p2p')).not.toBeChecked();
  await expect(page.locator('#p2p-stats')).toContainText('turned off P2P for this live');
  expect((await stats(page)).p2pEnabled).toBe(false);
  expect((await adminState()).settings.allowViewerP2P).toBe(false);
  await playsOn(page, 2, { timeout: 20_000 });

  // Act
  await adminApi('PUT', '/api/settings', { ...settings, allowViewerP2P: true });

  // Assert
  await expect(page.locator('#p2p')).toBeEnabled();
  await expect(page.locator('#p2p')).toBeChecked();
  expect((await stats(page)).p2pEnabled).toBe(true);
});

test('a peer that barely delivers never starves playback, even after a forced stall', { tag: '@media' }, async ({ viewers, browserName }) => {
  // Arrange
  test.skip(browserName !== 'chromium', 'network throttling needs CDP (Chromium)');
  const q0 = await adminApi<QualityState>('GET', '/api/quality');
  test.skip(!q0.ffmpeg.available, 'no ffmpeg on this machine (set SWARMCAST_FFMPEG)');
  test.setTimeout(360_000);
  await setPlaylistWindow(20);
  await adminApi('PUT', '/api/quality', ladderUpdate(q0, { mode: 'manual', enabled: true, heights: [480], encoder: 'libx264' }));
  await reconnectObs('hd');
  await expect
    .poll(async () => (await adminApi<QualityState>('GET', '/api/quality')).variants.map((v) => v.height), { timeout: 120_000, intervals: [1000] })
    .toEqual([720, 480]);
  await waitForPlaylist(19, { qualities: 2 });
  const slow = await viewers.join(uid('trickle'), {
    setup: async (c) => {
      await watch480(c);
      await trickleUploads(c, TRICKLE_MS);
    },
  });
  await waitPlaying(slow.page);
  await enableP2P(slow.page);
  await expect.poll(() => bufferAhead(slow.page), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(6);
  let cdp: CDPSession | undefined;
  const { page } = await viewers.join(uid('steady'), {
    setup: watch480,
    prepare: async (p) => {
      cdp = await p.context().newCDPSession(p);
      await cdp.send('Network.emulateNetworkConditions', TUNNEL);
    },
  });
  await waitPlaying(page);
  await unmute(page);
  await enableP2P(page);
  await page.evaluate(() => {
    const none = { simultaneousHttpDownloads: 0 };
    (window as unknown as { __hls: { p2pEngine: { applyDynamicConfig(c: unknown): void } } }).__hls.p2pEngine.applyDynamicConfig({ core: { ...none, mainStream: none, secondaryStream: none } });
  });
  await expect.poll(() => peerCount(page), { timeout: 90_000 }).toBeGreaterThan(0);
  await startStallMonitor(page);

  // Act
  await measuredWindow(page, SOAK_BEFORE_MS);
  const before = await stallReport(page);

  // Assert
  expect(before.maxStallMs, 'stall next to a slow peer').toBeLessThan(4000);

  // Act
  await cdp!.send('Network.emulateNetworkConditions', STARVED);
  await measuredWindow(page, FORCED_STALL_MS);
  await cdp!.send('Network.emulateNetworkConditions', TUNNEL);

  // Assert
  await expect.poll(async () => (await stallReport(page)).currentStallMs, { timeout: 25_000, intervals: [500] }).toBe(0);

  // Act
  const recovered = await stats(page);
  await startStallMonitor(page);
  await measuredWindow(page, SOAK_AFTER_MS);
  const after = await stallReport(page);
  const s = await stats(page);
  const delay = await page.evaluate(() => (window as unknown as { __swarmcast: { delay: unknown } }).__swarmcast.delay);
  console.log(`steady viewer: ${s.httpFallbacks} HTTPS fallbacks, ${s.peersDropped} peers dropped, ${s.stallRecoveries} stall recoveries, ${s.reloads} source reloads (last: ${s.lastReload ?? 'none'}; ${s.reloads - recovered.reloads} after recovering), ${Math.round(s.p2pDownBytes / 1024)} kB over P2P; played ${after.playedS.toFixed(1)} s, longest stall ${Math.round(after.maxStallMs)} ms; delay ${JSON.stringify(delay)}`);

  // Assert
  expect(after.playedS, 'media played after the forced stall').toBeGreaterThan(((SOAK_AFTER_MS / 1000) * 2) / 3);
  expect(after.maxStallMs, 'stall after recovering').toBeLessThan(4000);
  expect(s.reloads - recovered.reloads, `source reloads after recovering (last: ${s.lastReload})`).toBe(0);
});
