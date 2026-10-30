import crypto from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import {
  ACME_IDENTIFIER_OID,
  AcmeClient,
  createAlpnCertificate,
  createIpCsr,
  derOctetString,
  jwkThumbprint,
  keyAuthorization,
  publicJwk,
  reverseDnsName,
  signJws,
  type FetchLike,
} from '../../src/direct/acme.js';

// The ACME client (RFC 8555) for IP-address certificates (RFC 8738) with tls-alpn-01 (RFC 8737).
// The CA is a fake behind the injected `fetch`: no network.

const fromB64url = (s: string) => Buffer.from(s, 'base64url');
/** The OID of the Subject Alternative Name extension (Pkcs10CertificateRequest.getExtension takes an OID). */
const SAN_OID = '2.5.29.17';

describe('acme: JWK thumbprint and key authorization', () => {
  it('matches the RFC 7638 section 3.1 example', () => {
    // Arrange
    const jwk = {
      kty: 'RSA',
      n:
        '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMs' +
        'tn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajr' +
        'n1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
      alg: 'RS256',
      kid: '2011-04-29',
    };
    // Act
    const thumbprint = jwkThumbprint(jwk);
    // Assert
    expect(thumbprint).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('hashes only the required EC members in lexicographic order', () => {
    // Arrange
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicJwk(publicKey);
    const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = crypto.createHash('sha256').update(canonical).digest('base64url');
    // Act
    const thumbprint = jwkThumbprint({ ...jwk, kid: 'ignored', use: 'sig' } as crypto.JsonWebKey);
    const keyAuth = keyAuthorization('tok-EN_123', jwk);
    // Assert
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(thumbprint).toBe(expected);
    expect(keyAuth).toBe(`tok-EN_123.${expected}`);
  });
});

describe('acme: JWS (ES256, flattened)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(publicKey);

  /** The ES256 signature is raw r||s (64 bytes, as JWS wants it), not DER. */
  function rawSignature(jws: { signature: string }): Buffer {
    return fromB64url(jws.signature);
  }

  function verifies(jws: { protected: string; payload: string; signature: string }): boolean {
    return crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, rawSignature(jws));
  }

  it('embeds the jwk (newAccount) and signs protected.payload', () => {
    // Act
    const jws = signJws(privateKey, { jwk, url: 'https://ca/new-acct', nonce: 'n1' }, { termsOfServiceAgreed: true });
    // Assert
    expect(JSON.parse(fromB64url(jws.protected).toString())).toEqual({ alg: 'ES256', nonce: 'n1', url: 'https://ca/new-acct', jwk });
    expect(JSON.parse(fromB64url(jws.payload).toString())).toEqual({ termsOfServiceAgreed: true });
    expect(rawSignature(jws)).toHaveLength(64);
    expect(verifies(jws)).toBe(true);
  });

  it('a signature does not cover another payload', () => {
    // Arrange
    const jws = signJws(privateKey, { jwk, url: 'https://ca/new-acct', nonce: 'n1' }, { termsOfServiceAgreed: true });
    // Act
    const tampered = verifies({ ...jws, payload: Buffer.from('{}').toString('base64url') });
    // Assert
    expect(tampered).toBe(false);
  });

  it('uses kid instead of jwk afterwards, and an empty payload for POST-as-GET', () => {
    // Act
    const jws = signJws(privateKey, { kid: 'https://ca/acct/1', jwk, url: 'https://ca/order/1', nonce: 'n2' }, null);
    // Assert
    const header = JSON.parse(fromB64url(jws.protected).toString());
    expect(header).toEqual({ alg: 'ES256', nonce: 'n2', url: 'https://ca/order/1', kid: 'https://ca/acct/1' });
    expect(header.jwk).toBeUndefined();
    expect(jws.payload).toBe('');
    expect(rawSignature(jws)).toHaveLength(64);
    expect(verifies(jws)).toBe(true);
  });

  it('POST {} is distinct from POST-as-GET', () => {
    // Act
    const jws = signJws(privateKey, { kid: 'k', url: 'u', nonce: 'n' }, {});
    // Assert
    expect(fromB64url(jws.payload).toString()).toBe('{}');
  });
});

