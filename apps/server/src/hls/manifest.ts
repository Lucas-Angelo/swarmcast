import crypto from 'node:crypto';
import { CompactSign, importPKCS8 } from 'jose';
import type { IntegrityManifest } from '@swarmcast/shared';

/**
 * Signs the integrity manifest (segment path → SHA-256) with the origin's Ed25519 key
 * as a compact JWS. Viewers verify it with WebCrypto before trusting any P2P data.
 */
export class ManifestSigner {
  private key!: Awaited<ReturnType<typeof importPKCS8>>;
  readonly publicKeyRaw: string;
  private cache: { version: number; liveId: string; jws: string } | null = null;

  private constructor(private readonly pem: string) {
    const pub = crypto.createPublicKey(crypto.createPrivateKey(pem));
    const jwk = pub.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('not an Ed25519 key');
    this.publicKeyRaw = jwk.x; // base64url raw 32-byte key
  }

  static async create(pem: string): Promise<ManifestSigner> {
    const s = new ManifestSigner(pem);
    s.key = await importPKCS8(pem, 'EdDSA');
    return s;
  }

  async sign(liveId: string, version: number, segments: Record<string, string>): Promise<string> {
    if (this.cache && this.cache.version === version && this.cache.liveId === liveId) return this.cache.jws;
    const payload: IntegrityManifest = { liveId, version, issuedAt: Date.now(), segments };
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'EdDSA', typ: 'swarmcast-manifest' })
      .sign(this.key);
    this.cache = { version, liveId, jws };
    return jws;
  }
}
