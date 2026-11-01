import '../zod-config.js';
import { z } from 'zod';
import {
  CHAT_BLOCKED_WORDS_MAX,
  CHAT_BUDGET_SHARE_DEFAULT,
  CHAT_BUDGET_SHARE_MAX,
  CHAT_BUDGET_SHARE_MIN,
  CHAT_DELETE_MAX,
  CHAT_DUPLICATE_WINDOW_DEFAULT_S,
  CHAT_DUPLICATE_WINDOW_MAX_S,
  CHAT_HISTORY_ON_JOIN_DEFAULT,
  CHAT_HISTORY_ON_JOIN_MAX,
  CHAT_MAX_EMOJI_DEFAULT,
  CHAT_MAX_EMOJI_MAX,
  CHAT_MAX_EMOJI_MIN,
  CHAT_MAX_GRAPHEMES_DEFAULT,
  CHAT_MAX_GRAPHEMES_MAX,
  CHAT_MAX_GRAPHEMES_MIN,
  CHAT_MUTE_MAX_MIN,
  CHAT_NEW_VIEWER_WAIT_MAX_S,
  CHAT_SLOW_MODE_DEFAULT_S,
  CHAT_SLOW_MODE_MAX_S,
  CHAT_TEXT_MAX_UNITS,
  GIF_DIM_MAX,
  GIF_DIM_MIN,
  GIF_ID_RE,
  GIF_KEY_RE,
} from './limits.js';
import { GIF_PATH_MAX, gifMediaUrl } from './gif.js';

/**
 * Zod schemas of the chat (plan §4.3 and §5.2). Only plain regexes here (no `v` flag): this
 * module is part of the viewer's main bundle through clientMessageSchema.
 */

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((c) => c.toLowerCase());

export const chatContentKindSchema = z.enum(['text', 'emotes', 'gifs']);
export type ChatContentKind = z.infer<typeof chatContentKindSchema>;

export const gifProviderSchema = z.enum(['klipy', 'giphy']);
export type GifProvider = z.infer<typeof gifProviderSchema>;

/**
 * A GIF reference: provider + id + rendition size + the provider's media path (host-relative) and
 * which of its media hosts (index into GIF_PROVIDERS[p].media). Never a URL: clients build it from
 * an allowed host and a path that passed the provider's strict shape (gif.ts isGifMediaPath).
 */
export const gifRefSchema = z
  .strictObject({
    p: gifProviderSchema,
    id: z.string().regex(GIF_ID_RE),
    w: z.number().int().min(GIF_DIM_MIN).max(GIF_DIM_MAX),
    h: z.number().int().min(GIF_DIM_MIN).max(GIF_DIM_MAX),
    m: z.string().max(GIF_PATH_MAX),
    hi: z.number().int().min(0).max(7).optional(),
  })
  .refine((g) => gifMediaUrl(g) !== null, 'not a media path of this provider');
export type GifRef = z.infer<typeof gifRefSchema>;

/** Client nonce, echoed in chat.ack / chat.reject. */
export const chatNonceSchema = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/**
 * viewer → server `chat.send`. Exactly one of `text` or `gif`; the rule is a refinement, which
 * zod 4 keeps on the object, so the schema still works inside clientMessageSchema's
 * discriminated union (protocol.test.ts checks it).
 */
export const chatSendSchema = z
  .object({
    t: z.literal('chat.send'),
    n: chatNonceSchema,
    text: z.string().max(CHAT_TEXT_MAX_UNITS).optional(),
    gif: gifRefSchema.optional(),
  })
  .refine((m) => (m.text === undefined) !== (m.gif === undefined), 'exactly one of text or gif');

/** viewer → server: choose my name colour. */
export const chatColorSchema = z.object({ t: z.literal('chat.color'), color: hexColorSchema });

