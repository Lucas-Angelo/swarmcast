import { CHAT_BATCH_LARGE_AUDIENCE, CHAT_BATCH_MS, CHAT_BATCH_MS_LARGE, CHAT_BATCH_MS_PRESSURE, CHAT_EPHEMERAL_PENDING_MAX, CHAT_SOCKET_BUFFER_MAX, CHAT_STATE_MISSED_MAX, type ChatAuthor, type ChatItem } from '@swarmcast/shared';
import { TokenBucket } from './buckets.js';

/** What the batcher needs of a viewer socket (a `ws` WebSocket). */
export interface ChatSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string): void;
}

export interface ChatTransport {
  /** Every open viewer control socket. */
  sockets(): Iterable<ChatSocket>;
}

/** Items kept waiting for the next batch; beyond it the oldest viewer messages are dropped. */
const MAX_PENDING = 500;
/** A batch may wait this long for upload budget before viewer messages are dropped. */
const MAX_HOLD_MS = 1000;
/** Seconds of budget one batch may borrow (paid back before the next batch is sent). */
const BUDGET_DEBT_S = 2;
const OPEN = 1;

interface Pending {
  item: ChatItem;
  /** Streamer messages and moderation items are never dropped. */
  prio: boolean;
  at: number;
  /** Other authors this item names (a reply's parent, a mention, a pin): every socket gets their roster entry first. */
  refs?: readonly string[];
  /** A state item (`pushState`): the key of the state it changes. */
  state?: string;
}

/** The current item of a state key (`pushState`), and the authors it names; null when there is nothing to send for it any more. */
export type StateOf = (key: string) => { item: ChatItem; refs?: readonly string[] } | null;

/** Any batch item with a kind; ephemeral kinds are defined by the features that send them. */
export interface EphemeralItem {
  readonly k: string;
}

interface SocketDebt {
  /** Viewer messages this socket did not get (sent as one `skip` item when it catches up). */
  skipped: number;
  /** It missed a durable item (delete, clear, roster change…): it gets a fresh snapshot instead. Never set by ephemeral or state items. */
  missedPrio: boolean;
  /** Keys of the state items it missed: it gets their current state when it catches up (at most CHAT_STATE_MISSED_MAX, then a snapshot). */
  missedState?: Set<string>;
}

export interface BatcherOptions {
  transport: ChatTransport;
  /** Chat upload budget B_chat in bytes per second. */
  budgetBps: () => number;
  /** Batch every second whatever the audience (event-loop guard, budget pressure). */
  slow: () => boolean;
  /** Snapshot for a socket that missed moderation items while it was slow. */
  resync: (socket: ChatSocket) => void;
  /** Roster entry of an author key, for sockets that have not been told about that author yet. */
  authorOf?: (a: string) => ChatAuthor | undefined;
  /** The current item of a state key, for a socket that missed state items while it was slow (`pushState`). */
  stateOf?: StateOf;
  now?: () => number;
}

/**
 * Batched fan-out (plan §1.3 step 5, §6.6): items wait for a window of 250 ms (500 ms above 40
 * viewers, 1 s under pressure); then ONE JSON.stringify and the same string goes to every socket
 * whose send buffer is below 64 KB. The upload budget is a byte token bucket: when a batch does
 * not fit, it waits up to 1 s and then drops the oldest viewer messages, announcing a `skip`.
 *
 * Three classes of items (docs/CHAT.md, "Item classes and frame budgets"):
 * - viewer messages (`m`, `prio` false): dropped oldest first under budget pressure, with a `skip`;
 * - durable items (`prio` true: streamer messages, roster, delete, clear, system lines): never
 *   dropped; a slow socket that missed one gets a fresh snapshot;
 * - state items (`pushState`: the pin, a message's highlight): durable too, but each one only says
 *   what a piece of state is now, so a slow socket that missed some gets the current state of each
 *   (`stateOf`) when it catches up, not a snapshot;
 * - ephemeral items (`pushLatest`: latest-wins state such as vote or reaction counts): at most one
 *   pending per key, sent after the queue's items, dropped first under budget pressure, silently
 *   (no `skip`, which counts messages), and never a reason for a snapshot. They never take a seq.
 */
