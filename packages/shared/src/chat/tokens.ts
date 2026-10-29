import { P_EXTPICT, P_RI, P_VISIBLE, codePoints, graphemes, props } from './ucd.js';

/**
 * Tokenizer for rendering and for the content-mode checks: text, `:emote:` codes and emoji
 * graphemes. A linear scan; unknown `:codes:` stay text.
 */

export type ChatToken = { k: 't'; v: string } | { k: 'e'; code: string } | { k: 'j'; v: string };

/**
 * Codes of the built-in SwarmCast emote pack (assets/brand/emotes/emotes.json, made from the mascot
 * art by build_emotes.py; WP-C6). Clients map each code to its image; the server only needs the
 * codes. apps/viewer/test/unit/chat-emotes.test.ts checks this list against emotes.json.
 */
export const BUILTIN_EMOTE_CODES: readonly string[] = [
  'hi',
  'live',
  'sleep',
  'bee',
  'love',
  'hearts',
  'gg',
  'lol',
  'wow',
  'what',
  'fire',
  'hype',
  'sad',
  'zzz',
  'brb',
  'rec',
  'clip',
  'plus1',
  'cozy',
  'swarm',
];

const isCodeChar = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;

/** Is this grapheme an emoji (for modes and the emoji cap)? */
export function isEmojiText(g: string): boolean {
  for (const cp of codePoints(g)) if (props(cp) & (P_EXTPICT | P_RI) || cp === 0x20e3 || cp === 0xfe0f) return true;
  return false;
}

function pushText(out: ChatToken[], v: string): void {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.k === 't') last.v += v;
  else out.push({ k: 't', v });
}

function splitEmoji(out: ChatToken[], text: string): void {
  if (!text) return;
  let buf = '';
  for (const g of graphemes(text)) {
    if (isEmojiText(g)) {
      pushText(out, buf);
      buf = '';
      out.push({ k: 'j', v: g });
    } else buf += g;
  }
  pushText(out, buf);
}

/** Split `text` into tokens. Joining them (emotes as `:code:`) gives back `text` exactly. */
export function tokenizeChat(text: string, emoteCodes: ReadonlySet<string>): ChatToken[] {
  const out: ChatToken[] = [];
  let i = 0;
  let textStart = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x3a) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && j - i <= 25 && isCodeChar(text.charCodeAt(j))) j++;
    const len = j - i - 1;
    if (j < text.length && text.charCodeAt(j) === 0x3a && len >= 2 && len <= 24) {
      const code = text.slice(i + 1, j);
      if (emoteCodes.has(code)) {
        splitEmoji(out, text.slice(textStart, i));
        out.push({ k: 'e', code });
        i = j + 1;
        textStart = i;
        continue;
      }
    }
    i = j > i + 1 ? j : i + 1;
  }
  splitEmoji(out, text.slice(textStart));
  return out;
}

export function joinTokens(tokens: readonly ChatToken[]): string {
  return tokens.map((t) => (t.k === 'e' ? `:${t.code}:` : t.v)).join('');
}

/** What a message contains: visible text (letters, digits, punctuation…) and emotes or emoji. */
export function contentOf(text: string, emoteCodes: ReadonlySet<string>): { text: boolean; emotes: boolean } {
  let hasText = false;
  let hasEmotes = false;
  for (const t of tokenizeChat(text, emoteCodes)) {
    if (t.k !== 't') hasEmotes = true;
    else if (!hasText) for (const cp of codePoints(t.v)) if (props(cp) & P_VISIBLE) hasText = true;
  }
  return { text: hasText, emotes: hasEmotes };
}

const TLDS = new Set(['com', 'net', 'org', 'io', 'br', 'gg', 'tv', 'xyz', 'me', 'co', 'app', 'dev', 'link', 'ly', 'to', 'info', 'biz', 'ru', 'site', 'online', 'live', 'club', 'shop', 'top', 'us', 'uk', 'de', 'pt', 'es', 'fr', 'it', 'cc', 'ws', 'sh', 'gl', 'gd', 'bit']);

/**
 * Does the text look like it contains a link ("block links" setting)? A linear word scan: a
 * scheme ("://"), "www.", or a dotted word ending in a common top-level domain.
 */
export function containsLink(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('://') || lower.includes('www.')) return true;
  for (const raw of lower.split(' ')) {
    let w = raw;
    const slash = w.indexOf('/');
    if (slash > 0) w = w.slice(0, slash);
    while (w.length && '.,;:!?)]}\'"'.includes(w[w.length - 1]!)) w = w.slice(0, -1);
    const dot = w.lastIndexOf('.');
    if (dot <= 0 || dot === w.length - 1) continue;
    if (TLDS.has(w.slice(dot + 1))) return true;
  }
  return false;
}
