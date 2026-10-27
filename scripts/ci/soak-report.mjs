#!/usr/bin/env node
// Merges the result files of a soak (scripts/ci/soak-run.mjs) into one report.
//
//   node scripts/ci/soak-report.mjs <results dir> [--plan PLAN] [--out soak-report.md] [--json soak-report.json]
//
// Per suite and OS, and per check: runs, failures, flaky runs (failed, then passed on Playwright's
// retry), the pass rate on the first attempt, and a 95 % upper bound on the failure rate: the
// rule of three (3/n) when nothing failed, the Wilson score bound otherwise. Plus duration
// p50/p90/max, the failure signatures and the infra problems the harnesses recovered from.
// With --plan, runs the plan expected but no job reported count as failed ("(run finished)").
// The Markdown also goes to $GITHUB_STEP_SUMMARY. Exit code 1 when anything failed or was flaky.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { expand, readPlan } from './soak-plan.mjs';

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : 'soak-results');

// ------------------------------------------------------------------ statistics

/** 95 % upper bound on a failure rate after k failures in n runs. */
export function upperBound(k, n) {
  if (n === 0) return 1;
  if (k === 0) return Math.min(1, 3 / n); // rule of three
  const z = 1.96;
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + spread) / (1 + (z * z) / n));
}
/** Nearest-rank percentile. */
export function percentile(values, q) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
/** A failure message without the parts that change from run to run. */
export function signature(error) {
  return stripVTControlCharacters(String(error ?? 'no message'))
    .split('\n')[0]
    .replace(/\b[0-9a-f]{8,}\b/gi, 'H')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// ------------------------------------------------------------------ load

function load() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) files.push(p);
    }
  };
  walk(dir);
  const jobs = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.id && j.suite && Array.isArray(j.runs)) jobs.push(j);
    } catch {
      /* not a soak result file */
    }
  }
  return jobs;
}

/** Fills in the runs the plan expected but that never reported. */
function addMissing(jobs, plan) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const row of expand(plan)) {
    let job = byId.get(row.id);
    if (!job) {
      job = { id: row.id, suite: row.suite, os: row.os, repeat: row.repeat, expectedRuns: row.runs, runs: [] };
      jobs.push(job);
    }
    job.expectedRuns = row.runs;
  }
  for (const job of jobs) {
    for (const r of job.runs) r.checks.unshift({ name: '(run finished)', status: 'pass', seconds: r.seconds });
    for (let n = job.runs.length + 1; n <= (job.expectedRuns ?? 0); n++) {
      job.runs.push({
        run: n,
        missing: true,
        seconds: undefined,
        recoveries: {},
        checks: [{ name: '(run finished)', status: 'fail', error: 'no result: the job failed before this run, timed out or was cancelled (see its log)' }],
      });
    }
  }
}

// ------------------------------------------------------------------ aggregate

function aggregate(jobs) {
  const checks = new Map(); // suite|os|name -> stats
  const suites = new Map(); // suite|os -> stats
  for (const job of jobs) {
    const sk = `${job.suite}|${job.os}`;
    if (!suites.has(sk)) suites.set(sk, { suite: job.suite, os: job.os, jobs: 0, runs: 0, expected: 0, badRuns: 0, seconds: [], recoveries: {} });
    const s = suites.get(sk);
    s.jobs += 1;
    s.expected += job.expectedRuns ?? job.runs.length;
    for (const r of job.runs) {
      if (!r.missing) {
        s.runs += 1;
        s.seconds.push(r.seconds);
      }
      if (r.checks.some((c) => c.status === 'fail' || c.status === 'flaky')) s.badRuns += 1;
      for (const [kind, k] of Object.entries(r.recoveries ?? {})) s.recoveries[kind] = (s.recoveries[kind] ?? 0) + k;
      for (const c of r.checks) {
        const key = `${sk}|${c.name}`;
        if (!checks.has(key)) checks.set(key, { suite: job.suite, os: job.os, name: c.name, pass: 0, fail: 0, flaky: 0, warn: 0, skip: 0, seconds: [], signatures: {}, where: [] });
        const a = checks.get(key);
        a[c.status] = (a[c.status] ?? 0) + 1;
        if (c.seconds !== undefined && c.status !== 'skip') a.seconds.push(c.seconds);
        if (c.status === 'fail' || c.status === 'flaky' || c.status === 'warn') {
          const sig = signature(c.error);
          a.signatures[sig] = (a.signatures[sig] ?? 0) + 1;
          a.where.push(`${job.id} run ${r.run}`);
        }
      }
    }
  }
  for (const a of checks.values()) {
    a.n = a.pass + a.fail + a.flaky + a.warn;
    a.bad = a.fail + a.flaky;
    a.passRate = a.n ? (a.n - a.bad) / a.n : undefined;
    a.bound = upperBound(a.bad, a.n);
  }
  for (const s of suites.values()) s.bound = upperBound(s.badRuns, s.expected);
  return { checks: [...checks.values()], suites: [...suites.values()] };
}

// ------------------------------------------------------------------ report

