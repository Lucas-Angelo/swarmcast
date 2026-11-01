// Shared setup of the e2e specs: the server gate, the panel's API, viewers (real browsers and
// scripted /control clients), the player and the chat, and the fixtures that pair each change a
// test makes to the shared e2e server with the teardown that puts it back. The e2e server
// (server.ts) is one process for the whole run: every test starts from its starting state (the
// gate) and every fixture restores what its test changed, so no test depends on another's order.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect, test as base, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page, type TestInfo } from '@playwright/test';
import WebSocket from 'ws';
import type { AdminChatState, AdminState, ChatItem, ChatSettings, ChatYou, QualitySettingsUpdate, QualityState, ServerMessage } from '@swarmcast/shared';
import { NICKNAME_MAX } from '@swarmcast/shared';
import { loopbackBase, panelLogin } from '../../../../scripts/test/lib/loopback.mjs';
import { e2ePorts } from '../../../../scripts/test/lib/ports.mjs';
import { joinAs } from '../integration/helpers.js';
import { currentStall, stallTick, type StallState } from './stall-monitor.js';

export { expect };

// ---------------------------------------------------------------------------------------------
// The e2e server and its test control port
// ---------------------------------------------------------------------------------------------

/** What the e2e server wrote at start (test-results/e2e-env.json). */
export interface ServerEnv {
  adminLoginUrl: string;
  adminUrl: string;
  dataDir: string;
  downloadsDir: string;
}

export function serverEnv(): ServerEnv {
  return JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as ServerEnv;
}

// The test control port of server.ts (e2ePorts(): moved by SWARMCAST_E2E_PORT_OFFSET, like the
// other e2e ports). Every request the fixtures send goes to a loopback base rebuilt from checked
// parts (scripts/test/lib/loopback.mjs), never to a URL taken as it is from a file.
const CONTROL = loopbackBase(`http://127.0.0.1:${e2ePorts().control}`);

/** What GET /health on the test control port answers (server.ts). */
export interface StreamHealth {
  ok: boolean;
  problems: string[];
  phase: string;
  variants: number[];
  sinceSegmentMs: number | null;
  playlistS: number;
  previousTest: string;
  [k: string]: unknown;
}

