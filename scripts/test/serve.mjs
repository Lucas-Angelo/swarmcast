#!/usr/bin/env node
// Tiny static file server for the installer tests (lib/release-server.mjs as a command).
//
//   node serve.mjs ROOT_DIR PORT_FILE REQUEST_LOG
//
// Listens on 127.0.0.1 (random port), writes the port to PORT_FILE once ready and appends
// one line per request ("GET /name 200") to REQUEST_LOG.
// `node serve.mjs --free-port` prints a port that is free (and closed) right now.
import fs from 'node:fs';
import http from 'node:http';
import { serveDir } from './lib/release-server.mjs';

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
  const server = await serveDir(root, { onRequest: (r) => fs.appendFileSync(requestLog, `${r.method} ${r.path} ${r.status}\n`) });
  // Written in one go once the server listens: a reader that sees the file sees the whole port.
  fs.writeFileSync(portFile, String(server.port));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void server.close().then(() => process.exit(0)));
}
