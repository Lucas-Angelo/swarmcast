import { contrastRatio } from '@swarmcast/shared';
import { BRAND_PRESETS, deriveTheme, THEME_BASE, type BrandCorners, type BrandPreset, type DerivedTheme, type ThemeMode } from '@swarmcast/shared/branding';
import { formatNumber, t } from '@swarmcast/shared/i18n';
import { Info } from '../Info.js';
import { presetSwatch } from './preview-theme.js';
import type { Draft } from './types.js';

const CORNER_LIST: BrandCorners[] = ['round', 'soft', 'square'];

function Sample({ mode, d }: { mode: ThemeMode; d: DerivedTheme }) {
  const a = d[mode];
  const b = THEME_BASE[mode];
  return (
    <div class="bt-sample" style={{ '--bt-bg': b.surface, '--bt-ink': b.ink, '--bt-accent': a.accent, '--bt-on': a.onAccent, '--bt-strong': a.accentStrong }} data-testid={`brand-theme-${mode}`}>
      <span class="bt-sample-title">{mode === 'light' ? t('admin.brand.theme.light') : t('admin.brand.theme.dark')}</span>
      <span class="bt-sample-btn">{t('admin.brand.theme.button')}</span>
      <span class="bt-sample-link">{t('admin.brand.theme.link')}</span>
      <span class="bt-sample-ratio">{formatNumber(Math.round(contrastRatio(a.onAccent, a.accent) * 10) / 10)}:1</span>
    </div>
  );
}

/** Preset swatches, "Custom…" with a native colour input, the colours viewers get in both modes, corners. */
export function ThemePicker({ theme, error, onChange }: { theme: Draft['theme']; error?: string; onChange: (theme: Draft['theme']) => void }) {
  const d = deriveTheme(theme);
  const pick = (preset: BrandPreset): void => onChange({ ...theme, preset, ...(preset === 'custom' && !theme.accent ? { accent: presetSwatch('forest') } : {}) });
  return (
    <div class="field" data-testid="brand-theme">
      <span class="label-w">
        {t('admin.brand.theme')} <Info text={t('admin.brand.theme.tip')} />
      </span>
      <div class="bt-swatches" role="radiogroup" aria-label={t('admin.brand.theme')}>
        {BRAND_PRESETS.map((p) => (
          <button type="button" key={p} role="radio" aria-checked={theme.preset === p} class={`bt-swatch ${theme.preset === p ? 'active' : ''}`} data-testid={`brand-preset-${p}`} onClick={() => pick(p)}>
            <span class="bt-dot" style={{ '--bt-dot': presetSwatch(p, theme.accent) }} aria-hidden="true" />
            {t(`admin.brand.preset.${p}`)}
          </button>
        ))}
      </div>
      {theme.preset === 'custom' && (
        <label class="row tight">
          {t('admin.brand.theme.pick')}
          <input type="color" data-testid="brand-accent" value={/^#[0-9a-f]{6}$/i.test(theme.accent ?? '') ? theme.accent!.toLowerCase() : '#0f5c53'} onInput={(e) => onChange({ ...theme, accent: (e.target as HTMLInputElement).value.toLowerCase() })} />
          <code class="small">{theme.accent ?? ''}</code>
        </label>
      )}
      {error && <div class="small danger-text">{error}</div>}
      <div class="row tight">
        <Sample mode="light" d={d} />
        <Sample mode="dark" d={d} />
        <Info text={t('admin.brand.theme.derived.tip')} />
      </div>
      {d.adjusted && (
        <p class="small muted" data-testid="brand-theme-adjusted">
          {t('admin.brand.theme.adjusted')}
        </p>
      )}
      <div class="row tight" role="radiogroup" aria-label={t('admin.brand.corners')}>
        <span class="small">{t('admin.brand.corners')}</span>
        {CORNER_LIST.map((c) => (
          <label key={c} class="small">
            <input type="radio" name="brand-corners" data-testid={`brand-corners-${c}`} checked={theme.corners === c} onChange={() => onChange({ ...theme, corners: c })} />
            {t(`admin.brand.corners.${c}`)}
          </label>
        ))}
        <Info text={t('admin.brand.corners.tip')} />
      </div>
    </div>
  );
}
