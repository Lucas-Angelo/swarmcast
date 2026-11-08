// Reactions over the video on the watch page (docs/CHAT.md "Reactions"), against the mock hub, in
// chromium, firefox, webkit (and the phone projects for @mobile): the React button and its eight
// named reactions (mouse and keyboard), the page's own floater at once and its frames, everyone's
// reactions floating inside the player under its controls (capped, never taking a click), "reduce
// motion" (a calm counter instead), the viewer's own "Show reactions" (remembered), the streamer
// turning them off, mutes, Portuguese, both themes, a storm, and phones. Floaters are recorded as
// they are added (a MutationObserver in the page), so no check races their animation, and nothing
// here waits on a fixed time. Where a check depends on the page's timers (the sender's next frame
// window, CHAT_REACT_FRAME_MS: three Playwright clicks, each waiting for two stable animation
// frames, can outlast it on a slow runner; the calm counter going after CALM_COUNTER_MS), the
// page's clock stands still and the test runs it (freezePageClock).
import { CHAT_REACT_FRAME_MS } from '@swarmcast/shared';
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { freezePageClock, openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const ana = { a: 'k2', n: 'Ana', c: '#d4a017', r: 'viewer' as const };
const MAX = [20, 20, 20, 20, 20, 20, 20, 20];
const reactButton = (page: Page) => page.getByTestId('chat-react-button');
const options = (page: Page) => page.getByTestId('chat-react').getByTestId('chat-react-option');
const hubWithReactions = (over: ConstructorParameters<typeof MockHub>[1] = {}) => new MockHub('Bia', { ...over, settings: { reactions: true, ...over.settings } });

interface Seen {
  parent: string;
  inPlayer: boolean;
  beforeControls: boolean;
  pointerEvents: string;
  hitsItself: boolean;
  src: string;
}

/** Records every floater the page adds (where it is, what it is), and every CSP violation. */
async function watchFloaters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __seen: Seen[]; __csp: string[] };
    w.__seen = [];
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLImageElement) || !n.classList.contains('rx-float')) continue;
          const layer = n.parentElement!;
          const player = layer.parentElement!;
          const controls = player.querySelector('.pc');
          const box = n.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          w.__seen.push({
            parent: layer.className,
            inPlayer: player.classList.contains('player'),
            beforeControls: !!controls && !!(layer.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING),
            pointerEvents: getComputedStyle(layer).pointerEvents,
            hitsItself: hit === n,
            src: n.src,
          });
        }
    }).observe(document.querySelector('.player')!, { childList: true, subtree: true });
  });
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);

/**
 * Records from now on each time the React button is shown or hidden, with the page's Date.now(). A
 * timed mute is checked by when the button came back, not by looking while the mute lasts: a
 * frame that reaches a slow page after the mute ended shows it at once, which is right, and a
 * look meant for "while it lasts" would then see it.
 */
async function recordShown(page: Page): Promise<void> {
  await reactButton(page).evaluate((el) => {
    const w = window as unknown as { __shown: Array<{ shown: boolean; at: number }> };
    w.__shown = [];
    new MutationObserver(() => w.__shown.push({ shown: !(el as HTMLElement).hidden, at: Date.now() })).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });
}
const shownLog = (page: Page) => page.evaluate(() => (window as unknown as { __shown: Array<{ shown: boolean; at: number }> }).__shown);

const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __swarmcastChat: { stats: { reactions: { alive: number; spawned: number; peak: number } } } }).__swarmcastChat.stats.reactions);

/** A message from Ana that the page shows: everything the hub sent before it has been handled. */
async function settle(page: Page, hub: MockHub, text: string): Promise<void> {
  hub.say(ana, text);
  await expect(page.getByTestId('chat-list').locator('li.msg').last()).toContainText(text);
}

