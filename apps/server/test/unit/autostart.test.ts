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
  parseRegQuery,
  windowsCommandExe,
  windowsRunCommand,
  WINDOWS_QUERY_LINE,
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

  it('Windows: reads the SwarmCast value from reg query output, and nothing else', () => {
    // Arrange
    const cmd = windowsRunCommand('C:\\Users\\João Silva\\日本\\SwarmCast.exe');
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    SwarmCast    REG_SZ    ${cmd}\r\n\r\n`;
    // Act
    const ours = parseRegQuery(out);
    const otherCase = parseRegQuery(out.replace('SwarmCast ', 'swarmcast '));
    const expandable = parseRegQuery(out.replace('REG_SZ', 'REG_EXPAND_SZ'));
    const others = parseRegQuery(out.replace('SwarmCast ', 'Other '));
    const empty = parseRegQuery('    SwarmCast    REG_SZ    \r\n');
    const notAString = parseRegQuery('    SwarmCast    REG_BINARY    4300\r\n');
    // Assert
    expect(ours).toBe(cmd);
    expect(otherCase).toBe(cmd);
    expect(expandable).toBe(cmd);
    expect(others).toBeNull();
    expect(empty).toBe('');
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

  it('Linux: the same file through a link (a junction on Windows) is not another copy', async () => {
    // Arrange
    const home = tempDir('sc-home-');
    const exe = path.join(home, 'Apps', 'swarmcast-desktop');
    fs.mkdirSync(path.dirname(exe));
    fs.writeFileSync(exe, '');
    fs.symlinkSync(path.dirname(exe), path.join(home, 'Linked'), 'junction');
    await new Autostart({ platform: 'linux', home, exe, env: {} }).set(true);
    const sameFile = new Autostart({ platform: 'linux', home, exe: path.join(home, 'Linked', 'swarmcast-desktop'), env: {} });
    const otherFile = new Autostart({ platform: 'linux', home, exe: path.join(home, 'Other', 'swarmcast-desktop'), env: {} });
    // Act
    const same = await sameFile.status();
    const other = await otherFile.status();
    // Assert
    expect(same).toEqual({ supported: true, enabled: true });
    expect(other).toEqual({ supported: true, enabled: true, stale: true });
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
  const NOT_FOUND = 'ERROR: The system was unable to find the specified registry key or value.\r\n';
  const KEY_LINE = WINDOWS_RUN_KEY.replace('HKCU', 'HKEY_CURRENT_USER');

  /**
   * A fake HKCU Run key behind the commands Autostart may use, modelled on the registry API under
   * them: `reg query /v` (through cmd.exe, UTF-8) reads one value by its name; `reg export` walks the
   * values by index and writes them as UTF-16 with a BOM, and `onEnumerate(i)` runs after it read
   * index i (another program changing the key meanwhile); `add` sets a value, `delete` removes one.
   * Anything else fails like reg.exe would. Every call is recorded.
   */
  function fakeReg(initial: Array<[string, string]> = []) {
    const values = [...initial];
    const calls: string[][] = [];
    const hooks: { onEnumerate?: (i: number) => void; keepAdds: boolean } = { keepAdds: true };
    const find = (name: string): number => values.findIndex(([n]) => n.toLowerCase() === name.toLowerCase());
    const run: Runner = async (command, args, options) => {
      calls.push([command, ...args]);
      if (command === 'cmd.exe' && options?.verbatim && args.join(' ') === `/d /s /c "${WINDOWS_QUERY_LINE}"`) {
        const i = find('SwarmCast');
        if (i < 0) return { code: 1, stdout: '\r\n', stderr: NOT_FOUND };
        return { code: 0, stdout: `\r\n${KEY_LINE}\r\n    ${values[i]![0]}    REG_SZ    ${values[i]![1]}\r\n\r\n`, stderr: '' };
      }
      if (command !== 'reg.exe' || args[1] !== WINDOWS_RUN_KEY) return { code: 1, stdout: '', stderr: 'ERROR: unexpected command' };
      if (args[0] === 'export') {
        const lines = ['Windows Registry Editor Version 5.00', '', `[${KEY_LINE}]`];
        for (let i = 0; i < values.length; i++) {
          lines.push(`${regString(values[i]![0])}=${regString(values[i]![1])}`);
          hooks.onEnumerate?.(i);
        }
        fs.writeFileSync(args[2]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add' && args[2] === '/v') {
        const i = find(args[3]!);
        if (!hooks.keepAdds) return { code: 0, stdout: '', stderr: '' };
        if (i >= 0) values[i] = [values[i]![0], args[7]!];
        else values.push([args[3]!, args[7]!]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete' && args[2] === '/v') {
        const i = find(args[3]!);
        if (i < 0) return { code: 1, stdout: '', stderr: NOT_FOUND };
        values.splice(i, 1);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'ERROR: unexpected command' };
    };
    return { run, calls, hooks, values, value: () => values[find('SwarmCast')]?.[1] };
  }

  const EXE = 'C:\\Users\\João\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';

  it('adds the Run value with reg add and reads it back by name (accents)', async () => {
    // Arrange
    const reg = fakeReg();
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run });
    // Act
    const before = await a.status();
    const on = await a.set(true);
    // Assert
    expect(before).toEqual({ supported: true, enabled: false });
    expect(on).toEqual({ supported: true, enabled: true });
    expect(reg.value()).toBe(`"${EXE}" --background`);
    expect(reg.calls.filter((c) => c[1] === 'add')).toEqual([['reg.exe', 'add', WINDOWS_RUN_KEY, '/v', 'SwarmCast', '/t', 'REG_SZ', '/d', `"${EXE}" --background`, '/f']]);
  });

  // On a windows-latest runner, `reg export` (which walks the key by index) left the value out, with
  // exit code 0, while another process added and removed other Run values: the value moved to an
  // index the walk had already passed.
  it('reads its value back while another program adds and removes the other Run values', async () => {
    // Arrange
    const reg = fakeReg([['OneDrive', '"C:\\od.exe" /background']]);
    reg.hooks.onEnumerate = (i) => {
      if (i === 0 && reg.values.length > 1) reg.values.push(reg.values.shift()!);
    };
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run });
    // Act
    const on = await a.set(true);
    const off = await a.set(false);
    // Assert
    expect(on).toEqual({ supported: true, enabled: true });
    expect(off).toEqual({ supported: true, enabled: false });
    expect(reg.value()).toBeUndefined();
    expect(reg.values.map(([n]) => n)).toEqual(['OneDrive']);
  });

  it('an entry for another copy is stale and rewritten; the same path in another case or with \\\\?\\ is the same file', async () => {
    // Arrange
    const old = fakeReg([['SwarmCast', '"D:\\Old\\SwarmCast.exe" --background']]);
    const a = new Autostart({ platform: 'win32', exe: EXE, run: old.run });
    // Act
    const stale = await a.status();
    await a.set(true);
    const upperCase = await new Autostart({ platform: 'win32', exe: EXE.toUpperCase(), run: old.run }).status();
    const extendedLength = await new Autostart({ platform: 'win32', exe: `\\\\?\\${EXE}`, run: old.run }).status();
    // Assert
    expect(stale).toEqual({ supported: true, enabled: true, stale: true });
    expect(old.value()).toBe(`"${EXE}" --background`);
    expect(upperCase).toEqual({ supported: true, enabled: true });
    expect(extendedLength).toEqual({ supported: true, enabled: true });
  });

  it('deletes the Run value, and calls no reg delete when there is nothing to delete', async () => {
    // Arrange
    const reg = fakeReg([['SwarmCast', `"${EXE}" --background`]]);
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run });
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

  it('every command reads or changes only the SwarmCast value of the current user\'s Run key', async () => {
    // Arrange
    const reg = fakeReg();
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run });
    // Act
    await a.set(true);
    await a.set(false);
    // Assert
    expect(reg.calls.length).toBeGreaterThan(0);
    for (const c of reg.calls) {
      expect(c[0] === 'cmd.exe' ? c.slice(1) : c.slice(0, 5)).toEqual(c[0] === 'cmd.exe' ? ['/d', '/s', '/c', `"${WINDOWS_QUERY_LINE}"`] : ['reg.exe', c[1], WINDOWS_RUN_KEY, '/v', 'SwarmCast']);
    }
    expect(WINDOWS_QUERY_LINE).toBe(`chcp 65001 >nul & reg.exe query "${WINDOWS_RUN_KEY}" /v SwarmCast`);
  });

  it('says what it read back when the new value is not there (removed by another program)', async () => {
    // Arrange
    const reg = fakeReg();
    reg.hooks.keepAdds = false;
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run });
    // Act
    const turnOn = a.set(true);
    // Assert
    await expect(turnOn).rejects.toThrow(`The new autostart entry did not read back as expected (no SwarmCast value (reg query exit 1: ${NOT_FOUND.trim()})).`);
  });

  it('says what it read back when the value starts another program', async () => {
    // Arrange
    const reg = fakeReg([['SwarmCast', `"${EXE}" --background`]]);
    const other = new Autostart({ platform: 'win32', exe: 'D:\\Other\\SwarmCast.exe', run: reg.run });
    const a = new Autostart({ platform: 'win32', exe: EXE, run: reg.run });
    reg.hooks.keepAdds = false;
    // Act
    const turnOn = other.set(true);
    const status = await a.status();
    // Assert
    await expect(turnOn).rejects.toThrow(`(the Run value is ${JSON.stringify(`"${EXE}" --background`)}).`);
    expect(status).toEqual({ supported: true, enabled: true });
  });

  it('reports reg.exe failures; output it cannot read is an error, not "off"', async () => {
    // Arrange
    const denied: Runner = async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' });
    const garbled: Runner = async () => ({ code: 0, stdout: '\r\nHKEY_CURRENT_USER\\...\r\n    SwarmCast REG_SZ x\r\n', stderr: '' });
    const exe = 'C:\\SwarmCast\\SwarmCast.exe';
    // Act
    const status = await new Autostart({ platform: 'win32', exe, run: denied }).status();
    const turnOn = new Autostart({ platform: 'win32', exe, run: denied }).set(true);
    const unreadable = await new Autostart({ platform: 'win32', exe, run: garbled }).status();
    // Assert
    expect(status).toEqual({ supported: true, enabled: false });
    await expect(turnOn).rejects.toThrow(/Access is denied/);
    expect(unreadable).toMatchObject({ supported: true, enabled: false, error: expect.stringMatching(/printed no data/) });
  });
});
