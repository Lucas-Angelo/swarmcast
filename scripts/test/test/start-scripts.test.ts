// The Unix start scripts (scripts/start-linux.sh, scripts/start-macos.command) are two copies of
// one installer: most of their functions must stay byte-identical, so a fix made in one is made in
// the other. Only the functions in OS_SPECIFIC may differ (OS and hardware checks, ports, OBS,
// paths, the downloads and `main`). The uninstallers have the same guard in scripts/test/uninstall.sh.
// Functions are read as the scripts write them: a top-level `name() {` line up to the next line
// that is exactly `}`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINUX = 'start-linux.sh';
const MACOS = 'start-macos.command';

/** Functions written differently on purpose; every other function is the same in both scripts. */
const OS_SPECIFIC = new Set([
  'usage',
  'sha256_of',
  'refuse_root',
  'setup_paths',
  'check_os',
  'check_arch',
  'check_memory',
  'check_cpu',
  'port_busy',
  'port_owner',
  'check_obs',
  'report_and_confirm',
  'download_and_install',
  'main',
  // Linux only: installs curl and tar with sudo when they are missing.
  'ensure_tools',
]);

/** The top-level shell functions of a script, by name, each with its whole text (header to `}`). */
function shellFunctions(text: string): Map<string, string> {
  const functions = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = name === null ? /^([a-z_0-9]+)\(\) \{/.exec(line) : null;
    if (header) {
      name = header[1]!;
      body = [line];
      if (/\}\s*$/.test(line.slice(header[0].length))) {
        functions.set(name, line);
        name = null;
      }
    } else if (name !== null) {
      body.push(line);
      if (line === '}') {
        functions.set(name, body.join('\n'));
        name = null;
      }
    }
  }
  return functions;
}

/** How two scripts' functions compare, leaving out the names in `allowed`. */
function compareScripts(a: string, b: string, allowed: ReadonlySet<string>) {
  const fa = shellFunctions(a);
  const fb = shellFunctions(b);
  const names = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  return {
    differing: names.filter((n) => !allowed.has(n) && fa.has(n) && fb.has(n) && fa.get(n) !== fb.get(n)),
    onlyFirst: names.filter((n) => !allowed.has(n) && !fb.has(n)),
    onlySecond: names.filter((n) => !allowed.has(n) && !fa.has(n)),
    identicalAllowed: names.filter((n) => allowed.has(n) && fa.get(n) === fb.get(n)),
  };
}

const read = (name: string): string => fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');

describe('shellFunctions', () => {
  it('reads multi-line and one-line functions, with Windows line endings too', () => {
    // Arrange
    const text = ['#!/usr/bin/env bash', 'say() { echo hi; }', 'run() {', '  local x=1', '  if true; then', '    echo "$x"', '  fi', '}', 'main "$@"'].join('\r\n');

    // Act
    const functions = shellFunctions(text);

    // Assert
    expect([...functions.keys()]).toEqual(['say', 'run']);
    expect(functions.get('say')).toBe('say() { echo hi; }');
    expect(functions.get('run')).toBe(['run() {', '  local x=1', '  if true; then', '    echo "$x"', '  fi', '}'].join('\n'));
  });
});

describe('compareScripts', () => {
  it('reports a changed body, a function missing from one side and an allowed function that no longer differs', () => {
    // Arrange
    const a = ['same() {', '  echo 1', '}', 'changed() {', '  echo a', '}', 'only_a() {', '}', 'os() {', '  echo same', '}'].join('\n');
    const b = ['same() {', '  echo 1', '}', 'changed() {', '  echo b', '}', 'only_b() {', '}', 'os() {', '  echo same', '}'].join('\n');

    // Act
    const result = compareScripts(a, b, new Set(['os']));

    // Assert
    expect(result).toEqual({ differing: ['changed'], onlyFirst: ['only_a'], onlySecond: ['only_b'], identicalAllowed: ['os'] });
  });
});

describe('start-linux.sh and start-macos.command', () => {
  it('share every function outside the OS-specific list, byte for byte', () => {
    // Arrange
    const linux = read(LINUX);
    const macos = read(MACOS);

    // Act
    const result = compareScripts(linux, macos, OS_SPECIFIC);

    // Assert
    expect(result.differing, `copy the change into both ${LINUX} and ${MACOS}`).toEqual([]);
    expect(result.onlyFirst, `defined only in ${LINUX}`).toEqual([]);
    expect(result.onlySecond, `defined only in ${MACOS}`).toEqual([]);
  });

  it('keep the OS-specific list exact: each name exists and is still written differently', () => {
    // Arrange
    const linux = shellFunctions(read(LINUX));
    const macos = shellFunctions(read(MACOS));

    // Act
    const unknown = [...OS_SPECIFIC].filter((n) => !linux.has(n) && !macos.has(n));
    const { identicalAllowed } = compareScripts(read(LINUX), read(MACOS), OS_SPECIFIC);

    // Assert
    expect(unknown, 'no such function: remove it from OS_SPECIFIC').toEqual([]);
    expect(identicalAllowed, 'now identical: remove it from OS_SPECIFIC').toEqual([]);
  });

  it.each([LINUX, MACOS])('%s: every function header is read, none defined twice', (name) => {
    // Arrange
    const text = read(name);

    // Act
    const headers = text.match(/^[a-z_0-9]+\(\) \{/gm) ?? [];

    // Assert
    expect(shellFunctions(text).size).toBe(headers.length);
    expect(headers.length).toBeGreaterThan(OS_SPECIFIC.size);
  });
});
