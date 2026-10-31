import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
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
  type Platform,
  type SystemFacts,
} from '../../src/desktop/system-check.js';
import { tempDir } from './helpers.js';

// The desktop app's first-run system check: the same checks, values, thresholds and file
// (system-check.json) as the start scripts, from facts gathered with injected probes.

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

/** A TCP server on a port the OS picks (127.0.0.1), closed when the test finishes. */
async function listening(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  onTestFinished(() => new Promise<void>((r) => srv.close(() => r())));
  return (srv.address() as net.AddressInfo).port;
}

describe('operating system (same rules as the start scripts)', () => {
  const UBUNTU = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n');

  it('reads /etc/os-release', () => {
    // Assert
    expect(UBUNTU.PRETTY_NAME).toBe('Ubuntu 24.04.1 LTS');
  });

  it('Linux: Ubuntu 22.04+ and Debian 12+ are ok', () => {
    // Act
    const ubuntu = linuxOsInfo(UBUNTU, '6.8.0');
    const debian = linuxOsInfo({ ID: 'debian', VERSION_ID: '12', PRETTY_NAME: 'Debian GNU/Linux 12 (bookworm)' }, '6.1');
    // Assert
    expect(ubuntu).toEqual({ desc: 'Ubuntu 24.04.1 LTS', status: 'ok', note: '' });
    expect(debian).toMatchObject({ status: 'ok' });
  });

  it.each([
    ['Ubuntu 20.04', { ...UBUNTU, VERSION_ID: '20.04' }, '5.4', expect.objectContaining({ status: 'warn', note: 'Ubuntu 22.04 or newer is recommended' })],
    ['Debian 11', { ID: 'debian', VERSION_ID: '11' }, '5.10', expect.objectContaining({ status: 'warn', note: 'Debian 12 or newer is recommended' })],
    ['Fedora', { ID: 'fedora' }, '6.9', { desc: 'Linux 6.9', status: 'warn', note: 'not a tested distribution (tested: Ubuntu 22.04/24.04, Debian 12); it will probably work' }],
  ])("Linux: %s warns with the scripts' note", (_what, rel, kernel, info) => {
    // Act
    const i = linuxOsInfo(rel, kernel);
    // Assert
    expect(i).toEqual(info);
  });

  it('Linux: a derivative of Ubuntu/Debian warns as such; no os-release falls back to the kernel', () => {
    // Act
    const mint = linuxOsInfo({ ID: 'linuxmint', ID_LIKE: 'ubuntu debian', PRETTY_NAME: 'Linux Mint 22' }, '6.8');
    const unknown = linuxOsInfo(null, '6.9');
    // Assert
    expect(mint.note).toMatch(/^based on Ubuntu\/Debian but not tested/);
    expect(unknown.desc).toBe('Linux 6.9');
  });

  it.each([
    ['15.1\n', { desc: 'macOS 15.1', status: 'ok', note: '' }],
    ['11.7', { desc: 'macOS 11.7', status: 'bad', note: 'macOS 12 or newer is required' }],
    ['', expect.objectContaining({ desc: 'macOS unknown', status: 'warn' })],
  ])('macOS 12+ ok, older fails (below the minimum), unreadable warns: %j', (version, info) => {
    // Act
    const i = macOsInfo(version);
    // Assert
    expect(i).toEqual(info);
  });

  it.each([
    ['10.0.22631', 'Windows 10 Pro', { desc: 'Windows 11 Pro (build 22631)', status: 'ok', note: '' }],
    ['10.0.19045', 'Windows 10 Home', { desc: 'Windows 10 Home (build 19045)', status: 'ok', note: '' }],
    ['10.0.20348', 'Windows Server 2022 Datacenter', expect.objectContaining({ status: 'warn', note: expect.stringMatching(/Windows Server is not a tested edition/) })],
    ['6.3.9600', 'Windows 8.1', expect.objectContaining({ status: 'bad', note: 'Windows 10 or 11 is required' })],
  ])('Windows %s %s: caption + build, Windows 11 by build number, Server warns', (release, caption, info) => {
    // Act
    const i = windowsOsInfo(release, caption);
    // Assert
    expect(i).toEqual(info);
  });
});

