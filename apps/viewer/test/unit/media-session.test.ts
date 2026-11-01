// Lock-screen and notification controls (media-session.ts): play / pause only (a live has nothing
// to seek to), the streamer's name as the title and their avatar as a data: URL (read by the page
// itself, so the browser never fetches a members-only picture or anything off the origin), and
// nothing at all where the browser has no Media Session. navigator.mediaSession, MediaMetadata
// and the image reader are fakes.
import { describe, expect, it, vi } from 'vitest';
import { createMediaSession, imageAsDataUrl, type MediaSessionLike } from '../../src/media-session.js';

/** MediaMetadata: keeps what it was built with. */
class FakeMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];
  constructor(init: MediaMetadataInit) {
    this.title = init.title ?? '';
    this.artist = init.artist ?? '';
    this.album = init.album ?? '';
    this.artwork = [...(init.artwork ?? [])];
  }
}

/** navigator.mediaSession: its metadata, state and handlers; `unknown` actions throw like an older browser. */
class FakeMediaSession implements MediaSessionLike {
  metadata: MediaMetadata | null = null;
  playbackState: MediaSessionPlaybackState = 'none';
  readonly handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  constructor(private readonly unknown: MediaSessionAction[] = []) {}
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (this.unknown.includes(action)) throw new TypeError(`unknown action ${action}`);
    this.handlers.set(action, handler);
  }
  get meta(): FakeMetadata {
    return this.metadata as unknown as FakeMetadata;
  }
  call(action: MediaSessionAction): void {
    this.handlers.get(action)?.({ action });
  }
}

const FALLBACK: MediaImage = { src: '/assets/favicon-512-abc.png', sizes: '512x512', type: 'image/png' };
const AVATAR = `/brand/${'a'.repeat(64)}.png`;
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function setup(o: { session?: FakeMediaSession | null; toDataUrl?: (url: string) => Promise<string | null> } = {}) {
  const session = o.session === undefined ? new FakeMediaSession() : o.session;
  const player = { play: vi.fn(), pause: vi.fn() };
  const toDataUrl = vi.fn(o.toDataUrl ?? (async () => DATA_URL));
  const control = createMediaSession({
    mediaSession: session ?? undefined,
    Metadata: FakeMetadata as unknown as new (init: MediaMetadataInit) => MediaMetadata,
    player,
    labels: { title: 'Live', artist: 'Live on SwarmCast' },
    fallbackArtwork: FALLBACK,
    toDataUrl,
  });
  return { control, session: session!, player, toDataUrl };
}

describe('media session', () => {
  it('plays and pauses the video from the lock screen; stop pauses', () => {
    // Arrange
    const { session, player } = setup();
    // Act
    session.call('play');
    session.call('pause');
    session.call('stop');
    // Assert
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(2);
  });

  it('switches off seeking and track buttons (a live has no position)', () => {
    // Arrange
    const { session } = setup();
    // Act
    const off = ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].map((a) => session.handlers.get(a as MediaSessionAction));
    // Assert
    expect(off).toEqual([null, null, null, null, null]);
  });

  it('skips actions an older browser does not know', () => {
    // Arrange
    const session = new FakeMediaSession(['stop', 'seekto']);
    // Act
    const { player } = setup({ session });
    session.call('play');
    // Assert
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(session.handlers.has('stop')).toBe(false);
  });

  it('starts with "Live" and SwarmCast\'s own icon', () => {
    // Arrange
    const { session } = setup();
    // Act
    const meta = session.meta;
    // Assert
    expect(meta).toMatchObject({ title: 'Live', artist: 'Live on SwarmCast', album: 'SwarmCast', artwork: [FALLBACK] });
  });

  it('follows play and pause in the playback state', () => {
    // Arrange
    const { control, session } = setup();
    // Act
    control.setPlaying(true);
    // Assert
    expect(session.playbackState).toBe('playing');
    // Act
    control.setPlaying(false);
    // Assert
    expect(session.playbackState).toBe('paused');
  });

  it("shows the streamer's name and their avatar as a data: URL", async () => {
    // Arrange
    const { control, session, toDataUrl } = setup();
    // Act
    await control.setBrand({ name: 'Ana Plays', avatar: AVATAR });
    // Assert
    expect(toDataUrl).toHaveBeenCalledWith(AVATAR);
    expect(session.meta.title).toBe('Ana Plays');
    expect(session.meta.artwork).toEqual([{ src: DATA_URL, sizes: '256x256', type: 'image/png' }]);
  });

  it('reads the same avatar once', async () => {
    // Arrange
    const { control, toDataUrl, session } = setup();
    await control.setBrand({ name: 'Ana Plays', avatar: AVATAR });
    // Act
    await control.setBrand({ name: 'Ana Plays Live', avatar: AVATAR });
    // Assert
    expect(toDataUrl).toHaveBeenCalledTimes(1);
    expect(session.meta.title).toBe('Ana Plays Live');
    expect(session.meta.artwork[0]!.src).toBe(DATA_URL);
  });

  it('keeps its own icon when the avatar cannot be read', async () => {
    // Arrange
    const { control, session } = setup({ toDataUrl: async () => null });
    // Act
    await control.setBrand({ name: 'Ana Plays', avatar: AVATAR });
    // Assert
    expect(session.meta.title).toBe('Ana Plays');
    expect(session.meta.artwork).toEqual([FALLBACK]);
  });

  it('goes back to "Live" and its own icon when the page is turned off', async () => {
    // Arrange
    const { control, session } = setup();
    await control.setBrand({ name: 'Ana Plays', avatar: AVATAR });
    // Act
    await control.setBrand(null);
    // Assert
    expect(session.meta).toMatchObject({ title: 'Live', artwork: [FALLBACK] });
  });

  it('lets a newer page win over an older picture still being read', async () => {
    // Arrange
    let finish: (v: string) => void = () => {};
    const { control, session } = setup({ toDataUrl: () => new Promise((resolve) => (finish = resolve)) });
    const older = control.setBrand({ name: 'Old', avatar: AVATAR });
    // Act
    await control.setBrand({ name: 'New' });
    finish(DATA_URL);
    await older;
    // Assert
    expect(session.meta).toMatchObject({ title: 'New', artwork: [FALLBACK] });
  });

  it('does nothing where the browser has no Media Session', async () => {
    // Arrange
    const { control, toDataUrl } = setup({ session: null });
    // Act
    control.setPlaying(true);
    await control.setBrand({ name: 'Ana Plays', avatar: AVATAR });
    // Assert
    expect(toDataUrl).not.toHaveBeenCalled();
  });
});

describe('imageAsDataUrl', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('reads a same-origin image with the page cookies into a data: URL', async () => {
    // Arrange
    const f = vi.fn(async () => new Response(new Blob([png], { type: 'image/png' })));
    // Act
    const url = await imageAsDataUrl(AVATAR, f as unknown as typeof fetch);
    // Assert
    expect(f).toHaveBeenCalledWith(AVATAR, { credentials: 'same-origin' });
    expect(url).toBe('data:image/png;base64,iVBORw==');
  });

  it.each([
    ['a refused answer', async () => new Response('no', { status: 401 })],
    ['something that is not a picture', async () => new Response(new Blob(['<svg/>'], { type: 'image/svg+xml' }))],
    ['a network failure', async () => Promise.reject(new TypeError('offline'))],
  ])('gives null for %s', async (_what, answer) => {
    // Act
    const url = await imageAsDataUrl(AVATAR, vi.fn(answer) as unknown as typeof fetch);
    // Assert
    expect(url).toBeNull();
  });
});
