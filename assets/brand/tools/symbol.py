"""The SwarmCast symbol, built by hand: a little bee whose wings are broadcast waves  (( bee )).

  python3 assets/brand/tools/symbol.py out.svg [palette] [variant]

variant:
  full   - symbol with antennae, face and smile (logo, >= 48 px)
  glyph  - simplified, heavier strokes, no antennae/smile (app icon at 16-32 px, favicon)
  mono   - single colour with stripes and eyes knocked out (macOS tray template, stamps)
  tray   - single colour, one wave per side, extra heavy, for 16-32 px tray glyphs
  micro  - like tray but in colour (16 px app icon / favicon)
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from svgkit import n  # noqa: E402

# Colours of the symbol per palette: body (honey), ink (stripes, eyes), waves, antenna, face.
SYMBOL_COLORS = {
    "forest": {"body": "#F2B441", "ink": "#0F3D38", "waves": "#0F5C53", "face": None},
    "honey": {"body": "#F5A623", "ink": "#1D1812", "waves": "#1D1812", "face": None},
    "onair": {"body": "#FFB547", "ink": "#1C1B1A", "waves": "#FF5A1F", "face": None},
}

CX, CY = 256, 270
GEOM = {
    #          rx   ry  wave radii  spans    wave sw  stripe (y offset, h)        eye r  eye dy  eye dx
    "full": (98, 116, (160, 222), (36, 31), 32, ((16, 30), (66, 28)), 16, -30, 36),
    "glyph": (102, 120, (164, 226), (38, 32), 40, ((12, 38), (72, 34)), 20, -32, 40),
    "mono": (98, 116, (160, 222), (36, 31), 32, ((16, 30), (66, 28)), 16, -30, 36),
    "tray": (118, 136, (196,), (42,), 64, ((14, 52),), 0, 0, 0),
    "micro": (118, 136, (196,), (42,), 64, ((14, 52),), 0, 0, 0),
}


def arc(cx, cy, r, a0, a1):
    x0, y0 = cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))
    x1, y1 = cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))
    return f"M{n(x0)} {n(y0)}A{n(r)} {n(r)} 0 0 1 {n(x1)} {n(y1)}"


def ellipse_path(cx, cy, rx, ry):
    return (
        f"M{n(cx - rx)} {n(cy)}A{n(rx)} {n(ry)} 0 1 1 {n(cx + rx)} {n(cy)}"
        f"A{n(rx)} {n(ry)} 0 1 1 {n(cx - rx)} {n(cy)}Z"
    )


def stripe_path(cx, cy, rx, ry, y0, h):
    """Exact band of the ellipse between y0 and y0+h (no clip path needed)."""

    def half_w(y):
        t = (y - cy) / ry
        return rx * math.sqrt(max(0.0, 1 - t * t))

    ya, yb = y0, y0 + h
    wa, wb = half_w(ya), half_w(yb)
    # straight top/bottom edges, elliptical sides
    return (
        f"M{n(cx - wa)} {n(ya)}H{n(cx + wa)}"
        f"A{n(rx)} {n(ry)} 0 0 1 {n(cx + wb)} {n(yb)}H{n(cx - wb)}"
        f"A{n(rx)} {n(ry)} 0 0 1 {n(cx - wa)} {n(ya)}Z"
    )


def symbol_parts(palette="forest", variant="full", colors=None, cx=CX, cy=CY):
    c = dict(SYMBOL_COLORS[palette])
    if colors:
        c.update(colors)
    c.setdefault("antenna", c["ink"])
    single = variant in ("mono", "tray")
    if single:
        col = (colors or {}).get("mono", "#000000")
        c = {k: col for k in ("body", "ink", "waves", "antenna")}
    rx, ry, radii, spans, sw, stripes, er, edy, edx = GEOM[variant]
    parts = []
    waves = "".join(
        arc(cx, cy, r, 180 - s, 180 + s) + arc(cx, cy, r, -s, s) for r, s in zip(radii, spans)
    )
    parts.append(f'<path d="{waves}" fill="none" stroke="{c["waves"]}" stroke-width="{sw}" stroke-linecap="round"/>')
    if variant in ("full", "mono"):
        for s in (-1, 1):
            x0, y0 = cx + s * 32, cy - ry + 12
            x1, y1 = cx + s * 60, cy - ry - 50
            parts.append(
                f'<path d="M{n(x0)} {n(y0)}Q{n(cx + s * 36)} {n(cy - ry - 28)} {n(x1)} {n(y1)}" fill="none" '
                f'stroke="{c["antenna"]}" stroke-width="15" stroke-linecap="round"/>'
            )
            parts.append(f'<circle cx="{n(x1)}" cy="{n(y1)}" r="18" fill="{c["antenna"]}"/>')
    if variant in ("full", "glyph", "mono"):
        # small stinger, drawn behind the body so only its rounded tip shows
        tip = cy + ry + (24 if variant != "glyph" else 26)
        parts.append(
            f'<path d="M{cx - 20} {cy + ry - 14}L{cx + 20} {cy + ry - 14}L{cx} {tip}Z" fill="{c["ink"] if not single else c["body"]}" '
            f'stroke="{c["ink"] if not single else c["body"]}" stroke-width="8" stroke-linejoin="round"/>'
        )
    body = ellipse_path(cx, cy, rx, ry)
    stripe_d = "".join(stripe_path(cx, cy, rx, ry, cy + dy, h) for dy, h in stripes)
    eyes = [(cx - edx, cy + edy), (cx + edx, cy + edy)] if er else []
    if single:
        # one compound path: body minus stripes and eyes (even-odd)
        holes = stripe_d + "".join(ellipse_path(x, y, er, er) for x, y in eyes)
        parts.append(f'<path d="{body}{holes}" fill="{c["body"]}" fill-rule="evenodd"/>')
    else:
        parts.append(f'<path d="{body}" fill="{c["body"]}"/>')
        parts.append(f'<path d="{stripe_d}" fill="{c["ink"]}"/>')
        for x, y in eyes:
            parts.append(f'<circle cx="{n(x)}" cy="{n(y)}" r="{er}" fill="{c["ink"]}"/>')
        if variant == "full":
            parts.append(
                f'<path d="M{cx - 19} {cy - 1}q19 17 38 0" fill="none" stroke="{c["ink"]}" stroke-width="10" stroke-linecap="round"/>'
            )
    return "".join(parts)


def symbol_svg(palette="forest", variant="full", size=512, background=None, colors=None, title="SwarmCast"):
    bg = f'<rect width="512" height="512" fill="{background}"/>' if background else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">'
        f"<title>{title}</title>{bg}{symbol_parts(palette, variant, colors)}</svg>\n"
    )


if __name__ == "__main__":
    out = sys.argv[1]
    pal = sys.argv[2] if len(sys.argv) > 2 else "forest"
    var = sys.argv[3] if len(sys.argv) > 3 else "full"
    Path(out).write_text(symbol_svg(pal, var))
