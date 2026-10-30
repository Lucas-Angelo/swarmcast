import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { JoinPow, POW_COUNTER_RANGE, POW_TTL_MS, randomCounter, type PowPayload } from '../../src/security/pow.js';
import { manualClock } from './helpers.js';

// The join proof-of-work (ALTCHA). Solving is real work: SHA-256 up to the secret counter, and the
// counter is random within the level's range, so one solve can take three times another. The
// first test solves a real random challenge, as in production; the others pin the counter to the
// lowest of the range, the same bounded work every run. The derived key is the proof: the server
// checks it against the signed key signature. A challenge of another live (other secrets) is
// worthless, and reset() voids everything issued before.

/** The secret counter pinned to the lowest of the range. */
const lowest = (lo: number): number => lo;

/** A JoinPow that issues the cheapest challenge of each level. */
function cheapPow(now: () => number = Date.now, maxUsed?: number): JoinPow {
  return new JoinPow(now, maxUsed, lowest);
}

/** Solves `challenge` the way the join page does. */
async function solve(challenge: Challenge): Promise<PowPayload> {
  const solution = await solveChallenge({ challenge, deriveKey });
  return { challenge, solution: solution! } as PowPayload;
}

describe('join proof-of-work (ALTCHA)', () => {
  it('issues signed SHA-256 challenges within the level range and verifies a real solution (random counter)', async () => {
    // Arrange
    const pow = new JoinPow();
    // Act
    const ch = await pow.issue(1);
    const payload = await solve(ch);
    // Assert
    expect(ch.parameters.algorithm).toBe('SHA-256');
    expect(ch.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.parameters.keySignature).toBeDefined();
    expect(payload.solution.counter).toBeGreaterThanOrEqual(POW_COUNTER_RANGE[1][0]);
    expect(payload.solution.counter).toBeLessThanOrEqual(POW_COUNTER_RANGE[1][1]);
    expect(await pow.verify(payload)).toBe('ok');
  });

  it.each([1, 2] as const)('draws the secret counter of level %i from its range, and signs the level with the range end', async (level) => {
    // Arrange
    const asked: Array<[number, number]> = [];
    const pow = new JoinPow(Date.now, undefined, (lo, hi) => (asked.push([lo, hi]), lo));
    // Act
    const ch = await pow.issue(level);
    const { solution } = await solve(ch);
    // Assert
    expect(asked).toEqual([POW_COUNTER_RANGE[level]]);
    expect(ch.parameters.data).toEqual({ level, max: POW_COUNTER_RANGE[level][1] });
    expect(solution.counter).toBe(POW_COUNTER_RANGE[level][0]);
  });

  it('a random counter stays within its range', () => {
    // Assert
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 50_000 }), (lo, span) => {
        const n = randomCounter(lo, lo + span);
        return Number.isInteger(n) && n >= lo && n <= lo + span;
      }),
    );
  });

  it('a random counter can be the upper end of its range (a range of one number gives that number)', () => {
    // Act
    const n = randomCounter(5, 5);
    // Assert
    expect(n).toBe(5);
  });

  it.each([1, 2] as const)('reports the solved level %i from the signed challenge data', async (level) => {
    // Arrange
    const pow = cheapPow();
    const payload = await solve(await pow.issue(level));
    // Act
    const r = await pow.verifyLevel(payload);
    // Assert
    expect(r).toEqual({ verdict: 'ok', level });
  });

  it('claiming a higher level breaks the signature', async () => {
    // Arrange
    const pow = cheapPow();
    const forged = await solve(await pow.issue(1));
    forged.challenge = { ...forged.challenge, parameters: { ...forged.challenge.parameters, data: { level: 2, max: POW_COUNTER_RANGE[2][1] } } };
    // Act
    const r = await pow.verifyLevel(forged);
    // Assert
    expect(r).toEqual({ verdict: 'invalid' });
  });

  it('rejects a replayed solution (single use)', async () => {
    // Arrange
    const pow = cheapPow();
    const payload = await solve(await pow.issue(1));
    // Act
    const verdicts = [await pow.verify(payload), await pow.verify(payload)];
    // Assert
    expect(verdicts).toEqual(['ok', 'replay']);
  });

  it('rejects concurrent double submissions of the same solution', async () => {
    // Arrange
    const pow = cheapPow();
    const payload = await solve(await pow.issue(1));
    // Act
    const verdicts = await Promise.all([pow.verify(payload), pow.verify(payload)]);
    // Assert
    expect(verdicts.sort()).toEqual(['ok', 'replay']);
  });

  it('rejects expired challenges (fake clock)', async () => {
    // Arrange
    const clock = manualClock(Date.now());
    const pow = cheapPow(clock.now);
    const payload = await solve(await pow.issue(1));
    clock.advance(POW_TTL_MS + 1000);
    // Act
    const verdict = await pow.verify(payload);
    // Assert
    expect(verdict).toBe('expired');
  });

  describe('rejects tampering, wrong answers, foreign secrets and garbage', () => {
    let pow: JoinPow;
    let payload: PowPayload;
    let foreign: PowPayload;
    beforeAll(async () => {
      pow = cheapPow();
      payload = await solve(await pow.issue(1));
      foreign = await solve(await cheapPow().issue(1));
    });

    it.each([
      ['a wrong derived key', () => ({ ...payload, solution: { ...payload.solution, derivedKey: '00'.repeat(32) } }), 'invalid'],
      ['an easier key prefix', () => ({ ...payload, challenge: { ...payload.challenge, parameters: { ...payload.challenge.parameters, keyPrefix: '00' } } }), 'invalid'],
      ['a solution of another live', () => foreign, 'invalid'],
      ['no proof at all', () => undefined, 'missing'],
      ['a challenge that is not one', () => ({ challenge: 'x' }), 'invalid'],
      ['a string', () => 'nope', 'invalid'],
    ])('%s', async (_what, input, verdict) => {
      // Act
      const got = await pow.verify(input());
      // Assert
      expect(got).toBe(verdict);
    });
  });

  it('reset() voids every challenge issued before', async () => {
    // Arrange
    const pow = cheapPow();
    const fresh = await solve(await pow.issue(1));
    // Act
    pow.reset();
    // Assert
    expect(await pow.verify(fresh)).toBe('invalid');
  });

  it('fails closed when the replay store is full of unexpired entries', async () => {
    // Arrange
    const pow = cheapPow(Date.now, 1);
    const first = await solve(await pow.issue(1));
    const second = await solve(await pow.issue(1));
    // Act
    const verdicts = [await pow.verify(first), await pow.verify(second)];
    // Assert
    expect(verdicts).toEqual(['ok', 'busy']);
  });
});
