/**
 * The watch page's theater mode, keyboard shortcuts (and their list) and "stats for nerds",
 * wired to the page (watch.html) and the player. watch.ts calls installPlayerExtras() once, with
 * what only it knows: the player's counters, the adaptive delay, hls.js once it exists.
 *
 * Full screen is the video's own (the browser's full-screen player, with its controls); on iPhone
 * that is the only kind there is (webkitEnterFullscreen).
 */
import { createTheater, type Theater } from './theater.js';
import { installShortcuts, type PrefStorage, type ShortcutAction, type Shortcuts } from './shortcuts.js';
import { createStatsToggle, type StatsToggle } from './stats-toggle.js';
import type { StatsSource } from './stats-overlay.js';

/** Vendor-prefixed full-screen and picture-in-picture calls (Safari, iOS). */
interface WebkitVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitRequestFullscreen?: () => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  webkitDisplayingFullscreen?: boolean;
}
interface WebkitDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

const quiet = (p: unknown): void => {
  if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {});
};

/** The video in the browser's full screen, or back out of it. */
export function toggleFullscreen(video: HTMLVideoElement, doc: Document = document): boolean {
  const v = video as WebkitVideo;
  const d = doc as WebkitDocument;
  if (doc.fullscreenElement ?? d.webkitFullscreenElement) {
    if (typeof doc.exitFullscreen === 'function') quiet(doc.exitFullscreen());
    else d.webkitExitFullscreen?.();
    return true;
  }
  if (typeof v.requestFullscreen === 'function') quiet(v.requestFullscreen());
  else if (typeof v.webkitRequestFullscreen === 'function') v.webkitRequestFullscreen();
  else if (typeof v.webkitEnterFullscreen === 'function') v.webkitEnterFullscreen();
  else return false;
  return true;
}

/** The browser can put the video in a small floating window (Chrome, Edge, Safari; not Firefox's API-less button). */
export function pipSupported(video: HTMLVideoElement, doc: Document = document): boolean {
  const v = video as WebkitVideo;
  if (doc.pictureInPictureEnabled === true && typeof v.requestPictureInPicture === 'function' && !v.disablePictureInPicture) return true;
  return typeof v.webkitSetPresentationMode === 'function' && v.webkitSupportsPresentationMode?.('picture-in-picture') === true;
}

export function togglePip(video: HTMLVideoElement, doc: Document = document): boolean {
  const v = video as WebkitVideo;
  if (doc.pictureInPictureEnabled === true && typeof v.requestPictureInPicture === 'function') {
    if (doc.pictureInPictureElement) quiet(doc.exitPictureInPicture());
    else quiet(v.requestPictureInPicture());
    return true;
  }
  if (typeof v.webkitSetPresentationMode === 'function') {
    v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    return true;
  }
  return false;
}

export interface PlayerExtrasDeps {
  doc: Document;
  video: HTMLVideoElement;
  /** "LIVE / Go live" and "Unmute" (watch.html), driven by G and M like a click. */
  goLive: HTMLButtonElement;
  unmute: HTMLButtonElement;
  /** The chat column (C focuses its box when it shows). */
  chatRoot: HTMLElement;
  storage: PrefStorage | undefined;
  stats: StatsSource;
  clipboard?: { writeText(text: string): Promise<void> };
  debug?: (msg: string) => void;
}

export interface PlayerExtras {
  theater: Theater;
  shortcuts: Shortcuts;
  stats: StatsToggle;
  /** Runs what a shortcut does (tests and the page's own buttons). */
  run(action: ShortcutAction): boolean;
}

export function installPlayerExtras(d: PlayerExtrasDeps): PlayerExtras {
  const { doc, video } = d;
  const byId = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;

  const theater = createTheater({ body: doc.body, button: byId<HTMLButtonElement>('theater'), storage: d.storage });
  const stats = createStatsToggle({
    button: byId<HTMLButtonElement>('stats-open'),
    host: byId<HTMLElement>('stats'),
    source: d.stats,
    ...(d.clipboard ? { clipboard: d.clipboard } : {}),
    ...(d.debug ? { debug: d.debug } : {}),
  });

  // The list of shortcuts: a modal dialog (Esc and its × close it and give the focus back), with
  // the on / off switch. The picture-in-picture line only where the browser has it.
  const help = byId<HTMLDialogElement>('keys-help');
  const helpSwitch = byId<HTMLInputElement>('keys-on');
  const canPip = pipSupported(video, doc);
  help.querySelector<HTMLElement>('[data-key="pip"]')?.toggleAttribute('hidden', !canPip);
  const openHelp = (): void => {
    helpSwitch.checked = shortcuts.enabled;
    if (help.open) return;
    if (typeof help.showModal === 'function') help.showModal();
    else help.setAttribute('open', '');
  };
  const closeHelp = (): void => {
    if (typeof help.close === 'function') help.close();
    else help.removeAttribute('open');
  };
  byId<HTMLButtonElement>('keys-open').addEventListener('click', openHelp);
  byId<HTMLButtonElement>('keys-close').addEventListener('click', closeHelp);
  // A click on the backdrop (outside the sheet) closes it too.
  help.addEventListener('click', (e) => {
    if (e.target === help) closeHelp();
  });

  const run = (action: ShortcutAction): boolean => {
    switch (action) {
      case 'play-pause':
        if (video.paused) {
          void video.play().catch(() => {
            d.unmute.hidden = false;
          });
        } else video.pause();
        return true;
      case 'mute':
        video.muted = !video.muted;
        // The "Unmute" button is there while the sound is off, as after the muted autoplay.
        d.unmute.hidden = !video.muted;
        return true;
      case 'fullscreen':
        return toggleFullscreen(video, doc);
      case 'theater':
        theater.toggle();
        return true;
      case 'go-live':
        if (d.goLive.hidden) return false;
        d.goLive.click();
        return true;
      case 'pip':
        return canPip && togglePip(video, doc);
      case 'chat': {
        const box = d.chatRoot.hidden ? null : d.chatRoot.querySelector<HTMLTextAreaElement>('textarea:not([disabled])');
        if (!box || box.offsetParent === null) return false;
        box.focus();
        return true;
      }
      case 'stats':
        stats.toggle();
        return true;
      case 'help':
        openHelp();
        return true;
    }
  };

  const shortcuts = installShortcuts({ target: doc, storage: d.storage, run });
  helpSwitch.checked = shortcuts.enabled;
  helpSwitch.addEventListener('change', () => {
    shortcuts.enabled = helpSwitch.checked;
  });

  return { theater, shortcuts, stats, run };
}
