import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOVE_RETRIES, removeDir } from '../../src/core/fs-cleanup.js';
import { Transcoder } from '../../src/quality/transcoder.js';
import { silentLog } from './helpers.js';

// B5: deleting the ladder folder right after ffmpeg stops can fail with EPERM/EBUSY on Windows
// (Defender or the indexer still holds a segment). The delete is retried, and a folder that stays
// locked is logged and left: it never fails "Stop everything".

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
  // a virus scanner does) and lets go 600 ms later. A plain rmSync fails; removeDir waits it out.
  it.runIf(process.platform === 'win32')('waits out a file locked by another process (Windows)', async () => {
    const dir = tree();
    const file = path.join(dir, 'a', 'b', 'seg.m4s');
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep -Milliseconds 600; $f.Close()`],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    const exited = new Promise<void>((r) => ps.once('exit', () => r()));
    await new Promise<void>((resolve) => readline.createInterface({ input: ps.stdout! }).on('line', (l) => l.trim() === 'locked' && resolve()));
    let code: string | undefined;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(['EPERM', 'EBUSY']).toContain(code);
    expect(await removeDir(dir, silentLog, 'test')).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    await exited;
  }, 20_000);
});

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
