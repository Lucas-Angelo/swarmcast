import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { ffmpegBin, hasFfmpeg as ffmpegRuns, liveFeedArgs, type FeedOptions } from '../../../../scripts/test/lib/ffmpeg.mjs';
import { spawnTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';

export { until, waitForLine, WaitError } from '../../../../scripts/test/lib/wait.mjs';
export { isAlive, spawnTracked, stopTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';

/** The ffmpeg every test uses, by absolute path ($FFMPEG_BIN in CI, else the first on PATH). */
export const FFMPEG_BIN = ffmpegBin();
export const hasFfmpeg = ffmpegRuns();

export function tmpDir(prefix = 'sc-it-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Masks the stream key in RTMP URLs (`rtmp://host/app/<key>` becomes `rtmp://host/app/[key]`). */
export function maskStreamKeys(text: string): string {
  return text.replace(/(rtmp:\/\/[^\s/]+\/[^\s/]+\/)[^\s/.:'"]+/g, '$1[key]');
}

/** The fake OBS: a tracked ffmpeg (`exited`, `tail()`, `stop()` that confirms it is gone). */
export type Feed = Tracked;

/**
 * Push a synthetic stream with a 2 s keyframe interval (like OBS should be configured).
 * Default 640x360 at 1.2 Mbps; `cbr` pads to a constant bitrate (like OBS's CBR) so segment
 * sizes match the nominal bitrate even for the easy-to-compress test pattern.
 * ffmpeg's output is appended to `logFile` (default test-results/fake-obs.log, uploaded by CI)
 * between a start and an exit line, so a dead feed leaves its reason behind. CI artifacts of a
 * public repo are downloadable: every line has its stream key masked.
 * Pass the feed in `abortOn` of every wait that needs it: a feed that dies fails the wait at
 * once, with ffmpeg's last lines.
 */
export function startFeed(rtmpUrl: string, o: FeedOptions & { logFile?: string } = {}): Feed {
  const key = rtmpUrl.slice(rtmpUrl.lastIndexOf('/') + 1);
  const mask = (text: string): string => maskStreamKeys(key ? text.replaceAll(key, '[key]') : text);
  const kbps = o.kbps ?? 1200;
  return spawnTracked(FFMPEG_BIN, liveFeedArgs(rtmpUrl, o), {
    name: 'fake OBS',
    logFile: o.logFile ?? path.join('test-results', 'fake-obs.log'),
    mask,
    describe: `${o.size ?? '640x360'} ${kbps} kbps${o.cbr ? ' cbr' : ''} live x264 -> ${rtmpUrl}`,
  });
}

/** `startFeed` for callers that only need the ChildProcess (the E2E and quality servers). */
export function pushTestStream(rtmpUrl: string, o: FeedOptions & { logFile?: string } = {}): ChildProcess {
  return startFeed(rtmpUrl, o).child;
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
