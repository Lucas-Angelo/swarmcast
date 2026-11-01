import type { z } from 'zod';
import type { MessageKey, MessageParams } from '../i18n/index.js';
import type { ChatContentKind, ChatProtect, ChatSettings, GifProvider, GifRef, chatClientSchemas } from './schemas.js';

/**
 * Chat wire format on /control (plan §4.3). Server → viewer messages are typed, not parsed at
 * run time (like ServerMessage). Keys are short on purpose: every message is sent once per
 * viewer, so the compact form is what keeps chat inside its upload budget.
 *
 * Compatibility (plan §4.7): clients ignore unknown `t` and unknown `k`; new fields are
 * optional; a breaking change bumps CHAT_PROTOCOL_VERSION and old pages show "reload".
 *
 * Only `m` and `sys` ever take a `seq` (CHAT_SEQ_KINDS): a client sees a gap in seq as missed items
 * and asks to resume, so a new kind that took one would stall every older page. New kinds are
 * seq-less, like `d` and `clr`: durable ones (never dropped; a slow socket that missed one gets a
 * fresh snapshot) or ephemeral ones (latest-wins state such as vote or reaction counts: at most one
 * pending per key, dropped first under upload pressure, never a reason for a snapshot).
 */

export type ChatRole = 'viewer' | 'streamer';

/** Roster entry: author key, nickname, colour (sRGB hex as chosen; clients enforce contrast), role. */
export interface ChatAuthor {
  /** Opaque per-session key (base36). Never the session id. */
  a: string;
  /** Nickname (already canonical). */
  n: string;
  /** Colour, "#rrggbb". */
  c: string;
  r: ChatRole;
  /** Short tag (4 base32 characters) that tells apart two people with look-alike names. */
  tag?: string;
}

/** A chat message: `x` (text) or `g` (GIF), never both. */
export interface ChatMessageItem {
  k: 'm';
  /** Sequence number (the message id), increasing by one per ring item within a live. */
  s: number;
  /** Server receive time (Unix ms). */
  at: number;
  /** Author key (see the roster). */
  a: string;
  x?: string;
  g?: GifRef;
}

/** Roster upsert: first appearance of an author, or a colour change. */
export interface ChatRosterItem {
  k: 'u';
  au: ChatAuthor;
}

/** Messages deleted by the streamer. */
export interface ChatDeleteItem {
  k: 'd';
  s: number[];
}

/** The chat was cleared up to and including `s`. */
export interface ChatClearItem {
  k: 'clr';
  s: number;
}

/** A translated system line ("X was muted for 10 min", "The chat is protected right now"). */
export interface ChatSystemItem {
  k: 'sys';
  s: number;
  at: number;
  code: MessageKey;
  params?: MessageParams;
}

/** `n` messages were not delivered to this viewer (upload budget or a slow connection). */
export interface ChatSkipItem {
  k: 'skip';
  n: number;
}

export type ChatItem = ChatMessageItem | ChatRosterItem | ChatDeleteItem | ChatClearItem | ChatSystemItem | ChatSkipItem;

/** Ring items (they carry a `seq`). */
export type ChatRingItem = ChatMessageItem | ChatSystemItem;

/** The only item kinds that take a `seq` (see the compatibility note above). */
export const CHAT_SEQ_KINDS: readonly ChatRingItem['k'][] = ['m', 'sys'];

/** A ring item: one of CHAT_SEQ_KINDS. Any other kind, known or not, never counts in the seq order. */
export function isChatSeqItem(item: unknown): item is ChatRingItem {
  if (item === null || typeof item !== 'object') return false;
  const k = (item as { k?: unknown }).k;
  return k === 'm' || k === 'sys';
}

/** Settings every viewer gets (the effective values: manual + automatic protection). */
export interface ChatPublicSettings {
  enabled: boolean;
  content: ChatContentKind[];
  /** Effective seconds between messages per viewer (manual or automatic, whichever is higher). */
  slowS: number;
  /** slowS was raised automatically (busy chat or protection). */
  autoSlow: boolean;
  maxGraphemes: number;
  maxEmoji: number;
  newViewerWaitS: number;
  /** Viewers may choose their name colour. */
  colors: 'choose' | 'fixed';
  linksBlocked: boolean;
  /** Present only while the streamer has GIFs on (and a key) and protection allows them. */
  /** `consent` is always 'ask': each viewer agrees before their browser contacts the provider. */
  gif?: { provider: GifProvider; key: string; rating: string; consent: 'ask' };
  /** Custom emotes (0.4.1); empty in 0.4.0. Built-in emotes ship with the viewer. */
  emotes: Array<{ code: string; url: string; w: number; h: number; animated: boolean }>;
  builtinEmotes: boolean;
  /** Automatic or manual flood protection state. */
  protect: ChatProtect;
  /** Display name of the streamer ("" = the translated default). */
  streamerName: string;
}

