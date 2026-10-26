import fs from 'node:fs';
import os from 'node:os';
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

const tmpHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-home-'));

describe('autostart entries (pure)', () => {
  it('Windows: quoted exe + --background, read back from a reg export', () => {
    const exe = 'C:\\Users\\João Silva\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';
    const cmd = windowsRunCommand(exe);
    expect(cmd).toBe(`"${exe}" --background`);
    expect(windowsCommandExe(cmd)).toBe(exe);
    expect(windowsCommandExe('C:\\x\\a.exe --flag')).toBe('C:\\x\\a.exe');
    // How `reg export` writes the value (backslashes and quotes escaped).
    const reg = `\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[${WINDOWS_RUN_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}]\r\n"OneDrive"="\\"C:\\\\od.exe\\" /background"\r\n"SwarmCast"="${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\r\n`;
    expect(parseRegExport(reg)).toBe(cmd);
    expect(parseRegExport(reg.replace('"SwarmCast"', '"Other"'))).toBeNull();
    expect(parseRegExport('"SwarmCast"=hex(2):43,00')).toBe('');
    expect(() => windowsRunCommand('C:\\a"b.exe')).toThrow();
    expect(() => windowsRunCommand('relative\\a.exe')).toThrow();
  });

  it('macOS: LaunchAgent plist with the label, the args and RunAtLoad; XML-escaped paths read back', () => {
    const exe = '/Applications/My "Apps" & <Tools>/SwarmCast.app/Contents/MacOS/SwarmCast';
    const plist = macLaunchAgentPlist(exe);
    expect(plist).toContain(`<string>${APP_ID}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<string>--background</string>');
    expect(plist).toContain('My &quot;Apps&quot; &amp; &lt;Tools&gt;');
    expect(macPlistExe(plist)).toBe(exe);
    expect(macPlistExe('<plist><dict><key>Program</key><string>/x/y</string></dict></plist>')).toBe('/x/y');
    expect(macPlistExe('<plist/>')).toBeNull();
  });

  it('Linux: Exec quoting per the Desktop Entry spec (spaces, quotes, $, `, \\, %)', () => {
    expect(desktopExecValue('/opt/Swarm Cast/swarmcast-desktop')).toBe('"/opt/Swarm Cast/swarmcast-desktop" --background');
    expect(desktopExecValue('/home/a"b/$x`y`/100%/c\\d')).toBe('"/home/a\\\\"b/\\\\$x\\\\`y\\\\`/100%%/c\\\\\\\\d" --background');
    for (const exe of ['/opt/Swarm Cast/swarmcast-desktop', '/home/a"b/$x`y`/100%/c\\d', '/home/zé/Apps/SwarmCast.AppImage']) {
      const entry = linuxDesktopEntry(exe);
      expect(entry).toMatch(/^\[Desktop Entry\]\nType=Application\n/);
      expect(entry).toContain('X-GNOME-Autostart-enabled=true');
      expect(linuxEntryExe(entry)).toBe(exe);
      // TryExec: the bare path (string escaping only), so a removed app is skipped at login.
      expect(entry).toContain(`\nTryExec=${exe.replace(/\\/g, '\\\\')}\nExec=`);
    }
    expect(desktopTryExecValue('/opt/Swarm Cast/swarmcast-desktop')).toBe('/opt/Swarm Cast/swarmcast-desktop');
    expect(desktopTryExecValue('/home/a"b/$x`y`/100%/c\\d')).toBe('/home/a"b/$x`y`/100%/c\\\\d');
    expect(linuxDesktopEntry('/usr/bin/swarmcast-desktop')).toContain('\nTryExec=/usr/bin/swarmcast-desktop\nExec="/usr/bin/swarmcast-desktop" --background\n');
    expect(linuxEntryExe('[Desktop Entry]\nExec=/usr/bin/swarmcast-desktop --background\n')).toBe('/usr/bin/swarmcast-desktop');
    expect(linuxEntryExe('[Desktop Entry]\nExec=/x --background\nHidden=true\n')).toBeNull();
    expect(linuxEntryExe('[Desktop Entry]\nExec=/x\nX-GNOME-Autostart-enabled=false\n')).toBeNull();
    expect(linuxEntryExe('[Other]\nExec=/x\n')).toBeNull();
  });

  it('refuses relative paths and control characters', () => {
    expect(() => checkExePath('swarmcast')).toThrow();
    expect(() => checkExePath('/a\nb')).toThrow();
    expect(() => linuxDesktopEntry('/a\tb')).toThrow();
    expect(() => macLaunchAgentPlist('')).toThrow();
  });
});

