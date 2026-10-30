// The parsers of scripts/ci/soak-run.mjs: they turn each suite's own output into checks, for the
// soak report and the CI summary (.github/scripts/test-summary.mjs reuses them).
import { describe, expect, it } from 'vitest';
import { cargoChecks, lineChecks } from '../soak-run.mjs';

describe('cargoChecks', () => {
  it('reads coloured output (CI runs cargo test with CARGO_TERM_COLOR=always)', () => {
    // Arrange
    const output = [
      'test page::tests::pages_by_url ... \u001b[32mok\u001b[0m',
      'test logs::tests::rotates_by_size ... \u001b[31mFAILED\u001b[0m',
      'test updater::tests::slow ... \u001b[33mignored\u001b[0m',
      '',
      '---- logs::tests::rotates_by_size stdout ----',
      "thread 'logs::tests::rotates_by_size' panicked at src/logs.rs:170:9:",
    ].join('\n');

    // Act
    const checks = cargoChecks({ output });

    // Assert
    expect(checks).toEqual([
      { name: 'page::tests::pages_by_url', status: 'pass' },
      { name: 'logs::tests::rotates_by_size', status: 'fail', error: "thread 'logs::tests::rotates_by_size' panicked at src/logs.rs:170:9:" },
      { name: 'updater::tests::slow', status: 'skip' },
    ]);
  });
});

describe('lineChecks', () => {
  it('reads the PASS/FAIL and ✓/✗ lines of the harnesses, and nothing else', () => {
    // Arrange
    const output = [
      'PASS chat bench quiet',
      'FAIL chat bench flood — the server closed 1 bot sockets',
      '✓ [local] live link — http://127.0.0.1:8080/join/…',
      '✗ [local] app quits cleanly — exit 1',
      'infra recovery: DNS: x.trycloudflare.com resolved after 12 s (2 lookups said unknown: a brand-new name)',
      '  ok: exit code 0',
    ].join('\n');

    // Act
    const checks = lineChecks({ output });

    // Assert
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['chat bench quiet', 'pass'],
      ['chat bench flood', 'fail'],
      ['[local] live link', 'pass'],
      ['[local] app quits cleanly', 'fail'],
    ]);
    expect(checks[1]!.error).toBe('the server closed 1 bot sockets');
  });

  it('numbers a check seen twice in one run', () => {
    // Act
    const checks = lineChecks({ output: 'PASS panel login\nPASS panel login\n' });

    // Assert
    expect(checks.map((c) => c.name)).toEqual(['panel login', 'panel login #2']);
  });
});
