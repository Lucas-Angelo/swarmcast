// Browser-only helpers: language detection, DOM translation and accessible tooltips.
// Works under a strict CSP (no inline scripts or style attributes): positions are set via CSSOM.
import { isMessageKey, resolveLang, setLang, t, toLang, type Lang } from './index.js';

const STORAGE_KEY = 'swarmcast.lang';

/**
 * Pick the UI language: `?lang=en|pt-BR` (remembered), else the remembered choice,
 * else the first browser language starting with "pt" → pt-BR, otherwise English.
 */
export function initBrowserLang(): Lang {
  let override: string | null = null;
  try {
    override = toLang(new URLSearchParams(location.search).get('lang'));
  } catch {
    /* no location */
  }
  if (override) {
    rememberLang(override as Lang);
  } else {
    try {
      override = toLang(localStorage.getItem(STORAGE_KEY));
    } catch {
      /* storage blocked */
    }
  }
  const langs = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']) : [];
  const lang = resolveLang(langs, override);
  applyLang(lang);
  return lang;
}

/** Switch language now (sets <html lang>). */
export function applyLang(lang: Lang): void {
  setLang(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export function rememberLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage blocked */
  }
}

/**
 * Translate static markup: `data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder`,
 * `data-i18n-aria-label`. Unknown keys leave the original (English) text in place.
 */
export function applyI18n(root: ParentNode = document): void {
  const each = (attr: string, apply: (el: HTMLElement, text: string) => void): void => {
    root.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr);
      if (isMessageKey(key)) apply(el, t(key));
    });
  };
  each('data-i18n', (el, s) => (el.textContent = s));
  each('data-i18n-title', (el, s) => (el.title = s));
  each('data-i18n-placeholder', (el, s) => el.setAttribute('placeholder', s));
  each('data-i18n-aria-label', (el, s) => el.setAttribute('aria-label', s));
}

/** Place a fixed-position bubble below (or above) its anchor, kept inside the viewport. */
export function positionTip(anchor: Element, bubble: HTMLElement): void {
  bubble.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const m = 8;
  const left = Math.max(m, Math.min(r.left + r.width / 2 - b.width / 2, vw - b.width - m));
  let top = r.bottom + 6;
  if (top + b.height > vh - m && r.top - 6 - b.height > m) top = r.top - 6 - b.height;
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

function bubbleOf(el: Element | null): { btn: HTMLElement; bubble: HTMLElement } | null {
  const tip = el?.closest?.('.tip');
  const btn = tip?.querySelector<HTMLElement>('.tip-btn');
  const bubble = tip?.querySelector<HTMLElement>('.tip-bubble');
  return btn && bubble ? { btn, bubble } : null;
}

function closeAll(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.tip-bubble.open').forEach((b) => {
    if (b === except) return;
    b.classList.remove('open');
    delete b.dataset.pinned;
  });
}

let installed = false;

/**
 * Tooltips for markup like
 *   <span class="tip"><button type="button" class="tip-btn" aria-describedby="x">i</button>
 *   <span class="tip-bubble" role="tooltip" id="x">…</span></span>
 * Opens on mouse hover and keyboard focus, toggles on click/tap (touch screens), closes on
 * Escape, outside click, scroll or resize. Uses event delegation, so it works for markup
 * rendered later (e.g. by Preact).
 */
export function installTooltips(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = bubbleOf(e.target as Element);
    if (t && !t.bubble.classList.contains('open')) {
      closeAll(t.bubble);
      positionTip(t.btn, t.bubble);
    }
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = bubbleOf(e.target as Element);
    if (!t || t.bubble.dataset.pinned || document.activeElement === t.btn) return;
    const to = e.relatedTarget as Element | null;
    if (to && t.btn.closest('.tip')?.contains(to)) return;
    t.bubble.classList.remove('open');
  });
  document.addEventListener('focusin', (e) => {
    const target = e.target as Element;
    if (!target.classList?.contains('tip-btn')) return;
    const t = bubbleOf(target);
    if (t) {
      closeAll(t.bubble);
      positionTip(t.btn, t.bubble);
    }
  });
  document.addEventListener('focusout', (e) => {
    const target = e.target as Element;
    if (!target.classList?.contains('tip-btn')) return;
    const t = bubbleOf(target);
    if (t) {
      t.bubble.classList.remove('open');
      delete t.bubble.dataset.pinned;
    }
  });
  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const btn = target.closest?.('.tip-btn');
    if (!btn) {
      if (!target.closest?.('.tip-bubble')) closeAll();
      return;
    }
    e.preventDefault();
    const t = bubbleOf(btn);
    if (!t) return;
    if (t.bubble.dataset.pinned) {
      t.bubble.classList.remove('open');
      delete t.bubble.dataset.pinned;
    } else {
      closeAll(t.bubble);
      positionTip(t.btn, t.bubble);
      t.bubble.dataset.pinned = '1';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
  const reposition = (): void => {
    document.querySelectorAll<HTMLElement>('.tip-bubble.open').forEach((b) => {
      const t = bubbleOf(b);
      if (t) positionTip(t.btn, t.bubble);
    });
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
}
