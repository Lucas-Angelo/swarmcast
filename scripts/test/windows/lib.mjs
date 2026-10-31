// Shared helpers for the Windows end-to-end matrix (.github/workflows/_windows.yml).
//
// Every suite (installer.mjs, app.mjs, quality.mjs, direct.mjs, obs.mjs) records each check
// with record()/check(), keeps going after a failed section, and at the end writes
// <out>.json plus a Markdown table to $GITHUB_STEP_SUMMARY. Exit code 1 when any check failed.
//
// The installer and the app always run with a bare-OS PATH (System32, Windows, Wbem,
// WindowsPowerShell), never with the runner's Git/Node/Chocolatey tooling.
//
// No check is retried and nothing sleeps to let things settle: every wait is for its condition
// (poll, orTimeout, Playwright's waits), with a deadline. The one infra recovery is the name of
// a brand-new quick tunnel that the runner's resolver does not know yet (lib/viewer.mjs).
// The platform-neutral parts live in scripts/test/lib (shared with preflight/verify.mjs).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareEnv, loginFromOutput, waitLiveLink as waitLiveLinkOf } from '../lib/app.mjs';
import { ffmpegBin, liveFeedArgs } from '../lib/ffmpeg.mjs';
import { firefoxEnv } from '../lib/firefox.mjs';
import { writeJunit } from '../lib/junit.mjs';
import { mdCell } from '../lib/markdown.mjs';
import { isListening } from '../lib/ports.mjs';
import { ownerOf, spawnTracked } from '../lib/proc.mjs';
import { serveDir } from '../lib/release-server.mjs';
import { joinIn, pageState, playerStats, probeHealth, waitPlaying as waitPlayingIn } from '../lib/viewer.mjs';
import { formatExit, orTimeout, poll } from '../lib/wait.mjs';

export { barePath, bareEnv } from '../lib/app.mjs';
export { ffmpegBin } from '../lib/ffmpeg.mjs';
export { renderedTwice, waitPlaylistForLateJoiners } from '../lib/viewer.mjs';
export { orTimeout } from '../lib/wait.mjs';

export const isWin = process.platform === 'win32';
export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..', '..');

const args = process.argv.slice(2);
export const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
export const flag = (n) => args.includes(`--${n}`);

