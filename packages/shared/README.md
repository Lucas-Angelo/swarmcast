# @swarmcast/shared

TypeScript sources consumed directly by the other workspaces, with no build output (`exports: ./src/index.ts`).

- `src/constants.ts`: default ports (1935/8080/8081/8888), 2 s segments, 10-min session/ticket TTL, STUN server, message size limits, hash-failure threshold, `/control` close codes, cookie names.
- `src/schemas.ts`: zod schemas and types for the join request (nickname rules), viewer config, control-channel messages, integrity manifest, admin state and settings.
- `src/capacity.ts`: `estimateCapacity()`, which estimates how many viewers the upload can serve directly and with P2P.
- `src/zod-config.ts`: zod without its JIT. The viewer and panel CSPs forbid `new Function`, so every module here that builds schemas imports it first.
- `src/i18n/` (`@swarmcast/shared/i18n`): `en.ts` (every key and its English text: the source of truth), `pt-BR.ts` (the same keys, type-checked), `index.ts` (`t`, `tc` for the server's coded texts, plurals, numbers, `guideUrl`) and `browser.ts` (language choice, translation of the static pages, tooltips).
- `src/chat/` (`@swarmcast/shared/chat`): the chat core shared by server, viewer and panel: the Unicode pipeline (`text.ts`), nickname rules (`nickname.ts`), protocol, schemas and limits. `skeleton.ts` (confusables) is server-only, so the viewer bundle never carries its table. The `*.generated.ts` tables come from `scripts/build/gen-unicode-tables.mjs`: never edit them. [docs/CHAT.md](../../docs/CHAT.md).
- `src/branding/` (`@swarmcast/shared/branding`): "Your page": schemas, limits, text and link rules, theme colours with enforced contrast, the Pix payload and QR code, and `render-dom.ts`, the text-only renderer the viewer pages and the panel preview share. [docs/BRANDING.md](../../docs/BRANDING.md).
- `src/system-check.ts` (`@swarmcast/shared/system-check`): the schema of `system-check.json`, written by the start scripts and the desktop app's first start, served by the server and shown by the panel's setup tutorial.
- `src/mux.ts`: the tracker channel inside the `/control` WebSocket (one socket per viewer, [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)). `src/playback.ts`: live-delay bounds of the player and the playlists. `src/quality.ts`: quality ladder, encoder and upload-budget types. `src/diagnostics.ts`: log retention and "Export logs" types.

## Brand layer (`web/`)

`web/brand.css` is imported first by `apps/admin/src/style.css` and `apps/viewer/src/style.css`. It pulls in the brand tokens from `assets/brand/tokens.css` (the single source of colours, fonts, radii and shadows), Inter Variable (`@fontsource-variable/inter`, same package as the website) and Fredoka SemiBold (`web/fonts/`, subset from `assets/brand/font/`), and holds the spacing/type scale, the tooltip and focus styles both apps share, and the old-variable to token mapping. Vite bundles everything into each app's `/assets`, so the CSP needs only `'self'`.

Brand images, all set in one block of `web/brand.css`:

- **Logo** (`.sc-symbol`, panel header and viewer pages): `assets/brand/symbol/swarmcast-symbol.svg`, and `-on-dark.svg` in the dark theme.
- **Mascot** (`.sc-mascot-hello` in the setup tutorial welcome; `.sc-mascot-sleep` in the empty viewers list and the viewer's "stream ended" screen): `web/img/mascot-*-256.webp`, 256 px WebP copies of `assets/brand/mascot/mascot-*.png` (the originals are about 600 KB each).
- **Favicon**: each app's HTML links `assets/brand/favicon/favicon.svg`.

Typecheck: `npm run typecheck -w @swarmcast/shared`. Tests (`npm test`): `packages/shared/test/` (the chat pipeline: hostile-string corpus, properties, ReDoS, graphemes, protocol; branding, Pix and QR; guide links) and `apps/server/test/unit/shared.test.ts`. The exhaustive 24-bit colour sweeps run only with `CHAT_EXHAUSTIVE=1` (the `chat-load.yml` workflow).
