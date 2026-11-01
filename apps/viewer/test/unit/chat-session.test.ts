// The viewer's chat state without DOM (chat/session.ts): server frames become calls on a ChatView,
// in seq order and without repeats, with a resume request on a gap. Each test starts from a hello
// whose snapshot holds messages 1 and 2 from Ana, unless it says otherwise.
import fc from 'fast-check';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChatItem, ChatPublicSettings, ChatServerMessage, ChatSnapshot } from '@swarmcast/shared/chat';
import { ChatSession, RESUME_WAIT_MS, type ChatEntry, type ChatView, type ClientFrame } from '../../src/chat/session.js';

function settings(over: Partial<ChatPublicSettings> = {}): ChatPublicSettings {
  return { enabled: true, content: ['text', 'emotes'], slowS: 2, autoSlow: false, maxGraphemes: 200, maxEmoji: 30, newViewerWaitS: 0, colors: 'choose', linksBlocked: false, emotes: [], builtinEmotes: true, protect: 'off', streamerName: '', ...over };
}
const you = { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null };
const ana = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' as const };
const bia = { a: 'k2', n: 'Bia', c: '#46a758', r: 'viewer' as const };
const msg = (s: number, x = `m${s}`, a = 'k1'): ChatItem => ({ k: 'm', s, at: 1000 + s, a, x });
const batch = (...items: ChatItem[]): ChatServerMessage => ({ t: 'chat.batch', items });
const SNAPSHOT: ChatSnapshot = { v: 1, settings: settings(), you, roster: [ana], items: [msg(1), msg(2)], lastSeq: 2 };

/**
 * A ChatView that records what the session asks of it: `shown` the seqs on screen (a reset
 * replaces them), `entries` every entry handed over, `calls` everything else as short strings.
 */
function recordingView() {
  const shown: number[] = [];
  const calls: string[] = [];
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
    highlight: (s, on) => calls.push(`hl ${s} ${on}`),
    pin: (p) => calls.push(p ? `pin ${p.s} ${p.author.n} ${p.text ?? 'gif'}` : 'pin null'),
    author: (a) => calls.push(`author ${a.a} ${a.c}`),
    settings: (s) => calls.push(`settings ${s ? s.enabled : 'null'}`),
    you: () => calls.push('you'),
    ack: (n, s) => calls.push(`ack ${n} ${s}`),
    reject: (n, code) => calls.push(`reject ${n} ${code}`),
    unsupported: () => calls.push('unsupported'),
    connection: (o) => calls.push(`conn ${o}`),
  };
  return { view, shown, calls, entries };
}

/** A connected session after its hello (`SNAPSHOT` with `snapshot`'s changes; null = chat off). `sent` has the frames it sent. */
function setup(snapshot: Partial<ChatSnapshot> | null = {}) {
  const { view, shown, calls, entries } = recordingView();
  const sent: ClientFrame[] = [];
  const session = new ChatSession(view, (m) => {
    sent.push(m);
    return true;
  });
  session.connection(true);
  session.hello(snapshot === null ? undefined : { ...SNAPSHOT, ...snapshot });
  return { session, shown, calls, sent, entries };
}

