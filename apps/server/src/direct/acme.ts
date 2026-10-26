/**
 * Minimal ACME (RFC 8555) client for one job: an IP-address certificate (RFC 8738),
 * validated with http-01 or tls-alpn-01 (RFC 8737), optionally with an ACME profile
 * (draft-ietf-acme-profiles, e.g. Let's Encrypt "shortlived").
 *
 * Dependencies: node:crypto, global fetch and @peculiar/x509 (CSR and certificates).
 * The account key is an in-memory ECDSA P-256 key created per client and never persisted.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import * as x509 from '@peculiar/x509';

export type ChallengeType = 'http-01' | 'tls-alpn-01';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** OID of the id-pe-acmeIdentifier extension (RFC 8737 section 3). */
export const ACME_IDENTIFIER_OID = '1.3.6.1.5.5.7.1.31';
export const ACME_TLS_ALPN = 'acme-tls/1';
/** RFC 8555 section 6.1: clients must send a User-Agent. */
const USER_AGENT = 'SwarmCast-ACME/1 (node)';

const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const webcrypto = globalThis.crypto;

// ---------------------------------------------------------------------------
// Encoding helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function b64url(data: Buffer | Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) for EC, RSA and OKP public keys. */
export function jwkThumbprint(jwk: crypto.JsonWebKey): string {
  let members: Record<string, unknown>;
  if (jwk.kty === 'EC') members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  else if (jwk.kty === 'RSA') members = { e: jwk.e, kty: jwk.kty, n: jwk.n };
  else if (jwk.kty === 'OKP') members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  else throw new Error(`unsupported JWK key type ${String(jwk.kty)}`);
  // Keys are already in lexicographic order; JSON.stringify emits no whitespace.
  return b64url(crypto.createHash('sha256').update(JSON.stringify(members)).digest());
}

/** RFC 8555 section 8.1: token || '.' || base64url(JWK thumbprint). */
export function keyAuthorization(token: string, accountJwk: crypto.JsonWebKey): string {
  return `${token}.${jwkThumbprint(accountJwk)}`;
}

/** The public JWK (EC members only) of an ECDSA P-256 key. */
export function publicJwk(key: crypto.KeyObject): crypto.JsonWebKey {
  const { kty, crv, x, y } = key.export({ format: 'jwk' });
  return { kty, crv, x, y };
}

export interface JwsHeaderKey {
  /** Embedded public key (newAccount, revocation by key). */
  jwk?: crypto.JsonWebKey;
  /** Account URL (every other request). */
  kid?: string;
}

export interface FlattenedJws {
  protected: string;
  payload: string;
  signature: string;
}

/**
 * Flattened JWS signed with ES256 (RFC 7518 section 3.4: raw r||s, not DER).
 * `payload === null` produces a POST-as-GET (empty payload).
 */
export function signJws(privateKey: crypto.KeyObject, header: JwsHeaderKey & { url: string; nonce: string }, payload: unknown): FlattenedJws {
  const prot: Record<string, unknown> = { alg: 'ES256', nonce: header.nonce, url: header.url };
  if (header.kid) prot.kid = header.kid;
  else if (header.jwk) prot.jwk = header.jwk;
  else throw new Error('JWS needs either jwk or kid');
  const protectedB64 = b64url(JSON.stringify(prot));
  const payloadB64 = payload === null ? '' : b64url(JSON.stringify(payload));
  const signature = crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { protected: protectedB64, payload: payloadB64, signature: b64url(signature) };
}

function toPem(label: string, der: ArrayBuffer | Uint8Array): string {
  const b64 = Buffer.from(der instanceof ArrayBuffer ? new Uint8Array(der) : der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

async function newP256(): Promise<{ keys: CryptoKeyPair; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(EC_ALG, true, ['sign', 'verify']);
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { keys, keyPem: toPem('PRIVATE KEY', pkcs8) };
}

/** A fresh P-256 key and a DER CSR whose only name is an iPAddress SAN (no subject CN). */
export async function createIpCsr(ip: string): Promise<{ keyPem: string; csrDer: Buffer }> {
  if (!net.isIP(ip)) throw new Error(`not an IP address: ${ip}`);
  const { keys, keyPem } = await newP256();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create(
    { keys, signingAlgorithm: EC_ALG, extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: ip }])] },
    webcrypto,
  );
  return { keyPem, csrDer: Buffer.from(csr.rawData) };
}

