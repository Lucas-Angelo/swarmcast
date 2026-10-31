// Chrome on an Android emulator, driven like a viewer's phone: the link arrives through the
// system (a VIEW intent, as from a chat app), taps are touch events (they raise the on-screen
// keyboard; mouse clicks do not), rotation is the system's, and "background" is the Home key.
//
// Chrome is started by the suite, not by Playwright's experimental `_android.launchBrowser()`:
// that one adds Playwright's desktop switches (no renderer backgrounding, no back-forward
// cache...), and a phone that never backgrounds its page cannot show what the viewer gets when
// they switch apps. Chrome here gets only what automation needs (no first-run screens) and is
// reached over its DevTools socket (adb forward + chromium.connectOverCDP).
//
// Two things measured on Chrome 133 / Android 16 that the design depends on:
// - the page is served from http://127.0.0.1 through `adb reverse`, not from the emulator's
//   host alias 10.0.2.2: on 10.0.2.2 the page is not a secure context and has no crypto.subtle,
//   so the browser check cannot run; viewers always get HTTPS (the tunnel), a secure context.
// - Playwright keeps every page it is attached to "visible" (it turns on focus emulation, which
//   Chromium implements by counting the page as captured): backgrounded with Playwright
//   attached, the page stayed visible and kept playing; detached, it went hidden and its video
//   paused. background() therefore detaches first, foreground() attaches again.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';
import { spawnTracked, type Tracked } from '../../../../scripts/test/lib/proc.mjs';
import { until } from '../../../../scripts/test/lib/wait.mjs';
import { expect } from '../e2e/fixtures.js';
import { touchPoint, type Orientation, type Phone, type TouchPoint } from './phone.js';

const run = promisify(execFile);

const CHROME = 'com.android.chrome';
/** Chrome's launcher activity: what tapping its icon (or its card in Recents) starts. */
const CHROME_LAUNCHER = `${CHROME}/com.google.android.apps.chrome.Main`;
/** Read by Chrome at start on debuggable builds (the Google APIs images): no first-run screens. */
const CHROME_FLAGS = '_ --disable-fre --no-default-browser-check --no-first-run';
/** scripts/test/devices/setup.sh install android creates it. */
const AVD_NAME = 'swarmcast-pixel';
/** The emulator the suite boots when no device is connected (an even port in 5554-5584). */
const OWN_EMULATOR_PORT = 5580;
const BOOT_MS = 240_000;
/**
 * Emulator features turned off. HardwareDecoder: the emulator decodes H.264 for Android on the
 * host (Chrome gets c2.goldfish.h264.decoder). In Devices run 41173958482 the device log stopped
 * 1.2 s after "C2GoldfishAvcDec: calling onInit" and the emulator was gone; without the feature,
 * Android decodes the video itself (no goldfish codec in run 41175462466) and the live played.
 */
export const EMULATOR_FEATURES = ['-feature', '-HardwareDecoder'] as const;

function sdkRoot(): string {
  const env = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (env) return env;
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk');
}

const ADB = path.join(sdkRoot(), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');

/** `adb shell` joins its arguments into one command line for the device's shell: quote each word. */
function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The page targets Chrome's DevTools endpoint lists (`/json/list`), or null while it does not
 * answer yet (Chrome has not created its socket).
 */
async function pageTargets(port: number): Promise<string[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    return ((await res.json()) as Array<{ type: string; url: string }>).filter((t) => t.type === 'page').map((t) => t.url);
  } catch {
    return null;
  }
}

export class AndroidDevice {
  /**
   * The device log of the whole run, streamed to logcat.txt in the log folder: unlike the
   * per-test `logcat -d`, it keeps what the device said before it stopped answering.
   */
  private log: Tracked | null = null;

  private constructor(
    readonly serial: string,
    /** The emulator this suite booted (it stops it at the end); null for a device that was already there. */
    private readonly own: Tracked | null,
  ) {}

