"""Simple matte for flat illustrations on a plain light background (no ML model needed).

The background is the near-white, low-saturation region connected to the image border (so white
eye highlights and wings inside the dark outline stay opaque). The soft ground shadow is included
in that region. Edge pixels get a fractional alpha from their distance to the background colour.

  uv run --with pillow --with numpy --with scipy python assets/brand/tools/matte.py in.png out.png [size]
"""

import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def matte(src, dst, size=1024, margin=0.06, light=200, sat=0.16):
    im = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    mx, mn = im.max(-1), im.min(-1)
    s = (mx - mn) / np.maximum(mx, 1)
    bgish = (mn > light) & (s < sat)
    lab, _ = ndimage.label(bgish)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, border[border > 0])
    # also remove light shadow blobs that are enclosed by background only (ground shadow)
    fg = ~bg
    fg = ndimage.binary_opening(fg, iterations=1)
    # keep only the largest foreground component(s) (> 1% of the biggest)
    flab, k = ndimage.label(fg)
    if k > 1:
        sizes = ndimage.sum(fg, flab, range(1, k + 1))
        keep = [i + 1 for i, v in enumerate(sizes) if v > 0.01 * sizes.max()]
        fg = np.isin(flab, keep)
    fg = ndimage.binary_fill_holes(fg) | (fg & ~bg)
    # soft edge: 1px feather using distance transform on both sides
    d_in = ndimage.distance_transform_edt(fg)
    d_out = ndimage.distance_transform_edt(~fg)
    alpha = np.clip(0.5 + d_in - d_out, 0, 1)
    alpha = np.where(fg & (d_in > 1.5), 1.0, alpha)
    rgba = np.dstack([im, alpha * 255]).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    img = img.crop(bbox)
    side = int(max(img.size) / (1 - 2 * margin))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    canvas.resize((size, size), Image.LANCZOS).save(dst, optimize=True)
    return dst


if __name__ == "__main__":
    a = sys.argv[1:]
    size = int(a.pop()) if len(a) % 2 == 1 else 1024
    for i in range(0, len(a), 2):
        print(matte(a[i], a[i + 1], size))
