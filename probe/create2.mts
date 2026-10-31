// Temporary probe: first enable (creates the Run key) with concurrent panel reads, at scale, with
// the old class's own reg.exe calls traced so a failure shows which branch of status() it took.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { Autostart as NewAutostart, type Runner } from '../apps/server/src/desktop/autostart.ts';
import { Autostart as OldAutostart } from './autostart-old.ts';

const N = Number(process.env.PROBE_N ?? 1500);
const READERS = Number(process.env.PROBE_READERS ?? 4);
const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';
const exec = (c: string, a: string[], verbatim = false) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((r) =>
    execFile(c, a, { windowsHide: true, windowsVerbatimArguments: verbatim, timeout: 15_000 }, (e, so, se) => r({ code: !e ? 0 : typeof e.code === 'number' ? e.code : 1, stdout: String(so), stderr: String(se) })),
  );

let trace: string[] = [];
const traced: Runner = async (c, a, o) => {
  const r = await exec(c, a, !!o?.verbatim);
  let extra = '';
  if (a[0] === 'export') {
    try {
      const b = fs.readFileSync(a[2]!);
      extra = ` file ${b.length} bytes: ${JSON.stringify(b.subarray(2).toString('utf16le'))}`;
    } catch (err) {
      extra = ` no file (${(err as Error).message})`;
    }
  }
  trace.push(`${new Date().toISOString()} ${c} ${a[0]} -> exit ${r.code} ${r.stderr.trim()}${extra}`);
  return r;
};

async function scenario(name: string, Cls: typeof NewAutostart | typeof OldAutostart): Promise<void> {
  let failures = 0;
  for (let i = 0; i < N; i++) {
    await exec('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/f']);
    let stop = false;
    const rs = Array.from({ length: READERS }, async () => {
      const r = new Cls({ platform: 'win32', exe: EXE });
      while (!stop) await r.status();
    });
    trace = [];
    try {
      await new Cls({ platform: 'win32', exe: EXE, run: traced }).set(true);
    } catch (err) {
      failures++;
      if (failures <= 5) console.log(`  [${name}] ${i}: ${(err as Error).message}\n    ${trace.join('\n    ')}`);
    }
    stop = true;
    await Promise.all(rs);
  }
  console.log(`CREATE2 [${name}] ${N} first-time enables, ${READERS} concurrent readers: ${failures} failures`);
}

await scenario('old', OldAutostart);
await scenario('new', NewAutostart);
