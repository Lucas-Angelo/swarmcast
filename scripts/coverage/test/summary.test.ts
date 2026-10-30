// The coverage floors arithmetic (summary.mjs) that CI's coverage steps and `npm run coverage` rely
// on: percentages rounded down like Istanbul's (a floor of 65 must fail at 64.999), per-area totals
// from a json-summary whose paths may be Windows ones (C:\ or C:/, any drive-letter case), and the
// rule that a floor only goes up (suggestedFloor: rounded down, one point below the measured value).
import { describe, expect, it } from 'vitest';
import { againstFloors, floorsFor, istanbulTotals, llvmTotals, relativePath, suggestedFloor, table } from '../summary.mjs';

/** One file of an Istanbul json-summary: `covered` of `total` for every metric. */
const file = (covered: number, total: number) => Object.fromEntries(['lines', 'branches', 'functions', 'statements'].map((m) => [m, { total, covered, skipped: 0, pct: 0 }]));

/** `cargo llvm-cov --json --summary-only` with these totals. */
const llvmExport = (lines: [number, number], functions: [number, number], regions: [number, number]) => ({
  type: 'llvm.coverage.json.export',
  data: [{ totals: { lines: { covered: lines[0], count: lines[1] }, functions: { covered: functions[0], count: functions[1] }, regions: { covered: regions[0], count: regions[1] } } }],
});

const ROOT = '/repo';
const AREAS = { server: 'apps/server/src/', site: 'site/src/' };

describe('suggestedFloor', () => {
  it('rounds down and keeps one point below the measured value', () => {
    // Act
    const floors = [66.01, 66.99, 66, 0.5].map(suggestedFloor);

    // Assert
    expect(floors).toEqual([65, 65, 65, 0]);
  });
});

describe('relativePath', () => {
  it('makes POSIX and Windows report paths relative to the root, with forward slashes', () => {
    // Act
    const paths = [relativePath('/repo/apps/server/src/app.ts', '/repo'), relativePath('C:\\a\\repo\\site\\src\\lib\\seo.ts', 'C:\\a\\repo'), relativePath('c:/a/repo/apps/x.ts', 'C:\\a\\repo\\')];

    // Assert
    expect(paths).toEqual(['apps/server/src/app.ts', 'site/src/lib/seo.ts', 'apps/x.ts']);
  });

  it('leaves a path outside the root as it is', () => {
    // Act
    const outside = relativePath('/elsewhere/app.ts', '/repo');

    // Assert
    expect(outside).toBe('/elsewhere/app.ts');
  });
});

describe('istanbulTotals', () => {
  it('sums every file into the total and each file into its area', () => {
    // Arrange
    const summary = { total: file(0, 0), '/repo/apps/server/src/a.ts': file(3, 4), '/repo/apps/server/src/b.ts': file(1, 4), '/repo/site/src/c.ts': file(2, 2), '/repo/scripts/d.mjs': file(0, 2) };

    // Act
    const totals = istanbulTotals(summary, ROOT, AREAS);

    // Assert
    expect(totals.total.lines).toEqual({ total: 12, covered: 6, pct: 50 });
    expect(totals.areas.server!.branches).toEqual({ total: 8, covered: 4, pct: 50 });
    expect(totals.areas.site!.functions).toEqual({ total: 2, covered: 2, pct: 100 });
  });

  it('rounds percentages down to two decimals, like Istanbul', () => {
    // Arrange
    const summary = { '/repo/apps/server/src/a.ts': file(2, 3) };

    // Act
    const totals = istanbulTotals(summary, ROOT, AREAS);

    // Assert
    expect(totals.total.statements.pct).toBe(66.66);
  });

  it('counts an area without code as fully covered', () => {
    // Act
    const totals = istanbulTotals({}, ROOT, AREAS);

    // Assert
    expect(totals.areas.site!.lines).toEqual({ total: 0, covered: 0, pct: 100 });
  });
});

describe('llvmTotals', () => {
  it('reads lines, functions and regions of an llvm-cov export', () => {
    // Act
    const totals = llvmTotals(llvmExport([1, 3], [2, 2], [5, 10]));

    // Assert
    expect(totals).toEqual({ lines: { total: 3, covered: 1, pct: 33.33 }, functions: { total: 2, covered: 2, pct: 100 }, regions: { total: 10, covered: 5, pct: 50 } });
  });

  it('refuses a file that is not an llvm-cov export', () => {
    // Act
    const read = () => llvmTotals({ result: [] });

    // Assert
    expect(read).toThrow(/not an llvm-cov export/);
  });
});

describe('againstFloors', () => {
  it('flags a metric below its floor, also by a hundredth', () => {
    // Act
    const [lines] = againstFloors({ lines: { pct: 64.99 } }, { lines: 65 });

    // Assert
    expect(lines).toMatchObject({ metric: 'lines', floor: 65, below: true, raiseTo: null });
  });

  it('says how far a floor may go up when the measured value allows more', () => {
    // Act
    const [lines, branches] = againstFloors({ lines: { pct: 70.5 }, branches: { pct: 60.2 } }, { lines: 65, branches: 59 });

    // Assert
    expect(lines).toMatchObject({ below: false, raiseTo: 69 });
    expect(branches).toMatchObject({ below: false, raiseTo: null });
  });

  it('never fails a metric without a floor, and suggests its first one', () => {
    // Act
    const [lines] = againstFloors({ lines: { pct: 40.7 } }, undefined);

    // Assert
    expect(lines).toMatchObject({ floor: null, below: false, raiseTo: 39 });
  });
});

describe('floorsFor', () => {
  it('takes the floors of the OS or group, else the ones for every key', () => {
    // Arrange
    const all = { integration: { linux: { total: { lines: 53 } } }, unit: { '*': { total: { lines: 64 } } } };

    // Act
    const found = [floorsFor(all, 'integration', 'linux'), floorsFor(all, 'integration', 'win32'), floorsFor(all, 'unit', 'darwin'), floorsFor(all, 'desktop', 'linux')];

    // Assert
    expect(found).toEqual([{ total: { lines: 53 } }, undefined, { total: { lines: 64 } }, undefined]);
  });
});

describe('table', () => {
  it('writes one row per name with the floor beside each value, and lists failures and raises', () => {
    // Arrange
    const rows = [
      { name: 'total', results: againstFloors({ lines: { pct: 64.5 }, branches: { pct: 58.2 } }, { lines: 65, branches: 56 }) },
      { name: 'site/src/', results: againstFloors({ lines: { pct: 76.36 }, branches: { pct: 80.14 } }, undefined) },
    ];

    // Act
    const t = table('Coverage: unit (Linux)', rows);

    // Assert
    expect(t.markdown).toContain('| **total** | ❌ 64.50 % (floor 65) | 58.20 % (56) |');
    expect(t.markdown).toContain('| site/src/ | 76.36 % | 80.14 % |');
    expect(t.failures).toEqual(['Coverage: unit (Linux), total: lines 64.50 % is below its floor 65 %']);
    expect(t.raises).toEqual(['total branches: 56 -> 57', 'site/src/ lines: no floor yet -> 75', 'site/src/ branches: no floor yet -> 79']);
  });
});
