// The viewer's chat state, without DOM: settings, "you", the roster and the sequence numbers.
// It turns server frames into calls on a ChatView, in seq order and without duplicates
// (plan §4.2): items at or below lastSeq are ignored (reconnects), and a gap without a `skip`
// item asks the server to resume from lastSeq while the newer items wait (at most RESUME_WAIT_MS).
// Only `m` and `sys` count in that order (isChatSeqItem); every other kind, known or not, is
// seq-less, so items a newer server adds can never look like a gap. A malformed item is skipped on
// its own: it never stops the items after it.
//
// Highlights (`hl`) and the pin (`pin`, and `pin` in snapshots) are seq-less state items: they say
// what a message's highlight or the pinned message is now, never take a seq and never cause a resume.
//
// Replies and mentions are fields of a message (`re`, `mn`; docs/CHAT.md, "Replies and mentions"):
// the entry carries the quoted message's author and the server's quote, and the people mentioned.
// A `d` for the quoted message wipes the quote here too ("Original message deleted").
//
// Polls and predictions (docs/CHAT.md, "Polls and predictions"): the poll is a seq-less state item
// (`poll`, and `poll` in snapshots, with this device's vote as `mine`); vote counts are ephemeral
// `pt` items for that poll's id; `chat.voted` is the answer to this device's vote (also from another
// tab). None of them takes a seq or causes a resume.
import { CHAT_MENTIONS_MAX, CHAT_POLL_OPTIONS_MAX, CHAT_POLL_OPTIONS_MIN, CHAT_PROTOCOL_VERSION, isChatSeqItem, type ChatAuthor, type ChatClientMessage, type ChatItem, type ChatPin, type ChatPollPublic, type ChatPublicSettings, type ChatReplyRef, type ChatServerMessage, type ChatSnapshot, type ChatYou, type GifRef } from './core/index.js';
import type { MessageKey, MessageParams } from '@swarmcast/shared/i18n';

/** A chat frame this page sends on /control (the shared protocol type). */
export type ClientFrame = ChatClientMessage;

/** What a reply answers, as the page shows it: the author, and the server's quote (or why there is none). */
export interface ReplyEntry {
  s: number;
  author: ChatAuthor;
  /** The quote (absent: a GIF, a deleted message, or a quote the server left out). */
  quote?: string;
  /** The quote is the start of a longer message. */
  cut?: boolean;
  gif?: boolean;
  /** The quoted message was deleted. */
  gone?: boolean;
}

export type ChatEntry =
  | { kind: 'msg'; s: number; at: number; author: ChatAuthor; text?: string; gif?: GifRef; highlighted?: boolean; reply?: ReplyEntry; mentions?: ChatAuthor[]; mentionsMe?: boolean }
  | { kind: 'sys'; s: number; at: number; code: MessageKey; params?: MessageParams }
  | { kind: 'skip'; n: number };

/** The pinned message as the page shows it: its seq, author and text or GIF; `at` is when it was pinned. */
export interface PinnedEntry {
  s: number;
  at: number;
  author: ChatAuthor;
  text?: string;
  gif?: GifRef;
}

/** The poll or prediction as the page shows it: the server's, with this device's vote kept across updates. */
export interface PollEntry {
  id: string;
  kind: ChatPollPublic['kind'];
  q: string;
  o: string[];
  st: ChatPollPublic['st'];
  c: number[];
  /** While open: ms of voting left when it came. */
  endsIn?: number;
  win?: number;
  newOnly: boolean;
  /** The option this device voted for. */
  mine?: number;
}

