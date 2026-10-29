import { useEffect, useRef } from 'preact/hooks';
import { t } from '@swarmcast/shared/i18n';
import { Info } from '../Info.js';
import { buildBrCode, parsePixKey, PIX_CITY_MAX, PIX_NAME_MAX, toPixAscii } from './pix.js';
import { drawQr, encodeQr } from './qr.js';
import type { SupportConfig } from './types.js';
import type { FieldErrors } from './validate.js';

/**
 * Pix for the support button (BR6). The privacy warning is always shown: a Pix confirmation
 * shows the receiver's legal name, part of the CPF and the bank to every payer, whatever the
 * key. A CPF or phone key needs a second, explicit confirmation.
 */
export function PixField({
  support,
  errors,
  confirmed,
  onConfirm,
  onChange,
}: {
  support: SupportConfig;
  errors: FieldErrors;
  confirmed: boolean;
  onConfirm: (ok: boolean) => void;
  onChange: (patch: Partial<SupportConfig>) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = parsePixKey(support.pixKey ?? '');
  const name = toPixAscii(support.pixName ?? '', PIX_NAME_MAX);
  const city = toPixAscii(support.pixCity ?? '', PIX_CITY_MAX);
  let code: string | null = null;
  if (key.ok && name && city) {
    try {
      code = buildBrCode({ key: key.key, name, city });
    } catch {
      code = null;
    }
  }
  useEffect(() => {
    if (canvas.current && code) drawQr(canvas.current, encodeQr(code), 3);
  }, [code]);
  const keyErr = support.pixKey?.trim() ? errors['support.pixKey'] : undefined;
  return (
    <div class="bf-pix" data-testid="brand-pix">
      <div class="warn small" data-testid="brand-pix-warning">
        {t('admin.brand.pix.warning')}
      </div>
      <p class="small muted">{t('admin.brand.pix.recommend')}</p>
      <label class="field">
        <span class="label-w">
          {t('admin.brand.pix.key')} <Info text={t('admin.brand.pix.key.tip')} />
        </span>
        <input
          class="text-input bf-wide"
          data-testid="brand-pix-key"
          maxLength={100}
          autoComplete="off"
          value={support.pixKey ?? ''}
          aria-invalid={keyErr ? true : undefined}
          onInput={(e) => {
            onConfirm(false);
            onChange({ pixKey: (e.target as HTMLInputElement).value });
          }}
        />
      </label>
      {key.ok && (
        <p class="small" data-testid="brand-pix-type">
          {t('admin.brand.pix.detected', { typeKey: `admin.brand.pix.type.${key.type}` })}
        </p>
      )}
      {keyErr && <p class="small danger-text">{t(keyErr.key, keyErr.params)}</p>}
      {key.ok && key.needsConfirm && (
        <div class="warn small">
          <p>{t('admin.brand.pix.confirm.why')}</p>
          <label>
            <input type="checkbox" data-testid="brand-pix-confirm" checked={confirmed} onChange={(e) => onConfirm((e.target as HTMLInputElement).checked)} />
            {t('admin.brand.pix.confirm', { typeKey: `admin.brand.pix.type.${key.type}` })}
          </label>
        </div>
      )}
      <div class="bf-two">
        <label class="field">
          <span class="label-w">
            {t('admin.brand.pix.name')} <Info text={t('admin.brand.pix.name.tip')} />
          </span>
          <input class="text-input bf-wide" data-testid="brand-pix-name" maxLength={60} value={support.pixName ?? ''} onInput={(e) => onChange({ pixName: (e.target as HTMLInputElement).value })} />
          {name && name !== (support.pixName ?? '').trim() && <span class="small muted">{t('admin.brand.pix.inCode', { text: name })}</span>}
        </label>
        <label class="field">
          <span class="label-w">
            {t('admin.brand.pix.city')} <Info text={t('admin.brand.pix.city.tip')} />
          </span>
          <input class="text-input bf-wide" data-testid="brand-pix-city" maxLength={40} value={support.pixCity ?? ''} onInput={(e) => onChange({ pixCity: (e.target as HTMLInputElement).value })} />
          {city && city !== (support.pixCity ?? '').trim() && <span class="small muted">{t('admin.brand.pix.inCode', { text: city })}</span>}
        </label>
      </div>
      {key.ok && !code && <p class="small muted">{t('admin.brand.pix.needNameCity')}</p>}
      {code && (
        <div class="bf-pix-out">
          <canvas ref={canvas} class="bf-qr" data-testid="brand-pix-qr" role="img" aria-label="QR code" />
          <code class="bf-pix-code small" data-testid="brand-pix-code">
            {code}
          </code>
        </div>
      )}
    </div>
  );
}
