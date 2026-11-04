// .github/actions/fetch-remote/fetch.mjs: the remote actions our steps run are fetched with git at
// their pins, tried again after any failure (the runner's own download is not tried again after a
// 404: pipeline run 41636784175), and no action of ours makes the runner download one itself.
// A fake git stands in for the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIONS_DIR, PINS_FILE, actionDir, fetchAction, fetchActions, parsePins } from '../../../.github/actions/fetch-remote/fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHA = 'd1527c8f67ef9af357290475d4af4b0fab8f12e0';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-remote-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type GitResult = { ok: boolean; output: string; timedOut: boolean };
/** A fake git: `fetch` answers from `fetches` in turn (then ok), `rev-parse` prints `head`. */
function fakeGit({ fetches = [] as GitResult[], head = SHA } = {}) {
  const calls: string[][] = [];
  const git = (args: string[], { cwd }: { cwd: string }): GitResult => {
    const cmd = args.filter((a, i) => a !== '-c' && args[i - 1] !== '-c');
    calls.push(cmd);
    if (cmd[0] === 'init') fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    if (cmd[0] === 'fetch') return fetches.shift() ?? { ok: true, output: '', timedOut: false };
    if (cmd[0] === 'checkout') fs.writeFileSync(path.join(cwd, 'action.yml'), 'name: x\n');
    if (cmd[0] === 'rev-parse') return { ok: true, output: head, timedOut: false };
    return { ok: true, output: '', timedOut: false };
  };
  return { git, calls };
}
const notFound: GitResult = { ok: false, output: "fatal: unable to access 'https://github.com/Swatinem/rust-cache.git/': The requested URL returned error: 404", timedOut: false };
const stalled: GitResult = { ok: false, output: '', timedOut: true };
const base = () => ({ repo: 'Swatinem/rust-cache', sha: SHA, version: 'v2.9.3', dir: path.join(dir, 'rust-cache'), sleep: async () => {}, log: () => {} });

describe('fetchAction', () => {
  it('fetches the pinned commit at depth 1 into a fresh repository, as committed (no CRLF)', async () => {
    // Arrange
    const { git, calls } = fakeGit();
    const raw: string[][] = [];
    const lines: string[] = [];

    // Act
    const result = await fetchAction({ ...base(), git: (a: string[], o: { cwd: string }) => (raw.push(a), git(a, o)), log: (l: string) => lines.push(l) });

    // Assert
    expect(result.tries).toBe(1);
    expect(calls).toEqual([
      ['init', '-q'],
      ['fetch', '--depth=1', '--no-tags', '--quiet', 'https://github.com/Swatinem/rust-cache.git', SHA],
      ['checkout', '-q', '--detach', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
    ]);
    expect(raw[2]).toEqual(expect.arrayContaining(['core.autocrlf=false', 'core.eol=lf', 'credential.helper=']));
    expect(fs.existsSync(path.join(dir, 'rust-cache', 'action.yml'))).toBe(true);
    expect(lines).toEqual([expect.stringMatching(/^Swatinem\/rust-cache@d1527c8f\w+ \(v2\.9\.3\): fetched in [\d.]+ s$/)]);
  });

  it('tries again after a 404 and after a stalled fetch, with a warning and a wait before each try', async () => {
    // Arrange
    const { git } = fakeGit({ fetches: [notFound, stalled] });
    const waits: number[] = [];
    const lines: string[] = [];

    // Act
    const result = await fetchAction({ ...base(), git, sleep: async (s: number) => void waits.push(s), log: (l: string) => lines.push(l) });

    // Assert
    expect(result.tries).toBe(3);
    expect(waits).toEqual([5, 10]);
    expect(lines[0]).toMatch(/^::warning::Swatinem\/rust-cache@d1527c8f\w+ \(v2\.9\.3\): try 1 of 4: git fetch failed: .*error: 404; trying again in 5 s$/);
    expect(lines[1]).toMatch(/try 2 of 4: git fetch was cut off after 30 s; trying again in 10 s$/);
    expect(lines[2]).toMatch(/fetched in [\d.]+ s \(try 3 of 4\)$/);
  });

  it('fails after the fourth failed try and leaves nothing half-fetched', async () => {
    // Arrange
    const { git, calls } = fakeGit({ fetches: [notFound, notFound, notFound, notFound] });

    // Act / Assert
    await expect(fetchAction({ ...base(), git })).rejects.toThrow(/^Swatinem\/rust-cache@d1527c8f\w+ \(v2\.9\.3\): not fetched after 4 tries in [\d.]+ s; last: git fetch failed: .*404/);
    expect(calls.filter((c) => c[0] === 'fetch')).toHaveLength(4);
    expect(fs.existsSync(path.join(dir, 'rust-cache'))).toBe(false);
  });

  it('does not take a checkout of another commit', async () => {
    // Arrange
    const { git } = fakeGit({ head: '0000000000000000000000000000000000000000' });

    // Act / Assert
    await expect(fetchAction({ ...base(), git })).rejects.toThrow(/last: HEAD is 0{40}, not d1527c8f/);
  });

  it('does nothing for an action fetched completely before, and fetches again over a half-done one', async () => {
    // Arrange
    const first = fakeGit();
    await fetchAction({ ...base(), git: first.git });
    const again = fakeGit();
    const half = { ...base(), dir: path.join(dir, 'half') };
    fs.mkdirSync(path.join(half.dir, '.git'), { recursive: true });

    // Act
    const done = await fetchAction({ ...base(), git: again.git });
    const redone = await fetchAction({ ...half, git: again.git });

    // Assert
    expect(done).toEqual({ tries: 0, seconds: 0 });
    expect(redone.tries).toBe(1);
    expect(again.calls.filter((c) => c[0] === 'fetch')).toHaveLength(1);
  });
});

describe('pins', () => {
  it('parsePins reads owner/repo, SHA and version from uses: lines, and refuses two SHAs for one repository', () => {
    // Act
    const pins = parsePins(
      [
        'steps:',
        '  - if: ${{ false }}',
        '    uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
        '  - uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
        `  - uses: Swatinem/rust-cache@${SHA} # v2.9.3`,
        '  - uses: ./.github/actions/setup',
      ].join('\n'),
    );

    // Assert
    expect([...pins]).toEqual([
      ['actions/cache', { sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', version: 'v6.1.0' }],
      ['Swatinem/rust-cache', { sha: SHA, version: 'v2.9.3' }],
    ]);
    expect(() => parsePins(`uses: a/b@${SHA} # v1\nuses: a/b@${'1'.repeat(40)} # v2`)).toThrow(/a\/b is pinned twice/);
  });

  it('fetchActions puts each repository at its pin from the pins file, and refuses one without a pin', async () => {
    // Arrange
    fs.mkdirSync(path.join(dir, path.dirname(PINS_FILE)), { recursive: true });
    fs.writeFileSync(path.join(dir, PINS_FILE), `    - uses: Swatinem/rust-cache@${SHA} # v2.9.3\n`);
    const { git, calls } = fakeGit();

    // Act
    const dirs = await fetchActions({ workspace: dir, repos: ['Swatinem/rust-cache'], git, log: () => {} });

    // Assert
    expect(dirs).toEqual([path.join(dir, '.git', 'remote-actions', 'Swatinem', 'rust-cache')]);
    expect(calls.find((c) => c[0] === 'fetch')).toContain(SHA);
    await expect(fetchActions({ workspace: dir, repos: ['actions/cache'], git })).rejects.toThrow(/actions\/cache has no pin/);
  });
});

/** Every `uses:` value in the workflows and our own actions, with its file. */
function allUses() {
  const files = [
    ...fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => f.endsWith('.yml')).map((f) => path.join('.github', 'workflows', f)),
    ...fs.globSync('.github/actions/**/action.yml', { cwd: ROOT }),
  ];
  return files.flatMap((file) =>
    fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1])
      .filter((u): u is string => !!u)
      .map((uses) => ({ file: file.split(path.sep).join('/'), uses })),
  );
}

