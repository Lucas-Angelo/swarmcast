import {
  AhoCorasick,
  BUILTIN_EMOTE_CODES,
  CHAT_BUDGET_MAX_KBPS,
  CHAT_BUDGET_MIN_KBPS,
  CHAT_BURST_CAPACITY,
  CHAT_BURST_REFILL_PER_S,
  CHAT_BYTES_PER_MESSAGE,
  CHAT_GIF_INTERVAL_S,
  CHAT_GLOBAL_MAX_PER_S,
  CHAT_GLOBAL_MIN_PER_S,
  CHAT_PROTOCOL_VERSION,
  CHAT_REACT_FRAME_PREFIX,
  CHAT_RING_MAX_BYTES,
  CHAT_RING_MAX_ITEMS,
  canonicalizeChatText,
  chatColorSchema,
  chatResumeSchema,
  chatSendSchema,
  containsLink,
  contentOf,
  countGraphemes,
  validateNickname,
  type AdminChatMessage,
  type AdminChatState,
  type ChatAuthor,
  type ChatCounters,
  type ChatItem,
  type ChatProtect,
  type ChatRejectCode,
  type ChatRingItem,
  type ChatServerMessage,
  type ChatSettings,
  type ChatSnapshot,
  type ChatYou,
  type GifRef,
} from '@swarmcast/shared';
import { comparisonKey } from '@swarmcast/shared/chat/skeleton';
import type { MessageKey, MessageParams } from '@swarmcast/shared/i18n';
import type { AccessControl, Session } from '../access/access.js';
import type { ActivityLog } from '../core/activity.js';
import type { Logger } from '../core/logger.js';
import { ChatBatcher, type ChatSocket } from './batcher.js';
import { KeyedBuckets, RateWindow, TokenBucket, type ViewerPace } from './buckets.js';
import { AdaptiveSlowMode, ChatDetector, protectState, type ChatThreat } from './detector.js';
import { EventLoopGuard, type GuardOptions, type GuardState } from './guard.js';
import { ChatModeration, type ChatMember } from './moderation.js';
import { Coalescer, effectiveChat, type EffectiveChat } from './settings.js';

/** What the hub needs of the control channel. */
export interface ChatHost {
  /** Every open viewer control socket, with its session id. */
  sockets(): Iterable<ChatSocket & { sessionId: string }>;
  socketsOf(sessionId: string): Iterable<ChatSocket>;
}

export interface ChatHubDeps {
  access: AccessControl;
  host: ChatHost;
  /** The streamer's chat settings (config.json `chat`). */
  settings: () => ChatSettings;
  /** Upload cap the chat budget is a share of (Mbps). */
  uploadCapMbps: () => number;
  /** Connected viewers right now. */
  viewers: () => number;
  /** The attack shield's level, mapped to chat protection (0 normal, 1 suspicious, 2 attack). */
  shieldLevel?: () => ChatThreat;
  activity: ActivityLog;
  log: Logger;
  now?: () => number;
  /** Items for the panel (its own /ws message type). */
  onAdmin?: (msg: AdminChatMessage) => void;
  /** Effective protection or guard changed (panel state, upload reserve). */
  onState?: () => void;
  /**
   * Once a second: the chat's flood level (for the attack shield, capped there at suspicious)
   * and its upload and budget in bits per second (for the video limiter's reserve).
   */
  onTick?: (level: ChatThreat, egressBitsPerS: number, budgetBitsPerS: number) => void;
  guard?: GuardOptions;
}

type Reject = { code: ChatRejectCode; params?: MessageParams; retryMs?: number };

interface RingEntry {
  item: ChatRingItem;
  bytes: number;
  /** Other authors the item names (a reply's parent, a mention): kept in the roster and sent with it. */
  refs?: readonly string[];
}

/**
 * Every author key the items name: the author of each message and the authors it refers to
 * (`refs`), plus `extra`. Snapshots, resume answers and the panel send roster entries for exactly
 * these, and the periodic prune keeps them.
 */
export function ringAuthors(entries: Iterable<{ item: ChatItem; refs?: readonly string[] }>, extra: Iterable<string> = []): Set<string> {
  const keys = new Set(extra);
  for (const e of entries) {
    if (e.item.k === 'm') keys.add(e.item.a);
    if (e.refs) for (const a of e.refs) keys.add(a);
  }
  return keys;
}

/** More internal errors than this in a minute stop the chat for the rest of the live. */
const MAX_FAULTS_PER_MIN = 5;
const IP_BUCKETS = 5000;
const DEVICE_PACES = 5000;
const DUP_KEYS = 2000;
const STREAMER_ID = 'streamer';
/** Rejects sent to one socket per second (a script gets silence beyond that). */
const REJECTS_PER_S = 2;
const SLOW_CODES = new Set(['chat.err.slow']);
/** History in a hello while the chat's upload budget is in debt. */
const SNAPSHOT_IN_DEBT = 10;