export class ChatBatcher {
  private queue: Pending[] = [];
  /** Ephemeral items by key, in first-push order (a replaced one keeps its place). */
  private latest = new Map<string, { item: EphemeralItem }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly debts = new WeakMap<ChatSocket, SocketDebt>();
  /** Authors each socket has a roster entry for (from its hello, a reset or a batch). */
  private readonly known = new WeakMap<ChatSocket, Set<string>>();
  private readonly budget: TokenBucket;
  private readonly now: () => number;
  /** Bytes sent (EWMA over ~10 s, bytes per second). */
  private egressEwma = 0;
  private egressSec = 0;
  private egressAcc = 0;
  /** Viewer messages dropped for the budget (this live). */
  droppedForBudget = 0;
  /** Viewer messages not delivered to slow sockets (this live). */
  skippedSlow = 0;
  /** Ephemeral items dropped for the budget or the pending cap (this live); a newer one replaced them. */
  droppedEphemeral = 0;
  /** Bytes sent since the live began. */
  bytesSent = 0;

  constructor(private readonly o: BatcherOptions) {
    this.now = o.now ?? Date.now;
    const b = o.budgetBps();
    this.budget = new TokenBucket(b, b, this.now());
  }

  /**
   * Queue an item for the next batch. `refs`: other authors the item names besides its own author
   * (`m.a`); a socket that has no roster entry for one of them gets it just before the batch.
   */
  push(item: ChatItem, prio: boolean, refs?: readonly string[]): void {
    this.queue.push({ item, prio, at: this.now(), ...(refs?.length ? { refs } : {}) });
    if (this.queue.length > MAX_PENDING) {
      const i = this.queue.findIndex((p) => !p.prio && p.item.k === 'm');
      if (i >= 0) {
        this.queue.splice(i, 1);
        this.droppedForBudget++;
        this.queue.push({ item: { k: 'skip', n: 1 }, prio: true, at: this.now() });
        this.mergeSkips();
      }
    }
    this.schedule();
  }

  /**
   * Queue a state item: a durable item (never dropped) that says what the state under `key` is now
   * (`pin`, `hl:<seq>`). A socket too slow to get it is sent `stateOf(key)` when it catches up.
   */
  pushState(key: string, item: ChatItem, refs?: readonly string[]): void {
    this.queue.push({ item, prio: true, at: this.now(), state: key, ...(refs?.length ? { refs } : {}) });
    this.schedule();
  }

  /**
   * Queue an ephemeral, latest-wins item under `key`: it replaces the one pending under that key, or
   * `merge` folds the two (e.g. reaction counts add up). See the class comment for what it never does.
   */
  pushLatest<T extends EphemeralItem>(key: string, item: T, merge?: (pending: T, next: T) => T): void {
    const prev = this.latest.get(key);
    if (prev) {
      prev.item = merge ? merge(prev.item as T, item) : item;
    } else {
      this.latest.set(key, { item });
      if (this.latest.size > CHAT_EPHEMERAL_PENDING_MAX) {
        this.latest.delete(this.latest.keys().next().value!);
        this.droppedEphemeral++;
      }
    }
    this.schedule();
  }

  /** What one batch carries: the queue's items, then the ephemeral ones. */
  private payload(): string {
    const items: unknown[] = this.queue.map((p) => p.item);
    for (const e of this.latest.values()) items.push(e.item);
    return JSON.stringify({ t: 'chat.batch', items });
  }

  private mergeSkips(): void {
    let n = 0;
    const rest: Pending[] = [];
    for (const p of this.queue) {
      if (p.item.k === 'skip') n += p.item.n;
      else rest.push(p);
    }
    if (n > 0) rest.push({ item: { k: 'skip', n }, prio: true, at: this.now() });
    this.queue = rest;
  }

  private windowMs(): number {
    if (this.o.slow()) return CHAT_BATCH_MS_PRESSURE;
    let sockets = 0;
    for (const _ of this.o.transport.sockets()) if (++sockets > CHAT_BATCH_LARGE_AUDIENCE) break;
    return sockets > CHAT_BATCH_LARGE_AUDIENCE ? CHAT_BATCH_MS_LARGE : CHAT_BATCH_MS;
  }

