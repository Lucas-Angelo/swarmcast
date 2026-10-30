import { describe, expect, it } from 'vitest';
import { defaultChatSettings, type ChatItem, type ChatServerMessage, type ChatSettings } from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ChatHub, type ChatHost } from '../../src/chat/hub.js';
import { ActivityLog } from '../../src/core/activity.js';
import { manualClock, silentLog } from './helpers.js';

// The chat hub (docs/CHAT.md) on a manual clock, with fake viewer sockets.
//
// Budget arithmetic used below: the chat may use 5 % of the upload cap (10 Mbps here), that is
// 500 kbps = 62,500 B/s; a message costs about 70 B per viewer; the global message rate G is the
// budget over (viewers × 70 B), capped at 20 per second.

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

/** The hub of a begun live, `viewers` watching; `join` adds a viewer who joined 10 minutes ago. */
function setup(over: Partial<ChatSettings> = {}, viewers = 2) {
  const clock = manualClock(1_000_000_000_000);
  const access = new AccessControl(clock.now);
  access.begin();
  const settings: ChatSettings = { ...defaultChatSettings(), ...over };
  const sockets: FakeSocket[] = [];
  const host: ChatHost = {
    sockets: () => sockets,
    socketsOf: (id) => sockets.filter((s) => s.sessionId === id),
  };
  const activity = new ActivityLog();
  const admin: unknown[] = [];
  const hub = new ChatHub({
    access,
    host,
    settings: () => settings,
    uploadCapMbps: () => 10,
    viewers: () => viewers,
    activity,
    log: silentLog,
    now: clock.now,
    onAdmin: (m) => admin.push(m),
    guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  const join = (nickname: string, deviceId = nickname, ip = '203.0.113.1'): Viewer => {
    const s = access.createSession({ nickname, deviceId, device: 'desktop', ip });
    s.joinedAt = clock.now() - 10 * 60_000;
    const sock = new FakeSocket(s.id);
    sockets.push(sock);
    return { s, sock };
  };
  const send = (who: Viewer, text: string, n = 1) => hub.frame(who.s, who.sock, JSON.stringify({ t: 'chat.send', n, text }));
  return { hub, access, settings, sockets, join, send, advance: clock.advance, activity, admin, now: clock.now };
}

/** `count` messages from `who`, 2.1 s apart (past the default slow mode), numbered from `from`. */
function chatter(env: ReturnType<typeof setup>, who: Viewer, count: number, text: (i: number) => string = (i) => `m${i}`, from = 1): void {
  for (let i = from; i < from + count; i++) {
    env.advance(2100);
    env.send(who, text(i), i);
  }
}

const last = (sock: FakeSocket) => sock.messages().at(-1);
const KLIPY_MEDIA = '/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp';

describe('ChatHub: messages', () => {
  it('a message from A reaches B in one batch with seq, author and colour; A gets an ack', () => {
    // Arrange
    const { hub, join, send } = setup();
    const a = join('Ana');
    const b = join('Bia');
    // Act
    send(a, 'boa noite chat 😀', 7);
    hub.flush();
    // Assert
    expect(a.sock.messages()).toContainEqual({ t: 'chat.ack', n: 7, s: 1 });
    const items = b.sock.items();
    const roster = items.find((i) => i.k === 'u');
    const msg = items.find((i) => i.k === 'm');
    expect(roster).toMatchObject({ k: 'u', au: { n: 'Ana', r: 'viewer' } });
    expect(msg).toMatchObject({ k: 'm', s: 1, x: 'boa noite chat 😀' });
    expect(msg && msg.k === 'm' && roster && roster.k === 'u' && msg.a === roster.au.a).toBe(true);
    expect(roster && roster.k === 'u' && /^#[0-9a-f]{6}$/.test(roster.au.c)).toBe(true);
  });

  it('the ack comes before the batch, and every socket gets the same serialised batch', () => {
    // Arrange
    const { hub, join, send } = setup();
    const a = join('Ana');
    const b = join('Bia');
    // Act
    send(a, 'boa noite chat 😀', 7);
    const ack = last(a.sock);
    hub.flush();
    // Assert
    expect(ack).toEqual({ t: 'chat.ack', n: 7, s: 1 });
    expect(a.sock.sent.at(-1)).toBe(b.sock.sent.at(-1));
  });

  it('canonicalises with the shared pipeline (bidi controls removed)', () => {
    // Arrange
    const { hub, join, send } = setup({ slowModeS: 0 });
    const a = join('Ana');
    // Act
    send(a, 'abc\u{202E}fdp', 1);
    hub.flush();
    // Assert
    expect(a.sock.items().find((i) => i.k === 'm')).toMatchObject({ x: 'abcfdp' });
  });

  it.each([
    ['invisible characters only', JSON.stringify({ t: 'chat.send', n: 2, text: '\u{200B}\u{3164}' }), { code: 'text.empty' }],
    ['201 characters', JSON.stringify({ t: 'chat.send', n: 2, text: 'x'.repeat(201) }), { code: 'text.tooLong', params: { max: 200 } }],
    ['an object as text', '{"t":"chat.send","n":2,"text":{"__proto__":1}}', { code: 'text.invalid' }],
  ])('rejects %s with a translated code', (_what, frame, reject) => {
    // Arrange
    const { hub, join } = setup({ slowModeS: 0 });
    const a = join('Ana');
    // Act
    hub.frame(a.s, a.sock, frame);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.reject', n: 2, ...reject });
  });

  it('slow mode: a second message within 2 s gets chat.err.slow with retryMs; the socket stays', () => {
    // Arrange
    const { join, send, advance } = setup();
    const a = join('Ana');
    send(a, 'one', 1);
    advance(500);
    // Act
    send(a, 'two', 2);
    // Assert
    const r = last(a.sock);
    expect(r).toMatchObject({ t: 'chat.reject', n: 2, code: 'chat.err.slow', params: { count: 2 } });
    expect(r && r.t === 'chat.reject' && r.retryMs).toBe(1500);
    // Act
    advance(1600);
    send(a, 'three', 3);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack', n: 3 });
  });

  it('burst bucket: 5 per 10 s even with slow mode 0; three tabs of one device share it', () => {
    // Arrange
    const { join, send, advance } = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const tab1 = join('Ana', 'dev1');
    const tab2 = join('Ana2', 'dev1');
    // Act
    for (let i = 1; i <= 8; i++) {
      send(i % 2 ? tab1 : tab2, `m${i}`, i);
      advance(10);
    }
    // Assert
    const acks = [tab1.sock, tab2.sock].flatMap((s) => s.messages()).filter((m) => m.t === 'chat.ack');
    expect(acks).toHaveLength(5);
  });

  it('duplicates: the same text from one viewer within 30 s is refused, look-alikes included', () => {
    // Arrange
    const { join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    send(a, 'Olá pessoal', 1);
    advance(3000);
    // Act
    send(a, 'OLÁ   PESSOAL!', 2);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.dup' });
    // Act
    advance(31_000);
    send(a, 'olá pessoal', 3);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('emotes only refuses text and takes emotes', () => {
    // Arrange
    const { hub, join, send, settings, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    settings.content = { text: false, emotes: true, gifs: false };
    hub.refresh();
    // Act
    send(a, 'hello', 1);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.mode', params: { allowedKey: 'chat.content.e' } });
    // Act
    advance(3000);
    send(a, '😀 :gg:', 2);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('text only refuses emoji; GIFs off refuses GIFs', () => {
    // Arrange
    const { hub, join, send, settings, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    settings.content = { text: true, emotes: false, gifs: false };
    hub.refresh();
    // Act
    send(a, 'ok 😀', 3);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.mode', params: { allowedKey: 'chat.content.t' } });
    // Act
    advance(3000);
    hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n: 4, gif: { p: 'klipy', id: 'abc', w: 100, h: 100, m: KLIPY_MEDIA } }));
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.gifOff' });
  });

  it('blocked words match through look-alikes and are never echoed', () => {
    // Arrange
    const { hub, join, send } = setup({ slowModeS: 0, blockedWords: ['idiota'] });
    hub.refresh();
    const a = join('Ana');
    // Act
    send(a, 'vc é um I D I O T A', 1);
    // Assert
    expect(last(a.sock)).toEqual({ t: 'chat.reject', n: 1, code: 'chat.err.blocked' });
  });

  it('links can be blocked, or allowed as plain text', () => {
    // Arrange
    const { hub, join, send, settings, advance } = setup({ slowModeS: 0, links: 'block' });
    hub.refresh();
    const a = join('Ana');
    // Act
    send(a, 'olha evil.gg/x', 2);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.links' });
    // Act
    settings.links = 'text';
    hub.refresh();
    advance(3000);
    send(a, 'olha evil.gg/x', 3);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('GIFs (hooks for C8): need the streamer key and provider; one per 30 s', () => {
    // Arrange
    const { hub, join, settings, advance } = setup({ slowModeS: 0 });
    settings.content = { text: true, emotes: true, gifs: true };
    settings.gif = { provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' };
    hub.refresh();
    const a = join('Ana');
    const media: Record<string, string> = { klipy: KLIPY_MEDIA, giphy: '/media/3o7TKSjRrfIPjeiVyM/200.webp' };
    const gif = (n: number, p = 'klipy') => hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n, gif: { p, id: 'abc_1', w: 200, h: 150, m: media[p] } }));
    // Act
    gif(1);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
    expect(hub.effective.public.gif).toEqual({ provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' });
    // Act
    advance(3000);
    gif(2);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.slow' });
    // Act
    advance(30_000);
    gif(3, 'giphy');
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.gifInvalid' });
  });

  it('chat off: chat.err.off and no snapshot in hello', () => {
    // Arrange
    const { hub, join, send, settings } = setup();
    settings.enabled = false;
    hub.refresh();
    const a = join('Ana');
    // Act
    send(a, 'hi', 1);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.off' });
    expect(hub.snapshot(a.s)).toBeUndefined();
  });
});

describe('ChatHub: moderation', () => {
  it('mute for 1 min survives a rejoin from the same device; unmute applies at once', () => {
    // Arrange
    const { hub, access, join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana', 'devA');
    // Act
    hub.mute(a.s.id, 1);
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.you', you: { mutedUntil: expect.any(Number) } });
    // Act
    send(a, 'hi', 1);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.muted', params: { count: 1 } });
    // Act
    access.sessions.delete(a.s.id);
    const again = join('Ana', 'devA');
    send(again, 'hi again', 2);
    // Assert
    expect(last(again.sock)).toMatchObject({ code: 'chat.err.muted' });
    // Act
    hub.unmute(again.s.id);
    advance(10);
    send(again, 'free', 3);
    // Assert
    expect(last(again.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('mute until the end of the live, not announced by default', () => {
    // Arrange
    const { hub, join, send } = setup();
    const a = join('Ana');
    const b = join('Bia');
    // Act
    hub.mute(a.s.id, null);
    send(a, 'hi', 1);
    hub.flush();
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.mutedLive' });
    expect(b.sock.items().some((i) => i.k === 'sys')).toBe(false);
  });

  it('a mute is announced when the streamer wants it', () => {
    // Arrange
    const { hub, join, settings, sockets } = setup();
    join('Ana');
    const b = join('Bia');
    settings.announceMutes = true;
    // Act
    hub.mute(b.s.id, 10);
    hub.flush();
    // Assert
    expect(sockets[0]!.items().find((i) => i.k === 'sys')).toMatchObject({ code: 'chat.sys.muted', params: { nickname: 'Bia', minutes: 10 } });
  });

  it('delete and clear go to everyone; the ring forgets them', () => {
    // Arrange
    const { hub, join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    send(a, 'one', 1);
    advance(100);
    send(a, 'two', 2);
    // Act
    hub.delete([1]);
    hub.flush();
    // Assert
    expect(a.sock.items()).toContainEqual({ k: 'd', s: [1] });
    expect(hub.adminState().items.map((i) => i.k === 'm' && i.x)).toEqual(['two']);
    // Act
    hub.clear();
    hub.flush();
    // Assert
    expect(a.sock.items()).toContainEqual({ k: 'clr', s: 2 });
    expect(hub.adminState().items.map((i) => i.k)).toEqual(['sys']);
  });

  it('colours: viewers choose unless locked; the streamer can set and lock; roster upserts go to everyone', () => {
    // Arrange
    const { hub, join } = setup();
    const a = join('Ana');
    const b = join('Bia');
    // Act
    hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.color', color: '#12A594' }));
    hub.flush();
    // Assert
    expect(b.sock.items()).toContainEqual(expect.objectContaining({ k: 'u', au: expect.objectContaining({ n: 'Ana', c: '#12a594' }) }));
    // Act
    hub.setColor(a.s.id, '#e5484d', true);
    hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.color', color: '#000000' }));
    // Assert
    expect(hub.you(a.s)).toMatchObject({ color: '#e5484d', colorLocked: true });
  });

  it('the streamer posts with role streamer, the same pipeline and an anti-mistake limit', () => {
    // Arrange
    const { hub, join } = setup();
    const a = join('Ana');
    // Act
    const posted = hub.sendAsStreamer({ text: 'Bem-vindos! \u{202E}' });
    hub.flush();
    // Assert
    expect(posted).toEqual({ ok: true, s: 1 });
    expect(a.sock.items()).toContainEqual(expect.objectContaining({ k: 'u', au: expect.objectContaining({ r: 'streamer' }) }));
    expect(a.sock.items()).toContainEqual(expect.objectContaining({ k: 'm', x: 'Bem-vindos!' }));
    // Act
    for (let i = 0; i < 4; i++) hub.sendAsStreamer({ text: `m${i}` });
    const tooFast = hub.sendAsStreamer({ text: 'too fast' });
    // Assert
    expect(tooFast).toMatchObject({ ok: false, code: 'admin.chat.err.tooFast' });
  });

  it('a viewer can never get role streamer', () => {
    // Arrange
    const { hub, join, send } = setup();
    const a = join('Ana');
    // Act
    send(a, 'hi', 1);
    hub.flush();
    // Assert
    expect(a.sock.items().filter((i) => i.k === 'u').every((i) => i.k === 'u' && i.au.r === 'viewer')).toBe(true);
  });
});

describe('ChatHub: snapshots, resume, history', () => {
  /** What a viewer's page would know: roster entries from its hello and every frame it got. */
  function rosterSeen(sock: FakeSocket, helloRoster: Array<{ a: string }> = []): Set<string> {
    const seen = new Set(helloRoster.map((r) => r.a));
    for (const m of sock.messages()) {
      if (m.t === 'chat.batch') for (const i of m.items) if (i.k === 'u') seen.add(i.au.a);
      if (m.t === 'chat.reset') for (const r of m.roster) seen.add(r.a);
    }
    return seen;
  }

  /**
   * X spoke, then the chat was cleared, then B joined: B's hello history is empty, so its roster
   * does not list X.
   */
  function lateJoinerAfterClear() {
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const x = env.join('Xavi');
    env.send(x, 'first', 1);
    env.hub.flush();
    env.hub.clear();
    env.hub.flush();
    const b = env.join('Bia');
    const snap = env.hub.snapshot(b.s)!;
    env.hub.helloSent(b.sock, snap, 100);
    return { ...env, x, b, snap };
  }

  it("a late joiner gets the roster entry of an author who spoke before it joined (after a clear)", () => {
    // Arrange
    const { hub, x, b, snap, send, advance } = lateJoinerAfterClear();
    // Act
    advance(2100);
    send(x, 'again', 2);
    hub.flush();
    // Assert
    expect(snap.roster.map((r) => r.n)).not.toContain('Xavi');
    const xKey = hub.moderation.bySessionId(x.s.id)!.a;
    expect(b.sock.items().filter((i) => i.k === 'm').map((i) => i.k === 'm' && i.a)).toContain(xKey);
    expect(rosterSeen(b.sock, snap.roster).has(xKey)).toBe(true);
  });

  it('a late joiner also gets the roster entry of the streamer, with the streamer role', () => {
    // Arrange
    const { hub, b } = lateJoinerAfterClear();
    // Act
    hub.sendAsStreamer({ text: 'hello all' });
    hub.flush();
    // Assert
    const authors = b.sock.items().flatMap((i) => (i.k === 'u' ? [i.au] : []));
    expect(authors.find((au) => au.r === 'streamer')).toBeDefined();
  });

  it('sockets that already know the author get no extra roster frame: the ack and the batch only', () => {
    // Arrange
    const { hub, x, send, advance } = lateJoinerAfterClear();
    advance(2100);
    send(x, 'again', 2);
    hub.flush();
    const before = x.sock.sent.length;
    // Act
    advance(2100);
    send(x, 'third', 3);
    hub.flush();
    // Assert
    expect(x.sock.sent.length - before).toBe(2);
  });

  it('the same holds after a reconnect that got only a delta', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const { hub, join, send, advance, sockets } = env;
    const x = join('Xavi');
    const b = join('Bia');
    chatter(env, b, 3, (i) => `b${i}`);
    hub.flush();
    const again = { s: b.s, sock: new FakeSocket(b.s.id) };
    sockets.splice(sockets.indexOf(b.sock), 1, again.sock);
    const delta = hub.snapshot(again.s, { after: 3 })!;
    hub.helloSent(again.sock, delta, 80);
    // Act
    advance(2100);
    send(x, 'hi from X', 1);
    hub.flush();
    // Assert
    expect(delta.delta).toBe(true);
    const xKey = hub.moderation.bySessionId(x.s.id)!.a;
    expect(rosterSeen(again.sock, delta.roster).has(xKey)).toBe(true);
  });

  it('reconnect: a viewer that already has items gets only the delta', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    chatter(env, env.join('Ana'), 8);
    const b = env.join('Bia');
    // Act
    const delta = env.hub.snapshot(b.s, { after: 5 })!;
    const upToDate = env.hub.snapshot(b.s, { after: 8 });
    // Assert
    expect(delta.delta).toBe(true);
    expect(delta.items.map((i) => i.k === 'm' && i.s)).toEqual([6, 7, 8]);
    expect(delta.lastSeq).toBe(8);
    expect(delta.roster.map((r) => r.n).sort()).toEqual(['Ana', 'Bia']);
    expect(upToDate).toMatchObject({ delta: true, items: [] });
  });

  it('reconnect from another live (a seq beyond ours) or a first connection: a full snapshot', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    chatter(env, env.join('Ana'), 8);
    const b = env.join('Bia');
    // Act
    const otherLive = env.hub.snapshot(b.s, { after: 99 })!;
    const first = env.hub.snapshot(b.s, {})!;
    // Assert
    expect(otherLive.delta).toBeUndefined();
    expect(first.items).toHaveLength(8);
  });

  it('reconnect: a delete or clear since the viewer last saw the chat forces a full snapshot', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const a = env.join('Ana');
    chatter(env, a, 6);
    // Act
    env.hub.delete([2]);
    const snap = env.hub.snapshot(a.s, { after: 4 })!;
    // Assert
    expect(snap.delta).toBeUndefined();
    expect(snap.items.map((i) => i.k === 'm' && i.s)).toEqual([1, 3, 4, 5, 6]);
    // Act
    env.advance(2100);
    env.send(a, 'later', 7);
    // Assert
    expect(env.hub.snapshot(a.s, { after: 7 })!.delta).toBe(true);
  });

  it('reconnect: items evicted from the ring, or a gap longer than a fresh history, give a full snapshot', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    env.settings.historyOnJoin = 5;
    env.hub.refresh();
    const a = env.join('Ana');
    // Act
    chatter(env, a, 230);
    // Assert
    expect(env.hub.snapshot(a.s, { after: 3 })!.delta).toBeUndefined();
    const long = env.hub.snapshot(a.s, { after: 200 })!;
    expect(long.delta).toBeUndefined();
    expect(long.items).toHaveLength(5);
    expect(env.hub.snapshot(a.s, { after: 225 })!.delta).toBe(true);
  });

  it('hello snapshots are charged to the budget; in debt, history shrinks to 10 items until it refills', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const a = env.join('Ana');
    chatter(env, a, 60, (i) => `message number ${i}`);
    const full = env.hub.snapshot(a.s)!;
    const helloBytes = JSON.stringify({ t: 'hello', chat: full }).length;
    // Act
    for (let i = 0; i < 120; i++) env.hub.accountSent(helloBytes);
    const shrunk = env.hub.snapshot(a.s)!;
    // Assert
    expect(full.items).toHaveLength(50);
    expect(shrunk.items).toHaveLength(10);
    expect(shrunk.items.at(-1)).toEqual(full.items.at(-1));
    // Act
    env.advance(5 * 60_000);
    // Assert
    expect(env.hub.snapshot(a.s)!.items).toHaveLength(50);
  });

  it('hello snapshot: the last N items, my identity, roster for the authors shown', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    env.settings.historyOnJoin = 3;
    env.hub.refresh();
    chatter(env, env.join('Ana'), 5);
    const b = env.join('Bia');
    // Act
    const snap = env.hub.snapshot(b.s)!;
    // Assert
    expect(snap.v).toBe(1);
    expect(snap.lastSeq).toBe(5);
    expect(snap.items.map((i) => i.k === 'm' && i.x)).toEqual(['m3', 'm4', 'm5']);
    expect(snap.roster.map((r) => r.n).sort()).toEqual(['Ana', 'Bia']);
    expect(snap.you.a).toBe(snap.roster.find((r) => r.n === 'Bia')!.a);
  });

  it('chat.resume: missing items come back', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const a = env.join('Ana');
    chatter(env, a, 3);
    a.sock.clear();
    // Act
    env.hub.frame(a.s, a.sock, '{"t":"chat.resume","after":1}');
    // Assert
    expect(a.sock.items().filter((i) => i.k === 'm').map((i) => i.k === 'm' && i.s)).toEqual([2, 3]);
  });

  it('chat.resume: items evicted from the ring bring a full reset', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const a = env.join('Ana');
    chatter(env, a, 260);
    env.advance(5000);
    a.sock.clear();
    // Act
    env.hub.frame(a.s, a.sock, '{"t":"chat.resume","after":1}');
    // Assert
    expect(last(a.sock)).toMatchObject({ t: 'chat.reset', v: 1, lastSeq: 260 });
  });

  it('ring caps: 200 items', () => {
    // Arrange
    const env = setup({ slowModeS: 0, duplicateWindowS: 0 });
    // Act
    chatter(env, env.join('Ana'), 230);
    // Assert
    expect(env.hub.ringSize.items).toBe(200);
    expect(env.hub.ringSize.bytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('reset (Stop) wipes ring, mutes and roster; the next live starts at seq 1', () => {
    // Arrange
    const { hub, join, send } = setup();
    const a = join('Ana');
    send(a, 'hi', 1);
    hub.mute(a.s.id, null);
    // Act
    hub.reset();
    hub.begin();
    // Assert
    expect(hub.lastSeq).toBe(0);
    expect(hub.adminState().items).toEqual([]);
    expect(hub.moderation.muteCount).toBe(0);
  });
});

describe('ChatHub: limits and protection', () => {
  it('the global limit G comes from the upload budget and the audience', () => {
    // Arrange
    const many = setup({}, 120).hub;
    const few = setup({}, 5).hub;
    // Act
    const g120 = many.globalPerS();
    const g5 = few.globalPerS();
    // Assert
    expect(g120).toBeCloseTo(62_500 / (120 * 70), 5);
    expect(g5).toBe(20);
    expect(many.budgetBps()).toBe(62_500);
  });

  it('new-viewer wait: a viewer 5 s in waits the rest of the minute', () => {
    // Arrange
    const { hub, join, send, now } = setup({ newViewerWaitS: 60 });
    hub.refresh();
    const a = join('Ana');
    a.s.joinedAt = now() - 5_000;
    // Act
    send(a, 'hi', 1);
    // Assert
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.newViewer', params: { count: 55 } });
  });

  it('lockdown: only viewers who were already here may talk, and new joiners get no history', () => {
    // Arrange
    const { hub, join, send, now } = setup({ newViewerWaitS: 0 });
    const fresh = join('Ana');
    fresh.s.joinedAt = now() - 30_000;
    const old = join('Old');
    old.s.joinedAt = now() - 10 * 60_000;
    // Act
    hub.setProtect('lockdown');
    send(fresh, 'hi', 2);
    send(old, 'still here', 1);
    // Assert
    expect(last(fresh.sock)).toMatchObject({ code: 'chat.err.protect' });
    expect(last(old.sock)).toMatchObject({ t: 'chat.ack' });
    expect(hub.effective.historyOnJoin).toBe(0);
    // Act
    hub.setProtect('off');
    // Assert
    expect(hub.protection).toBe('off');
  });

  it('an internal error never escapes, and repeated ones stop only the chat', () => {
    // Arrange
    const { hub, join, activity } = setup();
    const a = join('Ana');
    const quiet = { ...a.sock, send: () => {} } as unknown as typeof a.sock;
    const faulty = new Proxy(a.s, {
      get(t, k) {
        if (k === 'deviceId') throw new Error('boom');
        return Reflect.get(t, k);
      },
    });
    // Act
    const frames = Array.from({ length: 7 }, () => () => hub.frame(faulty, quiet, '{"t":"chat.send","n":1,"text":"x"}'));
    // Assert
    for (const frame of frames) expect(frame).not.toThrow();
    expect(hub.isBroken).toBe(true);
    expect(hub.effective.enabled).toBe(false);
    expect(activity.list().some((e) => e.code === 'log.chat.broken')).toBe(true);
  });

  it('rejects to one socket are coalesced (a flooding script gets silence)', () => {
    // Arrange
    const { join, hub } = setup();
    const a = join('Ana');
    // Act
    for (let i = 0; i < 20; i++) hub.frame(a.s, a.sock, '{"t":"chat.send","n":1,"text":{}}');
    // Assert
    expect(a.sock.messages().filter((m) => m.t === 'chat.reject').length).toBeLessThanOrEqual(3);
  });
});
