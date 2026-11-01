// FROZEN: the viewer's chat session exactly as v0.4.2 shipped it (`git show v0.4.2:apps/viewer/src/chat/session.ts`),
// with its core import pointed at the shared package. Do not edit or "fix" it: it stands for a
// viewer page that is already open (a stale tab, a page restored from the back/forward cache) when
// a newer server answers, and chat-compat.test.ts proves such a page keeps working.
// The viewer's chat state, without DOM: settings, "you", the roster and the sequence numbers.
// It turns server frames into calls on a ChatView, in seq order and without duplicates
// (plan §4.2): items at or below lastSeq are ignored (reconnects), and a gap without a `skip`
// item asks the server to resume from lastSeq while the newer items wait (at most RESUME_WAIT_MS).
import { CHAT_PROTOCOL_VERSION, type ChatAuthor, type ChatClientMessage, type ChatItem, type ChatPublicSettings, type ChatServerMessage, type ChatSnapshot, type ChatYou, type GifRef } from '@swarmcast/shared';
import type { MessageKey, MessageParams } from '@swarmcast/shared/i18n';

/** A chat frame this page sends on /control (the shared protocol type). */
export type ClientFrame = ChatClientMessage;

export type ChatEntry =
  | { kind: 'msg'; s: number; at: number; author: ChatAuthor; text?: string; gif?: GifRef }
  | { kind: 'sys'; s: number; at: number; code: MessageKey; params?: MessageParams }
  | { kind: 'skip'; n: number };

export interface ChatView {
  /** A new snapshot: forget what is shown and show these. */
  reset(entries: ChatEntry[]): void;
  append(entries: ChatEntry[]): void;
  remove(seqs: readonly number[]): void;
  clearUpTo(s: number): void;
  /** An author's nickname or colour changed. */
  author(a: ChatAuthor): void;
  settings(s: ChatPublicSettings | null): void;
  you(y: ChatYou | null): void;
  ack(n: number, s: number): void;
  reject(n: number | undefined, code: MessageKey, params: MessageParams | undefined, retryMs: number | undefined): void;
  /** The server speaks a chat protocol this page does not know: ask for a reload. */
  unsupported(): void;
  connection(open: boolean): void;
}

export const RESUME_WAIT_MS = 3000;
const DELETED_MEMORY = 500;

const hasSeq = (i: ChatItem): i is Extract<ChatItem, { s: number; at: number }> => i.k === 'm' || i.k === 'sys';

export class ChatSession {
  settings: ChatPublicSettings | null = null;
  you: ChatYou | null = null;
  lastSeq = 0;
  readonly roster = new Map<string, ChatAuthor>();
  /** Items after a gap, waiting for the resume answer. */
  private held: ChatItem[] | null = null;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deleted = new Set<number>();
  private open = false;

