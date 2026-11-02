// @vitest-environment happy-dom
// The poll card (chat/poll.ts, docs/CHAT.md "Polls and predictions"): options as buttons with live
// percentages, a final vote, the ended / waiting / answered states, refusals, mutes, the countdown and
// the polite announcements, on an injected clock and injected timers.
import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '@swarmcast/shared/i18n';
import type { ChatYou } from '@swarmcast/shared/chat';
import { ANNOUNCE_MIN_MS, clockText, percents, PollCard, pollBadge, VOTE_WAIT_MS } from '../../src/chat/poll.js';
import type { PollEntry } from '../../src/chat/session.js';

const NOW = 1_700_000_000_000;
const POLL: PollEntry = { id: 'p1', kind: 'poll', q: 'Pizza ou hambúrguer?', o: ['Pizza', 'Hambúrguer'], st: 'open', c: [0, 0], endsIn: 90_000, newOnly: false };

/** A card in the page with a manual clock and manual timers (`run` fires the ones due). */
function makeCard(o: { you?: ChatYou | null; offline?: boolean } = {}) {
  document.body.replaceChildren();
  let now = NOW;
  let n = 0;
  const votes: Array<{ id: string; o: number; n: number }> = [];
  const timers: Array<{ at: number; cb: () => void; every?: number; live: boolean }> = [];
  const card = new PollCard({
    vote: (id, opt) => {
      if (o.offline) return null;
      votes.push({ id, o: opt, n: ++n });
      return n;
    },
    you: () => (o.you === undefined ? { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null } : o.you),
    now: () => now,
    later: (cb, ms) => {
      const t = { at: now + ms, cb, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    every: (cb, ms) => {
      const t = { at: now + ms, cb, every: ms, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
  });
  document.body.append(card.root);
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else next.live = false;
      next.cb();
    }
    now = end;
  };
  const q = <T extends Element = HTMLElement>(sel: string) => card.root.querySelector<T>(sel)!;
  const buttons = () => [...card.root.querySelectorAll<HTMLButtonElement>('[data-testid="chat-poll-option"]')];
  const status = () => q('[data-testid="chat-poll-status"]').textContent;
  const live = () => q('[data-testid="chat-poll-live"]').textContent;
  return { card, votes, advance, q, buttons, status, live };
}

beforeEach(() => setLang('en'));

describe('poll card', () => {
  it('shows the question and the options as buttons, the time left, and how to vote; hidden with no poll', () => {
    // Arrange
    const { card, buttons, status, q } = makeCard();
    const hiddenBefore = card.root.hidden;
    // Act
    card.set(POLL);
    // Assert
    expect(hiddenBefore).toBe(true);
    expect(card.root.hidden).toBe(false);
    expect(q('.poll-label').textContent).toBe('Poll');
    expect(q('.poll-q').textContent).toBe('Pizza ou hambúrguer?');
    expect(buttons().map((b) => b.querySelector('.poll-text')!.textContent)).toEqual(['Pizza', 'Hambúrguer']);
    expect(buttons().map((b) => b.getAttribute('aria-disabled'))).toEqual(['false', 'false']);
    expect(q('[data-testid="chat-poll-time"]').textContent).toBe('1:30 left');
    expect(status()).toBe('Tap an option. Your vote is final and anonymous. · 0 votes');
    expect(card.root.getAttribute('aria-labelledby')).toBe(q('.poll-q').id);
  });

  it('a click votes once: "sending", then the vote is marked, the buttons stay focusable but do nothing more', () => {
    // Arrange
    const { card, votes, buttons, status } = makeCard();
    card.set(POLL);
    // Act
    buttons()[1]!.click();
    buttons()[0]!.click();
    const sending = status();
    card.set({ ...POLL, c: [0, 1], mine: 1 });
    card.voted(1, 'p1', 1);
    buttons()[0]!.click();
    // Assert
    expect(votes).toEqual([{ id: 'p1', o: 1, n: 1 }]);
    expect(sending).toContain('Sending your vote…');
    expect(status()).toBe('You voted: Hambúrguer · 1 vote');
    expect(buttons()[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons()[1]!.classList.contains('mine')).toBe(true);
    expect(buttons().map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect(buttons().every((b) => !b.disabled)).toBe(true);
    expect(buttons()[1]!.textContent).toContain('(Your vote)');
  });

  it('live results: counts move the bars (through --p) and the percentages, in place (the focused button stays the same element)', () => {
    // Arrange
    const { card, buttons } = makeCard();
    card.set(POLL);
    const first = buttons()[0]!;
    first.focus();
    // Act
    card.tally('p1', [3, 1]);
    card.tally('p9', [0, 9]);
    // Assert
    expect(buttons()[0]).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(buttons().map((b) => b.querySelector('.poll-pct')!.textContent)).toEqual(['75%', '25%']);
    expect(buttons().map((b) => (b.querySelector('.poll-bar') as HTMLElement).style.getPropertyValue('--p'))).toEqual(['0.75', '0.25']);
  });

  it('refused because this device already voted (another tab): the card shows that vote, and keeps it when the poll changes', () => {
    // Arrange
    const { card, buttons, status } = makeCard();
    card.set(POLL);
    buttons()[0]!.click();
    // Act
    const mine = card.rejected(1, 'chat.err.voted', { o: 1 });
    const notMine = card.rejected(99, 'chat.err.slow', undefined);
    card.set({ ...POLL, st: 'closed', c: [4, 2] });
    // Assert
    expect([mine, notMine]).toEqual([true, false]);
    expect(status()).toBe('Poll ended · 6 votes · You voted: Hambúrguer');
  });

  it('another refusal is shown in the card and announced; the buttons work again', () => {
    // Arrange
    const { card, buttons, status, live, votes, advance } = makeCard();
    card.set(POLL);
    buttons()[0]!.click();
    // Act
    card.rejected(1, 'chat.err.pollLate', undefined);
    const shown = status();
    advance(ANNOUNCE_MIN_MS);
    const said = live();
    buttons()[1]!.click();
    // Assert
    expect(shown).toBe('Only people who were already watching when it started can vote. · 0 votes');
    expect(said).toBe('Only people who were already watching when it started can vote.');
    expect(votes.map((v) => v.o)).toEqual([0, 1]);
  });

  it('a vote the server never answers frees the buttons after VOTE_WAIT_MS', () => {
    // Arrange
    const { card, buttons, advance } = makeCard();
    card.set(POLL);
    buttons()[0]!.click();
    // Act
    advance(VOTE_WAIT_MS - 1);
    const waiting = buttons()[0]!.getAttribute('aria-disabled');
    advance(1);
    // Assert
    expect(waiting).toBe('true');
    expect(buttons()[0]!.getAttribute('aria-disabled')).toBe('false');
  });

  it('offline: nothing is sent and the card says so', () => {
    // Arrange
    const { card, buttons, status } = makeCard({ offline: true });
    card.set(POLL);
    // Act
    buttons()[0]!.click();
    // Assert
    expect(status()).toBe('Not connected. Wait a moment and try again. · 0 votes');
    expect(buttons()[0]!.getAttribute('aria-disabled')).toBe('false');
  });

  it('muted viewers see the options without being able to vote', () => {
    // Arrange
    const { card, buttons, status, votes } = makeCard({ you: { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: 'live' } });
    card.set(POLL);
    // Act
    buttons()[0]!.click();
    // Assert
    expect(votes).toEqual([]);
    expect(status()).toBe('Muted people cannot vote. · 0 votes');
    expect(buttons()[0]!.getAttribute('aria-disabled')).toBe('true');
  });

  it('a prediction: guesses, then "waiting for the answer", then the answer with how many got it right and whether this viewer did', () => {
    // Arrange
    const { card, status, buttons, q } = makeCard();
    const pred: PollEntry = { ...POLL, kind: 'prediction', q: 'Quem ganha?', o: ['Ana', 'Bia', 'Caio'], c: [0, 0, 0], newOnly: true };
    // Act
    card.set(pred);
    const open = status();
    card.set({ ...pred, st: 'locked', c: [2, 1, 0], mine: 0 });
    const locked = status();
    card.set({ ...pred, st: 'resolved', c: [2, 1, 0], mine: 0, win: 1 });
    // Assert
    expect(q('.poll-label').textContent).toBe('Prediction');
    expect(open).toBe('Make your guess. It is final and anonymous. · 0 guesses');
    expect(locked).toBe('Guesses are closed. Waiting for the answer… · 3 guesses · Your guess: Ana');
    expect(status()).toBe('The answer: Bia · 1 person got it right · Not this time.');
    expect(buttons()[1]!.classList.contains('win')).toBe(true);
    expect(buttons()[1]!.textContent).toContain('(Right answer)');
    expect(q('[data-testid="chat-poll-time"]').hidden).toBe(true);
  });

  it('the countdown follows the clock while open', () => {
    // Arrange
    const { card, advance, q } = makeCard();
    card.set({ ...POLL, endsIn: 61_500 });
    // Act
    advance(2000);
    // Assert
    expect(q('[data-testid="chat-poll-time"]').textContent).toBe('1:00 left');
  });

  it('announcements: opened, ended, the answer; at most one per ANNOUNCE_MIN_MS (a burst says only the last)', () => {
    // Arrange
    const { card, live, advance } = makeCard();
    // Act
    card.set(POLL);
    const opened = live();
    card.set({ ...POLL, st: 'closed' });
    const tooSoon = live();
    advance(ANNOUNCE_MIN_MS);
    // Assert
    expect(opened).toBe('The streamer started a poll: Pizza ou hambúrguer?');
    expect(tooSoon).toBe(opened);
    expect(live()).toBe('The poll ended.');
  });

  it('question and options are text, never markup; one that fails the shared invariants hides the poll (no buttons)', () => {
    // Arrange
    const { card, buttons, q } = makeCard();
    // Act
    card.set({ ...POLL, q: '<img src=x onerror=alert(1)>', o: ['<b>a</b>', 'b'] });
    const markup = { q: q('.poll-q').textContent, img: card.root.querySelector('img'), b: card.root.querySelector('b') };
    card.set({ ...POLL, id: 'p2', q: 'a‮b' });
    // Assert
    expect(markup).toEqual({ q: '<img src=x onerror=alert(1)>', img: null, b: null });
    expect(q('.poll-q').textContent).toBe('This poll cannot be shown on this page.');
    expect(buttons()).toEqual([]);
  });

  it('▾ folds the card to its header and ▸ opens it again', () => {
    // Arrange
    const { card, q } = makeCard();
    card.set(POLL);
    const toggle = q<HTMLButtonElement>('[data-testid="chat-poll-toggle"]');
    // Act
    toggle.click();
    const folded = { body: q('.poll-body').hidden, expanded: toggle.getAttribute('aria-expanded') };
    toggle.click();
    // Assert
    expect(folded).toEqual({ body: true, expanded: 'false' });
    expect(q('.poll-body').hidden).toBe(false);
  });

  it('hidden with the chat off, and when the poll is gone; "Show chat" names an open poll only', () => {
    // Arrange
    const { card } = makeCard();
    card.set(POLL);
    // Act
    card.setAllowed(false);
    const off = card.root.hidden;
    card.setAllowed(true);
    card.set(null);
    // Assert
    expect(off).toBe(true);
    expect(card.root.hidden).toBe(true);
    expect(pollBadge(POLL)).toBe('Poll');
    expect(pollBadge({ ...POLL, kind: 'prediction' })).toBe('Prediction');
    expect(pollBadge({ ...POLL, st: 'closed' })).toBeNull();
  });

  it('Portuguese texts', () => {
    // Arrange
    setLang('pt-BR');
    const { card, status, q } = makeCard();
    // Act
    card.set({ ...POLL, c: [1, 1], mine: 0 });
    // Assert
    expect(q('.poll-label').textContent).toBe('Enquete');
    expect(status()).toBe('Seu voto: Pizza · 2 votos');
    expect(q('[data-testid="chat-poll-time"]').textContent).toBe('Faltam 1:30');
  });

  it('helpers: clock text and whole percentages', () => {
    // Assert
    expect([clockText(0), clockText(1), clockText(59_001), clockText(600_000)]).toEqual(['0:00', '0:01', '1:00', '10:00']);
    expect(percents([0, 0])).toEqual([0, 0]);
    expect(percents([1, 2])).toEqual([33, 67]);
  });
});
