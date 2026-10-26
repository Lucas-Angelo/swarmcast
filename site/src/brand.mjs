// The ONE place for SwarmCast branding on the site. Swap the placeholders here when the real
// logo, icon and mascot from assets/brand/ are ready:
//
//   logo     Starlight's header logo, e.g.
//              { src: './src/assets/brand/logo.svg', alt: 'SwarmCast', replacesTitle: true }
//            (copy the file into site/src/assets/brand/). `undefined` = the plain text title.
//   favicon  A file in site/public/ (served at /swarmcast/<name>): SVG, PNG or ICO.
//   mascot   { file: 'mascot.png', alt: { en: '…', 'pt-BR': '…' } } with the file in
//            site/src/assets/brand/ (rendered by src/components/Mascot.astro), or `undefined` for
//            the placeholder.
//   accent   The panel purple. The light/dark shades are in src/styles/custom.css.

/**
 * @type {{
 *   name: string,
 *   accent: string,
 *   logo: undefined | { src: string, alt?: string, replacesTitle?: boolean },
 *   favicon: string,
 *   mascot: undefined | { file: string, alt: { en: string, 'pt-BR': string } },
 * }}
 */
export const brand = {
  name: 'SwarmCast',
  accent: '#6d4aff',
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
};
