/**
 * End-to-end test of the in-house ACME client against Pebble, Let's Encrypt's ACME test CA, run
 * as a process on this machine. Real Let's Encrypt (production or staging) is never contacted.
 *
 * - Pebble is the pinned binary `npm run fetch-bins` puts in vendor/<target>/ (scripts/build/
 *   versions.json, "pebble"): built from a commit of Pebble's main branch, not its v2.10.1
 *   release, which can leave the poll of an order that follows its finalize unanswered for good
 *   (its Order() handler read-locks the order twice, and the CA's write lock after issuing can
 *   queue between the two: letsencrypt/pebble#554, fixed by #555 on main). Our client polls right
 *   after finalizing, and a test failed after the client's 30 s request timeout about once in 200
 *   runs. Go back to a release once one has the fix (docs/RELEASING.md, section 8).
 * - Certificates are for 127.0.0.1: Pebble validates an IP identifier by connecting to the IP
 *   itself, on its config's `httpPort` / `tlsPort` (normally 80 / 443), set to free ports of this
 *   worker; the issuer's `challengeHttpPort` / `challengeTlsPort` serve the challenge there
 *   instead of mapping a router port.
 * - Pebble's own HTTPS uses a self-signed certificate for 127.0.0.1 made here, which a small
 *   node:https based fetch override trusts. Its management interface is off.
 * - PEBBLE_VA_ALWAYS_VALID=0 makes Pebble really validate (see the failure-path tests);
 *   PEBBLE_VA_NOSLEEP=1 skips Pebble's random validation delay; PEBBLE_WFE_NONCEREJECT=0
 *   disables random badNonce rejections (two in a row would exceed the client's single retry;
 *   badNonce handling is covered by the unit tests; set PEBBLE_WFE_NONCEREJECT=<percent> in the
 *   environment to exercise it against Pebble).
 *
 * Readiness is the directory answering, polled with a deadline; afterAll stops Pebble and
 * confirms it is gone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exe, platformTag } from '../../src/core/paths.js';
import type { FetchLike } from '../../src/direct/acme.js';
import { LetsEncryptIpIssuer, SelfSignedIssuer, type IssuedCert } from '../../src/direct/certs.js';
import type { PortMapper } from '../../src/direct/mapper.js';
import { ROOT, allocPorts, spawnTracked, tmpDir, until, type Tracked } from './helpers.js';

const PEBBLE = path.join(ROOT, 'vendor', platformTag(), exe('pebble'));
const SHORTLIVED_SECONDS = 518_400; // Pebble's "shortlived" profile validity (6 days)
/** The identifier of every certificate: Pebble connects to it to validate. */
const IP = '127.0.0.1';

const log = pino({ level: 'silent' });

/**
 * A free port of this worker's block that is not Pebble's httpPort: an http-01 responder there
 * is never reached, so that validation fails.
 */
async function portPebbleNeverCalls(): Promise<number> {
  return (await allocPorts(1))[0]!;
}

/** fetch() replacement that trusts an extra CA (global fetch has no per-call CA option without undici). */
function fetchTrusting(ca: string): FetchLike {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const method = init?.method ?? 'GET';
      const req = https.request(url, { method, ca, headers: init?.headers as Record<string, string> | undefined, signal: init?.signal ?? undefined }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, item);
          }
          const status = res.statusCode ?? 0;
          const body = method === 'HEAD' || status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers }));
        });
      });
      req.on('error', reject);
      req.end(typeof init?.body === 'string' ? init.body : undefined);
    });
}

