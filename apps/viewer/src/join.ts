import './style.css';
import './i18n.js';
import { startJoinForm } from './join-form.js';
import { solvePow } from './pow.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** style.css shows the page by itself after this long when the branding script never runs. */
const PAGE_SHOW_FALLBACK_MS = 3000;

/**
 * Settles once the join page is visible and takes clicks: when branding/loader.ts marks
 * body.brand-known (at most JOIN_BRAND_WAIT_MS after load), or after style.css's own fallback.
 */
function pageShown(): Promise<void> {
  return new Promise((resolve) => {
    const known = (): boolean => document.body.classList.contains('brand-known');
    if (known()) return resolve();
    const observer = new MutationObserver(() => {
      if (known()) done();
    });
    const timer = setTimeout(() => done(), PAGE_SHOW_FALLBACK_MS);
    function done(): void {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
}

startJoinForm(
  {
    form: $<HTMLFormElement>('join-form'),
    input: $<HTMLInputElement>('nickname'),
    button: $<HTMLButtonElement>('join'),
    error: $<HTMLParagraphElement>('error'),
    check: $<HTMLParagraphElement>('check'),
    progress: document.getElementById('check-progress') as HTMLProgressElement | null,
  },
  {
    // A wrapper: fetch called as a method of another object throws "Illegal invocation".
    fetch: (input, init) => fetch(input, init),
    solve: solvePow,
    go: (url) => location.replace(url),
    shown: pageShown(),
  },
);
