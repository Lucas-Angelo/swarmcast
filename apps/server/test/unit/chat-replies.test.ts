import { describe, expect, it } from 'vitest';
import {
  CHAT_MENTION_SAME_TARGET_S,
  CHAT_MENTIONS_PER_MIN,
  CHAT_MENTIONS_TO_TARGET_PER_MIN,
  CHAT_REPLY_QUOTE_MAX_GRAPHEMES,
  chatAdminSendSchema,
  defaultChatSettings,
  type ChatItem,
  type ChatMessageItem,
  type ChatServerMessage,
  type ChatSettings,
} from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ChatHub, type ChatHost } from '../../src/chat/hub.js';
import { ActivityLog } from '../../src/core/activity.js';
import { manualClock, silentLog } from './helpers.js';
import { joinViewer } from './helpers-b.js';

// Replies and @mentions in the hub (docs/CHAT.md, "Replies and mentions"), on a manual clock with
// fake viewer sockets. Neither can make a message fail: a reply whose message is gone is a plain
// message, and a mention that does not hold (or is over a limit) is plain text.

class FakeSocket {
  bufferedAmount = 0;
  readyState = 1;
  sent: string[] = [];
  constructor(readonly sessionId: string) {}
  send(d: string): void {
    this.sent.push(d);
  }
  messages(): ChatServerMessage[] {
    return this.sent.map((d) => JSON.parse(d) as ChatServerMessage);
  }
  items(): ChatItem[] {
    return this.messages().flatMap((m) => (m.t === 'chat.batch' ? m.items : []));
  }
  clear(): void {
    this.sent = [];
  }
}

type Viewer = { s: Session; sock: FakeSocket };