describe('acme: CSR', () => {
  it.each(['203.0.113.7', '2001:db8::5'])('carries only an iPAddress SAN for %s and no subject CN', async (ip) => {
    // Act
    const { keyPem, csrDer } = await createIpCsr(ip);
    // Assert
    const csr = new x509.Pkcs10CertificateRequest(new Uint8Array(csrDer));
    expect(csr.subject).toBe('');
    const raw = csr.getExtension(SAN_OID);
    expect(raw).not.toBeNull();
    expect(new x509.SubjectAlternativeNameExtension(raw!.rawData).names.toJSON()).toEqual([{ type: 'ip', value: ip }]);
    expect(csr.extensions.map((e) => e.type)).toEqual([SAN_OID]);
    expect(await csr.verify()).toBe(true);
    const keyOfPem = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ format: 'der', type: 'spki' });
    expect(Buffer.from(csr.publicKey.rawData).equals(keyOfPem)).toBe(true);
  });

  it('rejects non-IP identifiers', async () => {
    // Act
    const csr = createIpCsr('example.com');
    // Assert
    await expect(csr).rejects.toThrow(/not an IP/);
  });
});

describe('acme: tls-alpn-01 certificate', () => {
  it('has the critical acmeIdentifier extension with SHA-256(keyAuthorization), an IP SAN, and makes a TLS identity with its key', async () => {
    // Arrange
    const keyAuth = 'evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.9jg46WB3rR_AHD-EBXdN7cBkH1WOu0tA3M9fm21mqTI';
    // Act
    const { keyPem, certPem } = await createAlpnCertificate('198.51.100.4', keyAuth);
    // Assert
    const cert = new x509.X509Certificate(certPem);
    const ext = cert.getExtension(ACME_IDENTIFIER_OID);
    expect(ext).not.toBeNull();
    expect(ext!.critical).toBe(true);
    const digest = crypto.createHash('sha256').update(keyAuth).digest();
    expect(Buffer.from(ext!.value)).toEqual(Buffer.concat([Buffer.from([0x04, 0x20]), digest]));
    expect(cert.getExtension(x509.SubjectAlternativeNameExtension)!.names.toJSON()).toEqual([{ type: 'ip', value: '198.51.100.4' }]);
    expect(await cert.verify({ signatureOnly: true })).toBe(true);
    expect(new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem))).toBe(true);
  });

  it.each([
    [3, [4, 3]],
    [200, [4, 0x81, 200]],
    [300, [4, 0x82, 1, 44]],
  ])('DER OCTET STRING of %i bytes starts with %j (long-form lengths when needed)', (length, head) => {
    // Act
    const der = Buffer.from(derOctetString(new Uint8Array(length)));
    // Assert
    expect(der.subarray(0, head.length)).toEqual(Buffer.from(head));
    expect(der.subarray(head.length)).toEqual(Buffer.alloc(length));
  });

  it.each([
    ['203.0.113.7', '7.113.0.203.in-addr.arpa'],
    ['2001:db8::567:89ab', 'b.a.9.8.7.6.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa'],
  ])('computes the reverse-DNS SNI name of %s (RFC 8738)', (ip, name) => {
    // Act
    const sni = reverseDnsName(ip);
    // Assert
    expect(sni).toBe(name);
  });
});

