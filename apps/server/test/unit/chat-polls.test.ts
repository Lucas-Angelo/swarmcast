import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CHAT_POLL_RESULTS_S, CHAT_POLL_VOTES_PER_NET, CHAT_PREDICTION_LOCK_MAX_MIN, defaultChatSettings, type AdminChatMessage, type ChatItem, type ChatPollCreate, type ChatServerMessage, type ChatSettings } from '@swarmcast/shared';
import { AccessControl, type Session } from '../../src/access/access.js';
import { ChatHub, type ChatHost } from '../../src/chat/hub.js';
import { ChatPolls, type PollSpec } from '../../src/chat/polls.js';
import { ActivityLog } from '../../src/core/activity.js';
import { manualClock, silentLog } from './helpers.js';
import { joinViewer } from './helpers-b.js';

// Polls and predictions (docs/CHAT.md, "Polls and predictions"): the pure state machine on a manual
// clock, then the hub: votes from viewer frames (one per device, at most 10 per network, "only people
// already watching", moderation), counts as ephemeral latest-wins items, the poll as a state item in
// snapshots and resume answers, timers, kicks, Stop.

const T0 = 1_000_000_000_000;
const spec = (over: Partial<PollSpec> = {}): PollSpec => ({ kind: 'poll', q: 'Pizza ou hambúrguer?', o: ['Pizza', 'Hambúrguer'], seconds: 60, newOnly: false, ...over });
const voter = (deviceId: string, net = '198.51.100.1', joinedAt = T0 - 60_000) => ({ deviceId, net, joinedAt });

