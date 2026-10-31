// Shared Vitest fixtures of the build, release and stats script tests (scripts/*/test).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

/**
 * `it` with `tmp`: a fresh folder of its own for every test that asks for it, removed when the
 * test ends, whether it passed or not (os.tmpdir(), so the same on macOS, Linux and Windows).
 */
export const it = test.extend<{ tmp: string }>({
  // eslint-disable-next-line no-empty-pattern -- Vitest reads the fixtures a function uses from its first argument
  tmp: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-scripts-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
});
