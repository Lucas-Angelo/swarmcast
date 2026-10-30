import { describe, expect, it } from 'vitest';
import { deriveTheme, themeTokensOk } from '../../src/branding/index.js';

/**
 * U4 over the whole 24-bit colour space (branding plan §7.1): every custom accent gives readable
 * theme tokens in both themes. About 10 minutes, so only the on-demand `branding-fuzz` job runs
 * it (`CHAT_EXHAUSTIVE=1`, .github/workflows/chat-load.yml); the PR gate runs the 2,000-colour
 * property in branding.test.ts. At most 20 failures are listed.
 */
const EXHAUSTIVE = process.env.CHAT_EXHAUSTIVE === '1';

describe.skipIf(!EXHAUSTIVE)('branding theme, exhaustive', () => {
  it('U4: all 16,777,216 custom accents satisfy every constraint in both themes', () => {
    // Act
    const failures: string[] = [];
    for (let n = 0; n <= 0xffffff && failures.length < 20; n++) {
      const accent = `#${n.toString(16).padStart(6, '0')}`;
      const d = deriveTheme({ preset: 'custom', accent });
      if (!themeTokensOk(d.light, 'light') || !themeTokensOk(d.dark, 'dark')) failures.push(accent);
    }
    // Assert
    expect(failures).toEqual([]);
  }, 7_200_000);
});
