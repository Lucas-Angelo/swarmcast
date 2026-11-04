// Polls and predictions on the watch page (docs/CHAT.md "Polls and predictions"), against the mock
// hub, in chromium, firefox, webkit (and the phone projects for @mobile): the card under the pinned
// bar and above the list, a vote with the mouse and with the keyboard, live percentages, the ended,
// waiting and answered states, a reload that keeps "you voted", mutes, Portuguese, the "Show chat"
// badge, text as text, and the viewer's local /help. Nothing here waits on a timer.
import { expect, test, type Page } from './fixtures.js';
import { MockHub } from './mock-hub.js';
import { openWatch, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const ana = { a: 'k2', n: 'Ana', c: '#d4a017', r: 'viewer' as const };
const streamer = { a: 'k0', n: 'Lucas', c: '#000000', r: 'streamer' as const };
const POLL = { id: 'p1', kind: 'poll' as const, q: 'Pizza ou hambúrguer?', o: ['Pizza', 'Hambúrguer'], st: 'open' as const, c: [0, 0], endsIn: 120_000 };

const card = (page: Page) => page.getByTestId('chat-poll');
const options = (page: Page) => card(page).getByTestId('chat-poll-option');

/** Top and bottom (px) of an element on screen. */
async function box(page: Page, id: string) {
  const b = (await page.getByTestId(id).boundingBox())!;
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width, height: b.height };
}

