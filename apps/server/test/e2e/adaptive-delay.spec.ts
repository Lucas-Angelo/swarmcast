// The adaptive playback delay (apps/viewer/src/latency-controller.ts, docs/QUALITY.md), end to
// end in a real player on a real (emulated) network, on a fast clock: `?delaySpeed=10` runs the
// controller's own clocks (dwell times, quiet period, target drift) 10× faster, and
// `?delayRate=10` moves playbackRate 10× further from 1 (catch-up ≤ 1.5× instead of 1.05×,
// slow-down 0.5× instead of 0.95×), so the delay follows that clock: a 5 s change takes 10 s
// instead of 100 s. The real-time numbers are covered by latency-controller.test.ts. The page
// honours both flags only because server.ts starts SwarmCast with SWARMCAST_TEST_HOOKS=1.
// Viewers join once the live playlist is long enough to start ~20 s behind live, then reopen the
// player on the fast clock, with sound (fixtures.ts unmute: the browser then clocks playback in
// real time).
//
// Good network (Chromium and WebKit; Chromium emulates a good home connection, 30 Mbps and 20
// ms): the delay drifts below 15 s with a gentle catch-up (at most the profile's limit) and no
// stalls; "~N s behind live" shows next to the status with its tooltip, refreshed once a second;
// the panel's viewers table gets each viewer's delay; "Go live" jumps to the adaptive live
// position and keeps playing. Every sample of the controller is kept (attached to the result),
// so a failure shows how it classified the network. The drift is the controller's "firm"
// verdict: only "firm" lowers the target, and the network never looked unstable. The state of
// the very last sample is not checked: on this 10× clock "firm" ends after two loose ticks
// (firmExit.afterS 0.5 s; 5 s in real time), so one slow segment load on a busy CI machine may
// end it right after the drift (1 of 40 WebKit runs on macos-latest in the calibration soak),
// which says nothing about the drift itself.
//
// Throttled, oscillating 4G (CDP, Chromium only): 10 s at 5 Mbps / 60 ms, 10 s at 0.7 Mbps /
// 300 ms, three times. The test stream is ~1.3 Mbps, so the bad phases are below real time and
// the good ones refill the buffer; on this clock three cycles are enough to raise the target to
// the top of its range. Before the controller has seen the network wobble it may still catch up
// a little; once it calls the network unstable it never speeds up, except above the upper bound,
// where it does catch up to stay inside the playlist window.
import type { CDPSession, Page } from '@playwright/test';
import { expect, measuredWindow, playsOn, test, uid, unmute, viewerByNick, waitForPlaylist, waitPlaying, type Audience, type Viewer } from './fixtures.js';

const FAST = '/watch?delaySpeed=10&delayRate=10';

interface Delay {
  delay: number | null;
  target: number;
  state: string;
  rateMode: string;
  playbackRate: number;
  /** The controller's playbackRate limits on this clock. */
  rates: { max: number; slow: number };
  stalls: number;
  stalledS: number;
  holds: number;
  /** What the controller measured (latency-controller.ts Signals). */
  signals: unknown;
}

type Network = { offline: false; latency: number; downloadThroughput: number; uploadThroughput: number };

/** A good home connection: 30 Mbps down, 10 up, 20 ms. */
const GOOD_HOME: Network = { offline: false, latency: 20, downloadThroughput: 30e6 / 8, uploadThroughput: 10e6 / 8 };
/** The two phases of the oscillating 4G. */
const GOOD_4G: Network = { offline: false, latency: 60, downloadThroughput: 5e6 / 8, uploadThroughput: 2e6 / 8 };
const BAD_4G: Network = { offline: false, latency: 300, downloadThroughput: 0.7e6 / 8, uploadThroughput: 0.5e6 / 8 };
/** Bad, good, bad, good, bad, good: each a measured window of 10 s, sampled every 2 s. */
const PHASES = 6;
const SAMPLES_PER_PHASE = 5;
const SAMPLE_MS = 2_000;
/** Below this the controller's own catch-up is in play (above it, it catches up to stay inside the playlist window). */
const UPPER_BOUND_S = 29.5;

const delayOf = (page: Page): Promise<Delay> => page.evaluate(() => (window as unknown as { __swarmcast: { delay: Delay } }).__swarmcast.delay);

/** Joins once the live playlist is long enough to start ~20 s behind live, then reopens the player on the fast clock, with sound. */
async function watchWithFastClock(viewers: Audience, nick: string, before?: (page: Page) => Promise<void>): Promise<Viewer> {
  await waitForPlaylist(32);
  const viewer = await viewers.join(nick);
  await before?.(viewer.page);
  await viewer.page.goto(FAST);
  await waitPlaying(viewer.page);
  await unmute(viewer.page);
  return viewer;
}

async function emulate(page: Page, network?: Network): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  if (network) await cdp.send('Network.emulateNetworkConditions', network);
  return cdp;
}

