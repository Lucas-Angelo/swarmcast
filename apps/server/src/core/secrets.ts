import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { writePrivateFile } from './paths.js';

const secretsSchema = z.object({
  streamKey: z.string().min(16),
  /** Ed25519 private key, PKCS#8 PEM. Signs the integrity manifest. */
  manifestPrivateKeyPem: z.string().includes('PRIVATE KEY'),
  createdAt: z.string(),
  /**
   * HMAC key (hex) for the "browser already passed the check" cookie. Kept across lives and
   * restarts so a browser is remembered; added to older files on load.
   */
  browserCheckKey: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Secrets = z.infer<typeof secretsSchema>;

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Unambiguous random string (no 0/O/1/l/I), easy to read when pasted into OBS. */
export function randomToken(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      // Rejection sampling keeps the distribution uniform.
      if (b < 256 - (256 % ALPHABET.length)) out.push(ALPHABET[b % ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export function generateSecrets(): Secrets {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    streamKey: `sc_${randomToken(24)}`,
    manifestPrivateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    createdAt: new Date().toISOString(),
    browserCheckKey: crypto.randomBytes(32).toString('hex'),
  };
}

/** Load secrets, generating them on first run. Never log the returned object. */
export function loadOrCreateSecrets(file: string): Secrets {
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // Files from v0.1.0 have no browser check key yet: add one (keeping everything else).
    const backfill = raw && typeof raw === 'object' && raw.browserCheckKey === undefined;
    const parsed = secretsSchema.safeParse(backfill ? { ...raw, browserCheckKey: crypto.randomBytes(32).toString('hex') } : raw);
    if (parsed.success) {
      if (backfill) writePrivateFile(file, JSON.stringify(parsed.data, null, 2) + '\n');
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          /* best effort */
        }
      }
      return parsed.data;
    }
    // Keep the broken file for inspection instead of silently overwriting it.
    fs.renameSync(file, `${file}.invalid-${Date.now()}`);
  }
  const secrets = generateSecrets();
  writePrivateFile(file, JSON.stringify(secrets, null, 2) + '\n');
  return secrets;
}