describe('Autostart (file-based OSes, temporary HOME)', () => {
  it('is unsupported without the app path, and off by default', async () => {
    const home = tmpHome();
    expect(await new Autostart({ platform: 'linux', home }).status()).toEqual({ supported: false, enabled: false });
    await expect(new Autostart({ platform: 'linux', home }).set(true)).rejects.toThrow(/desktop app/);
    expect(await new Autostart({ platform: 'linux', home, exe: '/opt/sc/swarmcast-desktop', env: {} }).status()).toEqual({ supported: true, enabled: false });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('macOS: writes and removes the LaunchAgent; an entry for another copy is stale and rewritten', async () => {
    const home = tmpHome();
    const exe = '/Applications/Swarm Cast.app/Contents/MacOS/SwarmCast';
    const a = new Autostart({ platform: 'darwin', home, exe });
    const file = path.join(home, 'Library', 'LaunchAgents', `${APP_ID}.plist`);
    expect(a.entryFile()).toBe(file);
    expect(await a.set(true)).toEqual({ supported: true, enabled: true });
    expect(macPlistExe(fs.readFileSync(file, 'utf8'))).toBe(exe);

    fs.writeFileSync(file, macLaunchAgentPlist('/Volumes/Old/SwarmCast.app/Contents/MacOS/SwarmCast'));
    expect(await a.status()).toEqual({ supported: true, enabled: true, stale: true });
    expect(await a.set(true)).toEqual({ supported: true, enabled: true });
    expect(macPlistExe(fs.readFileSync(file, 'utf8'))).toBe(exe);

    expect(await a.set(false)).toEqual({ supported: true, enabled: false });
    expect(fs.existsSync(file)).toBe(false);
    expect(await a.set(false)).toEqual({ supported: true, enabled: false });
  });

  it('Linux: honours XDG_CONFIG_HOME (absolute only), defaults to ~/.config', async () => {
    const home = tmpHome();
    const exe = '/home/me/Apps/SwarmCast x64.AppImage';
    const def = new Autostart({ platform: 'linux', home, exe, env: {} });
    expect(def.entryFile()).toBe(path.join(home, '.config', 'autostart', 'swarmcast.desktop'));
    expect(new Autostart({ platform: 'linux', home, exe, env: { XDG_CONFIG_HOME: 'relative' } }).entryFile()).toBe(def.entryFile());

    const xdg = path.join(home, 'xdg');
    const a = new Autostart({ platform: 'linux', home, exe, env: { XDG_CONFIG_HOME: xdg } });
    const file = path.join(xdg, 'autostart', 'swarmcast.desktop');
    expect(a.entryFile()).toBe(file);
    expect(await a.set(true)).toEqual({ supported: true, enabled: true });
    expect(linuxEntryExe(fs.readFileSync(file, 'utf8'))).toBe(exe);
    // Turned off by the desktop's own settings app: reads as off.
    fs.appendFileSync(file, 'Hidden=true\n');
    expect(await a.status()).toEqual({ supported: true, enabled: false });
    expect(await a.set(false)).toEqual({ supported: true, enabled: false });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('Autostart on Windows (reg.exe faked)', () => {
  /** A fake registry Run key driven through the same reg.exe arguments. */
  function fakeReg(initial?: string): { run: Runner; calls: string[][]; value: () => string | undefined } {
    let value = initial;
    const calls: string[][] = [];
    const run: Runner = async (command, args) => {
      calls.push([command, ...args]);
      expect(command).toBe('reg.exe');
      expect(args[1]).toBe(WINDOWS_RUN_KEY);
      if (args[0] === 'export') {
        const lines = ['Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]'];
        if (value !== undefined) lines.push(`"SwarmCast"="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        fs.writeFileSync(args[2]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add') {
        expect(args.slice(2)).toEqual(['/v', 'SwarmCast', '/t', 'REG_SZ', '/d', args[7], '/f']);
        value = args[7];
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete') {
        value = undefined;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { run, calls, value: () => value };
  }

  it('adds, reads back (UTF-16, accents), rewrites a stale entry and deletes the Run value', async () => {
    const exe = 'C:\\Users\\João\\AppData\\Local\\Programs\\SwarmCast\\SwarmCast.exe';
    const reg = fakeReg();
    const a = new Autostart({ platform: 'win32', exe, run: reg.run });
    expect(await a.status()).toEqual({ supported: true, enabled: false });
    expect(await a.set(true)).toEqual({ supported: true, enabled: true });
    expect(reg.value()).toBe(`"${exe}" --background`);

    const old = fakeReg('"D:\\Old\\SwarmCast.exe" --background');
    const b = new Autostart({ platform: 'win32', exe, run: old.run });
    expect(await b.status()).toEqual({ supported: true, enabled: true, stale: true });
    // Same path in another case is the same file on Windows.
    expect(await new Autostart({ platform: 'win32', exe: exe.toUpperCase(), run: reg.run }).status()).toEqual({ supported: true, enabled: true });
    await b.set(true);
    expect(old.value()).toBe(`"${exe}" --background`);

    expect(await a.set(false)).toEqual({ supported: true, enabled: false });
    expect(reg.value()).toBeUndefined();
    // Nothing to delete: no reg delete call.
    const before = reg.calls.length;
    await a.set(false);
    expect(reg.calls.slice(before).map((c) => c[1])).not.toContain('delete');
  });

  it('reports reg.exe failures', async () => {
    const run: Runner = async (_c, args) => (args[0] === 'export' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Access is denied.' });
    const a = new Autostart({ platform: 'win32', exe: 'C:\\SwarmCast\\SwarmCast.exe', run });
    expect(await a.status()).toEqual({ supported: true, enabled: false });
    await expect(a.set(true)).rejects.toThrow(/Access is denied/);
  });
});
