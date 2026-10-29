import { describe, expect, it } from 'vitest';
import { defaultChatSettings } from '@swarmcast/shared';
import { ChatBatcher, type ChatSocket } from '../../src/chat/batcher.js';
import { KeyedBuckets, RateWindow, TokenBucket } from '../../src/chat/buckets.js';
import { AdaptiveSlowMode, ChatDetector, protectState } from '../../src/chat/detector.js';
import { EventLoopGuard, GUARD } from '../../src/chat/guard.js';
import { effectiveChat } from '../../src/chat/settings.js';

describe('buckets', () => {
  it('token bucket: capacity, refill, refund, wait', () => {
    const b = new TokenBucket(5, 0.5, 0);
    for (let i = 0; i < 5; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.waitMs(0)).toBe(2000);
    expect(b.take(2000)).toBe(true);
    b.refund();
    expect(b.take(2000)).toBe(true);
    b.force(2000, 10);
    expect(b.available(2000)).toBeLessThan(0);
  });

  it('keyed buckets evict the oldest beyond the cap', () => {
    const k = new KeyedBuckets(3, () => ({ n: 0 }));
    for (const key of ['a', 'b', 'c', 'd']) k.get(key);
    expect(k.size).toBe(3);
    expect(k.peek('a')).toBeUndefined();
    k.get('b');
    k.get('e');
    expect(k.peek('c')).toBeUndefined();
    expect(k.peek('b')).toBeDefined();
  });

  it('rate window counts per second over the window', () => {
    const w = new RateWindow(10_000);
    for (let i = 0; i < 20; i++) w.add(1_000_000 + i * 100);
    expect(w.total(1_002_000)).toBe(20);
    expect(w.perSecond(1_002_000)).toBe(2);
    expect(w.total(1_020_000)).toBe(0);
  });
});

describe('chat detector', () => {
  it('escalates after 3 s of flood and steps down after 2 calm minutes', () => {
    const d = new ChatDetector();
    let t = 1_000_000;
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 400; i++) d.frame(t);
      d.tick(t, 50);
      t += 1000;
    }
    expect(d.level).toBe(2);
    expect(d.reason).toBe('chat.protect.reason.flood');
    t += 20_000;
    for (let s = 0; s < 119; s++) {
      d.tick(t, 50);
      t += 1000;
    }
    expect(d.level).toBe(2);
    d.tick(t, 50);
    expect(d.level).toBe(1);
  });

  it('a short burst under 3 s does not escalate; normal chat stays normal', () => {
    const d = new ChatDetector();
    let t = 1_000_000;
    for (let i = 0; i < 300; i++) d.frame(t);
    d.tick(t, 50);
    t += 1000;
    d.tick(t, 50);
    expect(d.level).toBe(0);
    const calm = new ChatDetector();
    for (let s = 0; s < 60; s++) {
      calm.frame(t + s * 1000);
      calm.tick(t + s * 1000, 100);
    }
    expect(calm.level).toBe(0);
  });

  it('duplicate storm from many senders and frame terminations count', () => {
    const d = new ChatDetector();
    const t = 5_000_000;
    for (let i = 0; i < 20; i++) d.accepted(t, `dev${i}`, 'samekey', t - 60 * 60_000);
    expect(d.signals(t, 100).level).toBe(2);
    const e = new ChatDetector();
    e.terminated(t);
    expect(e.signals(t, 100).level).toBe(1);
  });

  it('honest slow-mode retries are not counted as rejects', () => {
    const d = new ChatDetector();
    const t = 5_000_000;
    for (let i = 0; i < 200; i++) d.reject(t, 'chat.err.slow');
    expect(d.signals(t, 10).level).toBe(0);
    for (let i = 0; i < 200; i++) d.reject(t, 'text.combining');
    expect(d.signals(t, 10).level).toBe(2);
  });
});

