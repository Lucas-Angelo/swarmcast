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

/**
 * What a reply answers (docs/CHAT.md, "Replies and mentions"): the message's seq and author, and a
 * quote the server cut from its text (never text from the client). `q` absent: a GIF (`gif`), a
 * message deleted since (`gone`, the quote is wiped), or a quote hidden because it holds a blocked
 * word. Pages older than 0.5.0 ignore it and show the reply as a plain message.
 */
export interface ChatReplyRef {
  s: number;
  a: string;
  /** The first CHAT_REPLY_QUOTE_MAX_GRAPHEMES graphemes of its canonical text, cut on a grapheme boundary. */
  q?: string;
  /** The quote is shorter than the message (the client adds an ellipsis). */
  cut?: 1;
  /** It was a GIF. */
  gif?: 1;
  /** It was deleted: "Original message deleted". */
  gone?: 1;
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
  /** Highlighted by the streamer (absent: not highlighted). Snapshots and resume answers carry the current value. */
  h?: 1;
  /** A reply: the message it answers (its author's roster entry is always sent before it). */
  re?: ChatReplyRef;
  /** Author keys this message mentions, checked by the server (at most CHAT_MENTIONS_MAX; roster entries sent before it). */
  mn?: string[];
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

/**
 * The streamer highlighted a message (`on`) or took the highlight off. Seq-less: `s` names the
 * message, it is not a seq of this item. A client that does not have message `s` ignores it.
 */
export interface ChatHighlightItem {
  k: 'hl';
  s: number;
  on: boolean;
}

/** The message pinned at the top of the chat: a copy, so it outlives the message's place in the ring. */
export interface ChatPin {
  /** Seq of the pinned message. */
  s: number;
  /** Its author key (see the roster; always sent before the pin). */
  a: string;
  /** Its text (canonical) or its GIF, never both. */
  x?: string;
  g?: GifRef;
  /** When it was pinned (server time, Unix ms): tells one pin of the same message from the next. */
  at: number;
  /** A timed pin: milliseconds left when this was sent (relative, so clock skew does not matter). */
  endsIn?: number;
}

/** The pin changed: a new pinned message (replacing any other), or `null` (unpinned). Seq-less. */
export interface ChatPinItem {
  k: 'pin';
  p: ChatPin | null;
}

export type ChatPollKind = 'poll' | 'prediction';
/**
 * open: voting. closed: a poll's voting ended, its results show. locked: a prediction's guesses
 * ended, waiting for the streamer's answer. resolved: a prediction with its right answer.
 * (A canceled or expired poll is no poll: `{k: 'poll', p: null}`.)
 */
export type ChatPollState = 'open' | 'closed' | 'locked' | 'resolved';

/** A poll or a prediction as viewers see it (docs/CHAT.md, "Polls and predictions"). */
export interface ChatPollPublic {
  /** Per live ("p1", "p2"…): a vote names it, so a vote for a poll that is gone is refused. */
  id: string;
  kind: ChatPollKind;
  /** Question and options, canonical (the chat's Unicode pipeline). */
  q: string;
  o: string[];
  st: ChatPollState;
  /** Votes per option (shown live while voting). */
  c: number[];
  /** While open: milliseconds of voting left when this was sent (relative, so clock skew does not matter). */
  endsIn?: number;
  /** A resolved prediction: the right option (index into `o`). */
  win?: number;
  /** Only people who were already watching when it opened may vote. */
  newOnly?: true;
  /** In a snapshot or a `chat.voted`: the option this device voted for. */
  mine?: number;
  /** Panel only: devices whose vote was refused because their network already gave CHAT_POLL_VOTES_PER_NET votes. */
  rn?: number;
}

/** The poll changed (opened, ended, answered) or is gone (`null`). A seq-less state item (key `poll`). */
export interface ChatPollItem {
  k: 'poll';
  p: ChatPollPublic | null;
}

/**
 * The vote counts of poll `id` now: an ephemeral latest-wins item (at most one per
 * CHAT_POLL_TALLY_MS, never in the ring, a snapshot or a resume answer; a slow socket that misses
 * one gets the next). A count for another poll id is ignored.
 */
export interface ChatPollTallyItem {
  k: 'pt';
  id: string;
  c: number[];
  /** Panel only: as ChatPollPublic.rn. */
  rn?: number;
}

export type ChatItem = ChatMessageItem | ChatRosterItem | ChatDeleteItem | ChatClearItem | ChatSystemItem | ChatSkipItem | ChatHighlightItem | ChatPinItem | ChatPollItem | ChatPollTallyItem;

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
  /** The pinned message, in full snapshots and in deltas alike (absent: nothing is pinned). */
  pin?: ChatPin;
  /** The poll or prediction on screen, with this device's vote (`mine`), in full snapshots and deltas alike (absent: none). */
  poll?: ChatPollPublic;
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
  'chat.err.pollClosed',
  'chat.err.voted',
  'chat.err.pollLate',
  'chat.err.pollNet',
] as const satisfies readonly MessageKey[];
export type ChatRejectCode = (typeof CHAT_REJECT_CODES)[number];

export type ChatServerMessage =
  | { t: 'chat.batch'; items: ChatItem[] }
  | { t: 'chat.ack'; n: number; s: number }
  | { t: 'chat.reject'; n?: number; code: ChatRejectCode; params?: MessageParams; retryMs?: number }
  | { t: 'chat.settings'; settings: ChatPublicSettings }
  | { t: 'chat.you'; you: ChatYou }
  | ({ t: 'chat.reset' } & ChatSnapshot)
  /** A vote was counted: to every socket of every session of the voting device (other tabs show it at once), with the counts now. */
  | { t: 'chat.voted'; n?: number; id: string; o: number; c: number[] };

/**
 * Viewer → server chat messages as the viewer builds them: `chat.send` carries `text` or `gif`,
 * never both (the rule chatSendSchema refines). The server parses them with chatClientSchemas.
 */
export type ChatClientMessage =
  | { t: 'chat.send'; n: number; text: string; re?: number; mn?: string[] }
  | { t: 'chat.send'; n: number; gif: GifRef; re?: number }
  | { t: 'chat.color'; color: string }
  | { t: 'chat.resume'; after: number }
  | { t: 'chat.vote'; n: number; id: string; o: number };

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
  /** The pinned message (absent: nothing is pinned). */
  pin?: ChatPin;
  /** The poll or prediction on screen, with `rn` (absent: none). */
  poll?: ChatPollPublic;
}
