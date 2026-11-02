// Chat polls, predictions and slash commands against the real server (docs/CHAT.md, "Polls and
// predictions", "Slash commands"): the panel starts one with its form or a command (English and
// Portuguese names), real viewer pages vote and see live percentages, a viewer who arrives later sees
// it with its countdown, a reload keeps "you voted", End now / Remove, a prediction answered from the
// panel, and the rules that come from moderation (a muted viewer, someone who joined after a
// prediction opened, the chat off, Clear chat). Scripted viewers (fixtures.ts ScriptedViewer) vote
// over /control where a page is not the subject.
//
// One poll at a time on the shared server: the e2e server's reset removes any poll a test left
// (server.ts), and every test starts its own. Every e2e viewer comes from 127.0.0.1, one network,
// so no test here has more than CHAT_POLL_VOTES_PER_NET (10) voters.
import type { Locator, Page } from '@playwright/test';
import type { AdminChatState } from '@swarmcast/shared';
import { admin, adminApi, chatReady, expect, FAST_CHAT, openPanel, test, uid, type ChatControl } from './fixtures.js';

const NARROW_WINDOW = { width: 420, height: 860 };

test.beforeEach(async ({ chat }) => {
  await chat.change(FAST_CHAT);
});

/** The panel (English or `lang`) while live, and its live chat column. */
async function openChat(page: Page, lang?: 'en' | 'pt-BR'): Promise<Locator> {
  await openPanel(page, lang);
  const live = page.getByTestId('chat-live');
  await expect(live.getByTestId('chat-input')).toBeVisible();
  return live;
}

const pollState = async (): Promise<AdminChatState['poll']> => (await adminApi<AdminChatState>('GET', '/api/chat')).poll;

async function sessionOf(chat: ChatControl, nickname: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = (await chat.state()).sessions.find((s) => s.nickname === nickname)?.sessionId;
      return id;
    })
    .toBeTruthy();
  return id!;
}

test('chat poll from the panel form: viewer pages vote with live results, a late viewer sees it, a reload keeps the vote, End now and Remove', { tag: '@ui' }, async ({ page, viewers, bots }) => {
  // Arrange
  const live = await openChat(page);
  const a = await viewers.join(uid('pollA'));
  const c = await bots.join(uid('pollC'));
  await chatReady(a.page);
  const question = `Pizza ou hambúrguer? ${uid('q')}`;
  const card = a.page.getByTestId('chat-poll');
  const options = card.getByTestId('chat-poll-option');

  // Act
  await live.getByTestId('chat-poll-new').click();
  const form = live.getByTestId('chat-poll-form');
  await form.getByTestId('chat-poll-question').fill(question);
  const inputs = form.getByTestId('chat-poll-option-input');
  await inputs.nth(0).fill('Pizza');
  await inputs.nth(1).fill('Hambúrguer');
  await form.getByTestId('chat-poll-add').click();
  await inputs.nth(2).fill('Os dois');
  await expect(form.getByTestId('chat-poll-newonly')).not.toBeChecked();
  // The column is as tall as the window: the form's Start and the box stay in view.
  await expect(form.getByTestId('chat-poll-start')).toBeInViewport();
  await expect(live.getByTestId('chat-send')).toBeInViewport();
  await form.getByTestId('chat-poll-start').click();

  // Assert
  await expect(form).toBeHidden();
  await expect(card.locator('.poll-q')).toHaveText(question);
  await expect(options).toHaveText([/^Pizza\s*0%$/, /^Hambúrguer\s*0%$/, /^Os dois\s*0%$/]);
  await expect(card.getByTestId('chat-poll-time')).toHaveText(/^[12]:\d\d left$/);

  // Act
  await options.nth(0).click();
  const id = (await pollState())!.id;
  const fromC = await c.voteAnswer(c.vote(id, 2));

  // Assert
  await expect(card.getByTestId('chat-poll-status')).toContainText('You voted: Pizza');
  expect(fromC).toEqual({ o: 2 });
  await expect(options).toHaveText([/^Pizza \(Your vote\)\s*50%$/, /^Hambúrguer\s*0%$/, /^Os dois\s*50%$/]);
  const panelCard = live.getByTestId('chat-poll');
  await expect(panelCard.getByTestId('chat-poll-count')).toHaveText(['1 · 50%', '0 · 0%', '1 · 50%']);
  await expect(panelCard.getByTestId('chat-poll-voters')).toContainText('2 votes from');

  // Act
  const late = await viewers.join(uid('pollL'));
  await a.page.reload();
  await chatReady(a.page, late.page);

  // Assert
  await expect(late.page.getByTestId('chat-poll').getByTestId('chat-poll-time')).toHaveText(/^[012]:\d\d left$/);
  await expect(late.page.getByTestId('chat-poll').getByTestId('chat-poll-status')).toHaveText('Tap an option. Your vote is final and anonymous. · 2 votes');
  await expect(card.getByTestId('chat-poll-status')).toHaveText('You voted: Pizza · 2 votes');
  await expect(options.nth(0)).toHaveAttribute('aria-pressed', 'true');

  // Act
  await panelCard.getByTestId('chat-poll-end').click();

  // Assert
  await expect(card.getByTestId('chat-poll-status')).toHaveText('Poll ended · 2 votes · You voted: Pizza');
  await expect(panelCard.getByTestId('chat-poll-state')).toHaveText('Voting ended');

  // Act
  await panelCard.getByTestId('chat-poll-remove').click();

  // Assert
  await expect(card).toBeHidden();
  await expect(late.page.getByTestId('chat-poll')).toBeHidden();
  await expect(panelCard).toHaveCount(0);
  expect(await pollState()).toBeUndefined();
});

