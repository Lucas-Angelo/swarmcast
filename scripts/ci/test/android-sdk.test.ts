// .github/scripts/android-sdk.mjs: when main's build stage saves the device suite's Android SDK
// archives again. A copy must always be there for the devices jobs, which run on main by hand
// only, so main saves a new one well before the newest expires, and not on every run.
import { describe, expect, it } from 'vitest';
import { needsSave, REFRESH_MS } from '../../../.github/scripts/android-sdk.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest copy, expiring `days` days after NOW. */
function expiringIn(days: number) {
  return { expires_at: new Date(NOW + days * DAY_MS).toISOString() };
}

describe('needsSave', () => {
  it('saves when main has no copy yet', () => {
    // Act
    const save = needsSave(null, NOW);

    // Assert
    expect(save).toBe(true);
  });

  it('saves nothing while the newest copy has more than the refresh window left', () => {
    // Arrange
    const fresh = expiringIn(89);
    const older = expiringIn(REFRESH_MS / DAY_MS + 1);

    // Act
    const saves = [needsSave(fresh, NOW), needsSave(older, NOW)];

    // Assert
    expect(saves).toEqual([false, false]);
  });

  it('saves a new copy once the newest is inside the refresh window', () => {
    // Arrange
    const ageing = expiringIn(REFRESH_MS / DAY_MS - 1);
    const lastHour = expiringIn(1 / 24);

    // Act
    const saves = [needsSave(ageing, NOW), needsSave(lastHour, NOW)];

    // Assert
    expect(saves).toEqual([true, true]);
  });
});
