// .github/actions/fetch-artifact: try 1 (download.mjs) runs download-artifact with a time limit
// that follows the listed size and a cut when the destination stops growing, so a stalled blob
// download ends long before the calling step's limit and try 2 (rest.sh) has its own time
// (release rehearsal 44018931697: one stalled try used the whole 10 minutes, try 2 never ran).
// Fake scripts stand in for download-artifact's dist/index.js. Time is the test's: the Watchdog
// takes the clock as a number, and downloadOnce's measurements run when the test advances its
// clock, so no try races a real limit however slow the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIMIT_BASE_S,
  LIST_S,
  PER_ARTIFACT_S,
  RATE_FLOOR_BPS,
  STALL_S,
  Watchdog,
  bytesUnder,
  childEnv,
  downloadOnce,
  parseListed,
  tryLimitMs,
} from '../../../.github/actions/fetch-artifact/download.mjs';

const REST_SH = path.join(import.meta.dirname, '../../../.github/actions/fetch-artifact/rest.sh');
const LINUX_DOCKER_BYTES = 334_827_666;
const LISTED_LINE = `- linux-docker-x64 (ID: 14299794010, Size: ${LINUX_DOCKER_BYTES}, Expected Digest: sha256:2fcaf068d78a943adb81aa3817114f8d58ac6be33215db5b011b4d835615bb42)`;

let dir: string;
let dest: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-artifact-test-'));
  dest = path.join(dir, 'dest');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake download-artifact; `body` runs with `fs`, `path` and `dest` (its INPUT_PATH) in scope. */
function fake(body: string): string {
  const file = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, `const fs = require('fs'); const path = require('path'); const dest = process.env.INPUT_PATH; ${body}`);
  return file;
}

/** The measurements' clock, moved by the test: `advance(ms)` moves it and takes one measurement. */
class ManualClock {
  t = 1_000_000;
  private tick: (() => void) | null = null;
  readonly clock = {
    now: (): number => this.t,
    every: (_ms: number, fn: () => void): (() => void) => {
      this.tick = fn;
      return () => {
        this.tick = null;
      };
    },
  };
  advance(ms: number): void {
    this.t += ms;
    this.tick?.();
  }
}

const env = (): NodeJS.ProcessEnv => childEnv({ PATH: process.env.PATH }, { name: 'linux-docker-x64', dest });

describe('tryLimitMs', () => {
  it('gives the 335 MB Docker build its bytes at the floor rate plus the base, well over its slowest working step (91 s)', () => {
    // Act
    const ms = tryLimitMs(LINUX_DOCKER_BYTES);

    // Assert
    expect(ms).toBe((LIMIT_BASE_S + PER_ARTIFACT_S + Math.ceil(LINUX_DOCKER_BYTES / RATE_FLOOR_BPS)) * 1000);
    expect(ms).toBeGreaterThan(91_000);
    expect(2 * ms + (65 + 45) * 1000).toBeLessThan(10 * 60_000);
  });
});

describe('parseListed', () => {
  it("reads download-artifact's listing line", () => {
    // Act
    const listed = parseListed(LISTED_LINE);

    // Assert
    expect(listed).toEqual({ name: 'linux-docker-x64', id: 14299794010, bytes: LINUX_DOCKER_BYTES });
  });

  it('ignores every other line', () => {
    // Act
    const listed = ['Found 19 artifact(s)', 'Starting download of artifact to: /tmp/x', '- not a listing'].map(parseListed);

    // Assert
    expect(listed).toEqual([null, null, null]);
  });
});

describe('Watchdog', () => {
  it('cuts off a try that lists nothing within LIST_S', () => {
    // Arrange
    const dog = new Watchdog(0, 0);

    // Act
    const before = dog.check(0, LIST_S * 1000 - 1);
    const after = dog.check(0, LIST_S * 1000);

    // Assert
    expect(before).toBeNull();
    expect(after).toMatch(/listed no artifact/);
  });

  it('cuts off a download that writes no byte more for STALL_S, long before its time limit (the 599 s stall)', () => {
    // Arrange
    const dog = new Watchdog(0, 0);
    dog.listed(LINUX_DOCKER_BYTES, 1_000);
    dog.check(8_000_000, 5_000);

    // Act
    const why = dog.check(8_000_000, 5_000 + STALL_S * 1000);

    // Assert
    expect(why).toMatch(/^stalled: no byte more in 30 s \(8000000 of 334827666 bytes written\)$/);
    expect(5_000 + STALL_S * 1000).toBeLessThan(tryLimitMs(LINUX_DOCKER_BYTES));
  });

  it('lets a download that keeps writing run until its size-based limit, then cuts it off', () => {
    // Arrange
    const dog = new Watchdog(0, 0);
    dog.listed(LINUX_DOCKER_BYTES, 1_000);
    const limit = tryLimitMs(LINUX_DOCKER_BYTES);
    const reads: (string | null)[] = [];

    // Act
    for (let t = 2_000, size = 1; t < limit; t += 2_000, size += 1) reads.push(dog.check(size, t));
    const atLimit = dog.check(LINUX_DOCKER_BYTES - 1, limit);

    // Assert
    expect(reads.every((r) => r === null)).toBe(true);
    expect(atLimit).toMatch(/^reached its time limit of 130 s for 334827666 bytes/);
  });

  it('adds up every listed artifact, with its own allowance each', () => {
    // Arrange
    const dog = new Watchdog(0, 0);

    // Act
    dog.listed(80_000_000, 500);
    dog.listed(3_600_000, 600);

    // Assert
    expect(dog.deadline).toBe(tryLimitMs(83_600_000, 2));
  });

  it('keeps a try within the caller\'s cap, counted from its start', () => {
    // Arrange
    const dog = new Watchdog(0, 0, 115_000);
    dog.listed(2_435_990_017, 1_000);

    // Act
    const before = dog.check(1, 114_999);
    const after = dog.check(2, 115_000);

    // Assert
    expect(before).toBeNull();
    expect(after).toMatch(/^reached its time limit of 115 s for 2435990017 bytes/);
  });
});

