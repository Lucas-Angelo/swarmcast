// A small typed stand-in for the server's chat hub (lane A, C2), speaking the /control chat
// protocol of @swarmcast/shared/chat. Used by the mock UI spec (chat-ui.spec.ts) through
// Playwright's routeWebSocket, so the viewer UI is tested before the real hub exists and without
// a stream. Behaviour kept close to plan §4: ack at once, the message comes back in a batch right
// after (held back while `holdEchoes()` is on, so a test can see the page's "sending…" state for
// as long as it needs), slow mode rejects with retryMs, colour changes come back as a roster upsert
// plus chat.you. The streamer's highlight and pin work as on the server: `hl` and `pin` items, the
// flag on the message and the pin in every snapshot; deleting the pinned message or clearing unpins.
// Replies and mentions too (docs/CHAT.md "Replies and mentions"): a `re` gets the server's quote (the
// shared cutQuote), deleting a message wipes the quote of its replies, and a mention is kept only for
// someone in the roster named "@" + nickname in the text (findMentionSpans).
// Polls and predictions (docs/CHAT.md "Polls and predictions"): the poll as a state item and a
// snapshot field (with this page's vote), counts as `pt` items, one vote per page (`chat.voted`, then
// `chat.err.voted` with the option), refusals on demand (`rejectVote`). Reactions: `chat.react` frames
// recorded and never answered, everyone's counts as `rx` items (`reactions`).
import { cutQuote, findMentionSpans, type ChatAuthor, type ChatItem, type ChatMessageItem, type ChatPin, type ChatPollPublic, type ChatPublicSettings, type ChatRejectCode, type ChatReplyRef, type ChatServerMessage, type ChatSnapshot, type ChatYou } from '@swarmcast/shared/chat';
import type { ServerMessage } from '@swarmcast/shared';

export function defaultSettings(over: Partial<ChatPublicSettings> = {}): ChatPublicSettings {
  return {
    enabled: true,
    content: ['text', 'emotes'],
    slowS: 0,
    autoSlow: false,
    maxGraphemes: 200,
    maxEmoji: 30,
    newViewerWaitS: 0,
    colors: 'choose',
    linksBlocked: false,
    emotes: [],
    builtinEmotes: true,
    protect: 'off',
    streamerName: '',
    ...over,
  };
}

type Send = (text: string) => void;

