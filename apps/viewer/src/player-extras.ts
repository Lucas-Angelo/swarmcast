/**
 * The watch page's theater mode, keyboard shortcuts (and their list) and "stats for nerds",
 * wired to the page (watch.html) and the player. watch.ts calls installPlayerExtras() once, with
 * what only it knows: the player's counters, the adaptive delay, hls.js once it exists.
 *
 * Full screen (F) is the player container's, with our own controls in it, wherever the browser
 * lets an element go full screen; on iPhone only the video can, in iOS's own player
 * (player-caps.ts). The shortcuts work the same with or without the player's own controls
 * (player-controls.ts): a page whose controls failed to mount keeps them.
 */
import { createTheater, type Theater } from './theater.js';
import { installShortcuts, type PrefStorage, type ShortcutAction, type Shortcuts } from './shortcuts.js';
import { createStatsToggle, type StatsToggle } from './stats-toggle.js';
import type { StatsSource } from './stats-overlay.js';
import { pipSupported, toggleFullscreen, togglePip } from './player-caps.js';

export interface PlayerExtrasDeps {
  doc: Document;
  video: HTMLVideoElement;
  /** The player container (`.player`): what F puts in full screen. */
  player: HTMLElement;
  /** "LIVE / Go live" and "Unmute" (watch.html), driven by G and M like a click. */
  goLive: HTMLButtonElement;
  unmute: HTMLButtonElement;
  /** The chat column (C focuses its box when it shows). */
  chatRoot: HTMLElement;
  storage: PrefStorage | undefined;
  stats: StatsSource;
  clipboard?: { writeText(text: string): Promise<void> };
  debug?: (msg: string) => void;
  /** A shortcut ran (player-controls.ts shows its bar for a moment, so the viewer sees what changed). */
  onAction?: (action: ShortcutAction) => void;
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
        return toggleFullscreen(d.player, video, doc);
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

  const shortcuts = installShortcuts({
    target: doc,
    storage: d.storage,
    run: (action) => {
      const done = run(action);
      if (done) d.onAction?.(action);
      return done;
    },
  });
  helpSwitch.checked = shortcuts.enabled;
  helpSwitch.addEventListener('change', () => {
    shortcuts.enabled = helpSwitch.checked;
  });

  return { theater, shortcuts, stats, run };
}
