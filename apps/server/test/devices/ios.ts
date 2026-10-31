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
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
  await until(async () => (await simulatorAppWindows()) > 0, { timeoutMs: 60_000, what: "Simulator.app's window" });
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
    /** The connection that keeps the simulator's webinspectord running (webInspectorReady). */
    private readonly inspector: net.Socket | null,
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
      // Opened here, where its first start (up to two minutes on CI) has the fixture's time, and
      // hidden: rotate() shows it only to turn the phone.
      await openSimulatorApp(sim.udid);
      await hideSimulatorApp();
      note('Simulator.app started and hidden');
    }
    const inspector = await webInspectorReady(sim.udid);
    note('Web Inspector up, Safari connected to it');
    const [port] = await allocPorts(1);
    const driver = spawnTracked('safaridriver', ['-p', String(port), '--diagnose'], { name: 'safaridriver', logFile: path.join(o.logDir, 'safaridriver.log') });
    const base = new URL(`http://127.0.0.1:${port}`);
    await until(() => ready(base), { timeoutMs: 30_000, what: 'safaridriver to answer /status', abortOn: [driver] });
    note('safaridriver ready');
    return new IosDevice(sim.udid, driver, base, rotator, booted, o.logDir, inspector);
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
  private async logs(from: Date, name: string, predicate: string): Promise<string> {
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
      // Activating it shows it again (attach() hid it).
      const item = to === 'landscape' ? 'Rotate Left' : 'Rotate Right';
      await run('osascript', ['-e', 'tell application "Simulator" to activate', '-e', `tell application "System Events" to tell process "Simulator" to click menu item "${item}" of menu "Device" of menu bar 1`]);
      // Upright again: Simulator.app hidden, so that it stops drawing the simulator's screen. Shown,
      // taps on the loaded simulator took up to 2.4 s from finger down to up, which iOS takes for a
      // long press: the touch reached the element and no click followed (Devices runs 41227486868,
      // 41235159056, with the screen recording already off).
      if (to === 'portrait') await hideSimulatorApp();
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
    this.inspector?.destroy();
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

  async tap(selector: string): Promise<void> {
    const element = await this.session.find(selector);
    // Scrolled only when not wholly in sight, as a finger would. After a scrollIntoView the page
    // reported the chat input at its new place while the screen (recording) still showed the old
    // one, and the tap there reached #unmute in the player, with the element origin and with
    // viewport coordinates alike (Devices runs 41181641808, 41183257695); unscrolled, every tap landed.
    await this.session.execute(
      `const el = arguments[0], r = el.getBoundingClientRect(), vv = window.visualViewport;
       if (r.top < vv.offsetTop || r.bottom > vv.offsetTop + vv.height || r.left < vv.offsetLeft || r.right > vv.offsetLeft + vv.width) el.scrollIntoView({ block: "center" });`,
      [element],
    );
    let point: TouchPoint | null = null;
    await expect
      .poll(async () => (point = await this.session.execute<TouchPoint | null>(`return (${touchPoint.toString()})(arguments[0]);`, [element])) !== null, {
        message: `${selector} can be touched (enabled, partly in sight, not covered)`,
      })
      .toBe(true);
    // What the tap delivers to the element, kept in sessionStorage: a tap on Watch may navigate.
    await this.session.execute(
      `const el = arguments[0];
       window.__tapStop?.();
       sessionStorage.setItem('__tap', '');
       const note = (e) => { if (e.isTrusted && (e.target === el || el.contains(e.target))) sessionStorage.setItem('__tap', sessionStorage.getItem('__tap') + e.type + ' '); };
       const types = ['touchstart', 'touchend', 'click'];
       for (const type of types) window.addEventListener(type, note, true);
       window.__tapStop = () => { for (const type of types) window.removeEventListener(type, note, true); };`,
      [element],
    );
    const started = Date.now();
    await this.session.perform(tapActions(point!.clientX, point!.clientY));
    const took = Date.now() - started;
    // A finger's tap ends in a click. When it does not (the touch reached the element and no click
    // followed: runs 41184587941, 41190536745, the second with a tap that took 9.5 s to perform on
    // an overloaded simulator), the test fails here, with what arrived.
    await expect
      .poll(() => this.evaluate(() => sessionStorage.getItem('__tap') ?? ''), { message: `the tap on ${selector} ended in a click (it took ${took} ms to perform)` })
      .toContain('click');
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

  async close(): Promise<void> {
    await this.session.delete().catch(() => {});
  }
}
