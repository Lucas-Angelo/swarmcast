import dgram from 'node:dgram';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CodedError } from '../../src/core/messages.js';
import { exe, platformTag } from '../../src/core/paths.js';
import type { TunnelRetry } from '../../src/tunnel/provider.js';
import { QuickTunnel } from '../../src/tunnel/quick.js';
import { START_RETRY_DELAYS_MS } from '../../src/tunnel/start-failure.js';
import { ROOT, allocPorts, tmpDir } from './helpers.js';

// The real cloudflared (vendor/, `npm run fetch-bins`) against a local stand-in for Cloudflare's
// quick-tunnel service (`--quick-service`): it answers each POST /tunnel with the next scripted
// response, as api.trycloudflare.com does when it refuses (429, "error code: 1015" or a JSON
// error), fails (503) or creates a tunnel. After a success cloudflared would connect to
// Cloudflare's edge: `--edge` points it at this machine instead, and the test stops it.
// The waits between attempts are recorded and skipped; jitter is fixed at 0.

const CLOUDFLARED = path.join(ROOT, 'vendor', platformTag(), exe('cloudflared'));
const HOSTNAME = 'quiet-river-test.trycloudflare.com';
const log = pino({ level: 'silent' });

type Reply = { status: number; body: string; type?: string };
const created: Reply = {
  status: 200,
  type: 'application/json',
  body: JSON.stringify({ success: true, result: { id: '9d7c3d3a-2a3b-4b4e-9a4e-1b2c3d4e5f60', name: 'test', hostname: HOSTNAME, account_tag: 'test', secret: Buffer.alloc(32).toString('base64') } }),
};
const tooMany: Reply = { status: 429, body: 'error code: 1015' };
const tooManyJson: Reply = { status: 429, type: 'application/json', body: JSON.stringify({ success: false, errors: [{ code: 1015, message: 'You are being rate limited' }] }) };
const unavailable: Reply = { status: 503, body: '<html>503 Service Temporarily Unavailable</html>' };

/** The stand-in quick-tunnel service: answers with `replies` in turn; counts the requests. */
async function quickService(replies: Reply[]): Promise<{ url: string; port: number; requests: () => number }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const r = replies[Math.min(n++, replies.length - 1)]!;
      res.writeHead(r.status, { 'content-type': r.type ?? 'text/plain' });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, requests: () => n };
}

/** A QuickTunnel running the real cloudflared against `service` (and `edgePort`); records the waits, retry and udp-blocked events. */
function realTunnel(service: { url: string; port: number }, extraArgs: string[] = [], edgePort = service.port) {
  const waits: number[] = [];
  const retries: TunnelRetry[] = [];
  const udpBlocked: string[] = [];
  const tunnel = new QuickTunnel(CLOUDFLARED, tmpDir('sc-cf-'), null, log, {
    extraArgs: ['--quick-service', service.url, '--edge', `127.0.0.1:${edgePort}`, '--metrics', '127.0.0.1:0', ...extraArgs],
    sleep: async (ms) => void waits.push(ms),
    random: () => 0,
  });
  tunnel.on('retry', (r) => retries.push(r));
  tunnel.on('udp-blocked', (reason) => udpBlocked.push(reason));
  onTestFinished(() => tunnel.stop());
  return { tunnel, waits, retries, udpBlocked };
}

/**
 * A stand-in for Cloudflare's edge on a network that drops UDP: its UDP port (QUIC) swallows every
 * packet; its TCP port (HTTP/2 over TLS, also cloudflared's TCP pre-check) records the TLS server
 * name of each connection (`h2.cftunnel.com` is the HTTP/2 tunnel connection, `probe.cftunnel.com`
 * the pre-check) and keeps it open without answering.
 */
async function edgeDroppingUdp(): Promise<{ port: number; udpPackets: () => number; tlsNames: string[] }> {
  const port = (await allocPorts(1))[0]!;
  const tlsNames: string[] = [];
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.once('data', (d) => tlsNames.push(/[a-z0-9.]+\.cftunnel\.com/.exec(d.toString('latin1'))?.[0] ?? `not TLS (0x${d[0]?.toString(16)})`));
  });
  await new Promise<void>((r) => tcp.listen(port, '127.0.0.1', r));
  let packets = 0;
  const udp = dgram.createSocket('udp4').on('message', () => void packets++);
  await new Promise<void>((r) => udp.bind(port, '127.0.0.1', r));
  onTestFinished(async () => {
    udp.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => tcp.close(() => r()));
  });
  return { port, udpPackets: () => packets, tlsNames };
}

