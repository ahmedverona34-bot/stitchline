"""Dump the Python engine's SLW records for every parity case (fixed time stamp) for the Rust parity test.

    python tests/dump_python_parity.py      writes tests/data/parity_python.json

Needs the Python Stitchline app (not part of this repository): set STITCHLINE_PY_APP to its folder
(default ../../app). Uses its tests/parity.py job setup and machine.build_records, read only.
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.environ.get('STITCHLINE_PY_APP') or os.path.join(HERE, '..', '..', 'app'))
REBUILD = os.path.dirname(HERE)                  # this project: paths in the output are relative to it
sys.dont_write_bytecode = True          # leave the Python app as it is
sys.path.insert(0, APP)
sys.path.insert(0, os.path.join(APP, 'tests'))
import parity  # noqa: E402
from engine import machine, stitches  # noqa: E402

STAMP = 1760000000


def rel(p):
    return os.path.relpath(p, REBUILD).replace(os.sep, '/')


def case(src, ref_path, save_name=None):
    ref = parity.read_ref(ref_path)
    j = parity.job_like_original(src, ref_path.endswith('.stitch.slw'))
    st = stitches.stitch_job(j)
    parity.align_order(j, st, ref)
    name = save_name or os.path.basename(ref_path)
    recs = machine.build_records(j, st, name, stamp=STAMP)
    return dict(src=rel(src), ref=rel(ref_path), save_name=name, order=j.order, records=[list(r) for r in recs])


if __name__ == '__main__':
    out = []
    folder = os.path.join(REBUILD, 'reference', 'parity')
    for n in sorted(os.listdir(folder)):
        if not n.lower().endswith(('.dxf', '.plt')):
            continue
        src = os.path.join(folder, n)
        for refp in (os.path.splitext(src)[0] + '.slw', os.path.splitext(src)[0] + '.stitch.slw'):
            if os.path.exists(refp):
                out.append(case(src, refp))
    ref = os.path.join(REBUILD, 'reference')
    out.append(case(os.path.join(ref, 'test.dxf'), os.path.join(ref, 'test_default.slw'), 'test_default.klw.slw'))
    dest = os.path.join(HERE, 'data', 'parity_python.json')
    with open(dest, 'w') as f:
        json.dump(dict(stamp=STAMP, cases=out), f)
    print('%d cases -> %s' % (len(out), dest))
