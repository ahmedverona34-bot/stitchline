"""Write synthetic drawings that exercise every importer path (tests/data/drawings).

    python tests/make_test_drawings.py

DXF with every entity type and nested blocks, Tajima DST, Barudan DSB, Illustrator AI (PostScript and PDF).
"""
import math, os, random, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'drawings')


def dxf():
    g = []

    def e(*pairs):
        for i in range(0, len(pairs), 2):
            g.extend([str(pairs[i]), str(pairs[i + 1])])
    e(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC')
    e(0, 'SECTION', 2, 'BLOCKS')
    e(0, 'BLOCK', 8, '0', 2, 'PETAL', 70, 0, 10, 5.0, 20, 2.5, 30, 0.0, 3, 'PETAL')
    e(0, 'LINE', 8, '0', 10, 0.0, 20, 0.0, 11, 12.5, 21, 3.25)
    e(0, 'CIRCLE', 8, 'INNER', 10, 6.0, 20, 4.0, 40, 3.5)
    e(0, 'LWPOLYLINE', 8, '0', 90, 3, 70, 0, 10, 0.0, 20, 0.0, 42, 0.4142, 10, 10.0, 20, 0.0, 10, 10.0, 20, 8.0)
    e(0, 'ENDBLK', 8, '0')
    e(0, 'BLOCK', 8, '0', 2, 'FLOWER', 70, 0, 10, 0.0, 20, 0.0, 3, 'FLOWER')
    e(0, 'INSERT', 8, '0', 2, 'PETAL', 10, 20.0, 20, 0.0, 41, 1.0, 42, 1.0, 50, 0.0)
    e(0, 'INSERT', 8, 'L2', 2, 'PETAL', 10, 20.0, 20, 0.0, 41, 0.75, 42, 1.25, 50, 72.0)
    e(0, 'ENDBLK', 8, '0')
    e(0, 'ENDSEC')
    e(0, 'SECTION', 2, 'ENTITIES')
    e(0, 'LINE', 8, 'A', 10, 1.0, 20, 2.0, 30, 0.0, 11, 81.5, 21, 2.0, 31, 0.0)
    e(0, 'LINE', 8, 'A', 10, 81.5, 20, 2.0, 11, 81.5, 21, 40.25)
    e(0, 'POINT', 8, 'P', 10, 50.0, 20, 50.0)
    e(0, 'CIRCLE', 8, 'C', 10, 120.0, 20, 30.0, 40, 12.7)
    e(0, 'CIRCLE', 8, 'C', 10, 150.0, 20, 30.0, 40, 30.0)
    e(0, 'ARC', 8, 'C', 10, 60.0, 20, 90.0, 40, 25.0, 50, 300.0, 51, 45.0)
    e(0, 'ELLIPSE', 8, 'E', 10, 200.0, 20, 60.0, 11, 30.0, 21, 10.0, 40, 0.4, 41, 0.0, 42, 6.283185307179586)
    e(0, 'ELLIPSE', 8, 'E', 10, 200.0, 20, 120.0, 11, -12.0, 21, 22.0, 40, 0.6, 41, 0.5, 42, 2.75)
    e(0, 'LWPOLYLINE', 8, 'W', 90, 4, 70, 1, 10, 0.0, 20, 100.0, 10, 40.0, 20, 100.0, 42, -0.5, 10, 40.0, 20, 140.0, 10, 0.0, 20, 140.0, 42, 1.0)
    e(0, 'LWPOLYLINE', 8, 'W', 90, 5, 70, 0, 10, 0.0, 20, 160.0, 10, 3.0, 20, 161.0, 10, 6.0, 20, 159.0, 10, 9.0, 20, 162.0, 42, 0.2, 10, 30.0, 20, 160.0)
    knots = [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1]
    e(0, 'SPLINE', 8, 'S', 70, 8, 71, 3, 72, len(knots), 73, 7, *[v for k in knots for v in (40, k)],
      *[v for x, y in [(100, 150), (110, 180), (130, 140), (150, 190), (170, 150), (180, 170), (200, 160)] for v in (10, x, 20, y, 30, 0)])
    e(0, 'SPLINE', 8, 'S', 70, 1, 71, 2, 10, 220.0, 20, 150.0, 10, 240.0, 20, 190.0, 10, 260.0, 20, 150.0, 10, 240.0, 20, 140.0)
    e(0, 'SPLINE', 8, 'S', 70, 0, 71, 3, 11, 0.0, 21, 200.0, 11, 10.0, 21, 210.0, 11, 25.0, 21, 205.0)
    e(0, 'POLYLINE', 8, 'OLD', 66, 1, 70, 1, 10, 0.0, 20, 0.0)
    for x, y, b in [(300, 0, 0), (340, 0, 0.3), (340, 30, 0), (300, 30, 0)]:
        e(0, 'VERTEX', 8, 'OLD', 10, x, 20, y, 42, b)
    e(0, 'VERTEX', 8, 'OLD', 70, 16, 10, 999, 20, 999)
    e(0, 'SEQEND', 8, 'OLD')
    e(0, 'POLYLINE', 8, 'OLD', 66, 1, 70, 0)
    for x, y in [(300, 50), (310, 60), (320, 50), (330, 60)]:
        e(0, 'VERTEX', 8, 'OLD', 10, x, 20, y)
    e(0, 'SEQEND', 8, 'OLD')
    e(0, 'INSERT', 8, 'B', 2, 'FLOWER', 10, 400.0, 20, 100.0, 41, 2.0, 42, 2.0, 50, 15.0)
    e(0, 'INSERT', 8, 'B', 2, 'PETAL', 10, 400.0, 20, 0.0)
    e(0, 'INSERT', 8, 'B', 2, 'MISSING', 10, 0.0, 20, 0.0)
    e(0, 'LINE', 8, 'A', 10, 1.0, 20, 2.0, 11, 81.5, 21, 2.0)          # an exact copy (removed on open)
    e(0, 'LINE', 8, 'A', 10, 81.5, 20, 40.25, 11, 60.0, 21, 40.27)     # joins the open lines
    e(0, 'ENDSEC', 0, 'EOF')
    return ('\r\n'.join(g) + '\r\n').encode('ascii')


def dst():
    rnd = random.Random(7)
    head = b'LA:SAMPLE'.ljust(512, b' ')

    def enc(dx, dy, flags=0):
        b0 = b1 = b2 = 0
        b2 |= 0x03 | flags
        for val, bits in ((dx, ((81, 2, 2, 3), (27, 1, 2, 3), (9, 0, 2, 3), (3, 1, 0, 1), (1, 0, 0, 1))),):
            pass
        # straightforward balanced-ternary encoding
        def tern(v):
            out = {}
            for w in (81, 27, 9, 3, 1):
                if v > w // 2:
                    out[w] = 1
                    v -= w
                elif v < -(w // 2):
                    out[w] = -1
                    v += w
                else:
                    out[w] = 0
            return out
        tx, ty = tern(dx), tern(dy)
        xb = {1: (0, 0, 1), 9: (0, 2, 3), 3: (1, 0, 1), 27: (1, 2, 3), 81: (2, 2, 3)}
        yb = {1: (0, 7, 6), 9: (0, 5, 4), 3: (1, 7, 6), 27: (1, 5, 4), 81: (2, 5, 4)}
        bs = [b0, b1, b2]
        for w, (byte, pos, neg) in xb.items():
            if tx[w] == 1:
                bs[byte] |= 1 << pos
            elif tx[w] == -1:
                bs[byte] |= 1 << neg
        for w, (byte, pos, neg) in yb.items():
            if ty[w] == 1:
                bs[byte] |= 1 << pos
            elif ty[w] == -1:
                bs[byte] |= 1 << neg
        return bytes(bs)
    body = b''
    for color in range(3):
        for _ in range(4):
            body += enc(rnd.randint(-100, 100), rnd.randint(-100, 100), 0x80)        # jump
            for _ in range(rnd.randint(5, 30)):
                body += enc(rnd.randint(-40, 40), rnd.randint(-40, 40))
        body += enc(0, 0, 0xC0)                                                      # color change
    body += b'\x00\x00\xF3'
    return head + body


def dsb():
    rnd = random.Random(11)
    head = b'LA:SAMPLE'.ljust(512, b' ')
    body = b''
    for color in range(2):
        for _ in range(3):
            body += bytes([0x01 | 0x20, rnd.randint(0, 120), rnd.randint(0, 120)])    # move
            for _ in range(rnd.randint(4, 25)):
                c = 0x00 | (0x40 if rnd.random() < 0.5 else 0) | (0x20 if rnd.random() < 0.5 else 0)
                body += bytes([c, rnd.randint(0, 60), rnd.randint(0, 60)])
            body += bytes([0x02, 0, 0])                                               # trim
        body += bytes([0xE9, 0, 0])                                                   # color change
    body += bytes([0xF8, 0, 0])
    return head + body


PS_ART = b'''%!PS-Adobe-3.0
%%Creator: Adobe Illustrator(R) 8.0
%%EndSetup
0 g 1 w
100 100 m 200 100 l 200 180 L 100 180 l h S
250 100 m 300 160 350 40 400 100 c 450 160 v 500 100 520 140 y s
[3 2] 0 d (text (with) parens) pop /Name pop
50 300 120 60 re f
600 100 m 650 150 l 700 100 l b
% a comment 1 2 m
800 100 m 820 120 l 840 100 l n
900 100 m 950 130 l
'''


def ai_ps():
    return PS_ART


def ai_pdf():
    content = b'q 1 0 0 1 0 0 cm\n10 10 m 110 10 l 110 90 l 10 90 l h S\n150 20 m 180 80 220 -20 260 40 c S\n300 10 50 50 re f\nQ\n'
    comp = zlib.compress(content)
    img = b'\x00' * 64
    parts = [b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n',
             b'1 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Length 64 >>\nstream\n' + img + b'\nendstream\nendobj\n',
             b'2 0 obj\n<< /Length 20 >>\nstream\nBT /F1 12 Tf ET\n\nendstream\nendobj\n',
             b'3 0 obj\n<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(comp) + comp + b'\nendstream\nendobj\n',
             b'trailer\n<< /Root 4 0 R >>\n%%EOF\n']
    return b''.join(parts)


def plt_mixed():
    out = ['IN', 'SP1', 'PU0,0', 'PD400,0,400,400,0,400,0,0', 'PU800,800', 'PR', 'PD200,0,0,200,-200,0', 'PA', 'SP2',
           'PU1000 1000', 'PD 1200,1000 1200,1200', 'LBLABEL TEXT\x03', 'SP1', 'PD1400,1400', 'PU', 'SP0']
    return (';\n'.join(out) + ';\n').encode('ascii')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, data in [('synthetic.dxf', dxf()), ('synthetic.dst', dst()), ('synthetic.dsb', dsb()), ('synthetic_ps.ai', ai_ps()),
                       ('synthetic_pdf.ai', ai_pdf()), ('mixed.plt', plt_mixed()), ('mixed.hpgl', plt_mixed()), ('unsupported.edi', b'x'),
                       ('unknown.xyz', b'x'), ('empty.dxf', b'0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n'), ('broken.slw', b'\x00' * 100)]:
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
    print('written to', OUT)
