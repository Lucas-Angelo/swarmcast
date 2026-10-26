"""Turn a line of text into SVG path data (outlined glyphs, shaped with HarfBuzz so kerning applies).

Used for the wordmark so the SVG does not depend on the font being installed.
  uv run --with fonttools --with uharfbuzz python assets/brand/tools/textpath.py "SwarmCast" 200
"""

import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT = Path(__file__).resolve().parent.parent / "font" / "Fredoka-SemiBold.ttf"


def text_path(text: str, size: float, x: float = 0, y: float = 0, tracking: float = 0, font_path: Path = FONT):
    """Return (path_d, advance_width, ascender, descender, cap_height) in px for baseline at y."""
    blob = hb.Blob.from_file_path(str(font_path))
    face = hb.Face(blob)
    font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})
    tt = TTFont(str(font_path))
    upem = tt["head"].unitsPerEm
    scale = size / upem
    glyphset = tt.getGlyphSet()
    order = tt.getGlyphOrder()
    pen = SVGPathPen(glyphset, ntos=lambda v: (f"{v:.1f}").rstrip("0").rstrip("."))
    cx = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        tp = TransformPen(pen, (scale, 0, 0, -scale, x + (cx + pos.x_offset) * scale, y - pos.y_offset * scale))
        glyphset[name].draw(tp)
        cx += pos.x_advance + tracking * upem / size
    os2 = tt["OS/2"]
    return (
        pen.getCommands(),
        cx * scale,
        os2.sTypoAscender * scale,
        os2.sTypoDescender * scale,
        getattr(os2, "sCapHeight", 700) * scale,
    )


if __name__ == "__main__":
    d, w, a, de, cap = text_path(sys.argv[1], float(sys.argv[2]))
    print(f"width={w:.1f} asc={a:.1f} desc={de:.1f} cap={cap:.1f}")
    print(d[:200], "...")
