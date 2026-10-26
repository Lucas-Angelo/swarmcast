// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { brand, links } from './src/brand.mjs';
import { langRedirectScript } from './src/lang-redirect.mjs';

/** Sidebar group/label helper: English label + pt-BR translation. */
/** @param {string} en @param {string} pt */
const t = (en, pt) => ({ label: en, translations: { 'pt-BR': pt } });

export default defineConfig({
  site: links.site,
  base: links.base,
  trailingSlash: 'always',
  // No telemetry, trackers or third-party requests on the site (fonts are the system's).
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: { en: `${brand.name} guide`, 'pt-BR': `Guia do ${brand.name}` },
      description: 'SwarmCast: members-only live streaming from your own computer. Free, private, open source.',
      logo: brand.logo,
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
      customCss: ['./src/styles/custom.css'],
      components: {
        Header: './src/components/Header.astro',
        Hero: './src/components/Hero.astro',
      },
      head: [
        { tag: 'script', content: langRedirectScript(links.base) },
        { tag: 'meta', attrs: { name: 'referrer', content: 'strict-origin-when-cross-origin' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: brand.accent } },
      ],
      plugins: [
        starlightLinksValidator({
          errorOnInconsistentLocale: true,
          errorOnLocalLinks: true,
        }),
      ],
      sidebar: [
        {
          ...t('Get started', 'Começar'),
          items: [
            { slug: 'download' },
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