describe('value texts', () => {
  it.each([
    [7982, '7.8 GB'],
    [16384, '16.0 GB'],
  ])('formats %d MB of RAM like the scripts: %s', (mb, text) => {
    // Act
    const t = formatRam(mb);
    // Assert
    expect(t).toBe(text);
  });

  it.each<[number, Platform, string]>([
    [100 * 1024 ** 3, 'linux', '100.0 GB'],
    [300 * 1024 ** 2 + 5000, 'darwin', '300 MB'],
    [1234.5 * 1024 ** 3, 'win32', '1,234.5 GB'],
    [300.6 * 1024 ** 2, 'win32', '301 MB'],
  ])('formats %d bytes of disk on %s like the scripts: %s', (bytes, platform, text) => {
    // Act
    const t = formatDisk(bytes, platform);
    // Assert
    expect(t).toBe(text);
  });

  it.each<[number, Platform, string]>([
    [23, 'linux', '23.0'],
    [23, 'win32', '23'],
    [23.44, 'win32', '23.4'],
  ])('formats %d Mbps on %s like the scripts: %s', (mbps, platform, text) => {
    // Act
    const t = formatMbps(mbps, platform);
    // Assert
    expect(t).toBe(text);
  });

  it.each([
    [40, 3],
    [5, 0],
  ])('estimates %d Mbps of upload as %d viewers', (mbps, viewers) => {
    // Act
    const n = viewerEstimate(mbps);
    // Assert
    expect(n).toBe(viewers);
  });
});

describe('buildSystemCheck', () => {
  it("writes the scripts' ids, order, values and thresholds, plus appVersion/source", () => {
    // Act
    const c = buildSystemCheck(facts(), new Date('2026-10-26T12:00:00.123Z'));
    // Assert
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
  });

  it("the panel's parser keeps the desktop fields", () => {
    // Arrange
    const c = buildSystemCheck(facts(), new Date('2026-10-26T12:00:00.123Z'));
    // Act
    const parsed = parseSystemCheck(JSON.stringify(c));
    // Assert
    expect(parsed?.appVersion).toBe('0.2.0');
  });

  it('marks what is below the minimum (fail)', () => {
    // Act
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
    // Assert
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
  });

  it('warns between the minimum and the recommended values', () => {
    // Act
    const c = buildSystemCheck(facts({ ramMB: 6000, cores: 2 }));
    // Assert
    expect(c.results.filter((r) => r.status === 'warn').map((r) => r.id)).toEqual(['ram', 'cpu', 'upload']);
  });

  it('speed test failed', () => {
    // Act
    const failed = buildSystemCheck(facts({ speed: 'failed' }));
    // Assert
    expect(failed.results.filter((r) => ['upload', 'download'].includes(r.id))).toEqual([
      { id: 'upload', status: 'warn', value: 'speed test failed', min: '10 Mbps', recommended: '50 Mbps', detail: '' },
      { id: 'download', status: 'warn', value: 'speed test failed', min: '', recommended: '', detail: '' },
    ]);
    expect(failed).toMatchObject({ uploadMbps: null, downloadMbps: null, viewerEstimate: null });
  });

  it('speed test skipped', () => {
    // Act
    const skipped = buildSystemCheck(facts({ speed: 'skipped' }));
    // Assert
    expect(skipped.results.filter((r) => ['upload', 'download'].includes(r.id)).map((r) => [r.status, r.value])).toEqual([
      ['skipped', 'not measured (skipped)'],
      ['skipped', 'not measured (skipped)'],
    ]);
  });
});

describe('when the desktop app runs the check', () => {
  const file = (): string => path.join(tempDir('sc-dsc-'), 'system-check.json');

  it('runs when the file is missing or invalid', () => {
    // Arrange
    const missing = file();
    const broken = file();
    fs.writeFileSync(broken, '{broken');
    // Act
    const needs = [needsSystemCheck(missing, '0.2.0'), needsSystemCheck(broken, '0.2.0')];
    // Assert
    expect(needs).toEqual([true, true]);
  });

  it('runs when the file comes from a start script (no appVersion/source)', () => {
    // Arrange
    const f = file();
    const { appVersion: _v, source: _s, ...script } = buildSystemCheck(facts());
    fs.writeFileSync(f, JSON.stringify(script));
    // Act
    const needs = needsSystemCheck(f, '0.2.0');
    // Assert
    expect(needs).toBe(true);
  });

  it('skips a check of this version, runs again for another one', () => {
    // Arrange
    const f = file();
    writeSystemCheck(f, buildSystemCheck(facts()));
    // Act
    const same = needsSystemCheck(f, '0.2.0');
    const next = needsSystemCheck(f, '0.3.0');
    // Assert
    expect(same).toBe(false);
    expect(next).toBe(true);
  });
});

