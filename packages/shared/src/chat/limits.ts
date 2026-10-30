/**
 * Chat limits (docs/CHAT.md, plan §2.2). The server and every client import these same
 * constants, so the limits cannot drift apart.
 */

/** Version of the chat wire format (`hello.chat.v`, `chat.reset.v`). */
export const CHAT_PROTOCOL_VERSION = 1;

/** Raw `chat.*` frame on /control, in bytes, checked before the frame is decoded or parsed. */
export const CHAT_FRAME_MAX_BYTES = 2048;

/** `text` field before the pipeline, in UTF-16 code units (bounds the work; NFC at most triples it). */
export const CHAT_TEXT_MAX_UNITS = 1500;

/** UTF-8 bytes of a message after the pipeline (bounds fan-out). */
export const CHAT_TEXT_MAX_BYTES = 1024;

/** Visible length in graphemes: default and the range the streamer may choose. */
export const CHAT_MAX_GRAPHEMES_DEFAULT = 200;
export const CHAT_MAX_GRAPHEMES_MIN = 20;
export const CHAT_MAX_GRAPHEMES_MAX = 500;

/** Emoji graphemes per message: default and range. */
export const CHAT_MAX_EMOJI_DEFAULT = 30;
export const CHAT_MAX_EMOJI_MIN = 1;
export const CHAT_MAX_EMOJI_MAX = 100;

/** Code points in one grapheme, and in one emoji grapheme (the longest RGI sequence has 10). */
export const CHAT_GRAPHEME_MAX_CODEPOINTS = 16;
export const CHAT_EMOJI_MAX_CODEPOINTS = 10;
/** ZWJs in one emoji grapheme (the most in RGI). */
export const CHAT_EMOJI_MAX_ZWJ = 3;

/** Consecutive nonspacing/enclosing marks kept (UTS #39 §5.4); no identical mark twice in a row. */
export const CHAT_MAX_MARK_RUN = 4;
/** More marks dropped than this in one message: reject `text.combining`. */
export const CHAT_MAX_DROPPED_MARKS = 20;

/** Implicit bidi marks (LRM, RLM, ALM) kept per message. */
export const CHAT_MAX_BIDI_MARKS = 4;

/** History (memory only, wiped on Stop). */
export const CHAT_RING_MAX_ITEMS = 200;
export const CHAT_RING_MAX_BYTES = 256 * 1024;
export const CHAT_HISTORY_ON_JOIN_DEFAULT = 50;
export const CHAT_HISTORY_ON_JOIN_MAX = 100;

/** Slow mode: seconds between messages per viewer (0 = only the burst bucket). */
export const CHAT_SLOW_MODE_DEFAULT_S = 2;
export const CHAT_SLOW_MODE_MAX_S = 300;
/** Presets the panel offers for slow mode. */
export const CHAT_SLOW_MODE_PRESETS_S = [0, 2, 5, 10, 30, 60, 120] as const;

/** Burst bucket per viewer: 5 messages, refilled at 0.5 per second. */
export const CHAT_BURST_CAPACITY = 5;
export const CHAT_BURST_REFILL_PER_S = 0.5;

/** Raw chat frames per socket per 10 s before the socket is terminated (4× what the UI can send). */
export const CHAT_MAX_FRAMES_PER_10S = 20;

/** Seconds between two GIFs from one viewer. */
export const CHAT_GIF_INTERVAL_S = 30;

/** Duplicate window: default and range (0 = allow repeats). */
export const CHAT_DUPLICATE_WINDOW_DEFAULT_S = 30;
export const CHAT_DUPLICATE_WINDOW_MAX_S = 300;

/** New-viewer wait before chatting: range. */
export const CHAT_NEW_VIEWER_WAIT_MAX_S = 600;

/** Blocked words: entries and graphemes per entry. */
export const CHAT_BLOCKED_WORDS_MAX = 200;
export const CHAT_BLOCKED_WORD_MAX_GRAPHEMES = 40;

/** Mute lengths offered by the panel, in minutes (null = until the end of this live). */
export const CHAT_MUTE_PRESETS_MIN = [1, 10, 60] as const;
export const CHAT_MUTE_MAX_MIN = 1440;

/** Messages the streamer may delete in one request. */
export const CHAT_DELETE_MAX = 100;

/**
 * Share of the upload cap chat may use, and its clamp in kbps (plan §6.1, raised from 4 % and
 * 768 kbps: a lively chat of 3 msg/s to 120 viewers needs about 408 kbps on a 10 Mbps cap).
 */
export const CHAT_BUDGET_SHARE_DEFAULT = 0.05;
export const CHAT_BUDGET_SHARE_MIN = 0.01;
export const CHAT_BUDGET_SHARE_MAX = 0.1;
export const CHAT_BUDGET_MIN_KBPS = 128;
export const CHAT_BUDGET_MAX_KBPS = 960;

/** Global accepted messages per second: floor and ceiling of G. */
export const CHAT_GLOBAL_MIN_PER_S = 1;
export const CHAT_GLOBAL_MAX_PER_S = 20;

/** Bytes a message costs per viewer in the budget formula (compact wire format + overhead). */
export const CHAT_BYTES_PER_MESSAGE = 70;

/** Batch windows (ms): up to 40 viewers, above that, and under budget or CPU pressure. */
export const CHAT_BATCH_MS = 250;
export const CHAT_BATCH_MS_LARGE = 500;
export const CHAT_BATCH_MS_PRESSURE = 1000;
export const CHAT_BATCH_LARGE_AUDIENCE = 40;

/** Chat is not sent to a socket with more than this many bytes waiting to go out. */
export const CHAT_SOCKET_BUFFER_MAX = 64 * 1024;

/** Nickname length (graphemes); the same as NICKNAME_MAX. */
export const CHAT_NICKNAME_MAX = 24;

/** Streamer name in the chat (graphemes). */
export const CHAT_STREAMER_NAME_MAX = 24;

/** GIF id from a provider: never a URL. */
export const GIF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** GIF rendition size (px) reported by the picker. */
export const GIF_DIM_MIN = 16;
export const GIF_DIM_MAX = 498;
/** A provider API key (both providers put it in the client by design). */
export const GIF_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Emote code inside `:…:`. */
export const EMOTE_CODE_RE = /^[a-z0-9_]{2,24}$/;

/** Default name colours (plan §5.4): no violet or indigo-heavy hues. */
export const CHAT_DEFAULT_PALETTE = [
  '#e5484d',
  '#f76b15',
  '#d4a017',
  '#46a758',
  '#12a594',
  '#0090ff',
  '#3e63dd',
  '#c2410c',
  '#d6409f',
  '#a18072',
  '#5b8c00',
  '#00a2c7',
] as const;

/** Contrast the client enforces for name colours against the chat background (WCAG AA). */
export const CHAT_MIN_CONTRAST = 4.5;
/** Contrast the adjuster aims at, to absorb rounding to 8-bit channels. */
export const CHAT_TARGET_CONTRAST = 4.6;

/** Reserved name keys (compared by skeleton): nobody may join with one of these. */
export const CHAT_RESERVED_NAMES = [
  'streamer',
  'transmissor',
  'transmissora',
  'transmissao',
  'swarmcast',
  'admin',
  'administrador',
  'moderator',
  'moderador',
  'mod',
  'system',
  'sistema',
] as const;
