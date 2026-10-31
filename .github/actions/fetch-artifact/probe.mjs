// fetch-artifact diagnostics (rest.sh diagnose): one GET of an artifact's blob URL with Node.js's
// https client, the runtime actions/download-artifact downloads with, the way it asks (a whole-file
// GET, no range). Prints the resolver's answer, when the socket was looked up, connected and
// secured, the HTTP status with Azure's error code and request id, and the exact error (code,
// syscall, address; each inner error of an AggregateError). Stops after 8 MiB or 30 s. Never
// prints the URL's query (its signature).
//
//   node probe.mjs URL
import dns from 'node:dns/promises';
import https from 'node:https';

const LIMIT_BYTES = 8 * 1024 * 1024;
const LIMIT_MS = 30_000;
const url = new URL(process.argv[2] ?? '');
const t0 = performance.now();
const at = () => `${Math.round(performance.now() - t0)} ms`;
const log = (line) => console.log(`${line} (${at()})`);

function describe(err) {
  if (!(err instanceof Error)) return String(err);
  const e = /** @type {NodeJS.ErrnoException & { errors?: unknown[] }} */ (err);
  const parts = [`${e.name}: ${e.message || '(no message)'}`];
  for (const key of ['code', 'errno', 'syscall', 'hostname', 'address', 'port']) {
    if (e[key] !== undefined) parts.push(`${key}=${e[key]}`);
  }
  if (Array.isArray(e.errors)) parts.push(`inner: [${e.errors.map(describe).join(' | ')}]`);
  return parts.join(' ');
}

log(`node ${process.version}, GET https://${url.host}${url.pathname}`);
try {
  const all = await dns.lookup(url.hostname, { all: true });
  log(`dns.lookup ${url.hostname}: ${all.map((a) => `${a.address} (IPv${a.family})`).join(', ')}`);
} catch (err) {
  log(`dns.lookup ${url.hostname} failed: ${describe(err)}`);
}

await new Promise((resolve) => {
  const stop = setTimeout(() => {
    log(`stopped: no end after ${LIMIT_MS} ms`);
    req.destroy();
    resolve();
  }, LIMIT_MS);
  const done = () => {
    clearTimeout(stop);
    resolve();
  };
  const req = https.get(url, (res) => {
    const h = res.headers;
    log(
      `HTTP ${res.statusCode} ${res.statusMessage}; content-type=${h['content-type']} content-length=${h['content-length']}` +
        ` x-ms-request-id=${h['x-ms-request-id']} x-ms-error-code=${h['x-ms-error-code'] ?? '-'}`,
    );
    let bytes = 0;
    let errorBody = '';
    res.on('data', (chunk) => {
      bytes += chunk.length;
      if (res.statusCode !== 200 && errorBody.length < 600) errorBody += chunk.toString('utf8');
      if (bytes >= LIMIT_BYTES) {
        log(`read ${bytes} bytes; stopping (the probe does not download the whole file)`);
        req.destroy();
        done();
      }
    });
    res.on('end', () => {
      log(`body ended after ${bytes} bytes${errorBody ? `: ${errorBody.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`);
      done();
    });
    res.on('error', (err) => {
      log(`response error after ${bytes} bytes: ${describe(err)}`);
      done();
    });
  });
  req.on('socket', (socket) => {
    socket.on('lookup', (err, address, family) =>
      log(err ? `socket lookup failed: ${describe(err)}` : `socket lookup: ${address} (IPv${family})`),
    );
    socket.on('connect', () => log(`connected to ${socket.remoteAddress}:${socket.remotePort}`));
    socket.on('secureConnect', () => log(`TLS ${socket.getProtocol?.()} established`));
  });
  req.on('error', (err) => {
    log(`request error: ${describe(err)}`);
    done();
  });
});
process.exit(0);
