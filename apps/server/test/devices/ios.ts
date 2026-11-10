// Mobile Safari on an iOS Simulator, through Apple's safaridriver (W3C WebDriver; `man
// safaridriver`: platformName iOS, safari:useSimulator, safari:deviceUDID). Taps are W3C touch
// actions, rotation is the simulator's (devicectl on Xcode 27+, Simulator.app's Rotate menu on
// Xcode 26). No "background": the session ends when Safari leaves the screen (IosPhone.background).
//
// Where it runs: Xcode 26 on macOS 26 (GitHub's macos-26 image, .github/workflows/devices.yml).
// On macOS 27 with Xcode 27, safaridriver finds no simulator for iOS 18 and later runtimes:
// they are cryptex images mounted under /private/var/run/com.apple.security.cryptexd, which
// the sandbox of safaridriver's HTTP service (WebDriver.framework) cannot read, so the
// simulator's OS version stays "(unknown)" and no session host matches (log: "Created
// Simulator target ... productVersion = (unknown)", then "Could not find any session hosts").
// Classic iOS 17 disk images still work there. docs/TESTING.md "Real devices" has the details.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { allocPorts } from '../../../../scripts/test/lib/ports.mjs';
import { spawnTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { expect } from '../e2e/fixtures.js';
import { actionablePoint, armTap, tapEndsInClick, touchState, type TouchState } from './actionability.js';
import { CALM_WINDOW_MS, measuredWindow, untilCalm, type Load } from './calm.js';
import type { Orientation, Phone } from './phone.js';
import { ready, Session, tapActions } from './webdriver.js';

const run = promisify(execFile);

/** scripts/test/devices/setup.sh install ios (and devices.yml) create it. */
const SIMULATOR_NAME = 'SwarmCast iPhone';
const SAFARI = 'com.apple.mobilesafari';
/**
 * Web Inspector and remote automation switches inside the simulator. Apple says simulators need
 * none since iOS 14, but a new simulator answered safaridriver only with a timeout waiting for
 * Safari until they were set and the simulator restarted (aletheia-works/formicarium#129).
 */
const AUTOMATION_KEYS = [
  ['com.apple.webinspectord', 'RemoteInspectorEnabled'],
  ['com.apple.webinspectord', 'RemoteAutomationEnabled'],
  ['com.apple.webinspectord', 'WIRRemoteAutomationEnabled'],
  ['com.apple.mobilesafari', 'WebKitDeveloperExtrasEnabledPreferenceKey'],
  ['com.apple.mobilesafari', 'WebInspectorEnabled'],
  ['com.apple.mobilesafari', 'RemoteAutomationEnabled'],
  ['com.apple.mobilesafari', 'WebKitRemoteAutomationEnabled'],
] as const;

/**
 * Safari's tips (TipKit) off: TipKit's own switch, the defaults key of its launch argument
 * `-com.apple.TipKit.HideAllTips 1`, read as Safari starts. A new simulator's Safari shows its
 * "More" button tip once, over the first page, a few seconds after it has loaded, and it stays
 * up until the next tap. A tap while it was still coming up (1.1 s after "viewDidAppear", its view
 * drawn for the first time meanwhile) went to the popover, which closed: the page got no touch
 * and no click at all (release-rehearsal pipeline 42399897758, the first test of the iOS job).
 * Taps 2.5 s or more after it appeared reached the page and closed it. Measured side by side
 * (Devices run 42403184245): the tip came up in both simulators without the key and in none of
 * the two with it. IosDevice.tipsShown checks after each test that none came up.
 */
const SAFARI_TIPS_OFF = ['com.apple.mobilesafari', 'com.apple.TipKit.HideAllTips'] as const;

/** Every defaults key the simulator needs set (true), checked at each attach. */
const SIMULATOR_KEYS = [...AUTOMATION_KEYS, SAFARI_TIPS_OFF] as const;

/**
 * Launchd jobs of the simulator a page in Safari never needs, turned off (unusedJobsOff). With them
 * the 3-core CI Mac stayed saturated through the whole run (load average 300 to 550, 3 % idle,
 * Devices run 41544831758), where a tap reached the element and no click followed (runs
 * 41184587941, 41190536745, 41518563555). apsd, the push daemon, retried the development push
 * server in a loop and logged 1,400 to 2,300 lines a second; each one went through the simulator's
 * diagnosticd and on to the Mac's (their .sim_diagnosticd_socket relay), and apsd and the two
 * diagnosticd took 78 % of the Mac's 300 %. identityservicesd and StatusKitAgent are apsd's
 * clients; the rest are the Health, Fitness, Reminders, Siri and photo-analysis daemons and
 * chronod, which keeps relaunching the home screen's widget extensions (100 to 360 MB each).
 * siriactionsd, the Shortcuts daemon, schedules a ToolKit index of every app's actions a few
 * seconds after a simulator's first long boot (the dasd activity
 * "com.apple.siriactionsd.toolkit.high-prio-deferred-delta-index"); about a minute later it runs
 * in siriactionsd's XPC service BackgroundShortcutRunner for 80 s, 26 s of CPU (Devices run
 * 42519281087), the most of any process but the log relay. In CI that was the first test's time:
 * at 76 to 118 % CPU with the Mac 0 % idle, the first tap's finger stayed down 1.3 s and iOS took
 * it for a long press (run 42515339177). scripts/test/devices/setup.sh turns the same jobs off.
 */
const UNUSED_JOBS = [
  'com.apple.apsd',
  'com.apple.identityservicesd',
  'com.apple.StatusKitAgent',
  'com.apple.remindd',
  'com.apple.healthd',
  'com.apple.fitcore',
  'com.apple.fitnessintelligenced',
  'com.apple.finhealthd',
  'com.apple.assistantd',
  'com.apple.mediaanalysisd',
  'com.apple.chronod',
  'com.apple.siriactionsd',
] as const;

async function simctl(args: readonly string[]): Promise<string> {
  return (await run('xcrun', ['simctl', ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

/** Which of UNUSED_JOBS run now (launchctl list: a PID, then the label). */
async function unusedJobsRunning(udid: string): Promise<string[]> {
  const list = (await simctl(['spawn', udid, 'launchctl', 'list'])).split('\n');
  return UNUSED_JOBS.filter((job) => list.some((line) => /^\d+\t/.test(line) && line.endsWith(`\t${job}`)));
}

/**
 * Turns UNUSED_JOBS off in the booted simulator: `launchctl disable` (kept in the simulator's
 * data, so later boots start without them) and `bootout` for those running. They live in the
 * simulator's user domain, which `simctl boot --disabledJob` does not reach: booted with it, all
 * of them ran (Devices run 41546937424); disabled, they stayed off after a reboot (run 41550242580).
 * Returns what was running.
 */
async function unusedJobsOff(udid: string): Promise<string[]> {
  const running = await unusedJobsRunning(udid);
  for (const job of UNUSED_JOBS) await simctl(['spawn', udid, 'launchctl', 'disable', `user/foreground/${job}`]);
  for (const job of running) {
    // Exit status 3 (No such process): the job ended by itself since the list.
    await simctl(['spawn', udid, 'launchctl', 'bootout', `user/foreground/${job}`]).catch((e: Error & { code?: unknown }) => {
      if (e.code !== 3) throw e;
    });
  }
  return running;
}

async function findSimulator(): Promise<SimDevice> {
  const list = JSON.parse(await simctl(['list', 'devices', '--json'])) as { devices: Record<string, SimDevice[]> };
  const all = Object.values(list.devices).flat();
  const wanted = process.env.IOS_SIMULATOR_UDID;
  const found = wanted ? all.find((d) => d.udid === wanted) : all.find((d) => d.name === SIMULATOR_NAME && d.isAvailable);
  if (!found) throw new Error(wanted ? `no simulator ${wanted}` : `no simulator named "${SIMULATOR_NAME}": run scripts/test/devices/setup.sh install ios (or set IOS_SIMULATOR_UDID)`);
  return found;
}

/** Runs AppleScript lines in osascript; returns what the script returns. */
async function osascript(lines: readonly string[]): Promise<string> {
  return (await run('osascript', lines.flatMap((l) => ['-e', l]))).stdout.trim();
}

/** Simulator.app's I/O > Keyboard menu, for System Events. */
const KEYBOARD_MENU = 'menu 1 of menu item "Keyboard" of menu "I/O" of menu bar 1';

/**
 * Whether Simulator.app connects the Mac's keyboard to the simulator it shows (I/O > Keyboard >
 * Connect Hardware Keyboard, ticked), read from the menu item's check mark.
 */
async function hardwareKeyboardConnected(): Promise<boolean> {
  const mark = await osascript([
    'tell application "System Events" to tell process "Simulator"',
    `set m to value of attribute "AXMenuItemMarkChar" of (first menu item of ${KEYBOARD_MENU} whose name contains "Hardware Keyboard")`,
    'if m is missing value then return "off"',
    'return "on"',
    'end tell',
  ]);
  return mark === 'on';
}

/**
 * Starts the simulator's Web Inspector daemon and waits until Safari has connected to it, before
 * any WebDriver session. launchd starts webinspectord only when something connects to its socket
 * (RWI_LISTEN_SOCKET, on the Mac's side); left to the first session, it took 16 s to come up on a
 * just-booted simulator, Safari connected to it then, and the Mac's side connected 25 s later still,
 * after safaridriver had given up ("timed out ... waiting for its RWIApplication to appear", the
 * first test of Devices runs 41171340670 and 41188080970; the simulator's log of the second).
 */
async function webInspectorReady(udid: string): Promise<net.Socket | null> {
  const running = async () => /"PID"\s*=/.test(await simctl(['spawn', udid, 'launchctl', 'list', 'com.apple.webinspectord']).catch(() => ''));
  // Already up (a simulator booted and used before the suite): Safari connected to it when it came up.
  if (await running()) return null;
  // Safari's connection logged from now on (the log keeps earlier boots' lines).
  const since = new Date(Date.now() - 1_000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '+0000');
  const socketPath = await simctl(['getenv', udid, 'RWI_LISTEN_SOCKET']);
  // Kept open until release(): closed at once, it let webinspectord exit again and launchd start a
  // new one for the first session, as slowly (Devices run 41233270465: launched 19:26:31, Safari
  // connected, the probe closed, a new webinspectord launched 19:26:46 while the session waited).
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const c = net.createConnection(socketPath, () => resolve(c));
    c.once('error', reject);
  });
  socket.on('error', () => {});
  await until(running, { timeoutMs: 60_000, what: 'webinspectord running in the simulator' });
  await until(
    async () =>
      (
        await simctl(['spawn', udid, 'log', 'show', '--start', since, '--style', 'compact', '--predicate', 'process == "webinspectord" AND eventMessage CONTAINS "Application Connected" AND eventMessage CONTAINS "com.apple.mobilesafari"']).catch(
          () => '',
        )
      ).includes('com.apple.mobilesafari'),
    { timeoutMs: 60_000, what: "Safari connected to the simulator's Web Inspector", pollMs: 2_000 },
  );
  return socket;
}

/** Simulator.app showing this simulator (its Device menu acts on the window), once its window is up. */
async function openSimulatorApp(udid: string): Promise<void> {
  await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid]);
  let state = '';
  await until(
    async () => {
      state = `${await simulatorAppWindows()} windows, ${(await simulatorAppRunning()) ? 'running' : 'not running'}`;
      return (await simulatorAppWindows()) > 0;
    },
    { timeoutMs: 60_000, what: "Simulator.app's window", detail: () => state },
  );
}

async function simulatorAppRunning(): Promise<boolean> {
  return run('pgrep', ['-x', 'Simulator']).then(
    () => true,
    () => false,
  );
}

/**
 * Quits Simulator.app while no simulator runs, so that the next open() starts it afresh with this
 * simulator. A Simulator.app left running and hidden from the previous worker's simulator (which
 * shut down) once showed no window for the next boot, for good: open() hands a running app no
 * arguments (Devices run 42694261030, the fourth boot of a job, and every boot after it).
 */
async function quitSimulatorApp(): Promise<void> {
  if (!(await simulatorAppRunning())) return;
  // A signal, not AppleScript's quit: hidden and windowless, Simulator.app took the quit event and
  // went on running (Devices run 42708098423).
  await run('pkill', ['-TERM', '-x', 'Simulator']).catch(() => {});
  const processes = () => run('ps', ['-axo', 'pid,stat,lstart,comm']).then((r) => r.stdout.split('\n').filter((l) => /\/Simulator(\.app|$)/.test(l)).join('; ') || 'none', (e: Error) => e.message);
  let seen = '';
  await until(
    async () => {
      seen = await processes();
      return !(await simulatorAppRunning());
    },
    { timeoutMs: 30_000, what: 'Simulator.app to quit', detail: () => seen },
  );
}

async function simulatorAppWindows(): Promise<number> {
  return Number((await run('osascript', ['-e', 'tell application "System Events" to count windows of process "Simulator"']).catch(() => ({ stdout: '0' }))).stdout.trim());
}

/**
 * Hides Simulator.app (its window then no longer draws the simulator's screen). Not quit: quitting
 * it shut the simulator down (Devices run 41237131465: "Current state: Shutdown").
 */
async function hideSimulatorApp(): Promise<void> {
  await run('osascript', ['-e', 'tell application "System Events" to set visible of process "Simulator" to false']);
}

/**
 * The most of one Mac core the simulator's processes may use together for the phone to count as
 * calm (calm.ts): Safari on a blank page, the system idle. A first boot's own work, a daemon in a
 * burst (siriactionsd's index of every app's actions: 76 to 118 % for 80 s, Devices run
 * 42519281087) or the previous test's page still closing is above it.
 */
const SIMULATOR_CALM_CORES = 0.5;
/** How long the phone may take to become calm: after a new simulator's first boot, then before each test. */
const CALM_AFTER_BOOT_MS = 300_000;
const CALM_BEFORE_TEST_MS = 120_000;

/** Seconds of CPU from `ps -o time` ("[[dd-]hh:]mm:ss.ss"). */
function cpuSeconds(time: string): number {
  const [days, rest] = time.includes('-') ? time.split('-') : ['0', time];
  return (rest ?? '').split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86_400;
}

/**
 * The CPU seconds each process of the iOS Simulator has used so far, by pid, with its name: every
 * process whose executable lies under a CoreSimulator folder (the runtime's root under
 * CoreSimulator/Volumes, the apps in the device's data). One simulator runs on the CI Mac.
 */
async function simulatorCpu(): Promise<Map<number, { name: string; cpu: number }>> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,time=,comm='], { maxBuffer: 16 * 1024 * 1024 });
  const found = new Map<number, { name: string; cpu: number }>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !m[3]!.includes('/CoreSimulator/')) continue;
    found.set(Number(m[1]), { name: path.basename(m[3]!), cpu: cpuSeconds(m[2]!) });
  }
  return found;
}