test('on a good network the delay drifts below 15 s, the status line shows it, and Go live still works', { tag: '@media' }, async ({ viewers, browserName }) => {
  // Arrange
  test.skip(browserName === 'firefox', 'checked on Chromium and WebKit');
  test.setTimeout(240_000);
  const nick = uid('delaygood');
  const { page } = await watchWithFastClock(viewers, nick, async (p) => {
    if (browserName === 'chromium') await emulate(p, GOOD_HOME);
  });
  await expect.poll(async () => (await delayOf(page)).delay ?? 0, { timeout: 30_000 }).toBeGreaterThan(16);
  const start = await delayOf(page);
  const label = page.locator('[data-testid="delay"]');
  let maxRate = 1;
  const timeline: Array<Pick<Delay, 'delay' | 'target' | 'state' | 'playbackRate'> & { s: number; signals?: unknown }> = [];
  const since = Date.now();

  // Assert
  expect(start.target).toBe(20);
  await expect(label).toHaveText(/^~\d+ s behind live$/);
  await expect(page.locator('#delay-wrap .tip-btn')).toHaveCount(1);
  await expect(page.locator('#tip-delay')).toContainText('adjusts itself to your connection');

  // Act
  await expect
    .poll(
      async () => {
        const d = await delayOf(page);
        timeline.push({ s: Math.round((Date.now() - since) / 100) / 10, delay: d.delay, target: d.target, state: d.state, playbackRate: d.playbackRate, signals: d.signals });
        maxRate = Math.max(maxRate, d.playbackRate);
        return d.delay ?? 99;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBeLessThan(15);
  const low = await delayOf(page);
  await test.info().attach('adaptive-delay timeline (good network)', { body: JSON.stringify({ low, timeline }, null, 1), contentType: 'application/json' });
  console.log('good network:', JSON.stringify({ start: start.delay, low: low.delay, target: low.target, stalls: low.stalls, stalledS: low.stalledS, holds: low.holds }));

  // Assert
  expect(timeline.some((d) => d.state === 'firm'), 'the controller called the network firm').toBe(true);
  expect(timeline.filter((d) => d.state === 'unstable'), 'samples that called the network unstable').toEqual([]);
  expect(low.target).toBeLessThan(15);
  expect(low.stalls).toBeLessThanOrEqual(3);
  expect(maxRate).toBeGreaterThan(1);
  expect(maxRate).toBeLessThanOrEqual(low.rates.max);
  await expect.poll(async () => Number(/\d+/.exec((await label.textContent()) ?? '')?.[0] ?? 99), { timeout: 10_000 }).toBeLessThanOrEqual(16);
  await expect.poll(async () => (await viewerByNick(nick))?.delayS ?? 99, { timeout: 20_000 }).toBeLessThan(17);

  // Act
  const goLive = page.locator('[data-testid="go-live"]');
  await expect(goLive).toBeVisible();
  await goLive.click();

  // Assert
  await playsOn(page, 2);
  const after = await delayOf(page);
  expect(after.delay!).toBeLessThan(after.target + 4);
  await expect(page.locator('#status')).toHaveText('Live');
});

test('on a throttled, oscillating network the delay rises and stalls stay rare', { tag: '@media' }, async ({ viewers, browserName }) => {
  // Arrange
  test.skip(browserName !== 'chromium', 'CDP network throttling is Chromium only');
  test.setTimeout(240_000);
  let cdp: CDPSession | undefined;
  const { page } = await watchWithFastClock(viewers, uid('delayosc'), async (p) => {
    cdp = await emulate(p);
  });
  await expect.poll(async () => (await delayOf(page)).delay ?? 0, { timeout: 30_000 }).toBeGreaterThan(16);
  const start = await delayOf(page);
  let maxRate = 1;
  let maxTarget = start.target;
  let last = start;

  // Act
  for (let phase = 0; phase < PHASES; phase++) {
    await cdp!.send('Network.emulateNetworkConditions', phase % 2 === 0 ? BAD_4G : GOOD_4G);
    for (let k = 0; k < SAMPLES_PER_PHASE; k++) {
      await measuredWindow(page, SAMPLE_MS);
      last = await delayOf(page);
      if (last.state === 'unstable' && last.delay !== null && last.delay < UPPER_BOUND_S) maxRate = Math.max(maxRate, last.playbackRate);
      maxTarget = Math.max(maxTarget, last.target);
    }
  }
  console.log('oscillating network:', JSON.stringify({ start: start.delay, end: last.delay, target: last.target, maxTarget, state: last.state, stalls: last.stalls, stalledS: last.stalledS, holds: last.holds }));

  // Assert
  expect(maxTarget).toBeGreaterThanOrEqual(26);
  expect(last.delay!).toBeGreaterThan(start.delay! + 3);
  expect(maxRate).toBeLessThanOrEqual(1);
  expect(last.stalls).toBeLessThanOrEqual(2);
});
