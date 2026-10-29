import { useEffect, useRef, useState } from 'preact/hooks';
import type { MessageKey } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { buildBrCode, parsePixKey } from './pix.js';
import { drawQr, encodeQr } from './qr.js';
import { deriveTheme, previewVars, type ThemeName } from './theme.js';
import type { BrandingText, SupportLabel } from './types.js';
import { parseBrandUrl, PLATFORM_NAMES, type BrandLink } from './url.js';

/**
 * A faithful component render of what viewers see (plan branding-0.4.0 §2.7): the watch page's
 * header, banner and About card, the join card and the end screen, with the derived theme
 * tokens, in light or dark and at computer or phone width. Not an iframe: the viewer pages
 * cannot be framed. Text only through text nodes; every href comes from parseBrandUrl.
 */

export interface PreviewImages {
  avatar?: string;
  banner?: string;
}

const SUPPORT_KEY: Record<SupportLabel, MessageKey> = {
  tip: 'admin.brand.pv.support.tip',
  support: 'admin.brand.pv.support.support',
  donate: 'admin.brand.pv.support.donate',
  pix: 'admin.brand.pv.support.pix',
};

/** Only object URLs this panel made, or the panel's own branding file route. */
export function safeImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('blob:')) return src;
  return /^\/api\/branding\/file\/[0-9a-f]{64}\.(png|jpg|webp)$/.test(src) ? src : undefined;
}

/** "Join {name}'s stream" with the name as its own <bdi> node (never concatenated into markup). */
function Interpolated({ template, name }: { template: string; name: string }) {
  const mark = '';
  const [before = '', after = ''] = template.split(mark);
  return (
    <>
      {before}
      <bdi>{name}</bdi>
      {after}
    </>
  );
}

function ExternalLink({ link, label, class: cls, testid }: { link: BrandLink; label: string; class?: string; testid?: string }) {
  return (
    <a class={cls} href={link.href} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer" data-testid={testid}>
      <bdi>{label}</bdi>
    </a>
  );
}

function Avatar({ src, size }: { src?: string; size: 'sm' | 'lg' }) {
  const safe = safeImageSrc(src);
  return safe ? <img class={`bp-avatar bp-avatar-${size}`} src={safe} alt="" data-testid="bp-avatar" /> : <span class={`bp-avatar bp-avatar-${size} sc-symbol`} aria-hidden="true" />;
}

