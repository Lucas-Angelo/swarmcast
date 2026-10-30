import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogExportResult } from '@swarmcast/shared';
import type { DesktopOutMessage } from '../../src/desktop/protocol.js';
import { allocAppPorts, Jar, ServerProcess, stopTracked, tmpDir, writeConfig, type Ports } from './helpers.js';

// "Export logs" on the real server, with its own data folder, HOME and Downloads folder
// (SWARMCAST_DOWNLOADS_DIR): never the user's own SwarmCast data or ~/Downloads.
// The data folder starts with a log line from an older run holding a viewer's IP address: the
// export must carry it anonymised, next to this run's own log file.

const VIEWER_IP = '203.0.113.99';

const servers: ServerProcess[] = [];
afterEach(async () => {
  // Graceful first (SwarmCast stops its MediaMTX), then whatever is left of the tree; the stop
  // confirms that nothing survived.
  await Promise.all(servers.splice(0).map((s) => s.proc.stop({ graceMs: 10_000 })));
  await stopTracked();
});

/** SwarmCast on `ports` (no live: --no-autostart), its data folder holding an older run's log. */
function start(ports: Ports, args: string[]): ServerProcess {
  const dataDir = tmpDir('sc-diag-data-');
  writeConfig(dataDir, ports);
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'swarmcast.log.1'), JSON.stringify({ level: 'warn', msg: `viewer from ${VIEWER_IP} was rate-limited` }) + '\n');
  const server = new ServerProcess({ args: ['--no-tunnel', '--no-autostart', ...args], dataDir, stdin: true, env: { SWARMCAST_LOG_LEVEL: 'info', SWARMCAST_DESKTOP_VERSION: '9.9.9-test' } });
  servers.push(server);
  return server;
}

/** The ZIP's files by name, as text. */
function unzip(file: string): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(new Uint8Array(fs.readFileSync(file)))).map(([k, v]) => [k, strFromU8(v)]));
}

/** The ZIP is in this server's Downloads folder, has what a report needs, and none of this data folder's secrets. */
function expectAnonymisedZip(file: string, server: ServerProcess, token: string): Record<string, string> {
  expect(path.dirname(file)).toBe(server.downloads);
  expect(path.basename(file)).toMatch(/^SwarmCast-logs-.+-\d{8}-\d{4}(-\d+)?\.zip$/);
  const files = unzip(file);
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['about.txt', 'config.json', 'activity.txt', 'logs/swarmcast.log.1']));
  expect(Object.keys(files).some((k) => /^logs\/swarmcast-\d{4}-\d{2}-\d{2}\.log$/.test(k))).toBe(true);
  expect(Object.keys(files).some((k) => /secrets|state\.json/.test(k))).toBe(false);
  const all = Object.values(files).join('\n');
  expect(all).toContain('SwarmCast ready');
  const secrets = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'secrets.json'), 'utf8')) as { streamKey: string };
  expect(all).not.toContain(secrets.streamKey);
  expect(all).not.toContain('PRIVATE KEY');
  expect(all).not.toContain(VIEWER_IP);
  expect(all).not.toContain(server.home);
  expect(all).not.toContain(token);
  expect(files['logs/swarmcast.log.1']).toMatch(/viewer from ip-[0-9a-f]{8} was rate-limited/);
  return files;
}

const isReady = (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: 'ready' }> => m.type === 'ready';
const isExport = (m: DesktopOutMessage): m is Extract<DesktopOutMessage, { type: 'export-logs' }> => m.type === 'export-logs';

describe('log export (real server)', () => {
  it('script mode: the panel API writes an anonymised ZIP to the Downloads folder', async () => {
    // Arrange
    const ports = await allocAppPorts();
    const server = start(ports, ['--no-tray', '--no-open']);
    const [, base, token] = await server.logLine(/(http:\/\/127\.0\.0\.1:\d+)\/auth\/(\S+)/, 'the panel login URL');
    const jar = new Jar(base!);
    const signedIn = await jar.fetch(`/auth/${token}`);
    const json = { origin: base!, 'content-type': 'application/json' };
    // Act
    const noOrigin = await jar.fetch('/api/diagnostics/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const res = await jar.fetch('/api/diagnostics/export', { method: 'POST', headers: json, body: '{}' });
    const exported = (await res.json()) as LogExportResult;
    // Assert
    expect(signedIn.status).toBe(200);
    expect(noOrigin.status).toBe(403);
    expect(res.status).toBe(200);
    expect(exported.fallback).toBe(false);
    const files = expectAnonymisedZip(exported.path, server, token!);
    expect(files['about.txt']).toContain('Mode: script');
    expect(files['about.txt']).toContain('Live phase: off');
    expect(JSON.parse(files['config.json']!).ports.rtmp).toBe(ports.rtmp);
    // Act
    const put = await jar.fetch('/api/diagnostics', { method: 'PUT', headers: json, body: JSON.stringify({ logRetentionDays: 21 }) });
    // Assert
    expect(await put.json()).toEqual({ logRetentionDays: 21 });
    expect(JSON.parse(fs.readFileSync(path.join(server.dataDir, 'config.json'), 'utf8')).diagnostics).toEqual({ logRetentionDays: 21 });
  });

  it('desktop mode: {"type":"export-logs"} on stdin answers with the ZIP path', async () => {
    // Arrange
    const server = start(await allocAppPorts(), ['--desktop']);
    const ready = await server.next(isReady, 'ready');
    // Act
    server.send({ type: 'export-logs' });
    const answer = await server.next(isExport, 'the export-logs answer');
    // Assert
    expect(answer).toMatchObject({ ok: true, path: expect.any(String) });
    const files = expectAnonymisedZip(answer.path!, server, ready.adminUrl.split('/auth/')[1]!);
    expect(files['about.txt']).toContain('Mode: desktop app');
    expect(files['about.txt']).toContain('Desktop app version: 9.9.9-test');
    // Act
    server.send({ type: 'quit' });
    const code = await server.exited;
    // Assert
    expect(code).toBe(0);
  });
});
