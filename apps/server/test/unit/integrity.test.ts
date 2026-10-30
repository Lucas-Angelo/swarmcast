import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestSigner } from '../../src/hls/manifest.js';
import { IntegrityVerifier, toHex } from '../../../viewer/src/integrity.js';

// The signed integrity manifest: the server signs segment hashes (Ed25519, compact JWS), and the
// viewer (apps/viewer/src/integrity.ts, WebCrypto) checks P2P segment data against them. The
// viewer fetches the manifest from its page's origin: `location` and `fetch` are its browser.

const MANIFEST = '/hls/manifest.json';
const PAGE = 'https://example.trycloudflare.com/watch';
const newKey = (): string => crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const pem = newKey();

/** The browser of the viewer: its page, and a server answering the manifest URL with `manifest` (a JWS, or a status). */
function browser(manifest: string | number): void {
  vi.stubGlobal('location', { href: PAGE });
  vi.stubGlobal('fetch', vi.fn(async () => (typeof manifest === 'number' ? new Response(null, { status: manifest }) : new Response(manifest, { status: 200 }))));
}

/** A verifier that loaded its key and the manifest the browser serves. */
async function verifier(signer: ManifestSigner): Promise<IntegrityVerifier> {
  const v = new IntegrityVerifier(MANIFEST, signer.publicKeyRaw);
  await v.init();
  return v;
}

const arrayBufferOf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const segmentsUrl = (name: string): string => `https://example.trycloudflare.com/hls/${name}`;

describe('signed integrity manifest', () => {
  let signer: ManifestSigner;
  beforeEach(async () => {
    signer = await ManifestSigner.create(pem);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs a compact JWS that the viewer verifies with WebCrypto Ed25519', async () => {
    // Arrange
    browser(404);
    const v = await verifier(signer);
    const jws = await signer.sign('live1', 1, { '/hls/a.mp4': 'ab' });
    // Act
    const payload = await v.verifyJws(jws);
    // Assert
    expect(v.usesSignature).toBe(true);
    expect(payload?.segments['/hls/a.mp4']).toBe('ab');
    expect(payload?.liveId).toBe('live1');
  });

  it('rejects a manifest signed by another key', async () => {
    // Arrange
    browser(404);
    const v = await verifier(signer);
    const other = await ManifestSigner.create(newKey());
    // Act
    const payload = await v.verifyJws(await other.sign('live1', 1, { '/hls/a.mp4': 'ab' }));
    // Assert
    expect(payload).toBeNull();
  });

  it('rejects a tampered manifest and anything that is not a JWS', async () => {
    // Arrange
    browser(404);
    const v = await verifier(signer);
    const [h, , s] = (await signer.sign('live1', 2, { '/hls/a.mp4': 'ab' })).split('.');
    const forged = Buffer.from(JSON.stringify({ liveId: 'live1', version: 2, issuedAt: 0, segments: { '/hls/a.mp4': 'cd' } })).toString('base64url');
    // Act
    const tampered = await v.verifyJws(`${h}.${forged}.${s}`);
    const notJws = await v.verifyJws('not.a.jws.at.all');
    // Assert
    expect(tampered).toBeNull();
    expect(notJws).toBeNull();
  });

  it('caches the signature per version', async () => {
    // Act
    const a = await signer.sign('L', 5, { x: '1' });
    const b = await signer.sign('L', 5, { x: '2' });
    const next = await signer.sign('L', 6, { x: '2' });
    // Assert
    expect(a).toBe(b);
    expect(next).not.toBe(a);
  });

  describe('P2P segment data against the signed hash', () => {
    const data = crypto.randomBytes(5000);
    const hash = crypto.createHash('sha256').update(data).digest('hex');

    async function loaded(): Promise<IntegrityVerifier> {
      browser(await signer.sign('live1', 3, { '/hls/seg1.mp4': hash }));
      return verifier(signer);
    }

    it('accepts data that matches', async () => {
      // Arrange
      const v = await loaded();
      // Act
      const ok = await v.check(segmentsUrl('seg1.mp4'), undefined, arrayBufferOf(data));
      // Assert
      expect(ok).toBe(true);
    });

    it('refuses data with one byte changed', async () => {
      // Arrange
      const v = await loaded();
      const bad = Buffer.from(data);
      bad[100] = bad[100]! ^ 0xff;
      // Act
      const ok = await v.check(segmentsUrl('seg1.mp4'), undefined, arrayBufferOf(bad));
      // Assert
      expect(ok).toBe(false);
    });

    it('never trusts a segment without a hash yet (the player falls back to HTTPS)', async () => {
      // Arrange
      const v = await loaded();
      // Act
      const ok = await v.check(segmentsUrl('seg2.mp4'), undefined, arrayBufferOf(data));
      // Assert
      expect(ok).toBe(false);
    });

    it('refuses byte ranges, which the origin never uses', async () => {
      // Arrange
      const v = await loaded();
      // Act
      const ok = await v.check(segmentsUrl('seg1.mp4'), { start: 0, end: 10 }, arrayBufferOf(data));
      // Assert
      expect(ok).toBe(false);
    });
  });

  it('hex helper', () => {
    // Act
    const hex = toHex(new Uint8Array([0, 15, 255]).buffer);
    // Assert
    expect(hex).toBe('000fff');
  });
});
