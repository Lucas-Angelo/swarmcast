// Mobile Safari on an iOS Simulator, through Apple's safaridriver (W3C WebDriver; `man
// safaridriver`: platformName iOS, safari:useSimulator, safari:deviceUDID). Taps are W3C touch
// actions, rotation is the simulator's (devicectl on Xcode 27+, Simulator.app's Rotate menu on
// Xcode 26), "background" is switching to the Settings app.
//
// Where it runs: Xcode 26 on macOS 26 (GitHub's macos-26 image, .github/workflows/devices.yml).
// On macOS 27 with Xcode 27, safaridriver finds no simulator for iOS 18 and later runtimes:
// they are cryptex images mounted under /private/var/run/com.apple.security.cryptexd, which
// the sandbox of safaridriver's HTTP service (WebDriver.framework) cannot read, so the
// simulator's OS version stays "(unknown)" and no session host matches (log: "Created
// Simulator target ... productVersion = (unknown)", then "Could not find any session hosts").
// Classic iOS 17 disk images still work there. docs/TESTING.md "Real devices" has the details.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { allocPorts } from '../../../../scripts/test/lib/ports.mjs';
import { spawnTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { expect } from '../e2e/fixtures.js';
import { touchPoint, type Orientation, type Phone, type TouchPoint } from './phone.js';
import { ready, Session, tapActions } from './webdriver.js';

const run = promisify(execFile);

/** scripts/test/devices/setup.sh install ios (and devices.yml) create it. */
const SIMULATOR_NAME = 'SwarmCast iPhone';
const SAFARI = 'com.apple.mobilesafari';
/** The app the viewer switches to in background(): Settings, there on every simulator. */
const OTHER_APP = 'com.apple.Preferences';
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

async function simctl(args: readonly string[]): Promise<string> {
  return (await run('xcrun', ['simctl', ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
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

/** The items of the I/O menu and its Keyboard submenu, for a failure message. */
function keyboardMenuItems(): Promise<string> {
  return osascript([
    'tell application "System Events" to tell process "Simulator"',
    'set io to name of every menu item of menu "I/O" of menu bar 1',
    `set kb to name of every menu item of ${KEYBOARD_MENU}`,
    'end tell',
    'set AppleScript\'s text item delimiters to ", "',
    'return "I/O: " & (io as text) & "; Keyboard: " & (kb as text)',
  ]).catch((e: Error) => `(menus unreadable: ${e.message})`);
}

/**
 * Connects the Mac's keyboard to the simulator (I/O > Keyboard > Connect Hardware Keyboard,
 * Simulator.app's default), so that a focused field gets a text input session. Without one,
 * safaridriver's Element Send Keys (Automation.performKeyboardInteractions, InsertByKey) answers
 * OK and inserts nothing: with the keyboard disconnected, Devices run 41175462466 joined with an
 * empty nickname in every test ("Please choose a nickname."), though the tap had reached the
 * field as a finger's and focused it. Either way iOS shows no on-screen keyboard here
 * (IosPhone.onScreenKeyboard). Simulator.app keeps the choice per simulator; the menu is the one
 * switch it reads at once.
 */
async function connectHardwareKeyboard(): Promise<void> {
  if (await hardwareKeyboardConnected()) return;
  await osascript([
    'tell application "Simulator" to activate',
    `tell application "System Events" to tell process "Simulator" to click (first menu item of ${KEYBOARD_MENU} whose name contains "Hardware Keyboard")`,
  ]);
  // The menu's check mark follows a moment later (CI run 41173006688 read it unchanged at once).
  await until(() => hardwareKeyboardConnected(), { timeoutMs: 10_000, what: 'Connect Hardware Keyboard ticked after its menu item was clicked' });
}

/** How this Xcode turns a simulator: `xcrun devicectl device orientation` (Xcode 27+) or Simulator.app's Device menu. */
type Rotator = 'devicectl' | 'simulator-app';

export class IosDevice {
  /** Where the Simulator.app rotation left the simulator (its menu turns by 90 degrees). */
  private orientation: Orientation = 'portrait';

  private constructor(
    readonly udid: string,
    private readonly driver: Tracked,
    private readonly base: URL,
    private readonly rotator: Rotator,
    /** Booted by the suite: shut down again in release(). */
    private readonly booted: boolean,
    private readonly logDir: string,
  ) {}

  static async attach(o: { logDir: string }): Promise<IosDevice> {
    // Each step with its time, so a slow or failed first session can be laid against them.
    const note = (step: string) => fs.appendFileSync(path.join(o.logDir, 'device.log'), `${new Date().toISOString()} ${step}\n`);
    const sim = await findSimulator();
    note(`simulator ${sim.udid} (${sim.state})`);
    let booted = false;
    if (sim.state !== 'Booted') {
      await simctl(['boot', sim.udid]);
      booted = true;
    }
    await simctl(['bootstatus', sim.udid, '-b']);
    note('booted');
    const missing: string[] = [];
    for (const [domain, key] of AUTOMATION_KEYS) {
      const value = await simctl(['spawn', sim.udid, 'defaults', 'read', domain, key]).catch(() => '');
      if (value !== '1') missing.push(`${domain} ${key}`);
    }
    if (missing.length > 0) {
      for (const [domain, key] of AUTOMATION_KEYS) await simctl(['spawn', sim.udid, 'defaults', 'write', domain, key, '-bool', 'true']);
      // webinspectord and Safari read them at start.
      await simctl(['shutdown', sim.udid]);
      await simctl(['boot', sim.udid]);
      await simctl(['bootstatus', sim.udid, '-b']);
      booted = true;
      note(`automation settings written (${missing.join(', ')}), rebooted`);
    }
    // Safari running before the first session gives the Web Inspector an application to list
    // (without it a new simulator answered safaridriver with a timeout: the same source).
    await simctl(['launch', sim.udid, SAFARI]);
    note('Safari launched');
    const rotator: Rotator = await run('xcrun', ['devicectl', 'device', 'orientation', 'get', '--device', sim.udid]).then(
      () => 'devicectl',
      () => 'simulator-app',
    );
    if (rotator === 'simulator-app') {
      // The Device menu acts on the simulator's window: Simulator.app shows this simulator.
      await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', sim.udid]);
      await until(
        async () => Number((await run('osascript', ['-e', 'tell application "System Events" to count windows of process "Simulator"']).catch(() => ({ stdout: '0' }))).stdout.trim()) > 0,
        { timeoutMs: 60_000, what: "Simulator.app's window" },
      );
      note("Simulator.app's window shown");
      await connectHardwareKeyboard().catch(async (e: Error) => {
        throw new Error(`${e.message} (${await keyboardMenuItems()})`);
      });
      note('hardware keyboard connected');
    }
    const [port] = await allocPorts(1);
    const driver = spawnTracked('safaridriver', ['-p', String(port), '--diagnose'], { name: 'safaridriver', logFile: path.join(o.logDir, 'safaridriver.log') });
    const base = new URL(`http://127.0.0.1:${port}`);
    await until(() => ready(base), { timeoutMs: 30_000, what: 'safaridriver to answer /status', abortOn: [driver] });
    note('safaridriver ready');
    return new IosDevice(sim.udid, driver, base, rotator, booted, o.logDir);
  }

  /** A WebDriver session (Safari's automation sessions start with no cookies or storage of an earlier one). */
  async newPhone(): Promise<IosPhone> {
    const started = new Date();
    const session = await Session.create(this.base, { browserName: 'Safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': this.udid }).catch(async (e: Error) => {
      throw new Error(`${e.message}\n(${await this.sessionLogs(started)})`);
    });
    await this.rotate('portrait');
    return new IosPhone(this, session);
  }

  /**
   * What the simulator and the Mac logged about Web Inspector, Safari and WebDriver since `from`,
   * written next to safaridriver.log for a session that could not be created; returns where.
   */
  private sessionLogs(from: Date): Promise<string> {
    return this.logs(from, 'session', 'process CONTAINS[c] "webinspector" OR process CONTAINS[c] "safari" OR process CONTAINS[c] "webdriver" OR subsystem CONTAINS[c] "webinspector" OR subsystem CONTAINS[c] "webkit"');
  }

  /**
   * The simulator's and the Mac's unified log since a minute before `from`, filtered by
   * `predicate`, in `<name>-<time>.log` in the log folder; returns where (for a failure message).
   */
  async logs(from: Date, name: string, predicate: string): Promise<string> {
    const start = new Date(from.getTime() - 60_000)
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
    } else if (to !== this.orientation) {
      // GitHub's macOS images let osascript drive System Events (Accessibility in their TCC database).
      const item = to === 'landscape' ? 'Rotate Left' : 'Rotate Right';
      await run('osascript', ['-e', 'tell application "Simulator" to activate', '-e', `tell application "System Events" to tell process "Simulator" to click menu item "${item}" of menu "Device" of menu bar 1`]);
    }
    this.orientation = to;
  }

  /** Whether Simulator.app connects the Mac's keyboard (an attached keyboard hides the on-screen one), for a failure message. */
  async keyboardState(): Promise<string> {
    if (this.rotator !== 'simulator-app') return '(no state on iOS; Simulator.app not used)';
    return hardwareKeyboardConnected().then(
      (on) => `Simulator.app ${on ? 'connects' : 'does not connect'} the hardware keyboard`,
      (e: Error) => `(Simulator.app menu unreadable: ${e.message})`,
    );
  }

  async launch(bundleId: string): Promise<void> {
    await simctl(['launch', this.udid, bundleId]);
  }

  async screenshot(): Promise<Buffer> {
    const { stdout } = await run('xcrun', ['simctl', 'io', this.udid, 'screenshot', '--type=png', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
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
    if (this.booted) await simctl(['shutdown', this.udid]);
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
   * the screen recording showed no keyboard, in every test. With the Mac's keyboard connected
   * (as attach() now leaves it, for typing: connectHardwareKeyboard) iOS shows none either. So on
   * iOS the keyboard checks (what it leaves in sight) are not made; the tap, the typing and every
   * other check are.
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

  async tap(selector: string): Promise<void> {
    const element = await this.session.find(selector);
    await this.session.execute('arguments[0].scrollIntoView({ block: "center" });', [element]);
    let point: TouchPoint | null = null;
    await expect
      .poll(async () => (point = await this.session.execute<TouchPoint | null>(`return (${touchPoint.toString()})(arguments[0]);`, [element])) !== null, {
        message: `${selector} can be touched (enabled, partly in sight, not covered)`,
      })
      .toBe(true);
    await this.session.perform(tapActions(element, point!.dx, point!.dy));
  }

  /**
   * Element Send Keys. When the text does not reach the field, fails at once with what the page
   * saw (key and input events, focus, whether the page has the window's focus) and the
   * simulator's UIKit, text input and WebKit log of that moment.
   */
  async type(selector: string, text: string): Promise<void> {
    const from = new Date();
    await this.evaluate(() => {
      const w = window as unknown as { __keys?: string[]; __keysListening?: boolean };
      w.__keys = [];
      if (w.__keysListening) return;
      w.__keysListening = true;
      for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart']) window.addEventListener(type, (e) => w.__keys?.push(`${type}${e.isTrusted ? '' : ' untrusted'}`), true);
    });
    const element = await this.session.find(selector);
    await this.session.sendKeys(element, text);
    const seen = await this.evaluate(
      (s) => ({
        value: (document.querySelector(s) as HTMLInputElement | null)?.value ?? null,
        focus: document.activeElement?.id ?? document.activeElement?.tagName ?? null,
        pageHasFocus: document.hasFocus(),
        events: [...new Set((window as unknown as { __keys?: string[] }).__keys ?? [])].join(', '),
      }),
      selector,
    );
    if (seen.value?.includes(text)) return;
    const logs = await this.device.logs(from, 'typing', 'subsystem == "com.apple.UIKit" OR subsystem CONTAINS[c] "webkit" OR process CONTAINS[c] "safari" OR process CONTAINS[c] "TextInput" OR process CONTAINS[c] "keyboard" OR category CONTAINS[c] "keyboard"');
    throw new Error(`typing "${text}" into ${selector} did not reach it: ${JSON.stringify(seen)} (${logs})`);
  }

  rotate(to: Orientation): Promise<void> {
    return this.device.rotate(to);
  }

  back(): Promise<void> {
    throw new Error('iOS has no system Back');
  }

  async background(): Promise<void> {
    await this.device.launch(OTHER_APP);
  }

  async foreground(): Promise<void> {
    await this.device.launch(SAFARI);
    // The automation session answers again once Safari is in front.
    await until(() => this.session.url().then(() => true, () => false), { timeoutMs: 30_000, what: 'Safari back in front' });
  }

  screenshot(): Promise<Buffer> {
    return this.device.screenshot();
  }

  /** iOS gives no keyboard state to the host; Simulator.app says whether it connects the Mac's keyboard. */
  keyboardState(): Promise<string> {
    return this.device.keyboardState();
  }

  async close(): Promise<void> {
    await this.session.delete().catch(() => {});
  }
}
