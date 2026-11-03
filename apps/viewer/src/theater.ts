/**
 * Theater mode: the video as big as the window on a computer (style.css, `.watch.theater`). The
 * page already gives the video the whole width beside the chat; theater mode also gives it the
 * whole height of the window (black around the picture), with the info row and the rest a scroll
 * away and the chat still beside it. Where the chat is under the video (phones, narrow windows)
 * the video already takes the whole width, so there the button is hidden and the mode changes
 * nothing.
 *
 * The button says whether the mode is on (aria-pressed); the T key toggles it too (shortcuts.ts).
 * The choice is remembered in this browser.
 */
import type { PrefStorage } from './shortcuts.js';

export const THEATER_PREF_KEY = 'swarmcast.theater';

export function loadTheater(storage: PrefStorage | undefined): boolean {
  try {
    return storage?.getItem(THEATER_PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveTheater(storage: PrefStorage | undefined, on: boolean): void {
  try {
    storage?.setItem(THEATER_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

export interface TheaterDeps {
  /** The page's body: gets the `theater` class. */
  body: HTMLElement;
  button: HTMLButtonElement;
  storage: PrefStorage | undefined;
}

export interface Theater {
  readonly on: boolean;
  toggle(): void;
  set(on: boolean): void;
}

export function createTheater({ body, button, storage }: TheaterDeps): Theater {
  let on = false;
  const apply = (next: boolean): void => {
    on = next;
    body.classList.toggle('theater', on);
    button.setAttribute('aria-pressed', String(on));
  };
  apply(loadTheater(storage));
  button.hidden = false;
  const set = (next: boolean): void => {
    apply(next);
    saveTheater(storage, next);
  };
  button.addEventListener('click', () => set(!on));
  return {
    get on() {
      return on;
    },
    toggle: () => set(!on),
    set,
  };
}
