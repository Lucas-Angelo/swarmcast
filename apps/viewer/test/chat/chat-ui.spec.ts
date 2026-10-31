// The viewer chat UI in chromium, firefox and webkit, against the mock hub (no server needed).
// Run: npm run build -w @swarmcast/viewer && npx playwright test -c apps/viewer/test/chat/playwright.config.ts
// Each test opens its own page on a hub of its own. The hub holds the echo of the page's own
// message when a test wants to see "sending…": nothing here waits on a timer.
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { emojiData } from '../../scripts/emoji-data.mjs';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild, reviewScreenshot } from './watch-page.js';

test.beforeAll(requireBuild);

const ana = { a: 'k2', n: 'Ana', c: '#d4a017', r: 'viewer' as const };
const streamer = { a: 'k0', n: 'Lucas', c: '#000000', r: 'streamer' as const };
/** Too light for the light theme. */
const clara = { a: 'k3', n: 'Clara', c: '#ffee88', r: 'viewer' as const };
/** Too dark for the dark theme. */
const escuro = { a: 'k4', n: 'Escuro', c: '#101010', r: 'viewer' as const };
const HOSTILE = '<img src=x onerror=alert(1)> **bold** https://evil.example/x.png';
/** Allowed through the server's pipeline only by a bug: a bidi override. The client hides it. */
const BIDI_OVERRIDE = 'abc‮fdp.exe';
/** A long Zalgo line: shaped wildly, it must stay inside its row's clamp. */
const ZALGO = 'Z' + '́̂̃̄' + 'À́̂̃ L G O '.repeat(40);
/** The clamp of a chat row: at most this many lines (chat.css, desktop width), plus padding. */
const ROW_MAX_LINES = 6;
/** Emoji chunk of the picker, per language (Vite names it after the language). */
const EMOJI_CHUNK = /\/assets\/(en|pt-BR)-[\w-]+\.js$/;

/** The picker's emoji (English), in its order: what the picker must offer, all of it. */
const EMOJI_EN = emojiData('en').groups.flatMap(([, rows]) => rows);
/** The emoji buttons of the picker (in the emoji categories, not the recent picks or the emotes). */
const EMOJI_BUTTONS = 'section[data-group]:not([data-group="recent"]):not([data-group="emotes"]) button.pick';
/** The smallest emoji cell of the picker grid (chat.css: minmax(36px, 1fr), min-height 36px). */
const CELL_MIN_PX = 36;

/**
 * Notes, in the page, the emoji buttons the picker has built at the moment its emoji categories
 * first appear (a MutationObserver runs before any later task of the page, idle work included),
 * and how many cells fit in its visible list. Call before opening the picker.
 */
async function emojiBuiltAtOpen(page: Page): Promise<() => Promise<{ built: number; fit: number }>> {
  await page.evaluate(
    ({ selector, cell }) => {
      const panel = document.querySelector('[data-testid="chat-picker"]')!;
      const w = window as unknown as { __atOpen?: { built: number; fit: number } };
      const mo = new MutationObserver(() => {
        if (!panel.querySelector('section[data-group="0"]')) return;
        const body = panel.querySelector<HTMLElement>('.picker-body')!;
        w.__atOpen = { built: panel.querySelectorAll(selector).length, fit: Math.ceil(body.clientHeight / cell + 1) * Math.floor(body.clientWidth / cell) };
        mo.disconnect();
      });
      mo.observe(panel, { childList: true, subtree: true });
    },
    { selector: EMOJI_BUTTONS, cell: CELL_MIN_PX },
  );
  return async () => {
    await expect.poll(() => page.evaluate(() => (window as unknown as { __atOpen?: unknown }).__atOpen ?? null)).not.toBeNull();
    return page.evaluate(() => (window as unknown as { __atOpen: { built: number; fit: number } }).__atOpen);
  };
}

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

/** The text colour of every name in the chat list and the list's background. */
async function nameColours(page: Page): Promise<{ names: string[]; background: string }> {
  const list = page.getByTestId('chat-list');
  return {
    names: await list.locator('.nick').evaluateAll((els) => els.map((e) => getComputedStyle(e).color)),
    background: await list.evaluate((el) => getComputedStyle(el).backgroundColor),
  };
}