async function control<T>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(pathname, CONTROL), {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`test control ${method} ${pathname}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Back to the server's starting state (reset() in server.ts). */
function resetServer(o: { hard?: boolean; test?: string } = {}): Promise<{ previous: string; did: string[] }> {
  return control('POST', `/reset${o.hard ? '?hard=1' : ''}`, o.test === undefined ? {} : { test: o.test });
}

/**
 * The stream's health, waiting up to `waitMs` for it: `qualities` variants (default 1, the
 * ladder off) and every media playlist holding `minPlaylistS`.
 */
function streamHealth(o: { waitMs?: number; minPlaylistS?: number; qualities?: number } = {}): Promise<StreamHealth> {
  return control('GET', `/health?waitMs=${o.waitMs ?? 0}&minPlaylistS=${o.minPlaylistS ?? 0}&qualities=${o.qualities ?? 1}`);
}

/**
 * Waits until the live playlist covers `seconds` of the current OBS connection (server.ts
 * healthNow). Viewers normally join a stream that has run for a while: right after OBS starts the
 * playlist is short, players sit at the live edge and every segment is urgent (fetched over HTTPS,
 * never from peers).
 */
export async function waitForPlaylist(seconds: number, o: { qualities?: number; timeoutMs?: number } = {}): Promise<void> {
  const h = await streamHealth({ waitMs: o.timeoutMs ?? 90_000, minPlaylistS: seconds, qualities: o.qualities ?? 1 });
  if (!h.ok) throw new Error(`the stream is not ready: ${h.problems.join('; ')} (${JSON.stringify(h)})`);
}

/** Forces the attack shield's automatic browser-check level (0 = back to the settings). */
export async function forcePowLevel(level: 0 | 1 | 2): Promise<number> {
  return (await control<{ browserCheck: number }>('POST', `/pow-level/${level}`)).browserCheck;
}

/**
 * The p99 of how long the server's own work held up its event loop since the previous call (ms;
 * the time the OS or the VM did not run it left out: scripts/test/lib/loop-delay.mjs), then
 * starts over.
 */
export async function serverOwnLoopDelayP99(): Promise<number> {
  return (await control<{ p99Ms: number }>('POST', '/own-loop-delay')).p99Ms;
}

/** Seconds every playlist keeps (40 by default; 20 emulates v0.2.0 ladder audio). The gate puts 40 back. */
export async function setPlaylistWindow(seconds: number): Promise<void> {
  await control('POST', `/playlist-window/${seconds}`);
}

/**
 * Makes the fake OBS reconnect with the 720p feed (`'hd'`, server.ts HD_FEED: a bigger picture
 * is when a new rendition plan applies) or the default one (null). The next test's gate puts the
 * default back by itself.
 */
export async function reconnectObs(feed: 'hd' | null): Promise<void> {
  await control('POST', '/obs', feed === null ? null : { feed });
}

/**
 * Makes the quality ladder drop a rendition at its next check (about 2 s), as when the
 * streamer's PC cannot convert it in real time; by itself it never does here (server.ts
 * SpecLoadGuard). The next test's gate puts the ladder settings back.
 */
export async function dropRendition(): Promise<void> {
  await control('POST', '/shed');
}

/**
 * Every test starts on a server in its starting state with a healthy stream: the gate resets
 * what earlier tests changed (viewers, bans, rate limits, the attack shield, settings, the
 * ladder and the fake OBS options), then waits for the stream. If it stays unhealthy, OBS
 * reconnects and the gate waits once more; still unhealthy, the test fails at once, naming the
 * test before it, instead of every later test timing out in waitPlaying.
 */
async function streamGate(testInfo: TestInfo): Promise<void> {
  const title = `${testInfo.project.name} › ${testInfo.titlePath.slice(1).join(' › ')}${testInfo.repeatEachIndex ? ` (repeat ${testInfo.repeatEachIndex})` : ''}`;
  const r = await resetServer({ test: title });
  let h = await streamHealth({ waitMs: r.did.includes('fake OBS reconnected') ? 30_000 : 10_000 });
  if (h.ok) return;
  testInfo.annotations.push({ type: 'stream-unhealthy', description: `after "${r.previous}": ${h.problems.join('; ')}` });
  await resetServer({ hard: true });
  h = await streamHealth({ waitMs: 45_000 });
  if (!h.ok) throw new Error(`stream unhealthy after "${r.previous}" (OBS reconnected, still: ${h.problems.join('; ')}): ${JSON.stringify(h)}`);
}

// ---------------------------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------------------------

const PROJECT_LETTER: Record<string, string> = { chromium: 'c', firefox: 'f', webkit: 'w' };

/** Three base-36 characters that tell this test from the others (FNV-1a of its id). */
function testTag(info: TestInfo): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < info.testId.length; i++) h = Math.imul(h ^ info.testId.charCodeAt(i), 0x01000193) >>> 0;
  return (h % 36 ** 3).toString(36).padStart(3, '0');
}

/**
 * A name unique to this test and attempt (the test, its project, retry and --repeat-each
 * index), so a test never finds another test's or an earlier attempt's viewer or message on the
 * shared server, whose chat history outlives each test: two tests may use the same prefix (a
 * test made in a loop does). Nicknames are at most 24 characters.
 */
export function uid(prefix: string, info: TestInfo = base.info()): string {
  const project = PROJECT_LETTER[info.project.name] ?? info.project.name.slice(0, 2);
  const id = `${prefix}-${project}${testTag(info)}${info.retry}x${info.repeatEachIndex}`;
  if (id.length > NICKNAME_MAX) throw new Error(`nickname "${id}" is longer than ${NICKNAME_MAX} characters: shorten the prefix "${prefix}"`);
  return id;
}

// ---------------------------------------------------------------------------------------------
// The panel's API
// ---------------------------------------------------------------------------------------------

let adminSession: { cookie: string; base: URL } | null = null;

/** The panel's base URL and a session cookie, from the control port (`GET /env`). */
async function adminAuth(): Promise<{ cookie: string; base: URL }> {
  if (adminSession) return adminSession;
  const { base, loginUrl } = panelLogin(await control<{ adminUrl: string; adminLoginPath: string }>('GET', '/env'));
  const res = await fetch(loginUrl, { redirect: 'manual' });
  adminSession = { cookie: res.headers.getSetCookie()[0]!.split(';')[0]!, base };
  return adminSession;
}

/** Any panel API call with the panel cookie; fails on an error answer (status and body in the message). */
export async function adminApi<T = unknown>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', pathname: string, body?: unknown): Promise<T> {
  const { cookie, base } = await adminAuth();
  const res = await fetch(new URL(pathname, base), {
    method,
    headers: { cookie, origin: base.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`panel ${method} ${pathname}: HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A POST to the panel API (the buttons: kick, rotate the link, disconnect everyone…). */
export function admin<T = unknown>(pathname: string, body: unknown = {}): Promise<T> {
  return adminApi<T>('POST', pathname, body);
}

export function adminState(): Promise<AdminState> {
  return adminApi<AdminState>('GET', '/api/state');
}

/** A raw upload to the panel (the "Your page" image route takes image bytes, not JSON). */
export async function adminUpload<T = unknown>(pathname: string, bytes: Buffer, contentType: string): Promise<{ status: number; body: T }> {
  const { cookie, base } = await adminAuth();
  const res = await fetch(new URL(pathname, base), { method: 'PUT', headers: { cookie, origin: base.origin, 'content-type': contentType }, body: new Uint8Array(bytes) });
  return { status: res.status, body: (await res.json()) as T };
}

/** Waits until OBS (ffmpeg) is live, then returns the current link. */
export async function liveLink(): Promise<string> {
  await expect.poll(async () => (await adminState()).phase, { timeout: 60_000 }).toBe('live');
  return (await adminState()).liveLink!;
}

/**
 * The viewer with this nickname (nicknames come from uid(), so they are unique to the attempt).
 * If one ever appears twice, prefer a connected one, then the newest.
 */
export async function viewerByNick(nick: string): Promise<AdminState['viewers'][number] | undefined> {
  const matches = (await adminState()).viewers.filter((v) => v.nickname === nick);
  return matches.findLast((v) => v.connected) ?? matches.at(-1);
}

/** Quality settings with some ladder fields changed (body for PUT /api/quality). */
export function ladderUpdate(q: QualityState, ladder: Partial<QualitySettingsUpdate['ladder']>): QualitySettingsUpdate {
  return {
    ...q.settings,
    ladder: { ...q.settings.ladder, ...ladder },
    obsWebsocket: { enabled: q.settings.obsWebsocket.enabled, url: q.settings.obsWebsocket.url },
  };
}

// ---------------------------------------------------------------------------------------------
// The panel in a browser
// ---------------------------------------------------------------------------------------------

/**
 * Opens the panel through its login URL (/auth/<token>) and waits until it lands on `/`.
 * That page sets the cookie and moves on to `/` by itself (a meta refresh, admin/gate.ts), so
 * the goto waits only for the answer ("commit"), not for the `load` of a page that is replaced
 * at once: WebKit sometimes never reports that load, and the goto then hung until the test
 * timeout (calibration soak, diagnostics on ubuntu-24.04 WebKit: 150 s, 1.5 s on the retry).
 * Where it lands is what the tests check, web-first.
 */
export async function loginPanel(page: Page, login = serverEnv().adminLoginUrl): Promise<void> {
  await page.goto(login, { waitUntil: 'commit' });
  await expect(page).toHaveURL(new URL('/', login).toString());
}

/**
 * The panel, logged in and showing the stream status, in English or in `lang`. The language
 * switch is a second navigation, started only once the login has landed on `/` (a goto during
 * the meta refresh would be interrupted by it).
 */
export async function openPanel(page: Page, lang?: 'en' | 'pt-BR'): Promise<void> {
  const login = serverEnv().adminLoginUrl;
  await loginPanel(page, login);
  if (lang) await page.goto(new URL(`/?lang=${lang}`, login).toString());
  await expect(page.getByTestId('status')).toBeVisible();
}

/**
 * Waits until the panel's viewers table lists `nickname`. The table sits above the Chat card and
 * gains a row per new session: a click aimed at a card below it while a join is still on its
 * way to the panel lands wherever the card was before the row pushed it down.
 */
export async function panelShows(page: Page, nickname: string): Promise<void> {
  await expect(page.getByTestId(`viewer-${nickname}`)).toBeVisible();
}

// ---------------------------------------------------------------------------------------------
// Viewers in real browsers
// ---------------------------------------------------------------------------------------------

/** How long join() waits for the final answer to POST /api/join (a browser check included). */
const JOIN_ANSWER_MS = 60_000;

/** The join page's own state, for a join that got no answer: which step it never finished. */
function joinPageState(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const el = (id: string) => document.getElementById(id);
      const progress = el('check-progress') as HTMLProgressElement | null;
      const sent = performance
        .getEntriesByType('resource')
        .map((r) => new URL(r.name).pathname)
        .filter((p) => p.startsWith('/api/') || p.includes('pow-worker'));
      return JSON.stringify({
        readyState: document.readyState,
        button: { disabled: (el('join') as HTMLButtonElement | null)?.disabled },
        check: { hidden: el('check')?.hidden, progress: progress?.value },
        error: el('error')?.hidden ? null : el('error')?.textContent,
        requests: sent,
      });
    })
    .catch((e: Error) => `unavailable (${e.message})`);
}

