/**
 * End-to-end test of the in-house ACME client against Pebble, Let's Encrypt's ACME test CA,
 * running in Docker. Real Let's Encrypt (production or staging) is never contacted.
 *
 * How validation reaches us (Docker Desktop on macOS, also works on Linux Docker >= 20.10):
 * - Pebble runs with `--add-host host.docker.internal:host-gateway`. Inside the container that
 *   name resolves to the host gateway IP (192.168.65.254 on Docker Desktop); we read it from
 *   the container's /etc/hosts and request the certificate for that IP. Pebble validates IP
 *   identifiers by connecting to the IP itself, and Docker Desktop forwards connections to
 *   the gateway IP to the Mac's loopback, so a responder bound to 127.0.0.1 is reachable.
 * - Pebble's config `httpPort` / `tlsPort` (normally 80 / 443) are set to free local ports,
 *   and the issuer's `challengeHttpPort` / `challengeTlsPort` serve the challenge there
 *   instead of mapping a router port.
 * - Pebble's directory uses a certificate from its test CA (/test/certs/pebble.minica.pem in
 *   the image); we copy it out and trust it through a small node:https based fetch override.
 * - PEBBLE_VA_ALWAYS_VALID=0 makes Pebble really validate (see the failure-path tests);
 *   PEBBLE_VA_NOSLEEP=1 skips Pebble's random validation delay; PEBBLE_WFE_NONCEREJECT=0
 *   disables random badNonce rejections (two in a row would exceed the client's single retry;
 *   badNonce handling is covered by the unit tests; set PEBBLE_WFE_NONCEREJECT=<percent> in the
 *   environment to exercise it against Pebble).
 *
 * The whole suite is skipped when `docker info` fails.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/direct/acme.js';
import { LetsEncryptIpIssuer, type IssuedCert } from '../../src/direct/certs.js';
import type { PortMapper } from '../../src/direct/mapper.js';
import { allocPorts } from './helpers.js';

/** ghcr.io/letsencrypt/pebble 2.10.1 (multi-arch index, revision b1e1ca4), pinned by digest. */
const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199';
const SHORTLIVED_SECONDS = 518_400; // Pebble's "shortlived" profile validity (6 days)

const hasDocker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const log = pino({ level: 'silent' });
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();

