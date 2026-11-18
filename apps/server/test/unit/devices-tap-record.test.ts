import { describe, expect, it } from 'vitest';
import { describeTap, fingerDownMs, LONG_PRESS_MS, parseTapEvents } from '../devices/tap-record.js';

// How the device suite reads and describes a tap's record (apps/server/test/devices/tap-record.ts):
// the page's `type[>element]@stamp:handled` entries, the finger's time down, when the finger was
// lifted against the answer to Perform Actions on iOS, and a long press named as such. The iOS
// record is the one of the tap on #join in release rehearsal 44243243561 (the times of the test
// process and of safaridriver's log of that run): the finger stayed down until Release Actions.

const STARTED = 1794979761578;
const ANSWERED = 1794979762865;
const PERFORMED = STARTED + 2765;
const HELD_UNTIL_RELEASE = 'touchstart@1794979761594:1794979761607 touchend@1794979763915:1794979763922 ';
const QUICK_TAP = 'touchstart@1794979761594:1794979761607 touchend@1794979761610:1794979761620 mouseover@1794979761630:1794979761631 mousedown@1794979761632:1794979761633 click@1794979761634:1794979761635 ';

describe('a device tap record', () => {
  it('reads each entry with its type, the element it reached elsewhere, its time stamp and when the page handled it', () => {
    // Act
    const events = parseTapEvents('touchstart@10:12 shown>info@15:15 click>player@20:21 bogus@1:2 ');
    // Assert
    expect(events).toEqual([
      { type: 'touchstart', stamp: 10, handled: 12 },
      { type: 'shown', elsewhere: 'info', stamp: 15, handled: 15 },
      { type: 'click', elsewhere: 'player', stamp: 20, handled: 21 },
      { type: '?', stamp: 1, handled: 2 },
    ]);
  });

  it('times the finger from the touchstart to the touchend on the element, and has no time without both', () => {
    // Act
    const held = fingerDownMs(parseTapEvents(HELD_UNTIL_RELEASE));
    const unfinished = fingerDownMs(parseTapEvents('touchstart@10:12 '));
    // Assert
    expect(held).toBe(2321);
    expect(unfinished).toBeNull();
  });

  it('says a finger lifted after Perform Actions was answered was lifted by Release Actions, and calls 2.3 s down a long press on iOS', () => {
    // Act
    const text = describeTap(parseTapEvents(HELD_UNTIL_RELEASE), { started: STARTED, performed: PERFORMED, answered: ANSWERED, longPressMs: LONG_PRESS_MS.ios });
    // Assert
    expect(text).toBe(
      'events: touchstart, touchend; actions performed in 2765 ms; touchstart 29 ms after the actions began; finger down 2321 ms by time stamps, 2315 ms as handled; ' +
        "lifted 1050 ms after the actions were answered (by Release Actions, not by the tap's own actions); a long press (500 ms or more)",
    );
  });

  it('says a quick tap was lifted before the actions were answered, and calls it no long press', () => {
    // Act
    const text = describeTap(parseTapEvents(QUICK_TAP), { started: STARTED, performed: STARTED + 80, answered: STARTED + 60, longPressMs: LONG_PRESS_MS.ios });
    // Assert
    expect(text).toBe(
      'events: touchstart, touchend, mouseover, mousedown, click; actions performed in 80 ms; touchstart 29 ms after the actions began; finger down 16 ms by time stamps, 13 ms as handled; ' +
        'lifted 28 ms before the actions were answered; then the click 15 ms after touchend',
    );
  });

  it.each([
    { platform: 'android' as const, downMs: 399, longPress: false },
    { platform: 'android' as const, downMs: 400, longPress: true },
    { platform: 'ios' as const, downMs: 499, longPress: false },
    { platform: 'ios' as const, downMs: 500, longPress: true },
  ])('a finger down $downMs ms on $platform is a long press: $longPress', ({ platform, downMs, longPress }) => {
    // Arrange
    const events = parseTapEvents(`touchstart@1000:1001 touchend@${1000 + downMs}:${1001 + downMs} click@${1010 + downMs}:${1011 + downMs} `);
    // Act
    const text = describeTap(events, { started: 990, performed: 1020 + downMs, longPressMs: LONG_PRESS_MS[platform] });
    // Assert
    expect(text.includes('a long press')).toBe(longPress);
    expect(text).not.toContain('lifted');
  });

  it('leaves the names of other elements out of the line for the file', () => {
    // Act
    const text = describeTap(parseTapEvents('touchstart@1000:1001 shown>secret_name@1002:1002 touchend@1010:1011 mouseover@1012:1013 '), { started: 990, performed: 1020, longPressMs: LONG_PRESS_MS.ios }, false);
    // Assert
    expect(text).toBe('events: touchstart, shown>element, touchend, mouseover; actions performed in 30 ms; touchstart 11 ms after the actions began; finger down 10 ms by time stamps, 10 ms as handled; taken for a hover (mouse moved, no press): the page revealed an element during the tap');
  });
});
