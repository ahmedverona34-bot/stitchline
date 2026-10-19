# Draws the numbered call-outs on the real screenshots: ../screenshots/*.png -> ../annotated/*.png.
# Where each part of the window is comes from ../screenshots/rects.json, written by capture.mjs while it took the
# pictures, so the call-outs follow the interface when it changes: run capture.mjs, then this script.
# Numbers only (the manual's text explains each number), in the "thread" pink of Stitchline's logo, with a white rim.
#   python docs/user-manual/source/annotate.py
import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'screenshots')
OUT = os.path.join(HERE, '..', 'annotated')
RECTS = json.load(open(os.path.join(SRC, 'rects.json'), encoding='utf-8'))
PINK = (232, 51, 109)
PAGE = (245, 245, 244)
FONT = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 21)


def R(img, key, grow=0):
    """Rect of a part recorded for a picture; 'name' or the first 'name:<n>' (panel sections)."""
    d = RECTS[img]
    if key in d:
        b = d[key]
    else:
        ks = [k for k in d if k.split(':')[0] == key]
        if not ks:
            raise KeyError(f'{img}: no rect {key!r}; have {sorted(d)}')
        b = d[ks[0]]
    return (b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow)


def Rn(img, key, n):
    """The n-th (0-based) section named key, in top-to-bottom order."""
    d = RECTS[img]
    ks = sorted((k for k in d if k.split(':')[0] == key), key=lambda k: d[k][1])
    return tuple(d[ks[n]])


def union(*bs):
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def badge(d, cx, cy, n, r=17):
    d.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3], fill='white')
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PINK)
    t = str(n)
    w = d.textlength(t, font=FONT)
    d.text((cx - w / 2, cy - 14), t, fill='white', font=FONT)


def render(name, out, marks=(), crop=None, pad=(0, 0, 0, 0), blur=()):
    """marks: (n, box, where) with box in picture pixels; where is a side / corner of the box ('tl', 'tr', 'bl', 'br',
    'l', 'r', 't', 'b', 'il', 'ir' inside top corners) or an (x, y) point joined to the box by a leader line."""
    im = Image.open(os.path.join(SRC, name)).convert('RGB')
    for b in blur:   # hide folder paths
        b = tuple(int(v) for v in b)
        im.paste(im.crop(b).filter(ImageFilter.GaussianBlur(7)), b[:2])
    ox = oy = 0
    if crop:
        crop = tuple(int(max(0, v)) for v in crop)
        crop = (crop[0], crop[1], min(crop[2], im.width), min(crop[3], im.height))
        im = im.crop(crop)
        ox, oy = crop[0], crop[1]
    l, t, r, b = pad
    if any(pad):
        canvas = Image.new('RGB', (im.width + l + r, im.height + t + b), PAGE)
        canvas.paste(im, (l, t))
        im = canvas
    ox -= l
    oy -= t
    d = ImageDraw.Draw(im)
    for n, box, at in marks:
        bx = (box[0] - ox, box[1] - oy, box[2] - ox, box[3] - oy)
        o = (bx[0] - 3, bx[1] - 3, bx[2] + 3, bx[3] + 3)
        d.rounded_rectangle(o, radius=7, outline='white', width=6)
        d.rounded_rectangle(o, radius=7, outline=PINK, width=3)
        g = 27
        pos = {
            'tl': (o[0], o[1]), 'tr': (o[2], o[1]), 'bl': (o[0], o[3]), 'br': (o[2], o[3]),
            'l': (o[0] - g, (o[1] + o[3]) / 2), 'r': (o[2] + g, (o[1] + o[3]) / 2),
            't': ((o[0] + o[2]) / 2, o[1] - g), 'b': ((o[0] + o[2]) / 2, o[3] + g),
            'il': (o[0] + 26, o[1] + 26), 'ir': (o[2] - 26, o[1] + 26),
        }
        if isinstance(at, str):
            c = pos[at]
        else:
            c = (at[0] - ox, at[1] - oy)
            e = (min(max(c[0], o[0]), o[2]), min(max(c[1], o[1]), o[3]))
            d.line([c, e], fill='white', width=6)
            d.line([c, e], fill=PINK, width=3)
        c = (min(max(c[0], 21), im.width - 21), min(max(c[1], 21), im.height - 21))
        badge(d, *c, n)
    im.save(os.path.join(OUT, out), optimize=True)
    print(out, im.size)