/** DER encoding of an OCTET STRING holding `content` (short or long definite length). */
export function derOctetString(content: Uint8Array): Uint8Array<ArrayBuffer> {
  const len = content.length;
  if (len > 0xffff) throw new Error('OCTET STRING too long');
  let header: number[];
  if (len < 0x80) header = [0x04, len];
  else if (len < 0x100) header = [0x04, 0x81, len];
  else header = [0x04, 0x82, len >> 8, len & 0xff];
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(content, header.length);
  return out;
}

/** RFC 8737 tls-alpn-01 validation certificate for an IP identifier (RFC 8738 section 6). */
export async function createAlpnCertificate(ip: string, keyAuth: string): Promise<{ keyPem: string; certPem: string }> {
  if (!net.isIP(ip)) throw new Error(`not an IP address: ${ip}`);
  const { keys, keyPem } = await newP256();
  const digest = crypto.createHash('sha256').update(keyAuth).digest();
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: `01${crypto.randomBytes(8).toString('hex')}`,
      name: 'CN=ACME tls-alpn-01 challenge',
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 24 * 3600_000),
      keys,
      signingAlgorithm: EC_ALG,
      extensions: [
        new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: ip }]),
        new x509.Extension(ACME_IDENTIFIER_OID, true, derOctetString(digest)),
      ],
    },
    webcrypto,
  );
  return { keyPem, certPem: cert.toString('pem') };
}

