"""Contact sheets for the brand explorations.

  uv run --with pillow python assets/brand/tools/contact_sheet.py dir A "A · Bee mascot" out.jpg [--glob 'qwen_*']
  uv run --with pillow python assets/brand/tools/contact_sheet.py picks picks.json out.jpg

`dir` lays out every PNG of explorations/raw/<dir> in a grid with its file name.
`picks` takes {"title": "...", "rows": [{"label": "A", "title": "...", "files": ["raw/A/x.png", ...]}]}.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "explorations"
FONT = Path(__file__).resolve().parent.parent / "font" / "Fredoka-SemiBold.ttf"
BG = (246, 241, 230)
INK = (18, 33, 31)
PINE = (15, 92, 83)


def font(size: int):
    try:
        return ImageFont.truetype(str(FONT), size)
    except OSError:
        return ImageFont.load_default(size)


def grid(files, cols, thumb, title, subtitle=""):
    rows = (len(files) + cols - 1) // cols
    pad, cap, head = 16, 30, 90 if subtitle else 70
    W = cols * (thumb + pad) + pad
    H = head + rows * (thumb + cap + pad) + pad
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((pad, 14), title, fill=INK, font=font(40))
    if subtitle:
        d.text((pad, 62), subtitle, fill=(95, 103, 116), font=font(20))
    for i, f in enumerate(files):
        r, c = divmod(i, cols)
        x, y = pad + c * (thumb + pad), head + r * (thumb + cap + pad)
        im = Image.open(f).convert("RGBA")
        im.thumbnail((thumb, thumb))
        tile = Image.new("RGB", (thumb, thumb), (255, 255, 255))
        tile.paste(im, ((thumb - im.width) // 2, (thumb - im.height) // 2), im)
        sheet.paste(tile, (x, y))
        d.text((x + 2, y + thumb + 4), Path(f).stem, fill=INK, font=font(18))
    return sheet


def main():
    mode = sys.argv[1]
    if mode == "dir":
        _, _, sub, title, out, *rest = sys.argv
        pattern = rest[1] if len(rest) == 2 and rest[0] == "--glob" else "*"
        files = sorted((ROOT / "raw" / sub).glob(pattern + ".png"))
        sheet = grid(files, 6, 300, title, f"{len(files)} images · explorations/raw/{sub}")
    else:
        _, _, spec_path, out = sys.argv
        spec = json.loads(Path(spec_path).read_text())
        thumb, pad, label_w = 280, 16, 380
        cols = max(len(r["files"]) for r in spec["rows"])
        W = label_w + cols * (thumb + pad) + pad
        H = 110 + len(spec["rows"]) * (thumb + pad * 2) + pad
        sheet = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(sheet)
        d.text((pad, 20), spec["title"], fill=INK, font=font(52))
        for i, row in enumerate(spec["rows"]):
            y = 110 + i * (thumb + pad * 2)
            d.rounded_rectangle((pad, y, label_w - pad, y + thumb), 24, fill=(255, 255, 255))
            d.text((pad + 24, y + 16), row["label"], fill=PINE, font=font(120))
            yy = y + 160
            for line in row["title"].split("\n"):
                d.text((pad + 24, yy), line, fill=INK, font=font(24))
                yy += 30
            for j, f in enumerate(row["files"]):
                im = Image.open(ROOT / f).convert("RGBA")
                im.thumbnail((thumb, thumb))
                tile = Image.new("RGB", (thumb, thumb), (255, 255, 255))
                tile.paste(im, ((thumb - im.width) // 2, (thumb - im.height) // 2), im)
                sheet.paste(tile, (label_w + j * (thumb + pad), y))
    sheet.save(out, quality=85, optimize=True)
    print(out, sheet.size)


if __name__ == "__main__":
    main()
