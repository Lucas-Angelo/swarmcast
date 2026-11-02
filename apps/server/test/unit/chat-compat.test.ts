import { describe, expect, it, onTestFinished } from 'vitest';
import { defaultChatSettings, type ChatAuthor, type ChatServerMessage, type ChatSettings, type ChatSnapshot } from '@swarmcast/shared';
import { AccessControl } from '../../src/access/access.js';
import { ChatBatcher, type ChatSocket } from '../../src/chat/batcher.js';
import { ChatHub, type ChatHost } from '../../src/chat/hub.js';
import { ActivityLog } from '../../src/core/activity.js';
import { ChatSession } from '../../../viewer/src/chat/session.js';
import { ChatSession as ChatSession042 } from '../fixtures/chat-0.4.2/session.js';
import { manualClock, silentLog } from './helpers.js';
import { joinViewer } from './helpers-b.js';

// Protocol v1 stays backward compatible (docs/CHAT.md, "Compatibility"): a viewer page that was
// already open when a newer server answers (here the chat session v0.4.2 shipped, frozen in
// test/fixtures/chat-0.4.2) and a current page, fed the very frames this server sends, show the same
// messages in the same order, and neither ever asks to resume or for a reload. The frames include
// what 0.5.0 builds on: ephemeral latest-wins items (also missed by a slow socket), roster entries
// for authors an item only refers to, and reaction frames the server ignores for now; and what
// 0.5.0 sends: highlights and the pin (seq-less state items, a snapshot field), and replies and
// mentions (optional fields of a message), which a v0.4.2 page simply does not show: it shows a
// reply as the plain message it also is.

interface Page {
  session: { hello(s: Parameters<ChatSession['hello']>[0]): void; frame(m: ChatServerMessage): void; connection(o: boolean): void; readonly lastSeq: number; readonly roster: Map<string, ChatAuthor> };
  /** Seqs on screen, in order (a reset replaces them, a delete or clear removes them). */
  shown: number[];
  /** Frames the page sent (a resume would show up here). */
  sent: Array<{ t: string }>;
  /** Anything unusual the session asked of its view (reload). */
  alarms: string[];
  /** What the page shows pinned (seq, author name, text), and the seqs it shows highlighted (current pages only). */
  pin: { s: number; n: string; x?: string } | null;
  lit: Set<number>;
  /** The text of each message shown, and (current pages) what each reply shows of the message it answers and who it mentions. */
  text: Map<number, string | undefined>;
  replies: Map<number, { n: string; q?: string; gone?: boolean }>;
  mentions: Map<number, string[]>;
}

/** A page running `Session` (the current one or v0.4.2's) with a view that records what it shows. */
function page(Session: typeof ChatSession | typeof ChatSession042): Page {
  const shown: number[] = [];
  const sent: Array<{ t: string }> = [];
  const alarms: string[] = [];
  const lit = new Set<number>();
  const text: Page['text'] = new Map();
  const replies: Page['replies'] = new Map();
  const mentions: Page['mentions'] = new Map();
  const out = { pin: null as Page['pin'] };
  type Shown = { kind: string; s?: number; highlighted?: boolean; text?: string; reply?: { author: { n: string }; quote?: string; gone?: boolean }; mentions?: Array<{ n: string }> };
  const mark = (e: Shown[]) => {
    for (const x of e) {
      if (x.kind !== 'msg') continue;
      if (x.highlighted) lit.add(x.s!);
      text.set(x.s!, x.text);
      if (x.reply) replies.set(x.s!, { n: x.reply.author.n, ...(x.reply.quote !== undefined ? { q: x.reply.quote } : {}), ...(x.reply.gone ? { gone: true } : {}) });
      if (x.mentions?.length) mentions.set(x.s!, x.mentions.map((m) => m.n));
    }
  };
  const drop = (keep: (s: number) => boolean): void => {
    const rest = shown.filter(keep);
    shown.length = 0;
    shown.push(...rest);
  };
  const view = {
    reset: (e: Shown[]) => {
      shown.length = 0;
      lit.clear();
      replies.clear();
      mentions.clear();
      for (const x of e) if (x.kind !== 'skip') shown.push(x.s!);
      mark(e);
    },
    append: (e: Shown[]) => {
      for (const x of e) if (x.kind !== 'skip') shown.push(x.s!);
      mark(e);
    },
    highlight: (s: number, on: boolean) => void (on ? lit.add(s) : lit.delete(s)),
    pin: (p: { s: number; author: { n: string }; text?: string } | null) => void (out.pin = p ? { s: p.s, n: p.author.n, ...(p.text !== undefined ? { x: p.text } : {}) } : null),
    remove: (seqs: readonly number[]) => drop((s) => !seqs.includes(s)),
    clearUpTo: (upTo: number) => drop((s) => s > upTo),
    author: () => {},
    settings: () => {},
    you: () => {},
    ack: () => {},
    reject: () => {},
    unsupported: () => alarms.push('unsupported'),
    connection: () => {},
  };
  const session = new Session(view, (m) => {
    sent.push(m);
    return true;
  });
  session.connection(true);
  return {
    session,
    shown,
    sent,
    alarms,
    lit,
    text,
    replies,
    mentions,
    get pin() {
      return out.pin;
    },
  };
}

