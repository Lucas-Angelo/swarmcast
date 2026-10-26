import fs from 'node:fs';
import readline from 'node:readline';
import type { App } from '../app.js';
import { appVersion } from '../core/version.js';
import type { DesktopBridge, ProtocolWriter } from './bridge.js';
import { decodeShellMessage, desktopStateFor, MAX_SHELL_LINE, sameDesktopState, type DesktopClickId, type DesktopStateMessage } from './protocol.js';

/** The viewer count also changes when sessions time out, without a 'state' event (as in the tray). */
const REFRESH_MS = 15_000;

export interface DesktopHandle {
  close(): void;
}

/**
 * `--desktop`: talk to the desktop shell over stdio (docs/DESKTOP.md). Sends `ready` once and
 * `state` on every change; runs the shell's clicks and keeps its update status for the panel.
 * Stdin closing (the shell is gone) quits like `{"type":"quit"}`.
 */
export function startDesktop(
  app: App,
  bridge: DesktopBridge,
  out: ProtocolWriter,
  o: { input?: NodeJS.ReadableStream; onQuit: () => void },
): DesktopHandle {
  const { live, log } = app;
  out.send({ type: 'ready', adminUrl: app.adminLoginUrl, version: appVersion() });
  // Tests only (scripts/test/desktop/verify.mjs): the panel login URL otherwise reaches only the
  // shell. The variable is set by whoever starts the app, i.e. the same user; owner-only file.
  const loginFile = process.env.SWARMCAST_TEST_LOGIN_FILE;
  if (loginFile) {
    fs.writeFileSync(`${loginFile}.tmp`, app.adminLoginUrl, { mode: 0o600 });
    fs.renameSync(`${loginFile}.tmp`, loginFile);
  }

  let last: DesktopStateMessage | null = null;
  const update = (): void => {
    const msg = desktopStateFor(live.phase, live.phase === 'live' ? live.snapshot().stats.viewersConnected : 0);
    if (sameDesktopState(last, msg)) return;
    last = msg;
    out.send(msg);
  };
  live.on('state', update);
  const refresh = setInterval(update, REFRESH_MS);
  refresh.unref();
  update();

  const click = (id: DesktopClickId): void => {
    log.info({ item: id }, 'desktop app click');
    switch (id) {
      case 'start':
        live.start().catch((err: Error) => log.error({ err: err.message }, 'start from the desktop app failed'));
        break;
      case 'stop':
        live.stop().catch((err: Error) => log.error({ err: err.message }, 'stop from the desktop app failed'));
        break;
      case 'quit':
        o.onQuit();
        break;
    }
  };

  // Tray "Export logs…": same anonymised ZIP as the panel button; the shell reveals the file.
  const exportLogs = (): void => {
    app.diagnostics.exportLogs().then(
      (r) => out.send({ type: 'export-logs', ok: true, path: r.path }),
      (err: Error) => {
        log.warn({ err: err.message }, 'log export from the desktop app failed');
        out.send({ type: 'export-logs', ok: false, error: err.message });
      },
    );
  };

  const input = o.input ?? process.stdin;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = decodeShellMessage(line);
    if (!msg) {
      log.warn({ line: line.slice(0, 200), length: line.length > MAX_SHELL_LINE ? line.length : undefined }, 'desktop app: unexpected message');
      return;
    }
    if (msg.type === 'click') click(msg.id);
    else if (msg.type === 'quit') o.onQuit();
    else if (msg.type === 'export-logs') exportLogs();
    else bridge.setUpdate(msg.update);
  });
  let closed = false;
  rl.on('close', () => {
    if (closed) return;
    log.info('desktop app closed our input; stopping everything');
    o.onQuit();
  });
  input.on('error', () => {});

  return {
    close: () => {
      if (closed) return;
      closed = true;
      live.off('state', update);
      clearInterval(refresh);
      rl.close();
    },
  };
}
