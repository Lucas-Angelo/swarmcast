import { CHAT_REPLY_QUOTE_MAX_BYTES, CHAT_REPLY_QUOTE_MAX_GRAPHEMES } from './limits.js';
import { graphemeBounds } from './grapheme.js';
import { codePoints } from './ucd.js';

/**
 * The quote of a reply (docs/CHAT.md, "Replies and mentions"): the start of a message's canonical
 * text, cut on a grapheme boundary so it never splits an emoji ZWJ sequence, a flag, a mark run or a
 * surrogate pair, at most `maxGraphemes` graphemes and `maxBytes` UTF-8 bytes, without the spaces
 * the cut left at its end. `cut` says something was left out (the client adds the ellipsis).
 *
 * A prefix on a grapheme boundary of text that passes checkChatInvariants passes them too (it only
 * has fewer of everything), which a property test checks (properties.test.ts, P13). The server and
 * the clients run the same code, so a client's own preview of its reply shows what the server sends.
 */
export function cutQuote(text: string, maxGraphemes = CHAT_REPLY_QUOTE_MAX_GRAPHEMES, maxBytes = CHAT_REPLY_QUOTE_MAX_BYTES): { q: string; cut: boolean } {
  const cps = codePoints(text);
  const bounds = graphemeBounds(cps);
  const graphemes = bounds.length - 1;
  let end = 0;
  let bytes = 0;
  let n = 0;
  for (; n < graphemes && n < maxGraphemes; n++) {
    let b = 0;
    for (let i = bounds[n]!; i < bounds[n + 1]!; i++) b += utf8Bytes(cps[i]!);
    if (bytes + b > maxBytes) break;
    bytes += b;
    end = bounds[n + 1]!;
  }
  const cut = n < graphemes;
  // A space the cut left at the end is its own grapheme (canonical text has single spaces).
  while (end > 0 && cps[end - 1] === 0x20) end--;
  return { q: String.fromCodePoint(...cps.slice(0, end)), cut };
}

function utf8Bytes(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}
