import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defaultChatSettings } from '@swarmcast/shared';
import { ChatBatcher, type ChatSocket } from '../../src/chat/batcher.js';
import { KeyedBuckets, RateWindow, TokenBucket } from '../../src/chat/buckets.js';
import { AdaptiveSlowMode, ChatDetector, protectState } from '../../src/chat/detector.js';
import { EventLoopGuard, GUARD } from '../../src/chat/guard.js';
import { effectiveChat } from '../../src/chat/settings.js';

// The chat's limits (docs/CHAT.md): token buckets, the flood detector, adaptive slow mode, the
// protection levels, the event-loop guard and the batcher that keeps the chat within its upload
// budget (B_chat). Times are explicit numbers (ms): every class here takes `now` per call.

describe('buckets', () => {
  it('token bucket: capacity, refill, refund, wait', () => {
    // Arrange
    const b = new TokenBucket(5, 0.5, 0);
    // Act
    const taken = Array.from({ length: 6 }, () => b.take(0));
    // Assert
    expect(taken).toEqual([true, true, true, true, true, false]);
    expect(b.waitMs(0)).toBe(2000);
    // Act
    const refilled = b.take(2000);
    b.refund();
    const refunded = b.take(2000);
    b.force(2000, 10);
    // Assert
    expect(refilled).toBe(true);
    expect(refunded).toBe(true);
    expect(b.available(2000)).toBeLessThan(0);
  });

  it('keyed buckets evict the oldest beyond the cap', () => {
    // Arrange
    const k = new KeyedBuckets(3, () => ({ n: 0 }));
    // Act
    for (const key of ['a', 'b', 'c', 'd']) k.get(key);
    // Assert
    expect(k.size).toBe(3);
    expect(k.peek('a')).toBeUndefined();
    // Act
    k.get('b');
    k.get('e');
    // Assert
    expect(k.peek('c')).toBeUndefined();
    expect(k.peek('b')).toBeDefined();
  });

  it('rate window counts per second over the window', () => {
    // Arrange
    const w = new RateWindow(10_000);
    // Act
    for (let i = 0; i < 20; i++) w.add(1_000_000 + i * 100);
    // Assert
    expect(w.total(1_002_000)).toBe(20);
    expect(w.perSecond(1_002_000)).toBe(2);
    expect(w.total(1_020_000)).toBe(0);
  });
});

