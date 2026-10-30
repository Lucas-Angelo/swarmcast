// The nasty-string corpus (packages/shared/test/chat/corpus.ts, chat plan §2.6 and §10.3) rendered
// by the real watch page in every engine, desktop and phone, against the mock hub: each string goes
// through the server's pipeline first (as the hub would send it), then the page must render all of
// them as text, inside their boxes, without hiding any, without errors and while staying
// responsive. A screenshot per engine is attached to the report for review. rendering.yml runs
// this file on Windows, macOS and Linux (the OS font stacks differ).
import { expect, test } from '@playwright/test';
import { canonicalizeChatText, validateNickname, type ChatAuthor } from '@swarmcast/shared/chat';
import { CORPUS } from '../../../../packages/shared/test/chat/corpus.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

/** Authors with names from several scripts (each one valid under the nickname rules). */
const NAMES = ['Ana', 'Rafa_gamer', 'नमस्ते', 'עדי', 'アナ', 'Ζωή', 'محمد', 'ประเสริฐ', 'Nguyễn', 'క్షమ'];

test('every corpus string renders as text, clipped to its box, nothing hidden, no errors @render', async ({ page, browserName }, testInfo) => {
  const authors: ChatAuthor[] = NAMES.map((n, i) => {
    const v = validateNickname(n);
    if (!v.ok) throw new Error(`${n}: ${v.code}`);
    return { a: `k${i}`, n: v.value, c: ['#e5484d', '#46a758', '#0090ff', '#d6409f', '#12a594'][i % 5]!, r: i === 0 ? 'streamer' : 'viewer' };
  });
  const hub = new MockHub('Bia');
  const sent: Array<{ id: string; text: string }> = [];
  for (const e of CORPUS) {
    // The default settings of a live (what viewers see unless the streamer changes them).
    const r = canonicalizeChatText(e.input);
    if (!r.ok) continue;
    hub.say(authors[sent.length % authors.length]!, r.text);
    sent.push({ id: e.id, text: r.text });
  }
  expect(sent.length).toBeGreaterThan(20);

  const consoleErrors: string[] = [];
  // There is no stream behind the mock: the player's 404s are expected. WebKit also logs its media
  // controls' placard icons and one refused stylesheet on the watch page with the chat off as
  // well (not from the chat; the page's own styles all come from files). Anything else is not.
  const noise = browserName === 'webkit' ? /^Failed to load resource|^Button failed to load|^Refused to apply a stylesheet because its hash/ : /^Failed to load resource/;
  page.on('console', (m) => {
    if (m.type() === 'error' && !noise.test(m.text())) consoleErrors.push(m.text());
  });
  const errors = await openWatch(page, hub);
  const list = page.getByTestId('chat-list');
  // The snapshot carries the last 50: the corpus fits.
  await expect(list.locator('li.msg:not(.sys)')).toHaveCount(Math.min(sent.length, 50));
  await expect(list.locator('li.hidden-msg')).toHaveCount(0);

  const boxes = await list.locator('li.msg:not(.sys)').evaluateAll((els) =>
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
  const expected = sent.slice(-50);
  for (const [i, b] of boxes.entries()) {
    const id = expected[i]!.id;
    // Text only: emote codes become images, everything else stays characters.
    expect(b.markup, id).toBe(0);
    expect(b.tag, id).toBe('bdi');
    expect(b.dir, id).toBe('auto');
    // The box clips whatever the shaper does: overflow clip (or hidden on older engines),
    // layout and paint contained, and never taller than its clamp.
    expect(b.overflow, id).toMatch(/^(clip|hidden) (clip|hidden)$/);
    expect(b.contain, id).toMatch(/content|paint/);
    if (Number.isFinite(b.maxHeight)) expect(b.height, id).toBeLessThanOrEqual(b.maxHeight + 0.5);
  }

  // Still responsive with everything on screen: two animation frames well under 100 ms. The
  // median of 7 samples, so one hiccup of a shared CI machine (another worker, a GC) does not
  // count as the page freezing; a page that really hangs on the corpus fails every sample.
  const frames = await page.evaluate(async () => {
    const twoFrames = (): Promise<number> =>
      new Promise((resolve) => {
        const t0 = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
      });
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) samples.push(await twoFrames());
    return samples.sort((a, b) => a - b);
  });
  expect(frames[3], `two-frame times (ms): ${frames.map((f) => f.toFixed(0)).join(', ')}`).toBeLessThan(100);
  const input = page.getByTestId('chat-input');
  const t0 = Date.now();
  await input.fill('ainda responde?');
  await expect(page.getByTestId('chat-counter')).toHaveText('15/200');
  expect(Date.now() - t0).toBeLessThan(1000);

  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await testInfo.attach(`corpus-${testInfo.project.name}-${browserName}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});
