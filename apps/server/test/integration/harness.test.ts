import net from 'node:net';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { hasFfmpeg, startFeed, stopTracked, until } from './helpers.js';

// The canary for "a wait burns its whole budget on a feed that died at once" (once 40 + 60 s):
// a wait that depends on the fake OBS fails as soon as ffmpeg exits, with ffmpeg's reason and
// the stream key masked. The wait has no poll to fall back on (pollMs is as long as its
// timeout), so only the exit itself can end it early.

/** How long the wait may wait in all: the timeout it would burn without the exit. */
const WAIT_BUDGET_MS = 60_000;
/**
 * The wait fails this soon after ffmpeg exits: at most the 500 ms the harness gives the pipes
 * to drain (so the error carries ffmpeg's last lines), plus scheduling.
 */
const REACTION_MS = 1000;
/** From the start of the wait to its failure: ffmpeg gives up on a refused stream at once. */
const FAILS_WITHIN_MS = 5000;

afterEach(stopTracked);

/**
 * An RTMP port that hangs up on every connection at once, like a server refusing the stream.
 * Not a closed port: how fast a connection to a closed port fails is up to the OS (Windows took
 * 5.3 s to give up on one, ETIMEDOUT, where Linux and macOS refuse at once).
 */
async function hangUpPort(): Promise<number> {
  const s = net.createServer((socket) => socket.destroy());
  onTestFinished(() => new Promise<void>((resolve) => s.close(() => resolve())));
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return (s.address() as net.AddressInfo).port;
}

describe.skipIf(!hasFfmpeg)('test harness: a dead fake OBS', () => {
  it("fails the wait that depends on it as soon as it exits, with ffmpeg's reason and the stream key masked", async () => {
    // Arrange
    const key = 'sc_canarycanarycanarycana';
    const port = await hangUpPort();
    // Act
    const feed = startFeed(`rtmp://127.0.0.1:${port}/live/${key}`);
    let exitedAt = 0;
    feed.child.once('exit', () => (exitedAt = Date.now()));
    const startedAt = Date.now();
    const err = await until(() => false, { timeoutMs: WAIT_BUDGET_MS, what: 'a live that never starts', abortOn: [feed], pollMs: WAIT_BUDGET_MS }).catch((e: Error) => e);
    const failedAt = Date.now();
    // Assert
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^a live that never starts: fake OBS exited \((code [1-9]\d*|SIG\w+)\)/);
    expect(msg).toContain('--- last output of fake OBS:');
    expect(msg).not.toContain(key);
    expect(exitedAt).toBeGreaterThan(0);
    expect(failedAt - exitedAt).toBeLessThan(REACTION_MS);
    expect(failedAt - startedAt).toBeLessThan(FAILS_WITHIN_MS);
  });
});
