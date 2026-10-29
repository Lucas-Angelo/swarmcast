import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, type ActivityEntry } from '@swarmcast/shared';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfig } from '../../src/core/config.js';
import { resolvePaths } from '../../src/core/paths.js';
import { decodeDesktopMessage, decodeShellMessage, encodeDesktopMessage, encodeShellMessage } from '../../src/desktop/protocol.js';
import { Diagnostics } from '../../src/diagnostics/diagnostics.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { silentLog } from './helpers.js';
import { makeController } from './live-helpers.js';
import { Anonymizer } from '../../src/diagnostics/anonymize.js';
import { buildLogExport, exportFileName, revealCommand, sanitizeConfig, writeExportFile, xdgDownloadDir } from '../../src/diagnostics/export.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-export-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ---- fixture secrets (none of them may reach the ZIP) ----
const STREAM_KEY = 'sc_Kq7mZp3RtY9wXv2NcB6hJd4F';
const JOIN_SECRET = 'Jn8vQ2xLm5RpT7wK3zYc9bHd';
const LIVE_LINK = `https://brave-otter-lamp-sea.trycloudflare.com/join/${JOIN_SECRET}`;
const PANEL_TOKEN = 'pT0kEn_9f8e7d6c5b4a3f2e1d0c9b8a';
const SESSION_ID = 'sess-4f9a8b7c6d5e4f3a2b1c';
const OBS_PASSWORD = 'obs-pass-Wq9x7v5t';
const EXTERNAL_URL = 'https://my-private-tunnel.example.net';
const PEM = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBzq1YpXo8sQ0d8u9v7t6r5e4w3q2a1s0d9f8g7h6j5k\n-----END PRIVATE KEY-----';
const VIEWER_IP4 = '203.0.113.77';
const VIEWER_IP4_B = '198.51.100.23';
const VIEWER_IP6 = '2001:db8:85a3:0:0:8a2e:370:7334';
const VIEWER_IP6_SHORT = '2001:db8:abcd::42';
const NICK = 'MariaGamer';
const NICK_2 = 'Zé Ninguém';
const HOME = os.homedir();

const NOW = Date.now();