  constructor(
    private readonly view: ChatView,
    private readonly sendFrame: (msg: ClientFrame) => boolean,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  get active(): boolean {
    return this.settings !== null;
  }

  /** hello: the snapshot, or undefined when the chat is off. */
  hello(snapshot: ChatSnapshot | undefined): void {
    if (!snapshot) {
      this.settings = null;
      this.view.settings(null);
      return;
    }
    this.applySnapshot(snapshot);
  }

  connection(open: boolean): void {
    this.open = open;
    this.view.connection(open);
  }

  send(msg: ClientFrame): boolean {
    return this.open && this.sendFrame(msg);
  }

  /** A `chat.*` frame from /control. Unknown `t` and `k` are ignored (plan §4.7). */
  frame(msg: ChatServerMessage): void {
    switch (msg.t) {
      case 'chat.reset':
        this.applySnapshot(msg);
        break;
      case 'chat.batch':
        if (Array.isArray(msg.items)) this.batch(msg.items);
        break;
      case 'chat.settings': {
        const wasOff = !this.settings?.enabled;
        this.settings = msg.settings;
        this.view.settings(msg.settings);
        // Turned on after hello said "off": we have no snapshot yet; ask for one.
        if (wasOff && msg.settings.enabled && this.you === null) this.send({ t: 'chat.resume', after: this.lastSeq });
        break;
      }
      case 'chat.you':
        this.you = msg.you;
        this.view.you(msg.you);
        break;
      case 'chat.ack':
        this.view.ack(msg.n, msg.s);
        break;
      case 'chat.reject':
        this.view.reject(msg.n, msg.code, msg.params, msg.retryMs);
        break;
    }
  }

  private applySnapshot(s: ChatSnapshot): void {
    if (s.v !== CHAT_PROTOCOL_VERSION) {
      this.view.unsupported();
      return;
    }
    // Reconnect delta: keep what is shown and add what came since (like a batch).
    if (s.delta && this.settings) {
      this.settings = s.settings;
      this.you = s.you;
      this.view.settings(s.settings);
      this.view.you(s.you);
      this.batch([...s.roster.map((au): ChatItem => ({ k: 'u', au })), ...s.items]);
      this.lastSeq = Math.max(this.lastSeq, s.lastSeq);
      return;
    }
    this.dropHeld();
    this.settings = s.settings;
    this.you = s.you;
    this.roster.clear();
    this.deleted.clear();
    for (const a of s.roster) this.roster.set(a.a, a);
    this.view.settings(s.settings);
    this.view.you(s.you);
    const entries: ChatEntry[] = [];
    this.lastSeq = 0;
    for (const item of s.items) this.collect(item, entries, true);
    this.lastSeq = Math.max(this.lastSeq, s.lastSeq);
    this.view.reset(entries);
  }

  private batch(items: ChatItem[]): void {
    if (this.held) {
      this.held.push(...items);
      this.drainHeld(false);
      return;
    }
    const entries: ChatEntry[] = [];
    let skipSeen = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.k === 'skip') skipSeen = true;
      if (hasSeq(item) && item.s > this.lastSeq + 1 && !skipSeen && this.lastSeq > 0) {
        // A gap: ask for the missing items, hold these until they come (or the wait ends).
        this.held = items.slice(i);
        this.send({ t: 'chat.resume', after: this.lastSeq });
        this.heldTimer = this.timers.set(() => this.drainHeld(true), RESUME_WAIT_MS);
        break;
      }
      this.collect(item, entries, skipSeen);
    }
    if (entries.length) this.view.append(entries);
  }

  /** Apply held items in seq order; with `force`, accept the gap (the resume never came). */
  private drainHeld(force: boolean): void {
    const held = this.held;
    if (!held) return;
    const seq = held.filter(hasSeq).sort((a, b) => a.s - b.s);
    const other = held.filter((i) => !hasSeq(i));
    const entries: ChatEntry[] = [];
    for (const item of other) this.collect(item, entries, true);
    const rest: ChatItem[] = [];
    for (const item of seq) {
      if (item.s <= this.lastSeq) continue;
      if (item.s === this.lastSeq + 1 || force) this.collect(item, entries, true);
      else rest.push(item);
    }
    if (rest.length === 0 || force) this.dropHeld();
    else this.held = rest;
    if (entries.length) this.view.append(entries);
  }

  private dropHeld(): void {
    if (this.heldTimer) this.timers.clear(this.heldTimer);
    this.heldTimer = null;
    this.held = null;
  }

  private collect(item: ChatItem, out: ChatEntry[], gapOk: boolean): void {
    switch (item.k) {
      case 'u': {
        if (!item.au || typeof item.au.a !== 'string') return;
        const before = this.roster.get(item.au.a);
        this.roster.set(item.au.a, item.au);
        if (before && (before.c !== item.au.c || before.n !== item.au.n || before.r !== item.au.r)) this.view.author(item.au);
        return;
      }
      case 'm':
      case 'sys': {
        if (!Number.isSafeInteger(item.s) || item.s <= this.lastSeq) return;
        if (!gapOk && this.lastSeq > 0 && item.s > this.lastSeq + 1) return;
        this.lastSeq = item.s;
        if (this.deleted.has(item.s)) return;
        if (item.k === 'sys') {
          out.push({ kind: 'sys', s: item.s, at: item.at, code: item.code, ...(item.params ? { params: item.params } : {}) });
          return;
        }
        const author = this.roster.get(item.a) ?? { a: item.a, n: '…', c: '', r: 'viewer' as const };
        out.push({ kind: 'msg', s: item.s, at: item.at, author, ...(typeof item.x === 'string' ? { text: item.x } : {}), ...(item.g ? { gif: item.g } : {}) });
        return;
      }
      case 'd': {
        if (!Array.isArray(item.s)) return;
        for (const s of item.s) {
          this.deleted.add(s);
          if (this.deleted.size > DELETED_MEMORY) this.deleted.delete(this.deleted.values().next().value as number);
        }
        // Remove from what is about to be shown, and from the screen.
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i]!;
          if (e.kind !== 'skip' && item.s.includes(e.s)) out.splice(i, 1);
        }
        this.view.remove(item.s);
        return;
      }
      case 'clr': {
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i]!;
          if (e.kind !== 'skip' && e.s <= item.s) out.splice(i, 1);
        }
        this.view.clearUpTo(item.s);
        return;
      }
      case 'skip':
        if (Number.isSafeInteger(item.n) && item.n > 0) out.push({ kind: 'skip', n: item.n });
        return;
    }
  }
}