/** viewer → server: I missed items after `after` (a gap or a reconnect). */
export const chatResumeSchema = z.object({ t: z.literal('chat.resume'), after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

/** Every viewer → server chat message (added to clientMessageSchema). */
export const chatClientSchemas = [chatSendSchema, chatColorSchema, chatResumeSchema] as const;

/** Raw-frame prefix of a chat message: the viewer always serialises `t` first (plan §4.1). */
export const CHAT_FRAME_PREFIX = '{"t":"chat.';

/**
 * Raw-frame prefix of a reaction frame (`chat.react`, reserved for 0.5.0), closing quote included so
 * `chat.reactX` does not match. These frames have their own budget (CHAT_REACT_FRAMES_PER_10S).
 */
export const CHAT_REACT_FRAME_PREFIX = '{"t":"chat.react"';

// ---------------------------------------------------------------------------
// Streamer settings (config.json `chat`, config version 4)
// ---------------------------------------------------------------------------

export const chatLinksSchema = z.enum(['text', 'block']);
export const chatScriptsSchema = z.enum(['any', 'latin']);
export const gifRatingSchema = z.enum(['g', 'pg', 'pg-13']);
/**
 * Every viewer agrees before their browser contacts the GIF provider (user decision): there is no
 * "load automatically" mode, so the only value is 'ask'.
 */
export const gifConsentSchema = z.enum(['ask']);
export const chatProtectSchema = z.enum(['off', 'slow', 'lockdown']);
export type ChatProtect = z.infer<typeof chatProtectSchema>;

export const chatContentSettingsSchema = z
  .object({
    text: z.boolean().default(true),
    emotes: z.boolean().default(true),
    gifs: z.boolean().default(false),
  })
  .refine((c) => c.text || c.emotes || c.gifs, 'choose at least one kind of content, or turn the chat off');

export const chatGifSettingsSchema = z.object({
  provider: gifProviderSchema.default('klipy'),
  /** The streamer's own key ("" = none). Sent to viewers: both providers put it in the client. */
  key: z.union([z.literal(''), z.string().regex(GIF_KEY_RE)]).default(''),
  rating: gifRatingSchema.default('pg'),
  consent: gifConsentSchema.default('ask'),
});

/** A blocked word: 1..40 characters after trimming (graphemes are checked by the server). */
const blockedWordSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(200));

export const chatSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  content: chatContentSettingsSchema.prefault({}),
  slowModeS: z.number().int().min(0).max(CHAT_SLOW_MODE_MAX_S).default(CHAT_SLOW_MODE_DEFAULT_S),
  maxGraphemes: z.number().int().min(CHAT_MAX_GRAPHEMES_MIN).max(CHAT_MAX_GRAPHEMES_MAX).default(CHAT_MAX_GRAPHEMES_DEFAULT),
  maxEmoji: z.number().int().min(CHAT_MAX_EMOJI_MIN).max(CHAT_MAX_EMOJI_MAX).default(CHAT_MAX_EMOJI_DEFAULT),
  newViewerWaitS: z.number().int().min(0).max(CHAT_NEW_VIEWER_WAIT_MAX_S).default(0),
  duplicateWindowS: z.number().int().min(0).max(CHAT_DUPLICATE_WINDOW_MAX_S).default(CHAT_DUPLICATE_WINDOW_DEFAULT_S),
  historyOnJoin: z.number().int().min(0).max(CHAT_HISTORY_ON_JOIN_MAX).default(CHAT_HISTORY_ON_JOIN_DEFAULT),
  links: chatLinksSchema.default('text'),
  blockedWords: z.array(blockedWordSchema).max(CHAT_BLOCKED_WORDS_MAX).default([]),
  viewerColors: z.boolean().default(true),
  /** The streamer's name in the chat ("" = the translated "Streamer"). Checked with the nickname rules by the server. */
  streamerName: z.string().max(100).default(''),
  announceMutes: z.boolean().default(false),
  scripts: chatScriptsSchema.default('any'),
  autoProtect: z.boolean().default(true),
  /** Share of the upload cap chat may use (config file only). */
  budgetShare: z.number().min(CHAT_BUDGET_SHARE_MIN).max(CHAT_BUDGET_SHARE_MAX).default(CHAT_BUDGET_SHARE_DEFAULT),
  gif: chatGifSettingsSchema.prefault({}),
  emotes: z.object({ builtin: z.boolean().default(true) }).prefault({}),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

export function defaultChatSettings(): ChatSettings {
  return chatSettingsSchema.parse({});
}

// ---------------------------------------------------------------------------
// Admin API bodies (apps/server/src/admin/chat-routes.ts)
// ---------------------------------------------------------------------------

export const chatAdminSendSchema = z
  .object({ text: z.string().max(CHAT_TEXT_MAX_UNITS).optional(), gif: gifRefSchema.optional() })
  .refine((m) => (m.text === undefined) !== (m.gif === undefined), 'exactly one of text or gif');

export const chatDeleteSchema = z.object({ seqs: z.array(z.number().int().min(1)).min(1).max(CHAT_DELETE_MAX) });

const sessionIdSchema = z.string().min(1).max(64);

export const chatMuteSchema = z.object({
  sessionId: sessionIdSchema,
  /** null = until the end of this live. */
  minutes: z.number().int().min(1).max(CHAT_MUTE_MAX_MIN).nullable(),
});

export const chatUnmuteSchema = z.object({ sessionId: sessionIdSchema });

export const chatSetColorSchema = z.object({
  sessionId: sessionIdSchema,
  /** null = back to the default colour. */
  color: hexColorSchema.nullable(),
  lock: z.boolean(),
});

export const chatProtectRequestSchema = z.object({ mode: chatProtectSchema });
