import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

/** One server log file is cut at this size (then `.1`, `.2`… for the same day). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Size-rotated parts kept per day (`.1` … `.5`); the oldest part is dropped beyond it. */
export const LOG_KEEP_PARTS = 5;
/** Default retention of log files and exports, in days (config `diagnostics.logRetentionDays`). */
export const LOG_RETENTION_DAYS = 14;
export const LOG_RETENTION_MIN_DAYS = 3;
export const LOG_RETENTION_MAX_DAYS = 90;
/** The logs folder (plus old exports) is kept under this size: oldest files go first. */
export const LOGS_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar day, `YYYY-MM-DD`. */
export function localDay(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Next local midnight after `t`. */
function nextMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** `swarmcast-2026-10-26.log` */
export function serverLogName(t: number, base = 'swarmcast'): string {
  return `${base}-${localDay(t)}.log`;
}

/**
 * The server log file: one file per local day (`swarmcast-YYYY-MM-DD.log`), cut at `maxBytes`
 * (the full file becomes `.1`, the previous `.1` becomes `.2`…, at most `keep` parts).
 *
 * A pino destination (sync SonicBoom) does the writing. Every log line is one synchronous
 * `write()`, and rotation happens inside `write()` before the line is written: rename the full
 * file, then `reopen()` the destination on the same path (sync mode opens the new file at once),
 * so no line is lost, split across files or interleaved. Renaming an open file works on Windows
 * too (libuv opens files with FILE_SHARE_DELETE).
 */
export class RotatingLogFile {
  private readonly dest: pino.DestinationStream & { reopen(file?: string): void; flushSync(): void; end(): void; once(event: 'close' | 'error', listener: () => void): void };
  /** Set by end(): the file is closed for good. */
  private ending: Promise<void> | null = null;
  private size = 0;
  private dayEndsAt = 0;
  private current: string;
  readonly maxBytes: number;
  readonly keep: number;
  private readonly base: string;
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    o: { base?: string; maxBytes?: number; keep?: number; now?: () => number } = {},
  ) {
    this.base = o.base ?? 'swarmcast';
    this.maxBytes = o.maxBytes ?? LOG_MAX_BYTES;
    this.keep = o.keep ?? LOG_KEEP_PARTS;
    this.now = o.now ?? Date.now;
    const t = this.now();
    this.current = path.join(dir, serverLogName(t, this.base));
    this.dayEndsAt = nextMidnight(t);
    this.size = sizeOf(this.current);
    this.dest = pino.destination({ dest: this.current, sync: true, mkdir: true }) as typeof this.dest;
  }

  /** Path of the file being written now. */
  get file(): string {
    return this.current;
  }

  write(chunk: string): boolean {
    // After end() (the app closed): a late line from background work is dropped, as writing
    // to the ended destination would throw.
    if (this.ending) return true;
    const t = this.now();
    if (t >= this.dayEndsAt) this.switchDay(t);
    const len = Buffer.byteLength(chunk);
    if (this.size > 0 && this.size + len > this.maxBytes) this.rotate();
    this.dest.write(chunk);
    this.size += len;
    return true;
  }

  flushSync(): void {
    if (this.ending) return;
    try {
      this.dest.flushSync();
    } catch {
      /* nothing buffered (sync mode) */
    }
  }

  /**
   * Close the file for good (lines written later are dropped). Resolves once the file is closed
   * (or could not be: nothing more to wait for), so its folder can be deleted right after, also
   * on Windows. Calling it again returns the same promise.
   */
  end(): Promise<void> {
    this.ending ??= new Promise<void>((resolve) => {
      this.dest.once('close', resolve);
      this.dest.once('error', resolve);
      this.dest.end();
    });
    return this.ending;
  }

  private switchDay(t: number): void {
    this.dayEndsAt = nextMidnight(t);
    const next = path.join(this.dir, serverLogName(t, this.base));
    if (next === this.current) return;
    this.current = next;
    this.size = sizeOf(next);
    this.reopen(next);
  }

  /** file → file.1 → file.2 … → file.<keep> (dropped), then a fresh file. */
  private rotate(): void {
    const numbered = (n: number): string => `${this.current}.${n}`;
    try {
      fs.rmSync(numbered(this.keep), { force: true });
      for (let n = this.keep - 1; n >= 1; n--) {
        if (fs.existsSync(numbered(n))) fs.renameSync(numbered(n), numbered(n + 1));
      }
      fs.renameSync(this.current, numbered(1));
    } catch {
      // Could not rename (e.g. a virus scanner holds the file): keep appending to it rather
      // than losing lines; the next write tries again once it is past the size again.
      this.size = 0;
      return;
    }
    this.size = 0;
    this.reopen(this.current);
  }

  private reopen(file: string): void {
    try {
      this.dest.reopen(file);
    } catch {
      /* the destination keeps its previous file descriptor */
    }
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Files the retention may delete: logs (`x.log`, `x.log.3`, `x-2026-10-26.log.1`) and log exports. */
export function isPrunable(name: string): boolean {
  return /\.log(\.\d+)?$/i.test(name) || /^SwarmCast-logs-.*\.zip$/i.test(name);
}

export interface PruneOptions {
  /** Folders to clean (not recursive): the logs folder and `<data>/exports`. */
  dirs: string[];
  /** Delete files last modified more than this many days ago. */
  maxAgeDays: number;
  /** Then delete the oldest files until the total is under this size. */
  maxTotalBytes?: number;
  now?: number;
  /** Files never deleted (the ones being written right now). */
  protect?: (file: string) => boolean;
}

/**
 * Log retention: delete log files (and old log exports) older than `maxAgeDays`, then the oldest
 * ones while the folders together are bigger than `maxTotalBytes`. Only file names that look
 * like logs or exports are touched. Returns the deleted paths.
 */
export function pruneLogs(o: PruneOptions): string[] {
  const now = o.now ?? Date.now();
  const cutoff = now - o.maxAgeDays * DAY_MS;
  const files: Array<{ file: string; mtime: number; size: number }> = [];
  for (const dir of o.dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isPrunable(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) files.push({ file, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
  const deleted: string[] = [];
  const remove = (file: string): boolean => {
    if (o.protect?.(file)) return false;
    try {
      fs.rmSync(file, { force: true });
      deleted.push(file);
      return true;
    } catch {
      return false;
    }
  };
  const kept = files.filter((f) => !(f.mtime < cutoff && remove(f.file)));
  if (o.maxTotalBytes !== undefined) {
    let total = kept.reduce((a, f) => a + f.size, 0);
    for (const f of kept.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= o.maxTotalBytes) break;
      if (remove(f.file)) total -= f.size;
    }
  }
  return deleted;
}

/** Clamp a retention value from config to the allowed range. */
export function retentionDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return LOG_RETENTION_DAYS;
  return Math.min(LOG_RETENTION_MAX_DAYS, Math.max(LOG_RETENTION_MIN_DAYS, Math.round(value)));
}
