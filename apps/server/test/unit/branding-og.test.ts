import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { brandingSchema } from '@swarmcast/shared/branding';
import { escapeHtml, isPreviewAgent, previewPage } from '../../src/branding/og.js';
import { CORPUS } from '../../../../packages/shared/test/chat/corpus.js';
import { hostile } from '../../../../packages/shared/test/chat/arbitraries.js';

/** Decode the few entities escapeHtml writes. */
const unescape = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);

function og(html: string, prop: string): string | undefined {
  const m = new RegExp(`<meta property="${prop}" content="([^"]*)">`).exec(html);
  return m ? unescape(m[1]!) : undefined;
}

describe('link preview page (U9)', () => {
  const branded = (name: string, tagline?: string) => brandingSchema.safeParse({ name, tagline, preview: { enabled: true } });

  it('every corpus string as name and tagline round-trips through the escaping; only fixed elements appear', () => {
    let checked = 0;
    for (const e of CORPUS) {
      const parsed = branded(e.input.slice(0, 40), e.input.slice(0, 100));
      if (!parsed.success || !parsed.data.name) continue;
      const b = parsed.data;
      const html = previewPage({ branding: b, url: 'https://x.trycloudflare.com/join/abc' });
      expect(og(html, 'og:title'), e.id).toBe(`${b.name} is live`);
      if (b.tagline) expect(og(html, 'og:description'), e.id).toBe(b.tagline);
      const tags = [...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]);
      expect(new Set(tags), e.id).toEqual(new Set(['html', 'head', 'meta', 'title', 'body', 'p', 'a']));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('property: no input can open a tag or an attribute', () => {
    fc.assert(
      fc.property(fc.oneof(hostile, fc.constantFrom('"><script>alert(1)</script>', "' onload='x", '</title><script>', '&quot;')), (s) => {
        const w = [...s].map((c) => (c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff ? '?' : c)).join('');
        const out = escapeHtml(w);
        expect(out).not.toMatch(/[<>"']/);
        expect(unescape(out)).toBe(w);
        return true;
      }),
      { numRuns: Number(process.env.CHAT_FUZZ_RUNS ?? 2000), seed: 0x0f },
    );
  });

  it('preview off or no name: a neutral invitation that names nobody', () => {
    const html = previewPage({ branding: brandingSchema.parse({ name: 'Secret Name' }), url: 'https://x/join/a', acceptLanguage: 'en-US,en;q=0.8' });
    expect(html).toContain('You&#39;re invited to a live stream');
    expect(html).not.toContain('Secret Name');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('recognises the preview fetchers and nothing else', () => {
    for (const ua of ['facebookexternalhit/1.1', 'WhatsApp/2.23.20.0 A', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0']) expect(isPreviewAgent(ua), ua).toBe(true);
    for (const ua of ['Mozilla/5.0 (iPhone) Safari/604.1', 'Mozilla/5.0 Chrome/140', '', undefined, 'x'.repeat(600)]) expect(isPreviewAgent(ua), String(ua)).toBe(false);
  });
});
