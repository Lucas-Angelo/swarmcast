// Starlight route middleware (astro.config.mjs → routeMiddleware): gives every guide page the same
// link-preview and search tags as the landing pages. Starlight already writes the canonical URL,
// the hreflang alternates (with x-default) and the meta description from each page's frontmatter;
// this replaces its Open Graph / Twitter tags with the full set (absolute og:image of the page's
// language, og:locale in language_TERRITORY form with its alternate, twitter:* text and image)
// and drops the repeated brand from titles like "The SwarmCast guide | SwarmCast guide".
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { siteLang } from './lib/i18n';
import { isSocialTag, pageTitle, socialTags } from './lib/seo';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const lang = siteLang(route.locale);
  const { data } = route.entry;
  const title = pageTitle(data.title, route.siteTitle);
  const attr = (match: (t: (typeof route.head)[number]) => boolean, key: string) => {
    const value = route.head.find(match)?.attrs?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  // Starlight's meta description: the frontmatter one, or the site description as a fallback.
  const description = attr((t) => t.tag === 'meta' && t.attrs?.name === 'description', 'content') ?? data.description ?? '';
  const canonical = attr((t) => t.tag === 'link' && t.attrs?.rel === 'canonical', 'href');

  const head = route.head.filter((t) => !isSocialTag(t));
  const titleTag = head.find((t) => t.tag === 'title');
  if (titleTag) titleTag.content = title;
  const tags = socialTags({ lang, title, description, url: canonical, type: 'article' });
  route.head = [...head, ...tags];
});
