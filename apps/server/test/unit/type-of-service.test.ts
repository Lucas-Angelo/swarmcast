import { spawn } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { guardTypeOfService } from '../../src/core/type-of-service.js';

// Node 24's fetch (undici 7.x) calls socket.setTypeOfService(0) right after a new connection is
// up and before the request is written. On macOS the OS refuses that (EINVAL) on a socket the
// other side has just reset, and Node throws it inside the socket's `connect` event: an uncaught
// exception that stopped SwarmCast (seen in CI: desktop mode died while stopping the live).
// src/core/type-of-service.ts makes the call best effort, as Node does on Windows and undici
// does upstream (nodejs/undici#5544). See the comment there.

const restores: Array<() => void> = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const off of cleanups.splice(0).reverse()) await off();
  for (const restore of restores.splice(0).reverse()) restore();
});

/**
 * Uncaught exceptions while the test runs (what stopped the app). `first` rejects with the first
 * one: the request it came from never settles, so a test waits for either.
 */
function collectUncaught(): { seen: string[]; first: Promise<never> } {
  const seen: string[] = [];
  let fail: (err: Error) => void = () => {};
  const first = new Promise<never>((_resolve, reject) => (fail = reject));
  first.catch(() => {});
  const on = (err: Error): void => {
    seen.push(err.message);
    fail(err);
  };
  process.on('uncaughtException', on);
  cleanups.push(() => process.off('uncaughtException', on));
  return { seen, first };
}

/**
 * A server in its own process that resets (RST) every connection as it arrives. Its own process:
 * the reset must be able to land while this process handles the new connection, between
 * "connected" and the first write, which a server sharing this event loop never does.
 */
async function resettingServer(): Promise<number> {
  const code = "const s=require('net').createServer((c)=>c.resetAndDestroy());s.listen(0,'127.0.0.1',()=>process.stdout.write(s.address().port+'\\n'));process.stdin.on('end',()=>process.exit(0)).resume();";
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Closing its stdin stops it; the test ends once it is gone.
  cleanups.push(() => {
    child.stdin.end();
    return exited;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim())));
  });
}

function listen(server: net.Server): Promise<number> {
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

describe('guardTypeOfService', () => {
  it('a new connection whose type-of-service the OS refuses still sends its request, and nothing is thrown', async () => {
    // Arrange: every new connection of fetch() gets a socket whose setsockopt answers EINVAL,
    // as macOS does once the peer has reset it, at the moment undici reports it connected.
    restores.push(guardTypeOfService());
    const port = await listen(http.createServer((_req, res) => res.end('ok')));
    const uncaught = collectUncaught();
    const refuse = (msg: unknown): void => {
      const handle = (msg as { socket: { _handle: { setTypeOfService?: (tos: number) => number } | null } }).socket._handle;
      if (handle) handle.setTypeOfService = () => -os.constants.errno.EINVAL;
    };
    diagnostics.subscribe('undici:client:connected', refuse);
    cleanups.push(() => diagnostics.unsubscribe('undici:client:connected', refuse));
    // Act
    const res = await Promise.race([fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } }), uncaught.first]);
    const body = await res.text();
    // Assert
    expect(uncaught.seen).toEqual([]);
    expect(res.status).toBe(200);
    expect(body).toBe('ok');
  });

  it('fetches to a server that resets every connection all reject, and nothing is thrown', async () => {
    // Arrange: a real reset each time. On macOS without the guard about 6 in 100 of these threw
    // "setTypeOfService EINVAL" out of the socket (Node 24.19 to 24.22.2), so 300 always hit it.
    restores.push(guardTypeOfService());
    const port = await resettingServer();
    const uncaught = collectUncaught();
    const outcomes = { rejected: 0, answered: 0 };
    // Act
    for (let i = 0; i < 300; i++) {
      await Promise.race([
        fetch(`http://127.0.0.1:${port}/`).then(
          () => outcomes.answered++,
          () => outcomes.rejected++,
        ),
        uncaught.first,
      ]);
    }
    // Assert
    expect(uncaught.seen).toEqual([]);
    expect(outcomes).toEqual({ rejected: 300, answered: 0 });
  });

  it('still throws for a wrong value, ignores only what the OS answers, and can be undone', () => {
    // Arrange
    class Plain extends net.Socket {}
    const original = net.Socket.prototype.setTypeOfService;
    const restore = guardTypeOfService();
    const again = guardTypeOfService();
    const socket = new Plain();
    // Act
    const wrong = (): unknown => socket.setTypeOfService(256);
    const notConnected = socket.setTypeOfService(0);
    again();
    const stillGuarded = net.Socket.prototype.setTypeOfService !== original;
    restore();
    // Assert
    expect(wrong).toThrow(RangeError);
    expect(notConnected).toBe(socket);
    expect(stillGuarded).toBe(true);
    expect(net.Socket.prototype.setTypeOfService).toBe(original);
    expect(Object.getOwnPropertyDescriptor(net.Socket.prototype, 'setTypeOfService')?.enumerable).toBe(true);
  });
});