function fixture(): { dataDir: string; logsDir: string; config: ReturnType<typeof defaultConfig>; activity: ActivityEntry[] } {
  const dataDir = tmp();
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir);
  const pino = (o: Record<string, unknown>): string => JSON.stringify({ level: 'info', time: NOW, ...o });
  fs.writeFileSync(
    path.join(logsDir, 'swarmcast-2026-10-26.log'),
    [
      pino({ msg: 'SwarmCast ready', version: '0.1.0', dataDir: path.join(HOME, 'Library', 'Application Support', 'SwarmCast') }),
      pino({ msg: 'quick tunnel URL received', url: 'https://brave-otter-lamp-sea.trycloudflare.com' }),
      pino({ msg: `live link ${LIVE_LINK}` }),
      pino({ msg: 'login', path: `/auth/${PANEL_TOKEN}` }),
      pino({ msg: `opened http://127.0.0.1:8081/auth/${PANEL_TOKEN}` }),
      pino({ viewer: NICK, msg: 'viewer joined' }),
      pino({ reporter: NICK_2, accused: NICK, segment: 12, msg: 'P2P segment failed hash check' }),
      pino({ level: 'warn', mediamtx: `WAR [RTMP] [conn ${VIEWER_IP4}:51234] closed: stream key ${STREAM_KEY}`, msg: 'mediamtx' }),
      pino({ level: 'warn', msg: `blocked ${VIEWER_IP6} and ${VIEWER_IP6_SHORT} and ::ffff:${VIEWER_IP4}` }),
      pino({ msg: 'secret fields', streamKey: STREAM_KEY, token: PANEL_TOKEN, password: OBS_PASSWORD, nested: { secret: 'nested-secret-value' } }),
      pino({ msg: `session ${SESSION_ID} from ${VIEWER_IP4_B}` }),
      pino({ msg: `key material ${PEM}` }),
      pino({ msg: 'local only', addr: '127.0.0.1:1935' }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(logsDir, 'desktop.log'),
    [
      `2026-10-26T12:00:00.000Z [desktop] SwarmCast desktop 0.1.0 starting (resources ${path.join(HOME, 'Applications')})`,
      `2026-10-26T12:00:01.000Z [desktop] ${NICK} said hi from ${VIEWER_IP4}`,
      pino({ msg: `rtmp://127.0.0.1:1935/live/${STREAM_KEY}` }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(logsDir, 'desktop.log.1'), `2026-10-25T10:00:00.000Z [desktop] old line ${LIVE_LINK}\n`);
  // Too old for the export (and for retention).
  const old = path.join(logsDir, 'swarmcast-2026-09-01.log');
  fs.writeFileSync(old, pino({ msg: 'very old' }) + '\n');
  const t = new Date(NOW - 30 * 24 * 3600 * 1000);
  fs.utimesSync(old, t, t);
  // Files that must never be exported.
  fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ streamKey: STREAM_KEY, manifestPrivateKeyPem: PEM }));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ lastDirectIp: VIEWER_IP4_B }));
  fs.writeFileSync(
    path.join(dataDir, 'system-check.json'),
    JSON.stringify({ version: 1, at: '2026-10-26', os: 'macOS 26', arch: 'arm64', results: [{ id: 'upload', status: 'ok', value: 80, detail: `public ip ${VIEWER_IP4_B}` }], belowMinimum: [] }),
  );
  const config = defaultConfig();
  config.tunnel = { provider: 'external', externalUrl: EXTERNAL_URL };
  config.quality.obsWebsocket = { ...config.quality.obsWebsocket, enabled: true, password: OBS_PASSWORD };
  config.security.extraBlocklistUrls = ['https://lists.example.org/private-list.txt'];
  const activity: ActivityEntry[] = [
    { id: 1, at: NOW, level: 'info', kind: 'viewer', code: 'log.viewerJoined', params: { nickname: NICK_2 }, text: `${NICK_2} joined.` },
    { id: 2, at: NOW, level: 'info', kind: 'action', code: 'log.kicked', params: { nickname: NICK }, text: `${NICK} was kicked.` },
    { id: 3, at: NOW, level: 'warn', kind: 'system', text: 'The tunnel dropped (lost [ip]). Reconnecting…' },
  ];
  return { dataDir, logsDir, config, activity };
}

async function build(o: { includeFullIps?: boolean; salt?: Buffer } = {}) {
  const f = fixture();
  const anonymizer = new Anonymizer({
    includeFullIps: o.includeFullIps,
    homeDir: HOME,
    secrets: [STREAM_KEY, LIVE_LINK, JOIN_SECRET, PANEL_TOKEN, SESSION_ID],
    nicknames: [],
    salt: o.salt,
  });
  const built = await buildLogExport({
    logsDir: f.logsDir,
    systemCheckFile: path.join(f.dataDir, 'system-check.json'),
    config: f.config,
    activity: f.activity,
    about: ['SwarmCast log export', `Data folder: ${f.dataDir}`, `Tunnel: ${LIVE_LINK}`],
    anonymizer,
    now: NOW,
  });
  return { ...f, built };
}

/** Write the ZIP like the app does, read it back with an unzipper, and return name → text. */
function roundTrip(zip: Uint8Array): Record<string, string> {
  const dir = tmp();
  const written = writeExportFile(zip, exportFileName('0.1.0', NOW), dir, path.join(dir, 'fallback'));
  const entries = unzipSync(new Uint8Array(fs.readFileSync(written.path)));
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strFromU8(v)]));
}