describe('chat detector', () => {
  /** `seconds` seconds of `perSecond` frames each, ticking with `viewers` watching; returns the time after. */
  function flood(d: ChatDetector, t: number, seconds: number, perSecond: number, viewers: number): number {
    for (let s = 0; s < seconds; s++, t += 1000) {
      for (let i = 0; i < perSecond; i++) d.frame(t);
      d.tick(t, viewers);
    }
    return t;
  }

  it('escalates after 3 s of flood and steps down after 2 calm minutes', () => {
    // Arrange
    const d = new ChatDetector();
    // Act
    let t = flood(d, 1_000_000, 3, 400, 50);
    // Assert
    expect(d.level).toBe(2);
    expect(d.reason).toBe('chat.protect.reason.flood');
    // Act
    t = flood(d, t + 20_000, 119, 0, 50);
    // Assert
    expect(d.level).toBe(2);
    // Act
    d.tick(t, 50);
    // Assert
    expect(d.level).toBe(1);
  });

  it('a short burst under 3 s does not escalate', () => {
    // Arrange
    const d = new ChatDetector();
    const t = 1_000_000;
    // Act
    for (let i = 0; i < 300; i++) d.frame(t);
    d.tick(t, 50);
    d.tick(t + 1000, 50);
    // Assert
    expect(d.level).toBe(0);
  });

  it('normal chat stays normal', () => {
    // Arrange
    const d = new ChatDetector();
    // Act
    flood(d, 1_001_000, 60, 1, 100);
    // Assert
    expect(d.level).toBe(0);
  });

  it('a duplicate storm from many senders escalates', () => {
    // Arrange
    const d = new ChatDetector();
    const t = 5_000_000;
    // Act
    for (let i = 0; i < 20; i++) d.accepted(t, `dev${i}`, 'samekey', t - 60 * 60_000);
    // Assert
    expect(d.signals(t, 100).level).toBe(2);
  });

  it('a terminated socket counts', () => {
    // Arrange
    const d = new ChatDetector();
    const t = 5_000_000;
    // Act
    d.terminated(t);
    // Assert
    expect(d.signals(t, 100).level).toBe(1);
  });

  // The start of a live is an audience arriving, not a raid: 30 viewers who all joined in the first
  // minute, each saying something about once every 15 s (2 messages per second overall).
  it('30 viewers who joined in the first minute chat normally', () => {
    // Arrange
    const d = new ChatDetector();
    const start = 10_000_000;
    d.start(start);
    const joined = Array.from({ length: 30 }, (_, i) => start + 2000 * i);
    // Act
    for (let s = 0, t = start + 65_000; s < 120; s++, t += 1000) {
      for (let i = s % 15; i < 30; i += 15) d.accepted(t, `dev${i}`, `hello ${i} ${s}`, joined[i]!);
      d.frame(t);
      d.frame(t);
      d.tick(t, 30);
    }
    // Assert
    expect(d.level).toBe(0);
  });

  // A real raid later in the live: an established audience of 8 chatters from the first minutes,
  // then 40 accounts that joined in the last 30 seconds, all chatting at once.
  it('a real raid later in the live (fresh joiners against an established audience) still triggers', () => {
    // Arrange
    const d = new ChatDetector();
    const start = 10_000_000;
    d.start(start);
    let t = start + 30 * 60_000;
    for (let i = 0; i < 8; i++) d.accepted(t, `old${i}`, `hi ${i}`, start + 1000 * i);
    // Act
    for (let s = 0; s < 4; s++, t += 1000) {
      for (let i = 0; i < 40; i++) d.accepted(t, `new${i}`, `raid ${i} ${s}`, t - 30_000);
      d.tick(t, 48);
    }
    // Assert
    expect(d.signals(t, 48)).toMatchObject({ level: 2 });
    expect(d.level).toBe(2);
  });

  it('honest slow-mode retries are not counted as rejects; other rejects are', () => {
    // Arrange
    const d = new ChatDetector();
    const t = 5_000_000;
    // Act
    for (let i = 0; i < 200; i++) d.reject(t, 'chat.err.slow');
    // Assert
    expect(d.signals(t, 10).level).toBe(0);
    // Act
    for (let i = 0; i < 200; i++) d.reject(t, 'text.combining');
    // Assert
    expect(d.signals(t, 10).level).toBe(2);
  });
});

describe('adaptive slow mode', () => {
  // 60 messages accepted in the window = 6 per second, at least 0.8 × G (G = 5): the slow mode is
  // the number of senders over G, 60 / 5 = 12 s.
  it('raises at once when busy for G and halves after 60 calm seconds', () => {
    // Arrange
    const a = new AdaptiveSlowMode();
    const t = 1_000_000;
    for (let i = 0; i < 60; i++) {
      a.accept(t, `s${i}`);
      a.offer(t);
    }
    // Act
    const raised = a.evaluate(t, 5);
    // Assert
    expect(raised).toBe(true);
    expect(a.autoSlowS).toBe(12);
    // Act
    a.evaluate(t + 20_000, 5);
    a.evaluate(t + 81_000, 5);
    // Assert
    expect(a.autoSlowS).toBe(6);
    // Act
    a.evaluate(t + 142_000, 5);
    // Assert
    expect(a.autoSlowS).toBe(0);
  });
});

