import { desktopUpdateSchema, type DesktopUpdate, type LivePhase } from '@swarmcast/shared';
import { trayStateFor, type TrayStateMessage } from '../tray/tray.js';

/**
 * Protocol between the desktop shell (apps/desktop, Tauri) and the server started with
 * `--desktop` (docs/DESKTOP.md). Pure functions only, unit-tested.
 *
 * Server → shell: stdout lines `@@swarmcast <JSON>`; every other stdout line is a log line.
 * Shell → server: one JSON object per stdin line. Stdin EOF means quit.
 */

export const PROTOCOL_PREFIX = '@@swarmcast ';

/**
 * Stable codes of `fatal` messages (the shell translates the known ones):
 * - already-running: another SwarmCast answers on the panel port (e.g. started from a terminal).
 * - ports-busy: a port SwarmCast needs is used by another program.
 * - startup-failed: anything else (broken config file, unreadable data folder…).
 */
export const FATAL_CODES = ['already-running', 'ports-busy', 'startup-failed'] as const;
export type FatalCode = (typeof FATAL_CODES)[number];

/** A startup failure with its fatal code (the message stays the English text shown in a terminal). */
export class StartupError extends Error {
  constructor(
    readonly fatalCode: FatalCode,
    message: string,
  ) {
    super(message);
  }
}

export function fatalCodeOf(err: unknown): FatalCode {
  return err instanceof StartupError ? err.fatalCode : 'startup-failed';
}

export interface DesktopReadyMessage {
  type: 'ready';
  /** Opens the panel and logs the webview in (per-run token). */
  adminUrl: string;
  version: string;
}

/** Same fields as the Go tray helper's state, plus the exact phase and the viewer count. */
export interface DesktopStateMessage extends TrayStateMessage {
  phase: LivePhase;
  viewers: number;
}

export interface DesktopFatalMessage {
  type: 'fatal';
  code: FatalCode;
  message: string;
}

/** Messages the server writes to stdout for the shell. */
export type DesktopOutMessage = DesktopReadyMessage | DesktopStateMessage | DesktopFatalMessage | { type: 'update-check' } | { type: 'update-install' };

export const DESKTOP_CLICK_IDS = ['start', 'stop', 'quit'] as const;
export type DesktopClickId = (typeof DESKTOP_CLICK_IDS)[number];

/** Messages the shell writes to the server's stdin. */
export type ShellMessage = { type: 'click'; id: DesktopClickId } | { type: 'quit' } | { type: 'update'; update: DesktopUpdate };

/** Longest stdin line accepted (release notes included); longer lines are ignored. */
export const MAX_SHELL_LINE = 256 * 1024;

export function desktopStateFor(phase: LivePhase, viewersConnected: number): DesktopStateMessage {
  const viewers = phase === 'live' ? Math.max(0, Math.floor(viewersConnected)) : 0;
  return { ...trayStateFor(phase, viewers), phase, viewers };
}

export function sameDesktopState(a: DesktopStateMessage | null, b: DesktopStateMessage): boolean {
  return !!a && a.state === b.state && a.tooltip === b.tooltip && a.canStart === b.canStart && a.canStop === b.canStop && a.phase === b.phase && a.viewers === b.viewers;
}

/** One whole protocol line for stdout (JSON.stringify never emits a raw newline). */
export function encodeDesktopMessage(msg: DesktopOutMessage): string {
  return `${PROTOCOL_PREFIX}${JSON.stringify(msg)}\n`;
}

/** Parse a stdout line written by the server (used by tests and tools); null for log lines. */
export function decodeDesktopMessage(line: string): DesktopOutMessage | null {
  if (!line.startsWith(PROTOCOL_PREFIX)) return null;
  try {
    const msg = JSON.parse(line.slice(PROTOCOL_PREFIX.length)) as unknown;
    return msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'string' ? (msg as DesktopOutMessage) : null;
  } catch {
    return null;
  }
}

/** One JSON line for the server's stdin (what the shell sends). */
export function encodeShellMessage(msg: ShellMessage): string {
  if (msg.type === 'update') return `${JSON.stringify({ type: 'update', ...msg.update })}\n`;
  return `${JSON.stringify(msg)}\n`;
}

/** Parse one stdin line from the shell; anything unexpected or invalid yields null. */
export function decodeShellMessage(line: string): ShellMessage | null {
  if (line.length > MAX_SHELL_LINE) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const { type, id, ...rest } = msg as { type?: unknown; id?: unknown };
  if (type === 'quit') return { type: 'quit' };
  if (type === 'click' && typeof id === 'string' && (DESKTOP_CLICK_IDS as readonly string[]).includes(id)) {
    return { type: 'click', id: id as DesktopClickId };
  }
  if (type === 'update') {
    const r = desktopUpdateSchema.safeParse(rest);
    return r.success ? { type: 'update', update: r.data } : null;
  }
  return null;
}
