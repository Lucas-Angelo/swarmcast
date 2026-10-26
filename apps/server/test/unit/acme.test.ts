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

const fromB64url = (s: string) => Buffer.from(s, 'base64url');

describe('acme: JWK thumbprint and key authorization', () => {
  it('matches the RFC 7638 section 3.1 example', () => {
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
    expect(jwkThumbprint(jwk)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('hashes only the required EC members in lexicographic order', () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicJwk(publicKey);
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = crypto.createHash('sha256').update(canonical).digest('base64url');
    expect(jwkThumbprint({ ...jwk, kid: 'ignored', use: 'sig' } as crypto.JsonWebKey)).toBe(expected);
    expect(keyAuthorization('tok-EN_123', jwk)).toBe(`tok-EN_123.${expected}`);
  });
});

describe('acme: JWS (ES256, flattened)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(publicKey);

  function verify(jws: { protected: string; payload: string; signature: string }): boolean {
    const sig = fromB64url(jws.signature);
    expect(sig.length).toBe(64); // raw r||s, not DER
    return crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  }

  it('embeds the jwk (newAccount) and signs protected.payload', () => {
    const jws = signJws(privateKey, { jwk, url: 'https://ca/new-acct', nonce: 'n1' }, { termsOfServiceAgreed: true });
    expect(JSON.parse(fromB64url(jws.protected).toString())).toEqual({ alg: 'ES256', nonce: 'n1', url: 'https://ca/new-acct', jwk });
    expect(JSON.parse(fromB64url(jws.payload).toString())).toEqual({ termsOfServiceAgreed: true });
    expect(verify(jws)).toBe(true);
    // Tampering is detected.
    expect(verify({ ...jws, payload: Buffer.from('{}').toString('base64url') })).toBe(false);
  });

  it('uses kid instead of jwk afterwards, and an empty payload for POST-as-GET', () => {
    const jws = signJws(privateKey, { kid: 'https://ca/acct/1', jwk, url: 'https://ca/order/1', nonce: 'n2' }, null);
    const header = JSON.parse(fromB64url(jws.protected).toString());
    expect(header).toEqual({ alg: 'ES256', nonce: 'n2', url: 'https://ca/order/1', kid: 'https://ca/acct/1' });
    expect(header.jwk).toBeUndefined();
    expect(jws.payload).toBe('');
    expect(verify(jws)).toBe(true);
  });

  it('POST {} is distinct from POST-as-GET', () => {
    const jws = signJws(privateKey, { kid: 'k', url: 'u', nonce: 'n' }, {});
    expect(fromB64url(jws.payload).toString()).toBe('{}');
  });
});

describe('acme: CSR', () => {
  for (const ip of ['203.0.113.7', '2001:db8::5']) {
    it(`carries only an iPAddress SAN for ${ip} and no subject CN`, async () => {
      const { keyPem, csrDer } = await createIpCsr(ip);
      const csr = new x509.Pkcs10CertificateRequest(new Uint8Array(csrDer));
      expect(csr.subject).toBe('');
      // Pkcs10CertificateRequest.getExtension() takes an OID and returns the generic Extension.
      const raw = csr.getExtension('2.5.29.17');
      expect(raw).not.toBeNull();
      const san = new x509.SubjectAlternativeNameExtension(raw!.rawData);
      expect(san.names.toJSON()).toEqual([{ type: 'ip', value: ip }]);
      expect(csr.extensions.map((e) => e.type)).toEqual(['2.5.29.17']);
      expect(await csr.verify()).toBe(true);
      // The returned private key matches the CSR's public key.
      const pub = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ format: 'der', type: 'spki' });
      expect(Buffer.from(csr.publicKey.rawData).equals(pub)).toBe(true);
    });
  }

  it('rejects non-IP identifiers', async () => {
    await expect(createIpCsr('example.com')).rejects.toThrow(/not an IP/);
  });
});