describe('gatherSystemFacts', () => {
  it('ports SwarmCast itself uses count as free; others are reported', async () => {
    // Arrange
    const busy = await listening();
    const own = await listening();
    // Act
    const f = await gatherSystemFacts({
      dataDir: tempDir('sc-dsc-'),
      appVersion: '0.2.0',
      ports: [busy, own],
      ownPorts: () => [own],
      speed: async () => 'skipped',
      fetchImpl: (async () => new Response(null, { status: 301 })) as typeof fetch,
      exec: async () => ({ ok: false, stdout: '' }),
      env: { PATH: '' },
      home: tempDir('sc-home-'),
      platform: 'linux',
    });
    // Assert
    expect(f.busyPorts.map((p) => p.port)).toContain(busy);
    expect(f.busyPorts.map((p) => p.port)).not.toContain(own);
    expect(f).toMatchObject({ platform: 'linux', githubOk: true, speed: 'skipped', obs: null, appVersion: '0.2.0' });
    expect(f.cores).toBeGreaterThan(0);
    expect(f.ramMB).toBeGreaterThan(0);
    expect(f.diskBytes).toBeGreaterThan(0);
  });

  it('a failed speed test and an unreachable github.com', async () => {
    // Act
    const f = await gatherSystemFacts({
      dataDir: tempDir('sc-dsc-'),
      appVersion: '0.2.0',
      ports: [],
      ownPorts: () => [],
      speed: async () => undefined,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
      exec: async () => ({ ok: true, stdout: '15.1' }),
      platform: 'darwin',
      home: tempDir('sc-home-'),
    });
    // Assert
    expect(f).toMatchObject({ speed: 'failed', githubOk: false, os: { desc: 'macOS 15.1', status: 'ok' } });
  });
});

describe('findObs (same places as the scripts)', () => {
  it('macOS: not found in either Applications folder', async () => {
    // Act
    const r = await findObs('darwin', { home: tempDir('sc-home-'), applications: tempDir('sc-apps-') });
    // Assert
    expect(r).toBeNull();
  });

  it('macOS: ~/Applications/OBS.app', async () => {
    // Arrange
    const home = tempDir('sc-home-');
    fs.mkdirSync(path.join(home, 'Applications', 'OBS.app'), { recursive: true });
    // Act
    const r = await findObs('darwin', { home, applications: tempDir('sc-apps-') });
    // Assert
    expect(r).toBe(path.join(home, 'Applications', 'OBS.app'));
  });

  it('macOS: the system Applications folder comes first', async () => {
    // Arrange
    const home = tempDir('sc-home-');
    const applications = tempDir('sc-apps-');
    fs.mkdirSync(path.join(home, 'Applications', 'OBS.app'), { recursive: true });
    fs.mkdirSync(path.join(applications, 'OBS.app'));
    // Act
    const r = await findObs('darwin', { home, applications });
    // Assert
    expect(r).toBe(path.join(applications, 'OBS.app'));
  });

  it('Linux: none on PATH, no flatpak, no snap', async () => {
    // Act
    const r = await findObs('linux', { env: { PATH: tempDir('sc-bin-') }, exec: async () => ({ ok: true, stdout: '' }) });
    // Assert
    expect(r).toBeNull();
  });

  it('Linux: the flatpak, asked with flatpak info', async () => {
    // Arrange
    const bin = tempDir('sc-bin-');
    fs.writeFileSync(path.join(bin, 'flatpak'), '#!/bin/sh\n', { mode: 0o755 });
    const calls: string[] = [];
    // Act
    const r = await findObs('linux', { env: { PATH: bin }, exec: async (c, a) => (calls.push([c, ...a].join(' ')), { ok: true, stdout: '' }) });
    // Assert
    expect(r).toBe('flatpak com.obsproject.Studio');
    expect(calls).toEqual(['flatpak info com.obsproject.Studio']);
  });

  it('Linux: obs on PATH comes first', async () => {
    // Arrange
    const bin = tempDir('sc-bin-');
    fs.writeFileSync(path.join(bin, 'flatpak'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'obs'), '#!/bin/sh\n', { mode: 0o755 });
    // Act
    const r = await findObs('linux', { env: { PATH: bin } });
    // Assert
    expect(r).toBe(path.join(bin, 'obs'));
  });

  it('Windows: registry keys via reg.exe query, in the scripts\' order', async () => {
    // Arrange
    const queried: string[] = [];
    // Act
    const r = await findObs('win32', {
      env: {},
      exec: async (c, a) => {
        queried.push(a[1]!);
        return { ok: c === 'reg.exe' && a[1] === 'HKCU\\SOFTWARE\\OBS Studio', stdout: '' };
      },
    });
    // Assert
    expect(r).toBe('HKCU\\SOFTWARE\\OBS Studio');
    expect(queried.slice(0, 3)).toEqual(['HKLM\\SOFTWARE\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio', 'HKCU\\SOFTWARE\\OBS Studio']);
  });

  it('Windows: nothing in the registry and no Program Files folder', async () => {
    // Act
    const r = await findObs('win32', { env: {}, exec: async () => ({ ok: false, stdout: '' }) });
    // Assert
    expect(r).toBeNull();
  });
});
