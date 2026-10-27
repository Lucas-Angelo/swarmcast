// The ONE place for SwarmCast branding on the site (logo, favicon, mascot). Colours, the font,
// radii and shadows are NOT here: they come from the shared tokens in assets/brand/tokens.css
// (repo root), which the site maps onto Starlight in src/styles/starlight.css.
//
//   logo     Files in assets/brand/ (repo root): `mark` (+ `markDark` for the dark theme) is the
//            symbol, shown next to the "SwarmCast" wordmark set in the display font (text, so it
//            stays crisp and translatable). With `full` (and optionally `fullDark`) a full lockup
//            replaces mark + wordmark. undefined = a placeholder mark drawn by
//            src/components/Logo.astro (for forks without the brand files).
//   favicon  A file in site/public/ (served at /swarmcast/<name>): SVG, PNG or ICO.
//   mascot   { file: 'mascot.png', alt: { en: '…', 'pt-BR': '…' } } with the file in
//            assets/brand/. Shown in the landing page's closing section. undefined = no mascot.
//   author   Who makes it, for the search engines' structured data (JSON-LD on the landing page).
//
// The social preview cards (public/og/) are rendered from assets/brand/ by
// scripts/social-cards.mjs; rerun it after a brand change.

/**
 * @type {{
 *   name: string,
 *   logo: undefined | { mark?: string, markDark?: string, full?: string, fullDark?: string, alt: string },
 *   favicon: string,
 *   mascot: undefined | { file: string, alt: { en: string, 'pt-BR': string } },
 *   author: { name: string, url: string },
 * }}
 */
export const brand = {
  name: 'SwarmCast',
  logo: { mark: 'symbol/swarmcast-symbol.svg', markDark: 'symbol/swarmcast-symbol-on-dark.svg', alt: 'SwarmCast' },
  favicon: '/favicon.svg',
  mascot: {
    file: 'mascot/mascot-hello.png',
    alt: { en: 'The SwarmCast bee waving hello', 'pt-BR': 'A abelha do SwarmCast acenando' },
  },
  author: { name: 'Lucas Ângelo', url: 'https://github.com/Lucas-Angelo' },
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
