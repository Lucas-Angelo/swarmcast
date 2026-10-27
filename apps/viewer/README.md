# @swarmcast/viewer

Static pages served by the public server: `join.html` (nickname form, browser check), `watch.html` (player) and `invalid.html` (expired or invalid link), in English and Brazilian Portuguese, on the Forest & Cream brand (`@swarmcast/shared/web/brand.css`). They contain no inline scripts or styles, so the strict CSP holds.

- Build: `npm run build -w @swarmcast/viewer` → `dist/`, served from `web/viewer` in release packages.
- Tested through the server's Playwright suite (`npm run test:e2e`, including `adaptive-delay.spec.ts`) and unit tests in `test/unit/` (`npm test`). `npm run dev -w @swarmcast/viewer` alone has no backend, so run the server for real testing.
- Key files in `src/`:
  - `watch.ts`: hls.js + p2p-media-loader setup, "Stable" (the default) or "Lower delay" profile, P2P off by default (opt-in; a viewer who turns it on keeps it on), "Go live" button, the "~14 s behind live" status, control channel.
  - `latency-controller.ts` (pure, unit tested in `test/unit/`) and `adaptive-delay.ts` (wiring): the **adaptive delay**. Each viewer's target delay adapts to their connection: Stable starts at 20 s and drifts down to 10–12 s on a firm network (12 s while P2P is on and peers deliver) or up to 30 s on an unstable one; Lower delay moves between 6 and 10 s. Inputs: segment load times vs segment duration, bandwidth estimate variance, stalls, the buffer trend, HTTP vs P2P segments. Bounds: `ADAPTIVE_DELAY` in `packages/shared/src/playback.ts`, capped by `MAX_PLAYER_DELAY_S` (`packages/shared/src/constants.ts`). `?delaySpeed=10` on the watch page runs the controller's clocks 10× faster (tests only). Details: [docs/QUALITY.md](../../docs/QUALITY.md#adaptive-delay).
  - `quality-menu.ts`, `latency-toggle.ts`, `player-config.ts`: the quality menu (Auto or one rendition), the Stable / Lower delay switch and the player settings ([docs/QUALITY.md](../../docs/QUALITY.md)).
  - `integrity.ts`: verifies the Ed25519-signed manifest and checks every P2P segment's SHA-256.
  - `peer-guard.ts`: closes connections to blocked peers by matching ICE ufrags from tracker signaling.
  - `join.ts`: the nickname form; `pow.ts` + `pow-worker.ts`: the proof-of-work browser check (on by default, remembered per browser), with its progress bar.
