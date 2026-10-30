import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_ID,
  Autostart,
  checkExePath,
  desktopExecValue,
  desktopTryExecValue,
  linuxDesktopEntry,
  linuxEntryExe,
  macLaunchAgentPlist,
  macPlistExe,
  parseRegExport,
  windowsCommandExe,
  windowsRunCommand,
  WINDOWS_RUN_KEY,
  type Runner,
} from '../../src/desktop/autostart.js';
import { tempDir } from './helpers.js';

// "Start with the computer" for the desktop app: a Run value (Windows), a LaunchAgent (macOS), an
// XDG autostart entry (Linux). The OS entry is the source of truth: status() reads it back.

/** A REG_SZ value as `reg export` writes it: backslashes and quotes escaped. */
const regString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Paths that need every escape of the Desktop Entry spec (spaces, quotes, $, `, \, %) or none. */
const LINUX_EXES = ['/opt/Swarm Cast/swarmcast-desktop', '/home/a"b/$x`y`/100%/c\\d', '/home/zé/Apps/SwarmCast.AppImage'];

describe('autostart entries (pure)', () => {
  it('Windows: the Run command quotes the exe and adds --background; the exe reads back from it', () => {
    // Arrange
    const exe = 'C:\\Users\\João Silva\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';
    // Act
    const cmd = windowsRunCommand(exe);
    // Assert
    expect(cmd).toBe(`"${exe}" --background`);
    expect(windowsCommandExe(cmd)).toBe(exe);
    expect(windowsCommandExe('C:\\x\\a.exe --flag')).toBe('C:\\x\\a.exe');
  });

  it('Windows: reads the SwarmCast value back from a reg export, and nothing else', () => {
    // Arrange
    const cmd = windowsRunCommand('C:\\Users\\João Silva\\SwarmCast.exe');
    const reg = `\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[${WINDOWS_RUN_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}]\r\n"OneDrive"=${regString('"C:\\od.exe" /background')}\r\n"SwarmCast"=${regString(cmd)}\r\n`;
    // Act
    const ours = parseRegExport(reg);
    const others = parseRegExport(reg.replace('"SwarmCast"', '"Other"'));
    const notAString = parseRegExport('"SwarmCast"=hex(2):43,00');
    // Assert
    expect(ours).toBe(cmd);
    expect(others).toBeNull();
    expect(notAString).toBe('');
  });

  it.each(['C:\\a"b.exe', 'relative\\a.exe'])('Windows: refuses %s as the exe', (exe) => {
    // Act
    const act = () => windowsRunCommand(exe);
    // Assert
    expect(act).toThrow();
  });

  it('macOS: LaunchAgent plist with the label, the args and RunAtLoad; XML-escaped paths read back', () => {
    // Arrange
    const exe = '/Applications/My "Apps" & <Tools>/SwarmCast.app/Contents/MacOS/SwarmCast';
    // Act
    const plist = macLaunchAgentPlist(exe);
    // Assert
    expect(plist).toContain(`<string>${APP_ID}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<string>--background</string>');
    expect(plist).toContain('My &quot;Apps&quot; &amp; &lt;Tools&gt;');
    expect(macPlistExe(plist)).toBe(exe);
  });

  it('macOS: reads Program from a plist; none without one', () => {
    // Act
    const program = macPlistExe('<plist><dict><key>Program</key><string>/x/y</string></dict></plist>');
    const none = macPlistExe('<plist/>');
    // Assert
    expect(program).toBe('/x/y');
    expect(none).toBeNull();
  });

  it.each([
    ['/opt/Swarm Cast/swarmcast-desktop', '"/opt/Swarm Cast/swarmcast-desktop" --background'],
    ['/home/a"b/$x`y`/100%/c\\d', '"/home/a\\\\"b/\\\\$x\\\\`y\\\\`/100%%/c\\\\\\\\d" --background'],
  ])('Linux: Exec of %s is quoted per the Desktop Entry spec', (exe, exec) => {
    // Act
    const value = desktopExecValue(exe);
    // Assert
    expect(value).toBe(exec);
  });

  it.each([
    ['/opt/Swarm Cast/swarmcast-desktop', '/opt/Swarm Cast/swarmcast-desktop'],
    ['/home/a"b/$x`y`/100%/c\\d', '/home/a"b/$x`y`/100%/c\\\\d'],
  ])('Linux: TryExec of %s is the bare path, string escaping only', (exe, tryExec) => {
    // Act
    const value = desktopTryExecValue(exe);
    // Assert
    expect(value).toBe(tryExec);
  });

  // TryExec holds the bare path, so the session skips the entry at login once the app is removed.
  it.each(LINUX_EXES)('Linux: the entry for %s starts the app at login and reads back', (exe) => {
    // Act
    const entry = linuxDesktopEntry(exe);
    // Assert
    expect(entry).toMatch(/^\[Desktop Entry\]\nType=Application\n/);
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
    expect(entry).toContain(`\nTryExec=${exe.replace(/\\/g, '\\\\')}\nExec=`);
    expect(linuxEntryExe(entry)).toBe(exe);
  });

  it('Linux: a plain path is written as is', () => {
    // Act
    const entry = linuxDesktopEntry('/usr/bin/swarmcast-desktop');
    // Assert
    expect(entry).toContain('\nTryExec=/usr/bin/swarmcast-desktop\nExec="/usr/bin/swarmcast-desktop" --background\n');
  });

  it.each([
    ['an unquoted Exec', '[Desktop Entry]\nExec=/usr/bin/swarmcast-desktop --background\n', '/usr/bin/swarmcast-desktop'],
    ['a hidden entry', '[Desktop Entry]\nExec=/x --background\nHidden=true\n', null],
    ['an entry GNOME turned off', '[Desktop Entry]\nExec=/x\nX-GNOME-Autostart-enabled=false\n', null],
    ['another section', '[Other]\nExec=/x\n', null],
  ])('Linux: reads %s back', (_what, entry, exe) => {
    // Act
    const read = linuxEntryExe(entry);
    // Assert
    expect(read).toBe(exe);
  });

  it.each([
    ['a relative path', () => checkExePath('swarmcast')],
    ['a newline', () => checkExePath('/a\nb')],
    ['a tab', () => linuxDesktopEntry('/a\tb')],
    ['no path', () => macLaunchAgentPlist('')],
  ])('refuses %s', (_what, act) => {
    // Assert
    expect(act).toThrow();
  });
});

