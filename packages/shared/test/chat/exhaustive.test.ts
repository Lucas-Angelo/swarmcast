import { describe, expect, it } from 'vitest';
import { CHAT_BG_DARK, CHAT_BG_LIGHT, CHAT_MIN_CONTRAST, adjustNameColor, contrastRatio } from '@swarmcast/shared';

/**
 * P12 over the whole 24-bit colour space (plan §10.1), not a sample: every colour a viewer or the
 * streamer can pick reaches 4.5:1 on both chat backgrounds. About 33.5 M adjustments, a few
 * minutes, so only the on-demand fuzz job runs it (`CHAT_EXHAUSTIVE=1`,
 * .github/workflows/chat-load.yml); the PR gate runs the 2,000-colour property in
 * properties.test.ts.
 */
const EXHAUSTIVE = process.env.CHAT_EXHAUSTIVE === '1';

describe.skipIf(!EXHAUSTIVE)('chat name colours, exhaustive', () => {
  it('P12: all 16,777,216 colours on both themes', () => {
    const failures: string[] = [];
    let worst = Infinity;
    for (let n = 0; n <= 0xffffff; n++) {
      const c = `#${n.toString(16).padStart(6, '0')}`;
      for (const bg of [CHAT_BG_LIGHT, CHAT_BG_DARK]) {
        const ratio = contrastRatio(adjustNameColor(c, bg), bg);
        if (ratio < worst) worst = ratio;
        if (ratio < CHAT_MIN_CONTRAST && failures.length < 20) failures.push(`${c} on ${bg}: ${ratio.toFixed(3)}`);
      }
    }
    expect(failures, `lowest ratio ${worst.toFixed(3)}`).toEqual([]);
  }, 3_600_000);
});
