// A small typed stand-in for the server's chat hub (lane A, C2), speaking the /control chat
// protocol of @swarmcast/shared/chat. Used by the mock UI spec (chat-ui.spec.ts) through
// Playwright's routeWebSocket, so the viewer UI is tested before the real hub exists and without
// a stream. Behaviour kept close to plan §4: ack at once, the message comes back in a batch,
// slow mode rejects with retryMs, colour changes come back as a roster upsert plus chat.you.
import type { ChatAuthor, ChatItem, ChatPublicSettings, ChatRejectCode, ChatServerMessage, ChatSnapshot, ChatYou } from '@swarmcast/shared/chat';
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
  /** Frames the page sent (parsed). */
  received: Array<Record<string, unknown>> = [];
  private sockets = new Set<Send>();
  private lastSendAt = 0;
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
    return { v: 1, settings: this.settings, you: this.you, roster: [...this.roster.values()], items: this.items.slice(-50), lastSeq: this.seq };
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

  /** Someone else says something. */
  say(author: ChatAuthor, text: string): number {
    const items: ChatItem[] = [];
    const known = this.roster.get(author.a);
    if (!known || known.c !== author.c || known.n !== author.n) {
      this.roster.set(author.a, author);
      items.push({ k: 'u', au: author });
    }
    const m: ChatItem = { k: 'm', s: ++this.seq, at: Date.now(), a: author.a, x: text };
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
    this.items = this.items.filter((i) => !('s' in i && typeof i.s === 'number' && seqs.includes(i.s)));
    this.broadcast({ t: 'chat.batch', items: [{ k: 'd', s: seqs }] });
  }

  clear(): void {
    this.items = [];
    this.broadcast({ t: 'chat.batch', items: [{ k: 'clr', s: this.seq }] });
  }

  setSettings(over: Partial<ChatPublicSettings>): void {
    this.settings = { ...this.settings, ...over };
    this.broadcast({ t: 'chat.settings', settings: this.settings });
  }

  setYou(over: Partial<ChatYou>): void {
    this.you = { ...this.you, ...over };
    this.broadcast({ t: 'chat.you', you: this.you });
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
        const m: ChatItem = { k: 'm', s: ++this.seq, at: now, a: this.you.a, x: String(msg.text) };
        this.items.push(m);
        this.reply(send, { t: 'chat.ack', n, s: m.s });
        setTimeout(() => this.broadcast({ t: 'chat.batch', items: [m] }), 120);
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
      case 'ping':
      case 'pong':
      case 'stats':
        return;
    }
  }
}
