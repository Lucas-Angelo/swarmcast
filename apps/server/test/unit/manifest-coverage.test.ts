import crypto from 'node:crypto';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ManifestSigner } from '../../src/hls/manifest.js';
import { HlsOrigin, type HlsSource } from '../../src/hls/origin.js';
import { silentLog } from './helpers.js';

// Invariant (origin.ts): a viewer never gets a playlist listing a segment whose hash is missing
// from the signed manifest. The origin publishes each media playlist as soon as it is processed,
// while the poll goes on with the next one (slow on Windows: every playlist and segment is a
// file read). The manifest is cached per origin.version, so the version must move as soon as a
// hashed file is added, not only when the whole poll ends.
//
// The scenario: a viewer fetched the manifest after the first poll (the signer caches it for that
// version); the next poll brings a new audio segment, and its video playlist read is slow (big
// files, Windows). While it is held, audio.m3u8 already lists the new segment, so the manifest
// served at that moment must hash it.

const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
/** The origin's poll interval here (ms): short, so the first poll is seen at once. */
const POLL_MS = 20;

function playlist(names: string[]): string {
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init.mp4"', ...names.flatMap((n) => ['#EXTINF:2.000000,', n])].join('\n');
}

/**
 * A ladder-like source. Like renderLadderMultivariant, the audio rendition comes first in the
 * multivariant playlist, so the origin processes (and publishes) audio.m3u8 before it reads the
 * video playlists; that video read can be held back, mid-poll.
 */
class GatedSource implements HlsSource {
  readonly kind = 'ladder';
  audio = ['a_0.m4s'];
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private held: (() => void) | null = null;
  /** This poll's audio playlist already listed every audio segment. */
  private audioCurrent = false;

  /** Holds the video read of the next poll that reads the audio playlist; resolves once it is held. */
  holdVideo(): Promise<void> {
    this.gate = new Promise((r) => (this.open = r));
    return new Promise((r) => (this.held = r));
  }
  releaseVideo(): void {
    this.open?.();
    this.gate = null;
  }
  reset(): void {}
  async fetch(uri: string): Promise<Response> {
    if (uri === 'index.m3u8') {
      return new Response(
        ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="aud"', 'video.m3u8'].join('\n'),
      );
    }
    if (uri === 'audio.m3u8') {
      this.audioCurrent = this.gate !== null;
      return new Response(playlist(this.audio));
    }
    if (uri === 'video.m3u8') {
      // Hold only the poll that read the new audio playlist (not one already past it).
      if (this.gate && this.audioCurrent) {
        this.held?.();
        await this.gate;
      }
      return new Response(playlist(['v_0.m4s']));
    }
    return new Response(`bytes of ${uri}`);
  }
}

const segmentsOf = (jws: string): Record<string, string> =>
  (JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString()) as { segments: Record<string, string> }).segments;

/** What GET /hls/manifest.json serves (public/server.ts): the signed hashes of the origin's version now. */
const servedManifest = (signer: ManifestSigner, origin: HlsOrigin) => async (): Promise<Record<string, string>> => segmentsOf(await signer.sign('live', origin.version, origin.segmentHashes()));

describe('signed manifest covers every listed segment', () => {
  it('a segment listed mid-poll is in the manifest served at that moment', async () => {
    // Arrange
    const signer = await ManifestSigner.create(pem);
    const src = new GatedSource();
    const origin = new HlsOrigin(src, silentLog, POLL_MS);
    onTestFinished(() => origin.stop());
    onTestFinished(() => src.releaseVideo());
    const manifest = servedManifest(signer, origin);
    origin.start();
    await expect.poll(() => origin.getPlaylist('video.m3u8')).toContain('v_0.m4s');
    const first = await manifest();
    src.audio = ['a_0.m4s', 'a_1.m4s'];
    // Act
    await src.holdVideo();
    const audio = origin.getPlaylist('audio.m3u8');
    const now = await manifest();
    // Assert
    expect(Object.keys(first)).toContain('/hls/a_0.m4s');
    expect(audio).toContain('a_1.m4s');
    expect(now['/hls/a_1.m4s']).toBe(origin.getFile('a_1.m4s')!.sha256);
  });
});
