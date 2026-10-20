"""Draws project.ico, the icon of Stitchline project files (.stitchline): an Adobe-style document (a dark page with
a folded corner) carrying the app's pink "Sl" monogram, like Ps / Ai, and a stitch line under it.
    python src-tauri/icons/project-icon.py
Each size is drawn 8x larger and scaled down; 16-32 px leave out the stitch line and use a bigger monogram.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

PINK, WHITE = (255, 90, 140, 255), (244, 244, 246, 255)
TOP, BOTTOM = (44, 44, 49), (27, 27, 30)
FONT = r"C:\Windows\Fonts\segoeuib.ttf"
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 8


def page(s, x0, y0, x1, y1, fold, r):
    """The page outline (folded top-right corner, rounded other corners) as a polygon, in s-scaled units."""
    pts = [(x0 + r, y0), (x1 - fold, y0), (x1, y0 + fold)]
    def arc(cx, cy, a0, a1):
        return [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(a0, a1 + 1, 5)]
    pts += arc(x1 - r, y1 - r, 0, 90) + arc(x0 + r, y1 - r, 90, 180) + arc(x0 + r, y0 + r, 180, 270)
    return [(x * s, y * s) for x, y in pts]


def draw(size):
    s = size * SS / 256  # design units: a 256 x 256 grid
    small = size <= 32
    img = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    x0, y0, x1, y1 = (34, 6, 222, 250) if small else (40, 12, 216, 244)
    fold, r = (64, 18) if small else (58, 16)
    outline = page(s, x0, y0, x1, y1, fold, r)
    # vertical gradient through a mask
    grad = Image.new("RGBA", img.size)
    gd = ImageDraw.Draw(grad)
    for y in range(img.size[1]):
        t = y / img.size[1]
        gd.line([(0, y), (img.size[0], y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    mask = Image.new("L", img.size)
    ImageDraw.Draw(mask).polygon(outline, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    d.line(outline + [outline[0]], fill=PINK[:3] + (110,), width=max(1, round((8 if small else 3) * s)), joint="curve")
    # the folded corner
    fx = x1 - fold
    d.polygon([(fx * s, y0 * s), (x1 * s, (y0 + fold) * s), ((fx + 16) * s, (y0 + fold) * s)], fill=PINK)
    d.polygon([(fx * s, y0 * s), ((fx + 16) * s, (y0 + fold) * s), (fx * s, (y0 + fold - 16) * s)], fill=PINK)
    d.pieslice([(fx * s, (y0 + fold - 32) * s), ((fx + 32) * s, (y0 + fold) * s)], 90, 180, fill=PINK)
    # the monogram
    font = ImageFont.truetype(FONT, round((150 if small else 112) * s))
    cy = (y0 + y1) / 2 + (18 if small else 6)
    d.text(((x0 + x1) / 2 * s, cy * s), "Sl", font=font, fill=PINK, anchor="mm")
    if not small:
        w = round(11 * s)
        y = 206 * s
        for a, b, c in ((70, 92, PINK), (106, 128, PINK), (142, 186, WHITE)):
            d.line([(a * s, y), (b * s, y)], fill=c, width=w)
            for xx in (a, b):
                d.ellipse([(xx * s - w / 2, y - w / 2), (xx * s + w / 2, y + w / 2)], fill=c)
    return img.resize((size, size), Image.LANCZOS)


here = os.path.dirname(os.path.abspath(__file__))
imgs = [draw(n) for n in SIZES]
imgs[-1].save(os.path.join(here, "project.ico"), format="ICO", sizes=[(n, n) for n in SIZES], append_images=imgs[:-1])
print("wrote project.ico")
