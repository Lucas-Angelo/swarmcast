// What the watch page may do with the player, by capability (player-caps.ts), with fakes for each
// kind of browser: full screen of the container where elements can go full screen (computers,
// Android, iPadOS; Safari's prefixed API on older ones), iOS's own player on an iPhone (only the
// video can), a container request refused falling back to the video; picture-in-picture through
// the standard API or Safari's presentation mode, nowhere else; a volume the page may set, except
// on iOS where it always reads 1.
import { describe, expect, it, vi } from 'vitest';
import { exitFullscreen, fullscreenMode, inPip, isFullscreen, pipMode, pipSupported, toggleFullscreen, togglePip, volumeSettable } from '../../src/player-caps.js';

type Fake = Record<string, unknown>;
const doc = (o: Fake = {}): Document => ({ fullscreenElement: null, pictureInPictureEnabled: false, pictureInPictureElement: null, body: {}, ...o }) as unknown as Document;
const el = (o: Fake = {}): HTMLElement => o as unknown as HTMLElement;
const vid = (o: Fake = {}): HTMLVideoElement => o as unknown as HTMLVideoElement;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('full screen', () => {
  it('computers, Android and iPadOS: the container, by the standard API; our controls go with it', () => {
    // Arrange
    const requestFullscreen = vi.fn(async () => {});
    const container = el({ requestFullscreen });
    const videoRequest = vi.fn(async () => {});
    const video = vid({ requestFullscreen: videoRequest, webkitEnterFullscreen: vi.fn() });
    // Act
    const mode = fullscreenMode(container, video, doc({ fullscreenEnabled: true }));
    const done = toggleFullscreen(container, video, doc({ fullscreenEnabled: true }));
    // Assert
    expect(mode).toBe('element');
    expect(done).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(videoRequest).not.toHaveBeenCalled();
  });

  it("older Safari and iPadOS before 16.4: the container, by WebKit's prefixed API", () => {
    // Arrange
    const webkitRequestFullscreen = vi.fn();
    const container = el({ webkitRequestFullscreen });
    // Act
    const mode = fullscreenMode(container, vid(), doc({ webkitFullscreenEnabled: true }));
    toggleFullscreen(container, vid(), doc({ webkitFullscreenEnabled: true }));
    // Assert
    expect(mode).toBe('element-webkit');
    expect(webkitRequestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("iPhone: no element full screen, so the video alone in iOS's own player", () => {
    // Arrange
    const webkitEnterFullscreen = vi.fn();
    const video = vid({ webkitEnterFullscreen });
    // Act
    const mode = fullscreenMode(el(), video, doc());
    toggleFullscreen(el(), video, doc());
    // Assert
    expect(mode).toBe('video-native');
    expect(webkitEnterFullscreen).toHaveBeenCalledTimes(1);
  });

  it('a page where the browser has the method but says no (fullscreenEnabled false): the next way down', () => {
    // Arrange
    const container = el({ requestFullscreen: vi.fn() });
    const video = vid({ webkitEnterFullscreen: vi.fn() });
    // Act / Assert
    expect(fullscreenMode(container, video, doc({ fullscreenEnabled: false }))).toBe('video-native');
    expect(fullscreenMode(container, vid(), doc({ fullscreenEnabled: false }))).toBe('none');
  });

  it('no way at all (some in-app browsers): says so and does nothing', () => {
    // Act / Assert
    expect(fullscreenMode(el(), vid(), doc())).toBe('none');
    expect(toggleFullscreen(el(), vid(), doc())).toBe(false);
  });

  it('a container request the browser refuses falls back to the video (WebViews that only honour a <video>)', async () => {
    // Arrange
    const container = el({ requestFullscreen: vi.fn(() => Promise.reject(new Error('NotSupportedError'))) });
    const videoRequest = vi.fn(async () => {});
    const video = vid({ requestFullscreen: videoRequest });
    // Act
    toggleFullscreen(container, video, doc());
    await settle();
    // Assert
    expect(videoRequest).toHaveBeenCalledTimes(1);
  });

  it('a refused video request after that ends in iOS-style full screen when there is one, and never throws', async () => {
    // Arrange
    const container = el({ requestFullscreen: vi.fn(() => Promise.reject(new Error('no'))) });
    const webkitEnterFullscreen = vi.fn();
    const video = vid({ requestFullscreen: vi.fn(() => Promise.reject(new Error('no'))), webkitEnterFullscreen });
    // Act
    toggleFullscreen(container, video, doc());
    await settle();
    // Assert
    expect(webkitEnterFullscreen).toHaveBeenCalledTimes(1);
  });

  it('already full screen: the call leaves it, whichever API put it there', () => {
    // Arrange
    const exit = vi.fn(async () => {});
    const webkitExit = vi.fn();
    const iosExit = vi.fn();
    const container = el({ requestFullscreen: vi.fn() });
    // Act
    toggleFullscreen(container, vid(), doc({ fullscreenElement: container, exitFullscreen: exit }));
    toggleFullscreen(container, vid(), doc({ fullscreenElement: undefined, webkitFullscreenElement: container, webkitExitFullscreen: webkitExit }));
    toggleFullscreen(container, vid({ webkitDisplayingFullscreen: true, webkitExitFullscreen: iosExit }), doc());
    // Assert
    expect(exit).toHaveBeenCalledTimes(1);
    expect(webkitExit).toHaveBeenCalledTimes(1);
    expect(iosExit).toHaveBeenCalledTimes(1);
    expect((container as unknown as { requestFullscreen: ReturnType<typeof vi.fn> }).requestFullscreen).not.toHaveBeenCalled();
  });

  it('isFullscreen sees the container, the prefixed element and iOS’s player; exitFullscreen does nothing when nothing is full screen', () => {
    // Arrange
    const exit = vi.fn(async () => {});
    // Act / Assert
    expect(isFullscreen(vid(), doc({ fullscreenElement: {} }))).toBe(true);
    expect(isFullscreen(vid(), doc({ fullscreenElement: undefined, webkitFullscreenElement: {} }))).toBe(true);
    expect(isFullscreen(vid({ webkitDisplayingFullscreen: true }), doc())).toBe(true);
    expect(isFullscreen(vid(), doc())).toBe(false);
    exitFullscreen(vid(), doc({ exitFullscreen: exit }));
    expect(exit).not.toHaveBeenCalled();
    exitFullscreen(vid(), doc({ fullscreenElement: {}, exitFullscreen: exit }));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('picture-in-picture', () => {
  it('the standard API (Chrome, Edge, Safari, Firefox 153+), else Safari presentation mode, else none', () => {
    // Arrange
    const chrome = vid({ requestPictureInPicture: vi.fn() });
    const safari = vid({ webkitSupportsPresentationMode: (m: string) => m === 'picture-in-picture', webkitSetPresentationMode: vi.fn() });
    const firefoxOld = vid();
    // Act / Assert
    expect(pipMode(chrome, doc({ pictureInPictureEnabled: true }))).toBe('standard');
    expect(pipMode(chrome, doc())).toBe('none');
    expect(pipMode(vid({ requestPictureInPicture: vi.fn(), disablePictureInPicture: true }), doc({ pictureInPictureEnabled: true }))).toBe('none');
    expect(pipMode(safari, doc())).toBe('webkit');
    expect(pipMode(vid({ webkitSetPresentationMode: vi.fn(), webkitSupportsPresentationMode: () => false }), doc())).toBe('none');
    expect(pipSupported(firefoxOld, doc())).toBe(false);
  });

  it('toggles: in and out with the standard API; Safari between inline and picture-in-picture; nothing elsewhere', async () => {
    // Arrange
    const requestPictureInPicture = vi.fn(async () => {});
    const exitPictureInPicture = vi.fn(async () => {});
    const chrome = vid({ requestPictureInPicture });
    const setMode = vi.fn();
    const safari = vid({ webkitSupportsPresentationMode: () => true, webkitSetPresentationMode: setMode, webkitPresentationMode: 'picture-in-picture' });
    // Act / Assert
    expect(togglePip(chrome, doc({ pictureInPictureEnabled: true }))).toBe(true);
    expect(requestPictureInPicture).toHaveBeenCalledTimes(1);
    expect(togglePip(chrome, doc({ pictureInPictureEnabled: true, pictureInPictureElement: chrome, exitPictureInPicture }))).toBe(true);
    expect(exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(inPip(chrome, doc({ pictureInPictureElement: chrome }))).toBe(true);
    expect(togglePip(safari, doc())).toBe(true);
    expect(setMode).toHaveBeenCalledWith('inline');
    expect(inPip(safari, doc())).toBe(true);
    expect(togglePip(vid(), doc())).toBe(false);
    // A refusal (no user gesture) is swallowed.
    expect(togglePip(vid({ requestPictureInPicture: () => Promise.reject(new Error('NotAllowedError')) }), doc({ pictureInPictureEnabled: true }))).toBe(true);
    await settle();
  });
});

describe('volume', () => {
  it('settable where a value set is read back, and the current value is put back', () => {
    // Arrange
    const video = { volume: 0.8 } as HTMLVideoElement;
    // Act
    const ok = volumeSettable(video);
    // Assert
    expect(ok).toBe(true);
    expect(video.volume).toBe(0.8);
  });

  it('iOS: volume always reads 1 (the hardware buttons own it), so there is no slider', () => {
    // Arrange
    const video = {} as HTMLVideoElement;
    Object.defineProperty(video, 'volume', { get: () => 1, set: () => {} });
    // Act / Assert
    expect(volumeSettable(video)).toBe(false);
  });

  it('a browser that throws on the setter has no slider either', () => {
    // Arrange
    const video = {} as HTMLVideoElement;
    Object.defineProperty(video, 'volume', {
      get: () => 1,
      set: () => {
        throw new Error('read-only');
      },
    });
    // Act / Assert
    expect(volumeSettable(video)).toBe(false);
  });
});