/**
 * The chat of one live (docs/CHAT.md): the pipeline, limits and moderation for every message, the
 * ring of recent items, batched fan-out within an upload budget, automatic protection and the
 * event-loop guard. Memory only; reset() (Stop) wipes everything.
 */
export class ChatHub {
  readonly moderation: ChatModeration;
  readonly detector = new ChatDetector();
  readonly adaptive = new AdaptiveSlowMode();
  readonly guard: EventLoopGuard;
  private readonly batcher: ChatBatcher;
  private readonly now: () => number;
  private ring: RingEntry[] = [];
  private ringBytes = 0;
  private seq = 0;
  /** Seq at the last delete or clear: a reconnect delta from before it would miss it. */
  private modSeq = 0;
  /** Authors whose roster entry viewers already have (sent once, again after a colour change). */
  private announced = new Set<string>();
  private readonly paces = new KeyedBuckets<ViewerPace>(DEVICE_PACES, () => ({ lastAt: 0, burst: new TokenBucket(CHAT_BURST_CAPACITY, CHAT_BURST_REFILL_PER_S, this.now()), lastGifAt: 0 }));
  private readonly ipBuckets = new KeyedBuckets<TokenBucket>(IP_BUCKETS, () => new TokenBucket(10, 2, this.now()));
  private global: TokenBucket;
  private readonly dups = new Map<string, number>();
  private readonly socketRejects = new WeakMap<ChatSocket, TokenBucket>();
  private readonly socketResumes = new WeakMap<ChatSocket, TokenBucket>();
  private readonly colorBuckets = new WeakMap<ChatMember, TokenBucket>();
  private readonly streamerBucket: TokenBucket;
  private blocked = new AhoCorasick([]);
  private blockedSource = '';
  private readonly emoteCodes = new Set(BUILTIN_EMOTE_CODES);
  private eff: EffectiveChat;
  private protect: ChatProtect = 'off';
  private manualProtect: ChatProtect | null = null;
  private alertStartedAt = 0;
  private broken = false;
  private faults: number[] = [];
  private readonly accepted = new RateWindow(60_000);
  private readonly rejected = new RateWindow(60_000);
  private ipCounts = new Map<string, number>();
  private ipCountsAt = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private adminQueue: ChatItem[] = [];
  private adminTimer: NodeJS.Timeout | null = null;
  private readonly settingsPush: Coalescer;
  private lastPublic = '';
  private running = false;

  constructor(private readonly d: ChatHubDeps) {
    this.now = d.now ?? Date.now;
    this.moderation = new ChatModeration(this.now);
    this.global = new TokenBucket(2 * CHAT_GLOBAL_MAX_PER_S, CHAT_GLOBAL_MAX_PER_S, this.now());
    this.streamerBucket = new TokenBucket(5, 1, this.now());
    this.guard = new EventLoopGuard({
      ...d.guard,
      onChange: (s, prev) => {
        d.guard?.onChange?.(s, prev);
        this.d.log.warn({ guard: s, prev, p99: Math.round(this.guard.last.p99Ms), elu: Number(this.guard.last.elu.toFixed(2)) }, 'chat event-loop guard');
        this.refresh();
      },
    });
    this.batcher = new ChatBatcher({
      transport: { sockets: () => d.host.sockets() },
      budgetBps: () => this.budgetBps(),
      slow: () => this.guard.state !== 'ok' || this.protect !== 'off',
      resync: (s) => this.resyncSocket(s),
      authorOf: (a) => this.moderation.authorOf(a),
      now: this.now,
    });
    this.eff = this.computeEffective();
    this.settingsPush = new Coalescer(() => this.pushSettings(), 1000, this.now);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** A live begins: fresh ring (seq from 1), roster, mutes and timers. */
  begin(): void {
    this.reset();
    this.running = true;
    this.detector.start(this.now());
    this.guard.start();
    this.tickTimer = setInterval(() => this.safe(() => this.tick()), 1000);
    this.tickTimer.unref();
  }

  /** Stop: wipe everything (ring, mutes, roster, counters). */
  reset(): void {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.adminTimer) clearTimeout(this.adminTimer);
    this.adminTimer = null;
    this.adminQueue = [];
    this.guard.stop();
    this.batcher.reset();
    this.settingsPush.cancel();
    this.ring = [];
    this.ringBytes = 0;
    this.seq = 0;
    this.modSeq = 0;
    this.announced.clear();
    this.paces.clear();
    this.ipBuckets.clear();
    this.dups.clear();
    this.moderation.reset();
    this.detector.reset();
    this.adaptive.reset();
    this.accepted.reset();
    this.rejected.reset();
    this.protect = 'off';
    this.manualProtect = null;
    this.alertStartedAt = 0;
    this.broken = false;
    this.faults = [];
    this.lastPublic = '';
    this.eff = this.computeEffective();
  }

