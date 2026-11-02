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
    poll: (p) => calls.push(p ? `poll ${p.id} ${p.st} ${p.c.join(',')}${p.mine !== undefined ? ` mine ${p.mine}` : ''}` : 'poll null'),
    tally: (id, c) => calls.push(`tally ${id} ${c.join(',')}`),
    voted: (n, id, o) => calls.push(`voted ${n} ${id} ${o}`),
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

describe('ChatSession: replies and mentions (docs/CHAT.md "Replies and mentions")', () => {
  const msgEntry = (entries: ChatEntry[], s: number) => entries.find((e): e is Extract<ChatEntry, { kind: 'msg' }> => e.kind === 'msg' && e.s === s);

  it('a reply entry carries the quoted author from the roster and the server quote; a GIF and a deleted message have no quote', () => {
    // Arrange
    const { session, entries } = setup();

    // Act
    session.frame(
      batch(
        { k: 'u', au: bia },
        { k: 'm', s: 3, at: 3, a: 'k2', x: 'concordo', re: { s: 1, a: 'k1', q: 'm1', cut: 1 } },
        { k: 'm', s: 4, at: 4, a: 'k2', x: 'kkk', re: { s: 2, a: 'k1', gif: 1 } },
        { k: 'm', s: 5, at: 5, a: 'k2', x: 'hã?', re: { s: 2, a: 'k1', gone: 1 } },
        { k: 'm', s: 6, at: 6, a: 'k2', x: 'quem?', re: { s: 2, a: 'k9' } },
      ),
    );

    // Assert
    expect(msgEntry(entries, 3)?.reply).toEqual({ s: 1, author: ana, quote: 'm1', cut: true });
    expect(msgEntry(entries, 4)?.reply).toEqual({ s: 2, author: ana, gif: true });
    expect(msgEntry(entries, 5)?.reply).toEqual({ s: 2, author: ana, gone: true });
    expect(msgEntry(entries, 6)?.reply).toEqual({ s: 2, author: { a: 'k9', n: '…', c: '', r: 'viewer' } });
  });

  it('a malformed reply or mention list is ignored on its own: the message still shows', () => {
    // Arrange
    const { session, entries, shown } = setup();
    const odd = [{ s: 'x', a: 'k1' }, { s: 1 }, { s: 1, a: 'k1', q: 5 }, null, 'k1'];

    // Act
    session.frame(batch(...odd.map((re, i) => ({ k: 'm', s: 3 + i, at: 3, a: 'k1', x: `r${i}`, re, mn: i % 2 ? 'k1' : [7, null, {}] }) as unknown as ChatItem)));

    // Assert
    expect(shown).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entries.slice(2).map((e) => (e.kind === 'msg' ? [e.reply, e.mentions] : null))).toEqual(odd.map(() => [undefined, undefined]));
  });

  it('a `d` for the quoted message wipes the quote of a reply in the same batch, and of one that arrives after it', () => {
    // Arrange
    const { session, entries, calls } = setup();

    // Act
    session.frame(batch({ k: 'm', s: 3, at: 3, a: 'k1', x: 'sim', re: { s: 1, a: 'k1', q: 'm1' } }, { k: 'd', s: [1] }));
    session.frame(batch({ k: 'm', s: 4, at: 4, a: 'k1', x: 'atrasada', re: { s: 1, a: 'k1', q: 'm1' } }));

    // Assert
    expect(msgEntry(entries, 3)?.reply).toEqual({ s: 1, author: ana, gone: true });
    expect(msgEntry(entries, 4)?.reply).toEqual({ s: 1, author: ana, gone: true });
    expect(calls).toContain('remove 1');
  });

  it('mentions: the people the page knows, at most three; "mentions me" when this viewer is one of them; never for a GIF', () => {
    // Arrange
    const { session, entries } = setup({ roster: [ana, bia, { a: 'me', n: 'Eu', c: '#0090ff', r: 'viewer' }] });

    // Act
    session.frame(
      batch(
        { k: 'm', s: 3, at: 3, a: 'k1', x: '@Bia @Eu', mn: ['k2', 'me', 'zz'] },
        { k: 'm', s: 4, at: 4, a: 'k1', x: '@Bia', mn: ['k2'] },
        { k: 'm', s: 5, at: 5, a: 'k1', g: { p: 'klipy', id: 'x', w: 20, h: 20, m: '/ii/a' }, mn: ['me'] } as ChatItem,
      ),
    );

    // Assert
    expect(msgEntry(entries, 3)?.mentions?.map((a) => a.n)).toEqual(['Bia', 'Eu']);
    expect(msgEntry(entries, 3)?.mentionsMe).toBe(true);
    expect(msgEntry(entries, 4)?.mentionsMe).toBeUndefined();
    expect(msgEntry(entries, 5)?.mentions).toBeUndefined();
  });

  it('replies and mentions never take part in the seq order: no resume', () => {
    // Arrange
    const { session, sent, shown } = setup();

    // Act
    session.frame(batch({ k: 'm', s: 3, at: 3, a: 'k1', x: 'oi', re: { s: 99, a: 'k1', q: 'x' }, mn: ['k1'] }));

    // Assert
    expect(shown).toEqual([1, 2, 3]);
    expect(sent).toEqual([]);
  });
});

