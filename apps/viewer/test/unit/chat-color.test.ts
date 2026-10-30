// @vitest-environment happy-dom
// Name colours in the chat (chat/color-ui.ts, chat/core/css.ts and the shared contrast rules, plan
// §5.4): colours read back from the page, every colour lifted to 4.5:1 on both chat surfaces, a
// default palette without violet or indigo, and the colour chooser.
import { describe, expect, it } from 'vitest';
import { adjustNameColor, CHAT_BG_DARK, CHAT_BG_LIGHT, CHAT_DEFAULT_PALETTE, contrastRatio } from '@swarmcast/shared/chat';
import { createColorChooser, NameColors, PREVIEW_BG } from '../../src/chat/color-ui.js';
import { cssColorToHex, isHexColor } from '../../src/chat/core/css.js';

/** The colour cube in steps of 16 per channel (17³ = 4,913 colours, 255 included). */
const CUBE = Array.from({ length: 17 ** 3 }, (_, i) => {
  const [r, g, b] = [Math.floor(i / 289), Math.floor(i / 17) % 17, i % 17].map((v) => Math.min(255, v * 16));
  return `#${[r!, g!, b!].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
});

/** An element of background `css` in the page, and NameColors reading it. */
function backgroundOf(css: string) {
  document.body.replaceChildren();
  const el = document.createElement('div');
  el.style.setProperty('background-color', css);
  document.body.append(el);
  return { el, colors: new NameColors(() => el) };
}

/** A chooser in the page; `picked` lists the colours it asked for. */
function chooser() {
  const picked: string[] = [];
  const c = createColorChooser((color) => picked.push(color));
  document.body.replaceChildren(c.element);
  const swatches = [...c.element.querySelectorAll<HTMLButtonElement>('button.swatch')];
  return { chooser: c, picked, swatches };
}

describe('reading colours back from the page', () => {
  it.each([
    ['rgb(255, 253, 248)', '#fffdf8'],
    ['rgba(19, 34, 31, 1)', '#13221f'],
    ['rgb(19 34 31 / 100%)', '#13221f'],
    ['#FFFDF8', '#fffdf8'],
    ['rgba(0, 0, 0, 0)', null],
    ['transparent', null],
  ])('parses the computed colour %j (transparent ones give null)', (css, hex) => {
    // Act
    const got = cssColorToHex(css);

    // Assert
    expect(got).toBe(hex);
  });

  it('a hex colour has hex digits only', () => {
    // Act
    const ok = isHexColor('#12ab9z');

    // Assert
    expect(ok).toBe(false);
  });

  it('NameColors reads the background once: a later change is not read again by itself', () => {
    // Arrange
    const { el, colors } = backgroundOf('rgb(19, 34, 31)');
    colors.background();

    // Act
    el.style.setProperty('background-color', 'rgb(255, 253, 248)');

    // Assert
    expect(colors.background()).toBe('#13221f');
  });

  it('NameColors reads the background again after invalidate() (a theme change) and paints for it', () => {
    // Arrange
    const { el, colors } = backgroundOf('rgb(19, 34, 31)');
    colors.background();
    el.style.setProperty('background-color', 'rgb(255, 253, 248)');

    // Act
    colors.invalidate();

    // Assert
    expect(colors.background()).toBe('#fffdf8');
    expect(contrastRatio(colors.paint('#ffee88'), '#fffdf8')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrast enforcement (plan §5.4): every colour reaches 4.5:1 on both chat surfaces', () => {
  it.each([CHAT_BG_LIGHT, CHAT_BG_DARK])('sweeps the colour cube (4,913 colours) on %s', (bg) => {
    // Act
    const worst = Math.min(...CUBE.map((hex) => contrastRatio(adjustNameColor(hex, bg), bg)));

    // Assert
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a colour that is already readable unchanged', () => {
    // Act
    const painted = adjustNameColor('#0f5c53', CHAT_BG_LIGHT);

    // Assert
    expect(painted).toBe('#0f5c53');
  });

  it.each(CHAT_DEFAULT_PALETTE)('the default palette colour %s is not violet or indigo heavy', (c) => {
    // Act
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

    // Assert
    expect(b! > r! + 40 && b! > g! + 40 && r! > g!, `${c} looks violet`).toBe(false);
  });
});

describe('colour chooser', () => {
  it.each(['light', 'dark'] as const)('previews the name on the %s theme with a readable colour, set through the CSSOM', (theme) => {
    // Arrange
    const { chooser: c } = chooser();

    // Act
    c.set('#ffee88', 'Bia');

    // Assert
    const nick = c.element.querySelector<HTMLElement>(`.sample.${theme} .nick`)!;
    expect(nick.textContent).toBe('Bia');
    expect(contrastRatio(nick.dataset.rendered!, PREVIEW_BG[theme])).toBeGreaterThanOrEqual(4.5);
    expect(nick.style.getPropertyValue('--nick')).toBe(nick.dataset.rendered);
  });

  it('offers the 12 palette swatches; a click asks for that colour', () => {
    // Arrange
    const { picked, swatches } = chooser();

    // Act
    swatches[3]!.click();

    // Assert
    expect(swatches).toHaveLength(12);
    expect(picked).toEqual([CHAT_DEFAULT_PALETTE[3]]);
  });

  it('marks the swatch of the current colour', () => {
    // Arrange
    const { chooser: c, swatches } = chooser();

    // Act
    c.set(CHAT_DEFAULT_PALETTE[3]!, 'Bia');

    // Assert
    expect(swatches[3]!.getAttribute('aria-checked')).toBe('true');
  });

  it('a custom colour from the colour input is asked for too', () => {
    // Arrange
    const { chooser: c, picked } = chooser();
    const custom = c.element.querySelector<HTMLInputElement>('input[type=color]')!;

    // Act
    custom.value = '#123456';
    custom.dispatchEvent(new Event('change'));

    // Assert
    expect(picked.at(-1)).toBe('#123456');
  });
});
