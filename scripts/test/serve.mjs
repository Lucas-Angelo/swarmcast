#!/usr/bin/env node
// Tiny static file server for the installer tests.
//
//   node serve.mjs ROOT_DIR PORT_FILE REQUEST_LOG
//
// Listens on 127.0.0.1 (random port), writes the port to PORT_FILE once ready and appends
// one line per request ("GET /name 200") to REQUEST_LOG.
// `node serve.mjs --free-port` prints a port that is free (and closed) right now.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (process.argv[2] === '--free-port') {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => console.log(port));
  });
} else {
  const [root, portFile, requestLog] = process.argv.slice(2);
  if (!root || !portFile || !requestLog) {
    console.error('usage: serve.mjs ROOT_DIR PORT_FILE REQUEST_LOG');
    process.exit(2);
  }
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = path.resolve(base, '.' + decodeURIComponent(url.pathname));
    let status = 404;
    let data = null;
    try {
      // Read directly (no exists/stat check first): a folder or a missing file throws.
      if (file.startsWith(base + path.sep)) data = fs.readFileSync(file);
    } catch {
      data = null;
    }
    if (data) {
      status = 200;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
    }
    fs.appendFileSync(requestLog, `${req.method} ${url.pathname} ${status}\n`);
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(portFile, String(server.address().port));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
