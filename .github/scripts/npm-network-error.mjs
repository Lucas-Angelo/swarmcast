#!/usr/bin/env node
// Did a failed `npm ci` fail on the network? The setup action (.github/actions/setup, "npm ci")
// runs `npm ci` once more only then: an infrastructure retry, like apt-retry.sh
// (.github/workflows/README.md, "Rules"). Any other failure fails the step.
//
//   node .github/scripts/npm-network-error.mjs <npm ci log>
//
// Exit 0 and print the line that shows it when the log has a network error, 1 when it has none,
// 2 when the log cannot be read.
//
// Network errors:
// - npm's own, after its fetch-retries: `npm error code ETIMEDOUT` (and the other socket codes
//   below) or `npm error network ...`;
// - prebuild-install's, in a native package's install script (the output npm prints, each line
//   after `npm error `, when the script fails): `prebuild-install warn install <message>`, where a
//   network message is simple-get's "Request timed out" (prebuild-install gives a download 30 s),
//   a Node socket error (`connect ETIMEDOUT 140.82.112.4:443`, `getaddrinfo ENOTFOUND github.com`,
//   `read ECONNRESET`...), "socket hang up" or a TLS handshake cut off. Its other message, "No
//   prebuilt binaries found", is any answer but 200 (also a 404 for a binary that does not exist),
//   so it is not one: a re-run would not change it. Pipeline run 41664754395: node-datachannel's
//   download from GitHub timed out on macos-15-intel, its build from source failed, and the old
//   pattern (npm's lines only) failed the step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOCKET_CODES = 'ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ERR_SOCKET_TIMEOUT|ENETUNREACH|EHOSTUNREACH|EPIPE';

/** npm's own: the code line of a failed request, or its "network" explanation. */
const NPM = new RegExp(`^npm error (?:code (?:${SOCKET_CODES})$|network )`);
/** prebuild-install's warning when its download failed, with a network message. */
const PREBUILD = new RegExp(
  `(?:^|\\s)prebuild-install warn install (?:Request timed out$|socket hang up$|Client network socket disconnected before secure TLS connection was established$|(?:connect|read|write|getaddrinfo) (?:${SOCKET_CODES})\\b)`,
);

/**
 * The first line of an `npm ci` log that shows a network error (see the top of this file), or
 * null. Colour codes and Windows line ends are ignored.
 * @param {string} log
 * @returns {string | null}
 */
export function networkError(log) {
  for (const raw of log.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, '').trimEnd();
    if (NPM.test(line) || PREBUILD.test(line)) return line;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  let log;
  try {
    if (!file) throw new Error('usage: npm-network-error.mjs <npm ci log>');
    log = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`npm-network-error: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  const line = networkError(log);
  if (line) console.log(line);
  process.exit(line ? 0 : 1);
}