def panel(name, out, keys, crop_keys=None, pad=(24, 12, 0, 0)):
    """A stage panel picture: one badge per section, at its top-left corner."""
    marks = [(i + 1, (b[0] + 4, b[1] + 3, b[2] - 4, b[3] - 3), 'tl') for i, b in enumerate(keys)]
    crop = None
    if crop_keys:
        crop = (0, crop_keys[0], 10_000, crop_keys[1])
        marks = [m for m in marks if m[1][1] >= crop_keys[0] - 4 and m[1][3] <= crop_keys[1] + 4]
    render(name, out, marks, crop=crop, pad=pad)


os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- Home
H = '01-home-first-start.png'
render(H, 'a01-home.png', [
    (1, R(H, 'brand'), 'l'), (2, R(H, 'new'), 'l'), (3, R(H, 'open'), 'l'), (4, R(H, 'quick', 6), 'tl'),
    (5, union(R(H, 'filter'), R(H, 'view')), 'tl'), (6, R(H, 'recent'), 'bl'), (7, R(H, 'start'), 't'), (8, R(H, 'tools'), 'l'),
])
H = '46-home-with-recent.png'
render(H, 'a46-home-continue.png', [(1, R(H, 'cont'), 'tl'), (2, R(H, 'back'), 'l'), (3, R(H, 'recent'), 'tl')])
H = '47-home-recent-list.png'
rc = R(H, 'recent')
render(H, 'a47-home-list.png', [(1, R(H, 'view'), 'tl'), (2, R(H, 'card'), 'tr')],
       crop=(rc[0] - 30, R(H, 'view')[1] - 30, rc[2] + 30, rc[3] + 20), blur=RECTS[H]['blur'])

# ---------------------------------------------------------------- the editor window
W = '04-arrange-after-open.png'
ins, side = R(W, 'insp'), R(W, 'side')
render(W, 'a04-window.png', [
    (1, union(R(W, 'home'), R(W, 'file')), 'l'),
    (2, R(W, 'stepbar', -2), ((R(W, 'readout')[0] + ins[2]) / 2, R(W, 'readout')[1] + 18)),
    (3, union(R(W, 'palette'), R(W, 'settings')), 'b'),
    (4, R(W, 'machine'), (R(W, 'next')[2] + 50, (R(W, 'next')[1] + R(W, 'next')[3]) / 2)),
    (5, R(W, 'winctl', -2), 'l'),
    (6, R(W, 'rail'), (R(W, 'rail')[0] - 24, R(W, 'rail')[1] + 420)),
    (7, R(W, 'side'), ((side[0] + side[2]) / 2, (side[1] + side[3]) / 2)),
    (8, R(W, 'readout'), 'b'),
    (9, R(W, 'viewbar'), 't'),
    (10, R(W, 'zoombar'), 't'),
    (11, R(W, 'insp'), ((ins[0] + ins[2]) / 2, (ins[1] + ins[3]) / 2)),
    (12, R(W, 'ifoot'), 't'),
    (13, R(W, 'toggle'), 'r'),
])
tb = R(W, 'topbar')
mid = (R(W, 'palette')[2] + R(W, 'file')[0]) / 2
render(W, 'a04-topbar-right.png', [
    (1, R(W, 'home'), 'b'), (2, R(W, 'file'), 'b'), (10, R(W, 'winctl', -2), 'b'),
], crop=(R(W, 'file')[0] - 40, 0, tb[2], tb[3]), pad=(0, 0, 0, 58))
render(W, 'a04-topbar-left.png', [
    (3, R(W, 'palette'), 'b'), (4, R(W, 'open'), 'b'), (5, R(W, 'save'), 'b'), (6, R(W, 'undo'), 'b'),
    (7, R(W, 'redo'), 'b'), (8, R(W, 'settings'), 'b'), (9, R(W, 'machine'), 'b'),
], crop=(0, 0, R(W, 'palette')[2] + 40, tb[3]), pad=(0, 0, 0, 58))
sb = R(W, 'stepbar')
half = (sb[0] + sb[2]) / 2
render(W, 'a04-stepbar-right.png', [(1, R(W, 'prev'), 'b'), (2, R(W, 'st1'), 'b')],
       crop=(R(W, 'st1')[0] - 260, sb[1], sb[2], sb[3]), pad=(0, 0, 0, 58))
render(W, 'a04-stepbar-left.png', [(3, R(W, 'st5'), 'b'), (4, R(W, 'next'), 'b')],
       crop=(sb[0], sb[1], R(W, 'st5')[2] + 260, sb[3]), pad=(0, 0, 0, 58))
