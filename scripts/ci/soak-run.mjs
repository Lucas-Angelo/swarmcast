#!/usr/bin/env node
// Runs one soak job of .github/workflows/soak.yml: the suite's usual test entry point, `runs`
// times in a row, and records every check of every run in soak-results/<id>.json (rewritten
// after each run, so a job that times out still reports the runs it finished).
//
//   SOAK='<matrix row JSON from soak-plan.mjs>' node scripts/ci/soak-run.mjs
//
// A check is one test (Vitest, Playwright, cargo test), one harness check (the Windows suites'
// result files, the PASS/FAIL lines of the shell and clean-machine harnesses), or one command of
// the run (its exit code and duration). scripts/ci/soak-report.mjs merges the files of all jobs.
// Exit code 1 when any check failed in any run (the report still counts every run).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { SUITES } from './soak-plan.mjs';

const isWin = process.platform === 'win32';

// The Tauri build dependencies (.github/actions/setup-rust), plus ffmpeg: what CI installs with apt.
const APT_PACKAGES = 'ffmpeg build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev file xz-utils';

/**
 * The commands of one run of a matrix row, in order (bash; Git Bash on Windows). $RUN_DIR is the
 * run's own folder (soak-results/<id>/run-<n>). `parse` turns the run's files and output into checks.
 */
export function commandsFor(row) {
  // The plan's extra arguments, quoted for bash.
  const A = JSON.parse(row.args || '[]')
    .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
    .join(' ');
  const COMMANDS = {
    unit: [{ name: 'vitest', cmd: `npx vitest run --retry=0 --reporter=default --reporter=json --outputFile.json="$RUN_DIR/vitest.json" ${A}`, parse: vitestChecks }],
    integration: [
      { name: 'vitest', cmd: `npx vitest run --config vitest.integration.config.ts --retry=0 --reporter=default --reporter=json --outputFile.json="$RUN_DIR/vitest.json" ${A}`, parse: vitestChecks },
    ],
    e2e: [
      {
        name: 'playwright',
        cmd: `PLAYWRIGHT_JSON_OUTPUT_NAME="$RUN_DIR/playwright.json" npx playwright test --repeat-each=${row.repeat} --reporter=list,json --output="$RUN_DIR/test-results" ${A}`,
        parse: playwrightChecks,
      },
    ],
    // The chat load bench (docs/CHAT.md): every scenario once per run, one PASS/FAIL line each.
    'chat-load': [{ name: 'bench.ts', cmd: `node --import tsx scripts/test/chat/bench.ts --out "$RUN_DIR/chat-bench" ${A}`, parse: lineChecks }],
    rust: [{ name: 'cargo test', cmd: `cd apps/desktop/src-tauri && cargo test --locked ${A}`, parse: cargoChecks }],
    preflight: [{ name: 'verify.mjs', cmd: `node scripts/test/preflight/verify.mjs --release-dir release --chrome ${A}`, parse: lineChecks }],
    scripts: isWin
      ? [
          { name: 'run.ps1', cmd: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'scripts\\test\\run.ps1' ${A}`, parse: lineChecks },
          { name: 'uninstall.ps1', cmd: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'scripts\\test\\uninstall.ps1'`, parse: lineChecks },
        ]
      : [
          { name: 'run.sh', cmd: `bash scripts/test/run.sh ${A}`, parse: lineChecks },
          { name: 'uninstall.sh', cmd: 'bash scripts/test/uninstall.sh', parse: lineChecks },
        ],
    'desktop-test': [
      {
        name: 'verify.mjs',
        cmd:
          // Linux as in _desktop.yml: a virtual display and a session bus, without the
          // accessibility bridge and the DMA-BUF renderer (no GPU under Xvfb).
          `SC_DESKTOP_ARTIFACTS="$RUN_DIR" ` +
          (process.platform === 'linux' ? "NO_AT_BRIDGE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- " : '') +
          `node scripts/test/desktop/verify.mjs --installers release/desktop ` +
          `--update-from release/update-test/0.0.0-test.1 --update-to release/desktop --update-port 47811 ${A}`,
        parse: lineChecks,
      },
    ],
    'desktop-dmg': [{ name: 'desktop.mjs --bundles app,dmg', cmd: `node scripts/build/desktop.mjs --target "${row.target}" --bundles app,dmg ${A}` }],
    // A cold apt cache every run: no downloaded .debs and no package lists.
    apt: [
      { name: 'clear the apt cache', cmd: 'sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*' },
      { name: 'apt-get update', cmd: '.github/scripts/apt-retry.sh update' },
      { name: 'apt-get install --download-only', cmd: `.github/scripts/apt-retry.sh install -y --no-install-recommends --download-only ${A || APT_PACKAGES}` },
    ],
  };
  for (const s of ['installer', 'app', 'direct', 'quality', 'obs', 'ffrepro']) {
    COMMANDS[`windows-${s}`] = [
      {
        name: `${s}.mjs`,
        cmd: `SC_ARTIFACTS="$RUN_DIR" node scripts/test/windows/${s}.mjs --work release/win-e2e \${SC_NEWER:+--newer "$SC_NEWER"} --out "$RUN_DIR/results.json" ${A}`,
        parse: windowsChecks,
      },
    ];
  }
  return COMMANDS[row.suite];
}

