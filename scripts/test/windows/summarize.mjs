#!/usr/bin/env node
// Merges the per-job result files of the Windows matrix into one table (check x runner)
// for $GITHUB_STEP_SUMMARY and summary.md.
//
// Usage: node scripts/test/windows/summarize.mjs <dir with **/*.json result files> [--soak]
// --soak: one row per check over every file and --repeat run (see soakTable below), written to
// soak-summary.md and soak-summary.json in that folder.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'results');
const files = [];
(function walk(d) {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json')) files.push(p);
  }
})(root);

const runs = [];
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.suite && Array.isArray(j.results)) runs.push(j);
  } catch {
    /* not a result file */
  }
}
const icon = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️', info: 'ℹ️' };
if (process.argv.includes('--soak')) {
  const table = soakTable(runs);
  const md = soakSummary(table);
  fs.writeFileSync(path.join(root, 'soak-summary.md'), md);
  fs.writeFileSync(path.join(root, 'soak-summary.json'), JSON.stringify(table, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  process.exit(0);
}
const runners = [...new Set(runs.map((r) => r.runner))].sort();
const suites = [...new Set(runs.map((r) => r.suite))];
const out = ['## SwarmCast Windows end-to-end matrix', ''];
for (const suite of suites) {
  const rows = new Map();
  for (const run of runs.filter((r) => r.suite === suite)) {
    for (const r of run.results) {
      if (r.status === 'info') continue;
      const key = `${r.section.replace(/ \| /g, ' ¦ ')} | ${r.name.replace(/ \| /g, ' ¦ ')}`;
      if (!rows.has(key)) rows.set(key, {});
      rows.get(key)[run.runner] = r;
    }
  }
  out.push(`### ${suite}`, '', `| Section | Check | ${runners.join(' | ')} |`, `|---|---|${runners.map(() => '---').join('|')}|`);
  for (const [key, per] of rows) {
    const [sec, name] = key.split(' | ').map((x) => x.replace(/\|/g, '\\|'));
    out.push(`| ${sec} | ${name} | ${runners.map((rn) => (per[rn] ? `${icon[per[rn].status]}` : '—')).join(' | ')} |`);
  }
  const notes = runs.filter((r) => r.suite === suite).flatMap((run) => run.results.filter((r) => r.status === 'warn' || r.status === 'fail').map((r) => `- ${icon[r.status]} **${run.runner}** [${r.section}] ${r.name}: ${r.detail.replace(/\r?\n/g, ' ')}`));
  if (notes.length) out.push('', '<details><summary>Findings and failures</summary>', '', ...notes, '', '</details>');
  const facts = runs.filter((r) => r.suite === suite).flatMap((run) => run.results.filter((r) => r.status === 'info').map((r) => `- **${run.runner}** ${r.name}: ${r.detail.replace(/\r?\n/g, ' ')}`));
  if (facts.length) out.push('', '<details><summary>Environment facts and measurements</summary>', '', ...facts, '', '</details>');
  out.push('');
}
const md = out.join('\n');
fs.writeFileSync(path.join(root, 'summary.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);

// ---------------------------------------------------------------------------
// Soak mode (--soak): every result file of a soak (many jobs, and --repeat runs inside a job)
// folded into one row per check: runs, pass, fail, warn, "passed on retry", and the 95 % upper
// bound of its failure rate (0 failures in n runs gives about 3/n, the rule of three). Plus the
// duration of each section (median, p90, max) and the counts of every "<x>: outcome" info row
// (for example the console close method and shutdown path, B2).
// ---------------------------------------------------------------------------

/** One-sided 95 % upper bound of a failure rate with k failures in n runs (exact binomial). */
function failUpper(k, n) {
  if (n === 0 || k >= n) return 1;
  // P(X <= k) for X ~ Binomial(n, p), summed in logs so a large n stays finite.
  const cdf = (p) => {
    let sum = 0;
    let logC = 0;
    for (let i = 0; i <= k; i++) {
      if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
      sum += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log1p(-p));
    }
    return sum;
  };
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
}

function quantile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : 0;
}

function soakTable(list) {
  const checks = new Map();
  const durations = new Map();
  const outcomes = new Map();
  const SEP = '\u0000';
  for (const run of list) {
    for (const r of run.results) {
      const key = [run.suite, run.runner, r.section, r.name].join(SEP);
      if (r.status === 'info') {
        if (!/: outcome$/.test(r.name)) continue;
        const value = r.detail.replace(/\s*seconds=\d+/, '');
        if (!outcomes.has(key)) outcomes.set(key, new Map());
        const m = outcomes.get(key);
        m.set(value, (m.get(value) ?? 0) + 1);
        continue;
      }
      if (!checks.has(key)) checks.set(key, { suite: run.suite, runner: run.runner, section: r.section, name: r.name, runs: 0, pass: 0, fail: 0, warn: 0, skip: 0, retry: 0, failedIn: [] });
      const c = checks.get(key);
      c.runs++;
      if (r.status in c) c[r.status]++;
      if (r.retry) c.retry++;
      if ((r.status === 'fail' || r.status === 'warn') && c.failedIn.length < 10) c.failedIn.push({ status: r.status, run: run.run?.url ?? null, rep: r.rep ?? 1, detail: r.detail.slice(0, 300) });
    }
    for (const s of run.sections ?? []) {
      const key = [run.suite, run.runner, s.section].join(SEP);
      if (!durations.has(key)) durations.set(key, []);
      durations.get(key).push(s.ms);
    }
  }
  const rows = [...checks.values()].map((c) => ({ ...c, failUpper95: failUpper(c.fail, c.runs) }));
  const sections = [...durations].map(([key, ms]) => {
    const [suite, runner, section] = key.split(SEP);
    const s = [...ms].sort((a, b) => a - b);
    return { suite, runner, section, runs: s.length, medianS: Math.round(quantile(s, 0.5) / 1000), p90S: Math.round(quantile(s, 0.9) / 1000), maxS: Math.round(s[s.length - 1] / 1000) };
  });
  const outs = [...outcomes].map(([key, m]) => {
    const [suite, runner, section, name] = key.split(SEP);
    return { suite, runner, section, name, values: Object.fromEntries([...m].sort((a, b) => b[1] - a[1])) };
  });
  return { jobs: list.length, checks: rows, sections, outcomes: outs };
}

function soakSummary(t) {
  const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)} %`;
  // Markdown table cell: backslashes first (Windows paths), then the cell separator.
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const out = ['## SwarmCast Windows soak', '', `${t.jobs} result files, ${t.checks.reduce((a, c) => a + c.runs, 0)} check runs.`, ''];
  const bad = t.checks.filter((c) => c.fail || c.warn || c.retry);
  out.push('### Checks that failed, warned or passed only on retry', '');
  if (!bad.length) out.push('None.', '');
  else {
    out.push('| Suite | Runner | Section | Check | Runs | Fail | Warn | Passed on retry | Failure rate < (95 %) |', '|---|---|---|---|---|---|---|---|---|');
    for (const c of bad.sort((a, b) => b.fail - a.fail || b.warn - a.warn)) out.push(`| ${c.suite} | ${c.runner} | ${esc(c.section)} | ${esc(c.name)} | ${c.runs} | ${c.fail} | ${c.warn} | ${c.retry} | ${pct(c.failUpper95)} |`);
    out.push('');
    const links = bad.flatMap((c) => c.failedIn.map((f) => `- ${icon[f.status]} ${c.suite} on ${c.runner} [${esc(c.section)}] ${esc(c.name)}${f.rep > 1 ? ` (run ${f.rep})` : ''}${f.run ? ` [artifacts](${f.run})` : ''}: ${esc(f.detail)}`));
    if (links.length) out.push('<details><summary>Details and artifacts</summary>', '', ...links, '', '</details>', '');
  }
  if (t.outcomes.length) {
    out.push('### Outcomes', '', '| Suite | Runner | Section | Row | Values (count) |', '|---|---|---|---|---|');
    for (const o of t.outcomes) out.push(`| ${o.suite} | ${o.runner} | ${esc(o.section)} | ${esc(o.name)} | ${Object.entries(o.values).map(([v, n]) => `${esc(v)} (${n})`).join('<br>')} |`);
    out.push('');
  }
  out.push('### Section durations', '', '| Suite | Runner | Section | Runs | Median s | p90 s | Max s |', '|---|---|---|---|---|---|---|');
  for (const s of t.sections) out.push(`| ${s.suite} | ${s.runner} | ${esc(s.section)} | ${s.runs} | ${s.medianS} | ${s.p90S} | ${s.maxS} |`);
  out.push('', '<details><summary>Every check</summary>', '', '| Suite | Runner | Section | Check | Runs | Pass | Failure rate < (95 %) |', '|---|---|---|---|---|---|---|');
  for (const c of t.checks) out.push(`| ${c.suite} | ${c.runner} | ${esc(c.section)} | ${esc(c.name)} | ${c.runs} | ${c.pass} | ${pct(c.failUpper95)} |`);
  out.push('', '</details>', '');
  return out.join('\n');
}
