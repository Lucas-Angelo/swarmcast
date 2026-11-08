import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { exe, platformTag } from '../../src/core/paths.js';
import { QuickTunnel } from '../../src/tunnel/quick.js';
import { cloudflareStandIn, standInArgs } from '../../src/tunnel/stand-in.js';
import { startLocalCloudflare, type LocalCloudflare } from '../../../../scripts/test/lib/cloudflare.mjs';
import { ROOT, bootApp, tmpDir, until } from './helpers.js';

// The local stand-in for Cloudflare's quick tunnels (scripts/test/lib/cloudflare.mjs), which the
// system tests use instead of the real service: the real cloudflared (vendor/, `npm run
// fetch-bins`) registers with its edge over the tunnel protocol, and viewers' requests and
// WebSockets reach the origin through it. Then a live of the real app opens its tunnel there
// (SWARMCAST_TEST_CLOUDFLARE): the live link, its reachability checks, the tunnel watch that
// replaces a tunnel Cloudflare answers with its 530 page, and "Stop everything".

const CLOUDFLARED = path.join(ROOT, 'vendor', platformTag(), exe('cloudflared'));
const QUICK_TUNNEL_URL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const log = pino({ level: 'silent' });
/** Bigger than a 2 s 1080p segment, and than HTTP/2's default 64 KiB windows many times over. */
const BIG_BODY = 'segment-'.repeat(768 * 1024);

async function localCloudflare(): Promise<LocalCloudflare> {
  const cf = await startLocalCloudflare({ dir: tmpDir('sc-cf-') });
  onTestFinished(() => cf.close());
  return cf;
}

/** An origin that echoes what it got: the request line and headers, a POST body, WebSocket messages; /big answers BIG_BODY. */
async function echoOrigin(): Promise<{ port: number }> {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/big') {
      res.end(BIG_BODY);
      return;
    }
    res.setHeader('set-cookie', ['first=1; Path=/', 'second=2; Path=/']);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, bodyLength: body.length }));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => socket.on('message', (m) => socket.send(`${String(m)} from ${String(req.headers['cf-connecting-ip'])}`)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  onTestFinished(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as AddressInfo).port };
}

/** The real cloudflared as SwarmCast runs it (QuickTunnel), pointed at the stand-in; returns its address once registered. */
async function tunnelTo(cf: LocalCloudflare, port: number): Promise<string> {
  const tunnel = new QuickTunnel(CLOUDFLARED, tmpDir('sc-cfd-'), null, log, { extraArgs: standInArgs(cloudflareStandIn(cf.appEnv)!) });
  onTestFinished(() => tunnel.stop());
  const url = await tunnel.start(port);
  await until(() => cf.tunnels().some((t) => `https://${t.hostname}` === url && t.connections > 0), { timeoutMs: 30_000, what: 'the tunnel connection registered' });
  return url;
}