function expandIPv6(ip: string): string[] {
  let addr = ip.toLowerCase().split('%')[0]!;
  // Embedded IPv4 (::ffff:1.2.3.4) -> two hextets.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4[1]!.split('.').map(Number);
    addr = addr.slice(0, -v4[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0'));
}

/** Reverse-DNS name of an IP (RFC 8738: the SNI sent during tls-alpn-01 for IP identifiers). */
export function reverseDnsName(ip: string): string {
  if (net.isIPv4(ip)) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  if (net.isIPv6(ip)) return `${expandIPv6(ip).join('').split('').reverse().join('.')}.ip6.arpa`;
  throw new Error(`not an IP address: ${ip}`);
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export interface AcmeProblem {
  type?: string;
  detail?: string;
  status?: number;
  subproblems?: AcmeProblem[];
}

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly problem: AcmeProblem | null = null,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'AcmeError';
  }
}

function describeProblem(p: AcmeProblem | null | undefined): string {
  if (!p) return 'no details';
  const type = p.type?.replace('urn:ietf:params:acme:error:', '') ?? 'error';
  const sub = p.subproblems?.length ? ` (${p.subproblems.map((s) => describeProblem(s)).join('; ')})` : '';
  return `${type}: ${p.detail ?? 'no detail'}${sub}`;
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  meta?: { termsOfService?: string; profiles?: Record<string, string> };
}

interface AcmeChallenge {
  type: string;
  url: string;
  status: string;
  token?: string;
  error?: AcmeProblem;
}

interface Authorization {
  identifier: { type: string; value: string };
  status: string;
  challenges: AcmeChallenge[];
}

interface Order {
  status: string;
  identifiers: Array<{ type: string; value: string }>;
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: AcmeProblem;
}

interface AcmeResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface PendingChallenge {
  type: ChallengeType;
  /** The IP address being validated. */
  identifier: string;
  token: string;
  keyAuthorization: string;
}

/**
 * Called once the challenge is chosen: start serving it, then resolve with a teardown
 * function. The client tells the CA to validate only after this resolves and always
 * calls the teardown afterwards. Throwing here skips to the next challenge type.
 */
export type ChallengeSolver = (challenge: PendingChallenge) => Promise<() => Promise<void>>;

export interface AcmeClientOptions {
  directoryUrl: string;
  fetch?: FetchLike;
  /** Max time to wait for an authorization or order to settle. Default 120 s. */
  pollTimeoutMs?: number;
  /** Per-request timeout. Default 30 s. */
  requestTimeoutMs?: number;
}

export interface ObtainIpCertificateOptions {
  ip: string;
  /** ACME profile to request when the CA advertises it. Default 'shortlived'; null = none. */
  profile?: string | null;
  /** Challenge types to try, in order. Default ['http-01', 'tls-alpn-01']. */
  challengeTypes?: ChallengeType[];
  solve: ChallengeSolver;
}

export interface ObtainedCertificate {
  keyPem: string;
  /** Full chain, leaf first. */
  certPem: string;
  notAfter: Date;
  challengeType: ChallengeType;
  profile: string | null;
}

/** Raised by the authorization step; `needsNewOrder` once the CA has been asked to validate. */
class AttemptError extends Error {
  constructor(
    message: string,
    readonly needsNewOrder: boolean,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(headers: Headers, fallbackMs: number): number {
  const v = headers.get('retry-after');
  let ms = fallbackMs;
  if (v) {
    if (/^\d+$/.test(v.trim())) ms = Number(v) * 1000;
    else if (!Number.isNaN(Date.parse(v))) ms = Date.parse(v) - Date.now();
  }
  return Math.min(Math.max(ms, 500), 30_000);
}

export class AcmeClient {
  private readonly fetchImpl: FetchLike;
  private readonly accountKey: crypto.KeyObject;
  readonly accountJwk: crypto.JsonWebKey;
  private directory: Directory | null = null;
  private nonce: string | null = null;
  private kid: string | null = null;
  private readonly pollTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: AcmeClientOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 120_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.accountKey = privateKey;
    this.accountJwk = publicJwk(publicKey);
  }

  /** Full flow: account, order, authorization, finalize, download. */
  async obtainIpCertificate(o: ObtainIpCertificateOptions): Promise<ObtainedCertificate> {
    if (!net.isIP(o.ip)) throw new Error(`not an IP address: ${o.ip}`);
    const types = o.challengeTypes ?? ['http-01', 'tls-alpn-01'];
    const dir = await this.getDirectory();
    const wanted = o.profile === undefined ? 'shortlived' : o.profile;
    const profile = wanted && dir.meta?.profiles && wanted in dir.meta.profiles ? wanted : null;
    await this.ensureAccount();

    const errors: string[] = [];
    let order: { url: string; body: Order } | null = null;
    let used: ChallengeType | null = null;
    for (const type of types) {
      order ??= await this.newOrder(o.ip, profile);
      try {
        await this.authorize(order.body, type, o.solve);
        used = type;
        break;
      } catch (err) {
        errors.push(`${type}: ${(err as Error).message}`);
        // Once validation was attempted the authorization is spent; a retry needs a new order.
        if (!(err instanceof AttemptError) || err.needsNewOrder) order = null;
      }
    }
    if (!used || !order) throw new AcmeError(`ACME validation failed for ${o.ip}: ${errors.join('; ') || 'no challenge type to try'}`);

    const ready = await this.pollOrder(order.url, ['ready', 'valid']);
    const { keyPem, csrDer } = await createIpCsr(o.ip);
    let final = ready;
    if (ready.status === 'ready') {
      await this.post<Order>(ready.finalize, { csr: b64url(csrDer) });
      final = await this.pollOrder(order.url, ['valid']);
    }
    if (!final.certificate) throw new AcmeError('ACME order is valid but has no certificate URL');
    const res = await this.post<string>(final.certificate, null, 'application/pem-certificate-chain');
    const certPem = res.body.trim() + '\n';
    const leaf = new x509.X509Certificate(certPem.slice(0, certPem.indexOf('-----END CERTIFICATE-----') + 25));
    return { keyPem, certPem, notAfter: leaf.notAfter, challengeType: used, profile };
  }

  private async getDirectory(): Promise<Directory> {
    if (this.directory) return this.directory;
    const res = await this.fetchImpl(this.opts.directoryUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!res.ok) throw new AcmeError(`ACME directory ${this.opts.directoryUrl} answered HTTP ${res.status}`, null, res.status);
    const dir = (await res.json()) as Directory;
    if (!dir.newNonce || !dir.newAccount || !dir.newOrder) throw new AcmeError('ACME directory is missing newNonce/newAccount/newOrder');
    this.directory = dir;
    return dir;
  }

  private async getNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const dir = await this.getDirectory();
    const res = await this.fetchImpl(dir.newNonce, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(this.requestTimeoutMs) });
    const n = res.headers.get('replay-nonce');
    if (!n) throw new AcmeError(`ACME newNonce answered HTTP ${res.status} without a Replay-Nonce`);
    return n;
  }

  /** Signed POST (payload null = POST-as-GET). Retries once on badNonce. */
  private async post<T>(url: string, payload: unknown, accept?: string, useJwk = false): Promise<AcmeResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      const nonce = await this.getNonce();
      const header = useJwk || !this.kid ? { jwk: this.accountJwk } : { kid: this.kid };
      const jws = signJws(this.accountKey, { ...header, url, nonce }, payload);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json', 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) },
        body: JSON.stringify(jws),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const replay = res.headers.get('replay-nonce');
      if (replay) this.nonce = replay;
      const text = await res.text();
      const ctype = res.headers.get('content-type') ?? '';
      if (res.status >= 400) {
        let problem: AcmeProblem | null = null;
        try {
          problem = JSON.parse(text) as AcmeProblem;
        } catch {
          /* not JSON */
        }
        if (problem?.type === 'urn:ietf:params:acme:error:badNonce' && attempt === 0) continue;
        throw new AcmeError(`ACME request to ${url} failed with HTTP ${res.status}: ${describeProblem(problem ?? { detail: text.slice(0, 200) })}`, problem, res.status);
      }
      const body = (ctype.includes('json') && text ? JSON.parse(text) : text) as T;
      return { status: res.status, headers: res.headers, body };
    }
  }

  private async ensureAccount(): Promise<void> {
    if (this.kid) return;
    const dir = await this.getDirectory();
    const res = await this.post<unknown>(dir.newAccount, { termsOfServiceAgreed: true }, undefined, true);
    const kid = res.headers.get('location');
    if (!kid) throw new AcmeError('ACME newAccount response has no Location (account URL)');
    this.kid = kid;
  }

  private async newOrder(ip: string, profile: string | null): Promise<{ url: string; body: Order }> {
    const dir = await this.getDirectory();
    const payload: Record<string, unknown> = { identifiers: [{ type: 'ip', value: ip }] };
    if (profile) payload.profile = profile;
    const res = await this.post<Order>(dir.newOrder, payload);
    const url = res.headers.get('location');
    if (!url) throw new AcmeError('ACME newOrder response has no Location (order URL)');
    return { url, body: res.body };
  }

  private async authorize(order: Order, type: ChallengeType, solve: ChallengeSolver): Promise<void> {
    for (const authzUrl of order.authorizations) {
      const authz = (await this.post<Authorization>(authzUrl, null)).body;
      if (authz.status === 'valid') continue;
      if (authz.status !== 'pending') throw new AttemptError(`authorization for ${authz.identifier.value} is ${authz.status}`, true);
      const ch = authz.challenges.find((c) => c.type === type);
      if (!ch?.token) throw new AttemptError(`challenge not offered (offered: ${authz.challenges.map((c) => c.type).join(', ')})`, false);
      const teardown = await solve({
        type,
        identifier: authz.identifier.value,
        token: ch.token,
        keyAuthorization: keyAuthorization(ch.token, this.accountJwk),
      }).catch((err: Error) => {
        throw new AttemptError(err.message, false);
      });
      try {
        await this.post(ch.url, {});
        await this.waitAuthorization(authzUrl, ch.url);
      } catch (err) {
        throw new AttemptError((err as Error).message, true);
      } finally {
        await teardown().catch(() => {});
      }
    }
  }

  private async waitAuthorization(authzUrl: string, challengeUrl: string): Promise<void> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const res = await this.post<Authorization>(authzUrl, null);
      const authz = res.body;
      if (authz.status === 'valid') return;
      if (authz.status !== 'pending') {
        const ch = authz.challenges.find((c) => c.url === challengeUrl) ?? authz.challenges.find((c) => c.error);
        throw new AcmeError(`authorization ${authz.status}: ${describeProblem(ch?.error)}`, ch?.error ?? null);
      }
      if (Date.now() > deadline) throw new AcmeError(`timed out waiting for the CA to validate ${authz.identifier.value}`);
      await sleep(retryAfterMs(res.headers, 1000));
    }
  }

  private async pollOrder(url: string, want: string[]): Promise<Order> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const res = await this.post<Order>(url, null);
      if (want.includes(res.body.status)) return res.body;
      if (res.body.status === 'invalid') throw new AcmeError(`ACME order is invalid: ${describeProblem(res.body.error)}`, res.body.error ?? null);
      if (Date.now() > deadline) throw new AcmeError(`timed out waiting for the ACME order (status ${res.body.status})`);
      await sleep(retryAfterMs(res.headers, 1000));
    }
  }
}