  /** Settings changed (panel or automatic): recompute, push to viewers at most once a second. */
  refresh(): void {
    const prevProtect = this.protect;
    this.protect = protectState(this.detector.level, this.d.shieldLevel?.() ?? 0, this.manualProtect, this.d.settings().autoProtect);
    if (this.protect !== prevProtect) this.protectChanged(prevProtect);
    this.eff = this.computeEffective();
    const words = this.d.settings().blockedWords;
    const src = words.join('\n');
    if (src !== this.blockedSource) {
      this.blockedSource = src;
      this.blocked = new AhoCorasick(words.map((w) => comparisonKey(w)).filter((k) => k.length > 0));
    }
    const pub = JSON.stringify(this.eff.public);
    if (pub !== this.lastPublic) {
      this.lastPublic = pub;
      this.settingsPush.request();
    }
    this.d.onState?.();
  }

  private computeEffective(): EffectiveChat {
    return effectiveChat({ settings: this.d.settings(), protect: this.protect, autoSlowS: this.d.settings().autoProtect ? this.adaptive.autoSlowS : 0, guard: this.guard.state, broken: this.broken });
  }

  private pushSettings(): void {
    this.broadcast({ t: 'chat.settings', settings: this.eff.public });
  }

  private protectChanged(prev: ChatProtect): void {
    const now = this.now();
    if (this.protect === 'lockdown' && prev !== 'lockdown') this.alertStartedAt = now;
    if (this.protect === 'off') this.alertStartedAt = 0;
    const reason: MessageKey = this.manualProtect ? 'chat.protect.reason.manual' : this.detector.level > 0 ? 'chat.protect.reason.flood' : 'chat.protect.reason.shield';
    this.d.activity.action('log.chat.protect', { modeKey: `chat.protect.${this.protect}`, reasonKey: this.protect === 'off' ? 'chat.protect.off' : reason }, this.protect === 'off' ? 'info' : 'warn');
    if (this.running) this.system(this.protect === 'off' ? 'chat.sys.protectOff' : 'chat.sys.protect');
  }

  /** Once a second: detector, adaptive slow mode (every 5 s), global limit. */
  private tick(): void {
    const now = this.now();
    const viewers = this.d.viewers();
    const changed = this.detector.tick(now, viewers);
    this.d.onTick?.(this.detector.level, this.egressBitsPerS(), this.budgetBps() * 8);
    let refresh = changed;
    if (++this.ticks % 5 === 0 && this.d.settings().autoProtect) refresh = this.adaptive.evaluate(now, this.globalPerS()) || refresh;
    const g = this.globalPerS();
    this.global.ratePerS = g;
    this.global.capacity = 2 * g;
    // The shield's level can change between ticks; refresh() is cheap when nothing changed.
    const shield = this.d.shieldLevel?.() ?? 0;
    if (refresh || protectState(this.detector.level, shield, this.manualProtect, this.d.settings().autoProtect) !== this.protect) this.refresh();
    if (this.ticks % 60 === 0) {
      // Forget members whose session ended; keep authors still visible in the ring (or named by it).
      const inRing = ringAuthors(this.ring);
      for (const m of [...this.moderation.members()]) if (m.sessionId !== STREAMER_ID && !this.d.access.sessions.has(m.sessionId)) this.moderation.forget(m.sessionId, (a) => inRing.has(a));
      this.moderation.prune((m) => inRing.has(m.a));
    }
  }

  // ---------------------------------------------------------------------------
  // Budget
  // ---------------------------------------------------------------------------

  /** B_chat: a share of the upload cap (5 % by default), clamped to 128–960 kbps, in bytes per second. */
  budgetBps(): number {
    const kbps = Math.min(CHAT_BUDGET_MAX_KBPS, Math.max(CHAT_BUDGET_MIN_KBPS, this.d.settings().budgetShare * this.d.uploadCapMbps() * 1000));
    return (kbps * 1000) / 8;
  }

  /** G: messages per second the budget carries for this audience (halved when the guard degrades). */
  globalPerS(): number {
    const v = Math.max(1, this.d.viewers());
    let g = Math.min(CHAT_GLOBAL_MAX_PER_S, Math.max(CHAT_GLOBAL_MIN_PER_S, this.budgetBps() / (v * CHAT_BYTES_PER_MESSAGE)));
    if (this.guard.state === 'degrade') g = Math.max(CHAT_GLOBAL_MIN_PER_S, g / 2);
    return g;
  }

  /** Chat upload right now (bits per second, ~10 s average): the video limiter reserves it. */
  egressBitsPerS(): number {
    return this.batcher.egressBps() * 8;
  }

  // ---------------------------------------------------------------------------
  // Failure isolation
  // ---------------------------------------------------------------------------

