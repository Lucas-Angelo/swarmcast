import crypto from 'node:crypto';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinPow, POW_COUNTER_RANGE, POW_TTL_MS } from '../../src/security/pow.js';

// Solving is real work (SHA-256 up to the secret counter), and the counter is random within the
// level's range, so the time each solve takes varies by a factor of 3. Except in the first test,
// which solves a real random challenge, the server draws the lowest counter of the range: the
// same bounded work every run.
beforeEach(() => {
  vi.spyOn(crypto, 'randomInt').mockImplementation(((a: number, b?: number) => (b === undefined ? 0 : a)) as typeof crypto.randomInt);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function solve(challenge: Challenge) {
  const solution = await solveChallenge({ challenge, deriveKey });
  return { challenge, solution: solution! };
}

describe('join proof-of-work (ALTCHA)', () => {
  it('issues signed SHA-256 challenges within the level range and verifies a real solution', async () => {
    vi.restoreAllMocks(); // a random counter, as in production
    const pow = new JoinPow();
    const ch = await pow.issue(1);
    expect(ch.parameters.algorithm).toBe('SHA-256');
    expect(ch.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.parameters.keySignature).toBeDefined();
    const payload = await solve(ch);
    expect(payload.solution.counter).toBeGreaterThanOrEqual(POW_COUNTER_RANGE[1][0]);
    expect(payload.solution.counter).toBeLessThanOrEqual(POW_COUNTER_RANGE[1][1]);
    expect(await pow.verify(payload)).toBe('ok');
  });

  it('reports the solved level from the signed challenge data', async () => {
    const pow = new JoinPow();
    const ch = await pow.issue(2);
    expect(ch.parameters.data).toEqual({ level: 2, max: POW_COUNTER_RANGE[2][1] });
    expect(await pow.verifyLevel(await solve(ch))).toEqual({ verdict: 'ok', level: 2 });
    expect(await pow.verifyLevel(await solve(await pow.issue(1)))).toEqual({ verdict: 'ok', level: 1 });
    // Claiming a higher level breaks the signature.
    const forged = await solve(await pow.issue(1));
    forged.challenge = { ...forged.challenge, parameters: { ...forged.challenge.parameters, data: { level: 2, max: POW_COUNTER_RANGE[2][1] } } };
    expect(await pow.verifyLevel(forged)).toEqual({ verdict: 'invalid' });
  });

  it('level 2 is harder but bounded', async () => {
    const ch = await new JoinPow().issue(2);
    const { solution } = await solve(ch);
    expect(solution.counter).toBeGreaterThanOrEqual(POW_COUNTER_RANGE[2][0]);
    expect(solution.counter).toBeLessThanOrEqual(POW_COUNTER_RANGE[2][1]);
  });

  it('rejects a replayed solution (single use)', async () => {
    const pow = new JoinPow();
    const payload = await solve(await pow.issue(1));
    expect(await pow.verify(payload)).toBe('ok');
    expect(await pow.verify(payload)).toBe('replay');
  });

  it('rejects concurrent double submissions of the same solution', async () => {
    const pow = new JoinPow();
    const payload = await solve(await pow.issue(1));
    const verdicts = await Promise.all([pow.verify(payload), pow.verify(payload)]);
    expect(verdicts.sort()).toEqual(['ok', 'replay']);
  });

  it('rejects expired challenges (fake clock)', async () => {
    let now = Date.now();
    const pow = new JoinPow(() => now);
    const payload = await solve(await pow.issue(1));
    now += POW_TTL_MS + 1000;
    expect(await pow.verify(payload)).toBe('expired');
  });

  it('rejects tampering, wrong answers, foreign secrets and garbage', async () => {
    const pow = new JoinPow();
    const payload = await solve(await pow.issue(1));
    // (The derived key is the proof; the server checks it against the signed key signature.)
    expect(await pow.verify({ ...payload, solution: { ...payload.solution, derivedKey: '00'.repeat(32) } })).toBe('invalid');
    const easier = { ...payload, challenge: { ...payload.challenge, parameters: { ...payload.challenge.parameters, keyPrefix: '00' } } };
    expect(await pow.verify(easier)).toBe('invalid');
    // A challenge from another live (other secrets) is worthless here.
    const other = await solve(await new JoinPow().issue(1));
    expect(await pow.verify(other)).toBe('invalid');
    expect(await pow.verify(undefined)).toBe('missing');
    expect(await pow.verify({ challenge: 'x' })).toBe('invalid');
    expect(await pow.verify('nope')).toBe('invalid');
    // reset() voids everything issued before.
    const fresh = await solve(await pow.issue(1));
    pow.reset();
    expect(await pow.verify(fresh)).toBe('invalid');
  });

  it('fails closed when the replay store is full of unexpired entries', async () => {
    const pow = new JoinPow(Date.now, 1);
    expect(await pow.verify(await solve(await pow.issue(1)))).toBe('ok');
    expect(await pow.verify(await solve(await pow.issue(1)))).toBe('busy');
  });
});
