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

describe('Your page: draft validation (panel glue over the shared rules)', () => {
  it('the default draft is valid and is what Save would send', () => {
    const d = defaultDraft();
    expect(validateDraft(d)).toEqual({});
    expect(cleanDraft(d)).toEqual(d);
    expect(d.preview.enabled).toBe(false);
    expect(d.showCredit).toBe(true);
    expect(d.support.label).toBe('support');
  });

  it('counts graphemes, not UTF-16 units: 40 emoji are a valid name, 41 are not', () => {
    expect(validateDraft(draft({ name: '🎮'.repeat(40) })).name).toBeUndefined();
    expect(validateDraft(draft({ name: '🎮'.repeat(41) })).name?.key).toBe('text.tooLong');
  });

  it('About: at most 12 lines (blank runs collapse), 1,000 graphemes', () => {
    // A run of blank lines counts as one blank line: 6 lines + 5 blanks = 11.
    expect(validateDraft(draft({ about: Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n\n\n\n') })).about).toBeUndefined();
    expect(validateDraft(draft({ about: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') })).about).toBeUndefined();
    expect(validateDraft(draft({ about: Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n') })).about?.key).toBe('brand.err.lines');
    expect(validateDraft(draft({ about: 'a'.repeat(1001) })).about?.key).toBe('text.tooLong');
  });

  it('tagline and end message caps', () => {
    expect(validateDraft(draft({ tagline: 'x'.repeat(100), endedMessage: 'y'.repeat(140) }))).toEqual({});
    const e = validateDraft(draft({ tagline: 'x'.repeat(101), endedMessage: 'y'.repeat(141) }));
    expect(e.tagline?.key).toBe('text.tooLong');
    expect(e.endedMessage?.key).toBe('text.tooLong');
  });

  it('tags: canonical, unique ignoring case and accents, at most 8, allowed characters only', () => {
    expect(checkNewTag('  Música ', [])).toEqual({ ok: true, tag: 'Música' });
    expect(checkNewTag('musica', ['Música'])).toMatchObject({ ok: false, error: { key: 'brand.err.tagDup' } });
    expect(checkNewTag('new', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toMatchObject({ ok: false, error: { key: 'admin.brand.err.tagsFull' } });
    expect(checkNewTag('a<b>', [])).toMatchObject({ ok: false, error: { key: 'brand.err.tagChars' } });
    expect(checkNewTag('🎮', [])).toEqual({ ok: true, tag: '🎮' });
    expect(checkNewTag('x'.repeat(25), [])).toMatchObject({ ok: false, error: { key: 'text.tooLong' } });
    expect(checkNewTag('   ', [])).toMatchObject({ ok: false, error: { key: 'text.empty' } });
    expect(tagKey('Ação  Livre')).toBe('acao livre');
  });

  it('links: bare hosts get https:// and e-mails mailto:, other schemes and tricks are refused', () => {
    expect(linkOf('ko-fi.com/ana')).toMatchObject({ ok: true, href: 'https://ko-fi.com/ana', platform: 'kofi' });
    expect(linkOf('ana@example.org')).toMatchObject({ ok: true, href: 'mailto:ana@example.org', kind: 'mailto' });
    const refused: Array<[string, string]> = [
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
    for (const [raw, code] of refused) expect(linkOf(raw), raw).toEqual({ ok: false, code });
    // A homograph host is kept in its ASCII (punycode) form, so viewers see what it really is.
    expect(linkOf('https://аррle.com/')).toMatchObject({ ok: true, display: expect.stringMatching(/^xn--[a-z0-9-]+\.com$/) });
    // Handles with "@" in the path still get their https:// (YouTube, Mastodon).
    expect(linkOf('youtube.com/@ana')).toMatchObject({ ok: true, href: 'https://youtube.com/@ana', platform: 'youtube' });
    expect(linkOf('mastodon.social/@ana')).toMatchObject({ ok: true, href: 'https://mastodon.social/@ana', platform: 'mastodon' });
    expect(linkOf('https://stream.example.org/x', 'stream.example.org')).toEqual({ ok: false, code: 'url.own' });
  });

  it('link rows: empty rows are ignored, half-filled rows explain what is missing', () => {
    const d = draft({
      links: [
        { label: '', url: '' },
        { label: 'YouTube', url: 'youtube.com/@ana' },
        { label: '', url: 'twitch.tv/ana' },
        { label: 'Bad', url: 'javascript:alert(1)' },
      ],
    });
    expect(isEmptyLink(d.links[0]!)).toBe(true);
    const e = validateDraft(d);
    expect(Object.keys(e).sort()).toEqual(['links.2.label', 'links.3.url']);
    expect(e['links.2.label']?.key).toBe('brand.err.linkLabel');
    expect(e['links.3.url']?.key).toBe('url.scheme');
    const ok = draft({ links: [{ label: ' YouTube ', url: 'youtube.com/@ana' }, { label: '', url: '' }] });
    expect(cleanDraft(ok).links).toEqual([{ label: 'YouTube', url: 'https://youtube.com/@ana' }]);
  });

  it('support link: validated only when the button is on and in link mode', () => {
    expect(validateDraft(draft({ support: { enabled: false, label: 'support', mode: 'link', url: 'javascript:x' } }))).toEqual({});
    expect(validateDraft(draft({ support: { enabled: true, label: 'support', mode: 'link', url: 'javascript:x' } }))['support.url']?.key).toBe('url.scheme');
    const c = cleanDraft(draft({ support: { enabled: true, label: 'tip', mode: 'link', url: 'livepix.gg/ana' } }));
    expect(c.support).toEqual({ enabled: true, label: 'tip', mode: 'link', url: 'https://livepix.gg/ana' });
  });

  it('Pix: a CPF or phone key needs the second confirmation; name and city are required', () => {
    const pix = (type: 'evp' | 'cpf' | 'phone', key: string, name = 'Ana Lima', city = 'São Paulo'): Draft =>
      draft({ support: { enabled: true, label: 'support', mode: 'pix', pix: { type, key, name, city } } });
    expect(validateDraft(pix('evp', '123e4567-e89b-12d3-a456-426614174000'))).toEqual({});
    expect(validateDraft(pix('cpf', '529.982.247-25'))['support.pixConfirm']?.key).toBe('admin.brand.pix.err.confirm');
    expect(validateDraft(pix('cpf', '529.982.247-25'), { pixConfirmed: true })).toEqual({});
    expect(validateDraft(pix('phone', '(11) 91234-5678'))['support.pixConfirm']).toBeDefined();
    expect(validateDraft(pix('cpf', '111.111.111-11'))['support.pixKey']?.key).toBe('pix.cpf');
    expect(validateDraft(pix('evp', 'not-a-key'))['support.pixKey']?.key).toBe('pix.evp');
    const e = validateDraft(pix('evp', '123e4567-e89b-12d3-a456-426614174000', '😀', '  '));
    expect(e['support.pixName']?.key).toBe('pix.name');
    expect(e['support.pixCity']?.key).toBe('pix.city');
    expect(cleanDraft(pix('cpf', '529.982.247-25')).support.pix?.key).toBe('52998224725');
  });

  it('custom colour must be a colour', () => {
    expect(validateDraft(draft({ theme: { preset: 'custom', corners: 'round' } }))['theme.accent']?.key).toBe('admin.brand.err.colour');
    expect(validateDraft(draft({ theme: { preset: 'custom', accent: '#C8102E', corners: 'soft' } }))).toEqual({});
    expect(cleanDraft(draft({ theme: { preset: 'ocean', accent: '#123456', corners: 'round' } })).theme).toEqual({ preset: 'ocean', corners: 'round' });
  });

  it('a saved config round-trips to the same draft (Save is disabled until something changes)', () => {
    const d = draft({ name: 'Ana Plays', tags: ['cozy'], links: [{ label: 'YouTube', url: 'https://youtube.com/@ana' }] });
    const saved = textOf({ ...d, images: {}, rev: 3 });
    expect(cleanDraft(saved)).toEqual(saved);
  });
});

describe('Your page: what the preview renders (PublicBranding)', () => {
  it('builds the viewers\' shape from the draft, leaving invalid parts out', () => {
    const p = toPublic(
      draft({
        name: '  Ana   Plays ',
        tagline: 'Chill games',
        tags: ['cozy'],
        links: [
          { label: 'YouTube', url: 'youtube.com/@ana' },
          { label: 'Evil', url: 'javascript:alert(1)' },
        ],
        support: { enabled: true, label: 'support', mode: 'link', url: 'ko-fi.com/ana' },
      }),
      { avatar: '/api/branding/file/' + 'a'.repeat(64) + '.webp', banner: 'https://evil.example.org/x.png' },
    );
    expect(p.name).toBe('Ana Plays');
    expect(p.links).toEqual([{ label: 'YouTube', href: 'https://youtube.com/@ana', display: 'youtube.com', platform: 'youtube' }]);
    expect(p.support?.link?.href).toBe('https://ko-fi.com/ana');
    expect(p.avatar?.s256).toMatch(/^\/api\/branding\/file\//);
    expect(p.banner).toBeUndefined();
  });

  it('Pix: the preview carries the byte-exact BR Code (BCB manual example)', () => {
    const p = toPublic(draft({ support: { enabled: true, label: 'pix', mode: 'pix', pix: { type: 'evp', key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' } } }), {});
    expect(p.support?.pix?.payload).toBe(BCB_EXAMPLE);
    expect(p.support?.label).toBe('pix');
  });

  it('only accepts its own picture URLs (panel object URLs or the branding file route)', () => {
    expect(safeImageSrc('blob:http://127.0.0.1:38081/0f3c1a2b-1111-4222-8333-444455556666')).toBeDefined();
    expect(safeImageSrc('blob:https://evil.example.org/abc')).toBeUndefined();
    expect(safeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(safeImageSrc('/api/branding/file/../../etc/passwd')).toBeUndefined();
    expect(safeImageSrc('data:image/svg+xml,<svg/>')).toBeUndefined();
  });
});

describe('Your page: preview colours', () => {
  it('every preset gives readable buttons and links in both modes', () => {
    for (const preset of BRAND_PRESETS.filter((p) => p !== 'custom')) {
      for (const mode of ['light', 'dark'] as const) {
        const v = previewVars(mode, deriveTheme({ preset }), 'round');
        expect(contrastRatio(v['--sc-accent']!, v['--sc-bg']!), `${preset} ${mode} button vs page`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(v['--sc-on-accent']!, v['--sc-accent']!), `${preset} ${mode} label`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(v['--sc-accent-strong']!, v['--sc-surface']!), `${preset} ${mode} link`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('any custom colour: the preview tokens meet the contrast rules in both modes (property)', () => {
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
  });

  it('swatches: presets show their light button colour; custom shows the picked colour', () => {
    expect(presetSwatch('forest')).toBe('#0f5c53');
    expect(presetSwatch('custom', '#C8102E')).toBe('#c8102e');
    expect(presetSwatch('custom', 'red')).toBe('#0f5c53');
  });
});

describe('Your page: pictures (panel stage of the upload pipeline)', () => {
  it('each field renders the exact slot variants, master first', () => {
    expect(FIELD_SLOTS.avatar).toEqual(['avatar', 'avatar128', 'fav32', 'fav180']);
    expect(FIELD_SLOTS.banner).toEqual(['banner', 'banner640']);
    expect(FIELD_ASPECT.banner).toBe(4);
  });

  it('quality steps go from 0.86 down by 0.08', () => {
    expect(qualitySteps()).toEqual([0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3]);
  });

  it('crop: the shape fits inside the picture at any zoom and centre (property)', () => {
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
  });

  it('the output type comes from the bytes (WebKit answers PNG to a WebP request)', () => {
    expect(encodedType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(encodedType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(encodedType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(encodedType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(fallbackType(true)).toBe('image/png');
    expect(fallbackType(false)).toBe('image/jpeg');
  });
});