  private schedule(delay = this.windowMs()): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** The socket got roster entries for these authors (hello, reset, resume answer). */
  markKnown(socket: ChatSocket, authors: Iterable<string>): void {
    let k = this.known.get(socket);
    if (!k) this.known.set(socket, (k = new Set()));
    for (const a of authors) k.add(a);
  }

  /** Bytes sent outside the batches (hello snapshots): charged to the budget like everything else. */
  charge(bytes: number): void {
    this.budget.force(this.now(), bytes);
    this.account(bytes);
  }

  /** The budget is in debt (recent sends used more than it refills): snapshots shrink. */
  inDebt(): boolean {
    return this.budget.available(this.now()) < 0;
  }

  /** Account bytes that left (batches, acks, snapshots). */
  account(bytes: number): void {
    const now = this.now();
    this.bytesSent += bytes;
    const sec = Math.floor(now / 1000);
    if (sec !== this.egressSec) {
      const gap = this.egressSec === 0 ? 1 : sec - this.egressSec;
      for (let i = 0; i < gap && i < 10; i++) this.egressEwma += 0.1 * ((i === 0 ? this.egressAcc : 0) - this.egressEwma);
      this.egressSec = sec;
      this.egressAcc = 0;
    }
    this.egressAcc += bytes;
  }

  /** Chat upload over the last ~10 s, bytes per second. */
  egressBps(): number {
    this.account(0);
    return this.egressEwma;
  }

  /** Send one message to one socket now (acks, rejects, snapshots): counted against the budget. */
  sendDirect(socket: ChatSocket, data: string): void {
    if (socket.readyState !== OPEN) return;
    socket.send(data);
    this.budget.force(this.now(), data.length);
    this.account(data.length);
  }