describe('the local Cloudflare with the real cloudflared', () => {
  it("carries a request to the origin with Cloudflare's headers, and the whole answer back", async () => {
    // Arrange
    const cf = await localCloudflare();
    const origin = await echoOrigin();
    const url = await tunnelTo(cf, origin.port);
    // Act
    const res = await cf.request(`${url}/path?q=1`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(50_000) });
    // Assert
    expect(url).toMatch(QUICK_TUNNEL_URL);
    expect(res?.status).toBe(200);
    expect(res?.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/']);
    const seen = JSON.parse(res!.body) as { method: string; url: string; headers: Record<string, string>; bodyLength: number };
    expect(seen).toMatchObject({ method: 'POST', url: '/path?q=1', bodyLength: 50_000 });
    expect(seen.headers).toMatchObject({ host: new URL(url).host, 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-proto': 'https' });
    expect(seen.headers['cf-ray']).toMatch(/^[0-9a-f]{16}-LCL$/);
  });

  it('carries a big answer whole (a video segment)', async () => {
    // Arrange
    const cf = await localCloudflare();
    const origin = await echoOrigin();
    const url = await tunnelTo(cf, origin.port);
    // Act
    const res = await cf.request(`${url}/big`);
    // Assert
    expect(res?.status).toBe(200);
    expect(res?.body.length).toBe(BIG_BODY.length);
    expect(res?.body === BIG_BODY).toBe(true);
  });

  it('carries a WebSocket both ways', async () => {
    // Arrange
    const cf = await localCloudflare();
    const origin = await echoOrigin();
    const host = new URL(await tunnelTo(cf, origin.port)).host;
    const socket = new WebSocket(`wss://${cf.web}/ws`, { ca: cf.caPem, servername: host, headers: { host } } as WebSocket.ClientOptions);
    onTestFinished(() => socket.terminate());
    await once(socket, 'open');
    // Act
    socket.send('ping');
    const [reply] = (await once(socket, 'message')) as [Buffer];
    // Assert
    expect(String(reply)).toBe('ping from 127.0.0.1');
  });

  it("answers Cloudflare's 530 for a tunnel whose connector is gone, and DNS knows its name", async () => {
    // Arrange
    const cf = await localCloudflare();
    const origin = await echoOrigin();
    const tunnel = new QuickTunnel(CLOUDFLARED, tmpDir('sc-cfd-'), null, log, { extraArgs: standInArgs(cloudflareStandIn(cf.appEnv)!) });
    const url = await tunnel.start(origin.port);
    await until(() => cf.tunnels().some((t) => t.connections > 0), { timeoutMs: 30_000, what: 'the tunnel connection registered' });
    // Act
    await tunnel.stop();
    const res = await cf.request(`${url}/`);
    // Assert
    expect(res?.status).toBe(530);
    expect(res?.body).toContain('error code: 1033');
    expect(cf.tunnels()).toEqual([expect.objectContaining({ hostname: new URL(url).hostname, connections: 0, known: true })]);
  });
});

describe('a live through the local Cloudflare', () => {
  /** A live of the real app whose quick tunnel goes to `cf`, its tunnel watch checking every `everyMs`. */
  async function liveThrough(cf: LocalCloudflare, everyMs = 30_000) {
    vi.stubEnv('SWARMCAST_TEST_CLOUDFLARE', cf.appEnv.SWARMCAST_TEST_CLOUDFLARE);
    onTestFinished(() => void vi.unstubAllEnvs());
    const { app } = await bootApp({ noTunnel: false, configOverrides: { tunnel: { provider: 'cloudflare-quick' } }, tunnelWatch: { everyMs, recheckMs: 200 } });
    onTestFinished(() => app.close());
    return app;
  }

  const baseOf = (link: string | undefined) => (link ?? '').replace(/\/join\/.*$/, '');

  it('opens the live link on a quick-tunnel name that answers with this live', async () => {
    // Arrange
    const cf = await localCloudflare();
    // Act
    const app = await liveThrough(cf);
    // Assert
    const base = baseOf(app.live.liveLink);
    expect(base).toMatch(QUICK_TUNNEL_URL);
    expect(await cf.healthz(base, { 'x-swarmcast-probe': app.live.access.probeToken() })).toBe(app.live.access.liveId);
  });

  it('replaces a tunnel whose address Cloudflare answers with its 530 page, with a new link that works', async () => {
    // Arrange
    const cf = await localCloudflare();
    const app = await liveThrough(cf, 300);
    const oldBase = baseOf(app.live.liveLink);
    const changed = once(app.live, 'link-changed') as Promise<[string]>;
    // Act
    cf.stopRouting(new URL(oldBase).hostname);
    const [link] = await changed;
    // Assert
    const newBase = baseOf(link);
    expect(newBase).toMatch(QUICK_TUNNEL_URL);
    expect(newBase).not.toBe(oldBase);
    expect(await cf.healthz(newBase, { 'x-swarmcast-probe': app.live.access.probeToken() })).toBe(app.live.access.liveId);
    expect((await cf.request(`${oldBase}/healthz`))?.status).toBe(530);
  });

  it('"Stop everything" is verified and the address then answers 530', async () => {
    // Arrange
    const cf = await localCloudflare();
    const app = await liveThrough(cf);
    const base = baseOf(app.live.liveLink);
    // Act
    const verified = await app.live.stop();
    // Assert
    expect(verified).toBe(true);
    expect((await cf.request(`${base}/healthz`))?.status).toBe(530);
  });
});
