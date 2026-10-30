import { CHAT_BATCH_LARGE_AUDIENCE, CHAT_BATCH_MS, CHAT_BATCH_MS_LARGE, CHAT_BATCH_MS_PRESSURE, CHAT_SOCKET_BUFFER_MAX, type ChatItem } from '@swarmcast/shared';
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
const OPEN = 1;

interface Pending {
  item: ChatItem;
  /** Streamer messages and moderation items are never dropped. */
  prio: boolean;
  at: number;
}

interface SocketDebt {
  /** Viewer messages this socket did not get (sent as one `skip` item when it catches up). */
  skipped: number;
  /** It missed a delete, clear or roster change: it gets a fresh snapshot instead. */
  missedPrio: boolean;
}

export interface BatcherOptions {
  transport: ChatTransport;
  /** Chat upload budget B_chat in bytes per second. */
  budgetBps: () => number;
  /** Batch every second whatever the audience (event-loop guard, budget pressure). */
  slow: () => boolean;
  /** Snapshot for a socket that missed moderation items while it was slow. */
  resync: (socket: ChatSocket) => void;
  now?: () => number;
}

/**
 * Batched fan-out (plan §1.3 step 5, §6.6): items wait for a window of 250 ms (500 ms above 40
 * viewers, 1 s under pressure); then ONE JSON.stringify and the same string goes to every socket
 * whose send buffer is below 64 KB. The upload budget is a byte token bucket: when a batch does
 * not fit, it waits up to 1 s and then drops the oldest viewer messages, announcing a `skip`.
 */
export class ChatBatcher {
  private queue: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly debts = new WeakMap<ChatSocket, SocketDebt>();
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
  /** Bytes sent since the live began. */
  bytesSent = 0;

  constructor(private readonly o: BatcherOptions) {
    this.now = o.now ?? Date.now;
    const b = o.budgetBps();
    this.budget = new TokenBucket(b, b, this.now());
  }

  /** Queue an item for the next batch. */
  push(item: ChatItem, prio: boolean): void {
    this.queue.push({ item, prio, at: this.now() });
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
    if (this.queue.length === 0) return;
    const now = this.now();
    const sockets = [...this.o.transport.sockets()].filter((s) => s.readyState === OPEN);
    const b = this.o.budgetBps();
    this.budget.capacity = b;
    this.budget.ratePerS = b;
    let payload = JSON.stringify({ t: 'chat.batch', items: this.queue.map((p) => p.item) });
    const cost = payload.length * sockets.length;
    if (sockets.length > 0 && this.budget.available(now) < cost) {
      const oldest = this.queue.find((p) => !p.prio)?.at ?? now;
      if (now - oldest < MAX_HOLD_MS) {
        this.schedule(Math.min(250, MAX_HOLD_MS - (now - oldest)));
        return;
      }
      // Drop the oldest viewer messages until the batch fits (priority items always go). Sizes
      // are estimated per item, so this stays linear; the batch is serialised once afterwards.
      const avail = this.budget.available(now) / sockets.length;
      let size = payload.length + 24;
      let dropped = 0;
      const keep: Pending[] = [];
      for (const p of this.queue) {
        if (size > avail && !p.prio && p.item.k === 'm') {
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
      payload = JSON.stringify({ t: 'chat.batch', items: this.queue.map((p) => p.item) });
    }
    const messages = this.queue.filter((p) => p.item.k === 'm').length;
    const hasPrio = this.queue.some((p) => p.item.k !== 'm' && p.item.k !== 'skip');
    this.queue = [];
    let sent = 0;
    for (const s of sockets) {
      if (s.bufferedAmount > CHAT_SOCKET_BUFFER_MAX) {
        // Chat never queues behind a slow reader: video, kicks and P2P orders go first.
        const d = this.debts.get(s) ?? { skipped: 0, missedPrio: false };
        d.skipped += messages;
        d.missedPrio ||= hasPrio;
        this.debts.set(s, d);
        this.skippedSlow += messages;
        continue;
      }
      const d = this.debts.get(s);
      if (d) {
        this.debts.delete(s);
        if (d.missedPrio) this.o.resync(s);
        else if (d.skipped > 0) {
          const skip = JSON.stringify({ t: 'chat.batch', items: [{ k: 'skip', n: d.skipped }] });
          s.send(skip);
          sent += skip.length;
        }
      }
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
    this.droppedForBudget = 0;
    this.skippedSlow = 0;
    this.bytesSent = 0;
    this.egressEwma = 0;
    this.egressAcc = 0;
    this.egressSec = 0;
  }

  get pending(): number {
    return this.queue.length;
  }
}