describe('ChatPolls (pure)', () => {
  it('one at a time: a second one is refused while the first is open or waiting for its answer, and replaces a finished one', () => {
    // Arrange
    const p = new ChatPolls();
    // Act
    const first = p.open(spec(), T0);
    const whileOpen = p.open(spec(), T0 + 1);
    p.end(T0 + 2);
    const afterResults = p.open(spec({ kind: 'prediction' }), T0 + 3);
    p.end(T0 + 4);
    const whileLocked = p.open(spec(), T0 + 5);
    // Assert
    expect([first, whileOpen, afterResults, whileLocked]).toEqual([true, false, true, false]);
    expect(p.id).toBe('p2');
    expect(p.state).toBe('locked');
  });

  it('one vote per device: a second vote from that device is refused with the option it chose', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec(), T0);
    // Act
    const a = p.vote(voter('dev-a'), 'p1', 1, T0 + 10);
    const again = p.vote(voter('dev-a'), 'p1', 0, T0 + 20);
    const b = p.vote(voter('dev-b'), 'p1', 0, T0 + 30);
    // Assert
    expect(a).toEqual({ ok: true, o: 1, c: [0, 1] });
    expect(again).toEqual({ ok: false, code: 'chat.err.voted', mine: 1 });
    expect(b).toEqual({ ok: true, o: 0, c: [1, 1] });
  });

  it(`at most ${CHAT_POLL_VOTES_PER_NET} votes per network; each refused device is counted once for the streamer`, () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec(), T0);
    // Act
    const results = Array.from({ length: CHAT_POLL_VOTES_PER_NET + 2 }, (_, i) => p.vote(voter(`dev-${i}`, 'net-1'), 'p1', 0, T0 + i));
    const again = p.vote(voter(`dev-${CHAT_POLL_VOTES_PER_NET}`, 'net-1'), 'p1', 0, T0 + 99);
    const otherNet = p.vote(voter('dev-x', 'net-2'), 'p1', 1, T0 + 100);
    // Assert
    expect(results.filter((r) => r.ok)).toHaveLength(CHAT_POLL_VOTES_PER_NET);
    expect(results.slice(CHAT_POLL_VOTES_PER_NET)).toEqual([
      { ok: false, code: 'chat.err.pollNet' },
      { ok: false, code: 'chat.err.pollNet' },
    ]);
    expect(again).toEqual({ ok: false, code: 'chat.err.pollNet' });
    expect(otherNet.ok).toBe(true);
    expect(p.view(T0 + 100, { admin: true })).toMatchObject({ c: [CHAT_POLL_VOTES_PER_NET, 1], rn: 2 });
    expect(p.view(T0 + 100)).not.toHaveProperty('rn');
  });

  it('"only people already watching": a session that joined after it opened is refused; forced on (protection) for a poll without it', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec({ newOnly: true }), T0);
    const q = new ChatPolls();
    q.open(spec({ newOnly: false }), T0);
    // Act
    const before = p.vote(voter('dev-a', 'n', T0), 'p1', 0, T0 + 10);
    const late = p.vote(voter('dev-b', 'n', T0 + 1), 'p1', 0, T0 + 10);
    const lateOpen = q.vote(voter('dev-b', 'n', T0 + 1), 'p1', 0, T0 + 10);
    const lateForced = q.vote(voter('dev-c', 'n', T0 + 1), 'p1', 0, T0 + 10, true);
    // Assert
    expect(before.ok).toBe(true);
    expect(late).toEqual({ ok: false, code: 'chat.err.pollLate' });
    expect(lateOpen.ok).toBe(true);
    expect(lateForced).toEqual({ ok: false, code: 'chat.err.pollLate' });
  });

  it('a vote at the last millisecond counts; at endsAt it is refused even before any timer ran', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec({ seconds: 15 }), T0);
    // Act
    const lastMs = p.vote(voter('dev-a'), 'p1', 0, T0 + 15_000 - 1);
    const atEnd = p.vote(voter('dev-b'), 'p1', 0, T0 + 15_000);
    // Assert
    expect(lastMs.ok).toBe(true);
    expect(atEnd).toEqual({ ok: false, code: 'chat.err.pollClosed' });
    expect(p.state).toBe('open');
  });

  it('votes for another poll, an option out of range or a finished poll are refused as closed', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec(), T0);
    // Act
    const wrongId = p.vote(voter('a'), 'p9', 0, T0 + 1);
    const badOption = p.vote(voter('b'), 'p1', 2, T0 + 1);
    const fraction = p.vote(voter('c'), 'p1', 0.5, T0 + 1);
    p.end(T0 + 2);
    const ended = p.vote(voter('d'), 'p1', 0, T0 + 3);
    const none = new ChatPolls().vote(voter('e'), 'p1', 0, T0);
    // Assert
    for (const r of [wrongId, badOption, fraction, ended, none]) expect(r).toEqual({ ok: false, code: 'chat.err.pollClosed' });
    expect(p.votes).toBe(0);
  });

  it('timers: a poll ends at its time and its results go after CHAT_POLL_RESULTS_S; a prediction waits for its answer, then for its results', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec({ seconds: 30 }), T0);
    const q = new ChatPolls();
    q.open(spec({ kind: 'prediction', seconds: 30 }), T0);
    // Act
    const early = p.due(T0 + 29_999);
    const ended = p.due(T0 + 30_000);
    const stateAfterEnd = p.state;
    const resultsLeft = p.due(T0 + 30_000 + CHAT_POLL_RESULTS_S * 1000 - 1);
    const gone = p.due(T0 + 30_000 + CHAT_POLL_RESULTS_S * 1000);
    const locked = q.due(T0 + 30_000);
    const lockedState = q.state;
    const answered = q.resolve(1, T0 + 40_000);
    const resolvedGone = q.due(T0 + 40_000 + CHAT_POLL_RESULTS_S * 1000);
    // Assert
    expect([early, ended, stateAfterEnd, resultsLeft, gone]).toEqual([null, 'ended', 'closed', null, 'removed']);
    expect(p.id).toBeNull();
    expect([locked, lockedState, answered, resolvedGone]).toEqual(['ended', 'locked', 'ok', 'removed']);
  });

  it(`a prediction left without an answer for ${CHAT_PREDICTION_LOCK_MAX_MIN} minutes is removed ('expired')`, () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec({ kind: 'prediction', seconds: 15 }), T0);
    p.due(T0 + 15_000);
    // Act
    const waiting = p.due(T0 + 15_000 + CHAT_PREDICTION_LOCK_MAX_MIN * 60_000 - 1);
    const expired = p.due(T0 + 15_000 + CHAT_PREDICTION_LOCK_MAX_MIN * 60_000);
    // Assert
    expect(waiting).toBeNull();
    expect(expired).toBe('expired');
    expect(p.state).toBeNull();
  });

  it('a clock that jumped over everything (a sleeping computer) ends and removes in one go, counting from the voting end', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec({ seconds: 15 }), T0);
    // Act
    const r = p.due(T0 + 15_000 + CHAT_POLL_RESULTS_S * 1000);
    // Assert
    expect(r).toBe('removed');
    expect(p.id).toBeNull();
  });

  it('resolve: only a prediction whose guesses ended, with an option it has', () => {
    // Arrange
    const poll = new ChatPolls();
    poll.open(spec(), T0);
    poll.end(T0 + 1);
    const pred = new ChatPolls();
    pred.open(spec({ kind: 'prediction', o: ['a', 'b', 'c'] }), T0);
    // Act
    const none = new ChatPolls().resolve(0, T0);
    const ofPoll = poll.resolve(0, T0 + 2);
    const whileOpen = pred.resolve(0, T0 + 2);
    pred.end(T0 + 3);
    const outOfRange = pred.resolve(3, T0 + 4);
    const ok = pred.resolve(2, T0 + 5);
    const twice = pred.resolve(1, T0 + 6);
    // Assert
    expect([none, ofPoll, whileOpen, outOfRange, ok, twice]).toEqual(['none', 'state', 'state', 'option', 'ok', 'state']);
    expect(pred.view(T0 + 6)).toMatchObject({ st: 'resolved', win: 2 });
  });

  it('a kicked device no longer counts and cannot vote again; a kick of someone who did not vote changes nothing', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec(), T0);
    p.vote(voter('dev-a'), 'p1', 1, T0 + 1);
    p.takeTally();
    // Act
    const nobody = p.kicked('dev-z');
    const kicked = p.kicked('dev-a');
    const twice = p.kicked('dev-a');
    const again = p.vote(voter('dev-a'), 'p1', 0, T0 + 2);
    // Assert
    expect([nobody, kicked, twice]).toEqual([false, true, false]);
    expect(again).toEqual({ ok: false, code: 'chat.err.voted' });
    expect(p.takeTally()).toEqual({ id: 'p1', c: [0, 0], rn: 0 });
  });

  it('the view: time left while open, this device\'s vote, "only people already watching", no time once ended', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec({ newOnly: true }), T0);
    p.vote(voter('dev-a', 'n', T0 - 1), 'p1', 0, T0 + 1000);
    // Act
    const open = p.view(T0 + 1000, { deviceId: 'dev-a' });
    const other = p.view(T0 + 1000, { deviceId: 'dev-b' });
    p.end(T0 + 2000);
    const closed = p.view(T0 + 2000);
    // Assert
    expect(open).toEqual({ id: 'p1', kind: 'poll', q: 'Pizza ou hambúrguer?', o: ['Pizza', 'Hambúrguer'], st: 'open', c: [1, 0], endsIn: 59_000, newOnly: true, mine: 0 });
    expect(other).not.toHaveProperty('mine');
    expect(closed).not.toHaveProperty('endsIn');
  });

  it('counts go out only when they changed', () => {
    // Arrange
    const p = new ChatPolls();
    p.open(spec(), T0);
    // Act
    const quiet = p.takeTally();
    p.vote(voter('a'), 'p1', 0, T0 + 1);
    p.vote(voter('b'), 'p1', 1, T0 + 2);
    const first = p.takeTally();
    const unchanged = p.takeTally();
    // Assert
    expect(quiet).toBeNull();
    expect(first).toEqual({ id: 'p1', c: [1, 1], rn: 0 });
    expect(unchanged).toBeNull();
  });

  it('cancel removes it in any state; reset forgets the id counter', () => {
    // Arrange
    const p = new ChatPolls();
    // Act
    const nothing = p.cancel();
    p.open(spec(), T0);
    const open = p.cancel();
    p.open(spec(), T0);
    p.end(T0);
    const results = p.cancel();
    p.reset();
    p.open(spec(), T0);
    // Assert
    expect([nothing, open, results]).toEqual([false, true, true]);
    expect(p.id).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

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

function setup(over: Partial<ChatSettings> = {}, viewers = 3) {
  const clock = manualClock(T0);
  const access = new AccessControl(clock.now);
  access.begin();
  const settings: ChatSettings = { ...defaultChatSettings(), ...over };
  const sockets: FakeSocket[] = [];
  const host: ChatHost = { sockets: () => sockets, socketsOf: (id) => sockets.filter((s) => s.sessionId === id) };
  const activity = new ActivityLog();
  const admin: AdminChatMessage[] = [];
  let audience = viewers;
  const hub = new ChatHub({
    access,
    host,
    settings: () => settings,
    uploadCapMbps: () => 10,
    viewers: () => audience,
    activity,
    log: silentLog,
    now: clock.now,
    onAdmin: (m) => admin.push(m),
    guard: { sample: () => ({ p99Ms: 10, elu: 0.1 }), intervalMs: 3_600_000 },
  });
  hub.begin();
  onTestFinished(() => hub.reset());
  /** A viewer who joined 10 minutes ago (or `joinedAgoMs`), on their own device unless one is given. */
  const join = (nickname: string, o: { deviceId?: string; ip?: string; joinedAgoMs?: number } = {}): Viewer => {
    const s = joinViewer(access, nickname, { deviceId: o.deviceId ?? nickname, ip: o.ip ?? '203.0.113.1' });
    s.joinedAt = clock.now() - (o.joinedAgoMs ?? 10 * 60_000);
    const sock = new FakeSocket(s.id);
    sockets.push(sock);
    return { s, sock };
  };
  /** A second tab of the same session (another socket). */
  const tab = (v: Viewer): FakeSocket => {
    const sock = new FakeSocket(v.s.id);
    sockets.push(sock);
    return sock;
  };
  let nonce = 100;
  const vote = (who: Viewer, o: number, id = hub.poll?.id ?? 'p1', sock = who.sock): number => {
    const n = ++nonce;
    hub.frame(who.s, sock, JSON.stringify({ t: 'chat.vote', n, id, o }));
    return n;
  };
  const start = (over: Partial<ChatPollCreate> = {}) => hub.startPoll({ kind: 'poll', question: 'Pizza ou hambúrguer?', options: ['Pizza', 'Hambúrguer'], seconds: 60, ...over });
  const answers = (sock: FakeSocket) => sock.messages().filter((m) => m.t === 'chat.voted' || m.t === 'chat.reject');
  return { hub, access, settings, sockets, join, tab, vote, start, answers, advance: clock.advance, now: clock.now, activity, admin, setAudience: (n: number) => void (audience = n) };
}

const polls = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { k: 'poll' }> => i.k === 'poll');
const tallies = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { k: 'pt' }> => i.k === 'pt');