/** The simulator's load over one measured window (CALM_WINDOW_MS): the cores its processes used, and the three busiest. */
async function simulatorLoad(): Promise<Load> {
  const before = await simulatorCpu();
  const started = Date.now();
  await measuredWindow(CALM_WINDOW_MS);
  const after = await simulatorCpu();
  const seconds = (Date.now() - started) / 1000;
  const used = [...after].map(([pid, p]) => ({ name: p.name, cores: (p.cpu - (before.get(pid)?.cpu ?? 0)) / seconds })).sort((a, b) => b.cores - a.cores);
  const busiest = used.slice(0, 3).map((p) => `${p.name} ${Math.round(p.cores * 100)} %`);
  return { cores: used.reduce((sum, p) => sum + p.cores, 0), busiest: busiest.join(', ') };
}

/** How this Xcode turns a simulator:`xcrun devicectl device orientation` (Xcode 27+) or Simulator.app's Device menu. */
type Rotator = 'devicectl' | 'simulator-app';

export class IosDevice {
  /** Where the last rotation left the simulator (Simulator.app's menu turns by 90 degrees). */
  private turned: Orientation = 'portrait';

  private constructor(
    readonly udid: string,
    private readonly driver: Tracked,
    private readonly base: URL,
    private readonly rotator: Rotator,
    /** Booted by the suite: shut down again in release(). */
    private readonly booted: boolean,
    private readonly logDir: string,
    /** The connection that keeps the simulator's webinspectord running (webInspectorReady). */
    private readonly inspector: net.Socket | null,
    /** `top` writing the Mac's load (simulator processes included) to host-load.log every 2 s. */
    private readonly sampler: ChildProcess,
  ) {}