  /**
   * The device to test on: $ANDROID_SERIAL, else the one connected device, else (CI, and a
   * machine with no device connected) the suite boots its AVD headless, its output and exit in
   * emulator.log, and stops it in release(). Then prepared: no animations, screen kept on, portrait, the
   * full-screen notice already seen, and the e2e server's public port reachable on the
   * device's 127.0.0.1.
   */
  static async attach(o: { publicPort: number; logDir: string }): Promise<AndroidDevice> {
    if (!fs.existsSync(ADB)) throw new Error(`adb not found at ${ADB}: run scripts/test/devices/setup.sh install android (or set ANDROID_HOME)`);
    fs.mkdirSync(o.logDir, { recursive: true });
    const listed = (await run(ADB, ['devices'])).stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((w) => w[1] === 'device')
      .map((w) => w[0]!);
    let serial = process.env.ANDROID_SERIAL ?? (listed.length === 1 ? listed[0]! : null);
    if (!serial && listed.length > 1) throw new Error(`${listed.length} Android devices are connected (${listed.join(', ')}): set ANDROID_SERIAL`);
    let own: Tracked | null = null;
    if (!serial) {
      serial = `emulator-${OWN_EMULATOR_PORT}`;
      const emulator = path.join(sdkRoot(), 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
      // Headless (CI boots it this way too), software GPU, no audio device, a cold boot, video
      // decoded inside Android (EMULATOR_FEATURES).
      own = spawnTracked(emulator, ['-avd', AVD_NAME, '-port', String(OWN_EMULATOR_PORT), '-no-window', '-no-boot-anim', '-no-snapshot', '-no-metrics', '-no-audio', '-gpu', 'swiftshader_indirect', ...EMULATOR_FEATURES], {
        name: 'emulator',
        logFile: path.join(o.logDir, 'emulator.log'),
      });
    }
    const device = new AndroidDevice(serial, own);
    await until(async () => (await device.shellOut(['getprop', 'sys.boot_completed']).catch(() => '')) === '1', {
      timeoutMs: BOOT_MS,
      what: `${serial} to finish booting`,
      abortOn: own ? [own] : [],
    });
    device.log = spawnTracked(ADB, ['-s', serial, 'logcat', '-v', 'threadtime'], { name: 'logcat', logFile: path.join(o.logDir, 'logcat.txt') });
    // Whether the emulator offers Android its host-side video decoders (2: it does; EMULATOR_FEATURES).
    const hostDecoders = await device.shellOut(['getprop', 'ro.boot.qemu.hwcodec.avcdec']);
    fs.appendFileSync(path.join(o.logDir, 'device.log'), `${new Date().toISOString()} ${serial} booted; ro.boot.qemu.hwcodec.avcdec=${hostDecoders || '(unset)'}\n`);
    for (const scale of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) await device.shell(['settings', 'put', 'global', scale, '0']);
    await device.shell(['svc', 'power', 'stayon', 'true']);
    // Android shows "Viewing full screen" the first time an app goes full screen, over the page.
    await device.shell(['settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed']);
    await device.shell(['wm', 'user-rotation', 'lock', '0']);
    await device.shell(['sh', '-c', `echo ${shellWord(CHROME_FLAGS)} > /data/local/tmp/chrome-command-line`]);
    await run(ADB, ['-s', serial, 'reverse', `tcp:${o.publicPort}`, `tcp:${o.publicPort}`]);
    return device;
  }

  /** How the emulator this suite booted ended, with its last output lines; null while it runs (or for a device that was already there). */
  emulatorExit(): string | null {
    if (!this.own || this.own.running) return null;
    return `the emulator exited (${JSON.stringify(this.own.exitInfo)}); its last lines:\n${this.own.tail(40)}`;
  }

  async shell(args: readonly string[]): Promise<void> {
    await this.shellOut(args);
  }

  async shellOut(args: readonly string[]): Promise<string> {
    const { stdout } = await run(ADB, ['-s', this.serial, 'shell', ...args.map(shellWord)], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }

  /**
   * Chrome's activity record in `dumpsys activity activities`: its `state=` (RESUMED, PAUSED,
   * STOPPED...) and whether it has reported idle after starting (`idle=true`); null when Chrome
   * has no activity. The record is named after the activity that started it (ChromeTabbedActivity
   * from a link, the launcher alias Main from the icon), so any record of the Chrome package counts.
   */
  async chromeActivity(): Promise<{ state: string | null; idle: boolean } | null> {
    const lines = (await this.shellOut(['dumpsys', 'activity', 'activities'])).split('\n');
    const at = lines.findIndex((l) => /\* Hist\b/.test(l) && l.includes(` ${CHROME}/`));
    if (at < 0) return null;
    let state: string | null = null;
    let idle = false;
    for (const l of lines.slice(at + 1)) {
      if (/\* Hist\b/.test(l)) break;
      state ??= /^\s*state=(\w+)/.exec(l)?.[1] ?? null;
      if (/\bidle=true\b/.test(l)) idle = true;
    }
    return { state, idle };
  }

  async chromeState(): Promise<string | null> {
    return (await this.chromeActivity())?.state ?? null;
  }

  /** Whether Chrome is the activity in front (`topResumedActivity`). */
  async chromeInFront(): Promise<boolean> {
    const top = (await this.shellOut(['dumpsys', 'activity', 'activities'])).split('\n').find((l) => l.includes('topResumedActivity='));
    return !!top && top.includes(` ${CHROME}/`);
  }

  /** The display's rotation in quarter turns (0 portrait, 1 landscape), from `dumpsys window`. */
  async rotation(): Promise<number | null> {
    const m = /^\s*mRotation=(\d)/m.exec(await this.shellOut(['dumpsys', 'window']));
    return m ? Number(m[1]) : null;
  }

  /**
   * Locks the system rotation (as the viewer's rotate button with auto-rotate off) and waits until
   * the display has turned. Turning upright while Chrome holds a full-screen video sideways does
   * not turn the display (Chrome locks landscape until the viewer leaves full screen).
   */
  async rotate(to: Orientation): Promise<void> {
    const quarter = to === 'landscape' ? 1 : 0;
    await this.shell(['wm', 'user-rotation', 'lock', String(quarter)]);
    await until(async () => (await this.rotation()) === quarter, { timeoutMs: 15_000, what: `the display turned ${to}`, detail: () => `rotation ${quarter} wanted` });
  }

  /** A fresh Chrome for one test: stopped, its data cleared (no cookie or remembered choice of an earlier test), portrait. */
  async newPhone(): Promise<AndroidPhone> {
    await this.shell(['am', 'force-stop', CHROME]);
    await this.shell(['pm', 'clear', CHROME]);
    // Without it, a fresh Chrome asks for it in a dialog over the page ("Chrome notifications
    // make things easier"), at a moment of its own: the join page's taps landed on the dialog.
    await this.shell(['pm', 'grant', CHROME, 'android.permission.POST_NOTIFICATIONS']);
    await this.rotate('portrait');
    // Chrome is running before the link arrives, as on a phone where it already is. Handed the
    // link while it was still starting after a cold boot, Chrome once opened the link's tab and
    // dropped it a second later for its empty start page (screen recording): the test lost its
    // page. Started from its icon first, it takes the link in the activity it already has.
    await this.shell(['am', 'start', '-n', CHROME_LAUNCHER]);
    let seen: { state: string | null; idle: boolean } | null = null;
    await until(
      async () => {
        const activity = await this.chromeActivity();
        seen = activity;
        return activity?.state === 'RESUMED' && activity.idle;
      },
      { timeoutMs: 60_000, what: 'Chrome started and idle', detail: () => JSON.stringify(seen) },
    );
    return new AndroidPhone(this);
  }

  /**
   * Chrome's DevTools socket forwarded to a free local port, and Playwright connected once
   * Chrome lists a tab `wanted` accepts. Not earlier: connectOverCDP waits for every tab to be
   * ready, and a tab Chrome creates during the handshake (the link's, right after the intent)
   * once stayed paused for the debugger: the connection timed out after 30 s, 1 run in 12.
   */
  async connectChrome(wanted: (url: string) => boolean): Promise<{ browser: Browser; port: number }> {
    const port = Number((await run(ADB, ['-s', this.serial, 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote'])).stdout.trim());
    let seen: string[] | null = null;
    await until(async () => (seen = await pageTargets(port))?.some(wanted) === true, {
      timeoutMs: 30_000,
      what: "Chrome's DevTools listing the tab",
      detail: () => (seen ? `tabs: ${seen.join(', ') || '(none)'}` : 'DevTools does not answer'),
    });
    return { browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`), port };
  }

  async unforward(port: number): Promise<void> {
    await run(ADB, ['-s', this.serial, 'forward', '--remove', `tcp:${port}`]);
  }

  /** The device screen, system bars and keyboard included. */
  async screenshot(): Promise<Buffer> {
    const { stdout } = await run(ADB, ['-s', this.serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  /**
   * Records the screen until the returned stop() (screenrecord on the device, pulled to `file`).
   * Kept by the caller only for a failed test.
   */
  startRecording(file: string): { stop(): Promise<void> } {
    const remote = '/sdcard/swarmcast-test.mp4';
    const rec = spawn(ADB, ['-s', this.serial, 'shell', 'screenrecord', '--bit-rate', '2000000', '--size', '540x1200', remote], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => rec.once('exit', () => resolve()));
    return {
      stop: async () => {
        // SIGINT lets screenrecord finish the MP4 (its moov atom), then the shell command exits.
        await this.shell(['pkill', '-INT', 'screenrecord']).catch(() => {});
        await exited;
        await run(ADB, ['-s', this.serial, 'pull', remote, file]);
        await this.shell(['rm', '-f', remote]);
      },
    };
  }

  /** The device log since the test's Chrome started (Chrome's and the system's), for a failed test. */
  async logcat(): Promise<string> {
    return (await run(ADB, ['-s', this.serial, 'logcat', '-d', '-t', '3000'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  }

  async release(): Promise<void> {
    await this.log?.stop();
    if (!this.own) return;
    await run(ADB, ['-s', this.serial, 'emu', 'kill']).catch(() => {});
    await this.own.stop({ graceMs: 30_000 });
  }
}

export class AndroidPhone implements Phone {
  readonly platform = 'android' as const;
  /** Gboard comes up for a tap on a text field (the AVD has no hardware keyboard). */
  readonly onScreenKeyboard = true;
  private browser: Browser | null = null;
  private port = 0;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  /** The page's address when it went to the background, to find its tab again. */
  private lastUrl = '';

  constructor(private readonly device: AndroidDevice) {}

  /** The Playwright page of the tab under test (the Android-only checks use its locators). */
  get current(): Page {
    if (!this.page) throw new Error('no page yet: open() a link first');
    return this.page;
  }

  async open(url: string): Promise<void> {
    await this.device.shell(['am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, CHROME]);
    const origin = new URL(url).origin;
    await this.attach((u) => u.startsWith(origin));
  }

  /** Connects Playwright to Chrome and picks the newest tab whose address `match` accepts. */
  private async attach(match: (url: string) => boolean): Promise<void> {
    const { browser, port } = await this.device.connectChrome(match);
    this.browser = browser;
    this.port = port;
    const context = browser.contexts()[0]!;
    await until(() => context.pages().some((p) => match(p.url())), { timeoutMs: 30_000, what: 'the tab of the link', detail: () => context.pages().map((p) => p.url()).join(', ') });
    this.page = context.pages().filter((p) => match(p.url())).at(-1)!;
    this.cdp = await context.newCDPSession(this.page);
  }

  private async detach(): Promise<void> {
    // Disconnects (a connected browser's close() leaves Chrome and its tabs alone).
    await this.browser?.close();
    if (this.port) await this.device.unforward(this.port);
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.port = 0;
  }

  async url(): Promise<string> {
    return this.current.url();
  }

  evaluate<R, A = undefined>(fn: (arg: A) => R, arg?: A): Promise<R> {
    return this.current.evaluate(fn as (arg: unknown) => R, arg);
  }

  async tap(selector: string): Promise<void> {
    const target = this.current.locator(selector);
    await target.scrollIntoViewIfNeeded();
    let point: TouchPoint | null = null;
    await expect
      .poll(async () => (point = await target.evaluate(touchPoint)) !== null, { message: `${selector} can be touched (enabled, partly in sight, not covered)` })
      .toBe(true);
    const cdp = this.cdp!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point!.x, y: point!.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async type(selector: string, text: string): Promise<void> {
    await expect(this.current.locator(selector)).toBeFocused();
    // What a keyboard app does: commits the text into the focused field.
    await this.current.keyboard.insertText(text);
  }

  rotate(to: Orientation): Promise<void> {
    return this.device.rotate(to);
  }

  /** The system Back gesture: leaves a full-screen video. */
  async back(): Promise<void> {
    await this.device.shell(['input', 'keyevent', 'KEYCODE_BACK']);
  }

  async background(): Promise<void> {
    this.lastUrl = await this.url();
    await this.detach();
    await this.device.shell(['input', 'keyevent', 'KEYCODE_HOME']);
    await until(async () => (await this.device.chromeState()) === 'STOPPED', { timeoutMs: 15_000, what: 'Chrome stopped in the background' });
  }

  async foreground(): Promise<void> {
    await this.device.shell(['am', 'start', '-n', CHROME_LAUNCHER]);
    await until(() => this.device.chromeInFront(), { timeoutMs: 15_000, what: 'Chrome back in front' });
    const url = this.lastUrl;
    await this.attach((u) => u === url);
  }

  screenshot(): Promise<Buffer> {
    return this.device.screenshot();
  }

  /** The input method service's view: whether the keyboard is shown, and which keyboard app it is. */
  async keyboardState(): Promise<string> {
    const lines = (await this.device.shellOut(['dumpsys', 'input_method'])).split('\n').map((l) => l.trim());
    return lines.filter((l) => /^(mInputShown|mImeWindowVis|mCurMethodId)=/.test(l)).join(' ') || '(no input method state)';
  }

  /** The page itself (without system bars), for a failed test's report. */
  async pageScreenshot(): Promise<Buffer | null> {
    return this.page ? this.page.screenshot().catch(() => null) : null;
  }

  async close(): Promise<void> {
    await this.detach().catch(() => {});
    await this.device.shell(['am', 'force-stop', CHROME]);
  }
}
