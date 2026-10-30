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

/** Links the page refuses, and the code the panel shows for each. */
const REFUSED_LINKS: Array<[string, string]> = [
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

/** The theme.css grammar: only these declarations, inside the three fixed rules below. */
const THEME_DECL = /^--sc-(accent|on-accent|accent-strong|accent-soft):#[0-9a-f]{6};$|^--sc-radius-(sm|md|lg):\d{1,2}px;$/;
const THEME_RULES = [/^:root\{(.*)\}$/, /^:root\[data-theme="dark"\]\{(.*)\}$/, /^@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\):not\(\[data-palette\]\)\{(.*)\}\}$/];

/** A PNG header declaring w × h. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A JPEG whose first SOF declares 1280 × 320. */
const JPEG_1280x320 = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x40, 0x05, 0x00, 3]);

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

describe('U1 text fields', () => {
  it('every corpus string through every profile satisfies the safety invariants and caps', () => {
    // Act
    const out = Object.entries(BRAND_TEXT).flatMap(([name, profile]) =>
      CORPUS.map((e) => ({ name: `${name}/${e.id}`, profile, r: canonicalizeBrandText(e.input, profile) })),
    );
    // Assert
    for (const { name, profile, r } of out) {
      if (!r.ok || r.text === '') continue;
      for (const line of r.text.split('\n')) expect(checkChatInvariants(line, { maxGraphemes: 1000, maxEmoji: 1000, maxBytes: profile.maxBytes }), name).toBe(true);
      expect(r.graphemes, name).toBeLessThanOrEqual(profile.maxGraphemes);
      expect(r.text.split('\n').length, name).toBeLessThanOrEqual(profile.maxLines);
    }
  });

  it('property: idempotent, caps hold, one line unless the profile allows more', () => {
    // Arrange
    const profiles = fc.constantFrom(...Object.values(BRAND_TEXT));
    // Act
    const run = () =>
      fc.assert(
        fc.property(hostile, profiles, (input, profile) => {
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
    // Assert
    expect(run).not.toThrow();
  });

  it('realistic bios come out unchanged', () => {
    // Act
    const run = () =>
      fc.assert(
        fc.property(realistic, (s) => {
          expect(canonicalizeBrandText(s, BRAND_TEXT.about)).toMatchObject({ ok: true, text: s });
          return true;
        }),
        params,
      );
    // Assert
    expect(run).not.toThrow();
  });

  it('About keeps lines and collapses blank runs; one-line fields join lines; caps answer with codes', () => {
    // Act
    const about = canonicalizeBrandText('Oi!\r\n\r\n\r\nLive toda sexta.\n\n', BRAND_TEXT.about);
    const twoLineName = canonicalizeBrandText('a\nb', BRAND_TEXT.name);
    const tooManyLines = canonicalizeBrandText(Array(14).fill('x').join('\n'), BRAND_TEXT.about);
    const mixedScripts = canonicalizeBrandText('Ana \u{1F3AE} \u{30B2}\u{30FC}\u{30E0}', BRAND_TEXT.name);
    const tooLong = canonicalizeBrandText('x'.repeat(41), BRAND_TEXT.name);
    const invisible = canonicalizeBrandText('\u{200B}\u{3164}', BRAND_TEXT.name);
    // Assert
    expect(about).toMatchObject({ ok: true, text: 'Oi!\n\nLive toda sexta.' });
    expect(twoLineName).toMatchObject({ ok: true, text: 'a b' });
    expect(tooManyLines).toMatchObject({ ok: false, code: 'brand.err.lines' });
    expect(mixedScripts).toMatchObject({ ok: true });
    expect(tooLong).toMatchObject({ ok: false, code: 'text.tooLong', params: { max: 40 } });
    expect(invisible).toEqual({ ok: true, text: '', graphemes: 0 });
  });

  it('U2 tags: letters, numbers, spaces, - _ and emoji only', () => {
    // Act
    const tags = ['indie games', '\u{1F3AE} cozy', '#cozy', 'a/b'].map((t) => canonicalizeBrandText(t, BRAND_TEXT.tag));
    // Assert
    expect(tags).toMatchObject([{ ok: true }, { ok: true }, { ok: false, code: 'brand.err.tagChars' }, { ok: false }]);
  });
});

describe('U3 links (https and mailto only)', () => {
  it.each(REFUSED_LINKS)('refuses %j (%s)', (input, code) => {
    // Act
    const r = parseBrandUrl(input);
    // Assert
    expect(r).toEqual({ ok: false, code });
  });

  it('accepts and normalises real links; IDN hosts are shown in punycode', () => {
    // Act
    const youtube = parseBrandUrl('https://www.YouTube.com/@ana');
    const kofi = parseBrandUrl('https://ko-fi.com/ana');
    const mastodon = parseBrandUrl('https://mastodon.social/@ana');
    const plain = parseBrandUrl('https://example.com.br/x?y=1#z');
    const idn = parseBrandUrl('https://\u{430}\u{440}\u{440}le.com/');
    const mail = parseBrandUrl('mailto:Ana@Example.COM');
    const own = parseBrandUrl('https://live.example.com/x', { ownHost: 'live.example.com:443' });
    // Assert
    expect(youtube).toMatchObject({ ok: true, kind: 'https', href: 'https://www.youtube.com/@ana', display: 'youtube.com', platform: 'youtube' });
    expect(kofi).toMatchObject({ ok: true, platform: 'kofi' });
    expect(mastodon).toMatchObject({ ok: true, platform: 'mastodon' });
    expect(plain).toMatchObject({ ok: true, platform: 'link', href: 'https://example.com.br/x?y=1#z' });
    expect(idn).toMatchObject({ ok: true, display: 'xn--le-6kc8da.com' });
    expect(mail).toEqual({ ok: true, kind: 'mailto', href: 'mailto:Ana@example.com', display: 'Ana@example.com', platform: 'mail' });
    expect(own).toEqual({ ok: false, code: 'url.own' });
  });

  it('suggests a scheme for bare addresses (shown to the streamer, never applied silently)', () => {
    // Act
    const suggestions = ['ko-fi.com/ana', 'ana@example.com', 'javascript:x', 'hello'].map(suggestBrandUrl);
    // Assert
    expect(suggestions).toEqual(['https://ko-fi.com/ana', 'mailto:ana@example.com', 'javascript:x', 'hello']);
  });

  it('property: anything accepted is https or mailto, round-trips, and has no credentials', () => {
    // Arrange
    const candidates = fc.oneof(fc.webUrl({ withQueryParameters: true, withFragments: true }), fc.string({ maxLength: 80 }), hostile);
    // Act
    const run = () =>
      fc.assert(
        fc.property(candidates, (s) => {
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
    // Assert
    expect(run).not.toThrow();
  });
});

describe('U4/U5 theme', () => {
  it('presets satisfy every constraint in both themes', () => {
    // Act
    const presets = (['forest', 'honey', 'onair', 'ocean', 'clay', 'graphite'] as const).map((preset) => ({ preset, d: deriveTheme({ preset }) }));
    // Assert
    for (const { preset, d } of presets) {
      expect(themeTokensOk(d.light, 'light'), preset).toBe(true);
      expect(themeTokensOk(d.dark, 'dark'), preset).toBe(true);
    }
  });

  it('property: every 24-bit custom colour gives readable tokens in both themes', () => {
    // Act
    const run = () =>
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
          const d = deriveTheme({ preset: 'custom', accent: hex(n) });
          return themeTokensOk(d.light, 'light') && themeTokensOk(d.dark, 'dark');
        }),
        params,
      );
    // Assert
    expect(run).not.toThrow();
  });

  it('theme.css follows a strict grammar (only fixed selectors, --sc-* hex values and radii)', () => {
    // Arrange
    const corners = fc.constantFrom('round', 'soft', 'square') as fc.Arbitrary<'round' | 'soft' | 'square'>;
    // Act
    const run = () =>
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 0xffffff }), corners, (n, c) => {
          const lines = themeCss(deriveTheme({ preset: 'custom', accent: hex(n) }), c).trim().split('\n');
          expect(lines).toHaveLength(THEME_RULES.length);
          lines.forEach((line, i) => {
            const body = THEME_RULES[i]!.exec(line);
            expect(body, line).not.toBeNull();
            for (const d of body![1]!.split(/(?<=;)/)) expect(d, d).toMatch(THEME_DECL);
          });
          return true;
        }),
        { ...params, numRuns: Math.min(RUNS, 500) },
      );
    // Assert
    expect(run).not.toThrow();
  });

  it('a custom colour that needs changing is reported as adjusted (the dark theme lightens a deep blue)', () => {
    // Act
    const adjusted = [deriveTheme({ preset: 'custom', accent: '#f5d90a' }), deriveTheme({ preset: 'custom', accent: '#1d6fb8' }), deriveTheme({ preset: 'forest' })].map((d) => d.adjusted);
    // Assert
    expect(adjusted).toEqual([true, true, false]);
  });
});

