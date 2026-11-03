import { CHAT_POLL_RESULTS_S, CHAT_POLL_VOTES_PER_NET, CHAT_PREDICTION_LOCK_MAX_MIN, type ChatPollKind, type ChatPollPublic, type ChatPollState } from '@swarmcast/shared';

/**
 * Polls and predictions (docs/CHAT.md, "Polls and predictions"): the state of the one poll of a
 * live, its votes and its timers. Pure: no sockets, no timers of its own, the clock passed in, so
 * every rule is unit tested with a manual clock (chat-polls.test.ts). The hub owns the wiring.
 *
 * Lifecycle: open → (time up or "End now") → closed (a poll: results on screen for
 * CHAT_POLL_RESULTS_S) or locked (a prediction: waiting for the right answer, at most
 * CHAT_PREDICTION_LOCK_MAX_MIN) → resolved (the answer, results on screen for CHAT_POLL_RESULTS_S)
 * → gone. Cancel removes it in any state. One at a time: a new one may replace a finished one
 * (closed or resolved), never one that is open or waiting for its answer.
 *
 * Votes are final and anonymous: one per device (the device cookie, which every tab and every
 * session of one browser share), at most CHAT_POLL_VOTES_PER_NET per network (networkKey: an IPv4
 * address, an IPv6 /64), and, with `newOnly`, only from sessions that joined before it opened. Who
 * voted for what is kept by device id in memory only, for "your vote" on a reload, and wiped with
 * the poll; it is never logged and never shown to anyone (the streamer sees counts).
 */

export interface PollSpec {
  kind: ChatPollKind;
  /** Canonical question and options (the hub ran them through the chat's Unicode pipeline). */
  q: string;
  o: string[];
  seconds: number;
  newOnly: boolean;
}

/** What a vote needs to know about the person voting. */
export interface PollVoter {
  deviceId: string;
  /** networkKey() of their address. */
  net: string;
  joinedAt: number;
}

export type VoteRefusal = 'chat.err.pollClosed' | 'chat.err.voted' | 'chat.err.pollLate' | 'chat.err.pollNet';
export type VoteResult = { ok: true; o: number; c: number[] } | { ok: false; code: VoteRefusal; mine?: number };

/** What a timer changed: voting ended (`ended`), results or a waiting prediction went away (`removed`, `expired`: no answer came). */
export type PollDue = 'ended' | 'removed' | 'expired' | null;

interface PollState {
  id: string;
  kind: ChatPollKind;
  q: string;
  o: string[];
  st: ChatPollState;
  c: number[];
  newOnly: boolean;
  openedAt: number;
  endsAt: number;
  /** When it goes away by itself: the end of the results (closed, resolved) or of the wait for an answer (locked). */
  goneAt: number | null;
  win?: number;
  /** Device id → option. A device whose voter was kicked keeps its entry (it cannot vote again) with the option −1 (not counted). */
  votes: Map<string, number>;
  perNet: Map<string, number>;
  /** Devices refused for their network (each counted once, for the streamer). */
  refusedNet: Set<string>;
}

export class ChatPolls {
  private poll: PollState | null = null;
  private counter = 0;
  /** Counts changed since the last `takeTally()`. */
  private dirty = false;

  /** The poll's id now (null: none). */
  get id(): string | null {
    return this.poll?.id ?? null;
  }

  get state(): ChatPollState | null {
    return this.poll?.st ?? null;
  }

  get kind(): ChatPollKind | null {
    return this.poll?.kind ?? null;
  }

  /** Total votes counted. */
  get votes(): number {
    return this.poll ? this.poll.c.reduce((a, b) => a + b, 0) : 0;
  }

  /** Open a poll. Refused (false) while another one is open or waiting for its answer; a finished one is replaced. */
  open(spec: PollSpec, now: number): boolean {
    if (this.poll && (this.poll.st === 'open' || this.poll.st === 'locked')) return false;
    this.poll = {
      id: `p${(++this.counter).toString(36)}`,
      kind: spec.kind,
      q: spec.q,
      o: [...spec.o],
      st: 'open',
      c: spec.o.map(() => 0),
      newOnly: spec.newOnly,
      openedAt: now,
      endsAt: now + spec.seconds * 1000,
      goneAt: null,
      votes: new Map(),
      perNet: new Map(),
      refusedNet: new Set(),
    };
    this.dirty = false;
    return true;
  }

  /** End the voting now: a poll shows its results, a prediction waits for its answer. False when nothing is open. */
  end(now: number): boolean {
    const p = this.poll;
    if (!p || p.st !== 'open') return false;
    p.endsAt = Math.min(p.endsAt, now);
    if (p.kind === 'poll') {
      p.st = 'closed';
      p.goneAt = now + CHAT_POLL_RESULTS_S * 1000;
    } else {
      p.st = 'locked';
      p.goneAt = now + CHAT_PREDICTION_LOCK_MAX_MIN * 60_000;
    }
    return true;
  }

