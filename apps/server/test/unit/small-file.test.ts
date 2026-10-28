import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSmallFile } from '../../src/core/small-file.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-small-file-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('readSmallFile', () => {
  it('reads a file up to the limit, byte for byte', () => {
    const f = path.join(tmp(), 'a.json');
    fs.writeFileSync(f, 'é'.repeat(8)); // 16 bytes
    expect(readSmallFile(f, 16)).toBe('é'.repeat(8));
    expect(readSmallFile(f, 15)).toBeNull();
    fs.writeFileSync(f, '');
    expect(readSmallFile(f, 16)).toBe('');
  });

  it('gives null for a missing path or a folder', () => {
    const d = tmp();
    expect(readSmallFile(path.join(d, 'missing'), 100)).toBeNull();
    expect(readSmallFile(d, 100)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('gives null for a FIFO at once instead of waiting for a writer', () => {
    const f = path.join(tmp(), 'fifo');
    execFileSync('mkfifo', [f]);
    expect(readSmallFile(f, 100)).toBeNull();
  });

  it('never returns more than the limit when the file grows after the check', () => {
    const f = path.join(tmp(), 'grow');
    fs.writeFileSync(f, 'x'.repeat(10));
    const realFstat = fs.fstatSync;
    // The size seen by the check is 10; the content read is far larger (a file swapped in between).
    fs.writeFileSync(f, 'x'.repeat(1000));
    const fstat = (fd: number): fs.Stats => Object.assign(realFstat(fd), { size: 10 });
    (fs as { fstatSync: unknown }).fstatSync = fstat;
    try {
      expect(readSmallFile(f, 64)).toBeNull();
    } finally {
      (fs as { fstatSync: unknown }).fstatSync = realFstat;
    }
  });
});
