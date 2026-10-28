import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIDE_URL, guideUrl } from '../src/i18n/index.js';

const SITE_DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../site/src/content/docs');

describe('guideUrl', () => {
  it('points at the website in the panel language', () => {
    expect(guideUrl('en')).toBe('https://lucas-angelo.github.io/swarmcast/');
    expect(guideUrl('pt-BR')).toBe('https://lucas-angelo.github.io/swarmcast/pt-br/');
    expect(guideUrl('pt-BR', '/start/obs/')).toBe('https://lucas-angelo.github.io/swarmcast/pt-br/start/obs/');
    expect(guideUrl('en', 'help/troubleshooting')).toBe(`${GUIDE_URL}help/troubleshooting/`);
    expect(guideUrl('en', '///')).toBe(GUIDE_URL);
    expect(guideUrl('en', '//a//b//')).toBe(`${GUIDE_URL}a//b/`);
  });

  it('stays linear on a long run of slashes inside the page', () => {
    const page = `a${'/'.repeat(200_000)}b`;
    const t0 = performance.now();
    expect(guideUrl('en', page)).toBe(`${GUIDE_URL}${page}/`);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('only links to pages that exist in both languages', () => {
    for (const page of ['start/obs', 'help/troubleshooting']) {
      expect(fs.existsSync(path.join(SITE_DOCS, `${page}.md`)), page).toBe(true);
      expect(fs.existsSync(path.join(SITE_DOCS, 'pt-br', `${page}.md`)), `pt-br/${page}`).toBe(true);
    }
  });
});
