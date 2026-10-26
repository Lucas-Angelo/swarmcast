import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { LivePhase } from '@swarmcast/shared';
import type { App } from '../app.js';
import { openBrowser } from '../core/notify.js';
import { exe } from '../core/paths.js';

/**
 * Tray / menu bar icon.
 *
 * The icon itself is drawn by `swarmcast-tray`, a tiny Go helper (apps/tray) shipped next to
 * MediaMTX and cloudflared in binDir. We talk to it with JSON lines over its stdin/stdout;
 * it exits by itself when its stdin closes, so it never outlives SwarmCast. If the helper is
 * missing or keeps failing (e.g. a Linux desktop without a tray host), SwarmCast just runs
 * with the browser panel only.
 */
export interface TrayHandle {
  update(): void;
  close(): void;
}

// ---- protocol (pure, unit-tested) ----

export type TrayIconState = 'off' | 'waiting' | 'live';

export interface TrayStateMessage {
  type: 'state';
  state: TrayIconState;
  tooltip: string;
  canStart: boolean;
  canStop: boolean;
}

/** Messages SwarmCast sends to the helper. */
export type TrayCommand = TrayStateMessage | { type: 'quit' };

export const TRAY_CLICK_IDS = ['open', 'start', 'stop', 'quit'] as const;
export type TrayClickId = (typeof TRAY_CLICK_IDS)[number];

/** Messages the helper sends to SwarmCast. */
export type TrayEvent = { type: 'ready' } | { type: 'click'; id: TrayClickId };

/** What the icon shows for a live phase. */
export function trayStateFor(phase: LivePhase, viewersConnected: number): TrayStateMessage {
  const controls = { canStart: phase === 'off', canStop: phase !== 'off' };
  switch (phase) {
    case 'off':
      return { type: 'state', state: 'off', tooltip: 'SwarmCast: off', ...controls };
    case 'live': {
      const n = Math.max(0, Math.floor(viewersConnected));
      return { type: 'state', state: 'live', tooltip: `SwarmCast: live · ${n} ${n === 1 ? 'viewer' : 'viewers'}`, ...controls };
    }
    case 'stopping':
      return { type: 'state', state: 'waiting', tooltip: 'SwarmCast: stopping…', ...controls };
    case 'starting':
    case 'waiting-obs':
    default:
      return { type: 'state', state: 'waiting', tooltip: 'SwarmCast: waiting for OBS', ...controls };
  }
}

export function sameTrayState(a: TrayStateMessage | null, b: TrayStateMessage): boolean {
  return !!a && a.state === b.state && a.tooltip === b.tooltip && a.canStart === b.canStart && a.canStop === b.canStop;
}

/** One JSON line for the helper's stdin. */
export function encodeTrayCommand(cmd: TrayCommand): string {
  return `${JSON.stringify(cmd)}\n`;
}

/** Parse one line of the helper's stdout; anything unexpected yields null. */
export function decodeTrayEvent(line: string): TrayEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const { type, id } = msg as { type?: unknown; id?: unknown };
  if (type === 'ready') return { type: 'ready' };
  if (type === 'click' && typeof id === 'string' && (TRAY_CLICK_IDS as readonly string[]).includes(id)) {
    return { type: 'click', id: id as TrayClickId };
  }
  return null;
}

// ---- helper process ----

/** Crashes are not retried in a loop: one restart, then panel only. */
const MAX_RESTARTS = 1;
const RESTART_DELAY_MS = 1000;
/** After asking the helper to quit, kill it if it is still there after this long. */
const QUIT_GRACE_MS = 1500;
/** The viewer count also changes when sessions time out, without a 'state' event. */
const REFRESH_MS = 15_000;

