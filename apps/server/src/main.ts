import { createApp, type App } from './app.js';
import { openBrowser } from './core/notify.js';
import { isAlive, runReaper } from './process/children.js';
import { appVersion } from './core/version.js';
import { startTray } from './tray/tray.js';
import { isListening } from './core/ports.js';
import { runCleanupCommand } from './direct/cleanup.js';
import { Autostart } from './desktop/autostart.js';
import { createProtocolWriter, DesktopBridge, type ProtocolWriter } from './desktop/bridge.js';
import { startDesktop } from './desktop/desktop.js';
import { runDesktopFirstRun } from './desktop/first-run.js';
import { fatalCodeOf } from './desktop/protocol.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** One-shot modes (smoke test) never need the parent watch. */
function smokeOrTool(): boolean {
  return flag('smoke-test');
}

async function main(): Promise<void> {
  if (flag('reaper')) {
    runReaper(Number(value('reaper')));
    return;
  }
  // Used by the uninstallers: remove a router port left open by a crash, then exit.
  if (flag('cleanup')) {
    process.exit(await runCleanupCommand(value('data-dir')));
  }
  if (flag('version')) {
    console.log(appVersion());
    return;
  }
  if (flag('help')) {
    console.log(`SwarmCast ${appVersion()}
Usage: swarmcast [options]
  --no-tunnel      Do not open the public tunnel (local testing / CI)
  --no-open        Do not open the panel in the browser
  --no-tray        Do not show the tray / menu bar icon
  --no-autostart   Do not start the stream automatically
  --desktop        Run inside the SwarmCast desktop app (JSON lines on stdin/stdout; implies
                   --no-open and --no-tray; quits when stdin closes). See docs/DESKTOP.md
  --smoke-test     Start everything (no tunnel), verify, stop, exit
  --cleanup        Remove a router port left open by a crash (used by the uninstaller), exit
  --data-dir DIR   Use DIR for config, secrets and logs
  --version        Print the version`);
    return;
  }

  const smoke = flag('smoke-test');
  // Desktop app (docs/DESKTOP.md): protocol lines on stdout, commands on stdin.
  const desktop = flag('desktop') && !smoke;
  let out: ProtocolWriter | null = null;
  let bridge: DesktopBridge | undefined;
  if (desktop) {
    out = createProtocolWriter(process.stdout);
    const exe = process.env.SWARMCAST_DESKTOP_EXE;
    bridge = new DesktopBridge({
      version: process.env.SWARMCAST_DESKTOP_VERSION || appVersion(),
      serverVersion: appVersion(),
      autostart: new Autostart({ exe: exe ? exe : undefined }),
      send: (msg) => out!.send(msg),
    });
  }
  let app: App;
  try {
    app = await createApp({ dataDir: value('data-dir'), noTunnel: flag('no-tunnel') || smoke, desktop: bridge });
  } catch (err) {
    console.error(`\n✗ ${(err as Error).message}\n`);
    if (out) {
      out.send({ type: 'fatal', code: fatalCodeOf(err), message: (err as Error).message });
      await out.flush();
    }
    process.exit(1);
  }

  let exiting = false;
  const exit = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.log('\nStopping everything…');
    // Safety net: if something hangs, exit anyway (children are already stopped or reaped).
    setTimeout(() => process.exit(code), 30_000).unref();
    await app.close();
    console.log('✓ Off: nothing on your computer is reachable.');
    // Pipes can be asynchronous (macOS): let the last lines (state "off") reach the shell.
    await out?.flush();
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(sig, () => void exit(0));
  }
  // Closing the window that started SwarmCast must stop everything. Windows Terminal (the
  // default console on Windows 11) closes the tab without telling child processes, and on any
  // OS the launcher can be killed abruptly: when the process that started us is gone, shut
  // down cleanly. SWARMCAST_NO_PARENT_WATCH=1 disables it (e.g. when started detached on purpose).
  const parent = process.ppid;
  if (parent > 1 && process.env.SWARMCAST_NO_PARENT_WATCH !== '1' && !smokeOrTool()) {
    const watch = setInterval(() => {
      if (!isAlive(parent)) {
        clearInterval(watch);
        app.log.info({ parent }, 'the window that started SwarmCast was closed; stopping everything');
        void exit(0);
      }
    }, 1500);
    watch.unref();
  }
  process.on('uncaughtException', (err) => {
    // A closed stdout/stderr (EPIPE) is not a reason to stop the live.
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
    app.log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    void exit(1);
  });
  process.on('unhandledRejection', (err) => {
    app.log.error({ err: (err as Error)?.message ?? String(err) }, 'unhandled rejection');
  });

  if (smoke) {
    await runSmokeTest(app);
    return;
  }

  if (bridge && out) {
    // The shell opens the panel in its window and draws the tray icon itself.
    startDesktop(app, bridge, out, { onQuit: () => void exit(0) });
    // The per-run panel token and the live link stay out of the shell's log file.
    console.log(`\nSwarmCast ${appVersion()} (desktop app)`);
    console.log(`Panel: ${app.adminUrl}\n`);
    app.live.scheduleSpeedTests();
    void runDesktopFirstRun(app, bridge).catch((err: Error) => app.log.warn({ err: err.message }, 'desktop first run failed'));
    if (!flag('no-autostart')) {
      app.live.start().catch((err: Error) => console.error(`\n✗ Could not start: ${err.message}\n`));
    }
    return;
  }

  const tray = flag('no-tray') ? null : startTray(app);
  // SWARMCAST_NO_OPEN=1: automated tests run the real installer without popping up a browser.
  if (!flag('no-open') && process.env.SWARMCAST_NO_OPEN !== '1') openBrowser(app.adminLoginUrl);
  console.log(`\nSwarmCast ${appVersion()}`);
  console.log(`Panel: ${app.adminLoginUrl}`);
  console.log('(If the panel did not open by itself, copy the address above into your browser.)');
  console.log('Keep this window open while you stream. Press Ctrl+C (or close it) to stop everything.\n');

  let printed = '';
  const printLink = (): void => {
    const s = app.live.snapshot();
    if (s.liveLink && s.liveLink !== printed) {
      printed = s.liveLink;
      console.log('────────────────────────────────────────────────────────────');
      console.log(`OBS → Settings → Stream → Service "Custom..."`);
      console.log(`  Server:     ${s.rtmpUrl}`);
      console.log(`  Stream key: (copy it from the panel)`);
      console.log(`Live link to send to your subscribers:\n  ${s.liveLink}`);
      console.log('────────────────────────────────────────────────────────────\n');
    }
  };
  app.live.on('state', printLink);
  tray?.update();

  app.live.scheduleSpeedTests();
  if (!flag('no-autostart')) {
    app.live.start().catch((err: Error) => console.error(`\n✗ Could not start: ${err.message}\n`));
  }
}

async function runSmokeTest(app: App): Promise<void> {
  const fail = async (msg: string): Promise<never> => {
    console.error(`✗ smoke test: ${msg}`);
    await app.close();
    process.exit(1);
  };
  try {
    await app.live.start();
  } catch (err) {
    await fail((err as Error).message);
  }
  const res = await fetch(`http://127.0.0.1:${app.config.ports.public}/healthz`).catch(() => null);
  if (!res?.ok) await fail('public server did not answer');
  if (!(await isListening(app.config.ports.rtmp))) await fail('RTMP port is not listening');
  const verified = await app.live.stop();
  if (!verified) await fail(`stop verification failed: ${app.live.steps.map((s) => `${s.id}=${s.status}${s.error ? `(${s.error})` : ''}`).join(', ')}`);
  console.log('✓ smoke test passed');
  await app.close();
  process.exit(0);
}

void main();