  static async attach(o: { logDir: string }): Promise<IosDevice> {
    // Each step with its time, so a slow or failed first session can be laid against them.
    const note = (step: string) => fs.appendFileSync(path.join(o.logDir, 'device.log'), `${new Date().toISOString()} ${step}\n`);
    // The Mac's load through the run (CPU, memory, swap, the busiest processes), to lay a slow tap against.
    const loadLog = fs.openSync(path.join(o.logDir, 'host-load.log'), 'a');
    const sampler = spawn('top', ['-l', '0', '-s', '2', '-o', 'cpu', '-n', '15', '-stats', 'pid,command,cpu,mem,state,threads'], { stdio: ['ignore', loadLog, loadLog] });
    fs.closeSync(loadLog);
    const sim = await findSimulator();
    note(`simulator ${sim.udid} (${sim.state})`);
    let booted = false;
    let driver: Tracked | null = null;
    let inspector: net.Socket | null = null;
    try {
      if (sim.state !== 'Booted') {
        await quitSimulatorApp();
        await simctl(['boot', sim.udid]);
        booted = true;
      }
      await simctl(['bootstatus', sim.udid, '-b']);
      note('booted');
      const missing: string[] = [];
      for (const [domain, key] of SIMULATOR_KEYS) {
        const value = await simctl(['spawn', sim.udid, 'defaults', 'read', domain, key]).catch(() => '');
        if (value !== '1') missing.push(`${domain} ${key}`);
      }
      if (missing.length > 0) {
        for (const [domain, key] of SIMULATOR_KEYS) await simctl(['spawn', sim.udid, 'defaults', 'write', domain, key, '-bool', 'true']);
        // webinspectord and Safari read them at start.
        await simctl(['shutdown', sim.udid]);
        await simctl(['boot', sim.udid]);
        await simctl(['bootstatus', sim.udid, '-b']);
        booted = true;
        note(`automation settings written (${missing.join(', ')}), rebooted`);
      }
      const stopped = await unusedJobsOff(sim.udid);
      const left = await unusedJobsRunning(sim.udid);
      note(`unused jobs off (stopped: ${stopped.join(', ') || 'none'}; running still: ${left.join(', ') || 'none'})`);
      // Safari running before the first session gives the Web Inspector an application to list
      // (without it a new simulator answered safaridriver with a timeout: the same source).
      await simctl(['launch', sim.udid, SAFARI]);
      note('Safari launched');
      const rotator: Rotator = await run('xcrun', ['devicectl', 'device', 'orientation', 'get', '--device', sim.udid]).then(
        () => 'devicectl',
        () => 'simulator-app',
      );
      if (rotator === 'simulator-app') {
        // Opened here, where its first start (up to two minutes on CI) has the fixture's time, and
        // hidden: rotate() shows it only to turn the phone.
        await openSimulatorApp(sim.udid);
        await hideSimulatorApp();
        note('Simulator.app started and hidden');
      }
      inspector = await webInspectorReady(sim.udid);
      note('Web Inspector up, Safari connected to it');
      const [port] = await allocPorts(1);
      driver = spawnTracked('safaridriver', ['-p', String(port), '--diagnose'], { name: 'safaridriver', logFile: path.join(o.logDir, 'safaridriver.log') });
      const base = new URL(`http://127.0.0.1:${port}`);
      await until(() => ready(base), { timeoutMs: 30_000, what: 'safaridriver to answer /status', abortOn: [driver] });
      note('safaridriver ready');
      const device = new IosDevice(sim.udid, driver, base, rotator, booted, o.logDir, inspector, sampler);
      await device.textFieldOnce();
      // The first boot's own work (indexes, caches, daemons starting, the text field's) done before the first test.
      await device.calm('after the boot', CALM_AFTER_BOOT_MS);
      return device;
    } catch (e) {
      // Left as it was found: a simulator this attach booted is shut down again, so the next
      // worker's attach starts from a shut-down simulator, not from this one's half-done setup.
      note(`attach failed: ${(e as Error).message.split('\n')[0]}`);
      await driver?.stop({ graceMs: 5_000 });
      inspector?.destroy();
      if (booted) await simctl(['shutdown', sim.udid]).catch(() => {});
      sampler.kill();
      throw e;
    }
  }

