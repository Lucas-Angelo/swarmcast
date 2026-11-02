/**
 * The watch page's Settings menu (watch.html `#settings-open` / `#settings-menu`): Playback
 * (Stable / Lower delay), Help the stream (P2P) with its numbers, the viewer's nickname, the
 * keyboard shortcuts and "Stats for nerds", kept out of the way until the viewer opens them (the
 * page used to show them in a big card under the video).
 *
 * A disclosure, not a modal: the button says whether the menu is open (aria-expanded), the menu
 * comes right after it in the page, so Tab goes from the button into it, and nothing traps the
 * focus. It closes on Esc (the focus goes back to the button when it was in the menu), on a
 * press outside it, and on a second press of the button. A dialog opened from it (the list of
 * shortcuts) keeps it open: pressing inside that dialog is not "outside", and the dialog gives the
 * focus back to its button in the menu when it closes.
 */

export interface SettingsMenuDeps {
  doc: Document;
  button: HTMLButtonElement;
  menu: HTMLElement;
}

export interface SettingsMenu {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

/** A press or key inside an open dialog (the shortcuts list, the Pix sheet) belongs to that dialog. */
function inDialog(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' && el.closest('dialog[open], [role="dialog"]') !== null;
}

export function createSettingsMenu({ doc, button, menu }: SettingsMenuDeps): SettingsMenu {
  let open = false;
  const inside = (target: EventTarget | null): boolean => {
    const node = target as Node | null;
    return !!node && (menu.contains(node) || button.contains(node));
  };

  const onPointer = (e: Event): void => {
    if (inside(e.target) || inDialog(e.target)) return;
    api.close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || inDialog(e.target)) return;
    const hadFocus = inside(doc.activeElement);
    api.close();
    if (hadFocus) {
      e.preventDefault();
      button.focus();
    }
  };

  const set = (next: boolean): void => {
    if (next === open) return;
    open = next;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      doc.addEventListener('pointerdown', onPointer, true);
      doc.addEventListener('keydown', onKey);
      // On a phone the menu opens down, over the chat: bring all of it into view.
      menu.scrollIntoView?.({ block: 'nearest' });
    } else {
      doc.removeEventListener('pointerdown', onPointer, true);
      doc.removeEventListener('keydown', onKey);
    }
  };

  const api: SettingsMenu = {
    get isOpen() {
      return open;
    },
    open: () => set(true),
    close: () => set(false),
    toggle: () => set(!open),
  };
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => api.toggle());
  return api;
}
