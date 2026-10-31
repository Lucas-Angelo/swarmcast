import { useLayoutEffect, useRef } from 'preact/hooks';
import { buildPixPayload, drawQr, normalizePixKey, PIX_CITY_MAX, PIX_NAME_MAX, PIX_PERSONAL_TYPES, pixAscii, qrMatrix, type PixKeyType } from '@swarmcast/shared/branding';
import { t } from '@swarmcast/shared/i18n';
import { Info } from '../Info.js';
import type { PixDraft } from './types.js';
import type { FieldErrors } from './validate.js';

/** Key types, the safest first (a random key shows no personal number). */
const TYPES: PixKeyType[] = ['evp', 'email', 'phone', 'cpf', 'cnpj'];

/**
 * Pix for the support button (BR6: key, "copia e cola" and QR code). The privacy warning is
 * always shown: a Pix confirmation shows the receiver's legal name and part of the CPF to every
 * payer, whatever the key. A CPF or phone key needs a second, explicit confirmation.
 */
export function PixField({ pix, errors, confirmed, onConfirm, onChange }: { pix: PixDraft; errors: FieldErrors; confirmed: boolean; onConfirm: (ok: boolean) => void; onChange: (pix: PixDraft) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = normalizePixKey(pix.type, pix.key);
  const payload = key.ok ? buildPixPayload({ key: key.key, name: pix.name, city: pix.city }) : null;
  const code = payload?.ok ? payload.payload : null;
  // Drawn before the browser paints: never a blank canvas, or the previous code's QR, for a frame.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !code) return;
    const m = qrMatrix(code);
    c.width = c.height = (m.length + 8) * 3;
    const ctx = c.getContext('2d');
    if (ctx) drawQr(ctx, m, 3);
  }, [code]);
  const set = (p: Partial<PixDraft>): void => onChange({ ...pix, ...p });
  const keyErr = pix.key.trim() ? errors['support.pixKey'] : undefined;
  const name = pixAscii(pix.name, PIX_NAME_MAX);
  const city = pixAscii(pix.city, PIX_CITY_MAX);
  const personal = PIX_PERSONAL_TYPES.includes(pix.type);
  return (
    <div class="bf-pix" data-testid="brand-pix">
      <div class="warn small" data-testid="brand-pix-warning">
        {t('pix.warning')}
      </div>
      <p class="small muted">{t('admin.brand.pix.recommend')}</p>
      <div class="bf-two">
        <label class="field">
          <span class="label-w">{t('admin.brand.pix.type')}</span>
          <select
            class="lang-select"
            data-testid="brand-pix-type"
            value={pix.type}
            onChange={(e) => {
              onConfirm(false);
              set({ type: (e.target as HTMLSelectElement).value as PixKeyType });
            }}
          >
            {TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`admin.brand.pix.type.${ty}`)}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="label-w">
            {t('admin.brand.pix.key')} <Info text={t('admin.brand.pix.key.tip')} />
          </span>
          <input
            class="text-input bf-wide"
            data-testid="brand-pix-key"
            maxLength={100}
            autoComplete="off"
            value={pix.key}
            aria-invalid={keyErr ? true : undefined}
            onInput={(e) => {
              onConfirm(false);
              set({ key: (e.target as HTMLInputElement).value });
            }}
          />
          {keyErr && <span class="small danger-text">{t(keyErr.key, keyErr.params)}</span>}
        </label>
      </div>
      {key.ok && personal && (
        <div class="warn small">
          <p>{t('pix.personal')}</p>
          <label>
            <input type="checkbox" data-testid="brand-pix-confirm" checked={confirmed} onChange={(e) => onConfirm((e.target as HTMLInputElement).checked)} />
            {t('admin.brand.pix.confirm', { typeKey: `admin.brand.pix.type.${pix.type}` })}
          </label>
        </div>
      )}
      <div class="bf-two">
        <label class="field">
          <span class="label-w">
            {t('admin.brand.pix.name')} <Info text={t('admin.brand.pix.name.tip')} />
          </span>
          <input class="text-input bf-wide" data-testid="brand-pix-name" maxLength={100} value={pix.name} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
          {name && name !== pix.name.trim() && <span class="small muted">{t('admin.brand.pix.inCode', { text: name })}</span>}
        </label>
        <label class="field">
          <span class="label-w">
            {t('admin.brand.pix.city')} <Info text={t('admin.brand.pix.city.tip')} />
          </span>
          <input class="text-input bf-wide" data-testid="brand-pix-city" maxLength={100} value={pix.city} onInput={(e) => set({ city: (e.target as HTMLInputElement).value })} />
          {city && city !== pix.city.trim() && <span class="small muted">{t('admin.brand.pix.inCode', { text: city })}</span>}
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
