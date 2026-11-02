// When the player's controls show (controls-visibility.ts), on a controlled clock: always while
// the video does not play; while it plays, for CONTROLS_HIDE_AFTER_MS after the last activity;
// never fading while pinned (keyboard focus, an open menu, the mouse on the bar, reduced motion);
// a touch on the video hides them at once or brings them back.
import { describe, expect, it } from 'vitest';
import { CONTROLS_HIDE_AFTER_MS, ControlsVisibility } from '../../src/controls-visibility.js';

/** A clock the test moves by hand. */
class FakeClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      next.live = false;
      next.fn();
    }
    this.t = end;
  }
}

function setup() {
  const clock = new FakeClock();
  const changes: boolean[] = [];
  const v = new ControlsVisibility({ schedule: clock.schedule, onChange: (on) => changes.push(on) });
  return { clock, v, changes };
}

describe('controls visibility', () => {
  it('shown while the video does not play, however long nothing happens', () => {
    // Arrange
    const { clock, v } = setup();
    // Act
    clock.advance(60_000);
    // Assert
    expect(v.visible).toBe(true);
  });

  it('while playing: shown for the hide delay after it starts, then faded; activity brings them back for the same time', () => {
    // Arrange
    const { clock, v, changes } = setup();
    // Act
    v.setPlaying(true);
    clock.advance(CONTROLS_HIDE_AFTER_MS - 1);
    const before = v.visible;
    clock.advance(1);
    // Assert
    expect(before).toBe(true);
    expect(v.visible).toBe(false);
    // Act
    v.activity();
    clock.advance(CONTROLS_HIDE_AFTER_MS / 2);
    v.activity();
    clock.advance(CONTROLS_HIDE_AFTER_MS - 1);
    // Assert: the second activity started the time again
    expect(v.visible).toBe(true);
    // Act
    clock.advance(1);
    // Assert
    expect(v.visible).toBe(false);
    expect(changes).toEqual([false, true, false]);
  });

  it('pausing shows them at once and keeps them', () => {
    // Arrange
    const { clock, v } = setup();
    v.setPlaying(true);
    clock.advance(CONTROLS_HIDE_AFTER_MS);
    // Act
    v.setPlaying(false);
    clock.advance(CONTROLS_HIDE_AFTER_MS * 5);
    // Assert
    expect(v.visible).toBe(true);
  });

  it.each(['focus', 'menu', 'hover', 'reduced-motion'] as const)('pinned by %s: never fades while held; released, it fades after the usual delay', (why) => {
    // Arrange
    const { clock, v } = setup();
    v.setPlaying(true);
    // Act
    v.pin(why, true);
    clock.advance(CONTROLS_HIDE_AFTER_MS * 10);
    v.hide();
    // Assert
    expect(v.visible).toBe(true);
    // Act
    v.pin(why, false);
    clock.advance(CONTROLS_HIDE_AFTER_MS - 1);
    const stillThere = v.visible;
    clock.advance(1);
    // Assert
    expect(stillThere).toBe(true);
    expect(v.visible).toBe(false);
  });

  it('two pins: released one at a time, they stay until the last one goes', () => {
    // Arrange
    const { clock, v } = setup();
    v.setPlaying(true);
    v.pin('focus', true);
    v.pin('menu', true);
    // Act
    v.pin('menu', false);
    clock.advance(CONTROLS_HIDE_AFTER_MS * 2);
    // Assert
    expect(v.visible).toBe(true);
  });

  it('a touch on the video: hides them when shown, shows them when faded', () => {
    // Arrange
    const { clock, v } = setup();
    v.setPlaying(true);
    // Act
    v.toggle();
    // Assert
    expect(v.visible).toBe(false);
    // Act
    v.toggle();
    // Assert
    expect(v.visible).toBe(true);
    clock.advance(CONTROLS_HIDE_AFTER_MS);
    expect(v.visible).toBe(false);
  });

  it('hide() while paused changes nothing (the controls are the only way to play again)', () => {
    // Arrange
    const { v, changes } = setup();
    // Act
    v.hide();
    // Assert
    expect(v.visible).toBe(true);
    expect(changes).toEqual([]);
  });
});
