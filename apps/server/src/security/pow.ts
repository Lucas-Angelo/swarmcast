import crypto from 'node:crypto';
import { createChallenge, verifySolution, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { z } from 'zod';

/**
 * Proof-of-work on join, using the ALTCHA protocol (altcha-lib, MIT): the server issues an
 * HMAC-signed challenge (random salt/nonce, expiry, a secret counter); the join page brute-forces
 * SHA-256 in a Web Worker until it finds the counter; the server checks the HMAC, the expiry and
 * that the challenge was not used before. Everything is self-hosted: no third party, no account.
 *
 * Deterministic mode: the expected work equals the secret counter, drawn from the range of the
 * current level. Since a browser that passes is remembered (see verified.ts), this runs about once
 * per browser, so it can be a little heavier than a per-join check.
 *
 * Measured (SHA-256 via WebCrypto, one attempt per digest, Apple-silicon Mac, 2026-10):
 *   Chrome 1.5 µs/attempt; with DevTools CPU throttling 4× ("mid-tier mobile") ~6 µs, 6× ~8–9 µs;
 *   Safari/WebKit ~22 µs (WebKit's digest is the slow case; a mid-range iPhone is estimated at
 *   30–55 µs).
 * Level 1, 5,000–15,000 attempts: about 0.1 s on a mid-range Android phone and 0.3–0.8 s on a
 * mid-range iPhone. Level 2 (under attack), 15,000–40,000 attempts: about 0.3 s / 0.8–2.2 s.
 */
export type PowLevel = 0 | 1 | 2;

export const POW_COUNTER_RANGE: Record<1 | 2, [number, number]> = {
  1: [5_000, 15_000],
  2: [15_000, 40_000],
};

/** Challenges stay valid this long (the page fetches one on load, then the viewer types a nickname). */
export const POW_TTL_MS = 10 * 60_000;

export type PowVerdict = 'ok' | 'missing' | 'invalid' | 'expired' | 'replay' | 'busy';

/** Verdict plus the level of the solved challenge (from its signed data) when ok. */
export interface PowResult {
  verdict: PowVerdict;
  level?: 1 | 2;
}

const hex = z.string().regex(/^[0-9a-f]+$/i).max(256);
export const powPayloadSchema = z.object({
  challenge: z.object({
    parameters: z
      .object({
        algorithm: z.literal('SHA-256'),
        nonce: hex,
        salt: hex,
        cost: z.number().int().positive(),
        keyLength: z.number().int().positive().max(64),
        keyPrefix: hex,
        keySignature: hex.optional(),
        expiresAt: z.number().optional(),
        data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      })
      .loose(),
    signature: hex,
  }),
  solution: z.object({
    counter: z.number().int().nonnegative(),
    derivedKey: hex,
    time: z.number().optional(),
  }),
});
export type PowPayload = z.infer<typeof powPayloadSchema>;

/** A secret counter drawn uniformly from lo..hi, both ends included. */
export function randomCounter(lo: number, hi: number): number {
  return crypto.randomInt(lo, hi + 1);
}

export class JoinPow {
  private hmacSecret = '';
  private keySecret = '';
  /** Signatures of solved challenges → when they expire (single use). */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxUsed = 50_000,
    /** Picks the secret counter of a new challenge within its level's range (tests pin it: the same work every run). */
    private readonly pickCounter: (lo: number, hi: number) => number = randomCounter,
  ) {
    this.reset();
  }

  /** New secrets: every challenge issued before is void. */
  reset(): void {
    this.hmacSecret = crypto.randomBytes(32).toString('hex');
    this.keySecret = crypto.randomBytes(32).toString('hex');
    this.used.clear();
  }

  async issue(level: 1 | 2): Promise<Challenge> {
    const [lo, hi] = POW_COUNTER_RANGE[level];
    return createChallenge({
      algorithm: 'SHA-256',
      cost: 1,
      counter: this.pickCounter(lo, hi),
      // Signed with the challenge: the level is what the "verified" cookie records; max lets the
      // page show progress (the real counter stays secret).
      data: { level, max: hi },
      deriveKey,
      expiresAt: Math.floor((this.now() + POW_TTL_MS) / 1000),
      hmacSignatureSecret: this.hmacSecret,
      // With a key signature, checking a solution is two HMACs (no re-hashing).
      hmacKeySignatureSecret: this.keySecret,
    });
  }

  async verify(input: unknown): Promise<PowVerdict> {
    return (await this.verifyLevel(input)).verdict;
  }

  async verifyLevel(input: unknown): Promise<PowResult> {
    const verdict = await this.check(input);
    if (verdict !== 'ok') return { verdict };
    const level = (input as PowPayload).challenge.parameters.data?.level;
    return { verdict, level: level === 2 ? 2 : 1 };
  }

  private async check(input: unknown): Promise<PowVerdict> {
    if (input === undefined || input === null) return 'missing';
    const parsed = powPayloadSchema.safeParse(input);
    if (!parsed.success) return 'invalid';
    const { challenge, solution } = parsed.data;
    const now = this.now();
    const exp = challenge.parameters.expiresAt;
    if (!exp || exp * 1000 < now) return 'expired';
    if (this.used.has(challenge.signature)) return 'replay';
    if (this.used.size >= this.maxUsed) {
      for (const [sig, until] of this.used) if (until < now) this.used.delete(sig);
      // Fail closed rather than forgetting challenges that could still be replayed.
      if (this.used.size >= this.maxUsed) return 'busy';
    }
    let verified: boolean;
    try {
      const r = await verifySolution({
        challenge: challenge as Challenge,
        solution,
        deriveKey,
        hmacSignatureSecret: this.hmacSecret,
        hmacKeySignatureSecret: this.keySecret,
      });
      if (r.expired) return 'expired';
      verified = r.verified;
    } catch {
      return 'invalid';
    }
    if (!verified) return 'invalid';
    // Check again after the await: two concurrent submissions of one solution.
    if (this.used.has(challenge.signature)) return 'replay';
    this.used.set(challenge.signature, exp * 1000);
    return 'ok';
  }
}
