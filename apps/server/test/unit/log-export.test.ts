import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@swarmcast/shared';
import { defaultConfig } from '../../src/core/config.js';
import { resolvePaths } from '../../src/core/paths.js';
import { decodeDesktopMessage, decodeShellMessage, encodeDesktopMessage, encodeShellMessage } from '../../src/desktop/protocol.js';
import { EXPORT_RATE_LIMIT } from '../../src/admin/diagnostics-routes.js';
import { Diagnostics } from '../../src/diagnostics/diagnostics.js';
import type { DirectMode } from '../../src/direct/direct.js';
import { Anonymizer } from '../../src/diagnostics/anonymize.js';
import { buildLogExport, exportFileName, revealCommand, sanitizeConfig, writeExportFile, xdgDownloadDir } from '../../src/diagnostics/export.js';
import { silentLog, tempDir } from './helpers.js';
import { makeController, PANEL_TOKEN, panelServer } from './live-helpers.js';

// "Export logs" (docs: diagnostics): a ZIP of the recent logs, the config, the activity log and
// the system check, with every secret, IP address, nickname, host name and the home folder
// replaced by a label, so a streamer can attach it to a public issue.
//
// The export picks log files by modification time, relative to `now`: the fixture writes its
// files now, so NOW is the real clock (the one old file gets an mtime 30 days back).

// ---- fixture secrets (none of them may reach the ZIP) ----
const STREAM_KEY = 'sc_Kq7mZp3RtY9wXv2NcB6hJd4F';
const JOIN_SECRET = 'Jn8vQ2xLm5RpT7wK3zYc9bHd';
const LIVE_LINK = `https://brave-otter-lamp-sea.trycloudflare.com/join/${JOIN_SECRET}`;
const PANEL_SECRET = 'pT0kEn_9f8e7d6c5b4a3f2e1d0c9b8a';
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