export interface ChatView {
  /** A new snapshot: forget what is shown and show these. */
  reset(entries: ChatEntry[]): void;
  append(entries: ChatEntry[]): void;
  remove(seqs: readonly number[]): void;
  clearUpTo(s: number): void;
  /** The streamer highlighted message `s` (`on`) or took the highlight off. */
  highlight(s: number, on: boolean): void;
  /** The pinned message changed (null: nothing pinned). */
  pin(p: PinnedEntry | null): void;
  /** The poll changed (opened, ended, answered, this device voted) or is gone (null). */
  poll?(p: PollEntry | null): void;
  /** New vote counts of the poll on screen (`id`). */
  tally?(id: string, c: number[]): void;
  /** The server counted this device's vote (`n`: its nonce, when this page sent it). */
  voted?(n: number | undefined, id: string, o: number): void;
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
/** Highlight changes remembered by seq, for a message that arrives after its `hl` (held behind a gap). */
const HIGHLIGHT_MEMORY = 200;

/** A seq item with a usable seq (anything else is handled, or dropped, as a seq-less item). */
const hasSeq = (i: ChatItem): i is Extract<ChatItem, { s: number; at: number }> => isChatSeqItem(i) && Number.isSafeInteger(i.s);

export class ChatSession {
  settings: ChatPublicSettings | null = null;
  you: ChatYou | null = null;
  lastSeq = 0;
  readonly roster = new Map<string, ChatAuthor>();
  /** Items after a gap, waiting for the resume answer. */
  private held: ChatItem[] | null = null;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deleted = new Set<number>();
  private readonly highlights = new Map<number, boolean>();
  /** The pinned message as the server last said (null: none). */
  pinned: ChatPin | null = null;
  /** The poll as the server last said (null: none). */
  poll: PollEntry | null = null;
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
      case 'chat.voted': {
        const p = this.poll;
        if (!p || msg.id !== p.id || !Number.isInteger(msg.o) || msg.o < 0 || msg.o >= p.o.length) break;
        // Without `endsIn`: the time left came with the poll, and the page counts down from then on.
        const { endsIn: _endsIn, ...rest } = p;
        this.poll = { ...rest, mine: msg.o, ...(isCounts(msg.c, p.o.length) ? { c: msg.c } : {}) };
        this.view.poll?.(this.poll);
        this.view.voted?.(typeof msg.n === 'number' ? msg.n : undefined, p.id, msg.o);
        break;
      }
    }
  }

  /** A poll from the server (an item or a snapshot field); anything malformed counts as none. This device's vote stays for the same poll. */
  private setPoll(p: unknown): void {
    const next = toPoll(p);
    if (next === null && this.poll === null) return;
    const mine = next?.mine ?? (next && this.poll?.id === next.id ? this.poll.mine : undefined);
    this.poll = next ? { ...next, ...(mine !== undefined && mine < next.o.length ? { mine } : {}) } : null;
    this.view.poll?.(this.poll);
  }

  private applySnapshot(s: ChatSnapshot): void {
    if (s.v !== CHAT_PROTOCOL_VERSION) {
      this.view.unsupported();
      return;
    }
    // Reconnect delta: keep what is shown and add what came since (like a batch). The pin comes with
    // every snapshot, delta or not: absent means nothing is pinned now.
    if (s.delta && this.settings) {
      this.settings = s.settings;
      this.you = s.you;
      this.view.settings(s.settings);
      this.view.you(s.you);
      this.batch([...s.roster.map((au): ChatItem => ({ k: 'u', au })), ...s.items]);
      this.lastSeq = Math.max(this.lastSeq, s.lastSeq);
      this.setPin(s.pin ?? null);
      this.setPoll(s.poll ?? null);
      return;
    }
    this.dropHeld();
    this.settings = s.settings;
    this.you = s.you;
    this.roster.clear();
    this.deleted.clear();
    this.highlights.clear();
    for (const a of s.roster) this.roster.set(a.a, a);
    this.view.settings(s.settings);
    this.view.you(s.you);
    const entries: ChatEntry[] = [];
    this.lastSeq = 0;
    for (const item of s.items) this.collect(item, entries, true);
    this.lastSeq = Math.max(this.lastSeq, s.lastSeq);
    this.view.reset(entries);
    this.setPin(s.pin ?? null);
    this.setPoll(s.poll ?? null);
  }

  /** A pin from the server (an item or a snapshot field); anything malformed counts as no pin. */
  private setPin(p: unknown): void {
    const pin = isPin(p) ? p : null;
    if (pin === null && this.pinned === null) return;
    this.pinned = pin;
    this.showPin();
  }

  /** An author from the roster, or a placeholder ("…") for one the page has no entry for. */
  private authorOf(a: string): ChatAuthor {
    return this.roster.get(a) ?? { a, n: '…', c: '', r: 'viewer' as const };
  }

  /** The reply of a message (anything malformed counts as no reply); a quote of a message deleted here is wiped. */
  private replyOf(re: unknown): ReplyEntry | undefined {
    if (!isReplyRef(re)) return undefined;
    const r: ReplyEntry = { s: re.s, author: this.authorOf(re.a) };
    if (re.gone === 1 || this.deleted.has(re.s)) return goneReply(r);
    if (re.gif === 1) r.gif = true;
    else if (typeof re.q === 'string' && re.q !== '') {
      r.quote = re.q;
      if (re.cut === 1) r.cut = true;
    }
    return r;
  }

  /** The people a message mentions that the page knows (the server sends their entries first). */
  private mentionsOf(mn: unknown): ChatAuthor[] {
    if (!Array.isArray(mn)) return [];
    const out: ChatAuthor[] = [];
    for (const a of mn.slice(0, CHAT_MENTIONS_MAX)) {
      const au = typeof a === 'string' ? this.roster.get(a) : undefined;
      if (au && !out.includes(au)) out.push(au);
    }
    return out;
  }

  private showPin(): void {
    const p = this.pinned;
    if (!p) return this.view.pin(null);
    const author = this.authorOf(p.a);
    this.view.pin({ s: p.s, at: p.at, author, ...(p.x !== undefined ? { text: p.x } : {}), ...(p.g ? { gif: p.g } : {}) });
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
      if (item?.k === 'skip') skipSeen = true;
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

  /** One item into `out`; a malformed one (missing fields, wrong types) is skipped without stopping the rest. */
  private collect(item: ChatItem, out: ChatEntry[], gapOk: boolean): void {
    if (item === null || typeof item !== 'object') return;
    try {
      this.collectItem(item, out, gapOk);
    } catch {}
  }

  private collectItem(item: ChatItem, out: ChatEntry[], gapOk: boolean): void {
    switch (item.k) {
      case 'u': {
        if (!item.au || typeof item.au.a !== 'string') return;
        const before = this.roster.get(item.au.a);
        this.roster.set(item.au.a, item.au);
        if (before && (before.c !== item.au.c || before.n !== item.au.n || before.r !== item.au.r)) this.view.author(item.au);
        // The pin was shown before its author's entry came (it never should): show it with the name now.
        else if (!before && this.pinned?.a === item.au.a) this.showPin();
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
        const author = this.authorOf(item.a);
        const highlighted = this.highlights.get(item.s) ?? item.h === 1;
        const reply = this.replyOf(item.re);
        const mentions = typeof item.x === 'string' ? this.mentionsOf(item.mn) : [];
        const mentionsMe = this.you !== null && mentions.some((m) => m.a === this.you!.a);
        out.push({
          kind: 'msg',
          s: item.s,
          at: item.at,
          author,
          ...(typeof item.x === 'string' ? { text: item.x } : {}),
          ...(item.g ? { gif: item.g } : {}),
          ...(highlighted ? { highlighted } : {}),
          ...(reply ? { reply } : {}),
          ...(mentions.length ? { mentions } : {}),
          ...(mentionsMe ? { mentionsMe } : {}),
        });
        return;
      }
      case 'hl': {
        if (!Number.isSafeInteger(item.s) || typeof item.on !== 'boolean') return;
        this.highlights.delete(item.s);
        this.highlights.set(item.s, item.on);
        if (this.highlights.size > HIGHLIGHT_MEMORY) this.highlights.delete(this.highlights.keys().next().value as number);
        // On screen, or about to be shown with this batch.
        for (const e of out) if (e.kind === 'msg' && e.s === item.s) e.highlighted = item.on;
        this.view.highlight(item.s, item.on);
        return;
      }
      case 'pin':
        this.setPin(item.p);
        return;
      case 'poll':
        this.setPoll(item.p);
        return;
      case 'pt': {
        const p = this.poll;
        if (!p || item.id !== p.id || !isCounts(item.c, p.o.length)) return;
        this.poll = { ...p, c: item.c };
        this.view.tally?.(p.id, item.c);
        return;
      }
      case 'd': {
        if (!Array.isArray(item.s)) return;
        for (const s of item.s) {
          this.deleted.add(s);
          if (this.deleted.size > DELETED_MEMORY) this.deleted.delete(this.deleted.values().next().value as number);
        }
        // Remove from what is about to be shown, and from the screen; replies to them lose their quote.
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i]!;
          if (e.kind !== 'skip' && item.s.includes(e.s)) out.splice(i, 1);
          else if (e.kind === 'msg' && e.reply && item.s.includes(e.reply.s)) e.reply = goneReply(e.reply);
        }
        this.view.remove(item.s);
        // A deleted message is never left pinned (the server unpins it too).
        if (this.pinned && item.s.includes(this.pinned.s)) this.setPin(null);
        return;
      }
      case 'clr': {
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i]!;
          if (e.kind !== 'skip' && e.s <= item.s) out.splice(i, 1);
        }
        this.view.clearUpTo(item.s);
        if (this.pinned && Number.isSafeInteger(item.s) && this.pinned.s <= item.s) this.setPin(null);
        return;
      }
      case 'skip':
        if (Number.isSafeInteger(item.n) && item.n > 0) out.push({ kind: 'skip', n: item.n });
        return;
    }
  }
}

