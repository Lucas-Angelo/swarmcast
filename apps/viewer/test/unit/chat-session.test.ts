import { describe, expect, it, vi } from 'vitest';
import type { ChatItem, ChatPublicSettings, ChatServerMessage, ChatSnapshot } from '@swarmcast/shared/chat';
import { ChatSession, RESUME_WAIT_MS, type ChatEntry, type ChatView, type ClientFrame } from '../../src/chat/session.js';

function settings(over: Partial<ChatPublicSettings> = {}): ChatPublicSettings {
  return { enabled: true, content: ['text', 'emotes'], slowS: 2, autoSlow: false, maxGraphemes: 200, maxEmoji: 30, newViewerWaitS: 0, colors: 'choose', linksBlocked: false, emotes: [], builtinEmotes: true, protect: 'off', streamerName: '', ...over };
}
const you = { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null };
const ana = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' as const };
const msg = (s: number, x = `m${s}`, a = 'k1'): ChatItem => ({ k: 'm', s, at: 1000 + s, a, x });

function setup(snapshot?: Partial<ChatSnapshot>) {
  const shown: number[] = [];
  const calls: string[] = [];
  const sent: ClientFrame[] = [];
  const entries: ChatEntry[] = [];
  const view: ChatView = {
    reset: (e) => {
      shown.length = 0;
      entries.length = 0;
      entries.push(...e);
      for (const x of e) if (x.kind !== 'skip') shown.push(x.s);
      calls.push('reset');
    },
    append: (e) => {
      entries.push(...e);
      for (const x of e) if (x.kind !== 'skip') shown.push(x.s);
    },
    remove: (s) => calls.push(`remove ${s.join(',')}`),
    clearUpTo: (s) => calls.push(`clr ${s}`),
    author: (a) => calls.push(`author ${a.a} ${a.c}`),
    settings: (s) => calls.push(`settings ${s ? s.enabled : 'null'}`),
    you: () => calls.push('you'),
    ack: (n, s) => calls.push(`ack ${n} ${s}`),
    reject: (n, code) => calls.push(`reject ${n} ${code}`),
    unsupported: () => calls.push('unsupported'),
    connection: (o) => calls.push(`conn ${o}`),
  };
  const session = new ChatSession(view, (m) => {
    sent.push(m);
    return true;
  });
  session.connection(true);
  session.hello({ v: 1, settings: settings(), you, roster: [ana], items: [msg(1), msg(2)], lastSeq: 2, ...snapshot });
  return { session, shown, calls, sent, entries };
}

describe('ChatSession', () => {
  it('shows the snapshot, then new items in seq order, ignoring repeats (reconnect)', () => {
    const { session, shown } = setup();
    expect(shown).toEqual([1, 2]);
    session.frame({ t: 'chat.batch', items: [msg(2), msg(3), msg(4)] });
    session.frame({ t: 'chat.batch', items: [msg(4)] });
    expect(shown).toEqual([1, 2, 3, 4]);
    expect(session.lastSeq).toBe(4);
  });

  it('resolves authors from the roster and reports colour changes', () => {
    const { session, entries, calls } = setup();
    session.frame({ t: 'chat.batch', items: [{ k: 'u', au: { ...ana, c: '#46a758' } }, msg(3)] });
    const last = entries.at(-1);
    expect(last?.kind === 'msg' && last.author.c).toBe('#46a758');
    expect(calls).toContain('author k1 #46a758');
  });

  it('asks to resume on a gap and holds newer items until the missing ones come', () => {
    const { session, shown, sent } = setup();
    session.frame({ t: 'chat.batch', items: [msg(5), msg(6)] });
    expect(sent).toEqual([{ t: 'chat.resume', after: 2 }]);
    expect(shown).toEqual([1, 2]);
    session.frame({ t: 'chat.batch', items: [msg(3), msg(4)] });
    expect(shown).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('accepts the gap when the resume answer never comes', () => {
    vi.useFakeTimers();
    try {
      const { session, shown } = setup();
      session.frame({ t: 'chat.batch', items: [msg(9)] });
      expect(shown).toEqual([1, 2]);
      vi.advanceTimersByTime(RESUME_WAIT_MS);
      expect(shown).toEqual([1, 2, 9]);
      expect(session.lastSeq).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a skip item explains a gap: no resume', () => {
    const { session, shown, sent, entries } = setup();
    session.frame({ t: 'chat.batch', items: [{ k: 'skip', n: 3 }, msg(6)] });
    expect(sent).toEqual([]);
    expect(shown).toEqual([1, 2, 6]);
    expect(entries.some((e) => e.kind === 'skip' && e.n === 3)).toBe(true);
  });

  it('a reset snapshot replaces everything and drops held items', () => {
    const { session, shown, calls } = setup();
    session.frame({ t: 'chat.batch', items: [msg(8)] });
    session.frame({ t: 'chat.reset', v: 1, settings: settings(), you, roster: [ana], items: [msg(10)], lastSeq: 10 });
    expect(shown).toEqual([10]);
    expect(calls.filter((c) => c === 'reset')).toHaveLength(2);
    session.frame({ t: 'chat.batch', items: [msg(11)] });
    expect(shown).toEqual([10, 11]);
  });

  it('deletes and clears are passed on and filter what is about to be shown', () => {
    const { session, shown, calls } = setup();
    session.frame({ t: 'chat.batch', items: [msg(3), { k: 'd', s: [3] }, msg(4), { k: 'clr', s: 4 }, msg(5)] });
    expect(shown).toEqual([1, 2, 5]);
    expect(calls).toContain('remove 3');
    expect(calls).toContain('clr 4');
  });

  it('passes acks, rejects, settings and you; ignores unknown t and k', () => {
    const { session, calls } = setup();
    session.frame({ t: 'chat.ack', n: 7, s: 3 });
    session.frame({ t: 'chat.reject', n: 8, code: 'chat.err.slow', retryMs: 900 });
    session.frame({ t: 'chat.you', you: { ...you, mutedUntil: 'live' } });
    session.frame({ t: 'chat.future' } as unknown as ChatServerMessage);
    session.frame({ t: 'chat.batch', items: [{ k: 'zz' } as unknown as ChatItem, msg(3)] });
    expect(calls).toEqual(expect.arrayContaining(['ack 7 3', 'reject 8 chat.err.slow', 'you']));
    expect(session.you?.mutedUntil).toBe('live');
    expect(session.lastSeq).toBe(3);
  });

  it('a snapshot of another protocol version asks for a reload', () => {
    const { session, calls } = setup();
    session.frame({ t: 'chat.reset', v: 2, settings: settings(), you, roster: [], items: [], lastSeq: 0 });
    expect(calls).toContain('unsupported');
  });

  it('chat off at hello, on later: asks for a snapshot', () => {
    const sent: ClientFrame[] = [];
    const noop = () => {};
    const view = { reset: noop, append: noop, remove: noop, clearUpTo: noop, author: noop, settings: noop, you: noop, ack: noop, reject: noop, unsupported: noop, connection: noop };
    const s = new ChatSession(view, (m) => {
      sent.push(m);
      return true;
    });
    s.connection(true);
    s.hello(undefined);
    expect(s.active).toBe(false);
    s.frame({ t: 'chat.settings', settings: settings() });
    expect(sent).toEqual([{ t: 'chat.resume', after: 0 }]);
  });

  it('does not send while disconnected', () => {
    const { session } = setup();
    session.connection(false);
    expect(session.send({ t: 'chat.send', n: 1, text: 'oi' })).toBe(false);
  });
});
