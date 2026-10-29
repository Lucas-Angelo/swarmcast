// `:emote:` tokenizer (plan §5.7). A linear scan, no regex over user text.
// TEMPORARY local copy: packages/shared/src/chat/tokens.ts (lane A / C1) owns this; once it lands,
// core/index.ts re-exports it.
const EMOTE_CODE_MIN = 2;
const EMOTE_CODE_MAX = 24;

/** Text, an emote, or (lane A's tokenizer) an emoji run; this local copy never emits 'j'. */
export type ChatToken = { k: 't'; v: string } | { k: 'e'; code: string } | { k: 'j'; v: string };

const codeChar = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;

/**
 * Split `text` into plain text and emote tokens. Only codes in `known` become emotes; anything
 * else (unknown codes, "a:b", URLs) stays text. Joining the tokens gives back the text.
 */
export function tokenizeChat(text: string, emoteCodes: ReadonlySet<string>): ChatToken[] {
  const out: ChatToken[] = [];
  if (emoteCodes.size === 0) return text ? [{ k: 't', v: text }] : [];
  let textStart = 0;
  let i = text.indexOf(':');
  while (i !== -1) {
    let j = i + 1;
    while (j < text.length && j - i - 1 <= EMOTE_CODE_MAX && codeChar(text.charCodeAt(j))) j++;
    const len = j - i - 1;
    if (j < text.length && text.charCodeAt(j) === 0x3a && len >= EMOTE_CODE_MIN && len <= EMOTE_CODE_MAX) {
      const code = text.slice(i + 1, j);
      if (emoteCodes.has(code)) {
        if (i > textStart) out.push({ k: 't', v: text.slice(textStart, i) });
        out.push({ k: 'e', code });
        textStart = j + 1;
        i = text.indexOf(':', j + 1);
        continue;
      }
      // The closing colon may open the next code (":x:hi:"): look again from it.
      i = j;
      continue;
    }
    i = text.indexOf(':', i + 1);
  }
  if (textStart < text.length) out.push({ k: 't', v: text.slice(textStart) });
  return out;
}