  /** The right answer of a prediction whose guesses ended. */
  resolve(option: number, now: number): 'ok' | 'none' | 'state' | 'option' {
    const p = this.poll;
    if (!p) return 'none';
    if (p.kind !== 'prediction' || p.st !== 'locked') return 'state';
    if (!Number.isInteger(option) || option < 0 || option >= p.o.length) return 'option';
    p.st = 'resolved';
    p.win = option;
    p.goneAt = now + CHAT_POLL_RESULTS_S * 1000;
    return 'ok';
  }

  /** Remove it, whatever its state. False when there was none. */
  cancel(): boolean {
    if (!this.poll) return false;
    this.poll = null;
    this.dirty = false;
    return true;
  }

  /** Apply the timers at `now`: voting time up, results over, no answer in time. */
  due(now: number): PollDue {
    const p = this.poll;
    if (!p) return null;
    if (p.st === 'open' && now >= p.endsAt) {
      this.end(p.endsAt);
      // Ended late (the timer fired after its time): the results' time still counts from endsAt.
      return this.due(now) ?? 'ended';
    }
    if (p.goneAt !== null && now >= p.goneAt) {
      const expired = p.st === 'locked';
      this.poll = null;
      this.dirty = false;
      return expired ? 'expired' : 'removed';
    }
    return null;
  }

  /** The next time `due()` has something to do (null: nothing pending). */
  nextDeadline(): number | null {
    const p = this.poll;
    if (!p) return null;
    return p.st === 'open' ? p.endsAt : p.goneAt;
  }

  /**
   * A vote for option `o` of poll `id`. Checked in this order, each O(1): the poll is this one and
   * open, and its time is not up (`now < endsAt`, to the millisecond, whatever the timers did);
   * "only people already watching" (`newOnly`, or `forceNewOnly` while the chat is protected); the
   * device has not voted; its network has votes left. The caller checked everything that is not
   * about the poll (chat on, mute, lockdown, new-viewer wait).
   */
  vote(voter: PollVoter, id: string, o: number, now: number, forceNewOnly = false): VoteResult {
    const p = this.poll;
    if (!p || p.id !== id || p.st !== 'open' || now >= p.endsAt || !Number.isInteger(o) || o < 0 || o >= p.o.length) return { ok: false, code: 'chat.err.pollClosed' };
    if ((p.newOnly || forceNewOnly) && voter.joinedAt > p.openedAt) return { ok: false, code: 'chat.err.pollLate' };
    const prev = p.votes.get(voter.deviceId);
    if (prev !== undefined) return { ok: false, code: 'chat.err.voted', ...(prev >= 0 ? { mine: prev } : {}) };
    const n = p.perNet.get(voter.net) ?? 0;
    if (n >= CHAT_POLL_VOTES_PER_NET) {
      p.refusedNet.add(voter.deviceId);
      this.dirty = true;
      return { ok: false, code: 'chat.err.pollNet' };
    }
    p.perNet.set(voter.net, n + 1);
    p.votes.set(voter.deviceId, o);
    p.c[o] = (p.c[o] ?? 0) + 1;
    this.dirty = true;
    return { ok: true, o, c: [...p.c] };
  }

  /**
   * A viewer was kicked: their device's vote no longer counts (the count goes down), and the device
   * cannot vote again in this poll (a kick also bans the device for the live). True when a count changed.
   */
  kicked(deviceId: string): boolean {
    const p = this.poll;
    if (!p) return false;
    const o = p.votes.get(deviceId);
    if (o === undefined || o < 0) return false;
    p.votes.set(deviceId, -1);
    p.c[o] = Math.max(0, (p.c[o] ?? 0) - 1);
    this.dirty = true;
    return true;
  }

  /**
   * The poll as viewers see it now (null: none): with `endsIn` while open, and `mine` when
   * `deviceId` voted. `admin` adds `rn` (devices refused for their network).
   */
  view(now: number, opts: { deviceId?: string; admin?: boolean } = {}): ChatPollPublic | null {
    const p = this.poll;
    if (!p) return null;
    const mine = opts.deviceId === undefined ? undefined : p.votes.get(opts.deviceId);
    return {
      id: p.id,
      kind: p.kind,
      q: p.q,
      o: [...p.o],
      st: p.st,
      c: [...p.c],
      ...(p.st === 'open' ? { endsIn: Math.max(0, p.endsAt - now) } : {}),
      ...(p.win !== undefined ? { win: p.win } : {}),
      ...(p.newOnly ? { newOnly: true as const } : {}),
      ...(mine !== undefined && mine >= 0 ? { mine } : {}),
      ...(opts.admin ? { rn: p.refusedNet.size } : {}),
    };
  }

  /** The counts, when they changed since the last call (then null until they change again). */
  takeTally(): { id: string; c: number[]; rn: number } | null {
    const p = this.poll;
    if (!p || !this.dirty) return null;
    this.dirty = false;
    return { id: p.id, c: [...p.c], rn: p.refusedNet.size };
  }

  /** Stop: forget the poll, its votes and the id counter. */
  reset(): void {
    this.poll = null;
    this.counter = 0;
    this.dirty = false;
  }
}
