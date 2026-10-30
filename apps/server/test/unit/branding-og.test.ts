import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { brandingSchema } from '@swarmcast/shared/branding';
import { escapeHtml, isPreviewAgent, previewPage } from '../../src/branding/og.js';
import { CORPUS } from '../../../../packages/shared/test/chat/corpus.js';
import { hostile } from '../../../../packages/shared/test/chat/arbitraries.js';

// The link preview page that chat apps fetch for the live link: the streamer's name and tagline
// (only with the preview turned on), escaped so no input can open a tag or an attribute.

/** Decode the few entities escapeHtml writes. */
const unescape = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);

function og(html: string, prop: string): string | undefined {
  const m = new RegExp(`<meta property="${prop}" content="([^"]*)">`).exec(html);
  return m ? unescape(m[1]!) : undefined;
}

/** The only elements a preview page may contain. */
const PAGE_TAGS = new Set(['html', 'head', 'meta', 'title', 'body', 'p', 'a']);

/** Every corpus string the branding schema accepts as a name (40) and tagline (100), previewed. */
const previewable = CORPUS.flatMap((e) => {
  const parsed = brandingSchema.safeParse({ name: e.input.slice(0, 40), tagline: e.input.slice(0, 100), preview: { enabled: true } });
  return parsed.success && parsed.data.name ? [{ id: e.id, branding: parsed.data }] : [];
});

describe('link preview page (U9)', () => {
  it('the corpus gives enough previewable names to be meaningful', () => {
    // Assert
    expect(previewable.length).toBeGreaterThan(20);
  });

  it.each(previewable)('corpus $id as name and tagline round-trips through the escaping; only fixed elements appear', ({ branding }) => {
    // Act
    const html = previewPage({ branding, url: 'https://x.trycloudflare.com/join/abc' });
    // Assert
    expect(og(html, 'og:title')).toBe(`${branding.name} is live`);
    if (branding.tagline) expect(og(html, 'og:description')).toBe(branding.tagline);
    expect(new Set([...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]))).toEqual(PAGE_TAGS);
  });

  it('property: no input can open a tag or an attribute', () => {
    // Arrange
    const input = fc.oneof(hostile, fc.constantFrom('"><script>alert(1)</script>', "' onload='x", '</title><script>', '&quot;'));
    const property = fc.property(input, (s) => {
      const wellFormed = [...s].map((c) => (c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff ? '?' : c)).join('');
      const out = escapeHtml(wellFormed);
      expect(out).not.toMatch(/[<>"']/);
      expect(unescape(out)).toBe(wellFormed);
      return true;
    });
    // Act
    const run = () => fc.assert(property, { numRuns: Number(process.env.CHAT_FUZZ_RUNS ?? 2000), seed: 0x0f });
    // Assert
    expect(run).not.toThrow();
  });

  it('preview off or no name: a neutral invitation that names nobody', () => {
    // Act
    const html = previewPage({ branding: brandingSchema.parse({ name: 'Secret Name' }), url: 'https://x/join/a', acceptLanguage: 'en-US,en;q=0.8' });
    // Assert
    expect(html).toContain('You&#39;re invited to a live stream');
    expect(html).not.toContain('Secret Name');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it.each(['facebookexternalhit/1.1', 'WhatsApp/2.23.20.0 A', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0'])(
    'recognises the preview fetcher %s',
    (ua) => {
      // Act
      const preview = isPreviewAgent(ua);
      // Assert
      expect(preview).toBe(true);
    },
  );

  it.each([
    ['Safari on an iPhone', 'Mozilla/5.0 (iPhone) Safari/604.1'],
    ['Chrome', 'Mozilla/5.0 Chrome/140'],
    ['an empty User-Agent', ''],
    ['no User-Agent', undefined],
    ['a 600-character User-Agent', 'x'.repeat(600)],
  ])('does not take %s for a preview fetcher', (_what, ua) => {
    // Act
    const preview = isPreviewAgent(ua);
    // Assert
    expect(preview).toBe(false);
  });
});
