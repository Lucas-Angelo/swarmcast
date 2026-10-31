import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@swarmcast/shared';
import { BRAND_PRESETS, deriveTheme, THEME_BASE } from '@swarmcast/shared/branding';
import { cropRect, encodedType, fallbackType, FIELD_ASPECT, FIELD_SLOTS, qualitySteps } from '../../src/branding/image.js';
import { presetSwatch, previewVars } from '../../src/branding/preview-theme.js';
import { safeImageSrc, toPublic } from '../../src/branding/public.js';
import { defaultDraft, textOf, type Draft } from '../../src/branding/types.js';
import { checkNewTag, cleanDraft, isEmptyLink, linkOf, tagKey, validateDraft } from '../../src/branding/validate.js';

const draft = (p: Partial<Draft> = {}): Draft => ({ ...defaultDraft(), ...p });
const BCB_EXAMPLE = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

/** Links the panel refuses, and the code it shows for each. */
const REFUSED_LINKS: Array<[string, string]> = [
  ['javascript:alert(1)', 'url.scheme'],
  ['JaVaScRiPt:alert(1)', 'url.scheme'],
  ['java\tscript:alert(1)', 'url.chars'],
  ['data:text/html,hi', 'url.scheme'],
  ['http://example.org', 'url.scheme'],
  ['https://user:pw@example.org', 'url.credentials'],
  ['https://youtube.com@evil.example.org', 'url.credentials'],
  ['https://192.168.0.1/', 'url.local'],
  ['https://[::1]/', 'url.local'],
  ['https://localhost/', 'url.local'],
  ['https://router.lan/', 'url.local'],
  ['https://example.org:8443/', 'url.port'],
  ['mailto:a@example.org?subject=hi', 'url.mail'],
  ['mailto:a@example.org,b@example.org', 'url.mail'],
  [`https://example.org/${'a'.repeat(520)}`, 'url.tooLong'],
];

const lines = (n: number, joiner = '\n'): string => Array.from({ length: n }, (_, i) => `line ${i}`).join(joiner);
const pix = (type: 'evp' | 'cpf' | 'phone', key: string, name = 'Ana Lima', city = 'São Paulo'): Draft =>
  draft({ support: { enabled: true, label: 'support', mode: 'pix', pix: { type, key, name, city } } });
const EVP = '123e4567-e89b-12d3-a456-426614174000';