test.describe('reactions over the video (mock hub)', () => {
  test('a named React button opens eight named reactions; a tap floats one over the video at once, inside the player under its controls, never taking a click; the taps after it go together', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await freezePageClock(page);
    await openWatch(page, hub);
    await watchFloaters(page);

    // Act
    await reactButton(page).click();

    // Assert
    await expect(reactButton(page)).toHaveAccessibleName('React');
    await expect(reactButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(options(page)).toHaveCount(8);
    const names = await options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names).toEqual(['Love', 'Hype', 'Funny', 'Wow', 'GG', 'Fire', 'Sad', 'Hi']);

    // Act
    await options(page).nth(5).click();
    await options(page).nth(5).click();
    await options(page).nth(0).click();

    // Assert
    await expect.poll(() => hub.framesOf('chat.react')).toEqual([{ t: 'chat.react', c: [0, 0, 0, 0, 0, 1] }]);

    // Act
    await page.clock.runFor(CHAT_REACT_FRAME_MS);

    // Assert
    await expect.poll(() => seen(page).then((s) => s.length)).toBe(3);
    for (const s of await seen(page)) {
      expect(s).toMatchObject({ parent: 'rx-layer', inPlayer: true, beforeControls: true, pointerEvents: 'none', hitsItself: false });
      expect(new URL(s.src).origin).toBe('http://chat.test');
    }
    await expect.poll(() => hub.framesOf('chat.react').length).toBe(2);
    expect(hub.framesOf('chat.react')).toEqual([
      { t: 'chat.react', c: [0, 0, 0, 0, 0, 1] },
      { t: 'chat.react', c: [1, 0, 0, 0, 0, 1] },
    ]);
    await expect(page.getByTestId('chat-react')).toBeVisible();
    expect(await cspViolations(page)).toEqual([]);
  });

  test('keyboard only: Enter opens, the arrows move, Enter and Space tap, Escape closes and gives the focus back', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub);
    await reactButton(page).focus();

    // Act
    await page.keyboard.press('Enter');
    await expect(options(page).nth(0)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Assert
    await expect(options(page).nth(5)).toBeFocused();
    await expect.poll(() => hub.framesOf('chat.react')).toEqual([{ t: 'chat.react', c: [0, 0, 0, 0, 0, 1] }]);

    // Act
    await page.keyboard.press('Home');
    await page.keyboard.press(' ');
    await page.keyboard.press('Escape');

    // Assert
    await expect(page.getByTestId('chat-react')).toBeHidden();
    await expect(reactButton(page)).toBeFocused();
    await expect.poll(() => hub.framesOf('chat.react').length).toBe(2);
    expect(hub.framesOf('chat.react')[1]).toEqual({ t: 'chat.react', c: [1] });
  });

  test("everyone's reactions float over the video: at most 8 per window, at most 24 at once; the page's own taps are not drawn twice", async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub);

    // Act
    hub.reactions(MAX);
    await expect.poll(() => stats(page).then((s) => s.spawned)).toBe(8);
    for (let i = 0; i < 5; i++) hub.reactions(MAX);
    await settle(page, hub, 'depois da chuva');

    // Assert
    expect((await stats(page)).peak).toBe(24);

    // Act: wait for the screen to be clear, then tap once and get that tap back from the server.
    await expect.poll(() => stats(page).then((s) => s.alive), { timeout: 10_000 }).toBe(0);
    const before = (await stats(page)).spawned;
    await reactButton(page).click();
    await options(page).nth(3).click();
    await expect.poll(() => hub.framesOf('chat.react').length).toBe(1);
    hub.reactions([0, 0, 0, 1]);
    await settle(page, hub, 'eco');

    // Assert
    expect((await stats(page)).spawned).toBe(before + 1);
  });

  test('"reduce motion": nothing floats; a calm counter per kind counts up in place, in a fixed order', async ({ page }) => {
    // Arrange
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const hub = hubWithReactions();
    await freezePageClock(page);
    await openWatch(page, hub);
    const chips = page.getByTestId('reactions-tally').locator('.rx-chip');

    // Act
    hub.reactions([0, 0, 0, 0, 0, 3]);
    hub.reactions([1, 0, 0, 0, 0, 1]);

    // Assert
    await expect.poll(() => chips.evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.reaction} ${e.textContent}`))).toEqual(['love 1', 'fire 4']);
    expect((await stats(page)).spawned).toBe(0);
    await expect(page.locator('.rx-float')).toHaveCount(0);
  });

  test('"Show reactions on the video" off: nothing is drawn, the choice is remembered after a reload, and tapping still sends', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub);
    await page.getByTestId('chat-settings-button').click();
    const show = page.getByTestId('chat-reactions-show');
    await expect(show).toBeChecked();
    await expect(page.getByTestId('chat-settings')).toContainText('Show reactions on the video');

    // Act
    await show.uncheck();
    hub.reactions(MAX);
    await settle(page, hub, 'sem reações');

    // Assert
    expect((await stats(page)).spawned).toBe(0);
    await expect(page.getByTestId('reactions')).toBeHidden();

    // Act
    await page.reload();
    await expect(page.getByTestId('chat')).toBeVisible();
    await page.getByTestId('chat-settings-button').click();

    // Assert
    await expect(page.getByTestId('chat-reactions-show')).not.toBeChecked();

    // Act
    await page.keyboard.press('Escape');
    await reactButton(page).click();
    await options(page).nth(7).click();

    // Assert
    await expect.poll(() => hub.framesOf('chat.react').length).toBe(1);
    expect((await stats(page)).spawned).toBe(0);
  });

  test('the streamer turns reactions off: the button and the setting go, and nothing is drawn; back on, they come back', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub);
    await expect(reactButton(page)).toBeVisible();

    // Act
    hub.setSettings({ reactions: undefined });

    // Assert
    await expect(reactButton(page)).toBeHidden();
    await page.getByTestId('chat-settings-button').click();
    await expect(page.getByTestId('chat-reactions-show')).toBeHidden();
    await page.keyboard.press('Escape');
    hub.reactions(MAX);
    await settle(page, hub, 'desligadas');
    expect((await stats(page)).spawned).toBe(0);

    // Act
    hub.setSettings({ reactions: true });

    // Assert
    await expect(reactButton(page)).toBeVisible();
  });

  test('a page whose server never announces reactions (older than 0.5.1) has no React button and sends nothing', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);

    // Act
    await settle(page, hub, 'servidor antigo');

    // Assert
    await expect(reactButton(page)).toBeHidden();
    expect(hub.framesOf('chat.react')).toEqual([]);
  });

  test('muted: no React button until the mute ends; chat off: no button and nothing drawn', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub);

    // Act
    hub.setYou({ mutedUntil: 'live' });

    // Assert
    await expect(reactButton(page)).toBeHidden();

    // Act
    await recordShown(page);
    const until = Date.now() + 1500;
    hub.setYou({ mutedUntil: until });

    // Assert: back once the mute ends by itself, never before.
    await expect(reactButton(page)).toBeVisible({ timeout: 10_000 });
    const shownAt = (await shownLog(page)).find((e) => e.shown)?.at;
    expect(shownAt, 'when the React button came back').toBeGreaterThanOrEqual(until);

    // Act
    hub.setSettings({ enabled: false });

    // Assert
    await expect(reactButton(page)).toBeHidden();
    await expect(page.getByTestId('reactions')).toBeHidden();
  });

  test('in Portuguese', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub, { lang: 'pt-BR' });

    // Act
    await reactButton(page).click();

    // Assert
    await expect(reactButton(page)).toHaveAccessibleName('Reagir');
    const names = await options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names).toEqual(['Amei', 'Hype', 'Engraçado', 'Uau', 'GG', 'Fogo', 'Triste', 'Oi']);
    await expect(page.getByTestId('chat-react')).toContainText('Toque em uma: ela flutua sobre o vídeo para todo mundo.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`both themes (${scheme}): the counter is light text on the video's scrim, the popover is the chat's surface`, async ({ page }) => {
      // Arrange
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const hub = hubWithReactions();
      await freezePageClock(page);
      await openWatch(page, hub);

      // Act
        hub.reactions([2]);
      await reactButton(page).click();

      // Assert
      const chip = page.getByTestId('reactions-tally').locator('.rx-chip').first();
      await expect(chip).toHaveText('2');
      const colours = await page.evaluate(() => {
        const c = getComputedStyle(document.querySelector('.rx-chip')!);
        const pop = getComputedStyle(document.querySelector('[data-testid="chat-react"]')!);
        const chat = getComputedStyle(document.querySelector('[data-testid="chat"]')!);
        return { color: c.color, bg: c.backgroundColor, pop: pop.backgroundColor, chat: chat.backgroundColor };
      });
      expect(colours.color).toBe('rgb(255, 255, 255)');
      expect(colours.bg).toBe('rgba(0, 0, 0, 0.5)');
      expect(colours.pop).toBe(colours.chat);
    });
  }

  test('a storm: hundreds of windows at once never put more than 24 on screen, and the chat box still works', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    const errors = await openWatch(page, hub);

    // Act
    hub.reactionStorm(MAX, 300);
    await settle(page, hub, 'depois da tempestade');
    await page.getByTestId('chat-input').fill('ainda escrevo');

    // Assert
    const s = await stats(page);
    expect(s.peak).toBeLessThanOrEqual(24);
    expect(s.alive).toBeLessThanOrEqual(24);
    await expect(page.getByTestId('chat-input')).toHaveValue('ainda escrevo');
    expect(errors).toEqual([]);
  });

  test('on a phone: the React button and its reactions are big enough to tap and inside the screen; a tap floats over the video @mobile', async ({ page }) => {
    // Arrange
    const hub = hubWithReactions();
    await openWatch(page, hub);
    await watchFloaters(page);

    // Act
    await reactButton(page).tap();

    // Assert
    const pop = (await page.getByTestId('chat-react').boundingBox())!;
    const vw = await page.evaluate(() => window.innerWidth);
    expect(pop.x).toBeGreaterThanOrEqual(0);
    expect(pop.x + pop.width).toBeLessThanOrEqual(vw + 1);
    const opt = (await options(page).first().boundingBox())!;
    expect(opt.width).toBeGreaterThanOrEqual(44);
    expect(opt.height).toBeGreaterThanOrEqual(44);

    // Act
    await options(page).nth(1).tap();

    // Assert
    await expect.poll(() => seen(page).then((s) => s.length)).toBe(1);
    expect((await seen(page))[0]).toMatchObject({ inPlayer: true, pointerEvents: 'none', hitsItself: false });
    await expect.poll(() => hub.framesOf('chat.react')).toEqual([{ t: 'chat.react', c: [0, 1] }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