/**
 * Problems of the runner's infrastructure (not of SwarmCast) that the harnesses wait out by
 * themselves: counted, not failed. A check itself is never retried. The harnesses log their own
 * as "infra recovery: <what>" (a brand-new quick-tunnel name, a busy disk image, a registry pull).
 */
const RECOVERIES = {
  'apt: slow or failed try, retried': /failed or took more than \d+ s \(try \d+/g,
  'hdiutil: Resource busy': /Resource busy/g,
  'infra recovery': /infra recovery: /g,
};

// ------------------------------------------------------------------ parsers

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const rel = (f) => path.relative(process.cwd(), f).replaceAll('\\', '/');
const firstLine = (s) => (s ? stripVTControlCharacters(String(s)).trim().split('\n')[0].slice(0, 300) : undefined);

export function vitestChecks({ dir }) {
  const j = readJson(path.join(dir, 'vitest.json'));
  const out = [];
  for (const file of j?.testResults ?? []) {
    if (!file.assertionResults?.length && file.status === 'failed') out.push({ name: `${rel(file.name)} (file)`, status: 'fail', error: firstLine(file.message) });
    for (const t of file.assertionResults ?? []) {
      const status = { passed: 'pass', failed: 'fail' }[t.status] ?? 'skip';
      out.push({ name: `${rel(file.name)} › ${t.fullName ?? t.title}`, status, seconds: (t.duration ?? 0) / 1000, error: firstLine(t.failureMessages?.[0]) });
    }
  }
  return out;
}

export function playwrightChecks({ dir }) {
  const j = readJson(path.join(dir, 'playwright.json'));
  const out = [];
  const walk = (suite, titles) => {
    for (const s of suite.suites ?? []) walk(s, [...titles, s.title]);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const status = { expected: 'pass', unexpected: 'fail', flaky: 'flaky' }[t.status] ?? 'skip';
        const results = t.results ?? [];
        out.push({
          name: `${t.projectName ? `[${t.projectName}] ` : ''}${spec.file} › ${[...titles, spec.title].join(' › ')}`,
          status,
          seconds: results.reduce((a, r) => a + (r.duration ?? 0), 0) / 1000,
          error: firstLine(results.find((r) => r.error)?.error?.message),
        });
      }
    }
  };
  // The top-level suites are the files (their title is the file name, already in spec.file).
  for (const file of j?.suites ?? []) walk(file, []);
  for (const e of j?.errors ?? []) out.push({ name: 'playwright (outside a test)', status: 'fail', error: firstLine(e.message) });
  return out;
}

/** cargo test's own lines; colour codes first stripped (CI runs it with CARGO_TERM_COLOR=always). */
export function cargoChecks({ output }) {
  const text = stripVTControlCharacters(output);
  const out = [];
  for (const m of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
    out.push({ name: m[1], status: { ok: 'pass', FAILED: 'fail' }[m[2]] ?? 'skip' });
  }
  for (const c of out.filter((c) => c.status === 'fail')) {
    const block = text.split(`---- ${c.name} stdout ----`)[1];
    c.error = firstLine(block?.split('\n').find((l) => /panicked at|assert/.test(l)));
  }
  return out;
}

/** Windows suites: their own result file ({ results: [{ section, name, status, detail }] }). */
export function windowsChecks({ dir }) {
  const j = readJson(path.join(dir, 'results.json'));
  return (j?.results ?? []).filter((r) => r.status !== 'info').map((r) => ({ name: `[${r.section}] ${r.name}`, status: r.status, error: r.status === 'pass' ? undefined : firstLine(r.detail) }));
}

/**
 * PASS/FAIL lines: `PASS name`, `FAIL name (detail)` (scripts/test/*, desktop/verify.mjs) and
 * `✓ name — detail` / `✗ name` (preflight/verify.mjs). Details often hold measurements, so they
 * are cut off the name. A name seen twice in one run gets " #2", " #3", ...
 */
