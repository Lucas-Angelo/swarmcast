import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { ensurePrivateDir } from './paths.js';

export type { Logger };

const REDACT = [
  'streamKey',
  'secret',
  'liveLink',
  'privateKey',
  'manifestPrivateKeyPem',
  'token',
  '*.streamKey',
  '*.secret',
  '*.liveLink',
  '*.token',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

/** Remove secrets that can appear inside URLs or free text. */
export function scrub(text: string): string {
  return text
    .replace(/\/join\/[A-Za-z0-9_-]+/g, '/join/[redacted]')
    .replace(/\/auth\/[A-Za-z0-9_-]+/g, '/auth/[redacted]')
    .replace(/sc_[A-Za-z0-9]{16,}/g, 'sc_[redacted]');
}

export function createLogger(opts: {
  logsDir?: string;
  level?: string;
  stdout?: boolean;
  /** Extra in-memory destination for warnings and errors (the admin activity log). */
  sink?: { write(line: string): void };
}): Logger {
  const level = (opts.level ?? process.env.SWARMCAST_LOG_LEVEL ?? 'info') as pino.Level;
  const streams: pino.StreamEntry[] = [];
  if (opts.logsDir) {
    ensurePrivateDir(opts.logsDir);
    const file = path.join(opts.logsDir, 'swarmcast.log');
    rotate(file);
    streams.push({ level, stream: pino.destination({ dest: file, sync: true, mkdir: true }) });
  }
  if (opts.stdout !== false) streams.push({ level, stream: safeStdout() });
  if (opts.sink) streams.push({ level: 'warn', stream: opts.sink });
  return pino(
    {
      level,
      redact: { paths: REDACT, censor: '[redacted]' },
      base: undefined,
      formatters: { level: (label) => ({ level: label }) },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as Parameters<typeof method>;
          method.apply(this, scrubbed);
        },
      },
    },
    pino.multistream(streams),
  );
}

/** Keep the log file small: rotate at 5 MB, keep one previous file. */
function rotate(file: string): void {
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no file yet */
  }
}

/**
 * stdout that stops writing once its reader is gone (EPIPE when the terminal or parent
 * process disappears) instead of throwing on every log line.
 */
function safeStdout(): { write(chunk: string): boolean } {
  let dead = false;
  process.stdout.on('error', () => {
    dead = true;
  });
  return {
    write(chunk: string): boolean {
      if (dead) return true;
      try {
        return process.stdout.write(chunk);
      } catch {
        dead = true;
        return true;
      }
    },
  };
}
