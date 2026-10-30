import { useEffect, useState } from 'preact/hooks';
import { getLang } from '@swarmcast/shared/i18n';
import { chatStore, type ChatView } from './store.js';

/** The chat store's current view, re-rendering on every change. */
export function useChatView(): ChatView {
  const [view, setView] = useState<ChatView>(() => chatStore.view());
  useEffect(() => {
    setView(chatStore.view());
    return chatStore.subscribe(setView);
  }, []);
  return view;
}

function isDark(): boolean {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The panel's theme (name colours are adjusted for the background they are shown on). */
export function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const update = (): void => setDark(isDark());
    mq?.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq?.removeEventListener('change', update);
      mo.disconnect();
    };
  }, []);
  return dark;
}

/** Local clock time ("21:40"). */
export function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
}
