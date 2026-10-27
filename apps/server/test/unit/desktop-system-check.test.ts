import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSystemCheck, systemCheckSchema } from '../../src/admin/system-check-routes.js';
import {
  buildSystemCheck,
  findObs,
  formatDisk,
  formatMbps,
  formatRam,
  gatherSystemFacts,
  linuxOsInfo,
  macOsInfo,
  needsSystemCheck,
  parseOsRelease,
  viewerEstimate,
  windowsOsInfo,
  writeSystemCheck,
  type SystemFacts,
} from '../../src/desktop/system-check.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dsc-'));

const facts = (over: Partial<SystemFacts> = {}): SystemFacts => ({
  platform: 'darwin',
  os: { desc: 'macOS 15.1', status: 'ok', note: '' },
  arch: 'arm64',
  ramMB: 16384,
  cores: 8,
  diskBytes: 200 * 1024 ** 3,
  busyPorts: [],
  obs: '/Applications/OBS.app',
  githubOk: true,
  speed: { uploadMbps: 40.2, downloadMbps: 300 },
  appVersion: '0.2.0',
  ...over,
});

describe('operating system (same rules as the start scripts)', () => {
  it('Linux: Ubuntu 22.04+ / Debian 12+ ok, others warn with the scripts\' notes', () => {
    const rel = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n');
    expect(rel.PRETTY_NAME).toBe('Ubuntu 24.04.1 LTS');
    expect(linuxOsInfo(rel, '6.8.0')).toEqual({ desc: 'Ubuntu 24.04.1 LTS', status: 'ok', note: '' });
    expect(linuxOsInfo({ ...rel, VERSION_ID: '20.04' }, '5.4')).toMatchObject({ status: 'warn', note: 'Ubuntu 22.04 or newer is recommended' });
    expect(linuxOsInfo({ ID: 'debian', VERSION_ID: '12', PRETTY_NAME: 'Debian GNU/Linux 12 (bookworm)' }, '6.1')).toMatchObject({ status: 'ok' });
    expect(linuxOsInfo({ ID: 'debian', VERSION_ID: '11' }, '5.10')).toMatchObject({ status: 'warn', note: 'Debian 12 or newer is recommended' });
    expect(linuxOsInfo({ ID: 'linuxmint', ID_LIKE: 'ubuntu debian', PRETTY_NAME: 'Linux Mint 22' }, '6.8').note).toMatch(/^based on Ubuntu\/Debian but not tested/);
    expect(linuxOsInfo({ ID: 'fedora' }, '6.9')).toEqual({ desc: 'Linux 6.9', status: 'warn', note: 'not a tested distribution (tested: Ubuntu 22.04/24.04, Debian 12); it will probably work' });
    expect(linuxOsInfo(null, '6.9').desc).toBe('Linux 6.9');
  });

  it('macOS 12+ ok, older fails (below the minimum), unreadable warns', () => {
    expect(macOsInfo('15.1\n')).toEqual({ desc: 'macOS 15.1', status: 'ok', note: '' });
    expect(macOsInfo('11.7')).toEqual({ desc: 'macOS 11.7', status: 'bad', note: 'macOS 12 or newer is required' });
    expect(macOsInfo('')).toMatchObject({ desc: 'macOS unknown', status: 'warn' });
  });

  it('Windows: caption + build; Windows 11 by build number; Server warns', () => {
    expect(windowsOsInfo('10.0.22631', 'Windows 10 Pro')).toEqual({ desc: 'Windows 11 Pro (build 22631)', status: 'ok', note: '' });
    expect(windowsOsInfo('10.0.19045', 'Windows 10 Home')).toEqual({ desc: 'Windows 10 Home (build 19045)', status: 'ok', note: '' });
    expect(windowsOsInfo('10.0.20348', 'Windows Server 2022 Datacenter')).toMatchObject({ status: 'warn', note: expect.stringMatching(/Windows Server is not a tested edition/) });
    expect(windowsOsInfo('6.3.9600', 'Windows 8.1')).toMatchObject({ status: 'bad', note: 'Windows 10 or 11 is required' });
  });
});

describe('value texts', () => {
  it('formats like the scripts', () => {
    expect(formatRam(7982)).toBe('7.8 GB');
    expect(formatRam(16384)).toBe('16.0 GB');
    expect(formatDisk(100 * 1024 ** 3, 'linux')).toBe('100.0 GB');
    expect(formatDisk(300 * 1024 ** 2 + 5000, 'darwin')).toBe('300 MB');
    expect(formatDisk(1234.5 * 1024 ** 3, 'win32')).toBe('1,234.5 GB');
    expect(formatDisk(300.6 * 1024 ** 2, 'win32')).toBe('301 MB');
    expect(formatMbps(23, 'linux')).toBe('23.0');
    expect(formatMbps(23, 'win32')).toBe('23');
    expect(formatMbps(23.44, 'win32')).toBe('23.4');
    expect(viewerEstimate(40)).toBe(3);
    expect(viewerEstimate(5)).toBe(0);
  });
});

