import crypto from 'node:crypto';
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { ManifestSigner } from '../../src/hls/manifest.js';
import { IntegrityVerifier, toHex } from '../../../viewer/src/integrity.js';

const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

describe('signed integrity manifest', () => {
  let signer: ManifestSigner;
  beforeAll(async () => {
    signer = await ManifestSigner.create(pem);
    vi.stubGlobal('location', { href: 'https://example.trycloudflare.com/watch' });
  });

  it('signs a compact JWS that the viewer verifies with WebCrypto Ed25519', async () => {
    const jws = await signer.sign('live1', 1, { '/hls/a.mp4': 'ab' });
    const v = new IntegrityVerifier('/hls/manifest.json', signer.publicKeyRaw);
    await (v as unknown as { init(): Promise<void> }).init().catch(() => {});
    const payload = await v.verifyJws(jws);
    expect(v.usesSignature).toBe(true);
    expect(payload?.segments['/hls/a.mp4']).toBe('ab');
    expect(payload?.liveId).toBe('live1');
  });

  it('rejects a manifest signed by another key or tampered', async () => {
    const other = await ManifestSigner.create(crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    const v = new IntegrityVerifier('/hls/manifest.json', signer.publicKeyRaw);
    await v.init().catch(() => {});
    expect(await v.verifyJws(await other.sign('live1', 1, { '/hls/a.mp4': 'ab' }))).toBeNull();
    const good = await signer.sign('live1', 2, { '/hls/a.mp4': 'ab' });
    const [h, , s] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ liveId: 'live1', version: 2, issuedAt: 0, segments: { '/hls/a.mp4': 'cd' } })).toString('base64url');
    expect(await v.verifyJws(`${h}.${forged}.${s}`)).toBeNull();
    expect(await v.verifyJws('not.a.jws.at.all')).toBeNull();
  });

  it('caches the signature per version', async () => {
    const a = await signer.sign('L', 5, { x: '1' });
    const b = await signer.sign('L', 5, { x: '2' });
    expect(a).toBe(b);
    expect(await signer.sign('L', 6, { x: '2' })).not.toBe(a);
  });

  it('validates P2P segment data against the signed hash', async () => {
    const data = crypto.randomBytes(5000);
    const good = crypto.createHash('sha256').update(data).digest('hex');
    const jws = await signer.sign('live1', 3, { '/hls/seg1.mp4': good });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(jws, { status: 200 })));
    const v = new IntegrityVerifier('/hls/manifest.json', signer.publicKeyRaw);
    await v.init();
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    expect(await v.check('https://example.trycloudflare.com/hls/seg1.mp4', undefined, ab)).toBe(true);
    const bad = Buffer.from(data);
    bad[100] = bad[100]! ^ 0xff;
    expect(await v.check('https://example.trycloudflare.com/hls/seg1.mp4', undefined, bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength))).toBe(false);
    // Unknown segment (no hash yet): never trusted, the player falls back to HTTPS.
    expect(await v.check('https://example.trycloudflare.com/hls/seg2.mp4', undefined, ab)).toBe(false);
    // Byte ranges are never used by the origin; refuse them.
    expect(await v.check('https://example.trycloudflare.com/hls/seg1.mp4', { start: 0, end: 10 }, ab)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('hex helper', () => {
    expect(toHex(new Uint8Array([0, 15, 255]).buffer)).toBe('000fff');
  });
});