describe('ChatSession', () => {
  it('shows the snapshot of the hello', () => {
    // Act
    const { shown, calls } = setup();

    // Assert
    expect(shown).toEqual([1, 2]);
    expect(calls.filter((c) => c === 'reset')).toHaveLength(1);
  });

  it('a reconnect delta keeps what is shown and adds only the new items, settings and authors', () => {
    // Arrange
    const { session, shown, calls } = setup();

    // Act
    session.hello({ v: 1, settings: settings({ slowS: 5 }), you, roster: [bia], items: [msg(3, 'oi', 'k2'), msg(4)], lastSeq: 4, delta: true });

    // Assert
    expect(shown).toEqual([1, 2, 3, 4]);
    expect(calls.filter((c) => c === 'reset')).toHaveLength(1);
    expect(session.lastSeq).toBe(4);
    expect(session.settings?.slowS).toBe(5);
    expect(session.roster.get('k2')?.n).toBe('Bia');
    expect(session.roster.get('k1')?.n).toBe('Ana');
  });

  it('an empty delta (nothing new while away) changes nothing', () => {
    // Arrange
    const { session, shown } = setup({ items: [msg(1), msg(2), msg(3), msg(4)], lastSeq: 4 });

    // Act
    session.hello({ v: 1, settings: settings(), you, roster: [], items: [], lastSeq: 4, delta: true });

    // Assert
    expect(shown).toEqual([1, 2, 3, 4]);
    expect(session.lastSeq).toBe(4);
  });

  it('shows new items in seq order and ignores repeats (a reconnect resends some)', () => {
    // Arrange
    const { session, shown } = setup();

    // Act
    session.frame(batch(msg(2), msg(3), msg(4)));
    session.frame(batch(msg(4)));

    // Assert
    expect(shown).toEqual([1, 2, 3, 4]);
    expect(session.lastSeq).toBe(4);
  });

  it('resolves authors from the roster and reports colour changes', () => {
    // Arrange
    const { session, entries, calls } = setup();

    // Act
    session.frame(batch({ k: 'u', au: { ...ana, c: '#46a758' } }, msg(3)));

    // Assert
    const last = entries.at(-1);
    expect(last?.kind === 'msg' && last.author.c).toBe('#46a758');
    expect(calls).toContain('author k1 #46a758');
  });

  it('asks to resume on a gap and holds newer items until the missing ones come', () => {
    // Arrange
    const { session, shown, sent } = setup();

    // Act
    session.frame(batch(msg(5), msg(6)));

    // Assert
    expect(sent).toEqual([{ t: 'chat.resume', after: 2 }]);
    expect(shown).toEqual([1, 2]);
  });

  it('shows the held items once the missing ones come', () => {
    // Arrange
    const { session, shown } = setup();
    session.frame(batch(msg(5), msg(6)));

    // Act
    session.frame(batch(msg(3), msg(4)));

    // Assert
    expect(shown).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it(`accepts the gap when the resume answer does not come within ${RESUME_WAIT_MS} ms`, () => {
    // Arrange
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const { session, shown } = setup();
    session.frame(batch(msg(9)));

    // Act
    vi.advanceTimersByTime(RESUME_WAIT_MS);

    // Assert
    expect(shown).toEqual([1, 2, 9]);
    expect(session.lastSeq).toBe(9);
  });

  it('a skip item explains a gap: no resume', () => {
    // Arrange
    const { session, shown, sent, entries } = setup();

    // Act
    session.frame(batch({ k: 'skip', n: 3 }, msg(6)));

    // Assert
    expect(sent).toEqual([]);
    expect(shown).toEqual([1, 2, 6]);
    expect(entries.some((e) => e.kind === 'skip' && e.n === 3)).toBe(true);
  });

  it('a reset snapshot replaces everything and drops held items', () => {
    // Arrange
    const { session, shown, calls } = setup();
    session.frame(batch(msg(8)));

    // Act
    session.frame({ t: 'chat.reset', ...SNAPSHOT, items: [msg(10)], lastSeq: 10 });
    session.frame(batch(msg(11)));

    // Assert
    expect(shown).toEqual([10, 11]);
    expect(calls.filter((c) => c === 'reset')).toHaveLength(2);
  });

  it('deletes and clears are passed on and filter what is about to be shown', () => {
    // Arrange
    const { session, shown, calls } = setup();

    // Act
    session.frame(batch(msg(3), { k: 'd', s: [3] }, msg(4), { k: 'clr', s: 4 }, msg(5)));

    // Assert
    expect(shown).toEqual([1, 2, 5]);
    expect(calls).toContain('remove 3');
    expect(calls).toContain('clr 4');
  });

  it('passes acks, rejects and "you" on', () => {
    // Arrange
    const { session, calls } = setup();

    // Act
    session.frame({ t: 'chat.ack', n: 7, s: 3 });
    session.frame({ t: 'chat.reject', n: 8, code: 'chat.err.slow', retryMs: 900 });
    session.frame({ t: 'chat.you', you: { ...you, mutedUntil: 'live' } });

    // Assert
    expect(calls).toEqual(expect.arrayContaining(['ack 7 3', 'reject 8 chat.err.slow', 'you']));
    expect(session.you?.mutedUntil).toBe('live');
  });

  it('ignores frames and items of a kind it does not know (a newer server)', () => {
    // Arrange
    const { session, calls } = setup();
    const before = [...calls];

    // Act
    session.frame({ t: 'chat.future' } as unknown as ChatServerMessage);
    session.frame(batch({ k: 'zz' } as unknown as ChatItem, msg(3)));

    // Assert
    expect(calls).toEqual(before);
    expect(session.lastSeq).toBe(3);
  });

  it('items of new kinds are seq-less, even when they carry an `s`: never a gap, never a resume', () => {
    // Arrange
    const { session, shown, sent } = setup();
    const future = [{ k: 'pin', s: 9, at: 1, a: 'k1' }, { k: 'tally', c: [3, 1] }, { k: 'rx', c: [1, 0, 2] }] as unknown as ChatItem[];

    // Act
    session.frame(batch(future[0]!, msg(3), future[1]!, msg(4), future[2]!));

    // Assert
    expect(shown).toEqual([1, 2, 3, 4]);
    expect(sent).toEqual([]);
    expect(session.lastSeq).toBe(4);
  });

  it('a malformed item is skipped on its own; the items around it still show', () => {
    // Arrange
    const { session, shown, sent } = setup();
    const bad = [null, 7, { k: 'm', s: '3', a: 'k1', x: 'string seq' }, { k: 'u' }, { k: 'u', au: null }, { k: 'd', s: 'all' }, { k: 'm', s: 3.5, a: 'k1' }] as unknown as ChatItem[];

    // Act
    session.frame(batch(...bad.slice(0, 4), msg(3), ...bad.slice(4), msg(4)));

    // Assert
    expect(shown).toEqual([1, 2, 3, 4]);
    expect(sent).toEqual([]);
  });

  it('fuzz: any batch of known, unknown and malformed items never throws, and lastSeq never goes back', () => {
    // Arrange
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const item = fc.oneof(
      fc.integer({ min: 1, max: 40 }).map((s) => msg(s)),
      fc.record({ k: fc.constantFrom('sys', 'd', 'clr', 'skip', 'u', 'pin', 'tally', 'zz'), s: fc.oneof(fc.integer({ min: -2, max: 40 }), fc.jsonValue()), n: fc.jsonValue(), au: fc.jsonValue(), code: fc.string() }),
      fc.jsonValue(),
    ) as fc.Arbitrary<unknown> as fc.Arbitrary<ChatItem>;
    const property = fc.property(fc.array(fc.array(item, { maxLength: 12 }), { maxLength: 6 }), (batches) => {
      const { session } = setup();
      let last = session.lastSeq;
      for (const items of batches) {
        session.frame(batch(...items));
        if (session.lastSeq < last) return false;
        last = session.lastSeq;
      }
      return true;
    });
    // Act
    const run = () => fc.assert(property, { numRuns: 1000, seed: 3 });

    // Assert
    expect(run).not.toThrow();
  });

  it('a snapshot of another protocol version asks for a reload', () => {
    // Arrange
    const { session, calls } = setup();

    // Act
    session.frame({ t: 'chat.reset', v: 2, settings: settings(), you, roster: [], items: [], lastSeq: 0 });

    // Assert
    expect(calls).toContain('unsupported');
  });

  it('chat off at hello, on later: asks for a snapshot', () => {
    // Arrange
    const { session, sent } = setup(null);

    // Act
    session.frame({ t: 'chat.settings', settings: settings() });

    // Assert
    expect(sent).toEqual([{ t: 'chat.resume', after: 0 }]);
  });

  it('chat off at hello: the session is not active', () => {
    // Act
    const { session } = setup(null);

    // Assert
    expect(session.active).toBe(false);
  });

  it('does not send while disconnected', () => {
    // Arrange
    const { session } = setup();
    session.connection(false);

    // Act
    const ok = session.send({ t: 'chat.send', n: 1, text: 'oi' });

    // Assert
    expect(ok).toBe(false);
  });
});

describe('ChatSession: highlight and pin (seq-less state items)', () => {
  const pin = (s: number, x = `m${s}`, a = 'k1', at = 9000) => ({ s, a, x, at });

  it('a highlighted message in the snapshot comes highlighted; an hl item changes it on screen without touching the seq order', () => {
    // Arrange
    const { session, entries, calls, sent } = setup({ items: [msg(1), { k: 'm', s: 2, at: 1002, a: 'k1', x: 'm2', h: 1 }] });

    // Act
    session.frame(batch({ k: 'hl', s: 1, on: true }, { k: 'hl', s: 2, on: false }, msg(3)));

    // Assert
    expect(entries.find((e) => e.kind === 'msg' && e.s === 2)).toMatchObject({ highlighted: true });
    expect(calls).toContain('hl 1 true');
    expect(calls).toContain('hl 2 false');
    expect(session.lastSeq).toBe(3);
    expect(sent).toEqual([]);
  });

  it('an hl item for a message in the same batch marks the entry before it is shown', () => {
    // Arrange
    const { session, entries } = setup();

    // Act
    session.frame(batch(msg(3), { k: 'hl', s: 3, on: true }));

    // Assert
    expect(entries.find((e) => e.kind === 'msg' && e.s === 3)).toMatchObject({ highlighted: true });
  });

  it('an hl item that arrives while its message waits behind a gap still applies when the message is shown', () => {
    // Arrange
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const { session, entries, sent } = setup();

    // Act: 4 comes before 3 (a gap), then its highlight, then the missing 3.
    session.frame(batch(msg(4)));
    session.frame(batch({ k: 'hl', s: 4, on: true }));
    session.frame(batch(msg(3)));

    // Assert
    expect(sent).toEqual([{ t: 'chat.resume', after: 2 }]);
    expect(entries.find((e) => e.kind === 'msg' && e.s === 4)).toMatchObject({ highlighted: true });
  });

  it('a pin in the hello is shown with its author from the roster; an unpin item takes it down', () => {
    // Arrange
    const { session, calls } = setup({ pin: pin(2) });

    // Act
    session.frame(batch({ k: 'pin', p: null }));

    // Assert
    expect(calls).toEqual(expect.arrayContaining(['pin 2 Ana m2', 'pin null']));
    expect(calls.indexOf('pin 2 Ana m2')).toBeLessThan(calls.indexOf('pin null'));
    expect(session.pinned).toBeNull();
  });

  it('a pin item replaces the pin; the author entry sent before it gives the name', () => {
    // Arrange
    const { session, calls, sent } = setup({ pin: pin(1) });

    // Act
    session.frame(batch({ k: 'u', au: bia }, msg(3, 'olá', 'k2'), { k: 'pin', p: pin(3, 'olá', 'k2') }));

    // Assert
    expect(calls.at(-1)).toBe('pin 3 Bia olá');
    expect(session.lastSeq).toBe(3);
    expect(sent).toEqual([]);
  });

  it('deleting or clearing the pinned message takes the pin down even before the server says so', () => {
    // Arrange
    const deleted = setup({ pin: pin(2) });
    const cleared = setup({ pin: pin(2) });

    // Act
    deleted.session.frame(batch({ k: 'd', s: [2] }));
    cleared.session.frame(batch({ k: 'clr', s: 2 }));

    // Assert
    expect(deleted.calls.at(-1)).toBe('pin null');
    expect(cleared.calls.at(-1)).toBe('pin null');
  });

  it('deleting another message keeps the pin', () => {
    // Arrange
    const { session, calls } = setup({ pin: pin(2) });

    // Act
    session.frame(batch({ k: 'd', s: [1] }));

    // Assert
    expect(calls.filter((c) => c.startsWith('pin'))).toEqual(['pin 2 Ana m2']);
    expect(session.pinned?.s).toBe(2);
  });

  it('a reconnect delta carries the pin as it is now: absent means it was unpinned meanwhile', () => {
    // Arrange
    const { session, calls } = setup({ pin: pin(2) });

    // Act
    session.hello({ v: 1, settings: settings(), you, roster: [], items: [msg(3)], lastSeq: 3, delta: true });

    // Assert
    expect(calls.at(-1)).toBe('pin null');
  });

  it('a full reset forgets earlier highlights (the snapshot says what is highlighted now)', () => {
    // Arrange
    const { session, entries } = setup();
    session.frame(batch({ k: 'hl', s: 5, on: true }));

    // Act
    session.frame({ t: 'chat.reset', ...SNAPSHOT, items: [msg(5)], lastSeq: 5 });

    // Assert
    expect(entries.find((e) => e.kind === 'msg' && e.s === 5)).not.toHaveProperty('highlighted');
  });

  it.each([
    ['no seq', { a: 'k1', x: 'oi', at: 1 }],
    ['no author', { s: 1, x: 'oi', at: 1 }],
    ['text and GIF', { s: 1, a: 'k1', x: 'oi', at: 1, g: { p: 'klipy', id: 'x', w: 20, h: 20, m: '/x' } }],
    ['neither text nor GIF', { s: 1, a: 'k1', at: 1 }],
    ['a string', 'pinned'],
  ])('a malformed pin (%s) counts as no pin and never stops the batch', (_what, p) => {
    // Arrange
    const { session, calls, shown } = setup({ pin: pin(2) });

    // Act
    session.frame(batch({ k: 'pin', p } as unknown as ChatItem, msg(3)));

    // Assert
    expect(calls.at(-1)).toBe('pin null');
    expect(shown).toEqual([1, 2, 3]);
  });

  it('malformed hl items are skipped on their own', () => {
    // Arrange
    const { session, calls, shown } = setup();

    // Act
    session.frame(batch({ k: 'hl', s: 'x', on: true } as unknown as ChatItem, { k: 'hl', s: 1, on: 'yes' } as unknown as ChatItem, msg(3)));

    // Assert
    expect(calls.some((c) => c.startsWith('hl'))).toBe(false);
    expect(shown).toEqual([1, 2, 3]);
  });
});
