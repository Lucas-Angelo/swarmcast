// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { adjustNameColor, CHAT_BG_DARK, CHAT_BG_LIGHT, CHAT_DEFAULT_PALETTE, contrastRatio } from '@swarmcast/shared/chat';
import { createColorChooser, NameColors, PREVIEW_BG } from '../../src/chat/color-ui.js';
import { cssColorToHex, isHexColor } from '../../src/chat/core/css.js';

describe('reading colours back from the page', () => {
  it('parses computed colours and skips transparent ones', () => {
    expect(cssColorToHex('rgb(255, 253, 248)')).toBe('#fffdf8');
    expect(cssColorToHex('rgba(19, 34, 31, 1)')).toBe('#13221f');
    expect(cssColorToHex('rgb(19 34 31 / 100%)')).toBe('#13221f');
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull();
    expect(cssColorToHex('transparent')).toBeNull();
    expect(cssColorToHex('#FFFDF8')).toBe('#fffdf8');
    expect(isHexColor('#12ab9z')).toBe(false);
  });

  it('NameColors reads the background once, until the theme changes', () => {
    document.body.replaceChildren();
    const el = document.createElement('div');
    el.style.setProperty('background-color', 'rgb(19, 34, 31)');
    document.body.append(el);
    const colors = new NameColors(() => el);
    expect(colors.background()).toBe('#13221f');
    el.style.setProperty('background-color', 'rgb(255, 253, 248)');
    expect(colors.background()).toBe('#13221f');
    colors.invalidate();
    expect(colors.background()).toBe('#fffdf8');
    expect(contrastRatio(colors.paint('#ffee88'), '#fffdf8')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrast enforcement (plan §5.4): every colour reaches 4.5:1 on both chat surfaces', () => {
  it('sweeps the colour cube (4,913 colours) on the light and dark surface', () => {
    let worst = Infinity;
    for (let r = 0; r <= 256; r += 16) {
      for (let g = 0; g <= 256; g += 16) {
        for (let b = 0; b <= 256; b += 16) {
          const hex = `#${[r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`;
          for (const bg of [CHAT_BG_LIGHT, CHAT_BG_DARK]) worst = Math.min(worst, contrastRatio(adjustNameColor(hex, bg), bg));
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('the default palette has no violet/indigo-heavy hue and keeps readable colours unchanged', () => {
    expect(adjustNameColor('#0f5c53', CHAT_BG_LIGHT)).toBe('#0f5c53');
    for (const c of CHAT_DEFAULT_PALETTE) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      expect(b! > r! + 40 && b! > g! + 40 && r! > g!, `${c} looks violet`).toBe(false);
    }
  });
});

describe('colour chooser', () => {
  it('previews the name on both themes with readable colours and marks the chosen swatch', () => {
    const picked: string[] = [];
    const chooser = createColorChooser((c) => picked.push(c));
    document.body.replaceChildren(chooser.element);
    chooser.set('#ffee88', 'Bia');
    for (const theme of ['light', 'dark'] as const) {
      const nick = chooser.element.querySelector<HTMLElement>(`.sample.${theme} .nick`)!;
      expect(nick.textContent).toBe('Bia');
      expect(contrastRatio(nick.dataset.rendered!, PREVIEW_BG[theme])).toBeGreaterThanOrEqual(4.5);
      expect(nick.style.getPropertyValue('--nick')).toBe(nick.dataset.rendered);
    }
    const swatches = [...chooser.element.querySelectorAll<HTMLButtonElement>('button.swatch')];
    expect(swatches).toHaveLength(12);
    swatches[3]!.click();
    expect(picked).toEqual([CHAT_DEFAULT_PALETTE[3]]);
    chooser.set(CHAT_DEFAULT_PALETTE[3], 'Bia');
    expect(swatches[3]!.getAttribute('aria-checked')).toBe('true');
    const custom = chooser.element.querySelector<HTMLInputElement>('input[type=color]')!;
    custom.value = '#123456';
    custom.dispatchEvent(new Event('change'));
    expect(picked.at(-1)).toBe('#123456');
  });
});
