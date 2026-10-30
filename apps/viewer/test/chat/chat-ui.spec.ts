// The viewer chat UI in chromium, firefox and webkit, against the mock hub (no server needed).
// Run: npm run build -w @swarmcast/viewer && npx playwright test -c apps/viewer/test/chat/playwright.config.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { viewerCsp } from '../../../server/src/public/security.js';
import { MockHub } from './mock-hub.js';

const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');
const ORIGIN = 'http://chat.test';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

test.beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, 'watch.html'))) throw new Error('Build the viewer first: npm run build -w @swarmcast/viewer');
});

async function openWatch(page: Page, hub: MockHub, o: { lang?: 'en' | 'pt-BR'; query?: string } = {}): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/config') {
      return route.fulfill({
        json: { sessionId: 's1', nickname: hub.nickname, manifestPublicKey: 'AAAA', playlistUrl: '/hls/index.m3u8', manifestUrl: '/hls/manifest.json', trackerUrl: 'ws://chat.test/tracker', controlUrl: 'ws://chat.test/control', stunServers: [], swarmId: 'x', p2pAllowed: false, segmentDurationS: 2 },
      });
    }
    if (url.pathname === '/api/session/refresh') return route.fulfill({ status: 204 });
    const file = url.pathname === '/watch' ? 'watch.html' : url.pathname.slice(1);
    const full = path.resolve(DIST, file);
    if (!full.startsWith(DIST + path.sep)) return route.fulfill({ status: 404, body: 'not found' });
    // One read, no check first: a missing file or a folder simply fails here.
    let body: Buffer;
    try {
      body = fs.readFileSync(full);
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({
      body,
      headers: { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream', 'content-security-policy': viewerCsp('chat.test', false), 'referrer-policy': 'no-referrer' },
    });
  });
  await page.routeWebSocket(`ws://chat.test/control`, (ws) => {
    const send = (m: string): void => ws.send(m);
    const detach = hub.attach(send);
    ws.onMessage((m) => hub.onFrame(send, String(m)));
    ws.onClose(() => detach());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ORIGIN}/watch?lang=${o.lang ?? 'en'}${o.query ?? ''}`);
  await expect(page.getByTestId('chat')).toBeVisible();
  expect(errors).toEqual([]);
}

const ana = { a: 'k2', n: 'Ana', c: '#d4a017', r: 'viewer' as const };
const streamer = { a: 'k0', n: 'Lucas', c: '#000000', r: 'streamer' as const };

/** WCAG 2.2 contrast of two CSS colours "rgb(r, g, b)". */
function contrast(a: string, b: string): number {
  const ch = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lum = (c: number[]): number => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(ch(a)), lum(ch(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test.describe('viewer chat (mock hub)', () => {
  test('shows history and new messages as text only, isolated, with emotes as images', async ({ page }) => {
    const hub = new MockHub('Bia');
    hub.say(ana, 'oi gente :hi:');
    await openWatch(page, hub);
    const list = page.getByTestId('chat-list');
    await expect(list.locator('li.msg')).toHaveCount(1);
    await expect(list.locator('li.msg .nick')).toHaveText('Ana');
    await expect(list.locator('li.msg img.emote')).toHaveAttribute('alt', ':hi:');

    hub.say(ana, '<img src=x onerror=alert(1)> **bold** https://evil.example/x.png');
    hub.say(streamer, 'bem-vindos');
    await expect(list.locator('li.msg')).toHaveCount(3);
    const hostile = list.locator('li.msg').nth(1);
    await expect(hostile.locator('.text')).toHaveText('<img src=x onerror=alert(1)> **bold** https://evil.example/x.png');
    await expect(hostile.locator('img, a')).toHaveCount(0);
    await expect(hostile.locator('bdi.text')).toHaveAttribute('dir', 'auto');
    await expect(list.locator('li.from-streamer .badge')).toHaveText('Streamer');
  });

  test('sends with Enter: "sending…" until the server copy arrives; the frame starts with t', async ({ page }) => {
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const input = page.getByTestId('chat-input');
    await input.fill('boa noite chat 😀');
    await expect(page.getByTestId('chat-counter')).toHaveText('16/200');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    const row = page.getByTestId('chat-list').locator('li.msg').last();
    await expect(row.locator('.text')).toHaveText('boa noite chat 😀');
    await expect(page.getByTestId('chat-list').locator('li.pending')).toHaveCount(0);
    await expect(page.getByTestId('chat-list').locator('li.msg')).toHaveCount(1);
    const sent = hub.received.find((m) => m.t === 'chat.send');
    expect(Object.keys(sent ?? {})[0]).toBe('t');
  });

  test('a reject explains itself (EN and pt-BR) and gives the text back', async ({ page }) => {
    for (const lang of ['en', 'pt-BR'] as const) {
      const hub = new MockHub('Bia');
      hub.rejectNext = { code: 'chat.err.blocked' };
      await openWatch(page, hub, { lang });
      const input = page.getByTestId('chat-input');
      await input.fill('palavra feia');
      await input.press('Enter');
      await expect(page.getByTestId('chat-status')).toHaveText(lang === 'en' ? /blocked/i : /bloquead/i);
      await expect(input).toHaveValue('palavra feia');
      await expect(page.getByTestId('chat-list').locator('li.failed')).toHaveCount(1);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('slow mode: Send waits and says for how long', async ({ page }) => {
    const hub = new MockHub('Bia', { settings: { slowS: 5 } });
    await openWatch(page, hub);
    await expect(page.getByTestId('chat-mode')).toContainText('5 s');
    const input = page.getByTestId('chat-input');
    await input.fill('um');
    await input.press('Enter');
    await input.fill('dois');
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toContainText(/send again in [45] s/);
  });

  test('over the limit: the counter turns red and Send is disabled', async ({ page }) => {
    const hub = new MockHub('Bia', { settings: { maxGraphemes: 20 } });
    await openWatch(page, hub);
    await page.getByTestId('chat-input').fill('a'.repeat(21));
    await expect(page.getByTestId('chat-counter')).toHaveClass(/over/);
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toContainText('21 of 20');
  });

  test('hide chat is remembered across a reload; "Show chat" counts what arrived', async ({ page }) => {
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await page.getByTestId('chat-hide').click();
    await expect(page.getByTestId('chat')).toBeHidden();
    await expect(page.getByTestId('chat-show')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('chat-show')).toBeVisible();
    await expect(page.getByTestId('chat')).toBeHidden();
    hub.say(ana, 'um');
    hub.say(ana, 'dois');
    await expect(page.getByTestId('chat-show')).toContainText('2 new');
    await page.getByTestId('chat-show').click();
    await expect(page.getByTestId('chat')).toBeVisible();
    await expect(page.getByTestId('chat-list').locator('li.msg')).toHaveCount(2);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`names reach 4.5:1 against the chat background (${scheme} theme), colours set through the CSSOM`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const hub = new MockHub('Bia');
      // Too light for the light theme, too dark for the dark one.
      hub.say({ a: 'k3', n: 'Clara', c: '#ffee88', r: 'viewer' }, 'oi');
      hub.say({ a: 'k4', n: 'Escuro', c: '#101010', r: 'viewer' }, 'oi');
      hub.say(ana, 'oi');
      await openWatch(page, hub);
      const list = page.getByTestId('chat-list');
      await expect(list.locator('li.msg')).toHaveCount(3);
      const bg = await list.evaluate((el) => getComputedStyle(el).backgroundColor);
      for (const color of await list.locator('.nick').evaluateAll((els) => els.map((e) => getComputedStyle(e).color))) {
        expect(contrast(color, bg), `${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test('the colour chooser previews the name on both themes and tells the server', async ({ page }) => {
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await page.getByTestId('chat-settings-button').click();
    const pop = page.getByTestId('chat-settings');
    await pop.locator('button.swatch').nth(2).click();
    await expect.poll(() => hub.received.filter((m) => m.t === 'chat.color').at(-1)?.color).toBe('#d4a017');
    for (const theme of ['light', 'dark'] as const) {
      const sample = page.getByTestId(`chat-color-preview-${theme}`);
      await expect(sample.locator('.nick')).toHaveText('Bia');
      const [fg, bg] = await sample.evaluate((el) => [getComputedStyle(el.querySelector('.nick')!).color, getComputedStyle(el).backgroundColor]);
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
    }
    // Locked by the streamer: the swatches go away and the reason shows.
    hub.setYou({ colorLocked: true });
    await expect(pop.locator('button.swatch').first()).toBeHidden();
    await expect(pop).toContainText('The streamer chose your colour');
  });

  test('emoji and emote picker: emotes at once, emoji loaded on first open, search, insert at the caret', async ({ page }) => {
    const hub = new MockHub('Bia');
    const emojiChunks: string[] = [];
    page.on('request', (r) => {
      if (/\/assets\/(en|pt-BR)-[\w-]+\.js$/.test(r.url())) emojiChunks.push(r.url());
    });
    await openWatch(page, hub);
    expect(emojiChunks).toHaveLength(0);
    await page.getByTestId('chat-picker-button').click();
    const picker = page.getByTestId('chat-picker');
    await expect(picker.locator('section[data-group="emotes"] button.pick')).toHaveCount(20);
    await expect(picker.locator('section[data-group="0"] button.pick').first()).toBeVisible();
    expect(emojiChunks.length).toBe(1);
    await page.getByTestId('chat-picker-search').fill('red heart');
    await expect(picker.locator('button.pick[aria-label="red heart"]')).toBeVisible();
    await picker.locator('button.pick[aria-label="red heart"]').click();
    await page.getByTestId('chat-picker-search').fill('gg');
    await picker.locator('button.pick[data-code="gg"]').click();
    await expect(page.getByTestId('chat-input')).toHaveValue('❤️:gg: ');
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    // Recent picks come first next time.
    await page.getByTestId('chat-picker-button').click();
    await expect(picker.locator('section[data-group="recent"] button.pick')).toHaveCount(2);
  });

  test('emotes off: no picker; chat off: the box says so', async ({ page }) => {
    const hub = new MockHub('Bia', { settings: { content: ['text'] } });
    await openWatch(page, hub);
    await expect(page.getByTestId('chat-picker-button')).toBeHidden();
    hub.setSettings({ enabled: false });
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toHaveText('The chat is off.');
  });

  test('muted: the box is disabled until the stream ends', async ({ page }) => {
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    hub.setYou({ mutedUntil: 'live' });
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toHaveText('You are muted until the stream ends.');
  });

  test('deletes and clears reach the list; a server bug cannot reach the DOM; boxes clip', async ({ page }) => {
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const list = page.getByTestId('chat-list');
    const s1 = hub.say(ana, 'apaga isso');
    hub.say(ana, 'Z' + '́̂̃̄'.repeat(1) + 'À́̂̃ L G O '.repeat(40));
    // Not allowed by the server's pipeline: a bidi override. The client hides it.
    hub.say(ana, 'abc‮fdp.exe');
    await expect(list.locator('li.msg')).toHaveCount(3);
    await expect(list.locator('li.hidden-msg')).toHaveText('Message hidden');
    const box = await list.locator('li.msg').nth(1).boundingBox();
    const lh = await list.locator('li.msg').nth(1).evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
    expect(box!.height).toBeLessThanOrEqual(lh * 6 + 8);
    hub.remove([s1]);
    await expect(list.locator('li.msg')).toHaveCount(2);
    hub.clear();
    await expect(list.locator('li.msg')).toHaveCount(0);
  });

  test('chat under the player on a phone @mobile', async ({ page }) => {
    const hub = new MockHub('Bia');
    hub.say(ana, 'oi do celular');
    await openWatch(page, hub);
    const player = await page.locator('.player').boundingBox();
    const chat = await page.getByTestId('chat').boundingBox();
    expect(chat!.y).toBeGreaterThan(player!.y + player!.height - 1);
    expect(chat!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});

// Screenshots for review, not a check: set CHAT_SCREENSHOTS to a folder and run with -g screenshots.
test('screenshots', async ({ page, browserName }, testInfo) => {
  const dir = process.env.CHAT_SCREENSHOTS;
  test.skip(!dir, 'CHAT_SCREENSHOTS not set');
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir!, `${testInfo.project.name}-${browserName}-${name}.png`) });
  };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const hub = new MockHub('Bia', { settings: { slowS: 2 } });
    hub.say(ana, 'boa noite, chat! :hi:');
    hub.say({ a: 'k5', n: 'Rafa', c: '#46a758', r: 'viewer' }, 'que live boa 🔥🔥 :gg:');
    hub.say({ a: 'k6', n: 'נועה', c: '#e5484d', r: 'viewer' }, 'שלום לכולם 123');
    hub.say(streamer, 'Valeu por estarem aqui! :love:');
    hub.say({ a: 'k7', n: 'Zé', c: '#ffee88', r: 'viewer' }, 'Z̷̢A̴L̵G̶O̷ ' + 'texto longo que quebra a linha sem sair da caixa '.repeat(5));
    hub.say({ a: 'k8', n: 'Bot', c: '#0090ff', r: 'viewer' }, 'abc‮fdp.exe');
    await openWatch(page, hub, { lang: 'pt-BR' });
    await page.getByTestId('chat-input').fill('oi :wow:');
    await shot(`${scheme}-chat`);
    if (testInfo.project.name.startsWith('mobile')) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      continue;
    }
    await page.getByTestId('chat-picker-button').click();
    await expect(page.getByTestId('chat-picker').locator('section[data-group="0"]')).toBeVisible();
    await shot(`${scheme}-picker`);
    await page.keyboard.press('Escape');
    await page.getByTestId('chat-settings-button').click();
    await shot(`${scheme}-settings`);
    await page.keyboard.press('Escape');
    await page.getByTestId('chat-hide').click();
    await shot(`${scheme}-hidden`);
    await page.getByTestId('chat-show').click();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
