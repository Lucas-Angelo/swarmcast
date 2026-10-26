import type { IntegrityManifest } from '@swarmcast/shared';

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Keeps the latest verified integrity manifest and checks P2P segments against it.
 * The manifest is fetched over HTTPS from the origin and its Ed25519 signature is
 * verified with WebCrypto. If the browser lacks WebCrypto Ed25519, we fall back to
 * trusting the HTTPS response itself (documented in docs/ARCHITECTURE.md).
 */
export class IntegrityVerifier {
  private key: CryptoKey | null = null;
  private signatureSupported = true;
  private hashes = new Map<string, string>();
  private liveId = '';
  private version = -1;
  private inflight: Promise<void> | null = null;
  private lastFetch = 0;

  constructor(
    private readonly manifestUrl: string,
    private readonly publicKeyB64url: string,
  ) {}

  async init(): Promise<void> {
    try {
      this.key = await crypto.subtle.importKey('raw', b64urlToBytes(this.publicKeyB64url), { name: 'Ed25519' }, false, ['verify']);
    } catch {
      this.signatureSupported = false;
    }
    await this.refresh(true);
  }

  get usesSignature(): boolean {
    return this.signatureSupported;
  }

  /** Verify a compact JWS and return its payload, or null when invalid. */
  async verifyJws(jws: string): Promise<IntegrityManifest | null> {
    const parts = jws.trim().split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    try {
      const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { alg?: string };
      if (header.alg !== 'EdDSA' && header.alg !== 'Ed25519') return null;
      if (this.key) {
        const ok = await crypto.subtle.verify({ name: 'Ed25519' }, this.key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
        if (!ok) return null;
      } else if (this.signatureSupported) {
        return null;
      }
      return JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as IntegrityManifest;
    } catch {
      return null;
    }
  }

  /** Fetch the manifest (at most every 750 ms unless forced). */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.lastFetch < 750) return Promise.resolve();
    this.inflight = (async () => {
      try {
        this.lastFetch = Date.now();
        const res = await fetch(this.manifestUrl, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return;
        const m = await this.verifyJws(await res.text());
        if (!m) return;
        if (m.liveId !== this.liveId) {
          this.liveId = m.liveId;
          this.hashes.clear();
          this.version = -1;
        }
        if (m.version < this.version) return;
        this.version = m.version;
        for (const [k, v] of Object.entries(m.segments)) this.hashes.set(k, v);
        // Keep memory bounded.
        if (this.hashes.size > 400) {
          const keep = new Set(Object.keys(m.segments));
          for (const k of this.hashes.keys()) if (!keep.has(k)) this.hashes.delete(k);
        }
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async expectedHash(path: string): Promise<string | undefined> {
    let h = this.hashes.get(path);
    if (!h) {
      await this.refresh(true);
      h = this.hashes.get(path);
    }
    return h;
  }

  /**
   * True only when `data` matches the signed hash for `url`. No hash yet → false,
   * so the player fetches the segment over HTTPS instead of trusting a peer.
   */
  async check(url: string, byteRange: unknown, data: ArrayBuffer): Promise<boolean> {
    if (byteRange) return false;
    const path = new URL(url, location.href).pathname;
    const expected = await this.expectedHash(path);
    if (!expected) return false;
    const actual = toHex(await crypto.subtle.digest('SHA-256', data));
    return actual === expected;
  }
}