export function lineChecks({ output }) {
  const out = [];
  for (const raw of stripVTControlCharacters(output).split(/\r?\n/)) {
    const m = /^(PASS|FAIL|WARN|✓|✗) (.+)$/.exec(raw.trimEnd());
    if (!m) continue;
    let name = m[2].split(' — ')[0];
    const detail = m[2].slice(name.length).replace(/^ — /, '') || /\(([^()]*)\)$/.exec(name)?.[1];
    name = name.replace(/ \([^()]*\)$/, '');
    const status = { PASS: 'pass', '✓': 'pass', FAIL: 'fail', '✗': 'fail', WARN: 'warn' }[m[1]];
    out.push({ name, status, error: status === 'pass' ? undefined : detail });
  }
  return dedupe(out);
}

function dedupe(checks) {
  const seen = new Map();
  for (const c of checks) {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    if (n > 1) c.name = `${c.name} #${n}`;
  }
  return checks;
}

// ------------------------------------------------------------------ running

// Windows: Git Bash, the `shell: bash` of the workflow steps. A bare "bash" could resolve to WSL's
// System32\bash.exe first.
const gitBash = isWin ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '';
const BASH = isWin && fs.existsSync(gitBash) ? gitBash : 'bash';

/** Runs one bash command with a time limit, streaming its output; resolves { code, output, seconds, timedOut }. */
function run(cmd, env, limitMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(BASH, ['-c', cmd], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
    let output = '';
    const onData = (d) => {
      process.stdout.write(d);
      output += d;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The whole process tree: a stuck browser or app would keep the pipes open.
      if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    }, limitMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, seconds: (Date.now() - start) / 1000, timedOut });
    });
  });
}

/** The line that best explains a failed command: the last error-looking line of its output. */
function explain(output) {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-60);
  return (tail.findLast((l) => /error|fail|timed out|panicked|exception/i.test(l)) ?? tail.at(-1) ?? 'no output').slice(0, 300);
}

async function main() {
  const row = JSON.parse(process.env.SOAK ?? 'null');
  if (!row?.suite || !SUITES[row.suite]) throw new Error('SOAK must hold a matrix row of scripts/ci/soak-plan.mjs');
  const OUT = path.resolve(process.env.SOAK_OUT ?? 'soak-results');
  const spec = SUITES[row.suite];
  const commands = commandsFor(row);
  const limitMs = (spec.inner ? row.repeat : 1) * spec.run * 60_000;
  const result = { id: row.id, suite: row.suite, label: row.label || undefined, os: row.os, target: row.target, repeat: row.repeat, expectedRuns: row.runs, runs: [] };
  fs.mkdirSync(OUT, { recursive: true });
  const resultFile = path.join(OUT, `${row.id}.json`);
  let failed = false;

  for (let n = 1; n <= row.runs; n++) {
    const dir = path.join(OUT, row.id, `run-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, RUN_DIR: dir, SOAK_RUN: String(n), SOAK_TARGET: row.target };
    const checks = [];
    const recoveries = {};
    const start = Date.now();
    for (const c of commands) {
      console.log(`::group::${row.suite} run ${n}/${row.runs}: ${c.name}`);
      const r = await run(c.cmd, env, limitMs);
      console.log('::endgroup::');
      fs.writeFileSync(path.join(dir, `${c.name.replace(/[^\w.-]+/g, '_')}.log`), r.output);
      const ok = r.code === 0 && !r.timedOut;
      const error = r.timedOut ? `timed out after ${limitMs / 60_000} min` : ok ? undefined : `exit ${r.code}: ${explain(r.output)}`;
      checks.push({ name: `(command) ${c.name}`, status: ok ? 'pass' : 'fail', seconds: r.seconds, error });
      if (c.parse) checks.push(...c.parse({ dir, output: r.output }));
      for (const [kind, re] of Object.entries(RECOVERIES)) {
        const k = r.output.match(re)?.length ?? 0;
        if (k) recoveries[kind] = (recoveries[kind] ?? 0) + k;
      }
      console.log(`${ok ? 'PASS' : 'FAIL'} ${row.suite} run ${n}: ${c.name} in ${r.seconds.toFixed(0)} s${error ? ` (${error})` : ''}`);
    }
    const bad = checks.filter((c) => c.status === 'fail' || c.status === 'flaky');
    if (bad.length) failed = true;
    result.runs.push({ run: n, seconds: (Date.now() - start) / 1000, checks, recoveries });
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 1));
    console.log(`Run ${n}/${row.runs}: ${checks.length} checks, ${bad.length} failed or flaky${Object.keys(recoveries).length ? `, recovered: ${JSON.stringify(recoveries)}` : ''}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
