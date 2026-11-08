// Downloads of the pinned binaries (fetch-binaries.mjs). Two kinds of tests:
// - HTTP behaviour (Range resume, 206/200/416 answers, checksums, mirrors) against real local
//   servers on 127.0.0.1 (a port the OS picks, one server per need, closed when the test ends). A
//   try that "breaks" is a connection the server closes mid-body after flushing its bytes: an event
//   the client sees at once, with no timer involved, so stallMs keeps its default and never fires.
// - Time behaviour (a try that gets no data for stallMs is aborted, the back-off between tries, the
//   count of tries without progress, the overall time cap) on a scripted network (download's
//   `fetch` option: an in-memory Response per request) under Vitest's fake clock, so a stall is
//   exactly stallMs of fake time after the last byte the script sent, never a real wait.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, onTestFinished, vi } from 'vitest';
import { assetUrls, download, downloadFirst, githubApiUrl } from '../fetch-binaries.mjs';
import versions from '../versions.json' with { type: 'json' };
import { it } from './fixtures.js';

const FILE = crypto.randomBytes(64 * 1024);
const SHA = crypto.createHash('sha256').update(FILE).digest('hex');
/** The SHA-256 of a file (comparing 64 KB byte by byte with toEqual takes ~40 ms a test). */
const sha256Of = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const HALF = FILE.length / 2;
/** No back-off between tries (the HTTP tests never wait for a timer). */
const NO_WAIT = { waitMs: () => 0 };
/** The time options of the stall tests (fake time): 300 ms without data is a stall, 10 ms between tries. */
const STALL = { waitMs: () => 10, stallMs: 300 };
/** Where the scripted network "is" (it answers any URL). */
const SCRIPTED_URL = 'https://downloads.example/ffmpeg.zip';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---- real local servers --------------------------------------------------------------------

/** A local server for this test; `handle` answers request number n (0-based). `seen` has each request's Range header. */
async function serve(handle: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; seen: Array<{ range?: string }> }> {
  const seen: Array<{ range?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ range: req.headers.range });
    handle(seen.length - 1, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ffmpeg.zip`, seen };
}

/**
 * A mirror that cannot be reached: a server that drops every connection as soon as it opens. It
 * keeps its port for the whole test, so no other process can take it in between.
 */
async function unreachable(): Promise<string> {
  const server = http.createServer();
  server.on('connection', (socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/ffmpeg.zip`;
}

/**
 * Sends `body` from `start`, as 206 when `partial`. With `breakAfter`, sends that many bytes and
 * then closes the connection once they are flushed: the client has every one of them, then an
 * unexpected end of the body.
 */
function send(res: http.ServerResponse, body: Buffer, o: { start?: number; partial?: boolean; breakAfter?: number } = {}): void {
  const start = o.start ?? 0;
  const part = body.subarray(start);
  const headers: http.OutgoingHttpHeaders = { 'content-length': part.length, 'accept-ranges': 'bytes' };
  if (o.partial) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
  res.writeHead(o.partial ? 206 : 200, headers);
  if (o.breakAfter === undefined) res.end(part);
  else res.write(part.subarray(0, o.breakAfter), () => res.socket?.end());
}

/** Every byte of `body`, chunked (no Content-Length), then the connection closes before the last chunk. */
function sendChunkedWithoutEnd(res: http.ServerResponse, body: Buffer): void {
  res.writeHead(200, { 'accept-ranges': 'bytes' });
  res.write(body, () => res.socket?.end());
}

function rangeStart(range: string | undefined): number | null {
  const m = /^bytes=(\d+)-$/.exec(range ?? '');
  return m ? Number(m[1]) : null;
}

// ---- the scripted network (fake time) ------------------------------------------------------

/** One scripted answer: the status, headers and body bytes, then the end of the body or silence (a stall). */
interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** The body in this many chunks, `dripMs` of (fake) time apart; all at once by default. */
  chunks?: number;
  dripMs?: number;
  then?: 'end' | 'silence';
}

