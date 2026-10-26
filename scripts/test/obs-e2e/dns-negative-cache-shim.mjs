// Test-only workaround, preloaded into the SwarmCast process with `node --import`.
//
// Problem it works around (an app bug, see README): right after cloudflared prints the new
// https://<words>.trycloudflare.com address, the DNS record does not exist yet for a second or two.
// SwarmCast's waitForReachable() probes it immediately; the NXDOMAIN answer is then cached by the
// local resolver (home router / ISP) — ~80 s on the machine this was written on — which is longer
// than the 60 s reachability timeout, so "Start" fails twice and gives up.
//
// This shim delays the first fetch() to each new *.trycloudflare.com host by a few seconds, which is
// what the suggested fix does. run.mjs only uses it after a start without it has failed.
const DELAY_MS = 4000;
const firstSeen = new Map();
const original = globalThis.fetch;
globalThis.fetch = async function shimmedFetch(input, init) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.hostname.endsWith('.trycloudflare.com')) {
      if (!firstSeen.has(url.hostname)) firstSeen.set(url.hostname, Date.now());
      const wait = firstSeen.get(url.hostname) + DELAY_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  } catch {
    /* not a URL we care about */
  }
  return original(input, init);
};
