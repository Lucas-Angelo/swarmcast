// DIAGNOSTIC ONLY (soak/chatsend-diag branch, never merged): finds where a page's main thread
// stalls for seconds in Chrome/Edge on Windows. Every test gets: a lag monitor in its page, a probe
// page in a second context of the same browser (another renderer process) with the same monitor,
// and a Chrome performance trace of the whole browser (all processes). The trace is kept only when
// a stall over STALL_MS was seen or the test failed.
import fs from 'node:fs';
import { test as base } from './fixtures.js';
export { expect } from './fixtures.js';
export type { Page } from '@playwright/test';

const STALL_MS = 1000;
const CATEGORIES = [
  '-*',
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'v8.execute',
  'blink',
  'fonts',
  'mojom',
  'ipc',
  'base',
  'browser',
  'loading',
  'navigation',
  'disabled-by-default-ipc.flow',
  'disabled-by-default-toplevel.flow',
];

const MONITOR = (): void => {
  const w = window as unknown as { __lag?: Array<{ at: number; gap: number }> };
  if (w.__lag) return;
  w.__lag = [];
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - last > 250) w.__lag!.push({ at: Date.now(), gap: Math.round(now - last) });
    last = now;
  }, 50);
};

type Lag = { at: number; gap: number };
const readLags = async (p: import('@playwright/test').Page): Promise<Lag[] | string> =>
  Promise.race([
    p.evaluate(() => (window as unknown as { __lag?: Lag[] }).__lag ?? []).catch((e: Error) => `err ${e.message.split('\n')[0]}`),
    new Promise<string>((r) => setTimeout(() => r('timeout reading lags'), 15_000)),
  ]);

export const test = base.extend<{ diag: void }, { launchedAt: number }>({
  launchedAt: [
    async ({ browser }, use) => {
      void browser;
      await use(Date.now());
    },
    { scope: 'worker' },
  ],
  diag: [
    async ({ page, browser, browserName, launchedAt }, use, testInfo) => {
      const start = Date.now();
      const chromium = false && browserName === 'chromium'; // light: no Chrome trace
      const tracePath = testInfo.outputPath('chrome-trace.json');
      if (chromium) await browser.startTracing(undefined, { path: tracePath, categories: CATEGORIES });
      await page.addInitScript(MONITOR);
      const probeCtx = await browser.newContext();
      const probe = await probeCtx.newPage();
      await probe.evaluate(MONITOR);
      // Protocol heartbeat: a round trip through the browser's parent process (Juggler) every 100 ms.
      const beats: Array<{ at: number; rtt: number }> = [];
      let beating = true;
      const beat = (async () => {
        while (beating) {
          const t = Date.now();
          await probe.evaluate(() => 1).catch(() => {});
          const rtt = Date.now() - t;
          if (rtt > 300) beats.push({ at: t + rtt, rtt });
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
      await use();
      beating = false;
      await beat;
      const [pageLags, probeLags] = await Promise.all([readLags(page), readLags(probe)]);
      await probeCtx.close().catch(() => {});
      if (chromium) await browser.stopTracing().catch(() => {});
      const big = (l: Lag[] | string): boolean => typeof l === 'string' || l.some((x) => x.gap > STALL_MS);
      const keep = !!process.env.DIAG_KEEP_ALL || big(pageLags) || big(probeLags) || beats.some((x) => x.rtt > STALL_MS) || testInfo.status !== testInfo.expectedStatus;
      const rel = (l: Lag[] | string): unknown => (typeof l === 'string' ? l : l.map((x) => ({ sinceLaunchMs: x.at - launchedAt, gapMs: x.gap, at: new Date(x.at).toISOString() })));
      const line = {
        project: testInfo.project.name,
        pid: process.pid,
        browserVersion: browser.version(),
        worker: testInfo.workerIndex,
        title: testInfo.title,
        status: testInfo.status,
        startSinceLaunchMs: start - launchedAt,
        durationMs: Date.now() - start,
        startAt: new Date(start).toISOString(),
        pageLags: rel(pageLags),
        probeLags: rel(probeLags),
        protocolStalls: beats.map((x) => ({ sinceLaunchMs: x.at - launchedAt, rttMs: x.rtt, at: new Date(x.at).toISOString() })),
        trace: keep && chromium ? tracePath : null,
      };
      fs.writeFileSync(testInfo.outputPath('diag.json'), JSON.stringify(line, null, 1));
      console.log(`DIAG ${JSON.stringify(line)}`);
      if (!keep && chromium) fs.rmSync(tracePath, { force: true });
    },
    { auto: true },
  ],
});