/** The rest of FILE from the Range start: 206 with its Content-Range, or the whole file (200) without a Range. */
function restOf(range: string | undefined, o: Partial<Answer> & { upTo?: number } = {}): Answer {
  const { upTo, ...answer } = o;
  const start = rangeStart(range) ?? 0;
  const body = FILE.subarray(start, upTo === undefined ? FILE.length : Math.min(FILE.length, start + upTo));
  const headers = start > 0 ? { 'content-range': `bytes ${start}-${FILE.length - 1}/${FILE.length}` } : undefined;
  return { status: start > 0 ? 206 : 200, ...(headers ? { headers } : {}), body, ...answer };
}

/**
 * A `fetch` that answers request number n with `answer(n, range)` from memory. A body that goes
 * silent errors with the request's abort reason once download() aborts the try, as fetch does.
 */
function scriptedNetwork(answer: (n: number, range: string | undefined) => Answer) {
  const seen: Array<{ range?: string }> = [];
  const fetch = async (_url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const range = new Headers(init.headers).get('range') ?? undefined;
    seen.push({ range });
    const a = answer(seen.length - 1, range);
    const signal = init.signal;
    const bytes = a.body ?? new Uint8Array(0);
    const chunks = a.chunks ?? 1;
    const size = Math.ceil(bytes.length / chunks);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const finish = () => (a.then === 'silence' ? signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true }) : controller.close());
        if (bytes.length === 0) return finish();
        for (let i = 0; i < chunks; i++) {
          const chunk = bytes.slice(i * size, (i + 1) * size);
          const deliver = () => {
            controller.enqueue(chunk);
            if (i === chunks - 1) finish();
          };
          if (a.dripMs) setTimeout(deliver, (i + 1) * a.dripMs);
          else deliver();
        }
      },
    });
    return new Response(body, { status: a.status ?? 200, ...(a.headers ? { headers: a.headers } : {}) });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

/** Runs `download` on the scripted network to its end, letting fake time pass while it waits. */
async function downloadScripted(net: ReturnType<typeof scriptedNetwork>, dest: string, opts: Record<string, unknown> = {}): Promise<void> {
  const done = download(SCRIPTED_URL, dest, SHA, { ...STALL, ...opts, fetch: net.fetch });
  // Attached at once: a download that fails while the clock runs is not an unhandled rejection.
  const settled = done.then(
    () => null,
    (err: unknown) => err,
  );
  await vi.runAllTimersAsync();
  const err = await settled;
  if (err) throw err;
}