test('chat prediction: guesses from people already watching, the right answer picked in the panel, who got it right', { tag: '@ui' }, async ({ page, viewers, bots }) => {
  // Arrange
  const live = await openChat(page);
  const a = await viewers.join(uid('predA'));
  const b = await bots.join(uid('predB'));
  await chatReady(a.page);
  const card = a.page.getByTestId('chat-poll');

  // Act
  await live.getByTestId('chat-poll-new').click();
  const form = live.getByTestId('chat-poll-form');
  await form.getByTestId('chat-poll-kind-prediction').check();
  await form.getByTestId('chat-poll-question').fill(`Quem ganha? ${uid('q')}`);
  await form.getByTestId('chat-poll-option-input').nth(0).fill('Azul');
  await form.getByTestId('chat-poll-option-input').nth(1).fill('Verde');
  const newOnly = await form.getByTestId('chat-poll-newonly').isChecked();
  await form.getByTestId('chat-poll-start').click();
  await expect(card.locator('.poll-label')).toHaveText('Prediction');
  await card.getByTestId('chat-poll-option').nth(1).click();
  const id = (await pollState())!.id;
  await b.voteAnswer(b.vote(id, 0));
  const late = await bots.join(uid('predL'));
  const lateAnswer = await late.voteAnswer(late.vote(id, 0));
  const panelCard = live.getByTestId('chat-poll');
  await panelCard.getByTestId('chat-poll-end').click();
  await expect(card.getByTestId('chat-poll-status')).toHaveText('Guesses are closed. Waiting for the answer… · 2 guesses · Your guess: Verde');
  await expect(panelCard.getByTestId('chat-poll-state')).toHaveText('Guesses ended: pick the right answer');
  await panelCard.getByTestId('chat-poll-answer').nth(1).click();

  // Assert
  expect(newOnly).toBe(true);
  expect(lateAnswer).toEqual({ code: 'chat.err.pollLate' });
  await expect(card.getByTestId('chat-poll-status')).toHaveText('The answer: Verde · 1 person got it right · You got it!');
  await expect(card.getByTestId('chat-poll-option').nth(1)).toHaveClass(/win/);
  await expect(panelCard.getByTestId('chat-poll-state')).toHaveText('Answered');
  await expect(panelCard.getByTestId('chat-poll-voters')).toContainText('1 person got it right');
  expect(b.messages.some((m) => m.t === 'chat.batch' && m.items.some((i) => i.k === 'poll' && i.p?.st === 'resolved' && i.p.win === 1))).toBe(true);
});

