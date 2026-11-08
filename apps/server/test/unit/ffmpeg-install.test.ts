import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CodedError } from '../../src/core/messages.js';
import { FFMPEG_STALL_MS, ffmpegDownloadUrl, installFfmpeg, type FfmpegPin, type InstallProgress } from '../../src/quality/ffmpeg.js';
import { silentLog, tempDir } from './helpers.js';

// The panel's "Install the video converter" and the desktop app's first start download the pinned
// ffmpeg archive (quality/ffmpeg.ts). A link that goes silent must fail the try within
// FFMPEG_STALL_MS with a message the panel translates, instead of "Downloading… 0 MB" for the
// whole 30-minute limit; a slow link that keeps sending must never be cut off. The system tests
// serve the archive from a local stand-in (SWARMCAST_TEST_FFMPEG_URL), never anything but 127.0.0.1.

const PIN: FfmpegPin = { url: 'https://example.invalid/ffmpeg.zip', asset: 'ffmpeg.zip', sha256: '0'.repeat(64), binary: 'ffmpeg', license: 'test' };
const STALLED = { code: 'quality.install.stalled', params: { s: FFMPEG_STALL_MS / 1000 } };

function pinFor(bytes: Uint8Array): FfmpegPin {
  return { ...PIN, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * A fetch that answers at once announcing `total` bytes and sends a chunk only when the test calls
 * `send`. Aborting its signal errors the body with the reason, as fetch does.
 */
function scriptedFetch(total: number) {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (body = c) });
    init?.signal?.addEventListener('abort', () => body.error(init.signal!.reason), { once: true });
    return new Response(stream, { headers: { 'content-length': String(total) } });
  }) as typeof fetch;
  return { fetchImpl, send: (b: Uint8Array) => body.enqueue(b), end: () => body.close() };
}

/** A fetch that never answers; aborting its signal rejects it with the reason, as fetch does. */
const silentFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))) as typeof fetch;

/** A local stand-in that sends the headers of a `total`-byte file and then nothing. */
async function headersThenNothing(total: number): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(total) });
    res.flushHeaders();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  onTestFinished(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/ffmpeg.zip`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('installFfmpeg: a download that stalls', () => {
  it('no new bytes for FFMPEG_STALL_MS: the try fails with "the download stopped", not before', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const net = scriptedFetch(1000);
    const progress: InstallProgress[] = [];
    const install = installFfmpeg(tempDir(), silentLog, (p) => progress.push(p), { pin: PIN, fetchImpl: net.fetchImpl });
    install.catch(() => {});
    // Act
    await vi.advanceTimersByTimeAsync(1000);
    net.send(new Uint8Array(100));
    await vi.advanceTimersByTimeAsync(FFMPEG_STALL_MS - 1);
    // Assert
    expect(progress.filter((p) => p.phase === 'error')).toEqual([]);
    // Act
    await vi.advanceTimersByTimeAsync(1);
    // Assert
    await expect(install).rejects.toBeInstanceOf(CodedError);
    await expect(install).rejects.toMatchObject(STALLED);
    expect(progress.at(-1)).toMatchObject({ phase: 'error', ...STALLED });
  });

  it('no answer at all for FFMPEG_STALL_MS: the same message', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const progress: InstallProgress[] = [];
    const install = installFfmpeg(tempDir(), silentLog, (p) => progress.push(p), { pin: PIN, fetchImpl: silentFetch });
    install.catch(() => {});
    // Act
    await vi.advanceTimersByTimeAsync(FFMPEG_STALL_MS);
    // Assert
    await expect(install).rejects.toMatchObject(STALLED);
    expect(progress.at(-1)).toMatchObject({ phase: 'error', ...STALLED });
  });

  it('a slow link that keeps sending is never cut off: every byte arrives and passes the checksum (then extraction fails: five random bytes are no archive)', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bytes = crypto.randomBytes(5);
    const net = scriptedFetch(bytes.length);
    const progress: InstallProgress[] = [];
    const install = installFfmpeg(tempDir(), silentLog, (p) => progress.push(p), { pin: pinFor(bytes), fetchImpl: net.fetchImpl });
    install.catch(() => {});
    // Act
    for (const b of bytes) {
      await vi.advanceTimersByTimeAsync(FFMPEG_STALL_MS - 1);
      net.send(Uint8Array.of(b));
    }
    net.end();
    // Assert
    await expect(install).rejects.not.toBeInstanceOf(CodedError);
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'verifying', receivedBytes: bytes.length }));
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'extracting' }));
  });

  it('a real connection that sends the headers and then nothing fails within the stall limit', async () => {
    // Arrange
    const url = await headersThenNothing(80_000_000);
    const progress: InstallProgress[] = [];
    // Act
    const install = installFfmpeg(tempDir(), silentLog, (p) => progress.push(p), { pin: PIN, stallMs: 1000, env: { SWARMCAST_TEST_FFMPEG_URL: url } });
    // Assert
    await expect(install).rejects.toMatchObject({ code: 'quality.install.stalled', params: { s: 1 } });
    expect(progress.at(-1)).toMatchObject({ phase: 'error', code: 'quality.install.stalled', message: expect.stringMatching(/nothing arrived for 1 seconds/) });
  });

  it('quitting the app stops the download as quitting, not as a stall', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const quit = new AbortController();
    const install = installFfmpeg(tempDir(), silentLog, () => {}, { pin: PIN, fetchImpl: silentFetch, signal: quit.signal });
    install.catch(() => {});
    // Act
    quit.abort(new Error('quitting'));
    // Assert
    await expect(install).rejects.toThrow('quitting');
  });
});

describe('ffmpegDownloadUrl', () => {
  it("is the publisher's URL when SWARMCAST_TEST_FFMPEG_URL is not set (every real run)", () => {
    // Act
    const url = ffmpegDownloadUrl(PIN, {});
    // Assert
    expect(url).toBe(PIN.url);
  });

  it('takes a local stand-in on 127.0.0.1', () => {
    // Act
    const url = ffmpegDownloadUrl(PIN, { SWARMCAST_TEST_FFMPEG_URL: 'http://127.0.0.1:20001/ffmpeg-n9.0.2-win64-lgpl-9.0.zip' });
    // Assert
    expect(url).toBe('http://127.0.0.1:20001/ffmpeg-n9.0.2-win64-lgpl-9.0.zip');
  });

  it.each([
    ['another host', 'https://example.com/ffmpeg.zip'],
    ['a name that resolves anywhere', 'http://localhost:20001/ffmpeg.zip'],
    ['a host that starts like loopback', 'http://127.0.0.1.example.com:80/ffmpeg.zip'],
    ['another loopback address', 'http://127.0.0.2:20001/ffmpeg.zip'],
    ['credentials or a query', 'http://127.0.0.1:20001/ffmpeg.zip?x=@example.com'],
  ])('refuses %s', (_what, value) => {
    // Act
    const pick = () => ffmpegDownloadUrl(PIN, { SWARMCAST_TEST_FFMPEG_URL: value });
    // Assert
    expect(pick).toThrow(/SWARMCAST_TEST_FFMPEG_URL/);
  });
});
