import { useEffect, useRef, useState } from 'preact/hooks';
import type { MessageKey, MessageParams } from '@swarmcast/shared';
import { deriveTheme, drawQr, qrMatrix, renderBrandAbout, renderBrandHeader, renderSupportButton, type PublicBranding, type ThemeMode } from '@swarmcast/shared/branding';
import { t } from '@swarmcast/shared/i18n';
import { previewVars } from './preview-theme.js';
import { toPublic, type PreviewImages } from './public.js';
import type { Draft } from './types.js';

/**
 * What viewers see (plan branding-0.4.0 §2.7), drawn by the viewers' own renderer
 * (`@swarmcast/shared/branding` render-dom: createElement + textContent only) inside the panel,
 * with the derived theme tokens, in light or dark and at computer or phone width. Not an
 * iframe: the viewer pages cannot be framed. The join card and the end screen, which the viewer
 * pages build themselves, are Preact text nodes here.
 */

const tr = (key: MessageKey, params?: MessageParams): string => t(key, params);

/** Mount a render-dom node into a container (replacing what was there). */
function useMount(ref: { current: HTMLElement | null }, build: (doc: Document) => HTMLElement | null, deps: unknown[]): void {
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const node = build(host.ownerDocument);
    if (node) host.replaceChildren(node);
    else host.replaceChildren();
  }, deps);
}

/** "Join {name}'s stream" with the name as its own <bdi> node (never concatenated into markup). */
function Interpolated({ template, name }: { template: string; name: string }) {
  const [before = '', after = ''] = template.split('');
  return (
    <>
      {before}
      <bdi dir="auto">{name}</bdi>
      {after}
    </>
  );
}

function PixSheet({ pix, onClose }: { pix: NonNullable<NonNullable<PublicBranding['support']>['pix']>; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const m = qrMatrix(pix.payload);
    const scale = 4;
    c.width = c.height = (m.length + 8) * scale;
    const ctx = c.getContext('2d');
    if (ctx) drawQr(ctx, m, scale);
  }, [pix.payload]);
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
      <div class="bp-muted">{t('admin.brand.pv.pixKey')}</div>
      <code class="bp-code" data-testid="bp-pix-key">
        {pix.key}
      </code>
      <button type="button" class="bp-btn" data-testid="bp-pix-copy-key" onClick={() => copy('key', pix.key)}>
        {copied === 'key' ? t('common.copied') : t('admin.brand.pv.pixCopyKey')}
      </button>
      <button type="button" class="bp-btn" data-testid="bp-pix-copy-code" onClick={() => copy('code', pix.payload)}>
        {copied === 'code' ? t('common.copied') : t('admin.brand.pv.pixCopyCode')}
      </button>
      <code class="bp-code bp-code-long" data-testid="bp-pix-code">
        {pix.payload}
      </code>
      <div class="bp-muted">{t('admin.brand.pv.pixScan')}</div>
      <canvas ref={canvas} class="bp-qr" data-testid="bp-pix-qr" role="img" aria-label="QR code" />
      <div class="bp-muted bp-small">{t('admin.brand.pv.pixPayerSees')}</div>
    </div>
  );
}

