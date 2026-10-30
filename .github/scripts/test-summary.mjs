#!/usr/bin/env node
// A test suite's results in the job summary ($GITHUB_STEP_SUMMARY): the counts, then every failed
// and flaky test with the first line of its error, and the slowest tests. Vitest writes its own
// (its github-actions reporter, vitest*.config.ts); every other suite of the workflows uses this.
//
//   node .github/scripts/test-summary.mjs --title <text> --<format> <file> [--<format> <file>]...
//
//   --playwright <results.json>   Playwright's JSON report
//   --junit <report.xml>          JUnit XML (Pester, bats, cargo-nextest, Playwright's junit reporter)
//   --windows <results.json>      a Windows suite's results file (scripts/test/windows)
//   --cargo <log>                 the output of `cargo test`
//   --lines <log>                 a harness's output: its PASS / FAIL / WARN and ✓ / ✗ lines
//
// The parsers are the soak's (scripts/ci/soak-run.mjs), so a suite counts the same here and in the
// soak report. Reporting only: it exits 0 whatever the results say (the test step is the verdict,
// and no test is retried, so a flaky one has already failed it); a results file that is missing
// is a warning (the suite stopped before writing it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { annotate } from './annotate.mjs';
import { cargoChecks, lineChecks, playwrightChecks, windowsChecks } from '../../scripts/ci/soak-run.mjs';

const ROWS_MAX = 50;
const SLOWEST = 5;

const firstLine = (s) => (s ? stripVTControlCharacters(String(s)).trim().split('\n')[0].slice(0, 300) : undefined);
const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));

/** JUnit XML: one check per <testcase>, failed when it holds a <failure> or <error>. */
export function junitChecks(xml) {
  const out = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], unescapeXml(a[2])]));
    const body = m[2] ?? '';
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const message = failure ? (/message\s*=\s*"([^"]*)"/.exec(failure[2])?.[1] ?? failure[3]?.replace(/<!\[CDATA\[|\]\]>/g, '') ?? failure[1]) : undefined;
    const status = failure ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    out.push({ name: [attrs.classname, attrs.name].filter(Boolean).join(' › '), status, seconds: Number(attrs.time) || undefined, error: firstLine(message && unescapeXml(message)) });
  }
  return out;
}

// The soak's file parsers read a fixed file name in a run's folder; give them one.
const scratch = [];
function asRunFolder(file, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-summary-'));
  scratch.push(dir);
  fs.copyFileSync(file, path.join(dir, name));
  return dir;
}

const FORMATS = {
  playwright: (file) => playwrightChecks({ dir: asRunFolder(file, 'playwright.json') }),
  windows: (file) => windowsChecks({ dir: asRunFolder(file, 'results.json') }),
  // CARGO_TERM_COLOR=always (the workflows) can colour libtest's "ok" / "FAILED".
  cargo: (file) => cargoChecks({ output: stripVTControlCharacters(fs.readFileSync(file, 'utf8')) }),
  lines: (file) => lineChecks({ output: fs.readFileSync(file, 'utf8') }),
  junit: (file) => junitChecks(fs.readFileSync(file, 'utf8')),
};

const cell = (s) => String(s ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim() || ' ';
const duration = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s < 10 ? s.toFixed(1) : Math.round(s)} s`);

/** The Markdown for one suite's checks (null: no results file). */
export function render(title, checks, missing) {
  const lines = [`## ${title}`, ''];
  for (const m of missing) lines.push(`⚠️ **No results**: \`${m}\` was not written (the suite stopped before writing it, or its reporter is not set up).`, '');
  if (!checks.length) {
    if (!missing.length) lines.push('⚠️ **No tests** in the results.', '');
    return lines.join('\n');
  }
  const count = (s) => checks.filter((c) => c.status === s).length;
  const [pass, fail, flaky, warn, skip] = ['pass', 'fail', 'flaky', 'warn', 'skip'].map(count);
  const seconds = checks.reduce((a, c) => a + (c.seconds ?? 0), 0);
  const parts = [];
  if (fail) parts.push(`❌ **${fail} failed**`);
  if (flaky) parts.push(`❌ **${flaky} flaky** (failed, then passed: a failure)`);
  if (pass) parts.push(`✅ **${pass} passed**`);
  if (warn) parts.push(`⚠️ ${warn} warning${warn === 1 ? '' : 's'}`);
  if (skip) parts.push(`${skip} skipped`);
  parts.push(`${checks.length} total`);
  if (seconds) parts.push(duration(seconds));
  lines.push(parts.join(' · '), '');
  const bad = checks.filter((c) => c.status === 'fail' || c.status === 'flaky' || c.status === 'warn');
  if (bad.length) {
    lines.push('| result | test | first line of the error |', '|---|---|---|');
    for (const c of bad.slice(0, ROWS_MAX)) lines.push(`| ${{ fail: '❌ failed', flaky: '❌ flaky', warn: '⚠️ warning' }[c.status]} | ${cell(c.name)} | ${cell(c.error)} |`);
    if (bad.length > ROWS_MAX) lines.push(`| | … and ${bad.length - ROWS_MAX} more | |`);
    lines.push('');
  }
  const timed = checks.filter((c) => c.seconds).sort((a, b) => b.seconds - a.seconds).slice(0, SLOWEST);
  if (timed.length > 1) {
    lines.push('<details><summary>Slowest</summary>', '', '| test | time |', '|---|---|');
    for (const c of timed) lines.push(`| ${cell(c.name)} | ${duration(c.seconds)} |`);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

function main(argv) {
  let title = '';
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].replace(/^--/, '');
    if (flag === 'title') title = argv[++i] ?? '';
    else if (FORMATS[flag] && argv[i + 1]) inputs.push({ format: flag, file: argv[++i] });
    else throw new Error(`unknown argument ${argv[i]} (see the top of .github/scripts/test-summary.mjs)`);
  }
  if (!inputs.length) throw new Error('nothing to summarise: pass --playwright, --junit, --windows, --cargo or --lines with a file');
  const checks = [];
  const missing = [];
  for (const { format, file } of inputs) {
    if (!fs.existsSync(file)) missing.push(file);
    else checks.push(...FORMATS[format](file));
  }
  const name = title || inputs.map((i) => path.basename(i.file)).join(', ');
  const text = render(name, checks, missing);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  for (const m of missing) annotate('warning', name, `no results: ${m} was not written`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    annotate('warning', 'test-summary.mjs', e.message);
  } finally {
    for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
  }
}
