// @vitest-environment happy-dom
// Reactions over the video (chat/reactions.ts, docs/CHAT.md "Reactions"): the page's frames (the first
// tap at once, the rest together, the tap bucket, its own taps taken off the server's counts), the
// floaters (sampled, capped, nothing while the tab is hidden), the calm counter for "reduce motion",
// the React picker (named buttons, arrows) and the session's `rx` guard, on injected clocks and timers.
import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '@swarmcast/shared/i18n';
import { CHAT_FLOATERS_MAX, CHAT_FLOATERS_SPAWN_PER_WINDOW, CHAT_REACT_BURST, CHAT_REACT_FRAME_MS, CHAT_REACT_PER_FRAME_MAX, CHAT_REACTIONS, type ChatSnapshot } from '@swarmcast/shared/chat';
import { CALM_COUNTER_MS, createReactPicker, OWN_ECHO_MS, ReactionLayer, ReactionSender, reactionName, sampleFloaters } from '../../src/chat/reactions.js';
import { ChatSession, type ChatView } from '../../src/chat/session.js';

/** Manual timers on a manual clock: `advance` fires the ones due, in order. */
function clock(start = 1_700_000_000_000) {
  let now = start;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (t: unknown) => void timers.delete(t as number),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

const one = (i: number) => CHAT_REACTIONS.map((_, k) => (k === i ? 1 : 0));

beforeEach(() => setLang('en'));

describe('ReactionSender', () => {
  function sender(ok = true) {
    const c = clock();
    const frames: number[][] = [];
    const s = new ReactionSender({ send: (x) => (frames.push(x), ok), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    return { s, c, frames };
  }

  it(`the first tap goes at once; the taps after it go together, at most one frame per ${CHAT_REACT_FRAME_MS} ms`, () => {
    // Arrange
    const { s, c, frames } = sender();
    // Act
    s.tap(0);
    s.tap(2);
    s.tap(2);
    c.advance(CHAT_REACT_FRAME_MS - 1);
    const before = frames.length;
    c.advance(1);
    // Assert
    expect(before).toBe(1);
    expect(frames).toEqual([[1], [0, 0, 2]]);
  });

  it(`one frame carries at most ${CHAT_REACT_PER_FRAME_MAX} taps, and the tap bucket (${CHAT_REACT_BURST}, refilled at 2/s) is the server's`, () => {
    // Arrange
    const { s, c, frames } = sender();
    // Act
    const first = Array.from({ length: CHAT_REACT_BURST + 3 }, () => s.tap(1));
    c.advance(CHAT_REACT_FRAME_MS);
    const later = Array.from({ length: 6 }, () => s.tap(1));
    c.advance(CHAT_REACT_FRAME_MS);
    // Assert: 10 at first (1 at once + 9 together), then 2 s later 4 taps refilled.
    expect(first.filter(Boolean)).toHaveLength(CHAT_REACT_BURST);
    expect(later.filter(Boolean)).toHaveLength(4);
    expect(frames.map((f) => f.reduce((a, b) => a + b, 0))).toEqual([1, CHAT_REACT_BURST - 1, 4]);
    expect(frames.every((f) => f.reduce((a, b) => a + b, 0) <= CHAT_REACT_PER_FRAME_MAX)).toBe(true);
  });

  it('a quick tapper never sends more than 5 frames in 10 s (half the socket budget)', () => {
    // Arrange
    const { s, c, frames } = sender();
    // Act: a tap every 100 ms for 10 s.
    for (let i = 0; i < 100; i++) {
      s.tap(i % CHAT_REACTIONS.length);
      c.advance(100);
    }
    // Assert
    expect(frames.length).toBeLessThanOrEqual(6);
    expect(frames.length).toBeGreaterThanOrEqual(5);
  });

  it(`its own taps are taken off the next counts from the server (once, for ${OWN_ECHO_MS} ms)`, () => {
    // Arrange
    const { s, c } = sender();
    s.tap(0);
    s.tap(3);
    // Act
    const first = s.others([4, 0, 0, 0]);
    c.advance(CHAT_REACT_FRAME_MS);
    const second = s.others([1, 0, 0, 2]);
    const third = s.others([1, 0, 0, 1]);
    s.tap(5);
    // That tap goes with the next frame (CHAT_REACT_FRAME_MS after the last one), then ages out.
    c.advance(CHAT_REACT_FRAME_MS + OWN_ECHO_MS + 1);
    const late = s.others([0, 0, 0, 0, 0, 1]);
    // Assert
    expect(first).toEqual([3, 0, 0, 0, 0, 0, 0, 0]);
    expect(second).toEqual([1, 0, 0, 1, 0, 0, 0, 0]);
    expect(third).toEqual([1, 0, 0, 1, 0, 0, 0, 0]);
    expect(late).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it('a frame that could not go is forgotten (not counted as its own, the next tap tries at once)', () => {
    // Arrange
    const { s, frames } = sender(false);
    // Act
    s.tap(0);
    const echo = s.others([1]);
    s.tap(1);
    // Assert
    expect(echo[0]).toBe(1);
    expect(frames).toEqual([[1], [0, 1]]);
  });

  it('reset drops the taps waiting for the next frame', () => {
    // Arrange
    const { s, c, frames } = sender();
    s.tap(0);
    s.tap(1);
    // Act
    s.reset();
    c.advance(CHAT_REACT_FRAME_MS * 2);
    // Assert
    expect(frames).toEqual([[1]]);
    expect(c.pending).toBe(0);
  });

  it('a tap of no reaction does nothing', () => {
    // Arrange
    const { s, frames } = sender();
    // Act
    const r = [s.tap(-1), s.tap(CHAT_REACTIONS.length), s.tap(Number.NaN)];
    // Assert
    expect(r).toEqual([false, false, false]);
    expect(frames).toEqual([]);
  });
});

describe('sampleFloaters', () => {
  const seq = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length]!;
  };
  it('a few taps: one floater each', () => {
    // Act
    const out = sampleFloaters([2, 0, 1], 8, seq(0.5));
    // Assert
    expect([...out].sort()).toEqual([0, 0, 2]);
  });

  it(`many taps: at most ${CHAT_FLOATERS_SPAWN_PER_WINDOW}, every kind that came at least once, the rest by the counts`, () => {
    // Act
    const out = sampleFloaters([20, 0, 2, 0, 0, 20, 0, 1], CHAT_FLOATERS_SPAWN_PER_WINDOW, seq(0.1, 0.9, 0.4));
    // Assert
    expect(out).toHaveLength(CHAT_FLOATERS_SPAWN_PER_WINDOW);
    expect(new Set(out)).toEqual(new Set([0, 2, 5, 7]));
    expect(out.filter((i) => i === 0).length).toBeGreaterThanOrEqual(2);
    expect(out.filter((i) => i === 5).length).toBeGreaterThanOrEqual(2);
  });

  it('more kinds than room: the most frequent ones', () => {
    // Act
    const out = sampleFloaters([1, 2, 3, 4, 5, 6, 7, 8], 3, seq(0.3));
    // Assert
    expect([...out].sort()).toEqual([5, 6, 7]);
  });

  it('nothing, or garbage, gives nothing', () => {
    // Act / Assert
    expect(sampleFloaters([], 8)).toEqual([]);
    expect(sampleFloaters([-3, Number.NaN, 0], 8)).toEqual([]);
  });
});

describe('ReactionLayer', () => {
  function layer(o: { reduced?: boolean; visible?: boolean } = {}) {
    document.body.replaceChildren();
    const player = document.createElement('div');
    player.className = 'player';
    const video = document.createElement('video');
    const controls = document.createElement('div');
    controls.className = 'pc';
    player.append(video, controls);
    document.body.append(player);
    const c = clock();
    const state = { reduced: o.reduced ?? false, visible: o.visible ?? true };
    const l = new ReactionLayer(player, { reduced: () => state.reduced, pageVisible: () => state.visible, rand: () => 0.5, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    l.setEnabled(true);
    return { l, c, player, state, floats: () => player.querySelectorAll('.rx-float') };
  }

  it('sits over the video and under the controls, never takes a click, and is hidden from screen readers', () => {
    // Arrange
    const { l, player } = layer();
    // Assert
    expect([...player.children].map((e) => e.className)).toEqual(['', 'rx-layer', 'pc']);
    expect(l.root.getAttribute('aria-hidden')).toBe('true');
    expect(l.root.hidden).toBe(false);
  });

  it(`floats at most ${CHAT_FLOATERS_SPAWN_PER_WINDOW} per window and ${CHAT_FLOATERS_MAX} at once; each one goes when it is done`, () => {
    // Arrange
    const { l, c, floats } = layer();
    // Act
    l.show([20, 20, 20, 20, 20, 20, 20, 20]);
    const firstWindow = floats().length;
    for (let i = 0; i < 5; i++) l.show([20, 20, 20, 20, 20, 20, 20, 20]);
    const capped = floats().length;
    c.advance(5000);
    // Assert
    expect(firstWindow).toBe(CHAT_FLOATERS_SPAWN_PER_WINDOW);
    expect(capped).toBe(CHAT_FLOATERS_MAX);
    expect(l.alive).toBe(0);
    expect(floats()).toHaveLength(0);
  });

  it('each floater is an image of our own emote with its place and timing as CSS custom properties (no style attribute text)', () => {
    // Arrange
    const { l, floats } = layer();
    // Act
    l.show(one(5));
    // Assert
    const img = floats()[0] as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.alt).toBe('');
    expect(img.getAttribute('src')).toMatch(/fire/);
    expect(img.style.getPropertyValue('--rx-dur')).toMatch(/^\d+ms$/);
    expect(img.style.getPropertyValue('--rx-rise')).toMatch(/^\d+px$/);
  });

  it('draws nothing while the tab is hidden (no backlog when it comes back), and nothing while turned off', () => {
    // Arrange
    const { l, state, floats } = layer({ visible: false });
    // Act
    l.show([5, 5]);
    state.visible = true;
    const back = floats().length;
    l.setEnabled(false);
    l.show([5, 5]);
    // Assert
    expect(back).toBe(0);
    expect(floats()).toHaveLength(0);
    expect(l.root.hidden).toBe(true);
  });

  it(`"reduce motion": nothing floats; a counter per kind counts up in place, in a fixed order, and goes after ${CALM_COUNTER_MS} ms without reactions`, () => {
    // Arrange
    const { l, c, floats, player } = layer({ reduced: true });
    const chips = () => [...player.querySelectorAll<HTMLElement>('.rx-chip')].map((e) => `${e.dataset.reaction} ${e.textContent}`);
    // Act
    l.show([0, 0, 0, 0, 0, 2]);
    l.show([1, 0, 0, 0, 0, 1]);
    const counting = chips();
    c.advance(CALM_COUNTER_MS - 1);
    const stillThere = chips().length;
    c.advance(1);
    // Assert
    expect(floats()).toHaveLength(0);
    expect(counting).toEqual(['love 1', 'fire 3']);
    expect(stillThere).toBe(2);
    expect(chips()).toEqual([]);
    expect(player.querySelector<HTMLElement>('.rx-tally')!.hidden).toBe(true);
  });

  it('turning it off clears what is on screen', () => {
    // Arrange
    const { l, floats } = layer();
    l.show([3]);
    // Act
    l.setEnabled(false);
    // Assert
    expect(floats()).toHaveLength(0);
    expect(l.alive).toBe(0);
  });
});

describe('createReactPicker', () => {
  function picker() {
    document.body.replaceChildren();
    const button = document.createElement('button');
    const taps: number[] = [];
    const p = createReactPicker(button, { onTap: (i) => taps.push(i) });
    document.body.append(button, p.panel);
    return { button, taps, p, options: () => [...p.panel.querySelectorAll<HTMLButtonElement>('.react-opt')] };
  }

  it('a named React button opens eight named reactions; a tap sends one and the popover stays open for more', () => {
    // Arrange
    const { button, taps, p, options } = picker();
    // Act
    button.click();
    options()[1]!.click();
    options()[1]!.click();
    options()[5]!.click();
    // Assert
    expect(button.getAttribute('aria-label')).toBe('React');
    expect(options().map((b) => b.getAttribute('aria-label'))).toEqual(['Love', 'Hype', 'Funny', 'Wow', 'GG', 'Fire', 'Sad', 'Hi']);
    expect(taps).toEqual([1, 1, 5]);
    expect(p.popover.isOpen).toBe(true);
    expect(document.activeElement).toBe(options()[0]);
  });

  it('arrow keys, Home and End move between the reactions; Escape closes and gives the focus back', () => {
    // Arrange
    const { button, p, options } = picker();
    button.click();
    const key = (k: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    // Act
    key('ArrowRight');
    const right = options().indexOf(document.activeElement as HTMLButtonElement);
    key('ArrowDown');
    const down = options().indexOf(document.activeElement as HTMLButtonElement);
    key('End');
    const end = options().indexOf(document.activeElement as HTMLButtonElement);
    key('Home');
    const home = options().indexOf(document.activeElement as HTMLButtonElement);
    key('ArrowLeft');
    const clamped = options().indexOf(document.activeElement as HTMLButtonElement);
    key('Escape');
    // Assert
    expect([right, down, end, home, clamped]).toEqual([1, 5, 7, 0, 0]);
    expect(p.popover.isOpen).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('every reaction has a translated name in Portuguese too', () => {
    // Act
    setLang('pt-BR');
    // Assert
    expect(CHAT_REACTIONS.map((_, i) => reactionName(i))).toEqual(['Amei', 'Hype', 'Engraçado', 'Uau', 'GG', 'Fogo', 'Triste', 'Oi']);
  });
});

describe('ChatSession: rx items', () => {
  function session() {
    const drawn: number[][] = [];
    const sent: Array<{ t: string }> = [];
    const view: ChatView = {
      reset: () => {},
      append: () => {},
      remove: () => {},
      clearUpTo: () => {},
      highlight: () => {},
      pin: () => {},
      reactions: (c) => drawn.push(c),
      author: () => {},
      settings: () => {},
      you: () => {},
      ack: () => {},
      reject: () => {},
      unsupported: () => {},
      connection: () => {},
    };
    const s = new ChatSession(view, (m) => (sent.push(m), true));
    s.connection(true);
    const snap: ChatSnapshot = {
      v: 1,
      settings: { enabled: true, content: ['text'], slowS: 0, autoSlow: false, maxGraphemes: 200, maxEmoji: 30, newViewerWaitS: 0, colors: 'choose', linksBlocked: false, emotes: [], builtinEmotes: true, protect: 'off', streamerName: '', reactions: true },
      you: { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null },
      roster: [{ a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' }],
      items: [{ k: 'm', s: 1, at: 1, a: 'k1', x: 'oi' }],
      lastSeq: 1,
    };
    s.hello(snap);
    return { s, drawn, sent };
  }

  it('hands each rx to the view (unknown kinds of a newer server left out, counts capped), never as a seq and never with a resume', () => {
    // Arrange
    const { s, drawn, sent } = session();
    // Act
    s.frame({ t: 'chat.batch', items: [{ k: 'rx', c: [1, 0, 2] }, { k: 'm', s: 2, at: 2, a: 'k1', x: 'boa' }, { k: 'rx', c: [0, 0, 0, 0, 0, 0, 0, 0, 9, 9] }, { k: 'rx', c: [999] }] });
    // Assert
    expect(drawn).toEqual([
      [1, 0, 2, 0, 0, 0, 0, 0],
      [20, 0, 0, 0, 0, 0, 0, 0],
    ]);
    expect(s.lastSeq).toBe(2);
    expect(sent).toEqual([]);
  });

  it.each([
    ['no counts', { k: 'rx' }],
    ['counts that are not a list', { k: 'rx', c: { 0: 1 } }],
    ['a negative count', { k: 'rx', c: [1, -1] }],
    ['a fraction', { k: 'rx', c: [0.5] }],
    ['text', { k: 'rx', c: ['<b>'] }],
    ['a seq on it', { k: 'rx', s: 9, c: [0] }],
  ])('a malformed rx (%s) is dropped on its own; the messages around it still show', (_name, bad) => {
    // Arrange
    const { s, drawn, sent } = session();
    // Act
    s.frame({ t: 'chat.batch', items: [bad as never, { k: 'm', s: 2, at: 2, a: 'k1', x: 'boa' }] });
    // Assert
    expect(drawn).toEqual([]);
    expect(s.lastSeq).toBe(2);
    expect(sent).toEqual([]);
  });
});
