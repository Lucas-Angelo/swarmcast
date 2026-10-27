# tunnel-limit

Measures the concurrency limit of a Cloudflare **quick tunnel** (`*.trycloudflare.com`) for SwarmCast's traffic pattern: long-lived WebSockets plus short HLS-like GETs. Cloudflare documents "200 in-flight requests"; this tells you what counts toward it. Results and what they mean for SwarmCast: [docs/ARCHITECTURE.md, "Quick tunnel limit"](../../../docs/ARCHITECTURE.md#quick-tunnel-limit-measured-2026-10-26). The raw output of the 2026-10-26 run is in `results/`.

It needs no SwarmCast: it starts a tiny local HTTP + WebSocket origin on 127.0.0.1 (random port), opens **one** quick tunnel with the bundled cloudflared, waits until the hostname resolves (Cloudflare DoH, then the system resolver; it connects to the DoH address so a cached NXDOMAIN cannot get in the way), and runs:

| Phase | What | Answers |
|---|---|---|
| `a` | Idle WebSockets, +25 every 10 s up to 400, a small message every 2 s on each, 3 HTTP probes per step | Do open WebSockets count? Do existing sockets drop at the limit? |
| `c` | Waves of concurrent slow requests (2.5 s to first byte), 100 → 300; then slow *bodies* (headers at once, body after 2.5 s) | Where do 429s start? Does a long download count? |
| `b` | K = 50 / 100 / 150 open WebSockets + slow waves around 200 − K + closed-loop 300 KB GETs | Do open sockets eat HTTP headroom? |

Each step records upgrades and status codes (429?), how many requests reached the origin at once, ping round trips, dropped sockets and cloudflared's own metrics (`cloudflared_tunnel_concurrent_requests_per_tunnel`).

## Run

```sh
npm ci                                   # for `ws`
npm run fetch-bins                       # or copy vendor/ from another checkout (gitignored)
node scripts/test/tunnel-limit/run.mjs --local          # self-test against 127.0.0.1, no Cloudflare
node scripts/test/tunnel-limit/run.mjs                  # the real thing: ~5 min, one quick tunnel
```

Options: `--phases a,c,b` (any subset), `--max-ws 400`, `--step 25`, `--hold 10` (seconds per step), `--budget 540` (hard stop, seconds), `--out DIR` (default: a new folder in the OS temp dir), `--cloudflared PATH`.

Output: `run.log` (what you saw on screen), `results.json` (every step), `cloudflared.log`. Strip the tunnel hostname before committing results.

## Etiquette

This runs against Cloudflare's free, shared infrastructure. Keep it modest:

- **Run it rarely**: when cloudflared or Cloudflare's documentation changes, or to check a design decision. Not in CI, not in a loop.
- **One tunnel, one machine, a few minutes.** Quick tunnel creation is rate limited; the harness creates exactly one and gives up if Cloudflare refuses it.
- It stops a phase after two steps in a row with 429s or failures (or one step with more than 20 % 429s for HTTP), backs off on 429 during the 300 KB load, caps that load at 80 MB per step, and has a hard time budget (`--budget`).
- It always stops **its own** cloudflared (SIGTERM, then SIGKILL; also on Ctrl-C and on exit) and checks that the process is gone. It never touches other cloudflared processes, such as a running SwarmCast.
- It identifies itself with a `User-Agent` pointing at this README.
- The origin binds to 127.0.0.1 on a random port and only serves random bytes, so nothing private goes through the tunnel.