S6 = '06-arrange-one-selected.png'
rail = R(S6, 'rail')
render(S6, 'a06-rail.png', [
    (i + 1, R(S6, k), (rail[0] - 50, (R(S6, k)[1] + R(S6, k)[3]) / 2))
    for i, k in enumerate(['t_select', 't_direct', 't_pan', 't_start', 't_measure', 't_add'])
], crop=(rail[0], rail[1], rail[2], R(S6, 't_add')[3] + 14), pad=(84, 0, 0, 0))
sd = R(S6, 'side')
row = R(S6, 'l2row')
below = row[3] + 150
render(S6, 'a06-layers.png', [
    (1, R(S6, 'groupSel'), 't'), (2, R(S6, 'addLayer'), 't'), (3, R(S6, 'addShape'), 't'),
    (4, R(S6, 'l2caret'), (R(S6, 'l2caret')[2] + 34, (row[1] + row[3]) / 2)),
    (5, R(S6, 'l2swatch'), ((R(S6, 'l2swatch')[0] + R(S6, 'l2swatch')[2]) / 2, below)),
    (6, R(S6, 'l2name'), ((R(S6, 'l2name')[0] + R(S6, 'l2name')[2]) / 2 - 10, below)),
    (7, R(S6, 'l2needle'), ((R(S6, 'l2needle')[0] + R(S6, 'l2needle')[2]) / 2, below)),
    (8, R(S6, 'l2switch'), ((R(S6, 'l2switch')[0] + R(S6, 'l2switch')[2]) / 2 - 30, below)),
    (9, R(S6, 'row'), (sd[0] - 40, (R(S6, 'row')[1] + R(S6, 'row')[3]) / 2)),
], crop=(sd[0], sd[1], sd[2], R(S6, 'row')[3] + 40), pad=(70, 34, 40, 60))
bb = R(S6, 'bbox')
render(S6, 'a06-selection.png', [
    (1, bb, 'tr'), (2, R(S6, 'handle'), 'r'), (3, R(S6, 'start'), 'bl'), (4, R(S6, 'row'), 'b'), (5, R(S6, 'readout'), 'b'),
], crop=(bb[0] - 90, R(S6, 'readout')[1] - 10, R(S6, 'side')[2], bb[3] + 70))
P = '44-panel-hidden.png'
render(P, 'a44-panel-hidden.png', [(1, R(P, 'toggle'), 'r')])

# ---------------------------------------------------------------- menus and tools
for src, out in [('09-canvas-context-menu-shape.png', 'a09-menu-shape.png'), ('10-canvas-context-menu-empty.png', 'a10-menu-empty.png'),
                 ('11-layer-context-menu.png', 'a11-menu-layer.png')]:
    c = R(src, 'ctx')
    render(src, out, [], crop=(c[0] - 26, c[1] - 26, c[2] + 26, c[3] + 26))
D = '13-direct-selection.png'
render(D, 'a13-direct.png', [], crop=R(D, 'shape', 30))
Mz = '14-measure-tool.png'
ln = R(Mz, 'line')
render(Mz, 'a14-measure.png', [(1, ln, 't')], crop=(ln[0] - 60, ln[1] - 120, ln[2] + 60, ln[3] + 60))

# ---------------------------------------------------------------- stage panels (every section open)
I = '08-import-panel-full.png'
panel(I, 'a08-import-panel.png', [R(I, k) for k in ['drop', 'recent', 'opening', 'res', 'scale', 'table', 'ifoot']])
A = '07-arrange-panel-full.png'
panel(A, 'a07-arrange-panel.png', [R(A, k) for k in ['move', 'rot', 'path', 'org', 'clean', 'ifoot']])
T = '16-stitch-panel-full.png'
st = [R(T, 'i-title'), Rn(T, 'sec', 0), Rn(T, 'sec', 1)] + [R(T, k) for k in ['bt', 'cl', 'corner', 'se', 'sp', 'mach', 'callout']] + [Rn(T, 'div', 0)]
cut = R(T, 'corner')[3] + 2
panel(T, 'a16-stitch-panel-1.png', st, crop_keys=(0, cut))
panel(T, 'a16-stitch-panel-2.png', st, crop_keys=(cut, R(T, 'ifoot')[1] - 4))
L = '18-laser-panel-full.png'
panel(L, 'a18-laser-panel.png', [R(L, 'i-title'), Rn(L, 'sec', 0), R(L, 'laserspeed'), R(L, 'mach'), R(L, 'callout')])
Q = '20-sequence-panel-full.png'
fq = R(Q, 'ifoot')
panel(Q, 'a20-sequence-panel.png', [R(Q, 'sort'), R(Q, 'travel'), fq], crop_keys=(R(Q, 'sort')[1] - 10, fq[3]))
O = '23-output-panel-full.png'
ok = [R(O, k) for k in ['stat-grid', 'prog', 'auto', 'file', 'export', 'ifoot']]
cut = R(O, 'prog')[3] + 2
panel(O, 'a23-output-panel-1.png', ok, crop_keys=(0, cut))
panel(O, 'a23-output-panel-2.png', ok, crop_keys=(cut, R(O, 'ifoot')[3]))

