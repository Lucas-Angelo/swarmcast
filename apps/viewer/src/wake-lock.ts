/**
 * Keeps the screen on while the stream plays (Screen Wake Lock API). Phones dim and lock after
 * a minute or so without a touch, which a viewer watching a live does not want.
 *
 * - Held while playing (muted too), let go on pause, at the end screen and when something asks
 *   for it (`block`, e.g. the audio-only mode, which needs no screen).
 * - The browser lets go by itself when the page is hidden (another tab, the phone locked): it is
 *   asked for again once the page is visible and still playing.
 * - Where the API is missing (Firefox < 126, Safari < 16.4, Android WebView) or refuses (battery
 *   saver: NotAllowedError), nothing happens and nothing is shown. No hidden looping video as a
 *   fallback: it costs battery and fights the player's own media on iOS.
 */

/** What the controller needs of WakeLockSentinel. */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** What the controller needs of navigator.wakeLock. */
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** What the controller needs of the document: its visibility and the event that reports changes. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Why the screen may go dark although the stream plays (audio-only, the end screen). */
export type WakeBlock = 'audio-only' | 'ended';

export type ScreenAwakeState = 'unsupported' | 'off' | 'requesting' | 'held';

export interface ScreenAwake {
  /** The player plays (true) or is paused or stopped (false). */
  setPlaying(playing: boolean): void;
  /** Lets go of the screen for `reason` (true) until the same reason is lifted (false). */
  block(reason: WakeBlock, blocked: boolean): void;
  /** For diagnostics and tests (window.__swarmcast.wakeLock). */
  readonly state: ScreenAwakeState;
}

export interface ScreenAwakeDeps {
  /** navigator.wakeLock, or undefined where the browser has none. */
  wakeLock: WakeLockLike | undefined;
  doc: VisibilitySource;
  debug?: (msg: string) => void;
}

/** The controller; it asks for nothing until the player says it plays. */
export function createScreenAwake({ wakeLock, doc, debug }: ScreenAwakeDeps): ScreenAwake {
  let playing = false;
  const blocks = new Set<WakeBlock>();
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;

  const wanted = (): boolean => playing && blocks.size === 0 && doc.visibilityState === 'visible';

  const update = (): void => {
    if (!wakeLock) return;
    if (!wanted()) {
      const held = sentinel;
      sentinel = null;
      if (held && !held.released) void held.release().catch(() => {});
      return;
    }
    if (sentinel || requesting) return;
    requesting = true;
    wakeLock.request('screen').then(
      (s) => {
        requesting = false;
        // Paused, blocked or hidden while the request was on its way: give it straight back.
        if (!wanted()) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        // The browser lets go by itself when the page is hidden; asked for again when visible.
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
      },
      (err: unknown) => {
        // Battery saver, a page without user activation yet (Safari) or a hidden page: no error
        // for the viewer; the next play or visibility change asks again.
        requesting = false;
        debug?.(`screen wake lock refused: ${err instanceof Error ? err.name : String(err)}`);
      },
    );
  };

  doc.addEventListener('visibilitychange', update);

  return {
    setPlaying(on) {
      playing = on;
      update();
    },
    block(reason, blocked) {
      if (blocked) blocks.add(reason);
      else blocks.delete(reason);
      update();
    },
    get state(): ScreenAwakeState {
      if (!wakeLock) return 'unsupported';
      if (sentinel && !sentinel.released) return 'held';
      return requesting ? 'requesting' : 'off';
    },
  };
}
