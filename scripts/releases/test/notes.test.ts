import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changelogSection } from '../notes.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'notes.mjs');
const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Beta versions.

## [0.2.2] - 2026-10-29

### Fixed

- A fix.

## [0.2.1] - 2026-10-27

- Older.

[Unreleased]: https://example.com/compare/v0.2.2...HEAD
[0.2.2]: https://example.com/compare/v0.2.1...v0.2.2
`;

describe('changelogSection', () => {
  it('takes the body between its heading and the next one (or the link references)', () => {
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBe('### Added\n\n- Beta versions.');
    expect(changelogSection(CHANGELOG, '0.2.2')).toBe('### Fixed\n\n- A fix.');
    expect(changelogSection(CHANGELOG, '0.2.1')).toBe('- Older.');
    expect(changelogSection(CHANGELOG, '0.2')).toBeNull();
    expect(changelogSection(CHANGELOG.replace('- Beta versions.', '').replace('### Added', ''), 'Unreleased')).toBe('');
  });

  it('CLI: prints the notes, fails on a missing or empty section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-notes-'));
    const file = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(file, CHANGELOG.replace('- Older.', ''));
    expect(execFileSync(process.execPath, [SCRIPT, '--section', 'Unreleased', file], { encoding: 'utf8' })).toBe('### Added\n\n- Beta versions.\n');
    const missing = spawnSync(process.execPath, [SCRIPT, '--section', '0.3.0', file], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("No '## [0.3.0]' section");
    const empty = spawnSync(process.execPath, [SCRIPT, '--section', '0.2.1', file], { encoding: 'utf8' });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('is empty');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