const pct = (x) => (x === undefined ? '—' : `${(100 * x).toFixed(x === 1 || x === 0 ? 0 : 1)} %`);
const secs = (x) => (x === undefined ? '—' : x >= 120 ? `${(x / 60).toFixed(1)} min` : `${x.toFixed(x < 10 ? 1 : 0)} s`);
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const durations = (v) => `${secs(percentile(v, 0.5))} / ${secs(percentile(v, 0.9))} / ${secs(v.length ? Math.max(...v) : undefined)}`;

function markdown({ checks, suites }, { full }) {
  const bad = checks.filter((c) => c.bad > 0);
  const flaky = checks.filter((c) => c.flaky > 0 || (c.fail > 0 && c.pass > 0));
  const runs = suites.reduce((a, s) => a + s.runs, 0);
  const expected = suites.reduce((a, s) => a + s.expected, 0);
  const out = ['## Soak report', ''];
  out.push(
    `${suites.reduce((a, s) => a + s.jobs, 0)} jobs, ${runs} of ${expected} runs finished, ${checks.length} checks. ` +
      (bad.length ? `**${bad.length} checks failed or were flaky.**` : '**Every check passed in every run.**'),
    '',
    'Bound = 95 % upper bound on the failure rate per run (rule of three, 3/n, when nothing failed; Wilson score otherwise). A flaky run (failed, then passed on retry) counts as a failure.',
    '',
  );
  out.push('### Suites', '', '| Suite | OS | Runs | Runs with a failure | Bound | Run p50 / p90 / max | Recovered infra |', '|---|---|---|---|---|---|---|');
  for (const s of suites.sort((a, b) => a.suite.localeCompare(b.suite) || a.os.localeCompare(b.os))) {
    const rec =
      Object.entries(s.recoveries)
        .map(([k, v]) => `${k} ×${v}`)
        .join(', ') || '—';
    out.push(`| ${s.suite} | ${s.os} | ${s.runs}/${s.expected} | ${s.badRuns} | ${pct(s.bound)} | ${durations(s.seconds)} | ${cell(rec)} |`);
  }
  out.push('', '### Flaky checks', '');
  if (!flaky.length) out.push('None.');
  else {
    out.push('| Suite | OS | Check | Pass / fail / flaky | First-attempt pass rate |', '|---|---|---|---|---|');
    for (const c of flaky) out.push(`| ${c.suite} | ${c.os} | ${cell(c.name)} | ${c.pass} / ${c.fail} / ${c.flaky} | ${pct(c.passRate)} |`);
  }
  out.push('', '### Failing checks and their signatures', '');
  if (!bad.length) out.push('None.');
  else {
    out.push('| Suite | OS | Check | Failed / runs | Bound | Signatures (count) | First seen in |', '|---|---|---|---|---|---|---|');
    for (const c of bad.sort((a, b) => b.bad - a.bad)) {
      const sigs = Object.entries(c.signatures)
        .sort((a, b) => b[1] - a[1])
        .map(([s, k]) => `\`${s}\` (${k})`)
        .join('<br>');
      out.push(`| ${c.suite} | ${c.os} | ${cell(c.name)} | ${c.bad} / ${c.n} | ${pct(c.bound)} | ${cell(sigs)} | ${cell(c.where[0])} |`);
    }
  }
  const warned = checks.filter((c) => c.warn > 0);
  if (warned.length) {
    out.push('', '### Findings (warn: reported, not failed)', '', '| Suite | OS | Check | Warn / runs | Signature |', '|---|---|---|---|---|');
    for (const c of warned) out.push(`| ${c.suite} | ${c.os} | ${cell(c.name)} | ${c.warn} / ${c.n} | ${cell(Object.keys(c.signatures)[0] ?? '')} |`);
  }
  if (full) {
    out.push('', '### Every check', '', '| Suite | OS | Check | Runs | Fail | Flaky | Skip | Bound | p50 / p90 / max |', '|---|---|---|---|---|---|---|---|---|');
    for (const c of checks) out.push(`| ${c.suite} | ${c.os} | ${cell(c.name)} | ${c.n} | ${c.fail} | ${c.flaky} | ${c.skip} | ${pct(c.bound)} | ${durations(c.seconds)} |`);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jobs = load();
  if (opt('plan')) addMissing(jobs, readPlan(opt('plan')));
  else for (const j of jobs) for (const r of j.runs) r.checks.unshift({ name: '(run finished)', status: 'pass', seconds: r.seconds });
  const agg = aggregate(jobs);
  const md = markdown(agg, { full: true });
  const outFile = opt('out') ?? path.join(dir, 'soak-report.md');
  fs.writeFileSync(outFile, md);
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(agg, null, 1));
  // The job summary holds at most 1 MiB: without the full table when it is too long.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const short = md.length > 900_000 ? markdown(agg, { full: false }) + '\nThe table of every check is in the soak-report artifact.\n' : md;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, short);
  }
  console.log(markdown(agg, { full: false }));
  console.log(`Full report: ${outFile}`);
  process.exit(agg.checks.some((c) => c.bad > 0) ? 1 : 0);
}
