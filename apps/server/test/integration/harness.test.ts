import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hasFfmpeg, startFeed, stopTracked, until } from './helpers.js';

const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await stopTracked();
});

/**
 * An RTMP port that hangs up on every connection at once, like a server refusing the stream.
 * Not a closed port: how fast a connection to a closed port fails is up to the OS (Windows took
 * 5.3 s to give up on one, ETIMEDOUT, where Linux and macOS refuse at once).
 */
async function hangUpPort(): Promise<number> {
  const s = net.createServer((socket) => socket.destroy());
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as net.AddressInfo).port;
}

describe.skipIf(!hasFfmpeg)('test harness: a dead fake OBS', () => {
  // The canary for "a wait burns its whole budget on a feed that died at once" (once 40 + 60 s).
  it("fails the wait that depends on it as soon as it exits, with ffmpeg's reason and the stream key masked", async () => {
    const key = 'sc_canarycanarycanarycana';
    const feed = startFeed(`rtmp://127.0.0.1:${await hangUpPort()}/live/${key}`);
    let exitedAt = 0;
    feed.child.once('exit', () => (exitedAt = Date.now()));
    const t0 = Date.now();
    const err = await until(() => false, { timeoutMs: 60_000, what: 'a live that never starts', abortOn: [feed], pollMs: 60_000 }).catch((e: Error) => e);
    const failedAt = Date.now();
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^a live that never starts: fake OBS exited \((code [1-9]\d*|SIG\w+)\)/);
    expect(msg).toContain('--- last output of fake OBS:');
    expect(msg).not.toContain(key);
    // The wait reacts to the exit itself (no poll: pollMs is 60 s), after at most the 500 ms the
    // harness gives the pipes to drain, so the error carries ffmpeg's last lines.
    expect(exitedAt).toBeGreaterThan(0);
    expect(failedAt - exitedAt).toBeLessThan(1000);
    expect(failedAt - t0).toBeLessThan(5000);
  });
});
