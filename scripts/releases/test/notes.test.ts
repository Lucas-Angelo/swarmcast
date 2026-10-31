// The release notes taken from CHANGELOG.md (notes.mjs), as a function and as the CLI the release
// workflow runs. A CHANGELOG saved with Windows line endings (CRLF) gives the same notes.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';
import { it } from '../../build/test/fixtures.js';
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

/** `notes.mjs --section <section> <file>`, without throwing on a non-zero exit. */
const notesCli = (section: string, file: string) => spawnSync(process.execPath, [SCRIPT, '--section', section, file], { encoding: 'utf8' });

describe('changelogSection: the body between its heading and the next one (or the link references)', () => {
  it.each([
    ['Unreleased', '### Added\n\n- Beta versions.'],
    ['0.2.2', '### Fixed\n\n- A fix.'],
    ['0.2.1', '- Older.'],
  ])('## [%s]', (section, notes) => {
    // Act
    const body = changelogSection(CHANGELOG, section);

    // Assert
    expect(body).toBe(notes);
  });

  it('a heading that is only a prefix of the asked version is not the section', () => {
    // Act
    const body = changelogSection(CHANGELOG, '0.2');

    // Assert
    expect(body).toBeNull();
  });

  it('a heading without a body gives an empty string (not null)', () => {
    // Arrange
    const empty = CHANGELOG.replace('- Beta versions.', '').replace('### Added', '');

    // Act
    const body = changelogSection(empty, 'Unreleased');

    // Assert
    expect(body).toBe('');
  });

  it('reads a CHANGELOG with CRLF line endings, and the notes it gives have LF', () => {
    // Arrange
    const crlf = CHANGELOG.replace(/\n/g, '\r\n');

    // Act
    const body = changelogSection(crlf, '0.2.2');

    // Assert
    expect(body).toBe('### Fixed\n\n- A fix.');
  });
});

describe('notes.mjs (CLI)', () => {
  it('prints the notes of the section', ({ tmp }) => {
    // Arrange
    const file = path.join(tmp, 'CHANGELOG.md');
    fs.writeFileSync(file, CHANGELOG);

    // Act
    const out = execFileSync(process.execPath, [SCRIPT, '--section', 'Unreleased', file], { encoding: 'utf8' });

    // Assert
    expect(out).toBe('### Added\n\n- Beta versions.\n');
  });

  it('fails with a ::error:: line on a missing section', ({ tmp }) => {
    // Arrange
    const file = path.join(tmp, 'CHANGELOG.md');
    fs.writeFileSync(file, CHANGELOG);

    // Act
    const run = notesCli('0.3.0', file);

    // Assert
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`::error file=${file}::No '## [0.3.0]' section`);
  });

  it('fails with a ::error:: line on an empty section', ({ tmp }) => {
    // Arrange
    const file = path.join(tmp, 'CHANGELOG.md');
    fs.writeFileSync(file, CHANGELOG.replace('- Older.', ''));

    // Act
    const run = notesCli('0.2.1', file);

    // Assert
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("The '## [0.2.1]' section is empty");
  });
});
