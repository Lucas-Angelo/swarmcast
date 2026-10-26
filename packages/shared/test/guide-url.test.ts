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
  });

  it('only links to pages that exist in both languages', () => {
    for (const page of ['start/obs', 'help/troubleshooting']) {
      expect(fs.existsSync(path.join(SITE_DOCS, `${page}.md`)), page).toBe(true);
      expect(fs.existsSync(path.join(SITE_DOCS, 'pt-br', `${page}.md`)), `pt-br/${page}`).toBe(true);
    }
  });
});
