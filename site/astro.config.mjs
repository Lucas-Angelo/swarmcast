// @ts-check
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { brand, links } from './src/brand.mjs';
import { langRedirectScript } from './src/lang-redirect.mjs';
import { themeColors } from './src/tokens.mjs';
import { FONT_LICENSES_FILE, fontLicensesText } from '../packages/shared/web/font-licenses.mjs';

const colors = themeColors();

/** The OFL asks for the licence to travel with the fonts: write it next to them (dist/_astro/). */
const fontLicenses = {
  name: 'swarmcast-font-licenses',
  hooks: {
    /** @param {{ dir: URL }} options */
    'astro:build:done': ({ dir }) => {
      const text = fontLicensesText({ resolveFrom: import.meta.url, fredokaLicense: fileURLToPath(new URL('./src/fonts/OFL.txt', import.meta.url)) });
      fs.mkdirSync(new URL('_astro/', dir), { recursive: true });
      fs.writeFileSync(new URL(`_astro/${FONT_LICENSES_FILE}`, dir), text);
    },
  },
};

/** Sidebar group/label helper: English label + pt-BR translation. */
/** @param {string} en @param {string} pt */
const t = (en, pt) => ({ label: en, translations: { 'pt-BR': pt } });

export default defineConfig({
  site: links.site,
  base: links.base,
  trailingSlash: 'always',
  // No telemetry, trackers or third-party requests on the site (the font is self-hosted).
  devToolbar: { enabled: false },
  integrations: [
    fontLicenses,
    starlight({
      title: { en: `${brand.name} guide`, 'pt-BR': `Guia do ${brand.name}` },
      description: 'SwarmCast: members-only live streaming from your own computer. Free, private, open source.',
      favicon: brand.favicon,
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'pt-br': { label: 'Português (Brasil)', lang: 'pt-BR' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: links.repo }],
      editLink: { baseUrl: `${links.repo}/edit/main/site/` },
      lastUpdated: false,
      credits: false,
      // Colours, font, radii: assets/brand/tokens.css (via tokens.css), mapped onto Starlight.
      customCss: ['./src/styles/tokens.css', './src/styles/ui.css', './src/styles/starlight.css'],
      components: {
        Header: './src/components/Header.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        styleOverrides: {
          borderRadius: '8px',
          borderColor: 'var(--sc-border)',
          codeBackground: 'var(--sc-surface)',
          codeFontFamily: 'var(--sc-font-mono)',
          codeFontSize: '0.875rem',
          uiFontFamily: 'var(--sc-font)',
          frames: {
            frameBoxShadowCssValue: 'none',
            editorActiveTabBackground: 'var(--sc-surface)',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorTabBarBackground: 'var(--sc-surface-2)',
            editorTabBarBorderBottomColor: 'var(--sc-border)',
            terminalTitlebarBackground: 'var(--sc-surface-2)',
            terminalTitlebarBorderBottomColor: 'var(--sc-border)',
            terminalTitlebarDotsForeground: 'var(--sc-border-strong)',
            terminalTitlebarDotsOpacity: '1',
            terminalBackground: 'var(--sc-surface)',
            inlineButtonBorder: 'var(--sc-border-strong)',
            inlineButtonForeground: 'var(--sc-ink)',
            tooltipSuccessBackground: 'var(--sc-ink)',
            tooltipSuccessForeground: 'var(--sc-bg)',
          },
        },
      },
      head: [
        { tag: 'script', content: langRedirectScript(links.base) },
        { tag: 'meta', attrs: { name: 'referrer', content: 'strict-origin-when-cross-origin' } },
        { tag: 'meta', attrs: { name: 'theme-color', media: '(prefers-color-scheme: light)', content: colors.light } },
        { tag: 'meta', attrs: { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: colors.dark } },
      ],
      plugins: [
        starlightLinksValidator({
          errorOnInconsistentLocale: true,
          errorOnLocalLinks: true,
          // The home and download pages are the site's own Astro pages (src/pages/), which the
          // validator cannot see. Their anchors (#windows, #macos, #linux) are checked by the
          // Playwright tests.
          exclude: ['/swarmcast/', '/swarmcast/pt-br/', '/swarmcast/download/', '/swarmcast/download/#{windows,macos,linux}', '/swarmcast/pt-br/download/', '/swarmcast/pt-br/download/#{windows,macos,linux}'],
        }),
      ],
      sidebar: [
        {
          ...t('Get started', 'Começar'),
          items: [
            { slug: 'guide' },
            { ...t('Download', 'Baixar'), link: '/download/' },
            { slug: 'install/windows' },
            { slug: 'install/macos' },
            { slug: 'install/linux' },
            { slug: 'start/first-run' },
            { slug: 'start/obs' },
          ],
        },
        {
          ...t('Going live', 'Na live'),
          items: [
            { slug: 'live/go-live' },
            { slug: 'live/kick-and-new-link' },
            { slug: 'live/quality' },
            { slug: 'live/p2p' },
            { slug: 'live/protection' },
            { slug: 'live/direct-mode' },
          ],
        },
        {
          ...t('The app', 'O aplicativo'),
          items: [{ slug: 'app/autostart' }, { slug: 'app/updates' }, { slug: 'app/uninstall' }],
        },
        {
          ...t('Help', 'Ajuda'),
          items: [{ slug: 'help/troubleshooting' }, { slug: 'viewers' }],
        },
        {
          ...t('More', 'Mais'),
          items: [{ slug: 'advanced/script-install' }, { slug: 'about/privacy' }, { slug: 'developers' }],
        },
      ],
    }),
  ],
});