# ---------------------------------------------------------------- whole window per stage
S5 = '05-import-stage.png'
render(S5, 'a05-import.png', [(1, R(S5, 'insp'), 'ir'), (2, R(S5, 'st1'), 'b')])
S15 = '15-stitch-stage.png'
render(S15, 'a15-stitch.png', [
    (1, R(S15, 'picker'), 'tl'), (2, union(R(S15, 'kind'), R(S15, 'kind2')), 'r'), (3, R(S15, 'len'), 'r'),
])
S17 = '17-laser-layer.png'
render(S17, 'a17-laser.png', [
    (1, union(R(S17, 'kind'), R(S17, 'kind2')), 'r'), (2, R(S17, 'hint'), 'b'), (3, R(S17, 'l2needle'), 'b'),
    (4, R(S17, 'outline'), 'tr'), (5, R(S17, 'laserspeed'), 'r'),
])
S49 = '49-laser-slow-warning.png'
render(S49, 'a49-laser-slow.png', [
    (1, R(S49, 'status'), 'b'), (2, R(S49, 'warn'), 'r'), (3, R(S49, 'tiny'), 'r'), (4, R(S49, 'fix'), 'r'),
])
S51 = '51-laser-after-fix.png'
render(S51, 'a51-laser-fixed.png', [(1, R(S51, 'warn'), 'r'), (2, R(S51, 'fix'), 'r'), (3, R(S51, 'toast'), 't')])
S19 = '19-sequence-stage.png'
render(S19, 'a19-sequence.png', [(1, R(S19, 'order'), 'r'), (2, R(S19, 'sort'), 'r'), (3, R(S19, 'simulate'), 't')])
S19b = '19b-sequence-hover.png'
render(S19b, 'a19b-sequence-hover.png', [(1, R(S19b, 'focus'), 'tr')])
S21 = '21-simulation.png'
render(S21, 'a21-simulation.png', [
    (1, R(S21, 'play'), 't'), (2, R(S21, 'pos'), 't'), (3, R(S21, 'speed'), 't'), (4, R(S21, 'txt'), 't'), (5, R(S21, 'close'), 't'),
])
S22 = '22-output-stage.png'
render(S22, 'a22-output.png', [
    (1, R(S22, 'stats'), 'r'), (2, R(S22, 'prog'), 'r'), (3, R(S22, 'insrow'), 'r'), (4, R(S22, 'moverow'), 'r'),
    (5, R(S22, 'savebig'), 'r'), (6, R(S22, 'machine'), 'b'), (7, R(S22, 'next'), 'b'),
])

# ---------------------------------------------------------------- settings, find any tool
G = '40-settings-general.png'
render(G, 'a40-settings.png', [
    (1, R(G, 't1'), 'l'), (2, R(G, 't2'), 'l'), (3, R(G, 't3'), 'l'), (4, R(G, 't4'), 'l'),
    (5, R(G, 'keys'), 'l'), (6, R(G, 'reset'), 't'), (7, R(G, 'done'), 't'),
])
F = '39-command-palette-search.png'
render(F, 'a39-palette.png', [
    (1, R(F, 'q'), (-28, (R(F, 'q')[1] + R(F, 'q')[3]) / 2)), (2, R(F, 'r1'), (-28, (R(F, 'r1')[1] + R(F, 'r1')[3]) / 2)),
    (3, R(F, 'r2'), (-28, (R(F, 'r2')[1] + R(F, 'r2')[3]) / 2)), (4, R(F, 'count'), (-28, (R(F, 'count')[1] + R(F, 'count')[3]) / 2)),
], pad=(56, 0, 0, 0))
