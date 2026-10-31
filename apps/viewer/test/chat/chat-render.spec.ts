// The nasty-string corpus (packages/shared/test/chat/corpus.ts, chat plan §2.6 and §10.3) rendered
// by the real watch page in every engine, desktop and phone, against the mock hub: each string goes
// through the server's pipeline first (as the hub would send it, with the default settings of a
// live), then the page must render all of them as text, inside their boxes, without hiding any,
// without errors and while staying responsive. A screenshot per engine is attached to the report
// for review. rendering.yml runs this file on Windows, macOS and Linux (the OS font stacks differ).
//
// The first page of a fresh browser stalls while the system fonts are scanned for the corpus's
// scripts and emoji (once per browser process): warmFontFallback lays them out first, so the checks
// below time the page, not that scan. The machine's own first load of those fonts happens earlier,
// in globalSetup (warm-browsers.ts), not while other workers' tests run.
import { expect, test, type Page } from './fixtures.js';
import { NAMES, SNAPSHOT_MAX, sayCorpus } from './corpus-hub.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild, reviewScreenshot, warmFontFallback } from './watch-page.js';

test.beforeAll(requireBuild);

/** A frame's main-thread work (script, style, layout, paint recording) must stay well under this. */
const FRAME_WORK_BUDGET_MS = 50;
/**
 * Frames sampled; their median is checked, so one hiccup of a shared CI machine (another worker, a
 * GC) does not count as the page freezing, while a page that really hangs on the corpus fails
 * every sample.
 */
const FRAME_SAMPLES = 7;
/** Measured window: typing into the box with everything on screen must show in the counter within it. */
const INPUT_RESPONSE_BUDGET_MS = 1000;

/**
 * Console errors of the page, except the expected ones: there is no stream behind the mock, so the
 * player's 404s are expected; WebKit also logs its media controls' placard icons and one refused
 * stylesheet on the watch page with the chat off as well (not from the chat; the page's own styles
 * all come from files). Anything else is collected.
 */
function consoleErrors(page: Page, browserName: string): string[] {
  const errors: string[] = [];
  const noise = browserName === 'webkit' ? /^Failed to load resource|^Button failed to load|^Refused to apply a stylesheet because its hash/ : /^Failed to load resource/;
  page.on('console', (m) => {
    if (m.type() === 'error' && !noise.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/**
 * What the test checks of each rendered message row. Text only: emote codes become images,
 * everything else stays characters, in a bdi with dir=auto. The box clips whatever the shaper does:
 * overflow clip (or hidden on older engines), layout and paint contained, and never taller than its
 * clamp (max-height).
 */
function messageBoxes(page: Page) {
  return page
    .getByTestId('chat-list')
    .locator('li.msg:not(.sys)')
    .evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        const text = el.querySelector('.text');
        return {
          text: text?.textContent ?? '',
          dir: text?.getAttribute('dir') ?? null,
          tag: text?.tagName.toLowerCase() ?? '',
          markup: el.querySelectorAll('a, script, iframe, object, embed, svg, video, audio').length,
          height: el.getBoundingClientRect().height,
          maxHeight: parseFloat(cs.maxHeight),
          overflow: `${cs.overflowX} ${cs.overflowY}`,
          contain: cs.contain,
        };
      }),
    );
}

/**
 * The main thread's work per frame (script, style, layout, paint recording), in ms, sorted: each
 * sample posts a message from inside an animation frame callback and times its arrival, which comes
 * after that frame's rendering work. Rasterising is left out on purpose: it runs off the main
 * thread, and Chrome on the macOS runners does it in software (no GPU), so two frames there take
 * 100-400 ms on any page with this much text, while Firefox and WebKit on the same runner and
 * Chrome on a real Mac take ~20 ms. Web font subsets (Inter greek, cyrillic, vietnamese) load once
 * the list asks for them: the samples start after they are in.
 */
function mainThreadFrameWork(page: Page, samples: number): Promise<number[]> {
  return page.evaluate(async (n) => {
    await document.fonts.ready;
    const frameWork = (): Promise<number> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const t0 = performance.now();
          const ch = new MessageChannel();
          ch.port1.onmessage = () => resolve(performance.now() - t0);
          ch.port2.postMessage(0);
        });
      });
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await frameWork());
    return out.sort((a, b) => a - b);
  }, samples);
}

test('every corpus string renders as text, clipped to its box, nothing hidden, no errors @render', async ({ page, browserName }, testInfo) => {
  // Arrange
  const hub = new MockHub('Bia');
  const sent = sayCorpus(hub);
  const expected = sent.slice(-SNAPSHOT_MAX);
  const pageConsoleErrors = consoleErrors(page, browserName);
  await warmFontFallback(page, [...NAMES, ...sent.map((e) => e.text)]);

  // Act
  const errors = await openWatch(page, hub);
  const list = page.getByTestId('chat-list');
  await expect(list.locator('li.msg:not(.sys)')).toHaveCount(Math.min(sent.length, SNAPSHOT_MAX));
  const boxes = await messageBoxes(page);

  // Assert
  expect(sent.length).toBeGreaterThan(20);
  await expect(list.locator('li.hidden-msg')).toHaveCount(0);
  for (const [i, b] of boxes.entries()) {
    const id = expected[i]!.id;
    expect(b.markup, id).toBe(0);
    expect(b.tag, id).toBe('bdi');
    expect(b.dir, id).toBe('auto');
    expect(b.overflow, id).toMatch(/^(clip|hidden) (clip|hidden)$/);
    expect(b.contain, id).toMatch(/content|paint/);
    if (Number.isFinite(b.maxHeight)) expect(b.height, id).toBeLessThanOrEqual(b.maxHeight + 0.5);
  }

  // Act
  const busy = await mainThreadFrameWork(page, FRAME_SAMPLES);

  // Assert
  expect(busy[Math.floor(FRAME_SAMPLES / 2)], `main-thread frame work (ms): ${busy.map((f) => f.toFixed(0)).join(', ')}`).toBeLessThan(FRAME_WORK_BUDGET_MS);

  // Act
  const t0 = Date.now();
  await page.getByTestId('chat-input').fill('ainda responde?');
  await expect(page.getByTestId('chat-counter')).toHaveText('15/200');
  const inputMs = Date.now() - t0;

  // Assert
  expect(inputMs).toBeLessThan(INPUT_RESPONSE_BUDGET_MS);
  expect(errors).toEqual([]);
  expect(pageConsoleErrors).toEqual([]);
  await testInfo.attach(`corpus-${testInfo.project.name}-${browserName}.png`, { body: await reviewScreenshot(page, { fullPage: true }), contentType: 'image/png' });
});
