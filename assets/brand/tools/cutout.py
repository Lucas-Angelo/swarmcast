"""Remove the plain background of a generated mascot -> transparent PNG, trimmed with a margin.

  uv run --python 3.12 --with "rembg[cpu]==2.0.67" --with pillow python assets/brand/tools/cutout.py in.png out.png [size]

Uses rembg with the BiRefNet-general model (MIT); the matte is cleaned (tiny alpha noise removed,
soft ground shadow dropped) and the result is trimmed and centred on a square canvas.
"""

import sys

import numpy as np
from PIL import Image
from rembg import new_session, remove

_session = None


def cutout(src, dst, size=1024, margin=0.06):
    global _session
    if _session is None:
        _session = new_session("birefnet-general")
    im = Image.open(src).convert("RGB")
    out = remove(im, session=_session, post_process_mask=True)
    a = np.array(out)
    alpha = a[..., 3].astype(np.float32)
    # drop faint pixels (ground shadow, halo) and harden the matte a little
    alpha = np.clip((alpha - 40) * 255 / (255 - 40), 0, 255)
    a[..., 3] = alpha.astype(np.uint8)
    # un-premultiply white fringe: for semi-transparent pixels, push colour away from white
    semi = (alpha > 0) & (alpha < 250)
    f = (alpha[semi] / 255.0)[:, None]
    rgb = a[..., :3][semi].astype(np.float32)
    a[..., :3][semi] = np.clip((rgb - 255 * (1 - f)) / np.maximum(f, 0.2), 0, 255).astype(np.uint8)
    img = Image.fromarray(a, "RGBA")
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    img = img.crop(bbox)
    side = int(max(img.size) / (1 - 2 * margin))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    canvas = canvas.resize((size, size), Image.LANCZOS)
    canvas.save(dst, optimize=True)
    return dst


if __name__ == "__main__":
    pairs = sys.argv[1:]
    size = 1024
    if len(pairs) % 2 == 1:
        size = int(pairs.pop())
    for i in range(0, len(pairs), 2):
        print(cutout(pairs[i], pairs[i + 1], size))
