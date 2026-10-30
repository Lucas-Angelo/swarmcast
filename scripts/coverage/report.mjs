// The coverage table of each suite, with its floors (docs/DEVELOPMENT.md, "Coverage").
//
//   node scripts/coverage/report.mjs [suite...] [--key <os|group>] [--check]
//
// suite: unit, integration, e2e-server, desktop; without one, every suite with a report under
// coverage/ (what `npm run coverage` prints at the end). Reads coverage/<suite>/coverage-summary.json
// (Istanbul json-summary: Vitest and c8) or coverage/desktop/llvm-summary.json (cargo llvm-cov), and
// prints a Markdown table, also appended to $GITHUB_STEP_SUMMARY in CI.
// --key: which floors apply, for a suite whose floors differ per OS or e2e group (default: this OS).
// --check: exit 1 when a metric is below its floor, or the report is missing. For the suites whose
// tool does not check floors itself (e2e-server, desktop); Vitest checks the unit and integration
// floors during the run (vitest.config.ts, vitest.integration.config.ts).
import fs from 'node:fs';
import path from 'node:path';
import { againstFloors, floorsFor, istanbulTotals, llvmTotals, table } from './summary.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FLOORS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'floors.json'), 'utf8'));
const SUITES = {
  unit: 'coverage/unit/coverage-summary.json',
  integration: 'coverage/integration/coverage-summary.json',
  'e2e-server': 'coverage/e2e-server/coverage-summary.json',
  desktop: 'coverage/desktop/llvm-summary.json',
};
const OS_NAMES = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const key = flag('--key') ?? process.platform;
const check = args.includes('--check');
const named = args.filter((a) => !a.startsWith('--'));
for (const s of named) if (!(s in SUITES)) throw new Error(`unknown suite "${s}" (one of: ${Object.keys(SUITES).join(', ')})`);
const suites = named.length ? named : Object.keys(SUITES).filter((s) => fs.existsSync(path.join(ROOT, SUITES[s])));

/**
 * The table rows of one suite: the total, then its areas (the unit run's path prefixes). c8 (e2e
 * server) has a fixed denominator for lines only: its other figures are left out (e2e-server.mjs).
 */
function rows(suite, report, floors) {
  if (suite === 'desktop') return [{ name: 'total', results: againstFloors(llvmTotals(report), floors?.total) }];
  const areas = Object.fromEntries(Object.keys(floors ?? {}).filter((n) => n !== 'total').map((prefix) => [prefix, prefix]));
  const totals = istanbulTotals(report, ROOT, areas);
  const pick = (m) => (suite === 'e2e-server' ? { lines: m.lines } : m);
  return [{ name: 'total', results: againstFloors(pick(totals.total), floors?.total) }, ...Object.entries(totals.areas).map(([name, m]) => ({ name, results: againstFloors(pick(m), floors?.[name]) }))];
}

const failures = [];
const chunks = [];
for (const suite of suites) {
  const file = path.join(ROOT, SUITES[suite]);
  const where = [OS_NAMES[process.platform] ?? process.platform, ...(key === process.platform ? [] : [key])].join(', ');
  const title = `Coverage: ${suite} (${where})`;
  if (!fs.existsSync(file)) {
    chunks.push(`### ${title}\n\nNo coverage report (${SUITES[suite]}): the run stopped before writing it.\n`);
    failures.push(`${title}: no report at ${SUITES[suite]}`);
    continue;
  }
  const floors = floorsFor(FLOORS, suite, key);
  const t = table(title, rows(suite, JSON.parse(fs.readFileSync(file, 'utf8')), floors));
  chunks.push(floors ? t.markdown : `${t.markdown}\nNo floors for ${suite} on "${key}": reported, not checked.\n`);
  failures.push(...t.failures);
}
const out = chunks.join('\n');
process.stdout.write(out);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
if (check && failures.length) {
  for (const f of failures) console.error(process.env.GITHUB_ACTIONS ? `::error title=Coverage::${f}` : `✗ ${f}`);
  process.exitCode = 1;
}
