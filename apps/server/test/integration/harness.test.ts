import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hasFfmpeg, startFeed, stopTracked, until } from './helpers.js';

afterEach(stopTracked);

/** A local port nothing listens on (bound once by the OS, then released). */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.skipIf(!hasFfmpeg)('test harness: a dead fake OBS', () => {
  // The canary for "a wait burns its whole budget on a feed that died at once" (once 40 + 60 s).
  it('fails the wait that depends on it in under 5 s, with ffmpeg\'s reason and the stream key masked', async () => {
    const key = 'sc_canarycanarycanarycana';
    const feed = startFeed(`rtmp://127.0.0.1:${await closedPort()}/live/${key}`);
    const t0 = Date.now();
    const err = await until(() => false, { timeoutMs: 60_000, what: 'a live that never starts', abortOn: [feed] }).catch((e: Error) => e);
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^a live that never starts: fake OBS exited \((code [1-9]\d*|SIG\w+)\)/);
    expect(msg).toContain('--- last output of fake OBS:');
    expect(msg).not.toContain(key);
    expect(elapsed).toBeLessThan(5000);
  });
});
