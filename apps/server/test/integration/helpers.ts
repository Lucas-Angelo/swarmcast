import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { clipFeedArgs, ensureClipSync, ffmpegBin, hasFfmpeg as ffmpegRuns, liveFeedArgs, type FeedOptions } from '../../../../scripts/test/lib/ffmpeg.mjs';
import { allocPortMap, isBindError } from '../../../../scripts/test/lib/ports.mjs';
import { descendants, spawnTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { createApp, type App, type AppOptions } from '../../src/app.js';
import { defaultConfig } from '../../src/core/config.js';
import { decodeDesktopMessage, encodeShellMessage, PROTOCOL_PREFIX, type DesktopOutMessage, type ShellMessage } from '../../src/desktop/protocol.js';

export { until, waitForLine, WaitError } from '../../../../scripts/test/lib/wait.mjs';
export { descendants, isAlive, spawnTracked, stopTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';
export { allocPortMap, allocPorts } from '../../../../scripts/test/lib/ports.mjs';

/** The ffmpeg every test uses, by absolute path ($FFMPEG_BIN in CI, else the first on PATH). */
export const FFMPEG_BIN = ffmpegBin();
export const hasFfmpeg = ffmpegRuns();

/** True where processes have POSIX signals and `ps` (macOS, Linux): the process-tree checks. */
export const POSIX = process.platform !== 'win32';

/** The repository root (the working directory of every SwarmCast a test starts). */
export const ROOT = path.resolve(import.meta.dirname, '../../../..');
const SOURCES = [path.join(ROOT, 'apps/server/src'), path.join(ROOT, 'packages/shared/src')];
const BUNDLE = path.join(ROOT, 'apps/server/dist/swarmcast.cjs');

function newestSource(dir: string): number {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestSource(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

let bundleFresh: boolean | undefined;

/**
 * Node arguments that run the server with `args`: the bundle `npm run build` made
 * (apps/server/dist/swarmcast.cjs) when it is newer than every source file, as in CI; else the
 * sources through tsx, which transpiles on every start (about a second each on a CI runner).
 */
export function serverArgs(args: string[]): string[] {
  bundleFresh ??= (() => {
    try {
      const built = fs.statSync(BUNDLE).mtimeMs;
      return SOURCES.every((d) => newestSource(d) <= built);
    } catch {
      return false;
    }
  })();
  return bundleFresh ? [BUNDLE, ...args] : ['--import', 'tsx', path.join(ROOT, 'apps/server/src/main.ts'), ...args];
}

/**
 * A new empty folder (a data folder, HOME, Downloads). In a Vitest run it lies in the run's own
 * folder (global-setup.ts sets SWARMCAST_TEST_TMP), deleted with everything in it once every
 * file has finished; for other callers (the E2E server, scripts) in the OS temp folder.
 */
export function tmpDir(prefix = 'sc-it-'): string {
  return fs.mkdtempSync(path.join(process.env.SWARMCAST_TEST_TMP ?? os.tmpdir(), prefix));
}

export type Ports = {
  rtmp: number;
  public: number;
  admin: number;
  mediamtxHls: number;
};

/** All four SwarmCast ports from this worker's block: for a SwarmCast started with a config file. */
export function allocAppPorts(): Promise<Ports> {
  return allocPortMap(['rtmp', 'public', 'admin', 'mediamtxHls']);
}

/**
 * The config.json of every SwarmCast a test starts: its own ports, no tunnel, no speed test,
 * and the public blocklists on with no list to fetch. A test run never downloads anything from
 * the internet (third-party services are not ours to call on every run, and their speed and
 * availability are not what any test checks). `extra` replaces top-level keys.
 */
export function testConfig(ports: Ports, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ports, speedTest: { enabled: false, intervalMinutes: 15 }, tunnel: { provider: 'none' }, security: { blocklists: [] }, ...extra };
}

/** Writes `testConfig(ports, extra)` as `dir`/config.json. */
export function writeConfig(dir: string, ports: Ports, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(testConfig(ports, extra)));
}

/**
 * createApp() for a test, then `live.start()` (unless `start: false`). The panel and the
 * public server listen on ports the OS picks (`app.adminUrl`, `app.live.publicPort`); MediaMTX
 * gets RTMP and HLS ports from this worker's block. A port taken between the probe and
 * MediaMTX's own listen gets one retry on new ports, logged, so a soak can count it.
 * The blocklists have no list to fetch, as in testConfig().
 */
export async function bootApp(o: AppOptions & { start?: boolean } = {}): Promise<{ app: App; ports: Ports }> {
  for (let attempt = 1; ; attempt++) {
    const { rtmp, mediamtxHls } = await allocPortMap(['rtmp', 'mediamtxHls']);
    const ports = { rtmp, mediamtxHls, public: 0, admin: 0 };
    const app = await createApp({
      dataDir: tmpDir(),
      noTunnel: true,
      noReaper: true,
      logToStdout: false,
      ...o,
      configOverrides: {
        speedTest: { enabled: false, intervalMinutes: 15 },
        security: { ...defaultConfig().security, blocklists: [] },
        ...o.configOverrides,
        ports,
      },
    });
    if (o.start === false) return { app, ports };
    try {
      await app.live.start();
      return { app, ports };
    } catch (err) {
      await app.close();
      if (attempt > 1 || !isBindError(err)) throw err;
      console.warn(`bootApp: a port was taken after the probe (${(err as Error).message}); retrying once on new ports`);
    }
  }
}

/** The command-line flags of a SwarmCast in script mode that opens nothing and draws no tray icon. */
export const SCRIPT_MODE = ['--no-tunnel', '--no-open', '--no-tray'];

export interface ServerOptions {
  /** Command-line flags (the data folder is added): SCRIPT_MODE, ['--desktop', ...]. */
  args: string[];
  /** Its data folder (default: a new one; write its config.json first, see writeConfig). */
  dataDir?: string;
  /** Its HOME (default: a new empty folder). */
  home?: string;
  /** Added to the environment (after the defaults: may replace them). */
  env?: Record<string, string>;
  /** stdin as a pipe, for the desktop protocol (default: ignored). */
  stdin?: boolean;
  /** In messages and in the log file (default "SwarmCast"). */
  name?: string;
}

/**
 * The real server in its own process, from source or the bundle (serverArgs), with its own data
 * folder, HOME and Downloads folder: never the user's SwarmCast data, LaunchAgents or downloads.
 * It never opens a browser, never notifies and never installs the video converter. stdout lines
 * of the desktop protocol (`@@swarmcast <JSON>`) land in `messages`, every other stdout line in
 * `logLines`; `proc` has the exit, the tail and stop() (stopTracked() stops it too).
 */
export class ServerProcess {
  readonly proc: Tracked;
  readonly dataDir: string;
  readonly home: string;
  readonly downloads: string;
  readonly messages: DesktopOutMessage[] = [];
  readonly logLines: string[] = [];
  /**
   * stdout lines that carry the protocol prefix without being one whole protocol line (glued
   * to a log line, cut short): the shell would miss them. Always empty.
   */
  readonly brokenLines: string[] = [];

  constructor(o: ServerOptions) {
    this.dataDir = o.dataDir ?? tmpDir('sc-data-');
    this.home = o.home ?? tmpDir('sc-home-');
    this.downloads = tmpDir('sc-dl-');
    this.proc = spawnTracked(process.execPath, serverArgs([...o.args, '--data-dir', this.dataDir]), {
      name: o.name ?? 'SwarmCast',
      cwd: ROOT,
      stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: this.home,
        USERPROFILE: this.home,
        XDG_CONFIG_HOME: '',
        SWARMCAST_DOWNLOADS_DIR: this.downloads,
        SWARMCAST_NO_OPEN: '1',
        SWARMCAST_NO_NOTIFY: '1',
        SWARMCAST_NO_FFMPEG_INSTALL: '1',
        SWARMCAST_LOG_LEVEL: 'warn',
        ...o.env,
      },
    });
    this.proc.on('line', (line, stream) => {
      if (stream !== 'stdout') return;
      const msg = decodeDesktopMessage(line);
      if (msg) this.messages.push(msg);
      else {
        if (line.includes(PROTOCOL_PREFIX.trim())) this.brokenLines.push(line);
        this.logLines.push(line);
      }
    });
  }

  get exited(): Promise<number | null> {
    return this.proc.exited.then((x) => x.code);
  }

  /** Every process the server started that runs right now (MediaMTX, its reaper): POSIX only, [] on Windows. */
  children(): number[] {
    return descendants(this.proc.pid!);
  }

  /** A shell message (or raw text) on stdin. */
  send(msg: ShellMessage | string): void {
    this.proc.child.stdin!.write(typeof msg === 'string' ? msg : encodeShellMessage(msg));
  }

  /**
   * The first protocol message from index `from` on that matches. Checked on every output line;
   * fails at once, with the server's last lines, if it exits first.
   */
  async next<T extends DesktopOutMessage>(pred: (m: DesktopOutMessage) => m is T, what: string, o: { from?: number; timeoutMs?: number } = {}): Promise<T> {
    const from = o.from ?? 0;
    let found: T | undefined;
    await until(
      () => {
        found = this.messages.slice(from).find(pred);
        return !!found;
      },
      { timeoutMs: o.timeoutMs ?? 40_000, what, abortOn: [this.proc], on: [[this.proc, 'line']], detail: () => `messages ${JSON.stringify(this.messages.slice(from).map((m) => m.type))}; last output: ${this.proc.tail(10)}` },
    );
    return found!;
  }

  /** The first log line (not a protocol message) that matches `re`; fails at once if the server exits first. */
  async logLine(re: RegExp, what: string, timeoutMs = 40_000): Promise<RegExpExecArray> {
    let match: RegExpExecArray | null = null;
    await until(() => (match = this.logLines.map((l) => re.exec(l)).find((m) => m !== null) ?? null) !== null, {
      timeoutMs,
      what,
      abortOn: [this.proc],
      on: [[this.proc, 'line']],
      detail: () => `last output: ${this.proc.tail(10)}`,
    });
    return match!;
  }
}

/** A signed-in panel: its origin, the session cookie, and fetch for its API (JSON, same origin). */
export interface Panel {
  base: string;
  cookie: string;
  /** How the login address answered: 200 and a page that opens / itself (see signIn). */
  login: { status: number; page: string };
  api(p: string, init?: RequestInit): Promise<Response>;
}

/**
 * Sign in like the browser: open the one-time /auth/<token> address (200, the session cookie,
 * a page that opens / itself: not a redirect, the cookie is SameSite=Strict) and keep the cookie.
 */
export async function signIn(loginUrl: string): Promise<Panel> {
  const res = await fetch(loginUrl, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const base = new URL(loginUrl).origin;
  return {
    base,
    cookie,
    login: { status: res.status, page: await res.text() },
    api: (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, origin: base, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } }),
  };
}