describe('Autostart (file-based OSes, temporary HOME)', () => {
  it('is unsupported without the app path, and off by default', async () => {
    // Arrange
    const home = tempDir('sc-home-');
    const noExe = new Autostart({ platform: 'linux', home });
    const withExe = new Autostart({ platform: 'linux', home, exe: '/opt/sc/swarmcast-desktop', env: {} });
    // Act
    const unsupported = await noExe.status();
    const turnOn = noExe.set(true);
    const off = await withExe.status();
    // Assert
    expect(unsupported).toEqual({ supported: false, enabled: false });
    await expect(turnOn).rejects.toThrow(/desktop app/);
    expect(off).toEqual({ supported: true, enabled: false });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('macOS: writes and removes the LaunchAgent; an entry for another copy is stale and rewritten', async () => {
    // Arrange
    const home = tempDir('sc-home-');
    const exe = '/Applications/Swarm Cast.app/Contents/MacOS/SwarmCast';
    const a = new Autostart({ platform: 'darwin', home, exe });
    const file = path.join(home, 'Library', 'LaunchAgents', `${APP_ID}.plist`);
    // Act
    const on = await a.set(true);
    // Assert
    expect(a.entryFile()).toBe(file);
    expect(on).toEqual({ supported: true, enabled: true });
    expect(macPlistExe(fs.readFileSync(file, 'utf8'))).toBe(exe);
    // Act
    fs.writeFileSync(file, macLaunchAgentPlist('/Volumes/Old/SwarmCast.app/Contents/MacOS/SwarmCast'));
    const stale = await a.status();
    const rewritten = await a.set(true);
    // Assert
    expect(stale).toEqual({ supported: true, enabled: true, stale: true });
    expect(rewritten).toEqual({ supported: true, enabled: true });
    expect(macPlistExe(fs.readFileSync(file, 'utf8'))).toBe(exe);
    // Act
    const off = await a.set(false);
    const offAgain = await a.set(false);
    // Assert
    expect(off).toEqual({ supported: true, enabled: false });
    expect(fs.existsSync(file)).toBe(false);
    expect(offAgain).toEqual({ supported: true, enabled: false });
  });

  it('Linux: defaults to ~/.config, also for a relative XDG_CONFIG_HOME', () => {
    // Arrange
    const home = tempDir('sc-home-');
    const exe = '/home/me/Apps/SwarmCast x64.AppImage';
    // Act
    const byDefault = new Autostart({ platform: 'linux', home, exe, env: {} }).entryFile();
    const relative = new Autostart({ platform: 'linux', home, exe, env: { XDG_CONFIG_HOME: 'relative' } }).entryFile();
    // Assert
    expect(byDefault).toBe(path.join(home, '.config', 'autostart', 'swarmcast.desktop'));
    expect(relative).toBe(byDefault);
  });

  it('Linux: honours an absolute XDG_CONFIG_HOME; an entry the desktop turned off reads as off', async () => {
    // Arrange
    const home = tempDir('sc-home-');
    const exe = '/home/me/Apps/SwarmCast x64.AppImage';
    const xdg = path.join(home, 'xdg');
    const a = new Autostart({ platform: 'linux', home, exe, env: { XDG_CONFIG_HOME: xdg } });
    const file = path.join(xdg, 'autostart', 'swarmcast.desktop');
    // Act
    const on = await a.set(true);
    // Assert
    expect(a.entryFile()).toBe(file);
    expect(on).toEqual({ supported: true, enabled: true });
    expect(linuxEntryExe(fs.readFileSync(file, 'utf8'))).toBe(exe);
    // Act
    fs.appendFileSync(file, 'Hidden=true\n');
    const hidden = await a.status();
    const off = await a.set(false);
    // Assert
    expect(hidden).toEqual({ supported: true, enabled: false });
    expect(off).toEqual({ supported: true, enabled: false });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('Autostart on Windows (reg.exe faked)', () => {
  /**
   * A fake HKCU Run key behind the reg.exe arguments Autostart uses: `export` writes the key as
   * UTF-16 with a BOM (as reg.exe does), `add` sets the SwarmCast value, `delete` removes it.
   * Anything else fails like reg.exe would. Every call is recorded.
   */
  function fakeReg(initial?: string): { run: Runner; calls: string[][]; value: () => string | undefined } {
    let value = initial;
    const calls: string[][] = [];
    const run: Runner = async (command, args) => {
      calls.push([command, ...args]);
      if (command !== 'reg.exe' || args[1] !== WINDOWS_RUN_KEY) return { code: 1, stdout: '', stderr: 'ERROR: unexpected command' };
      if (args[0] === 'export') {
        const lines = ['Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]'];
        if (value !== undefined) lines.push(`"SwarmCast"=${regString(value)}`);
        fs.writeFileSync(args[2]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add') {
        value = args[7];
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete') {
        value = undefined;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'ERROR: unexpected command' };
    };
    return { run, calls, value: () => value };
  }

  const EXE = 'C:\\Users\\João\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';

  it('adds the Run value with reg add and reads it back (UTF-16 export, accents)', async () => {
    // Arrange
    const reg = fakeReg();
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run, tmpDir: tempDir('sc-reg-') });
    // Act
    const before = await a.status();
    const on = await a.set(true);
    // Assert
    expect(before).toEqual({ supported: true, enabled: false });
    expect(on).toEqual({ supported: true, enabled: true });
    expect(reg.value()).toBe(`"${EXE}" --background`);
    expect(reg.calls.filter((c) => c[1] === 'add')).toEqual([['reg.exe', 'add', WINDOWS_RUN_KEY, '/v', 'SwarmCast', '/t', 'REG_SZ', '/d', `"${EXE}" --background`, '/f']]);
  });

  it('an entry for another copy is stale and rewritten; the same path in another case is the same file', async () => {
    // Arrange
    const old = fakeReg('"D:\\Old\\SwarmCast.exe" --background');
    const tmpDir = tempDir('sc-reg-');
    const a = new Autostart({ platform: 'win32', exe: EXE, run: old.run, tmpDir });
    // Act
    const stale = await a.status();
    await a.set(true);
    const upperCase = await new Autostart({ platform: 'win32', exe: EXE.toUpperCase(), run: old.run, tmpDir }).status();
    // Assert
    expect(stale).toEqual({ supported: true, enabled: true, stale: true });
    expect(old.value()).toBe(`"${EXE}" --background`);
    expect(upperCase).toEqual({ supported: true, enabled: true });
  });

  it('deletes the Run value, and calls no reg delete when there is nothing to delete', async () => {
    // Arrange
    const reg = fakeReg(`"${EXE}" --background`);
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run, tmpDir: tempDir('sc-reg-') });
    // Act
    const off = await a.set(false);
    const callsAfterDelete = reg.calls.length;
    await a.set(false);
    // Assert
    expect(off).toEqual({ supported: true, enabled: false });
    expect(reg.value()).toBeUndefined();
    expect(reg.calls.slice(0, callsAfterDelete).filter((c) => c[1] === 'delete')).toHaveLength(1);
    expect(reg.calls.slice(callsAfterDelete).map((c) => c[1])).not.toContain('delete');
  });

  it('every reg.exe call targets the Run key of the current user', async () => {
    // Arrange
    const reg = fakeReg();
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run, tmpDir: tempDir('sc-reg-') });
    // Act
    await a.set(true);
    await a.set(false);
    // Assert
    expect(reg.calls.length).toBeGreaterThan(0);
    expect(reg.calls.every((c) => c[0] === 'reg.exe' && c[2] === WINDOWS_RUN_KEY)).toBe(true);
  });

  it('reports reg.exe failures', async () => {
    // Arrange
    const run: Runner = async (_c, args) => (args[0] === 'export' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Access is denied.' });
    const a = new Autostart({ platform: 'win32', exe: 'C:\\SwarmCast\\SwarmCast.exe', run, tmpDir: tempDir('sc-reg-') });
    // Act
    const status = await a.status();
    const turnOn = a.set(true);
    // Assert
    expect(status).toEqual({ supported: true, enabled: false });
    await expect(turnOn).rejects.toThrow(/Access is denied/);
  });
});