function splitPem(chain: string): string[] {
  return chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * A fake router: "mapping external port 80" starts a TCP forwarder on Pebble's httpPort that
 * leads to the issuer's own (random) local responder port; unmapping closes it. `events` lists
 * the calls in order.
 */
function fakeRouter(httpPort: number): { mapper: PortMapper; events: string[]; forwarding: () => boolean } {
  const events: string[] = [];
  let proxy: net.Server | null = null;
  const mapper: PortMapper = {
    kind: 'upnp',
    id: 'fake',
    externalIp: async () => IP,
    hasMapping: async () => proxy !== null,
    map: async (externalPort, internalPort, internalHost) => {
      events.push(`map ${externalPort}`);
      proxy = net.createServer((client) => {
        const upstream = net.connect(internalPort, internalHost);
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      await new Promise<void>((r) => proxy!.listen(httpPort, IP, () => r()));
    },
    unmap: async (externalPort) => {
      events.push(`unmap ${externalPort}`);
      await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
      proxy = null;
    },
  };
  return { mapper, events, forwarding: () => proxy !== null };
}

describe('ACME client against Pebble', () => {
  let pebble: Tracked | null = null;
  let directoryUrl = '';
  let fetchImpl: FetchLike;
  let httpPort = 0;
  let tlsPort = 0;

  beforeAll(async () => {
    let listenPort: number;
    [listenPort, httpPort, tlsPort] = (await allocPorts(3)) as [number, number, number];
    const tmp = tmpDir('sc-pebble-');
    const tls = await new SelfSignedIssuer().issue(IP);
    fs.writeFileSync(path.join(tmp, 'cert.pem'), tls.certPem);
    fs.writeFileSync(path.join(tmp, 'key.pem'), tls.keyPem);
    const config = {
      pebble: {
        listenAddress: `${IP}:${listenPort}`,
        managementListenAddress: '',
        certificate: path.join(tmp, 'cert.pem'),
        privateKey: path.join(tmp, 'key.pem'),
        httpPort,
        tlsPort,
        ocspResponderURL: '',
        externalAccountBindingRequired: false,
        retryAfter: { authz: 1, order: 1 },
        keyAlgorithm: 'ecdsa',
        profiles: {
          default: { description: 'The profile you know and love', validityPeriod: 7_776_000 },
          shortlived: { description: 'A short-lived cert profile', validityPeriod: SHORTLIVED_SECONDS },
        },
      },
    };
    fs.writeFileSync(path.join(tmp, 'pebble-config.json'), JSON.stringify(config));

    pebble = spawnTracked(PEBBLE, ['-config', path.join(tmp, 'pebble-config.json')], {
      name: 'pebble',
      cwd: tmp,
      env: { ...process.env, PEBBLE_VA_ALWAYS_VALID: '0', PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: process.env.PEBBLE_WFE_NONCEREJECT ?? '0' },
    });
    directoryUrl = `https://${IP}:${listenPort}/dir`;
    fetchImpl = fetchTrusting(tls.certPem);

    let lastError = 'no answer yet';
    await until(
      async () => {
        try {
          // Pebble rejects requests without a User-Agent (RFC 8555 section 6.1).
          const res = await fetchImpl(directoryUrl, { headers: { 'User-Agent': 'swarmcast-test' } });
          lastError = `HTTP ${res.status}`;
          return res.ok;
        } catch (err) {
          lastError = (err as Error).message;
          return false;
        }
      },
      { timeoutMs: 30_000, what: `Pebble's directory at ${directoryUrl}`, detail: () => `${lastError}; Pebble's output:\n${pebble!.tail(40)}`, abortOn: [pebble] },
    );
  });

  afterAll(async () => {
    await pebble?.stop();
  });

  async function expectValidIpCert(cert: IssuedCert) {
    expect(cert.source).toBe('letsencrypt');
    const chain = splitPem(cert.certPem);
    expect(chain.length).toBeGreaterThanOrEqual(2); // leaf + Pebble intermediate
    const leaf = new x509.X509Certificate(chain[0]!);
    const san = leaf.getExtension(x509.SubjectAlternativeNameExtension)!;
    expect(san.names.toJSON()).toEqual([{ type: 'ip', value: IP }]);
    expect(cert.expiresAt).toBe(leaf.notAfter.getTime());
    // The shortlived profile was requested and honored (6 days instead of 90).
    const lifetime = (leaf.notAfter.getTime() - leaf.notBefore.getTime()) / 1000;
    expect(Math.abs(lifetime - SHORTLIVED_SECONDS)).toBeLessThan(3600);
    // Leaf is signed by the next certificate in the chain, and the private key matches.
    expect(await leaf.verify({ publicKey: new x509.X509Certificate(chain[1]!), signatureOnly: true })).toBe(true);
    expect(new crypto.X509Certificate(chain[0]!).checkPrivateKey(crypto.createPrivateKey(cert.keyPem))).toBe(true);
  }

  it('issues an IP certificate with http-01', async () => {
    // Arrange
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, { fetch: fetchImpl, preferredChallenge: 'http-01', challengeHttpPort: httpPort, listenHost: IP, pollTimeoutMs: 60_000 });
    // Act
    const cert = await issuer.issue(IP, { mapper: null, internalHost: '127.0.0.1' });
    // Assert
    await expectValidIpCert(cert);
  });

  it('issues an IP certificate with tls-alpn-01 (acme-tls/1, reverse-DNS SNI, acmeIdentifier extension)', async () => {
    // Arrange
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, { fetch: fetchImpl, preferredChallenge: 'tls-alpn-01', challengeTlsPort: tlsPort, listenHost: IP, pollTimeoutMs: 60_000 });
    // Act
    const cert = await issuer.issue(IP, { mapper: null, internalHost: '127.0.0.1' });
    // Assert
    await expectValidIpCert(cert);
  });

  it('falls back to tls-alpn-01 with a new order when http-01 validation fails', async () => {
    // Arrange
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, {
      fetch: fetchImpl,
      preferredChallenge: ['http-01', 'tls-alpn-01'],
      challengeHttpPort: await portPebbleNeverCalls(),
      challengeTlsPort: tlsPort,
      listenHost: IP,
      pollTimeoutMs: 60_000,
    });
    // Act
    const cert = await issuer.issue(IP, { mapper: null, internalHost: '127.0.0.1' });
    // Assert
    await expectValidIpCert(cert);
  });

  it('maps the validation port through the PortMapper only during validation, then removes it', async () => {
    // Arrange
    const router = fakeRouter(httpPort);
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, { fetch: fetchImpl, preferredChallenge: 'http-01', listenHost: IP, pollTimeoutMs: 60_000 });
    // Act
    const cert = await issuer.issue(IP, { mapper: router.mapper, internalHost: '127.0.0.1' });
    // Assert
    await expectValidIpCert(cert);
    expect(router.events).toEqual(['map 80', 'unmap 80']);
    expect(router.forwarding()).toBe(false);
  });

  it('reports the ACME problem detail when validation fails', async () => {
    // Arrange
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, { fetch: fetchImpl, preferredChallenge: 'http-01', challengeHttpPort: await portPebbleNeverCalls(), listenHost: IP, pollTimeoutMs: 60_000 });
    // Act
    const issuing = issuer.issue(IP, { mapper: null, internalHost: '127.0.0.1' });
    // Assert
    await expect(issuing).rejects.toThrow(/http-01: authorization invalid: connection: /);
  });
});
