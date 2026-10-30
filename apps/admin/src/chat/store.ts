import type { AdminChatMessage, AdminChatState, ChatAuthor, ChatCounters, ChatItem, ChatRingItem, ChatSessionInfo } from '@swarmcast/shared';

/** Messages the panel keeps (the server's ring holds 200; the panel also keeps lines skipped for slow viewers). */
export const PANEL_CHAT_KEEP = 500;

/** What the chat card renders: the feed, who wrote it, and the moderation state per session. */
export interface ChatView {
  /** Messages and system lines in seq order (deleted and cleared ones removed). */
  items: ChatRingItem[];
  /** Author key → author (nickname, colour, role). */
  roster: ReadonlyMap<string, ChatAuthor>;
  /** Author key → session id (the panel acts on sessions). */
  sessions: ReadonlyMap<string, string>;
  /** Session id → mute and colour state (from GET /api/chat). */
  info: ReadonlyMap<string, ChatSessionInfo>;
  counters: ChatCounters | null;
  /** Highest seq seen. */
  lastSeq: number;
  /** Bumped on every change (cheap equality for UI hooks). */
  rev: number;
}

type Listener = (v: ChatView) => void;

/**
 * The panel's copy of the chat. Fed by the admin /ws `{type:'chat'}` messages (the ring arrives
 * on connect with reset: true) and by GET /api/chat (sessions, mutes, colours). Pure state: no
 * DOM, no network, so it is unit tested on its own.
 */
export class ChatStore {
  private items: ChatRingItem[] = [];
  private roster = new Map<string, ChatAuthor>();
  private sessions = new Map<string, string>();
  private info = new Map<string, ChatSessionInfo>();
  private counters: ChatCounters | null = null;
  private lastSeq = 0;
  private rev = 0;
  private listeners = new Set<Listener>();
  private cached: ChatView | null = null;
  /**
   * Authors of messages in the feed whose roster entry the panel never got. The server
   * announces an author once per live, and a panel opened after a clear (or a reconnect whose
   * ring no longer holds their earlier lines) can miss it: GET /api/chat fills it in.
   */
  private unknown = new Set<string>();

  constructor(private readonly keep = PANEL_CHAT_KEEP) {}

  /** A /ws chat message. */
  apply(msg: AdminChatMessage): void {
    if (msg.reset) {
      this.items = [];
      this.roster.clear();
      this.sessions.clear();
      this.unknown.clear();
      this.lastSeq = 0;
    }
    for (const [a, sid] of Object.entries(msg.sessions ?? {})) {
      if (typeof sid === 'string') this.sessions.set(a, sid);
    }
    this.applyItems(msg.items ?? []);
    if (msg.counters) this.counters = msg.counters;
    this.changed();
  }

  /** GET /api/chat: replaces the feed and the per-session state. */
  applyState(s: AdminChatState): void {
    this.items = [];
    this.roster.clear();
    this.unknown.clear();
    this.lastSeq = 0;
    for (const au of s.roster) this.roster.set(au.a, au);
    this.applyItems(s.items);
    this.lastSeq = Math.max(this.lastSeq, s.lastSeq);
    this.fillSessions(s.sessions);
    this.counters = s.counters;
    this.changed();
  }

  /** Per-session state and counters only (after a moderation action, or a periodic refresh); the feed stays as the socket built it. */
  setSessions(list: readonly ChatSessionInfo[], counters?: ChatCounters): void {
    this.fillSessions(list);
    if (counters) this.counters = counters;
    this.changed();
  }

  private fillSessions(list: readonly ChatSessionInfo[]): void {
    this.info.clear();
    for (const si of list) {
      this.info.set(si.sessionId, si);
      this.sessions.set(si.a, si.sessionId);
    }
  }

  private applyItems(items: readonly ChatItem[]): void {
    for (const it of items) {
      switch (it.k) {
        case 'u':
          this.roster.set(it.au.a, it.au);
          this.unknown.delete(it.au.a);
          break;
        case 'm':
          if (!this.roster.has(it.a)) this.unknown.add(it.a);
        // falls through
        case 'sys':
          if (it.s <= this.lastSeq && this.items.some((x) => x.s === it.s)) break;
          this.items.push(it);
          if (it.s > this.lastSeq) this.lastSeq = it.s;
          else this.items.sort((x, y) => x.s - y.s);
          break;
        case 'd': {
          const gone = new Set(it.s);
          this.items = this.items.filter((x) => !(x.k === 'm' && gone.has(x.s)));
          break;
        }
        case 'clr':
          this.items = this.items.filter((x) => x.s > it.s);
          break;
        case 'skip':
          // Viewers' gaps only: the panel gets every message.
          break;
        default:
          // Unknown kinds from a newer server are ignored (protocol rule §4.7).
          break;
      }
    }
    if (this.items.length > this.keep) this.items = this.items.slice(-this.keep);
  }

  private changed(): void {
    this.rev++;
    this.cached = null;
    const v = this.view();
    for (const l of this.listeners) l(v);
  }

  view(): ChatView {
    this.cached ??= {
      items: this.items,
      roster: this.roster,
      sessions: this.sessions,
      info: this.info,
      counters: this.counters,
      lastSeq: this.lastSeq,
      rev: this.rev,
    };
    return this.cached;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Some message in the feed has an author the panel does not know yet (see `unknown`). */
  get missingAuthors(): boolean {
    return this.unknown.size > 0;
  }

  /** The session behind a message author (undefined for the streamer or someone gone). */
  sessionOf(authorKey: string): string | undefined {
    return this.sessions.get(authorKey);
  }

  /** Mute/colour state of a session. */
  infoOf(sessionId: string): ChatSessionInfo | undefined {
    return this.info.get(sessionId);
  }
}

/** The panel's one store (the /ws handler in api.ts feeds it from the moment the socket opens). */
export const chatStore = new ChatStore();