describe('ChatHub polls: starting one', () => {
  it('question and options go through the Unicode pipeline; the poll reaches everyone as a state item, with no system line', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    // Act
    const r = env.start({ question: 'Pizza‮ ou   hambúrguer?', options: [' Pizza ', 'Hambúrguer​'] });
    env.hub.flush();
    // Assert
    expect(r).toEqual({ ok: true, id: 'p1' });
    const items = a.sock.items();
    expect(polls(items)).toEqual([{ k: 'poll', p: { id: 'p1', kind: 'poll', q: 'Pizza ou hambúrguer?', o: ['Pizza', 'Hambúrguer'], st: 'open', c: [0, 0], endsIn: 60_000 } }]);
    expect(items.some((i) => i.k === 'sys')).toBe(false);
    expect(env.hub.lastSeq).toBe(0);
  });

  it('a prediction has "only people already watching" on unless the streamer turned it off; a poll has it off unless turned on', () => {
    // Arrange
    const env = setup();
    // Act
    env.start({ kind: 'prediction' });
    const pred = env.hub.poll;
    env.hub.cancelPoll();
    env.start({ kind: 'prediction', newOnly: false });
    const predOff = env.hub.poll;
    env.hub.cancelPoll();
    env.start({ kind: 'poll' });
    const poll = env.hub.poll;
    env.hub.cancelPoll();
    env.start({ kind: 'poll', newOnly: true });
    const pollOn = env.hub.poll;
    // Assert
    expect([pred?.newOnly, predOff?.newOnly, poll?.newOnly, pollOn?.newOnly]).toEqual([true, undefined, undefined, true]);
  });

  it.each([
    [{ question: '​​' }, { code: 'admin.chat.err.pollQuestion', params: { max: 80 } }],
    [{ question: 'x'.repeat(81) }, { code: 'admin.chat.err.pollQuestion', params: { max: 80 } }],
    [{ options: ['a', ''] }, { code: 'admin.chat.err.pollOption', params: { n: 2, max: 30 } }],
    [{ options: ['a', 'b'.repeat(31)] }, { code: 'admin.chat.err.pollOption', params: { n: 2, max: 30 } }],
    [{ options: ['Sim', 'sim '] }, { code: 'admin.chat.err.pollDuplicate' }],
    [{ options: ['Sim', 'SIM', 'Não'] }, { code: 'admin.chat.err.pollDuplicate' }],
    [{ options: ['Ana', 'Аna'] }, { code: 'admin.chat.err.pollDuplicate' }],
  ])('%j is refused: %j', (over, err) => {
    // Arrange
    const env = setup();
    // Act
    const r = env.start(over);
    // Assert
    expect(r).toEqual({ ok: false, ...err });
    expect(env.hub.poll).toBeNull();
  });

  it('two different emoji-only or punctuation-only options are not duplicates', () => {
    // Arrange
    const env = setup();
    // Act
    const r = env.start({ options: ['👍', '👎', '!!', '??'] });
    // Assert
    expect(r.ok).toBe(true);
  });

  it('one at a time; the chat off refuses polls; end, resolve and cancel without a poll say so', () => {
    // Arrange
    const env = setup();
    env.start();
    // Act
    const second = env.start();
    env.hub.cancelPoll();
    const end = env.hub.endPoll();
    const resolve = env.hub.resolvePoll(0);
    const cancel = env.hub.cancelPoll();
    env.settings.enabled = false;
    env.hub.refresh();
    const off = env.start();
    // Assert
    expect(second).toEqual({ ok: false, code: 'admin.chat.err.pollOpen' });
    expect([end, resolve, cancel]).toEqual([
      { ok: false, code: 'admin.chat.err.noPoll' },
      { ok: false, code: 'admin.chat.err.noPoll' },
      { ok: false, code: 'admin.chat.err.noPoll' },
    ]);
    expect(off).toEqual({ ok: false, code: 'admin.chat.err.disabled' });
  });

  it('the activity log says what happened, with counts only (never the question or an option)', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.start({ kind: 'prediction', question: 'Segredo?', options: ['Xis', 'Ypsilon'] });
    env.vote(a, 1);
    // Act
    env.hub.endPoll();
    env.hub.resolvePoll(1);
    env.hub.cancelPoll();
    // Assert
    const log = JSON.stringify(env.activity.list());
    expect(log).toContain('log.chat.predictionOpened');
    expect(log).toContain('log.chat.predictionLocked');
    expect(log).toContain('log.chat.predictionResolved');
    expect(log).toContain('log.chat.pollCanceled');
    expect(log).not.toMatch(/Segredo|Xis|Ypsilon/);
  });
});

