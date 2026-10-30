import { BRAND_MAX_LINKS } from '@swarmcast/shared/branding';
import { t } from '@swarmcast/shared/i18n';
import { Info } from '../Info.js';
import { PLATFORM_NAMES } from './platforms.js';
import type { Draft } from './types.js';
import { isEmptyLink, linkOf, suggestLink, type FieldErrors } from './validate.js';

/** Up to 6 links: a name and an address each; where it goes shows as soon as the address parses. */
export function LinksEditor({ links, errors, onChange }: { links: Draft['links']; errors: FieldErrors; onChange: (links: Draft['links']) => void }) {
  const set = (i: number, patch: Partial<Draft['links'][number]>): void => onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div class="field" data-testid="brand-links">
      <span class="label-w">
        {t('admin.brand.links')} <Info text={t('admin.brand.links.tip')} />
      </span>
      {links.map((l, i) => {
        const r = l.url.trim() ? linkOf(l.url) : null;
        const empty = isEmptyLink(l);
        const labelErr = empty ? undefined : errors[`links.${i}.label`];
        const urlErr = l.url.trim() ? errors[`links.${i}.url`] : undefined;
        const added = r?.ok && suggestLink(l.url) !== l.url.trim();
        return (
          <div class="bf-link-row" key={i} data-testid="brand-link-row">
            <input
              class="text-input bf-link-label"
              aria-label={t('admin.brand.links.label')}
              placeholder={t('admin.brand.links.label')}
              maxLength={200}
              value={l.label}
              aria-invalid={labelErr ? true : undefined}
              data-testid="brand-link-label"
              onInput={(e) => set(i, { label: (e.target as HTMLInputElement).value })}
            />
            <input
              class="text-input bf-link-url"
              aria-label={t('admin.brand.links.url')}
              placeholder="https://"
              inputMode="url"
              maxLength={600}
              value={l.url}
              aria-invalid={urlErr ? true : undefined}
              data-testid="brand-link-url"
              onInput={(e) => set(i, { url: (e.target as HTMLInputElement).value })}
            />
            <button type="button" class="small" onClick={() => onChange(links.filter((_, j) => j !== i))}>
              {t('admin.brand.links.remove')}
            </button>
            {r?.ok && (
              <span class="muted small bf-link-msg" data-testid="brand-link-host">
                {t('admin.brand.links.goesTo', { host: r.platform !== 'link' && r.platform !== 'mail' ? `${PLATFORM_NAMES[r.platform]} (${r.display})` : r.display })}
                {added ? ` · ${r.kind === 'mailto' ? t('admin.brand.links.prefixedMail') : t('admin.brand.links.prefixed')}` : ''}
              </span>
            )}
            {labelErr && (
              <span class="small danger-text bf-link-msg" data-testid="brand-link-label-error">
                {t(labelErr.key, labelErr.params)}
              </span>
            )}
            {urlErr && (
              <span class="small danger-text bf-link-msg" data-testid="brand-link-error">
                {t(urlErr.key, urlErr.params)}
              </span>
            )}
          </div>
        );
      })}
      {links.length < BRAND_MAX_LINKS && (
        <button type="button" class="small" data-testid="brand-link-add" onClick={() => onChange([...links, { label: '', url: '' }])}>
          {t('admin.brand.links.add')}
        </button>
      )}
    </div>
  );
}
