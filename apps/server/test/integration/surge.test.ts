import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { LiveController } from '../../src/core/live.js';
import { ManifestSigner } from '../../src/hls/manifest.js';
import { NEED_HEADER } from '../../src/hls/need.js';
import { inactiveDirect, makeController } from '../unit/live-helpers.js';
import { startSyntheticSource, type SyntheticSource } from '../../../../scripts/test/surge/source.js';
import { Jar, ROOT, joinAs } from './helpers.js';

// Many people at once (docs/QUALITY.md "Upload order"): the real public server and HLS origin,
// fed by the surge bench's synthetic ladder (scripts/test/surge/source.ts) instead of MediaMTX,
// behind a small upload cap so the cap is the bottleneck. What a whole burst does to an audience
// is measured by the bench itself (scripts/test/surge/bench.ts, soak suite "surge"); here, that the
// pieces work over real HTTP: the order of the upload, and the pre-compressed page scripts.

const VIEWER_DIST = path.join(ROOT, 'apps/viewer/dist');

let live: LiveController | null = null;
let source: SyntheticSource | null = null;

afterEach(async () => {
  // The source first: "Stop everything" checks that nothing listens on MediaMTX's port any more.
  await source?.close();
  await live?.stop();
  live = null;
  source = null;
});

/** A live at `uploadMbps` on a one-rendition synthetic stream of `kbps` (2 s segments), once its origin serves it. */
async function startLive(uploadMbps: number, kbps: number): Promise<{ base: string; link: string; live: LiveController }> {
  const streamKey = `sc_${crypto.randomBytes(12).toString('hex')}`;
  source = await startSyntheticSource(streamKey, [{ height: 480, kbps }]);
  const config = defaultConfig();
  config.ports = { rtmp: 0, public: 0, admin: 0, mediamtxHls: source.port };
  config.security.requireBrowserCheck = false;
  config.uploadLimitMbps = uploadMbps;
  config.quality.upload.mode = 'manual';
  config.quality.ladder = { ...config.quality.ladder, mode: 'manual', enabled: false };
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const signer = await ManifestSigner.create(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  ({ live } = makeController(inactiveDirect(), {
    config,
    streamKey,
    signer,
    viewerDir: VIEWER_DIST,
    // The server's own public address (P2P privacy): a fake lookup, never Cloudflare's trace endpoint.
    egress: { lookup: async () => ({ v4: '192.0.2.1' }), interfaces: () => 'test-net', tickMs: 3_600_000 },
  }));
  await live.start();
  const deadline = Date.now() + 30_000;
  while (!live.origin.available) {
    if (Date.now() > deadline) throw new Error('the origin never served the synthetic stream');
    await new Promise((r) => setTimeout(r, 50));
  }
  return { base: `http://127.0.0.1:${live.publicPort}`, link: live.liveLink!, live };
}

/** The segment names the stream's playlist lists now, oldest first. */
async function segments(jar: Jar): Promise<string[]> {
  const res = await jar.fetch('/hls/v480.m3u8');
  expect(res.status).toBe(200);
  return (await res.text()).split('\n').filter((l) => l.endsWith('.mp4') && !l.startsWith('#'));
}

/** Downloads `/hls/<name>` saying it is needed in `needS`; resolves when the last byte arrived (performance.now()). */
async function download(jar: Jar, name: string, needS: number): Promise<{ firstByteAt: number; doneAt: number; bytes: number }> {
  const res = await jar.fetch(`/hls/${name}`, { headers: { [NEED_HEADER]: String(needS) } });
  expect(res.status).toBe(200);
  let firstByteAt = 0;
  let bytes = 0;
  for await (const chunk of res.body!) {
    firstByteAt ||= performance.now();
    bytes += (chunk as Uint8Array).length;
  }
  return { firstByteAt, doneAt: performance.now(), bytes };
}

describe('upload order', () => {
  it('sends a segment needed now before buffer fill that asked first, and keeps the fill moving', async () => {
    // Arrange: 8 Mbps (1 MB/s); 1 MB segments. One viewer fills its buffer far ahead with four
    // segments; then a newcomer asks for its first one.
    const { base, link } = await startLive(8, 4000);
    const filler = await joinAs(base, link, 'Filler');
    const newcomer = await joinAs(base, link, 'Newcomer');
    const names = await segments(filler);
    expect(names.length).toBeGreaterThanOrEqual(5);
    const fill = names.slice(0, 4).map((n) => download(filler, n, 20));
    // The fill is under way (its first bytes arrived) before the newcomer asks.
    await Promise.race(fill.map(async (f) => (await f).firstByteAt));
    const t0 = performance.now();
    // Act
    const first = await download(newcomer, names.at(-1)!, 0);
    const done = await Promise.all(fill);
    // Assert: alone the newcomer's 1 MB takes about 1 s; shared equally with the fill downloads
    // still running (about 3 MB left at 1 MB/s) it would have ended with them, after about 4 s.
    // The fill keeps receiving bytes meanwhile, and finishes after it.
    expect(first.bytes).toBe(1_000_000);
    expect(first.doneAt - t0).toBeLessThan(2_500);
    const running = done.filter((d) => d.doneAt > t0);
    expect(running.length).toBeGreaterThanOrEqual(2);
    for (const d of done) expect(d.bytes).toBe(1_000_000);
    for (const d of running) expect(d.doneAt).toBeGreaterThan(first.doneAt);
  });
});

describe('page scripts', () => {
  /** GET `p` without decoding the body: status, headers and the bytes on the wire. */
  function rawGet(base: string, p: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: number }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${base}${p}`, { headers }, (res) => {
          let bytes = 0;
          res.on('data', (c: Buffer) => (bytes += c.length));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes }));
        })
        .on('error', reject);
    });
  }

  it('are served Brotli-compressed to a browser that accepts it, plain otherwise (about a quarter of the bytes)', async () => {
    // Arrange: the watch page's main script, as built (npm run build).
    const { base } = await startLive(8, 500);
    const html = fs.readFileSync(path.join(VIEWER_DIST, 'watch.html'), 'utf8');
    const script = /src="(\/assets\/watch-[^"]+\.js)"/.exec(html)?.[1];
    expect(script, 'watch.html names its script').toBeDefined();
    const raw = fs.statSync(path.join(VIEWER_DIST, script!)).size;
    // Act
    const br = await rawGet(base, script!, { 'accept-encoding': 'gzip, deflate, br' });
    const gz = await rawGet(base, script!, { 'accept-encoding': 'gzip' });
    const plain = await rawGet(base, script!, {});
    // Assert
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toMatch(/javascript/);
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(br.headers.vary).toMatch(/accept-encoding/i);
    expect(br.bytes).toBeLessThan(raw * 0.35);
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.bytes).toBeLessThan(raw * 0.4);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.bytes).toBe(raw);
  });
});