describe('ChatHub polls: votes', () => {
  it('one vote per device across three sessions and two tabs: every socket of that device is told, the rest are refused with the vote', () => {
    // Arrange
    const env = setup();
    const s1 = env.join('Ana', { deviceId: 'dev-ana' });
    const s1tab = env.tab(s1);
    const s2 = env.join('Ana2', { deviceId: 'dev-ana' });
    const s3 = env.join('Ana3', { deviceId: 'dev-ana' });
    const other = env.join('Bia');
    env.start();
    // Act
    const n = env.vote(s1, 1);
    const again = env.vote(s2, 0);
    const third = env.vote(s3, 0, undefined, s3.sock);
    // Assert
    const voted: ChatServerMessage = { t: 'chat.voted', n, id: 'p1', o: 1, c: [0, 1] };
    for (const sock of [s1.sock, s1tab, s2.sock, s3.sock]) expect(sock.messages()).toContainEqual(voted);
    expect(other.sock.messages().some((m) => m.t === 'chat.voted')).toBe(false);
    expect(env.answers(s2.sock).at(-1)).toEqual({ t: 'chat.reject', n: again, code: 'chat.err.voted', params: { o: 1 } });
    expect(env.answers(s3.sock).at(-1)).toEqual({ t: 'chat.reject', n: third, code: 'chat.err.voted', params: { o: 1 } });
    expect(env.hub.poll?.c).toEqual([0, 1]);
  });

  it('a private window (another device cookie) counts as another vote', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana', { deviceId: 'dev-ana' });
    const priv = env.join('Ana Private', { deviceId: 'dev-ana-private' });
    env.start();
    // Act
    env.vote(a, 0);
    env.vote(priv, 0);
    // Assert
    expect(env.hub.poll?.c).toEqual([2, 0]);
  });

  it(`IPv4: at most ${CHAT_POLL_VOTES_PER_NET} votes from one address; the streamer sees the refused ones`, () => {
    // Arrange
    const env = setup({}, 20);
    const people = Array.from({ length: CHAT_POLL_VOTES_PER_NET + 1 }, (_, i) => env.join(`P${i}`, { ip: '198.51.100.7' }));
    const elsewhere = env.join('Elsewhere', { ip: '198.51.100.8' });
    env.start();
    // Act
    for (const p of people) env.vote(p, 0);
    env.vote(elsewhere, 1);
    // Assert
    expect(env.answers(people.at(-1)!.sock).at(-1)).toMatchObject({ t: 'chat.reject', code: 'chat.err.pollNet' });
    expect(env.hub.poll).toMatchObject({ c: [CHAT_POLL_VOTES_PER_NET, 1], rn: 1 });
  });

  it('IPv6: addresses of one /64 count as one network (also written another way), another /64 is another network', () => {
    // Arrange
    const env = setup({}, 20);
    const same = Array.from({ length: CHAT_POLL_VOTES_PER_NET }, (_, i) => env.join(`V${i}`, { ip: `2001:db8:1:2::${(i + 1).toString(16)}` }));
    const sameLonghand = env.join('Longhand', { ip: '2001:0db8:0001:0002:ffff:0000:0000:0001' });
    const otherNet = env.join('Other', { ip: '2001:db8:1:3::1' });
    env.start();
    // Act
    for (const v of same) env.vote(v, 0);
    env.vote(sameLonghand, 0);
    env.vote(otherNet, 1);
    // Assert
    expect(env.answers(sameLonghand.sock).at(-1)).toMatchObject({ code: 'chat.err.pollNet' });
    expect(env.hub.poll?.c).toEqual([CHAT_POLL_VOTES_PER_NET, 1]);
  });

  it('muted (timed or until the end), the new-viewer wait, lockdown for newcomers and the chat off refuse a vote; nothing is counted', () => {
    // Arrange
    const env = setup({ newViewerWaitS: 60 });
    const muted = env.join('Muted');
    const mutedLive = env.join('MutedLive');
    const fresh = env.join('Fresh', { joinedAgoMs: 1000 });
    env.hub.mute(muted.s.id, 10);
    env.hub.mute(mutedLive.s.id, null);
    env.start();
    // Act
    env.vote(muted, 0);
    env.vote(mutedLive, 0);
    env.vote(fresh, 0);
    env.settings.newViewerWaitS = 0;
    env.hub.refresh();
    env.hub.setProtect('lockdown');
    const newcomer = env.join('Newcomer', { joinedAgoMs: 0 });
    env.vote(newcomer, 0);
    env.hub.setProtect('off');
    env.settings.enabled = false;
    env.hub.refresh();
    const off = env.join('Off');
    env.vote(off, 0);
    // Assert
    expect(env.answers(muted.sock).at(-1)).toMatchObject({ code: 'chat.err.muted' });
    expect(env.answers(mutedLive.sock).at(-1)).toMatchObject({ code: 'chat.err.mutedLive' });
    expect(env.answers(fresh.sock).at(-1)).toMatchObject({ code: 'chat.err.newViewer' });
    expect(env.answers(newcomer.sock).at(-1)).toMatchObject({ code: 'chat.err.protect' });
    expect(env.answers(off.sock).at(-1)).toMatchObject({ code: 'chat.err.off' });
    expect(env.hub.poll?.c).toEqual([0, 0]);
  });

  it('a prediction refuses people who joined after it opened; protection forces that on a poll too', () => {
    // Arrange
    const env = setup();
    env.start({ kind: 'prediction' });
    env.advance(1000);
    const late = env.join('Late', { joinedAgoMs: 0 });
    const early = env.join('Early');
    // Act
    env.vote(late, 0);
    env.vote(early, 0);
    env.hub.cancelPoll();
    env.start({ kind: 'poll', seconds: 600 });
    // Joined after the poll opened, and longer ago than the new-viewer wait "slow" protection sets (60 s).
    env.advance(90_000);
    const late2 = env.join('Late2', { joinedAgoMs: 61_000 });
    env.hub.setProtect('slow');
    env.vote(late2, 0);
    // Assert
    expect(env.answers(late.sock).at(-1)).toMatchObject({ code: 'chat.err.pollLate' });
    expect(env.answers(early.sock).at(-1)).toMatchObject({ t: 'chat.voted' });
    expect(env.answers(late2.sock).at(-1)).toMatchObject({ code: 'chat.err.pollLate' });
  });

  it('votes cost none of the message limits: a vote right after a message, and a message right after a vote, both go', () => {
    // Arrange
    const env = setup({ slowModeS: 30 });
    const a = env.join('Ana');
    env.start();
    // Act
    env.hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n: 1, text: 'oi' }));
    env.vote(a, 0);
    const b = env.join('Bia');
    env.vote(b, 1);
    env.hub.frame(b.s, b.sock, JSON.stringify({ t: 'chat.send', n: 2, text: 'eu também' }));
    // Assert
    expect(a.sock.messages()).toContainEqual(expect.objectContaining({ t: 'chat.ack', n: 1 }));
    expect(env.answers(a.sock).at(-1)).toMatchObject({ t: 'chat.voted' });
    expect(b.sock.messages()).toContainEqual(expect.objectContaining({ t: 'chat.ack', n: 2 }));
  });

  it.each([
    '{"t":"chat.vote","n":1,"id":"p1","o":0',
    '{"t":"chat.vote","n":1,"id":"p1","o":1e400}',
    '{"t":"chat.vote","n":1,"id":"p1","o":NaN}',
    '{"t":"chat.vote","n":1,"id":"p1","o":[[0]]}',
    '{"t":"chat.vote","n":1,"id":{"$gt":""},"o":0}',
    '{"t":"chat.vote","n":1,"id":"p1","o":0,"__proto__":{"x":1}}',
    '{"t":"chat.vote","n":99999999999,"id":"p1","o":0}',
    '{"t":"chat.vote"}',
  ])('a hostile vote frame %s is refused as invalid, counts nothing and breaks nothing', (frame) => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.start();
    // Act
    env.hub.frame(a.s, a.sock, frame);
    const after = env.vote(env.join('Bia'), 0);
    // Assert
    expect(env.answers(a.sock).at(-1)).toMatchObject({ t: 'chat.reject', code: 'text.invalid' });
    expect(env.hub.poll?.c).toEqual([1, 0]);
    expect(after).toBeGreaterThan(0);
    expect(env.hub.isBroken).toBe(false);
  });

  it('a replayed vote frame is refused as "already voted"; one for the previous poll as "ended"', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.start();
    const frame = JSON.stringify({ t: 'chat.vote', n: 5, id: 'p1', o: 0 });
    env.hub.frame(a.s, a.sock, frame);
    // Act
    env.hub.frame(a.s, a.sock, frame);
    const replay = env.answers(a.sock).at(-1);
    env.hub.cancelPoll();
    env.start();
    env.advance(1000);
    env.hub.frame(a.s, a.sock, frame);
    const stale = env.answers(a.sock).at(-1);
    // Assert
    expect(replay).toEqual({ t: 'chat.reject', n: 5, code: 'chat.err.voted', params: { o: 0 } });
    expect(stale).toEqual({ t: 'chat.reject', n: 5, code: 'chat.err.pollClosed' });
  });
});