/** The console of every page the `viewers` fixture opened, from its first line (join() reports it). */
const consoles = new WeakMap<Page, string[]>();

function recordConsole(page: Page): void {
  const lines: string[] = [];
  consoles.set(page, lines);
  page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
}

/**
 * Picks `nickname` on the join page and joins; fails with the server's status and reason when
 * the join is refused, and with the join page's own state and console when no final answer comes.
 * Types once "Watch" is enabled, as the page's script does once it handles the form: a page that
 * lost a script on the way reloads itself first (its startup guard), and a nickname typed into
 * the page it replaces would be gone.
 */
async function joinFrom(page: Page, nickname: string): Promise<void> {
  const consoleLines = consoles.get(page) ?? [];
  await expect(page.locator('#join')).toBeEnabled();
  await page.fill('#nickname', nickname);
  // A 403 "check required" is not final: the page solves the browser check and posts again.
  const answer = page.waitForResponse(async (r) => {
    if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/join') return false;
    if (r.status() !== 403) return true;
    const body = (await r.json().catch(() => ({}))) as { code?: string };
    return body.code !== 'viewer.err.checkRequired';
  }, { timeout: 0 });
  // The page shows an error without a final answer when the browser check fails.
  const shownError = page.locator('#error').waitFor({ state: 'visible', timeout: 0 }).then(() => null);
  // The race below settles on one of these; the others end with the page and must not be
  // reported as unhandled rejections.
  answer.catch(() => {});
  shownError.catch(() => {});
  await page.click('#join');
  let stuckTimer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<'stuck'>((resolve) => {
    stuckTimer = setTimeout(() => resolve('stuck'), JOIN_ANSWER_MS);
  });
  const res = await Promise.race([answer, shownError, stuck]).finally(() => clearTimeout(stuckTimer));
  if (res === 'stuck') throw new Error(`join as "${nickname}": no POST /api/join answer in ${JOIN_ANSWER_MS / 1000} s; the page: ${await joinPageState(page)}; console: ${JSON.stringify(consoleLines.slice(-20))}`);
  if (!res) throw new Error(`join as "${nickname}" failed without a final POST /api/join answer; the page says: ${await page.locator('#error').textContent()}`);
  expect(res.status(), `POST /api/join as "${nickname}" answered ${res.status()}: ${await res.text().catch(() => '(no body)')}`).toBe(200);
  await expect(page).toHaveURL(/\/watch$/);
}

