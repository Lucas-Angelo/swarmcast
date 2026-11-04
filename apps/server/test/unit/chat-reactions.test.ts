import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  CHAT_BATCH_LARGE_AUDIENCE,
  CHAT_REACT_BROADCAST_MAX_PER_KIND,
  CHAT_REACT_BURST,
  CHAT_REACT_PER_FRAME_MAX,
  CHAT_REACT_WINDOW_MS,
  CHAT_REACT_WINDOW_MS_LARGE,
  CHAT_REACTIONS,
  defaultChatSettings,
  isChatSeqItem,
  type AdminChatMessage,
  type ChatItem,
  type ChatReactionsItem,
  type ChatServerMessage,
  type ChatSettings,
} from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ChatBatcher } from '../../src/chat/batcher.js';
import { ChatHub, type ChatHost } from '../../src/chat/hub.js';
import { ReactionTally, allowTaps, mergeReactions } from '../../src/chat/reactions.js';
import { effectiveChat } from '../../src/chat/settings.js';
import { ActivityLog } from '../../src/core/activity.js';
import { manualClock, silentLog } from './helpers.js';
import { joinViewer } from './helpers-b.js';

// Reactions over the video (docs/CHAT.md, "Reactions"): taps by emote index, added up per window on
// the server and sent as one ephemeral `rx` item (never a seq, never a snapshot), their own buckets,
// silent drops for everyone who may not take part, and nothing at all while they are off.

const T0 = 1_000_000_000_000;
const zeros = () => CHAT_REACTIONS.map(() => 0);

describe('ReactionTally, mergeReactions, allowTaps (pure)', () => {
  it('adds taps per kind, hands out one window at a time (capped for viewers, raw for the panel), then starts again at 0', () => {
    // Arrange
    const t = new ReactionTally();
    // Act
    t.add([3, 0, 1], T0);
    t.add([0, 0, 0, 0, 0, CHAT_REACT_BROADCAST_MAX_PER_KIND + 5], T0 + 10);
    const first = t.take();
    const second = t.take();
    // Assert
    expect(first).toEqual({ raw: [3, 0, 1, 0, 0, CHAT_REACT_BROADCAST_MAX_PER_KIND + 5, 0, 0], c: [3, 0, 1, 0, 0, CHAT_REACT_BROADCAST_MAX_PER_KIND, 0, 0] });
    expect(second).toBeNull();
    expect(t.hasPending).toBe(false);
  });

  it('keeps the taps of the last minute per kind for the panel, and forgets everything on reset', () => {
    // Arrange
    const t = new ReactionTally();
    t.add([2], T0);
    t.add([1, 4], T0 + 30_000);
    // Act
    const inMinute = t.lastMinute(T0 + 30_000);
    const later = t.lastMinute(T0 + 75_000);
    t.reset();
    // Assert
    expect(inMinute).toEqual([3, 4, 0, 0, 0, 0, 0, 0]);
    expect(later).toEqual([1, 4, 0, 0, 0, 0, 0, 0]);
    expect(t.lastMinute(T0 + 75_000)).toEqual(zeros());
    expect(t.take()).toBeNull();
  });

  it('merging two pending windows adds the counts, each still capped', () => {
    // Act
    const m = mergeReactions({ k: 'rx', c: [CHAT_REACT_BROADCAST_MAX_PER_KIND - 1, 2] }, { k: 'rx', c: [5, 1, 1] });
    // Assert
    expect(m).toEqual({ k: 'rx', c: [CHAT_REACT_BROADCAST_MAX_PER_KIND, 3, 1] });
  });

  it('a frame keeps as many taps as the buckets allow, kinds in order', () => {
    // Act
    const some = allowTaps([2, 0, 5, 3], 4);
    const all = allowTaps([1, 1], 10);
    const none = allowTaps([3], 0);
    // Assert
    expect(some).toEqual({ take: [2, 0, 2, 0, 0, 0, 0, 0], n: 4 });
    expect(all).toEqual({ take: [1, 1, 0, 0, 0, 0, 0, 0], n: 2 });
    expect(none.n).toBe(0);
  });
});