  get orientation(): Orientation {
    return this.turned;
  }

  /**
   * Focuses a text field once after the boot, in a session of its own, as Android's keyboardOnce
   * brings its keyboard up once. A simulator's first text field after a boot sets kbd (the
   * keyboard daemon) to work, with the Mac reading its runtime image (diskimagesiod): in Devices
   * run 42715017924 kbd ran at 9 to 23 % right after each of a job's boots, as the first test's
   * join page focused its nickname field and took its tap. The calm wait after the boot then
   * waits that work out.
   */
  private async textFieldOnce(): Promise<void> {
    const session = await Session.create(this.base, { browserName: 'Safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': this.udid });
    try {
      await session.navigate('data:text/html,<meta name=viewport content="width=device-width"><input id=field autocomplete=off>');
      const focused = await session.execute<boolean>('const f = document.getElementById("field"); f.focus(); return document.activeElement === f;');
      this.note(`text field focused once after the boot (${focused ? 'focused' : 'not focused'})`);
    } finally {
      await session.delete().catch(() => {});
    }
  }

  /** A WebDriver session (Safari's automation sessions start with no cookies or storage of an earlier one). */
  async newPhone(): Promise<IosPhone> {
    const started = new Date();
    const session = await Session.create(this.base, { browserName: 'Safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': this.udid }).catch(async (e: Error) => {
      throw new Error(`${e.message}\n(${await this.sessionLogs(started)})`);
    });
    await this.rotate('portrait');
    await this.verifyStart(session);
    await this.calm('before the test', CALM_BEFORE_TEST_MS);
    return new IosPhone(this, session);
  }

