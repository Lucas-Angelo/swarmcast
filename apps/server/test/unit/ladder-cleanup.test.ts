import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { REMOVE_RETRIES, REMOVE_RETRY_BUDGET_MS, removeDir } from '../../src/core/fs-cleanup.js';
import { Transcoder } from '../../src/quality/transcoder.js';
import { captureLog, silentLog, tempDir } from './helpers.js';

// B5: deleting the ladder folder right after ffmpeg stops can fail with EPERM/EBUSY on Windows
// (Defender or the indexer still holds a segment). The delete is retried, and a folder that stays
// locked is logged and left: it never fails "Stop everything".

/**
 * The Windows scenario's lock: another process holds a segment this long after removeDir started,
 * then lets go, as a virus scanner would. A measured window, not a wait for something to happen:
 * the test checks that removeDir outlasted it (and stayed within its retry budget).
 */
const LOCK_HELD_MS = 300;
/** Windows PowerShell 5.1 starts in 2–4 s on a CI runner, much slower under load. */
const LOCKER_START_BUDGET_MS = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A ladder-like folder: a segment two levels down and a playlist. Deleted when the test finishes. */
function tree(): string {
  const dir = tempDir('sc-cleanup-');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'seg.m4s'), 'x');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), '#EXTM3U');
  return dir;
}

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });

describe('removeDir', () => {
  it('deletes the whole folder, with the retries for briefly locked files', async () => {
    // Arrange
    const rm = vi.spyOn(fs.promises, 'rm');
    const dir = tree();
    // Act
    const removed = await removeDir(dir, silentLog, 'test');
    // Assert
    expect(removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(rm).toHaveBeenCalledWith(dir, { recursive: true, force: true, ...REMOVE_RETRIES });
  });

  it('retries 10 times, 100 ms longer each time: 5.5 s in all', () => {
    // Assert
    expect(REMOVE_RETRIES).toEqual({ maxRetries: 10, retryDelay: 100 });
    expect(REMOVE_RETRY_BUDGET_MS).toBe(5500);
  });

  it('a folder that is already gone is fine too', async () => {
    // Arrange
    const dir = path.join(tempDir('sc-cleanup-'), 'gone');
    // Act
    const removed = await removeDir(dir, silentLog, 'test');
    // Assert
    expect(removed).toBe(true);
  });

  it('never throws: a folder that stays locked is logged and left', async () => {
    // Arrange
    const { log, lines } = captureLog('debug');
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(eperm());
    const dir = tree();
    // Act
    const removed = await removeDir(dir, log, 'quality ladder');
    // Assert
    expect(removed).toBe(false);
    const warn = lines().find((l) => l.level === 40);
    expect(warn).toMatchObject({ dir, code: 'EPERM' });
    expect(String(warn?.msg)).toContain('quality ladder');
  });

  // b cannot be removed from a read-only folder; root can, so the check needs a normal user.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a real permission error is reported, not thrown (POSIX)', async () => {
    // Arrange
    const dir = tree();
    fs.chmodSync(path.join(dir, 'a'), 0o500);
    onTestFinished(() => fs.chmodSync(path.join(dir, 'a'), 0o700));
    // Act
    const removed = await removeDir(path.join(dir, 'a'), silentLog, 'test');
    // Assert
    expect(removed).toBe(false);
    expect(fs.existsSync(path.join(dir, 'a', 'b'))).toBe(true);
  });

  // The Windows case itself: another process holds a segment open without FILE_SHARE_DELETE (as
  // a virus scanner does) and lets go while removeDir is retrying. The locker says "locked" once it
  // holds the file, and closes it only when the test writes "release". The bounds: the locker's
  // start (Windows PowerShell takes seconds on a busy runner; it is reported, and gets its own
  // budget) plus removeDir's documented retry budget.
  it.runIf(process.platform === 'win32')(
    'waits out a file locked by another process (Windows)',
    async () => {
      // Arrange
      const dir = tree();
      const locker = new FileLocker(path.join(dir, 'a', 'b', 'seg.m4s'));
      onTestFinished(() => locker.stop());
      const startMs = await locker.locked;
      // Act
      let code: string | undefined;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
      // Assert
      expect(['EPERM', 'EBUSY'], `plain rmSync while locked (locker started in ${startMs} ms)`).toContain(code);
      // Act
      const t0 = Date.now();
      const removing = removeDir(dir, silentLog, 'test');
      await new Promise((r) => setTimeout(r, LOCK_HELD_MS));
      await locker.release();
      const removed = await removing;
      const took = Date.now() - t0;
      // Assert
      expect(removed).toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
      expect(took).toBeGreaterThanOrEqual(LOCK_HELD_MS);
      expect(took, 'removeDir finished within its retry budget').toBeLessThan(REMOVE_RETRY_BUDGET_MS + 2000);
    },
    LOCKER_START_BUDGET_MS + LOCK_HELD_MS + REMOVE_RETRY_BUDGET_MS + 5000,
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
  private readonly exited: Promise<unknown>;
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
    this.exited = once(this.ps, 'exit');
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

  /** Ends the locker and waits for its exit: the file is closed before the folder is deleted. */
  async stop(): Promise<void> {
    if (this.ps.exitCode === null && this.ps.signalCode === null) this.ps.kill();
    await this.exited;
  }
}

describe('Transcoder.stop', () => {
  // `node` stands in for ffmpeg: it refuses ffmpeg's arguments and exits at once.
  it('stops cleanly and lets the next start use a fresh folder even when the old one cannot be deleted', async () => {
    // Arrange
    const t = new Transcoder({ ffmpeg: process.execPath, inputUrl: 'rtmp://127.0.0.1:9/live/x', workDir: tempDir('sc-ladder-'), reaper: null, log: silentLog, maxRestarts: 0 });
    const rungs = [
      { name: 'v1080', height: 1080, width: 1920, fps: 30, kbps: 6000, source: true },
      { name: 'v480', height: 480, width: 854, fps: 30, kbps: 1500, source: false },
    ];
    t.start(rungs, 'libx264', false);
    const first = t.outDir!;
    const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(eperm());
    // Act
    const stopped = t.stop();
    // Assert
    await expect(stopped).resolves.toBeUndefined();
    expect(fs.existsSync(first)).toBe(true);
    expect(t.status).toBe('off');
    expect(t.outDir).toBeNull();
    // Act
    rm.mockRestore();
    t.start(rungs, 'libx264', false);
    const second = t.outDir!;
    await t.stop();
    // Assert
    expect(second).not.toBe(first);
    expect(fs.existsSync(second)).toBe(false);
  });
});
