// The video-first gate of the chat (chat plan §6.6 and §10.5, chat-flood.spec.ts @media): one
// real viewer plays the stream while scripted viewers flood the chat at the highest rate their
// sockets allow, with slow mode off so every frame a bot sends is a real message attempt.
// Compared with a calm stretch of the same live, the player must keep playing and not stall
// more (plus one segment of timer noise), the server's own work must keep its event loop within
// 20 ms of calm (p99, scripts/test/lib/loop-delay.mjs: the limit of the chat bench), the HLS
// answers must not get slower beyond 20 % (+ 50 ms for loopback jitter), and a kick in the middle
// of the flood must still arrive within a second (control messages jump ahead of chat). The full bench (more viewers, more scenarios) is
// scripts/test/chat/bench.ts. One engine is enough for the server side.
//
// The stall comparison holds where the runner plays steadily. Chrome on the macOS runners stalls
// about 3 s in roughly one 20 s stretch in ten whether or not the chat is busy (the stability
// soak: 2 of 20 stretches, one of them calm, while 40 of 40 on Linux had none, and the HLS
// answers and the kick stayed as fast as in the calm stretch). The HLS answer times the page sees
// have the same blind spot there: those VMs stop whole processes for 50-110 ms now and then (see
// loop-delay.mjs), and a calm stretch's p95 reached 50 ms with the server idle (pipeline runs of
// 2026-10-30: calm p95 3-50 ms, flood p95 2-18 ms, and once 100 ms in a flood with no stall, a
// kick in 8 ms). One calm stretch against one busy one cannot tell either apart from the chat
// there. The event-loop check can: it measures the server's own work, leaving out the time the
// VM did not run it, so it holds on every runner, and the playback, kick and HLS-count checks
// still run everywhere.
import type { Page } from '@playwright/test';
import { admin, expect, measuredWindow, serverOwnLoopDelayP99, startStallMonitor, stallReport, test, uid, unmute, viewerByNick, waitPlaying, type ScriptedViewer } from './fixtures.js';

test.skip(({ browserName }) => browserName !== 'chromium', 'one engine is enough for the server side');

const BOTS = 24;
/** The calm stretch, and the flood (a kick in its middle): measured windows of playback and HLS answers. */
const WINDOW_MS = 20_000;
/** A bot's chat frames, 1.8 a second: just under the 20-per-10-s line that terminates a socket (the load, not a wait). */
const BOT_FRAME_INTERVAL_MS = 555;
/** Whether one calm stretch against one busy one can tell the chat's stalls and slow HLS answers from the runner's own (see above). */
const STEADY_RUNNER = process.platform !== 'darwin';
/** How much the server's own work may hold up its event loop beyond calm (p99, ms): the chat bench's limit (bench.ts). */
const OWN_LOOP_SLACK_MS = 20;

/** HLS answers (segments and playlists) the page saw since the last call, ms each. */
async function hlsTimings(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const out = performance
      .getEntriesByType('resource')
      .filter((e) => new URL(e.name).pathname.startsWith('/hls/'))
      .map((e) => (e as PerformanceResourceTiming).responseEnd - (e as PerformanceResourceTiming).requestStart);
    performance.clearResourceTimings();
    return out;
  });
}

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0;
};

/** Every bot sends chat frames until stop(), which resolves with how many were sent. */
function flood(crowd: ScriptedViewer[]): { stop(): Promise<number> } {
  let on = true;
  let sent = 0;
  const loops = crowd.map(async (b, i) => {
    while (on) {
      if (b.open) b.send(`flood ${i} ${++sent} kkkkkk 🔥`);
      await new Promise((r) => setTimeout(r, BOT_FRAME_INTERVAL_MS));
    }
  });
  return {
    stop: async () => {
      on = false;
      await Promise.all(loops);
      return sent;
    },
  };
}

test('a chat flood never slows the video down, and a kick still arrives within a second', { tag: '@media' }, async ({ viewers, bots, chat }) => {
  // Arrange
  test.setTimeout(180_000);
  const { page } = await viewers.join(uid('flood'));
  await page.evaluate(() => performance.setResourceTimingBufferSize(5000));
  await waitPlaying(page, 3);
  await unmute(page);
  await hlsTimings(page);
  await startStallMonitor(page);
  await serverOwnLoopDelayP99();

  // Act
  await measuredWindow(page, WINDOW_MS);
  const calm = { stall: await stallReport(page), hls: await hlsTimings(page), ownLoopP99: await serverOwnLoopDelayP99() };

  // Arrange
  await chat.change({ slowModeS: 0 });
  const prefix = uid('b').slice(0, 14);
  const crowd: ScriptedViewer[] = [];
  for (let i = 0; i < BOTS; i++) crowd.push(await bots.join(`${prefix}${i}`));
  const target = crowd[0]!;
  const targetRow = await viewerByNick(target.nickname);
  expect(targetRow, 'the bot to kick is listed').toBeTruthy();
  await startStallMonitor(page);
  await serverOwnLoopDelayP99();

  // Act
  const flooding = flood(crowd);
  await measuredWindow(page, WINDOW_MS / 2);
  const kickAt = Date.now();
  await admin(`/api/viewers/${targetRow!.sessionId}/kick`);
  await expect.poll(() => target.kickedAt, { timeout: 5_000 }).toBeGreaterThan(0);
  const kickMs = target.kickedAt - kickAt;
  await measuredWindow(page, WINDOW_MS / 2);
  const sent = await flooding.stop();
  const busy = { stall: await stallReport(page), hls: await hlsTimings(page), ownLoopP99: await serverOwnLoopDelayP99() };
  const { counters } = await chat.state();

  // Assert
  const report = {
    calm: { maxStallMs: calm.stall.maxStallMs, playedS: calm.stall.playedS, hlsP95: p95(calm.hls), hls: calm.hls.length, ownLoopP99: calm.ownLoopP99 },
    flood: { maxStallMs: busy.stall.maxStallMs, playedS: busy.stall.playedS, hlsP95: p95(busy.hls), hls: busy.hls.length, ownLoopP99: busy.ownLoopP99 },
    kickMs,
    sent,
    counters,
  };
  console.log(`chat-flood: ${JSON.stringify(report)}`);
  await test.info().attach('chat-flood.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(sent).toBeGreaterThan(BOTS * (WINDOW_MS / 1000));
  expect(busy.stall.playedS).toBeGreaterThan((WINDOW_MS / 1000) * 0.8);
  if (STEADY_RUNNER) expect(busy.stall.maxStallMs).toBeLessThanOrEqual(Math.max(calm.stall.maxStallMs, 1000) + 1000);
  expect(busy.ownLoopP99).toBeLessThanOrEqual(calm.ownLoopP99 + OWN_LOOP_SLACK_MS);
  expect(busy.hls.length).toBeGreaterThan(5);
  if (STEADY_RUNNER) expect(p95(busy.hls)).toBeLessThanOrEqual(p95(calm.hls) * 1.2 + 50);
  expect(kickMs).toBeLessThanOrEqual(1000);
});
