import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSmallFile } from '../../src/core/small-file.js';
import { tempDir } from './helpers.js';

// readSmallFile reads a small regular file whole, or gives null: missing, a folder, a FIFO (at
// once, without waiting for a writer: POSIX only, Windows has no mkfifo), or bigger than the limit.
// The size is checked on the opened file and the read stops after limit + 1 bytes, so a file that
// grows (or is swapped) between the check and the read is never returned whole. That race cannot
// be timed from a test: the size the check sees is stubbed instead.

afterEach(() => {
  vi.restoreAllMocks();
});

/** A file holding `content`, in a temp folder of this test. */
function fileWith(content: string): string {
  const f = path.join(tempDir('sc-small-file-'), 'a.json');
  fs.writeFileSync(f, content);
  return f;
}

/** 8 two-byte characters: 16 bytes. */
const SIXTEEN_BYTES = 'é'.repeat(8);

describe('readSmallFile', () => {
  it('reads a file up to the limit, byte for byte', () => {
    // Arrange
    const f = fileWith(SIXTEEN_BYTES);
    // Act
    const text = readSmallFile(f, 16);
    // Assert
    expect(text).toBe(SIXTEEN_BYTES);
  });

  it('gives null for a file one byte over the limit', () => {
    // Arrange
    const f = fileWith(SIXTEEN_BYTES);
    // Act
    const text = readSmallFile(f, 15);
    // Assert
    expect(text).toBeNull();
  });

  it('reads an empty file as an empty string', () => {
    // Arrange
    const f = fileWith('');
    // Act
    const text = readSmallFile(f, 16);
    // Assert
    expect(text).toBe('');
  });

  it.each([
    ['a missing path', (d: string) => path.join(d, 'missing')],
    ['a folder', (d: string) => d],
  ])('gives null for %s', (_what, at) => {
    // Arrange
    const target = at(tempDir('sc-small-file-'));
    // Act
    const text = readSmallFile(target, 100);
    // Assert
    expect(text).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('gives null for a FIFO at once instead of waiting for a writer', () => {
    // Arrange
    const f = path.join(tempDir('sc-small-file-'), 'fifo');
    execFileSync('mkfifo', [f]);
    // Act
    const text = readSmallFile(f, 100);
    // Assert
    expect(text).toBeNull();
  });

  it('never returns more than the limit when the file grows after the size check', () => {
    // Arrange
    const f = fileWith('x'.repeat(1000));
    const realFstat = fs.fstatSync.bind(fs);
    const check = vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => Object.assign(realFstat(fd), { size: 10 })) as typeof fs.fstatSync);
    // Act
    const text = readSmallFile(f, 64);
    // Assert
    expect(check).toHaveBeenCalled();
    expect(text).toBeNull();
  });
});