  /** Run a chat entry point; an exception never leaves the chat (and never stops the live). */
  safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.fault(e);
      return undefined;
    }
  }

  private fault(e: unknown): void {
    const now = this.now();
    this.d.log.error({ err: e instanceof Error ? e.message : String(e) }, 'chat internal error');
    this.faults = this.faults.filter((t) => now - t < 60_000);
    this.faults.push(now);
    if (this.faults.length > MAX_FAULTS_PER_MIN && !this.broken) {
      this.broken = true;
      this.d.activity.action('log.chat.broken', undefined, 'error');
      try {
        this.system('chat.sys.stopped');
        this.refresh();
      } catch {}
    }
  }

  get isBroken(): boolean {
    return this.broken;
  }

  // ---------------------------------------------------------------------------
  // Viewer frames
  // ---------------------------------------------------------------------------

  /** A chat frame over the raw size limit (never decoded): "too long", without a nonce. */
  tooBig(socket: ChatSocket): void {
    this.safe(() => {
      const now = this.now();
      this.detector.frame(now);
      this.reject(socket, undefined, { code: 'text.tooLong', params: { max: this.d.settings().maxGraphemes } }, now);
    });
  }

  /** A chat frame was terminated for flooding (frame ceiling): counted by the detector. */
  terminated(): void {
    this.detector.terminated(this.now());
  }

  /**
   * One `chat.*` frame from a viewer (the control channel already checked the frame budget, the
   * raw size and the session). Cheapest checks first; the buckets run before JSON.parse.
   */
  frame(session: Session, socket: ChatSocket, text: string): void {
    this.safe(() => this.onFrame(session, socket, text));
  }

  private onFrame(session: Session, socket: ChatSocket, text: string): void {
    const now = this.now();
    this.detector.frame(now);
    if (text.startsWith('{"t":"chat.send"')) return this.onSend(session, socket, text, now);
    // Reaction frames (reserved for 0.5.0) have their own budget on /control and no handler yet.
    if (text.startsWith(CHAT_REACT_FRAME_PREFIX)) return;
    if (!this.eff.enabled) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    if (text.startsWith('{"t":"chat.color"')) {
      const p = chatColorSchema.safeParse(raw);
      if (p.success) this.onColor(session, p.data.color, now);
      return;
    }
    if (text.startsWith('{"t":"chat.resume"')) {
      const p = chatResumeSchema.safeParse(raw);
      if (p.success) this.onResume(session, socket, p.data.after, now);
    }
  }

  /** The nonce, read without parsing (`{"t":"chat.send","n":123,…}`), for early rejects. */
  private static nonceOf(text: string): number | undefined {
    const head = '{"t":"chat.send","n":';
    if (!text.startsWith(head)) return undefined;
    let n = 0;
    let i = head.length;
    for (; i < text.length && i < head.length + 10; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x30 || c > 0x39) break;
      n = n * 10 + (c - 0x30);
    }
    return i > head.length && n >= 1 && n <= 2 ** 31 - 1 ? n : undefined;
  }

  private onSend(session: Session, socket: ChatSocket, text: string, now: number): void {
    this.adaptive.offer(now);
    const n = ChatHub.nonceOf(text);
    const early = this.precheck(session, now);
    if (early) return this.reject(socket, n, early, now);
    // Provisional buckets: burst (device), IP, global. Refunded when validation fails.
    const pace = this.paces.get(session.deviceId);
    if (!pace.burst.take(now)) return this.reject(socket, n, { code: 'chat.err.slow', params: { count: Math.ceil(pace.burst.waitMs(now) / 1000) }, retryMs: pace.burst.waitMs(now) }, now);
    const ip = this.ipBucket(session, now);
    if (!ip.take(now)) {
      pace.burst.refund();
      return this.reject(socket, n, { code: 'chat.err.busy', retryMs: Math.max(1000, ip.waitMs(now)) }, now);
    }
    if (!this.global.take(now)) {
      pace.burst.refund();
      ip.refund();
      return this.reject(socket, n, { code: 'chat.err.busy', retryMs: Math.min(5000, Math.max(1000, this.global.waitMs(now))) }, now);
    }
    const refund = (): void => {
      pace.burst.refund();
      ip.refund();
      this.global.refund();
    };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      refund();
      return this.reject(socket, n, { code: 'text.invalid' }, now);
    }
    const parsed = chatSendSchema.safeParse(raw);
    if (!parsed.success) {
      refund();
      return this.reject(socket, n, { code: 'text.invalid' }, now);
    }
    const msg = parsed.data;
    const member = this.moderation.member(session);
    const result = msg.gif ? this.checkGif(msg.gif, pace, now) : this.checkText(msg.text ?? '', session.deviceId, now);
    if ('code' in result) {
      refund();
      return this.reject(socket, msg.n, result, now);
    }
    pace.lastAt = now;
    if (msg.gif) pace.lastGifAt = now;
    const s = this.append(member, 'x' in result ? { x: result.x } : { g: result.g }, false);
    this.batcher.sendDirect(socket, JSON.stringify({ t: 'chat.ack', n: msg.n, s } satisfies ChatServerMessage));
    this.accepted.add(now);
    this.adaptive.accept(now, session.deviceId);
    this.detector.accepted(now, session.deviceId, 'x' in result ? result.key : `gif:${result.g.id}`, session.joinedAt);
  }

  /** O(1) checks before any bucket: chat on, mute, lockdown, new-viewer wait, guard pause, slow mode. */
  private precheck(session: Session, now: number): Reject | null {
    if (!this.eff.enabled) return { code: 'chat.err.off' };
    const muted = this.moderation.mutedUntil(session);
    if (muted === 'live') return { code: 'chat.err.mutedLive' };
    if (muted !== null) return { code: 'chat.err.muted', params: { count: Math.ceil((muted - now) / 60_000) }, retryMs: muted - now };
    if (this.eff.lockdown && !(session.joinedAt < this.alertStartedAt && now - session.joinedAt >= this.eff.lockdownPresentMs)) return { code: 'chat.err.protect' };
    const waitMs = session.joinedAt + this.eff.newViewerWaitS * 1000 - now;
    if (waitMs > 0) return { code: 'chat.err.newViewer', params: { count: Math.ceil(waitMs / 1000) }, retryMs: waitMs };
    if (this.guard.state === 'pause') return { code: 'chat.err.busy', retryMs: 3000 };
    const pace = this.paces.peek(session.deviceId);
    if (pace && this.eff.slowS > 0) {
      const left = pace.lastAt + this.eff.slowS * 1000 - now;
      if (left > 0) return { code: 'chat.err.slow', params: { count: Math.ceil(left / 1000) }, retryMs: left };
    }
    return null;
  }

  /** Per-IP bucket: 2 msg/s × min(sessions behind that IP, 10), burst 10 (CGNAT-friendly). */
  private ipBucket(session: Session, now: number): TokenBucket {
    if (now - this.ipCountsAt > 1000) {
      this.ipCounts = new Map();
      for (const s of this.d.access.sessions.values()) this.ipCounts.set(s.ip, (this.ipCounts.get(s.ip) ?? 0) + 1);
      this.ipCountsAt = now;
    }
    const b = this.ipBuckets.get(session.ip);
    const k = Math.min(10, Math.max(1, this.ipCounts.get(session.ip) ?? 1));
    b.ratePerS = 2 * k;
    b.capacity = Math.max(10, 2 * k);
    return b;
  }

  private checkGif(gif: GifRef, pace: ViewerPace, now: number): Reject | { g: GifRef } {
    const s = this.d.settings();
    if (!this.eff.gifs || !this.eff.public.gif) return { code: 'chat.err.gifOff' };
    if (gif.p !== s.gif.provider) return { code: 'chat.err.gifInvalid' };
    const left = pace.lastGifAt + CHAT_GIF_INTERVAL_S * 1000 - now;
    if (pace.lastGifAt > 0 && left > 0) return { code: 'chat.err.slow', params: { count: Math.ceil(left / 1000) }, retryMs: left };
    return { g: gif };
  }

  /** Pipeline, content mode, links, blocked words, duplicates. */
  private checkText(input: string, dupScope: string, now: number, opts: { dup: boolean } = { dup: true }): Reject | { x: string; key: string } {
    const s = this.d.settings();
    const r = canonicalizeChatText(input, { maxGraphemes: s.maxGraphemes, maxEmoji: s.maxEmoji, scripts: s.scripts });
    if (!r.ok) return { code: r.code, params: r.params };
    const kinds = contentOf(r.text, this.emoteCodes);
    if ((kinds.text && !s.content.text) || (kinds.emotes && !s.content.emotes)) return { code: 'chat.err.mode', params: { allowedKey: contentKey(s.content) } };
    if (s.links === 'block' && containsLink(r.text)) return { code: 'chat.err.links' };
    const key = comparisonKey(r.text);
    if (!this.blocked.empty && this.blocked.test(key)) return { code: 'chat.err.blocked' };
    if (opts.dup && s.duplicateWindowS > 0) {
      const dk = `${dupScope}|${key}`;
      const at = this.dups.get(dk);
      if (at !== undefined && now - at < s.duplicateWindowS * 1000) return { code: 'chat.err.dup' };
      this.dups.delete(dk);
      this.dups.set(dk, now);
      while (this.dups.size > DUP_KEYS) this.dups.delete(this.dups.keys().next().value!);
    }
    return { x: r.text, key };
  }

  private reject(socket: ChatSocket, n: number | undefined, r: Reject, now: number): void {
    this.rejected.add(now);
    this.detector.reject(now, r.code);
    let b = this.socketRejects.get(socket);
    if (!b) this.socketRejects.set(socket, (b = new TokenBucket(REJECTS_PER_S, REJECTS_PER_S, now)));
    // Coalesced: a flooding script gets silence, not one reply per frame (upload).
    if (!b.take(now) && !SLOW_CODES.has(r.code)) return;
    const msg: ChatServerMessage = { t: 'chat.reject', ...(n !== undefined ? { n } : {}), code: r.code, ...(r.params ? { params: r.params } : {}), ...(r.retryMs !== undefined ? { retryMs: Math.max(0, Math.round(r.retryMs)) } : {}) };
    this.batcher.sendDirect(socket, JSON.stringify(msg));
  }

  private onColor(session: Session, color: string, now: number): void {
    if (!this.d.settings().viewerColors) return;
    const m = this.moderation.member(session);
    if (m.colorLocked) return this.sendYou(session.id);
    let b = this.colorBuckets.get(m);
    if (!b) this.colorBuckets.set(m, (b = new TokenBucket(2, 0.5, now)));
    if (!b.take(now)) return this.sendYou(session.id);
    this.moderation.setColor(m, color, false);
    this.announce(m, true);
    this.sendYou(session.id);
  }

  private onResume(session: Session, socket: ChatSocket, after: number, now: number): void {
    let b = this.socketResumes.get(socket);
    if (!b) this.socketResumes.set(socket, (b = new TokenBucket(2, 0.5, now)));
    if (!b.take(now)) return;
    if (after >= this.seq) return;
    const oldest = this.ring[0]?.item.s ?? this.seq + 1;
    if (after + 1 < oldest || after > this.seq) return this.resyncSocket(socket, session);
    const entries = this.ring.filter((e) => e.item.s > after);
    const items = entries.map((e) => e.item);
    const roster = this.rosterFor(entries);
    this.batcher.sendDirect(socket, JSON.stringify({ t: 'chat.batch', items: [...roster.map((au): ChatItem => ({ k: 'u', au })), ...items] } satisfies ChatServerMessage));
    this.batcher.markKnown(socket, roster.map((r) => r.a));
  }

  /** Full snapshot for one socket (missed moderation items while slow, or an evicted resume). */
  private resyncSocket(socket: ChatSocket, session?: Session): void {
    const sid = session?.id ?? (socket as ChatSocket & { sessionId?: string }).sessionId;
    const s = sid ? this.d.access.sessions.get(sid) : undefined;
    const snap = s ? this.snapshot(s) : undefined;
    if (snap) {
      this.batcher.sendDirect(socket, JSON.stringify({ t: 'chat.reset', ...snap } satisfies ChatServerMessage));
      this.batcher.markKnown(socket, snap.roster.map((r) => r.a));
    }
  }

  // ---------------------------------------------------------------------------
  // Ring and fan-out
  // ---------------------------------------------------------------------------

  private announce(m: ChatMember, force = false): void {
    if (!force && this.announced.has(m.a)) return;
    this.announced.add(m.a);
    const item: ChatItem = { k: 'u', au: this.moderation.author(m) };
    this.batcher.push(item, true);
    this.toAdmin(item);
  }

  /** Accept a message into the ring and the next batch; returns its seq. `refs`: other authors it names. */
  private append(m: ChatMember, body: { x: string } | { g: GifRef }, prio: boolean, refs?: readonly string[]): number {
    this.announce(m);
    const item: ChatRingItem = { k: 'm', s: ++this.seq, at: this.now(), a: m.a, ...body };
    this.ringPush(item, refs);
    this.batcher.push(item, prio, refs);
    this.toAdmin(item);
    return item.s;
  }

  /** A translated system line for everyone. */
  system(code: MessageKey, params?: MessageParams): void {
    const item: ChatRingItem = { k: 'sys', s: ++this.seq, at: this.now(), code, ...(params ? { params } : {}) };
    this.ringPush(item);
    this.batcher.push(item, true);
    this.toAdmin(item);
  }

  private ringPush(item: ChatRingItem, refs?: readonly string[]): void {
    const bytes = JSON.stringify(item).length;
    this.ring.push({ item, bytes, ...(refs?.length ? { refs } : {}) });
    this.ringBytes += bytes;
    while (this.ring.length > CHAT_RING_MAX_ITEMS || this.ringBytes > CHAT_RING_MAX_BYTES) this.ringBytes -= this.ring.shift()!.bytes;
  }

  private rosterFor(entries: readonly RingEntry[], extra: string[] = []): ChatAuthor[] {
    // Only the authors these entries name (and `extra`): a viewer who later gets an item naming an
    // author it has no entry for gets that entry from the batcher first (per-socket roster,
    // batcher.ts), so hellos stay small even when many viewers reconnect at once.
    const out: ChatAuthor[] = [];
    for (const a of ringAuthors(entries, extra)) {
      const au = this.moderation.authorOf(a);
      if (au) out.push(au);
    }
    return out;
  }

  private broadcast(msg: ChatServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.d.host.sockets()) this.batcher.sendDirect(s, data);
  }

  private sendTo(sessionId: string, msg: ChatServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.d.host.socketsOf(sessionId)) this.batcher.sendDirect(s, data);
  }

  private sendYou(sessionId: string): void {
    const s = this.d.access.sessions.get(sessionId);
    if (s) this.sendTo(sessionId, { t: 'chat.you', you: this.you(s) });
  }

  /** Flush the pending batch now (tests). */
  flush(): void {
    this.batcher.flush();
  }

  private toAdmin(item: ChatItem): void {
    if (!this.d.onAdmin) return;
    this.adminQueue.push(item);
    if (this.adminTimer) return;
    this.adminTimer = setTimeout(() => {
      this.adminTimer = null;
      const items = this.adminQueue;
      this.adminQueue = [];
      this.safe(() => this.d.onAdmin?.({ type: 'chat', reset: false, items, sessions: this.sessionMap(items), counters: this.counters() }));
    }, 250);
    this.adminTimer.unref?.();
  }

  private sessionMap(items: readonly ChatItem[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of items) {
      const a = i.k === 'm' ? i.a : i.k === 'u' ? i.au.a : undefined;
      const m = a ? this.moderation.byAuthor(a) : undefined;
      if (a && m) out[a] = m.sessionId;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  you(session: Session): ChatYou {
    const m = this.moderation.member(session);
    const waitUntil = session.joinedAt + this.eff.newViewerWaitS * 1000;
    return { a: m.a, color: m.color, colorLocked: m.colorLocked, mutedUntil: this.moderation.mutedUntil(session), ...(waitUntil > this.now() ? { waitUntil } : {}) };
  }

  /** The snapshot a viewer gets in hello (undefined while the chat is off). Counted in the budget by the caller's send. */
  snapshot(session: Session, opts: { after?: number } = {}): ChatSnapshot | undefined {
    return this.safe(() => {
      if (!this.eff.enabled) return undefined;
      // A burst of hellos (a tunnel drop reconnects everyone at once) must not blow the upload
      // budget: while it is in debt, history shrinks to the last few items.
      let n = this.eff.historyOnJoin;
      if (this.batcher.inDebt()) n = Math.min(n, SNAPSHOT_IN_DEBT);
      const you = this.you(session);
      const base = { v: CHAT_PROTOCOL_VERSION, settings: this.eff.public, you, lastSeq: this.seq };
      // Reconnect: the viewer already has everything up to `after`. Send only what came since, when
      // the ring still holds it, nothing was deleted or cleared meanwhile, and it is not longer than
      // a fresh snapshot would be.
      const after = opts.after;
      const oldest = this.ring[0]?.item.s ?? this.seq + 1;
      if (after !== undefined && after > 0 && after <= this.seq && after + 1 >= oldest && this.modSeq < after) {
        const entries = this.ring.filter((e) => e.item.s > after);
        if (entries.length <= Math.max(n, SNAPSHOT_IN_DEBT)) return { ...base, roster: this.rosterFor(entries, [you.a]), items: entries.map((e): ChatItem => e.item), delta: true as const };
      }
      const entries = n > 0 ? this.ring.slice(-n) : [];
      return { ...base, roster: this.rosterFor(entries, [you.a]), items: entries.map((e): ChatItem => e.item) };
    });
  }

  /** A hello carrying `snapshot` went to `socket` (`bytes` long): charged to the budget, roster noted. */
  helloSent(socket: ChatSocket, snapshot: ChatSnapshot, bytes: number): void {
    this.batcher.charge(bytes);
    this.batcher.markKnown(socket, snapshot.roster.map((r) => r.a));
  }

  /** Bytes of a snapshot sent outside the batcher: charged to the budget. */
  accountSent(bytes: number): void {
    this.batcher.charge(bytes);
  }

  // ---------------------------------------------------------------------------
  // Streamer (panel) actions
  // ---------------------------------------------------------------------------

  private streamerMember(): ChatMember {
    const name = this.d.settings().streamerName;
    return this.moderation.member({ id: STREAMER_ID, deviceId: STREAMER_ID, nickname: name }, 'streamer');
  }

  /** The streamer's name when set and valid; "" = viewers show the translated "Streamer". */
  static validStreamerName(name: string): string | null {
    if (name.trim() === '') return '';
    const r = validateNickname(name);
    return r.ok && countGraphemes(r.value) <= 24 ? r.value : null;
  }

  /** A message from the panel: role streamer, the same pipeline, only an anti-mistake limit. */
  sendAsStreamer(body: { text?: string; gif?: GifRef }): { ok: true; s: number } | { ok: false; code: ChatRejectCode | 'admin.chat.err.tooFast' | 'admin.chat.err.disabled'; params?: MessageParams } {
    const now = this.now();
    if (!this.eff.enabled) return { ok: false, code: 'admin.chat.err.disabled' };
    if (!this.streamerBucket.take(now)) return { ok: false, code: 'admin.chat.err.tooFast' };
    const m = this.streamerMember();
    if (body.gif) {
      if (!this.eff.public.gif || body.gif.p !== this.d.settings().gif.provider) return { ok: false, code: 'chat.err.gifOff' };
      return { ok: true, s: this.append(m, { g: body.gif }, true) };
    }
    const r = canonicalizeChatText(body.text ?? '', { maxGraphemes: this.d.settings().maxGraphemes, maxEmoji: this.d.settings().maxEmoji });
    if (!r.ok) {
      this.streamerBucket.refund();
      return { ok: false, code: r.code, params: r.params };
    }
    return { ok: true, s: this.append(m, { x: r.text }, true) };
  }

  delete(seqs: number[]): number {
    const set = new Set(seqs);
    const before = this.ring.length;
    this.ring = this.ring.filter((e) => {
      if (e.item.k === 'm' && set.has(e.item.s)) {
        this.ringBytes -= e.bytes;
        return false;
      }
      return true;
    });
    const removed = before - this.ring.length;
    this.modSeq = this.seq;
    const item: ChatItem = { k: 'd', s: [...set] };
    this.batcher.push(item, true);
    this.toAdmin(item);
    this.d.activity.action('log.chat.deleted', { count: seqs.length });
    return removed;
  }

  clear(): void {
    this.modSeq = this.seq;
    this.ring = [];
    this.ringBytes = 0;
    const item: ChatItem = { k: 'clr', s: this.seq };
    this.batcher.push(item, true);
    this.toAdmin(item);
    this.d.activity.action('log.chat.cleared');
    this.system('chat.sys.cleared');
  }

  mute(sessionId: string, minutes: number | null): boolean {
    const s = this.d.access.sessions.get(sessionId);
    if (!s) return false;
    const m = this.moderation.member(s);
    this.moderation.mute(m, minutes);
    if (minutes === null) this.d.activity.action('log.chat.mutedLive', { nickname: s.nickname });
    else this.d.activity.action('log.chat.muted', { nickname: s.nickname, minutes });
    if (this.d.settings().announceMutes) this.system(minutes === null ? 'chat.sys.mutedLive' : 'chat.sys.muted', minutes === null ? { nickname: s.nickname } : { nickname: s.nickname, minutes });
    this.sendYou(sessionId);
    return true;
  }

  unmute(sessionId: string): boolean {
    const s = this.d.access.sessions.get(sessionId);
    if (!s) return false;
    this.moderation.unmute(this.moderation.member(s));
    this.d.activity.action('log.chat.unmuted', { nickname: s.nickname });
    this.sendYou(sessionId);
    return true;
  }

  setColor(sessionId: string, color: string | null, lock: boolean): boolean {
    const s = this.d.access.sessions.get(sessionId);
    if (!s) return false;
    const m = this.moderation.member(s);
    this.moderation.setColor(m, color, lock);
    this.announce(m, true);
    this.d.activity.action('log.chat.color', { nickname: s.nickname });
    this.sendYou(sessionId);
    return true;
  }

  /** Manual protection from the panel; "off" also resets the detector ("Back to normal"). */
  setProtect(mode: ChatProtect): void {
    if (mode === 'off') {
      this.detector.reset();
      this.adaptive.reset();
      this.manualProtect = null;
    } else this.manualProtect = mode;
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // Panel state
  // ---------------------------------------------------------------------------

  counters(): ChatCounters {
    const now = this.now();
    return {
      acceptedPerMin: this.accepted.total(now),
      rejectedPerMin: this.rejected.total(now),
      skipped: this.batcher.droppedForBudget + this.batcher.skippedSlow,
      globalPerS: Math.round(this.globalPerS() * 10) / 10,
      egressKbps: Math.round(this.egressBitsPerS() / 100) / 10,
      budgetKbps: Math.round((this.budgetBps() * 8) / 1000),
      guard: this.guard.state,
      protect: this.protect,
      ...(this.protect !== 'off' ? { protectReason: this.manualProtect ? 'chat.protect.reason.manual' : this.detector.level > 0 ? 'chat.protect.reason.flood' : 'chat.protect.reason.shield' } : {}),
      broken: this.broken,
    };
  }

  adminState(): AdminChatState {
    const items = this.ring.map((e) => e.item);
    const sessions = [...this.d.access.sessions.values()].map((s) => {
      const m = this.moderation.member(s);
      return { sessionId: s.id, a: m.a, nickname: s.nickname, color: m.color, colorLocked: m.colorLocked, mutedUntil: this.moderation.mutedUntil(s), tag: m.tag };
    });
    return { settings: this.d.settings(), effective: this.eff.public, roster: this.rosterFor(this.ring), items, lastSeq: this.seq, sessions, counters: this.counters() };
  }

  /** Author key → session id of every author in the ring (the panel acts on sessions). */
  adminSessions(): Record<string, string> {
    return this.sessionMap(this.ring.map((e) => e.item));
  }

  get effective(): EffectiveChat {
    return this.eff;
  }

  get protection(): ChatProtect {
    return this.protect;
  }

  get guardState(): GuardState {
    return this.guard.state;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get ringSize(): { items: number; bytes: number } {
    return { items: this.ring.length, bytes: this.ringBytes };
  }
}

/** The message key naming what the chat accepts now (chat.content.*). */
function contentKey(c: ChatSettings['content']): MessageKey {
  const k = `${c.text ? 't' : ''}${c.emotes ? 'e' : ''}${c.gifs ? 'g' : ''}` || 'teg';
  return `chat.content.${k}` as MessageKey;
}