describe('Your page: draft validation (panel glue over the shared rules)', () => {
  it('the default draft is valid and is what Save would send', () => {
    // Arrange
    const d = defaultDraft();
    // Act
    const errors = validateDraft(d);
    const cleaned = cleanDraft(d);
    // Assert
    expect(errors).toEqual({});
    expect(cleaned).toEqual(d);
    expect(d).toMatchObject({ preview: { enabled: false }, showCredit: true, support: { label: 'support' } });
  });

  it('counts graphemes, not UTF-16 units: 40 emoji are a valid name, 41 are not', () => {
    // Act
    const forty = validateDraft(draft({ name: '🎮'.repeat(40) })).name;
    const fortyOne = validateDraft(draft({ name: '🎮'.repeat(41) })).name;
    // Assert
    expect(forty).toBeUndefined();
    expect(fortyOne?.key).toBe('text.tooLong');
  });

  it('About: at most 12 lines (a run of blank lines counts as one: 6 lines and 5 blanks are 11), 1,000 graphemes', () => {
    // Act
    const errors = [validateDraft(draft({ about: lines(6, '\n\n\n\n') })), validateDraft(draft({ about: lines(12) })), validateDraft(draft({ about: lines(13) })), validateDraft(draft({ about: 'a'.repeat(1001) }))].map((e) => e.about?.key);
    // Assert
    expect(errors).toEqual([undefined, undefined, 'brand.err.lines', 'text.tooLong']);
  });

  it('tagline and end message caps', () => {
    // Act
    const atCap = validateDraft(draft({ tagline: 'x'.repeat(100), endedMessage: 'y'.repeat(140) }));
    const over = validateDraft(draft({ tagline: 'x'.repeat(101), endedMessage: 'y'.repeat(141) }));
    // Assert
    expect(atCap).toEqual({});
    expect([over.tagline?.key, over.endedMessage?.key]).toEqual(['text.tooLong', 'text.tooLong']);
  });

  it('tags: canonical, unique ignoring case and accents, at most 8, allowed characters only', () => {
    // Act
    const checks = [
      checkNewTag('  Música ', []),
      checkNewTag('musica', ['Música']),
      checkNewTag('new', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
      checkNewTag('a<b>', []),
      checkNewTag('🎮', []),
      checkNewTag('x'.repeat(25), []),
      checkNewTag('   ', []),
    ];
    const key = tagKey('Ação  Livre');
    // Assert
    expect(checks).toMatchObject([
      { ok: true, tag: 'Música' },
      { ok: false, error: { key: 'brand.err.tagDup' } },
      { ok: false, error: { key: 'admin.brand.err.tagsFull' } },
      { ok: false, error: { key: 'brand.err.tagChars' } },
      { ok: true, tag: '🎮' },
      { ok: false, error: { key: 'text.tooLong' } },
      { ok: false, error: { key: 'text.empty' } },
    ]);
    expect(key).toBe('acao livre');
  });

  it('links: bare hosts get https:// and e-mails mailto:, other schemes and tricks are refused', () => {
    // Act
    const bareHost = linkOf('ko-fi.com/ana');
    const email = linkOf('ana@example.org');
    const refused = REFUSED_LINKS.map(([raw]) => linkOf(raw));
    const own = linkOf('https://stream.example.org/x', 'stream.example.org');
    // Assert
    expect(bareHost).toMatchObject({ ok: true, href: 'https://ko-fi.com/ana', platform: 'kofi' });
    expect(email).toMatchObject({ ok: true, href: 'mailto:ana@example.org', kind: 'mailto' });
    expect(refused).toEqual(REFUSED_LINKS.map(([, code]) => ({ ok: false, code })));
    expect(own).toEqual({ ok: false, code: 'url.own' });
  });

  it('a homograph host is kept in its ASCII (punycode) form, so viewers see what it really is', () => {
    // Act
    const link = linkOf('https://аррle.com/');
    // Assert
    expect(link).toMatchObject({ ok: true, display: expect.stringMatching(/^xn--[a-z0-9-]+\.com$/) });
  });

  it('handles with "@" in the path still get their https:// (YouTube, Mastodon)', () => {
    // Act
    const handles = [linkOf('youtube.com/@ana'), linkOf('mastodon.social/@ana')];
    // Assert
    expect(handles).toMatchObject([
      { ok: true, href: 'https://youtube.com/@ana', platform: 'youtube' },
      { ok: true, href: 'https://mastodon.social/@ana', platform: 'mastodon' },
    ]);
  });

  it('link rows: empty rows are ignored, half-filled rows explain what is missing', () => {
    // Arrange
    const d = draft({
      links: [
        { label: '', url: '' },
        { label: 'YouTube', url: 'youtube.com/@ana' },
        { label: '', url: 'twitch.tv/ana' },
        { label: 'Bad', url: 'javascript:alert(1)' },
      ],
    });
    const ok = draft({ links: [{ label: ' YouTube ', url: 'youtube.com/@ana' }, { label: '', url: '' }] });
    // Act
    const e = validateDraft(d);
    const cleaned = cleanDraft(ok).links;
    // Assert
    expect(isEmptyLink(d.links[0]!)).toBe(true);
    expect(Object.keys(e).sort()).toEqual(['links.2.label', 'links.3.url']);
    expect(e['links.2.label']?.key).toBe('brand.err.linkLabel');
    expect(e['links.3.url']?.key).toBe('url.scheme');
    expect(cleaned).toEqual([{ label: 'YouTube', url: 'https://youtube.com/@ana' }]);
  });

  it('support link: validated only when the button is on and in link mode', () => {
    // Act
    const off = validateDraft(draft({ support: { enabled: false, label: 'support', mode: 'link', url: 'javascript:x' } }));
    const on = validateDraft(draft({ support: { enabled: true, label: 'support', mode: 'link', url: 'javascript:x' } }));
    const cleaned = cleanDraft(draft({ support: { enabled: true, label: 'tip', mode: 'link', url: 'livepix.gg/ana' } })).support;
    // Assert
    expect(off).toEqual({});
    expect(on['support.url']?.key).toBe('url.scheme');
    expect(cleaned).toEqual({ enabled: true, label: 'tip', mode: 'link', url: 'https://livepix.gg/ana' });
  });

  it('Pix: a CPF or phone key needs the second confirmation; name and city are required', () => {
    // Act
    const evp = validateDraft(pix('evp', EVP));
    const cpf = validateDraft(pix('cpf', '529.982.247-25'));
    const cpfConfirmed = validateDraft(pix('cpf', '529.982.247-25'), { pixConfirmed: true });
    const phone = validateDraft(pix('phone', '(11) 91234-5678'));
    const badCpf = validateDraft(pix('cpf', '111.111.111-11'));
    const badEvp = validateDraft(pix('evp', 'not-a-key'));
    const noNameNoCity = validateDraft(pix('evp', EVP, '😀', '  '));
    const cleanedKey = cleanDraft(pix('cpf', '529.982.247-25')).support.pix?.key;
    // Assert
    expect(evp).toEqual({});
    expect(cpf['support.pixConfirm']?.key).toBe('admin.brand.pix.err.confirm');
    expect(cpfConfirmed).toEqual({});
    expect(phone['support.pixConfirm']).toBeDefined();
    expect(badCpf['support.pixKey']?.key).toBe('pix.cpf');
    expect(badEvp['support.pixKey']?.key).toBe('pix.evp');
    expect([noNameNoCity['support.pixName']?.key, noNameNoCity['support.pixCity']?.key]).toEqual(['pix.name', 'pix.city']);
    expect(cleanedKey).toBe('52998224725');
  });

  it('custom colour must be a colour; a preset drops the custom one', () => {
    // Act
    const missing = validateDraft(draft({ theme: { preset: 'custom', corners: 'round' } }));
    const given = validateDraft(draft({ theme: { preset: 'custom', accent: '#C8102E', corners: 'soft' } }));
    const preset = cleanDraft(draft({ theme: { preset: 'ocean', accent: '#123456', corners: 'round' } })).theme;
    // Assert
    expect(missing['theme.accent']?.key).toBe('admin.brand.err.colour');
    expect(given).toEqual({});
    expect(preset).toEqual({ preset: 'ocean', corners: 'round' });
  });

  it('a saved config round-trips to the same draft (Save is disabled until something changes)', () => {
    // Arrange
    const d = draft({ name: 'Ana Plays', tags: ['cozy'], links: [{ label: 'YouTube', url: 'https://youtube.com/@ana' }] });
    const saved = textOf({ ...d, images: {}, rev: 3 });
    // Act
    const cleaned = cleanDraft(saved);
    // Assert
    expect(cleaned).toEqual(saved);
  });
});

describe("Your page: what the preview renders (PublicBranding)", () => {
  it("builds the viewers' shape from the draft, leaving invalid parts out", () => {
    // Arrange
    const d = draft({
      name: '  Ana   Plays ',
      tagline: 'Chill games',
      tags: ['cozy'],
      links: [
        { label: 'YouTube', url: 'youtube.com/@ana' },
        { label: 'Evil', url: 'javascript:alert(1)' },
      ],
      support: { enabled: true, label: 'support', mode: 'link', url: 'ko-fi.com/ana' },
    });
    // Act
    const p = toPublic(d, { avatar: '/api/branding/file/' + 'a'.repeat(64) + '.webp', banner: 'https://evil.example.org/x.png' });
    // Assert
    expect(p.name).toBe('Ana Plays');
    expect(p.links).toEqual([{ label: 'YouTube', href: 'https://youtube.com/@ana', display: 'youtube.com', platform: 'youtube' }]);
    expect(p.support?.link?.href).toBe('https://ko-fi.com/ana');
    expect(p.avatar?.s256).toMatch(/^\/api\/branding\/file\//);
    expect(p.banner).toBeUndefined();
  });

  it('Pix: the preview carries the byte-exact BR Code (BCB manual example)', () => {
    // Act
    const p = toPublic(draft({ support: { enabled: true, label: 'pix', mode: 'pix', pix: { type: 'evp', key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' } } }), {});
    // Assert
    expect(p.support?.pix?.payload).toBe(BCB_EXAMPLE);
    expect(p.support?.label).toBe('pix');
  });

  it('only accepts its own picture URLs (panel object URLs or the branding file route)', () => {
    // Act
    const own = safeImageSrc('blob:http://127.0.0.1:11081/0f3c1a2b-1111-4222-8333-444455556666');
    const foreign = ['blob:https://evil.example.org/abc', 'javascript:alert(1)', '/api/branding/file/../../etc/passwd', 'data:image/svg+xml,<svg/>'].map(safeImageSrc);
    // Assert
    expect(own).toBeDefined();
    expect(foreign).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('Your page: preview colours', () => {
  it('every preset gives readable buttons and links in both modes', () => {
    // Act
    const contrasts = BRAND_PRESETS.filter((p) => p !== 'custom').flatMap((preset) =>
      (['light', 'dark'] as const).map((mode) => {
        const v = previewVars(mode, deriveTheme({ preset }), 'round');
        return { name: `${preset} ${mode}`, button: contrastRatio(v['--sc-accent']!, v['--sc-bg']!), label: contrastRatio(v['--sc-on-accent']!, v['--sc-accent']!), link: contrastRatio(v['--sc-accent-strong']!, v['--sc-surface']!) };
      }),
    );
    // Assert
    for (const c of contrasts) {
      expect(c.button, `${c.name} button vs page`).toBeGreaterThanOrEqual(3);
      expect(c.label, `${c.name} label`).toBeGreaterThanOrEqual(4.5);
      expect(c.link, `${c.name} link`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('any custom colour: the preview tokens meet the contrast rules in both modes (property)', () => {
    // Act
    const run = () =>
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 0xffffff }), fc.constantFrom('light' as const, 'dark' as const), (n, mode) => {
          const accent = `#${n.toString(16).padStart(6, '0')}`;
          const v = previewVars(mode, deriveTheme({ preset: 'custom', accent }), 'square');
          return (
            v['--sc-bg'] === THEME_BASE[mode].bg &&
            contrastRatio(v['--sc-accent']!, v['--sc-bg']!) >= 3 &&
            contrastRatio(v['--sc-on-accent']!, v['--sc-accent']!) >= 4.5 &&
            contrastRatio(v['--sc-accent-strong']!, v['--sc-bg']!) >= 4.5 &&
            contrastRatio(v['--sc-accent-strong']!, v['--sc-surface']!) >= 4.5 &&
            v['--sc-radius-lg'] === '4px'
          );
        }),
        { numRuns: 2000, seed: 20261029 },
      );
    // Assert
    expect(run).not.toThrow();
  });

  it('swatches: presets show their light button colour; custom shows the picked colour', () => {
    // Act
    const swatches = [presetSwatch('forest'), presetSwatch('custom', '#C8102E'), presetSwatch('custom', 'red')];
    // Assert
    expect(swatches).toEqual(['#0f5c53', '#c8102e', '#0f5c53']);
  });
});

describe('Your page: pictures (panel stage of the upload pipeline)', () => {
  it('each field renders the exact slot variants, master first', () => {
    // Assert
    expect(FIELD_SLOTS.avatar).toEqual(['avatar', 'avatar128', 'fav32', 'fav180']);
    expect(FIELD_SLOTS.banner).toEqual(['banner', 'banner640']);
    expect(FIELD_ASPECT.banner).toBe(4);
  });

  it('quality steps go from 0.86 down by 0.08', () => {
    // Act
    const steps = qualitySteps();
    // Assert
    expect(steps).toEqual([0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3]);
  });

  it('crop: the shape fits inside the picture at any zoom and centre (property)', () => {
    // Act
    const run = () =>
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 12000 }),
          fc.integer({ min: 1, max: 12000 }),
          fc.constantFrom(1, 4, 1200 / 630),
          fc.double({ min: -2, max: 6, noNaN: true }),
          fc.double({ min: -1, max: 2, noNaN: true }),
          fc.double({ min: -1, max: 2, noNaN: true }),
          (w, h, aspect, zoom, cx, cy) => {
            const r = cropRect(w, h, aspect, { zoom, cx, cy });
            const eps = 1e-6;
            return r.sx >= -eps && r.sy >= -eps && r.sx + r.sw <= w + eps && r.sy + r.sh <= h + eps && Math.abs(r.sw / r.sh - aspect) < 1e-6 * aspect + 1e-9;
          },
        ),
        { numRuns: 2000, seed: 7 },
      );
    // Assert
    expect(run).not.toThrow();
  });

  it('the output type comes from the bytes (WebKit answers PNG to a WebP request)', () => {
    // Act
    const types = [
      encodedType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      encodedType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
      encodedType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')),
      encodedType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ];
    const fallbacks = [fallbackType(true), fallbackType(false)];
    // Assert
    expect(types).toEqual(['image/png', 'image/jpeg', 'image/webp', null]);
    expect(fallbacks).toEqual(['image/png', 'image/jpeg']);
  });
});