describe('image headers (panel pre-decode check)', () => {
  it('sniffs types and sizes; refuses SVG, unknown files and bombs', () => {
    // Act
    const sniffedPng = sniffImage(png(256, 256));
    const checks = [
      checkImageInput(png(20_000, 20_000)),
      checkImageInput(png(8000, 8000)),
      checkImageInput(png(4000, 3000)),
      checkImageInput(new TextEncoder().encode('<?xml version="1.0"?><svg onload="x"/>')),
      checkImageInput(new TextEncoder().encode('\u{FEFF}  <svg/>')),
      checkImageInput(new TextEncoder().encode('hello')),
      checkImageInput(png(1, 1), 25 * 1024 * 1024),
    ];
    const sniffedJpeg = sniffImage(JPEG_1280x320);
    // Assert
    expect(sniffedPng).toMatchObject({ kind: 'png', width: 256, height: 256 });
    expect(checks).toMatchObject([
      { ok: false, code: 'img.tooLarge' },
      { ok: false, code: 'img.tooLarge' },
      { ok: true },
      { ok: false, code: 'img.svg' },
      { ok: false, code: 'img.svg' },
      { ok: false, code: 'img.type' },
      { ok: false, code: 'img.tooBig', params: { mb: 25, max: 20 } },
    ]);
    expect(sniffedJpeg).toMatchObject({ kind: 'jpeg', width: 1280, height: 320 });
  });

  it('property: never throws on garbage', () => {
    // Act
    const run = () =>
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 200 }), (b) => {
          checkImageInput(b);
          return true;
        }),
        params,
      );
    // Assert
    expect(run).not.toThrow();
  });
});

