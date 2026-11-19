// .github/actions/fetch-artifact: try 1 (download.mjs) runs download-artifact with the caller's
// time limit and a cut when the download stops growing, so a stalled blob download ends long
// before the calling step's limit and try 2 (rest.sh) has its own time (release rehearsal
// 44018931697: one stalled try used the whole 10 minutes, try 2 never ran), while a slow one that
// keeps moving may use the whole limit (release rehearsal 44603650109: a size-based 50 s cut the
// crates' 82 MB off at 73.5 MB). A try writes into a folder of its own and only a finished
// download reaches the destination (place.mjs), so a cut-off try never leaves half an archive
// where a caller would unpack it (the same rehearsal: cargo-crates unpacked such a tar).
// Fake scripts stand in for download-artifact's dist/index.js. Time is the test's: the Watchdog
// takes the clock as a number, and downloadOnce's measurements run when the test advances its
// clock, so no try races a real limit however slow the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIST_S, STALL_S, Watchdog, bytesUnder, childEnv, downloadOnce, downloadPlaced, parseListed } from '../../../.github/actions/fetch-artifact/download.mjs';
import { placeInto, stageFor } from '../../../.github/actions/fetch-artifact/place.mjs';

const REST_SH = path.join(import.meta.dirname, '../../../.github/actions/fetch-artifact/rest.sh');
const LINUX_DOCKER_BYTES = 334_827_666;
/** The room a 10-minute step leaves each try: (600 - 110 - 40) / 2. */
const TEN_MINUTE_STEP_TRY_MS = 225_000;
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
  it('fits two tries and the diagnostics into a 10-minute step at the room it leaves', () => {
    // Act
    const total = 2 * TEN_MINUTE_STEP_TRY_MS + (65 + 45) * 1000;

    // Assert
    expect(total).toBeLessThanOrEqual(10 * 60_000 - 40_000);
  });

  it('refuses to run a try without a time limit', () => {
    // Act
    const make = () => new Watchdog(0, 0, Number(''));

    // Assert
    expect(make).toThrow(/needs a time limit \(max-try-seconds\)/);
  });

  it('cuts off a try that lists nothing within LIST_S', () => {
    // Arrange
    const dog = new Watchdog(0, 0, TEN_MINUTE_STEP_TRY_MS);

    // Act
    const before = dog.check(0, LIST_S * 1000 - 1);
    const after = dog.check(0, LIST_S * 1000);

    // Assert
    expect(before).toBeNull();
    expect(after).toMatch(/listed no artifact/);
  });

  it('cuts off a download that writes no byte more for STALL_S, long before its time limit (the 599 s stall)', () => {
    // Arrange
    const dog = new Watchdog(0, 0, TEN_MINUTE_STEP_TRY_MS);
    dog.listed(LINUX_DOCKER_BYTES, 1_000);
    dog.check(8_000_000, 5_000);

    // Act
    const why = dog.check(8_000_000, 5_000 + STALL_S * 1000);

    // Assert
    expect(why).toMatch(/^stalled: no byte more in 30 s \(8000000 of 334827666 bytes written\)$/);
    expect(5_000 + STALL_S * 1000).toBeLessThan(TEN_MINUTE_STEP_TRY_MS);
  });

  it("lets a small download that keeps moving at 0.8 MB/s finish within the crates' 150 s (cut at 50 s in run 44603650109)", () => {
    // Arrange
    const crates = 82_355_902;
    const dog = new Watchdog(0, 0, 150_000);
    dog.listed(crates, 1_000);
    const reads: (string | null)[] = [];
    let t = 1_000;

    // Act
    for (let size = 0; size < crates; size = Math.min(crates, size + 1_600_000)) {
      t += 2_000;
      reads.push(dog.check(size, t));
    }

    // Assert
    expect(reads.every((r) => r === null)).toBe(true);
    expect(t).toBeGreaterThan(50_000);
    expect(t).toBeLessThan(150_000);
  });

  it('cuts off a download that keeps writing once it reaches its time limit, whatever the size', () => {
    // Arrange
    const dog = new Watchdog(0, 0, TEN_MINUTE_STEP_TRY_MS);
    dog.listed(80_000_000, 500);
    dog.listed(3_600_000, 600);
    const reads: (string | null)[] = [];

    // Act
    for (let t = 2_000, size = 1; t < TEN_MINUTE_STEP_TRY_MS; t += 2_000, size += 1) reads.push(dog.check(size, t));
    const atLimit = dog.check(83_599_999, TEN_MINUTE_STEP_TRY_MS);

    // Assert
    expect(reads.every((r) => r === null)).toBe(true);
    expect(atLimit).toMatch(/^reached its time limit of 225 s for 83600000 bytes \(83599999 of 83600000 bytes written\)$/);
  });

  it('keeps a try within the caller\'s limit, counted from its start', () => {
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
    const result = await downloadOnce({ script, env: env(), dest, limitMs: TEN_MINUTE_STEP_TRY_MS, clock: new ManualClock().clock, log: () => {} });

    // Assert
    expect(result).toEqual({ ok: true, why: '', bytes: LINUX_DOCKER_BYTES, seconds: 0 });
    expect(bytesUnder(dest)).toBe(10);
  });

  it("names download-artifact's own failure and turns its error into a warning (try 2 may still get the files)", async () => {
    // Arrange
    const script = fake(`console.log('::error::Unable to download artifact(s): Artifact download failed after 5 retries.'); process.exitCode = 1;`);
    const lines: string[] = [];

    // Act
    const result = await downloadOnce({ script, env: env(), dest, limitMs: TEN_MINUTE_STEP_TRY_MS, clock: new ManualClock().clock, log: (l: string) => lines.push(l) });

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
    const result = await downloadOnce({ script, env: env(), dest, limitMs: TEN_MINUTE_STEP_TRY_MS, clock: clock.clock, log });

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
    const result = await downloadOnce({ script, env: env(), dest, limitMs: TEN_MINUTE_STEP_TRY_MS, clock: clock.clock, log });

    // Assert
    expect(result).toEqual({ ok: false, why: `listed no artifact in ${LIST_S} s`, bytes: 0, seconds: LIST_S });
  });
});

