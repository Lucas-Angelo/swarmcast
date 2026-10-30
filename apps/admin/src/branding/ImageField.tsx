import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '@swarmcast/shared/i18n';
import { Info } from '../Info.js';
import { BRAND_SLOTS, type BrandSlot } from '@swarmcast/shared/branding';
import { cropRect, encodeVariant, FIELD_ASPECT, FIELD_SLOTS, ImageError, pickImage, type Crop, type FieldId, type Picked } from './image.js';
import { safeImageSrc } from './public.js';

const LABEL = { avatar: 'admin.brand.avatar', banner: 'admin.brand.banner', card: 'admin.brand.card' } as const;
const TIP = { avatar: 'admin.brand.avatar.tip', banner: 'admin.brand.banner.tip', card: 'admin.brand.card.tip' } as const;

export interface ImageFieldProps {
  field: FieldId;
  /** What the preview shows now (server file URL or a local object URL). */
  current?: string;
  /** Store the rendered variants (master first). Resolves false when the server could not keep them. */
  onSave: (variants: Array<{ slot: BrandSlot; blob: Blob }>) => Promise<boolean>;
  onRemove: () => Promise<void>;
  disabled?: boolean;
}

/**
 * Picture field with crop and canvas re-encode (plan branding-0.4.0 §3.1, stage 1). The picked
 * file is checked before decoding, drawn into a crop frame of the slot's shape, then every
 * variant is encoded on a canvas, so only freshly encoded pixels leave the panel.
 */
export function ImageField({ field, current, onSave, onRemove, disabled }: ImageFieldProps) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [crop, setCrop] = useState<Crop>({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [err, setErr] = useState<ImageError | null>(null);
  const [working, setWorking] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const aspect = FIELD_ASPECT[field];
  const master = BRAND_SLOTS[FIELD_SLOTS[field][0]!];

  // Live crop preview on a canvas (no object URL needed for the picked file).
  useEffect(() => {
    const c = canvas.current;
    if (!c || !picked) return;
    const w = Math.min(360, master.w);
    c.width = w;
    c.height = Math.round(w / aspect);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const r = cropRect(picked.w, picked.h, aspect, crop);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(picked.bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
  }, [picked, crop]);

  // The decoded picture is released when the field closes.
  useEffect(() => () => picked?.bitmap.close(), [picked]);

  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setErr(null);
    setNotSaved(false);
    try {
      setPicked(await pickImage(file));
      setCrop({ zoom: 1, cx: 0.5, cy: 0.5 });
    } catch (e) {
      setErr(e instanceof ImageError ? e : new ImageError('admin.brand.img.err.decode'));
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  const use = async (): Promise<void> => {
    if (!picked) return;
    setWorking(true);
    setErr(null);
    try {
      const variants: Array<{ slot: BrandSlot; blob: Blob }> = [];
      for (const slot of FIELD_SLOTS[field]) variants.push({ slot, blob: await encodeVariant(picked, aspect, crop, BRAND_SLOTS[slot]) });
      const kept = await onSave(variants);
      setNotSaved(!kept);
      setPicked(null);
    } catch (e) {
      setErr(e instanceof ImageError ? e : new ImageError('admin.brand.img.err.encode'));
    } finally {
      setWorking(false);
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: crop.cx, cy: crop.cy };
  };
  const onPointerMove = (e: PointerEvent): void => {
    const d = drag.current;
    const c = canvas.current;
    if (!d || !c || !picked) return;
    const r = cropRect(picked.w, picked.h, aspect, crop);
    // One canvas pixel is (r.sw / c.clientWidth) picture pixels; dragging right shows more of the left.
    const scale = r.sw / Math.max(1, c.clientWidth);
    setCrop({ ...crop, cx: Math.min(1, Math.max(0, d.cx - ((e.clientX - d.x) * scale) / picked.w)), cy: Math.min(1, Math.max(0, d.cy - ((e.clientY - d.y) * scale) / picked.h)) });
  };

  const shown = safeImageSrc(current);
  return (
    <div class="field bf-image" data-testid={`brand-image-${field}`}>
      <span class="label-w">
        {t(LABEL[field])} <Info text={t(TIP[field])} />
      </span>
      {!picked && (
        <div class="row">
          {shown ? <img class={`bf-thumb bf-thumb-${field}`} src={shown} alt="" data-testid={`brand-thumb-${field}`} /> : null}
          <label class={`button small ${disabled ? 'disabled' : ''}`}>
            {shown ? t('admin.brand.img.change') : t('admin.brand.img.pick')}
            <input
              ref={input}
              class="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif"
              disabled={disabled}
              data-testid={`brand-file-${field}`}
              onChange={(e) => void choose((e.target as HTMLInputElement).files?.[0])}
            />
          </label>
          {shown && (
            <button type="button" class="small" disabled={disabled} onClick={() => void onRemove()}>
              {t('admin.brand.img.remove')}
            </button>
          )}
        </div>
      )}
      {picked && (
        <div class="bf-crop">
          <canvas
            ref={canvas}
            class={`bf-crop-canvas bf-crop-${field}`}
            data-testid={`brand-crop-${field}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          />
          <p class="muted small">{t('admin.brand.img.drag')}</p>
          {picked.animated && <p class="muted small">{t('admin.brand.img.animated')}</p>}
          <label class="row tight small">
            {t('admin.brand.img.zoom')}
            <input type="range" min={1} max={4} step={0.05} value={crop.zoom} onInput={(e) => setCrop({ ...crop, zoom: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <div class="row tight">
            <button type="button" class="primary small" disabled={working} data-testid={`brand-use-${field}`} onClick={() => void use()}>
              {working ? t('admin.brand.img.working') : t('admin.brand.img.use')}
            </button>
            <button type="button" class="small" disabled={working} onClick={() => setPicked(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {err && (
        <div class="err small" data-testid={`brand-image-error-${field}`}>
          {t(err.key, err.params)}
        </div>
      )}
      {notSaved && <p class="muted small">{t('admin.brand.img.notSaved')}</p>}
      <p class="muted small">{t('admin.brand.img.privacy')}</p>
    </div>
  );
}
