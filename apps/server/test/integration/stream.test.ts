import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeTrackerFrame, parseTrackerFrame } from '@swarmcast/shared';
import type { App } from '../../src/app.js';
import { isListening } from '../../src/core/ports.js';
import { infoHashHexFor } from '../../src/tracker/tracker.js';
import { bootApp, hasFfmpeg, isAlive, joinAs, signIn, startFeed, stopTracked, until, type Feed, type Ports } from './helpers.js';
import { openControl, stopViewerLives, upgradeStatus } from './viewers.js';

// MediaMTX, the public server and the panel of a real app, with a real RTMP stream from the
// fake OBS. The checks that only read share one live (starting MediaMTX and the stream is the
// expensive part); "Stop everything" ends a live, so it gets one of its own.
// A server started without SWARMCAST_TEST_HOOKS sends no `testHooks` in the viewer config: the
// watch page's test-only URL flags stay off.

interface Live {
  app: App;
  ports: Ports;
  feed: Feed;
  /** The public server (its port is picked by the OS when the live starts). */
  base: string;
}

/** An app whose live is on with the fake OBS sending (closed again if it does not get there). */
async function startStreaming(): Promise<Live> {
  const { app, ports } = await bootApp();
  const feed = startFeed(`rtmp://127.0.0.1:${ports.rtmp}/live/${app.live.snapshot().streamKey}`);
  try {
    await until(() => app.live.phase === 'live', { timeoutMs: 40_000, what: 'stream to become live', detail: () => `phase ${app.live.phase}`, abortOn: [feed], on: [[app.live, 'state']] });
  } catch (err) {
    await stopStreaming({ app, feed, ports, base: '' });
    throw err;
  }
  return { app, feed, ports: { ...ports, public: app.live.publicPort!, admin: app.adminPort }, base: `http://127.0.0.1:${app.live.publicPort}` };
}

async function stopStreaming(l: Live | undefined): Promise<void> {
  await l?.feed.stop();
  await l?.app.close();
  await stopTracked();
}

const segmentsOf = (playlist: string): string[] => playlist.split('\n').filter((l) => l && !l.startsWith('#'));

