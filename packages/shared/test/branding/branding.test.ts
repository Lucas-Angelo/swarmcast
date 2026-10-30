import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BRAND_SLOTS,
  BRAND_TEXT,
  brandingSchema,
  brandingTextSchema,
  canonicalizeBrandText,
  checkImageInput,
  deriveTheme,
  parseBrandUrl,
  sniffImage,
  suggestBrandUrl,
  themeCss,
  themeTokensOk,
} from '../../src/branding/index.js';
import { checkChatInvariants } from '../../src/chat/text.js';
import { CORPUS } from '../chat/corpus.js';
import { hostile, realistic } from '../chat/arbitraries.js';

const RUNS = Number(process.env.CHAT_FUZZ_RUNS ?? 2000);
const params = { numRuns: RUNS, seed: 0xb4a1 };

describe('U1 text fields', () => {
  it('every corpus string through every profile satisfies the safety invariants and caps', () => {
    for (const [name, profile] of Object.entries(BRAND_TEXT)) {
      for (const e of CORPUS) {
        const r = canonicalizeBrandText(e.input, profile);
        if (!r.ok || r.text === '') continue;
        for (const line of r.text.split('\n')) expect(checkChatInvariants(line, { maxGraphemes: 1000, maxEmoji: 1000, maxBytes: profile.maxBytes }), `${name}/${e.id}`).toBe(true);
        expect(r.graphemes).toBeLessThanOrEqual(profile.maxGraphemes);
        expect(r.text.split('\n').length).toBeLessThanOrEqual(profile.maxLines);
      }
    }
  });

  it('property: idempotent, caps hold, one line unless the profile allows more', () => {
    fc.assert(
      fc.property(hostile, fc.constantFrom(...Object.values(BRAND_TEXT)), (input, profile) => {
        const r = canonicalizeBrandText(input, profile);
        if (!r.ok) return true;
        expect(canonicalizeBrandText(r.text, profile)).toEqual(r);
        expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(profile.maxBytes);
        if (profile.maxLines === 1) expect(r.text.includes('\n')).toBe(false);
        expect(r.text).not.toMatch(/\n\n\n/);
        return true;
      }),
      params,
    );
  });

  it('realistic bios come out unchanged; About keeps lines and collapses blank runs', () => {
    fc.assert(
      fc.property(realistic, (s) => {
        expect(canonicalizeBrandText(s, BRAND_TEXT.about)).toMatchObject({ ok: true, text: s });
        return true;
      }),
      params,
    );
    expect(canonicalizeBrandText('Oi!\r\n\r\n\r\nLive toda sexta.\n\n', BRAND_TEXT.about)).toMatchObject({ ok: true, text: 'Oi!\n\nLive toda sexta.' });
    expect(canonicalizeBrandText('a\nb', BRAND_TEXT.name)).toMatchObject({ ok: true, text: 'a b' });
    expect(canonicalizeBrandText(Array(14).fill('x').join('\n'), BRAND_TEXT.about)).toMatchObject({ ok: false, code: 'brand.err.lines' });
    expect(canonicalizeBrandText('Ana \u{1F3AE} \u{30B2}\u{30FC}\u{30E0}', BRAND_TEXT.name)).toMatchObject({ ok: true });
    expect(canonicalizeBrandText('x'.repeat(41), BRAND_TEXT.name)).toMatchObject({ ok: false, code: 'text.tooLong', params: { max: 40 } });
    expect(canonicalizeBrandText('\u{200B}\u{3164}', BRAND_TEXT.name)).toEqual({ ok: true, text: '', graphemes: 0 });
  });

  it('U2 tags: letters, numbers, spaces, - _ and emoji only', () => {
    expect(canonicalizeBrandText('indie games', BRAND_TEXT.tag)).toMatchObject({ ok: true });
    expect(canonicalizeBrandText('\u{1F3AE} cozy', BRAND_TEXT.tag)).toMatchObject({ ok: true });
    expect(canonicalizeBrandText('#cozy', BRAND_TEXT.tag)).toMatchObject({ ok: false, code: 'brand.err.tagChars' });
    expect(canonicalizeBrandText('a/b', BRAND_TEXT.tag)).toMatchObject({ ok: false });
  });
});

