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
 * current level. Measured about 8 µs per attempt on a recent laptop; mid-range phones are a few
 * times slower, so level 2 (at most 20,000 attempts) stays around or under one second there.
 */
export type PowLevel = 0 | 1 | 2;

export const POW_COUNTER_RANGE: Record<1 | 2, [number, number]> = {
  1: [2_000, 8_000],
  2: [8_000, 20_000],
};

/** Challenges stay valid this long (the page fetches one on load, then the viewer types a nickname). */
export const POW_TTL_MS = 10 * 60_000;

export type PowVerdict = 'ok' | 'missing' | 'invalid' | 'expired' | 'replay' | 'busy';

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

export class JoinPow {
  private hmacSecret = '';
  private keySecret = '';
  /** Signatures of solved challenges → when they expire (single use). */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxUsed = 50_000,
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
      counter: crypto.randomInt(lo, hi + 1),
      deriveKey,
      expiresAt: Math.floor((this.now() + POW_TTL_MS) / 1000),
      hmacSignatureSecret: this.hmacSecret,
      // With a key signature, checking a solution is two HMACs (no re-hashing).
      hmacKeySignatureSecret: this.keySecret,
    });
  }

  async verify(input: unknown): Promise<PowVerdict> {
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