function setup(over: Partial<ChatSettings> = {}) {
  const clock = manualClock(1_000_000_000_000);
  const access = new AccessControl(clock.now);
  access.begin();
  const settings: ChatSettings = { ...defaultChatSettings(), slowModeS: 0, duplicateWindowS: 0, ...over };
  const sockets: FakeSocket[] = [];
  const host: ChatHost = { sockets: () => sockets, socketsOf: (id) => sockets.filter((s) => s.sessionId === id) };
  const hub = new ChatHub({
    access,
    host,
    settings: () => settings,
    uploadCapMbps: () => 10,
    viewers: () => 3,
    activity: new ActivityLog(),
    log: silentLog,
    now: clock.now,
    guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  // Compiles the blocked words (the live does it when the chat's settings are applied).
  hub.refresh();
  const join = (nickname: string, deviceId = nickname, ip = '198.51.100.20'): Viewer => {
    const s = joinViewer(access, nickname, { deviceId, ip });
    s.joinedAt = clock.now() - 10 * 60_000;
    const sock = new FakeSocket(s.id);
    sockets.push(sock);
    return { s, sock };
  };
  let n = 0;
  /**
   * `who` sends `text` with an optional reply and mentions, `wait` ms after the last send (2.1 s by
   * default: past the burst bucket); returns the frame's nonce.
   */
  const send = (who: Viewer, text: string, extra: { re?: number; mn?: string[] } = {}, wait = 2100): number => {
    clock.advance(wait);
    const nonce = ++n;
    hub.frame(who.s, who.sock, JSON.stringify({ t: 'chat.send', n: nonce, text, ...extra }));
    return nonce;
  };
  /** The ring item of the message `who` sent last. */
  const lastOf = (who: Viewer): ChatMessageItem => {
    const key = hub.you(who.s).a;
    const m = [...hub.adminState().items].reverse().find((i): i is ChatMessageItem => i.k === 'm' && i.a === key);
    if (!m) throw new Error('no message');
    return m;
  };
  const key = (who: Viewer): string => hub.you(who.s).a;
  return { hub, access, settings, join, send, lastOf, key, advance: clock.advance, now: clock.now };
}

const acks = (sock: FakeSocket) => sock.messages().filter((m) => m.t === 'chat.ack');
const rejects = (sock: FakeSocket) => sock.messages().filter((m) => m.t === 'chat.reject');

describe('ChatHub: replies', () => {
  it('a reply carries the seq, the author and a quote cut by the server from the message it answers', () => {
    // Arrange
    const { hub, join, send, lastOf, key } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'qual o link da loja?');
    const parent = lastOf(ana);
    // Act
    send(bia, 'está na descrição', { re: parent.s });
    hub.flush();
    // Assert
    expect(lastOf(bia)).toMatchObject({ x: 'está na descrição', re: { s: parent.s, a: key(ana), q: 'qual o link da loja?' } });
    expect(lastOf(bia).re).not.toHaveProperty('cut');
    expect(acks(bia.sock)).toHaveLength(1);
  });

  it(`a long message is quoted by its first ${CHAT_REPLY_QUOTE_MAX_GRAPHEMES} graphemes (marked as cut); a GIF is quoted as a GIF`, () => {
    // Arrange
    const { hub, join, send, lastOf, settings } = setup();
    settings.gif = { ...settings.gif, key: 'k'.repeat(20) };
    settings.content = { text: true, emotes: true, gifs: true };
    hub.refresh();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, '👩‍👩‍👧‍👦 '.repeat(30));
    const long = lastOf(ana);
    hub.frame(ana.s, ana.sock, JSON.stringify({ t: 'chat.send', n: 99, gif: { p: 'klipy', id: 'abc', w: 200, h: 150, m: '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp' } }));
    const gif = lastOf(ana);
    // Act
    send(bia, 'kkk', { re: long.s });
    const toLong = lastOf(bia).re;
    send(bia, 'haha', { re: gif.s });
    const toGif = lastOf(bia).re;
    // Assert
    expect(toLong?.cut).toBe(1);
    expect(toLong?.q).toBe(Array(6).fill('👩‍👩‍👧‍👦').join(' '));
    expect(toGif).toEqual({ s: gif.s, a: gif.a, gif: 1 });
  });

  it('a reply to a message that is gone (never was, a system line, deleted, cleared away) goes out as a plain message, without a reject', () => {
    // Arrange
    const { hub, join, send, lastOf } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'primeira');
    const deleted = lastOf(ana).s;
    hub.delete([deleted]);
    hub.mute(ana.s.id, 1);
    hub.unmute(ana.s.id);
    send(ana, 'antes da limpeza');
    const cleared = lastOf(ana).s;
    hub.clear();
    const sys = hub.lastSeq;
    // Act
    const replies = [deleted, cleared, sys, 4711].map((re) => {
      send(bia, `resposta a ${re}`, { re });
      return lastOf(bia);
    });
    // Assert
    expect(replies.map((m) => m.re)).toEqual([undefined, undefined, undefined, undefined]);
    expect(replies.map((m) => m.x)).toEqual([`resposta a ${deleted}`, `resposta a ${cleared}`, `resposta a ${sys}`, 'resposta a 4711']);
    expect(rejects(bia.sock)).toEqual([]);
  });

  it('deleting the message wipes its quote from every reply in the ring ("gone"), with the bytes counted again; the replies stay', () => {
    // Arrange
    const { hub, join, send, lastOf, key } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'algo que vai ser apagado');
    const parent = lastOf(ana).s;
    send(bia, 'concordo', { re: parent });
    send(bia, 'eu também', { re: parent });
    const bytesBefore = hub.ringSize.bytes;
    // Act
    hub.delete([parent]);
    hub.flush();
    // Assert
    const replies = hub.adminState().items.filter((i): i is ChatMessageItem => i.k === 'm' && i.re !== undefined);
    expect(replies.map((m) => m.re)).toEqual([
      { s: parent, a: key(ana), gone: 1 },
      { s: parent, a: key(ana), gone: 1 },
    ]);
    expect(JSON.stringify(hub.snapshot(join('Caio').s))).not.toContain('apagado');
    expect(hub.ringSize.bytes).toBe(hub.adminState().items.reduce((n, i) => n + JSON.stringify(i).length, 0));
    expect(hub.ringSize.bytes).toBeLessThan(bytesBefore);
    expect(bia.sock.items()).toContainEqual({ k: 'd', s: [parent] });
  });

  it('a reply is a message like any other: blocked words, the content mode, mute and slow mode apply to its own text', () => {
    // Arrange
    const { hub, join, send, lastOf, settings } = setup({ blockedWords: ['palavrão'] });
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'oi');
    const parent = lastOf(ana).s;
    // Act
    send(bia, 'que palavrão', { re: parent });
    const blocked = rejects(bia.sock).at(-1);
    settings.content = { text: false, emotes: true, gifs: false };
    hub.refresh();
    send(bia, 'texto', { re: parent });
    const mode = rejects(bia.sock).at(-1);
    settings.content = { text: true, emotes: true, gifs: false };
    settings.slowModeS = 30;
    hub.refresh();
    send(bia, 'um', { re: parent });
    send(bia, 'dois', { re: parent });
    const slow = rejects(bia.sock).at(-1);
    hub.mute(bia.s.id, 5);
    send(bia, 'mudo', { re: parent });
    const muted = rejects(bia.sock).at(-1);
    // Assert
    expect(blocked).toMatchObject({ code: 'chat.err.blocked' });
    expect(mode).toMatchObject({ code: 'chat.err.mode' });
    expect(slow).toMatchObject({ code: 'chat.err.slow' });
    expect(muted).toMatchObject({ code: 'chat.err.muted' });
    expect(hub.adminState().items.filter((i) => i.k === 'm').map((i) => (i.k === 'm' ? i.x : ''))).toEqual(['oi', 'um']);
  });

  it('a quote that holds a blocked word (the list changed since, or a streamer message) is left out: the reply still says whom it answers', () => {
    // Arrange
    const { hub, join, send, lastOf, settings } = setup();
    const ana = join('Ana');
    hub.sendAsStreamer({ text: 'nada de palavrão aqui' });
    const fromStreamer = hub.lastSeq;
    send(ana, 'outra coisa feia');
    const fromAna = lastOf(ana).s;
    settings.blockedWords = ['palavrão', 'feia'];
    hub.refresh();
    const bia = join('Bia');
    // Act
    send(bia, 'ok', { re: fromStreamer });
    const toStreamer = lastOf(bia).re;
    send(bia, 'ok 2', { re: fromAna });
    const toAna = lastOf(bia).re;
    // Assert
    expect(toStreamer).toEqual({ s: fromStreamer, a: expect.any(String) });
    expect(toAna).toEqual({ s: fromAna, a: lastOf(ana).a });
  });

  it('the quoted author reaches a socket that joined after them, before the reply; snapshots and the panel include them', () => {
    // Arrange
    const { hub, join, send, lastOf, key, access } = setup();
    const ana = join('Ana');
    send(ana, 'oi gente');
    const parent = lastOf(ana).s;
    const anaKey = key(ana);
    hub.flush();
    const late = join('Caio');
    const snap = hub.snapshot(late.s, {})!;
    hub.helloSent(late.sock, { ...snap, roster: snap.roster.filter((r) => r.a !== anaKey) }, 0);
    const bia = join('Bia');
    // Act
    send(bia, 'oi Ana', { re: parent });
    hub.flush();
    access.kick(ana.s.id);
    for (let i = 0; i < 60; i++) hub['tick']();
    // Assert
    const items = late.sock.items();
    const roster = items.findIndex((i) => i.k === 'u' && i.au.a === anaKey);
    const reply = items.findIndex((i) => i.k === 'm' && i.re?.s === parent);
    expect(roster).toBeGreaterThanOrEqual(0);
    expect(roster).toBeLessThan(reply);
    expect(hub.adminState().roster.map((r) => r.n)).toContain('Ana');
  });

  it('highlighting a reply keeps its quote and mentions', () => {
    // Arrange
    const { hub, join, send, lastOf, key } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'pergunta');
    send(bia, '@Ana resposta', { re: lastOf(ana).s, mn: [key(ana)] });
    const reply = lastOf(bia);
    // Act
    hub.highlight(reply.s, true);
    // Assert
    expect(lastOf(bia)).toMatchObject({ h: 1, re: reply.re, mn: [key(ana)] });
  });

  it('the streamer can reply from the panel (the same quote) and mention people', () => {
    // Arrange
    const { hub, join, send, lastOf, key } = setup();
    const ana = join('Ana');
    send(ana, 'você vai jogar hoje?');
    const parent = lastOf(ana).s;
    // Act
    const r = hub.sendAsStreamer(chatAdminSendSchema.parse({ text: '@Ana vou sim', re: parent, mn: [key(ana)] }));
    // Assert
    expect(r.ok).toBe(true);
    const m = hub.adminState().items.at(-1);
    expect(m).toMatchObject({ k: 'm', x: '@Ana vou sim', re: { s: parent, a: key(ana), q: 'você vai jogar hoje?' }, mn: [key(ana)] });
  });
});