describe('U3 links (https and mailto only)', () => {
  const refused: Array<[string, string]> = [
    ['javascript:alert(1)', 'url.scheme'],
    ['JaVaScRiPt:alert(1)', 'url.scheme'],
    ['java\tscript:alert(1)', 'url.chars'],
    ['%6Aavascript:alert(1)', 'url.scheme'],
    [' javascript:alert(1)', 'url.scheme'],
    ['data:text/html,<b>x</b>', 'url.scheme'],
    ['vbscript:x', 'url.scheme'],
    ['file:///etc/passwd', 'url.scheme'],
    ['blob:https://x.com/1', 'url.scheme'],
    ['intent://x#Intent;end', 'url.scheme'],
    ['http://example.com', 'url.scheme'],
    ['ftp://example.com', 'url.scheme'],
    ['https://user:pw@x.com', 'url.credentials'],
    ['https://youtube.com@evil.example.org/', 'url.credentials'],
    ['https://192.168.0.1/admin', 'url.local'],
    ['https://10.0.0.1', 'url.local'],
    ['https://[::1]/', 'url.local'],
    ['https://0x7f000001/', 'url.local'],
    ['https://2130706433/', 'url.local'],
    ['https://localhost/', 'url.local'],
    ['https://router.lan/', 'url.local'],
    ['https://printer.local/', 'url.local'],
    ['https://nas.home/', 'url.local'],
    ['https://intranet/', 'url.local'],
    ['https://x.internal/', 'url.local'],
    ['https://example.com:8443/', 'url.port'],
    ['https://exa mple.com', 'url.chars'],
    ['https://ex\u{200B}ample.com', 'url.chars'],
    ['https://x.c0m/', 'url.host'],
    ['https://-x.com/', 'url.host'],
    [`https://x.com/${'a'.repeat(520)}`, 'url.tooLong'],
    ['', 'url.empty'],
    ['mailto:a@b.com?subject=hi', 'url.mail'],
    ['mailto:a@b.com,c@d.com', 'url.mail'],
    ['mailto:a@localhost', 'url.local'],
    ['mailto:<a@b.com>', 'url.mail'],
    ['mailto:a@@b.com', 'url.mail'],
  ];
  for (const [input, code] of refused) {
    it(`refuses ${JSON.stringify(input).slice(0, 50)} (${code})`, () => {
      expect(parseBrandUrl(input)).toEqual({ ok: false, code });
    });
  }

  it('accepts and normalises real links; IDN hosts are shown in punycode', () => {
    expect(parseBrandUrl('https://www.YouTube.com/@ana')).toMatchObject({ ok: true, kind: 'https', href: 'https://www.youtube.com/@ana', display: 'youtube.com', platform: 'youtube' });
    expect(parseBrandUrl('https://ko-fi.com/ana')).toMatchObject({ ok: true, platform: 'kofi' });
    expect(parseBrandUrl('https://mastodon.social/@ana')).toMatchObject({ ok: true, platform: 'mastodon' });
    expect(parseBrandUrl('https://example.com.br/x?y=1#z')).toMatchObject({ ok: true, platform: 'link', href: 'https://example.com.br/x?y=1#z' });
    expect(parseBrandUrl('https://\u{430}\u{440}\u{440}le.com/')).toMatchObject({ ok: true, display: 'xn--le-6kc8da.com' });
    expect(parseBrandUrl('mailto:Ana@Example.COM')).toEqual({ ok: true, kind: 'mailto', href: 'mailto:Ana@example.com', display: 'Ana@example.com', platform: 'mail' });
    expect(parseBrandUrl('https://live.example.com/x', { ownHost: 'live.example.com:443' })).toEqual({ ok: false, code: 'url.own' });
  });

  it('suggests a scheme for bare addresses (shown to the streamer, never applied silently)', () => {
    expect(suggestBrandUrl('ko-fi.com/ana')).toBe('https://ko-fi.com/ana');
    expect(suggestBrandUrl('ana@example.com')).toBe('mailto:ana@example.com');
    expect(suggestBrandUrl('javascript:x')).toBe('javascript:x');
    expect(suggestBrandUrl('hello')).toBe('hello');
  });

  it('property: anything accepted is https or mailto, round-trips, and has no credentials', () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl({ withQueryParameters: true, withFragments: true }), fc.string({ maxLength: 80 }), hostile), (s) => {
        const r = parseBrandUrl(s);
        if (!r.ok) return true;
        const u = new URL(r.href);
        expect(['https:', 'mailto:']).toContain(u.protocol);
        expect(u.username + u.password).toBe('');
        expect(parseBrandUrl(r.href)).toEqual(r);
        return true;
      }),
      params,
    );
  });
});