test('chat slash commands in the panel, in Portuguese and English: suggestions, poll shortcuts, the ? list, /limpar asks first', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  const live = await openChat(page, 'pt-BR');
  const input = live.getByTestId('chat-input');
  const result = live.getByTestId('chat-cmd-result');

  // Act
  await input.fill('/enq');

  // Assert
  await expect(live.getByTestId('chat-cmd-option')).toHaveCount(1);
  await expect(live.getByTestId('chat-cmd-option')).toHaveAttribute('data-cmd', 'poll');

  // Act
  await input.press('Tab');

  // Assert
  await expect(input).toHaveValue('/enquete ');

  // Act
  await input.fill('/Enquête 30s Pizza? | Sim | Não');
  await input.press('Enter');

  // Assert
  await expect(result).toHaveText('Enquete aberta.');
  await expect(input).toHaveValue('');
  const panelCard = live.getByTestId('chat-poll');
  await expect(panelCard.getByTestId('chat-poll-state')).toHaveText('Votação aberta');
  expect(await pollState()).toMatchObject({ kind: 'poll', q: 'Pizza?', o: ['Sim', 'Não'], st: 'open' });

  // Act
  await input.fill('/encerrar');
  await input.press('Enter');
  await expect(result).toHaveText('Votação encerrada.');
  await input.fill('/cancelar');
  await input.press('Enter');

  // Assert
  await expect(result).toHaveText('Removido.');
  await expect(panelCard).toHaveCount(0);

  // Act
  await input.fill('/palpite');
  await input.press('Enter');

  // Assert
  const form = live.getByTestId('chat-poll-form');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('chat-poll-kind-prediction')).toBeChecked();
  await expect(form.getByTestId('chat-poll-newonly')).toBeChecked();

  // Act
  await form.getByRole('button', { name: 'Cancelar', exact: true }).first().click();
  await live.getByTestId('chat-cmd-help-button').click();

  // Assert
  const help = live.getByTestId('chat-cmd-help');
  await expect(help).toBeVisible();
  await expect(help.getByTestId('chat-cmd-pick')).toHaveCount(13);
  await expect(help.getByTestId('chat-cmd-pick').filter({ hasText: '/enquete [tempo] Pergunta' })).toContainText('/poll');

  // Act
  await help.locator('[data-cmd="pin"]').click();

  // Assert
  await expect(input).toHaveValue('/fixar ');
  await expect(help).toBeHidden();

  // Act
  await input.fill('/limpar');
  await input.press('Enter');

  // Assert
  await expect(live.getByTestId('chat-clear-yes')).toBeVisible();
  await live.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(live.getByTestId('chat-clear-yes')).toHaveCount(0);

  // Act
  await input.fill('/resposta 9');
  await input.press('Enter');

  // Assert
  await expect(result).toHaveText('Escreva o número da opção certa, de 1 a 5.');
  await expect(input).toHaveValue('/resposta 9');

  // Act: English names in an English panel, and a server refusal shown in the box.
  await openChat(page, 'en');
  await input.fill('/poll 1m Fruit? | Apple | Pear');
  await input.press('Enter');
  await expect(result).toHaveText('Poll started.');
  await input.fill('/answer 1');
  await input.press('Enter');

  // Assert
  await expect(live.getByTestId('chat-send-error')).toHaveText('Not possible right now: end the guesses first, then pick the right answer.');
  await expect(input).toHaveValue('/answer 1');

  // Act
  await input.fill('/cancel');
  await input.press('Enter');

  // Assert
  await expect(result).toHaveText('Removed.');
});

test('chat poll rules from moderation: muted viewers cannot vote, the chat off refuses votes, Clear chat leaves the poll', { tag: '@ui' }, async ({ bots, chat }) => {
  // Arrange
  const ana = await bots.join(uid('pmAna'));
  const bia = await bots.join(uid('pmBia'));
  const cris = await bots.join(uid('pmCris'));
  const { id } = await admin<{ id: string }>('/api/chat/poll', { kind: 'poll', question: 'Regras?', options: ['Sim', 'Não'], seconds: 120 });
  await admin('/api/chat/mute', { sessionId: await sessionOf(chat, ana.nickname), minutes: 10 });

  // Act
  const muted = await ana.voteAnswer(ana.vote(id, 0));
  const ok = await bia.voteAnswer(bia.vote(id, 1));
  const again = await bia.voteAnswer(bia.vote(id, 0));
  await chat.clear();
  const afterClear = await pollState();
  await chat.change({ enabled: false });
  const off = await cris.voteAnswer(cris.vote(id, 0));

  // Assert
  expect(muted).toEqual({ code: 'chat.err.muted' });
  expect(ok).toEqual({ o: 1 });
  expect(again).toEqual({ code: 'chat.err.voted' });
  expect(afterClear).toMatchObject({ id, st: 'open', c: [0, 1] });
  expect(off).toEqual({ code: 'chat.err.off' });
});

test('chat poll in a narrow panel window: the card, then the form in its place, and the box stay on screen', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await page.setViewportSize(NARROW_WINDOW);
  const live = await openChat(page);
  const inWindow = async (el: Locator): Promise<void> => {
    const b = (await el.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(NARROW_WINDOW.width);
  };

  // Act
  await admin('/api/chat/poll', { kind: 'prediction', question: 'Uma pergunta longa para a janela estreita do painel?', options: ['Primeira opção', 'Segunda opção', 'Terceira opção', 'Quarta opção', 'Quinta opção'], seconds: 300 });

  // Assert
  const card = live.getByTestId('chat-poll');
  await expect(card).toBeVisible();
  await inWindow(card);
  await expect(card.getByTestId('chat-poll-end')).toBeInViewport();
  await expect(live.getByTestId('chat-send')).toBeInViewport();

  // Act
  await live.getByTestId('chat-poll-new').click();

  // Assert
  const form = live.getByTestId('chat-poll-form');
  await expect(form).toBeVisible();
  await expect(card).toHaveCount(0);
  await inWindow(form);
  await inWindow(live.getByTestId('chat-input'));
  await expect(form.getByTestId('chat-poll-start')).toBeInViewport();
  await expect(live.getByTestId('chat-send')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
