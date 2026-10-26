#!/usr/bin/env node
// Merges the per-job result files of the Windows matrix into one table (check x runner)
// for $GITHUB_STEP_SUMMARY and summary.md.
//
// Usage: node scripts/test/windows/summarize.mjs <dir with **/*.json result files>
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