describe('adaptive slow mode', () => {
  it('raises at once when busy for G and halves after 60 calm seconds', () => {
    const a = new AdaptiveSlowMode();
    let t = 1_000_000;
    for (let i = 0; i < 60; i++) {
      a.accept(t, `s${i}`);
      a.offer(t);
    }
    // 60 accepted in the window = 6/s ≥ 0.8 × G(5): 60 senders / 5 → 12 s.
    expect(a.evaluate(t, 5)).toBe(true);
    expect(a.autoSlowS).toBe(12);
    t += 20_000;
    a.evaluate(t, 5);
    t += 61_000;
    a.evaluate(t, 5);
    expect(a.autoSlowS).toBe(6);
    t += 61_000;
    a.evaluate(t, 5);
    expect(a.autoSlowS).toBe(0);
  });
});

describe('protection and effective settings', () => {
  it('manual wins, then the higher of detector and shield; off without auto protection', () => {
    expect(protectState(0, 0, null, true)).toBe('off');
    expect(protectState(1, 0, null, true)).toBe('slow');
    expect(protectState(0, 2, null, true)).toBe('lockdown');
    expect(protectState(2, 2, null, false)).toBe('off');
    expect(protectState(2, 2, 'off', true)).toBe('off');
    expect(protectState(0, 0, 'lockdown', false)).toBe('lockdown');
  });

  it('slow and lockdown tighten the settings; the guard pauses GIFs', () => {
    const s = { ...defaultChatSettings(), content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy' as const, key: 'Abcdefgh', rating: 'pg' as const, consent: 'ask' as const } };
    const base = effectiveChat({ settings: s, protect: 'off', autoSlowS: 0, guard: 'ok', broken: false });
    expect(base).toMatchObject({ slowS: 2, gifs: true, historyOnJoin: 50, lockdown: false });
    expect(base.public.gif).toBeDefined();
    expect(effectiveChat({ settings: s, protect: 'slow', autoSlowS: 0, guard: 'ok', broken: false })).toMatchObject({ slowS: 10, newViewerWaitS: 60, historyOnJoin: 20, gifs: false });
    expect(effectiveChat({ settings: s, protect: 'lockdown', autoSlowS: 0, guard: 'ok', broken: false })).toMatchObject({ slowS: 30, historyOnJoin: 0, gifs: false, lockdown: true });
    expect(effectiveChat({ settings: s, protect: 'off', autoSlowS: 15, guard: 'degrade', broken: false })).toMatchObject({ slowS: 15, gifs: false, public: { autoSlow: true } });
    expect(effectiveChat({ settings: s, protect: 'off', autoSlowS: 0, guard: 'ok', broken: true }).enabled).toBe(false);
  });
});

describe('event-loop guard', () => {
  it('degrades after 5 s over the threshold, pauses on 2 s of heavy load, recovers after 10 calm s', () => {
    const states: string[] = [];
    const g = new EventLoopGuard({ onChange: (s) => states.push(s) });
    for (let i = 0; i < 20; i++) g.tick({ p99Ms: 11, elu: 0.1 });
    for (let i = 0; i < 4; i++) g.tick({ p99Ms: 11 + GUARD.degradeDelayMs + 5, elu: 0.2 });
    expect(g.state).toBe('ok');
    g.tick({ p99Ms: 50, elu: 0.2 });
    expect(g.state).toBe('degrade');
    g.tick({ p99Ms: 300, elu: 0.95 });
    g.tick({ p99Ms: 300, elu: 0.95 });
    expect(g.state).toBe('pause');
    for (let i = 0; i < 9; i++) g.tick({ p99Ms: 11, elu: 0.1 });
    expect(g.state).toBe('pause');
    g.tick({ p99Ms: 11, elu: 0.1 });
    expect(g.state).toBe('ok');
    expect(states).toEqual(['degrade', 'pause', 'ok']);
  });

  it('reacts to load from any cause (ELU alone)', () => {
    const g = new EventLoopGuard();
    for (let i = 0; i < 5; i++) g.tick({ p99Ms: 0, elu: 0.75 });
    expect(g.state).toBe('degrade');
  });

  it('the baseline never learns an overload', () => {
    const g = new EventLoopGuard();
    for (let i = 0; i < 5; i++) g.tick({ p99Ms: 10, elu: 0.1 });
    for (let i = 0; i < 300; i++) g.tick({ p99Ms: 200, elu: 0.5 });
    expect(g.state).toBe('pause');
  });

  it('samples the real event loop with perf_hooks', async () => {
    const g = new EventLoopGuard({ intervalMs: 20 });
    g.start();
    await new Promise((r) => setTimeout(r, 70));
    g.stop();
    expect(g.last.elu).toBeGreaterThanOrEqual(0);
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

  it('one serialisation per batch; a slow socket is skipped and later told how many it missed', () => {
    const a = new Sock();
    const slow = new Sock();
    let t = 1000;
    const resynced: ChatSocket[] = [];
    const b = new ChatBatcher({ transport: { sockets: () => [a, slow] }, budgetBps: () => 1e9, slow: () => false, resync: (s) => resynced.push(s), now: () => t });
    slow.bufferedAmount = 100_000;
    b.push({ k: 'm', s: 1, at: t, a: 'k', x: 'hi' }, false);
    b.push({ k: 'm', s: 2, at: t, a: 'k', x: 'yo' }, false);
    b.flush();
    expect(a.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    slow.bufferedAmount = 0;
    t += 1000;
    b.push({ k: 'm', s: 3, at: t, a: 'k', x: 'ok' }, false);
    b.flush();
    expect(JSON.parse(slow.sent[0]!)).toEqual({ t: 'chat.batch', items: [{ k: 'skip', n: 2 }] });
    expect(slow.sent[1]).toBe(a.sent[1]);
    expect(resynced).toHaveLength(0);
    // Missing a delete means a full snapshot, not a skip.
    slow.bufferedAmount = 100_000;
    b.push({ k: 'd', s: [1] }, true);
    b.flush();
    slow.bufferedAmount = 0;
    b.push({ k: 'm', s: 4, at: t, a: 'k', x: 'x' }, false);
    b.flush();
    expect(resynced).toEqual([slow]);
  });

  it('over budget: holds up to 1 s, then drops the oldest viewer messages (never priority items) with a skip', () => {
    const socks = Array.from({ length: 100 }, () => new Sock());
    let t = 10_000;
    const b = new ChatBatcher({ transport: { sockets: () => socks }, budgetBps: () => 20_000, slow: () => false, resync: () => {}, now: () => t });
    for (let i = 0; i < 40; i++) b.push({ k: 'm', s: i + 1, at: t, a: 'k', x: 'a message of some length' }, false);
    b.push({ k: 'd', s: [3] }, true);
    b.flush();
    expect(socks[0]!.sent).toHaveLength(0);
    t += 1000;
    b.flush();
    const batch = JSON.parse(socks[0]!.sent[0]!) as { items: Array<{ k: string; n?: number }> };
    expect(batch.items.some((i) => i.k === 'd')).toBe(true);
    const skip = batch.items.find((i) => i.k === 'skip');
    expect(skip?.n).toBeGreaterThan(0);
    expect(batch.items.filter((i) => i.k === 'm').length + skip!.n!).toBe(40);
    expect(b.droppedForBudget).toBe(skip!.n);
  });

  it('the pending queue is capped at 500 items', () => {
    const b = new ChatBatcher({ transport: { sockets: () => [] }, budgetBps: () => 1e9, slow: () => false, resync: () => {} });
    for (let i = 0; i < 700; i++) b.push({ k: 'm', s: i + 1, at: 0, a: 'k', x: 'x' }, false);
    expect(b.pending).toBeLessThanOrEqual(501);
    b.reset();
  });
});