function PixSheet({ d, onClose }: { d: BrandingText; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const s = d.support!;
  const key = parsePixKey(s.pixKey ?? '');
  let code: string | null = null;
  try {
    code = key.ok ? buildBrCode({ key: key.key, name: s.pixName ?? '', city: s.pixCity ?? '' }) : null;
  } catch {
    code = null;
  }
  useEffect(() => {
    if (canvas.current && code) drawQr(canvas.current, encodeQr(code), 4);
  }, [code]);
  const copy = (what: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  };
  return (
    <div class="bp-sheet" role="dialog" aria-label={t('admin.brand.pv.pixTitle')} data-testid="bp-pix-sheet">
      <div class="bp-sheet-head">
        <strong>{t('admin.brand.pv.pixTitle')}</strong>
        <button type="button" class="bp-btn-ghost" onClick={onClose}>
          {t('admin.brand.pv.close')}
        </button>
      </div>
      {key.ok && (
        <>
          <div class="bp-muted">{t('admin.brand.pv.pixKey')}</div>
          <code class="bp-code" data-testid="bp-pix-key">
            {key.key}
          </code>
          <button type="button" class="bp-btn" data-testid="bp-pix-copy-key" onClick={() => copy('key', key.key)}>
            {copied === 'key' ? t('common.copied') : t('admin.brand.pv.pixCopyKey')}
          </button>
        </>
      )}
      {code && (
        <>
          <button type="button" class="bp-btn" data-testid="bp-pix-copy-code" onClick={() => copy('code', code)}>
            {copied === 'code' ? t('common.copied') : t('admin.brand.pv.pixCopyCode')}
          </button>
          <code class="bp-code bp-code-long" data-testid="bp-pix-code">
            {code}
          </code>
          <div class="bp-muted">{t('admin.brand.pv.pixScan')}</div>
          <canvas ref={canvas} class="bp-qr" data-testid="bp-pix-qr" aria-label="QR code" role="img" />
        </>
      )}
      <div class="bp-muted bp-small">{t('admin.brand.pv.pixPayerSees')}</div>
    </div>
  );
}

function SupportButton({ d, onPix }: { d: BrandingText; onPix: () => void }) {
  const s = d.support;
  if (!s) return null;
  const label = t(SUPPORT_KEY[s.label]);
  if (s.mode === 'link') {
    const r = parseBrandUrl(s.url ?? '');
    return r.ok ? <ExternalLink link={r.value} label={label} class="bp-btn bp-support" testid="bp-support" /> : null;
  }
  return parsePixKey(s.pixKey ?? '').ok ? (
    <button type="button" class="bp-btn bp-support" data-testid="bp-support" onClick={onPix}>
      {label}
    </button>
  ) : null;
}

export function Preview({ draft: d, images }: { draft: BrandingText; images: PreviewImages }) {
  const [page, setPage] = useState<'watch' | 'join' | 'ended'>('watch');
  const [phone, setPhone] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [more, setMore] = useState(false);
  const [pixOpen, setPixOpen] = useState(false);
  const derived = deriveTheme(d.theme.preset, d.theme.accent);
  const vars = previewVars(theme, derived, d.theme.corners);
  const branded = d.enabled;
  const name = branded ? d.name?.trim() : undefined;
  const links = branded ? d.links.map((l) => ({ label: l.label.trim(), r: parseBrandUrl(l.url) })).filter((l) => l.label && l.r.ok) : [];
  const banner = branded ? safeImageSrc(images.banner) : undefined;
  const avatar = branded ? images.avatar : undefined;
  const about = branded ? d.about?.trim() : undefined;
  const tagline = branded ? d.tagline?.trim() : undefined;
  const tags = branded ? d.tags : [];
  const credit = !branded || d.showCredit;

  const seg = <T extends string>(value: T, current: T, set: (v: T) => void, label: string, testid: string) => (
    <button type="button" class="seg-btn" aria-pressed={value === current} data-testid={testid} onClick={() => set(value)}>
      {label}
    </button>
  );

  return (
    <div class="bp-wrap">
      <div class="bp-toolbar" role="toolbar" aria-label={t('admin.brand.preview')}>
        <div class="seg">
          {seg('watch', page, setPage, t('admin.brand.preview.watch'), 'bp-tab-watch')}
          {seg('join', page, setPage, t('admin.brand.preview.join'), 'bp-tab-join')}
          {seg('ended', page, setPage, t('admin.brand.preview.endedTab'), 'bp-tab-ended')}
        </div>
        <div class="seg">
          {seg<'d' | 'p'>('d', phone ? 'p' : 'd', (v) => setPhone(v === 'p'), t('admin.brand.preview.desktop'), 'bp-desktop')}
          {seg<'d' | 'p'>('p', phone ? 'p' : 'd', (v) => setPhone(v === 'p'), t('admin.brand.preview.phone'), 'bp-phone')}
        </div>
        <div class="seg">
          {seg<ThemeName>('light', theme, setTheme, t('admin.brand.preview.light'), 'bp-light')}
          {seg<ThemeName>('dark', theme, setTheme, t('admin.brand.preview.dark'), 'bp-dark')}
        </div>
      </div>
      <div class={`bp ${phone ? 'bp-phone' : 'bp-desktop'}`} style={vars} data-theme-preview={theme} data-testid="brand-preview">
        {page === 'watch' && (
          <div class="bp-page">
            <header class="bp-header">
              <Avatar src={avatar} size="sm" />
              <span class="bp-name" data-testid="bp-name">
                {name ? <bdi>{name}</bdi> : <span class="sc-wordmark">SwarmCast</span>}
              </span>
              <span class="spacer" />
              {branded && <SupportButton d={d} onPix={() => setPixOpen(true)} />}
            </header>
            {banner && <img class="bp-banner" src={banner} alt="" data-testid="bp-banner" />}
            <div class="bp-video" aria-hidden="true">
              <span class="bp-live">{t('admin.brand.pv.live')}</span>
            </div>
            {(tagline || about || tags.length > 0 || links.length > 0) && (
              <section class="bp-about" data-testid="bp-about">
                <h3>{t('admin.brand.pv.about')}</h3>
                {tagline && (
                  <p class="bp-tagline" data-testid="bp-tagline">
                    <bdi>{tagline}</bdi>
                  </p>
                )}
                {about && (
                  <>
                    <p class={`bp-about-text ${more ? '' : 'bp-clamp'}`} dir="auto" data-testid="bp-about-text">
                      {about}
                    </p>
                    {about.split('\n').length > 6 || about.length > 400 ? (
                      <button type="button" class="bp-btn-ghost" onClick={() => setMore(!more)}>
                        {more ? t('admin.brand.pv.showLess') : t('admin.brand.pv.showMore')}
                      </button>
                    ) : null}
                  </>
                )}
                {tags.length > 0 && (
                  <ul class="bp-tags" data-testid="bp-tags">
                    {tags.map((tag) => (
                      <li key={tag}>
                        <bdi>{tag}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
                {links.length > 0 && (
                  <ul class="bp-links" data-testid="bp-links">
                    {links.map(({ label, r }, i) =>
                      r.ok ? (
                        <li key={i}>
                          <ExternalLink link={r.value} label={label} class="bp-link" testid="bp-link" />
                          <span class="bp-host">
                            {r.value.platform ? `${PLATFORM_NAMES[r.value.platform]} · ` : ''}
                            {r.value.display}
                          </span>
                        </li>
                      ) : null,
                    )}
                  </ul>
                )}
              </section>
            )}
            {credit && <footer class="bp-credit">{t('admin.brand.pv.credit')}</footer>}
          </div>
        )}
        {page === 'join' && (
          <div class="bp-page bp-join">
            <div class="bp-join-card">
              <Avatar src={avatar} size="lg" />
              <h3 data-testid="bp-join-title">{name ? <Interpolated template={t('admin.brand.pv.join', { name: '' })} name={name} /> : t('admin.brand.pv.joinStock')}</h3>
              <p class="bp-muted">{tagline ? <bdi>{tagline}</bdi> : t('admin.brand.pv.intro')}</p>
              <span class="bp-input">{t('admin.brand.pv.nickname')}</span>
              <span class="bp-btn bp-btn-wide">{t('admin.brand.pv.joinButton')}</span>
            </div>
            {credit && <footer class="bp-credit">{t('admin.brand.pv.credit')}</footer>}
          </div>
        )}
        {page === 'ended' && (
          <div class="bp-page bp-ended">
            {branded && avatar ? <Avatar src={avatar} size="lg" /> : <span class="bp-mascot sc-mascot sc-mascot-sleep" aria-hidden="true" />}
            <p data-testid="bp-ended">{branded && d.endedMessage?.trim() ? <bdi>{d.endedMessage.trim()}</bdi> : t('admin.brand.pv.ended')}</p>
            {branded && <SupportButton d={d} onPix={() => setPixOpen(true)} />}
          </div>
        )}
        {pixOpen && d.support?.mode === 'pix' && <PixSheet d={d} onClose={() => setPixOpen(false)} />}
      </div>
    </div>
  );
}
