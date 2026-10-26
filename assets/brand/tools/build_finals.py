"""Build every final brand asset (Forest palette) from the hand-made symbol.

  uv run --with pillow --with fonttools --with uharfbuzz python assets/brand/tools/build_finals.py

Needs `resvg` on PATH (brew install resvg). Mascot poses are made separately (see README).
"""

import io
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from palettes import PALETTES  # noqa: E402
from symbol import symbol_parts  # noqa: E402
from textpath import text_path  # noqa: E402

BRAND = Path(__file__).resolve().parent.parent
L, D = PALETTES["forest"]["light"], PALETTES["forest"]["dark"]
HONEY, PINE, PINE_DEEP, CREAM = "#F2B441", "#0F5C53", "#0F3D38", "#F6F1E6"
TEAL_LIGHT = D["accent"]  # #3DB5A2

ON_LIGHT = {"waves": PINE, "ink": PINE_DEEP, "antenna": PINE_DEEP}
ON_DARK = {"waves": TEAL_LIGHT, "ink": PINE_DEEP, "antenna": CREAM}
ON_PINE = {"waves": CREAM, "ink": PINE_DEEP, "antenna": CREAM}

TRAY_STATES = {"off": "#8A948F", "waiting": HONEY, "live": L["live"]}


def svg_doc(inner, w=512, h=512, title="SwarmCast", extra=""):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">'
        f"<title>{title}</title>{extra}{inner}</svg>\n"
    )


def write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def render(svg_path: Path, out: Path, w: int, h: int | None = None):
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["resvg", "-w", str(w)] + (["-h", str(h)] if h else []) + [str(svg_path), str(out)]
    subprocess.run(cmd, check=True)
    return out


def render_img(svg_text: str, w: int, h: int | None = None) -> Image.Image:
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "a.svg"
        p.write_text(svg_text)
        o = render(p, Path(td) / "a.png", w, h)
        return Image.open(o).convert("RGBA").copy()


def scaled(parts: str, scale: float, size=512):
    off = size * (1 - scale) / 2
    return f'<g transform="translate({off:g} {off:g}) scale({scale:g})">{parts}</g>'


# ---------------------------------------------------------------- symbol
def build_symbol():
    out = BRAND / "symbol"
    files = {
        "swarmcast-symbol.svg": symbol_parts("forest", "full", ON_LIGHT),
        "swarmcast-symbol-on-dark.svg": symbol_parts("forest", "full", ON_DARK),
        "swarmcast-symbol-mono.svg": symbol_parts("forest", "mono", {"mono": "#000000"}),
        "swarmcast-symbol-mono-white.svg": symbol_parts("forest", "mono", {"mono": "#FFFFFF"}),
        "swarmcast-symbol-small.svg": symbol_parts("forest", "glyph", ON_LIGHT),
    }
    for name, parts in files.items():
        p = write(out / name, svg_doc(parts))
        render(p, out / name.replace(".svg", "-1024.png"), 1024)


# ---------------------------------------------------------------- app icon
def icon_svg(rounded: bool, variant="full", scale=0.86):
    if rounded:
        # macOS Big Sur+ grid: 824x824 body centred on a 1024 canvas, corner radius ~185
        bg = f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{PINE}"/>'
        sym = f'<g transform="translate(100 100) scale({824 / 512:g})">{scaled(symbol_parts("forest", variant, ON_PINE), scale)}</g>'
    else:
        bg = f'<rect width="1024" height="1024" fill="{PINE}"/>'
        sym = f'<g transform="scale(2)">{scaled(symbol_parts("forest", variant, ON_PINE), scale)}</g>'
    return svg_doc(bg + sym, 1024, 1024)


def build_icon():
    out = BRAND / "icon"
    p = write(out / "app-icon.svg", icon_svg(False))
    render(p, out / "app-icon-1024.png", 1024)
    p = write(out / "app-icon-macos.svg", icon_svg(True))
    render(p, out / "app-icon-macos-1024.png", 1024)
    # simplified sources for small sizes: glyph (no antennae, heavier) for 24-48 px, micro (one wave) for 16 px
    p = write(out / "app-icon-small.svg", icon_svg(False, "glyph", 0.9))
    render(p, out / "app-icon-small-1024.png", 1024)
    p = write(out / "app-icon-micro.svg", icon_svg(False, "micro", 0.94))
    render(p, out / "app-icon-micro-1024.png", 1024)
    # hand-picked size set (use these to override what `tauri icon` derives for the small sizes)
    sizes_dir = out / "sizes"
    for px in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        src = "app-icon-micro.svg" if px <= 16 else "app-icon-small.svg" if px <= 48 else "app-icon.svg"
        render(out / src, sizes_dir / f"app-icon-{px}.png", px)
    # preview: actual size on top, 4x nearest-neighbour zoom below
    sheet = Image.new("RGB", (900, 330), CREAM)
    x = 20
    for px in (16, 24, 32, 48, 64):
        im = Image.open(sizes_dir / f"app-icon-{px}.png").convert("RGBA")
        sheet.paste(im, (x, 20), im)
        z = im.resize((px * 4, px * 4), Image.NEAREST)
        sheet.paste(z, (x, 70), z)
        x += px * 4 + 24
    sheet.save(out / "preview-sizes.png")


