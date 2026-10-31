#!/usr/bin/env node
// Serves site/dist under /swarmcast/ like GitHub Pages (index.html for folders, 404.html for
// missing files). Used by the Playwright tests; no dependencies.
//   node test/serve.mjs [port]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const BASE = '/swarmcast';
const PORT = Number(process.argv[2] ?? process.env.SITE_E2E_PORT ?? 13210);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pf_meta': 'application/octet-stream',
};

function send(res, status, file) {
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === BASE) {
      res.writeHead(301, { Location: `${BASE}/` }).end();
      return;
    }
    if (!p.startsWith(`${BASE}/`)) return send(res, 404, path.join(DIST, '404.html'));
    p = p.slice(BASE.length);
    const file = path.join(DIST, path.normalize(p));
    if (!file.startsWith(DIST)) return send(res, 404, path.join(DIST, '404.html'));
    const candidate = p.endsWith('/') ? path.join(file, 'index.html') : file;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return send(res, 200, candidate);
    if (fs.existsSync(path.join(file, 'index.html'))) {
      res.writeHead(301, { Location: `${url.pathname}/` }).end();
      return;
    }
    send(res, 404, path.join(DIST, '404.html'));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`site on http://127.0.0.1:${PORT}${BASE}/`));
