#!/usr/bin/env python3
"""Branding image fixtures (plan U6). Run with Pillow 12: python3 make.py <out-dir>.
The files are committed; this script only re-creates them. Every "with metadata" file carries
markers (GPS, camera, comments, text, ICC, XMP) the server stage must remove."""
import io, os, struct, sys, zlib
from PIL import Image, PngImagePlugin, ImageCms

out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(__file__)
os.makedirs(out, exist_ok=True)

exif = Image.Exif()
exif[0x010F] = 'MARKER-CAMERA'
exif[0x0110] = 'MARKER-MODEL'
exif[0x8825] = {1: 'N', 2: (22.0, 54.0, 30.0), 3: 'W', 4: (43.0, 12.0, 0.0)}
icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/">MARKER-XMP</rdf:RDF></x:xmpmeta>'


def pic(w, h, mode='RGB'):
    img = Image.new(mode, (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            v = ((x * 7) ^ (y * 13)) & 255
            px[x, y] = (v, 255 - v, (x + y) & 255) if mode == 'RGB' else (v, 255 - v, (x + y) & 255, 200)
    return img


def save(name, data):
    with open(os.path.join(out, name), 'wb') as f:
        f.write(data)


def jpeg(img, **kw):
    b = io.BytesIO()
    img.save(b, 'JPEG', quality=80, **kw)
    return b.getvalue()


def png(img, **kw):
    b = io.BytesIO()
    img.save(b, 'PNG', **kw)
    return b.getvalue()


def webp(img, **kw):
    b = io.BytesIO()
    img.save(b, 'WEBP', quality=80, **kw)
    return b.getvalue()


banner = pic(1280, 320)
avatar = pic(256, 256, 'RGBA')
fav = pic(32, 32, 'RGBA')

save('banner-meta.jpg', jpeg(banner, exif=exif.tobytes(), comment=b'MARKER-COMMENT', icc_profile=icc))
save('banner-progressive.jpg', jpeg(banner, progressive=True, exif=exif.tobytes()))
save('banner-cmyk.jpg', jpeg(pic(1280, 320).convert('CMYK')))
save('banner-wrong-size.jpg', jpeg(pic(1200, 300)))
meta = PngImagePlugin.PngInfo()
meta.add_text('Author', 'MARKER-TEXT')
meta.add_text('Comment', 'MARKER-ZTXT', zip=True)
meta.add_itxt('XML:com.adobe.xmp', xmp.decode())
save('avatar-meta.png', png(avatar, pnginfo=meta, exif=exif.tobytes(), icc_profile=icc))
save('avatar-16bit.png', png(Image.new('I;16', (256, 256), 1000)))
save('fav32.png', png(fav))
save('banner-meta.webp', webp(banner, exif=exif.tobytes(), icc_profile=icc, xmp=xmp))
save('avatar-alpha.webp', webp(avatar, exif=exif.tobytes()))
save('avatar-lossless.webp', webp(avatar, lossless=True, exif=exif.tobytes()))
frames = [pic(256, 256, 'RGBA'), pic(256, 256, 'RGBA').rotate(90)]
b = io.BytesIO()
frames[0].save(b, 'PNG', save_all=True, append_images=frames[1:])
save('avatar-apng.png', b.getvalue())
b = io.BytesIO()
frames[0].save(b, 'WEBP', save_all=True, append_images=frames[1:])
save('avatar-animated.webp', b.getvalue())

# Hand-made PNGs: interlaced, a 20,000² IHDR bomb, and an IDAT that inflates to more than declared.
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)


def raw_png(w, h, interlace=0, extra=0):
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, interlace)
    row = b'\x00' + b'\x80' * (w * 3)
    data = zlib.compress(row * h + b'\x00' * extra, 9)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', data) + chunk(b'IEND', b'')


save('avatar-interlaced.png', raw_png(256, 256, interlace=1))
save('bomb.png', raw_png(20000, 20000)[:200])
save('avatar-overflow.png', raw_png(256, 256, extra=100000))
good = raw_png(256, 256)
bad_crc = bytearray(good)
bad_crc[30] ^= 0xff
save('avatar-badcrc.png', bytes(bad_crc))
save('avatar-trailing.png', good + b'MARKER-TRAILING' * 10)
print('ok')
