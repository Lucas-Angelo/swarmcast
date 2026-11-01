/**
 * Lock-screen and notification controls (Media Session API): the streamer's name and picture, and
 * play / pause. A live has no position to seek to, so the seek and track buttons are switched off
 * (their handlers set to null) and no position is reported.
 *
 * - Browsers show these controls only while the media plays with sound: a muted viewer sees
 *   nothing until they unmute.
 * - The picture: the streamer's avatar (/brand/<sha>.png) is only for members (cookie), and the
 *   browser fetches artwork on its own, without the page's cookies on some platforms. So the page
 *   fetches it itself (same origin, connect-src 'self') and hands over a data: URL, which the CSP
 *   allows (img-src 'self' data:). Without an avatar, SwarmCast's own icon (same origin, public).
 *   No request ever leaves the origin.
 * - Where the API is missing (Android WebView, older browsers), nothing happens.
 */

/** What the controller needs of navigator.mediaSession. */
export interface MediaSessionLike {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void;
}

/** The streamer's page fields used here (from /api/brand, sanitised by branding/brand.ts). */
export interface MediaBrand {
  name?: string;
  /** Same-origin URL of the 256 px avatar. */
  avatar?: string;
}

export interface MediaSessionControl {
  /** The player plays (true) or is paused (false): the lock screen shows the matching button. */
  setPlaying(playing: boolean): void;
  /** The streamer's page changed (null: no page or it is off): new title and picture. */
  setBrand(brand: MediaBrand | null): Promise<void>;
}

export interface MediaSessionDeps {
  /** navigator.mediaSession, or undefined where the browser has none. */
  mediaSession: MediaSessionLike | undefined;
  /** The MediaMetadata constructor (window.MediaMetadata). */
  Metadata: (new (init: MediaMetadataInit) => MediaMetadata) | undefined;
  player: { play(): void; pause(): void };
  /** Title without a streamer's name ("Live"), and the line under it ("Live on SwarmCast"). */
  labels: { title: string; artist: string };
  /** SwarmCast's own icon (same-origin, public), used without an avatar. */
  fallbackArtwork: MediaImage;
  /** Same-origin image URL -> data: URL, or null when it cannot be read. */
  toDataUrl: (url: string) => Promise<string | null>;
}

/** Actions a live does not have: no ±10 s, seek bar or track buttons on the lock screen. */
const NO_ACTIONS: MediaSessionAction[] = ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'];

export function createMediaSession(d: MediaSessionDeps): MediaSessionControl {
  const ms = d.mediaSession;
  const Metadata = d.Metadata;
  if (!ms || !Metadata) return { setPlaying: () => {}, setBrand: async () => {} };

  const handle = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // A browser that does not know this action throws (the spec says TypeError): skip it.
    }
  };
  handle('play', () => d.player.play());
  handle('pause', () => d.player.pause());
  handle('stop', () => d.player.pause());
  for (const a of NO_ACTIONS) handle(a, null);

  const show = (title: string, artwork: MediaImage): void => {
    ms.metadata = new Metadata({ title, artist: d.labels.artist, album: 'SwarmCast', artwork: [artwork] });
  };
  show(d.labels.title, d.fallbackArtwork);

  // A newer setBrand wins over an older one still reading its picture. The picture's URL names
  // its content (a hash), so the same URL is read once.
  let seq = 0;
  let read: { url: string; art: MediaImage } | null = null;
  return {
    setPlaying(playing) {
      ms.playbackState = playing ? 'playing' : 'paused';
    },
    async setBrand(brand) {
      const mine = ++seq;
      const title = brand?.name ?? d.labels.title;
      const avatar = brand?.avatar;
      if (avatar && read?.url === avatar) return show(title, read.art);
      // The name at once, the picture when it is read (it is small: 256 px).
      show(title, d.fallbackArtwork);
      if (!avatar) return;
      const src = await d.toDataUrl(avatar);
      if (mine !== seq || !src) return;
      read = { url: avatar, art: { src, sizes: '256x256', type: src.slice(5, src.indexOf(';')) } };
      show(title, read.art);
    },
  };
}

/** Reads a same-origin image with the page's cookies and returns it as a data: URL (null on any failure). */
export async function imageAsDataUrl(url: string, f: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await f(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    // In slices: String.fromCharCode with one argument per byte of a whole picture would overflow the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
