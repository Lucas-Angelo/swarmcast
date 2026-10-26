// Finds and highlights the real panel areas for the "During the live" tour step.
// Areas are located by their (translated) card titles, so the lookup survives cards being
// added or reordered. Returns null when an area is not on screen (e.g. SwarmCast is off).
import { t, type MessageKey } from '@swarmcast/shared/i18n';

export const AREAS = ['top', 'link', 'p2p', 'quality', 'mode', 'security', 'viewers', 'activity'] as const;
export type AreaId = (typeof AREAS)[number];

const TITLE_KEYS: Partial<Record<AreaId, MessageKey>> = {
  link: 'admin.link.title',
  p2p: 'admin.p2p.title',
  mode: 'admin.mode.title',
  viewers: 'admin.viewers.title',
  activity: 'admin.log.title',
  security: 'admin.sec.title',
};

const SPOT = 'onb-spot';

function panelCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('section.card, div.card')].filter((el) => !el.closest('.onb-bg'));
}

/** First text of a card's <h2> (the title, without the tooltip text that follows it). */
function cardTitle(card: HTMLElement): string {
  const h2 = card.querySelector('h2');
  if (!h2) return '';
  for (const n of h2.childNodes) {
    const text = n.textContent?.trim();
    if (text) return text;
  }
  return '';
}

export function findArea(id: AreaId): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (id === 'top') return document.querySelector<HTMLElement>('header.top');
  if (id === 'security') {
    const el = document.querySelector<HTMLElement>('[data-testid="security"]');
    if (el) return el;
  }
  if (id === 'activity') {
    const el = document.querySelector<HTMLElement>('[data-testid="activity"]');
    if (el) return el;
  }
  const cards = panelCards();
  if (id === 'quality') {
    return document.querySelector<HTMLElement>('[data-testid="quality-card"]') ?? cards.find((c) => /^(quality|qualidade)/i.test(cardTitle(c))) ?? null;
  }
  const key = TITLE_KEYS[id];
  if (!key) return null;
  const title = t(key);
  return cards.find((c) => cardTitle(c) === title) ?? null;
}

export function clearSpot(): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll(`.${SPOT}`).forEach((el) => el.classList.remove(SPOT));
}

/** Outline the area and scroll it into view; false when it is not on the page. */
export function spotlight(id: AreaId): boolean {
  clearSpot();
  const el = findArea(id);
  if (!el) return false;
  el.classList.add(SPOT);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  return true;
}
