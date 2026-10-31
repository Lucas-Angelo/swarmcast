import { useEffect, useRef, useState } from 'preact/hooks';
import type { AdminChatState, AdminState, ChatSettings } from '@swarmcast/shared';
import { chatApi } from '../api.js';
import { useChatView } from './hooks.js';
import { chatStore, type ChatView } from './store.js';

/** Sessions (mutes, colours) and effective settings are refreshed this often while live; messages come over /ws. */
const REFRESH_MS = 10_000;

/** What the live chat column and the Chat settings card share (one load, one refresh timer). */
export interface ChatPanel {
  /** GET /api/chat; null until it answers. */
  chat: AdminChatState | null;
  view: ChatView;
  /** The last failed load or refresh of GET /api/chat (null once it answers). */
  loadErr: unknown;
  /** A chat action is running (the buttons of both cards wait for it). */
  busy: boolean;
  /** Runs a chat action, then refreshes the sessions; resolves to its error (null when it worked) for the card that asked. */
  act: (fn: () => Promise<unknown>) => Promise<unknown>;
  saveSettings: (s: ChatSettings) => Promise<void>;
}

/**
 * The panel's chat state, for both chat cards. Called by App before its first render (the hook
 * order must not change), so it takes the state snapshot or null while the panel connects.
 */
export function useChatPanel(state: AdminState | null): ChatPanel {
  const view = useChatView();
  const [chat, setChat] = useState<AdminChatState | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const phase = state?.phase ?? 'off';
  const live = phase === 'live';
  const viewerKey = state?.viewers.map((v) => v.sessionId).join(',') ?? '';

  const reload = async (full = false): Promise<void> => {
    try {
      setChat(full ? await chatApi.load() : await chatApi.refreshSessions());
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e);
    }
  };
  useEffect(() => void reload(true), []);
  // Someone joined or left: their mute and colour state changes with them.
  useEffect(() => void reload(), [viewerKey, phase]);
  // A message whose author the panel never got (announced before this panel opened): fetch the roster.
  const lastFill = useRef(0);
  useEffect(() => {
    if (!chatStore.missingAuthors || Date.now() - lastFill.current < 5000) return;
    lastFill.current = Date.now();
    void reload(true);
  }, [view.rev]);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(id);
  }, [live]);

  const act = async (fn: () => Promise<unknown>): Promise<unknown> => {
    setBusy(true);
    try {
      await fn();
      await reload();
      return null;
    } catch (e) {
      return e;
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = async (s: ChatSettings): Promise<void> => {
    const r = await chatApi.saveSettings(s);
    setChat((c) => (c ? { ...c, settings: r.settings, effective: r.effective } : c));
  };
  return { chat, view, loadErr, busy, act, saveSettings };
}
