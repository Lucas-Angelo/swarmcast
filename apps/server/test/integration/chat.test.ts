import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import type { LiveController } from '../../src/core/live.js';
import { Jar, joinAs } from './helpers.js';
import { goLive, openControl, startViewerLive, stopViewerLives, upgradeStatus, viewerLive, type ControlClient } from './viewers.js';

// The chat on the real public server: real joins, real /control sockets, real batches (a
// LiveController in this process; MediaMTX is stood in, see viewers.ts).
//
// Latencies are measured from the action to the message's arrival at the viewer (each wait is
// on the message itself): a chat message reaches the other viewers within CHAT_LATENCY_MS, a
// kick reaches its target within KICK_LATENCY_MS even while the chat is flooded.

/** A chat message reaches the others within this: the 250 ms batch window plus delivery. */
const CHAT_LATENCY_MS = 600;
/** A kick reaches its target within this, flood or not (control messages are never batched). */
const KICK_LATENCY_MS = 1000;
/**
 * Flood messages the target has received before the kick: the flood runs through the server
 * (the three flooders are accepted, batched and delivered), not just from the test.
 */
const FLOOD_UNDER_WAY = 6;

/** Nicknames refused while "ana" and "cope" watch, and why. */
const NICKNAME_REFUSALS = [
  ['Ana', 'nickname.taken'],
  // All Cyrillic, so one script, but it looks like "cope".
  ['\u{441}\u{43E}\u{440}\u{435}', 'nickname.taken'],
  ['\u{430}na', 'nickname.mixed'],
  ['Streamer', 'nickname.reserved'],
  ['Ana😀', 'nickname.chars'],
  ['A', 'nickname.tooShort'],
  ['\u{3164}\u{3164}', 'nickname.chars'],
] as const;

afterEach(stopViewerLives);

/** What the viewer page sends for message `n`. */
const say = (n: number, text: string) => ({ t: 'chat.send', n, text });

/** A viewer on a fresh join: the socket and its hello. */
async function viewer(base: string, link: string, nickname: string, jar?: Jar): Promise<ControlClient> {
  return openControl(base, await joinAs(base, link, nickname, jar));
}

/**
 * A round trip on the viewer's socket (a message and its ack): whatever the server sent the
 * viewer before it answered has arrived by then. Needs slow mode not to hold this message back.
 */
async function roundTrip(v: ControlClient, n: number): Promise<void> {
  v.send(say(n, `round trip ${n}`));
  await v.next('chat.ack', (m) => m.n === n);
}

/** Every flooder sends a message every `everyMs`, until the returned function is called. */
function flood(flooders: ControlClient[], everyMs = 50): () => void {
  let n = 0;
  const timer = setInterval(() => {
    for (const f of flooders) f.send(say(++n, `flood ${n}`));
  }, everyMs);
  return () => clearInterval(timer);
}

/**
 * 110 chat lines (seq 1 to 110): the streamer's anti-mistake limit lets 5 of their own messages
 * through, so the rest are system lines posted through the hub.
 */
function fillHistory(live: LiveController): void {
  for (let i = 0; i < 60; i++) live.chat.sendAsStreamer({ text: `m${i}` });
  for (let i = 0; i < 55; i++) live.chat.system('chat.sys.protectOff');
}

