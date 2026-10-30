import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import { isPrunable, localDay, pruneLogs, retentionDays, RotatingLogFile, serverLogName } from '../../src/core/log-files.js';
import { tempDir } from './helpers.js';

// The log files in <data>/logs: one per local day, cut by size, pruned by age and total size.
// The day is the local one: the times below are local times, so the tests hold in every time zone.

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 9, 26, 12, 0, 0).getTime();

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** A RotatingLogFile in `dir`, ended (and closed) when the test finishes, before `dir` goes: Windows cannot delete an open file's folder. */
function logFile(dir: string, o: ConstructorParameters<typeof RotatingLogFile>[1]): RotatingLogFile {
  const f = new RotatingLogFile(dir, o);
  onTestFinished(() => f.end());
  return f;
}

describe('RotatingLogFile', () => {
  it('writes swarmcast-YYYY-MM-DD.log in the local day', () => {
    // Arrange
    const f = logFile(tempDir('sc-logs-'), { now: () => NOON });
    // Act
    f.write('hello\n');
    f.flushSync();
    // Assert
    expect(path.basename(f.file)).toBe('swarmcast-2026-10-26.log');
    expect(lines(f.file)).toEqual(['hello']);
  });

  it('names the file and the day from the local date', () => {
    // Act
    const name = serverLogName(NOON);
    const day = localDay(NOON);
    // Assert
    expect(name).toBe('swarmcast-2026-10-26.log');
    expect(day).toBe('2026-10-26');
  });

  it('cuts the file by size while running, keeping every line whole and in order', () => {
    // Arrange
    const dir = tempDir('sc-logs-');
    const f = logFile(dir, { now: () => NOON, maxBytes: 1000, keep: 3 });
    const all = Array.from({ length: 60 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(40) }));
    // Act
    for (const line of all) f.write(`${line}\n`);
    f.flushSync();
    // Assert
    const base = path.join(dir, 'swarmcast-2026-10-26.log');
    for (const n of [1, 2, 3]) expect(fs.statSync(`${base}.${n}`).size).toBeLessThanOrEqual(1000);
    expect(fs.existsSync(`${base}.4`)).toBe(false);
    expect(fs.statSync(base).size).toBeLessThanOrEqual(1000);
    const kept = [`${base}.3`, `${base}.2`, `${base}.1`, base].flatMap(lines);
    for (const l of kept) expect(() => JSON.parse(l)).not.toThrow();
    expect(kept).toEqual(all.slice(all.length - kept.length));
  });

  it('starts a new file at local midnight', () => {
    // Arrange
    const dir = tempDir('sc-logs-');
    let now = NOON;
    const f = logFile(dir, { now: () => now });
    f.write('day one\n');
    // Act
    now = NOON + DAY;
    f.write('day two\n');
    f.flushSync();
    // Assert
    expect(lines(path.join(dir, 'swarmcast-2026-10-26.log'))).toEqual(['day one']);
    expect(lines(path.join(dir, 'swarmcast-2026-10-27.log'))).toEqual(['day two']);
    expect(path.basename(f.file)).toBe('swarmcast-2026-10-27.log');
  });

  it('appends to the file of the day after a restart and rotates it once it is full', () => {
    // Arrange
    const dir = tempDir('sc-logs-');
    const file = path.join(dir, serverLogName(NOON));
    fs.writeFileSync(file, 'x'.repeat(998) + '\n');
    const f = logFile(dir, { now: () => NOON, maxBytes: 1000 });
    // Act
    f.write('next\n');
    f.flushSync();
    // Assert
    expect(fs.statSync(`${file}.1`).size).toBe(999);
    expect(lines(file)).toEqual(['next']);
  });

  it('end() is final: lines written later are dropped, without an error', async () => {
    // Arrange
    const f = logFile(tempDir('sc-logs-'), { now: () => NOON });
    f.write('before\n');
    // Act
    await f.end();
    const late = () => {
      f.write('after\n');
      f.flushSync();
    };
    // Assert
    expect(late).not.toThrow();
    expect(lines(f.file)).toEqual(['before']);
  });

  it('end() resolves once the file is closed, so its folder can go at once; a second end() is the same', async () => {
    // Arrange
    const dir = tempDir('sc-logs-');
    const f = new RotatingLogFile(dir, { now: () => NOON });
    f.write('line\n');
    // Act
    const first = f.end();
    const second = f.end();
    await first;
    // Assert
    expect(second).toBe(first);
    expect(() => fs.rmSync(dir, { recursive: true })).not.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('is the logger file destination (multistream), with secrets still redacted', () => {
    // Arrange
    let file: RotatingLogFile | undefined;
    const log = createLogger({ logsDir: tempDir('sc-logs-'), stdout: false, onFile: (f) => (file = f) });
    onTestFinished(() => file?.end());
    // Act
    log.info({ streamKey: 'sc_abcdefghijklmnopqrstuvwx' }, 'joined via https://x.trycloudflare.com/join/SECRETtoken123');
    file!.flushSync();
    // Assert
    const text = fs.readFileSync(file!.file, 'utf8');
    expect(path.basename(file!.file)).toMatch(/^swarmcast-\d{4}-\d{2}-\d{2}\.log$/);
    expect(text).toContain('/join/[redacted]');
    expect(text).not.toContain('SECRETtoken123');
    expect(text).not.toContain('sc_abcdefghijklmnopqrstuvwx');
  });
});

describe('pruneLogs', () => {
  function touch(dir: string, name: string, ageDays: number, size = 10): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x'.repeat(size));
    const t = new Date(NOON - ageDays * DAY);
    fs.utimesSync(file, t, t);
    return file;
  }

  it('deletes log files and old exports past the retention, and nothing else', () => {
    // Arrange
    const logs = tempDir('sc-logs-');
    const exports = tempDir('sc-logs-');
    touch(logs, 'swarmcast-2026-10-01.log', 25);
    touch(logs, 'swarmcast-2026-10-01.log.2', 25);
    touch(logs, 'swarmcast.log.1', 30);
    touch(logs, 'desktop.log.2', 20);
    touch(logs, 'swarmcast-2026-10-20.log', 6);
    touch(logs, 'desktop.log', 15);
    touch(logs, 'notes.txt', 400);
    touch(exports, 'SwarmCast-logs-0.1.0-20260901-1200.zip', 40);
    touch(exports, 'SwarmCast-logs-0.1.0-20261025-1200.zip', 1);
    // Act
    const deleted = pruneLogs({ dirs: [logs, exports], maxAgeDays: 14, now: NOON, protect: (f) => path.basename(f) === 'desktop.log' });
    // Assert
    expect(deleted.map((f) => path.basename(f)).sort()).toEqual([
      'SwarmCast-logs-0.1.0-20260901-1200.zip',
      'desktop.log.2',
      'swarmcast-2026-10-01.log',
      'swarmcast-2026-10-01.log.2',
      'swarmcast.log.1',
    ]);
    expect(fs.readdirSync(logs).sort()).toEqual(['desktop.log', 'notes.txt', 'swarmcast-2026-10-20.log']);
    expect(fs.readdirSync(exports)).toEqual(['SwarmCast-logs-0.1.0-20261025-1200.zip']);
  });

  it('caps the total size by deleting the oldest files first', () => {
    // Arrange
    const logs = tempDir('sc-logs-');
    touch(logs, 'swarmcast-2026-10-21.log', 5, 400);
    touch(logs, 'swarmcast-2026-10-22.log', 4, 400);
    touch(logs, 'swarmcast-2026-10-23.log', 3, 400);
    touch(logs, 'swarmcast-2026-10-26.log', 0, 400);
    // Act
    const deleted = pruneLogs({ dirs: [logs], maxAgeDays: 14, maxTotalBytes: 1000, now: NOON });
    // Assert
    expect(deleted.map((f) => path.basename(f))).toEqual(['swarmcast-2026-10-21.log', 'swarmcast-2026-10-22.log']);
  });

  it('the protected (current) file stays even if it alone is over the cap', () => {
    // Arrange
    const logs = tempDir('sc-logs-');
    touch(logs, 'swarmcast-2026-10-23.log', 3, 400);
    touch(logs, 'swarmcast-2026-10-26.log', 0, 400);
    // Act
    const deleted = pruneLogs({ dirs: [logs], maxAgeDays: 14, maxTotalBytes: 100, now: NOON, protect: (f) => f.endsWith('10-26.log') });
    // Assert
    expect(deleted.map((f) => path.basename(f))).toEqual(['swarmcast-2026-10-23.log']);
    expect(fs.readdirSync(logs)).toEqual(['swarmcast-2026-10-26.log']);
  });

  it('ignores missing folders', () => {
    // Act
    const deleted = pruneLogs({ dirs: [path.join(tempDir('sc-logs-'), 'missing')], maxAgeDays: 3 });
    // Assert
    expect(deleted).toEqual([]);
  });

  it.each([
    ['desktop.log.1', true],
    ['swarmcast-2026-10-26.log', true],
    ['config.json', false],
    ['secrets.json', false],
    ['SwarmCast-logs-0.1.0-20261026-1200.zip', true],
    ['holiday.zip', false],
  ])('knows what it may delete: %s → %s', (name, prunable) => {
    // Act
    const p = isPrunable(name);
    // Assert
    expect(p).toBe(prunable);
  });

  it.each([
    [undefined, 14],
    [1, 3],
    [365, 90],
    [30, 30],
  ])('clamps the retention setting to 3..90 days: %s → %i', (days, clamped) => {
    // Act
    const d = retentionDays(days);
    // Assert
    expect(d).toBe(clamped);
  });
});
