import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOVE_RETRIES, REMOVE_RETRY_BUDGET_MS, removeDir } from '../../src/core/fs-cleanup.js';
import { Transcoder } from '../../src/quality/transcoder.js';
import { silentLog } from './helpers.js';

// B5: deleting the ladder folder right after ffmpeg stops can fail with EPERM/EBUSY on Windows
// (Defender or the indexer still holds a segment). The delete is retried, and a folder that stays
// locked is logged and left: it never fails "Stop everything".

/** removeDir's first tries fail while the file is held; the release comes this long after. */
const RELEASE_AFTER_MS = 300;
/** Windows PowerShell 5.1 starts in 2–4 s on a CI runner, much slower under load. */
const LOCKER_START_BUDGET_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-cleanup-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'seg.m4s'), 'x');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), '#EXTM3U');
  return dir;
}

function capture(): { log: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const out: string[] = [];
  const log = pino({ level: 'debug' }, { write: (l: string) => void out.push(l) });
  return { log, lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });

describe('removeDir', () => {
  it('deletes the whole folder with retries for briefly locked files', async () => {
    const rm = vi.spyOn(fs.promises, 'rm');
    const dir = tree();
    expect(await removeDir(dir, silentLog, 'test')).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(rm).toHaveBeenCalledWith(dir, { recursive: true, force: true, ...REMOVE_RETRIES });
    expect(REMOVE_RETRIES).toEqual({ maxRetries: 10, retryDelay: 100 });
    expect(REMOVE_RETRY_BUDGET_MS).toBe(5500);
    // A folder that is already gone is fine too.
    expect(await removeDir(dir, silentLog, 'test')).toBe(true);
  });

  it('never throws: a folder that stays locked is logged and left', async () => {
    const { log, lines } = capture();
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(eperm());
    const dir = tree();
    expect(await removeDir(dir, log, 'quality ladder')).toBe(false);
    const warn = lines().find((l) => l.level === 40);
    expect(warn).toMatchObject({ dir, code: 'EPERM' });
    expect(String(warn?.msg)).toContain('quality ladder');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a real permission error is reported, not thrown (POSIX)', async () => {
    const dir = tree();
    fs.chmodSync(path.join(dir, 'a'), 0o500); // b cannot be removed from a read-only folder
    try {
      expect(await removeDir(path.join(dir, 'a'), silentLog, 'test')).toBe(false);
      expect(fs.existsSync(path.join(dir, 'a', 'b'))).toBe(true);
    } finally {
      fs.chmodSync(path.join(dir, 'a'), 0o700);
    }
  });

  // The Windows case itself: another process holds a segment open without FILE_SHARE_DELETE (as
  // a virus scanner does) and lets go while removeDir is retrying. Every step is an explicit
  // signal, never a timer racing the test: the locker says "locked" once it holds the file, and
  // closes it only when the test writes "release". The bounds: the locker's start (Windows
  // PowerShell takes seconds on a busy runner; it is reported, and gets its own budget) plus
  // removeDir's documented retry budget.
  it.runIf(process.platform === 'win32')(
    'waits out a file locked by another process (Windows)',
    async () => {
      const dir = tree();
      const file = path.join(dir, 'a', 'b', 'seg.m4s');
      const locker = new FileLocker(file);
      try {
        const startMs = await locker.locked;
        let code: string | undefined;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          code = (err as NodeJS.ErrnoException).code;
        }
        // Locked for real until the test says otherwise.
        expect(['EPERM', 'EBUSY'], `plain rmSync while locked (locker started in ${startMs} ms)`).toContain(code);
        const t0 = Date.now();
        const removing = removeDir(dir, silentLog, 'test');
        // Let removeDir fail and retry at least once, then let go of the file.
        await new Promise((r) => setTimeout(r, RELEASE_AFTER_MS));
        await locker.release();
        expect(await removing).toBe(true);
        const took = Date.now() - t0;
        expect(fs.existsSync(dir)).toBe(false);
        expect(took).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
        expect(took, 'removeDir finished within its retry budget').toBeLessThan(REMOVE_RETRY_BUDGET_MS + 2000);
      } finally {
        locker.kill();
      }
    },
    LOCKER_START_BUDGET_MS + RELEASE_AFTER_MS + REMOVE_RETRY_BUDGET_MS + 5000,
  );
});