describe.skipIf(!hasFfmpeg)('MediaMTX + server with a real RTMP stream', () => {
  let live: Live;
  beforeAll(async () => {
    live = await startStreaming();
  });
  afterEach(stopViewerLives);
  afterAll(() => stopStreaming(live));

  it('rejects publishing with a wrong stream key', async () => {
    // Arrange
    const intruder = startFeed(`rtmp://127.0.0.1:${live.ports.rtmp}/live/sc_wrongwrongwrongwrongwr`);
    // Act
    const { code } = await intruder.exited;
    await intruder.stop();
    // Assert
    expect(code).not.toBe(0);
  });

  it('serves playlists, segments and a signed manifest whose hashes match', async () => {
    // Arrange
    const snap = live.app.live.snapshot();
    const jar = await joinAs(live.base, snap.liveLink!, 'Integration');
    // Act
    const multi = await (await jar.fetch('/hls/index.m3u8')).text();
    const media = await (await jar.fetch('/hls/video1_stream.m3u8')).text();
    const segName = segmentsOf(media).pop()!;
    const segRes = await jar.fetch(`/hls/${segName}`);
    const hash = crypto.createHash('sha256').update(Buffer.from(await segRes.arrayBuffer())).digest('hex');
    const jws = await (await jar.fetch('/hls/manifest.json')).text();
    const cfg = (await (await jar.fetch('/api/config')).json()) as { manifestPublicKey: string; testHooks?: boolean };
    // Assert
    expect(snap.obsConnected).toBe(true);
    expect(snap.obsBitrateKbps).toBeGreaterThan(300);
    expect(multi).toContain('#EXT-X-STREAM-INF');
    expect(multi).not.toContain('session=');
    expect(media).toContain('#EXT-X-MAP');
    expect(media).toMatch(/#EXT-X-TARGETDURATION:2\b/);
    expect(segRes.status).toBe(200);
    expect(segRes.headers.get('cache-control')).toContain('private');
    expect(cfg.testHooks).toBeUndefined();
    const [h, p, s] = jws.split('.') as [string, string, string];
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: cfg.manifestPublicKey }, format: 'jwk' });
    expect(crypto.verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))).toBe(true);
    const manifest = JSON.parse(Buffer.from(p, 'base64url').toString()) as { segments: Record<string, string> };
    expect(manifest.segments[`/hls/${segName}`]).toBe(hash);
  });

  it('rejects every protected resource without a session', async () => {
    // Arrange
    const ws = live.base.replace('http', 'ws');
    // Act
    const http401 = await Promise.all(['/hls/index.m3u8', '/hls/video1_stream.m3u8', '/hls/manifest.json', '/api/config'].map(async (p) => [p, (await fetch(live.base + p)).status] as const));
    const watch = (await fetch(`${live.base}/watch`)).status;
    const sockets = await Promise.all(['/tracker', '/control'].map(async (p) => [p, await upgradeStatus(ws + p, { origin: live.base })] as const));
    // Assert
    expect(Object.fromEntries(http401)).toEqual({ '/hls/index.m3u8': 401, '/hls/video1_stream.m3u8': 401, '/hls/manifest.json': 401, '/api/config': 401 });
    expect(watch).toBe(404);
    expect(Object.fromEntries(sockets)).toEqual({ '/tracker': 401, '/control': 401 });
  });

  it('carries the tracker inside /control: one WebSocket per viewer (quick tunnel limit)', async () => {
    // Arrange
    const jar = await joinAs(live.base, live.app.live.snapshot().liveLink!, 'OneSocket');
    const ctl = await openControl(live.base, jar);
    const infoHash = Buffer.from(infoHashHexFor(live.app.live.access.liveId, 'main'), 'hex').toString('latin1');
    // Act
    ctl.sendFrame(encodeTrackerFrame({ op: 'open', id: 1 }));
    ctl.sendFrame(encodeTrackerFrame({ op: 'data', id: 1, payload: JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: '-PM0400-000000000042', numwant: 0, offers: [], event: 'started' }) }));
    const frame = parseTrackerFrame(await ctl.frame((f) => f.startsWith('~d1 '), 'the tracker answer on the control socket'));
    const whileOpen = { peers: live.app.live.tracker.peerCount(), plainSockets: live.app.live.tracker.plainSocketCount, inFlight: live.app.live.snapshot().stats.tunnelInFlight };
    ctl.ws.close();
    await ctl.closed;
    await until(() => live.app.live.tracker.socketCount === 0, { timeoutMs: 5000, what: 'the channel to close with the control socket', detail: () => `sockets ${live.app.live.tracker.socketCount}` });
    // Assert
    const answer = JSON.parse(frame?.op === 'data' ? frame.payload : '{}') as Record<string, unknown>;
    expect(answer['failure reason']).toBeUndefined();
    expect(answer.action).toBe('announce');
    expect(ctl.messages[0]?.t).toBe('hello');
    expect(whileOpen.peers).toBeGreaterThanOrEqual(1);
    expect(whileOpen.plainSockets).toBe(0);
    expect(whileOpen.inFlight).toBeGreaterThanOrEqual(1);
  });

  it('rejects cross-origin WebSocket upgrades even with a session', async () => {
    // Arrange
    const jar = await joinAs(live.base, live.app.live.snapshot().liveLink!, 'OriginCheck');
    // Act
    const status = await upgradeStatus(`${live.base.replace('http', 'ws')}/control`, { origin: 'https://evil.example', headers: { cookie: jar.header() } });
    // Assert
    expect(status).toBe(403);
  });

  it('sends a strict CSP and security headers on viewer pages', async () => {
    // Arrange
    const jar = await joinAs(live.base, live.app.live.snapshot().liveLink!, 'Headers');
    // Act
    const res = await jar.fetch('/watch');
    const html = await res.text();
    // Assert
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('keeps the admin API off the public port and locked down on its own port', async () => {
    // Arrange
    const admin = `http://127.0.0.1:${live.ports.admin}`;
    // Act
    const onPublic = { state: (await fetch(`${live.base}/api/state`)).status, stop: (await fetch(`${live.base}/api/live/stop`, { method: 'POST' })).status };
    const signedOut = (await fetch(`${admin}/api/state`)).status;
    const rebound = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: live.ports.admin, path: '/api/state', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });
    const panel = await signIn(live.app.adminLoginUrl);
    const signedIn = (await panel.api('/api/state')).status;
    const crossSite = (await panel.api('/api/link/rotate', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })).status;
    // Assert
    expect(onPublic).toEqual({ state: 404, stop: 404 });
    expect(signedOut).toBe(401);
    expect(rebound).toBe(421);
    expect(signedIn).toBe(200);
    expect(crossSite).toBe(403);
    expect(await isListening(live.ports.admin, '127.0.0.1')).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)('"Stop everything" with a real RTMP stream', () => {
  let live: Live | undefined;
  afterEach(() => stopStreaming(live));

  it('leaves no process, port or cached video behind', async () => {
    // Arrange
    live = await startStreaming();
    const { app, ports, base } = live;
    const mediamtxPid = app.mediamtx.pid;
    await live.feed.stop();
    // Act
    const verified = await app.live.stop();
    // Assert
    expect(verified).toBe(true);
    expect(app.live.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(app.live.phase).toBe('off');
    expect(app.live.origin.cachedFileCount).toBe(0);
    expect(mediamtxPid).toEqual(expect.any(Number));
    expect(isAlive(mediamtxPid!)).toBe(false);
    for (const p of [ports.rtmp, ports.public, ports.mediamtxHls]) expect(await isListening(p), `port ${p}`).toBe(false);
    expect(await fetch(`${base}/healthz`).then(() => 'up', () => 'down')).toBe('down');
  });
});
