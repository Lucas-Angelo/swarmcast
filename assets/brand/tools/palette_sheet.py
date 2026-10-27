"""Render one palette sheet (swatches + contrast, symbol, app icon, wordmark, button, panel card, mascot).

  uv run --with pillow python assets/brand/tools/palette_sheet.py <palette> <mascot.png|-> <out.png>
"""

import base64
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from palettes import PALETTES, contrast, grade  # noqa: E402
from symbol import SYMBOL_COLORS, symbol_svg  # noqa: E402
from textpath import text_path  # noqa: E402

FONT = Path(__file__).resolve().parent.parent / "font" / "Fredoka-SemiBold.ttf"
W, H = 1800, 1270


def inner(svg: str) -> str:
    return svg[svg.index(">") + 1 : svg.rindex("</svg>")]


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;")


def symbol_at(pal, x, y, size, variant="full", colors=None, uid="s"):
    s = inner(symbol_svg(pal, variant, colors=colors)).replace('id="b"', f'id="{uid}"').replace("url(#b)", f"url(#{uid})")
    return f'<g transform="translate({x} {y}) scale({size / 512})">{s}</g>'


def wordmark(pal, x, y, h, ink, colors=None, uid="w"):
    """Symbol + 'SwarmCast' at height h (symbol box)."""
    d, w, *_ = text_path("SwarmCast", h * 0.62)
    sym = symbol_at(pal, x, y, h, colors=colors, uid=uid)
    return sym + f'<path transform="translate({x + h * 1.02} {y + h * 0.71})" d="{d}" fill="{ink}"/>', h * 1.02 + w


def card(p, x, y, w, live_label="LIVE"):
    t = []
    t.append(f'<rect x="{x}" y="{y}" width="{w}" height="250" rx="16" fill="{p["surface"]}" stroke="{p["border"]}" stroke-width="2"/>')
    t.append(f'<text x="{x + 24}" y="{y + 44}" font-family="Fredoka" font-size="26" fill="{p["ink"]}">Your live</text>')
    t.append(f'<rect x="{x + w - 118}" y="{y + 20}" width="94" height="34" rx="17" fill="{p["live"]}"/>')
    t.append(f'<circle cx="{x + w - 98}" cy="{y + 37}" r="6" fill="{p["on-live"]}"/>')
    t.append(f'<text x="{x + w - 84}" y="{y + 45}" font-family="Helvetica" font-weight="bold" font-size="18" fill="{p["on-live"]}">{live_label}</text>')
    t.append(f'<text x="{x + 24}" y="{y + 84}" font-family="Helvetica" font-size="17" fill="{p["muted"]}">Secret link · only your members can watch</text>')
    t.append(f'<rect x="{x + 24}" y="{y + 102}" width="{w - 48}" height="44" rx="10" fill="{p["bg"]}" stroke="{p["border"]}" stroke-width="2"/>')
    t.append(f'<text x="{x + 40}" y="{y + 131}" font-family="Menlo" font-size="16" fill="{p["ink"]}">https://•••••••.trycloudflare.com/w/•••••</text>')
    t.append(f'<rect x="{x + 24}" y="{y + 168}" width="160" height="52" rx="12" fill="{p["accent"]}"/>')
    t.append(f'<text x="{x + 104}" y="{y + 201}" text-anchor="middle" font-family="Helvetica" font-weight="bold" font-size="19" fill="{p["on-accent"]}">Copy link</text>')
    t.append(f'<rect x="{x + 196}" y="{y + 168}" width="150" height="52" rx="12" fill="{p["surface"]}" stroke="{p["border"]}" stroke-width="2"/>')
    t.append(f'<text x="{x + 271}" y="{y + 201}" text-anchor="middle" font-family="Helvetica" font-weight="bold" font-size="19" fill="{p["ink"]}">New link</text>')
    t.append(f'<text x="{x + w - 24}" y="{y + 201}" text-anchor="end" font-family="Helvetica" font-size="18" fill="{p["success"]}">● 42 watching</text>')
    return "".join(t)


