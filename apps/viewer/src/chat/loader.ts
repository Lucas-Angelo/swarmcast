// The only chat code in the watch page's main bundle: it routes `chat.*` frames and loads the
// chat chunk (chat.ts) when the live has the chat on. The chunk is guarded: if it fails to load
// or to start (an old browser, a network error), the chat stays hidden and the video is not
// touched. Frames that arrive while it loads are kept (at most QUEUE_MAX) and replayed in order.
import type { ChatServerMessage, ChatSnapshot } from '@swarmcast/shared/chat';
import type { ChatController } from './chat.js';
import type { ClientFrame } from './session.js';

const QUEUE_MAX = 200;

export interface ChatRouter {
  /** hello from /control: its chat snapshot, or undefined when the chat is off. */
  hello(snapshot: ChatSnapshot | undefined): void;
  /** Every JSON frame whose t starts with "chat."; returns true when it was a chat frame. */
  frame(msg: { t: string }): boolean;
  connection(open: boolean): void;
  /** The /control URL to (re)connect to: with ?chatAfter=<seq> once chat items are shown. */
  controlUrl(base: string): string;
}

/** What the router needs from the chat chunk (chat.ts). */
export type ChatChunk = Pick<typeof import('./chat.js'), 'mountChat'>;

export function createChatRouter(opts: {
  root: HTMLElement;
  showButton: HTMLButtonElement;
  nickname: () => string;
  send(msg: ClientFrame): boolean;
  debug?: (msg: string) => void;
  /** Loads the chat chunk (by default the lazy import Vite splits off the main bundle). */
  loadChunk?: () => Promise<ChatChunk>;
}): ChatRouter {
  const loadChunk = opts.loadChunk ?? (() => import('./chat.js'));
  let controller: ChatController | null = null;
  let loading = false;
  let failed = false;
  let open = false;
  let pending: Array<() => void> = [];

  const run = (fn: (c: ChatController) => void): void => {
    if (controller) {
      try {
        fn(controller);
      } catch (err) {
        opts.debug?.(`chat: ${String(err)}`);
      }
      return;
    }
    if (failed) return;
    if (pending.length < QUEUE_MAX) pending.push(() => run(fn));
  };

  const load = (): void => {
    if (controller || loading || failed) return;
    loading = true;
    loadChunk()
      .then((m) => {
        controller = m.mountChat({ root: opts.root, showButton: opts.showButton, nickname: opts.nickname(), sendFrame: opts.send });
        controller.connection(open);
        const queued = pending;
        pending = [];
        for (const fn of queued) fn();
      })
      .catch((err: unknown) => {
        failed = true;
        pending = [];
        opts.root.hidden = true;
        opts.showButton.hidden = true;
        opts.debug?.(`chat chunk failed: ${String(err)}`);
      })
      .finally(() => {
        loading = false;
      });
  };

  return {
    hello(snapshot) {
      if (snapshot) load();
      if (snapshot || controller || loading) run((c) => c.hello(snapshot));
    },
    frame(msg) {
      if (typeof msg.t !== 'string' || !msg.t.startsWith('chat.')) return false;
      const m = msg as ChatServerMessage;
      // The chat was off at hello and is turned on now: load it (it asks for a snapshot).
      if (m.t === 'chat.settings' && m.settings?.enabled) load();
      if (controller || loading) run((c) => c.frame(m));
      return true;
    },
    connection(o) {
      open = o;
      if (controller) run((c) => c.connection(o));
    },
    controlUrl(base) {
      const seq = controller?.lastSeq() ?? 0;
      if (!(seq > 0)) return base;
      const u = new URL(base, location.href);
      u.searchParams.set('chatAfter', String(seq));
      return u.toString();
    },
  };
}