describe('effectiveChat: reactions', () => {
  const base = { protect: 'off' as const, autoSlowS: 0, guard: 'ok' as const, broken: false };
  it.each([
    ['on by default', {}, base, true],
    ['off when the streamer turns them off', { reactions: false }, base, false],
    ['off with the chat off', { enabled: false }, base, false],
    ['on under slow protection', {}, { ...base, protect: 'slow' as const }, true],
    ['off in lockdown', {}, { ...base, protect: 'lockdown' as const }, false],
    ['off while the guard degrades', {}, { ...base, guard: 'degrade' as const }, false],
    ['off while the guard pauses the chat', {}, { ...base, guard: 'pause' as const }, false],
    ['off when the chat stopped itself', {}, { ...base, broken: true }, false],
  ])('%s', (_name, over, inputs, on) => {
    // Act
    const eff = effectiveChat({ settings: { ...defaultChatSettings(), ...over }, ...inputs });
    // Assert
    expect(eff.reactions).toBe(on);
    expect(eff.public.reactions).toBe(on ? true : undefined);
    expect('reactions' in eff.public).toBe(on);
  });
});

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
}

type Viewer = { s: Session; sock: FakeSocket };

function setup(over: Partial<ChatSettings> = {}, viewers = 3) {
  const clock = manualClock(T0);
  const access = new AccessControl(clock.now);
  access.begin();
  const settings: ChatSettings = { ...defaultChatSettings(), ...over };
  const sockets: FakeSocket[] = [];
  const host: ChatHost = { sockets: () => sockets, socketsOf: (id) => sockets.filter((s) => s.sessionId === id) };
  const admin: AdminChatMessage[] = [];
  let audience = viewers;
  const hub = new ChatHub({
    access,
    host,
    settings: () => settings,
    uploadCapMbps: () => 10,
    viewers: () => audience,
    activity: new ActivityLog(),
    log: silentLog,
    now: clock.now,
    onAdmin: (m) => admin.push(m),
    guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  onTestFinished(() => hub.reset());
  const join = (nickname: string, o: { deviceId?: string; ip?: string; joinedAgoMs?: number } = {}): Viewer => {
    const s = joinViewer(access, nickname, { deviceId: o.deviceId ?? nickname, ip: o.ip ?? `203.0.113.${sockets.length + 1}` });
    s.joinedAt = clock.now() - (o.joinedAgoMs ?? 10 * 60_000);
    const sock = new FakeSocket(s.id);
    sockets.push(sock);
    return { s, sock };
  };
  const react = (who: Viewer, c: number[] | string): void => hub.frame(who.s, who.sock, typeof c === 'string' ? c : JSON.stringify({ t: 'chat.react', c }));
  /** The window is over and the batch goes out. */
  const window = (): void => {
    hub.flushReactions();
    hub.flush();
  };
  return { hub, access, settings, sockets, join, react, window, admin, advance: clock.advance, now: clock.now, setAudience: (n: number) => void (audience = n) };
}

const rx = (items: ChatItem[]) => items.filter((i): i is ChatReactionsItem => i.k === 'rx');

describe('ChatHub reactions', () => {
  it("everyone's taps of one window reach everyone as one rx item, capped per kind; never a seq, never in the ring or a snapshot; nobody gets an answer", () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    const b = env.join('Bia');
    const watcher = env.join('Watcher');
    // Act
    env.react(a, [2, 0, 1]);
    env.react(b, [1, 0, 0, 0, 0, 3]);
    env.window();
    // Assert
    for (const v of [a, b, watcher]) expect(rx(v.sock.items())).toEqual([{ k: 'rx', c: [3, 0, 1, 0, 0, 3, 0, 0] }]);
    expect(isChatSeqItem({ k: 'rx', c: [1] })).toBe(false);
    expect(env.hub.lastSeq).toBe(0);
    expect(env.hub.ringSize.items).toBe(0);
    expect(env.hub.snapshot(watcher.s)!.items).toEqual([]);
    expect(a.sock.messages().filter((m) => m.t !== 'chat.batch')).toEqual([]);
    expect(env.hub.snapshot(watcher.s)!.settings.reactions).toBe(true);
  });

  it('a window without taps sends nothing; the next window starts from 0', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.react(a, [1]);
    env.window();
    // Act
    env.window();
    env.advance(5000);
    env.react(a, [0, 1]);
    env.window();
    // Assert
    expect(rx(a.sock.items())).toEqual([
      { k: 'rx', c: [1, 0, 0, 0, 0, 0, 0, 0] },
      { k: 'rx', c: [0, 1, 0, 0, 0, 0, 0, 0] },
    ]);
  });

  it(`each device has ${CHAT_REACT_BURST} taps, refilled at 2 per second; a frame keeps what is left of them`, () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    // Act
    env.react(a, [CHAT_REACT_PER_FRAME_MAX]);
    env.react(a, [3]);
    env.advance(1000);
    env.react(a, [0, 0, 0, 5]);
    env.window();
    // Assert
    expect(rx(a.sock.items())).toEqual([{ k: 'rx', c: [CHAT_REACT_BURST, 0, 0, 2, 0, 0, 0, 0] }]);
  });

  it('the address has a bucket too, scaled by the sessions behind it (CGNAT), so many devices on one address cannot multiply it without limit', () => {
    // Arrange
    const env = setup();
    const crowd = Array.from({ length: 15 }, (_, i) => env.join(`Nat${i}`, { ip: '198.51.100.9' }));
    // Act: everyone at once, then again a second later.
    for (const v of crowd) env.react(v, [CHAT_REACT_PER_FRAME_MAX]);
    const first = env.hub.counters().reactions!.reduce((x, y) => x + y, 0);
    env.advance(1000);
    for (const v of crowd) env.react(v, [CHAT_REACT_PER_FRAME_MAX]);
    const both = env.hub.counters().reactions!.reduce((x, y) => x + y, 0);
    // Assert: the address starts with a burst of 10 and refills at 2 taps/s for each of at most 10
    // sessions behind it, so 15 devices take 10 + 20 taps, not 15 × 10 twice.
    expect(first).toBe(CHAT_REACT_BURST);
    expect(both).toBe(CHAT_REACT_BURST + 20);
  });

  it('muted viewers, viewers still in the new-viewer wait, and anyone during lockdown cannot react (dropped silently)', () => {
    // Arrange
    const env = setup({ newViewerWaitS: 60 });
    const muted = env.join('Muted');
    const fresh = env.join('Fresh', { joinedAgoMs: 1000 });
    const ok = env.join('Ok');
    env.hub.mute(muted.s.id, 10);
    // Act
    env.react(muted, [1]);
    env.react(fresh, [0, 1]);
    env.react(ok, [0, 0, 1]);
    env.window();
    env.hub.setProtect('lockdown');
    env.react(ok, [0, 0, 1]);
    env.window();
    // Assert
    expect(rx(ok.sock.items())).toEqual([{ k: 'rx', c: [0, 0, 1, 0, 0, 0, 0, 0] }]);
    expect(muted.sock.messages().filter((m) => m.t === 'chat.reject')).toEqual([]);
    expect(env.hub.effective.public.reactions).toBeUndefined();
  });

  it('with reactions off (or the chat off) nothing is taken; taps already waiting are dropped when they are turned off before the window ends', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.react(a, [1]);
    // Act
    env.settings.reactions = false;
    env.hub.refresh();
    env.window();
    env.react(a, [1]);
    env.window();
    env.settings.reactions = true;
    env.settings.enabled = false;
    env.hub.refresh();
    env.react(a, [1]);
    env.window();
    // Assert
    expect(rx(a.sock.items())).toEqual([]);
    expect(env.hub.snapshot(a.s)).toBeUndefined();
  });

  it.each([
    ['bad JSON', '{"t":"chat.react","c":[1'],
    ['too many taps in one frame', JSON.stringify({ t: 'chat.react', c: [CHAT_REACT_PER_FRAME_MAX, 1] })],
    ['no taps', JSON.stringify({ t: 'chat.react', c: [0, 0] })],
    ['a negative count', JSON.stringify({ t: 'chat.react', c: [2, -1] })],
    ['a fraction', JSON.stringify({ t: 'chat.react', c: [1.5] })],
    ['more kinds than there are', JSON.stringify({ t: 'chat.react', c: [...zeros(), 1] })],
    ['an extra field', JSON.stringify({ t: 'chat.react', c: [1], x: 'hi' })],
    ['text instead of counts', JSON.stringify({ t: 'chat.react', c: ['<img src=x>'] })],
    ['an object', JSON.stringify({ t: 'chat.react', c: { 0: 1 } })],
  ])('a hostile frame (%s) is dropped without an answer and costs nothing else', (_name, frame) => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    // Act
    env.react(a, frame);
    env.window();
    env.react(a, [1]);
    env.window();
    // Assert
    expect(rx(a.sock.items())).toEqual([{ k: 'rx', c: [1, 0, 0, 0, 0, 0, 0, 0] }]);
    expect(a.sock.messages().filter((m) => m.t !== 'chat.batch')).toEqual([]);
  });

  it('a whole audience tapping at once is not a flood: the chat detector never counts reaction frames', () => {
    // Arrange
    const env = setup({}, 120);
    const crowd = Array.from({ length: 120 }, (_, i) => env.join(`V${i}`));
    // Act: every viewer at the page's highest rate (one frame per 2 s) for 10 s.
    for (let s = 0; s < 10; s += 2) {
      for (const v of crowd) env.react(v, [1, 1]);
      env.advance(2000);
    }
    // Assert
    expect(env.hub.detector.signals(env.now(), 120).level).toBe(0);
  });

  it('a socket too slow for a window misses its rx without a snapshot or a skip; under budget pressure rx goes first, messages stay', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    const slow = env.join('Slow');
    slow.sock.bufferedAmount = 100_000;
    env.react(a, [1]);
    env.window();
    slow.sock.bufferedAmount = 0;
    // Act
    env.react(a, [0, 1]);
    env.window();
    // Assert
    expect(slow.sock.messages().map((m) => m.t)).toEqual(['chat.batch']);
    expect(rx(slow.sock.items())).toEqual([{ k: 'rx', c: [0, 1, 0, 0, 0, 0, 0, 0] }]);
    expect(slow.sock.items().filter((i) => i.k === 'skip')).toEqual([]);
  });

  it('two windows waiting for the same batch merge into one rx (latest-wins key), still capped', () => {
    // Arrange
    const env = setup();
    const crowd = Array.from({ length: 4 }, (_, i) => env.join(`V${i}`));
    // Act
    for (const v of crowd) env.react(v, [CHAT_REACT_PER_FRAME_MAX]);
    env.hub.flushReactions();
    env.advance(5000);
    for (const v of crowd) env.react(v, [CHAT_REACT_PER_FRAME_MAX]);
    env.hub.flushReactions();
    env.hub.flush();
    // Assert
    expect(rx(crowd[0]!.sock.items())).toEqual([{ k: 'rx', c: [CHAT_REACT_BROADCAST_MAX_PER_KIND, 0, 0, 0, 0, 0, 0, 0] }]);
  });

  it('the panel gets the counts before the cap and a per-kind tally of the last minute in its counters', () => {
    // Arrange
    vi.useFakeTimers({ now: T0 });
    onTestFinished(() => void vi.useRealTimers());
    const env = setup();
    const crowd = Array.from({ length: 3 }, (_, i) => env.join(`V${i}`));
    // Act
    for (const v of crowd) env.react(v, [0, 0, 0, 0, 0, CHAT_REACT_PER_FRAME_MAX]);
    env.hub.flushReactions();
    vi.advanceTimersByTime(300);
    // Assert
    const items = env.admin.flatMap((m) => m.items);
    expect(rx(items)).toEqual([{ k: 'rx', c: [0, 0, 0, 0, 0, 3 * CHAT_REACT_PER_FRAME_MAX, 0, 0] }]);
    expect(env.admin.at(-1)!.counters!.reactions).toEqual([0, 0, 0, 0, 0, 3 * CHAT_REACT_PER_FRAME_MAX, 0, 0]);
  });

  it(`the window's own timer sends the taps after ${CHAT_REACT_WINDOW_MS} ms, or ${CHAT_REACT_WINDOW_MS_LARGE} ms above ${CHAT_BATCH_LARGE_AUDIENCE} viewers`, () => {
    // Arrange
    vi.useFakeTimers({ now: T0 });
    onTestFinished(() => void vi.useRealTimers());
    const env = setup();
    const a = env.join('Ana');
    // Act
    env.react(a, [1]);
    vi.advanceTimersByTime(CHAT_REACT_WINDOW_MS - 1);
    const early = env.hub.counters().reactions;
    const pendingEarly = rx(env.admin.flatMap((m) => m.items)).length;
    vi.advanceTimersByTime(1);
    env.hub.flush();
    const small = rx(a.sock.items()).length;
    env.setAudience(CHAT_BATCH_LARGE_AUDIENCE + 1);
    env.advance(1000);
    env.react(a, [1]);
    vi.advanceTimersByTime(CHAT_REACT_WINDOW_MS);
    env.hub.flush();
    const largeEarly = rx(a.sock.items()).length;
    vi.advanceTimersByTime(CHAT_REACT_WINDOW_MS_LARGE - CHAT_REACT_WINDOW_MS);
    env.hub.flush();
    // Assert
    expect(early).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(pendingEarly).toBe(0);
    expect(small).toBe(1);
    expect(largeEarly).toBe(1);
    expect(rx(a.sock.items())).toHaveLength(2);
  });

  it('Stop wipes the taps waiting, the buckets and the tally', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.react(a, [CHAT_REACT_PER_FRAME_MAX]);
    // Act
    env.hub.reset();
    env.hub.begin();
    env.react(a, [CHAT_REACT_PER_FRAME_MAX]);
    env.window();
    // Assert
    expect(env.hub.counters().reactions).toEqual([CHAT_REACT_PER_FRAME_MAX, 0, 0, 0, 0, 0, 0, 0]);
    expect(rx(a.sock.items())).toEqual([{ k: 'rx', c: [CHAT_REACT_PER_FRAME_MAX, 0, 0, 0, 0, 0, 0, 0] }]);
  });

  it('the batcher drops a pending rx first when the upload budget is short, and never sends it as a skip', () => {
    // Arrange
    // Four sockets on a 200 B/s budget that one batch just used up: the next batch with a message
    // and a full rx does not fit, the message alone does.
    const now = { t: 5000 };
    const socks = Array.from({ length: 4 }, () => new FakeSocket(''));
    const b = new ChatBatcher({ transport: { sockets: () => socks }, budgetBps: () => 200, slow: () => false, resync: () => {}, now: () => now.t });
    b.charge(500);
    // Act
    b.push({ k: 'm', s: 1, at: 1, a: 'k1', x: 'oi' }, false);
    b.pushLatest('rx', { k: 'rx', c: CHAT_REACTIONS.map(() => CHAT_REACT_BROADCAST_MAX_PER_KIND) }, mergeReactions);
    now.t += 1500;
    b.flush();
    // Assert
    for (const s of socks) expect(s.items()).toEqual([{ k: 'm', s: 1, at: 1, a: 'k1', x: 'oi' }]);
    expect(b.droppedEphemeral).toBe(1);
    expect(b.droppedForBudget).toBe(0);
  });
});
