import { describe, expect, it } from 'vitest';
import { defaultChatSettings, type ChatItem, type ChatServerMessage, type ChatSettings } from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ChatHub, type ChatHost } from '../../src/chat/hub.js';
import { ActivityLog } from '../../src/core/activity.js';
import { silentLog } from './helpers.js';

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

function setup(over: Partial<ChatSettings> = {}, viewers = 2) {
  let t = 1_000_000_000_000;
  const now = () => t;
  const access = new AccessControl(now);
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
    now,
    onAdmin: (m) => admin.push(m),
    guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  const join = (nickname: string, deviceId = nickname, ip = '203.0.113.1'): { s: Session; sock: FakeSocket } => {
    const s = access.createSession({ nickname, deviceId, device: 'desktop', ip });
    s.joinedAt = t - 10 * 60_000;
    const sock = new FakeSocket(s.id);
    sockets.push(sock);
    return { s, sock };
  };
  const send = (who: { s: Session; sock: FakeSocket }, text: string, n = 1) => hub.frame(who.s, who.sock, JSON.stringify({ t: 'chat.send', n, text }));
  const advance = (ms: number) => {
    t += ms;
  };
  return { hub, access, settings, sockets, join, send, advance, activity, admin, now };
}

const last = (sock: FakeSocket) => sock.messages().at(-1);

