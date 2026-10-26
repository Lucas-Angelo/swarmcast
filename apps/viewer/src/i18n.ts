// Shared page setup: pick the language, translate the static markup, enable tooltips.
import { applyI18n, initBrowserLang, installTooltips } from '@swarmcast/shared/i18n/browser';

initBrowserLang();
applyI18n();
installTooltips();

export { formatNumber, humanDuration, t, tc, type MessageKey } from '@swarmcast/shared/i18n';