  /** Send now (also called by tests). */
  flush(): void {
    if (this.queue.length === 0 && this.latest.size === 0) return;
    const now = this.now();
    const sockets = [...this.o.transport.sockets()].filter((s) => s.readyState === OPEN);
    const b = this.o.budgetBps();
    this.budget.capacity = b;
    this.budget.ratePerS = b;
    let payload = this.payload();
    const cost = payload.length * sockets.length;
    // The bucket holds one second of budget, which a single batch to a big audience can exceed
    // even when chat is quiet (120 viewers × 500 B > 50 KB). So a batch goes out whenever the
    // bucket is not in debt, and its full cost is charged afterwards: the debt it leaves (at most
    // BUDGET_DEBT_S seconds of budget) is paid back before the next batch, which keeps the average
    // at or below B_chat. In debt, a batch waits up to 1 s, then sheds the oldest viewer messages.
    const avail = this.budget.available(now);
    const allowance = avail + BUDGET_DEBT_S * b;
    if (sockets.length > 0 && (avail < 0 || cost > allowance)) {
      const oldest = this.queue.find((p) => !p.prio)?.at ?? now;
      if (now - oldest < MAX_HOLD_MS) {
        this.schedule(Math.min(250, MAX_HOLD_MS - (now - oldest)));
        return;
      }
      // Drop ephemeral items first (a newer count replaces them anyway), then the oldest viewer
      // messages, until the batch fits the allowance (priority items always go). Sizes are
      // estimated per item, so this stays linear; the batch is serialised once afterwards.
      const perSocket = Math.max(0, allowance) / sockets.length;
      let size = payload.length + 24;
      for (const [key, e] of this.latest) {
        if (size <= perSocket) break;
        size -= JSON.stringify(e.item).length + 1;
        this.latest.delete(key);
        this.droppedEphemeral++;
      }
      let dropped = 0;
      const keep: Pending[] = [];
      for (const p of this.queue) {
        if (size > perSocket && !p.prio && p.item.k === 'm') {
          size -= JSON.stringify(p.item).length + 1;
          dropped++;
        } else keep.push(p);
      }
      this.queue = keep;
      if (dropped > 0) {
        this.droppedForBudget += dropped;
        this.queue.push({ item: { k: 'skip', n: dropped }, prio: true, at: now });
        this.mergeSkips();
      }
      payload = this.payload();
    }
    const messages = this.queue.filter((p) => p.item.k === 'm').length;
    // Only the queue's durable items count: ephemeral ones are never a reason for a snapshot, and a
    // state item is owed as its current state instead.
    const hasPrio = this.queue.some((p) => p.state === undefined && p.item.k !== 'm' && p.item.k !== 'skip');
    const states = [...new Set(this.queue.flatMap((p) => (p.state === undefined ? [] : [p.state])))];
    // Every socket must know every author an item names: the author of a message and the authors
    // it refers to (`refs`). The batch's own roster items cover first appearances; a socket that
    // joined later (and whose hello only listed the authors of its history) gets the missing
    // entries in a small frame just before the batch.
    const announcedNow = new Set<string>();
    const authors = new Set<string>();
    for (const p of this.queue) {
      if (p.item.k === 'u') announcedNow.add(p.item.au.a);
      else if (p.item.k === 'm') authors.add(p.item.a);
      if (p.refs) for (const a of p.refs) authors.add(a);
    }
    this.queue = [];
    this.latest.clear();
    let sent = 0;
    for (const s of sockets) {
      if (s.bufferedAmount > CHAT_SOCKET_BUFFER_MAX) {
        // Chat never queues behind a slow reader: video, kicks and P2P orders go first.
        const d: SocketDebt = this.debts.get(s) ?? { skipped: 0, missedPrio: false };
        d.skipped += messages;
        d.missedPrio ||= hasPrio;
        if (states.length && !d.missedPrio) {
          const missed = (d.missedState ??= new Set());
          for (const k of states) missed.add(k);
          // Owing too many states (a stuck socket during a busy stretch): a snapshot is cheaper.
          if (missed.size > CHAT_STATE_MISSED_MAX || !this.o.stateOf) d.missedPrio = true;
        }
        if (d.missedPrio) delete d.missedState;
        this.debts.set(s, d);
        this.skippedSlow += messages;
        continue;
      }
      const d = this.debts.get(s);
      // The current state of every state item this socket missed: sent after the roster entries
      // they name and before this batch (whose own state items can only be as new or newer).
      const owed: ChatItem[] = [];
      const owedRefs: string[] = [];
      if (d) {
        this.debts.delete(s);
        if (d.missedPrio) this.o.resync(s);
        else {
          if (d.skipped > 0) {
            const skip = JSON.stringify({ t: 'chat.batch', items: [{ k: 'skip', n: d.skipped }] });
            s.send(skip);
            sent += skip.length;
          }
          for (const key of d.missedState ?? []) {
            const cur = this.o.stateOf?.(key);
            if (!cur) continue;
            owed.push(cur.item);
            if (cur.refs) owedRefs.push(...cur.refs);
          }
        }
      }
      let known = this.known.get(s);
      if (!known) this.known.set(s, (known = new Set()));
      const missing: ChatItem[] = [];
      for (const a of owedRefs.length ? new Set([...owedRefs, ...authors]) : authors) {
        if (known.has(a) || announcedNow.has(a)) continue;
        const au = this.o.authorOf?.(a);
        if (au) missing.push({ k: 'u', au });
        known.add(a);
      }
      if (missing.length) {
        const roster = JSON.stringify({ t: 'chat.batch', items: missing });
        s.send(roster);
        sent += roster.length;
      }
      if (owed.length) {
        const state = JSON.stringify({ t: 'chat.batch', items: owed });
        s.send(state);
        sent += state.length;
      }
      for (const a of announcedNow) known.add(a);
      s.send(payload);
      sent += payload.length;
    }
    this.budget.force(now, sent);
    this.account(sent);
  }

  /** Forget everything (Stop). */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.latest.clear();
    this.droppedForBudget = 0;
    this.skippedSlow = 0;
    this.droppedEphemeral = 0;
    this.bytesSent = 0;
    this.egressEwma = 0;
    this.egressAcc = 0;
    this.egressSec = 0;
  }

  /** Items waiting for the next batch (queue and ephemeral). */
  get pending(): number {
    return this.queue.length + this.latest.size;
  }
}