describe('ChatHub: mentions', () => {
  it('a mention of someone who wrote and is watching, named in the text, goes out as their author key', () => {
    // Arrange
    const { hub, join, send, lastOf, key } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'oi');
    // Act
    send(bia, 'oi @Ana, tudo bem?', { mn: [key(ana)] });
    hub.flush();
    // Assert
    expect(lastOf(bia).mn).toEqual([key(ana)]);
    expect(ana.sock.items()).toContainEqual(expect.objectContaining({ k: 'm', mn: [key(ana)] }));
  });

  it('dropped, the message still going as plain text: the sender, a key not named in the text, a look-alike name, someone who never wrote, someone who left, a key that never was', () => {
    // Arrange
    const { join, send, lastOf, key, access } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    const lurker = join('Lia');
    const gone = join('Caio');
    send(ana, 'oi');
    send(gone, 'tchau');
    access.kick(gone.s.id);
    // Act
    const cases: Array<[string, string[]]> = [
      ['@Bia sou eu', [key(bia)]],
      ['oi pessoal', [key(ana)]],
      ['@\u{410}na oi', [key(ana)]],
      ['@Anabela oi', [key(ana)]],
      ['@Lia oi', [key(lurker)]],
      ['@Caio volta', [key(gone)]],
      ['@Ana oi', ['zz']],
    ];
    const out = cases.map(([text, mn]) => {
      send(bia, text, { mn });
      return lastOf(bia);
    });
    // Assert
    expect(out.map((m) => m.mn)).toEqual(cases.map(() => undefined));
    expect(out.map((m) => m.x)).toEqual(cases.map(([t]) => t));
    expect(rejects(bia.sock)).toEqual([]);
  });

  it('the streamer is mentioned by their name, or by the translated default in either language while they have none', () => {
    // Arrange
    const { hub, join, send, lastOf, settings } = setup();
    const bia = join('Bia');
    hub.sendAsStreamer({ text: 'boa noite' });
    const streamer = hub.adminState().roster.find((r) => r.r === 'streamer')!.a;
    // Act
    // (Past the "same person again" wait between two mentions of the streamer.)
    const later = CHAT_MENTION_SAME_TARGET_S * 1000;
    send(bia, '@Streamer oi', { mn: [streamer] });
    const en = lastOf(bia).mn;
    send(bia, '@Transmissão oi', { mn: [streamer] }, later);
    const pt = lastOf(bia).mn;
    settings.streamerName = 'Lucas';
    hub.sendAsStreamer({ text: 'mudei de nome' });
    send(bia, '@Streamer oi de novo', { mn: [streamer] }, later);
    const oldDefault = lastOf(bia).mn;
    send(bia, '@Lucas oi', { mn: [streamer] });
    const named = lastOf(bia).mn;
    // Assert
    expect(en).toEqual([streamer]);
    expect(pt).toEqual([streamer]);
    expect(oldDefault).toBeUndefined();
    expect(named).toEqual([streamer]);
  });

  it(`limits: ${CHAT_MENTIONS_PER_MIN} mentions a minute from one device, the same person once per ${CHAT_MENTION_SAME_TARGET_S} s; past them, plain text`, () => {
    // Arrange: people who wrote; the bucket refills at ${CHAT_MENTIONS_PER_MIN} a minute (one every 10 s).
    const { join, send, lastOf, key } = setup();
    const people = Array.from({ length: CHAT_MENTIONS_PER_MIN + 2 }, (_, i) => join(`Pessoa${i}`));
    for (const p of people) send(p, 'oi');
    const bia = join('Bia');
    const mention = (i: number, wait: number): string[] | undefined => {
      send(bia, `@Pessoa${i} oi`, { mn: [key(people[i]!)] }, wait);
      return lastOf(bia).mn;
    };
    // Act: five at once (the message burst allows five), then one 2.1 s later, then one more.
    const burst = [0, 1, 2, 3, 4].map((i) => mention(i, 0));
    const sixth = mention(5, 2100);
    const seventh = mention(6, 2100);
    const sameAgain = mention(0, 2100);
    // A minute on: the bucket is full again, and Pessoa0 was mentioned long enough ago.
    const afterAMinute = mention(0, 60_000);
    const sameSoon = mention(0, 2100);
    // Assert
    expect(burst).toEqual([0, 1, 2, 3, 4].map((i) => [key(people[i]!)]));
    expect(sixth).toEqual([key(people[5]!)]);
    expect(seventh).toBeUndefined();
    expect(sameAgain).toBeUndefined();
    expect(afterAMinute).toEqual([key(people[0]!)]);
    expect(sameSoon).toBeUndefined();
    expect(lastOf(bia).x).toBe('@Pessoa0 oi');
  });

  it(`limits: one person gets at most ${CHAT_MENTIONS_TO_TARGET_PER_MIN} mentions a minute from everyone together`, () => {
    // Arrange
    const { join, send, lastOf, key } = setup();
    const ana = join('Ana');
    send(ana, 'oi');
    // Each from a device and address of their own, all within the same moment.
    const senders = Array.from({ length: CHAT_MENTIONS_TO_TARGET_PER_MIN + 3 }, (_, i) => join(`Fã${i}`, `fan-${i}`, `198.51.100.${30 + i}`));
    // Act
    const out = senders.map((s) => {
      send(s, '@Ana oi', { mn: [key(ana)] }, 0);
      return lastOf(s).mn;
    });
    // Assert
    expect(out.filter((m) => m !== undefined)).toHaveLength(CHAT_MENTIONS_TO_TARGET_PER_MIN);
    expect(out.slice(CHAT_MENTIONS_TO_TARGET_PER_MIN)).toEqual([undefined, undefined, undefined]);
  });

  it('the streamer is not limited, and a muted person can still be mentioned; Stop wipes the mention limits', () => {
    // Arrange
    const { hub, join, send, lastOf, key, advance } = setup();
    const ana = join('Ana');
    send(ana, 'oi');
    hub.mute(ana.s.id, null);
    // Act: more mentions of Ana than anyone may get in a minute, one a second (the panel's own limit).
    const fromStreamer = Array.from({ length: CHAT_MENTIONS_TO_TARGET_PER_MIN + 2 }, (_, i) => {
      advance(1000);
      const r = hub.sendAsStreamer({ text: `@Ana oi ${i}`, mn: [key(ana)] });
      const m = hub.adminState().items.at(-1);
      return r.ok && m?.k === 'm' ? m.mn : 'refused';
    });
    const bia = join('Bia');
    send(bia, '@Ana oi', { mn: [key(ana)] });
    const fromViewer = lastOf(bia).mn;
    // Assert
    expect(fromStreamer).toEqual(fromStreamer.map(() => [key(ana)]));
    expect(fromViewer).toEqual([key(ana)]);
    expect(hub['mentionsTo'].size).toBeGreaterThan(0);
    hub.reset();
    expect([hub['mentionsBy'].size, hub['mentionsTo'].size, hub['mentionedAt'].size]).toEqual([0, 0, 0]);
  });

  it('a GIF mentions nobody; repeated keys count once', () => {
    // Arrange
    const { join, send, lastOf, key } = setup();
    const ana = join('Ana');
    const bia = join('Bia');
    send(ana, 'oi');
    // Act
    send(bia, '@Ana @Ana', { mn: [key(ana), key(ana)] });
    // Assert
    expect(lastOf(bia).mn).toEqual([key(ana)]);
  });
});