test.describe('polls and predictions (mock hub)', () => {
  test('the card sits under the pinned bar and above the list; a click votes once, live percentages follow the counts', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    const s = hub.say(streamer, 'Votem na enquete!');
    hub.pin(s);
    await openWatch(page, hub);
    await expect(card(page)).toBeHidden();

    // Act
    hub.setPoll(POLL);

    // Assert
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.poll-label')).toHaveText('Poll');
    await expect(card(page).locator('.poll-q')).toHaveText('Pizza ou hambúrguer?');
    await expect(options(page)).toHaveText([/Pizza\s*0%/, /Hambúrguer\s*0%/]);
    await expect(card(page).getByTestId('chat-poll-time')).toHaveText(/^[12]:\d\d left$/);
    const pinned = await box(page, 'chat-pinned');
    const poll = await box(page, 'chat-poll');
    const list = await box(page, 'chat-list');
    const input = await box(page, 'chat-input');
    expect(pinned.bottom).toBeLessThanOrEqual(poll.top + 1);
    expect(poll.bottom).toBeLessThanOrEqual(list.top + 1);
    expect(list.bottom).toBeLessThanOrEqual(input.top + 1);

    // Act
    await options(page).nth(1).click();

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('You voted: Hambúrguer · 1 vote');
    expect(hub.framesOf('chat.vote')).toEqual([expect.objectContaining({ t: 'chat.vote', id: 'p1', o: 1 })]);
    await expect(options(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(options(page)).toHaveText([/0%/, /100%/]);

    // Act: the other option, now that the vote is final (the button keeps the focus but does nothing).
    await options(page).nth(0).focus();
    await page.keyboard.press('Enter');
    hub.tally([3, 1]);

    // Assert
    await expect(options(page)).toHaveText([/^Pizza\s*75%$/, /^Hambúrguer \(Your vote\)\s*25%$/]);
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('You voted: Hambúrguer · 4 votes');
    expect(hub.framesOf('chat.vote')).toHaveLength(1);
    const bar = await options(page).nth(0).locator('.poll-bar').evaluate((el) => getComputedStyle(el).getPropertyValue('--p').trim());
    expect(bar).toBe('0.75');
  });

  test('keyboard only: Enter or Space on a focused option votes; the vote is announced politely; the buttons keep the focus and do nothing more', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.setPoll(POLL);
    await openWatch(page, hub);
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId('chat-poll-live')).toHaveText('The streamer started a poll: Pizza ou hambúrguer?');

    // Act
    await options(page).nth(1).focus();
    await page.keyboard.press('Enter');

    // Assert
    await expect(options(page).nth(1)).toBeFocused();
    await expect(options(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
    for (const i of [0, 1]) await expect(options(page).nth(i)).toHaveAttribute('aria-disabled', 'true');
    await expect(card(page)).toHaveAttribute('aria-labelledby', /chat-poll-q-/);
    await expect(page.getByTestId('chat-poll-live')).toHaveText('You voted: Hambúrguer');

    // Act
    await options(page).nth(0).focus();
    await page.keyboard.press('Space');

    // Assert
    await expect(options(page).nth(0)).toBeFocused();
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('You voted: Hambúrguer · 1 vote');
    expect(hub.framesOf('chat.vote')).toHaveLength(1);
  });

  test('ended, then gone; a prediction waits for the answer, then shows it with who got it right, and whether this viewer did', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.setPoll(POLL);
    await openWatch(page, hub);
    await options(page).nth(0).click();
    await expect(card(page).getByTestId('chat-poll-status')).toContainText('You voted: Pizza');

    // Act
    hub.setPoll({ st: 'closed', c: [5, 2] });

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('Poll ended · 7 votes · You voted: Pizza');
    await expect(card(page).getByTestId('chat-poll-time')).toBeHidden();

    // Act
    hub.setPoll(null);
    hub.setPoll({ id: 'p2', kind: 'prediction', q: 'Quem ganha?', o: ['Ana', 'Bia', 'Caio'], st: 'open', c: [0, 0, 0], endsIn: 60_000, newOnly: true });
    await expect(card(page).locator('.poll-label')).toHaveText('Prediction');
    await options(page).nth(2).click();
    await expect(card(page).getByTestId('chat-poll-status')).toContainText('Your guess: Caio');
    hub.setPoll({ st: 'locked', c: [2, 1, 1] });

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('Guesses are closed. Waiting for the answer… · 4 guesses · Your guess: Caio');

    // Act
    hub.setPoll({ st: 'resolved', win: 2 });

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('The answer: Caio · 1 person got it right · You got it!');
    await expect(options(page).nth(2)).toHaveClass(/win/);
    await expect(options(page).nth(2)).toContainText('Right answer');
  });

  test('a reload keeps "you voted"; a refusal is shown in the card', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    hub.setPoll(POLL);
    await openWatch(page, hub);
    hub.rejectVote = 'chat.err.pollLate';

    // Act
    await options(page).nth(0).click();

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('Only people who were already watching when it started can vote. · 0 votes');

    // Act
    await options(page).nth(0).click();
    await expect(card(page).getByTestId('chat-poll-status')).toContainText('You voted: Pizza');
    await openWatch(page, hub);

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('You voted: Pizza · 1 vote');
    await expect(options(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  });

  test('muted: the options show, voting does not', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia', { you: { mutedUntil: 'live' } });
    hub.setPoll(POLL);
    await openWatch(page, hub);

    // Act
    await options(page).nth(0).focus();
    await page.keyboard.press('Enter');

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('Muted people cannot vote. · 0 votes');
    await expect(options(page).nth(0)).toHaveAttribute('aria-disabled', 'true');
    expect(hub.framesOf('chat.vote')).toEqual([]);
  });

  test('in Portuguese; chat hidden: "Show chat" says a poll is open; chat off: no card; ▾ folds it', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub, { lang: 'pt-BR' });
    await page.getByTestId('chat-hide').click();

    // Act
    hub.setPoll(POLL);

    // Assert
    await expect(page.getByTestId('chat-show-poll')).toHaveText('Enquete');

    // Act
    await page.getByTestId('chat-show').click();

    // Assert
    await expect(card(page).locator('.poll-label')).toHaveText('Enquete');
    await expect(card(page).getByTestId('chat-poll-status')).toHaveText('Toque numa opção. Seu voto é definitivo e anônimo. · 0 votos');
    await expect(card(page).getByTestId('chat-poll-time')).toHaveText(/^Faltam [12]:\d\d$/);

    // Act
    await card(page).getByTestId('chat-poll-toggle').click();

    // Assert
    await expect(card(page).locator('.poll-body')).toBeHidden();
    await expect(card(page).getByTestId('chat-poll-toggle')).toHaveAttribute('aria-expanded', 'false');

    // Act
    hub.setSettings({ enabled: false });

    // Assert
    await expect(card(page)).toBeHidden();
  });

  test('question and options are text, never markup', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    const errors = await openWatch(page, hub);

    // Act
    hub.setPoll({ ...POLL, q: '<img src=x onerror=alert(1)> **negrito**', o: ['<b>a</b>', 'https://evil.example/x.png'] });

    // Assert
    await expect(card(page).locator('.poll-q')).toHaveText('<img src=x onerror=alert(1)> **negrito**');
    await expect(options(page).nth(0).locator('.poll-text')).toHaveText('<b>a</b>');
    await expect(card(page).locator('img, b, a')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a viewer\'s /help is answered on the page and never sent; a streamer command is not sent either', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    await openWatch(page, hub);
    const input = page.getByTestId('chat-input');

    // Act
    await input.fill('/ajuda');
    await input.press('Enter');

    // Assert
    await expect(page.getByTestId('chat-help')).toBeVisible();
    await expect(page.getByTestId('chat-help').locator('li')).toHaveCount(4);
    await expect(input).toHaveValue('');

    // Act
    await input.fill('/poll Pizza? | sim | não');
    await input.press('Enter');

    // Assert
    await expect(page.getByTestId('chat-status')).toHaveText('Only the streamer can use this command. Type /help to see what you can do.');
    await expect(input).toHaveValue('/poll Pizza? | sim | não');
    expect(hub.framesOf('chat.send')).toEqual([]);

    // Act
    await page.getByTestId('chat-help-close').click();

    // Assert
    await expect(page.getByTestId('chat-help')).toBeHidden();
  });

  test('on a phone: a new poll starts folded to one line, the list keeps room and the box stays below; a tap opens it, the options are big enough to tap @mobile', async ({ page }) => {
    // Arrange
    const hub = new MockHub('Bia');
    for (let i = 0; i < 5; i++) hub.say(ana, `oi ${i}`);
    await openWatch(page, hub);

    // Act
    hub.setPoll({ ...POLL, kind: 'prediction', q: 'Quem vai ganhar a partida de hoje à noite, depois da prorrogação?', o: ['Time azul', 'Time verde', 'Empate', 'Ninguém sabe', 'Vai chover'], c: [0, 0, 0, 0, 0] });

    // Assert
    await expect(card(page).getByTestId('chat-poll-peek')).toBeVisible();
    await expect(card(page).locator('.poll-body')).toBeHidden();
    const chat = (await page.getByTestId('chat').boundingBox())!;
    const poll = await box(page, 'chat-poll');
    const list = await box(page, 'chat-list');
    const input = await box(page, 'chat-input');
    expect(poll.left).toBeGreaterThanOrEqual(chat.x - 1);
    expect(poll.right).toBeLessThanOrEqual(chat.x + chat.width + 1);
    expect(poll.bottom).toBeLessThanOrEqual(list.top + 1);
    expect(list.bottom).toBeLessThanOrEqual(input.top + 1);
    const line = await page.getByTestId('chat-list').locator('li.msg').first().evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(list.height).toBeGreaterThanOrEqual(3 * line);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Act
    await card(page).getByTestId('chat-poll-peek').tap();

    // Assert
    await expect(card(page).locator('.poll-body')).toBeVisible();
    const tap = (await options(page).first().boundingBox())!;
    expect(tap.height).toBeGreaterThanOrEqual(36);
    expect(tap.x + tap.width).toBeLessThanOrEqual(chat.x + chat.width + 1);

    // Act
    await options(page).nth(4).scrollIntoViewIfNeeded();
    await options(page).nth(4).tap();

    // Assert
    await expect(card(page).getByTestId('chat-poll-status')).toContainText('Your guess: Vai chover');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
