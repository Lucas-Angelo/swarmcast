import { useEffect, useRef, useState } from 'preact/hooks';
import { countGraphemes, type MessageKey } from '@swarmcast/shared';
import { t } from '@swarmcast/shared/i18n';
import { errorText } from '../api.js';
import { Info } from '../Info.js';
import { brandingApi, NotAvailableError } from './api.js';
import type { FieldId, SlotId } from './image.js';
import { ImageField } from './ImageField.js';
import { LinksEditor } from './LinksEditor.js';
import { PixField } from './PixField.js';
import { Preview } from './Preview.js';
import { ThemePicker } from './ThemePicker.js';
import { BRAND_LIMITS, defaultBranding, textOf, type BrandingResponse, type BrandingText, type SupportConfig, type SupportLabel } from './types.js';
import { checkNewTag, cleanDraft, countLines, validateDraft, type FieldError } from './validate.js';
import './branding.css';

type Section = 'identity' | 'about' | 'links' | 'colours' | 'share';
const SECTIONS: Section[] = ['identity', 'about', 'links', 'colours', 'share'];
const SUPPORT_LABELS: SupportLabel[] = ['support', 'tip', 'donate', 'pix'];
const MASTER: Record<FieldId, SlotId> = { avatar: 'avatar', banner: 'banner', card: 'card' };

const same = (a: BrandingText, b: BrandingText): boolean => JSON.stringify(a) === JSON.stringify(b);

function Counter({ value, max }: { value: string | undefined; max: number }) {
  const n = countGraphemes(value ?? '');
  return <span class={`small ${n > max ? 'danger-text' : 'muted'}`}>{t('admin.brand.counter', { count: n, max })}</span>;
}

function ErrorText({ e, testid }: { e?: FieldError; testid?: string }) {
  return e ? (
    <span class="small danger-text bf-msg" data-testid={testid}>
      {t(e.key, e.params)}
    </span>
  ) : null;
}

/**
 * The panel's "Your page" card (plan branding-0.4.0 §2.7): five sections, a live preview, one
 * explicit Save. Pictures are stored as soon as they are cropped (each is its own upload);
 * texts, links, colours and switches wait for Save.
 */
