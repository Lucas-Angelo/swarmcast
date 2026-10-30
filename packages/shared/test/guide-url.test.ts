import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIDE_URL, guideUrl } from '../src/i18n/index.js';

const SITE_DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../site/src/content/docs');

/** The pages the panel links to. */
const LINKED_PAGES = ['start/obs', 'help/troubleshooting'];

/**
 * A long run of slashes inside the page (CodeQL's polynomial-regex finding): trimming them with
 * /\/+$/ is quadratic (half a second at 40,000 slashes on a laptop, 25 times that at this
 * length); the one-pass trim takes well under a millisecond. The budget lies orders of
 * magnitude from both, so it tells them apart on any machine.
 */
const SLASH_RUN = 200_000;
const LINEAR_BUDGET_MS = 1000;

describe('guideUrl', () => {
  it('points at the website in the panel language', () => {
    // Act
    const urls = [guideUrl('en'), guideUrl('pt-BR'), guideUrl('pt-BR', '/start/obs/'), guideUrl('en', 'help/troubleshooting'), guideUrl('en', '///'), guideUrl('en', '//a//b//')];
    // Assert
    expect(urls).toEqual([
      'https://lucas-angelo.github.io/swarmcast/',
      'https://lucas-angelo.github.io/swarmcast/pt-br/',
      'https://lucas-angelo.github.io/swarmcast/pt-br/start/obs/',
      `${GUIDE_URL}help/troubleshooting/`,
      GUIDE_URL,
      `${GUIDE_URL}a//b/`,
    ]);
  });

  it('stays linear on a long run of slashes inside the page', () => {
    // Arrange
    const page = `a${'/'.repeat(SLASH_RUN)}b`;
    // Act
    const t0 = performance.now();
    const url = guideUrl('en', page);
    const elapsedMs = performance.now() - t0;
    // Assert
    expect(url).toBe(`${GUIDE_URL}${page}/`);
    expect(elapsedMs).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it('only links to pages that exist in both languages', () => {
    // Act
    const missing = LINKED_PAGES.flatMap((page) => [`${page}.md`, `pt-br/${page}.md`]).filter((f) => !fs.existsSync(path.join(SITE_DOCS, f)));
    // Assert
    expect(missing).toEqual([]);
  });
});
