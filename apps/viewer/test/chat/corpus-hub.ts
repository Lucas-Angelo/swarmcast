// The nasty-string corpus (packages/shared/test/chat/corpus.ts) said on a MockHub by authors with
// names from several scripts, as the server's pipeline would pass it. Shared by the corpus
// rendering spec (chat-render.spec.ts) and globalSetup (warm-browsers.ts), which renders the same
// page before any test so the machine's fonts for all of it are loaded once, up front.
import { canonicalizeChatText, validateNickname, type ChatAuthor } from '@swarmcast/shared/chat';
import { CORPUS } from '../../../../packages/shared/test/chat/corpus.js';
import type { MockHub } from './mock-hub.js';

/** Authors with names from several scripts (each one valid under the nickname rules). */
export const NAMES = ['Ana', 'Rafa_gamer', 'नमस्ते', 'עדי', 'アナ', 'Ζωή', 'محمد', 'ประเสริฐ', 'Nguyễn', 'క్షమ'];
/** The snapshot of a hello carries the last 50 messages: the corpus fits. */
export const SNAPSHOT_MAX = 50;

/** The corpus authors, from NAMES: the first is the streamer. */
function corpusAuthors(): ChatAuthor[] {
  return NAMES.map((n, i) => {
    const v = validateNickname(n);
    if (!v.ok) throw new Error(`${n}: ${v.code}`);
    return { a: `k${i}`, n: v.value, c: ['#e5484d', '#46a758', '#0090ff', '#d6409f', '#12a594'][i % 5]!, r: i === 0 ? 'streamer' : 'viewer' };
  });
}

/** Every corpus string the server's pipeline accepts, said on `hub` in turn by the corpus authors. */
export function sayCorpus(hub: MockHub): Array<{ id: string; text: string }> {
  const authors = corpusAuthors();
  const sent: Array<{ id: string; text: string }> = [];
  for (const e of CORPUS) {
    const r = canonicalizeChatText(e.input);
    if (!r.ok) continue;
    hub.say(authors[sent.length % authors.length]!, r.text);
    sent.push({ id: e.id, text: r.text });
  }
  return sent;
}