describe('ChatSession: polls and predictions', () => {
  const POLL = { id: 'p1', kind: 'poll' as const, q: 'Pizza?', o: ['Sim', 'Não'], st: 'open' as const, c: [0, 0], endsIn: 60_000 };

  it('the poll comes with the hello (with this device\'s vote), as a state item, and goes with p: null; never as a seq', () => {
    // Arrange
    const { session, calls, sent } = setup({ poll: { ...POLL, c: [2, 1], mine: 0 } });
    // Act
    session.frame(batch({ k: 'poll', p: { ...POLL, st: 'closed', c: [3, 1] } }, msg(3)));
    session.frame(batch({ k: 'poll', p: null }));
    // Assert
    expect(calls.filter((c) => c.startsWith('poll'))).toEqual(['poll p1 open 2,1 mine 0', 'poll p1 closed 3,1 mine 0', 'poll null']);
    expect(session.lastSeq).toBe(3);
    expect(sent).toEqual([]);
  });

  it('counts (`pt`) update the poll on screen; counts for another poll, or of the wrong shape, are ignored', () => {
    // Arrange
    const { session, calls } = setup({ poll: POLL });
    // Act
    session.frame(batch({ k: 'pt', id: 'p1', c: [4, 2] }, { k: 'pt', id: 'p9', c: [9, 9] }, { k: 'pt', id: 'p1', c: [1] }, { k: 'pt', id: 'p1', c: [1, -1] }, { k: 'pt', id: 'p1', c: [1.5, 0] }));
    // Assert
    expect(calls.filter((c) => c.startsWith('tally'))).toEqual(['tally p1 4,2']);
    expect(session.poll?.c).toEqual([4, 2]);
  });

  it('chat.voted marks this device\'s vote (also from another tab), with the counts; it is kept when the poll changes later', () => {
    // Arrange
    const { session, calls } = setup({ poll: POLL });
    // Act
    session.frame({ t: 'chat.voted', id: 'p1', o: 1, c: [0, 1] });
    session.frame({ t: 'chat.voted', n: 5, id: 'p9', o: 0, c: [1, 0] });
    session.frame(batch({ k: 'poll', p: { ...POLL, st: 'closed', c: [2, 1] } }));
    // Assert
    expect(calls.filter((c) => c.startsWith('poll') || c.startsWith('voted'))).toEqual(['poll p1 open 0,0', 'poll p1 open 0,1 mine 1', 'voted undefined p1 1', 'poll p1 closed 2,1 mine 1']);
  });

  it('a new poll forgets the vote of the last one; a reconnect delta brings the poll too', () => {
    // Arrange
    const { session, calls } = setup({ poll: { ...POLL, mine: 1 } });
    // Act
    session.frame(batch({ k: 'poll', p: { ...POLL, id: 'p2' } }));
    session.hello({ v: 1, settings: settings(), you, roster: [], items: [], lastSeq: 2, delta: true, poll: { ...POLL, id: 'p2', c: [1, 0], mine: 0 } });
    session.hello({ v: 1, settings: settings(), you, roster: [], items: [], lastSeq: 2, delta: true });
    // Assert
    expect(calls.filter((c) => c.startsWith('poll'))).toEqual(['poll p1 open 0,0 mine 1', 'poll p2 open 0,0', 'poll p2 open 1,0 mine 0', 'poll null']);
  });

  it.each([
    [{ ...POLL, o: ['só uma'], c: [0] }],
    [{ ...POLL, o: ['a', 'b', 'c', 'd', 'e', 'f'], c: [0, 0, 0, 0, 0, 0] }],
    [{ ...POLL, st: 'weird' }],
    [{ ...POLL, kind: 'quiz' }],
    [{ ...POLL, c: [0] }],
    [{ ...POLL, q: 7 }],
    [{ ...POLL, id: 1 }],
    ['nope'],
  ])('a malformed poll %j counts as none, and the items after it still come', (bad) => {
    // Arrange
    const { session, calls, shown } = setup({ poll: POLL });
    // Act
    session.frame(batch({ k: 'poll', p: bad } as unknown as ChatItem, msg(3)));
    // Assert
    expect(calls.at(-1)).toBe('poll null');
    expect(shown).toEqual([1, 2, 3]);
    expect(session.poll).toBeNull();
  });

  it('poll items behind a gap wait with the rest for the resume answer, and never ask for a resume of their own', () => {
    // Arrange
    const { session, calls, sent, shown } = setup();
    // Act
    session.frame(batch({ k: 'poll', p: POLL }, { k: 'pt', id: 'p1', c: [1, 0] }));
    const alone = [...sent];
    session.frame(batch(msg(4), { k: 'pt', id: 'p1', c: [2, 0] }));
    const held = calls.filter((c) => c.startsWith('tally')).length;
    session.frame(batch(msg(3)));
    // Assert
    expect(alone).toEqual([]);
    expect(sent).toEqual([{ t: 'chat.resume', after: 2 }]);
    expect(held).toBe(1);
    expect(calls.filter((c) => c.startsWith('poll') || c.startsWith('tally'))).toEqual(['poll p1 open 0,0', 'tally p1 1,0', 'tally p1 2,0']);
    expect(shown).toEqual([1, 2, 3, 4]);
  });
});
