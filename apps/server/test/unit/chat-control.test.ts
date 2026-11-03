import type { IncomingMessage } from 'node:http';
import fc from 'fast-check';
import type { WebSocket } from 'ws';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CHAT_FRAME_PREFIX, CHAT_REACT_FRAME_PREFIX, CHAT_REACT_FRAMES_MAX_PER_10S, CHAT_REACT_FRAMES_PER_10S, defaultChatSettings, validateNickname, type ChatSettings } from '@swarmcast/shared';
import { AccessControl } from '../../src/access/access.js';
import { ChatHub } from '../../src/chat/hub.js';
import { chatFrameKind, ControlChannel } from '../../src/control/control.js';
import { ActivityLog } from '../../src/core/activity.js';
import { FakeControlSocket, manualClock, silentLog } from './helpers.js';
import { joinViewer } from './helpers-b.js';

// The chat rides on the viewer's /control WebSocket (control/control.ts). Chat frames have a
// budget of their own (20 per 10 s, CHAT_MAX_FRAMES_PER_10S) next to the control budget (30 per
// 10 s): a socket over either is terminated, and nothing else terminates it but binary frames.
// Reaction frames (`chat.react`, reserved for 0.5.0) have yet another budget: 10 per 10 s are
// handed on, up to 20 are ignored, the 21st terminates; they never count as chat frames.

const REQ = { url: '/control' } as IncomingMessage;

