import type { AdminDesktopMessage, AdminLogMessage, AdminSocketMessage, AdminState, ApiErrorBody, MessageKey, MessageParams } from '@swarmcast/shared';
import { tc } from '@swarmcast/shared/i18n';

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