export interface Viewer {
  readonly nickname: string;
  readonly context: BrowserContext;
  readonly page: Page;
}

export interface BrowserOptions {
  /** Context options (locale, colour scheme…). */
  context?: BrowserContextOptions;
  /** Runs on the new context before its page opens: init scripts, routes, listeners. */
  setup?: (context: BrowserContext) => Promise<void>;
}

export interface JoinPageOptions extends BrowserOptions {
  /** The link to open (the current live link by default). */
  link?: string;
  /** Runs on the new page before it opens the link (a CDP session that shapes its network). */
  prepare?: (page: Page) => Promise<void>;
}

/** The `viewers` fixture: browsers of their own (one context each), all closed after the test. */
export class Audience {
  private readonly contexts: BrowserContext[] = [];

  constructor(private readonly browser: Browser) {}

  /** A new browser of its own (cookies, storage, device id), closed after the test. */
  async browserContext(o: BrowserOptions = {}): Promise<BrowserContext> {
    const context = await this.browser.newContext(o.context);
    this.contexts.push(context);
    await o.setup?.(context);
    return context;
  }

  /** A new browser on the join page of the live link, not joined yet. */
  async atJoinPage(o: JoinPageOptions = {}): Promise<Page> {
    const page = await (await this.browserContext(o)).newPage();
    recordConsole(page);
    await o.prepare?.(page);
    await page.goto(o.link ?? (await liveLink()));
    await expect(page).toHaveURL(/\/join$/);
    return page;
  }

  /** A new browser that opened the live link, joined as `nickname` and is on the watch page. */
  async join(nickname: string, o: JoinPageOptions = {}): Promise<Viewer> {
    const page = await this.atJoinPage(o);
    await joinFrom(page, nickname);
    return { nickname, context: page.context(), page };
  }

  async close(): Promise<void> {
    for (const c of this.contexts.splice(0)) await c.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------------------------

/**
 * Waits until the video has really played `seconds` (summed `played` ranges, not currentTime:
 * hls.js seeks to the live start position before the first frame plays, so a large
 * currentTime alone does not mean playback started).
 */
export async function waitPlaying(page: Page, seconds = 1.5): Promise<void> {
  await page.waitForFunction((s) => {
    const v = document.querySelector('video');
    if (!v || v.paused) return false;
    let played = 0;
    for (let i = 0; i < v.played.length; i++) played += v.played.end(i) - v.played.start(i);
    return played > s;
  }, seconds, { timeout: 60_000 });
}

/**
 * Turns the sound on, as a viewer does with the Unmute button (the video autoplays muted). For
 * the scenarios that time playback: Chrome clocks muted, video-only playback by the frames it
 * gets on screen, and on the 3-vCPU macOS runner, which composites about 15 frames a second,
 * muted video then plays at about half speed. Measured there (probe in PR #21): 0.55x muted,
 * 1.02x with sound, its audio output clocking playback; 1.0x both ways on Ubuntu.
 */
export async function unmute(page: Page): Promise<void> {
  const button = page.locator('#unmute');
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.muted)).toBe(false);
}