/** A reply whose quoted message was deleted: whom it answered, without the quote. */
export function goneReply(r: ReplyEntry): ReplyEntry {
  return { s: r.s, author: r.author, gone: true };
}

/** A reply reference as the server sends it (seq and author key; the rest is optional). */
function isReplyRef(r: unknown): r is ChatReplyRef {
  if (r === null || typeof r !== 'object') return false;
  const v = r as Partial<ChatReplyRef>;
  return Number.isSafeInteger(v.s) && typeof v.a === 'string' && (v.q === undefined || typeof v.q === 'string');
}

/** A pin as the server sends it: seq, author key, when, and text or a GIF reference (never both). */
function isPin(p: unknown): p is ChatPin {
  if (p === null || typeof p !== 'object') return false;
  const v = p as Partial<ChatPin>;
  if (!Number.isSafeInteger(v.s) || typeof v.a !== 'string' || typeof v.at !== 'number') return false;
  // A GIF is checked where it is drawn (gifMediaUrl), like a message's.
  return typeof v.x === 'string' ? v.g === undefined : typeof v.g === 'object' && v.g !== null;
}

/** Vote counts for `n` options: whole numbers, none negative. */
function isCounts(c: unknown, n: number): c is number[] {
  return Array.isArray(c) && c.length === n && c.every((x) => Number.isSafeInteger(x) && x >= 0);
}

