import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsSchema, type ServerMessage } from '@swarmcast/shared';
import { configSchema, defaultConfig } from '../../src/core/config.js';
import { VIEWER_COUNT_INTERVAL_MS, type LiveController } from '../../src/core/live.js';
import { joinViewer } from './helpers-b.js';
import { makeController } from './live-helpers.js';

// The viewer count viewers see: on by default, only the number (never who joined), pushed at most
// once every VIEWER_COUNT_INTERVAL_MS with the final number of a burst of joins, only when it
// changed, and null once the streamer hides it. It counts the sessions the panel counts as
// "Watching". The clock is fake. The pushes are read from the control channel's broadcasts.
//
// Regression (flaky e2e "viewers see how many people are watching"): the count went 2 -> 0 -> 2
// within one throttle window, and viewer A got "1" in its hello between the two pushes. The push of
// "2" must still go out although the last broadcast was also 2.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A live that began, and every message it broadcast to viewers so far. */
function live(): { live: LiveController; sent: () => ServerMessage[] } {
  const { live } = makeController();
  const broadcast = vi.spyOn(live.control, 'broadcast');
  live.access.begin();
  return { live, sent: () => broadcast.mock.calls.map(([m]) => m) };
}

/** The viewer counts among `sent`, in order. */
const counts = (sent: ServerMessage[]): (number | null)[] => sent.flatMap((m) => (m.t === 'viewers' ? [m.count] : []));

/** Ana joined and her count went out; then Bia and Caio joined right away. */
function threeJoinedInABurst() {
  const l = live();
  joinViewer(l.live.access, 'ana');
  vi.advanceTimersByTime(0);
  joinViewer(l.live.access, 'bia', { device: 'mobile' });
  joinViewer(l.live.access, 'caio');
  return l;
}

describe('viewer count for viewers', () => {
  it.each([
    ['the default config', () => defaultConfig().showViewerCount],
    ['a saved config without the setting', () => configSchema.parse({}).showViewerCount],
    ['a settings update without it', () => settingsSchema.parse({ uploadLimitMbps: 10, autoStopMinutes: 10, alsoStreamingElsewhere: false }).showViewerCount],
  ])('is on by default: %s', (_what, read) => {
    // Act
    const on = read();
    // Assert
    expect(on).toBe(true);
  });

  it('broadcasts only the number, never who joined', () => {
    // Arrange
    const l = live();
    // Act
    joinViewer(l.live.access, 'ana');
    vi.advanceTimersByTime(0);
    // Assert
    expect(counts(l.sent())).toEqual([1]);
    expect(JSON.stringify(l.sent())).not.toContain('ana');
  });

  it('holds more pushes until the throttle window has passed', () => {
    // Arrange
    const l = threeJoinedInABurst();
    // Act
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS - 100);
    // Assert
    expect(counts(l.sent())).toEqual([1]);
  });

  it('then pushes the final number of the burst, once', () => {
    // Arrange
    const l = threeJoinedInABurst();
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS - 100);
    // Act
    vi.advanceTimersByTime(200);
    // Assert
    expect(counts(l.sent())).toEqual([1, 3]);
  });

  it('sends nothing when the number did not change', () => {
    // Arrange
    const l = threeJoinedInABurst();
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS + 100);
    // Act
    l.live.viewerCountChanged();
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS * 2);
    // Assert
    expect(counts(l.sent())).toEqual([1, 3]);
  });

  it('the hello message carries the current count', () => {
    // Arrange
    const l = threeJoinedInABurst();
    // Act
    const hello = l.live.control.viewerCount();
    // Assert
    expect(hello).toBe(3);
  });

  /** Two viewers left and two others came within one throttle window; returns the counts their hellos carried. */
  function twoToZeroToTwo() {
    const l = live();
    joinViewer(l.live.access, 'old1');
    joinViewer(l.live.access, 'old2');
    vi.advanceTimersByTime(0);
    l.live.disconnectAll();
    joinViewer(l.live.access, 'a');
    const helloA = l.live.control.viewerCount();
    joinViewer(l.live.access, 'b');
    const helloB = l.live.control.viewerCount();
    return { ...l, hellos: [helloA, helloB] };
  }

  it('re-sends an unchanged number when a viewer was greeted with another one meanwhile', () => {
    // Arrange
    const l = twoToZeroToTwo();
    // Act
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    // Assert
    expect(l.hellos).toEqual([1, 2]);
    expect(counts(l.sent())).toEqual([2, 2]);
  });

  it('hellos that match what everyone already has cause no extra push', () => {
    // Arrange
    const l = twoToZeroToTwo();
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    // Act
    const hello = l.live.control.viewerCount();
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS * 2);
    // Assert
    expect(hello).toBe(2);
    expect(counts(l.sent())).toEqual([2, 2]);
  });

  it('counts the same sessions as the panel "Watching" stat', () => {
    // Arrange
    const l = live();
    const gone = joinViewer(l.live.access, 'a');
    joinViewer(l.live.access, 'b');
    gone.lastSeenAt = Date.now() - 60_000;
    gone.connections = 0;
    // Act
    const watching = l.live.connectedSessions();
    // Assert
    expect(watching).toHaveLength(1);
    expect(l.live.snapshot().stats.viewersConnected).toBe(1);
    expect(l.live.control.viewerCount()).toBe(1);
  });

  it('when the streamer hides the count, sends null, and hello carries none', () => {
    // Arrange
    const l = live();
    joinViewer(l.live.access, 'a');
    vi.advanceTimersByTime(0);
    // Act
    l.live.updateSettings({ ...l.live.snapshot().settings, showViewerCount: false });
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    // Assert
    expect(counts(l.sent())).toEqual([1, null]);
    expect(l.live.control.viewerCount()).toBeNull();
    expect(l.live.snapshot().settings.showViewerCount).toBe(false);
  });

  it('while hidden, a new viewer sends nothing more', () => {
    // Arrange
    const l = live();
    joinViewer(l.live.access, 'a');
    vi.advanceTimersByTime(0);
    l.live.updateSettings({ ...l.live.snapshot().settings, showViewerCount: false });
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    // Act
    joinViewer(l.live.access, 'b');
    vi.advanceTimersByTime(VIEWER_COUNT_INTERVAL_MS);
    // Assert
    expect(counts(l.sent())).toEqual([1, null]);
  });
});
