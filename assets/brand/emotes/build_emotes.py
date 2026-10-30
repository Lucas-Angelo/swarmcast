#!/usr/bin/env python3
"""Build the built-in chat emote pack from the mascot art.

Every emote is one of the three mascot poses (assets/brand/mascot/*.png), or a crop of one,
with a small badge drawn on top in the brand colours (Forest & Cream): a heart, "GG", a flame…
Output: <code>.webp at 56x56 and <code>@2x.webp at 112x112 next to this file, plus
emotes.json (the list the viewer and the server read). Original art for the project, under the
repository licence. Needs Pillow with WebP support (python3 -m pip install pillow).

    python3 assets/brand/emotes/build_emotes.py            # writes the files
    python3 assets/brand/emotes/build_emotes.py --sheet x.png  # also a contact sheet to review
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
BRAND = HERE.parent
FONT = BRAND / 'font' / 'Fredoka-SemiBold.ttf'
W = 448  # work size (4x the 2x size): drawn big, scaled down once
SIZES = {'': 56, '@2x': 112}

INK = (18, 33, 31, 255)  # --sc-ink (light)
PINE = (15, 92, 83, 255)  # --sc-accent
HONEY = (242, 180, 65, 255)  # --sc-secondary
CREAM = (255, 253, 248, 255)  # --sc-surface
RED = (214, 58, 47, 255)  # --sc-live
ROSE = (229, 72, 77, 255)
ORANGE = (247, 107, 21, 255)
SKY = (90, 176, 224, 255)
STROKE = 14


def pose(name: str) -> Image.Image:
    im = Image.open(BRAND / 'mascot' / f'mascot-{name}.png').convert('RGBA')
    return im.crop(im.getbbox())


def fit(im: Image.Image, box: int = W, pad: int = 8) -> Image.Image:
    """`im` scaled to fit a square `box`, centred, transparent around."""
    s = (box - 2 * pad) / max(im.size)
    im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    out = Image.new('RGBA', (box, box))
    out.alpha_composite(im, ((box - im.width) // 2, (box - im.height) // 2))
    return out


def head(name: str, left: float = 0.04, right: float = 0.96) -> Image.Image:
    """The face, antennae and headset of a pose on a round sticker: reads better at 28 px."""
    im = pose(name)
    w, h = im.size
    crop = im.crop((round(w * left), 0, round(w * right), h))
    s = (W - 40) / crop.width
    face = crop.resize((W - 40, round(crop.height * s)), Image.LANCZOS)
    ring = STROKE
    disc = Image.new('RGBA', (W, W))
    ImageDraw.Draw(disc).ellipse((ring, ring, W - ring, W - ring), fill=(226, 234, 228, 255))  # --sc-accent-soft
    disc.alpha_composite(face, (20, 30))
    mask = Image.new('L', (W, W))
    ImageDraw.Draw(mask).ellipse((ring, ring, W - ring, W - ring), fill=255)
    out = Image.new('RGBA', (W, W))
    out.paste(disc, (0, 0), mask)
    ImageDraw.Draw(out).ellipse((ring // 2, ring // 2, W - ring // 2, W - ring // 2), outline=PINE, width=ring)
    return out


def font(px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), px)


def text_badge(im: Image.Image, text: str, fill=PINE, ink=CREAM, at=(0.74, 0.80), px: int = 150) -> Image.Image:
    d = ImageDraw.Draw(im)
    f = font(px)
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=f, stroke_width=0)
    tw, th = x1 - x0, y1 - y0
    cx, cy = at[0] * W, at[1] * W
    padx, pady = px * 0.28, px * 0.2
    rect = (cx - tw / 2 - padx, cy - th / 2 - pady, cx + tw / 2 + padx, cy + th / 2 + pady)
    # keep the badge inside the canvas
    dx = max(0, -rect[0] + 4) - max(0, rect[2] - W + 4)
    dy = max(0, -rect[1] + 4) - max(0, rect[3] - W + 4)
    rect = (rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy)
    d.rounded_rectangle(rect, radius=(rect[3] - rect[1]) / 2, fill=fill, outline=INK, width=STROKE)
    d.text(((rect[0] + rect[2]) / 2 - tw / 2 - x0, (rect[1] + rect[3]) / 2 - th / 2 - y0), text, font=f, fill=ink)
    return im


def heart(im: Image.Image, cx: float, cy: float, r: float, fill=ROSE) -> Image.Image:
    d = ImageDraw.Draw(im)
    pts = []
    for i in range(120):
        t = 2 * math.pi * i / 120
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx * W + x * r / 16, cy * W - y * r / 16))
    d.polygon(pts, fill=fill, outline=INK, width=STROKE)
    # shine
    d.ellipse((cx * W - r * 0.55, cy * W - r * 0.55, cx * W - r * 0.25, cy * W - r * 0.25), fill=(255, 255, 255, 170))
    return im


def flame(im: Image.Image, cx: float, cy: float, r: float) -> Image.Image:
    d = ImageDraw.Draw(im)

    def shape(scale: float, dy: float) -> list[tuple[float, float]]:
        pts = []
        for i in range(100):
            t = 2 * math.pi * i / 100
            # teardrop pointing up, with a slight lick to the side
            x = math.sin(t) * (1 - math.cos(t)) * 0.62
            y = -math.cos(t) * 1.1
            x += 0.18 * math.sin(3 * t) * (y < 0)
            pts.append((cx * W + x * r * scale, cy * W + (y + dy) * r * scale))
        return pts

    d.polygon(shape(1.0, 0), fill=ORANGE, outline=INK, width=STROKE)
    d.polygon(shape(0.55, 0.55), fill=HONEY)
    return im


def drop(im: Image.Image, cx: float, cy: float, r: float, fill=SKY) -> Image.Image:
    d = ImageDraw.Draw(im)
    pts = []
    for i in range(100):
        t = 2 * math.pi * i / 100
        x = math.sin(t) * (1 - math.cos(t)) * 0.5
        y = -math.cos(t)
        pts.append((cx * W + x * r, cy * W + y * r))
    d.polygon(pts, fill=fill, outline=INK, width=STROKE // 2 + 2)
    return im


def sparkle(im: Image.Image, cx: float, cy: float, r: float, fill=HONEY) -> Image.Image:
    d = ImageDraw.Draw(im)
    pts = []
    for i in range(8):
        a = math.pi / 4 * i - math.pi / 2
        rr = r if i % 2 == 0 else r * 0.32
        pts.append((cx * W + math.cos(a) * rr, cy * W + math.sin(a) * rr))
    d.polygon(pts, fill=fill, outline=INK, width=STROKE // 2 + 2)
    return im


def letters(im: Image.Image, items: list[tuple[str, float, float, int]], fill=PINE) -> Image.Image:
    d = ImageDraw.Draw(im)
    for ch, x, y, px in items:
        d.text((x * W, y * W), ch, font=font(px), fill=fill, stroke_width=STROKE // 2 + 2, stroke_fill=CREAM, anchor='mm')
    return im


def onair(im: Image.Image) -> Image.Image:
    d = ImageDraw.Draw(im)
    d.ellipse((W * 0.70, W * 0.04, W * 0.94, W * 0.28), fill=RED, outline=INK, width=STROKE)
    return im


def symbol() -> Image.Image:
    im = Image.open(BRAND / 'symbol' / 'swarmcast-symbol-1024.png').convert('RGBA')
    return fit(im.crop(im.getbbox()))


# code -> builder. Codes follow the chat rule [a-z0-9_]{2,24}; keep this list short and friendly.
EMOTES: dict[str, callable] = {
    'hi': lambda: fit(pose('hello')),
    'live': lambda: fit(pose('live')),
    'sleep': lambda: fit(pose('sleep')),
    'bee': lambda: head('hello'),
    'love': lambda: heart(head('hello'), 0.78, 0.74, 120),
    'hearts': lambda: heart(heart(fit(pose('hello')), 0.18, 0.2, 70), 0.84, 0.16, 56),
    'gg': lambda: text_badge(fit(pose('hello')), 'GG'),
    'lol': lambda: text_badge(head('hello'), 'LOL', fill=HONEY, ink=INK, px=120),
    'wow': lambda: letters(head('hello'), [('!', 0.86, 0.22, 230)], fill=RED),
    'what': lambda: letters(head('live'), [('?', 0.86, 0.22, 230)], fill=PINE),
    'fire': lambda: flame(fit(pose('hello')), 0.8, 0.7, 120),
    'hype': lambda: sparkle(sparkle(sparkle(fit(pose('hello')), 0.16, 0.18, 70), 0.86, 0.14, 50), 0.88, 0.62, 44),
    'sad': lambda: drop(head('sleep'), 0.32, 0.72, 62),
    'zzz': lambda: letters(fit(pose('sleep')), [('z', 0.16, 0.30, 110), ('z', 0.28, 0.14, 84), ('Z', 0.10, 0.08, 64)]),
    'brb': lambda: text_badge(fit(pose('sleep')), 'BRB', fill=HONEY, ink=INK, at=(0.3, 0.16), px=120),
    'rec': lambda: onair(fit(pose('live'))),
    'clip': lambda: text_badge(fit(pose('live')), 'CLIP', at=(0.7, 0.84), px=110),
    'plus1': lambda: text_badge(head('hello'), '+1', fill=PINE, at=(0.78, 0.76), px=170),
    'cozy': lambda: heart(fit(pose('sleep')), 0.82, 0.2, 70),
    'swarm': symbol,
}


def main() -> None:
    sheet_path = None
    if '--sheet' in sys.argv:
        sheet_path = Path(sys.argv[sys.argv.index('--sheet') + 1])
    manifest = []
    tiles = []
    for code, build in EMOTES.items():
        im = build()
        for suffix, px in SIZES.items():
            out = im.resize((px, px), Image.LANCZOS)
            out.save(HERE / f'{code}{suffix}.webp', 'WEBP', quality=82, method=6, exact=False)
        manifest.append({'code': code, 'file': f'{code}.webp', 'file2x': f'{code}@2x.webp', 'w': 56, 'h': 56})
        tiles.append(im)
    (HERE / 'emotes.json').write_text(json.dumps({'version': 1, 'emotes': manifest}, indent=2) + '\n')
    if sheet_path:
        cols = 5
        rows = math.ceil(len(tiles) / cols)
        sheet = Image.new('RGBA', (cols * 140 + 20, rows * 160 + 20), CREAM)
        d = ImageDraw.Draw(sheet)
        for i, (code, im) in enumerate(zip(EMOTES, tiles)):
            x, y = 20 + (i % cols) * 140, 20 + (i // cols) * 160
            sheet.alpha_composite(im.resize((112, 112), Image.LANCZOS), (x, y))
            sheet.alpha_composite(im.resize((28, 28), Image.LANCZOS), (x + 112, y + 84))
            d.text((x, y + 116), f':{code}:', font=font(20), fill=INK)
        sheet.save(sheet_path)
    for suffix in SIZES:
        total = sum((HERE / f'{c}{suffix}.webp').stat().st_size for c in EMOTES)
        print(f'{len(EMOTES)} emotes{suffix or " (1x)"}: {total / 1024:.1f} KB')


if __name__ == '__main__':
    main()