describe('buildSystemCheck', () => {
  it('writes the scripts\' ids, order, values and thresholds, plus appVersion/source', () => {
    const c = buildSystemCheck(facts(), new Date('2026-10-26T12:00:00.123Z'));
    expect(systemCheckSchema.safeParse(c).success).toBe(true);
    expect(c).toMatchObject({ version: 1, at: '2026-10-26T12:00:00Z', os: 'macOS 15.1', arch: 'arm64', uploadMbps: 40.2, downloadMbps: 300, viewerEstimate: 3, belowMinimum: [], appVersion: '0.2.0', source: 'desktop' });
    expect(c.results).toEqual([
      { id: 'os', status: 'ok', value: 'macOS 15.1 (arm64)', min: 'macOS 12', recommended: '', detail: '' },
      { id: 'ram', status: 'ok', value: '16.0 GB', min: '4 GB', recommended: '8 GB', detail: '' },
      { id: 'cpu', status: 'ok', value: '8', min: '2', recommended: '4', detail: '' },
      { id: 'upload', status: 'warn', value: '40.2 Mbps', min: '10 Mbps', recommended: '50 Mbps', detail: '' },
      { id: 'download', status: 'ok', value: '300.0 Mbps', min: '-', recommended: '-', detail: '' },
      { id: 'disk', status: 'ok', value: '200.0 GB', min: '500 MB', recommended: '', detail: '' },
      { id: 'ports', status: 'ok', value: 'free', min: '', recommended: '', detail: '' },
      { id: 'obs', status: 'ok', value: 'installed', min: '', recommended: '', detail: '' },
      { id: 'github', status: 'ok', value: 'reachable', min: '', recommended: '', detail: '' },
      { id: 'release', status: 'ok', value: 'v0.2.0 (desktop app)', min: '', recommended: '', detail: '' },
    ]);
    // The panel's parser keeps the new fields.
    expect(parseSystemCheck(JSON.stringify(c))?.appVersion).toBe('0.2.0');
  });

  it('marks what is below the minimum (fail) and warns between minimum and recommended', () => {
    const c = buildSystemCheck(
      facts({
        platform: 'win32',
        os: { desc: 'Windows 8.1 (build 9600)', status: 'bad', note: 'Windows 10 or 11 is required' },
        arch: 'x64',
        ramMB: 3000,
        cores: 1,
        diskBytes: 100 * 1024 ** 2,
        speed: { uploadMbps: 4, downloadMbps: 20 },
        busyPorts: [{ port: 1935 }, { port: 8080, owner: 'nginx (PID 4)' }],
        obs: null,
        githubOk: false,
      }),
    );
    expect(c.belowMinimum).toEqual(['os', 'ram', 'cpu', 'upload', 'disk']);
    const by = Object.fromEntries(c.results.map((r) => [r.id, r]));
    expect(by.os).toMatchObject({ status: 'fail', value: 'Windows 8.1 (build 9600)', min: 'Windows 10', detail: 'Windows 10 or 11 is required' });
    expect(by.ram).toMatchObject({ status: 'fail', value: '2.9 GB' });
    expect(by.cpu).toMatchObject({ status: 'fail', value: '1' });
    expect(by.upload).toMatchObject({ status: 'fail', value: '4 Mbps' });
    expect(by.disk).toMatchObject({ status: 'fail', value: '100 MB' });
    expect(by.ports).toEqual({ id: 'ports', status: 'warn', value: 'in use: 1935 8080', min: '', recommended: '', detail: 'port 1935 is used by another program; port 8080 is used by nginx (PID 4)' });
    expect(by.obs).toMatchObject({ status: 'warn', value: 'not found', detail: 'Install OBS Studio from https://obsproject.com to stream.' });
    expect(by.github).toMatchObject({ status: 'warn', value: 'unreachable (not needed)' });
    expect(c.viewerEstimate).toBe(0);
    expect(buildSystemCheck(facts({ ramMB: 6000, cores: 2 })).results.filter((r) => r.status === 'warn').map((r) => r.id)).toEqual(['ram', 'cpu', 'upload']);
  });

  it('speed test failed or skipped', () => {
    const failed = buildSystemCheck(facts({ speed: 'failed' }));
    expect(failed.results.filter((r) => ['upload', 'download'].includes(r.id))).toEqual([
      { id: 'upload', status: 'warn', value: 'speed test failed', min: '10 Mbps', recommended: '50 Mbps', detail: '' },
      { id: 'download', status: 'warn', value: 'speed test failed', min: '', recommended: '', detail: '' },
    ]);
    expect(failed).toMatchObject({ uploadMbps: null, downloadMbps: null, viewerEstimate: null });
    const skipped = buildSystemCheck(facts({ speed: 'skipped' }));
    expect(skipped.results.filter((r) => ['upload', 'download'].includes(r.id)).map((r) => [r.status, r.value])).toEqual([
      ['skipped', 'not measured (skipped)'],
      ['skipped', 'not measured (skipped)'],
    ]);
  });
});

