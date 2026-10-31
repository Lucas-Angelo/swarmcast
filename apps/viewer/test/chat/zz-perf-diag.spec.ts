// TEMPORARY measurement (not committed): click -> first painted frame with emoji, and the longest frame gap.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const frames: number[] = [];
    w.__frames = frames;
    w.__mark = 0;
    w.__click = 0;
    const loop = (ts: number) => {
      frames.push(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    document.addEventListener('pointerdown', () => (w.__click = performance.now()), { capture: true, once: true });
    const panel = document.querySelector('[data-testid="chat-picker"]')!;
    const mo = new MutationObserver(() => {
      if (!w.__mark && panel.querySelector('section[data-group="0"] button.pick')) w.__mark = performance.now();
    });
    mo.observe(panel, { childList: true, subtree: true });
  });
}

async function collect(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __mark: number; __click: number };
    const f = w.__frames.filter((t) => t >= w.__click);
    const after = f.filter((t) => t > w.__mark);
    const paint = after[1] ?? NaN;
    let gap = 0;
    let prev = w.__click;
    for (const t of f) {
      if (t > paint + 1) break;
      gap = Math.max(gap, t - prev);
      prev = t;
    }
    return { openMs: Math.round(paint - w.__click), maxGapMs: Math.round(gap), buttons: document.querySelectorAll('[data-testid="chat-picker"] button.pick').length };
  });
}

for (let i = 0; i < Number(process.env.PERF_N ?? 6); i++) {
  test(`picker perf ${i}`, async ({ page, browserName }) => {
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const throttle = process.env.PERF_CPU && browserName === 'chromium' ? Number(process.env.PERF_CPU) : 0;
    if (throttle) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
    const picker = page.getByTestId('chat-picker');
    await arm(page);
    await page.getByTestId('chat-picker-button').click();
    await expect(picker.locator('section[data-group="0"] button.pick').first()).toBeVisible();
    const first = await collect(page);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    const second = await page.evaluate(
      () =>
        new Promise<{ syncMs: number; frameMs: number; atOpen: number }>((resolve) => {
          const btn = document.querySelector<HTMLButtonElement>('[data-testid="chat-picker-button"]')!;
          const t0 = performance.now();
          btn.click();
          const t1 = performance.now();
          const atOpen = document.querySelectorAll('[data-testid="chat-picker"] button.pick').length;
          requestAnimationFrame(() => {
            const f0 = performance.now();
            const ch = new MessageChannel();
            ch.port1.onmessage = () => {
              const frameMs = +(performance.now() - f0).toFixed(1);
              let prev = performance.now();
              let gap = 0;
              const tick = () => {
                const now = performance.now();
                gap = Math.max(gap, now - prev);
                prev = now;
                const done = !document.querySelector('[data-testid="chat-picker"] [data-pending]');
                if (done || now - t0 > 5000) resolve({ syncMs: +(t1 - t0).toFixed(1), frameMs, atOpen, fillMs: Math.round(now - t0), maxGapDuringFillMs: Math.round(gap), done } as never);
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            };
            ch.port2.postMessage(0);
          });
        }),
    );
    console.log('PERF ' + JSON.stringify({ browser: browserName, project: test.info().project.name, os: process.platform, throttle, first, second }));
  });
}
