// Name colours on screen (plan §5.4): every name is painted in a colour that reaches 4.5:1
// against the chat's actual background, read from the computed style (once per theme change),
// and the viewer's colour chooser with a live preview of the name in both themes.
import { t } from '@swarmcast/shared/i18n';
import { adjustNameColor, CHAT_BG_DARK, CHAT_BG_LIGHT, CHAT_DEFAULT_PALETTE, cssColorToHex, isHexColor } from './core/index.js';

/** The chat surface of the Forest & Cream palette (assets/brand/tokens.css --sc-surface), for the preview. */
export const PREVIEW_BG = { light: CHAT_BG_LIGHT, dark: CHAT_BG_DARK } as const;

/** The first opaque background colour of `el` or its ancestors, as "#rrggbb". */
export function backgroundOf(el: Element | null): string {
  for (let e = el; e; e = e.parentElement) {
    const hex = cssColorToHex(getComputedStyle(e).backgroundColor);
    if (hex) return hex;
  }
  return PREVIEW_BG.light;
}

/** Calls `cb` when the theme may have changed (system setting, data-theme / data-palette). */
export function onThemeChange(cb: () => void): void {
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', cb);
  } catch {
    /* old Safari without addEventListener on MediaQueryList: the page keeps its first colours */
  }
  new MutationObserver(cb).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
}

/** The colour of the brand token `name` (e.g. `--sc-accent-soft`) as seen at `el`, or null. */
export function tokenColorAt(el: Element | null, name: string): string | null {
  return el ? cssColorToHex(getComputedStyle(el).getPropertyValue(name)) : null;
}

/** Reads the chat background lazily and adjusts colours against it. */
export class NameColors {
  private bg: string | null = null;
  /** `read`: the background to check against (by default the first opaque one of `surface` or its ancestors). */
  constructor(
    private readonly surface: () => Element | null,
    private readonly read: (el: Element | null) => string = backgroundOf,
  ) {}
  invalidate(): void {
    this.bg = null;
  }
  background(): string {
    return (this.bg ??= this.read(this.surface()));
  }
  paint(color: string): string {
    return adjustNameColor(color, this.background());
  }
}

export interface ColorChooser {
  element: HTMLElement;
  set(color: string, nick: string): void;
}

/**
 * 12 swatches + "Other colour…" (a native colour input) + the name shown on a light and a dark
 * background, as other viewers will see it.
 */
export function createColorChooser(onPick: (color: string) => void): ColorChooser {
  const wrap = document.createElement('div');
  wrap.className = 'chat-color';
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', t('chat.viewer.color'));
  const buttons = CHAT_DEFAULT_PALETTE.map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', t('chat.viewer.color.pick', { index: i + 1 }));
    b.dataset.color = c;
    b.style.setProperty('--swatch', c);
    b.addEventListener('click', () => onPick(c));
    swatches.append(b);
    return b;
  });
  const custom = document.createElement('label');
  custom.className = 'custom';
  const input = document.createElement('input');
  input.type = 'color';
  input.dataset.testid = 'chat-color-custom';
  input.addEventListener('change', () => {
    if (isHexColor(input.value)) onPick(input.value.toLowerCase());
  });
  const customText = document.createElement('span');
  customText.textContent = t('chat.viewer.color.custom');
  custom.append(input, customText);

  const preview = document.createElement('div');
  preview.className = 'preview';
  const sample = (theme: 'light' | 'dark'): { box: HTMLElement; nick: HTMLElement } => {
    const box = document.createElement('div');
    box.className = `sample ${theme}`;
    box.dataset.testid = `chat-color-preview-${theme}`;
    const nick = document.createElement('bdi');
    nick.className = 'nick';
    const label = document.createElement('span');
    label.className = 'theme';
    label.textContent = t(theme === 'light' ? 'chat.viewer.color.light' : 'chat.viewer.color.dark');
    box.append(nick, label);
    preview.append(box);
    return { box, nick };
  };
  const light = sample('light');
  const dark = sample('dark');
  wrap.append(swatches, custom, preview);

  return {
    element: wrap,
    set(color: string, nick: string) {
      const c = isHexColor(color) ? color.toLowerCase() : CHAT_DEFAULT_PALETTE[0];
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.color === c));
      input.value = c;
      for (const [s, bg] of [
        [light, PREVIEW_BG.light],
        [dark, PREVIEW_BG.dark],
      ] as const) {
        s.nick.textContent = nick;
        s.nick.style.setProperty('--nick', adjustNameColor(c, bg));
        s.nick.dataset.rendered = adjustNameColor(c, bg);
      }
    },
  };
}
