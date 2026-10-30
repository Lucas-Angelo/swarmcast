import type {
  AdminChatMessage,
  AdminChatState,
  AdminDesktopMessage,
  AdminLogMessage,
  AdminSocketMessage,
  AdminState,
  ApiErrorBody,
  ChatProtect,
  ChatPublicSettings,
  ChatSettings,
  MessageKey,
  MessageParams,
} from '@swarmcast/shared';
import { tc } from '@swarmcast/shared/i18n';
import { chatStore } from './chat/store.js';

/** API error with the server's English text and, when known, a code to translate it. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: MessageKey,
    readonly params?: MessageParams,
  ) {
    super(message);
  }

  /** The message in the current UI language (English fallback). */
  get translated(): string {
    return tc(this, this.message);
  }
}

/** Translated text of any error thrown by api()/post(). */
export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.translated : (err as Error).message;
}

export async function api<T = unknown>(path: string, method = 'POST', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorBody>;
  if (!res.ok) {
    if (data.error) throw new ApiError(data.error, data.code, data.params);
    throw new ApiError(`Request failed (${res.status})`, 'err.requestFailed', { status: res.status });
  }
  return data;
}

// POST with an empty JSON body still needs the JSON content type (CSRF defense on the server).
export function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, 'POST', body);
}

function isLogMessage(m: AdminSocketMessage): m is AdminLogMessage {
  return (m as Partial<AdminLogMessage>).type === 'log';
}

function isChatMessage(m: AdminSocketMessage): m is AdminChatMessage {
  return (m as Partial<AdminChatMessage>).type === 'chat';
}

function isDesktopMessage(m: AdminSocketMessage): m is AdminDesktopMessage {
  return (m as Partial<AdminDesktopMessage>).type === 'desktop';
}

/**
 * Subscribe to state pushes, activity-log messages and (desktop app only) desktop state; falls
 * back to polling the state if the socket drops (the log backlog and the desktop state are sent
 * again on reconnect).
 */
export function subscribe(
  onState: (s: AdminState) => void,
  onDown: (down: boolean) => void,
  onLog: (m: AdminLogMessage) => void = () => {},
  onDesktop: (m: AdminDesktopMessage) => void = () => {},
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let poll: number | undefined;
  const connect = (): void => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      onDown(false);
      if (poll) clearInterval(poll);
      poll = undefined;
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as AdminSocketMessage;
      if (isLogMessage(msg)) onLog(msg);
      else if (isDesktopMessage(msg)) onDesktop(msg);
      // Chat items go to the chat store (the chat card); never mistake them for a state snapshot.
      else if (isChatMessage(msg)) chatStore.apply(msg);
      else onState(msg);
    };
    ws.onclose = () => {
      if (stopped) return;
      onDown(true);
      if (!poll) {
        poll = window.setInterval(() => {
          api<AdminState>('/api/state', 'GET').then(onState, () => onDown(true));
        }, 2000);
      }
      setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
    if (poll) clearInterval(poll);
  };
}

// ---- chat: panel ----
// The chat card's calls (apps/server/src/admin/chat-routes.ts). Mutes and colours are not
// pushed on /ws, so the calls that change them refresh the per-session state afterwards.

export const chatApi = {
  /** Settings, the ring, sessions (mutes, colours) and counters; also refreshes the store. */
  async load(): Promise<AdminChatState> {
    const s = await api<AdminChatState>('/api/chat', 'GET');
    chatStore.applyState(s);
    return s;
  },
  /** Sessions (mutes and colours) and counters, keeping the feed as the socket built it. */
  async refreshSessions(): Promise<AdminChatState> {
    const s = await api<AdminChatState>('/api/chat', 'GET');
    chatStore.setSessions(s.sessions, s.counters);
    return s;
  },
  saveSettings(settings: ChatSettings): Promise<{ settings: ChatSettings; effective: ChatPublicSettings }> {
    return api('/api/chat/settings', 'PUT', settings);
  },
  send(text: string): Promise<{ ok: true; s: number }> {
    return post('/api/chat/send', { text });
  },
  remove(seqs: number[]): Promise<unknown> {
    return post('/api/chat/delete', { seqs });
  },
  clear(): Promise<unknown> {
    return post('/api/chat/clear');
  },
  async mute(sessionId: string, minutes: number | null): Promise<void> {
    await post('/api/chat/mute', { sessionId, minutes });
    await chatApi.refreshSessions();
  },
  async unmute(sessionId: string): Promise<void> {
    await post('/api/chat/unmute', { sessionId });
    await chatApi.refreshSessions();
  },
  async color(sessionId: string, color: string | null, lock: boolean): Promise<void> {
    await api('/api/chat/color', 'PUT', { sessionId, color, lock });
    await chatApi.refreshSessions();
  },
  protect(mode: ChatProtect): Promise<{ ok: true; protect: ChatProtect }> {
    return post('/api/chat/protect', { mode });
  },
};
// ---- end ----
