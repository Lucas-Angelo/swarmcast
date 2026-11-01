import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CodedError } from '../../src/core/messages.js';
import { exe, platformTag } from '../../src/core/paths.js';
import type { TunnelRetry } from '../../src/tunnel/provider.js';
import { QuickTunnel } from '../../src/tunnel/quick.js';
import { START_RETRY_DELAYS_MS } from '../../src/tunnel/start-failure.js';
import { ROOT, tmpDir } from './helpers.js';

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

/** A QuickTunnel running the real cloudflared against `service`; records the waits and retry events. */
function realTunnel(service: { url: string; port: number }, extraArgs: string[] = []) {
  const waits: number[] = [];
  const retries: TunnelRetry[] = [];
  const tunnel = new QuickTunnel(CLOUDFLARED, tmpDir('sc-cf-'), null, log, {
    extraArgs: ['--quick-service', service.url, '--edge', `127.0.0.1:${service.port}`, '--metrics', '127.0.0.1:0', ...extraArgs],
    sleep: async (ms) => void waits.push(ms),
    random: () => 0,
  });
  tunnel.on('retry', (r) => retries.push(r));
  onTestFinished(() => tunnel.stop());
  return { tunnel, waits, retries };
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
