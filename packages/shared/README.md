# @swarmcast/shared

TypeScript sources consumed directly by the other workspaces, with no build output (`exports: ./src/index.ts`).

- `src/constants.ts`: default ports (1935/8080/8081/8888), 2 s segments, 10-min session/ticket TTL, STUN server, message size limits, hash-failure threshold, cookie names.
- `src/schemas.ts`: zod schemas and types for the join request (nickname rules), viewer config, control-channel messages, integrity manifest, admin state and settings.
- `src/capacity.ts`: `estimateCapacity()`, which estimates how many viewers the upload can serve directly and with P2P.

## Brand layer (`web/`)

`web/brand.css` is imported first by `apps/admin/src/style.css` and `apps/viewer/src/style.css`. It pulls in the brand tokens from `assets/brand/tokens.css` (the single source of colours, fonts, radii and shadows), Inter Variable (`@fontsource-variable/inter`, same package as the website) and Fredoka SemiBold (`web/fonts/`, subset from `assets/brand/font/`), and holds the spacing/type scale, the tooltip and focus styles both apps share, and the old-variable to token mapping. Vite bundles everything into each app's `/assets`, so the CSP needs only `'self'`.

Brand images, all set in one block of `web/brand.css`:

- **Logo** (`.sc-symbol`, panel header and viewer pages): `assets/brand/symbol/swarmcast-symbol.svg`, and `-on-dark.svg` in the dark theme.
- **Mascot** (`.sc-mascot-hello` in the setup tutorial welcome; `.sc-mascot-sleep` in the empty viewers list and the viewer's "stream ended" screen): `web/img/mascot-*-256.webp`, 256 px WebP copies of `assets/brand/mascot/mascot-*.png` (the originals are about 600 KB each).
- **Favicon**: each app's HTML links `assets/brand/favicon/favicon.svg`.

Typecheck: `npm run typecheck -w @swarmcast/shared`. Tests live in `apps/server/test/unit/shared.test.ts`.
