// A small popover anchored to a button: opens above the chat input or below the header, closes
// on Escape, outside click or a second click on its button, and gives focus back.

export interface Popover {
  panel: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function createPopover(button: HTMLButtonElement, panel: HTMLElement, hooks: { onOpen?: () => void } = {}): Popover {
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'dialog');
  let open = false;
  const outside = (e: Event): void => {
    const target = e.target as Node | null;
    if (target && (panel.contains(target) || button.contains(target))) return;
    api.close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      api.close();
      button.focus();
    }
  };
  const api: Popover = {
    panel,
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey);
      hooks.onOpen?.();
    },
    close() {
      if (!open) return;
      open = false;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey);
    },
  };
  button.addEventListener('click', () => (open ? api.close() : api.open()));
  return api;
}