describe('when the desktop app runs the check', () => {
  it('runs when the file is missing, invalid, from a start script or from another version', () => {
    const file = path.join(tmp(), 'system-check.json');
    expect(needsSystemCheck(file, '0.2.0')).toBe(true);
    fs.writeFileSync(file, '{broken');
    expect(needsSystemCheck(file, '0.2.0')).toBe(true);
    const c = buildSystemCheck(facts());
    const { appVersion: _v, source: _s, ...script } = c;
    fs.writeFileSync(file, JSON.stringify(script));
    expect(needsSystemCheck(file, '0.2.0')).toBe(true);
    writeSystemCheck(file, c);
    expect(needsSystemCheck(file, '0.2.0')).toBe(false);
    expect(needsSystemCheck(file, '0.3.0')).toBe(true);
  });
});

describe('gatherSystemFacts', () => {
  it('ports SwarmCast itself uses count as free; others are reported', async () => {
    const other = net.createServer();
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const busy = (other.address() as net.AddressInfo).port;
    const ours = net.createServer();
    await new Promise<void>((r) => ours.listen(0, '127.0.0.1', () => r()));
    const own = (ours.address() as net.AddressInfo).port;
    try {
      const f = await gatherSystemFacts({
        dataDir: tmp(),
        appVersion: '0.2.0',
        ports: [busy, own],
        ownPorts: () => [own],
        speed: async () => 'skipped',
        fetchImpl: (async () => new Response(null, { status: 301 })) as typeof fetch,
        exec: async () => ({ ok: false, stdout: '' }),
        env: { PATH: '' },
        home: tmp(),
        platform: 'linux',
      });
      expect(f.busyPorts.map((p) => p.port)).toContain(busy);
      expect(f.busyPorts.map((p) => p.port)).not.toContain(own);
      expect(f).toMatchObject({ platform: 'linux', githubOk: true, speed: 'skipped', obs: null, appVersion: '0.2.0' });
      expect(f.cores).toBeGreaterThan(0);
      expect(f.ramMB).toBeGreaterThan(0);
      expect(f.diskBytes).toBeGreaterThan(0);
    } finally {
      other.close();
      ours.close();
    }
  });

  it('a failed speed test and an unreachable github.com', async () => {
    const f = await gatherSystemFacts({
      dataDir: tmp(),
      appVersion: '0.2.0',
      ports: [],
      ownPorts: () => [],
      speed: async () => undefined,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
      exec: async () => ({ ok: true, stdout: '15.1' }),
      platform: 'darwin',
      home: tmp(),
    });
    expect(f).toMatchObject({ speed: 'failed', githubOk: false, os: { desc: 'macOS 15.1', status: 'ok' } });
  });
});

describe('findObs (same places as the scripts)', () => {
  it('macOS: /Applications or ~/Applications', async () => {
    const home = tmp();
    const r = await findObs('darwin', { home });
    expect(r === null || r === '/Applications/OBS.app').toBe(true);
    if (r === null) {
      fs.mkdirSync(path.join(home, 'Applications', 'OBS.app'), { recursive: true });
      expect(await findObs('darwin', { home })).toBe(path.join(home, 'Applications', 'OBS.app'));
    }
  });

  it('Linux: obs on PATH, else flatpak, else snap', async () => {
    const bin = tmp();
    const none = await findObs('linux', { env: { PATH: bin }, exec: async () => ({ ok: true, stdout: '' }) });
    expect(none).toBeNull();
    fs.writeFileSync(path.join(bin, 'flatpak'), '#!/bin/sh\n', { mode: 0o755 });
    const calls: string[] = [];
    expect(await findObs('linux', { env: { PATH: bin }, exec: async (c, a) => (calls.push([c, ...a].join(' ')), { ok: true, stdout: '' }) })).toBe('flatpak com.obsproject.Studio');
    expect(calls).toEqual(['flatpak info com.obsproject.Studio']);
    fs.writeFileSync(path.join(bin, 'obs'), '#!/bin/sh\n', { mode: 0o755 });
    expect(await findObs('linux', { env: { PATH: bin } })).toBe(path.join(bin, 'obs'));
  });

  it('Windows: registry keys via reg.exe query', async () => {
    const queried: string[] = [];
    const r = await findObs('win32', {
      env: {},
      exec: async (c, a) => {
        queried.push(a[1]!);
        return { ok: c === 'reg.exe' && a[1] === 'HKCU\\SOFTWARE\\OBS Studio', stdout: '' };
      },
    });
    expect(r).toBe('HKCU\\SOFTWARE\\OBS Studio');
    expect(queried.slice(0, 3)).toEqual(['HKLM\\SOFTWARE\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio', 'HKCU\\SOFTWARE\\OBS Studio']);
    expect(await findObs('win32', { env: {}, exec: async () => ({ ok: false, stdout: '' }) })).toBeNull();
  });
});