describe('protection and effective settings', () => {
  it.each([
    [0, 0, null, true, 'off'],
    [1, 0, null, true, 'slow'],
    [0, 2, null, true, 'lockdown'],
    [2, 2, null, false, 'off'],
    [2, 2, 'off', true, 'off'],
    [0, 0, 'lockdown', false, 'lockdown'],
  ] as const)('detector %i, shield %i, manual %s, auto %s: %s (manual wins, then the higher of detector and shield)', (detector, shield, manual, auto, state) => {
    // Act
    const p = protectState(detector, shield, manual, auto);
    // Assert
    expect(p).toBe(state);
  });

  const s = { ...defaultChatSettings(), content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy' as const, key: 'Abcdefgh', rating: 'pg' as const, consent: 'ask' as const } };

  it('off: the settings as chosen, GIFs on', () => {
    // Act
    const base = effectiveChat({ settings: s, protect: 'off', autoSlowS: 0, guard: 'ok', broken: false });
    // Assert
    expect(base).toMatchObject({ slowS: 2, gifs: true, historyOnJoin: 50, lockdown: false });
    expect(base.public.gif).toBeDefined();
  });

  it.each([
    ['slow protection', { protect: 'slow', autoSlowS: 0, guard: 'ok' }, { slowS: 10, newViewerWaitS: 60, historyOnJoin: 20, gifs: false }],
    ['lockdown', { protect: 'lockdown', autoSlowS: 0, guard: 'ok' }, { slowS: 30, historyOnJoin: 0, gifs: false, lockdown: true }],
    ['an automatic slow mode under a degraded guard', { protect: 'off', autoSlowS: 15, guard: 'degrade' }, { slowS: 15, gifs: false, public: { autoSlow: true } }],
  ] as const)('%s tightens the settings and pauses GIFs', (_what, state, effective) => {
    // Act
    const e = effectiveChat({ settings: s, broken: false, ...state });
    // Assert
    expect(e).toMatchObject(effective);
  });

  it('a broken chat is off', () => {
    // Act
    const e = effectiveChat({ settings: s, protect: 'off', autoSlowS: 0, guard: 'ok', broken: true });
    // Assert
    expect(e.enabled).toBe(false);
  });
});

describe('event-loop guard', () => {
  it('degrades after 5 s over the threshold, pauses on 2 s of heavy load, recovers after 10 calm s', () => {
    // Arrange
    const states: string[] = [];
    const g = new EventLoopGuard({ onChange: (st) => states.push(st) });
    for (let i = 0; i < 20; i++) g.tick({ p99Ms: 11, elu: 0.1 });
    // Act
    for (let i = 0; i < 4; i++) g.tick({ p99Ms: 11 + GUARD.degradeDelayMs + 5, elu: 0.2 });
    // Assert
    expect(g.state).toBe('ok');
    // Act
    g.tick({ p99Ms: 50, elu: 0.2 });
    // Assert
    expect(g.state).toBe('degrade');
    // Act
    g.tick({ p99Ms: 300, elu: 0.95 });
    g.tick({ p99Ms: 300, elu: 0.95 });
    // Assert
    expect(g.state).toBe('pause');
    // Act
    for (let i = 0; i < 9; i++) g.tick({ p99Ms: 11, elu: 0.1 });
    // Assert
    expect(g.state).toBe('pause');
    // Act
    g.tick({ p99Ms: 11, elu: 0.1 });
    // Assert
    expect(g.state).toBe('ok');
    expect(states).toEqual(['degrade', 'pause', 'ok']);
  });

  it('reacts to load from any cause (ELU alone)', () => {
    // Arrange
    const g = new EventLoopGuard();
    // Act
    for (let i = 0; i < 5; i++) g.tick({ p99Ms: 0, elu: 0.75 });
    // Assert
    expect(g.state).toBe('degrade');
  });

  it('the baseline never learns an overload', () => {
    // Arrange
    const g = new EventLoopGuard();
    for (let i = 0; i < 5; i++) g.tick({ p99Ms: 10, elu: 0.1 });
    // Act
    for (let i = 0; i < 300; i++) g.tick({ p99Ms: 200, elu: 0.5 });
    // Assert
    expect(g.state).toBe('pause');
  });

  // The state itself depends on the machine's load, so only the sample is checked; waiting for a
  // sample is waiting for the guard's own timer (intervalMs) to fire once.
  it('samples the real event loop with perf_hooks; stop() resets the state', async () => {
    // Arrange
    const g = new EventLoopGuard({ intervalMs: 20 });
    onTestFinished(() => g.stop());
    const initial = g.last;
    // Act
    g.start();
    await vi.waitFor(() => expect(g.last).not.toBe(initial));
    g.stop();
    // Assert
    expect(g.last.elu).toBeGreaterThanOrEqual(0);
    expect(g.last.elu).toBeLessThanOrEqual(1);
    expect(Number.isFinite(g.last.p99Ms)).toBe(true);
    expect(g.state).toBe('ok');
  });
});

describe('batcher', () => {
  class Sock implements ChatSocket {
    bufferedAmount = 0;
    readyState = 1;
    sent: string[] = [];
    send(d: string): void {
      this.sent.push(d);
    }
  }

  /** Batches as one socket gets them: the items of each frame it was sent. */
  const itemsOf = (sock: Sock): Array<{ k: string; n?: number }> => sock.sent.flatMap((x) => (JSON.parse(x) as { items: Array<{ k: string; n?: number }> }).items);

  it('one serialisation per batch; a slow socket is skipped and later told how many it missed', () => {
    // Arrange
    const a = new Sock();
    const slow = new Sock();
    let t = 1000;
    const resynced: ChatSocket[] = [];
    const b = new ChatBatcher({ transport: { sockets: () => [a, slow] }, budgetBps: () => 1e9, slow: () => false, resync: (s) => resynced.push(s), now: () => t });
    slow.bufferedAmount = 100_000;
    // Act
    b.push({ k: 'm', s: 1, at: t, a: 'k', x: 'hi' }, false);
    b.push({ k: 'm', s: 2, at: t, a: 'k', x: 'yo' }, false);
    b.flush();
    // Assert
    expect(a.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    // Act
    slow.bufferedAmount = 0;
    t += 1000;
    b.push({ k: 'm', s: 3, at: t, a: 'k', x: 'ok' }, false);
    b.flush();
    // Assert
    expect(JSON.parse(slow.sent[0]!)).toEqual({ t: 'chat.batch', items: [{ k: 'skip', n: 2 }] });
    expect(slow.sent[1]).toBe(a.sent[1]);
    expect(resynced).toHaveLength(0);
  });

  it('a slow socket that missed a delete gets a full snapshot, not a skip', () => {
    // Arrange
    const a = new Sock();
    const slow = new Sock();
    const resynced: ChatSocket[] = [];
    const b = new ChatBatcher({ transport: { sockets: () => [a, slow] }, budgetBps: () => 1e9, slow: () => false, resync: (s) => resynced.push(s), now: () => 2000 });
    slow.bufferedAmount = 100_000;
    b.push({ k: 'd', s: [1] }, true);
    b.flush();
    // Act
    slow.bufferedAmount = 0;
    b.push({ k: 'm', s: 4, at: 2000, a: 'k', x: 'x' }, false);
    b.flush();
    // Assert
    expect(resynced).toEqual([slow]);
  });

  it('over budget: holds up to 1 s, then drops the oldest viewer messages (never priority items) with a skip', () => {
    // Arrange
    const socks = Array.from({ length: 100 }, () => new Sock());
    let t = 10_000;
    const b = new ChatBatcher({ transport: { sockets: () => socks }, budgetBps: () => 20_000, slow: () => false, resync: () => {}, now: () => t });
    for (let i = 0; i < 40; i++) b.push({ k: 'm', s: i + 1, at: t, a: 'k', x: 'a message of some length' }, false);
    b.push({ k: 'd', s: [3] }, true);
    // Act
    b.flush();
    // Assert
    expect(socks[0]!.sent).toHaveLength(0);
    // Act
    t += 1000;
    b.flush();
    // Assert
    const items = itemsOf(socks[0]!);
    expect(items.some((i) => i.k === 'd')).toBe(true);
    const skip = items.find((i) => i.k === 'skip');
    expect(skip?.n).toBeGreaterThan(0);
    expect(items.filter((i) => i.k === 'm').length + skip!.n!).toBe(40);
    expect(b.droppedForBudget).toBe(skip!.n);
  });

  // 3 messages with their roster items to 120 sockets are more than the whole 1 s bucket at 50 KB/s:
  // they still go out at once, and the quiet chat that follows (one message every 2 s for a
  // minute) keeps flowing with nothing skipped.
  it('a quiet chat to a big audience is delivered: 3 messages with roster items, 120 sockets, 50 KB/s', () => {
    // Arrange
    const socks = Array.from({ length: 120 }, () => new Sock());
    let t = 10_000;
    const b = new ChatBatcher({ transport: { sockets: () => socks }, budgetBps: () => 50_000, slow: () => false, resync: () => {}, now: () => t });
    for (let i = 0; i < 3; i++) {
      b.push({ k: 'u', au: { a: `a${i}`, n: `Viewer ${i}`, c: '#e5484d', r: 'viewer', tag: 'abcd' } }, true);
      b.push({ k: 'm', s: i + 1, at: t, a: `a${i}`, x: 'boa noite, chat! tudo certo por aí? 😀' }, false);
    }
    // Act
    b.flush();
    // Assert
    expect(socks[0]!.sent).toHaveLength(1);
    const items = itemsOf(socks[0]!);
    expect(items.filter((i) => i.k === 'm')).toHaveLength(3);
    expect(items.some((i) => i.k === 'skip')).toBe(false);
    expect(socks[0]!.sent[0]!.length * 120).toBeGreaterThan(50_000);
    // Act
    for (let s = 0; s < 30; s++) {
      t += 2000;
      b.push({ k: 'm', s: 100 + s, at: t, a: 'a1', x: 'kkkkk 😂' }, false);
      b.flush();
    }
    // Assert
    expect(b.droppedForBudget).toBe(0);
    expect(socks[7]!.sent).toHaveLength(31);
  });

  // Over the run the batcher sends at most the budget, plus one second of capacity and its
  // bounded debt; a delete goes out every 10 s whatever the flood.
  it('a sustained flood stays within B_chat on average (bounded debt), and priority items always go', () => {
    // Arrange
    const socks = Array.from({ length: 120 }, () => new Sock());
    let t = 10_000;
    const budget = 50_000;
    const seconds = 120;
    const b = new ChatBatcher({ transport: { sockets: () => socks }, budgetBps: () => budget, slow: () => false, resync: () => {}, now: () => t });
    let seq = 0;
    // Act
    for (let tick = 0; tick < seconds * 4; tick++) {
      for (let i = 0; i < 20; i++) b.push({ k: 'm', s: ++seq, at: t, a: 'k', x: `flood message number ${seq}` }, false);
      if (tick % 40 === 0) b.push({ k: 'd', s: [seq] }, true);
      b.flush();
      t += 250;
    }
    // Assert
    const sent = socks.reduce((n, s) => n + s.sent.reduce((m, x) => m + x.length, 0), 0);
    expect(sent).toBeLessThanOrEqual(budget * seconds + budget + 2 * budget);
    expect(sent).toBeGreaterThan(budget * seconds * 0.5);
    expect(b.droppedForBudget).toBeGreaterThan(0);
    expect(itemsOf(socks[0]!).filter((i) => i.k === 'd')).toHaveLength(seconds / 10);
  });

  it('the pending queue is capped at 500 items', () => {
    // Arrange
    const b = new ChatBatcher({ transport: { sockets: () => [] }, budgetBps: () => 1e9, slow: () => false, resync: () => {} });
    onTestFinished(() => b.reset());
    // Act
    for (let i = 0; i < 700; i++) b.push({ k: 'm', s: i + 1, at: 0, a: 'k', x: 'x' }, false);
    // Assert
    expect(b.pending).toBeLessThanOrEqual(501);
  });
});