/** What this viewer may do right now. `mutedUntil`: Unix ms, 'live' (until the stream ends) or null. */
export interface ChatYou {
  a: string;
  color: string;
  colorLocked: boolean;
  mutedUntil: number | 'live' | null;
  /** Unix ms before which this viewer may not chat yet (new-viewer wait); absent when none. */
  waitUntil?: number;
}

/** Full snapshot: on connect (inside hello), and when a resume cannot be served from the ring. */
export interface ChatSnapshot {
  v: number;
  settings: ChatPublicSettings;
  you: ChatYou;
  roster: ChatAuthor[];
  items: ChatItem[];
  /** Highest seq so far in this live (0 = none). */
  lastSeq: number;
  /**
   * A reconnect delta: `items` are only those after the seq the viewer said it already has
   * (`/control?chatAfter=<seq>`); keep what is shown and add them. Absent: a full snapshot.
   */
  delta?: true;
}

/** Reject codes (each is a message key in en.ts / pt-BR.ts). */
export const CHAT_REJECT_CODES = [
  'chat.err.off',
  'chat.err.muted',
  'chat.err.mutedLive',
  'chat.err.slow',
  'chat.err.busy',
  'chat.err.newViewer',
  'chat.err.protect',
  'chat.err.mode',
  'chat.err.dup',
  'chat.err.blocked',
  'chat.err.links',
  'chat.err.gifOff',
  'chat.err.gifInvalid',
  'text.tooLong',
  'text.empty',
  'text.invalid',
  'text.combining',
  'text.tooManyEmoji',
  'text.script',
] as const satisfies readonly MessageKey[];
export type ChatRejectCode = (typeof CHAT_REJECT_CODES)[number];

export type ChatServerMessage =
  | { t: 'chat.batch'; items: ChatItem[] }
  | { t: 'chat.ack'; n: number; s: number }
  | { t: 'chat.reject'; n?: number; code: ChatRejectCode; params?: MessageParams; retryMs?: number }
  | { t: 'chat.settings'; settings: ChatPublicSettings }
  | { t: 'chat.you'; you: ChatYou }
  | ({ t: 'chat.reset' } & ChatSnapshot);

/**
 * Viewer → server chat messages as the viewer builds them: `chat.send` carries `text` or `gif`,
 * never both (the rule chatSendSchema refines). The server parses them with chatClientSchemas.
 */
export type ChatClientMessage =
  | { t: 'chat.send'; n: number; text: string }
  | { t: 'chat.send'; n: number; gif: GifRef }
  | { t: 'chat.color'; color: string }
  | { t: 'chat.resume'; after: number };

/** Compile-time check: every ChatClientMessage is an input chatClientSchemas accepts by shape. */
type _ConformsToSchemas<T extends z.input<(typeof chatClientSchemas)[number]>> = T;
type _ChatClientMessageCheck = _ConformsToSchemas<ChatClientMessage>;

/** Counters shown in the panel's chat card (per minute, rolling). */
export interface ChatCounters {
  acceptedPerMin: number;
  rejectedPerMin: number;
  skipped: number;
  /** Effective global limit G (messages per second). */
  globalPerS: number;
  /** Chat upload right now, kbps, and its budget. */
  egressKbps: number;
  budgetKbps: number;
  /** Event-loop guard state. */
  guard: 'ok' | 'degrade' | 'pause';
  protect: ChatProtect;
  /** Why protection is on (automatic), as a message key. */
  protectReason?: MessageKey;
  /** The chat stopped itself after repeated internal errors (the stream is not affected). */
  broken: boolean;
}

/** Per-session moderation state the panel shows (mutes, colours). */
export interface ChatSessionInfo {
  sessionId: string;
  a: string;
  nickname: string;
  color: string;
  colorLocked: boolean;
  mutedUntil: number | 'live' | null;
  tag: string;
}

/**
 * Admin /ws message with chat items. Separate from AdminState, so the big snapshot never carries
 * chat. `sessions` maps author keys to session ids (the panel may act on them). `reset` replaces
 * the panel's list (connect, clear).
 */
export interface AdminChatMessage {
  type: 'chat';
  reset: boolean;
  items: ChatItem[];
  sessions: Record<string, string>;
  counters?: ChatCounters;
}

/** GET /api/chat */
export interface AdminChatState {
  settings: ChatSettings;
  effective: ChatPublicSettings;
  roster: ChatAuthor[];
  items: ChatItem[];
  lastSeq: number;
  sessions: ChatSessionInfo[];
  counters: ChatCounters;
}
