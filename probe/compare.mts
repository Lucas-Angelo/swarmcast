// Temporary probe: old (reg export) vs new (reg query by name) Autostart, under a fast writer of
// other Run values (another process), and the new one with a Unicode path.
import { spawn } from 'node:child_process';
import { Autostart as NewAutostart } from '../apps/server/src/desktop/autostart.ts';
import { Autostart as OldAutostart } from './autostart-old.ts';

const N = Number(process.env.PROBE_N ?? 300);
const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';

/** Another process that sets and deletes other Run values as fast as it can until killed. */
function fastWriter() {
  const ps = `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run'); $i=0; while ($true) { $k.SetValue('ScProbeA','x'); $k.SetValue('ScProbeB','y'); $k.DeleteValue('ScProbeA'); $k.DeleteValue('ScProbeB'); $i++; if ($i % 5000 -eq 0) { [Console]::Out.WriteLine($i); [Console]::Out.Flush() } }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let last = '0';
  child.stdout.on('data', (c) => (last = String(c).trim().split(/\s+/).pop() ?? last));
  return { stop: () => new Promise<string>((resolve) => { child.on('exit', () => resolve(last)); child.kill(); }) };
}

async function scenario(name: string, make: () => { set: (on: boolean) => Promise<unknown> }, writer: boolean): Promise<number> {
  const a = make();
  const w = writer ? fastWriter() : null;
  // let the writer get going: wait for its first output line is overkill; a status loop is enough
  let failures = 0;
  const messages = new Map<string, number>();
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    for (const on of [true, false]) {
      try {
        await a.set(on);
      } catch (err) {
        failures++;
        const m = (err as Error).message;
        messages.set(m, (messages.get(m) ?? 0) + 1);
      }
    }
  }
  const cycles = w ? await w.stop() : '0';
  console.log(`[${name}] ${N} x (on, off): ${failures} failures in ${((Date.now() - t0) / 1000).toFixed(1)} s; writer cycles >= ${cycles}`);
  for (const [m, n] of messages) console.log(`    ${n} x ${m}`);
  return failures;
}

const results: Record<string, number> = {};
results.oldQuiet = await scenario('old: reg export, no other writer', () => new OldAutostart({ platform: 'win32', exe: EXE }), false);
results.newQuiet = await scenario('new: reg query by name, no other writer', () => new NewAutostart({ platform: 'win32', exe: EXE }), false);
results.oldBusy = await scenario('old: reg export, another process changing other Run values', () => new OldAutostart({ platform: 'win32', exe: EXE }), true);
results.newBusy = await scenario('new: reg query by name, another process changing other Run values', () => new NewAutostart({ platform: 'win32', exe: EXE }), true);
const uni = 'C:\\Users\\João Ñandú 日本 😀 %USERPROFILE% & ^ !x!\\App  Data\\SwarmCast.exe';
const u = new NewAutostart({ platform: 'win32', exe: uni });
const on = await u.set(true).catch((e: Error) => e.message);
const st = await u.status();
const off = await u.set(false).catch((e: Error) => e.message);
console.log(`[new, Unicode path] on ${JSON.stringify(on)} status ${JSON.stringify(st)} off ${JSON.stringify(off)}`);
console.log(`RESULT ${JSON.stringify(results)}`);