describe('acme: tls-alpn-01 certificate', () => {
  it('has the critical acmeIdentifier extension with SHA-256(keyAuthorization) and an IP SAN', async () => {
    const keyAuth = 'evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.9jg46WB3rR_AHD-EBXdN7cBkH1WOu0tA3M9fm21mqTI';
    const { keyPem, certPem } = await createAlpnCertificate('198.51.100.4', keyAuth);
    const cert = new x509.X509Certificate(certPem);
    const ext = cert.getExtension(ACME_IDENTIFIER_OID);
    expect(ext).not.toBeNull();
    expect(ext!.critical).toBe(true);
    const digest = crypto.createHash('sha256').update(keyAuth).digest();
    expect(Buffer.from(ext!.value)).toEqual(Buffer.concat([Buffer.from([0x04, 0x20]), digest]));
    expect(cert.getExtension(x509.SubjectAlternativeNameExtension)!.names.toJSON()).toEqual([{ type: 'ip', value: '198.51.100.4' }]);
    expect(await cert.verify({ signatureOnly: true })).toBe(true);
    // Node accepts the pair as a TLS identity.
    expect(new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem))).toBe(true);
  });

  it('DER OCTET STRING uses long-form lengths when needed', () => {
    expect(Buffer.from(derOctetString(new Uint8Array(3)))).toEqual(Buffer.from([4, 3, 0, 0, 0]));
    expect(Buffer.from(derOctetString(new Uint8Array(200))).subarray(0, 3)).toEqual(Buffer.from([4, 0x81, 200]));
    expect(Buffer.from(derOctetString(new Uint8Array(300))).subarray(0, 4)).toEqual(Buffer.from([4, 0x82, 1, 44]));
  });

  it('computes the reverse-DNS SNI names (RFC 8738)', () => {
    expect(reverseDnsName('203.0.113.7')).toBe('7.113.0.203.in-addr.arpa');
    expect(reverseDnsName('2001:db8::567:89ab')).toBe('b.a.9.8.7.6.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa');
  });
});

describe('acme: nonce handling and errors (fake CA)', () => {
  type Call = { method: string; url: string; nonce?: string; payload?: unknown };

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
    return { calls, fetchImpl };
  }

  const problem = (type: string, detail: string, nonce: string, status = 400) =>
    new Response(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail, status }), {
      status,
      headers: { 'Content-Type': 'application/problem+json', 'Replay-Nonce': nonce },
    });
  const okAccount = () => new Response('{"status":"valid"}', { status: 201, headers: { 'Content-Type': 'application/json', Location: 'https://ca/acct/1', 'Replay-Nonce': 'acct-nonce' } });
  const solve = async () => async () => {};

  it('retries once on badNonce with the nonce from the error, then surfaces the problem detail', async () => {
    const ca = fakeCa({
      newAccount: (n) => (n === 1 ? problem('badNonce', 'stale', 'fresh-nonce') : problem('unauthorized', 'account creation is disabled', 'x', 403)),
    });
    const client = new AcmeClient({ directoryUrl: 'https://ca/dir', fetch: ca.fetchImpl });
    await expect(client.obtainIpCertificate({ ip: '203.0.113.7', solve })).rejects.toThrow(/HTTP 403: unauthorized: account creation is disabled/);
    const posts = ca.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.nonce)).toEqual(['head-nonce', 'fresh-nonce']);
    expect(ca.calls.filter((c) => c.method === 'HEAD')).toHaveLength(1);
  });

  it('does not retry badNonce forever', async () => {
    const ca = fakeCa({ newAccount: (n) => problem('badNonce', `bad ${n}`, `nonce-${n}`) });
    const client = new AcmeClient({ directoryUrl: 'https://ca/dir', fetch: ca.fetchImpl });
    await expect(client.obtainIpCertificate({ ip: '203.0.113.7', solve })).rejects.toThrow(/badNonce: bad 2/);
  });

  it('sends the profile only when the directory advertises it, and reuses Replay-Nonce', async () => {
    for (const profiles of [false, true]) {
      let orderPayload: unknown;
      const ca = fakeCa({
        profiles,
        newAccount: okAccount,
        newOrder: (p) => {
          orderPayload = p;
          return problem('rejectedIdentifier', 'no IPs here', 'y');
        },
      });
      const client = new AcmeClient({ directoryUrl: 'https://ca/dir', fetch: ca.fetchImpl });
      await expect(client.obtainIpCertificate({ ip: '203.0.113.7', solve })).rejects.toThrow(/rejectedIdentifier: no IPs here/);
      const ids = [{ type: 'ip', value: '203.0.113.7' }];
      expect(orderPayload).toEqual(profiles ? { identifiers: ids, profile: 'shortlived' } : { identifiers: ids });
      const posts = ca.calls.filter((c) => c.method === 'POST');
      expect(posts.map((c) => c.nonce)).toEqual(['head-nonce', 'acct-nonce']);
    }
  });
});