describe('downloadPlaced', () => {
  /** download-artifact's inputs with `stage` as its path, as try 1 gives them. */
  const envIn = (stage: string): NodeJS.ProcessEnv => childEnv({ PATH: process.env.PATH }, { name: 'cargo-crates-1.99.1-a54f7231e0b69f90', dest: stage });
  const leftovers = (): string[] => fs.readdirSync(dir).filter((n) => n.startsWith('.fetch-artifact-'));

  it('moves a finished download into the destination, next to what was there, and leaves no folder of its own', async () => {
    // Arrange
    fs.mkdirSync(path.join(dest, 'keep'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'keep', 'old.txt'), 'old');
    const script = fake(`console.log(${JSON.stringify(LISTED_LINE)}); fs.mkdirSync(path.join(dest, 'keep'), { recursive: true }); fs.writeFileSync(path.join(dest, 'cargo-crates.tar'), 'x'.repeat(10)); fs.writeFileSync(path.join(dest, 'keep', 'new.txt'), 'new');`);

    // Act
    const result = await downloadPlaced({ script, env: envIn, dest, limitMs: TEN_MINUTE_STEP_TRY_MS, clock: new ManualClock().clock, log: () => {} });

    // Assert
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'cargo-crates.tar'), 'utf8')).toBe('x'.repeat(10));
    expect(fs.readdirSync(path.join(dest, 'keep')).sort()).toEqual(['new.txt', 'old.txt']);
    expect(leftovers()).toEqual([]);
  });

  it('never puts the part of an archive a cut-off try wrote into the destination (73.5 of 82 MB in run 44603650109)', async () => {
    // Arrange
    const clock = new ManualClock();
    const script = fake(`console.log(${JSON.stringify(LISTED_LINE)});
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'cargo-crates.tar'), 'x'.repeat(4096));
      setInterval(() => {}, 1000);
      console.log('half written');`);
    const log = (l: string): void => {
      if (l !== 'half written') return;
      clock.advance(2_000);
      clock.advance(50_000);
    };

    // Act
    const result = await downloadPlaced({ script, env: envIn, dest, limitMs: 50_000, clock: clock.clock, log });

    // Assert
    expect(result.ok).toBe(false);
    expect(result.why).toMatch(/^reached its time limit of 50 s .*\(4096 of \d+ bytes written\)$/);
    expect(fs.existsSync(path.join(dest, 'cargo-crates.tar'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('leaves the destination as it was after download-artifact failed with a file half unzipped', async () => {
    // Arrange
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'other.txt'), 'other');
    const script = fake(`fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'cargo-crates.tar'), 'x'.repeat(100)); console.log('::error::Unable to download artifact(s): digest mismatch'); process.exitCode = 1;`);

    // Act
    const result = await downloadPlaced({ script, env: envIn, dest, limitMs: TEN_MINUTE_STEP_TRY_MS, clock: new ManualClock().clock, log: () => {} });

    // Assert
    expect(result).toMatchObject({ ok: false, why: 'Unable to download artifact(s): digest mismatch' });
    expect(fs.readdirSync(dest)).toEqual(['other.txt']);
    expect(leftovers()).toEqual([]);
  });
});

describe('placeInto', () => {
  it('merges folders, replaces a file of the same name and returns what it put in', () => {
    // Arrange
    const from = stageFor(dest);
    fs.mkdirSync(path.join(from, 'a'), { recursive: true });
    fs.writeFileSync(path.join(from, 'a', 'new'), '1');
    fs.writeFileSync(path.join(from, 'f'), 'new');
    fs.mkdirSync(path.join(dest, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'a', 'old'), '0');
    fs.writeFileSync(path.join(dest, 'f'), 'old');

    // Act
    const placed = placeInto(from, dest);

    // Assert
    expect(placed.sort()).toEqual([path.join(dest, 'a', 'new'), path.join(dest, 'f')]);
    expect(fs.readdirSync(path.join(dest, 'a')).sort()).toEqual(['new', 'old']);
    expect(fs.readFileSync(path.join(dest, 'f'), 'utf8')).toBe('new');
    expect(path.dirname(from)).toBe(path.dirname(dest));
  });
});

describe('rest.sh', () => {
  it('gives try 2 the time to list that try 1 has, and no limit that follows the size', () => {
    // Arrange
    const text = fs.readFileSync(REST_SH, 'utf8');

    // Act
    const listS = Number(/^LIST_S=(\d+)$/m.exec(text)?.[1]);

    // Assert
    expect(listS).toBe(LIST_S);
    expect(text).not.toMatch(/RATE_FLOOR_BPS|LIMIT_BASE_S|PER_ARTIFACT_S/);
    expect(text).toMatch(/BUDGET="\$\{FETCH_MAX_S:-\}"/);
  });

  it('unzips into a folder of its own and moves the artifacts into DEST only after every one checked out', () => {
    // Arrange
    const text = fs.readFileSync(REST_SH, 'utf8');
    const fetchBody = text.slice(text.indexOf('fetch() {'), text.indexOf('case "${1:-}" in'));

    // Act
    const order = ['dir="$stage"', 'if [ "$failed" -gt 0 ]; then', 'place.mjs'].map((s) => fetchBody.indexOf(s));

    // Assert
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fetchBody).not.toMatch(/dir="\$out"/);
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
