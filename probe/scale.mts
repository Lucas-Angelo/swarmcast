// Temporary probe: how often does each way of reading the SwarmCast Run value miss it while other
// processes add and delete other Run values (with reg.exe, as a program's installer might)?
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRegQuery, WINDOWS_QUERY_LINE, WINDOWS_RUN_KEY } from '../apps/server/src/desktop/autostart.ts';

const N = Number(process.env.PROBE_N ?? 4000);
const DATA = '"C:\\Users\\runneradmin\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe" --background';

function exec(command: string, args: string[], verbatim = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, windowsVerbatimArguments: verbatim, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: !err ? 0 : typeof err.code === 'number' ? err.code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function writer(tag: string) {
  const script = `
    const { execFileSync } = require('node:child_process');
    const key = ${JSON.stringify(WINDOWS_RUN_KEY)};
    const names = ['${tag}A', '${tag}B', '${tag}C'];
    let i = 0, stop = false;
    process.stdin.on('data', () => { stop = true; });
    (function loop() {
      if (stop) { for (const n of names) { try { execFileSync('reg.exe', ['delete', key, '/v', n, '/f'], { stdio: 'ignore' }); } catch {} } process.stdout.write(String(i)); process.exit(0); }
      try { execFileSync('reg.exe', ['add', key, '/v', names[i % 3], '/t', 'REG_SZ', '/d', 'x'.repeat(1 + (i % 50)), '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
      try { execFileSync('reg.exe', ['delete', key, '/v', names[(i + 2) % 3], '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
      i++;
      setImmediate(loop);
    })();`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  return { stop: () => new Promise<number>((resolve) => { child.on('exit', () => resolve(Number(out))); child.stdin.write('x'); }) };
}

await exec('reg.exe', ['add', WINDOWS_RUN_KEY, '/v', 'SwarmCast', '/t', 'REG_SZ', '/d', DATA, '/f']);
const writers = [writer('ScW1'), writer('ScW2')];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-'));
let exportMiss = 0, exportFail = 0, queryMiss = 0, queryWrong = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const file = path.join(tmp, 'r.reg');
  const e = await exec('reg.exe', ['export', WINDOWS_RUN_KEY, file, '/y']);
  if (e.code !== 0) {
    exportFail++;
    if (exportFail <= 3) console.log(`export exit ${e.code}: ${e.stderr.trim()}`);
  } else {
    const text = fs.readFileSync(file).subarray(2).toString('utf16le');
    if (!text.includes('"SwarmCast"=')) {
      exportMiss++;
      if (exportMiss <= 5) console.log(`${new Date().toISOString()} export ${i} without SwarmCast: ${JSON.stringify(text)}`);
    }
  }
  const q = await exec('cmd.exe', ['/d', '/s', '/c', `"${WINDOWS_QUERY_LINE}"`], true);
  if (q.code !== 0) {
    queryMiss++;
    if (queryMiss <= 3) console.log(`query ${i} exit ${q.code}: ${q.stderr.trim()}`);
  } else if (parseRegQuery(q.stdout) !== DATA) {
    queryWrong++;
    if (queryWrong <= 3) console.log(`query ${i} read ${JSON.stringify(q.stdout)}`);
  }
}
const cycles = await Promise.all(writers.map((w) => w.stop()));
await exec('reg.exe', ['delete', WINDOWS_RUN_KEY, '/v', 'SwarmCast', '/f']);
console.log(`SCALE ${JSON.stringify({ reads: N, exportMiss, exportFail, queryMiss, queryWrong, writerCycles: cycles, seconds: Math.round((Date.now() - t0) / 1000) })}`);
