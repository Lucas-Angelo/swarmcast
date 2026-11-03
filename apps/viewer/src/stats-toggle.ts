// The only "stats for nerds" code in the watch page's main bundle: the link that opens and closes
// the panel. The panel itself (stats-overlay.ts and its styles) is a chunk of its own, loaded the
// first time the viewer opens it: closed, it costs nothing (no code, no timer).
import type { StatsPanel, StatsPanelDeps, StatsSource } from './stats-overlay.js';

export type MountStatsPanel = (d: StatsPanelDeps) => StatsPanel;

export interface StatsToggleDeps {
  /** The "Stats for nerds" link (aria-expanded follows the panel). */
  button: HTMLButtonElement;
  /**
   * Where the focus goes back when the panel closes and the link is out of sight (it is in the
   * Settings menu, which closes when the panel opens): the menu's button.
   */
  fallbackFocus?: HTMLElement | null;
  /** The empty, hidden container in the player. */
  host: HTMLElement;
  source: StatsSource;
  clipboard?: { writeText(text: string): Promise<void> };
  /** Loads the chunk (by default the lazy import Vite splits off the main bundle). */
  load?: () => Promise<MountStatsPanel>;
  debug?: (msg: string) => void;
}

export interface StatsToggle {
  readonly open: boolean;
  toggle(): void;
  close(): void;
}

export function createStatsToggle(d: StatsToggleDeps): StatsToggle {
  const load = d.load ?? (() => import('./stats-overlay.js').then((m) => m.mountStatsPanel));
  let open = false;
  let panel: StatsPanel | null = null;
  // A newer open or close wins over a load still on its way.
  let seq = 0;

  const show = (): void => {
    const mine = ++seq;
    open = true;
    d.button.setAttribute('aria-expanded', 'true');
    load()
      .then((mount) => {
        if (mine !== seq || !open) return;
        d.host.hidden = false;
        panel = mount({ host: d.host, source: d.source, onClose: () => hide(true), ...(d.clipboard ? { clipboard: d.clipboard } : {}) });
      })
      .catch((err: unknown) => {
        d.debug?.(`stats chunk failed: ${String(err)}`);
        if (mine === seq) hide(false);
      });
  };

  const hide = (refocus: boolean): void => {
    seq++;
    const hadFocus = d.host.contains(d.host.ownerDocument.activeElement);
    open = false;
    panel?.destroy();
    panel = null;
    d.host.hidden = true;
    d.button.setAttribute('aria-expanded', 'false');
    if (refocus || hadFocus) {
      const shown = d.button.getClientRects().length > 0;
      (shown || !d.fallbackFocus ? d.button : d.fallbackFocus).focus({ preventScroll: true });
    }
  };

  d.host.hidden = true;
  d.button.setAttribute('aria-expanded', 'false');
  d.button.addEventListener('click', () => (open ? hide(false) : show()));

  return {
    get open() {
      return open;
    },
    toggle: () => (open ? hide(false) : show()),
    close: () => hide(false),
  };
}