/** A local HTTP(S) server that takes every request and never answers it: a hung network. */
export interface HangingServer {
  url: string;
  /** Paths requested so far, in order. */
  readonly requests: string[];
  /** Emits 'request' for each one. */
  readonly server: http.Server;
  close(): Promise<void>;
}

/**
 * A server on 127.0.0.1 (a port the OS picks) that accepts every request and never answers:
 * the slow network of a first start, for a download or a check that must be cut short.
 * With `tls`, HTTPS with this certificate (pass its PEM to the client as a trusted CA).
 */
export async function hangingServer(o: { tls?: { certPem: string; keyPem: string } } = {}): Promise<HangingServer> {
  const requests: string[] = [];
  const onRequest = (req: http.IncomingMessage): void => void requests.push(req.url ?? '');
  const server = o.tls ? https.createServer({ cert: o.tls.certPem, key: o.tls.keyPem }, onRequest) : http.createServer(onRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${o.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Masks the stream key in RTMP URLs (`rtmp://host/app/<key>` becomes `rtmp://host/app/[key]`). */
export function maskStreamKeys(text: string): string {
  return text.replace(/(rtmp:\/\/[^\s/]+\/[^\s/]+\/)[^\s/.:'"]+/g, '$1[key]');
}

/** The fake OBS: a tracked ffmpeg (`exited`, `tail()`, `stop()` that confirms it is gone). */
export type Feed = Tracked;

/** The feeds the suites use; global-setup.ts encodes their clips before the first test. */
export const FEEDS = {
  /** What most tests need: a small stream. */
  small: {},
  /** A 1080p OBS at 6 Mbps CBR, so the ladder has 720p and 480p to make. */
  hd: { size: '1920x1080', kbps: 6000, cbr: true },
} as const satisfies Record<string, FeedOptions>;

export interface StartFeedOptions extends FeedOptions {
  /**
   * Encode in real time instead of sending a pre-encoded clip. The clip (default) costs close
   * to no CPU: x264 1080p30 in real time next to the ladder took a 3-vCPU runner to its limit.
   */
  live?: boolean;
  /** Clip length in seconds (a whole number of 2 s keyframe intervals); the feed loops it. */
  clipSeconds?: number;
  /** Send this many seconds at once first, so the first segments exist right away (default 4; 0: off). */
  burstSeconds?: number;
  /** Default test-results/fake-obs.log. */
  logFile?: string;
}

/**
 * The fake OBS: a stream with a 2 s keyframe interval (like OBS should be configured).
 * Default 640x360 at 1.2 Mbps; `cbr` pads to a constant bitrate (like OBS's CBR) so segment
 * sizes match the nominal bitrate even for the easy-to-compress test pattern.
 * By default it sends a clip encoded once (cached, see scripts/test/lib/ffmpeg.mjs) in a loop
 * with `-c copy`; `live: true` encodes in real time instead.
 * ffmpeg's output is appended to `logFile` (default test-results/fake-obs.log, uploaded by CI)
 * between a start and an exit line, so a dead feed leaves its reason behind. CI artifacts of a
 * public repo are downloadable: every line has its stream key masked.
 * Pass the feed in `abortOn` of every wait that needs it: a feed that dies fails the wait at
 * once, with ffmpeg's last lines.
 */
export function startFeed(rtmpUrl: string, o: StartFeedOptions = {}): Feed {
  const key = rtmpUrl.slice(rtmpUrl.lastIndexOf('/') + 1);
  const mask = (text: string): string => maskStreamKeys(key ? text.replaceAll(key, '[key]') : text);
  const what = `${o.size ?? '640x360'} ${o.kbps ?? 1200} kbps${o.cbr ? ' cbr' : ''}`;
  let args: string[];
  let summary: string;
  if (o.live) {
    args = liveFeedArgs(rtmpUrl, o);
    summary = `${what}, x264 in real time -> ${rtmpUrl}`;
  } else {
    const clip = ensureClipSync({ ...o, ...(o.clipSeconds ? { seconds: o.clipSeconds } : {}) });
    args = clipFeedArgs(clip, rtmpUrl, { burstSeconds: o.burstSeconds ?? 4 });
    summary = `${what}, ${path.basename(clip)} in a loop${args.includes('-readrate_initial_burst') ? ' (initial burst)' : ''} -> ${rtmpUrl}`;
  }
  return spawnTracked(FFMPEG_BIN, args, { name: 'fake OBS', logFile: o.logFile ?? path.join('test-results', 'fake-obs.log'), mask, describe: summary });
}

/** A feed encoded in real time, for callers that only need the ChildProcess (the E2E and quality servers). */
export function pushTestStream(rtmpUrl: string, o: FeedOptions & { logFile?: string } = {}): ChildProcess {
  return startFeed(rtmpUrl, { ...o, live: true }).child;
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