export function Preview({ draft, images }: { draft: Draft; images: PreviewImages }) {
  const [page, setPage] = useState<'watch' | 'join' | 'ended'>('watch');
  const [phone, setPhone] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(() => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [pixOpen, setPixOpen] = useState(false);
  const header = useRef<HTMLDivElement>(null);
  const about = useRef<HTMLDivElement>(null);
  const support = useRef<HTMLDivElement>(null);
  const endedSupport = useRef<HTMLDivElement>(null);

  const branded = draft.enabled;
  const pub: PublicBranding = branded ? toPublic(draft, images) : { rev: 0, tags: [], links: [], theme: { preset: 'forest', corners: 'round' }, showCredit: true };
  const derived = deriveTheme(branded ? draft.theme : { preset: 'forest' });
  const vars = previewVars(mode, derived, branded ? draft.theme.corners : 'round');
  const key = JSON.stringify(pub);
  const lang = t('lang.name');
  const opts = { t: tr };

  const supportNode = (doc: Document): HTMLElement | null => {
    const b = renderSupportButton(pub, { doc, ...opts });
    if (b && pub.support?.pix) b.addEventListener('click', () => setPixOpen(true));
    b?.setAttribute('data-testid', 'bp-support');
    return b;
  };
  useMount(header, (doc) => (pub.name || pub.avatar || pub.tagline ? renderBrandHeader(pub, { doc, ...opts }) : null), [key, page, lang]);
  useMount(about, (doc) => renderBrandAbout(pub, { doc, ...opts }), [key, page, lang]);
  useMount(support, supportNode, [key, page, lang]);
  useMount(endedSupport, supportNode, [key, page, lang]);
  useEffect(() => {
    if (!pub.support?.pix) setPixOpen(false);
  }, [key]);

  const seg = <T extends string>(value: T, current: T, set: (v: T) => void, label: string, testid: string) => (
    <button type="button" class="seg-btn" aria-pressed={value === current} data-testid={testid} onClick={() => set(value)}>
      {label}
    </button>
  );
  const credit = pub.showCredit && <footer class="bp-credit">{t('brand.credit')}</footer>;

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
          {seg<ThemeMode>('light', mode, setMode, t('admin.brand.preview.light'), 'bp-light')}
          {seg<ThemeMode>('dark', mode, setMode, t('admin.brand.preview.dark'), 'bp-dark')}
        </div>
      </div>
      <div class={`bp ${phone ? 'bp-phone' : 'bp-desktop'}`} style={vars} data-mode={mode} data-testid="brand-preview">
        {page === 'watch' && (
          <div class="bp-page">
            <div class="bp-top">
              {!pub.name && !pub.avatar && (
                <span class="bp-stock">
                  <span class="sc-symbol" aria-hidden="true" />
                  <span class="sc-wordmark">SwarmCast</span>
                </span>
              )}
              <div ref={header} class="bp-header-slot" data-testid="bp-header" />
              <span class="spacer" />
              <div ref={support} class="bp-support-slot" />
            </div>
            {pub.banner && <img class="bp-banner" src={pub.banner.s1280} alt={pub.banner.alt ?? ''} data-testid="bp-banner" />}
            <div class="bp-video" aria-hidden="true">
              <span class="bp-live">{t('admin.brand.pv.live')}</span>
            </div>
            <div ref={about} class="bp-about-slot" data-testid="bp-about" />
            {credit}
          </div>
        )}
        {page === 'join' && (
          <div class="bp-page bp-join">
            <div class="bp-join-card">
              {pub.avatar ? <img class="bp-avatar-lg" src={pub.avatar.s256} alt="" /> : <span class="bp-avatar-lg sc-symbol" aria-hidden="true" />}
              <h3 data-testid="bp-join-title">{pub.name ? <Interpolated template={t('admin.brand.pv.join', { name: '' })} name={pub.name} /> : t('admin.brand.pv.joinStock')}</h3>
              <p class="bp-muted">{pub.tagline ? <bdi dir="auto">{pub.tagline}</bdi> : t('admin.brand.pv.intro')}</p>
              <span class="bp-input">{t('admin.brand.pv.nickname')}</span>
              <span class="bp-btn bp-btn-wide">{t('admin.brand.pv.joinButton')}</span>
            </div>
            {credit}
          </div>
        )}
        {page === 'ended' && (
          <div class="bp-page bp-ended">
            {pub.avatar ? <img class="bp-avatar-lg" src={pub.avatar.s256} alt="" /> : <span class="bp-mascot sc-mascot sc-mascot-sleep" aria-hidden="true" />}
            <p data-testid="bp-ended">{pub.endedMessage ? <bdi dir="auto">{pub.endedMessage}</bdi> : t('admin.brand.pv.ended')}</p>
            <div ref={endedSupport} class="bp-support-slot" />
            {credit}
          </div>
        )}
        {pixOpen && pub.support?.pix && <PixSheet pix={pub.support.pix} onClose={() => setPixOpen(false)} />}
      </div>
    </div>
  );
}
