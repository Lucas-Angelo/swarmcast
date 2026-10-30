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
  ) {}

  static async attach(o: { logDir: string }): Promise<IosDevice> {
    const sim = await findSimulator();
    let booted = false;
    if (sim.state !== 'Booted') {
      await simctl(['boot', sim.udid]);
      booted = true;
    }
    await simctl(['bootstatus', sim.udid, '-b']);
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
    }
    // Safari running before the first session gives the Web Inspector an application to list
    // (without it a new simulator answered safaridriver with a timeout: the same source).
    await simctl(['launch', sim.udid, SAFARI]);
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
    }
    const [port] = await allocPorts(1);
    const driver = spawnTracked('safaridriver', ['-p', String(port), '--diagnose'], { name: 'safaridriver', logFile: path.join(o.logDir, 'safaridriver.log') });
    const base = new URL(`http://127.0.0.1:${port}`);
    await until(() => ready(base), { timeoutMs: 30_000, what: 'safaridriver to answer /status', abortOn: [driver] });
    return new IosDevice(sim.udid, driver, base, rotator, booted);
  }

  /** A WebDriver session (Safari's automation sessions start with no cookies or storage of an earlier one). */
  async newPhone(): Promise<IosPhone> {
    const session = await Session.create(this.base, { browserName: 'Safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceUDID': this.udid });
    await this.rotate('portrait');
    return new IosPhone(this, session);
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

  async type(selector: string, text: string): Promise<void> {
    await this.session.sendKeys(await this.session.find(selector), text);
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

  /** iOS gives no keyboard state to the host: the viewport readings around it say what there is. */
  keyboardState(): Promise<string> {
    return Promise.resolve('(not available on iOS)');
  }

  async close(): Promise<void> {
    await this.session.delete().catch(() => {});
  }
}