// Section loops for targeted soaks (one install, then the chosen sections N times):
//   --sections 13          only section 13 (plus section 0 / "environment", which always runs once)
//   --sections 0,5,X button  numbers match the section number, other words part of its name
//   --repeat 100           every section that runs (except section 0) runs 100 times
// Sections a chosen one depends on (an install, a running app) must be listed too.
const SECTIONS = (opt('sections') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const REPEAT = Math.max(1, Number(opt('repeat', '1')) || 1);
const sectionNumber = (name) => /^(\d+)\./.exec(name)?.[1] ?? (/^environment/i.test(name) ? '0' : null);
function sectionWanted(name) {
  const n = sectionNumber(name);
  if (!SECTIONS.length || n === '0') return true;
  return SECTIONS.some((s) => (/^\d+$/.test(s) ? s === n : name.toLowerCase().includes(s.toLowerCase())));
}

// CI sets SC_ARTIFACTS (the uploaded folder). Otherwise a new private folder (mkdtemp: unique
// name, mode 0700), never a fixed name in the shared temp dir that another user could create or
// point elsewhere with a symlink first.
export const ART = process.env.SC_ARTIFACTS ? path.resolve(process.env.SC_ARTIFACTS) : fs.mkdtempSync(path.join(os.tmpdir(), 'sc-win-artifacts-'));
fs.mkdirSync(ART, { recursive: true });
if (!process.env.SC_ARTIFACTS) console.log(`artifacts (results, logs, screenshots, failure dumps): ${ART}`);
export const SUITE = opt('suite', path.basename(process.argv[1] ?? 'suite', '.mjs'));
export const RUNNER = process.env.SC_RUNNER_LABEL ?? process.env.ImageOS ?? os.release();
const harnessLog = path.join(ART, `${SUITE}-harness.log`);

export function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(harnessLog, line + '\n');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const results = [];
/** One entry per section run: { section, rep, ms, failed } (the soak summary's durations). */
export const sectionRuns = [];
let currentSection = '';
let currentRep = 1;

/**
 * status: pass | fail | skip | info. There is no third verdict: what a suite can judge is a check
 * (pass or fail), and a measurement or an outcome nothing documents is info.
 */
export function record(name, status, detail = '') {
  if (!['pass', 'fail', 'skip', 'info'].includes(status)) throw new Error(`record(${JSON.stringify(name)}): unknown status ${status}`);
  const r = { section: currentSection, name, status, detail: String(detail ?? '').slice(0, 1500) };
  if (REPEAT > 1) r.rep = currentRep;
  results.push(r);
  const sym = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', info: 'INFO' }[status];
  log(`${sym} [${currentSection}] ${name}${r.detail ? ` -- ${r.detail}` : ''}`);
  return status === 'pass';
}
export const check = (name, ok, detail = '') => record(name, ok ? 'pass' : 'fail', detail);
export const info = (name, detail) => record(name, 'info', detail);
/** Like check(), but aborts the current section when it fails. */
export function must(name, ok, detail = '') {
  check(name, ok, detail);
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

const openPages = new Set();
/**
 * Tracks `page` for the failure dumps, with its requests: how many, and the last one with its
 * time. The browser process reports them (Firefox's network observer runs in the parent), so
 * for a page that stopped answering the automation they still tell whether its scripts run.
 */
export function trackPage(page, label) {
  const net = { count: 0, lastAt: 0, lastUrl: '' };
  page.on('request', (r) => {
    net.count++;
    net.lastAt = Date.now();
    net.lastUrl = r.url();
  });
  openPages.add({ page, label, net });
}
const networkLine = ({ count, lastAt, lastUrl }) =>
  count ? `requests: ${count}, the last ${((Date.now() - lastAt) / 1000).toFixed(1)} s ago (${new Date(lastAt).toISOString()}): ${lastUrl}` : 'requests: none';
async function screenshotAll(tag) {
  const states = [];
  for (const p of [...openPages]) {
    if (p.page.isClosed()) {
      openPages.delete(p);
      continue;
    }
    const file = path.join(ART, `${SUITE}-${tag}-${p.label}.png`.replace(/[^\w.-]+/g, '_'));
    const net = networkLine(p.net);
    await p.page.screenshot({ path: file, timeout: 10_000 }).catch(() => {});
    states.push(`===== ${p.label}\n${net}\n${await pageState(p.page)}`);
  }
  if (states.length) fs.writeFileSync(path.join(ART, `${SUITE}-${tag}-pages.txt`.replace(/[^\w.-]+/g, '_')), states.join('\n\n') + '\n');
}

const cleanups = [];
/** Registered cleanups run after each section (LIFO), even when it failed. */
export function onCleanup(fn) {
  cleanups.push(fn);
}

export async function section(name, fn) {
  if (!sectionWanted(name)) {
    log(`===== ${name}: skipped (--sections ${SECTIONS.join(',')})`);
    return;
  }
  const reps = sectionNumber(name) === '0' ? 1 : REPEAT;
  for (let rep = 1; rep <= reps; rep++) await runSection(name, fn, rep, reps);
}

async function runSection(name, fn, rep, reps) {
  currentSection = name;
  currentRep = rep;
  log(`===== ${name}${reps > 1 ? ` (run ${rep} of ${reps})` : ''}`);
  const t0 = Date.now();
  const tag = `${name.slice(0, 40)}${reps > 1 ? `-run${rep}` : ''}`;
  const failsBefore = results.filter((r) => r.status === 'fail').length;
  try {
    await fn();
  } catch (e) {
    record('section aborted', 'fail', e?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
  } finally {
    // Before the cleanups, so the dumps show the pages, processes and ports as the failure left
    // them: also for a failed check that did not abort the section (a viewer that never joined).
    const failed = results.filter((r) => r.status === 'fail').length > failsBefore;
    if (failed) {
      await screenshotAll(tag);
      failureDump(tag);
    }
    while (cleanups.length) {
      const c = cleanups.pop();
      try {
        await c();
      } catch (e) {
        log(`cleanup failed: ${e.message}`);
      }
    }
    openPages.clear();
    let list = null;
    try {
      list = isWin ? processes() : null;
    } catch {
      /* best effort */
    }
    closeStrayBrowsers(list);
    sweepStrays(list);
    sectionRuns.push({ section: name, rep, ms: Date.now() - t0, failed });
    log(`===== ${name} done in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

/**
 * SwarmCast opens the panel in the default browser at every start (`cmd /c start <url>`).
 * Close those windows between sections; Playwright's own browsers are left alone.
 */
export function closeStrayBrowsers(list = null) {
  if (!isWin) return;
  try {
    for (const p of list ?? processes()) {
      if (!/^(msedge|chrome|firefox|iexplore)\.exe$/i.test(p.name)) continue;
      if (/remote-debugging-pipe|juggler|playwright/i.test(p.cmd)) continue;
      spawnSync('taskkill', ['/F', '/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true });
    }
  } catch {
    /* best effort */
  }
}

// Path-based sweep at the end of every section. taskkill /T follows parent pids and misses
// orphans whose parent already exited, so anything whose executable or command line points into
// the artifacts folder, the work folder or a folder a suite adds (addSweepPath) is ended: console
// helpers, cmd /c wrappers, a start script a cleanup missed. Never this harness or its ancestors,
// nor what a suite keeps across sections (keepAcrossSections) and everything below it.
const sweepPaths = new Set([ART, path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')))]);
const keptPids = new Set();
export const addSweepPath = (p) => sweepPaths.add(path.resolve(p));
export const keepAcrossSections = (pid) => pid && keptPids.add(pid);
function sweepStrays(list) {
  if (!isWin || !list) return;
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const exempt = new Set();
  for (let p = byPid.get(process.pid); p && !exempt.has(p.pid); p = byPid.get(p.ppid)) exempt.add(p.pid);
  exempt.add(process.pid);
  for (const k of keptPids) {
    if (!byPid.has(k)) keptPids.delete(k);
    else for (const d of descendants(list, k)) exempt.add(d.pid);
  }
  const roots = [...sweepPaths].map((r) => r.toLowerCase());
  const strays = list.filter((p) => {
    if (exempt.has(p.pid)) return false;
    const cmd = (p.cmd || '').toLowerCase().replaceAll('/', '\\');
    const exe = (p.path || '').toLowerCase();
    return roots.some((r) => cmd.includes(r) || exe.startsWith(r + path.sep));
  });
  if (!strays.length) return;
  for (const p of strays) spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true });
  info('stray processes ended after the section (path sweep)', strays.map((p) => `${p.name}#${p.pid} (ppid ${p.ppid}): ${(p.cmd || p.path).slice(0, 160)}`).join(' | '));
}

/**
 * Indented process tree, one line per process: "<pid> (ppid <ppid>) <name>: <command line>".
 * A process whose parent is gone (or is itself, like the System Idle Process) is a root. Every
 * process is listed exactly once: a parent pid that Windows reused for a later process can form
 * a cycle that no root reaches, and those processes are listed as extra roots, marked.
 */
export function processTree(list) {
  const pids = new Set(list.map((p) => p.pid));
  const ROOT = Symbol('root');
  const kids = new Map();
  for (const p of list) {
    const parent = pids.has(p.ppid) && p.ppid !== p.pid ? p.ppid : ROOT;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  for (const k of kids.values()) k.sort((a, b) => a.pid - b.pid);
  const lines = [];
  const seen = new Set();
  const visit = (p, depth, note = '') => {
    seen.add(p.pid);
    lines.push(`${'  '.repeat(depth)}${p.pid} (ppid ${p.ppid}${note}) ${p.name}: ${(p.cmd || p.path || '').slice(0, 600)}`);
    for (const c of kids.get(p.pid) ?? []) if (!seen.has(c.pid)) visit(c, depth + 1);
  };
  for (const p of kids.get(ROOT) ?? []) if (!seen.has(p.pid)) visit(p, 0);
  for (const p of [...list].sort((a, b) => a.pid - b.pid)) if (!seen.has(p.pid)) visit(p, 0, ', parent pid reused');
  return lines.join('\n');
}

/** The window over which browserCpu measures: the CPU a process used in it, as a share of one core. */
const CPU_SAMPLE_MS = 3000;

/** What a browser process is, from its command line (`cmds`: pid -> command line). */
function browserRole(cmd = '') {
  const chromeType = /--type=([\w-]+)/.exec(cmd)?.[1];
  if (chromeType) return chromeType === 'utility' ? `utility ${/--utility-sub-type=([\w.]+)/.exec(cmd)?.[1] ?? ''}`.trim() : chromeType;
  // Firefox ends a child's command line with its id and type: "... 4 tab", "... 3 rdd".
  if (/-contentproc/.test(cmd)) return /\s(\d+ \w+)\s*$/.exec(cmd)?.[1] ?? 'child';
  return 'browser';
}

/**
 * CPU of every Chrome, Edge and Firefox process over CPU_SAMPLE_MS: the whole process, its main
 * thread (the oldest) with its state, and its busiest thread. A page that stopped answering the
 * automation is told apart here: a content process spinning at 100 % of a core (a script or
 * layout loop), or idle with its main thread waiting (a deadlock), or idle and fine.
 */
function browserCpu(cmds) {
  const snap = `Get-Process -Name firefox,chrome,msedge -ErrorAction SilentlyContinue | ForEach-Object {
    $th = @($_.Threads | Sort-Object { try { $_.StartTime } catch { [datetime]::MaxValue } })
    [pscustomobject]@{ pid = $_.Id; ms = $_.TotalProcessorTime.TotalMilliseconds; threads = @($th | ForEach-Object {
      [pscustomobject]@{ id = $_.Id; ms = $_.TotalProcessorTime.TotalMilliseconds; state = "$($_.ThreadState)$(if ($_.ThreadState -eq 'Wait') { ':' + $_.WaitReason })" } }) } }`;
  const out = ps(`$a = @(${snap}); Start-Sleep -Milliseconds ${CPU_SAMPLE_MS}; $b = @(${snap}); @{ a = $a; b = $b } | ConvertTo-Json -Depth 5 -Compress`, { allowFail: true, timeout: 60_000 });
  const { a = [], b = [] } = JSON.parse(out || '{}');
  const before = new Map([a].flat().map((p) => [p.pid, p]));
  const pct = (ms) => `${Math.round((ms / CPU_SAMPLE_MS) * 100)} %`;
  return [b]
    .flat()
    .filter((p) => before.has(p.pid))
    .map((p) => {
      const was = before.get(p.pid);
      const wasThread = new Map([was.threads].flat().map((t) => [t.id, t.ms]));
      const threads = [p.threads].flat().map((t) => ({ ...t, used: t.ms - (wasThread.get(t.id) ?? t.ms) }));
      const main = threads[0];
      const busiest = threads.reduce((x, t) => (t.used > x.used ? t : x), threads[0]);
      return { line: `${p.pid} ${browserRole(cmds.get(p.pid))}: ${pct(p.ms - was.ms)}; main thread ${main ? `${main.id} ${pct(main.used)} ${main.state}` : '?'}; busiest ${busiest ? `${busiest.id} ${pct(busiest.used)} ${busiest.state}` : '?'}; ${threads.length} threads`, used: p.ms - was.ms };
    })
    .sort((x, y) => y.used - x.used)
    .map((x) => x.line)
    .join('\n');
}

/**
 * Writes <suite>-dump-<tag>.txt to the artifacts: the process tree (PID, PPID, command line),
 * the CPU of the browsers' processes (browserCpu), TCP listeners and UDP endpoints with their
 * owners, and the ports Windows reserves (excludedportrange, dynamic range: Hyper-V, WSL and
 * Docker take ports from there); then the thread stacks of Firefox (firefoxStacks). The app's
 * logs are copied by startApp's cleanup.
 */
export function failureDump(tag) {
  if (!isWin) return;
  const file = path.join(ART, `${SUITE}-dump-${tag}.txt`.replace(/[^\w.-]+/g, '_'));
  const parts = [`failure dump: ${SUITE} [${currentSection}] on ${RUNNER} at ${new Date().toISOString()}`];
  const add = (title, fn) => {
    let out;
    try {
      out = fn();
    } catch (e) {
      out = `error: ${e.message}`;
    }
    parts.push(`\n===== ${title}\n${String(out ?? '').trimEnd()}`);
  };
  const netsh = (...a) => {
    const r = spawnSync('netsh', a, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `error: ${r.error.message}` : ''}`;
  };
  let names = new Map();
  let cmds = new Map();
  add('process tree (pid, ppid, name, command line)', () => {
    const list = processes();
    names = new Map(list.map((p) => [p.pid, p.name]));
    cmds = new Map(list.map((p) => [p.pid, p.cmd]));
    return processTree(list);
  });
  add(`browser processes: CPU over ${CPU_SAMPLE_MS / 1000} s (whole process, main thread, busiest thread)`, () => browserCpu(cmds));
  const owner = (pid) => `${pid} ${names.get(pid) ?? '?'}`;
  add('TCP listeners (address:port owner)', () =>
    psJson('Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess', { allowFail: true })
      .sort((a, b) => a.LocalPort - b.LocalPort)
      .map((c) => `${c.LocalAddress}:${c.LocalPort}\t${owner(c.OwningProcess)}`)
      .join('\n'),
  );
  add('UDP endpoints (address:port owner)', () =>
    psJson('Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess', { allowFail: true })
      .sort((a, b) => a.LocalPort - b.LocalPort)
      .map((c) => `${c.LocalAddress}:${c.LocalPort}\t${owner(c.OwningProcess)}`)
      .join('\n'),
  );
  add('netsh int ipv4 show excludedportrange protocol=tcp', () => netsh('int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'));
  add('netsh int ipv4 show excludedportrange protocol=udp', () => netsh('int', 'ipv4', 'show', 'excludedportrange', 'protocol=udp'));
  add('netsh int ipv4 show dynamicport tcp', () => netsh('int', 'ipv4', 'show', 'dynamicport', 'tcp'));
  try {
    fs.writeFileSync(file, parts.join('\n') + '\n');
    log(`failure dump: ${file}`);
  } catch (e) {
    log(`failure dump failed: ${e.message}`);
  }
  try {
    firefoxStacks(tag, cmds);
  } catch (e) {
    log(`Firefox thread stacks failed: ${e.message}`);
  }
}

/** The console debugger of the Windows SDK (on the GitHub Windows images), or null. */
const CDB = ['ProgramFiles(x86)', 'ProgramFiles']
  .map((v) => process.env[v] && path.join(process.env[v], 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'))
  .find((f) => f && fs.existsSync(f)) ?? null;

/**
 * Writes <suite>-stacks-<tag>.txt: the thread stacks of every Firefox process (cdb attached
 * noninvasively, no symbols needed: module + offset and the system calls show where a thread
 * waits). This is how a frozen Firefox was traced to its startup-cache write (lib/firefox.mjs).
 * `cmds`: pid -> command line, from the process tree.
 */
function firefoxStacks(tag, cmds) {
  if (!CDB) return;
  const pids = [...cmds].filter(([, cmd]) => /\\firefox\.exe/i.test(cmd ?? '')).map(([pid]) => pid);
  if (!pids.length) return;
  const out = pids.map((pid) => {
    const r = spawnSync(CDB, ['-pv', '-p', String(pid), '-c', '!runaway 7; ~*kn 40; q'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return `===== ${pid} ${browserRole(cmds.get(pid))}\n${r.stdout ?? ''}${r.error ? `error: ${r.error.message}` : ''}`;
  });
  const file = path.join(ART, `${SUITE}-stacks-${tag}.txt`.replace(/[^\w.-]+/g, '_'));
  fs.writeFileSync(file, out.join('\n\n'));
  log(`thread stacks of ${pids.length} Firefox processes: ${path.basename(file)}`);
}

export function finish() {
  const out = opt('out', path.join(ART, `${SUITE}.json`));
  const failed = results.filter((r) => r.status === 'fail');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const e = process.env;
  const run = e.GITHUB_RUN_ID ? { url: `${e.GITHUB_SERVER_URL ?? 'https://github.com'}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`, attempt: Number(e.GITHUB_RUN_ATTEMPT ?? 1), sha: e.GITHUB_SHA } : null;
  fs.writeFileSync(out, JSON.stringify({ suite: SUITE, runner: RUNNER, run, repeat: REPEAT, sectionsFilter: SECTIONS, sections: sectionRuns, results }, null, 2));
  // The same checks as JUnit next to it (<out>.junit.xml), for the CI summary; info rows are facts, not checks.
  writeJunit(out.replace(/\.json$/, '') + '.junit.xml', `${SUITE} on ${RUNNER}`, results.filter((r) => r.status !== 'info').map((r) => ({ group: r.section, name: r.rep ? `${r.name} (run ${r.rep})` : r.name, status: r.status, detail: r.detail })));
  const icon = { pass: '✅', fail: '❌', skip: '⏭️', info: 'ℹ️' };
  const md = [
    `### ${SUITE} on ${RUNNER}: ${results.filter((r) => r.status === 'pass').length} passed, ${failed.length} failed`,
    '',
    '| | Section | Check | Detail |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${icon[r.status] ?? r.status} | ${r.section} | ${r.name} | ${mdCell(r.detail.slice(0, 300))} |`),
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  log(`\n${SUITE}: ${results.length} checks, ${failed.length} failed`);
  for (const f of failed) log(`  FAILED: [${f.section}] ${f.name} -- ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Files, hashes, processes, ports
// ---------------------------------------------------------------------------

export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
export const pkgVersion = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

/** `fn`'s first truthy value, polled every `every` ms (lib/wait.mjs poll: a throw means "not yet"). */
export const until = (fn, timeoutMs, what, every = 500) => poll(fn, { timeoutMs, what, everyMs: every });

/** Runs a PowerShell 5.1 snippet; stdout is forced to UTF-8 so non-ASCII paths survive. */
export function ps(script, { timeout = 120_000, allowFail = false } = {}) {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${script}`], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) throw new Error(`powershell failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return (r.stdout ?? '').trim();
}
export function psJson(script, opts) {
  const out = ps(`${script} | ConvertTo-Json -Depth 4 -Compress`, opts);
  if (!out) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}

/** All processes: { pid, ppid, name, path, cmd }. */
export function processes() {
  return psJson('Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="ppid";e={$_.ParentProcessId}},@{n="name";e={$_.Name}},@{n="path";e={$_.ExecutablePath}},@{n="cmd";e={$_.CommandLine}}').map((p) => ({ ...p, path: p.path ?? '', cmd: p.cmd ?? '' }));
}
/** Processes whose executable lives under `dir` (SwarmCast, its reaper, MediaMTX, cloudflared, tray, ffmpeg). */
export function processesUnder(dir) {
  const d = path.resolve(dir).toLowerCase() + path.sep;
  return processes().filter((p) => p.path && p.path.toLowerCase().startsWith(d));
}
/** `root` and every process below it in `list` (by parent pid), root first. */
export function descendants(list, root) {
  const out = [];
  const want = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) {
      if (want.has(p.pid) || !want.has(p.ppid) || p.pid === p.ppid) continue;
      want.add(p.pid);
      grew = true;
    }
  }
  for (const p of list) if (want.has(p.pid)) out.push(p);
  return out.sort((a, b) => (a.pid === root ? -1 : b.pid === root ? 1 : 0));
}
export const describeProcs = (list) => list.map((p) => `${p.name}#${p.pid}${/--reaper/.test(p.cmd) ? '(reaper)' : ''}`).join(', ');
/** The main SwarmCast process (not its --reaper twin) installed under `home`. */
export function appProcess(home) {
  return processesUnder(home).find((p) => /^swarmcast\.exe$/i.test(p.name) && !/--reaper/.test(p.cmd));
}
export function killTree(pid) {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
}
export function killUnder(dir) {
  for (const p of processesUnder(dir)) killTree(p.pid);
}

/** TCP listeners (and UDP endpoints) owned by the given pids. */
export function socketsOf(pids) {
  if (!pids.length) return { tcp: [], udp: [] };
  const list = pids.join(',');
  const tcp = psJson(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${list}) -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess`, { allowFail: true });
  const udp = psJson(`Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { @(${list}) -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess`, { allowFail: true });
  return { tcp, udp };
}
export const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || /^127\./.test(a);

export const listening = isListening;

/** Occupy host:port with a plain TCP listener (simulates another program). */
export function occupy(port, host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.destroy());
    srv.once('error', reject);
    srv.listen({ port, host, exclusive: true }, () => resolve({ close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

/** PE header subsystem: 2 = Windows GUI (no console window), 3 = console. */
export function peSubsystem(file) {
  const b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  return b.readUInt16LE(pe + 4 + 20 + 68);
}

// ---------------------------------------------------------------------------
// Release server
// ---------------------------------------------------------------------------

/** The release folder `root` on 127.0.0.1 (lib/release-server.mjs): { url, port, close }. */
export const serve = (root) => serveDir(root);

// ---------------------------------------------------------------------------
// Installer / app
// ---------------------------------------------------------------------------

export const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
export const powershellExe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const cmdExe = path.join(systemRoot, 'System32', 'cmd.exe');

let instCount = 0;
/**
 * Starts the installer.
 *   entry 'ps'   powershell.exe (5.1) -NoProfile -ExecutionPolicy Bypass -File start-windows.ps1 <args>
 *   entry 'cmd'  cmd.exe /d /s /c ""<dir>\start-windows.cmd" <args>"  (what a double-click runs)
 *   entry 'iex'  powershell.exe -NoProfile -Command "irm <url>/start-windows.ps1 | iex"
 */
export function runInstaller({ entry = 'ps', dir, releaseUrl, home, args = [], iexUrl, extraEnv = {}, label = entry }) {
  const env = bareEnv({ home, releaseUrl, extra: extraEnv });
  const n = ++instCount;
  const logFile = path.join(ART, `${SUITE}-installer-${String(n).padStart(2, '0')}-${label}.log`.replace(/[^\w.\\:-]+/g, '_'));
  let child;
  if (entry === 'ps') {
    child = spawn(powershellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'start-windows.ps1'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } else if (entry === 'cmd') {
    const line = `""${path.join(dir, 'start-windows.cmd')}"${args.length ? ' ' + args.join(' ') : ''}"`;
    child = spawn(cmdExe, ['/d', '/s', '/c', line], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true });
  } else if (entry === 'iex') {
    child = spawn(powershellExe, ['-NoProfile', '-Command', `irm ${iexUrl}/start-windows.ps1 | iex`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } else throw new Error(`unknown entry ${entry}`);
  let out = '';
  const onData = (d) => {
    out += d;
    fs.appendFileSync(logFile, d);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exit = new Promise((r) => child.on('exit', (c) => r(c)));
  log(`installer #${n} (${label}) pid ${child.pid}: ${entry} ${args.join(' ')} home=${home ?? '(default)'} url=${releaseUrl ?? iexUrl ?? '(none)'}`);
  // `owner`: a wait on this start script (its panel URL, the live link) fails at once when it exits.
  return { child, out: () => out, exit, logFile, exited: () => child.exitCode !== null, owner: ownerOf(child, `start script #${n} (${label})`, () => out) };
}

/** Waits for the installer to finish (non-starting runs). */
export async function installerResult(inst, timeoutMs = 300_000) {
  const code = await orTimeout(inst.exit, timeoutMs, 'timeout');
  if (code === 'timeout') inst.child.kill();
  return { code, out: inst.out() };
}

/**
 * Parses "Panel: http://127.0.0.1:<port>/auth/<token>" from `text()`, logs in, returns an API
 * client (lib/app.mjs loginFromOutput). Fails at once when a process of `abortOn` exits first.
 */
export const adminLogin = (text, timeoutMs = 300_000, abortOn = []) => loginFromOutput(text, { timeoutMs, abortOn });

/** Starts the installed app through the installer and logs into the panel. */
export async function startApp(o) {
  const inst = runInstaller(o);
  const home = o.home ?? path.join(process.env.LOCALAPPDATA ?? '', 'SwarmCast');
  // Registered first, so it runs after the section's other cleanups (process kills).
  onCleanup(() => copyAppLogs(home, `${o.label ?? 'app'}-${inst.child.pid}`));
  // The start script restarts SwarmCast when it exits within 10 s: stop the script itself too,
  // unless the app is meant to outlive this section (o.persist).
  if (!o.persist) onCleanup(() => inst.child.exitCode === null && killTree(inst.child.pid));
  else keepAcrossSections(inst.child.pid);
  try {
    const admin = await adminLogin(inst.out, o.loginTimeoutMs ?? 300_000, [inst.owner]);
    return { inst, ...admin };
  } catch (e) {
    inst.child.kill();
    throw new Error(`${e.message}\n--- installer output tail ---\n${inst.out().slice(-3000)}`, { cause: e });
  }
}

/** The state with the live link (lib/app.mjs): fails at once on a failed start or when the start script exits. */
export const waitLiveLink = (app, timeoutMs = 120_000) => waitLiveLinkOf(app, timeoutMs, app.inst ? [app.inst.owner] : []);

/** Quits through the panel API and checks: exit code, no process under home, ports closed. */
export async function quitAndVerify(app, home, label, { via = 'api' } = {}) {
  if (via === 'api') await app.api('/api/app/quit', {}).catch(() => {});
  const code = await orTimeout(app.inst.exit, 60_000, 'timeout');
  check(`${label}: app quits cleanly (installer exit code 0)`, code === 0, `exit ${code}`);
  const left = await until(async () => (processesUnder(home).length === 0 ? [] : null), 15_000, 'no leftovers').catch(() => processesUnder(home));
  check(`${label}: no SwarmCast/reaper/MediaMTX/cloudflared/ffmpeg/tray process left`, left.length === 0, describeProcs(left));
  check(`${label}: port 1935 closed`, !(await listening(1935)));
  if (code === 'timeout') killTree(app.inst.child.pid);
  killUnder(home);
}

/**
 * Runs `cmd /c uninstall-windows.cmd [args]` (double-click equivalent, SWARMCAST_NO_PAUSE) from
 * `dir` and verifies: exit 0, no SwarmCast/reaper/MediaMTX/cloudflared/ffmpeg/tray process,
 * the data folder gone (or only config.json + secrets.json with -KeepSettings), ports free.
 * `envHome: false` leaves SWARMCAST_HOME unset (default %LOCALAPPDATA%\SwarmCast).
 */
export async function uninstallAndVerify({ dir, home, args = [], label, envHome = true, alsoPorts = [] }) {
  const cmdFile = path.join(dir, 'uninstall-windows.cmd');
  if (!fs.existsSync(cmdFile)) {
    record(`${label}: uninstaller`, 'skip', 'uninstall-windows.cmd not in this release');
    return null;
  }
  const before = processesUnder(home);
  const env = bareEnv({ home: envHome ? home : undefined });
  const line = `""${cmdFile}"${args.length ? ' ' + args.join(' ') : ''}"`;
  const child = spawn(cmdExe, ['/d', '/s', '/c', line], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const t0 = Date.now();
  const code = await orTimeout(new Promise((r) => child.on('exit', (c) => r(c))), 240_000, 'timeout');
  const secs = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(ART, `${SUITE}-uninstall-${label}.log`.replace(/[^\w.\\:-]+/g, '_')), out);
  if (code === 'timeout') killTree(child.pid);
  const keep = args.some((a) => /keep-?settings/i.test(a));
  check(`${label}: uninstall-windows.cmd${args.length ? ' ' + args.join(' ') : ''} exits 0`, code === 0, `exit ${code} after ${secs} s; was running: ${describeProcs(before) || 'nothing'}; ${(/SwarmCast uninstall finished: .*/.exec(out) ?? [''])[0]}`);
  const left = await until(async () => (processesUnder(home).length === 0 ? [] : null), 10_000, 'no process').catch(() => processesUnder(home));
  check(`${label}: no SwarmCast/MediaMTX/cloudflared/ffmpeg/tray process left`, left.length === 0, describeProcs(left));
  if (keep) {
    const kept = fs.existsSync(home) ? fs.readdirSync(home).sort() : [];
    check(`${label}: -KeepSettings keeps only config.json + secrets.json`, JSON.stringify(kept) === JSON.stringify(['config.json', 'secrets.json']), kept.join(', ') || '(folder gone)');
  } else {
    check(`${label}: data folder removed`, !fs.existsSync(home), fs.existsSync(home) ? fs.readdirSync(home).join(', ') : home);
  }
  const busy = [];
  for (const p of [1935, 8080, 8081, 8888, ...alsoPorts]) if (await listening(p)) busy.push(p);
  check(`${label}: ports free after uninstall`, busy.length === 0, busy.length ? `still listening: ${busy.join(', ')}` : `1935 8080 8081 8888${alsoPorts.length ? ' ' + alsoPorts.join(' ') : ''}`);
  check(`${label}: uninstaller says OBS settings were not changed`, /OBS settings were not changed/.test(out));
  return { code, out };
}

/**
 * A measured upload at which "your upload is too low" (capacity.tooLow: not one direct viewer,
 * packages/shared/src/capacity.ts) cannot come from the uplink: the 75 % of it SwarmCast uses,
 * 37.5 Mbps, carries five viewers of a 6 Mbps stream with the 15 % per-viewer overhead, and the
 * suites' feeds are slower still. Below it the warning can be right.
 */
const FAST_UPLINK_MBPS = 50;
/**
 * The panel's capacity line and the adaptive upload cap (docs/QUALITY.md): on a fast uplink, a
 * "too low" warning comes from the cap, which is a bug. Reads the state once the app's own speed
 * test (at start, then every 15 min while off) is not running; without a measurement of at least
 * FAST_UPLINK_MBPS the line cannot be judged, and that is recorded instead.
 */
export async function uploadCapCheck(app, label) {
  const s = await until(async () => {
    const x = await app.state();
    return x.speedTestRunning ? null : x;
  }, 120_000, "the app's speed test to finish");
  const q = await app.api('/api/quality').catch(() => null);
  const u = q?.upload ?? {};
  const up = s.speedTest?.uploadMbps;
  const detail = `capacity "${s.capacity?.code}" (${s.capacity?.directViewers} direct viewers); measured upload ${up ?? '?'} Mbps; cap ${u.capMbps} Mbps (${u.mode}/${u.phase}), ceiling ${u.ceilingMbps}; last back-off: ${u.lastBackoff ? `${u.lastBackoff.reason} ${u.lastBackoff.fromMbps}->${u.lastBackoff.toMbps}` : 'none'}; rtt ${u.signals?.rttMs}/${u.signals?.baseRttMs} ms`;
  if (!(up >= FAST_UPLINK_MBPS)) return info(`${label}: "upload too low" warning not judged`, `the speed test measured ${up === undefined ? 'nothing' : `${up} Mbps`} (needs ${FAST_UPLINK_MBPS} Mbps); ${detail}`);
  check(`${label}: no "upload too low" warning on a fast uplink`, s.capacity?.code !== 'capacity.tooLow', detail);
}

export function copyAppLogs(home, tag) {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return;
  const dest = path.join(ART, `${SUITE}-logs-${tag}`.replace(/[^\w.-]+/g, '_'));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.copyFileSync(path.join(dir, f), path.join(dest, f));
    } catch {
      /* ignore */
    }
  }
}
/** pino log lines (JSON) of the app: swarmcast-YYYY-MM-DD.log files (plus a legacy swarmcast.log), oldest first. */
export function appLog(home) {
  const dir = path.join(home, 'logs');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^swarmcast(-\d{4}-\d{2}-\d{2})?\.log$/.test(n)).sort();
  } catch {
    /* no logs yet */
  }
  return names.map((n) => readText(path.join(dir, n))).join('');
}

export function editConfig(home, fn) {
  const file = path.join(home, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fn(cfg);
  fs.mkdirSync(home, { recursive: true });
  // Written next to it, then renamed: SwarmCast never reads a half-written config.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

// ---------------------------------------------------------------------------
// OBS-like feed
// ---------------------------------------------------------------------------

/** The feed waitPhase(…, 'live') watches: the latest one pushStream started and nobody stopped. */
let currentFeed = null;
let feedCount = 0;

/**
 * The OBS-like test feed to `rtmpUrl`/`key` (lib/ffmpeg.mjs liveFeedArgs: test pattern and tone,
 * 30 fps, 2 s keyframes, x264 veryfast with peaks capped at `kbps`), as a tracked process
 * (lib/proc.mjs): its output goes to <suite>-feed-NN.log with the stream key masked, and
 * waitPhase(…, 'live') fails at once when it exits. `stop()` never throws (it is a cleanup).
 */
export function pushStream(rtmpUrl, key, { size = '640x360', kbps = 1200 } = {}) {
  const logFile = path.join(ART, `${SUITE}-feed-${String(++feedCount).padStart(2, '0')}.log`);
  const mask = (t) => (key ? t.replaceAll(key, '[stream key]') : t);
  const describe = `${ffmpegBin()} ${size} ${kbps} kbps`;
  const proc = spawnTracked(ffmpegBin(), liveFeedArgs(`${rtmpUrl}/${key}`, { size, kbps, preset: 'veryfast', vbv: true }), { name: 'test feed', logFile, mask, describe });
  log(`test feed #${feedCount} pid ${proc.pid ?? '?'}: ${describe} (output: ${path.basename(logFile)})`);
  const handle = {
    proc,
    stderr: () => proc.tail(30),
    /** null while running, else how it ended (also for a feed that never started). */
    exited: () => (proc.exitInfo ? formatExit(proc.exitInfo) : null),
    stop: () => {
      if (currentFeed === handle) currentFeed = null;
      return proc.stop().catch((e) => log(`test feed: ${e.message}`));
    },
  };
  currentFeed = handle;
  onCleanup(() => handle.stop());
  return handle;
}

/** Waits for the app's phase. Waiting for 'live' fails at once when the test feed has exited. */
export function waitPhase(app, phase, timeoutMs = 90_000) {
  const feed = phase === 'live' ? currentFeed : null;
  let last;
  return poll(
    async () => {
      const s = await app.state();
      last = s.phase;
      return s.phase === phase ? s : null;
    },
    { timeoutMs, what: `phase ${phase}`, abortOn: feed ? [feed.proc] : [], detail: () => `phase ${last ?? 'unknown'}` },
  );
}

// ---------------------------------------------------------------------------
// Browsers (Playwright: Google Chrome, Microsoft Edge, Firefox)
// ---------------------------------------------------------------------------

let pw;
async function playwright() {
  pw ??= await import('playwright');
  return pw;
}

/** kind: chrome | msedge | firefox */
export async function launchBrowser(kind) {
  const { chromium, firefox } = await playwright();
  let b;
  if (kind === 'firefox') {
    b = await firefox.launch({
      env: firefoxEnv(),
      firefoxUserPrefs: {
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
      },
    });
  } else {
    b = await chromium.launch({ channel: kind, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  }
  b.__kind = kind;
  onCleanup(() => b.close().catch(() => {}));
  log(`launched ${kind} ${b.version()}`);
  return b;
}

export async function newPage(browser, label, ctxOpts = {}) {
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') log(`[${label} console] ${m.text().slice(0, 300)}`);
  });
  trackPage(page, label);
  return { context, page };
}

/**
 * Opens the join link in a new page, picks a nickname and clicks Join (no wait for the watch
 * page; lib/viewer.mjs joinIn). A quick tunnel's brand-new name is awaited first (the one infra
 * recovery, logged); a local link is opened once.
 */
export async function join(browser, link, nickname, ctxOpts = {}) {
  const v = await newPage(browser, `${browser.__kind}-${nickname}`, ctxOpts);
  await joinIn(v.page, link, nickname, log);
  return v;
}

export const waitPlaying = waitPlayingIn;

export async function joinAndPlay(browser, link, nickname, ctxOpts = {}) {
  const v = await join(browser, link, nickname, ctxOpts);
  await v.page.waitForURL(/\/watch$/, { timeout: 60_000, waitUntil: 'commit' });
  await waitPlaying(v.page);
  return v;
}

export const stats = playerStats;

/**
 * Records hls.js events in the viewer page (window.__scHls): level switching/switched/loading,
 * errors, destroy, and the count of 480p fragments, re-attached whenever the viewer creates a
 * new hls.js instance (a source reload by the stall watchdog does). Read it with hlsProbe().
 */
export async function installHlsProbe(page) {
  await page.evaluate(() => {
    const w = window;
    if (w.__scHls) return;
    const probe = { events: [], instances: 0, frag480: 0 };
    w.__scHls = probe;
    let hooked = null;
    const hook = () => {
      const h = w.__hls;
      if (!h || h === hooked) return;
      hooked = h;
      const inst = ++probe.instances;
      const E = h.constructor?.Events ?? {};
      for (const name of ['MANIFEST_PARSED', 'LEVEL_SWITCHING', 'LEVEL_SWITCHED', 'LEVEL_LOADING', 'FRAG_LOADED', 'ERROR', 'DESTROYING']) {
        if (!E[name]) continue;
        h.on(E[name], (_e, d) => {
          const level = d?.level ?? d?.frag?.level;
          if (name === 'FRAG_LOADED') {
            // Main (video) fragments only: an audio rendition's fragments carry the audio track index
            // in frag.level, which would read as a video level (21 bogus "480p" fragments once).
            if (d?.frag?.type === 'main' && h.levels?.[level]?.height === 480) probe.frag480++;
            return;
          }
          if (probe.events.length < 400) probe.events.push({ t: Math.round(performance.now()), inst, ev: name, level, details: typeof d?.details === 'string' ? d.details : undefined, fatal: d?.fatal });
        });
      }
    };
    hook();
    setInterval(hook, 200);
  });
}
export async function hlsProbe(page) {
  return page.evaluate(() => {
    const h = window.__hls;
    const p = window.__scHls ?? { events: [], instances: 0, frag480: 0 };
    return { ...p, cur: h?.levels?.[h.currentLevel]?.height, load: h?.levels?.[h.loadLevel]?.height, auto: h?.autoLevelEnabled, stallRecoveries: window.__swarmcast?.stats?.stallRecoveries };
  });
}

/** Panel page logged in through the per-run URL. */
export async function openPanel(browser, loginUrl, label = 'panel', ctxOpts = {}) {
  const v = await newPage(browser, label, ctxOpts);
  await v.page.goto(loginUrl);
  await v.page.waitForSelector('[data-testid=status]', { timeout: 30_000 });
  return v;
}

/** Health probe of a live link's base (lib/viewer.mjs probeHealth: quick tunnels through DNS-over-HTTPS). */
export const probe = probeHealth;

// ---------------------------------------------------------------------------
// UI strings (read from the shared i18n dictionaries)
// ---------------------------------------------------------------------------

const dicts = {};
/** String for `key` in `lang` ('en' | 'pt-BR') straight from packages/shared/src/i18n/<lang>.ts. */
export function ui(lang, key) {
  dicts[lang] ??= readText(path.join(repoRoot, 'packages', 'shared', 'src', 'i18n', `${lang}.ts`));
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`'${esc}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(dicts[lang]) ?? new RegExp(`'${esc}':\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(dicts[lang]);
  return m ? m[1].replace(/\\'/g, "'") : null;
}

// ---------------------------------------------------------------------------
// Environment facts (recorded as info rows)
// ---------------------------------------------------------------------------

/**
 * Facts about the runner, in ONE PowerShell call (each PowerShell 5.1 started costs seconds on a
 * cold runner; the old nine calls took 96-102 s). The Media Foundation state (DISM, as
 * .github/scripts/media-foundation.ps1 installs it) is read only in the app suite, the one that
 * needs it for Firefox; client Windows has it built in and no such Server feature.
 */
export function environmentFacts() {
  const facts = {
    os: '(Get-CimInstance Win32_OperatingSystem | ForEach-Object { "$($_.Caption) $($_.Version) build $($_.BuildNumber)" })',
    powershell: '"Windows PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"',
    elevated: '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    uac: '(Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System).EnableLUA',
    session: '"session $((Get-Process -Id $PID).SessionId); explorer running: $([bool](Get-Process explorer -ErrorAction SilentlyContinue)); interactive: $([Environment]::UserInteractive)"',
    defaultTerminal: '$d = (Get-ItemProperty "HKCU:\\Console\\%%Startup" -ErrorAction SilentlyContinue).DelegationTerminal; if ($d) { $d } else { "not set (Windows decides)" }',
    firewall: '(Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.Enabled) in:$($_.DefaultInboundAction) notify:$($_.NotifyOnListen)" }) -join "; "',
    gpu: '(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join "; "',
    cpu: '"$((Get-CimInstance Win32_Processor | Select-Object -First 1).Name) / $([Environment]::ProcessorCount) logical cores / $([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)) GB"',
    mediaFoundation: SUITE === 'app' ? '$s = ((dism.exe /English /Online /Get-FeatureInfo /FeatureName:ServerMediaFoundation) | Select-String "^State : (.+)$").Matches.Groups[1].Value; if ($s) { "ServerMediaFoundation: $s" } else { "built in (no ServerMediaFoundation feature)" }' : '"n/a (checked in the app suite only)"',
  };
  const body = Object.entries(facts)
    .map(([k, s]) => `try { $f['${k}'] = [string](& { ${s} }) } catch { $f['${k}'] = "error: $($_.Exception.Message)" }`)
    .join('\n');
  try {
    return JSON.parse(ps(`$f = [ordered]@{}\n${body}\n$f | ConvertTo-Json -Compress`, { allowFail: true, timeout: 240_000 }));
  } catch (e) {
    return { error: `environment facts failed: ${e.message}` };
  }
}

