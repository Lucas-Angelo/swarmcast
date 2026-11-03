import net from 'node:net';

const GUARDED = Symbol.for('swarmcast.typeOfServiceGuard');

type Guarded = net.Socket & { [GUARDED]?: true };

/**
 * Makes `net.Socket#setTypeOfService` best effort, so an outbound `fetch()` whose connection the
 * other side resets can only fail that one request, never stop SwarmCast.
 *
 * Node 24's built-in fetch (undici 7.x) calls `socket.setTypeOfService(0)` before the first
 * request on every new connection. On macOS, `setsockopt` answers EINVAL on a socket the peer
 * has already reset, and Node throws that synchronously inside the socket's `connect` event:
 * an uncaught exception, not a rejected fetch. Measured on macOS with Node 24.22.1 (the Node
 * the release builds bundle): about 6 in 100 fetches to a server that resets each connection
 * threw it. Node already ignores the error on Windows; undici fixed it upstream the same way
 * (nodejs/undici#5544, fix #5547 in 8.x = Node 26; 7.x backport #6076, not in a Node 24 release
 * yet). Remove this once the Node 24 line bundles undici with #6076.
 *
 * Only the socket-option error itself is ignored (argument errors still throw): the request
 * then fails on its own (ECONNRESET / EPIPE) and its fetch rejects, as on Node 26.
 * Returns a function that puts the original method back (tests).
 */
export function guardTypeOfService(proto: net.Socket = net.Socket.prototype): () => void {
  const target = proto as Guarded;
  if (Object.prototype.hasOwnProperty.call(target, GUARDED)) return () => {};
  const before = Object.getOwnPropertyDescriptor(target, 'setTypeOfService');
  const original = target.setTypeOfService;
  if (typeof original !== 'function') return () => {};
  const guarded = function (this: net.Socket, tos: number): net.Socket {
    try {
      return original.call(this, tos);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).syscall === 'setTypeOfService') return this;
      throw err;
    }
  };
  Object.defineProperty(target, 'setTypeOfService', { value: guarded, writable: true, configurable: true, enumerable: before?.enumerable ?? false });
  Object.defineProperty(target, GUARDED, { value: true, configurable: true });
  return () => {
    delete target[GUARDED];
    if (before) Object.defineProperty(target, 'setTypeOfService', before);
    else delete (target as Partial<net.Socket>).setTypeOfService;
  };
}