/**
 * Holds `file` open with FileShare None (no delete, no read by others) in a PowerShell process.
 * The path reaches it as data ($env:SC_LOCK_FILE), never as code.
 */
class FileLocker {
  private readonly ps: ChildProcess;
  private readonly lines: string[] = [];
  private readonly waiters: Array<() => void> = [];
  /** Resolves with the locker's start time (ms) once it holds the file. */
  readonly locked: Promise<number>;

  constructor(file: string) {
    const script = [
      "$f = [System.IO.File]::Open($env:SC_LOCK_FILE, 'Open', 'Read', 'None')",
      "[Console]::Out.WriteLine('locked'); [Console]::Out.Flush()",
      '[void][Console]::In.ReadLine()',
      '$f.Close()',
      "[Console]::Out.WriteLine('released'); [Console]::Out.Flush()",
    ].join('; ');
    const started = Date.now();
    this.ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, SC_LOCK_FILE: file },
    });
    const errors: string[] = [];
    this.ps.stderr!.on('data', (d: Buffer) => errors.push(d.toString()));
    readline.createInterface({ input: this.ps.stdout! }).on('line', (l) => {
      this.lines.push(l.trim());
      for (const w of this.waiters.splice(0)) w();
    });
    this.locked = this.waitFor('locked', LOCKER_START_BUDGET_MS, () => errors.join('')).then(() => Date.now() - started);
  }

  private waitFor(line: string, timeoutMs: number, detail: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`locker: no "${line}" within ${timeoutMs} ms; output ${JSON.stringify(this.lines)}; stderr ${detail()}`)), timeoutMs);
      const check = (): void => {
        if (this.lines.includes(line)) {
          clearTimeout(timer);
          resolve();
        } else if (this.ps.exitCode !== null) {
          clearTimeout(timer);
          reject(new Error(`locker exited with ${this.ps.exitCode} before "${line}": ${detail()}`));
        } else this.waiters.push(check);
      };
      this.ps.once('exit', () => check());
      check();
    });
  }

  /** Close the file and wait until the locker confirms it. */
  async release(): Promise<void> {
    this.ps.stdin!.end('release\n');
    await this.waitFor('released', 10_000, () => '');
  }

  kill(): void {
    if (this.ps.exitCode === null) this.ps.kill();
  }
}

describe('Transcoder.stop', () => {
  it('stops cleanly and lets the next start use a fresh folder even when the old one cannot be deleted', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ladder-'));
    dirs.push(workDir);
    const t = new Transcoder({ ffmpeg: process.execPath, inputUrl: 'rtmp://127.0.0.1:9/live/x', workDir, reaper: null, log: silentLog, maxRestarts: 0 });
    const rungs = [
      { name: 'v1080', height: 1080, width: 1920, fps: 30, kbps: 6000, source: true },
      { name: 'v480', height: 480, width: 854, fps: 30, kbps: 1500, source: false },
    ];
    t.start(rungs, 'libx264', false);
    const first = t.outDir!;
    expect(fs.existsSync(first)).toBe(true);
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(eperm());
    await expect(t.stop()).resolves.toBeUndefined();
    expect(t.status).toBe('off');
    expect(t.outDir).toBeNull();
    vi.restoreAllMocks();
    t.start(rungs, 'libx264', false);
    expect(t.outDir).not.toBe(first);
    const second = t.outDir!;
    await t.stop();
    expect(fs.existsSync(second)).toBe(false);
  });
});
