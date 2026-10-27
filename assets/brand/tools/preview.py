"""Quick preview strip of SVGs (rendered with resvg) at several sizes, incl. 32 and 16 px upscaled.

  uv run --with pillow python assets/brand/tools/preview.py out.png file1.svg [file2.svg ...] [--bg #hex]
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


def render(svg: Path, px: int) -> Image.Image:
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "o.png"
        subprocess.run(["resvg", "-w", str(px), "-h", str(px), str(svg), str(out)], check=True)
        return Image.open(out).convert("RGBA").copy()


def main():
    args = sys.argv[1:]
    bg = "#FBF7EF"
    if "--bg" in args:
        i = args.index("--bg")
        bg = args[i + 1]
        del args[i : i + 2]
    out, files = args[0], [Path(a) for a in args[1:]]
    big, cell = 320, 340
    W = cell + 2 * 136
    sheet = Image.new("RGB", (W * len(files), cell), bg)
    for i, f in enumerate(files):
        x = i * W
        im = render(f, big)
        sheet.paste(im, (x + 10, 10), im)
        for j, px in enumerate((32, 16)):
            small = render(f, px).resize((128, 128), Image.NEAREST)
            tile = Image.new("RGB", (128, 128), bg)
            tile.paste(small, (0, 0), small)
            sheet.paste(tile, (x + cell + j * 136, 100))
    sheet.save(out)
    print(out, sheet.size)


if __name__ == "__main__":
    main()
