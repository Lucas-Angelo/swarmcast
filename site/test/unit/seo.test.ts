// Unit tests for the link-preview and structured-data helpers (src/lib/seo.ts).
import { describe, expect, it } from 'vitest';
import { absolute, appJsonLd, isSocialTag, jsonLdText, ogImageUrl, pageTitle, socialTags } from '../../src/lib/seo';

/** The content of every tag of `tags` named `key` (property or name). */
const contentOf = (tags: ReturnType<typeof socialTags>, key: string) => tags.filter((t) => (t.attrs.property ?? t.attrs.name) === key).map((t) => t.attrs.content);

describe('seo helpers', () => {
  it.each([
    ['/', 'https://lucas-angelo.github.io/swarmcast/'],
    ['og/og-en.png', 'https://lucas-angelo.github.io/swarmcast/og/og-en.png'],
    ['/swarmcast/pt-br/', 'https://lucas-angelo.github.io/swarmcast/pt-br/'],
  ])('builds the absolute URL of %s under the base', (path, full) => {
    // Act
    const got = absolute(path);

    // Assert
    expect(got).toBe(full);
  });

  it('points at the card image of the language', () => {
    // Act
    const image = ogImageUrl('pt-BR');

    // Assert
    expect(image).toBe('https://lucas-angelo.github.io/swarmcast/og/og-pt-br.png');
  });

  it.each([
    ['adds the site title', 'Install on Windows', 'SwarmCast guide', 'Install on Windows | SwarmCast guide'],
    ['keeps a page title that already names the brand', 'Guia do SwarmCast', 'Guia do SwarmCast', 'Guia do SwarmCast'],
  ])('%s', (_case, title, site, full) => {
    // Act
    const got = pageTitle(title, site);

    // Assert
    expect(got).toBe(full);
  });

  it('gives every page the full Open Graph and Twitter set in its language', () => {
    // Act
    const tags = socialTags({ lang: 'pt-BR', title: 'T', description: 'D', url: 'https://x/', type: 'article' });

    // Assert
    expect(contentOf(tags, 'og:locale')).toEqual(['pt_BR']);
    expect(contentOf(tags, 'og:locale:alternate')).toEqual(['en_US']);
    expect(contentOf(tags, 'og:image')).toEqual(['https://lucas-angelo.github.io/swarmcast/og/og-pt-br.png']);
    expect(contentOf(tags, 'twitter:image')).toEqual(contentOf(tags, 'og:image'));
    expect(contentOf(tags, 'og:url')).toEqual(['https://x/']);
    expect(tags.every(isSocialTag)).toBe(true);
  });

  it('has no og:url without a page URL', () => {
    // Act
    const tags = socialTags({ lang: 'en', title: 'T', description: 'D', type: 'website' });

    // Assert
    expect(tags.some((t) => t.attrs.property === 'og:url')).toBe(false);
  });

  it('a plain meta description is not a social tag', () => {
    // Act
    const social = isSocialTag({ tag: 'meta', attrs: { name: 'description', content: 'x' } });

    // Assert
    expect(social).toBe(false);
  });

  it('describes the app as free software', () => {
    // Act
    const data = appJsonLd({ lang: 'en', description: 'd', url: 'https://lucas-angelo.github.io/swarmcast/', version: '1.2.3' });

    // Assert
    const app = data['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    expect(app).toMatchObject({ softwareVersion: '1.2.3', applicationCategory: 'MultimediaApplication', offers: [{ price: '0' }, { price: '0' }] });
  });

  it('the JSON-LD text is safely embeddable: no </script> breaks out, and it parses back', () => {
    // Arrange
    const data = appJsonLd({ lang: 'en', description: 'a </script> b', url: 'https://lucas-angelo.github.io/swarmcast/', version: '1.2.3' });

    // Act
    const text = jsonLdText(data);

    // Assert
    expect(text).not.toContain('</script>');
    expect(JSON.parse(text)).toEqual(data);
  });
});
