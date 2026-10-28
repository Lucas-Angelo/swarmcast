import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { download } from '../fetch-binaries.mjs';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fetch-bins-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD = Buffer.from('the pinned archive');
const SHA = crypto.createHash('sha256').update(GOOD).digest('hex');
const noWait = { waitMs: () => 0 };

describe('download', () => {
  it('writes the bytes only when they match the pinned SHA-256', async () => {
    const dest = path.join(tmp(), 'a.zip');
    await download('https://example.test/a.zip', dest, SHA, { ...noWait, fetchImpl: async () => GOOD });
    expect(fs.readFileSync(dest)).toEqual(GOOD);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('fails at once on a mismatch and leaves nothing on disk', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'a.zip');
    const fetchImpl = vi.fn(async () => Buffer.from('something else'));
    await expect(download('https://example.test/a.zip', dest, SHA, { ...noWait, fetchImpl })).rejects.toThrow(/Checksum mismatch .*expected [0-9a-f]{64}, got [0-9a-f]{64}/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('retries a failed try, then verifies what arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dest = path.join(tmp(), 'a.zip');
    let n = 0;
    const fetchImpl = async (): Promise<Buffer> => {
      n += 1;
      if (n < 3) throw new Error('ECONNRESET');
      return GOOD;
    };
    await download('https://example.test/a.zip', dest, SHA, { ...noWait, fetchImpl });
    expect(n).toBe(3);
    expect(fs.readFileSync(dest)).toEqual(GOOD);
  });

  it('does not retry a missing file', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 404'), { final: true });
    });
    await expect(download('https://example.test/a.zip', path.join(tmp(), 'a.zip'), SHA, { ...noWait, fetchImpl })).rejects.toThrow(/HTTP 404 .*try 1 of 6/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to download without a pinned SHA-256', async () => {
    const fetchImpl = vi.fn(async () => GOOD);
    await expect(download('https://example.test/a.zip', path.join(tmp(), 'a.zip'), undefined as unknown as string, { fetchImpl })).rejects.toThrow(/no pinned SHA-256/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
