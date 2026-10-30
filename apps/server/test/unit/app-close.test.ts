import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createApp, ENCODER_PROBE_DELAY_MS, type App } from '../../src/app.js';
import { defaultConfig, type AppConfig } from '../../src/core/config.js';
import { tempDir } from './helpers.js';

// App.close() ends what createApp started, so an app closed in-process (every test of the real
// app, the desktop app's quit) leaves nothing behind: the server log file is closed (late lines
// from background work are dropped), the encoder probe due 3 s after start never runs, and a
// blocklist download in flight ends without writing into the data folder.
//
// createApp here: a temp data folder, no reaper, no tunnel, every port 0 (the panel listens on
// 127.0.0.1, on a port the OS picks), no speed test, and the public blocklists off unless a test
// points them at its own server.

const PORTS_ZERO = { rtmp: 0, public: 0, admin: 0, mediamtxHls: 0 };

/** A real app on a temp data folder, closed when the test finishes (close() can be called twice). */
async function app(security: Partial<AppConfig['security']> = {}): Promise<App> {
  const a = await createApp({
    dataDir: tempDir('sc-app-'),
    noTunnel: true,
    noReaper: true,
    logToStdout: false,
    configOverrides: {
      ports: PORTS_ZERO,
      speedTest: { enabled: false, intervalMinutes: 15 },
      security: { ...defaultConfig().security, blockKnownBadIps: false, ...security },
    },
  });
  onTestFinished(() => a.close());
  return a;
}

/** The files in `dir`; none when it does not exist. */
const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

/** The server log files of `a`, read back. */
function serverLog(a: App): string {
  return fs
    .readdirSync(a.paths.logsDir)
    .filter((f) => f.startsWith('swarmcast-'))
    .map((f) => fs.readFileSync(path.join(a.paths.logsDir, f), 'utf8'))
    .join('');
}

/**
 * A blocklist server on 127.0.0.1 that sends headers and a first line, then never finishes:
 * `requested` once it has the request, `abandoned` once the client closed the connection.
 */
async function hangingListServer(): Promise<{ url: string; requested: Promise<void>; abandoned: Promise<void> }> {
  let gotRequest!: () => void;
  let lost!: () => void;
  const requested = new Promise<void>((r) => (gotRequest = r));
  const abandoned = new Promise<void>((r) => (lost = r));
  const server = http.createServer((_req, res) => {
    res.on('close', lost);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('1.2.3.0/24\n');
    gotRequest();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/list.txt`, requested, abandoned };
}

describe('App.close()', () => {
  it('ends the server log file: lines logged after close are dropped, without an error', async () => {
    // Arrange
    const a = await app();
    a.log.info('before close');
    // Act
    await a.close();
    const late = () => a.log.info('after close');
    // Assert
    expect(late).not.toThrow();
    const text = serverLog(a);
    expect(text).toContain('before close');
    expect(text).toContain('shutdown complete');
    expect(text).not.toContain('after close');
  });

  it('leaves no open file in the data folder: it can be deleted at once (Windows refuses while a file is open)', async () => {
    // Arrange
    const a = await app();
    // Act
    await a.close();
    const remove = () => fs.rmSync(a.paths.dataDir, { recursive: true });
    // Assert
    expect(remove).not.toThrow();
    expect(fs.existsSync(a.paths.dataDir)).toBe(false);
  });

  // The 3 s wait is the subject: fake setTimeout from before createApp, so the probe's timer is one.
  it('cancels the encoder probe that was due after start', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const a = await app();
    const probe = vi.spyOn(a.live.quality, 'probe').mockResolvedValue();
    // Act
    await a.close();
    vi.advanceTimersByTime(ENCODER_PROBE_DELAY_MS);
    // Assert
    expect(probe).not.toHaveBeenCalled();
  });

  it('while the app is open, the encoder probe runs once, after ENCODER_PROBE_DELAY_MS', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const a = await app();
    const probe = vi.spyOn(a.live.quality, 'probe').mockResolvedValue();
    // Act
    vi.advanceTimersByTime(ENCODER_PROBE_DELAY_MS - 1);
    // Assert
    expect(probe).not.toHaveBeenCalled();
    // Act
    vi.advanceTimersByTime(1);
    // Assert
    expect(probe).toHaveBeenCalledOnce();
  });

  it('ends a blocklist download in flight; nothing reaches the data folder', async () => {
    // Arrange
    const server = await hangingListServer();
    const a = await app({ blockKnownBadIps: true, blocklists: [], extraBlocklistUrls: [server.url] });
    await server.requested;
    // Act
    await a.close();
    // Assert
    await server.abandoned;
    expect(filesIn(path.join(a.paths.dataDir, 'blocklists'))).toEqual([]);
  });
});
