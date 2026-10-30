// A local release server for the tests of the real start scripts and installers: the files of
// one folder over plain HTTP on 127.0.0.1 (a port the OS picks, so it never collides and never
// listens on a public interface: no firewall prompt).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves `root` on 127.0.0.1. GET and HEAD of a file under it answer 200, anything else 404 (no
 * listing, no path outside `root`).
 * - `resolve(name)`: the file a request path names, relative to `root` (default: the path itself),
 *   e.g. to answer one feed name with another file.
 * - `onRequest({ method, path, status })`: called once per request, after the answer is chosen.
 * @param {string} root
 * @param {{ resolve?: (name: string) => string, onRequest?: (r: { method: string, path: string, status: number }) => void }} [o]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function serveDir(root, o = {}) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    let name;
    try {
      name = decodeURIComponent(pathname);
    } catch {
      name = '';
    }
    // join() folds "..": a name that climbs out of `root` fails the prefix check below.
    const file = path.join(base, o.resolve ? o.resolve(name) : name);
    let size = -1;
    try {
      // A folder, a missing file and a path outside `root` are all a 404.
      if (file.startsWith(base + path.sep) && (req.method === 'GET' || req.method === 'HEAD')) {
        const st = fs.statSync(file);
        if (st.isFile()) size = st.size;
      }
    } catch {
      size = -1;
    }
    const status = size >= 0 ? 200 : 404;
    o.onRequest?.({ method: req.method ?? 'GET', path: pathname, status });
    if (status === 404) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        // Ends kept-alive connections too, so close() resolves at once instead of after their timeout.
        close: () => new Promise((done) => server.close(() => done()).closeAllConnections()),
      });
    });
  });
}
