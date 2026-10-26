import { EventEmitter } from 'node:events';
import type { ActivityEntry, ActivityKind, ActivityLevel } from '@swarmcast/shared';
import { translate, type MessageKey, type MessageParams } from '@swarmcast/shared/i18n';
import { scrub } from './logger.js';

export const ACTIVITY_MAX = 500;

export const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Full IPv6 (4+ groups, so clock times like 12:30:45 are left alone) and "::" compressed forms.
export const IPV6_FULL = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi;
export const IPV6_SHORT = /(?:\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b)?/gi;

/** Remove link secrets, tokens, stream keys (see scrub) and IP addresses (except loopback). */
export function scrubActivity(text: string): string {
  return scrub(text)
    .replace(IPV4, (ip) => (ip.startsWith('127.') || ip === '0.0.0.0' ? ip : '[ip]'))
    .replace(IPV6_FULL, '[ip]')
    .replace(IPV6_SHORT, (ip) => (ip === '::' || ip === '::1' ? ip : '[ip]'));
}

/** Fields of log records worth showing in the panel (never nicknames' IPs, never secrets). */
const DETAIL_FIELDS = ['err', 'reason', 'child', 'step', 'attempt', 'delay'] as const;

export interface ActivityInput {
  level?: ActivityLevel;
  kind?: ActivityKind;
  code?: MessageKey;
  params?: MessageParams;
  /** English text; derived from `code` when omitted. */
  text?: string;
}

/**
 * In-memory ring buffer of what happened (actions, viewers, warnings, errors) for the admin
 * panel's activity console. Never written to disk; every entry is scrubbed.
 */
export class ActivityLog extends EventEmitter<{ entry: [entry: ActivityEntry]; clear: [] }> {
  private entries: ActivityEntry[] = [];
  private seq = 0;

  constructor(
    readonly max = ACTIVITY_MAX,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  add(input: ActivityInput): ActivityEntry {
    const params = input.params ? scrubParams(input.params) : undefined;
    const text = input.text ?? (input.code ? translate('en', input.code, input.params) : '');
    const entry: ActivityEntry = {
      id: ++this.seq,
      at: this.now(),
      level: input.level ?? 'info',
      kind: input.kind ?? 'system',
      ...(input.code ? { code: input.code } : {}),
      ...(params ? { params } : {}),
      text: scrubActivity(text).slice(0, 1000),
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.emit('entry', entry);
    return entry;
  }

  action(code: MessageKey, params?: MessageParams, level: ActivityLevel = 'info'): ActivityEntry {
    return this.add({ kind: 'action', code, params, level });
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.emit('clear');
  }

  /**
   * A pino destination: turns warn/error log records into entries. Records logged with
   * `{ panel: true }` are skipped (they were already added with a translatable code).
   */
  logStream(): { write(line: string): void } {
    return {
      write: (line: string) => {
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (rec.panel === true) return;
        // Level is a label with our logger's formatter, a number with pino's default.
        const lv = rec.level;
        const level: ActivityLevel =
          lv === 'error' || lv === 'fatal' || (typeof lv === 'number' && lv >= 50) ? 'error' : lv === 'warn' || (typeof lv === 'number' && lv >= 40) ? 'warn' : 'info';
        this.add({ level, kind: 'system', text: describeRecord(rec) });
      },
    };
  }
}

function scrubParams(params: MessageParams): MessageParams {
  const out: MessageParams = {};
  for (const [k, v] of Object.entries(params)) out[k] = typeof v === 'string' ? scrubActivity(v) : v;
  return out;
}

function describeRecord(rec: Record<string, unknown>): string {
  const msg = typeof rec.msg === 'string' ? rec.msg : '';
  if (typeof rec.mediamtx === 'string') return `MediaMTX: ${rec.mediamtx}`;
  if (typeof rec.cloudflared === 'string') return `cloudflared: ${rec.cloudflared}`;
  const details = DETAIL_FIELDS.filter((f) => typeof rec[f] === 'string' || typeof rec[f] === 'number').map((f) => `${f}=${String(rec[f])}`);
  return details.length ? `${msg} (${details.join(', ')})` : msg;
}
