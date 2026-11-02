/**
 * When the player's own controls (player-controls.ts) show, as a small state machine with its
 * clock injected (unit-tested without timers):
 *
 * - While the video does not play (paused, not started, ended) they always show.
 * - While it plays they show after any activity (the pointer moving over the player, a touch, a
 *   key, a shortcut) and fade out CONTROLS_HIDE_AFTER_MS after the last one.
 * - They never fade while "pinned": the keyboard focus is inside them, a menu of theirs is open,
 *   the mouse rests on the bar, or the viewer asked the system for reduced motion (things that
 *   appear and vanish by themselves are what that setting is for; research §1 "Accessibility").
 * - A touch on the video while they show hides them at once (as video apps do); the mouse
 *   leaving the player hides them at once too.
 */

/** Fade out after this long without activity while playing (YouTube: about 3 s). */
export const CONTROLS_HIDE_AFTER_MS = 3000;

/** Why the controls must stay (each one holds them until released). */
export type ControlsPin = 'focus' | 'menu' | 'hover' | 'reduced-motion';

export interface VisibilityDeps {
  /** Runs `fn` after `ms`; returns the cancel function (setTimeout / clearTimeout in the page). */
  schedule(fn: () => void, ms: number): () => void;
  /** Called with the new value each time it changes. */
  onChange(visible: boolean): void;
  hideAfterMs?: number;
}

export class ControlsVisibility {
  private playingNow = false;
  private readonly pins = new Set<ControlsPin>();
  /** Activity happened within hideAfterMs (the fade-out timer runs). */
  private recent = false;
  private cancel: (() => void) | null = null;
  private shown = true;
  private readonly hideAfterMs: number;

  constructor(private readonly d: VisibilityDeps) {
    this.hideAfterMs = d.hideAfterMs ?? CONTROLS_HIDE_AFTER_MS;
  }

  get visible(): boolean {
    return this.shown;
  }

  get playing(): boolean {
    return this.playingNow;
  }

  /** The video plays (a short hold inside a stall counts as playing: nothing changes for the viewer). */
  setPlaying(on: boolean): void {
    if (on === this.playingNow) return;
    this.playingNow = on;
    // Starting to play keeps them for the usual time, so the viewer sees what they pressed.
    if (on) this.restart();
    this.update();
  }

  pin(why: ControlsPin, on: boolean): void {
    if (on) this.pins.add(why);
    else if (this.pins.delete(why)) this.restart();
    this.update();
  }

  /** Pointer moved, touch, key: show them and start the fade-out time again. */
  activity(): void {
    this.restart();
    this.update();
  }

  /** Hide now (a touch on the video while they show, the mouse leaving the player), unless something holds them. */
  hide(): void {
    this.stop();
    this.update();
  }

  /** A touch on the video: hide when shown, show when hidden. */
  toggle(): void {
    if (this.shown) this.hide();
    else this.activity();
  }

  private restart(): void {
    this.stop();
    this.recent = true;
    this.cancel = this.d.schedule(() => {
      this.cancel = null;
      this.recent = false;
      this.update();
    }, this.hideAfterMs);
  }

  private stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.recent = false;
  }

  private update(): void {
    const next = !this.playingNow || this.pins.size > 0 || this.recent;
    if (next === this.shown) return;
    this.shown = next;
    this.d.onChange(next);
  }
}
