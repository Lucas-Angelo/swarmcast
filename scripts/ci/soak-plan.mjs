#!/usr/bin/env node
// Expands a soak plan (.github/soak-plan.json) into the job matrices of .github/workflows/soak.yml.
//
//   node scripts/ci/soak-plan.mjs [PLAN]      PLAN = a file path or inline JSON (default .github/soak-plan.json)
//
// Prints one `<job>=<JSON list>` line per job of soak.yml (for $GITHUB_OUTPUT), plus `total=<n>`.
// A plan entry is { suite, os: [runner labels], jobs, repeat, args, label }: `jobs` fresh runners
// per OS, each running the suite `repeat` times (Playwright: --repeat-each), so a suite gets
// jobs x repeat runs per OS. `label` (optional) names a variant, so one suite can be listed twice
// on the same OS with different `args` (the E2E flake hunt and one test with --retries=0); the
// report counts each label apart. See .github/soak-plan.json for the suites and their defaults.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Suite -> the soak.yml job that runs it, and the minutes a job may spend on setup and on one
 * run (a run past that is stopped and counts as failed). `inner`: the tool repeats by itself
 * (Playwright --repeat-each), so a job makes one run that holds `repeat` copies of each test.
 */
export const SUITES = {
  unit: { job: 'node', setup: 10, run: 5 },
  integration: { job: 'node', setup: 10, run: 8 },
  'chat-load': { job: 'node', setup: 10, run: 12 },
  e2e: { job: 'node', setup: 15, run: 30, inner: true },
  rust: { job: 'rust', setup: 20, run: 5 },
  'windows-installer': { job: 'windows', setup: 15, run: 20 },
  'windows-app': { job: 'windows', setup: 15, run: 20 },
  'windows-direct': { job: 'windows', setup: 15, run: 15 },
  'windows-quality': { job: 'windows', setup: 15, run: 15 },
  'windows-obs': { job: 'windows', setup: 15, run: 15 },
  preflight: { job: 'preflight', setup: 15, run: 15 },
  scripts: { job: 'scripts', setup: 5, run: 10 },
  'desktop-test': { job: 'desktop_test', setup: 10, run: 20 },
  'desktop-dmg': { job: 'desktop_dmg', setup: 30, run: 10 },
  apt: { job: 'apt', setup: 5, run: 15 },
};
export const JOBS = [...new Set(Object.values(SUITES).map((s) => s.job))];
const MAX_MINUTES = 360; // GitHub-hosted job limit
const MAX_MATRIX = 256; // jobs per matrix

/** The release target a runner label builds and tests (preflight, desktop-test, desktop-dmg). */
export function targetOf(os) {
  if (os.startsWith('windows')) return 'windows-x64';
  if (os.startsWith('macos')) return os.endsWith('-intel') || os === 'macos-13' ? 'macos-x64' : 'macos-arm64';
  return os.endsWith('-arm') ? 'linux-arm64' : 'linux-x64';
}

export function readPlan(src = '.github/soak-plan.json') {
  const text = src.trim().startsWith('{') ? src : fs.readFileSync(src, 'utf8');
  return JSON.parse(text);
}

const count = (v, what) => {
  const n = v ?? 1;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
};

/** Every job of the plan: { id, name, suite, label, os, target, job, repeat, runs, args, timeout }. */
export function expand(plan) {
  if (!Array.isArray(plan?.suites)) throw new Error('the plan needs a "suites" list');
  const out = [];
  for (const entry of plan.suites) {
    const spec = SUITES[entry.suite];
    if (!spec) throw new Error(`unknown suite "${entry.suite}" (known: ${Object.keys(SUITES).join(', ')})`);
    const oses = Array.isArray(entry.os) ? entry.os : [entry.os];
    if (!oses.length || oses.some((o) => typeof o !== 'string' || !o)) throw new Error(`${entry.suite}: "os" must list runner labels`);
    const jobs = count(entry.jobs, `${entry.suite}.jobs`);
    const repeat = count(entry.repeat, `${entry.suite}.repeat`);
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error(`${entry.suite}: "args" must be a list of strings`);
    const label = entry.label ?? '';
    if (typeof label !== 'string' || !/^[\w.-]*$/.test(label)) throw new Error(`${entry.suite}: "label" must be letters, digits, ".", "_" or "-"`);
    const kind = label ? `${entry.suite}-${label}` : entry.suite;
    const timeout = Math.min(MAX_MINUTES, spec.setup + repeat * spec.run);
    for (const os of oses) {
      for (let j = 1; j <= jobs; j++) {
        const id = `${kind}-${os}-${j}`;
        // runs: how many runs the job makes (and the report expects from it).
        const runs = spec.inner ? 1 : repeat;
        out.push({ id, name: `${kind} · ${os} · ${j}/${jobs} (×${repeat})`, suite: entry.suite, label, os, target: targetOf(os), job: spec.job, repeat, runs, args: JSON.stringify(args), timeout });
      }
    }
  }
  const ids = new Set();
  for (const m of out) {
    if (ids.has(m.id)) throw new Error(`${m.id} is listed twice (one entry per suite and OS, or give each its own "label")`);
    ids.add(m.id);
  }
  return out;
}

/** The matrices of soak.yml: { <job>: [entries] } for every job, empty lists included. */
export function matrices(plan) {
  const all = expand(plan);
  const by = Object.fromEntries(JOBS.map((j) => [j, all.filter((m) => m.job === j)]));
  for (const [job, list] of Object.entries(by)) {
    if (list.length > MAX_MATRIX) throw new Error(`${job}: ${list.length} jobs, more than the ${MAX_MATRIX} a matrix may have`);
  }
  return { by, total: all.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { by, total } = matrices(readPlan(process.argv[2]));
  for (const [job, list] of Object.entries(by)) {
    // The job's matrix rows minus the fields the job does not use.
    console.log(`${job}=${JSON.stringify(list.map(({ job: _job, ...m }) => m))}`);
  }
  console.log(`total=${total}`);
}