export async function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')!.currentTime);
}

/** The player can no longer play: paused, and with no media left (hls.js detached it). */
export async function playerStopped(page: Page): Promise<{ paused: boolean; hasMedia: boolean }> {
  return page.evaluate(() => {
    const v = document.querySelector('video')!;
    return { paused: v.paused, hasMedia: v.readyState > HTMLMediaElement.HAVE_NOTHING };
  });
}

/**
 * Lets `ms` of real time pass: only for a window the test measures (playback next to a slow
 * peer, a network phase, a flood) or a fault it injects for that long. Every other wait in the
 * suite waits for its condition.
 */
export function measuredWindow(page: Page, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

async function installStallMonitorCode(page: Page): Promise<void> {
  // stall-monitor.ts, in the page (its source, so the spec and the unit test share the logic).
  await page.evaluate(`window.__stallTick = ${stallTick.toString()}; window.__currentStall = ${currentStall.toString()};`);
}

/**
 * Starts a playback monitor in the page: `stallReport()` then returns the longest time (ms)
 * the playhead did not play while not paused, since the last start, and how many seconds of
 * media played (`playedS`). Only playback steps count: a jump (the stall watchdog's seeks, a
 * source reload) is neither playback nor lost progress (stall-monitor.ts).
 */
export async function startStallMonitor(page: Page, name = 'stall'): Promise<void> {
  await installStallMonitorCode(page);
  await page.evaluate((key) => {
    type W = Record<string, (StallState & { timer: number }) | undefined> & { __stallTick: typeof stallTick; __swarmcast?: { delay?: { holding?: boolean } | null } };
    const w = window as unknown as W;
    const old = w[`__${key}`];
    if (old) clearInterval(old.timer);
    const v = document.querySelector('video')!;
    const st = { prev: v.currentTime, prevNow: performance.now(), at: performance.now(), max: 0, played: 0, frozen: false, timer: 0 };
    st.timer = window.setInterval(() => {
      w.__stallTick(st, { now: performance.now(), currentTime: v.currentTime, paused: v.paused, held: w.__swarmcast?.delay?.holding === true });
    }, 200);
    w[`__${key}`] = st;
  }, name);
}

export async function stallReport(page: Page, name = 'stall'): Promise<{ maxStallMs: number; currentStallMs: number; currentTime: number; playedS: number }> {
  return page.evaluate((key) => {
    const w = window as unknown as Record<string, StallState> & { __currentStall: typeof currentStall };
    const st = w[`__${key}`]!;
    const current = w.__currentStall(st, performance.now());
    return { maxStallMs: Math.max(st.max, current), currentStallMs: current, currentTime: document.querySelector('video')!.currentTime, playedS: st.played };
  }, name);
}

/**
 * Waits until the player has played `seconds` more from now. Counted by a monitor of its own
 * (playback steps only, stall-monitor.ts), so a seek right before or during it (Go live, a
 * profile switch, a source reload) neither counts as playback nor hides it.
 */
export async function playsOn(page: Page, seconds: number, o: { timeout?: number } = {}): Promise<void> {
  await startStallMonitor(page, 'playsOn');
  await expect.poll(async () => (await stallReport(page, 'playsOn')).playedS, { timeout: o.timeout ?? 30_000, message: `${seconds} s more of playback` }).toBeGreaterThan(seconds);
  await page.evaluate(() => clearInterval((window as unknown as { __playsOn: { timer: number } }).__playsOn.timer));
}

export interface ViewerStats {
  httpBytes: number;
  p2pDownBytes: number;
  p2pUpBytes: number;
  peers: string[];
  hashFailures: number;
  httpFallbacks: number;
  peersDropped: number;
  stallRecoveries: number;
  /** Times the player loaded the source again (watch.ts), and why the last time. */
  reloads: number;
  lastReload: string | null;
  p2pEnabled: boolean;
  p2pAllowed: boolean;
}

export async function stats(page: Page): Promise<ViewerStats> {
  return page.evaluate(() => (window as unknown as { __swarmcast: { stats: ViewerStats } }).__swarmcast.stats);
}

/** Turns P2P on (it is off by default, opt-in; `check` is a no-op when already checked). */
export async function enableP2P(page: Page): Promise<void> {
  await page.check('#p2p');
  await expect(page.locator('#p2p')).toBeChecked();
}

// ---------------------------------------------------------------------------------------------
// What a page sends: other origins, WebSockets, the tracker inside /control
// ---------------------------------------------------------------------------------------------

/** Every request `context` makes to an origin other than `origin`, from now on (url and referer). */
export function outsideRequests(context: BrowserContext, origin: string): Array<{ url: string; referer?: string }> {
  const seen: Array<{ url: string; referer?: string }> = [];
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && u.origin !== origin) seen.push({ url: r.url(), referer: r.headers()['referer'] });
  });
  return seen;
}