def sheet(key, mascot_png, out):
    P = PALETTES[key]
    L, D = P["light"], P["dark"]
    sc = SYMBOL_COLORS[key]
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}" height="{H}" viewBox="0 0 {W} {H}">']
    s.append(f'<rect width="{W}" height="{H}" fill="{L["bg"]}"/>')
    # dark half on the right bottom
    s.append(f'<rect x="0" y="850" width="{W}" height="{H - 850}" fill="{D["bg"]}"/>')
    # header
    s.append(f'<text x="48" y="78" font-family="Fredoka" font-size="54" fill="{L["ink"]}">{esc(P["name"])}</text>')
    s.append(f'<text x="48" y="116" font-family="Helvetica" font-size="20" fill="{L["muted"]}">{esc(P["summary"])}</text>')
    # swatches
    sw = [("accent", "Primary"), ("accent-strong", "Primary text"), ("secondary", "Secondary"), ("ink", "Ink"),
          ("bg", "Background"), ("surface", "Surface"), ("success", "Success"), ("warning", "Warning"),
          ("live", "Live"), ("danger", "Danger")]
    x0, y0, sw_w = 48, 150, 166
    for i, (k, label) in enumerate(sw):
        x = x0 + i * (sw_w + 8)
        col = L[k]
        s.append(f'<rect x="{x}" y="{y0}" width="{sw_w}" height="120" rx="14" fill="{col}" stroke="{L["border"]}" stroke-width="2"/>')
        # contrast of white/ink text on swatch
        best = max((L["ink"], "ink"), ("#FFFFFF", "white"), key=lambda c: contrast(col, c[0]))
        cr = contrast(col, best[0])
        s.append(f'<text x="{x + 14}" y="{y0 + 34}" font-family="Fredoka" font-size="21" fill="{best[0]}">{label}</text>')
        s.append(f'<text x="{x + 14}" y="{y0 + 104}" font-family="Helvetica" font-size="13" fill="{best[0]}">{best[1]} text {cr:.1f}:1</text>')
        s.append(f'<text x="{x + 14}" y="{y0 + 150}" font-family="Menlo" font-size="17" fill="{L["ink"]}">{col}</text>')
        s.append(f'<text x="{x + 14}" y="{y0 + 172}" font-family="Menlo" font-size="14" fill="{L["muted"]}">dark {D[k]}</text>')
        # contrast against surface for text-ish colours
        if k in ("accent-strong", "success", "warning", "danger", "live", "accent"):
            c2 = contrast(col, L["surface"])
            s.append(f'<text x="{x + 14}" y="{y0 + 192}" font-family="Helvetica" font-size="13" fill="{L["muted"]}">as text {c2:.1f} {grade(c2) if c2 >= 3 else "(fill only)"}</text>')
    # symbol + icon + wordmark row (light)
    y1 = 380
    s.append(symbol_at(key, 48, y1, 300, uid="s1"))
    # app icon: rounded square, ink background for honey/onair, accent background for forest
    icon_bg = {"honey": L["ink"], "forest": L["accent"], "onair": L["ink"]}[key]
    icon_cols = {"honey": {"waves": sc["body"], "antenna": sc["body"]},
                 "forest": {"waves": "#F6F1E6", "antenna": "#F6F1E6"},
                 "onair": {"waves": "#FF5A1F", "antenna": "#FF5A1F"}}[key]
    s.append(f'<rect x="380" y="{y1 + 20}" width="260" height="260" rx="58" fill="{icon_bg}"/>')
    s.append(symbol_at(key, 390, y1 + 30, 240, colors=icon_cols, uid="s2"))
    # tiny icons 32/16 simulation
    s.append(f'<rect x="660" y="{y1 + 20}" width="64" height="64" rx="14" fill="{icon_bg}"/>')
    s.append(symbol_at(key, 662, y1 + 22, 60, variant="glyph", colors=icon_cols, uid="s3"))
    s.append(f'<rect x="660" y="{y1 + 100}" width="32" height="32" rx="7" fill="{icon_bg}"/>')
    s.append(symbol_at(key, 661, y1 + 101, 30, variant="glyph", colors=icon_cols, uid="s4"))
    s.append(f'<text x="660" y="{y1 + 170}" font-family="Helvetica" font-size="14" fill="{L["muted"]}">64 / 32 px</text>')
    wm, _ = wordmark(key, 760, y1 + 10, 120, L["ink"], uid="s5")
    s.append(wm)
    # sample card light
    s.append(card(L, 760, y1 + 170, 560))
    # mascot
    if mascot_png:
        b64 = base64.b64encode(Path(mascot_png).read_bytes()).decode()
        s.append(f'<image x="1370" y="{y1 + 10}" width="400" height="400" xlink:href="data:image/png;base64,{b64}"/>')
    # dark row
    y2 = 890
    dk = {"waves": D["accent"] if key != "honey" else sc["body"], "antenna": D["ink"]}
    s.append(symbol_at(key, 48, y2, 300, colors=dk, uid="s6"))
    wm2, _ = wordmark(key, 380, y2 + 10, 110, D["ink"], colors=dk, uid="s7")
    s.append(wm2)
    s.append(card(D, 380, y2 + 130, 560))
    s.append(f'<text x="1000" y="{y2 + 200}" font-family="Fredoka" font-size="24" fill="{D["ink"]}">Dark theme</text>')
    s.append(f'<text x="1000" y="{y2 + 232}" font-family="Helvetica" font-size="17" fill="{D["muted"]}">ink on bg {contrast(D["ink"], D["bg"]):.1f}:1 · muted on surface {contrast(D["muted"], D["surface"]):.1f}:1</text>')
    s.append(f'<text x="1000" y="{y2 + 258}" font-family="Helvetica" font-size="17" fill="{D["muted"]}">button text {contrast(D["on-accent"], D["accent"]):.1f}:1 · live badge {contrast(D["on-live"], D["live"]):.1f}:1</text>')
    s.append(f'<text x="1000" y="{y2 + 300}" font-family="Helvetica" font-size="15" fill="{D["muted"]}">Light: ink on bg {contrast(L["ink"], L["bg"]):.1f}:1 · button text {contrast(L["on-accent"], L["accent"]):.1f}:1 · live badge {contrast(L["on-live"], L["live"]):.1f}:1</text>')
    s.append(f'<text x="1000" y="{y2 + 324}" font-family="Helvetica" font-size="15" fill="{D["muted"]}">Primary is a fill colour; use “Primary text” for links on light backgrounds.</text>')
    s.append("</svg>")
    svg_path = Path(out).with_suffix(".svg")
    svg_path.write_text("".join(s))
    subprocess.run(["resvg", "--use-font-file", str(FONT), str(svg_path), out], check=True)
    svg_path.unlink()
    print(out)


if __name__ == "__main__":
    key, mascot, out = sys.argv[1:4]
    sheet(key, None if mascot == "-" else mascot, out)
