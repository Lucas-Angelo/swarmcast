# @swarmcast/viewer

Static pages served by the public server: `join.html` (nickname form, browser check), `watch.html` (player) and `invalid.html` (expired or invalid link), in English and Brazilian Portuguese, on the Forest & Cream brand (`@swarmcast/shared/web/brand.css`). They contain no inline scripts or styles, so the strict CSP holds.

- Build: `npm run build -w @swarmcast/viewer` → `dist/`, served from `web/viewer` in release packages.
- Tested through the server's Playwright suite (`npm run test:e2e`). `npm run dev -w @swarmcast/viewer` alone has no backend, so run the server for real testing.
- Key files in `src/`:
  - `watch.ts`: hls.js + p2p-media-loader setup, "Stable" (about 20 s behind live, the default) or "Lower delay" profile, P2P off by default (opt-in; a viewer who turns it on keeps it on), "Go live" button, control channel.
  - `quality-menu.ts`, `latency-toggle.ts`, `player-config.ts`: the quality menu (Auto or one rendition), the Stable / Lower delay switch and the player settings ([docs/QUALITY.md](../../docs/QUALITY.md)).
  - `integrity.ts`: verifies the Ed25519-signed manifest and checks every P2P segment's SHA-256.
  - `peer-guard.ts`: closes connections to blocked peers by matching ICE ufrags from tracker signaling.
  - `join.ts`: the nickname form; `pow.ts` + `pow-worker.ts`: the proof-of-work browser check (on by default, remembered per browser), with its progress bar.
