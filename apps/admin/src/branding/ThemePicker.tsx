import { contrastRatio } from '@swarmcast/shared';
import { formatNumber, t } from '@swarmcast/shared/i18n';
import { Info } from '../Info.js';
import { BASE, deriveTheme, normalizeHex, PRESETS, presetSwatch, type Corners, type PresetId, type ThemeName } from './theme.js';
import type { BrandingText } from './types.js';

const CORNER_LIST: Corners[] = ['round', 'soft', 'square'];

function Sample({ theme, d }: { theme: ThemeName; d: ReturnType<typeof deriveTheme> }) {
  const a = d[theme];
  const b = BASE[theme];
  return (
    <div class="bt-sample" style={{ '--bt-bg': b.surface, '--bt-ink': b.ink, '--bt-accent': a.accent, '--bt-on': a.onAccent, '--bt-strong': a.accentStrong }} data-testid={`brand-theme-${theme}`}>
      <span class="bt-sample-title">{theme === 'light' ? t('admin.brand.theme.light') : t('admin.brand.theme.dark')}</span>
      <span class="bt-sample-btn">{t('admin.brand.theme.button')}</span>
      <span class="bt-sample-link">{t('admin.brand.theme.link')}</span>
      <span class="bt-sample-ratio muted small">{formatNumber(Math.round(contrastRatio(a.onAccent, a.accent) * 10) / 10)}:1</span>
    </div>
  );
}

/** Preset swatches, "Custom…" with a native colour input, the colours viewers get in both modes, corners. */
export function ThemePicker({ theme, error, onChange }: { theme: BrandingText['theme']; error?: string; onChange: (theme: BrandingText['theme']) => void }) {
  const d = deriveTheme(theme.preset, theme.accent);
  const pick = (preset: PresetId): void => onChange({ ...theme, preset, ...(preset === 'custom' ? { accent: normalizeHex(theme.accent) ?? presetSwatch('forest') } : {}) });
  return (
    <div class="field" data-testid="brand-theme">
      <span class="label-w">
        {t('admin.brand.theme')} <Info text={t('admin.brand.theme.tip')} />
      </span>
      <div class="bt-swatches" role="radiogroup" aria-label={t('admin.brand.theme')}>
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p}
            role="radio"
            aria-checked={theme.preset === p}
            class={`bt-swatch ${theme.preset === p ? 'active' : ''}`}
            data-testid={`brand-preset-${p}`}
            onClick={() => pick(p)}
          >
            <span class="bt-dot" style={{ '--bt-dot': presetSwatch(p, theme.accent) }} aria-hidden="true" />
            {t(`admin.brand.preset.${p}`)}
          </button>
        ))}
      </div>
      {theme.preset === 'custom' && (
        <label class="row tight">
          {t('admin.brand.theme.pick')}
          <input type="color" data-testid="brand-accent" value={normalizeHex(theme.accent) ?? '#0f5c53'} onInput={(e) => onChange({ ...theme, accent: (e.target as HTMLInputElement).value.toLowerCase() })} />
          <code class="small">{normalizeHex(theme.accent) ?? ''}</code>
        </label>
      )}
      {error && <div class="small danger-text">{error}</div>}
      <div class="row tight">
        <Sample theme="light" d={d} />
        <Sample theme="dark" d={d} />
        <Info text={t('admin.brand.theme.derived.tip')} />
      </div>
      {(d.adjusted.light || d.adjusted.dark) && (
        <p class="small muted" data-testid="brand-theme-adjusted">
          {t('admin.brand.theme.adjusted')}
        </p>
      )}
      <div class="row tight" role="radiogroup" aria-label={t('admin.brand.corners')}>
        <span class="small">{t('admin.brand.corners')}</span>
        {CORNER_LIST.map((c) => (
          <label key={c} class="small">
            <input type="radio" name="brand-corners" checked={theme.corners === c} onChange={() => onChange({ ...theme, corners: c })} />
            {t(`admin.brand.corners.${c}`)}
          </label>
        ))}
        <Info text={t('admin.brand.corners.tip')} />
      </div>
    </div>
  );
}