export class MockHub {
  settings: ChatPublicSettings;
  you: ChatYou;
  roster = new Map<string, ChatAuthor>();
  items: ChatItem[] = [];
  seq = 0;
  /** The pinned message (null: none). */
  pinned: ChatPin | null = null;
  /** The poll (null: none) and this page's vote in it. */
  poll: ChatPollPublic | null = null;
  pollMine: number | undefined;
  /** Refuse the next vote with this code (once). */
  rejectVote: ChatRejectCode | null = null;
  /** Frames the page sent (parsed). */
  received: Array<Record<string, unknown>> = [];
  /** The frames of type `t` the page sent, in order. */
  framesOf(t: string): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.t === t);
  }
  private sockets = new Set<Send>();
  private lastSendAt = 0;
  /** Echo batches of the page's own messages, while holdEchoes() is on. */
  private held: ChatItem[] | null = null;
  /** Reject the next chat.send with this code (once). */
  rejectNext: { code: ChatRejectCode; retryMs?: number } | null = null;

  constructor(
    readonly nickname: string,
    opts: { settings?: Partial<ChatPublicSettings>; you?: Partial<ChatYou> } = {},
  ) {
    this.settings = defaultSettings(opts.settings);
    this.you = { a: 'me1', color: '#0090ff', colorLocked: false, mutedUntil: null, ...opts.you };
    this.roster.set(this.you.a, { a: this.you.a, n: nickname, c: this.you.color, r: 'viewer' });
  }

  snapshot(): ChatSnapshot {
    const poll = this.poll ? { ...this.poll, ...(this.pollMine !== undefined ? { mine: this.pollMine } : {}) } : null;
    return { v: 1, settings: this.settings, you: this.you, roster: [...this.roster.values()], items: this.items.slice(-50), lastSeq: this.seq, ...(this.pinned ? { pin: this.pinned } : {}), ...(poll ? { poll } : {}) };
  }

  hello(sessionId = 's1'): ServerMessage {
    return { t: 'hello', sessionId, nickname: this.nickname, p2pAllowed: false, blockedPeers: [], viewerCount: 3, ...(this.settings.enabled ? { chat: this.snapshot() } : {}) };
  }

  /** Attach to one page socket (Playwright WebSocketRoute.send). */
  attach(send: Send): () => void {
    this.sockets.add(send);
    send(JSON.stringify(this.hello()));
    return () => this.sockets.delete(send);
  }

  private broadcast(msg: ChatServerMessage): void {
    const s = JSON.stringify(msg);
    for (const send of this.sockets) send(s);
  }

  private reply(send: Send, msg: ChatServerMessage): void {
    send(JSON.stringify(msg));
  }

  /** The reply of a message to `re` as the server builds it (undefined: that message is not here). */
  private replyRef(re: unknown): ChatReplyRef | undefined {
    const parent = this.items.find((i): i is ChatMessageItem => i.k === 'm' && i.s === re);
    if (!parent) return undefined;
    if (parent.g) return { s: parent.s, a: parent.a, gif: 1 };
    const { q, cut } = cutQuote(parent.x ?? '');
    return { s: parent.s, a: parent.a, q, ...(cut ? { cut: 1 as const } : {}) };
  }

  /** The keys of `mn` the server would keep: people in the roster, not the sender, named in the text. */
  private mentionsOf(text: string, mn: unknown, sender: string): string[] {
    if (!Array.isArray(mn)) return [];
    const people = mn.flatMap((a) => {
      const au = typeof a === 'string' && a !== sender ? this.roster.get(a) : undefined;
      return au ? [{ a: au.a, n: au.n || 'Streamer' }] : [];
    });
    return [...new Set(findMentionSpans(text, people).map((sp) => sp.a))];
  }

  /** Someone else says something (a reply to `o.re`, mentioning `o.mn`). */
  say(author: ChatAuthor, text: string, o: { re?: number; mn?: string[] } = {}): number {
    const items: ChatItem[] = [];
    const known = this.roster.get(author.a);
    if (!known || known.c !== author.c || known.n !== author.n) {
      this.roster.set(author.a, author);
      items.push({ k: 'u', au: author });
    }
    const re = this.replyRef(o.re);
    const mn = this.mentionsOf(text, o.mn, author.a);
    const m: ChatItem = { k: 'm', s: ++this.seq, at: Date.now(), a: author.a, x: text, ...(re ? { re } : {}), ...(mn.length ? { mn } : {}) };
    this.items.push(m);
    items.push(m);
    this.broadcast({ t: 'chat.batch', items });
    return this.seq;
  }

  system(code: Extract<ChatItem, { k: 'sys' }>['code'], params?: Record<string, string | number>): void {
    const item: ChatItem = { k: 'sys', s: ++this.seq, at: Date.now(), code, ...(params ? { params } : {}) };
    this.items.push(item);
    this.broadcast({ t: 'chat.batch', items: [item] });
  }

  remove(seqs: number[]): void {
    this.items = this.items
      .filter((i) => !('s' in i && typeof i.s === 'number' && seqs.includes(i.s)))
      .map((i) => (i.k === 'm' && i.re && seqs.includes(i.re.s) ? { ...i, re: { s: i.re.s, a: i.re.a, gone: 1 as const } } : i));
    const unpin: ChatItem[] = this.pinned && seqs.includes(this.pinned.s) ? [{ k: 'pin', p: (this.pinned = null) }] : [];
    this.broadcast({ t: 'chat.batch', items: [...unpin, { k: 'd', s: seqs }] });
  }

  clear(): void {
    this.items = [];
    const unpin: ChatItem[] = this.pinned ? [{ k: 'pin', p: (this.pinned = null) }] : [];
    this.broadcast({ t: 'chat.batch', items: [...unpin, { k: 'clr', s: this.seq }] });
  }

  /** The streamer highlights message `s` (`on`) or takes the highlight off. */
  highlight(s: number, on: boolean): void {
    this.items = this.items.map((i): ChatItem => {
      if (i.k !== 'm' || i.s !== s) return i;
      const { h: _h, ...rest } = i;
      return on ? { ...rest, h: 1 } : rest;
    });
    this.broadcast({ t: 'chat.batch', items: [{ k: 'hl', s, on }] });
  }

  /** The streamer pins message `s` (null: unpins). */
  pin(s: number | null): void {
    const m = this.items.find((i) => i.k === 'm' && i.s === s);
    this.pinned = m?.k === 'm' ? { s: m.s, a: m.a, ...(m.x !== undefined ? { x: m.x } : {}), ...(m.g ? { g: m.g } : {}), at: Date.now() } : null;
    this.broadcast({ t: 'chat.batch', items: [{ k: 'pin', p: this.pinned }] });
  }

  /** The streamer starts a poll or prediction (2–5 options), or changes it (`over`), or removes it (null). */
  setPoll(p: Partial<ChatPollPublic> | null): void {
    if (p === null) this.poll = null;
    else {
      const base: ChatPollPublic = this.poll ?? { id: 'p1', kind: 'poll', q: '?', o: ['a', 'b'], st: 'open', c: [0, 0], endsIn: 120_000 };
      const next: ChatPollPublic = { ...base, ...p };
      if (next.id !== this.poll?.id) this.pollMine = undefined;
      if (next.st !== 'open') delete next.endsIn;
      this.poll = next;
    }
    this.broadcast({ t: 'chat.batch', items: [{ k: 'poll', p: this.poll }] });
  }

  /** Everyone's reaction taps of one window (an ephemeral `rx` item, docs/CHAT.md "Reactions"). */
  reactions(c: number[]): void {
    this.broadcast({ t: 'chat.batch', items: [{ k: 'rx', c }] });
  }

  /**
   * `windows` windows of reaction taps arriving at once: one batch of that many `rx` items, which
   * the page handles in one task, as it would frames that queued up. Not one frame each: every
   * frame the mock sends is a call into the page of its own, and hundreds of them can take
   * longer than a check's wait to reach a slow browser.
   */
  reactionStorm(c: number[], windows: number): void {
    this.broadcast({ t: 'chat.batch', items: Array.from({ length: windows }, () => ({ k: 'rx' as const, c })) });
  }

  /** New counts for the poll (an ephemeral `pt` item). */
  tally(c: number[]): void {
    if (!this.poll) return;
    this.poll = { ...this.poll, c };
    this.broadcast({ t: 'chat.batch', items: [{ k: 'pt', id: this.poll.id, c }] });
  }

  setSettings(over: Partial<ChatPublicSettings>): void {
    this.settings = { ...this.settings, ...over };
    this.broadcast({ t: 'chat.settings', settings: this.settings });
  }

  setYou(over: Partial<ChatYou>): void {
    this.you = { ...this.you, ...over };
    this.broadcast({ t: 'chat.you', you: this.you });
  }

  /** From now on, the page's own messages are acked but not sent back until releaseEchoes(). */
  holdEchoes(): void {
    this.held ??= [];
  }

  /** Sends the held messages back (in order) and stops holding: later ones come back at once. */
  releaseEchoes(): void {
    const held = this.held ?? [];
    this.held = null;
    if (held.length) this.broadcast({ t: 'chat.batch', items: held });
  }

  /** A frame from the page. */
  onFrame(send: Send, raw: string): void {
    if (raw.startsWith('~')) return; // tracker channel
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    this.received.push(msg);
    switch (msg.t) {
      case 'chat.send': {
        const n = Number(msg.n);
        if (this.rejectNext) {
          const r = this.rejectNext;
          this.rejectNext = null;
          this.reply(send, { t: 'chat.reject', n, code: r.code, ...(r.retryMs ? { retryMs: r.retryMs } : {}) });
          return;
        }
        const now = Date.now();
        if (this.settings.slowS > 0 && now - this.lastSendAt < this.settings.slowS * 1000) {
          const left = this.settings.slowS * 1000 - (now - this.lastSendAt);
          this.reply(send, { t: 'chat.reject', n, code: 'chat.err.slow', params: { count: Math.ceil(left / 1000) }, retryMs: left });
          return;
        }
        this.lastSendAt = now;
        const text = String(msg.text);
        const re = this.replyRef(msg.re);
        const mn = this.mentionsOf(text, msg.mn, this.you.a);
        const m: ChatItem = { k: 'm', s: ++this.seq, at: now, a: this.you.a, x: text, ...(re ? { re } : {}), ...(mn.length ? { mn } : {}) };
        this.items.push(m);
        this.reply(send, { t: 'chat.ack', n, s: m.s });
        if (this.held) this.held.push(m);
        else this.broadcast({ t: 'chat.batch', items: [m] });
        return;
      }
      case 'chat.color': {
        const color = String(msg.color).toLowerCase();
        this.you = { ...this.you, color };
        const au = { ...this.roster.get(this.you.a)!, c: color };
        this.roster.set(au.a, au);
        this.reply(send, { t: 'chat.you', you: this.you });
        this.broadcast({ t: 'chat.batch', items: [{ k: 'u', au }] });
        return;
      }
      case 'chat.resume':
        this.reply(send, { t: 'chat.reset', ...this.snapshot() });
        return;
      case 'chat.vote': {
        const n = Number(msg.n);
        const p = this.poll;
        if (this.rejectVote) {
          const code = this.rejectVote;
          this.rejectVote = null;
          this.reply(send, { t: 'chat.reject', n, code });
          return;
        }
        const o = Number(msg.o);
        if (!p || msg.id !== p.id || p.st !== 'open' || !(o >= 0 && o < p.o.length)) {
          this.reply(send, { t: 'chat.reject', n, code: 'chat.err.pollClosed' });
          return;
        }
        if (this.pollMine !== undefined) {
          this.reply(send, { t: 'chat.reject', n, code: 'chat.err.voted', params: { o: this.pollMine } });
          return;
        }
        this.pollMine = o;
        const c = p.c.map((x, i) => (i === o ? x + 1 : x));
        this.poll = { ...p, c };
        this.reply(send, { t: 'chat.voted', n, id: p.id, o, c });
        return;
      }
      // Fire-and-forget, as on the server: recorded (framesOf), never answered.
      case 'chat.react':
      case 'ping':
      case 'pong':
      case 'stats':
        return;
    }
  }
}