# ---------------------------------------------------------------- wordmark
def lockup(text_color, sym_colors, h=200, gap_ratio=0.1):
    """Horizontal lockup: symbol box h x h, word set at cap height ~0.42 h."""
    size = h * 0.56
    d, w, asc, desc, cap = text_path("SwarmCast", size)
    tx = h * (1 + gap_ratio) - h * 0.06
    baseline = h / 2 + cap / 2
    sym = f'<g transform="scale({h / 512:g})">{symbol_parts("forest", "full", sym_colors)}</g>'
    word = f'<path transform="translate({tx:.1f} {baseline:.1f})" d="{d}" fill="{text_color}"/>'
    W = tx + w + h * 0.04
    return sym + word, W, h


def build_wordmark():
    out = BRAND / "wordmark"
    for name, tc, sc, bg in (
        ("swarmcast-lockup-light", L["ink"], ON_LIGHT, L["bg"]),
        ("swarmcast-lockup-dark", D["ink"], ON_DARK, D["bg"]),
        ("swarmcast-lockup-mono", "#000000", {"waves": "#000", "ink": "#fff", "body": "#000", "antenna": "#000"}, "#fff"),
    ):
        inner, W, H = lockup(tc, sc)
        if name.endswith("mono"):
            inner = inner.replace(symbol_parts("forest", "full", sc), symbol_parts("forest", "mono", {"mono": "#000000"}))
        p = write(out / f"{name}.svg", svg_doc(inner, round(W, 1), H))
        render(p, out / f"{name}.png", 1600)
        # preview on its background
        im = render_img(svg_doc(f'<rect width="{W + 80:g}" height="{H + 80:g}" fill="{bg}"/><g transform="translate(40 40)">{inner}</g>', round(W + 80, 1), H + 80), 1200)
        im.convert("RGB").save(out / f"{name}-preview.png")
    # wordmark only (text) for places where the symbol is shown separately
    d, w, asc, desc, cap = text_path("SwarmCast", 112)
    write(out / "swarmcast-wordtype.svg", svg_doc(f'<path transform="translate(0 {asc:.1f})" d="{d}" fill="{L["ink"]}"/>', round(w, 1), round(asc - desc, 1)))


# ---------------------------------------------------------------- tray
def build_tray():
    out = BRAND / "tray"
    # macOS template: black + alpha only; named *Template so AppKit tints it
    tmpl = write(out / "trayTemplate.svg", svg_doc(symbol_parts("forest", "tray", {"mono": "#000000"})))
    for px, suffix in ((16, ""), (32, "@2x"), (64, "@4x")):
        render(tmpl, out / f"trayTemplate{suffix}.png", px)
    for state, col in TRAY_STATES.items():
        p = write(out / f"tray-{state}.svg", svg_doc(symbol_parts("forest", "tray", {"mono": col})))
        for px in (16, 32, 64):
            render(p, out / f"tray-{state}-{px}.png", px)
        imgs = [Image.open(out / f"tray-{state}-{px}.png").convert("RGBA") for px in (16, 32, 64)]
        imgs[-1].save(out / f"tray-{state}.ico", sizes=[(16, 16), (32, 32), (64, 64)], append_images=imgs[:2])
    # preview on light and dark bars: 16 px and 32 px, zoomed 4x / 2x (nearest neighbour)
    names = ["trayTemplate"] + [f"tray-{s}" for s in TRAY_STATES]
    sheet = Image.new("RGB", (len(names) * 160 + 20, 2 * 74 + 20), "white")
    for i, name in enumerate(names):
        for row, bg in enumerate(("#ECECEC", "#2B2B2B")):
            for j, px in enumerate((16, 32)):
                if name == "trayTemplate":
                    src = out / ("trayTemplate.png" if px == 16 else "trayTemplate@2x.png")
                else:
                    src = out / f"{name}-{px}.png"
                im = Image.open(src).convert("RGBA")
                if name == "trayTemplate" and row == 1:
                    # AppKit tints templates white on dark menu bars
                    im = Image.merge("RGBA", (*[Image.new("L", im.size, 255)] * 3, im.getchannel("A")))
                tile = Image.new("RGBA", (px, px), bg)
                tile.alpha_composite(im)
                tile = tile.resize((64, 64), Image.NEAREST)
                sheet.paste(tile, (10 + i * 160 + j * 72, 10 + row * 74))
    sheet.save(out / "preview-16-32px-zoomed.png")


# ---------------------------------------------------------------- favicon
def build_favicon():
    out = BRAND / "favicon"
    parts_light = symbol_parts("forest", "glyph", ON_LIGHT)
    style = (
        "<style>.w{stroke:%s}@media (prefers-color-scheme:dark){.w{stroke:%s}}</style>" % (PINE, TEAL_LIGHT)
    )
    fav = parts_light.replace(f'stroke="{PINE}"', 'class="w" stroke="%s"' % PINE, 1)
    write(out / "favicon.svg", svg_doc(fav, extra=style))
    # PNG favicons on a pine tile so they read on light and dark tab bars
    rect = f'<rect width="512" height="512" rx="112" fill="{PINE}"/>'
    p = write(out / "favicon-tile.svg", svg_doc(rect + scaled(symbol_parts("forest", "glyph", ON_PINE), 0.92)))
    pm = write(out / "favicon-tile-16.svg", svg_doc(rect + scaled(symbol_parts("forest", "micro", ON_PINE), 0.98)))
    render(pm, out / "favicon-16.png", 16)
    for px in (32, 48, 180, 192, 512):
        render(p, out / f"favicon-{px}.png", px)
    (out / "apple-touch-icon.png").write_bytes((out / "favicon-180.png").read_bytes())
    ims = [Image.open(out / f"favicon-{px}.png").convert("RGBA") for px in (16, 32, 48)]
    ims[2].save(out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ims[:2])


if __name__ == "__main__":
    build_symbol()
    build_icon()
    build_wordmark()
    build_tray()
    build_favicon()
    print("done")
