// Unit tests for the link-preview and structured-data helpers (src/lib/seo.ts).
import { describe, expect, it } from 'vitest';
import { absolute, appJsonLd, isSocialTag, jsonLdText, ogImageUrl, pageTitle, socialTags } from '../../src/lib/seo';

describe('seo helpers', () => {
  it('builds absolute URLs under the base', () => {
    expect(absolute('/')).toBe('https://lucas-angelo.github.io/swarmcast/');
    expect(absolute('og/og-en.png')).toBe('https://lucas-angelo.github.io/swarmcast/og/og-en.png');
    expect(absolute('/swarmcast/pt-br/')).toBe('https://lucas-angelo.github.io/swarmcast/pt-br/');
    expect(ogImageUrl('pt-BR')).toBe('https://lucas-angelo.github.io/swarmcast/og/og-pt-br.png');
  });

  it('adds the site title unless the page title already names the brand', () => {
    expect(pageTitle('Install on Windows', 'SwarmCast guide')).toBe('Install on Windows | SwarmCast guide');
    expect(pageTitle('Guia do SwarmCast', 'Guia do SwarmCast')).toBe('Guia do SwarmCast');
  });

  it('gives every page the full Open Graph and Twitter set in its language', () => {
    const tags = socialTags({ lang: 'pt-BR', title: 'T', description: 'D', url: 'https://x/', type: 'article' });
    const get = (k: string) => tags.filter((t) => (t.attrs.property ?? t.attrs.name) === k).map((t) => t.attrs.content);
    expect(get('og:locale')).toEqual(['pt_BR']);
    expect(get('og:locale:alternate')).toEqual(['en_US']);
    expect(get('og:image')).toEqual(['https://lucas-angelo.github.io/swarmcast/og/og-pt-br.png']);
    expect(get('twitter:image')).toEqual(get('og:image'));
    expect(get('og:url')).toEqual(['https://x/']);
    expect(tags.every(isSocialTag)).toBe(true);
    expect(socialTags({ lang: 'en', title: 'T', description: 'D', type: 'website' }).some((t) => t.attrs.property === 'og:url')).toBe(false);
    expect(isSocialTag({ tag: 'meta', attrs: { name: 'description', content: 'x' } })).toBe(false);
  });

  it('describes the app as free software, safely embeddable', () => {
    const data = appJsonLd({ lang: 'en', description: 'a </script> b', url: 'https://lucas-angelo.github.io/swarmcast/', version: '1.2.3' });
    const app = data['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    expect(app).toMatchObject({ softwareVersion: '1.2.3', applicationCategory: 'MultimediaApplication', offers: [{ price: '0' }, { price: '0' }] });
    const text = jsonLdText(data);
    expect(text).not.toContain('</script>');
    expect(JSON.parse(text)).toEqual(data);
  });
});