describe('childEnv', () => {
  it("gives download-artifact its inputs (this run's by default) and none of ours", () => {
    // Act
    const out = childEnv(
      { PATH: '/bin', GITHUB_RUN_ID: '44018931697', GITHUB_REPOSITORY: 'Lucas-Angelo/swarmcast', 'INPUT_MAX-TRY-SECONDS': '115', INPUT_REQUIRED: 'true' },
      { pattern: 'linux-docker-x64', dest: '/tmp/a', mergeMultiple: 'true' },
    );

    // Assert
    expect(out).toEqual({
      PATH: '/bin',
      GITHUB_RUN_ID: '44018931697',
      GITHUB_REPOSITORY: 'Lucas-Angelo/swarmcast',
      INPUT_NAME: '',
      INPUT_PATTERN: 'linux-docker-x64',
      INPUT_PATH: '/tmp/a',
      'INPUT_MERGE-MULTIPLE': 'true',
      'INPUT_RUN-ID': '44018931697',
      'INPUT_GITHUB-TOKEN': '',
      INPUT_REPOSITORY: 'Lucas-Angelo/swarmcast',
      'INPUT_ARTIFACT-IDS': '',
      'INPUT_SKIP-DECOMPRESS': 'false',
      'INPUT_DIGEST-MISMATCH': 'error',
    });
  });
});

describe('downloadOnce', () => {
  it('reports a download that finished, with the bytes it listed', async () => {
    // Arrange
    const script = fake(`console.log(${JSON.stringify(LISTED_LINE)}); fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'linux-docker.tar'), 'x'.repeat(10));`);

    // Act
    const result = await downloadOnce({ script, env: env(), dest, clock: new ManualClock().clock, log: () => {} });

    // Assert
    expect(result).toEqual({ ok: true, why: '', bytes: LINUX_DOCKER_BYTES, seconds: 0 });
    expect(bytesUnder(dest)).toBe(10);
  });

  it("names download-artifact's own failure and turns its error into a warning (try 2 may still get the files)", async () => {
    // Arrange
    const script = fake(`console.log('::error::Unable to download artifact(s): Artifact download failed after 5 retries.'); process.exitCode = 1;`);
    const lines: string[] = [];

    // Act
    const result = await downloadOnce({ script, env: env(), dest, clock: new ManualClock().clock, log: (l: string) => lines.push(l) });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.why).toBe('Unable to download artifact(s): Artifact download failed after 5 retries.');
    expect(lines).toEqual(['::warning::Unable to download artifact(s): Artifact download failed after 5 retries.']);
  });

  it('cuts off a download that stalls (and what it started) after STALL_S, not at the caller\'s limit', async () => {
    // Arrange
    const clock = new ManualClock();
    const pidFile = path.join(dir, 'grandchild.pid');
    const script = fake(`console.log(${JSON.stringify(LISTED_LINE)});
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'linux-docker.tar'), 'x'.repeat(4096));
      const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setInterval(() => {}, 1000);
      console.log('stalled');`);
    const log = (l: string): void => {
      if (l !== 'stalled') return;
      clock.advance(2_000);
      clock.advance(STALL_S * 1000);
    };

    // Act
    const result = await downloadOnce({ script, env: env(), dest, clock: clock.clock, log });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.why).toBe(`stalled: no byte more in ${STALL_S} s (4096 of ${LINUX_DOCKER_BYTES} bytes written)`);
    expect(result.seconds).toBe(2 + STALL_S);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await expect.poll(() => isAlive(grandchild)).toBe(false);
  });

  it('cuts off a try that never lists its artifacts', async () => {
    // Arrange
    const clock = new ManualClock();
    const script = fake(`setInterval(() => {}, 1000); console.log('hanging');`);
    const log = (l: string): void => {
      if (l === 'hanging') clock.advance(LIST_S * 1000);
    };

    // Act
    const result = await downloadOnce({ script, env: env(), dest, clock: clock.clock, log });

    // Assert
    expect(result).toEqual({ ok: false, why: `listed no artifact in ${LIST_S} s`, bytes: 0, seconds: LIST_S });
  });
});

describe('rest.sh', () => {
  it('budgets try 2 with the same limits as try 1', () => {
    // Arrange
    const text = fs.readFileSync(REST_SH, 'utf8');
    const value = (name: string): number => Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(text)?.[1]);

    // Act
    const limits = { RATE_FLOOR_BPS: value('RATE_FLOOR_BPS'), LIMIT_BASE_S: value('LIMIT_BASE_S'), PER_ARTIFACT_S: value('PER_ARTIFACT_S'), LIST_S: value('LIST_S') };

    // Assert
    expect(limits).toEqual({ RATE_FLOOR_BPS, LIMIT_BASE_S, PER_ARTIFACT_S, LIST_S });
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
