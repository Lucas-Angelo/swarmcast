/**
 * What the browser lets the watch page do with the player, found by capability (never by user
 * agent), and the calls that do it. Research: .claude/handoff/research-0.5.0-player.md §1.
 *
 * - Full screen: the player CONTAINER (`.player`: video, our controls, the status and stats
 *   overlays, later the chat over the video) wherever elements can go full screen: computers,
 *   Android, iPadOS (`requestFullscreen`, or `webkitRequestFullscreen` on older Safari). An iPhone
 *   has no element full screen at all (MDN BCD api.Element.requestFullscreen: "Only available on
 *   iPad, not on iPhone"); there only the video itself can, with `webkitEnterFullscreen()`, and
 *   iOS then shows its own player and controls instead of ours until the viewer leaves it.
 * - Picture-in-picture: `requestPictureInPicture` (Chrome, Edge, Safari, Firefox 153+ on
 *   computers) or Safari's `webkitSetPresentationMode`; nothing on Firefox for Android, Android
 *   WebView and Firefox before 153 (its own button over the video stays its own).
 * - Volume: read-only on iOS and iPadOS (the hardware buttons own it; setting it does nothing),
 *   so the volume slider shows only where a value set is read back.
 */

/** Vendor-prefixed full-screen and picture-in-picture members (Safari, iOS). */
export interface WebkitVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  webkitDisplayingFullscreen?: boolean;
}
export interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}
export interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
}

/**
 * How this browser goes full screen:
 * - `element`: the container, standard API (our controls stay);
 * - `element-webkit`: the container, Safari's prefixed API (our controls stay);
 * - `video-native`: the video alone with the system's player (iPhone; our controls are gone until it ends);
 * - `none`: not at all (some in-app browsers).
 */
export type FullscreenMode = 'element' | 'element-webkit' | 'video-native' | 'none';

export function fullscreenMode(container: HTMLElement, video: HTMLVideoElement, doc: Document): FullscreenMode {
  const c = container as WebkitElement;
  const d = doc as WebkitDocument;
  // fullscreenEnabled is false in a frame without allow="fullscreen" and where the browser has
  // the method but not the feature; undefined only where the API is missing altogether.
  if (typeof c.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) return 'element';
  if (typeof c.webkitRequestFullscreen === 'function' && d.webkitFullscreenEnabled !== false) return 'element-webkit';
  if (typeof (video as WebkitVideo).webkitEnterFullscreen === 'function') return 'video-native';
  return 'none';
}

/** Something on this page is full screen now (the container, the video, or iOS's own player). */
export function isFullscreen(video: HTMLVideoElement, doc: Document): boolean {
  const d = doc as WebkitDocument;
  return !!(doc.fullscreenElement ?? d.webkitFullscreenElement) || (video as WebkitVideo).webkitDisplayingFullscreen === true;
}

/** Handles a refusal of a call that may return a promise (old engines return nothing). */
const onRefusal = (p: unknown, fallback: () => void = () => {}): void => {
  if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(fallback);
};

/**
 * Enters full screen as `fullscreenMode` says, or leaves it when something is full screen.
 * Returns false when the browser cannot do either. A container request the browser refuses (an
 * Android WebView that only honours full screen on a <video>, research §1 risks) falls back to
 * the video's own full screen.
 */
export function toggleFullscreen(container: HTMLElement, video: HTMLVideoElement, doc: Document): boolean {
  const d = doc as WebkitDocument;
  const v = video as WebkitVideo;
  if (doc.fullscreenElement ?? d.webkitFullscreenElement) {
    if (typeof doc.exitFullscreen === 'function') onRefusal(doc.exitFullscreen());
    else d.webkitExitFullscreen?.();
    return true;
  }
  if (v.webkitDisplayingFullscreen === true) {
    v.webkitExitFullscreen?.();
    return true;
  }
  const videoFallback = (): void => {
    if (typeof v.requestFullscreen === 'function') onRefusal(v.requestFullscreen(), () => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.();
  };
  switch (fullscreenMode(container, video, doc)) {
    case 'element':
      onRefusal(container.requestFullscreen(), videoFallback);
      return true;
    case 'element-webkit':
      (container as WebkitElement).webkitRequestFullscreen!();
      return true;
    case 'video-native':
      v.webkitEnterFullscreen!();
      return true;
    case 'none':
      return false;
  }
}

/** Leaves full screen if the page is in it (the live ended, the viewer was removed). */
export function exitFullscreen(video: HTMLVideoElement, doc: Document): void {
  if (isFullscreen(video, doc)) toggleFullscreen(doc.body, video, doc);
}

/** How this browser puts the video in a small floating window, if it can. */
export type PipMode = 'standard' | 'webkit' | 'none';

export function pipMode(video: HTMLVideoElement, doc: Document): PipMode {
  const v = video as WebkitVideo;
  if (doc.pictureInPictureEnabled === true && typeof v.requestPictureInPicture === 'function' && !v.disablePictureInPicture) return 'standard';
  if (typeof v.webkitSetPresentationMode === 'function' && v.webkitSupportsPresentationMode?.('picture-in-picture') === true) return 'webkit';
  return 'none';
}

/** The browser can put the video in a small floating window. */
export function pipSupported(video: HTMLVideoElement, doc: Document): boolean {
  return pipMode(video, doc) !== 'none';
}

/** The video is in its floating window now. */
export function inPip(video: HTMLVideoElement, doc: Document): boolean {
  return (!!doc.pictureInPictureElement && doc.pictureInPictureElement === video) || (video as WebkitVideo).webkitPresentationMode === 'picture-in-picture';
}

export function togglePip(video: HTMLVideoElement, doc: Document): boolean {
  const v = video as WebkitVideo;
  switch (pipMode(video, doc)) {
    case 'standard':
      if (doc.pictureInPictureElement) onRefusal(doc.exitPictureInPicture());
      else onRefusal(v.requestPictureInPicture());
      return true;
    case 'webkit':
      v.webkitSetPresentationMode!(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      return true;
    case 'none':
      return false;
  }
}

/**
 * Whether a volume set by the page sticks: false on iOS and iPadOS, where `volume` always reads
 * 1 and only the hardware buttons change it. Probes with a value next to the current one and
 * puts the current one back.
 */
export function volumeSettable(video: HTMLVideoElement): boolean {
  const before = video.volume;
  const probe = before > 0.5 ? before - 0.25 : before + 0.25;
  try {
    video.volume = probe;
    const ok = Math.abs(video.volume - probe) < 0.01;
    video.volume = before;
    return ok;
  } catch {
    return false;
  }
}