describe('acme: nonce handling and errors (fake CA)', () => {
  type Call = { method: string; url: string; nonce?: string; payload?: unknown };

  /**
   * A CA behind `fetch`: the directory, a HEAD newNonce ("head-nonce"), and newAccount/newOrder
   * answered by the handlers (`n`: the how-many-th newAccount call). Records every call.
   */
  function fakeCa(handlers: { profiles?: boolean; newAccount: (n: number) => Response; newOrder?: (payload: unknown) => Response }) {
    const calls: Call[] = [];
    let accountCalls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET';
      let nonce: string | undefined;
      let payload: unknown;
      if (method === 'POST') {
        const jws = JSON.parse(String(init!.body)) as { protected: string; payload: string };
        nonce = JSON.parse(fromB64url(jws.protected).toString()).nonce;
        payload = jws.payload ? JSON.parse(fromB64url(jws.payload).toString()) : null;
      }
      calls.push({ method, url, nonce, payload });
      if (url === 'https://ca/dir') {
        const meta = handlers.profiles ? { profiles: { classic: 'x', shortlived: 'y' } } : {};
        return Response.json({ newNonce: 'https://ca/nonce', newAccount: 'https://ca/acct', newOrder: 'https://ca/order', meta });
      }
      if (url === 'https://ca/nonce') return new Response(null, { status: 200, headers: { 'Replay-Nonce': 'head-nonce' } });
      if (url === 'https://ca/acct') return handlers.newAccount(++accountCalls);
      if (url === 'https://ca/order' && handlers.newOrder) return handlers.newOrder(payload);
      return new Response('not found', { status: 404 });
    };
    const posts = (): Call[] => calls.filter((c) => c.method === 'POST');
    return { calls, posts, client: new AcmeClient({ directoryUrl: 'https://ca/dir', fetch: fetchImpl }) };
  }

  /** An ACME problem document (RFC 8555 section 6.7) carrying the next nonce. */
  const problem = (type: string, detail: string, nonce: string, status = 400) =>
    new Response(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail, status }), {
      status,
      headers: { 'Content-Type': 'application/problem+json', 'Replay-Nonce': nonce },
    });
  const okAccount = () => new Response('{"status":"valid"}', { status: 201, headers: { 'Content-Type': 'application/json', Location: 'https://ca/acct/1', 'Replay-Nonce': 'acct-nonce' } });
  const solve = async () => async () => {};
  const IP = '203.0.113.7';

  it('retries once on badNonce with the nonce from the error, then surfaces the problem detail', async () => {
    // Arrange
    const ca = fakeCa({ newAccount: (n) => (n === 1 ? problem('badNonce', 'stale', 'fresh-nonce') : problem('unauthorized', 'account creation is disabled', 'x', 403)) });
    // Act
    const obtained = ca.client.obtainIpCertificate({ ip: IP, solve });
    // Assert
    await expect(obtained).rejects.toThrow(/HTTP 403: unauthorized: account creation is disabled/);
    expect(ca.posts().map((c) => c.nonce)).toEqual(['head-nonce', 'fresh-nonce']);
    expect(ca.calls.filter((c) => c.method === 'HEAD')).toHaveLength(1);
  });

  it('does not retry badNonce forever', async () => {
    // Arrange
    const ca = fakeCa({ newAccount: (n) => problem('badNonce', `bad ${n}`, `nonce-${n}`) });
    // Act
    const obtained = ca.client.obtainIpCertificate({ ip: IP, solve });
    // Assert
    await expect(obtained).rejects.toThrow(/badNonce: bad 2/);
  });

  it.each([
    [false, { identifiers: [{ type: 'ip', value: IP }] }],
    [true, { identifiers: [{ type: 'ip', value: IP }], profile: 'shortlived' }],
  ])('profiles advertised: %s; the order asks for %j and reuses Replay-Nonce', async (profiles, order) => {
    // Arrange
    let orderPayload: unknown;
    const ca = fakeCa({
      profiles,
      newAccount: okAccount,
      newOrder: (p) => {
        orderPayload = p;
        return problem('rejectedIdentifier', 'no IPs here', 'y');
      },
    });
    // Act
    const obtained = ca.client.obtainIpCertificate({ ip: IP, solve });
    // Assert
    await expect(obtained).rejects.toThrow(/rejectedIdentifier: no IPs here/);
    expect(orderPayload).toEqual(order);
    expect(ca.posts().map((c) => c.nonce)).toEqual(['head-nonce', 'acct-nonce']);
  });
});
