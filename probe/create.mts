// Temporary probe: the desktop test's situation. The Run key does not exist on a fresh runner, so
// the first "Start with the computer" creates it, while the panel window may read it (GET
// /api/desktop -> status()) at the same moment. Old (reg export) vs new (reg query by name).
import { execFile } from 'node:child_process';
import { Autostart as NewAutostart } from '../apps/server/src/desktop/autostart.ts';
import { Autostart as OldAutostart } from './autostart-old.ts';

const N = Number(process.env.PROBE_N ?? 500);
const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';
const exec = (c: string, a: string[]) => new Promise<number>((r) => execFile(c, a, { windowsHide: true }, (e) => r(e ? 1 : 0)));

async function scenario(name: string, Cls: typeof NewAutostart | typeof OldAutostart, readers: number): Promise<void> {
  let failures = 0;
  const msgs = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    await exec('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/f']);
    let stop = false;
    const rs = Array.from({ length: readers }, async () => {
      const r = new Cls({ platform: 'win32', exe: EXE });
      while (!stop) await r.status();
    });
    try {
      await new Cls({ platform: 'win32', exe: EXE }).set(true);
    } catch (err) {
      failures++;
      const m = (err as Error).message;
      msgs.set(m, (msgs.get(m) ?? 0) + 1);
    }
    stop = true;
    await Promise.all(rs);
  }
  console.log(`CREATE [${name}] ${N} first-time enables (Run key created each time), ${readers} concurrent readers: ${failures} failures`);
  for (const [m, n] of msgs) console.log(`    ${n} x ${m}`);
}

await scenario('old, no readers', OldAutostart, 0);
await scenario('old, 2 readers', OldAutostart, 2);
await scenario('new, 2 readers', NewAutostart, 2);
