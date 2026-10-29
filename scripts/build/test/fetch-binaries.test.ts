import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetUrls, download, downloadFirst } from '../fetch-binaries.mjs';
import { renderBinariesJson } from '../binaries-json.mjs';
import versions from '../versions.json' with { type: 'json' };

const dirs: string[] = [];
const servers: http.Server[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fetch-bins-'));
  dirs.push(d);
  return d;
}
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const FILE = crypto.randomBytes(64 * 1024);
const SHA = crypto.createHash('sha256').update(FILE).digest('hex');
const HALF = FILE.length / 2;
const fast = { waitMs: () => 10, stallMs: 300 };

interface Seen {
  range?: string;
}
/** A local server; `handle` answers request number n (0-based) and sees its Range header. */
async function serve(handle: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    seen.push({ range: req.headers.range });
    handle(seen.length - 1, req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/ffmpeg.zip`, seen };
}

/** Sends `body` from `start`, as 206 when start > 0; with `stallAfter`, sends that many bytes and then nothing. */
function send(res: http.ServerResponse, body: Buffer, o: { start?: number; partial?: boolean; stallAfter?: number } = {}): void {
  const start = o.start ?? 0;
  const part = body.subarray(start);
  const headers: http.OutgoingHttpHeaders = { 'content-length': part.length, 'accept-ranges': 'bytes' };
  if (o.partial) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
  res.writeHead(o.partial ? 206 : 200, headers);
  if (o.stallAfter === undefined) res.end(part);
  else res.write(part.subarray(0, o.stallAfter)); // ...and never ends.
}

function rangeStart(req: http.IncomingMessage): number | null {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  return m ? Number(m[1]) : null;
}

describe('download', () => {
  it('writes the bytes only when they match the pinned SHA-256', async () => {
    const { url, seen } = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp(), 'a.zip');
    await download(url, dest, SHA, fast);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(seen).toEqual([{ range: undefined }]);
  });

  it('resumes a try that stalled mid-body with a Range request, and gets the right bytes', async () => {
    const { url, seen } = await serve((n, req, res) => {
      if (n === 0) return send(res, FILE, { stallAfter: HALF });
      const start = rangeStart(req);
      send(res, FILE, start === null ? {} : { start, partial: true });
    });
    const dest = path.join(tmp(), 'a.zip');
    await download(url, dest, SHA, fast);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`]);
  });

  it('also works with a server that answers a Range request with the whole file (200)', async () => {
    const { url, seen } = await serve((n, _req, res) => send(res, FILE, n === 0 ? { stallAfter: HALF } : {}));
    const dest = path.join(tmp(), 'a.zip');
    await download(url, dest, SHA, fast);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`]);
  });

  it('takes a 416 as "already complete" when the earlier try had every byte', async () => {
    const { url, seen } = await serve((n, _req, res) => {
      if (n === 0) {
        // Every byte, chunked (no Content-Length), but the last chunk never comes.
        res.writeHead(200, { 'accept-ranges': 'bytes' });
        return void res.write(FILE);
      }
      res.writeHead(416, { 'content-range': `bytes */${FILE.length}` }).end();
    });
    const dest = path.join(tmp(), 'a.zip');
    await download(url, dest, SHA, fast);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(seen).toHaveLength(2);
  });

  it('starts over after a 416 that does not match what it has', async () => {
    const { url, seen } = await serve((n, _req, res) => {
      if (n === 0) return send(res, FILE, { stallAfter: HALF });
      if (n === 1) return void res.writeHead(416, { 'content-range': `bytes */${HALF - 1}` }).end();
      send(res, FILE);
    });
    const dest = path.join(tmp(), 'a.zip');
    await download(url, dest, SHA, fast);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(seen.map((s) => s.range)).toEqual([undefined, `bytes=${HALF}-`, undefined]);
  });

  it('fails at once on a mismatch and leaves nothing on disk', async () => {
    const { url, seen } = await serve((_n, _req, res) => send(res, Buffer.from('something else')));
    const dir = tmp();
    await expect(download(url, path.join(dir, 'a.zip'), SHA, fast)).rejects.toThrow(/Checksum mismatch .*expected [0-9a-f]{64}, got [0-9a-f]{64}$/);
    expect(seen).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a mismatch after a resume is final too, and says it resumed', async () => {
    const other = crypto.randomBytes(FILE.length);
    const { url, seen } = await serve((n, req, res) => {
      if (n === 0) return send(res, FILE, { stallAfter: HALF });
      send(res, other, { start: rangeStart(req) ?? 0, partial: true }); // the rest of a different file
    });
    const dir = tmp();
    await expect(download(url, path.join(dir, 'a.zip'), SHA, fast)).rejects.toThrow(new RegExp(`Checksum mismatch .*after resuming at byte ${HALF}`));
    expect(seen).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a server that sends a few KB per connection and then stalls still finishes, after more than 6 tries', async () => {
    const step = 4 * 1024; // 64 KB in 16 connections
    const { url, seen } = await serve((_n, req, res) => {
      const start = rangeStart(req) ?? 0;
      const last = start + step >= FILE.length;
      send(res, FILE, { start, partial: start > 0, ...(last ? {} : { stallAfter: step }) });
    });
    const dest = path.join(tmp(), 'a.zip');
    await download(url, dest, SHA, fast);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(seen).toHaveLength(FILE.length / step);
  });

  it('gives up after 6 tries in a row without new bytes, whatever came before', async () => {
    const { url, seen } = await serve((n, req, res) => {
      const start = rangeStart(req) ?? 0;
      // Progress on the first two connections, then nothing.
      send(res, FILE, { start, partial: start > 0, stallAfter: n < 2 ? 1024 : 0 });
    });
    await expect(download(url, path.join(tmp(), 'a.zip'), SHA, fast)).rejects.toThrow(/no data for .*try 8, 6 of 6 in a row without progress/);
    expect(seen).toHaveLength(8);
  });

  it('stops at the overall time cap even while bytes still trickle in', async () => {
    const { url } = await serve((_n, req, res) => {
      const start = rangeStart(req) ?? 0;
      send(res, FILE, { start, partial: start > 0, stallAfter: 16 });
    });
    const dir = tmp();
    await expect(download(url, path.join(dir, 'a.zip'), SHA, { ...fast, maxMs: 1500 })).rejects.toThrow(/gave up after 0\.025 min, \d+ bytes received; SC_DOWNLOAD_MAX_MIN/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not retry a missing file', async () => {
    const { url, seen } = await serve((_n, _req, res) => void res.writeHead(404).end());
    await expect(download(url, path.join(tmp(), 'a.zip'), SHA, fast)).rejects.toThrow(/HTTP 404 .*try 1, 1 of 6 in a row without progress/);
    expect(seen).toHaveLength(1);
  });

  it('refuses to download without a pinned SHA-256', async () => {
    const { url, seen } = await serve((_n, _req, res) => send(res, FILE));
    await expect(download(url, path.join(tmp(), 'a.zip'), undefined as unknown as string, fast)).rejects.toThrow(/no pinned SHA-256/);
    expect(seen).toHaveLength(0);
  });
});

describe('downloadFirst (mirror first, publisher as fallback)', () => {
  it('uses the mirror and never asks the publisher when the mirror works', async () => {
    const mirror = await serve((_n, _req, res) => send(res, FILE));
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp(), 'a.zip');
    expect(await downloadFirst([mirror.url, origin.url], dest, SHA, fast)).toBe(mirror.url);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(origin.seen).toHaveLength(0);
  });

  it('falls back to the publisher when the mirror file is missing (404)', async () => {
    const mirror = await serve((_n, _req, res) => void res.writeHead(404).end());
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp(), 'a.zip');
    expect(await downloadFirst([mirror.url, origin.url], dest, SHA, fast)).toBe(origin.url);
    expect(fs.readFileSync(dest)).toEqual(FILE);
    expect(mirror.seen).toHaveLength(1);
    expect(origin.seen).toHaveLength(1);
  });

  it('falls back to the publisher when the mirror cannot be reached', async () => {
    const gone = await serve((_n, _req, res) => send(res, FILE));
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dest = path.join(tmp(), 'a.zip');
    expect(await downloadFirst([gone.url, origin.url], dest, SHA, fast)).toBe(origin.url);
    expect(fs.readFileSync(dest)).toEqual(FILE);
  });

  it('a wrong file on the mirror is a final error: the publisher is not tried and nothing is written', async () => {
    const mirror = await serve((_n, _req, res) => send(res, Buffer.from('not the pinned file')));
    const origin = await serve((_n, _req, res) => send(res, FILE));
    const dir = tmp();
    await expect(downloadFirst([mirror.url, origin.url], path.join(dir, 'a.zip'), SHA, fast)).rejects.toThrow(new RegExp(`^Checksum mismatch for ${mirror.url}`));
    expect(origin.seen).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports every source when all of them fail', async () => {
    const mirror = await serve((_n, _req, res) => void res.writeHead(404).end());
    const origin = await serve((_n, _req, res) => void res.writeHead(410).end());
    const dir = tmp();
    await expect(downloadFirst([mirror.url, origin.url], path.join(dir, 'a.zip'), SHA, fast)).rejects.toThrow(/HTTP 404 .*; then HTTP 410 /);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('versions.json mirrors', () => {
  type Asset = { url?: string; asset: string; sha256: string; mirrors?: string[] };
  type Spec = { version: string; url: string; assets: Record<string, Asset> };
  const specs = versions as unknown as Record<string, Spec>;
  const all = Object.entries(specs).flatMap(([tool, spec]) => Object.entries(spec.assets).map(([target, a]) => ({ tool, target, spec, a })));

  it('lists the mirrors first and the publisher last', () => {
    const { spec, a } = all.find((x) => x.tool === 'ffmpeg' && x.target === 'macos-arm64')!;
    expect(assetUrls(spec, a)).toEqual([...a.mirrors!, a.url]);
    const mtx = all.find((x) => x.tool === 'mediamtx')!;
    expect(assetUrls(mtx.spec, mtx.a)).toEqual([`https://github.com/bluenviron/mediamtx/releases/download/${mtx.spec.version}/${mtx.a.asset}`]);
  });

  it('only points at this repo\'s ci-deps pre-release, and one mirror file always has one pin', () => {
    const pinOf = new Map<string, string>();
    for (const { a } of all) {
      for (const m of a.mirrors ?? []) {
        expect(m).toMatch(/^https:\/\/github\.com\/Lucas-Angelo\/swarmcast\/releases\/download\/ci-deps\/[\w.-]+$/);
        expect(pinOf.get(m) ?? a.sha256).toBe(a.sha256);
        pinOf.set(m, a.sha256);
      }
    }
    expect(pinOf.size).toBeGreaterThan(0);
  });

  it('never reach users: binaries.json carries the publisher URLs only', () => {
    const out = renderBinariesJson(versions);
    expect(out).not.toContain('ci-deps');
    expect(out).not.toContain('mirrors');
  });
});
