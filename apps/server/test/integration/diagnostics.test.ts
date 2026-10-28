import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogExportResult } from '@swarmcast/shared';
import { decodeDesktopMessage, encodeShellMessage, type DesktopOutMessage } from '../../src/desktop/protocol.js';
import { allocAppPorts, Jar, spawnTracked, stopTracked, tmpDir, until, type Tracked } from './helpers.js';

// The real server from source, with a temporary data folder, HOME and Downloads folder
// (SWARMCAST_DOWNLOADS_DIR): never the user's own SwarmCast data or ~/Downloads.

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'apps/server/src/main.ts');
const VIEWER_IP = '203.0.113.99';

interface Started {
  proc: Tracked;
  stdout: string[];
  messages: DesktopOutMessage[];
  dataDir: string;
  downloads: string;
  home: string;
}

const procs: Tracked[] = [];
afterEach(async () => {
  // Graceful first (SwarmCast stops its MediaMTX), then whatever is left of the tree; the
  // stop confirms that nothing survived.
  await Promise.all(procs.splice(0).map((p) => p.stop({ graceMs: 10_000 })));
  await stopTracked();
});

function start(ports: Record<string, number>, args: string[]): Started {
  const dataDir = tmpDir('sc-diag-data-');
  const downloads = tmpDir('sc-diag-dl-');
  const home = tmpDir('sc-diag-home-');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ports, speedTest: { enabled: false, intervalMinutes: 15 }, tunnel: { provider: 'none' } }));
  // A log line with a viewer's IP address (as if written by an older run).
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'swarmcast.log.1'), JSON.stringify({ level: 'warn', msg: `viewer from ${VIEWER_IP} was rate-limited` }) + '\n');
  const proc = spawnTracked(process.execPath, ['--import', 'tsx', MAIN, '--no-tunnel', '--no-autostart', '--data-dir', dataDir, ...args], {
    name: 'SwarmCast',
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: '',
      SWARMCAST_NO_OPEN: '1',
      SWARMCAST_NO_FFMPEG_INSTALL: '1',
      SWARMCAST_LOG_LEVEL: 'info',
      SWARMCAST_DOWNLOADS_DIR: downloads,
      SWARMCAST_DESKTOP_VERSION: '9.9.9-test',
    },
  });
  procs.push(proc);
  const s: Started = { proc, stdout: [], messages: [], dataDir, downloads, home };
  proc.on('line', (line, stream) => {
    if (stream !== 'stdout') return;
    const msg = decodeDesktopMessage(line);
    if (msg) s.messages.push(msg);
    else s.stdout.push(line);
  });
  return s;
}

/** Wait for `pred` (checked on every output line); fails at once if the server exits. */
function waitOn(s: Started, pred: () => boolean, what: string): Promise<void> {
  return until(pred, { timeoutMs: 60_000, what, abortOn: [s.proc], on: [[s.proc, 'line']], detail: () => `last output: ${s.proc.tail(10)}` });
}

/** Open the ZIP and check that the secrets of this data folder are not in it. */
function checkZip(file: string, s: Started, token?: string): Record<string, string> {
  expect(path.dirname(file)).toBe(s.downloads);
  expect(path.basename(file)).toMatch(/^SwarmCast-logs-.+-\d{8}-\d{4}(-\d+)?\.zip$/);
  const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(fs.readFileSync(file)))).map(([k, v]) => [k, strFromU8(v)]));
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['about.txt', 'config.json', 'activity.txt', 'logs/swarmcast.log.1']));
  expect(Object.keys(files).some((k) => /^logs\/swarmcast-\d{4}-\d{2}-\d{2}\.log$/.test(k))).toBe(true);
  expect(Object.keys(files).some((k) => /secrets|state\.json/.test(k))).toBe(false);
  const all = Object.values(files).join('\n');
  expect(all).toContain('SwarmCast ready');
  const secrets = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'secrets.json'), 'utf8')) as { streamKey: string };
  expect(all).not.toContain(secrets.streamKey);
  expect(all).not.toContain('PRIVATE KEY');
  expect(all).not.toContain(VIEWER_IP);
  expect(all).not.toContain(s.home);
  if (token) expect(all).not.toContain(token);
  expect(files['logs/swarmcast.log.1']).toMatch(/viewer from ip-[0-9a-f]{8} was rate-limited/);
  return files;
}

describe('log export (real server)', () => {
  it('script mode: the panel API writes an anonymised ZIP to the Downloads folder', async () => {
    const ports = await allocAppPorts();
    const s = start(ports, ['--no-tray', '--no-open']);
    await waitOn(s, () => s.stdout.some((l) => l.includes('/auth/')), 'panel login URL');
    const login = /(http:\/\/127\.0\.0\.1:\d+)\/auth\/(\S+)/.exec(s.stdout.find((l) => l.includes('/auth/'))!)!;
    const base = login[1]!;
    const token = login[2]!;
    const jar = new Jar(base);
    // /auth/<token> answers 200 with a page that opens / itself (not a redirect: SameSite=Strict).
    expect((await jar.fetch(`/auth/${token}`)).status).toBe(200);
    const json = { origin: base, 'content-type': 'application/json' };

    // Produce some log lines (warnings go to the log file and the activity log).
    for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${ports.public}/join/not-a-valid-link-token-${i}`).catch(() => null);

    // CSRF: no Origin → refused.
    expect((await jar.fetch('/api/diagnostics/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const res = await jar.fetch('/api/diagnostics/export', { method: 'POST', headers: json, body: '{}' });
    expect(res.status).toBe(200);
    const r = (await res.json()) as LogExportResult;
    expect(r.fallback).toBe(false);
    const files = checkZip(r.path, s, token);
    expect(files['about.txt']).toContain('Mode: script');
    expect(files['about.txt']).toContain('Live phase: off');
    expect(JSON.parse(files['config.json']!).ports.rtmp).toBe(ports.rtmp);

    // Retention setting round trip (saved to config.json).
    const put = await jar.fetch('/api/diagnostics', { method: 'PUT', headers: json, body: JSON.stringify({ logRetentionDays: 21 }) });
    expect(await put.json()).toEqual({ logRetentionDays: 21 });
    expect(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'config.json'), 'utf8')).diagnostics).toEqual({ logRetentionDays: 21 });
  });

  it('desktop mode: {"type":"export-logs"} on stdin answers with the ZIP path', async () => {
    const ports = await allocAppPorts();
    const s = start(ports, ['--desktop']);
    await waitOn(s, () => s.messages.some((m) => m.type === 'ready'), 'ready');
    const ready = s.messages.find((m) => m.type === 'ready') as { adminUrl: string };
    s.proc.child.stdin!.write(encodeShellMessage({ type: 'export-logs' }));
    await waitOn(s, () => s.messages.some((m) => m.type === 'export-logs'), 'export-logs answer');
    const answer = s.messages.find((m) => m.type === 'export-logs') as { ok: boolean; path: string };
    expect(answer.ok).toBe(true);
    const files = checkZip(answer.path, s, ready.adminUrl.split('/auth/')[1]);
    expect(files['about.txt']).toContain('Mode: desktop app');
    expect(files['about.txt']).toContain('Desktop app version: 9.9.9-test');
    s.proc.child.stdin!.write(encodeShellMessage({ type: 'quit' }));
    expect((await s.proc.exited).code).toBe(0);
  });
});