  /**
   * Checks that a new session starts where a viewer's Safari would: one tab, no prompt over it,
   * the simulator upright, and Simulator.app hidden (shown, it draws the simulator's screen, and
   * taps slowed into long presses: rotate()).
   */
  private async verifyStart(session: Session): Promise<void> {
    const appShown = async () => this.rotator === 'simulator-app' && (await run('osascript', ['-e', 'tell application "System Events" to get visible of process "Simulator"'])).stdout.trim() === 'true';
    const state = async () => JSON.stringify({ tabs: (await session.windowHandles()).length, prompt: await session.alertText(), upright: this.turned === 'portrait', simulatorAppShown: await appShown() });
    await expect
      .poll(state, { message: 'the new Safari session starts with one tab, no prompt, the simulator upright and Simulator.app hidden' })
      .toBe(JSON.stringify({ tabs: 1, prompt: null, upright: true, simulatorAppShown: false }));
  }

  /** Waits until the simulator is calm (SIMULATOR_CALM_CORES, calm.ts); every window goes to device.log. */
  calm(what: string, timeoutMs: number): Promise<void> {
    return untilCalm({ what: `simulator ${what}`, maxCores: SIMULATOR_CALM_CORES, timeoutMs, measure: simulatorLoad, record: (line) => this.note(line) });
  }