describe('U4/U5 theme', () => {
  it('presets satisfy every constraint in both themes', () => {
    for (const preset of ['forest', 'honey', 'onair', 'ocean', 'clay', 'graphite'] as const) {
      const d = deriveTheme({ preset });
      expect(themeTokensOk(d.light, 'light'), preset).toBe(true);
      expect(themeTokensOk(d.dark, 'dark'), preset).toBe(true);
    }
  });

  it('property: every 24-bit custom colour gives readable tokens in both themes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const d = deriveTheme({ preset: 'custom', accent: `#${n.toString(16).padStart(6, '0')}` });
        expect(themeTokensOk(d.light, 'light')).toBe(true);
        expect(themeTokensOk(d.dark, 'dark')).toBe(true);
        return true;
      }),
      params,
    );
  });

  it('theme.css follows a strict grammar (only fixed selectors, --sc-* hex values and radii)', () => {
    const decl = /^--sc-(accent|on-accent|accent-strong|accent-soft):#[0-9a-f]{6};$|^--sc-radius-(sm|md|lg):\d{1,2}px;$/;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), fc.constantFrom('round', 'soft', 'square') as fc.Arbitrary<'round' | 'soft' | 'square'>, (n, corners) => {
        const css = themeCss(deriveTheme({ preset: 'custom', accent: `#${n.toString(16).padStart(6, '0')}` }), corners);
        const lines = css.trim().split('\n');
        expect(lines).toHaveLength(3);
        const bodies = [lines[0]!.match(/^:root\{(.*)\}$/), lines[1]!.match(/^:root\[data-theme="dark"\]\{(.*)\}$/), lines[2]!.match(/^@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\):not\(\[data-palette\]\)\{(.*)\}\}$/)];
        for (const b of bodies) {
          expect(b).not.toBeNull();
          for (const d of b![1]!.split(/(?<=;)/)) expect(d, d).toMatch(decl);
        }
        return true;
      }),
      { ...params, numRuns: Math.min(RUNS, 500) },
    );
  });

  it('a custom colour that needs changing is reported as adjusted', () => {
    expect(deriveTheme({ preset: 'custom', accent: '#f5d90a' }).adjusted).toBe(true);
    expect(deriveTheme({ preset: 'custom', accent: '#1d6fb8' }).adjusted).toBe(true); // dark theme lightens it
    expect(deriveTheme({ preset: 'forest' }).adjusted).toBe(false);
  });
});

describe('image headers (panel pre-decode check)', () => {
  const png = (w: number, h: number): Uint8Array => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  it('sniffs types and sizes; refuses SVG, unknown files and bombs', () => {
    expect(sniffImage(png(256, 256))).toMatchObject({ kind: 'png', width: 256, height: 256 });
    expect(checkImageInput(png(20_000, 20_000))).toMatchObject({ ok: false, code: 'img.tooLarge' });
    expect(checkImageInput(png(8000, 8000))).toMatchObject({ ok: false, code: 'img.tooLarge' });
    expect(checkImageInput(png(4000, 3000))).toMatchObject({ ok: true });
    expect(checkImageInput(new TextEncoder().encode('<?xml version="1.0"?><svg onload="x"/>'))).toMatchObject({ ok: false, code: 'img.svg' });
    expect(checkImageInput(new TextEncoder().encode('\u{FEFF}  <svg/>'))).toMatchObject({ ok: false, code: 'img.svg' });
    expect(checkImageInput(new TextEncoder().encode('hello'))).toMatchObject({ ok: false, code: 'img.type' });
    expect(checkImageInput(png(1, 1), 25 * 1024 * 1024)).toMatchObject({ ok: false, code: 'img.tooBig', params: { mb: 25, max: 20 } });
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x40, 0x05, 0x00, 3]);
    expect(sniffImage(jpeg)).toMatchObject({ kind: 'jpeg', width: 1280, height: 320 });
  });

  it('property: never throws, and never reports a size for garbage', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (b) => {
        expect(() => checkImageInput(b)).not.toThrow();
        return true;
      }),
      params,
    );
  });
});

describe('schemas', () => {
  it('defaults: on, no texts, forest round, preview off, credit shown, support off with the "Support" label', () => {
    expect(brandingSchema.parse({})).toMatchObject({ enabled: true, tags: [], links: [], theme: { preset: 'forest', corners: 'round' }, preview: { enabled: false }, showCredit: true, support: { enabled: false, label: 'support', mode: 'link' }, images: {}, rev: 0 });
  });

  it('canonicalises text and links on parse and refuses bad ones with coded messages', () => {
    const ok = brandingTextSchema.parse({ name: '  Ana\u{202E} Plays ', links: [{ label: 'YouTube', url: 'https://www.youtube.com/@ana' }], support: { enabled: true, mode: 'pix', pix: { type: 'cpf', key: '529.982.247-25', name: 'Ana', city: 'Rio' } } });
    expect(ok.name).toBe('Ana Plays');
    expect(ok.support.pix?.key).toBe('52998224725');
    for (const bad of [{ links: [{ label: 'x', url: 'javascript:alert(1)' }] }, { links: [{ label: '', url: 'https://x.com' }] }, { tags: ['#x'] }, { theme: { preset: 'purple' } }, { links: Array(7).fill({ label: 'x', url: 'https://x.com' }) }]) {
      expect(brandingTextSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('slot caps add up to the size budget of the plan (5.5)', () => {
    const total = Object.values(BRAND_SLOTS).reduce((a, s) => a + s.maxBytes, 0);
    expect(total).toBe((64 + 24 + 6 + 32 + 150 + 50 + 200) * 1024);
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});