/**
 * Resolves once the page has laid out and painted what it shows now, twice: by then everything
 * its current DOM loads (images, lazy images in view, what observers start on layout) has been
 * requested. What a test checks next about the requests it saw covers what the page shows.
 */
export async function painted(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** The path of every WebSocket the pages of `context` open, from now on. */
export function webSockets(context: BrowserContext): string[] {
  const paths: string[] = [];
  context.on('page', (p) => p.on('websocket', (ws) => paths.push(new URL(ws.url()).pathname)));
  return paths;
}

/** A WebTorrent tracker message carried inside /control (packages/shared/src/mux.ts `~d<id> <json>`). */
export interface TrackerMessage {
  at: number;
  /** The channel's id inside /control. */
  channel: number;
  body: { action?: string; offer?: unknown; answer?: unknown; interval?: number; complete?: number; incomplete?: number; 'failure reason'?: string; [k: string]: unknown };
}

/**
 * Every tracker message the pages of `context` send and receive on /control, from now on. An
 * announce answer is a received message with an `interval`; its `complete + incomplete` is the
 * size of the swarm the tracker answered for.
 */
export function trackerTraffic(context: BrowserContext): { sent: TrackerMessage[]; received: TrackerMessage[] } {
  const log = { sent: [] as TrackerMessage[], received: [] as TrackerMessage[] };
  const parse = (payload: string | Buffer): TrackerMessage | null => {
    const m = /^~d(\d+) ([\s\S]*)$/.exec(String(payload));
    if (!m) return null;
    try {
      return { at: Date.now(), channel: Number(m[1]), body: JSON.parse(m[2]!) as TrackerMessage['body'] };
    } catch {
      return null;
    }
  };
  context.on('page', (p) =>
    p.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname !== '/control') return;
      ws.on('framesent', (f) => {
        const m = parse(f.payload);
        if (m) log.sent.push(m);
      });
      ws.on('framereceived', (f) => {
        const m = parse(f.payload);
        if (m) log.received.push(m);
      });
    }),
  );
  return log;
}

// ---------------------------------------------------------------------------------------------
// The chat on a viewer page
// ---------------------------------------------------------------------------------------------

export function chatMessage(page: Page, text: string): Locator {
  return page.getByTestId('chat-list').locator('li.msg', { hasText: text });
}

/** The chat column shows (hello carried a snapshot: the chat is on by default). */
export async function chatReady(...pages: Page[]): Promise<void> {
  for (const p of pages) await expect(p.getByTestId('chat')).toBeVisible({ timeout: 15_000 });
}

/**
 * Sends a message that must go through: waits until the server took it (the "sending…" row
 * settles). `shown` is the part of the row's text to find it by when the message has emotes
 * (an emote code shows as a picture, not as text).
 */
export async function say(page: Page, text: string, shown = text): Promise<void> {
  const input = page.getByTestId('chat-input');
  await input.fill(text);
  await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 10_000 });
  await input.press('Enter');
  const own = chatMessage(page, shown).last();
  await expect(own, "the sender's own row").not.toHaveClass(/\bpending\b/, { timeout: 10_000 });
  if (/\bfailed\b/.test((await own.getAttribute('class')) ?? '')) throw new Error(`"${text}" was refused: ${await page.getByTestId('chat-status').textContent()}`);
}

/**
 * Another viewer's page shows the message within 5 s. When it does not, the error says what that
 * page was doing: its visibility and focus, its last rows, and the chat's own counters (lastSeq:
 * the newest chat item the page received, so a message that never arrived shows as a lower seq;
 * late: draws the list made from its timer because no animation frame came, render.ts).
 */
export async function sees(page: Page, text: string): Promise<void> {
  try {
    await expect(chatMessage(page, text)).toBeVisible({ timeout: 5_000 });
  } catch (e) {
    const state = await page
      .evaluate(() => ({
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        last: [...document.querySelectorAll('[data-testid=chat-list] li')].slice(-5).map((li) => `${li.className}: ${li.textContent?.slice(0, 60)}`),
        unread: document.querySelector('[data-testid=chat-list]')?.parentElement?.querySelector('.pill')?.textContent ?? null,
        chat: (window as unknown as { __swarmcastChat?: { stats: unknown } }).__swarmcastChat?.stats ?? null,
      }))
      .catch((err: Error) => ({ unavailable: err.message }));
    throw new Error(`${(e as Error).message}\nthe receiving page: ${JSON.stringify(state)}`, { cause: e });
  }
}

