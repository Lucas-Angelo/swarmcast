// A local stand-in for the publisher of the ffmpeg build the app installs for streamers
// (scripts/build/versions.json "ffmpeg"), for the system tests: it serves the pinned archive on
// 127.0.0.1, and the app downloads it from there (SWARMCAST_TEST_FFMPEG_URL, read by
// apps/server/src/quality/ffmpeg.ts) instead of from github.com, so a GitHub outage cannot fail the
// gate (docs/TESTING.md, "No third-party service in the gate"). Everything else is the app's real
// install: the same SHA-256 check (a wrong file still fails), extraction and `ffmpeg -version`.
//
// The archive comes from CI's download cache: the setup action's `app-ffmpeg` input fetches it
// there before the tests (fetch-binaries.mjs --only ffmpeg, with its own recoveries), so the
// test step itself reaches no service on the internet.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pinnedArchive } from './pinned-archive.mjs';

/**
 * The verified archive of the app's ffmpeg pin `a` (versions.json `ffmpeg.assets[<target>]`) in
 * SC_DOWNLOAD_CACHE (pinned-archive.mjs). Throws, saying how to get it, when it is missing or wrong.
 * @param {{ asset: string, sha256: string }} a
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function pinnedFfmpegArchive(a, env = process.env) {
  return pinnedArchive(a, { tool: 'ffmpeg', setupInput: 'app-ffmpeg', env });
}

/**
 * Serves `file` at http://127.0.0.1:<port>/<its name> (any other path: 404). With
 * `stallAfterHeaders` it sends the headers and then nothing, as a stalled download does.
 * `appEnv` is what the app needs to download from it; `requests()` counts the downloads asked for.
 * @param {string} file
 * @param {{ stallAfterHeaders?: boolean }} [o]
 * @returns {Promise<{ url: string, appEnv: { SWARMCAST_TEST_FFMPEG_URL: string }, requests: () => number, close: () => Promise<void> }>}
 */
export async function startFfmpegStandIn(file, { stallAfterHeaders = false } = {}) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== `/${name}`) {
      res.writeHead(404).end();
      return;
    }
    requests++;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
    if (stallAfterHeaders) {
      res.flushHeaders();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const url = `http://127.0.0.1:${server.address().port}/${name}`;
  return {
    url,
    appEnv: { SWARMCAST_TEST_FFMPEG_URL: url },
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
