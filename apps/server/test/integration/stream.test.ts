import crypto from 'node:crypto';
import http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { encodeTrackerFrame, parseTrackerFrame } from '@swarmcast/shared';
import { createApp, type App } from '../../src/app.js';
import { infoHashHexFor } from '../../src/tracker/tracker.js';
import { isListening } from '../../src/core/ports.js';
import { isAlive } from '../../src/process/children.js';
import { hasFfmpeg, joinAs, pushTestStream, tmpDir, waitFor } from './helpers.js';

const PORTS = { rtmp: 29350, public: 28080, admin: 28081, mediamtxHls: 28888 };
const BASE = `http://127.0.0.1:${PORTS.public}`;

describe.skipIf(!hasFfmpeg)('MediaMTX + server with a real RTMP stream', () => {
  let app: App;
  let ffmpeg: ChildProcess | null = null;
  let mediamtxPid: number | undefined;

  beforeAll(async () => {
    app = await createApp({
      dataDir: tmpDir(),
      noTunnel: true,
      noReaper: true,
      logToStdout: false,
      configOverrides: { ports: PORTS, speedTest: { enabled: false, intervalMinutes: 15 } },
    });
    await app.live.start();
    mediamtxPid = (app.live as unknown as { d: { mediamtx: { pid?: number } } }).d.mediamtx.pid;
    ffmpeg = pushTestStream(`rtmp://127.0.0.1:${PORTS.rtmp}/live/${app.live.snapshot().streamKey}`);
    await waitFor(() => app.live.phase === 'live', 40_000, 'stream to become live');
  });

  afterAll(async () => {
    ffmpeg?.kill('SIGKILL');
    await app?.close();
  });

  it('rejects publishing with a wrong stream key', async () => {
    const bad = pushTestStream(`rtmp://127.0.0.1:${PORTS.rtmp}/live/sc_wrongwrongwrongwrongwr`);
    const code = await new Promise<number | null>((r) => bad.on('exit', r));
    expect(code).not.toBe(0);
  });

  it('serves playlists, segments and a signed manifest whose hashes match', async () => {
    const snap = app.live.snapshot();
    expect(snap.obsConnected).toBe(true);
    expect(snap.obsBitrateKbps).toBeGreaterThan(300);
    const jar = await joinAs(BASE, snap.liveLink!, 'Integration');

    const multi = await (await jar.fetch('/hls/index.m3u8')).text();
    expect(multi).toContain('#EXT-X-STREAM-INF');
    expect(multi).not.toContain('session=');
    const media = await (await jar.fetch('/hls/video1_stream.m3u8')).text();
    expect(media).toContain('#EXT-X-MAP');
    expect(media).toMatch(/#EXT-X-TARGETDURATION:2\b/);
    const segName = media.split('\n').filter((l) => l && !l.startsWith('#')).pop()!;
    const segRes = await jar.fetch(`/hls/${segName}`);
    expect(segRes.status).toBe(200);
    expect(segRes.headers.get('cache-control')).toContain('private');
    const seg = Buffer.from(await segRes.arrayBuffer());
    const hash = crypto.createHash('sha256').update(seg).digest('hex');

    const jws = await (await jar.fetch('/hls/manifest.json')).text();
    const [h, p, s] = jws.split('.') as [string, string, string];
    const cfg = (await (await jar.fetch('/api/config')).json()) as { manifestPublicKey: string };
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: cfg.manifestPublicKey }, format: 'jwk' });
    expect(crypto.verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))).toBe(true);
    const manifest = JSON.parse(Buffer.from(p, 'base64url').toString()) as { segments: Record<string, string> };
    expect(manifest.segments[`/hls/${segName}`]).toBe(hash);
  });

  it('rejects every protected resource without a session', async () => {
    for (const p of ['/hls/index.m3u8', '/hls/video1_stream.m3u8', '/hls/manifest.json', '/api/config']) {
      const res = await fetch(BASE + p);
      expect(res.status, p).toBe(401);
    }
    expect((await fetch(`${BASE}/watch`)).status).toBe(404);
    for (const p of ['/tracker', '/control']) {
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORTS.public}${p}`, { origin: BASE });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
        ws.on('error', () => {});
      });
      expect(code, p).toBe(401);
    }
  });

  it('carries the tracker inside /control: one WebSocket per viewer (quick tunnel limit)', async () => {
    const jar = await joinAs(BASE, app.live.snapshot().liveLink!, 'OneSocket');
    const ws = new WebSocket(`ws://127.0.0.1:${PORTS.public}/control`, { origin: BASE, headers: { cookie: jar.header() } });
    const frames: string[] = [];
    ws.on('message', (d) => frames.push(d.toString()));
    await new Promise((r) => ws.on('open', r));
    const peer = '-PM0400-000000000042';
    const infoHash = Buffer.from(infoHashHexFor(app.live.access.liveId, 'main'), 'hex').toString('latin1');
    ws.send(encodeTrackerFrame({ op: 'open', id: 1 }));
    ws.send(encodeTrackerFrame({ op: 'data', id: 1, payload: JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: peer, numwant: 0, offers: [], event: 'started' }) }));
    await waitFor(() => frames.some((f) => f.startsWith('~d1 ')), 5000, 'tracker answer on the control socket');
    const frame = parseTrackerFrame(frames.find((f) => f.startsWith('~d1 '))!);
    const answer = JSON.parse(frame?.op === 'data' ? frame.payload : '{}') as Record<string, unknown>;
    expect(answer['failure reason']).toBeUndefined();
    expect(answer.action).toBe('announce');
    // Control messages share the socket (hello came first).
    expect(JSON.parse(frames[0]!).t).toBe('hello');
    expect(app.live.tracker.peerCount()).toBeGreaterThanOrEqual(1);
    expect(app.live.tracker.plainSocketCount).toBe(0);
    expect(app.live.snapshot().stats.tunnelInFlight).toBeGreaterThanOrEqual(1);
    const closed = new Promise((r) => ws.on('close', r));
    ws.close();
    await closed;
    await waitFor(() => app.live.tracker.socketCount === 0, 5000, 'channel closed with the control socket');
  });

  it('rejects cross-origin WebSocket upgrades even with a session', async () => {
    const jar = await joinAs(BASE, app.live.snapshot().liveLink!, 'OriginCheck');
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORTS.public}/control`, { origin: 'https://evil.example', headers: { cookie: jar.header() } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(code).toBe(403);
  });

  it('sends a strict CSP and security headers on viewer pages', async () => {
    const jar = await joinAs(BASE, app.live.snapshot().liveLink!, 'Headers');
    const res = await jar.fetch('/watch');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    const html = await res.text();
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('keeps the admin API off the public port and locked down on its own port', async () => {
    expect((await fetch(`${BASE}/api/state`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/live/stop`, { method: 'POST' })).status).toBe(404);
    const admin = `http://127.0.0.1:${PORTS.admin}`;
    expect((await fetch(`${admin}/api/state`)).status).toBe(401);
    // DNS rebinding: foreign Host header.
    const rebind = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORTS.admin, path: '/api/state', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });
    expect(rebind).toBe(421);
    // Login, then a cross-site POST must still fail.
    const login = await fetch(app.adminLoginUrl, { redirect: 'manual' });
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    expect((await fetch(`${admin}/api/state`, { headers: { cookie } })).status).toBe(200);
    const csrf = await fetch(`${admin}/api/link/rotate`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(csrf.status).toBe(403);
    expect(await isListening(PORTS.admin, '127.0.0.1')).toBe(true);
  });

  it('"Stop everything" leaves no process, port or cached video behind', async () => {
    ffmpeg?.kill('SIGKILL');
    const verified = await app.live.stop();
    expect(verified).toBe(true);
    expect(app.live.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(app.live.phase).toBe('off');
    expect(app.live.origin.cachedFileCount).toBe(0);
    if (mediamtxPid) expect(isAlive(mediamtxPid)).toBe(false);
    for (const p of [PORTS.rtmp, PORTS.public, PORTS.mediamtxHls]) expect(await isListening(p)).toBe(false);
    expect(await fetch(`${BASE}/healthz`).then(() => 'up', () => 'down')).toBe('down');
  });
});