/** A fake viewer socket whose frames go straight into the pages listening on it. */
class PipeSocket implements ChatSocket {
  bufferedAmount = 0;
  readyState = 1;
  readonly pages: Page[] = [];
  constructor(readonly sessionId = '') {}
  send(d: string): void {
    for (const p of this.pages) p.session.frame(JSON.parse(d) as ChatServerMessage);
  }
}

describe('chat protocol v1: a v0.4.2 page and a current page on this server', () => {
  it('a live chat (messages, streamer posts, a delete, a mute line, a clear, reaction frames) shows the same on both, without a resume', () => {
    // Arrange
    const clock = manualClock(1_000_000_000_000);
    const access = new AccessControl(clock.now);
    access.begin();
    const settings: ChatSettings = { ...defaultChatSettings(), slowModeS: 0, duplicateWindowS: 0, announceMutes: true };
    const sockets: PipeSocket[] = [];
    const host: ChatHost = { sockets: () => sockets, socketsOf: (id) => sockets.filter((s) => s.sessionId === id) };
    const hub = new ChatHub({ access, host, settings: () => settings, uploadCapMbps: () => 10, viewers: () => 3, activity: new ActivityLog(), log: silentLog, now: clock.now, guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 } });
    hub.begin();
    onTestFinished(() => hub.reset());
    const join = (name: string) => {
      const s = joinViewer(access, name, { deviceId: name });
      s.joinedAt = clock.now() - 600_000;
      const sock = new PipeSocket(s.id);
      sockets.push(sock);
      return { s, sock };
    };
    const ana = join('Ana');
    const viewer = join('Bia');
    const old = page(ChatSession042);
    const current = page(ChatSession);
    viewer.sock.pages.push(old, current);
    const snap = hub.snapshot(viewer.s)!;
    old.session.hello(snap);
    current.session.hello(snap);
    hub.helloSent(viewer.sock, snap, 0);
    const say = (text: string, n: number) => {
      clock.advance(2100);
      hub.frame(ana.s, ana.sock, JSON.stringify({ t: 'chat.send', n, text }));
    };
    // Act
    say('boa noite', 1);
    say('tudo bem?', 2);
    hub.frame(viewer.s, viewer.sock, '{"t":"chat.react","c":[1,0,2]}');
    hub.sendAsStreamer({ text: 'bem-vindos!' });
    hub.flush();
    hub.delete([2]);
    hub.mute(ana.s.id, 10);
    hub.flush();
    clock.advance(60 * 60_000);
    hub.unmute(ana.s.id);
    say('voltei', 3);
    hub.frame(viewer.s, viewer.sock, '{"t":"chat.react","c":[0,1]}');
    hub.flush();
    hub.clear();
    say('depois da limpeza', 4);
    hub.flush();
    // Assert
    expect(current.shown).toEqual(old.shown);
    expect(old.shown).toEqual([hub.lastSeq - 1, hub.lastSeq]);
    expect(old.sent).toEqual([]);
    expect(current.sent).toEqual([]);
    expect(old.alarms).toEqual([]);
    expect(current.alarms).toEqual([]);
    expect(old.session.lastSeq).toBe(hub.lastSeq);
  });

  it('ephemeral items, a slow socket that missed some, and referred authors: the same messages on both, without a resume or a reload', () => {
    // Arrange
    const ana: ChatAuthor = { a: 'k1', n: 'Ana', c: '#e5484d', r: 'viewer' };
    const bia: ChatAuthor = { a: 'k2', n: 'Bia', c: '#46a758', r: 'viewer' };
    const roster = new Map([
      ['k1', ana],
      ['k2', bia],
    ]);
    const sock = new PipeSocket();
    const b = new ChatBatcher({ transport: { sockets: () => [sock] }, budgetBps: () => 1e9, slow: () => false, resync: () => {}, authorOf: (a) => roster.get(a), now: () => 5000 });
    const old = page(ChatSession042);
    const current = page(ChatSession);
    sock.pages.push(old, current);
    const snap: ChatSnapshot = {
      v: 1,
      settings: { enabled: true, content: ['text'], slowS: 0, autoSlow: false, maxGraphemes: 200, maxEmoji: 30, newViewerWaitS: 0, colors: 'choose', linksBlocked: false, emotes: [], builtinEmotes: true, protect: 'off', streamerName: '' },
      you: { a: 'me', color: '#0090ff', colorLocked: false, mutedUntil: null },
      roster: [ana],
      items: [],
      lastSeq: 0,
    };
    old.session.hello(snap);
    current.session.hello(snap);
    b.markKnown(sock, ['k1']);
    // Act
    b.push({ k: 'm', s: 1, at: 5000, a: 'k1', x: 'oi' }, false);
    b.pushLatest('poll', { k: 'pt', id: 1, c: [1, 0] });
    b.pushLatest('rx', { k: 'rx', c: [2, 0, 1] }, (x, y) => ({ k: 'rx', c: x.c.map((n, i) => n + (y.c[i] ?? 0)) }));
    b.flush();
    sock.bufferedAmount = 100_000;
    b.pushLatest('poll', { k: 'pt', id: 1, c: [3, 1] });
    b.flush();
    sock.bufferedAmount = 0;
    b.push({ k: 'sys', s: 2, at: 5000, code: 'chat.sys.protect' }, true);
    b.push({ k: 'm', s: 3, at: 5000, a: 'k1', x: '@Bia oi' }, false, ['k2']);
    b.pushLatest('poll', { k: 'pt', id: 1, c: [4, 2] });
    b.flush();
    // Assert
    expect(old.shown).toEqual([1, 2, 3]);
    expect(current.shown).toEqual([1, 2, 3]);
    expect(old.sent).toEqual([]);
    expect(current.sent).toEqual([]);
    expect(old.alarms).toEqual([]);
    expect(current.alarms).toEqual([]);
    expect(old.session.roster.get('k2')).toEqual(bia);
    expect(current.session.roster.get('k2')).toEqual(bia);
  });

  it('highlights and pins (also missed by a slow socket, and in a reconnect hello): the same messages on both, the pin only on the current page', () => {
    // Arrange
    const clock = manualClock(1_000_000_000_000);
    const access = new AccessControl(clock.now);
    access.begin();
    const settings: ChatSettings = { ...defaultChatSettings(), slowModeS: 0, duplicateWindowS: 0 };
    const sockets: PipeSocket[] = [];
    const host: ChatHost = { sockets: () => sockets, socketsOf: (id) => sockets.filter((s) => s.sessionId === id) };
    const hub = new ChatHub({ access, host, settings: () => settings, uploadCapMbps: () => 10, viewers: () => 3, activity: new ActivityLog(), log: silentLog, now: clock.now, guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 } });
    hub.begin();
    onTestFinished(() => hub.reset());
    const join = (name: string) => {
      const s = joinViewer(access, name, { deviceId: name });
      s.joinedAt = clock.now() - 600_000;
      const sock = new PipeSocket(s.id);
      sockets.push(sock);
      return { s, sock };
    };
    const ana = join('Ana');
    const viewer = join('Bia');
    const old = page(ChatSession042);
    const current = page(ChatSession);
    viewer.sock.pages.push(old, current);
    const snap = hub.snapshot(viewer.s)!;
    old.session.hello(snap);
    current.session.hello(snap);
    hub.helloSent(viewer.sock, snap, 0);
    let n = 0;
    const say = (text: string) => {
      clock.advance(2100);
      hub.frame(ana.s, ana.sock, JSON.stringify({ t: 'chat.send', n: ++n, text }));
      return hub.lastSeq;
    };
    // Act
    const s1 = say('primeira');
    const s2 = say('segunda');
    hub.flush();
    hub.highlight(s1, true);
    hub.pin(s2, 5);
    const s3 = say('terceira');
    hub.flush();
    const pinnedThen = current.pin;
    // The viewer's connection stalls: it misses an unpin, a new pin and two highlight changes (no
    // message, so any resume would come from them).
    viewer.sock.bufferedAmount = 100_000;
    hub.unpin();
    hub.pin(s3, null);
    hub.highlight(s1, false);
    hub.highlight(s3, true);
    hub.flush();
    viewer.sock.bufferedAmount = 0;
    const s5 = say('quarta');
    hub.flush();
    const caughtUp = { pin: current.pin, lit: [...current.lit].sort() };
    hub.delete([s3]);
    hub.flush();
    const afterDelete = current.pin;
    hub.pin(s5, null);
    hub.flush();
    // A reconnect: both pages get a hello with the pin in it.
    const again = hub.snapshot(viewer.s, { after: old.session.lastSeq })!;
    old.session.hello(again);
    current.session.hello(again);
    hub.clear();
    hub.flush();
    // Assert
    expect(pinnedThen).toEqual({ s: s2, n: 'Ana', x: 'segunda' });
    expect(caughtUp).toEqual({ pin: { s: s3, n: 'Ana', x: 'terceira' }, lit: [s3] });
    expect(afterDelete).toBeNull();
    expect(again.pin).toMatchObject({ s: s5, x: 'quarta' });
    expect(current.pin).toBeNull();
    expect(current.shown).toEqual(old.shown);
    expect(old.shown).toEqual([hub.lastSeq]);
    expect(old.sent).toEqual([]);
    expect(current.sent).toEqual([]);
    expect(old.alarms).toEqual([]);
    expect(current.alarms).toEqual([]);
    expect(old.session.lastSeq).toBe(hub.lastSeq);
  });

  it('replies and mentions: both pages show the same messages with the same text, the current one also the quote and the mentions; a reconnect after a delete shows the quote wiped', () => {
    // Arrange
    const clock = manualClock(1_000_000_000_000);
    const access = new AccessControl(clock.now);
    access.begin();
    const settings: ChatSettings = { ...defaultChatSettings(), slowModeS: 0, duplicateWindowS: 0 };
    const sockets: PipeSocket[] = [];
    const host: ChatHost = { sockets: () => sockets, socketsOf: (id) => sockets.filter((s) => s.sessionId === id) };
    const hub = new ChatHub({ access, host, settings: () => settings, uploadCapMbps: () => 10, viewers: () => 3, activity: new ActivityLog(), log: silentLog, now: clock.now, guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 } });
    hub.begin();
    onTestFinished(() => hub.reset());
    const join = (name: string) => {
      const s = joinViewer(access, name, { deviceId: name });
      s.joinedAt = clock.now() - 600_000;
      const sock = new PipeSocket(s.id);
      sockets.push(sock);
      return { s, sock };
    };
    const ana = join('Ana');
    const viewer = join('Bia');
    const old = page(ChatSession042);
    const current = page(ChatSession);
    viewer.sock.pages.push(old, current);
    const snap = hub.snapshot(viewer.s)!;
    old.session.hello(snap);
    current.session.hello(snap);
    hub.helloSent(viewer.sock, snap, 0);
    let n = 0;
    const say = (who: { s: typeof ana.s; sock: PipeSocket }, text: string, extra: { re?: number; mn?: string[] } = {}) => {
      clock.advance(2100);
      hub.frame(who.s, who.sock, JSON.stringify({ t: 'chat.send', n: ++n, text, ...extra }));
      return hub.lastSeq;
    };
    const anaKey = hub.you(ana.s).a;
    const biaKey = hub.you(viewer.s).a;
    // Act
    const question = say(ana, 'alguém sabe a música?');
    say(viewer, 'oi');
    const answer = say(viewer, '@Ana é a do começo', { re: question, mn: [anaKey] });
    const back = say(ana, '@Bia valeu!', { re: answer, mn: [biaKey] });
    hub.sendAsStreamer({ text: 'boa', re: back });
    hub.flush();
    const live = { replies: new Map(current.replies), mentions: new Map(current.mentions) };
    hub.delete([question]);
    hub.flush();
    const again = hub.snapshot(viewer.s, { after: old.session.lastSeq })!;
    old.session.hello(again);
    current.session.hello(again);
    // Assert
    expect(current.shown).toEqual(old.shown);
    expect([...current.text]).toEqual([...old.text]);
    expect(old.text.get(answer)).toBe('@Ana é a do começo');
    expect(old.replies.size + old.mentions.size).toBe(0);
    expect(live.replies.get(answer)).toEqual({ n: 'Ana', q: 'alguém sabe a música?' });
    expect(live.replies.get(back)).toEqual({ n: 'Bia', q: '@Ana é a do começo' });
    expect(live.mentions.get(answer)).toEqual(['Ana']);
    expect(live.mentions.get(back)).toEqual(['Bia']);
    expect(current.replies.get(answer)).toEqual({ n: 'Ana', gone: true });
    expect(old.sent).toEqual([]);
    expect(current.sent).toEqual([]);
    expect(old.alarms).toEqual([]);
    expect(current.alarms).toEqual([]);
    expect(old.session.lastSeq).toBe(hub.lastSeq);
  });
});