describe('chat over /control', () => {
  it(`two viewers: a message from A reaches B within ${CHAT_LATENCY_MS} ms with seq, author and colour; A gets an ack`, async () => {
    // Arrange
    const { base, link } = await startViewerLive();
    const a = await viewer(base, link, 'Ana');
    const b = await viewer(base, link, 'Bia');
    // Act
    const sentAt = Date.now();
    a.send(say(1, 'boa noite chat 😀'));
    await b.until(() => b.items().some((i) => i.k === 'm'), 'the message at B');
    const latencyMs = Date.now() - sentAt;
    const ack = await a.next('chat.ack');
    // Assert
    expect(b.hello.chat).toMatchObject({ v: 1, lastSeq: 0, settings: { enabled: true, slowS: 2, maxGraphemes: 200 } });
    expect(latencyMs).toBeLessThanOrEqual(CHAT_LATENCY_MS);
    expect(ack).toEqual({ t: 'chat.ack', n: 1, s: 1 });
    const msg = b.items().find((i) => i.k === 'm')!;
    expect(msg).toMatchObject({ s: 1, x: 'boa noite chat 😀' });
    expect(b.items().find((i) => i.k === 'u')).toMatchObject({ au: { a: msg.k === 'm' ? msg.a : '', n: 'Ana', r: 'viewer', c: expect.stringMatching(/^#[0-9a-f]{6}$/) } });
  });

  it('slow mode answers with chat.err.slow and retryMs; the socket stays open and keeps answering', async () => {
    // Arrange
    const { base, link } = await startViewerLive();
    const a = await viewer(base, link, 'Ana');
    // Act
    a.send(say(1, 'one'));
    a.send(say(2, 'two'));
    const slow = await a.next('chat.reject', (m) => m.n === 2);
    a.send(say(3, 'three'));
    const again = await a.next('chat.reject', (m) => m.n === 3);
    // Assert
    expect(slow).toMatchObject({ n: 2, code: 'chat.err.slow', retryMs: expect.any(Number) });
    expect(again).toMatchObject({ code: 'chat.err.slow' });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a script sending 21 chat frames in 10 s loses the socket; a legitimate burst never does', async () => {
    // Arrange
    const { base, link } = await startViewerLive({ chat: { slowModeS: 0, duplicateWindowS: 0 } });
    const ok = await viewer(base, link, 'Ana');
    const bot = await viewer(base, link, 'Bot');
    // Act
    for (let i = 1; i <= 5; i++) ok.send(say(i, `m${i}`));
    await ok.until(() => ok.all('chat.ack').length === 5, 'five acks');
    for (let i = 1; i <= 21; i++) bot.send(say(i, `spam ${i}`));
    const botClosedWith = await bot.closed;
    // Assert
    expect(botClosedWith).toBe(1006);
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('mute for 1 min survives leaving and rejoining from the same device; unmute applies at once', async () => {
    // Arrange
    const { live, base, link } = await startViewerLive({ chat: { slowModeS: 0 } });
    const jar = await joinAs(base, link, 'Ana');
    const first = await openControl(base, jar);
    // Act
    const muted = live.chat.mute(first.hello.sessionId, 1);
    await first.next('chat.you', (m) => typeof m.you.mutedUntil === 'number');
    first.ws.close();
    await first.closed;
    const back = await viewer(base, link, 'Ana', jar);
    back.send(say(1, 'hi'));
    const refused = await back.next('chat.reject');
    // Assert
    expect(muted).toBe(true);
    expect(back.hello.chat?.you.mutedUntil).toEqual(expect.any(Number));
    expect(refused).toMatchObject({ code: 'chat.err.muted' });
    // Act
    live.chat.unmute(back.hello.sessionId);
    back.send(say(2, 'free'));
    const ack = await back.next('chat.ack');
    // Assert
    expect(ack).toMatchObject({ n: 2 });
  });

  it('nicknames: look-alikes of a live viewer are taken (with a suggestion); reserved names are refused', async () => {
    // Arrange
    const { base, link } = await startViewerLive();
    await viewer(base, link, 'ana');
    await viewer(base, link, 'cope');
    // Act
    const answers = [];
    for (const [nickname] of NICKNAME_REFUSALS) {
      const jar = new Jar(base);
      await jar.fetch(link);
      const res = await jar.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) });
      answers.push({ nickname, status: res.status, ...((await res.json()) as object) });
    }
    // Assert
    expect(answers).toMatchObject(
      NICKNAME_REFUSALS.map(([nickname, code]) => ({ nickname, status: 400, code, ...(code === 'nickname.taken' ? { params: { suggestion: `${nickname}2` } } : {}) })),
    );
  });

  it('two settings changes in a row reach every socket once, with the last values (coalesced)', async () => {
    // Arrange
    const { live, base, link } = await startViewerLive();
    const viewers = [await viewer(base, link, 'Ana'), await viewer(base, link, 'Bia')];
    // Act
    live.updateChatSettings({ ...live.chatSettings(), slowModeS: 10 });
    live.updateChatSettings({ ...live.chatSettings(), slowModeS: 30 });
    for (const v of viewers) await v.next('chat.settings', (m) => m.settings.slowS === 30);
    for (const v of viewers) await roundTrip(v, 1);
    // Assert
    expect(viewers.map((v) => v.all('chat.settings').map((m) => m.settings.slowS))).toEqual([[30], [30]]);
  });

  it('refuses a streamer chat name with a bidi override', () => {
    // Arrange
    const live = viewerLive();
    // Act
    const save = () => live.updateChatSettings({ ...live.chatSettings(), streamerName: 'Str\u{202E}eamer' });
    // Assert
    expect(save).toThrow();
  });

  it('chat.resume returns the missing items; history on join is 50 and 0 under lockdown', async () => {
    // Arrange
    const { live, base, link } = await startViewerLive({ chat: { slowModeS: 0, duplicateWindowS: 0 } });
    fillHistory(live);
    const a = await viewer(base, link, 'Ana');
    // Act
    a.send({ t: 'chat.resume', after: 55 });
    const resumed = await a.next('chat.batch');
    live.chat.setProtect('lockdown');
    const b = await viewer(base, link, 'Bia');
    // Assert
    expect(a.hello.chat?.items).toHaveLength(50);
    expect(resumed.items.flatMap((i) => ('s' in i && typeof i.s === 'number' ? [i.s] : []))).toEqual([56, 57, 58, 59, 60]);
    expect(b.hello.chat?.items).toHaveLength(0);
    expect(b.hello.chat?.settings.protect).toBe('lockdown');
  });

  it(`a kick during a chat flood reaches the target within ${KICK_LATENCY_MS} ms`, async () => {
    // Arrange
    const { live, base, link } = await startViewerLive({ chat: { slowModeS: 0, duplicateWindowS: 0 } });
    const target = await viewer(base, link, 'Tia');
    const flooders = await Promise.all(['Fa', 'Fb', 'Fc'].map((n) => viewer(base, link, n)));
    onTestFinished(flood(flooders));
    await target.until(() => target.items().filter((i) => i.k === 'm').length >= FLOOD_UNDER_WAY, 'the flood at the target');
    // Act
    const kickedAt = Date.now();
    live.kick(target.hello.sessionId);
    await target.next('kicked');
    const latencyMs = Date.now() - kickedAt;
    // Assert
    expect(latencyMs).toBeLessThanOrEqual(KICK_LATENCY_MS);
  });

  it('a reconnect with ?chatAfter gets only the delta, and does not count as an upgrade for the shield', async () => {
    // Arrange
    const { live, base, link } = await startViewerLive({ chat: { slowModeS: 0, duplicateWindowS: 0 } });
    const jar = await joinAs(base, link, 'Ana');
    const upgrade = vi.spyOn(live.shield, 'upgrade');
    const first = await openControl(base, jar);
    const afterFirstConnect = upgrade.mock.calls.length;
    for (let i = 1; i <= 3; i++) {
      first.send(say(i, `m${i}`));
      await first.next('chat.ack', (m) => m.n === i);
    }
    first.ws.close();
    await first.closed;
    live.chat.sendAsStreamer({ text: 'while you were away' });
    // Act
    const back = await openControl(base, jar, { query: '?chatAfter=3' });
    const afterReconnect = upgrade.mock.calls.length;
    const stranger = await upgradeStatus(`${base.replace('http', 'ws')}/control`, { origin: base });
    const afterStranger = upgrade.mock.calls.length;
    // Assert
    const chat = back.hello.chat!;
    expect(chat.delta).toBe(true);
    expect(chat.items.map((i) => (i.k === 'm' ? i.x : i.k))).toEqual(['while you were away']);
    expect(chat.lastSeq).toBe(4);
    expect(stranger).toBe(401);
    expect({ afterFirstConnect, afterReconnect, afterStranger }).toEqual({ afterFirstConnect: 1, afterReconnect: 1, afterStranger: 2 });
  });

  it('Stop wipes the chat; the next live starts at seq 1', async () => {
    // Arrange
    const { live, base, link } = await startViewerLive();
    const a = await viewer(base, link, 'Ana');
    a.send(say(1, 'hi'));
    await a.next('chat.ack');
    live.chat.mute(a.hello.sessionId, null);
    // Act
    await live.stop();
    const wiped = { lastSeq: live.chat.lastSeq, mutes: live.chat.moderation.muteCount };
    const next = await goLive(live);
    const b = await viewer(next.base, next.link, 'Ana');
    b.send(say(1, 'again'));
    const ack = await b.next('chat.ack');
    // Assert
    expect(wiped).toEqual({ lastSeq: 0, mutes: 0 });
    expect(b.hello.chat?.lastSeq).toBe(0);
    expect(ack).toMatchObject({ s: 1 });
  });
});
