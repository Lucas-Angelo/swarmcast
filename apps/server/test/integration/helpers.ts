import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';

export const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export function tmpDir(prefix = 'sc-it-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Push a synthetic stream with a 2 s keyframe interval (like OBS should be configured).
 * Default 640x360 at 1.2 Mbps; `cbr` pads to a constant bitrate (like OBS's CBR) so segment
 * sizes match the nominal bitrate even for the easy-to-compress test pattern.
 */
export function pushTestStream(rtmpUrl: string, o: { size?: string; kbps?: number; cbr?: boolean } = {}): ChildProcess {
  const kbps = o.kbps ?? 1200;
  return spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', `testsrc2=size=${o.size ?? '640x360'}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', `${kbps}k`,
      ...(o.cbr ? ['-minrate', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`, '-x264-params', 'nal-hrd=cbr:filler=1'] : []),
      '-c:a', 'aac', '-b:a', '96k', '-f', 'flv', rtmpUrl,
    ],
    { stdio: 'ignore' },
  );
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Tiny cookie jar for fetch-based "browsers". */
export class Jar {
  private cookies = new Map<string, string>();
  constructor(private readonly base: string) {}
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair!.indexOf('=');
      const k = pair!.slice(0, eq).trim();
      const v = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (expired || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(p.startsWith('http') ? p : this.base + p, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), cookie: this.header() },
    });
    this.store(res);
    return res;
  }
  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

/**
 * Open the live link, pick a nickname, and return the viewer's cookie jar. Like the join page,
 * solves the browser check (on by default) when the server asks for it.
 */
export async function joinAs(base: string, liveLink: string, nickname: string, jar = new Jar(base)): Promise<Jar> {
  const r1 = await jar.fetch(liveLink);
  if (r1.status !== 303) throw new Error(`join link returned ${r1.status}`);
  const ch = (await (await jar.fetch('/api/join/challenge')).json()) as { required: boolean; challenge?: Challenge };
  const pow = ch.required ? { challenge: ch.challenge!, solution: await solveChallenge({ challenge: ch.challenge!, deriveKey }) } : undefined;
  const r2 = await jar.fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pow ? { nickname, pow } : { nickname }) });
  if (r2.status !== 200) throw new Error(`join returned ${r2.status}: ${await r2.text()}`);
  return jar;
}
