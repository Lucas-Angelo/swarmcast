// The ONE place for SwarmCast branding on the site (logo, favicon, mascot). Colours, the font,
// radii and shadows are NOT here: they come from the shared tokens in assets/brand/tokens.css
// (repo root), which the site maps onto Starlight in src/styles/starlight.css.
//
//   logo     undefined = the placeholder mark (src/components/LogoMark.astro) + the "SwarmCast"
//            wordmark set in the site font. To use the real logo, put the SVG files in
//            assets/brand/ (repo root) and set e.g.
//              { mark: 'mark.svg', alt: 'SwarmCast' }
//            The mark is shown next to the wordmark (text, so it stays crisp and translatable).
//            With `full: 'logo.svg'` (and optionally `fullDark: 'logo-dark.svg'`) the full lockup
//            replaces mark + wordmark.
//   favicon  A file in site/public/ (served at /swarmcast/<name>): SVG, PNG or ICO.
//   mascot   { file: 'mascot.png', alt: { en: '…', 'pt-BR': '…' } } with the file in
//            assets/brand/. Shown in the landing page's closing section. undefined = no mascot.

/**
 * @type {{
 *   name: string,
 *   logo: undefined | { mark?: string, full?: string, fullDark?: string, alt: string },
 *   favicon: string,
 *   mascot: undefined | { file: string, alt: { en: string, 'pt-BR': string } },
 * }}
 */
export const brand = {
  name: 'SwarmCast',
  logo: undefined,
  favicon: '/favicon.svg',
  mascot: undefined,
};

/** Public URLs used across the site (kept here so a fork only changes one file). */
export const links = {
  site: 'https://lucas-angelo.github.io',
  base: '/swarmcast',
  repo: 'https://github.com/Lucas-Angelo/swarmcast',
  releases: 'https://github.com/Lucas-Angelo/swarmcast/releases/latest',
  issues: 'https://github.com/Lucas-Angelo/swarmcast/issues',
  license: 'https://github.com/Lucas-Angelo/swarmcast/blob/main/LICENSE',
};