const POLL_STATES: ReadonlySet<string> = new Set(['open', 'closed', 'locked', 'resolved']);

/** A poll as the server sends it, or null: id, kind, question, 2–5 options, state and counts of the right shape. */
function toPoll(p: unknown): PollEntry | null {
  if (p === null || typeof p !== 'object') return null;
  const v = p as Partial<ChatPollPublic>;
  if (typeof v.id !== 'string' || (v.kind !== 'poll' && v.kind !== 'prediction') || typeof v.q !== 'string' || typeof v.st !== 'string' || !POLL_STATES.has(v.st)) return null;
  if (!Array.isArray(v.o) || v.o.length < CHAT_POLL_OPTIONS_MIN || v.o.length > CHAT_POLL_OPTIONS_MAX || !v.o.every((x) => typeof x === 'string')) return null;
  if (!isCounts(v.c, v.o.length)) return null;
  const n = v.o.length;
  const idx = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n;
  return {
    id: v.id,
    kind: v.kind,
    q: v.q,
    o: [...v.o],
    st: v.st,
    c: [...v.c],
    ...(typeof v.endsIn === 'number' && Number.isFinite(v.endsIn) && v.endsIn >= 0 ? { endsIn: v.endsIn } : {}),
    ...(idx(v.win) ? { win: v.win } : {}),
    newOnly: v.newOnly === true,
    ...(idx(v.mine) ? { mine: v.mine } : {}),
  };
}