  /** A line in device.log in the log folder, with the time. */
  private note(line: string): void {
    fs.appendFileSync(path.join(this.logDir, 'device.log'), `${new Date().toISOString()} ${line}\n`);
  }

  /**
   * What the simulator and the Mac logged about Web Inspector, Safari and WebDriver since `from`,
   * written next to safaridriver.log for a session that could not be created; returns where.
   */
  private sessionLogs(from: Date): Promise<string> {
    return this.logs(from, 'session', 'process CONTAINS[c] "webinspector" OR process CONTAINS[c] "safari" OR process CONTAINS[c] "webdriver" OR subsystem CONTAINS[c] "webinspector" OR subsystem CONTAINS[c] "webkit"');
  }

  /**
   * The tips Safari has shown since `from` (TipKit's "viewDidAppear" lines in the simulator's
   * log): none, with SAFARI_TIPS_OFF. One can take a tap meant for the page.
   */
  async tipsShown(from: Date): Promise<string[]> {
    const start = from.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+0000');
    const { stdout } = await run('xcrun', ['simctl', 'spawn', this.udid, 'log', 'show', '--style', 'compact', '--info', '--start', start, '--predicate', 'subsystem == "com.apple.TipKit" AND eventMessage CONTAINS "viewDidAppear"'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split('\n').filter((line) => line.includes('viewDidAppear'));
  }

  /** Appends one tap's timing (IosPhone.tap) to taps.log in the log folder. */
  noteTap(line: string): void {
    fs.appendFileSync(path.join(this.logDir, 'taps.log'), `${new Date().toISOString()} ${line}\n`);
  }

  /** What WebKit and UIKit logged in the simulator about a tap that began at `from`; returns where. */
  tapLogs(from: Date): Promise<string> {
    return this.logs(from, 'tap', 'subsystem == "com.apple.WebKit" OR subsystem == "com.apple.UIKit" OR process == "MobileSafari"', 5_000);
  }

  /**
   * The simulator's and the Mac's unified log since `leadMs` (a minute) before `from`, filtered by
   * `predicate`, in `<name>-<time>.log` in the log folder; returns where (for a failure message).
   */
  private async logs(from: Date, name: string, predicate: string, leadMs = 60_000): Promise<string> {
    const start = new Date(from.getTime() - leadMs)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '+0000');
    const file = path.join(this.logDir, `${name}-${from.toISOString().replace(/[:.]/g, '-')}.log`);
    const show = (cmd: string, args: string[]) =>
      run(cmd, [...args, 'show', '--style', 'compact', '--info', '--debug', '--start', start, '--predicate', predicate], { maxBuffer: 256 * 1024 * 1024 }).then(
        (r) => r.stdout,
        (e: Error) => `(log show failed: ${e.message})`,
      );
    const simulator = await show('xcrun', ['simctl', 'spawn', this.udid, 'log']);
    const mac = await show('log', []);
    fs.writeFileSync(file, `== simulator ${this.udid}\n${simulator}\n== mac\n${mac}\n`);
    return `simulator and Mac logs: ${file}`;
  }

  async rotate(to: Orientation): Promise<void> {
    if (this.rotator === 'devicectl') {
      await run('xcrun', ['devicectl', 'device', 'orientation', 'set', '--device', this.udid, to === 'landscape' ? 'landscapeLeft' : 'portrait']);
    } else if (to !== this.turned) {
      // GitHub's macOS images let osascript drive System Events (Accessibility in their TCC database).
      // Activating it shows it again (attach() hid it).
      const item = to === 'landscape' ? 'Rotate Left' : 'Rotate Right';
      await run('osascript', ['-e', 'tell application "Simulator" to activate', '-e', `tell application "System Events" to tell process "Simulator" to click menu item "${item}" of menu "Device" of menu bar 1`]);
      // Upright again: Simulator.app hidden, so that it stops drawing the simulator's screen. Shown,
      // taps on the loaded simulator took up to 2.4 s from finger down to up, which iOS takes for a
      // long press: the touch reached the element and no click followed (Devices runs 41227486868,
      // 41235159056, with the screen recording already off).
      if (to === 'portrait') await hideSimulatorApp();
    }
    this.turned = to;
  }

  /** Whether Simulator.app connects the Mac's keyboard (an attached keyboard hides the on-screen one), for a failure message. */
  async keyboardState(): Promise<string> {
    if (this.rotator !== 'simulator-app') return '(no state on iOS; Simulator.app not used)';
    return hardwareKeyboardConnected().then(
      (on) => `Simulator.app ${on ? 'connects' : 'does not connect'} the hardware keyboard`,
      (e: Error) => `(Simulator.app menu unreadable: ${e.message})`,
    );
  }

  /**
   * The simulator's screen as a PNG, through a file in the log folder. Not `-` for stdout, which
   * `simctl io screenshot`'s help offers: Xcode 26's simctl writes a file named `-` in the current
   * folder instead, exits 0 and leaves stdout empty (stderr: "Wrote screenshot to: <cwd>/-"), so
   * every failed test kept an empty "screen" (Devices runs 42508591582, 42515339177; 42519281087
   * tried both ways). Throws with what simctl said when it leaves no image, so the test's
   * "screen (failed)" says why.
   */
  async screenshot(): Promise<Buffer> {
    const file = path.join(this.logDir, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    const { stdout, stderr } = await run('xcrun', ['simctl', 'io', this.udid, 'screenshot', '--type=png', file]);
    const png = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    fs.rmSync(file, { force: true });
    if (png.length === 0) throw new Error(`simctl io screenshot left no image (${`${stdout}${stderr}`.trim() || 'it said nothing'})`);
    return png;
  }

  /** Records the screen until the returned stop(); kept by the caller only for a failed test. */
  startRecording(file: string): { stop(): Promise<void> } {
    const rec = spawn('xcrun', ['simctl', 'io', this.udid, 'recordVideo', '--codec=h264', '--force', file], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => rec.once('exit', () => resolve()));
    return {
      stop: async () => {
        // SIGINT: simctl finishes the movie file, then exits.
        rec.kill('SIGINT');
        await exited;
      },
    };
  }

  async release(): Promise<void> {
    await this.driver.stop({ graceMs: 5_000 });
    this.inspector?.destroy();
    if (this.booted) await simctl(['shutdown', this.udid]);
    this.sampler.kill();
  }
}

export class IosPhone implements Phone {
  readonly platform = 'ios' as const;
  /**
   * The iOS Simulator under safaridriver never raised the on-screen keyboard (CI, macos-26,
   * Xcode 26, iOS 26.5, Devices run 41173958482): the tap on #nickname reached the page as a
   * finger's (trusted pointerdown/pointerup of type touch, touchstart, touchend, then mousedown
   * and click), the field had focus, Simulator.app did not connect the Mac's keyboard (its
   * I/O > Keyboard menu, unticked then), and still the visual viewport stayed 714 px high and
   * the screen recording showed no keyboard, in every test; with the Mac's keyboard connected
   * (Simulator.app's default) none either. type() says why. So on iOS the keyboard checks (what
   * it leaves in sight) are not made; the tap and every other check are.
   */
  readonly onScreenKeyboard = false;

  constructor(
    private readonly device: IosDevice,
    private readonly session: Session,
  ) {}

  /** Safari's address bar: a WebDriver session can only steer its own tab, so not `simctl openurl`. */
  async open(url: string): Promise<void> {
    await this.session.navigate(url);
  }

  url(): Promise<string> {
    return this.session.url();
  }

  evaluate<R, A = undefined>(fn: (arg: A) => R, arg?: A): Promise<R> {
    return this.session.execute<R>(`return (${fn.toString()})(arguments[0]);`, [arg ?? null]);
  }

  get orientation(): Orientation {
    return this.device.orientation;
  }

  /**
   * A finger's tap (actionability.ts): W3C touch actions, which safaridriver plays through WebKit's
   * automation as touches on Safari's view (WebAutomationSession::simulateTouchInteraction), so the
   * page gets real touch events and Safari's own click synthesis decides the rest
   * (WebPage::handleSyntheticClick), as for a finger. A mouse pointer would skip the touches and
   * that synthesis, and a script's click() is no finger at all.
   */
  async tap(selector: string): Promise<void> {
    const element = await this.session.find(selector);
    // Scrolled only when not wholly in sight, as a finger would. After a scrollIntoView the page
    // reported the chat input at its new place while the screen (recording) still showed the old
    // one, and the tap there reached #unmute in the player (Devices runs 41181641808, 41183257695):
    // the point is read once Safari shows the page where it reports it (actionablePoint).
    await this.session.execute(
      `const el = arguments[0], r = el.getBoundingClientRect(), vv = window.visualViewport;
       if (r.top < vv.offsetTop || r.bottom > vv.offsetTop + vv.height || r.left < vv.offsetLeft || r.right > vv.offsetLeft + vv.width) el.scrollIntoView({ block: "center" });`,
      [element],
    );
    await this.session.execute(`(${armTap.toString()})(arguments[0]);`, [element]);
    const wanted = { landscape: this.orientation === 'landscape', initialScale: true };
    const asked = Date.now();
    const point = await actionablePoint(this, selector, () => this.session.execute<TouchState>(`return (${touchState.toString()})(arguments[0], arguments[1]);`, [element, wanted]));
    const started = Date.now();
    await this.session.perform(tapActions(point.clientX, point.clientY));
    const performed = Date.now();
    // A tap that took 9.5 s to perform on an overloaded simulator ended in no click (run
    // 41190536745), one with the finger down 1.3 s in a long press (run 42515339177).
    await tapEndsInClick(this, selector, started, performed, { waitedMs: started - asked, log: (line) => this.device.noteTap(line), onFailure: () => this.device.tapLogs(new Date(started)) });
  }

  /**
   * Puts the text in the field the way the keyboard does (the field's value, then an input event
   * of type insertText), after the tap that focused it. Not safaridriver's Element Send Keys: on
   * the iOS Simulator it delivers trusted keydown, keypress and keyup to the focused field and
   * inserts nothing (no beforeinput, no input), with the Mac's keyboard connected or not, and with
   * the field focused by the page's autofocus or by the tap alone (Devices runs 41175462466,
   * 41177262228, 41178761001, 41180367812). The simulator's log then shows Safari's WKContentView
   * as first responder with a text input session, and UIKit's "_inputViewsForResponder,
   * disableAutomaticKeyboardUI return empty": WebKit gives UIKit no field to edit, the same reason
   * the on-screen keyboard never shows (onScreenKeyboard). What the viewer types is checked on
   * Android; here the rest of the flow is.
   */
  async type(selector: string, text: string): Promise<void> {
    const typed = await this.evaluate(
      ({ s, t }) => {
        const el = document.querySelector(s) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el || document.activeElement !== el) return false;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
        setter.call(el, el.value + t);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }));
        return true;
      },
      { s: selector, t: text },
    );
    if (!typed) throw new Error(`${selector} is not the focused field: tap it first`);
  }

  rotate(to: Orientation): Promise<void> {
    return this.device.rotate(to);
  }

  back(): Promise<void> {
    throw new Error('iOS has no system Back');
  }

  /**
   * Not possible under safaridriver: when Safari leaves the screen the automation session ends.
   * In Devices run 41181641808, once Settings was launched over Safari (`simctl launch`), every
   * command answered "invalid session id", also after Safari was launched back in front, and a
   * new session opens a new page. The background check runs on Android (viewer.spec.ts).
   */
  background(): Promise<void> {
    throw new Error('iOS: the safaridriver session ends when Safari goes to the background');
  }

  foreground(): Promise<void> {
    throw new Error('iOS: the safaridriver session ends when Safari goes to the background');
  }

  screenshot(): Promise<Buffer> {
    return this.device.screenshot();
  }

  /** iOS gives no keyboard state to the host; Simulator.app says whether it connects the Mac's keyboard. */
  keyboardState(): Promise<string> {
    return this.device.keyboardState();
  }

  /** Never: the iOS Simulator under safaridriver raises no on-screen keyboard (onScreenKeyboard). */
  async keyboardShown(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    await this.session.delete().catch(() => {});
  }
}
