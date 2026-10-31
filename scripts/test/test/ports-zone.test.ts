import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  e2ePorts,
  EPHEMERAL_DEFAULTS,
  ephemeralRange,
  FIXED_PORTS,
  FIXED_ZONE,
  fixedPortProblems,
  PORT_BASE,
  RESERVED,
  SCREENSHOTS_OFFSET,
  type Harness,
} from '../lib/ports.mjs';

// The fixed ports of the test harnesses (scripts/test/lib/ports.mjs FIXED_PORTS) never lie in an
// ephemeral range: an outgoing connection takes its local port from that range, and while it (or
// its TIME_WAIT) holds 127.0.0.1:<port>, nothing can listen there. The e2e server died at start
// with EADDRINUSE on its control port, 38082 (inside Linux's 32768-60999), in pipeline run
// 41192273509. Nor on a SwarmCast's default or demo port (RESERVED), nor on another harness's port.

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DEFAULT_RANGES = Object.values(EPHEMERAL_DEFAULTS);
const inRange = (port: number, [first, last]: readonly [number, number]): boolean => port >= first && port <= last;
const harnesses = Object.entries(FIXED_PORTS) as Array<[Harness, Record<string, number>]>;
/** The Vitest workers' blocks of allocPorts(): PORT_BASE + 60 blocks of BLOCK ports. */
const VITEST_BLOCKS: [number, number] = [PORT_BASE, PORT_BASE + 60 * BLOCK - 1];

describe('fixed test ports', () => {
  it.each(harnesses)('%s: in 10000-19999, outside every default ephemeral range, never a reserved port', (harness, ports) => {
    // Act
    const problems = fixedPortProblems(harness, ports, DEFAULT_RANGES);
    // Assert
    expect(problems).toEqual([]);
    for (const port of Object.values(ports)) {
      expect(port).toBeGreaterThanOrEqual(FIXED_ZONE[0]);
      expect(port).toBeLessThanOrEqual(FIXED_ZONE[1]);
      expect(RESERVED.has(port)).toBe(false);
      for (const range of DEFAULT_RANGES) expect(inRange(port, range), `${harness} ${port} in ${range.join('-')}`).toBe(false);
    }
  });

  it('no port belongs to two harnesses', () => {
    // Arrange
    const all = harnesses.flatMap(([, ports]) => Object.values(ports));
    // Assert
    expect(new Set(all).size).toBe(all.length);
  });

  it("the zone is clear of every default ephemeral range, of the Vitest blocks and of SwarmCast's ports", () => {
    // Assert
    for (const [first, last] of [...DEFAULT_RANGES, VITEST_BLOCKS]) expect(FIXED_ZONE[1] < first || FIXED_ZONE[0] > last, `${FIXED_ZONE.join('-')} vs ${first}-${last}`).toBe(true);
    for (const port of RESERVED) expect(inRange(port, FIXED_ZONE), String(port)).toBe(false);
  });

  it('the Vitest blocks of allocPorts() are outside every default ephemeral range too', () => {
    // Assert
    for (const [first] of DEFAULT_RANGES) expect(VITEST_BLOCKS[1]).toBeLessThan(first);
  });

  it("the docs screenshots' offset keeps the e2e ports in place", () => {
    // Act
    const problems = fixedPortProblems('e2e', e2ePorts(SCREENSHOTS_OFFSET), DEFAULT_RANGES);
    // Assert
    expect(problems).toEqual([]);
  });

  it('none is inside the ephemeral range of this machine', () => {
    // Arrange
    const range = ephemeralRange();
    // Assert
    expect(range[0]).toBeGreaterThanOrEqual(1024);
    expect(range[0]).toBeLessThanOrEqual(range[1]);
    expect(range[1]).toBeLessThanOrEqual(65535);
    for (const [harness, ports] of harnesses) expect(fixedPortProblems(harness, ports, [range])).toEqual([]);
  });
});

describe('fixedPortProblems', () => {
  it.each([
    ['an offset that moves the e2e ports into an ephemeral range', 27_000, /control would be 38082, inside the ephemeral range 32768-60999/],
    ["an offset that lands on another harness's port", 5000, /public would be 16080, the port of quality\.public/],
    ['an offset that leaves the zone', -1500, /public would be 9580, outside 10000-19999/],
  ])('names %s', (_what, offset, message) => {
    // Act
    const problems = fixedPortProblems('e2e', e2ePorts(offset), DEFAULT_RANGES);
    // Assert
    expect(problems.join('; ')).toMatch(message);
  });

  it("names a SwarmCast's default port and a port inside this machine's range", () => {
    // Act
    const problems = fixedPortProblems('site', { http: 8080, other: 12000 }, [[11000, 12999]]);
    // Assert
    expect(problems).toEqual([
      'http would be 8080, a port of a SwarmCast that may run on this computer (RESERVED)',
      'other would be 12000, inside the ephemeral range 11000-12999, where outgoing connections take their local ports',
    ]);
  });
});

/** Every file of `dir` (recursive) whose name matches `pattern`, outside node_modules and build output. */
function filesUnder(dir: string, pattern: RegExp): string[] {
  return (fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
    .map((f) => path.join(dir, f))
    .filter((f) => pattern.test(f) && !/node_modules|[\\/](dist|target)[\\/]/.test(f) && fs.statSync(path.join(ROOT, f)).isFile());
}

describe('port numbers written in the harnesses', () => {
  // What cannot import FIXED_PORTS (workflows, shell scripts) writes the port out. A loopback URL or
  // a --port / --update-port argument there never names a port inside a default ephemeral range.
  const files = [
    ...filesUnder('.github/workflows', /\.ya?ml$/),
    ...filesUnder('scripts', /\.(m?[jt]s|sh|ps1)$/),
    ...filesUnder('site/test', /\.(m?[jt]s)$/),
    ...filesUnder('apps', /[\\/]test[\\/].*\.(m?[jt]sx?)$/),
    'playwright.config.ts',
    'site/playwright.config.ts',
  ];
  const LITERAL = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\b|--(?:update-)?port[ =](\d{2,5})\b/g;

  it('finds the files it checks', () => {
    // Assert
    expect(files).toContain(path.join('.github', 'workflows', '_desktop.yml'));
    expect(files).toContain(path.join('scripts', 'test', 'desktop', 'verify.mjs'));
  });

  it('none names a port inside a default ephemeral range', () => {
    // Act
    const found = files.flatMap((f) =>
      [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(LITERAL)]
        .map((m) => ({ f, text: m[0], port: Number(m[1] ?? m[2]) }))
        .filter(({ port }) => DEFAULT_RANGES.some((r) => inRange(port, r))),
    );
    // Assert
    expect(found).toEqual([]);
  });

  it("the desktop update server's port in the workflows is FIXED_PORTS.desktopUpdate", () => {
    // Arrange
    const text = ['_desktop.yml', 'soak.yml'].map((f) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8')).join('\n') + fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'soak-run.mjs'), 'utf8');
    // Act
    const ports = new Set([...text.matchAll(/127\.0\.0\.1:(\d+)|--update-port (\d+)/g)].map((m) => Number(m[1] ?? m[2])));
    // Assert
    expect([...ports]).toEqual([FIXED_PORTS.desktopUpdate.http]);
  });
});
