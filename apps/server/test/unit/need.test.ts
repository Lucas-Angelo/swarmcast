import { describe, expect, it } from 'vitest';
import { URGENT_FAIR_SHARES, URGENT_FLOOR_BYTES, URGENT_S, URGENT_WINDOW_MS, UrgencyBudget, parseNeed } from '../../src/hls/need.js';
import { DEFAULT_NEED_S, MAX_NEED_S } from '../../src/hls/throttle.js';

// X-SC-Need (docs/QUALITY.md "Upload order"): what the page says, and the bound on what one viewer
// may claim as urgent. The clock is injected.

describe('parseNeed', () => {
  it('reads seconds with up to three decimals, clamped to MAX_NEED_S', () => {
    expect(parseNeed('0')).toBe(0);
    expect(parseNeed('3.5')).toBe(3.5);
    expect(parseNeed('999')).toBe(MAX_NEED_S);
  });

  it('ignores anything else (absent, negative, words, lists, exponents)', () => {
    for (const v of [undefined, '', '-1', 'soon', '1e3', '1,5', ' 2', '2.', '1.23456']) expect(parseNeed(v), String(v)).toBeUndefined();
    expect(parseNeed(['1', '2'])).toBeUndefined();
  });
});

describe('UrgencyBudget', () => {
  const MB = 1024 * 1024;
  const make = (o: { capBytesPerS?: number; viewers?: number } = {}) => {
    let now = 0;
    const budget = new UrgencyBudget({ capBytesPerS: () => o.capBytesPerS ?? 1 * MB, viewers: () => o.viewers ?? 50, now: () => now });
    return { budget, advance: (ms: number) => (now += ms) };
  };

  it('passes non-urgent needs through and gives requests that say nothing the default', () => {
    const { budget } = make();
    expect(budget.needFor('a', 12, 10 * MB)).toBe(12);
    expect(budget.needFor('a', URGENT_S, 10 * MB)).toBe(URGENT_S);
    expect(budget.needFor('a', undefined, 1000)).toBe(DEFAULT_NEED_S);
  });

  it('honours urgent needs up to the floor per window, then schedules that viewer like everyone else', () => {
    // Arrange: 1 MB/s for 50 viewers: 3 fair shares of 10 s are 0.6 MB, below the 3 MB floor.
    const { budget, advance } = make();
    const seg = 700 * 1024;
    // Act
    const needs = Array.from({ length: 6 }, () => budget.needFor('liar', 0, seg));
    // Assert: four segments (2.8 MB) fit the floor, the fifth would not.
    expect(needs).toEqual([0, 0, 0, 0, DEFAULT_NEED_S, DEFAULT_NEED_S]);
    // Another viewer still gets its first picture first.
    expect(budget.needFor('newcomer', 0, seg)).toBe(0);
    // A new window, a new budget.
    advance(URGENT_WINDOW_MS);
    expect(budget.needFor('liar', 0, seg)).toBe(0);
  });

  it('grows with the fair share on a big uplink with few viewers', () => {
    // 10 MB/s for 2 viewers: one fair share of 10 s is 50 MB, three are 150 MB.
    const { budget } = make({ capBytesPerS: 10 * MB, viewers: 2 });
    const limit = URGENT_FAIR_SHARES * ((10 * MB * URGENT_WINDOW_MS) / 1000 / 2);
    expect(limit).toBeGreaterThan(URGENT_FLOOR_BYTES);
    expect(budget.needFor('a', 1, limit - 1)).toBe(1);
    expect(budget.needFor('a', 1, 2)).toBe(DEFAULT_NEED_S);
  });

  it('forgets viewers whose window ended once it holds many more of them than watch', () => {
    const { budget, advance } = make({ viewers: 1 });
    for (let i = 0; i < 40; i++) budget.needFor(`v${i}`, 0, 1);
    advance(URGENT_WINDOW_MS);
    budget.needFor('fresh', 0, 1);
    expect((budget as unknown as { used: Map<string, unknown> }).used.size).toBe(1);
  });
});
