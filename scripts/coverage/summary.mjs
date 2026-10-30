// Coverage numbers against their floors (docs/DEVELOPMENT.md, "Coverage"). Pure functions only (no
// I/O): report.mjs is the CLI that reads the reports and writes the tables.
//
// A floor is the lowest coverage a suite may have: floors.json holds one per suite, metric and,
// where the suite runs different tests per OS (or per e2e group), per OS or group. Floors only go
// up: when coverage rises, raise them to suggestedFloor() of the lowest value CI measured across
// the OSes; never lower one to make CI pass. Coverage is a floor that stops regressions (code that
// lost its tests), not a target: a high number says little about how good the tests are.

/** The metrics of an Istanbul summary (Vitest, c8), in table order. */
export const ISTANBUL_METRICS = ['lines', 'branches', 'functions', 'statements'];
/** The metrics `cargo llvm-cov` reports on stable Rust (branch coverage needs nightly). */
export const LLVM_METRICS = ['lines', 'functions', 'regions'];

/** The floor for a measured percentage: rounded down, one point below. Never below 0. */
export function suggestedFloor(pct) {
  return Math.max(0, Math.floor(pct) - 1);
}

/** `file` relative to `root` with forward slashes (Windows reports carry `C:\...` or `C:/...` paths). */
export function relativePath(file, root) {
  const f = file.replaceAll('\\', '/');
  const r = root.replaceAll('\\', '/').replace(/\/$/, '');
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f;
}

function percent(covered, total) {
  return total === 0 ? 100 : Math.floor((10_000 * covered) / total) / 100;
}

/**
 * Totals of an Istanbul json-summary (`coverage-summary.json`), overall and per area.
 * @param {Record<string, Record<string, { total: number, covered: number }>>} summary
 * @param {string} root the repository root the file paths are under
 * @param {Record<string, string>} areas area name -> path prefix (`apps/server/src/`)
 * @returns {{ total: Record<string, Metric>, areas: Record<string, Record<string, Metric>> }}
 *   with `Metric = { total, covered, pct }`; a file in no area counts in the total only
 */
export function istanbulTotals(summary, root, areas = {}) {
  const empty = () => Object.fromEntries(ISTANBUL_METRICS.map((m) => [m, { total: 0, covered: 0, pct: 100 }]));
  const total = empty();
  const byArea = Object.fromEntries(Object.keys(areas).map((a) => [a, empty()]));
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const rel = relativePath(file, root);
    const area = Object.keys(areas).find((a) => rel.startsWith(areas[a]));
    for (const m of ISTANBUL_METRICS) {
      for (const sum of area ? [total, byArea[area]] : [total]) {
        sum[m].total += metrics[m].total;
        sum[m].covered += metrics[m].covered;
      }
    }
  }
  for (const sum of [total, ...Object.values(byArea)]) {
    for (const m of ISTANBUL_METRICS) sum[m].pct = percent(sum[m].covered, sum[m].total);
  }
  return { total, areas: byArea };
}

/**
 * Totals of `cargo llvm-cov --json --summary-only` (the llvm-cov export format).
 * @returns {Record<string, { total: number, covered: number, pct: number }>}
 */
export function llvmTotals(exported) {
  const totals = exported?.data?.[0]?.totals;
  if (!totals) throw new Error('not an llvm-cov export: no data[0].totals');
  return Object.fromEntries(LLVM_METRICS.map((m) => [m, { total: totals[m].count, covered: totals[m].covered, pct: percent(totals[m].covered, totals[m].count) }]));
}

/**
 * Each measured metric against its floor.
 * @param {Record<string, { pct: number }>} measured
 * @param {Record<string, number> | undefined} floors no floors: reported, never failing
 * @returns {Array<{ metric: string, pct: number, floor: number | null, below: boolean, raiseTo: number | null }>}
 *   `raiseTo`: the floor the measured value allows, when it is above the current one
 */
export function againstFloors(measured, floors) {
  return Object.entries(measured).map(([metric, { pct }]) => {
    const floor = typeof floors?.[metric] === 'number' ? floors[metric] : null;
    const allowed = suggestedFloor(pct);
    return { metric, pct, floor, below: floor !== null && pct < floor, raiseTo: floor === null || allowed > floor ? allowed : null };
  });
}

/**
 * The floors of `suite` for this run: floors.json keys a suite by OS (`linux`, `darwin`, `win32`)
 * or e2e group (`ui`, `media`) when its tests differ between them, else by `*`.
 * @returns {Record<string, Record<string, number>> | undefined} row name (`total`, an area) -> metric -> floor
 */
export function floorsFor(all, suite, key) {
  const s = all[suite];
  if (!s) return undefined;
  return s[key] ?? s['*'];
}

function cell({ pct, floor, below }) {
  const value = `${pct.toFixed(2)} %`;
  if (floor === null) return value;
  return below ? `❌ ${value} (floor ${floor})` : `${value} (${floor})`;
}

/**
 * A Markdown table: one row per name (`total` first), one column per metric, "measured (floor)".
 * @param {string} title
 * @param {Array<{ name: string, results: ReturnType<typeof againstFloors> }>} rows
 * @returns {{ markdown: string, failures: string[], raises: string[] }}
 */
export function table(title, rows) {
  const metrics = rows[0]?.results.map((r) => r.metric) ?? [];
  const failures = [];
  const raises = [];
  const lines = [`### ${title}`, '', `| | ${metrics.join(' | ')} |`, `|---|${metrics.map(() => '---:').join('|')}|`];
  for (const { name, results } of rows) {
    lines.push(`| ${name === 'total' ? '**total**' : name} | ${results.map(cell).join(' | ')} |`);
    for (const r of results) {
      if (r.below) failures.push(`${title}, ${name}: ${r.metric} ${r.pct.toFixed(2)} % is below its floor ${r.floor} %`);
      if (r.raiseTo !== null) raises.push(`${name} ${r.metric}: ${r.floor === null ? 'no floor yet' : r.floor} -> ${r.raiseTo}`);
    }
  }
  lines.push('', 'Cells: measured (floor). Floors: `scripts/coverage/floors.json`.');
  if (raises.length) lines.push('', `<details><summary>Floors this run would allow (raise them when every OS allows it)</summary>`, '', ...raises.map((r) => `- ${r}`), '', '</details>');
  return { markdown: `${lines.join('\n')}\n`, failures, raises };
}