/** A port of this worker's block, free right now (not one from the OS's ephemeral range). */
async function freePort(): Promise<number> {
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

// Docker Desktop (macOS) forwards the gateway IP to the host's loopback; on Linux the
// container reaches the host through the bridge, so responders must listen on all interfaces.
const LISTEN_HOST = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';

// Windows runners only run Windows containers (no Linux Pebble image, no host-gateway).
describe.skipIf(!hasDocker || process.platform === 'win32')('ACME client against Pebble (Docker)', () => {
  let container = '';
  let directoryUrl = '';
  let ip = '';
  let fetchImpl: FetchLike;
  let httpPort = 0;
  let tlsPort = 0;

  beforeAll(async () => {
    httpPort = await freePort();
    tlsPort = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-pebble-'));
    const config = {
      pebble: {
        listenAddress: '0.0.0.0:14000',
        managementListenAddress: '0.0.0.0:15000',
        certificate: 'test/certs/localhost/cert.pem',
        privateKey: 'test/certs/localhost/key.pem',
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

    // create + cp + start avoids bind mounts (and Docker Desktop file-sharing settings).
    container = docker(
      'create', '--rm',
      '-p', '127.0.0.1::14000',
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', 'PEBBLE_VA_ALWAYS_VALID=0',
      '-e', 'PEBBLE_VA_NOSLEEP=1',
      '-e', `PEBBLE_WFE_NONCEREJECT=${process.env.PEBBLE_WFE_NONCEREJECT ?? '0'}`,
      PEBBLE_IMAGE,
      '-config', '/test/config/swarmcast-pebble.json',
    );
    docker('cp', path.join(tmp, 'pebble-config.json'), `${container}:/test/config/swarmcast-pebble.json`);
    docker('start', container);

    docker('cp', `${container}:/test/certs/pebble.minica.pem`, path.join(tmp, 'minica.pem'));
    docker('cp', `${container}:/etc/hosts`, path.join(tmp, 'hosts'));
    const hosts = fs.readFileSync(path.join(tmp, 'hosts'), 'utf8');
    const gw = /^(\d+\.\d+\.\d+\.\d+)\s+host\.docker\.internal\b/m.exec(hosts)?.[1];
    if (!gw) throw new Error(`host.docker.internal not found in the container's /etc/hosts:\n${hosts}`);
    ip = gw;

    const published = docker('port', container, '14000/tcp').split('\n')[0]!; // "127.0.0.1:55001"
    directoryUrl = `https://127.0.0.1:${published.split(':').pop()}/dir`;
    fetchImpl = fetchTrusting(fs.readFileSync(path.join(tmp, 'minica.pem'), 'utf8'));

    const deadline = Date.now() + 30_000;
    for (;;) {
      let lastError: string;
      try {
        // Pebble rejects requests without a User-Agent (RFC 8555 section 6.1).
        const res = await fetchImpl(directoryUrl, { headers: { 'User-Agent': 'swarmcast-test' } });
        if (res.ok) break;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = (err as Error).message; // not up yet
      }
      if (Date.now() > deadline) throw new Error(`Pebble did not answer at ${directoryUrl} (${lastError}):\n${docker('logs', container)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(() => {
    if (container) {
      try {
        execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
  });

  async function expectValidIpCert(cert: IssuedCert) {
    expect(cert.source).toBe('letsencrypt');
    const chain = splitPem(cert.certPem);
    expect(chain.length).toBeGreaterThanOrEqual(2); // leaf + Pebble intermediate
    const leaf = new x509.X509Certificate(chain[0]!);
    const san = leaf.getExtension(x509.SubjectAlternativeNameExtension)!;
    expect(san.names.toJSON()).toEqual([{ type: 'ip', value: ip }]);
    expect(cert.expiresAt).toBe(leaf.notAfter.getTime());
    // The shortlived profile was requested and honored (6 days instead of 90).
    const lifetime = (leaf.notAfter.getTime() - leaf.notBefore.getTime()) / 1000;
    expect(Math.abs(lifetime - SHORTLIVED_SECONDS)).toBeLessThan(3600);
    // Leaf is signed by the next certificate in the chain, and the private key matches.
    expect(await leaf.verify({ publicKey: new x509.X509Certificate(chain[1]!), signatureOnly: true })).toBe(true);
    expect(new crypto.X509Certificate(chain[0]!).checkPrivateKey(crypto.createPrivateKey(cert.keyPem))).toBe(true);
  }

  it('issues an IP certificate with http-01', async () => {
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, {
      fetch: fetchImpl,
      preferredChallenge: 'http-01',
      challengeHttpPort: httpPort,
      listenHost: LISTEN_HOST,
      pollTimeoutMs: 60_000,
    });
    await expectValidIpCert(await issuer.issue(ip, { mapper: null, internalHost: '127.0.0.1' }));
  });

  it('issues an IP certificate with tls-alpn-01 (acme-tls/1, reverse-DNS SNI, acmeIdentifier extension)', async () => {
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, {
      fetch: fetchImpl,
      preferredChallenge: 'tls-alpn-01',
      challengeTlsPort: tlsPort,
      listenHost: LISTEN_HOST,
      pollTimeoutMs: 60_000,
    });
    await expectValidIpCert(await issuer.issue(ip, { mapper: null, internalHost: '127.0.0.1' }));
  });

  it('falls back to tls-alpn-01 with a new order when http-01 validation fails', async () => {
    const wrongPort = await freePort(); // Pebble connects to httpPort, where nothing listens.
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, {
      fetch: fetchImpl,
      preferredChallenge: ['http-01', 'tls-alpn-01'],
      challengeHttpPort: wrongPort,
      challengeTlsPort: tlsPort,
      listenHost: LISTEN_HOST,
      pollTimeoutMs: 60_000,
    });
    await expectValidIpCert(await issuer.issue(ip, { mapper: null, internalHost: '127.0.0.1' }));
  });

  it('maps the validation port through the PortMapper only during validation, then removes it', async () => {
    // A fake router: "mapping external port 80" starts a TCP forwarder on Pebble's httpPort
    // that leads to the issuer's random local responder port.
    const events: string[] = [];
    let proxy: net.Server | null = null;
    const mapper: PortMapper = {
      kind: 'upnp',
      id: 'fake',
      externalIp: async () => ip,
      hasMapping: async () => proxy !== null,
      map: async (externalPort, internalPort, internalHost) => {
        events.push(`map ${externalPort}`);
        expect(externalPort).toBe(80);
        proxy = net.createServer((client) => {
          const upstream = net.connect(internalPort, internalHost);
          client.pipe(upstream).pipe(client);
          client.on('error', () => upstream.destroy());
          upstream.on('error', () => client.destroy());
        });
        await new Promise<void>((r) => proxy!.listen(httpPort, LISTEN_HOST, () => r()));
      },
      unmap: async (externalPort) => {
        events.push(`unmap ${externalPort}`);
        await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
        proxy = null;
      },
    };
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, { fetch: fetchImpl, preferredChallenge: 'http-01', listenHost: LISTEN_HOST, pollTimeoutMs: 60_000 });
    await expectValidIpCert(await issuer.issue(ip, { mapper, internalHost: '127.0.0.1' }));
    expect(events).toEqual(['map 80', 'unmap 80']);
    expect(proxy).toBeNull();
  });

  it('reports the ACME problem detail when validation fails', async () => {
    const wrongPort = await freePort();
    const issuer = new LetsEncryptIpIssuer(log, directoryUrl, {
      fetch: fetchImpl,
      preferredChallenge: 'http-01',
      challengeHttpPort: wrongPort,
      listenHost: LISTEN_HOST,
      pollTimeoutMs: 60_000,
    });
    await expect(issuer.issue(ip, { mapper: null, internalHost: '127.0.0.1' })).rejects.toThrow(/http-01: authorization invalid: connection: /);
  });
});