export function BrandingCard() {
  const [available, setAvailable] = useState(true);
  const [saved, setSaved] = useState<BrandingText>(() => textOf(defaultBranding()));
  const [draft, setDraft] = useState<BrandingText>(() => textOf(defaultBranding()));
  const [images, setImages] = useState<BrandingResponse['images']>({});
  const [local, setLocal] = useState<Partial<Record<FieldId, string>>>({});
  const [open, setOpen] = useState<Section>('identity');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pixConfirmed, setPixConfirmed] = useState(false);
  const [tagText, setTagText] = useState('');
  const [tagErr, setTagErr] = useState<FieldError | null>(null);
  const localRef = useRef(local);
  localRef.current = local;

  const apply = (r: BrandingResponse, keepDraft = false): void => {
    const text = textOf({ ...defaultBranding(), ...r.branding });
    setSaved(text);
    if (!keepDraft) {
      setDraft(text);
      setPixConfirmed(Boolean(text.support?.pixKey));
    }
    setImages(r.images ?? {});
  };

  useEffect(() => {
    brandingApi.load().then(
      (r) => apply(r),
      (e: unknown) => {
        if (e instanceof NotAvailableError) setAvailable(false);
        else setErr(e);
      },
    );
  }, []);
  // Object URLs made for the preview are released when the card goes away.
  useEffect(() => () => Object.values(localRef.current).forEach((u) => u && URL.revokeObjectURL(u)), []);

  const errors = validateDraft(draft, { pixConfirmed });
  const hasErrors = Object.keys(errors).length > 0;
  const dirty = !same(cleanDraft(draft), saved);
  const patch = (p: Partial<BrandingText>): void => {
    setJustSaved(false);
    setDraft((d) => ({ ...d, ...p }));
  };
  const patchSupport = (p: Partial<SupportConfig>): void => patch({ support: { label: 'support', mode: 'link', ...draft.support, ...p } });

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      apply(await brandingApi.save(cleanDraft(draft)));
      setJustSaved(true);
    });

  const setLocalUrl = (field: FieldId, blob: Blob | null): void => {
    setLocal((prev) => {
      if (prev[field]) URL.revokeObjectURL(prev[field]!);
      const next = { ...prev };
      if (blob) next[field] = URL.createObjectURL(blob);
      else delete next[field];
      return next;
    });
  };

  const saveImage =
    (field: FieldId) =>
    async (variants: Array<{ slot: SlotId; blob: Blob }>): Promise<boolean> => {
      setLocalUrl(field, variants[0]!.blob);
      if (!available) return false;
      try {
        let last: BrandingResponse | null = null;
        for (const v of variants) last = await brandingApi.upload(v.slot, v.blob);
        if (last) apply(last, true);
        setLocalUrl(field, null);
        return true;
      } catch (e) {
        setErr(e);
        return false;
      }
    };

  const removeImage = (field: FieldId) => async (): Promise<void> => {
    setLocalUrl(field, null);
    if (!available) return;
    await run(async () => apply(await brandingApi.remove(MASTER[field]), true));
  };

  const reset = (): Promise<void> =>
    run(async () => {
      setConfirmReset(false);
      (['avatar', 'banner', 'card'] as FieldId[]).forEach((f) => setLocalUrl(f, null));
      if (available) apply(await brandingApi.reset());
      else {
        const d = textOf(defaultBranding());
        setSaved(d);
        setDraft(d);
      }
    });

  const addTag = (): void => {
    const e = checkNewTag(tagText, draft.tags);
    setTagErr(e);
    if (e) return;
    patch({ tags: [...draft.tags, tagText.trim()] });
    setTagText('');
  };

  const img = (field: FieldId): string | undefined => local[field] ?? images[MASTER[field]];
  const supportMode = draft.support?.mode ?? 'none';

  const sectionBody = (s: Section) => {
    switch (s) {
      case 'identity':
        return (
          <>
            <label class="field">
              <span class="label-w">
                {t('admin.brand.name')} <Info text={t('admin.brand.name.tip')} /> <Counter value={draft.name} max={BRAND_LIMITS.name} />
              </span>
              <input class="text-input bf-wide" data-testid="brand-name" maxLength={400} value={draft.name ?? ''} onInput={(e) => patch({ name: (e.target as HTMLInputElement).value })} />
              <ErrorText e={errors.name} />
            </label>
            <ImageField field="avatar" current={img('avatar')} onSave={saveImage('avatar')} onRemove={removeImage('avatar')} disabled={busy} />
            <ImageField field="banner" current={img('banner')} onSave={saveImage('banner')} onRemove={removeImage('banner')} disabled={busy} />
          </>
        );
      case 'about':
        return (
          <>
            <label class="field">
              <span class="label-w">
                {t('admin.brand.tagline')} <Info text={t('admin.brand.tagline.tip')} /> <Counter value={draft.tagline} max={BRAND_LIMITS.tagline} />
              </span>
              <input class="text-input bf-wide" data-testid="brand-tagline" maxLength={1000} value={draft.tagline ?? ''} onInput={(e) => patch({ tagline: (e.target as HTMLInputElement).value })} />
              <ErrorText e={errors.tagline} />
            </label>
            <label class="field">
              <span class="label-w">
                {t('admin.brand.about')} <Info text={t('admin.brand.about.tip')} /> <Counter value={draft.about} max={BRAND_LIMITS.about} />
                <span class="small muted">{t('admin.brand.about.lines', { count: countLines(draft.about ?? ''), max: BRAND_LIMITS.aboutLines })}</span>
              </span>
              <textarea class="text-input bf-wide bf-textarea" data-testid="brand-about" rows={5} maxLength={8000} value={draft.about ?? ''} onInput={(e) => patch({ about: (e.target as HTMLTextAreaElement).value })} />
              <ErrorText e={errors.about} />
            </label>
            <div class="field">
              <span class="label-w">
                {t('admin.brand.tags')} <Info text={t('admin.brand.tags.tip')} /> <span class="small muted">{t('admin.brand.counter', { count: draft.tags.length, max: BRAND_LIMITS.tags })}</span>
              </span>
              <ul class="bf-tags" data-testid="brand-tags">
                {draft.tags.map((tag) => (
                  <li key={tag}>
                    <bdi>{tag}</bdi>
                    <button type="button" class="bf-tag-x" aria-label={t('admin.brand.tags.remove', { tag })} onClick={() => patch({ tags: draft.tags.filter((x) => x !== tag) })}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <div class="row tight">
                <input
                  class="text-input"
                  data-testid="brand-tag-input"
                  placeholder={t('admin.brand.tags.placeholder')}
                  maxLength={100}
                  value={tagText}
                  onInput={(e) => setTagText((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                <button type="button" class="small" disabled={!tagText.trim()} onClick={addTag}>
                  {t('admin.brand.tags.add')}
                </button>
              </div>
              <ErrorText e={tagErr ?? errors.tags} />
            </div>
          </>
        );
      case 'links':
        return (
          <>
            <LinksEditor links={draft.links} errors={errors} onChange={(links) => patch({ links })} />
            <div class="field" data-testid="brand-support">
              <span class="label-w">
                {t('admin.brand.support')} <Info text={t('admin.brand.support.tip')} />
              </span>
              <div class="row tight" role="radiogroup" aria-label={t('admin.brand.support')}>
                {(['none', 'link', 'pix'] as const).map((m) => (
                  <label key={m} class="small">
                    <input
                      type="radio"
                      name="brand-support"
                      data-testid={`brand-support-${m}`}
                      checked={supportMode === m}
                      onChange={() => {
                        if (m === 'none') patch({ support: undefined });
                        else patchSupport({ mode: m, label: m === 'pix' && !draft.support ? 'pix' : (draft.support?.label ?? 'support') });
                      }}
                    />
                    {t(`admin.brand.support.${m}`)}
                  </label>
                ))}
              </div>
              {draft.support && (
                <label class="row tight small">
                  {t('admin.brand.support.text')}
                  <select class="lang-select" data-testid="brand-support-label" value={draft.support.label} onChange={(e) => patchSupport({ label: (e.target as HTMLSelectElement).value as SupportLabel })}>
                    {SUPPORT_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {t(`admin.brand.pv.support.${l}`)}
                      </option>
                    ))}
                  </select>
                  <Info text={t('admin.brand.support.text.tip')} />
                </label>
              )}
              {draft.support?.mode === 'link' && (
                <label class="field">
                  <span class="label-w">
                    {t('admin.brand.support.url')} <Info text={t('admin.brand.support.url.tip')} />
                  </span>
                  <input class="text-input bf-wide" data-testid="brand-support-url" placeholder="https://" inputMode="url" maxLength={600} value={draft.support.url ?? ''} onInput={(e) => patchSupport({ url: (e.target as HTMLInputElement).value })} />
                  {draft.support.url?.trim() ? <ErrorText e={errors['support.url']} /> : null}
                </label>
              )}
              {draft.support?.mode === 'pix' && <PixField support={draft.support} errors={errors} confirmed={pixConfirmed} onConfirm={setPixConfirmed} onChange={patchSupport} />}
            </div>
          </>
        );
      case 'colours':
        return <ThemePicker theme={draft.theme} error={errors['theme.accent'] ? t(errors['theme.accent'].key) : undefined} onChange={(theme) => patch({ theme })} />;
      case 'share':
        return (
          <>
            <label class="field">
              <span class="label-w">
                {t('admin.brand.ended')} <Info text={t('admin.brand.ended.tip')} /> <Counter value={draft.endedMessage} max={BRAND_LIMITS.ended} />
              </span>
              <input class="text-input bf-wide" data-testid="brand-ended" maxLength={1000} value={draft.endedMessage ?? ''} onInput={(e) => patch({ endedMessage: (e.target as HTMLInputElement).value })} />
              <ErrorText e={errors.ended} />
            </label>
            <div class="field">
              <label>
                <input type="checkbox" data-testid="brand-preview-card" checked={draft.preview.enabled} onChange={(e) => patch({ preview: { enabled: (e.target as HTMLInputElement).checked } })} />
                {t('admin.brand.preview.switch')}
              </label>{' '}
              <Info text={t('admin.brand.preview.tip')} />
              <p class="small muted">{t('admin.brand.preview.tip')}</p>
            </div>
            {draft.preview.enabled && <ImageField field="card" current={img('card')} onSave={saveImage('card')} onRemove={removeImage('card')} disabled={busy} />}
            <div class="field">
              <label>
                <input type="checkbox" data-testid="brand-credit" checked={draft.showCredit} onChange={(e) => patch({ showCredit: (e.target as HTMLInputElement).checked })} />
                {t('admin.brand.credit')}
              </label>{' '}
              <Info text={t('admin.brand.credit.tip')} />
            </div>
          </>
        );
    }
  };

  const sectionHasError = (s: Section): boolean => {
    const keys = Object.keys(errors);
    const prefix: Record<Section, string[]> = {
      identity: ['name'],
      about: ['tagline', 'about', 'tags'],
      links: ['links.', 'support.'],
      colours: ['theme.'],
      share: ['ended'],
    };
    return keys.some((k) => prefix[s].some((p) => k.startsWith(p)));
  };

  return (
    <section class="card mt brand-card" data-testid="brand-card">
      <div class="brand-head">
        <h2 class="row-title">
          {t('admin.brand.title')} <Info text={t('admin.brand.tip')} />
        </h2>
        <label class="bf-switch" title={t('admin.brand.switch.tip')}>
          <input type="checkbox" role="switch" data-testid="brand-enabled" checked={draft.enabled} onChange={(e) => patch({ enabled: (e.target as HTMLInputElement).checked })} />
          <span>{draft.enabled ? t('admin.brand.switch.on') : t('admin.brand.switch.off')}</span>
        </label>
        <Info text={t('admin.brand.switch.tip')} />
      </div>
      {!available && (
        <p class="small muted" data-testid="brand-unavailable">
          {t('admin.brand.unavailable')}
        </p>
      )}
      {!draft.enabled && <p class="small muted">{t('admin.brand.offNote')}</p>}
      {err !== null && (
        <div class="err small" data-testid="brand-error">
          {errorText(err)}
        </div>
      )}
      <div class="brand-body">
        <div class="brand-preview-col">
          <h3 class="small strong">
            {t('admin.brand.preview')} <Info text={t('admin.brand.preview.note')} />
          </h3>
          <Preview draft={draft} images={{ avatar: img('avatar'), banner: img('banner') }} />
        </div>
        <div class="brand-form-col">
          {SECTIONS.map((s, i) => (
            <div class={`bf-section ${open === s ? 'open' : ''}`} key={s}>
              <button type="button" class="bf-section-head" aria-expanded={open === s} data-testid={`brand-section-${s}`} onClick={() => setOpen(open === s ? ('' as Section) : s)}>
                <span class="bf-step">{i + 1}</span>
                {t(`admin.brand.section.${s}` as MessageKey)}
                {sectionHasError(s) && <span class="bf-dot-err" aria-hidden="true" />}
              </button>
              {open === s && <div class="bf-section-body">{sectionBody(s)}</div>}
            </div>
          ))}
          <div class="row bf-actions">
            <button type="button" class="primary" data-testid="brand-save" title={t('admin.brand.save.tip')} disabled={!dirty || hasErrors || busy || !available} onClick={() => void save()}>
              {busy ? t('admin.brand.saving') : t('admin.brand.save')}
            </button>
            {justSaved && !dirty && (
              <span class="small ok" data-testid="brand-saved">
                {t('admin.brand.saved')}
              </span>
            )}
            {dirty && !hasErrors && <span class="small muted">{t('admin.brand.unsaved')}</span>}
            {dirty && hasErrors && <span class="small danger-text">{t('admin.brand.err.fix')}</span>}
            <span class="spacer" />
            {confirmReset ? (
              <span class="row tight">
                <span class="small">{t('admin.brand.reset.confirm')}</span>
                <button type="button" class="small danger" data-testid="brand-reset-yes" onClick={() => void reset()}>
                  {t('admin.brand.reset.yes')}
                </button>
                <button type="button" class="small" onClick={() => setConfirmReset(false)}>
                  {t('common.cancel')}
                </button>
              </span>
            ) : (
              <button type="button" class="small" data-testid="brand-reset" title={t('admin.brand.reset.tip')} onClick={() => setConfirmReset(true)}>
                {t('admin.brand.reset')}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
