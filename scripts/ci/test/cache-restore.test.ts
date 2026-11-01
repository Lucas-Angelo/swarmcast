// .github/actions/cache-restore/restore.mjs: a cache restore that stalls is cut
// off and tried once more, a failed one is tried once more, a plain miss is not, and every outcome
// is a hit or a miss. Fake restore scripts stand in for actions/cache's restore-only entry point.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPaths, findRestoreScript, parseOutputs, restore } from '../../../.github/actions/cache-restore/restore.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-restore-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake restore script; `body` runs with `out(name, value)` and `tries()` (1, 2, ...) in scope. */
function fake(body: string) {
  const file = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.cjs`);
  const counter = path.join(dir, 'tries');
  fs.writeFileSync(
    file,
    `const fs = require('fs');
     const out = (n, v) => fs.appendFileSync(process.env.GITHUB_OUTPUT, n + '=' + v + '\\n');
     const tries = () => { const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1; fs.writeFileSync(${JSON.stringify(counter)}, String(n)); return n; };
     ${body}`,
  );
  return file;
}

const KEY = 'node-cache-Linux-x64-npm-08e3fc1865e9c2877bfae6e5e4e5e8dabf045247662ec59b94a2edcf5f41cb4f';
const base = () => ({ paths: [path.join(dir, 'npm')], key: KEY, restoreKeys: ['node-cache-Linux-x64-npm-'], timeoutMs: 5000, log: () => {} });

describe('restore', () => {
  it('returns a hit for the exact key in one try, with the inputs actions/cache reads', async () => {
    // Arrange
    const script = fake(`tries();
      out('cache-hit', 'true');
      out('cache-matched-key', process.env.INPUT_KEY);
      out('seen', JSON.stringify([process.env.INPUT_PATH, process.env['INPUT_RESTORE-KEYS'], process.env.INPUT_ENABLECROSSOSARCHIVE, process.env['INPUT_FAIL-ON-CACHE-MISS'], process.env['INPUT_LOOKUP-ONLY']]));
      console.log('seen ' + fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8').split('seen=')[1]);`);
    const lines: string[] = [];

    // Act
    const result = await restore({ ...base(), script, log: (l: string) => lines.push(l) });

    // Assert
    expect(result).toEqual({ hit: true, matchedKey: KEY, tries: [{ timedOut: false, failed: false, seconds: expect.any(Number) }] });
    expect(JSON.parse(lines.join('\n').split('seen ')[1])).toEqual([path.join(dir, 'npm'), 'node-cache-Linux-x64-npm-', 'false', 'false', 'false']);
  });

  it('reports a restore-keys match as a miss of the key (cache-hit false) with its matched key', async () => {
    // Arrange
    const script = fake(`out('cache-hit', 'false'); out('cache-matched-key', 'node-cache-Linux-x64-npm-old');`);

    // Act
    const result = await restore({ ...base(), script });

    // Assert
    expect(result.hit).toBe(false);
    expect(result.matchedKey).toBe('node-cache-Linux-x64-npm-old');
  });

  it('does not try again after a plain miss', async () => {
    // Arrange
    const script = fake(`tries(); console.log('Cache not found for input keys: x'); out('cache-hit', 'false');`);

    // Act
    const result = await restore({ ...base(), script });

    // Assert
    expect(result).toEqual({ hit: false, matchedKey: '', tries: [{ timedOut: false, failed: false, seconds: expect.any(Number) }] });
  });

  it('cuts off a try that hangs (and what it started), clears the half-restored path, and tries once more', async () => {
    // Arrange: the first try leaves a file behind and hangs, with a child of its own (like tar);
    // the second restores.
    fs.mkdirSync(path.join(dir, 'npm'));
    const script = fake(`if (tries() === 1) {
        fs.writeFileSync(${JSON.stringify(path.join(dir, 'npm', 'half'))}, 'x');
        require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        setInterval(() => {}, 1000);
      } else {
        console.log('second try: ' + fs.existsSync(${JSON.stringify(path.join(dir, 'npm', 'half'))}));
        out('cache-hit', 'true'); out('cache-matched-key', process.env.INPUT_KEY);
      }`);
    const lines: string[] = [];
    const start = Date.now();

    // Act
    const result = await restore({ ...base(), script, timeoutMs: 1500, log: (l: string) => lines.push(l) });

    // Assert
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(result.hit).toBe(true);
    expect(result.tries.map((t: { timedOut: boolean }) => t.timedOut)).toEqual([true, false]);
    expect(lines).toContain('second try: false');
    expect(lines.some((l) => l.startsWith('::warning::') && l.includes('try 1 of 2 cut off after 2 s, trying again'))).toBe(true);
  });

  it('tries once more after "Failed to restore" (a failed download reports a miss)', async () => {
    // Arrange
    const script = fake(`if (tries() === 1) { console.log('::warning::Failed to restore: read ECONNRESET'); out('cache-hit', 'false'); }
      else { out('cache-hit', 'true'); out('cache-matched-key', process.env.INPUT_KEY); }`);

    // Act
    const result = await restore({ ...base(), script });

    // Assert
    expect(result.hit).toBe(true);
    expect(result.tries.map((t: { failed: boolean }) => t.failed)).toEqual([true, false]);
  });

  it('goes on without the cache when every try hangs, within tries x the time limit', async () => {
    // Arrange
    const script = fake(`setInterval(() => {}, 1000);`);
    const lines: string[] = [];
    const start = Date.now();

    // Act
    const result = await restore({ ...base(), script, timeoutMs: 800, log: (l: string) => lines.push(l) });

    // Assert
    expect(Date.now() - start).toBeLessThan(6000);
    expect(result).toEqual({ hit: false, matchedKey: '', tries: [expect.objectContaining({ timedOut: true }), expect.objectContaining({ timedOut: true })] });
    expect(lines.at(-1)).toMatch(/try 2 of 2 cut off after 1 s, going on without it/);
  });

  it('treats a crash (non-zero exit) as a failed try', async () => {
    // Arrange
    const script = fake(`tries() === 1 ? process.exit(3) : (out('cache-hit', 'true'), out('cache-matched-key', process.env.INPUT_KEY));`);

    // Act
    const result = await restore({ ...base(), script });

    // Assert
    expect(result.hit).toBe(true);
    expect(result.tries.length).toBe(2);
  });
});

