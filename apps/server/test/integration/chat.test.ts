import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ChatItem, ServerMessage } from '@swarmcast/shared';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { makeController } from '../unit/live-helpers.js';
import { Jar, joinAs } from './helpers.js';

// The chat on the real public server: real joins, real /control sockets, real batches.

const direct = { noteViewer: vi.fn(), snapshot: () => ({ active: false, viewersSeen: 0 }), active: false, ipChanged: null } as unknown as DirectMode;
const lives: LiveController[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const l of lives.splice(0)) await l.stop().catch(() => {});
});

async function startLive(chat: Partial<ReturnType<typeof defaultConfig>['chat']> = {}) {
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };
  config.security.requireBrowserCheck = false;
  config.chat = { ...config.chat, ...chat };
  const { live } = makeController(direct, { config });
  lives.push(live);
  await live.start();
  const base = `http://127.0.0.1:${live.publicPort}`;
  return { live, base, link: live.liveLink! };
}

type Viewer = { ws: WebSocket; messages: ServerMessage[]; closed: Promise<number>; send: (m: object) => void; items: () => ChatItem[] };

async function openControl(base: string, jar: Jar, query = ''): Promise<Viewer> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/control${query}`, { origin: base, headers: { cookie: jar.header() } });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => {
    const text = String(d);
    if (!text.startsWith('~')) messages.push(JSON.parse(text) as ServerMessage);
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await vi.waitFor(() => expect(messages.some((m) => m.t === 'hello')).toBe(true));
  return {
    ws,
    messages,
    closed,
    // The viewer always serialises `t` first, as the server's cheap pre-parse checks expect.
    send: (m) => ws.send(JSON.stringify(m)),
    items: () => messages.flatMap((m) => (m.t === 'chat.batch' ? m.items : m.t === 'chat.reset' ? m.items : [])),
  };
}

const hello = (v: Viewer) => v.messages.find((m) => m.t === 'hello') as Extract<ServerMessage, { t: 'hello' }>;
const lastOf = <T extends ServerMessage['t']>(v: Viewer, t: T) => v.messages.filter((m) => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;

describe('chat over /control', () => {
  it('two viewers: a message from A reaches B within 600 ms with seq, author and colour; A gets an ack', async () => {
    const { base, link } = await startLive();
    const a = await openControl(base, await joinAs(base, link, 'Ana'));
    const b = await openControl(base, await joinAs(base, link, 'Bia'));
    expect(hello(b).chat).toMatchObject({ v: 1, lastSeq: 0, settings: { enabled: true, slowS: 2, maxGraphemes: 200 } });
    const t0 = Date.now();
    a.send({ t: 'chat.send', n: 1, text: 'boa noite chat 😀' });
    await vi.waitFor(() => expect(b.items().some((i) => i.k === 'm')).toBe(true), { timeout: 2000, interval: 10 });
    expect(Date.now() - t0).toBeLessThanOrEqual(600);
    expect(lastOf(a, 'chat.ack')).toEqual({ t: 'chat.ack', n: 1, s: 1 });
    const msg = b.items().find((i) => i.k === 'm')!;
    const au = b.items().find((i) => i.k === 'u');
    expect(msg).toMatchObject({ s: 1, x: 'boa noite chat 😀' });
    expect(au).toMatchObject({ au: { a: msg.k === 'm' ? msg.a : '', n: 'Ana', r: 'viewer', c: expect.stringMatching(/^#[0-9a-f]{6}$/) } });
  });

  it('slow mode answers with chat.err.slow and retryMs; the socket stays open', async () => {
    const { base, link } = await startLive();
    const a = await openControl(base, await joinAs(base, link, 'Ana'));
    a.send({ t: 'chat.send', n: 1, text: 'one' });
    a.send({ t: 'chat.send', n: 2, text: 'two' });
    await vi.waitFor(() => expect(lastOf(a, 'chat.reject')).toMatchObject({ n: 2, code: 'chat.err.slow', retryMs: expect.any(Number) }));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a script sending 21 chat frames in 10 s loses the socket; a legitimate burst never does', async () => {
    const { base, link } = await startLive({ slowModeS: 0, duplicateWindowS: 0 });
    const ok = await openControl(base, await joinAs(base, link, 'Ana'));
    for (let i = 1; i <= 5; i++) ok.send({ t: 'chat.send', n: i, text: `m${i}` });
    await vi.waitFor(() => expect(ok.messages.filter((m) => m.t === 'chat.ack')).toHaveLength(5));
    const bot = await openControl(base, await joinAs(base, link, 'Bot'));
    for (let i = 1; i <= 21; i++) bot.send({ t: 'chat.send', n: i, text: `spam ${i}` });
    expect(await bot.closed).toBe(1006);
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('mute for 1 min survives leaving and rejoining from the same device; unmute applies at once', async () => {
    const { live, base, link } = await startLive({ slowModeS: 0 });
    const jar = await joinAs(base, link, 'Ana');
    let a = await openControl(base, jar);
    const sid = hello(a).sessionId;
    expect(live.chat.mute(sid, 1)).toBe(true);
    await vi.waitFor(() => expect(lastOf(a, 'chat.you')?.you.mutedUntil).toEqual(expect.any(Number)));
    a.ws.close();
    await joinAs(base, link, 'Ana', jar);
    a = await openControl(base, jar);
    expect(hello(a).chat?.you.mutedUntil).toEqual(expect.any(Number));
    a.send({ t: 'chat.send', n: 1, text: 'hi' });
    await vi.waitFor(() => expect(lastOf(a, 'chat.reject')).toMatchObject({ code: 'chat.err.muted' }));
    live.chat.unmute(hello(a).sessionId);
    a.send({ t: 'chat.send', n: 2, text: 'free' });
    await vi.waitFor(() => expect(lastOf(a, 'chat.ack')).toMatchObject({ n: 2 }));
  });

  it('nicknames: look-alikes of a live viewer are taken (with a suggestion); reserved names are refused', async () => {
    const { base, link } = await startLive();
    await openControl(base, await joinAs(base, link, 'ana'));
    await openControl(base, await joinAs(base, link, 'cope'));
    for (const [nick, code] of [
      ['Ana', 'nickname.taken'],
      // All Cyrillic, so one script, but it looks like "cope".
      ['\u{441}\u{43E}\u{440}\u{435}', 'nickname.taken'],
      ['\u{430}na', 'nickname.mixed'],
      ['Streamer', 'nickname.reserved'],
      ['Ana😀', 'nickname.chars'],
      ['A', 'nickname.tooShort'],
      ['\u{3164}\u{3164}', 'nickname.chars'],
    ] as const) {
      const jar = new Jar(base);
      await jar.fetch(link);
      const res = await jar.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: nick }) });
      expect(res.status, nick).toBe(400);
      const body = (await res.json()) as { code: string; params?: { suggestion?: string } };
      expect(body.code, nick).toBe(code);
      if (code === 'nickname.taken') expect(body.params?.suggestion).toBe(`${nick}2`);
    }
  });

  it('a settings change reaches every socket once (coalesced)', async () => {
    const { live, base, link } = await startLive();
    const a = await openControl(base, await joinAs(base, link, 'Ana'));
    const b = await openControl(base, await joinAs(base, link, 'Bia'));
    live.updateChatSettings({ ...live.chatSettings(), slowModeS: 10 });
    live.updateChatSettings({ ...live.chatSettings(), slowModeS: 30 });
    await vi.waitFor(() => expect(lastOf(b, 'chat.settings')?.settings.slowS).toBe(30), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 1200));
    for (const v of [a, b]) expect(v.messages.filter((m) => m.t === 'chat.settings').length).toBeLessThanOrEqual(2);
    expect(() => live.updateChatSettings({ ...live.chatSettings(), streamerName: 'Str\u{202E}eamer' })).toThrow();
  });

  it('chat.resume returns the missing items; history on join is 50 and 0 under lockdown', async () => {
    const { live, base, link } = await startLive({ slowModeS: 0, duplicateWindowS: 0 });
    for (let i = 0; i < 60; i++) live.chat.sendAsStreamer({ text: `m${i}` });
    // (the anti-mistake limit lets 5 through; post the rest as system lines through the hub)
    for (let i = 0; i < 55; i++) live.chat.system('chat.sys.protectOff');
    const a = await openControl(base, await joinAs(base, link, 'Ana'));
    expect(hello(a).chat?.items).toHaveLength(50);
    a.send({ t: 'chat.resume', after: 55 });
    await vi.waitFor(() => expect(a.messages.some((m) => m.t === 'chat.batch' && m.items.some((i) => i.k === 'sys' && i.s === 56))).toBe(true));
    live.chat.setProtect('lockdown');
    const b = await openControl(base, await joinAs(base, link, 'Bia'));
    expect(hello(b).chat?.items).toHaveLength(0);
    expect(hello(b).chat?.settings.protect).toBe('lockdown');
  });

  it('a kick during a chat flood reaches the target within 1 s', async () => {
    const { live, base, link } = await startLive({ slowModeS: 0, duplicateWindowS: 0 });
    const target = await openControl(base, await joinAs(base, link, 'Tia'));
    const flooders = await Promise.all(['Fa', 'Fb', 'Fc'].map(async (n) => openControl(base, await joinAs(base, link, n))));
    let n = 0;
    const flood = setInterval(() => {
      for (const f of flooders) f.send({ t: 'chat.send', n: ++n, text: `flood ${n}` });
    }, 50);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    live.kick(hello(target).sessionId);
    await vi.waitFor(() => expect(target.messages.some((m) => m.t === 'kicked')).toBe(true), { timeout: 2000, interval: 5 });
    clearInterval(flood);
    expect(Date.now() - t0).toBeLessThanOrEqual(1000);
  });

  it('a reconnect with ?chatAfter gets only the delta, and does not count as an upgrade for the shield', async () => {
    const { live, base, link } = await startLive({ slowModeS: 0, duplicateWindowS: 0 });
    const jar = await joinAs(base, link, 'Ana');
    const upgrade = vi.spyOn(live.shield, 'upgrade');
    let a = await openControl(base, jar);
    expect(upgrade).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 3; i++) {
      a.send({ t: 'chat.send', n: i, text: `m${i}` });
      await vi.waitFor(() => expect(lastOf(a, 'chat.ack')).toMatchObject({ n: i }));
    }
    a.ws.close();
    await a.closed;
    live.chat.sendAsStreamer({ text: 'while you were away' });
    a = await openControl(base, jar, '?chatAfter=3');
    const chat = hello(a).chat!;
    expect(chat.delta).toBe(true);
    expect(chat.items.map((i) => (i.k === 'm' ? i.x : i.k))).toEqual(['while you were away']);
    expect(chat.lastSeq).toBe(4);
    // The reconnect of a known session is not an attack signal.
    expect(upgrade).toHaveBeenCalledTimes(1);
    // A refused upgrade (no session) still counts.
    const stranger = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base });
    sockets.push(stranger);
    await new Promise((r) => stranger.once('error', r));
    expect(upgrade).toHaveBeenCalledTimes(2);
  });

  it('Stop wipes the chat; the next live starts at seq 1', async () => {
    const { live, base, link } = await startLive();
    const a = await openControl(base, await joinAs(base, link, 'Ana'));
    a.send({ t: 'chat.send', n: 1, text: 'hi' });
    await vi.waitFor(() => expect(lastOf(a, 'chat.ack')).toBeDefined());
    live.chat.mute(hello(a).sessionId, null);
    await live.stop();
    expect(live.chat.lastSeq).toBe(0);
    expect(live.chat.moderation.muteCount).toBe(0);
    await live.start();
    const base2 = `http://127.0.0.1:${live.publicPort}`;
    const b = await openControl(base2, await joinAs(base2, live.liveLink!, 'Ana'));
    expect(hello(b).chat?.lastSeq).toBe(0);
    b.send({ t: 'chat.send', n: 1, text: 'again' });
    await vi.waitFor(() => expect(lastOf(b, 'chat.ack')).toMatchObject({ s: 1 }));
  });
});
