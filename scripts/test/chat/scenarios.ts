// Scenarios of the chat bench (docs/CHAT.md "Load and soak", chat plan §8.4 and §10.5). Each one
// says how many bots join, what they send, which chat settings apply, and what must hold for the
// run to pass. bench.ts runs them; bots.ts plays the bots.
import type { ChatSettings } from '@swarmcast/shared';

export type Behaviour =
  /** Each bot sends `perBotPerS` messages a second (jittered), unique texts. */
  | { kind: 'chat'; perBotPerS: number }
  /** Corpus strings (packages/shared/test/chat/corpus.ts) at the given rate. */
  | { kind: 'corpus'; perBotPerS: number }
  /** Every bot sends the same text. */
  | { kind: 'same'; perBotPerS: number }
  /** GIF messages. */
  | { kind: 'gif'; perBotPerS: number }
  /** Nothing (readers only). */
  | { kind: 'idle' };

export interface Scenario {
  name: string;
  description: string;
  bots: number;
  behaviour: Behaviour;
  /** Seconds of chat after a 5 s calm baseline. */
  seconds: number;
  /** Upload cap of the live (the chat budget is 4 % of it, 128–768 kbps). */
  uploadMbps: number;
  chat?: Partial<ChatSettings>;
  /** Bots 0..n-1 stop reading their socket (a slow consumer). */
  slowReaders?: number;
  /** Extra bots that join during the run and chat at once at their maximum. */
  raid?: { bots: number; atS: number; overS: number };
  /** Every bot drops its socket at this second and reconnects at once. */
  reconnectAtS?: number;
}

/** The highest rate a bot may send without being terminated (20 chat frames per 10 s). */
const MAX = 1.8;

export const SCENARIOS: Scenario[] = [
  { name: 'quiet', description: '120 viewers, 0.5 msg/s overall', bots: 120, behaviour: { kind: 'chat', perBotPerS: 0.5 / 120 }, seconds: 30, uploadMbps: 10 },
  { name: 'lively', description: '120 viewers, 3 msg/s overall', bots: 120, behaviour: { kind: 'chat', perBotPerS: 3 / 120 }, seconds: 30, uploadMbps: 10 },
  { name: 'flood', description: '120 viewers, every one at the highest rate the socket allows', bots: 120, behaviour: { kind: 'chat', perBotPerS: MAX }, seconds: 30, uploadMbps: 10, chat: { slowModeS: 0 } },
  {
    name: 'raid',
    description: '120 viewers chatting, then 60 more join within 30 s and chat at once at their maximum',
    bots: 120,
    behaviour: { kind: 'chat', perBotPerS: 3 / 120 },
    seconds: 50,
    uploadMbps: 10,
    raid: { bots: 60, atS: 5, overS: 30 },
  },
  { name: 'zalgo', description: '50 viewers sending the nasty-string corpus at the highest rate', bots: 50, behaviour: { kind: 'corpus', perBotPerS: MAX }, seconds: 30, uploadMbps: 10, chat: { slowModeS: 0, duplicateWindowS: 0 } },
  { name: 'slow-readers', description: '120 viewers, 20 of them stop reading their socket, the rest chat', bots: 120, behaviour: { kind: 'chat', perBotPerS: 6 / 120 }, seconds: 40, uploadMbps: 10, slowReaders: 20 },
  { name: 'dup-storm', description: '60 viewers sending the same text', bots: 60, behaviour: { kind: 'same', perBotPerS: 0.5 }, seconds: 30, uploadMbps: 10, chat: { slowModeS: 0 } },
  {
    name: 'gif-spam',
    description: '30 viewers sending GIFs as fast as they can',
    bots: 30,
    behaviour: { kind: 'gif', perBotPerS: 1 },
    seconds: 40,
    uploadMbps: 10,
    chat: { slowModeS: 0, content: { text: true, emotes: true, gifs: true }, gif: { provider: 'klipy', key: 'benchkey_0123456789', rating: 'pg', consent: 'ask' } },
  },
  { name: 'reconnect-storm', description: '120 viewers drop and reconnect at the same moment', bots: 120, behaviour: { kind: 'chat', perBotPerS: 3 / 120 }, seconds: 30, uploadMbps: 10, reconnectAtS: 15 },
];
