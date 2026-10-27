// Search and link-preview tags, shared by the site's own pages (src/layouts/SiteLayout.astro) and
// the guide pages (src/route-data.ts, a Starlight route middleware), so every page gets the same
// Open Graph / Twitter set with the right language card. The cards are rendered by
// scripts/social-cards.mjs into public/og/.
import { brand, links } from '../brand.mjs';
import type { SiteLang } from './i18n';

/** One <head> element, in Starlight's HeadConfig shape (also rendered by SiteLayout). */
export interface HeadTag {
  tag: 'meta' | 'link' | 'script';
  attrs: Record<string, string>;
  content?: string;
}

/** The social card of each language: public/og/<file>, 1200×630 PNG. */
export const OG_IMAGE = {
  width: 1200,
  height: 630,
  type: 'image/png',
  file: { en: 'og-en.png', 'pt-BR': 'og-pt-br.png' } satisfies Record<SiteLang, string>,
  alt: {
    en: 'SwarmCast: members-only live streams, straight from your PC. Free, no accounts, viewers help share the video.',
    'pt-BR': 'SwarmCast: lives só para membros, direto do seu PC. Grátis, sem cadastro, quem assiste ajuda a transmitir.',
  } satisfies Record<SiteLang, string>,
};

/** Absolute https URL of a site path (with or without the base). */
export function absolute(pathname: string): string {
  const p = pathname.startsWith(`${links.base}/`) || pathname === links.base ? pathname : `${links.base}/${pathname.replace(/^\/+/, '')}`;
  return new URL(p, links.site).href;
}

export const ogImageUrl = (lang: SiteLang) => absolute(`og/${OG_IMAGE.file[lang]}`);

/** Open Graph wants language_TERRITORY. */
export const ogLocale = (lang: SiteLang) => (lang === 'pt-BR' ? 'pt_BR' : 'en_US');

/** "Install on Windows" -> "Install on Windows | SwarmCast guide"; a title that already names the brand stays as it is. */
export function pageTitle(title: string, siteTitle: string): string {
  return title.includes(brand.name) ? title : `${title} | ${siteTitle}`;
}

export interface SocialInput {
  lang: SiteLang;
  title: string;
  description: string;
  /** Absolute canonical URL; omitted for pages without one (404). */
  url?: string;
  type: 'website' | 'article';
}

/** Open Graph + Twitter card tags for one page. */
export function socialTags({ lang, title, description, url, type }: SocialInput): HeadTag[] {
  const other: SiteLang = lang === 'en' ? 'pt-BR' : 'en';
  const image = ogImageUrl(lang);
  const alt = OG_IMAGE.alt[lang];
  const og = (property: string, content: string): HeadTag => ({ tag: 'meta', attrs: { property, content } });
  const tw = (name: string, content: string): HeadTag => ({ tag: 'meta', attrs: { name, content } });
  return [
    og('og:type', type),
    og('og:site_name', brand.name),
    og('og:title', title),
    og('og:description', description),
    ...(url ? [og('og:url', url)] : []),
    og('og:locale', ogLocale(lang)),
    og('og:locale:alternate', ogLocale(other)),
    og('og:image', image),
    og('og:image:secure_url', image),
    og('og:image:type', OG_IMAGE.type),
    og('og:image:width', String(OG_IMAGE.width)),
    og('og:image:height', String(OG_IMAGE.height)),
    og('og:image:alt', alt),
    tw('twitter:card', 'summary_large_image'),
    tw('twitter:title', title),
    tw('twitter:description', description),
    tw('twitter:image', image),
    tw('twitter:image:alt', alt),
  ];
}

/** True for the tags socialTags() owns (to drop Starlight's own versions before adding ours). */
export function isSocialTag(tag: { tag: string; attrs?: Record<string, string | boolean | undefined> }): boolean {
  if (tag.tag !== 'meta') return false;
  const key = String(tag.attrs?.property ?? tag.attrs?.name ?? '');
  return key.startsWith('og:') || key.startsWith('twitter:');
}

export interface AppJsonLdInput {
  lang: SiteLang;
  description: string;
  /** Absolute URL of the landing page in this language. */
  url: string;
  version: string;
}

/**
 * schema.org JSON-LD for a landing page: the WebSite, its author, and SwarmCast as a free
 * SoftwareApplication. Google's software rich result also asks for ratings or reviews, which the
 * project does not have and will not invent; the markup is still valid and describes the app.
 */
export function appJsonLd({ lang, description, url, version }: AppJsonLdInput) {
  const home = absolute('/');
  const author = { '@type': 'Person', '@id': `${home}#author`, name: brand.author.name, url: brand.author.url };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      author,
      {
        '@type': 'WebSite',
        '@id': `${home}#website`,
        name: brand.name,
        url: home,
        inLanguage: ['en', 'pt-BR'],
        publisher: { '@id': author['@id'] },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${home}#app`,
        name: brand.name,
        description,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Windows, macOS, Linux',
        offers: [
          { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          { '@type': 'Offer', price: '0', priceCurrency: 'BRL' },
        ],
        url,
        downloadUrl: links.releases,
        softwareVersion: version,
        image: ogImageUrl(lang),
        inLanguage: lang,
        license: 'https://opensource.org/license/mit',
        isAccessibleForFree: true,
        author: { '@id': author['@id'] },
        publisher: { '@id': author['@id'] },
        sameAs: links.repo,
      },
    ],
  };
}

/** JSON for an inline <script type="application/ld+json">, safe against a "</script>" in a string. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
