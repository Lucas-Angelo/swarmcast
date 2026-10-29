# Streamer branding ("Your page")

Draft. BR0 spike findings for v0.4.0; the full document (data model, routes, threat model
additions, panel guide) is written in BR7. Plan: `.claude/test-plans/branding-0.4.0.md`.

## BR0 findings (2026-10-29)

### 1. Link previews today

Read from the code (`apps/server/src/public/server.ts`): `GET /join/<secret>` sets the ticket
cookie and answers `303 → /join`. `/join` without a valid ticket answers 404 with the "Link not
valid" page. A preview fetcher that does not carry the cookie across the redirect therefore
renders **"Link not valid · SwarmCast"**. BR3 answers known preview user agents directly on
`/join/<secret>` (200, Open Graph tags, no cookie) and keeps the 303 for browsers.

User agents matched (from the providers' documentation and widely published lists; real-app
captures stay a manual pre-release check): `facebookexternalhit`, `Facebot`, `meta-externalagent`,
`Twitterbot`, `WhatsApp/`, `TelegramBot`, `Discordbot`, `Slackbot-LinkExpanding`, `Slackbot`,
`LinkedInBot`, `SkypeUriPreview`, `Embedly`, `redditbot`, `Applebot`, `Iframely`, `Pinterestbot`,
`vkShare`, `Mastodon/`, `Bluesky`, `SignalLinkPreview` (Signal's proxy sends a generic UA; it falls
back to today's behaviour, which is harmless).

### 2. Canvas re-encode matrix

`createImageBitmap(file, {imageOrientation: 'from-image'})` + `OffscreenCanvas.convertToBlob`,
fixtures made with Pillow carrying EXIF (camera make/model, orientation 6, GPS), a JPEG comment
and a PNG `tEXt` chunk. Playwright 1.64, macOS:

| Engine | Orientation applied | `image/webp` gives | Source metadata in output | Engine-added metadata |
|---|---|---|---|---|
| Chromium | yes (1600×400 → 400×1600) | WebP | none | JPEG output has an `ICC_PROFILE` (sRGB) APP2 |
| WebKit (Safari, WKWebView) | yes | **PNG** (no WebP encoder) | none | PNG output has an **`eXIf` chunk**, JPEG output an `Exif` APP1 (no GPS, no camera data) |
| Firefox | not run (the local Playwright Firefox did not start; CI runs it in BR8) | | | |

Consequences: the source's GPS, camera, comments and text never survive a canvas re-encode,
but the output is **not** metadata-free (ICC profile, WebKit's own EXIF). The server stage
therefore strips every non-pixel chunk, as planned; the panel must take the type from the blob,
since WebKit answers PNG to a WebP request.

### 3. Vite and `/brand/theme.css`

A static `<link rel="stylesheet" href="/brand/theme.css">` in `join.html` survives `vite build`
unchanged (Vite logs "doesn't exist at build time, it will remain unchanged to be resolved at
runtime").

### 4. Pix BR Code

Derived from the BCB "Manual de Padrões para Iniciação do Pix" (EMV QRCPS merchant-presented
mode), static payload:

| ID | Field | Value |
|---|---|---|
| 00 | Payload Format Indicator | `01` |
| 26 | Merchant Account Information – Pix | `00` GUI `br.gov.bcb.pix`, `01` the key, `02` optional description |
| 52 | Merchant Category Code | `0000` |
| 53 | Transaction Currency | `986` (BRL) |
| 54 | Transaction Amount | omitted (the payer types the amount) |
| 58 | Country Code | `BR` |
| 59 | Merchant Name | 1–25 characters, ASCII (transliterated) |
| 60 | Merchant City | 1–15 characters, ASCII |
| 62 | Additional Data, `05` Reference Label | `***` (static code without a transaction id) |
| 63 | CRC16 | CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the whole payload including `6304`, 4 uppercase hex digits |

Each field is `ID` + 2-digit length + value; field 26's value nests the same layout. The bank-app
check was skipped (user decision); `packages/shared/src/branding/pix.ts` reproduces the payload
byte for byte and its tests decode the QR code with an independent decoder.