/** A live access, its control channel and chat on one manual clock, and a viewer (10 min in) on it. */
function setup(over: Partial<ChatSettings> = {}) {
  const clock = manualClock(Date.UTC(2026, 9, 26));
  const access = new AccessControl(clock.now);
  access.begin();
  const control = new ControlChannel(access, silentLog, clock.now);
  const settings = { ...defaultChatSettings(), ...over };
  const hub = new ChatHub({
    access,
    host: control,
    settings: () => settings,
    uploadCapMbps: () => 10,
    viewers: () => 2,
    activity: new ActivityLog(),
    log: silentLog,
    now: clock.now,
    guard: { sample: () => ({ p99Ms: 0, elu: 0 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  control.chat = hub;
  onTestFinished(() => {
    hub.reset();
    control.close();
  });
  const s = joinViewer(access, 'Ana', { deviceId: 'dev' });
  s.joinedAt = clock.now() - 600_000;
  /** A new control socket of the viewer, attached like an accepted upgrade. */
  const connect = (): FakeControlSocket => {
    const sock = new FakeControlSocket();
    control.attach(sock as unknown as WebSocket, s, REQ);
    return sock;
  };
  return { access, control, hub, s, settings, clock, connect };
}

/** Random text, hostile chat frames, odd JSON, prototype tricks, tracker frames and raw bytes. */
const fuzzFrame = fc.oneof(
  fc.string({ maxLength: 300 }),
  fc.string({ unit: 'binary', maxLength: 300 }).map((x) => `{"t":"chat.send","n":1,"text":${JSON.stringify(x)}}`),
  fc.json().map((j) => `{"t":"chat.${['send', 'color', 'resume', 'x', 'react', 'reactx'][j.length % 6]}",${j.startsWith('{') ? j.slice(1) : `"v":${j}}`}`),
  fc.array(fc.nat({ max: 99 }), { maxLength: 12 }).map((c) => `{"t":"chat.react","c":${JSON.stringify(c)}}`),
  fc.constantFrom('{"t":"chat.send","n":1,"text":{"__proto__":{"x":1}}}', '{"t":"chat.send","constructor":{"prototype":{}}}', '{"t":"chat.color","color":"#zzzzzz"}', '{"t":"chat.resume","after":1e308}', '{"t":"chat.send"', '~o1', '~d1 x'),
  fc.uint8Array({ maxLength: 64 }).map((u) => Buffer.from(u)),
  // Replies and mentions with hostile values: huge, fractional, negative or wrong-typed seqs, key lists
  // too long, nested, or of the wrong shape (docs/CHAT.md, "Replies and mentions").
  fc
    .tuple(
      fc.oneof(fc.integer(), fc.double(), fc.string({ maxLength: 12 }), fc.constant(null), fc.array(fc.nat(), { maxLength: 3 }), fc.constantFrom(1, 2, 3, 2 ** 53, -1, 0)),
      fc.oneof(fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }), fc.array(fc.constantFrom('1', '2', 'a', 'zz'), { maxLength: 4 }), fc.string({ maxLength: 12 }), fc.json({ maxDepth: 3 })),
    )
    .map(([re, mn]) => `{"t":"chat.send","n":1,"text":"@Ana oi","re":${JSON.stringify(re) ?? 'null'},"mn":${typeof mn === 'string' && mn.startsWith('{') ? mn : JSON.stringify(mn)}}`),
  // Votes with hostile values (docs/CHAT.md, "Polls and predictions"): odd ids, options, nonces.
  fc
    .tuple(fc.oneof(fc.constantFrom('p1', 'p2', 'P1', 'p', 'p1x'), fc.string({ maxLength: 14 }), fc.integer()), fc.oneof(fc.integer({ min: -2, max: 6 }), fc.double(), fc.string({ maxLength: 3 }), fc.constant(null)), fc.oneof(fc.nat(), fc.constant(2 ** 40)))
    .map(([id, o, n]) => `{"t":"chat.vote","n":${n},"id":${JSON.stringify(id)},"o":${JSON.stringify(o) ?? 'null'}}`),
);

/**
 * The fuzz property over up to 30 frames. Each run is a fresh socket of the viewer, 11 s after the
 * previous run, so every run starts with full budgets. No frame throws; 20 chat frames or fewer
 * (with at most 30 frames in all) stay within both budgets, so the socket is not terminated; the
 * ring stays capped and the chat healthy.
 */
function frameFuzz({ hub, clock, connect }: ReturnType<typeof setup>) {
  return fc.property(fc.array(fuzzFrame, { maxLength: 30 }), (frames) => {
    clock.advance(11_000);
    const sock = connect();
    const kinds = frames.map((f) => chatFrameKind(typeof f === 'string' ? Buffer.from(f) : f));
    const chat = kinds.filter((k) => k === 'chat').length;
    const react = kinds.filter((k) => k === 'react').length;
    for (const f of frames) expect(() => sock.receive(f)).not.toThrow();
    // One viewer, one device: whatever it sends, a poll counts at most one vote from it.
    expect((hub.poll?.c ?? []).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
    if (chat <= 20 && react <= CHAT_REACT_FRAMES_MAX_PER_10S) expect(sock.terminate).not.toHaveBeenCalled();
    expect(hub.ringSize.items).toBeLessThanOrEqual(200);
    expect(hub.isBroken).toBe(false);
    // A reply only ever names a message the ring held; mentions only ever name people who wrote.
    const state = hub.adminState();
    const authors = new Set(state.roster.map((r) => r.a));
    for (const m of state.items) {
      if (m.k !== 'm') continue;
      if (m.re) expect(Number.isSafeInteger(m.re.s) && m.re.s >= 1 && m.re.s < m.s).toBe(true);
      for (const a of m.mn ?? []) expect(authors.has(a)).toBe(true);
      expect((m.mn ?? []).length).toBeLessThanOrEqual(3);
    }
    sock.emit('close');
    return true;
  });
}

describe('chat on /control', () => {
  it('chat frames have their own budget: 20 per 10 s never cost the control budget, 21 terminate', () => {
    // Arrange
    const { connect } = setup({ slowModeS: 0 });
    const sock = connect();
    // Act
    for (let i = 1; i <= 20; i++) sock.receive(`{"t":"chat.send","n":${i},"text":"m${i}"}`);
    for (let i = 0; i < 29; i++) sock.receive('{"t":"pong"}');
    // Assert
    expect(sock.terminate).not.toHaveBeenCalled();
    // Act
    sock.receive('{"t":"chat.send","n":21,"text":"x"}');
    // Assert
    expect(sock.terminate).toHaveBeenCalledOnce();
  });

  it('a vote is a chat frame: votes and messages share the 20-per-10-s budget; the vote comes back as chat.voted on that socket', () => {
    // Arrange
    const { connect, hub } = setup({ slowModeS: 0 });
    hub.startPoll({ kind: 'poll', question: 'Q?', options: ['a', 'b'], seconds: 60 });
    const sock = connect();
    // Act
    sock.receive('{"t":"chat.vote","n":1,"id":"p1","o":1}');
    for (let i = 2; i <= 20; i++) sock.receive(i % 2 ? `{"t":"chat.vote","n":${i},"id":"p1","o":0}` : `{"t":"chat.send","n":${i},"text":"m${i}"}`);
    const kept = !sock.terminate.mock.calls.length;
    sock.receive('{"t":"chat.vote","n":21,"id":"p1","o":0}');
    // Assert
    expect(kept).toBe(true);
    expect(sock.terminate).toHaveBeenCalledOnce();
    expect(sock.sent.map((d) => JSON.parse(d) as { t: string })).toContainEqual({ t: 'chat.voted', n: 1, id: 'p1', o: 1, c: [0, 1] });
    expect(hub.poll?.c).toEqual([0, 1]);
  });

  it('reaction frames have their own budget: 20 chat frames and 10 reaction frames in 10 s keep the socket', () => {
    // Arrange
    const { connect, hub } = setup({ slowModeS: 0 });
    const sock = connect();
    const frame = vi.spyOn(hub, 'frame');
    // Act
    for (let i = 1; i <= 20; i++) {
      sock.receive(`{"t":"chat.send","n":${i},"text":"m${i}"}`);
      if (i <= CHAT_REACT_FRAMES_PER_10S) sock.receive('{"t":"chat.react","c":[1]}');
    }
    // Assert
    expect(sock.terminate).not.toHaveBeenCalled();
    expect(frame).toHaveBeenCalledTimes(20 + CHAT_REACT_FRAMES_PER_10S);
  });

  it(`reaction frames past ${CHAT_REACT_FRAMES_PER_10S} per 10 s are ignored, past ${CHAT_REACT_FRAMES_MAX_PER_10S} the socket is terminated`, () => {
    // Arrange
    const { connect, hub, clock } = setup();
    const sock = connect();
    const frame = vi.spyOn(hub, 'frame');
    // Act
    for (let i = 0; i < CHAT_REACT_FRAMES_MAX_PER_10S; i++) sock.receive('{"t":"chat.react","c":[1]}');
    // Assert
    expect(frame).toHaveBeenCalledTimes(CHAT_REACT_FRAMES_PER_10S);
    expect(sock.terminate).not.toHaveBeenCalled();
    expect(sock.sent.filter((d) => d.startsWith('{"t":"chat.reject"'))).toEqual([]);
    // Act
    clock.advance(10_001);
    sock.receive('{"t":"chat.react","c":[1]}');
    // Assert
    expect(frame).toHaveBeenCalledTimes(CHAT_REACT_FRAMES_PER_10S + 1);
    // Act
    for (let i = 0; i < CHAT_REACT_FRAMES_MAX_PER_10S; i++) sock.receive('{"t":"chat.react","c":[1]}');
    // Assert
    expect(sock.terminate).toHaveBeenCalledOnce();
  });

  it('an oversized reaction frame is dropped before it is decoded, without a reply', () => {
    // Arrange
    const { connect, hub } = setup();
    const sock = connect();
    const big = Buffer.from(`{"t":"chat.react","c":[${'1,'.repeat(1500)}1]}`);
    const toString = vi.spyOn(big, 'toString');
    const frame = vi.spyOn(hub, 'frame');
    const before = sock.sent.length;
    // Act
    sock.receive(big);
    // Assert
    expect(toString).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
    expect(sock.sent).toHaveLength(before);
    expect(sock.terminate).not.toHaveBeenCalled();
  });

  it('a reaction frame reaches the hub, which has nothing to do with it yet: no reply, no item, no fault', () => {
    // Arrange
    const { connect, hub } = setup();
    const sock = connect();
    const before = sock.sent.length;
    // Act
    sock.receive('{"t":"chat.react","c":[2,0,1],"t":"chat.send","n":1,"text":"smuggled"}');
    hub.flush();
    // Assert
    expect(sock.sent).toHaveLength(before);
    expect(hub.lastSeq).toBe(0);
    expect(hub.isBroken).toBe(false);
  });

  it('frame kinds come from the first bytes only: chat.react (closing quote included) or any other chat frame', () => {
    // Arrange
    const cases = ['{"t":"chat.react","c":[1]}', '{"t":"chat.react"', '{"t":"chat.reactx","c":[1]}', '{"t":"chat.send","n":1}', '{"t":"chat.', '{"t":"chat', ' {"t":"chat.react"}', '{"t":"stats"}', ''];
    // Act
    const kinds = cases.map((c) => chatFrameKind(Buffer.from(c)));
    // Assert
    expect(kinds).toEqual(['react', 'react', 'chat', 'chat', 'chat', null, null, null, null]);
  });

  it('frame kinds (fuzz): react exactly when the bytes start with the react prefix, chat when they start with the chat prefix otherwise', () => {
    // Arrange
    const bytes = fc.oneof(
      fc.uint8Array({ maxLength: 40 }).map((u) => Buffer.from(u)),
      fc.string({ maxLength: 40 }).map((x) => Buffer.from(CHAT_FRAME_PREFIX + x)),
      fc.string({ maxLength: 40 }).map((x) => Buffer.from(CHAT_REACT_FRAME_PREFIX + x)),
      fc.integer({ min: 0, max: CHAT_REACT_FRAME_PREFIX.length }).map((n) => Buffer.from(CHAT_REACT_FRAME_PREFIX.slice(0, n))),
    );
    const property = fc.property(bytes, (b) => {
      const text = b.toString('latin1');
      const want = text.startsWith(CHAT_REACT_FRAME_PREFIX) ? 'react' : text.startsWith(CHAT_FRAME_PREFIX) ? 'chat' : null;
      return chatFrameKind(b) === want;
    });
    // Act
    const run = () => fc.assert(property, { numRuns: 2000, seed: 17 });
    // Assert
    expect(run).not.toThrow();
  });

  it('a raw frame over 2 KB is refused before it is decoded, without closing the socket', () => {
    // Arrange
    const { connect } = setup();
    const sock = connect();
    const big = Buffer.from(`{"t":"chat.send","n":1,"text":"${'a'.repeat(3000)}"}`);
    const toString = vi.spyOn(big, 'toString');
    // Act
    sock.receive(big);
    // Assert
    expect(toString).not.toHaveBeenCalled();
    expect(JSON.parse(sock.sent.at(-1)!)).toMatchObject({ t: 'chat.reject', code: 'text.tooLong' });
    expect(sock.terminate).not.toHaveBeenCalled();
    expect(sock.close).not.toHaveBeenCalled();
  });

  it('frames of an ended session close the socket', () => {
    // Arrange
    const { access, s, connect } = setup();
    const sock = connect();
    access.sessions.delete(s.id);
    // Act
    sock.receive('{"t":"chat.send","n":1,"text":"hi"}');
    // Assert
    expect(sock.close).toHaveBeenCalledWith(4001, 'session ended');
  });

  it('binary frames still terminate', () => {
    // Arrange
    const { connect } = setup();
    const sock = connect();
    // Act
    sock.receive(Buffer.from([1, 2, 3]), true);
    // Assert
    expect(sock.terminate).toHaveBeenCalledOnce();
  });

  it('fuzz: random and hostile frames never throw, terminate only for the documented reasons, and caps hold', () => {
    // Arrange
    const property = frameFuzz(setup({ slowModeS: 0, duplicateWindowS: 0 }));
    // Act
    const run = () => fc.assert(property, { numRuns: 300, seed: 42 });
    // Assert
    expect(run).not.toThrow();
  });

  it('the hello snapshot is there while the chat is on, and absent while it is off', () => {
    // Arrange
    const { s, hub, settings } = setup();
    // Act
    const on = hub.snapshot(s);
    settings.enabled = false;
    hub.refresh();
    const off = hub.snapshot(s);
    // Assert
    expect(on).toMatchObject({ v: 1, lastSeq: 0, you: { mutedUntil: null } });
    expect(off).toBeUndefined();
  });

  it('the hello an attached socket gets carries the chat snapshot', () => {
    // Arrange
    const { connect } = setup();
    // Act
    const sock = connect();
    // Assert
    expect(JSON.parse(sock.sent[0]!)).toMatchObject({ t: 'hello', nickname: 'Ana', chat: { v: 1, lastSeq: 0 } });
  });
});

describe('nickname uniqueness and reserved names', () => {
  /** A live access with "ana" (device d1) and "lucas" (d2) watching. */
  function watching() {
    const a = new AccessControl();
    a.begin();
    joinViewer(a, 'ana', { deviceId: 'd1' }).connections = 1;
    joinViewer(a, 'lucas', { deviceId: 'd2' }).connections = 1;
    return a;
  }

  it.each([
    ['another case', 'Ana'],
    ['a Cyrillic а', '\u{430}na'],
    ['I for l', 'Iucas'],
    ['a trailing underscore', 'ana_'],
  ])('refuses a look-alike of someone watching (%s: %s)', (_what, nickname) => {
    // Arrange
    const a = watching();
    // Act
    const problem = a.nicknameProblem(nickname, 'd9');
    // Assert
    expect(problem).toBe('taken');
  });

  it('the same device may rejoin with its name; a new name is free', () => {
    // Arrange
    const a = watching();
    // Act
    const rejoin = a.nicknameProblem('Ana', 'd1');
    const fresh = a.nicknameProblem('Bia', 'd9');
    // Assert
    expect(rejoin).toBeNull();
    expect(fresh).toBeNull();
  });

  it('suggests a free, valid name; a suggestion never grows past the length limit', () => {
    // Arrange
    const a = watching();
    // Act
    const suggestion = a.suggestNickname('Ana', 'd9');
    const long = a.suggestNickname('a'.repeat(24), 'd9');
    // Assert
    expect(suggestion).toBe('Ana2');
    expect(validateNickname(suggestion).ok).toBe(true);
    expect(long).toHaveLength(24);
  });

  it('a session gone for 30 s frees its name', () => {
    // Arrange
    const clock = manualClock();
    const a = new AccessControl(clock.now);
    a.begin();
    joinViewer(a, 'ana', { deviceId: 'd1' });
    const before = a.nicknameProblem('Ana', 'd2');
    // Act
    clock.advance(31_000);
    // Assert
    expect(before).toBe('taken');
    expect(a.nicknameProblem('Ana', 'd2')).toBeNull();
  });

  it.each(['Streamer', 'STREAMER', 'Moderador', 'Swarm Cast', 'admin'])('%s is reserved', (nickname) => {
    // Arrange
    const a = new AccessControl();
    a.begin();
    // Act
    const problem = a.nicknameProblem(nickname, 'd');
    // Assert
    expect(problem).toBe('reserved');
  });

  it("the streamer's chat name is reserved, also as a look-alike; an empty one reserves nothing", () => {
    // Arrange
    const a = new AccessControl();
    a.begin();
    // Act
    const lookAlike = a.nicknameProblem('Lucas Live', 'd', ['lucas-live']);
    const none = a.nicknameProblem('Lucas', 'd', ['']);
    // Assert
    expect(lookAlike).toBe('reserved');
    expect(none).toBeNull();
  });
});