describe('helpers', () => {
  it('parseOutputs reads name=value lines and name<<EOF blocks', () => {
    // Act
    const outputs = parseOutputs('cache-hit=false\ncache-matched-key=a=b\nmulti<<ghadelim\nx\ny\nghadelim\n');

    // Assert
    expect(outputs).toEqual({ 'cache-hit': 'false', 'cache-matched-key': 'a=b', multi: 'x\ny' });
  });

  it('clearPaths removes plain paths and glob matches', () => {
    // Arrange
    fs.mkdirSync(path.join(dir, 'debs'));
    fs.writeFileSync(path.join(dir, 'debs', 'a.deb'), '');
    fs.writeFileSync(path.join(dir, 'debs', 'keep.txt'), '');
    fs.mkdirSync(path.join(dir, 'npm', '_cacache'), { recursive: true });

    // Act
    clearPaths([path.join(dir, 'debs', '*.deb'), path.join(dir, 'npm'), path.join(dir, 'missing')]);

    // Assert
    expect(fs.readdirSync(path.join(dir, 'debs'))).toEqual(['keep.txt']);
    expect(fs.existsSync(path.join(dir, 'npm'))).toBe(false);
  });

  it("findRestoreScript finds actions/cache's restore-only entry point among the downloaded actions", () => {
    // Arrange
    const script = path.join(dir, '_actions', 'actions', 'cache', '55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'dist', 'restore-only', 'index.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '');
    fs.mkdirSync(path.join(dir, '_actions', 'actions', 'cache', 'other-without-dist'), { recursive: true });

    // Act / Assert
    expect(findRestoreScript(path.join(dir, '_actions'))).toBe(script);
    expect(findRestoreScript(path.join(dir, 'nothing'))).toBeNull();
  });
});