describe('log export', () => {
  it('contains the expected files and none of the secrets, IPs or nicknames', async () => {
    const { built } = await build();
    const files = roundTrip(built.zip);
    expect(Object.keys(files).sort()).toEqual(['about.txt', 'activity.txt', 'config.json', 'logs/desktop.log', 'logs/desktop.log.1', 'logs/swarmcast-2026-10-26.log', 'system-check.json']);
    const all = Object.values(files).join('\n');
    for (const secret of [
      STREAM_KEY,
      JOIN_SECRET,
      LIVE_LINK,
      PANEL_TOKEN,
      SESSION_ID,
      OBS_PASSWORD,
      EXTERNAL_URL,
      'my-private-tunnel',
      'private-list.txt',
      'nested-secret-value',
      'BEGIN PRIVATE KEY',
      'MC4CAQAwBQYDK2VwBCIEIBzq1YpXo8sQ0d8u9v7t6r5e4w3q2a1s0d9f8g7h6j5k',
      'brave-otter-lamp-sea',
      VIEWER_IP4,
      VIEWER_IP4_B,
      VIEWER_IP6,
      VIEWER_IP6_SHORT,
      NICK,
      NICK_2,
      HOME,
      'very old',
    ]) {
      expect(all, `leaked: ${secret}`).not.toContain(secret);
    }
    // Loopback addresses stay (they tell which local service was involved).
    expect(files['logs/swarmcast-2026-10-26.log']).toContain('127.0.0.1:1935');
    // Every log line is still valid JSON after anonymisation.
    for (const l of files['logs/swarmcast-2026-10-26.log']!.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
    expect(files['config.json']).toContain('"externalUrl": "[redacted]"');
    expect(files['config.json']).toContain('"password": "[redacted]"');
    expect(JSON.parse(files['config.json']!).uploadLimitMbps).toBe(100);
  });

  it('gives one address (or nickname) one label inside an export, and new labels in the next one', async () => {
    const a = roundTrip((await build()).built.zip);
    const log = a['logs/swarmcast-2026-10-26.log']!;
    const ipLabels = [...log.matchAll(/ip-[0-9a-f]{8}/g)].map((m) => m[0]);
    // 203.0.113.77 appears plain and IPv4-mapped (::ffff:): same label both times.
    const mediamtx = JSON.parse(log.split('\n').find((l) => l.includes('"mediamtx"'))!).mediamtx as string;
    const label = /ip-[0-9a-f]{8}/.exec(mediamtx)![0];
    expect(log).toContain(`and ${label}"`);
    expect(new Set(ipLabels).size).toBe(4); // 2 IPv4 + 2 IPv6
    // The same nickname has the same label in the JSON fields, in desktop.log and in the activity log.
    const viewerLabel = JSON.parse(log.split('\n').find((l) => l.includes('viewer joined'))!).viewer as string;
    expect(viewerLabel).toMatch(/^viewer-[0-9a-f]{8}$/);
    expect(a['logs/desktop.log']).toContain(`${viewerLabel} said hi`);
    expect(a['activity.txt']).toContain(`${viewerLabel} was kicked.`);
    const b = roundTrip((await build()).built.zip);
    expect(b['logs/swarmcast-2026-10-26.log']).not.toContain(label);
  });

  it('keeps full IP addresses only when asked, still hiding every secret', async () => {
    const files = roundTrip((await build({ includeFullIps: true })).built.zip);
    const all = Object.values(files).join('\n');
    expect(all).toContain(VIEWER_IP4);
    expect(all).toContain(VIEWER_IP6);
    for (const secret of [STREAM_KEY, JOIN_SECRET, PANEL_TOKEN, OBS_PASSWORD, NICK]) expect(all).not.toContain(secret);
  });

  it('sanitises config strings under link, URL, password and key fields', () => {
    const anon = new Anonymizer();
    expect(sanitizeConfig({ a: { externalUrl: 'https://x', streamKey: 'sc_x', autoNewLink: true, port: 1 }, list: ['ok'] }, anon)).toEqual({
      a: { externalUrl: '[redacted]', streamKey: '[redacted]', autoNewLink: true, port: 1 },
      list: ['ok'],
    });
  });
});

describe('anonymiser: partial IPv6 and host names', () => {
  const salt = Buffer.alloc(32, 7);

  it('masks bare IPv6 prefixes (3+ groups without "::") with the label of the prefix', () => {
    const a = new Anonymizer({ salt });
    const prefix = a.ipLabel('2804:1b3:61c1:c649::');
    expect(a.text('home network 2804:1b3:61c1:c649 is up')).toBe(`home network ${prefix} is up`);
    expect(a.text('route 2804:1b3:61c1:c649/64 via 2804:1b3:61c1:c649::/64')).toBe(`route ${prefix}/64 via ${prefix}/64`);
    for (const s of ['2804:1b3:61c1', '2001:db8:aa:bb:cc', 'fd12:3456:789a:1', 'fe80:1:2:3', '2804:1B3:61C1:C649:1234:5678:9']) {
      expect(a.text(`x ${s} y`), s).toMatch(/^x ip-[0-9a-f]{8} y$/);
    }
    // An unbracketed full address with a port still loses the address.
    expect(a.text('peer 2001:db8:85a3:1:2:8a2e:370:7334:443')).toMatch(/^peer ip-[0-9a-f]{8}:443$/);
    expect(new Anonymizer({ salt, includeFullIps: true }).text('2804:1b3:61c1:c649')).toBe('2804:1b3:61c1:c649');
  });

  it('keeps times, MAC addresses, fingerprints, hashes, UUIDs and file positions intact', () => {
    const a = new Anonymizer({ salt });
    for (const s of [
      '2026-10-26T12:34:56.789Z',
      'at 12:34:56 and 23:59:59.5',
      'elapsed 2000:00:00',
      'mac aa:bb:cc:dd:ee:ff and 2c:54:91:88:c9:e3',
      'fingerprint 3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D',
      'sha256 2a3f9c0e1b7d4f6a8c2e5b9d0f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a',
      'digest sha256:2a3f9c0e1b7d4f6a and git 3f2a1b0c9d8e',
      'uuid 2b1e4f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      'at run (/app/dist/swarmcast.cjs:2345:67) and bundle.cjs:3000:12:5',
      'version 0.2.1, segment v1_seg2345.mp4, ratio 16:9, port 8080',
    ]) {
      expect(a.text(s), s).toBe(s);
    }
  });

  it('hashes local, dynamic-DNS and custom host names; keeps the services SwarmCast uses', () => {
    const a = new Anonymizer({ salt, hostnames: ['https://stream.minha-casa.example.net:8443/', 'Anas-MacBook-Pro', 'server'] });
    const out = a.text(
      'mDNS Anas-MacBook-Pro.local, printer.lan, nas.home.arpa, myhome.duckdns.org, casa.ddns.net, https://stream.minha-casa.example.net:8443/x, mail me@private-box.com.br',
    );
    expect(out).toMatch(/^mDNS host-[0-9a-f]{8}\.local, host-[0-9a-f]{8}\.lan, host-[0-9a-f]{8}\.home\.arpa, host-[0-9a-f]{8}\.duckdns\.org, host-[0-9a-f]{8}\.ddns\.net, https:\/\/host-[0-9a-f]{8}:8443\/x, mail me@host-[0-9a-f]{8}$/);
    for (const leaked of ['Anas', 'MacBook', 'printer', 'myhome', 'casa', 'minha-casa', 'private-box']) expect(out).not.toContain(leaked);
    // One name, one label (also across forms and case).
    expect(a.text('stream.minha-casa.example.net')).toBe(a.text('STREAM.minha-casa.example.net'));
    expect(a.text('Anas-MacBook-Pro said hi')).toBe(`${a.hostLabel('anas-macbook-pro')} said hi`);
    // A plain word given as the computer name is not hunted through the text.
    expect(a.text('the public server started')).toBe('the public server started');
    const kept =
      'https://github.com/Lucas-Angelo/swarmcast speed.cloudflare.com [tunnel].trycloudflare.com objects.githubusercontent.com ' +
      'acme-v02.api.letsencrypt.org www.spamhaus.org iplists.firehol.org ffmpeg.martin-riedl.de lucas-angelo.github.io obsproject.com';
    expect(a.text(kept)).toBe(kept);
  });

  it('leaves code, files and prose that only look dotted alone', () => {
    const a = new Anonymizer({ salt });
    for (const s of [
      'at Logger.info (pino.js:12:3) this.access.live err.message process.env',
      'README.md swarmcast.cjs index.m3u8 config.json desktop.log.1 p2p-media-loader-core.es.js SwarmCast.app hls.js node:fs',
      'e.g. i.e. v0.2.1 Node.js 24, see example.com.json',
    ]) {
      expect(a.text(s), s).toBe(s);
    }
    // JSON log lines stay valid JSON with host names inside.
    const line = a.line(JSON.stringify({ level: 'info', msg: 'tunnel up', url: 'https://cam.duckdns.org/live', host: 'Anas-MacBook-Pro.local' }));
    expect(JSON.parse(line)).toMatchObject({ url: expect.stringMatching(/^https:\/\/host-[0-9a-f]{8}\.duckdns\.org\/live$/), host: expect.stringMatching(/^host-[0-9a-f]{8}\.local$/) });
  });
});

describe('export file', () => {
  it('is named after the version and the local time', () => {
    const t = new Date(2026, 9, 26, 9, 5).getTime();
    expect(exportFileName('0.1.0', t)).toBe('SwarmCast-logs-0.1.0-20261026-0905.zip');
    expect(exportFileName('1.0.0/../x', t)).toBe('SwarmCast-logs-1.0.0_.._x-20261026-0905.zip');
  });

  it('never overwrites, and falls back to <data>/exports when Downloads is unusable', () => {
    const dir = tmp();
    const zip = new Uint8Array([1, 2, 3]);
    const a = writeExportFile(zip, 'SwarmCast-logs-x.zip', dir, path.join(dir, 'exports'));
    const b = writeExportFile(zip, 'SwarmCast-logs-x.zip', dir, path.join(dir, 'exports'));
    expect(path.basename(a.path)).toBe('SwarmCast-logs-x.zip');
    expect(path.basename(b.path)).toBe('SwarmCast-logs-x-2.zip');
    const c = writeExportFile(zip, 'SwarmCast-logs-x.zip', null, path.join(dir, 'exports'));
    expect(c).toEqual({ path: path.join(dir, 'exports', 'SwarmCast-logs-x.zip'), fallback: true });
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(writeExportFile(zip, 'SwarmCast-logs-y.zip', file, path.join(dir, 'exports')).fallback).toBe(true);
  });

  it('finds the XDG download folder', () => {
    const read = (text: string) => () => text;
    expect(xdgDownloadDir({ XDG_DOWNLOAD_DIR: '$HOME/Baixados' }, '/home/a')).toBe('/home/a/Baixados');
    expect(xdgDownloadDir({}, '/home/a', read('# comment\nXDG_DOWNLOAD_DIR="$HOME/Transferências"\n'))).toBe('/home/a/Transferências');
    expect(xdgDownloadDir({}, '/home/a', read('XDG_DOWNLOAD_DIR="$HOME/"\n'))).toBeNull();
    expect(xdgDownloadDir({}, '/home/a', () => {
      throw new Error('missing');
    })).toBeNull();
  });

  it('reveals the file with the native file manager', () => {
    expect(revealCommand('C:\\Users\\a\\Downloads\\x.zip', 'win32')).toEqual({ command: 'explorer.exe', args: ['/select,C:\\Users\\a\\Downloads\\x.zip'] });
    expect(revealCommand('/Users/a/Downloads/x.zip', 'darwin')).toEqual({ command: 'open', args: ['-R', '/Users/a/Downloads/x.zip'] });
    expect(revealCommand('/home/a/Downloads/x.zip', 'linux')).toEqual({ command: 'xdg-open', args: ['/home/a/Downloads'] });
  });
});

describe('diagnostics admin API', () => {
  const PORT = 39431;
  const headers = { host: `127.0.0.1:${PORT}`, cookie: `${ADMIN_COOKIE}=tok` };
  const json = { ...headers, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' };

  it('exports to the given folder, checks auth/CSRF, validates the retention and rate-limits exports', async () => {
    const dataDir = tmp();
    const downloads = tmp();
    const paths = resolvePaths(dataDir);
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.logsDir, 'swarmcast-2026-10-26.log'), JSON.stringify({ msg: `stream key ${STREAM_KEY} from ${VIEWER_IP4}` }) + '\n');
    const { live } = makeController({ snapshot: () => ({}) } as unknown as DirectMode);
    const config = defaultConfig();
    const persist = vi.fn();
    const diagnostics = new Diagnostics({ paths, config, persist, live, log: silentLog, version: '0.1.0', panelToken: 'tok', downloadsDir: async () => downloads });
    const app = await createAdminServer({ port: PORT, adminDir: '/nonexistent', live, log: silentLog, token: 'tok', onQuit: vi.fn(), checkDirect: vi.fn(), cleanupStale: vi.fn(), diagnostics });
    try {
      // Auth and CSRF, like every admin route.
      expect((await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: { ...json, cookie: '' }, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: { ...json, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: { ...headers, 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: { ...json, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
      expect((await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: json, payload: { includeFullIps: 'yes' } })).statusCode).toBe(400);

      const r = await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: json, payload: {} });
      expect(r.statusCode, r.body).toBe(200);
      const res = r.json() as { path: string; folder: string; name: string; fallback: boolean; bytes: number };
      expect(res.folder).toBe(downloads);
      expect(res.fallback).toBe(false);
      expect(res.name).toMatch(/^SwarmCast-logs-0\.1\.0-\d{8}-\d{4}(-\d+)?\.zip$/);
      const files = unzipSync(new Uint8Array(fs.readFileSync(res.path)));
      expect(Object.keys(files)).toContain('about.txt');
      const all = Object.values(files).map((f) => strFromU8(f)).join('\n');
      expect(all).not.toContain(STREAM_KEY);
      expect(all).not.toContain(VIEWER_IP4);
      expect(strFromU8(files['about.txt']!)).toContain('Mode: script');

      // Show in folder only opens exports of this run.
      const reveal = await app.inject({ method: 'POST', url: '/api/diagnostics/reveal', headers: json, payload: { path: path.join(dataDir, 'secrets.json') } });
      expect(reveal.json()).toEqual({ ok: false });

      // Retention setting: 3..90 days, saved to config.json.
      expect((await app.inject({ method: 'GET', url: '/api/diagnostics', headers })).json()).toEqual({ logRetentionDays: 14 });
      expect((await app.inject({ method: 'PUT', url: '/api/diagnostics', headers: json, payload: { logRetentionDays: 2 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: '/api/diagnostics', headers: json, payload: { logRetentionDays: 91 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: '/api/diagnostics', headers: json, payload: { logRetentionDays: 30 } })).json()).toEqual({ logRetentionDays: 30 });
      expect(config.diagnostics.logRetentionDays).toBe(30);
      expect(persist).toHaveBeenCalled();

      // Rate limit: a few exports per minute (the invalid ones above count too).
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: json, payload: {} })).statusCode);
      expect(codes).toContain(429);
    } finally {
      await app.close();
    }
  });
});

describe('desktop protocol: export-logs', () => {
  it('the shell asks with {"type":"export-logs"} and gets the path back', () => {
    expect(encodeShellMessage({ type: 'export-logs' })).toBe('{"type":"export-logs"}\n');
    expect(decodeShellMessage('{"type":"export-logs"}')).toEqual({ type: 'export-logs' });
    expect(decodeShellMessage('{"type":"export-logs","path":"/etc/passwd"}')).toEqual({ type: 'export-logs' });
    const line = encodeDesktopMessage({ type: 'export-logs', ok: true, path: '/home/a/Downloads/SwarmCast-logs-0.1.0-20261026-1200.zip' });
    expect(line).toBe('@@swarmcast {"type":"export-logs","ok":true,"path":"/home/a/Downloads/SwarmCast-logs-0.1.0-20261026-1200.zip"}\n');
    expect(decodeDesktopMessage(line.trimEnd())).toEqual({ type: 'export-logs', ok: true, path: '/home/a/Downloads/SwarmCast-logs-0.1.0-20261026-1200.zip' });
  });
});