/**
 * Proves that `text` never reached `page`: the streamer posts a marker after it, and the chat
 * delivers in order (one batched queue, chat/batcher.ts), so once the page shows the marker it
 * would also show `text`. The streamer's own messages pass every content filter (sendAsStreamer).
 */
export async function neverSees(page: Page, text: string, marker: string): Promise<void> {
  await admin('/api/chat/send', { text: marker });
  await sees(page, marker);
  await expect(chatMessage(page, text)).toHaveCount(0);
}

// ---------------------------------------------------------------------------------------------
// Scripted viewers: a real join and a real /control socket, no browser
// ---------------------------------------------------------------------------------------------

/**
 * Refusals the server answers on one socket before it falls silent: REJECTS_PER_S in
 * chat/hub.ts is a bucket of 2 that refills at 2 a second, so a socket's first two refusals are
 * always answered (a flooding script gets silence). A test that needs more uses another viewer.
 */
export const REJECT_BURST = 2;

/** A viewer that joins like a browser (link → ticket → /api/join, the browser check solved) and holds /control. */
export class ScriptedViewer {
  readonly messages: ServerMessage[] = [];
  /** When the server told this viewer it was kicked (Date.now()), 0 = never. */
  kickedAt = 0;
  private nonce = 0;
  private refusals = 0;

  private constructor(
    readonly nickname: string,
    private readonly ws: WebSocket,
  ) {}

