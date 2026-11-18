// A tap's record as the page keeps it (actionability.ts armTap), read and described for the log
// and a failure message: pure, so the unit tests read it too (test/unit/devices-tap-record.test.ts).
import type { Platform } from './phone.js';

/** The entries armTap records. */
const TAP_TYPES = ['touchstart', 'touchend', 'mouseover', 'mousedown', 'click', 'shown'] as const;

/**
 * One entry of a tap's record: its type, the element it reached when that was not the tapped one
 * (for `shown`, the element revealed), its time stamp and when the page handled it (epoch ms).
 */
export interface TapEvent {
  type: (typeof TAP_TYPES)[number] | '?';
  elsewhere?: string;
  stamp: number;
  handled: number;
}

/**
 * The page's record (`type[>element]@stamp:handled ...`). It comes from the page, so the type is
 * taken from TAP_TYPES and the times are numbers; only an element's name is the page's own text,
 * and describeTap leaves it out of what is written to taps.log.
 */
export function parseTapEvents(record: string): TapEvent[] {
  return record
    .split(' ')
    .filter(Boolean)
    .map((entry) => {
      const [what = '', times = ''] = entry.split('@');
      const [raw = '', elsewhere] = what.split('>');
      const [stamp = NaN, handled = NaN] = times.split(':').map(Number);
      return { type: TAP_TYPES.find((t) => t === raw) ?? '?', ...(elsewhere === undefined ? {} : { elsewhere }), stamp, handled };
    });
}

/**
 * The finger's time down from which each phone takes a touch for a long press, not a tap: UIKit's
 * long-press recognizers (UILongPressGestureRecognizer's minimumPressDuration, 0.5 s; Safari's
 * text selection and drag lift at the point began 0.57 s after the touch in release rehearsal
 * 44243243561), and Android's ViewConfiguration long-press timeout (400 ms since Android 12),
 * which Chrome's gesture detector uses. A finger held that long was the harness's doing (the
 * driver, a loaded host), not the page's: the touch is no tap, whatever followed it.
 */
export const LONG_PRESS_MS: Readonly<Record<Platform, number>> = { ios: 500, android: 400 };

/** When a tap was performed (epoch ms, the test process's clock, the one the page's time stamps are on). */
export interface TapTiming {
  /** The driver was asked to tap. */
  started: number;
  /** The driver's last command for the tap was answered. */
  performed: number;
  /** iOS: the test process read the answer to Perform Actions (webdriver.ts Session.perform); a lift after it was Release Actions'. */
  answered?: number;
  /** The phone's LONG_PRESS_MS. */
  longPressMs: number;
}

/** The finger's time down by the time stamps of the touchstart and touchend on the element, or null without both. */
export function fingerDownMs(events: readonly TapEvent[]): number | null {
  const down = events.find((e) => e.type === 'touchstart' && e.elsewhere === undefined);
  const up = events.find((e) => e.type === 'touchend' && e.elsewhere === undefined);
  return down && up ? up.stamp - down.stamp : null;
}

/**
 * What a tap delivered and when, for the log and a failure message: the events in order, the
 * finger's time down (touchstart to touchend, by the events' time stamps and by when the page
 * handled them), on iOS when the finger was lifted against the answer to Perform Actions (after
 * it, only Release Actions can have lifted it), and the click's delay after touchend. "click"
 * appears only when one arrived on the element; one elsewhere is "click>element"
 * ("click>elsewhere" without `names`, for the file). A finger held for LONG_PRESS_MS or more is
 * named a long press. A touch that ended in no click names the controls the page revealed from
 * touchstart on, and whether WebKit took the tap for a hover (moved the mouse, pressed nothing).
 */
export function describeTap(events: readonly TapEvent[], t: TapTiming, names = true): string {
  const own = (type: string) => events.find((e) => e.type === type && e.elsewhere === undefined);
  const down = own('touchstart');
  const up = own('touchend');
  const click = own('click');
  const held = fingerDownMs(events);
  const label = (e: TapEvent) => (e.elsewhere === undefined ? e.type : `${e.type}>${names ? e.elsewhere : e.type === 'shown' ? 'element' : 'elsewhere'}`);
  // What the page revealed before the touch is not the tap's business: actionablePoint waited it out.
  const during = events.filter((e) => e.type !== 'shown' || (down !== undefined && e.handled >= down.handled));
  const parts = [`events: ${during.map(label).join(', ') || '(none)'}`, `actions performed in ${t.performed - t.started} ms`];
  if (down) parts.push(`touchstart ${down.handled - t.started} ms after the actions began`);
  if (down && up) parts.push(`finger down ${held} ms by time stamps, ${up.handled - down.handled} ms as handled`);
  if (up && t.answered !== undefined) {
    const by = t.answered - up.stamp;
    parts.push(by >= 0 ? `lifted ${by} ms before the actions were answered` : `lifted ${-by} ms after the actions were answered (by Release Actions, not by the tap's own actions)`);
  }
  if (held !== null && held >= t.longPressMs) parts.push(`a long press (${t.longPressMs} ms or more)`);
  if (up && click) parts.push(`then the click ${click.handled - up.handled} ms after touchend`);
  if (down && !click) {
    const over = own('mouseover');
    const shown = during.filter((e) => e.type === 'shown').map((e) => (names ? e.elsewhere : 'an element'));
    const revealed = shown.length > 0 ? `the page revealed ${shown.join(', ')} during the tap` : '';
    if (over && !own('mousedown')) parts.push(`taken for a hover (mouse moved, no press)${revealed ? `: ${revealed}` : ''}`);
    else if (revealed) parts.push(revealed);
  }
  return parts.join('; ');
}
