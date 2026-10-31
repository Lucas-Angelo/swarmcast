// Temporary probe (soak branch only): how does the Windows autostart read-back behave on a
// GitHub windows-latest runner? Runs the real Autostart class against the real HKCU Run key.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Autostart, WINDOWS_RUN_KEY, type Runner } from '../apps/server/src/desktop/autostart.ts';

const N = Number(process.env.PROBE_N ?? 300);
const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';

function exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err?.message ?? '') });
    });
  });
}

interface Trace { t: number; args: string[]; code: number; stderr: string; text?: string }
function instrumented(): { run: Runner; trace: Trace[] } {
  const trace: Trace[] = [];
  const run: Runner = async (command, args) => {
    const r = await exec(command, args);
    const entry: Trace = { t: Date.now(), args, code: r.code, stderr: r.stderr.trim() };
    if (args[0] === 'export') {
      try {
        const buf = fs.readFileSync(args[2]!);
        entry.text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : `(not UTF-16) ${buf.toString('utf8')}`;
      } catch (err) {
        entry.text = `(no file: ${(err as Error).message})`;
      }
    }
    trace.push(entry);
    if (trace.length > 20) trace.shift();
    return r;
  };
  return { run, trace };
}

async function dumpRun(label: string): Promise<void> {
  const r = await exec('reg.exe', ['query', WINDOWS_RUN_KEY, '/s']);
  console.log(`--- ${label}: reg query Run /s (exit ${r.code})\n${r.stdout.trim()}\n${r.stderr.trim()}`);
}

/** Background loop in another process that adds and deletes other values in the Run key. */
function otherWriter(): { stop: () => Promise<number> } {
  const script = `
    const { execFileSync } = require('node:child_process');
    const key = ${JSON.stringify(WINDOWS_RUN_KEY)};
    let i = 0, stop = false;
    process.stdin.on('data', () => { stop = true; });
    (function loop() {
      if (stop) { for (const n of ['ScProbeA','ScProbeB','ScProbeC']) { try { execFileSync('reg.exe', ['delete', key, '/v', n, '/f'], { stdio: 'ignore' }); } catch {} } process.stdout.write(String(i)); process.exit(0); }
      const n = ['ScProbeA','ScProbeB','ScProbeC'][i % 3];
      try { execFileSync('reg.exe', ['add', key, '/v', n, '/t', 'REG_SZ', '/d', 'x', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
      try { execFileSync('reg.exe', ['delete', key, '/v', ['ScProbeA','ScProbeB','ScProbeC'][(i + 2) % 3], '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
      i++;
      setImmediate(loop);
    })();`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  return {
    stop: () =>
      new Promise((resolve) => {
        child.on('exit', () => resolve(Number(out)));
        child.stdin.write('x');
      }),
  };
}

async function scenario(name: string, opts: { readers?: number; writer?: boolean }): Promise<number> {
  const { run, trace } = instrumented();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const a = new Autostart({ platform: 'win32', exe: EXE, run, tmpDir });
  let stopReaders = false;
  let readerCalls = 0;
  let readerErrors = 0;
  const readers = Array.from({ length: opts.readers ?? 0 }, async () => {
    const r = new Autostart({ platform: 'win32', exe: EXE, tmpDir });
    while (!stopReaders) {
      const s = await r.status();
      readerCalls++;
      if (s.error) readerErrors++;
    }
  });
  const writer = opts.writer ? otherWriter() : null;
  let failures = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    for (const enabled of [true, false]) {
      try {
        await a.set(enabled);
      } catch (err) {
        failures++;
        if (failures <= 5) {
          console.log(`\n[${name}] iteration ${i} set(${enabled}) FAILED: ${(err as Error).message}`);
          for (const tr of trace.slice(-4)) console.log(`  ${new Date(tr.t).toISOString()} reg ${tr.args.join(' ')} -> exit ${tr.code} ${tr.stderr}${tr.text !== undefined ? `\n    export text: ${JSON.stringify(tr.text)}` : ''}`);
          await dumpRun(`[${name}] right after the failure`);
        }
      }
    }
  }
  stopReaders = true;
  await Promise.all(readers);
  const writes = writer ? await writer.stop() : 0;
  console.log(`[${name}] ${N} x (on, off): ${failures} failures, ${((Date.now() - t0) / 1000).toFixed(1)} s; reader status() calls ${readerCalls} (errors ${readerErrors}); other-writer cycles ${writes}`);
  return failures;
}

/** Mechanism: is a value read by name (reg query /v) ever missed while other values change? */
async function queryVsExport(): Promise<void> {
  await exec('reg.exe', ['add', WINDOWS_RUN_KEY, '/v', 'SwarmCast', '/t', 'REG_SZ', '/d', `"${EXE}" --background`, '/f']);
  const writer = otherWriter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-q-'));
  let exportMiss = 0;
  let exportFail = 0;
  let queryMiss = 0;
  for (let i = 0; i < N * 2; i++) {
    const file = path.join(tmp, `${i}.reg`);
    const e = await exec('reg.exe', ['export', WINDOWS_RUN_KEY, file, '/y']);
    if (e.code !== 0) {
      exportFail++;
      if (exportFail <= 3) console.log(`export exit ${e.code}: ${e.stderr.trim()}`);
    } else if (!fs.readFileSync(file).subarray(2).toString('utf16le').includes('"SwarmCast"=')) exportMiss++;
    const q = await exec('reg.exe', ['query', WINDOWS_RUN_KEY, '/v', 'SwarmCast']);
    if (q.code !== 0) queryMiss++;
  }
  const writes = await writer.stop();
  await exec('reg.exe', ['delete', WINDOWS_RUN_KEY, '/v', 'SwarmCast', '/f']);
  console.log(`[mechanism] ${N * 2} reads each while another process changes other Run values (${writes} cycles): reg export failed ${exportFail}, export without SwarmCast ${exportMiss}; reg query /v missed ${queryMiss}`);
}

await dumpRun('start');
let total = 0;
total += await scenario('sequential', {});
total += await scenario('concurrent status() readers', { readers: 2 });
total += await scenario('another process changes other Run values', { writer: true });
await queryVsExport();
await dumpRun('end');
console.log(`TOTAL set() failures: ${total}`);
