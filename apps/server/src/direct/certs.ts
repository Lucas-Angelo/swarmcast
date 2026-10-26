import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import * as x509 from '@peculiar/x509';
import type { Logger } from '../core/logger.js';
import type { PortMapper } from './mapper.js';
import { ACME_TLS_ALPN, AcmeClient, createAlpnCertificate, reverseDnsName, type ChallengeType, type FetchLike, type PendingChallenge } from './acme.js';

export interface IssuedCert {
  keyPem: string;
  certPem: string;
  source: 'letsencrypt' | 'self-signed';
  expiresAt: number;
}

export interface CertificateIssuer {
  issue(ip: string, ctx: { mapper: PortMapper | null; internalHost: string }): Promise<IssuedCert>;
}

export const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export interface LetsEncryptIpIssuerOptions {
  /** fetch override (tests: trust a private CA such as Pebble's). */
  fetch?: FetchLike;
  /** Challenge type(s) to try, in order. Default ['http-01', 'tls-alpn-01']. */
  preferredChallenge?: ChallengeType | ChallengeType[];
  /** Serve http-01 on this local port instead of mapping router port 80 (tests). */
  challengeHttpPort?: number;
  /** Serve tls-alpn-01 on this local port instead of mapping router port 443 (tests). */
  challengeTlsPort?: number;
  /** Address the temporary responder binds to. Default 0.0.0.0. */
  listenHost?: string;
  /** Max wait for validation / issuance. Default 120 s. */
  pollTimeoutMs?: number;
}

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/**
 * Let's Encrypt certificate for a bare IP address ("shortlived" profile, ~6 days).
 * IP certificates can only be validated with http-01 (port 80) or tls-alpn-01 (port 443),
 * so port 80 (or 443) is mapped on the router just for the few seconds of validation and
 * removed right after. A certificate for an IP is valid on any port, so the stream itself
 * uses the random high port. The account key and certificate live only in memory.
 */
export class LetsEncryptIpIssuer implements CertificateIssuer {
  constructor(
    private readonly log: Logger,
    private readonly directoryUrl = LE_PRODUCTION,
    private readonly opts: LetsEncryptIpIssuerOptions = {},
  ) {}

  async issue(ip: string, ctx: { mapper: PortMapper | null; internalHost: string }): Promise<IssuedCert> {
    const pref = this.opts.preferredChallenge;
    const types: ChallengeType[] = Array.isArray(pref) ? pref : pref ? [pref] : ['http-01', 'tls-alpn-01'];
    const localPort = (t: ChallengeType) => (t === 'http-01' ? this.opts.challengeHttpPort : this.opts.challengeTlsPort);
    if (!ctx.mapper && !types.some((t) => localPort(t) !== undefined)) {
      throw new Error('Automatic certificates need automatic port opening on the router.');
    }
    const client = new AcmeClient({ directoryUrl: this.directoryUrl, fetch: this.opts.fetch, pollTimeoutMs: this.opts.pollTimeoutMs });
    const cert = await client.obtainIpCertificate({
      ip,
      profile: 'shortlived',
      challengeTypes: types,
      solve: (ch) =>
        this.serveChallenge(ch, ctx.mapper, ctx.internalHost, localPort(ch.type)).catch((err: Error) => {
          this.log.warn({ type: ch.type, err: err.message }, 'could not prepare the ACME challenge');
          throw err;
        }),
    });
    return { keyPem: cert.keyPem, certPem: cert.certPem, source: 'letsencrypt', expiresAt: cert.notAfter.getTime() };
  }

  /** Start a responder (plus the temporary router mapping); resolves with its teardown. */
  private async serveChallenge(
    ch: PendingChallenge,
    mapper: PortMapper | null,
    internalHost: string,
    localPort: number | undefined,
  ): Promise<() => Promise<void>> {
    let server: http.Server | tls.Server;
    if (ch.type === 'http-01') {
      const path = `/.well-known/acme-challenge/${ch.token}`;
      server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === path) res.writeHead(200, { 'Content-Type': 'text/plain' }).end(ch.keyAuthorization);
        else res.writeHead(404).end();
      });
    } else {
      const { keyPem, certPem } = await createAlpnCertificate(ch.identifier, ch.keyAuthorization);
      const context = tls.createSecureContext({ key: keyPem, cert: certPem });
      const sni = reverseDnsName(ch.identifier);
      server = tls.createServer(
        {
          key: keyPem,
          cert: certPem,
          ALPNProtocols: [ACME_TLS_ALPN],
          // The CA sends the reverse-DNS name of the IP as SNI (RFC 8738), or no SNI at all.
          SNICallback: (name, cb) => (name.toLowerCase() === sni ? cb(null, context) : cb(new Error(`unexpected SNI ${name}`))),
        },
        (s) => s.end(),
      );
      server.on('tlsClientError', () => {});
    }
    const close = () => new Promise<void>((r) => server.close(() => r()));
    const port = await listen(server, localPort ?? 0, this.opts.listenHost ?? '0.0.0.0');
    if (localPort !== undefined) return close;
    if (!mapper) {
      await close();
      throw new Error('Automatic certificates need automatic port opening on the router.');
    }
    const externalPort = ch.type === 'http-01' ? 80 : 443;
    try {
      await mapper.map(externalPort, port, internalHost, 'SwarmCast ACME (temporary)', 300);
    } catch (err) {
      await close();
      throw err;
    }
    return async () => {
      await mapper.unmap(externalPort, port).catch((e) => this.log.warn({ err: (e as Error).message }, 'could not remove ACME port mapping'));
      await close();
    };
  }
}

/**
 * Last resort: a self-signed certificate. Browsers show a warning page the viewer must
 * click through; after that the page is still a secure context, so WebCrypto works.
 */
export class SelfSignedIssuer implements CertificateIssuer {
  async issue(ip: string): Promise<IssuedCert> {
    x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
    const keys = (await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: crypto.randomBytes(8).toString('hex'),
      name: 'CN=SwarmCast direct mode',
      notBefore,
      notAfter,
      keys,
      signingAlgorithm: alg,
      extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: ip }])],
    });
    const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey as unknown as crypto.webcrypto.CryptoKey);
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    return { keyPem, certPem: cert.toString('pem'), source: 'self-signed', expiresAt: notAfter.getTime() };
  }
}

/** Try Let's Encrypt first, fall back to self-signed. */
export class FallbackIssuer implements CertificateIssuer {
  constructor(
    private readonly primary: CertificateIssuer,
    private readonly fallback: CertificateIssuer,
    private readonly log: Logger,
  ) {}
  async issue(ip: string, ctx: { mapper: PortMapper | null; internalHost: string }): Promise<IssuedCert> {
    try {
      return await this.primary.issue(ip, ctx);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "Let's Encrypt certificate failed, using a self-signed certificate");
      return this.fallback.issue(ip, ctx);
    }
  }
}