  static async join(nickname: string, link: string): Promise<ScriptedViewer> {
    const base = new URL(link).origin;
    const jar = await joinAs(base, link, nickname);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/control`, { origin: base, headers: { cookie: jar.header() } });
    const viewer = new ScriptedViewer(nickname, ws);
    await new Promise<void>((resolve, reject) => {
      // Before hello an error or a close fails the join; after it, they settle nothing.
      ws.on('error', reject);
      ws.once('close', (code) => reject(new Error(`/control closed (${code}) before hello`)));
      ws.on('message', (d) => {
        const text = String(d);
        if (text.startsWith('~')) return;
        const m = JSON.parse(text) as ServerMessage;
        viewer.messages.push(m);
        if (m.t === 'kicked') viewer.kickedAt = Date.now();
        if (m.t === 'hello') resolve();
      });
    });
    return viewer;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** The chat items this viewer got (batches and resets). */
  items(): ChatItem[] {
    return this.messages.flatMap((m) => (m.t === 'chat.batch' || m.t === 'chat.reset' ? m.items : []));
  }

  /** The latest `chat.you` (mute, colour) the server sent this viewer. */
  you(): ChatYou | undefined {
    return this.messages.filter((m): m is Extract<ServerMessage, { t: 'chat.you' }> => m.t === 'chat.you').at(-1)?.you;
  }

  /** Sends a chat message; returns its nonce. */
  send(text: string): number {
    const n = ++this.nonce;
    // `t` first: the server's cheap pre-parse check expects it.
    this.ws.send(JSON.stringify({ t: 'chat.send', n, text }));
    return n;
  }

  /** The server's answer to a nonce: the ack's seq, or the reject code. */
  async answer(n: number): Promise<{ s?: number; code?: string }> {
    let found: { s?: number; code?: string } | undefined;
    await expect
      .poll(
        () => {
          for (const m of this.messages) {
            if (m.t === 'chat.ack' && m.n === n) found = { s: m.s };
            if (m.t === 'chat.reject' && m.n === n) found = { code: m.code };
          }
          return found !== undefined;
        },
        { message: `answer to nonce ${n}; last messages: ${JSON.stringify(this.messages.slice(-6))}` },
      )
      .toBe(true);
    return found!;
  }

  /** Sends a message the server must refuse and returns the code (at most REJECT_BURST per viewer). */
  async refused(text: string): Promise<string | undefined> {
    if (++this.refusals > REJECT_BURST) throw new Error(`${this.nickname}: more than ${REJECT_BURST} refusals on one socket are not all answered (REJECT_BURST); use another viewer`);
    return (await this.answer(this.send(text))).code;
  }

  close(): void {
    this.ws.terminate();
  }
}

/** The `bots` fixture: scripted viewers, their sockets closed after the test. */
export class Bots {
  private readonly all: ScriptedViewer[] = [];

  /** A scripted viewer joined as `nickname` with the current live link (or `link`). */
  async join(nickname: string, link?: string): Promise<ScriptedViewer> {
    const v = await ScriptedViewer.join(nickname, link ?? (await liveLink()));
    this.all.push(v);
    return v;
  }

  close(): void {
    for (const v of this.all.splice(0)) v.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Changes to the shared server that a fixture puts back
// ---------------------------------------------------------------------------------------------

/** Chat settings for tests where a viewer sends several messages in a row (slow mode and repeats are other tests' subject). */
export const FAST_CHAT = { slowModeS: 0, duplicateWindowS: 0 } as const satisfies Partial<ChatSettings>;

/** The `chat` fixture: the panel's chat API; settings and protection it changed are put back after the test. */
export class ChatControl {
  private original: ChatSettings | null = null;
  private protectChanged = false;

  state(): Promise<AdminChatState> {
    return adminApi<AdminChatState>('GET', '/api/chat');
  }

  /** Changes the chat settings for this test (on top of the current ones). */
  async change(changes: Partial<ChatSettings> | ((s: ChatSettings) => ChatSettings)): Promise<void> {
    const now = (await this.state()).settings;
    this.original ??= structuredClone(now);
    await adminApi('PUT', '/api/chat/settings', typeof changes === 'function' ? changes(structuredClone(now)) : { ...now, ...changes });
  }

  async protect(mode: 'off' | 'slow' | 'lockdown'): Promise<void> {
    this.protectChanged = true;
    await admin('/api/chat/protect', { mode });
  }

  async clear(): Promise<void> {
    await admin('/api/chat/clear');
  }

  async restore(): Promise<void> {
    if (this.original) await adminApi('PUT', '/api/chat/settings', this.original);
    this.original = null;
    // A flood switches protection on by itself, so it is checked whatever the test did.
    if (this.protectChanged || (await this.state()).effective.protect !== 'off') await admin('/api/chat/protect', { mode: 'off' });
    this.protectChanged = false;
  }
}

/**
 * A w × h RGB PNG drawn here (a soft gradient), so the upload carries bytes the test made itself,
 * not a file from disk.
 */
export function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      rows[o + 1 + x * 3] = 20 + ((x * 120) / w) | 0;
      rows[o + 2 + x * 3] = 110 + ((y * 100) / h) | 0;
      rows[o + 3 + x * 3] = 120;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** The `branding` fixture: the streamer's page ("Your page") through the panel API, reset after the test. */
export class BrandingControl {
  private changed = false;

  async save(fields: Record<string, unknown>): Promise<void> {
    this.changed = true;
    await adminApi('PUT', '/api/branding', fields);
  }

  async upload(slot: string, bytes: Buffer, contentType: string): Promise<void> {
    this.changed = true;
    const up = await adminUpload(`/api/branding/image/${slot}`, bytes, contentType);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
  }

  async reset(): Promise<void> {
    await admin('/api/branding/reset');
    this.changed = false;
  }

  /** The panel saved something through its own card (a test against the real routes). */
  markChanged(): void {
    this.changed = true;
  }

  async restore(): Promise<void> {
    if (this.changed) await this.reset();
  }
}

// ---------------------------------------------------------------------------------------------
// The test object every spec imports
// ---------------------------------------------------------------------------------------------

export interface E2EFixtures {
  /** Automatic: the server in its starting state with a healthy stream (streamGate). */
  streamGate: void;
  viewers: Audience;
  bots: Bots;
  chat: ChatControl;
  branding: BrandingControl;
}

export const test = base.extend<E2EFixtures>({
  streamGate: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function uses from its first argument
    async ({}, use, testInfo) => {
      await streamGate(testInfo);
      // DIAG: a test still running after 70 s on Linux CI: every WebKit process's threads (gdb) into RUN_DIR.
      const dumpTimer = process.env.RUN_DIR && process.platform === 'linux' && testInfo.project.name === 'webkit'
        ? setTimeout(() => {
            const out = path.join(process.env.RUN_DIR!, `hang-${Date.now()}.txt`);
            try {
              execSync(`bash scripts/ci/diag-dumpall.sh '${out}' '${testInfo.title.replace(/'/g, '')}'`, { stdio: 'inherit', timeout: 240_000 });
            } catch (e) {
              console.log(`DIAG dump failed: ${String(e)}`);
            }
          }, 70_000)
        : undefined;
      await use();
      clearTimeout(dumpTimer);
    },
    { auto: true },
  ],
  viewers: async ({ browser }, use) => {
    const audience = new Audience(browser);
    await use(audience);
    await audience.close();
  },
  // eslint-disable-next-line no-empty-pattern -- as above
  bots: async ({}, use) => {
    const bots = new Bots();
    await use(bots);
    bots.close();
  },
  // eslint-disable-next-line no-empty-pattern -- as above
  chat: async ({}, use) => {
    const chat = new ChatControl();
    await use(chat);
    await chat.restore();
  },
  // eslint-disable-next-line no-empty-pattern -- as above
  branding: async ({}, use) => {
    const branding = new BrandingControl();
    await use(branding);
    await branding.restore();
  },
});