/** Polls `ok` every 100 ms until it holds; the test's own timeout bounds it. */
async function until(ok: () => boolean): Promise<void> {
  while (!ok()) await new Promise((r) => setTimeout(r, 100));
}

async function rejection(p: Promise<unknown>): Promise<CodedError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CodedError);
  return err as CodedError;
}

describe('quick tunnel start with the real cloudflared', () => {
  it('tries again after a 429 and a 503, then gets the address', async () => {
    // Arrange
    const service = await quickService([tooMany, unavailable, created]);
    const { tunnel, waits, retries } = realTunnel(service);
    // Act
    const url = await tunnel.start(18080);
    // Assert
    expect(url).toBe(`https://${HOSTNAME}`);
    expect(service.requests()).toBe(3);
    expect(waits).toEqual([START_RETRY_DELAYS_MS[0], START_RETRY_DELAYS_MS[1]]);
    expect(retries.map((r) => [r.cause, r.reason])).toEqual([
      ['busy', 'quick tunnel provisioning failed with status 429'],
      ['unavailable', 'quick tunnel provisioning failed with status 503'],
    ]);
  });

  it("gives up after the last attempt with Cloudflare's own words", async () => {
    // Arrange
    const service = await quickService([tooManyJson]);
    const { tunnel } = realTunnel(service);
    // Act
    const err = await rejection(tunnel.start(18080));
    // Assert
    expect(service.requests()).toBe(START_RETRY_DELAYS_MS.length + 1);
    expect(err.code).toBe('err.tunnelBusy');
    expect(err.params?.reason).toBe('quick tunnel provisioning failed with status 429: [1015] You are being rate limited');
  });

  it('fails at once with its message when cloudflared refuses its arguments', async () => {
    // Arrange
    const service = await quickService([created]);
    const { tunnel, retries } = realTunnel(service, ['--bogus-flag']);
    // Act
    const err = await rejection(tunnel.start(18080));
    // Assert
    expect(service.requests()).toBe(0);
    expect(retries).toEqual([]);
    expect(err.code).toBe('err.tunnelFailed');
    expect(err.params?.reason).toBe('Incorrect Usage. flag provided but not defined: -bogus-flag');
  });
});

// A network that blocks or drops UDP (CI run 41283791976 on a macOS runner): cloudflared gets its
// address over HTTPS, then cannot reach Cloudflare's edge over QUIC, its default, and keeps trying
// QUIC for well over a minute. SwarmCast notices from cloudflared's own lines and opens the next
// tunnel with --protocol http2 (TCP).
describe('quick tunnel with the real cloudflared on a network that drops UDP', () => {
  it('reports UDP blocked from its QUIC failures', async () => {
    // Arrange
    const service = await quickService([created]);
    const edge = await edgeDroppingUdp();
    const { tunnel, udpBlocked } = realTunnel(service, [], edge.port);
    // Act
    const url = await tunnel.start(18080);
    await until(() => udpBlocked.length > 0);
    // Assert
    expect(url).toBe(`https://${HOSTNAME}`);
    expect(udpBlocked).toHaveLength(1);
    expect(udpBlocked[0]).toMatch(/failed to dial to edge with quic|UDP Connectivity/);
    expect(edge.udpPackets()).toBeGreaterThan(0);
    expect(edge.tlsNames).not.toContain('h2.cftunnel.com');
  });

  it('connects to the edge over TCP with HTTP/2 when started with transport tcp', async () => {
    // Arrange
    const service = await quickService([created]);
    const edge = await edgeDroppingUdp();
    const { tunnel, udpBlocked } = realTunnel(service, [], edge.port);
    // Act
    const url = await tunnel.start(18080, { transport: 'tcp' });
    await until(() => edge.tlsNames.some((name) => name === 'h2.cftunnel.com'));
    // Assert
    expect(url).toBe(`https://${HOSTNAME}`);
    expect(udpBlocked).toEqual([]);
  });
});
