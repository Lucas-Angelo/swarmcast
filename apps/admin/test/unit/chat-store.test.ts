import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { AdminChatMessage, AdminChatState, ChatAuthor, ChatCounters, ChatItem } from '@swarmcast/shared';
import { ChatStore } from '../../src/chat/store.js';

const counters: ChatCounters = { acceptedPerMin: 3, rejectedPerMin: 1, skipped: 0, globalPerS: 5, egressKbps: 1, budgetKbps: 128, guard: 'ok', protect: 'off', broken: false };
const ana: ChatAuthor = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' };
const host: ChatAuthor = { a: 'k0', n: 'Lu', c: '#12a594', r: 'streamer' };
const m = (s: number, a = 'k1', x = `msg ${s}`): ChatItem => ({ k: 'm', s, at: 1_700_000_000_000 + s, a, x });
const msg = (items: ChatItem[], o: Partial<AdminChatMessage> = {}): AdminChatMessage => ({ type: 'chat', reset: false, items, sessions: {}, ...o });
const seqs = (st: ChatStore) => st.view().items.map((i) => i.s);

describe('panel chat store', () => {
  it('a reset message (the ring on connect) replaces everything, roster first', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([m(1)], { sessions: { k1: 'sess-a' } }));
    // Act
    st.apply(msg([{ k: 'u', au: ana }, { k: 'u', au: host }, m(5), m(6, 'k0')], { reset: true, sessions: { k1: 'sess-b' }, counters }));
    // Assert
    const v = st.view();
    expect(seqs(st)).toEqual([5, 6]);
    expect(v.roster.get('k0')?.r).toBe('streamer');
    expect(v.sessions.get('k1')).toBe('sess-b');
    expect(v.counters).toEqual(counters);
    expect(v.lastSeq).toBe(6);
  });

  it('appends in seq order and ignores duplicates after a reconnect', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1), m(2), m(3)]));
    // Act
    st.apply(msg([m(2), m(3)]));
    // Assert
    expect(seqs(st)).toEqual([1, 2, 3]);
  });

  it('deletes, and a clear keeps only what comes after it', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1), m(2), m(3)]));
    // Act
    st.apply(msg([{ k: 'd', s: [2] }]));
    // Assert
    expect(seqs(st)).toEqual([1, 3]);
    // Act
    st.apply(msg([m(4), { k: 'clr', s: 4 }, { k: 'sys', s: 5, at: 1, code: 'chat.sys.cleared' }]));
    // Assert
    expect(seqs(st)).toEqual([5]);
    expect(st.view().items[0]!.k).toBe('sys');
  });

  it('a delete never removes a system line with the same seq; skip and unknown kinds are ignored', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'sys', s: 1, at: 1, code: 'chat.sys.protect' }, m(2)]));
    // Act
    st.apply(msg([{ k: 'd', s: [1, 2] }, { k: 'skip', n: 3 }, { k: 'zz' } as unknown as ChatItem]));
    // Assert
    expect(seqs(st)).toEqual([1]);
  });

  it('a malformed item (a newer or broken server) is skipped on its own; the items around it apply', () => {
    // Arrange
    const st = new ChatStore();
    const bad = [null, 3, { k: 'u' }, { k: 'u', au: null }, { k: 'm', s: 'x', a: 'k1' }, { k: 'm', s: 2 }, { k: 'sys', s: null }, { k: 'd', s: 4 }, { k: 'clr', s: 'all' }] as unknown as ChatItem[];
    // Act
    st.apply(msg([{ k: 'u', au: ana }, m(1), ...bad, m(3)]));
    // Assert
    expect(seqs(st)).toEqual([1, 3]);
    expect(st.view().roster.size).toBe(1);
  });

  it('fuzz: any items never throw and keep the feed in seq order', () => {
    // Arrange
    const item = fc.oneof(
      fc.integer({ min: 1, max: 50 }).map((s) => m(s)),
      fc.record({ k: fc.constantFrom('u', 'm', 'sys', 'd', 'clr', 'skip', 'pin', 'zz'), s: fc.oneof(fc.integer({ min: 0, max: 50 }), fc.jsonValue()), a: fc.jsonValue(), au: fc.jsonValue(), code: fc.string() }),
      fc.jsonValue(),
    ) as fc.Arbitrary<unknown> as fc.Arbitrary<ChatItem>;
    const property = fc.property(fc.array(fc.array(item, { maxLength: 15 }), { maxLength: 5 }), (batches) => {
      const st = new ChatStore();
      for (const items of batches) st.apply(msg(items));
      const s = seqs(st);
      return s.every((x, i) => i === 0 || s[i - 1]! < x);
    });
    // Act
    const run = () => fc.assert(property, { numRuns: 1000, seed: 5 });
    // Assert
    expect(run).not.toThrow();
  });

  it('a colour change (roster upsert) updates the author in place', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1)]));
    // Act
    st.apply(msg([{ k: 'u', au: { ...ana, c: '#0090ff' } }]));
    // Assert
    expect(st.view().roster.get('k1')?.c).toBe('#0090ff');
  });

  it('flags a message whose author was announced before the panel opened, until the roster arrives', () => {
    // Arrange
    const st = new ChatStore();
    // Act
    st.apply(msg([m(1, 'k0')]));
    // Assert
    expect(st.missingAuthors).toBe(true);
    // Act
    st.apply(msg([{ k: 'u', au: host }]));
    // Assert
    expect(st.missingAuthors).toBe(false);
    // Act
    st.apply(msg([m(2, 'k9')]));
    st.applyState({ settings: {} as AdminChatState['settings'], effective: {} as AdminChatState['effective'], roster: [{ ...ana, a: 'k9' }], items: [m(2, 'k9')], lastSeq: 2, sessions: [], counters });
    // Assert
    expect(st.missingAuthors).toBe(false);
  });

  it('keeps at most `keep` messages', () => {
    // Arrange
    const st = new ChatStore(3);
    // Act
    st.apply(msg([m(1), m(2), m(3), m(4), m(5)]));
    // Assert
    expect(seqs(st)).toEqual([3, 4, 5]);
  });

  it('GET /api/chat state: feed, sessions with mutes and colours, counters', () => {
    // Arrange
    const st = new ChatStore();
    const state: AdminChatState = {
      settings: {} as AdminChatState['settings'],
      effective: {} as AdminChatState['effective'],
      roster: [ana],
      items: [m(7), m(8)],
      lastSeq: 9,
      sessions: [{ sessionId: 'sess-a', a: 'k1', nickname: 'Ana', color: '#e5484d', colorLocked: true, mutedUntil: 'live', tag: 'ABCD' }],
      counters,
    };
    // Act
    st.applyState(state);
    // Assert
    expect(seqs(st)).toEqual([7, 8]);
    expect(st.view().lastSeq).toBe(9);
    expect(st.sessionOf('k1')).toBe('sess-a');
    expect(st.infoOf('sess-a')?.mutedUntil).toBe('live');
    // Act
    st.setSessions([]);
    // Assert
    expect(st.infoOf('sess-a')).toBeUndefined();
  });

  it('notifies subscribers with a new view each change, and stops after unsubscribe', () => {
    // Arrange
    const st = new ChatStore();
    const fn = vi.fn();
    const off = st.subscribe(fn);
    // Act
    st.apply(msg([m(1)]));
    st.apply(msg([m(2)]));
    off();
    st.apply(msg([m(3)]));
    // Assert
    const [[first], [second]] = fn.mock.calls as [[{ rev: number }], [{ rev: number }]];
    expect(second).not.toBe(first);
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('panel chat store: highlight and pin', () => {
  const pin = (s: number, o: Partial<{ endsIn: number; at: number }> = {}) => ({ s, a: 'k1', x: `msg ${s}`, at: o.at ?? 9000, ...(o.endsIn !== undefined ? { endsIn: o.endsIn } : {}) });

  it('hl items mark and unmark a message with a new item object (the row re-renders); unknown seqs change nothing', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1), m(2)]));
    const before = st.view().items[0];
    // Act
    st.apply(msg([{ k: 'hl', s: 1, on: true }, { k: 'hl', s: 9, on: true }]));
    const lit = st.view().items[0];
    st.apply(msg([{ k: 'hl', s: 1, on: false }]));
    // Assert
    expect(lit).toMatchObject({ s: 1, h: 1 });
    expect(lit).not.toBe(before);
    expect(st.view().items[0]).not.toHaveProperty('h');
    expect(seqs(st)).toEqual([1, 2]);
  });

  it('a pin item sets the pin and, for a timed one, when it comes down on this clock; null unpins', () => {
    // Arrange
    const st = new ChatStore(500, () => 1_000);
    st.apply(msg([{ k: 'u', au: ana }, m(1), m(2)]));
    // Act
    st.apply(msg([{ k: 'pin', p: pin(2, { endsIn: 60_000 }) }]));
    const timed = { pin: st.view().pin, until: st.view().pinUntil };
    st.apply(msg([{ k: 'pin', p: pin(1) }]));
    const forever = { pin: st.view().pin?.s, until: st.view().pinUntil };
    st.apply(msg([{ k: 'pin', p: null }]));
    // Assert
    expect(timed).toEqual({ pin: pin(2, { endsIn: 60_000 }), until: 61_000 });
    expect(forever).toEqual({ pin: 1, until: null });
    expect(st.view().pin).toBeNull();
  });

  it('deleting or clearing the pinned message unpins it; a reset unpins until the pin comes again', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1), m(2), { k: 'pin', p: pin(2) }]));
    // Act
    st.apply(msg([{ k: 'd', s: [1] }]));
    const afterOther = st.view().pin?.s;
    st.apply(msg([{ k: 'd', s: [2] }]));
    const afterDelete = st.view().pin;
    st.apply(msg([m(3), { k: 'pin', p: pin(3) }, { k: 'clr', s: 3 }]));
    const afterClear = st.view().pin;
    st.apply(msg([m(4), { k: 'pin', p: pin(4) }]));
    st.apply(msg([{ k: 'u', au: ana }, m(4)], { reset: true }));
    // Assert
    expect(afterOther).toBe(2);
    expect(afterDelete).toBeNull();
    expect(afterClear).toBeNull();
    expect(st.view().pin).toBeNull();
  });

  it('GET /api/chat brings the pin (or none)', () => {
    // Arrange
    const st = new ChatStore(500, () => 0);
    const state = (p?: ReturnType<typeof pin>): AdminChatState => ({ settings: {} as AdminChatState['settings'], effective: {} as AdminChatState['effective'], roster: [ana], items: [m(1)], lastSeq: 1, sessions: [], counters, ...(p ? { pin: p } : {}) });
    // Act
    st.applyState(state(pin(1, { endsIn: 5000 })));
    const withPin = { s: st.view().pin?.s, until: st.view().pinUntil };
    st.applyState(state());
    // Assert
    expect(withPin).toEqual({ s: 1, until: 5000 });
    expect(st.view().pin).toBeNull();
  });

  it('a malformed pin or hl item counts as no pin / is skipped, and never stops the items after it', () => {
    // Arrange
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1), { k: 'pin', p: pin(1) }]));
    // Act
    st.apply(msg([{ k: 'pin', p: { s: 'x' } } as unknown as ChatItem, { k: 'hl', s: 1, on: 'yes' } as unknown as ChatItem, m(2)]));
    // Assert
    expect(st.view().pin).toBeNull();
    expect(st.view().items[0]).not.toHaveProperty('h');
    expect(seqs(st)).toEqual([1, 2]);
  });
});