test.describe('viewer chat (mock hub)', () => {
  test('shows history as text, with emotes as images', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.say(ana, 'oi gente :hi:');

    // Act
    await openWatch(page, hub);

    // Assert
    const list = page.getByTestId('chat-list');
    await expect(list.locator('li.msg')).toHaveCount(1);
    await expect(list.locator('li.msg .nick')).toHaveText('Ana');
    await expect(list.locator('li.msg img.emote')).toHaveAttribute('alt', ':hi:');
  });

  test('new messages come as text only, isolated, and the streamer has a badge', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.say(ana, 'oi gente :hi:');
    await openWatch(page, hub);
    const list = page.getByTestId('chat-list');
    await expect(list.locator('li.msg')).toHaveCount(1);

    // Act
    hub.say(ana, HOSTILE);
    hub.say(streamer, 'bem-vindos');

    // Assert
    await expect(list.locator('li.msg')).toHaveCount(3);
    const hostile = list.locator('li.msg').nth(1);
    await expect(hostile.locator('.text')).toHaveText(HOSTILE);
    await expect(hostile.locator('img, a')).toHaveCount(0);
    await expect(hostile.locator('bdi.text')).toHaveAttribute('dir', 'auto');
    await expect(list.locator('li.from-streamer .badge')).toHaveText('Streamer');
  });

  test('sends with Enter: "sending…" until the server copy arrives; the frame starts with t', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.holdEchoes();
    await openWatch(page, hub);
    const input = page.getByTestId('chat-input');
    const list = page.getByTestId('chat-list');

    // Act
    await input.fill('boa noite chat 😀');

    // Assert
    await expect(page.getByTestId('chat-counter')).toHaveText('16/200');

    // Act
    await input.press('Enter');

    // Assert
    await expect(input).toHaveValue('');
    await expect(list.locator('li.pending .state')).toHaveText('sending…');
    await expect.poll(() => hub.framesOf('chat.send')).toHaveLength(1);
    expect(Object.keys(hub.framesOf('chat.send')[0]!)[0]).toBe('t');

    // Act
    hub.releaseEchoes();

    // Assert
    await expect(list.locator('li.msg').last().locator('.text')).toHaveText('boa noite chat 😀');
    await expect(list.locator('li.pending')).toHaveCount(0);
    await expect(list.locator('li.msg')).toHaveCount(1);
  });

  for (const [lang, reason] of [
    ['en', /blocked/i],
    ['pt-BR', /bloquead/i],
  ] as const) {
    test(`a reject explains itself (${lang}) and gives the text back`, async ({ page }) => {
      // Arrange
      const hub = new MockHub('Bia');
      hub.rejectNext = { code: 'chat.err.blocked' };
      await openWatch(page, hub, { lang });
      const input = page.getByTestId('chat-input');

      // Act
      await input.fill('palavra feia');
      await input.press('Enter');

      // Assert
      await expect(page.getByTestId('chat-status')).toHaveText(reason);
      await expect(input).toHaveValue('palavra feia');
      await expect(page.getByTestId('chat-list').locator('li.failed')).toHaveCount(1);
    });
  }

  test('slow mode: Send waits and says for how long', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia', { settings: { slowS: 5 } });
    await openWatch(page, hub);
    const input = page.getByTestId('chat-input');

    // Act
    await input.fill('um');
    await input.press('Enter');
    await input.fill('dois');

    // Assert
    await expect(page.getByTestId('chat-mode')).toContainText('5 s');
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toContainText(/send again in [45] s/);
  });

  test('over the limit: the counter turns red and Send is disabled', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia', { settings: { maxGraphemes: 20 } });
    await openWatch(page, hub);

    // Act
    await page.getByTestId('chat-input').fill('a'.repeat(21));

    // Assert
    await expect(page.getByTestId('chat-counter')).toHaveClass(/over/);
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toContainText('21 of 20');
  });

  test('hide chat is remembered across a reload; "Show chat" counts what arrived', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);

    // Act
    await page.getByTestId('chat-hide').click();

    // Assert
    await expect(page.getByTestId('chat')).toBeHidden();
    await expect(page.getByTestId('chat-show')).toBeVisible();

    // Act
    await page.reload();

    // Assert
    await expect(page.getByTestId('chat-show')).toBeVisible();
    await expect(page.getByTestId('chat')).toBeHidden();

    // Act
    hub.say(ana, 'um');
    hub.say(ana, 'dois');

    // Assert
    await expect(page.getByTestId('chat-show')).toContainText('2 new');

    // Act
    await page.getByTestId('chat-show').click();

    // Assert
    await expect(page.getByTestId('chat')).toBeVisible();
    await expect(page.getByTestId('chat-list').locator('li.msg')).toHaveCount(2);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`names reach 4.5:1 against the chat background (${scheme} theme), colours set through the CSSOM`, async ({ page }) => {
      // Arrange
      await page.emulateMedia({ colorScheme: scheme });
      const hub = new MockHub('Bia');
      for (const author of [clara, escuro, ana]) hub.say(author, 'oi');

      // Act
      await openWatch(page, hub);
      await expect(page.getByTestId('chat-list').locator('li.msg')).toHaveCount(3);
      const { names, background } = await nameColours(page);

      // Assert
      for (const color of names) expect(contrast(color, background), `${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('the colour chooser tells the server and previews the name readably on both themes', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await page.getByTestId('chat-settings-button').click();

    // Act
    await page.getByTestId('chat-settings').locator('button.swatch').nth(2).click();

    // Assert
    await expect.poll(() => hub.framesOf('chat.color').at(-1)?.color).toBe('#d4a017');
    for (const theme of ['light', 'dark'] as const) {
      const sample = page.getByTestId(`chat-color-preview-${theme}`);
      await expect(sample.locator('.nick')).toHaveText('Bia');
      const [fg, bg] = await sample.evaluate((el) => [getComputedStyle(el.querySelector('.nick')!).color, getComputedStyle(el).backgroundColor]);
      expect(contrast(fg!, bg!), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('a colour locked by the streamer: the swatches go away and the reason shows', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    await page.getByTestId('chat-settings-button').click();
    const pop = page.getByTestId('chat-settings');
    await expect(pop.locator('button.swatch').first()).toBeVisible();

    // Act
    hub.setYou({ colorLocked: true });

    // Assert
    await expect(pop.locator('button.swatch').first()).toBeHidden();
    await expect(pop).toContainText('The streamer chose your colour');
  });

  test('emoji and emote picker: emotes at once, emoji loaded on first open, search, insert at the caret, recent first', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    const emojiChunks: string[] = [];
    page.on('request', (r) => {
      if (EMOJI_CHUNK.test(r.url())) emojiChunks.push(r.url());
    });
    const picker = page.getByTestId('chat-picker');

    // Act
    await openWatch(page, hub);

    // Assert
    expect(emojiChunks).toHaveLength(0);

    // Act
    await page.getByTestId('chat-picker-button').click();

    // Assert
    await expect(picker.locator('section[data-group="emotes"] button.pick')).toHaveCount(20);
    await expect(picker.locator('section[data-group="0"] button.pick').first()).toBeVisible();
    expect(emojiChunks).toHaveLength(1);

    // Act
    await page.getByTestId('chat-picker-search').fill('red heart');
    await picker.locator('button.pick[aria-label="red heart"]').click();
    await page.getByTestId('chat-picker-search').fill('gg');
    await picker.locator('button.pick[data-code="gg"]').click();

    // Assert
    await expect(page.getByTestId('chat-input')).toHaveValue('❤️:gg: ');

    // Act
    await page.keyboard.press('Escape');

    // Assert
    await expect(picker).toBeHidden();

    // Act
    await page.getByTestId('chat-picker-button').click();

    // Assert
    await expect(picker.locator('section[data-group="recent"] button.pick')).toHaveCount(2);
  });

  test('emoji picker: opens with only the emoji in view; scrolling, search and the arrow keys still reach every emoji', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const picker = page.getByTestId('chat-picker');
    const builtAtOpen = await emojiBuiltAtOpen(page);
    const last = EMOJI_EN.at(-1)!;

    // Act
    await page.getByTestId('chat-picker-button').click();

    // Assert
    await expect(picker.locator('section[data-group="0"] button.pick').first()).toBeInViewport();
    const atOpen = await builtAtOpen();
    expect(atOpen.built).toBeGreaterThan(0);
    expect(atOpen.built).toBeLessThanOrEqual(atOpen.fit);
    expect(atOpen.fit).toBeLessThan(EMOJI_EN.length / 4);

    // Act
    await picker.locator('button.pick').first().press('End');

    // Assert
    await expect(picker.locator(`button.pick[aria-label="${last[1]}"]`)).toBeInViewport();
    await expect(picker.locator(EMOJI_BUTTONS)).toHaveCount(EMOJI_EN.length);
    expect(await picker.locator(EMOJI_BUTTONS).evaluateAll((bs) => bs.map((b) => b.textContent))).toEqual(EMOJI_EN.map(([ch]) => ch));

    // Act
    await page.getByTestId('chat-picker-search').fill(last[2]);

    // Assert
    await expect(picker.locator(`button.pick[aria-label="${last[1]}"]`)).toBeInViewport();

    // Act
    await page.getByTestId('chat-picker-search').fill('');
    const first = picker.locator('button.pick').first();
    await first.press('ArrowRight');

    // Assert
    await expect(picker.locator('button.pick').nth(1)).toBeFocused();

    // Act
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');

    // Assert
    const below = await picker.evaluate((el) => {
      const [a] = el.querySelectorAll<HTMLElement>('button.pick');
      const b = document.activeElement as HTMLElement;
      return { sameColumn: a!.offsetLeft === b.offsetLeft, lower: b.offsetTop > a!.offsetTop, pick: b.matches('button.pick') };
    });
    expect(below).toEqual({ sameColumn: true, lower: true, pick: true });
  });

  test('emotes off: no picker', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia', { settings: { content: ['text'] } });

    // Act
    await openWatch(page, hub);

    // Assert
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await expect(page.getByTestId('chat-picker-button')).toBeHidden();
  });

  test('chat turned off: the box says so', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia', { settings: { content: ['text'] } });
    await openWatch(page, hub);

    // Act
    hub.setSettings({ enabled: false });

    // Assert
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toHaveText('The chat is off.');
  });

  test('muted: the box is disabled until the stream ends', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);

    // Act
    hub.setYou({ mutedUntil: 'live' });

    // Assert
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-status')).toHaveText('You are muted until the stream ends.');
  });

  test('a server bug cannot reach the DOM, and a wild line stays inside its clamp', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const list = page.getByTestId('chat-list');

    // Act
    hub.say(ana, 'apaga isso');
    hub.say(ana, ZALGO);
    hub.say(ana, BIDI_OVERRIDE);

    // Assert
    await expect(list.locator('li.msg')).toHaveCount(3);
    await expect(list.locator('li.hidden-msg')).toHaveText('Message hidden');
    const zalgo = list.locator('li.msg').nth(1);
    const box = await zalgo.boundingBox();
    const lineHeight = await zalgo.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(box!.height).toBeLessThanOrEqual(lineHeight * ROW_MAX_LINES + 8);
  });

  test('deletes and clears reach the list', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const list = page.getByTestId('chat-list');
    const first = hub.say(ana, 'apaga isso');
    hub.say(ana, 'fica');
    hub.say(ana, 'fica também');
    await expect(list.locator('li.msg')).toHaveCount(3);

    // Act
    hub.remove([first]);

    // Assert
    await expect(list.locator('li.msg')).toHaveCount(2);

    // Act
    hub.clear();

    // Assert
    await expect(list.locator('li.msg')).toHaveCount(0);
  });

  test('chat under the player on a phone @mobile', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.say(ana, 'oi do celular');

    // Act
    await openWatch(page, hub);
    const player = await page.locator('.player').boundingBox();
    const chat = await page.getByTestId('chat').boundingBox();

    // Assert
    expect(chat!.y).toBeGreaterThan(player!.y + player!.height - 1);
    expect(chat!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});

// Screenshots for review, not a check: set CHAT_SCREENSHOTS to a folder and run with -g screenshots.
test('screenshots', async ({ page, browserName }, testInfo) => {
  // Arrange
  const dir = process.env.CHAT_SCREENSHOTS;
  test.skip(!dir, 'CHAT_SCREENSHOTS not set');
  const shot = (name: string) => reviewScreenshot(page, { path: path.join(dir!, `${testInfo.project.name}-${browserName}-${name}.png`) });
  const phone = testInfo.project.name.startsWith('mobile');

  for (const scheme of ['light', 'dark'] as const) {
    // Act
    await page.emulateMedia({ colorScheme: scheme });
    const hub = new MockHub('Bia', { settings: { slowS: 2 } });
    hub.say(ana, 'boa noite, chat! :hi:');
    hub.say({ a: 'k5', n: 'Rafa', c: '#46a758', r: 'viewer' }, 'que live boa 🔥🔥 :gg:');
    hub.say({ a: 'k6', n: 'נועה', c: '#e5484d', r: 'viewer' }, 'שלום לכולם 123');
    hub.say(streamer, 'Valeu por estarem aqui! :love:');
    hub.say({ a: 'k7', n: 'Zé', c: '#ffee88', r: 'viewer' }, 'Z̷̢A̴L̵G̶O̷ ' + 'texto longo que quebra a linha sem sair da caixa '.repeat(5));
    hub.say({ a: 'k8', n: 'Bot', c: '#0090ff', r: 'viewer' }, BIDI_OVERRIDE);
    await openWatch(page, hub, { lang: 'pt-BR' });
    await page.getByTestId('chat-input').fill('oi :wow:');
    await shot(`${scheme}-chat`);
    if (!phone) {
      await page.getByTestId('chat-picker-button').click();
      await expect(page.getByTestId('chat-picker').locator('section[data-group="0"]')).toBeVisible();
      await shot(`${scheme}-picker`);
      await page.keyboard.press('Escape');
      await page.getByTestId('chat-settings-button').click();
      await expect(page.getByTestId('chat-settings')).toBeVisible();
      await shot(`${scheme}-settings`);
      await page.keyboard.press('Escape');
      await page.getByTestId('chat-hide').click();
      await expect(page.getByTestId('chat-show')).toBeVisible();
      await shot(`${scheme}-hidden`);
      await page.getByTestId('chat-show').click();
    }
    await page.unrouteAll({ behavior: 'wait' });
  }
});