class TrayHelper {
  private proc: ChildProcess | null = null;
  private ready = false;
  private lastSent: TrayStateMessage | null = null;
  private restarts = 0;
  private closed = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly binary: string,
    private readonly app: App,
  ) {}

  start(): void {
    const { log, reaper } = this.app;
    const proc = spawn(this.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: own process group, so Ctrl+C in the terminal reaches SwarmCast (which shuts
      // down in order) but not the helper.
      detached: process.platform !== 'win32',
    });
    this.proc = proc;
    this.ready = false;
    this.lastSent = null;
    const pid = proc.pid;
    if (pid) reaper?.register(pid);

    let gone = false;
    const onGone = (reason: Record<string, unknown>): void => {
      if (gone) return;
      gone = true;
      if (pid) reaper?.unregister(pid);
      if (this.proc === proc) {
        this.proc = null;
        this.ready = false;
      }
      if (this.closed) return;
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        log.warn(reason, 'tray helper exited, restarting it once');
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.closed) this.start();
        }, RESTART_DELAY_MS);
        this.restartTimer.unref();
      } else {
        log.warn(reason, 'tray helper exited again, continuing without tray (panel only)');
      }
    };
    proc.once('error', (err) => onGone({ err: err.message }));
    proc.once('exit', (code, signal) => onGone({ code, signal }));
    // A write after the helper died must not crash SwarmCast; 'exit' handles the rest.
    proc.stdin?.on('error', () => {});

    if (proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        const event = decodeTrayEvent(line);
        if (!event) {
          log.debug({ line }, 'tray helper: unexpected output');
        } else if (event.type === 'ready') {
          this.ready = true;
          log.info('tray icon ready');
          this.update();
        } else {
          this.onClick(event.id);
        }
      });
    }
    if (proc.stderr) {
      readline.createInterface({ input: proc.stderr }).on('line', (line) => log.warn({ line }, 'tray helper stderr'));
    }
  }

  update(): void {
    if (!this.proc || !this.ready) return;
    const { live } = this.app;
    const viewers = live.phase === 'live' ? live.snapshot().stats.viewersConnected : 0;
    const msg = trayStateFor(live.phase, viewers);
    if (sameTrayState(this.lastSent, msg)) return;
    this.lastSent = msg;
    this.send(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    if (!proc) return;
    // Let the helper remove its icon cleanly (on Windows a killed process leaves a ghost icon).
    this.send({ type: 'quit' });
    proc.stdin?.end();
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, QUIT_GRACE_MS).unref();
  }

  private send(cmd: TrayCommand): void {
    const stdin = this.proc?.stdin;
    if (stdin?.writable) stdin.write(encodeTrayCommand(cmd));
  }

  private onClick(id: TrayClickId): void {
    const { app } = this;
    app.log.info({ item: id }, 'tray menu click');
    switch (id) {
      case 'open':
        openBrowser(app.adminLoginUrl);
        break;
      case 'start':
        app.live.start().catch((err: Error) => app.log.error({ err: err.message }, 'start from the tray failed'));
        break;
      case 'stop':
        app.live.stop().catch((err: Error) => app.log.error({ err: err.message }, 'stop from the tray failed'));
        break;
      case 'quit':
        // main.ts handles SIGTERM: stop everything, then exit.
        process.emit('SIGTERM');
        break;
    }
  }
}

export function startTray(app: App): TrayHandle | null {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.DBUS_SESSION_BUS_ADDRESS) {
    app.log.info('no desktop session, running without a tray icon (panel only)');
    return null;
  }
  const binary = path.join(app.paths.binDir, exe('swarmcast-tray'));
  if (!fs.existsSync(binary)) {
    app.log.info({ binary }, 'tray helper not found, panel only');
    return null;
  }
  const helper = new TrayHelper(binary, app);
  const update = (): void => helper.update();
  app.live.on('state', update);
  const refresh = setInterval(update, REFRESH_MS);
  refresh.unref();
  helper.start();

  let closed = false;
  const handle: TrayHandle = {
    update,
    close: () => {
      if (closed) return;
      closed = true;
      app.live.off('state', update);
      clearInterval(refresh);
      helper.close();
    },
  };
  // Remove the icon as soon as SwarmCast starts shutting down, whichever path triggers it
  // (tray Quit, panel Quit, Ctrl+C, fatal error). Without this the reaper would SIGKILL the
  // helper at the end of app.close().
  const appClose = app.close;
  app.close = () => {
    handle.close();
    return appClose();
  };
  return handle;
}