describe('schemas', () => {
  it('defaults: on, no texts, forest round, preview off, credit shown, support off with the "Support" label', () => {
    // Act
    const d = brandingSchema.parse({});
    // Assert
    expect(d).toMatchObject({ enabled: true, tags: [], links: [], theme: { preset: 'forest', corners: 'round' }, preview: { enabled: false }, showCredit: true, support: { enabled: false, label: 'support', mode: 'link' }, images: {}, rev: 0 });
  });

  it('canonicalises text and links on parse and refuses bad ones with coded messages', () => {
    // Arrange
    const bad = [{ links: [{ label: 'x', url: 'javascript:alert(1)' }] }, { links: [{ label: '', url: 'https://x.com' }] }, { tags: ['#x'] }, { theme: { preset: 'purple' } }, { links: Array(7).fill({ label: 'x', url: 'https://x.com' }) }];
    // Act
    const ok = brandingTextSchema.parse({ name: '  Ana\u{202E} Plays ', links: [{ label: 'YouTube', url: 'https://www.youtube.com/@ana' }], support: { enabled: true, mode: 'pix', pix: { type: 'cpf', key: '529.982.247-25', name: 'Ana', city: 'Rio' } } });
    const refused = bad.map((b) => ({ input: JSON.stringify(b), success: brandingTextSchema.safeParse(b).success }));
    // Assert
    expect(ok.name).toBe('Ana Plays');
    expect(ok.support.pix?.key).toBe('52998224725');
    expect(refused).toEqual(bad.map((b) => ({ input: JSON.stringify(b), success: false })));
  });

  it('slot caps add up to the size budget of the plan (5.5)', () => {
    // Act
    const total = Object.values(BRAND_SLOTS).reduce((a, s) => a + s.maxBytes, 0);
    // Assert
    expect(total).toBe((64 + 24 + 6 + 32 + 150 + 50 + 200) * 1024);
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});
