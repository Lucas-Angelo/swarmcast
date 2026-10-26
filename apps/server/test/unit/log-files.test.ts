import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/core/logger.js';
import { isPrunable, localDay, pruneLogs, retentionDays, RotatingLogFile, serverLogName } from '../../src/core/log-files.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-logs-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 9, 26, 12, 0, 0).getTime();

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

describe('RotatingLogFile', () => {
  it('writes swarmcast-YYYY-MM-DD.log in the local day', () => {
    const dir = tmp();
    const f = new RotatingLogFile(dir, { now: () => NOON });
    f.write('hello\n');
    f.flushSync();
    expect(path.basename(f.file)).toBe('swarmcast-2026-10-26.log');
    expect(serverLogName(NOON)).toBe('swarmcast-2026-10-26.log');
    expect(localDay(NOON)).toBe('2026-10-26');
    expect(lines(f.file)).toEqual(['hello']);
    f.end();
  });

  it('cuts the file by size while running, keeping every line whole and in order', () => {
    const dir = tmp();
    const f = new RotatingLogFile(dir, { now: () => NOON, maxBytes: 1000, keep: 3 });
    const all: string[] = [];
    for (let i = 0; i < 60; i++) {
      const line = JSON.stringify({ n: i, pad: 'x'.repeat(40) });
      all.push(line);
      f.write(`${line}\n`);
    }
    f.flushSync();
    const base = path.join(dir, 'swarmcast-2026-10-26.log');
    // keep = 3: .1 .2 .3 exist, .4 was never kept.
    for (const n of [1, 2, 3]) expect(fs.statSync(`${base}.${n}`).size).toBeLessThanOrEqual(1000);
    expect(fs.existsSync(`${base}.4`)).toBe(false);
    expect(fs.statSync(base).size).toBeLessThanOrEqual(1000);
    // Oldest part first: .3, .2, .1, then the current file. No line lost, split or reordered.
    const kept = [`${base}.3`, `${base}.2`, `${base}.1`, base].flatMap(lines);
    for (const l of kept) expect(() => JSON.parse(l)).not.toThrow();
    expect(kept).toEqual(all.slice(all.length - kept.length));
    f.end();
  });

  it('starts a new file at local midnight', () => {
    const dir = tmp();
    let now = NOON;
    const f = new RotatingLogFile(dir, { now: () => now });
    f.write('day one\n');
    now = NOON + DAY;
    f.write('day two\n');
    f.flushSync();
    expect(lines(path.join(dir, 'swarmcast-2026-10-26.log'))).toEqual(['day one']);
    expect(lines(path.join(dir, 'swarmcast-2026-10-27.log'))).toEqual(['day two']);
    expect(path.basename(f.file)).toBe('swarmcast-2026-10-27.log');
    f.end();
  });

  it('appends to the file of the day after a restart and rotates it once it is full', () => {
    const dir = tmp();
    const file = path.join(dir, serverLogName(NOON));
    fs.writeFileSync(file, 'x'.repeat(998) + '\n');
    const f = new RotatingLogFile(dir, { now: () => NOON, maxBytes: 1000 });
    f.write('next\n');
    f.flushSync();
    expect(fs.statSync(`${file}.1`).size).toBe(999);
    expect(lines(file)).toEqual(['next']);
    f.end();
  });

  it('is the logger file destination (multistream), with secrets still redacted', () => {
    const dir = tmp();
    let file: RotatingLogFile | undefined;
    const log = createLogger({ logsDir: dir, stdout: false, onFile: (f) => (file = f) });
    log.info({ streamKey: 'sc_abcdefghijklmnopqrstuvwx' }, 'joined via https://x.trycloudflare.com/join/SECRETtoken123');
    file!.flushSync();
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
    const logs = tmp();
    const exports = tmp();
    touch(logs, 'swarmcast-2026-10-01.log', 25);
    touch(logs, 'swarmcast-2026-10-01.log.2', 25);
    touch(logs, 'swarmcast.log.1', 30);
    touch(logs, 'desktop.log.2', 20);
    touch(logs, 'swarmcast-2026-10-20.log', 6);
    touch(logs, 'desktop.log', 15);
    touch(logs, 'notes.txt', 400);
    touch(exports, 'SwarmCast-logs-0.1.0-20260901-1200.zip', 40);
    touch(exports, 'SwarmCast-logs-0.1.0-20261025-1200.zip', 1);
    const deleted = pruneLogs({ dirs: [logs, exports], maxAgeDays: 14, now: NOON, protect: (f) => path.basename(f) === 'desktop.log' });
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
    const logs = tmp();
    touch(logs, 'swarmcast-2026-10-21.log', 5, 400);
    touch(logs, 'swarmcast-2026-10-22.log', 4, 400);
    touch(logs, 'swarmcast-2026-10-23.log', 3, 400);
    touch(logs, 'swarmcast-2026-10-26.log', 0, 400);
    const deleted = pruneLogs({ dirs: [logs], maxAgeDays: 14, maxTotalBytes: 1000, now: NOON });
    expect(deleted.map((f) => path.basename(f))).toEqual(['swarmcast-2026-10-21.log', 'swarmcast-2026-10-22.log']);
    // The protected (current) file stays even if it alone is over the cap.
    const deleted2 = pruneLogs({ dirs: [logs], maxAgeDays: 14, maxTotalBytes: 100, now: NOON, protect: (f) => f.endsWith('10-26.log') });
    expect(deleted2.map((f) => path.basename(f))).toEqual(['swarmcast-2026-10-23.log']);
    expect(fs.readdirSync(logs)).toEqual(['swarmcast-2026-10-26.log']);
  });

  it('ignores missing folders, and knows what it may delete', () => {
    expect(pruneLogs({ dirs: [path.join(os.tmpdir(), 'sc-missing-xyz')], maxAgeDays: 3 })).toEqual([]);
    expect(isPrunable('desktop.log.1')).toBe(true);
    expect(isPrunable('swarmcast-2026-10-26.log')).toBe(true);
    expect(isPrunable('config.json')).toBe(false);
    expect(isPrunable('secrets.json')).toBe(false);
    expect(isPrunable('SwarmCast-logs-0.1.0-20261026-1200.zip')).toBe(true);
    expect(isPrunable('holiday.zip')).toBe(false);
  });

  it('clamps the retention setting to 3..90 days', () => {
    expect(retentionDays(undefined)).toBe(14);
    expect(retentionDays(1)).toBe(3);
    expect(retentionDays(365)).toBe(90);
    expect(retentionDays(30)).toBe(30);
  });
});
