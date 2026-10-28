import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isListening } from '../../src/core/ports.js';
import { allocAppPorts, ROOT, serverArgs, spawnTracked, stopTracked, tmpDir, until } from './helpers.js';

// B11, second half (plan: WIN F1): the start scripts restart SwarmCast when it exits with a
// non-zero code within 10 s (start-windows.ps1). A user who quits right after the panel opened
// (tray Quit or the panel's Quit, while the live, the blocklists and the tray are still
// starting) must get a clean exit 0, or the script would start SwarmCast again.

afterEach(stopTracked);

async function quitAfter(delayMs: number): Promise<void> {
  const dir = tmpDir();
  const ports = await allocAppPorts();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ports, speedTest: { enabled: false, intervalMinutes: 15 }, tunnel: { provider: 'none' } }));
  const main = spawnTracked(process.execPath, serverArgs(['--no-tunnel', '--no-open', '--no-tray', '--data-dir', dir]), {
    name: 'SwarmCast',
    cwd: ROOT,
    env: { ...process.env, SWARMCAST_LOG_LEVEL: 'warn', SWARMCAST_NO_NOTIFY: '1' },
  });
  let login: string | undefined;
  await until(() => (login = main.lines.map((l) => /^Panel: (http:\/\/\S+\/auth\/\S+)/.exec(l)?.[1]).find(Boolean)) !== undefined, {
    timeoutMs: 30_000,
    what: 'the panel address',
    abortOn: [main],
    detail: () => main.tail(10),
  });
  const origin = new URL(login!).origin;
  // Sign in like the browser does, then wait the given time after "ready" and press Quit.
  const auth = await fetch(login!, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  await new Promise((r) => setTimeout(r, delayMs));
  const res = await fetch(`${origin}/api/app/quit`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(200);
  const { code, signal } = await main.exited;
  expect({ code, signal }, main.tail(20)).toEqual({ code: 0, signal: null });
  expect(main.lines.join('\n')).toContain('Off: nothing on your computer is reachable');
  for (const p of Object.values(ports)) expect(await isListening(p), `port ${p}`).toBe(false);
}

describe('quitting right after start-up', () => {
  for (const delayMs of [0, 300, 1000]) {
    it(`Quit ${delayMs} ms after the panel is ready exits with code 0 and leaves nothing behind`, () => quitAfter(delayMs), 60_000);
  }
});
