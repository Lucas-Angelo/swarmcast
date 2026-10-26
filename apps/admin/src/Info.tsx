import { useId } from 'preact/hooks';
import { t } from '@swarmcast/shared/i18n';

/**
 * Small accessible tooltip: an (i) button next to a value or setting. Shows the text on hover,
 * keyboard focus and tap (touch screens); behavior lives in installTooltips() (event delegation).
 */
export function Info({ text }: { text: string }) {
  const id = useId();
  return (
    <span class="tip">
      <button type="button" class="tip-btn" aria-label={t('tip.more')} aria-describedby={id}>
        i
      </button>
      <span class="tip-bubble" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  );
}