describe('the repository', () => {
  const pins = parsePins(fs.readFileSync(path.join(ROOT, PINS_FILE), 'utf8'));
  const local = `./${ACTIONS_DIR.split(path.sep).join('/')}/`;

  it('runs no remote action from inside one of our actions: the runner would download it, with no new try after a 404', () => {
    // Act
    const remote = allUses().filter(({ file, uses }) => file.startsWith('.github/actions/') && file !== PINS_FILE.split(path.sep).join('/') && !uses.startsWith('./'));

    // Assert
    expect(remote).toEqual([]);
  });

  it('has a pin for every action a step runs from the fetched copies, and a fetch-remote step or cache-restore for it', () => {
    // Arrange
    const fetched = allUses().filter(({ uses }) => uses.startsWith(local));

    // Act
    const unpinned = fetched.filter(({ uses }) => !pins.has(uses.slice(local.length).split('/').slice(0, 2).join('/')));
    const unfetched = fetched.filter(({ file, uses }) => {
      const repo = uses.slice(local.length).split('/').slice(0, 2).join('/');
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      return !new RegExp(`uses: \\./\\.github/actions/fetch-remote\\s*\\n(?:\\s+.*\\n)*?\\s+repos: .*${repo.replace('/', '\\/')}`).test(text);
    });

    // Assert
    expect(fetched.length).toBeGreaterThan(0);
    expect(unpinned).toEqual([]);
    expect(unfetched).toEqual([]);
  });

  it('pins each repository at the same commit as the workflows that still run it as a remote action', () => {
    // Act
    const differing = allUses()
      .filter(({ file }) => file.startsWith('.github/workflows/'))
      .map(({ file, uses }) => ({ file, uses, m: /^([\w.-]+\/[\w.-]+)(?:\/[^@]*)?@([0-9a-f]{40})$/.exec(uses) }))
      .filter(({ m }) => m && pins.has(m[1]!) && pins.get(m[1]!)!.sha !== m[2])
      .map(({ file, uses }) => `${file}: ${uses}`);

    // Assert
    expect(differing).toEqual([]);
  });

  it('keeps the copies inside .git, where nothing that reads the workspace sees them', () => {
    expect(actionDir('/w', 'actions/cache')).toBe(path.join('/w', '.git', 'remote-actions', 'actions', 'cache'));
  });
});
