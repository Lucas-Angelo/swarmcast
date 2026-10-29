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
    const st = new ChatStore();
    st.apply(msg([m(1)], { sessions: { k1: 'sess-a' } }));
    st.apply(msg([{ k: 'u', au: ana }, { k: 'u', au: host }, m(5), m(6, 'k0')], { reset: true, sessions: { k1: 'sess-b' }, counters }));
    const v = st.view();
    expect(seqs(st)).toEqual([5, 6]);
    expect(v.roster.get('k0')?.r).toBe('streamer');
    expect(v.sessions.get('k1')).toBe('sess-b');
    expect(v.counters).toEqual(counters);
    expect(v.lastSeq).toBe(6);
  });

  it('appends in seq order, ignores duplicates after a reconnect, deletes and clears', () => {
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1), m(2), m(3)]));
    st.apply(msg([m(2), m(3)]));
    expect(seqs(st)).toEqual([1, 2, 3]);
    st.apply(msg([{ k: 'd', s: [2] }]));
    expect(seqs(st)).toEqual([1, 3]);
    st.apply(msg([m(4), { k: 'clr', s: 4 }, { k: 'sys', s: 5, at: 1, code: 'chat.sys.cleared' }]));
    expect(seqs(st)).toEqual([5]);
    expect(st.view().items[0]!.k).toBe('sys');
  });

  it('a delete never removes a system line with the same seq; skip and unknown kinds are ignored', () => {
    const st = new ChatStore();
    st.apply(msg([{ k: 'sys', s: 1, at: 1, code: 'chat.sys.protect' }, m(2)]));
    st.apply(msg([{ k: 'd', s: [1, 2] }, { k: 'skip', n: 3 }, { k: 'zz' } as unknown as ChatItem]));
    expect(seqs(st)).toEqual([1]);
  });

  it('a colour change (roster upsert) updates the author in place', () => {
    const st = new ChatStore();
    st.apply(msg([{ k: 'u', au: ana }, m(1)]));
    st.apply(msg([{ k: 'u', au: { ...ana, c: '#0090ff' } }]));
    expect(st.view().roster.get('k1')?.c).toBe('#0090ff');
  });

  it('keeps at most `keep` messages', () => {
    const st = new ChatStore(3);
    st.apply(msg([m(1), m(2), m(3), m(4), m(5)]));
    expect(seqs(st)).toEqual([3, 4, 5]);
  });

  it('GET /api/chat state: feed, sessions with mutes and colours, counters', () => {
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
    st.applyState(state);
    expect(seqs(st)).toEqual([7, 8]);
    expect(st.view().lastSeq).toBe(9);
    expect(st.sessionOf('k1')).toBe('sess-a');
    expect(st.infoOf('sess-a')?.mutedUntil).toBe('live');
    st.setSessions([]);
    expect(st.infoOf('sess-a')).toBeUndefined();
  });

  it('notifies subscribers with a new view each change, and stops after unsubscribe', () => {
    const st = new ChatStore();
    const fn = vi.fn();
    const off = st.subscribe(fn);
    st.apply(msg([m(1)]));
    const first = fn.mock.calls[0]![0];
    st.apply(msg([m(2)]));
    const second = fn.mock.calls[1]![0];
    expect(second).not.toBe(first);
    expect(second.rev).toBeGreaterThan(first.rev);
    off();
    st.apply(msg([m(3)]));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