describe('download (real HTTP)', () => {
  it('writes the bytes only when they match the pinned SHA-256, and no .part file stays', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp, 'a.zip');

    // Act
    await download(url, dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(seen).toEqual([{ range: undefined }]);
  });

  it('resumes a try that broke mid-body with a Range request, and gets the right bytes', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((n, req, res) => {
      if (n === 0) return send(res, FILE, { breakAfter: HALF });
      const start = rangeStart(req.headers.range);
      send(res, FILE, start === null ? {} : { start, partial: true });
    });
    const dest = path.join(tmp, 'a.zip');

    // Act
    await download(url, dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`]);
  });

  it('also works with a server that answers a Range request with the whole file (200)', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((n, _req, res) => send(res, FILE, n === 0 ? { breakAfter: HALF } : {}));
    const dest = path.join(tmp, 'a.zip');

    // Act
    await download(url, dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`]);
  });

  it('takes a 416 as "already complete" when the earlier try had every byte', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((n, _req, res) => {
      if (n === 0) return sendChunkedWithoutEnd(res, FILE);
      res.writeHead(416, { 'content-range': `bytes */${FILE.length}` }).end();
    });
    const dest = path.join(tmp, 'a.zip');

    // Act
    await download(url, dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(seen).toHaveLength(2);
  });

  it('starts over after a 416 that does not match what it has', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((n, _req, res) => {
      if (n === 0) return send(res, FILE, { breakAfter: HALF });
      if (n === 1) return void res.writeHead(416, { 'content-range': `bytes */${HALF - 1}` }).end();
      send(res, FILE);
    });
    const dest = path.join(tmp, 'a.zip');

    // Act
    await download(url, dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`, undefined]);
  });

  it('starts over after a 206 that starts at another byte than it asked for', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((n, _req, res) => {
      if (n === 0) return send(res, FILE, { breakAfter: HALF });
      send(res, FILE, n === 1 ? { start: 0, partial: true } : {});
    });
    const dest = path.join(tmp, 'a.zip');

    // Act
    await download(url, dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`, undefined]);
  });

  it('fails at once on a mismatch and leaves nothing on disk', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((_n, _req, res) => send(res, Buffer.from('something else')));

    // Act
    const run = download(url, path.join(tmp, 'a.zip'), SHA, NO_WAIT);

    // Assert
    await expect(run).rejects.toThrow(/Checksum mismatch .*expected [0-9a-f]{64}, got [0-9a-f]{64}$/);
    expect(seen).toHaveLength(1);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('a mismatch after a resume is final too, and says it resumed', async ({ tmp }) => {
    // Arrange
    const other = crypto.randomBytes(FILE.length);
    const { url, seen } = await serve((n, req, res) => {
      if (n === 0) return send(res, FILE, { breakAfter: HALF });
      send(res, other, { start: rangeStart(req.headers.range) ?? 0, partial: true });
    });

    // Act
    const run = download(url, path.join(tmp, 'a.zip'), SHA, NO_WAIT);

    // Assert
    await expect(run).rejects.toThrow(new RegExp(`Checksum mismatch .*after resuming at byte ${HALF}`));
    expect(seen).toHaveLength(2);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('does not retry a missing file', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((_n, _req, res) => void res.writeHead(404).end());

    // Act
    const run = download(url, path.join(tmp, 'a.zip'), SHA, NO_WAIT);

    // Assert
    await expect(run).rejects.toThrow(/HTTP 404 .*try 1, 1 of 6 in a row without progress/);
    expect(seen).toHaveLength(1);
  });

  it('refuses to download without a pinned SHA-256', async ({ tmp }) => {
    // Arrange
    const { url, seen } = await serve((_n, _req, res) => send(res, FILE));

    // Act
    const run = download(url, path.join(tmp, 'a.zip'), undefined as unknown as string, NO_WAIT);

    // Assert
    await expect(run).rejects.toThrow(/no pinned SHA-256/);
    expect(seen).toHaveLength(0);
  });
});