/** A data folder as SwarmCast leaves it: logs (one too old), secrets, state, the system check. */
function fixture(): { dataDir: string; logsDir: string; config: ReturnType<typeof defaultConfig>; activity: ActivityEntry[] } {
  const dataDir = tempDir('sc-export-');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir);
  const pino = (o: Record<string, unknown>): string => JSON.stringify({ level: 'info', time: NOW, ...o });
  fs.writeFileSync(
    path.join(logsDir, 'swarmcast-2026-10-26.log'),
    [
      pino({ msg: 'SwarmCast ready', version: '0.1.0', dataDir: path.join(HOME, 'Library', 'Application Support', 'SwarmCast') }),
      pino({ msg: 'quick tunnel URL received', url: 'https://brave-otter-lamp-sea.trycloudflare.com' }),
      pino({ msg: `live link ${LIVE_LINK}` }),
      pino({ msg: 'login', path: `/auth/${PANEL_SECRET}` }),
      pino({ msg: `opened http://127.0.0.1:8081/auth/${PANEL_SECRET}` }),
      pino({ viewer: NICK, msg: 'viewer joined' }),
      pino({ reporter: NICK_2, accused: NICK, segment: 12, msg: 'P2P segment failed hash check' }),
      pino({ level: 'warn', mediamtx: `WAR [RTMP] [conn ${VIEWER_IP4}:51234] closed: stream key ${STREAM_KEY}`, msg: 'mediamtx' }),
      pino({ level: 'warn', msg: `blocked ${VIEWER_IP6} and ${VIEWER_IP6_SHORT} and ::ffff:${VIEWER_IP4}` }),
      pino({ msg: 'secret fields', streamKey: STREAM_KEY, token: PANEL_SECRET, password: OBS_PASSWORD, nested: { secret: 'nested-secret-value' } }),
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

/** The export of a fresh fixture. */
async function build(o: { includeFullIps?: boolean; salt?: Buffer } = {}) {
  const f = fixture();
  const anonymizer = new Anonymizer({
    includeFullIps: o.includeFullIps,
    homeDir: HOME,
    secrets: [STREAM_KEY, LIVE_LINK, JOIN_SECRET, PANEL_SECRET, SESSION_ID],
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
  const dir = tempDir('sc-export-');
  const written = writeExportFile(zip, exportFileName('0.1.0', NOW), dir, path.join(dir, 'fallback'));
  const entries = unzipSync(new Uint8Array(fs.readFileSync(written.path)));
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strFromU8(v)]));
}

/** Everything the fixture holds that is private. */
const SECRETS = [
  STREAM_KEY,
  JOIN_SECRET,
  LIVE_LINK,
  PANEL_SECRET,
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
];

describe('log export', () => {
  it('contains the expected files and none of the secrets, IPs or nicknames', async () => {
    // Arrange
    const { built } = await build();
    // Act
    const files = roundTrip(built.zip);
    // Assert
    expect(Object.keys(files).sort()).toEqual(['about.txt', 'activity.txt', 'config.json', 'logs/desktop.log', 'logs/desktop.log.1', 'logs/swarmcast-2026-10-26.log', 'system-check.json']);
    const all = Object.values(files).join('\n');
    expect(SECRETS.filter((secret) => all.includes(secret))).toEqual([]);
  });

  it('keeps loopback addresses (they tell which local service was involved) and every log line valid JSON', async () => {
    // Arrange
    const { built } = await build();
    // Act
    const log = roundTrip(built.zip)['logs/swarmcast-2026-10-26.log']!;
    // Assert
    expect(log).toContain('127.0.0.1:1935');
    for (const l of log.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('redacts the config values that are links, URLs or passwords, and keeps the rest', async () => {
    // Arrange
    const { built } = await build();
    // Act
    const config = roundTrip(built.zip)['config.json']!;
    // Assert
    expect(config).toContain('"externalUrl": "[redacted]"');
    expect(config).toContain('"password": "[redacted]"');
    expect(JSON.parse(config).uploadLimitMbps).toBe(100);
  });

  it('gives one address one label inside an export, also IPv4-mapped (::ffff:)', async () => {
    // Act
    const log = roundTrip((await build()).built.zip)['logs/swarmcast-2026-10-26.log']!;
    // Assert
    const mediamtx = JSON.parse(log.split('\n').find((l) => l.includes('"mediamtx"'))!).mediamtx as string;
    const label = /ip-[0-9a-f]{8}/.exec(mediamtx)![0];
    expect(log).toContain(`and ${label}"`);
    expect(new Set([...log.matchAll(/ip-[0-9a-f]{8}/g)].map((m) => m[0])).size).toBe(4);
  });

  it('gives a nickname the same label in the JSON fields, in desktop.log and in the activity log', async () => {
    // Act
    const a = roundTrip((await build()).built.zip);
    // Assert
    const viewerLabel = JSON.parse(a['logs/swarmcast-2026-10-26.log']!.split('\n').find((l) => l.includes('viewer joined'))!).viewer as string;
    expect(viewerLabel).toMatch(/^viewer-[0-9a-f]{8}$/);
    expect(a['logs/desktop.log']).toContain(`${viewerLabel} said hi`);
    expect(a['activity.txt']).toContain(`${viewerLabel} was kicked.`);
  });

  it('gives new labels in the next export', async () => {
    // Arrange
    const first = roundTrip((await build()).built.zip)['logs/swarmcast-2026-10-26.log']!;
    const label = /ip-[0-9a-f]{8}/.exec(first)![0];
    // Act
    const next = roundTrip((await build()).built.zip)['logs/swarmcast-2026-10-26.log']!;
    // Assert
    expect(next).not.toContain(label);
  });

  it('keeps full IP addresses only when asked, still hiding every secret', async () => {
    // Arrange
    const { built } = await build({ includeFullIps: true });
    // Act
    const all = Object.values(roundTrip(built.zip)).join('\n');
    // Assert
    expect(all).toContain(VIEWER_IP4);
    expect(all).toContain(VIEWER_IP6);
    for (const secret of [STREAM_KEY, JOIN_SECRET, PANEL_SECRET, OBS_PASSWORD, NICK]) expect(all).not.toContain(secret);
  });

  it('sanitises config strings under link, URL, password and key fields', () => {
    // Act
    const out = sanitizeConfig({ a: { externalUrl: 'https://x', streamKey: 'sc_x', autoNewLink: true, port: 1 }, list: ['ok'] }, new Anonymizer());
    // Assert
    expect(out).toEqual({ a: { externalUrl: '[redacted]', streamKey: '[redacted]', autoNewLink: true, port: 1 }, list: ['ok'] });
  });
});

describe('anonymiser: partial IPv6 and host names', () => {
  const salt = Buffer.alloc(32, 7);

  it('masks bare IPv6 prefixes (3+ groups without "::") with the label of the prefix', () => {
    // Arrange
    const a = new Anonymizer({ salt });
    const prefix = a.ipLabel('2804:1b3:61c1:c649::');
    // Act
    const text = a.text('home network 2804:1b3:61c1:c649 is up');
    const routes = a.text('route 2804:1b3:61c1:c649/64 via 2804:1b3:61c1:c649::/64');
    // Assert
    expect(text).toBe(`home network ${prefix} is up`);
    expect(routes).toBe(`route ${prefix}/64 via ${prefix}/64`);
  });

  it.each(['2804:1b3:61c1', '2001:db8:aa:bb:cc', 'fd12:3456:789a:1', 'fe80:1:2:3', '2804:1B3:61C1:C649:1234:5678:9'])('masks the partial IPv6 %s', (s) => {
    // Arrange
    const a = new Anonymizer({ salt });
    // Act
    const text = a.text(`x ${s} y`);
    // Assert
    expect(text).toMatch(/^x ip-[0-9a-f]{8} y$/);
  });

  it('an unbracketed full address with a port still loses the address', () => {
    // Act
    const text = new Anonymizer({ salt }).text('peer 2001:db8:85a3:1:2:8a2e:370:7334:443');
    // Assert
    expect(text).toMatch(/^peer ip-[0-9a-f]{8}:443$/);
  });

  it('keeps a partial IPv6 when full IPs were asked for', () => {
    // Act
    const text = new Anonymizer({ salt, includeFullIps: true }).text('2804:1b3:61c1:c649');
    // Assert
    expect(text).toBe('2804:1b3:61c1:c649');
  });

  it.each([
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
  ])('keeps times, MAC addresses, fingerprints, hashes, UUIDs and file positions intact: %s', (s) => {
    // Act
    const text = new Anonymizer({ salt }).text(s);
    // Assert
    expect(text).toBe(s);
  });

  it('hashes local, dynamic-DNS and custom host names', () => {
    // Arrange
    const a = new Anonymizer({ salt, hostnames: ['https://stream.minha-casa.example.net:8443/', 'Anas-MacBook-Pro', 'server'] });
    // Act
    const out = a.text(
      'mDNS Anas-MacBook-Pro.local, printer.lan, nas.home.arpa, myhome.duckdns.org, casa.ddns.net, https://stream.minha-casa.example.net:8443/x, mail me@private-box.com.br',
    );
    // Assert
    expect(out).toMatch(/^mDNS host-[0-9a-f]{8}\.local, host-[0-9a-f]{8}\.lan, host-[0-9a-f]{8}\.home\.arpa, host-[0-9a-f]{8}\.duckdns\.org, host-[0-9a-f]{8}\.ddns\.net, https:\/\/host-[0-9a-f]{8}:8443\/x, mail me@host-[0-9a-f]{8}$/);
    for (const leaked of ['Anas', 'MacBook', 'printer', 'myhome', 'casa', 'minha-casa', 'private-box']) expect(out).not.toContain(leaked);
  });

  it('one host name, one label, across forms and case; a plain word given as the computer name is not hunted', () => {
    // Arrange
    const a = new Anonymizer({ salt, hostnames: ['https://stream.minha-casa.example.net:8443/', 'Anas-MacBook-Pro', 'server'] });
    // Act
    const lower = a.text('stream.minha-casa.example.net');
    const upper = a.text('STREAM.minha-casa.example.net');
    const computer = a.text('Anas-MacBook-Pro said hi');
    const prose = a.text('the public server started');
    // Assert
    expect(lower).toBe(upper);
    expect(computer).toBe(`${a.hostLabel('anas-macbook-pro')} said hi`);
    expect(prose).toBe('the public server started');
  });

  it('keeps the services SwarmCast uses', () => {
    // Arrange
    const kept =
      'https://github.com/Lucas-Angelo/swarmcast speed.cloudflare.com [tunnel].trycloudflare.com objects.githubusercontent.com ' +
      'acme-v02.api.letsencrypt.org www.spamhaus.org iplists.firehol.org ffmpeg.martin-riedl.de lucas-angelo.github.io obsproject.com';
    // Act
    const text = new Anonymizer({ salt, hostnames: ['Anas-MacBook-Pro'] }).text(kept);
    // Assert
    expect(text).toBe(kept);
  });

  it.each([
    'at Logger.info (pino.js:12:3) this.access.live err.message process.env',
    'README.md swarmcast.cjs index.m3u8 config.json desktop.log.1 p2p-media-loader-core.es.js SwarmCast.app hls.js node:fs',
    'e.g. i.e. v0.2.1 Node.js 24, see example.com.json',
  ])('leaves code, files and prose that only look dotted alone: %s', (s) => {
    // Act
    const text = new Anonymizer({ salt }).text(s);
    // Assert
    expect(text).toBe(s);
  });

  it('JSON log lines stay valid JSON with host names inside', () => {
    // Arrange
    const a = new Anonymizer({ salt });
    // Act
    const line = a.line(JSON.stringify({ level: 'info', msg: 'tunnel up', url: 'https://cam.duckdns.org/live', host: 'Anas-MacBook-Pro.local' }));
    // Assert
    expect(JSON.parse(line)).toMatchObject({ url: expect.stringMatching(/^https:\/\/host-[0-9a-f]{8}\.duckdns\.org\/live$/), host: expect.stringMatching(/^host-[0-9a-f]{8}\.local$/) });
  });
});

describe('export file', () => {
  // Local time in, local time out: the same in every time zone.
  it('is named after the version and the local time; the version cannot add folders', () => {
    // Arrange
    const t = new Date(2026, 9, 26, 9, 5).getTime();
    // Act
    const name = exportFileName('0.1.0', t);
    const hostile = exportFileName('1.0.0/../x', t);
    // Assert
    expect(name).toBe('SwarmCast-logs-0.1.0-20261026-0905.zip');
    expect(hostile).toBe('SwarmCast-logs-1.0.0_.._x-20261026-0905.zip');
  });

  it('never overwrites', () => {
    // Arrange
    const dir = tempDir('sc-export-');
    const zip = new Uint8Array([1, 2, 3]);
    // Act
    const a = writeExportFile(zip, 'SwarmCast-logs-x.zip', dir, path.join(dir, 'exports'));
    const b = writeExportFile(zip, 'SwarmCast-logs-x.zip', dir, path.join(dir, 'exports'));
    // Assert
    expect(path.basename(a.path)).toBe('SwarmCast-logs-x.zip');
    expect(path.basename(b.path)).toBe('SwarmCast-logs-x-2.zip');
  });

  it('falls back to <data>/exports when Downloads is unknown or not a folder', () => {
    // Arrange
    const dir = tempDir('sc-export-');
    const zip = new Uint8Array([1, 2, 3]);
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    // Act
    const unknown = writeExportFile(zip, 'SwarmCast-logs-x.zip', null, path.join(dir, 'exports'));
    const notAFolder = writeExportFile(zip, 'SwarmCast-logs-y.zip', file, path.join(dir, 'exports'));
    // Assert
    expect(unknown).toEqual({ path: path.join(dir, 'exports', 'SwarmCast-logs-x.zip'), fallback: true });
    expect(notAFolder.fallback).toBe(true);
  });

  it.each<[string, NodeJS.ProcessEnv, () => string, string | null]>([
    ['XDG_DOWNLOAD_DIR', { XDG_DOWNLOAD_DIR: '$HOME/Baixados' }, () => '', '/home/a/Baixados'],
    ['user-dirs.dirs', {}, () => '# comment\nXDG_DOWNLOAD_DIR="$HOME/Transferências"\n', '/home/a/Transferências'],
    ['user-dirs.dirs naming the home folder itself', {}, () => 'XDG_DOWNLOAD_DIR="$HOME/"\n', null],
    [
      'no user-dirs.dirs',
      {},
      () => {
        throw new Error('missing');
      },
      null,
    ],
  ])('finds the XDG download folder from %s', (_what, env, read, dir) => {
    // Act
    const d = xdgDownloadDir(env, '/home/a', read);
    // Assert
    expect(d).toBe(dir);
  });

  it.each<[NodeJS.Platform, string, { command: string; args: string[] }]>([
    ['win32', 'C:\\Users\\a\\Downloads\\x.zip', { command: 'explorer.exe', args: ['/select,C:\\Users\\a\\Downloads\\x.zip'] }],
    ['darwin', '/Users/a/Downloads/x.zip', { command: 'open', args: ['-R', '/Users/a/Downloads/x.zip'] }],
    ['linux', '/home/a/Downloads/x.zip', { command: 'xdg-open', args: ['/home/a/Downloads'] }],
  ])('reveals the file with the native file manager (%s)', (platform, file, command) => {
    // Act
    const c = revealCommand(file, platform);
    // Assert
    expect(c).toEqual(command);
  });
});

describe('diagnostics admin API', () => {
  /** The panel of a live whose data folder has one log line with a stream key and an IP; exports go to `downloads`. */
  async function diagnosticsPanel() {
    const dataDir = tempDir('sc-export-');
    const downloads = tempDir('sc-export-');
    const paths = resolvePaths(dataDir);
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.logsDir, 'swarmcast-2026-10-26.log'), JSON.stringify({ msg: `stream key ${STREAM_KEY} from ${VIEWER_IP4}` }) + '\n');
    const { live } = makeController({ snapshot: () => ({}) } as unknown as DirectMode);
    const config = defaultConfig();
    const persist = vi.fn();
    const diagnostics = new Diagnostics({ paths, config, persist, live, log: silentLog, version: '0.1.0', panelToken: PANEL_TOKEN, downloadsDir: async () => downloads });
    const { app, headers } = await panelServer({ live, diagnostics });
    const post = (payload: Record<string, unknown> | string, h: Record<string, string> = headers.json) => app.inject({ method: 'POST', url: '/api/diagnostics/export', headers: h, payload });
    return { app, headers, dataDir, downloads, config, persist, post };
  }

  it('checks auth, CSRF, the body type and the body, like every admin route', async () => {
    // Arrange
    const { headers, post } = await diagnosticsPanel();
    // Act
    const noCookie = await post({}, { ...headers.json, cookie: '' });
    const foreignOrigin = await post({}, { ...headers.json, origin: 'https://evil.example' });
    const noOrigin = await post({}, { ...headers.get, 'content-type': 'application/json' });
    const notJson = await post('{}', { ...headers.json, 'content-type': 'text/plain' });
    const badBody = await post({ includeFullIps: 'yes' });
    // Assert
    expect(noCookie.statusCode).toBe(401);
    expect(foreignOrigin.statusCode).toBe(403);
    expect(noOrigin.statusCode).toBe(403);
    expect(notJson.statusCode).toBe(415);
    expect(badBody.statusCode).toBe(400);
  });

  it('exports to the given folder, anonymised, in script mode', async () => {
    // Arrange
    const { downloads, post } = await diagnosticsPanel();
    // Act
    const r = await post({});
    // Assert
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
  });

  it('"Show in folder" only opens exports of this run', async () => {
    // Arrange
    const { app, headers, dataDir } = await diagnosticsPanel();
    // Act
    const reveal = await app.inject({ method: 'POST', url: '/api/diagnostics/reveal', headers: headers.json, payload: { path: path.join(dataDir, 'secrets.json') } });
    // Assert
    expect(reveal.json()).toEqual({ ok: false });
  });

  it('the retention setting: 3..90 days, saved to config.json', async () => {
    // Arrange
    const { app, headers, config, persist } = await diagnosticsPanel();
    const put = (logRetentionDays: number) => app.inject({ method: 'PUT', url: '/api/diagnostics', headers: headers.json, payload: { logRetentionDays } });
    // Act
    const current = await app.inject({ method: 'GET', url: '/api/diagnostics', headers: headers.get });
    const tooShort = await put(2);
    const tooLong = await put(91);
    const ok = await put(30);
    // Assert
    expect(current.json()).toEqual({ logRetentionDays: 14 });
    expect(tooShort.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
    expect(ok.json()).toEqual({ logRetentionDays: 30 });
    expect(config.diagnostics.logRetentionDays).toBe(30);
    expect(persist).toHaveBeenCalled();
  });

  it(`takes ${EXPORT_RATE_LIMIT.max} exports a minute and refuses the next one (429)`, async () => {
    // Arrange
    const { post } = await diagnosticsPanel();
    // Act
    const codes: number[] = [];
    for (let i = 0; i <= EXPORT_RATE_LIMIT.max; i++) codes.push((await post({})).statusCode);
    // Assert
    expect(codes).toEqual([...Array<number>(EXPORT_RATE_LIMIT.max).fill(200), 429]);
  });

  it('refused requests count against the export limit too', async () => {
    // Arrange
    const { post } = await diagnosticsPanel();
    for (let i = 0; i < EXPORT_RATE_LIMIT.max; i++) await post({ includeFullIps: 'yes' });
    // Act
    const r = await post({});
    // Assert
    expect(r.statusCode).toBe(429);
  });
});

describe('desktop protocol: export-logs', () => {
  it('the shell asks with {"type":"export-logs"} (nothing else it sends counts)', () => {
    // Act
    const encoded = encodeShellMessage({ type: 'export-logs' });
    const plain = decodeShellMessage('{"type":"export-logs"}');
    const withPath = decodeShellMessage('{"type":"export-logs","path":"/etc/passwd"}');
    // Assert
    expect(encoded).toBe('{"type":"export-logs"}\n');
    expect(plain).toEqual({ type: 'export-logs' });
    expect(withPath).toEqual({ type: 'export-logs' });
  });

  it('and gets the path back', () => {
    // Arrange
    const msg = { type: 'export-logs' as const, ok: true, path: '/home/a/Downloads/SwarmCast-logs-0.1.0-20261026-1200.zip' };
    // Act
    const line = encodeDesktopMessage(msg);
    // Assert
    expect(line).toBe('@@swarmcast {"type":"export-logs","ok":true,"path":"/home/a/Downloads/SwarmCast-logs-0.1.0-20261026-1200.zip"}\n');
    expect(decodeDesktopMessage(line.trimEnd())).toEqual(msg);
  });
});