describe('ChatHub: messages', () => {
  it('a message from A reaches B in one batch with seq, author and colour; A gets an ack', () => {
    const { hub, join, send } = setup();
    const a = join('Ana');
    const b = join('Bia');
    send(a, 'boa noite chat 😀', 7);
    expect(last(a.sock)).toEqual({ t: 'chat.ack', n: 7, s: 1 });
    hub.flush();
    const items = b.sock.items();
    const roster = items.find((i) => i.k === 'u');
    const msg = items.find((i) => i.k === 'm');
    expect(roster).toMatchObject({ k: 'u', au: { n: 'Ana', r: 'viewer' } });
    expect(msg).toMatchObject({ k: 'm', s: 1, x: 'boa noite chat 😀' });
    expect(msg && msg.k === 'm' && roster && roster.k === 'u' && msg.a === roster.au.a).toBe(true);
    expect(roster && roster.k === 'u' && /^#[0-9a-f]{6}$/.test(roster.au.c)).toBe(true);
    // One stringify for everyone: both sockets got the identical batch.
    expect(a.sock.sent.at(-1)).toBe(b.sock.sent.at(-1));
  });

  it('canonicalises with the shared pipeline and rejects with translated codes', () => {
    const { hub, join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    send(a, 'abc\u{202E}fdp', 1);
    hub.flush();
    expect(a.sock.items().find((i) => i.k === 'm')).toMatchObject({ x: 'abcfdp' });
    advance(3000);
    send(a, '\u{200B}\u{3164}', 2);
    expect(last(a.sock)).toMatchObject({ t: 'chat.reject', n: 2, code: 'text.empty' });
    advance(3000);
    send(a, 'x'.repeat(201), 3);
    expect(last(a.sock)).toMatchObject({ t: 'chat.reject', n: 3, code: 'text.tooLong', params: { max: 200 } });
    advance(3000);
    hub.frame(a.s, a.sock, '{"t":"chat.send","n":4,"text":{"__proto__":1}}');
    expect(last(a.sock)).toMatchObject({ t: 'chat.reject', n: 4, code: 'text.invalid' });
  });

  it('slow mode: a second message within 2 s gets chat.err.slow with retryMs; the socket stays', () => {
    const { join, send, advance } = setup();
    const a = join('Ana');
    send(a, 'one', 1);
    advance(500);
    send(a, 'two', 2);
    const r = last(a.sock);
    expect(r).toMatchObject({ t: 'chat.reject', n: 2, code: 'chat.err.slow', params: { count: 2 } });
    expect(r && r.t === 'chat.reject' && r.retryMs).toBe(1500);
    advance(1600);
    send(a, 'three', 3);
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack', n: 3 });
  });

  it('burst bucket: 5 per 10 s even with slow mode 0; three tabs of one device share it', () => {
    const { join, send, advance } = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const tab1 = join('Ana', 'dev1');
    const tab2 = join('Ana2', 'dev1');
    let acks = 0;
    for (let i = 1; i <= 8; i++) {
      send(i % 2 ? tab1 : tab2, `m${i}`, i);
      advance(10);
    }
    for (const s of [tab1.sock, tab2.sock]) acks += s.messages().filter((m) => m.t === 'chat.ack').length;
    expect(acks).toBe(5);
  });

  it('duplicates: the same text from one viewer within 30 s is refused, look-alikes included', () => {
    const { join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    send(a, 'Olá pessoal', 1);
    advance(3000);
    send(a, 'OLÁ   PESSOAL!', 2);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.dup' });
    advance(31_000);
    send(a, 'olá pessoal', 3);
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('modes: emotes only refuses text; text only refuses emoji; GIFs off refuses GIFs', () => {
    const { hub, join, send, settings, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    settings.content = { text: false, emotes: true, gifs: false };
    hub.refresh();
    send(a, 'hello', 1);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.mode', params: { allowedKey: 'chat.content.e' } });
    advance(3000);
    send(a, '😀 :gg:', 2);
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
    settings.content = { text: true, emotes: false, gifs: false };
    hub.refresh();
    advance(3000);
    send(a, 'ok 😀', 3);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.mode', params: { allowedKey: 'chat.content.t' } });
    advance(3000);
    hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n: 4, gif: { p: 'klipy', id: 'abc', w: 100, h: 100 } }));
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.gifOff' });
  });

  it('blocked words match through look-alikes; links can be blocked; never echoed', () => {
    const { hub, join, send, settings, advance } = setup({ slowModeS: 0, blockedWords: ['idiota'], links: 'block' });
    hub.refresh();
    const a = join('Ana');
    send(a, 'vc é um I D I O T A', 1);
    expect(last(a.sock)).toEqual({ t: 'chat.reject', n: 1, code: 'chat.err.blocked' });
    advance(3000);
    send(a, 'olha evil.gg/x', 2);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.links' });
    settings.links = 'text';
    hub.refresh();
    advance(3000);
    send(a, 'olha evil.gg/x', 3);
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('GIFs (hooks for C8): need the streamer key and provider; one per 30 s', () => {
    const { hub, join, settings, advance } = setup({ slowModeS: 0 });
    settings.content = { text: true, emotes: true, gifs: true };
    settings.gif = { provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' };
    hub.refresh();
    const a = join('Ana');
    const gif = (n: number, p = 'klipy') => hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n, gif: { p, id: 'abc_1', w: 200, h: 150 } }));
    gif(1);
    expect(last(a.sock)).toMatchObject({ t: 'chat.ack' });
    advance(3000);
    gif(2);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.slow' });
    advance(30_000);
    gif(3, 'giphy');
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.gifInvalid' });
    expect(hub.effective.public.gif).toEqual({ provider: 'klipy', key: 'Abcdefgh_123', rating: 'pg', consent: 'ask' });
  });

  it('chat off: chat.err.off and no snapshot in hello', () => {
    const { hub, join, send, settings } = setup();
    settings.enabled = false;
    hub.refresh();
    const a = join('Ana');
    send(a, 'hi', 1);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.off' });
    expect(hub.snapshot(a.s)).toBeUndefined();
  });
});

describe('ChatHub: moderation', () => {
  it('mute for 1 min survives a rejoin from the same device; unmute applies at once', () => {
    const { hub, access, join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana', 'devA');
    hub.mute(a.s.id, 1);
    expect(last(a.sock)).toMatchObject({ t: 'chat.you', you: { mutedUntil: expect.any(Number) } });
    send(a, 'hi', 1);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.muted', params: { count: 1 } });
    access.sessions.delete(a.s.id);
    const again = join('Ana', 'devA');
    send(again, 'hi again', 2);
    expect(last(again.sock)).toMatchObject({ code: 'chat.err.muted' });
    hub.unmute(again.s.id);
    advance(10);
    send(again, 'free', 3);
    expect(last(again.sock)).toMatchObject({ t: 'chat.ack' });
  });

  it('mute until the end of the live; announced only when the streamer wants it', () => {
    const { hub, join, send, settings, sockets } = setup();
    const a = join('Ana');
    const b = join('Bia');
    hub.mute(a.s.id, null);
    send(a, 'hi', 1);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.mutedLive' });
    hub.flush();
    expect(b.sock.items().some((i) => i.k === 'sys')).toBe(false);
    settings.announceMutes = true;
    hub.mute(b.s.id, 10);
    hub.flush();
    expect(sockets[0]!.items().find((i) => i.k === 'sys')).toMatchObject({ code: 'chat.sys.muted', params: { nickname: 'Bia', minutes: 10 } });
  });

  it('delete and clear go to everyone; the ring forgets them', () => {
    const { hub, join, send, advance } = setup({ slowModeS: 0 });
    const a = join('Ana');
    send(a, 'one', 1);
    advance(100);
    send(a, 'two', 2);
    hub.delete([1]);
    hub.flush();
    expect(a.sock.items()).toContainEqual({ k: 'd', s: [1] });
    expect(hub.adminState().items.map((i) => i.k === 'm' && i.x)).toEqual(['two']);
    hub.clear();
    hub.flush();
    expect(a.sock.items()).toContainEqual({ k: 'clr', s: 2 });
    expect(hub.adminState().items.map((i) => i.k)).toEqual(['sys']);
  });

  it('colours: viewers choose unless locked; the streamer can set and lock; roster upserts go to everyone', () => {
    const { hub, join } = setup();
    const a = join('Ana');
    const b = join('Bia');
    hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.color', color: '#12A594' }));
    hub.flush();
    expect(b.sock.items()).toContainEqual(expect.objectContaining({ k: 'u', au: expect.objectContaining({ n: 'Ana', c: '#12a594' }) }));
    hub.setColor(a.s.id, '#e5484d', true);
    hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.color', color: '#000000' }));
    expect(hub.you(a.s)).toMatchObject({ color: '#e5484d', colorLocked: true });
  });

  it('the streamer posts with role streamer, the same pipeline and an anti-mistake limit', () => {
    const { hub, join } = setup();
    const a = join('Ana');
    expect(hub.sendAsStreamer({ text: 'Bem-vindos! \u{202E}' })).toEqual({ ok: true, s: 1 });
    hub.flush();
    expect(a.sock.items()).toContainEqual(expect.objectContaining({ k: 'u', au: expect.objectContaining({ r: 'streamer' }) }));
    expect(a.sock.items()).toContainEqual(expect.objectContaining({ k: 'm', x: 'Bem-vindos!' }));
    for (let i = 0; i < 4; i++) hub.sendAsStreamer({ text: `m${i}` });
    expect(hub.sendAsStreamer({ text: 'too fast' })).toMatchObject({ ok: false, code: 'admin.chat.err.tooFast' });
  });

  it('a viewer can never get role streamer', () => {
    const { hub, join, send } = setup();
    const a = join('Ana');
    send(a, 'hi', 1);
    hub.flush();
    expect(a.sock.items().filter((i) => i.k === 'u').every((i) => i.k === 'u' && i.au.r === 'viewer')).toBe(true);
  });
});

describe('ChatHub: snapshots, resume, history', () => {
  it('hello snapshot: the last N items, my identity, roster for the authors shown', () => {
    const { hub, join, send, advance, settings } = setup({ slowModeS: 0, duplicateWindowS: 0 });
    settings.historyOnJoin = 3;
    hub.refresh();
    const a = join('Ana');
    for (let i = 1; i <= 5; i++) {
      advance(2100);
      send(a, `m${i}`, i);
    }
    const b = join('Bia');
    const snap = hub.snapshot(b.s)!;
    expect(snap.v).toBe(1);
    expect(snap.lastSeq).toBe(5);
    expect(snap.items.map((i) => i.k === 'm' && i.x)).toEqual(['m3', 'm4', 'm5']);
    expect(snap.roster.map((r) => r.n).sort()).toEqual(['Ana', 'Bia']);
    expect(snap.you.a).toBe(snap.roster.find((r) => r.n === 'Bia')!.a);
  });

  it('chat.resume: missing items come back; evicted ones bring a full reset', () => {
    const { hub, join, send, advance } = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const a = join('Ana');
    for (let i = 1; i <= 3; i++) {
      advance(2100);
      send(a, `m${i}`, i);
    }
    a.sock.clear();
    hub.frame(a.s, a.sock, '{"t":"chat.resume","after":1}');
    expect(a.sock.items().filter((i) => i.k === 'm').map((i) => i.k === 'm' && i.s)).toEqual([2, 3]);
    a.sock.clear();
    for (let i = 4; i <= 260; i++) {
      advance(2100);
      send(a, `n${i}`, i);
    }
    advance(5000);
    a.sock.clear();
    hub.frame(a.s, a.sock, '{"t":"chat.resume","after":1}');
    expect(last(a.sock)).toMatchObject({ t: 'chat.reset', v: 1, lastSeq: 260 });
  });

  it('ring caps: 200 items', () => {
    const { hub, join, send, advance } = setup({ slowModeS: 0, duplicateWindowS: 0 });
    const a = join('Ana');
    for (let i = 1; i <= 230; i++) {
      advance(2100);
      send(a, `m${i}`, i);
    }
    expect(hub.ringSize.items).toBe(200);
    expect(hub.ringSize.bytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('reset (Stop) wipes ring, mutes and roster; the next live starts at seq 1', () => {
    const { hub, join, send } = setup();
    const a = join('Ana');
    send(a, 'hi', 1);
    hub.mute(a.s.id, null);
    hub.reset();
    hub.begin();
    expect(hub.lastSeq).toBe(0);
    expect(hub.adminState().items).toEqual([]);
    expect(hub.moderation.muteCount).toBe(0);
  });
});

describe('ChatHub: limits and protection', () => {
  it('the global limit G comes from the upload budget and the audience', () => {
    const many = setup({}, 120).hub;
    const few = setup({}, 5).hub;
    // 4 % of 10 Mbps = 400 kbps = 50,000 B/s; / (120 × 70 B) ≈ 6 msg/s; few viewers hit the cap 20.
    expect(many.globalPerS()).toBeCloseTo(50_000 / (120 * 70), 5);
    expect(few.globalPerS()).toBe(20);
    expect(many.budgetBps()).toBe(50_000);
  });

  it('new-viewer wait and lockdown', () => {
    const { hub, join, send, settings, now } = setup({ newViewerWaitS: 60 });
    hub.refresh();
    const a = join('Ana');
    a.s.joinedAt = now() - 5_000;
    send(a, 'hi', 1);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.newViewer', params: { count: 55 } });
    settings.newViewerWaitS = 0;
    const old = join('Old');
    old.s.joinedAt = now() - 10 * 60_000;
    hub.setProtect('lockdown');
    a.s.joinedAt = now() - 30_000;
    send(a, 'hi', 2);
    expect(last(a.sock)).toMatchObject({ code: 'chat.err.protect' });
    send(old, 'still here', 1);
    expect(last(old.sock)).toMatchObject({ t: 'chat.ack' });
    expect(hub.effective.historyOnJoin).toBe(0);
    hub.setProtect('off');
    expect(hub.protection).toBe('off');
  });

  it('an internal error never escapes, and repeated ones stop only the chat', () => {
    const { hub, join, activity } = setup();
    const a = join('Ana');
    const boom = { ...a.sock, send: () => {} } as unknown as typeof a.sock;
    // A session object that throws on access: every frame faults.
    const bad = new Proxy(a.s, {
      get(t, k) {
        if (k === 'deviceId') throw new Error('boom');
        return Reflect.get(t, k);
      },
    });
    for (let i = 0; i < 7; i++) expect(() => hub.frame(bad, boom, '{"t":"chat.send","n":1,"text":"x"}')).not.toThrow();
    expect(hub.isBroken).toBe(true);
    expect(hub.effective.enabled).toBe(false);
    expect(activity.list().some((e) => e.code === 'log.chat.broken')).toBe(true);
  });

  it('rejects to one socket are coalesced (a flooding script gets silence)', () => {
    const { join, hub } = setup();
    const a = join('Ana');
    for (let i = 0; i < 20; i++) hub.frame(a.s, a.sock, '{"t":"chat.send","n":1,"text":{}}');
    expect(a.sock.messages().filter((m) => m.t === 'chat.reject').length).toBeLessThanOrEqual(3);
  });
});