describe('ChatHub polls: counts, state items and snapshots', () => {
  it('counts go out as one ephemeral `pt` per second at most, only when they changed, never in the ring', () => {
    // Arrange
    const env = setup();
    const watcher = env.join('Watcher');
    const voters = ['A', 'B', 'C', 'D'].map((n) => env.join(n));
    env.start();
    env.hub.flush();
    watcher.sock.clear();
    // Act
    env.vote(voters[0]!, 0);
    env.vote(voters[1]!, 1);
    env.advance(1000);
    env.hub.pollTick();
    env.vote(voters[2]!, 1);
    env.advance(500);
    env.hub.pollTick();
    env.hub.flush();
    const firstWindow = tallies(watcher.sock.items());
    env.advance(500);
    env.hub.pollTick();
    env.hub.flush();
    const secondWindow = tallies(watcher.sock.items()).slice(firstWindow.length);
    env.advance(1000);
    env.hub.pollTick();
    env.hub.flush();
    const quiet = tallies(watcher.sock.items()).slice(firstWindow.length + secondWindow.length);
    // Assert
    expect(firstWindow).toEqual([{ k: 'pt', id: 'p1', c: [1, 1] }]);
    expect(secondWindow).toEqual([{ k: 'pt', id: 'p1', c: [1, 2] }]);
    expect(quiet).toEqual([]);
    expect(env.hub.lastSeq).toBe(0);
    expect(env.hub.ringSize.items).toBe(0);
  });

  it('above 40 viewers (or under protection) counts go out at most every 2 s', () => {
    // Arrange
    const env = setup({}, 120);
    const watcher = env.join('Watcher');
    const a = env.join('A');
    const b = env.join('B');
    env.start();
    env.hub.flush();
    watcher.sock.clear();
    // Act
    env.vote(a, 0);
    env.advance(1000);
    env.hub.pollTick();
    env.hub.flush();
    const at1s = tallies(watcher.sock.items()).length;
    env.vote(b, 0);
    env.advance(1000);
    env.hub.pollTick();
    env.hub.flush();
    const at2s = tallies(watcher.sock.items());
    // Assert
    expect(at1s).toBe(0);
    expect(at2s).toEqual([{ k: 'pt', id: 'p1', c: [2, 0] }]);
  });

  it('a slow socket that misses counts gets no snapshot and no skip; one that missed the poll ending gets the current poll, not a snapshot', () => {
    // Arrange
    const env = setup();
    const slow = env.join('Slow');
    const a = env.join('A');
    env.start();
    env.hub.flush();
    slow.sock.clear();
    slow.sock.bufferedAmount = 200_000;
    // Act
    env.vote(a, 1);
    env.advance(1000);
    env.hub.pollTick();
    env.hub.flush();
    env.hub.endPoll();
    env.hub.flush();
    slow.sock.bufferedAmount = 0;
    env.hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n: 9, text: 'acabou' }));
    env.hub.flush();
    // Assert
    const msgs = slow.sock.messages();
    expect(msgs.some((m) => m.t === 'chat.reset')).toBe(false);
    expect(slow.sock.items().some((i) => i.k === 'skip')).toBe(false);
    expect(polls(slow.sock.items())).toEqual([{ k: 'poll', p: expect.objectContaining({ id: 'p1', st: 'closed', c: [0, 1] }) }]);
    expect(tallies(slow.sock.items())).toEqual([]);
  });

  it('snapshots (full, delta, lockdown) carry the poll with this device\'s vote; another device sees no vote', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    const b = env.join('Bia');
    env.start();
    env.vote(a, 1);
    env.advance(5000);
    // Act
    const full = env.hub.snapshot(a.s);
    const delta = env.hub.snapshot(a.s, { after: 0 });
    env.hub.setProtect('lockdown');
    const locked = env.hub.snapshot(a.s);
    const other = env.hub.snapshot(b.s);
    // Assert
    expect(full?.poll).toEqual({ id: 'p1', kind: 'poll', q: 'Pizza ou hambúrguer?', o: ['Pizza', 'Hambúrguer'], st: 'open', c: [0, 1], endsIn: 55_000, mine: 1 });
    expect(delta?.poll?.mine).toBe(1);
    expect(locked?.poll?.mine).toBe(1);
    expect(other?.poll).not.toHaveProperty('mine');
    expect(full?.poll).not.toHaveProperty('rn');
  });

  it('a resume answer carries the current poll with this device\'s vote', () => {
    // Arrange
    const env = setup({ slowModeS: 0 });
    const a = env.join('Ana');
    env.start();
    env.vote(a, 0);
    env.hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n: 1, text: 'um' }));
    env.hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.send', n: 2, text: 'dois' }));
    a.sock.clear();
    // Act
    env.hub.frame(a.s, a.sock, JSON.stringify({ t: 'chat.resume', after: 1 }));
    // Assert
    expect(polls(a.sock.items())).toEqual([{ k: 'poll', p: expect.objectContaining({ id: 'p1', mine: 0 }) }]);
  });

  it('timers: the poll ends at its time with its final counts, the results go away after a minute; a prediction waits for the answer', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    const watcher = env.join('Watcher');
    env.start({ seconds: 30 });
    env.vote(a, 0);
    env.hub.flush();
    watcher.sock.clear();
    // Act
    env.advance(30_000);
    env.hub.pollTick();
    env.hub.flush();
    const ended = polls(watcher.sock.items());
    env.advance(CHAT_POLL_RESULTS_S * 1000);
    env.hub.pollTick();
    env.hub.flush();
    const gone = polls(watcher.sock.items()).slice(ended.length);
    env.start({ kind: 'prediction', seconds: 15 });
    env.advance(15_000);
    env.hub.pollTick();
    const locked = env.hub.poll;
    const answer = env.hub.resolvePoll(0);
    // Assert
    expect(ended).toEqual([{ k: 'poll', p: expect.objectContaining({ st: 'closed', c: [1, 0] }) }]);
    expect(ended[0]!.p).not.toHaveProperty('endsIn');
    expect(gone).toEqual([{ k: 'poll', p: null }]);
    expect(locked?.st).toBe('locked');
    expect(answer).toEqual({ ok: true, id: 'p2' });
    expect(env.hub.poll).toMatchObject({ st: 'resolved', win: 0 });
  });

  it('the poll\'s own timer ends it on time (a real timer at its deadline)', () => {
    // Arrange
    vi.useFakeTimers({ now: T0 });
    onTestFinished(() => void vi.useRealTimers());
    const env = setup();
    const watcher = env.join('Watcher');
    env.start({ seconds: 15 });
    // Act
    env.advance(15_000);
    vi.advanceTimersByTime(15_000);
    env.hub.flush();
    // Assert
    expect(polls(watcher.sock.items()).at(-1)).toEqual({ k: 'poll', p: expect.objectContaining({ st: 'closed' }) });
  });

  it('Clear chat leaves the poll; a kick takes the vote out of the counts; Stop wipes it', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    const b = env.join('Bia');
    env.start();
    env.vote(a, 0);
    env.vote(b, 1);
    // Act
    env.hub.clear();
    const afterClear = env.hub.poll?.c;
    env.access.kick(a.s.id);
    env.hub.kicked(a.s);
    const afterKick = env.hub.poll?.c;
    env.hub.reset();
    env.hub.begin();
    // Assert
    expect(afterClear).toEqual([1, 1]);
    expect(afterKick).toEqual([0, 1]);
    expect(env.hub.poll).toBeNull();
    expect(env.hub.snapshot(b.s)?.poll).toBeUndefined();
  });

  it('with the chat off, viewers get no snapshot and votes are refused; turned back on, the poll is still there', () => {
    // Arrange
    const env = setup();
    const a = env.join('Ana');
    env.start();
    // Act
    env.settings.enabled = false;
    env.hub.refresh();
    const off = env.hub.snapshot(a.s);
    env.vote(a, 0);
    env.settings.enabled = true;
    env.hub.refresh();
    const on = env.hub.snapshot(a.s);
    // Assert
    expect(off).toBeUndefined();
    expect(env.answers(a.sock).at(-1)).toMatchObject({ code: 'chat.err.off' });
    expect(on?.poll).toMatchObject({ id: 'p1', st: 'open', c: [0, 0] });
  });

  it('the panel gets the poll and the counts with the refused-by-network count', () => {
    // Arrange
    vi.useFakeTimers({ now: T0 });
    onTestFinished(() => void vi.useRealTimers());
    const env = setup({}, 20);
    const people = Array.from({ length: CHAT_POLL_VOTES_PER_NET + 1 }, (_, i) => env.join(`P${i}`, { ip: '198.51.100.9' }));
    env.start();
    // Act
    for (const p of people) env.vote(p, 0);
    env.advance(1000);
    env.hub.pollTick();
    vi.advanceTimersByTime(250);
    const state = env.hub.adminState();
    // Assert
    const items = env.admin.flatMap((m) => m.items);
    expect(items.find((i) => i.k === 'poll')).toMatchObject({ k: 'poll', p: { id: 'p1', rn: 0 } });
    expect(items.filter((i) => i.k === 'pt').at(-1)).toEqual({ k: 'pt', id: 'p1', c: [CHAT_POLL_VOTES_PER_NET, 0], rn: 1 });
    expect(state.poll).toMatchObject({ id: 'p1', rn: 1, c: [CHAT_POLL_VOTES_PER_NET, 0] });
  });

  it('a flood of 120 votes in one second is O(1) each: one count goes out, and the hub keeps up', () => {
    // Arrange
    const env = setup({}, 120);
    const watcher = env.join('Watcher');
    const people = Array.from({ length: 120 }, (_, i) => env.join(`V${i}`, { ip: `198.51.${100 + Math.floor(i / 10)}.${i % 10}` }));
    env.start({ options: ['a', 'b', 'c', 'd', 'e'] });
    env.hub.flush();
    watcher.sock.clear();
    // Act
    const t0 = performance.now();
    for (const [i, p] of people.entries()) env.vote(p, i % 5);
    const elapsed = performance.now() - t0;
    env.advance(2000);
    env.hub.pollTick();
    env.hub.flush();
    // Assert
    expect(env.hub.poll?.c).toEqual([24, 24, 24, 24, 24]);
    expect(tallies(watcher.sock.items())).toEqual([{ k: 'pt', id: 'p1', c: [24, 24, 24, 24, 24] }]);
    expect(elapsed).toBeLessThan(1000);
  });
});
