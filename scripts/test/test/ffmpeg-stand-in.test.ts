// The local stand-in for the publisher of the app's ffmpeg build (scripts/test/lib/ffmpeg-stand-in.mjs),
// which the Windows quality suite serves the pinned archive from, with the app's real installer
// (apps/server/src/quality/ffmpeg.ts) downloading through it: the bytes and their size, the
// SHA-256 check that still refuses a wrong file, and a stand-in that stalls after the headers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, onTestFinished } from 'vitest';
import { installFfmpeg, type FfmpegPin, type InstallProgress } from '../../../apps/server/src/quality/ffmpeg.js';
import { cachedArchive } from '../../build/fetch-binaries.mjs';
import { pinnedFfmpegArchive, startFfmpegStandIn } from '../lib/ffmpeg-stand-in.mjs';

const log = pino({ level: 'silent' });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ffmpeg-stand-in-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A download cache holding `bytes` as the archive of a pin made for them. */
function cacheWith(bytes: Buffer): { cache: string; pin: FfmpegPin } {
  const cache = tempDir();
  const pin: FfmpegPin = { url: 'https://example.invalid/ffmpeg.zip', asset: 'ffmpeg.zip', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), binary: 'ffmpeg', license: 'test' };
  fs.writeFileSync(cachedArchive(cache, pin), bytes);
  return { cache, pin };
}

async function standIn(file: string, o?: { stallAfterHeaders?: boolean }) {
  const s = await startFfmpegStandIn(file, o);
  onTestFinished(() => s.close());
  return s;
}

describe('ffmpeg stand-in', () => {
  it('serves the cached archive, byte for byte, with its size, on 127.0.0.1 only', async () => {
    // Arrange
    const bytes = crypto.randomBytes(300_000);
    const { cache, pin } = cacheWith(bytes);
    const s = await standIn(pinnedFfmpegArchive(pin, { SC_DOWNLOAD_CACHE: cache }));
    // Act
    const res = await fetch(s.url);
    const body = Buffer.from(await res.arrayBuffer());
    const other = await fetch(new URL('/other.zip', s.url));
    // Assert
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(body.equals(bytes)).toBe(true);
    expect(other.status).toBe(404);
    expect(s.requests()).toBe(1);
  });

  it('refuses a cached file that does not match the pin or is missing, and says how to get the right one', () => {
    // Arrange
    const { cache, pin } = cacheWith(Buffer.from('the pinned build'));
    fs.writeFileSync(cachedArchive(cache, pin), 'another file');
    // Act
    const wrong = () => pinnedFfmpegArchive(pin, { SC_DOWNLOAD_CACHE: cache });
    const missing = () => pinnedFfmpegArchive({ ...pin, sha256: 'f'.repeat(64) }, { SC_DOWNLOAD_CACHE: cache });
    const noCache = () => pinnedFfmpegArchive(pin, {});
    // Assert
    expect(wrong).toThrow(/does not match the pin/);
    expect(missing).toThrow(/is missing.*app-ffmpeg/);
    expect(noCache).toThrow(/SC_DOWNLOAD_CACHE is not set.*app-ffmpeg/);
  });

  it("the app's installer downloads through it and still checks the SHA-256: a file other than the pin fails", async () => {
    // Arrange
    const { cache, pin } = cacheWith(crypto.randomBytes(1000));
    const s = await standIn(pinnedFfmpegArchive(pin, { SC_DOWNLOAD_CACHE: cache }));
    const progress: InstallProgress[] = [];
    // Act
    const install = installFfmpeg(tempDir(), log, (p) => progress.push(p), { pin: { ...pin, sha256: '0'.repeat(64) }, env: s.appEnv });
    // Assert
    await expect(install).rejects.toThrow(/Checksum mismatch/);
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'verifying', receivedBytes: 1000 }));
    expect(s.requests()).toBe(1);
  });

  it("a stand-in that sends the headers and then nothing: the app's install fails with the stall message", async () => {
    // Arrange
    const { cache, pin } = cacheWith(crypto.randomBytes(1000));
    const s = await standIn(pinnedFfmpegArchive(pin, { SC_DOWNLOAD_CACHE: cache }), { stallAfterHeaders: true });
    const progress: InstallProgress[] = [];
    // Act
    const install = installFfmpeg(tempDir(), log, (p) => progress.push(p), { pin, env: s.appEnv, stallMs: 1000 });
    // Assert
    await expect(install).rejects.toMatchObject({ code: 'quality.install.stalled', params: { s: 1 } });
    expect(progress.at(-1)).toMatchObject({ phase: 'error', code: 'quality.install.stalled' });
    expect(s.requests()).toBe(1);
  });
});