describe('download: stalls and time limits (scripted network, fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a try that gets no data for stallMs and resumes it with a Range request', async ({ tmp }) => {
    // Arrange
    const net = scriptedNetwork((n, range) => (n === 0 ? restOf(range, { upTo: HALF, then: 'silence' }) : restOf(range)));
    const dest = path.join(tmp, 'a.zip');

    // Act
    await downloadScripted(net, dest);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(net.seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`try 1 failed (no data for 0.3 s, ${HALF} bytes kept;`));
  });

  it('a slow body whose chunks keep coming within stallMs is not a stall', async ({ tmp }) => {
    // Arrange
    const net = scriptedNetwork((_n, range) => restOf(range, { chunks: 8, dripMs: STALL.stallMs - 1 }));
    const dest = path.join(tmp, 'a.zip');

    // Act
    await downloadScripted(net, dest);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(net.seen).toHaveLength(1);
  });

  it('a server that sends a few KB per connection and then stalls still finishes, after more than 6 tries', async ({ tmp }) => {
    // Arrange
    const step = 4 * 1024;
    const net = scriptedNetwork((_n, range) => {
      const last = (rangeStart(range) ?? 0) + step >= FILE.length;
      return restOf(range, last ? {} : { upTo: step, then: 'silence' });
    });
    const dest = path.join(tmp, 'a.zip');

    // Act
    await downloadScripted(net, dest);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(net.seen).toHaveLength(FILE.length / step);
  });

  it('gives up after 6 tries in a row without new bytes, whatever came before', async ({ tmp }) => {
    // Arrange
    const net = scriptedNetwork((n, range) => restOf(range, { upTo: n < 2 ? 1024 : 0, then: 'silence' }));

    // Act
    const run = downloadScripted(net, path.join(tmp, 'a.zip'));

    // Assert
    await expect(run).rejects.toThrow(/no data for 0\.3 s \(.*try 8, 6 of 6 in a row without progress\)$/);
    expect(net.seen).toHaveLength(8);
  });

  it('stops at the overall time cap even while bytes still trickle in', async ({ tmp }) => {
    // Arrange
    const net = scriptedNetwork((_n, range) => restOf(range, { upTo: 16, then: 'silence' }));

    // Act
    const run = downloadScripted(net, path.join(tmp, 'a.zip'), { maxMs: 1500 });

    // Assert
    await expect(run).rejects.toThrow(/gave up after 0\.025 min, 80 bytes received; SC_DOWNLOAD_MAX_MIN/);
    expect(net.seen).toHaveLength(5);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('downloadFirst (mirror first, publisher as fallback)', () => {
  it('uses the mirror and never asks the publisher when the mirror works', async ({ tmp }) => {
    // Arrange
    const mirror = await serve((_n, _req, res) => send(res, FILE));
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp, 'a.zip');

    // Act
    const used = await downloadFirst([mirror.url, origin.url], dest, SHA, NO_WAIT);

    // Assert
    expect(used).toBe(mirror.url);
    expect(sha256Of(dest)).toBe(SHA);
    expect(origin.seen).toHaveLength(0);
  });

  it('logs a source that worked only after failed tries as an infra recovery (the soak counts them)', async ({ tmp }) => {
    // Arrange
    const origin = await serve((n, _req, res) => (n === 0 ? void res.writeHead(504).end() : send(res, FILE)));
    const dest = path.join(tmp, 'a.zip');

    // Act
    await downloadFirst([origin.url], dest, SHA, NO_WAIT);

    // Assert
    expect(sha256Of(dest)).toBe(SHA);
    expect(vi.mocked(console.warn).mock.calls.flat()).toContain(`  infra recovery: ${origin.url} downloaded on try 2 (the 1 before it failed)`);
  });

  it('falls back to the publisher when the mirror file is missing (404)', async ({ tmp }) => {
    // Arrange
    const mirror = await serve((_n, _req, res) => void res.writeHead(404).end());
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp, 'a.zip');

    // Act
    const used = await downloadFirst([mirror.url, origin.url], dest, SHA, NO_WAIT);

    // Assert
    expect(used).toBe(origin.url);
    expect(sha256Of(dest)).toBe(SHA);
    expect(mirror.seen).toHaveLength(1);
    expect(origin.seen).toHaveLength(1);
  });

  it('falls back to the publisher when the mirror cannot be reached', async ({ tmp }) => {
    // Arrange
    const gone = await unreachable();
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp, 'a.zip');

    // Act
    const used = await downloadFirst([gone, origin.url], dest, SHA, NO_WAIT);

    // Assert
    expect(used).toBe(origin.url);
    expect(sha256Of(dest)).toBe(SHA);
  });

  it('a wrong file on the mirror is a final error: the publisher is not tried and nothing is written', async ({ tmp }) => {
    // Arrange
    const mirror = await serve((_n, _req, res) => send(res, Buffer.from('not the pinned file')));
    const origin = await serve((_n, _req, res) => send(res, FILE));

    // Act
    const run = downloadFirst([mirror.url, origin.url], path.join(tmp, 'a.zip'), SHA, NO_WAIT);

    // Assert
    await expect(run).rejects.toThrow(new RegExp(`^Checksum mismatch for ${mirror.url}`));
    expect(origin.seen).toHaveLength(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('reports every source when all of them fail', async ({ tmp }) => {
    // Arrange
    const mirror = await serve((_n, _req, res) => void res.writeHead(404).end());
    const origin = await serve((_n, _req, res) => void res.writeHead(410).end());

    // Act
    const run = downloadFirst([mirror.url, origin.url], path.join(tmp, 'a.zip'), SHA, NO_WAIT);

    // Assert
    await expect(run).rejects.toThrow(/HTTP 404 .*; then HTTP 410 /);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('downloadFirst: GitHub release files through the GitHub API (github.com answering 504)', () => {
  const RELEASE_URL = 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/a.zip';
  /** The network: github.com answers 504 to everything, the rest goes to the local servers. */
  const github504: typeof globalThis.fetch = async (url, init) => (String(url).startsWith('https://github.com/') ? new Response('Gateway Time-out', { status: 504 }) : fetch(url, init));

  /** A local stand-in for api.github.com: the release by tag, and its asset as octet-stream (or `assetStatus`). */
  async function api({ tagStatus = 200, assets = [{ id: 7, name: 'a.zip' }] } = {}) {
    const seen: Array<{ url?: string; accept?: string }> = [];
    const server = await serve((_n, req, res) => {
      seen.push({ url: req.url, accept: req.headers.accept });
      if (req.url === '/repos/bluenviron/mediamtx/releases/tags/v1.21.3') {
        res.writeHead(tagStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ assets }));
      } else if (req.url === '/repos/bluenviron/mediamtx/releases/assets/7' && req.headers.accept === 'application/octet-stream') {
        send(res, FILE);
      } else {
        res.writeHead(404).end();
      }
    });
    return { apiBase: server.url.replace(/\/ffmpeg\.zip$/, ''), seen };
  }

  it('gets the file from the API after github.com failed its tries, and logs it as an infra recovery', async ({ tmp }) => {
    // Arrange
    const { apiBase, seen } = await api();
    const dest = path.join(tmp, 'a.zip');

    // Act
    const used = await downloadFirst([RELEASE_URL], dest, SHA, { ...NO_WAIT, fetch: github504, apiBase });

    // Assert
    expect(used).toBe(`${apiBase}/repos/bluenviron/mediamtx/releases/assets/7`);
    expect(sha256Of(dest)).toBe(SHA);
    expect(seen.map((r) => r.url)).toEqual(['/repos/bluenviron/mediamtx/releases/tags/v1.21.3', '/repos/bluenviron/mediamtx/releases/assets/7']);
    expect(vi.mocked(console.warn).mock.calls.flat().some((l) => String(l).startsWith(`  infra recovery: ${RELEASE_URL} downloaded through the GitHub API`))).toBe(true);
  });

  it('reports every source when the API refuses too (its limit of 60 requests an hour)', async ({ tmp }) => {
    // Arrange
    const { apiBase } = await api({ tagStatus: 403 });

    // Act
    const run = downloadFirst([RELEASE_URL], path.join(tmp, 'a.zip'), SHA, { ...NO_WAIT, fetch: github504, apiBase });

    // Assert
    await expect(run).rejects.toThrow(/^HTTP 504 \(https:\/\/github\.com\/.*try 6, 6 of 6 in a row without progress\); then HTTP 403 from the GitHub API for release v1\.21\.3 of bluenviron\/mediamtx$/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('asks the API only for GitHub release files, and names a missing asset', async ({ tmp }) => {
    // Arrange
    const other = await serve((_n, _req, res) => void res.writeHead(404).end());
    const { apiBase } = await api({ assets: [] });

    // Act
    const notGithub = downloadFirst([other.url], path.join(tmp, 'a.zip'), SHA, { ...NO_WAIT, apiBase });
    const missing = githubApiUrl(RELEASE_URL, { apiBase });

    // Assert
    await expect(notGithub).rejects.toThrow(/^HTTP 404 \(http:\/\/127\.0\.0\.1:\d+\/ffmpeg\.zip, try 1, 1 of 6 in a row without progress\)$/);
    await expect(missing).rejects.toThrow('release v1.21.3 of bluenviron/mediamtx has no a.zip (GitHub API)');
  });
});

describe('versions.json mirrors', () => {
  type Asset = { url?: string; asset: string; sha256: string; mirrors?: string[] };
  type Spec = { version: string; url: string; assets: Record<string, Asset> };
  const specs = versions as unknown as Record<string, Spec>;
  const all = Object.entries(specs).flatMap(([tool, spec]) => Object.entries(spec.assets).map(([target, a]) => ({ tool, target, spec, a })));

  it('lists the mirrors first and the publisher last', () => {
    // Arrange
    const ffmpeg = all.find((x) => x.tool === 'ffmpeg' && x.target === 'macos-arm64')!;

    // Act
    const urls = assetUrls(ffmpeg.spec, ffmpeg.a);

    // Assert
    expect(urls).toEqual([...ffmpeg.a.mirrors!, ffmpeg.a.url]);
  });

  it('an asset without mirrors comes from its publisher only', () => {
    // Arrange
    const mtx = all.find((x) => x.tool === 'mediamtx')!;

    // Act
    const urls = assetUrls(mtx.spec, mtx.a);

    // Assert
    expect(urls).toEqual([`https://github.com/bluenviron/mediamtx/releases/download/${mtx.spec.version}/${mtx.a.asset}`]);
  });

  it("only points at this repo's ci-deps pre-release, and one mirror file always has one pin", () => {
    // Act
    const mirrors = all.flatMap(({ a }) => (a.mirrors ?? []).map((m) => ({ m, sha256: a.sha256 })));

    // Assert
    expect(mirrors.length).toBeGreaterThan(0);
    for (const { m } of mirrors) expect(m).toMatch(/^https:\/\/github\.com\/Lucas-Angelo\/swarmcast\/releases\/download\/ci-deps\/[\w.-]+$/);
    const pins = new Map<string, Set<string>>();
    for (const { m, sha256 } of mirrors) pins.set(m, (pins.get(m) ?? new Set()).add(sha256));
    for (const [m, set] of pins) expect(set.size, m).toBe(1);
  });
});

describe('versions.json test tools', () => {
  type Spec = { version: string; url: string; bundle?: boolean; testTool?: boolean; assets: Record<string, { asset: string; sha256: string }> };
  const tools = Object.entries(versions as unknown as Record<string, Spec>).filter(([, spec]) => spec.testTool);

  it('are never bundled, have a build for every target and come from this repo\'s ci-deps pre-release', () => {
    // Assert
    expect(tools.map(([tool]) => tool)).toContain('pebble');
    for (const [tool, spec] of tools) {
      expect(spec.bundle, tool).toBe(false);
      expect(Object.keys(spec.assets).sort(), tool).toEqual(['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
      for (const a of Object.values(spec.assets)) expect(assetUrls(spec, a)).toEqual([`https://github.com/Lucas-Angelo/swarmcast/releases/download/ci-deps/${a.asset}`]);
    }
  });
});

describe('versions.json archives kept whole', () => {
  type Spec = { version: string; url: string; bundle?: boolean; testOnly?: boolean; archive?: boolean; assets: Record<string, { asset: string; sha256: string }> };
  const archives = Object.entries(versions as unknown as Record<string, Spec>).filter(([, spec]) => spec.archive);

  it('are test tools fetched only by name, never bundled (the OBS suite\'s portable OBS)', () => {
    // Assert
    expect(archives.map(([tool]) => tool)).toEqual(['obs-studio']);
    for (const [tool, spec] of archives) {
      expect(spec.bundle, tool).toBe(false);
      expect(spec.testOnly, tool).toBe(true);
      for (const a of Object.values(spec.assets)) expect(a.sha256, tool).toMatch(/^[0-9a-f]{64}$/);
    }
    const obs = archives[0]![1];
    expect(Object.keys(obs.assets)).toEqual(['windows-x64']);
    expect(assetUrls(obs, obs.assets['windows-x64']!)).toEqual(['https://github.com/obsproject/obs-studio/releases/download/33.0.0/OBS-Studio-33.0.0-Windows-x64.zip']);
  });
});
