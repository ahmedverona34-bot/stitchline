"""Run the same UI actions through the Python app and the Rust engine and compare everything they produce:
every reply the window would get (state, program, stats, stitches, messages, errors), every file written
(SLW byte for byte, DXF, PLT, SVG, CSV, job files) and the prefs / autosave files.

    python tests/compare_with_python.py              all scenarios
    python tests/compare_with_python.py edits -v     one scenario, show every difference

Needs the Rust test driver (cargo build -p stitchline-engine --bin stitchline-cli, in target/engine or set
STITCHLINE_CLI) and the Python Stitchline app (not part of this repository; STITCHLINE_PY_APP, default ../../app).
STITCHLINE_EXTRA: more drawings or .stitchline jobs to compare, separated by ';'.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TAURI = os.path.dirname(HERE)
REF = os.path.join(TAURI, 'reference')
PAR = os.path.join(REF, 'parity')
DRAW = os.path.join(HERE, 'data', 'drawings')
EXTRA = [p for p in os.environ.get('STITCHLINE_EXTRA', '').split(';') if p.strip()]
CLI = os.environ.get('STITCHLINE_CLI') or os.path.join(TAURI, 'target', 'engine', 'debug', 'stitchline-cli.exe')
FIXED_TIME = '1760000000'


# ------------------------------------------------------------------ scenarios ("{out}" is each side's output folder)

def S(op, answers=None, **args):
    d = dict(op=op, args=args)
    if answers is not None:
        d['answers'] = answers
    return d


def outputs(tag):
    o = '{out}\\' + tag
    return [S('save_machine', [o + '.slw']),
            S('export', [o + '_geom.dxf'], kind='dxf', mode='geometry'), S('export', [o + '_st.dxf'], kind='dxf', mode='stitches'),
            S('export', [o + '_geom.plt'], kind='plt', mode='geometry'), S('export', [o + '_st.plt'], kind='plt', mode='stitches'),
            S('export', [o + '.svg'], kind='svg'), S('export', [o + '.csv'], kind='csv')]


LINE_TO_POINT = dict(convert=True, stitch_len=2.2, bt_start=1, bt_end=1, bt_start_rep=1, bt_end_rep=1)


def format_scenario(path):
    tag = os.path.splitext(os.path.basename(path))[0].replace(' ', '_')
    steps = [S('state'), S('open', path=path)]
    steps += outputs(tag)
    for lid in ('L1', 'L2', 'L3'):
        steps.append(S('update_layer', id=lid, fields=dict(settings=LINE_TO_POINT)))
    steps.append(S('save_machine', ['{out}\\%s_stitch.slw' % tag]))
    steps.append(S('export', ['{out}\\%s_stitch.csv' % tag], kind='csv'))
    for lid in ('L1', 'L2'):
        steps.append(S('update_layer', id=lid, fields=dict(needle=3, settings=dict(convert=False))))
        steps.append(S('laser_fix', id=lid))
    steps.append(S('save_machine', ['{out}\\%s_laser.slw' % tag]))
    steps.append(S('save', ['{out}\\%s.stitchline' % tag], as_new=True))
    steps.append(S('undo'))
    steps.append(S('redo'))
    return [dict(steps=steps)]


def edits_scenario():
    syn = os.path.join(DRAW, 'synthetic.dxf')
    st = [S('open', path=syn), S('state')]
    st += [S('move', ids=[1, 3], dx=5.5, dy=-2.25), S('rotate', ids=[4], angle=33.3), S('mirror', ids=[5, 6], axis='h'),
           S('mirror', ids=[7], axis='v'), S('scale', ids=[8], sx=1.5, sy=0.75), S('reverse', ids=[9, 10]),
           S('set_start', id=9, x=20.0, y=141.0), S('set_start', id=10, x=31.0, y=160.0), S('start_at', ids=[4, 11, 12], side='top'),
           S('start_at', ids=[5, 13], side='left'), S('start_at', ids=[14], side='right'), S('start_at', ids=[15], side='bottom'),
           S('extend', ids=[11], start=3.0, end=-4.5), S('extend', ids=[14], start=-2.0, end=6.0),
           S('set_points', id=13, pts=[[0, 200], [10.5, 210], [25, 205], [30, 190]], closed=True),
           S('split', id=16, index=7), S('split', id=17, index=30), S('merge_points', ids=[8, 9], tol=1.2),
           S('delete_short', ids=[3, 15, 22], min=5), S('join', ids=[16, 24, 19], tol=50),
           S('duplicate', ids=[12, 13], dx=5, dy=-5), S('duplicate', ids=[6], dx=0, dy=40, mh=True, mv=True),
           S('add_shape', kind='rect', x=10, y=-50, size=20, w=30, h=0), S('add_shape', kind='circle', x=60, y=-50, size=8),
           S('add_shape', kind='line', x=90, y=-50, size=25, layer='L1'), S('add_shape', kind='point', x=120, y=-50),
           S('add_layer', name=''), S('add_layer', name='Laser'), S('add_layer', name='laser'),
           S('set_layer', ids=[4, 5], layer='L2'), S('update_layer', id='L2', fields=dict(name='Circles', color='#123456', needle=2)),
           S('update_layer', id='L3', fields=dict(needle=3, output=True)), S('set_layer', ids=[17, 20], layer='L3'),
           S('group', ids=[7, 8], name='Grp', needle=3, color='#ff0000'), S('group', ids=[11], needle=2),
           S('move_group', id='L2', delta=2), S('rename_shape', id=7, name='Ellipse A'),
           S('add_mark', id=11, kind='zigzag', a=5, b=25, params=dict(width=3, span=2, shape='V', start='middle')),
           S('add_mark', id=9, kind='zigzag', a=10, b=40, params=dict(width=2.4, span=2.5, shape='W', start='left')),
           S('add_mark', id=10, kind='backtack', a=3, b=9),
           S('add_mark', id=12, kind='special', a=10, b=60),
           S('update_layer', id='L1', fields=dict(settings=dict(special_len=4.5, special_needle=True, special_speed=900))),
           S('set_ref', which='r1', id=1), S('set_ref', which='r2', id=12), S('set_ref', which='align', id=3),
           S('set_ref', which='align', id=None),
           S('insert_instruction', before=7, name='Speed', value='1200'), S('insert_instruction', before='end', name='Delay', value=0.5),
           S('insert_instruction', before=12, name='Output IO', value='3 on'), S('insert_instruction', before=12, name='Label', value='x'),
           S('insert_instruction', before=1, name='Z axis', value='12.5'),
           S('state'), S('save_machine', ['{out}\\edits1.slw']), S('export', ['{out}\\edits1.csv'], kind='csv'),
           S('reorder', ids=[12, 7, 9]), S('sort', dir='tb', spacing=15), S('save_machine', ['{out}\\edits_tb.slw']),
           S('sort', dir='bt', spacing=8, by_end=True), S('sort', dir='lr', spacing=20), S('sort', dir='rl', spacing=5),
           S('nearest'), S('save_machine', ['{out}\\edits_nearest.slw']), S('order_by_group'),
           S('move_instruction', iid=None, delta=1), S('state'), S('delete', ids=[12]), S('clear_marks', ids=[11]),
           S('copy_layer_settings', id='L1'), S('ungroup', id='L2'), S('remove_empty_groups'), S('delete_layer', id='L4'),
           S('remove_overlaps', ids=list(range(1, 60))), S('scale_all', sx=1.1, sy=0.9),
           S('rename_job', name='Edited job ✂'), S('save_machine', ['{out}\\edits_end.slw']),
           S('export', ['{out}\\edits_end.dxf'], kind='dxf', mode='geometry'), S('export', ['{out}\\edits_end.plt'], kind='plt', mode='stitches'),
           S('undo'), S('undo'), S('undo'), S('redo'), S('save', ['{out}\\edits.stitchline'])]
    # instruction ids depend on the job: move / delete the first one the program lists
    return [dict(steps=st)]


def stitch_scenario():
    syn = os.path.join(DRAW, 'synthetic.dxf')
    base = dict(convert=True, stitch_len=2.0, bt_start=2, bt_end=3, bt_start_rep=2, bt_end_rep=1, cl_start=2, cl_start_rep=2,
                cl_end=3, cl_end_rep=3, end_repeat=2, corner_slow=True, corner_angle=30, corner_slow_n=3)
    combos = [dict(corner_dense=True, corner_dense_n=2, corner_dense_f=3.0),
              dict(se_dense=True, se_dense_n=3, se_dense_f=2.5),
              dict(double_on=True, double_len=4.0, double_odd=1, double_even=0, stitch_len=1.7),
              dict(corner_slow=False, stitch_len=3.3, corner_dense=True, corner_dense_f=1.0),
              dict(stitch_len=0.05, corner_slow_n=0)]
    steps = [S('open', path=syn), S('add_mark', id=9, kind='special', a=5, b=50),
             S('add_mark', id=11, kind='zigzag', a=2, b=30, params=dict(width=3, span=1.5, shape='W', start='right')),
             S('add_mark', id=10, kind='backtack', a=1, b=12)]
    for i, c in enumerate(combos):
        steps.append(S('update_layer', id='L1', fields=dict(settings=dict(base, **c))))
        steps += [S('state'), S('save_machine', ['{out}\\combo%d.slw' % i]), S('export', ['{out}\\combo%d.csv' % i], kind='csv')]
    steps += [S('update_layer', id='L1', fields=dict(settings=dict(base, corner_slow_n=4))),
              S('set_job', values=dict(points_on=True, points_range=35, origin='tr')), S('save_machine', ['{out}\\points_tr.slw']),
              S('set_job', values=dict(origin='tl', out_scale_on=True, out_scale_x=95.5, out_scale_y=104, speed_ramp_on=True,
                                       io_positions=[dict(shape=4, port=2, at=5)], io_on_reverse=True, io_reverse_port=3, speed=2400,
                                       comp={'x-': 0.1, 'x+': 0.2, 'y-': 0.0, 'y+': 0.3, 'on': True}, unknown_key=5)),
              S('save_machine', ['{out}\\scaled_tl.slw']), S('export', ['{out}\\scaled_tl.dxf'], kind='dxf'),
              S('set_job', values=dict(origin='br', defaults={'Job start': [dict(name='Speed', value='1500')],
                                                            'Shape start': [dict(name='Output IO', value='1 on 1'), dict(name='Delay', value='20')],
                                                            'Shape end': [dict(name='Output IO', value='1 off')],
                                                            'At corners': [dict(name='Pause', value='')],
                                                            'Job end': [dict(name='Z axis', value='-1.25')]})),
              S('update_layer', id='L1', fields=dict(needle=3)), S('state'), S('save_machine', ['{out}\\events_br.slw'])]
    return [dict(steps=steps)]


def errors_scenario():
    t = os.path.join(REF, 'test.dxf')
    steps = [S('save_machine'), S('open', path=t), S('move', dx=1), S('move', ids=[1], dx='abc'), S('move', ids=[], dx=1),
             S('nope'), S('export', kind='pdf'), S('split', id=6, index=0), S('split', id=999, index=1), S('join', ids=[1], tol=0.001),
             S('ungroup', id='L1'), S('delete_layer', id='L1'), S('extend', ids=[6], start=-500, end=0),
             S('add_mark', id=6, kind='zigzag', a=1, b=1.05), S('insert_instruction', name='Fly'), S('move_instruction', iid=12345, delta=1),
             S('set_layer', ids=[1], layer='L99'), S('rename_shape', id=999, name='x'), S('add_shape', kind='star'),
             S('laser_fix', id='L9'), S('set_points', id=1, pts=[]), S('set_ref', which='r1', id=999), S('start_at', ids=[1], side='middle'),
             S('update_layer', id='L1', fields=dict(output=False)), S('save_machine'), S('update_layer', id='L1', fields=dict(output=True)),
             S('save_machine', None, drive='Q:\\'), S('save_machine', [None]), S('open', [None]), S('insert', [None]),
             S('open', path=os.path.join(DRAW, 'unsupported.edi')), S('open', path=os.path.join(DRAW, 'unknown.xyz')),
             S('open', path=os.path.join(DRAW, 'empty.dxf')), S('open', path=os.path.join(DRAW, 'broken.slw')),
             S('insert', [os.path.join(DRAW, 'mixed.plt')]), S('insert', [os.path.join(DRAW, 'synthetic.dst')]),
             S('state'), S('new'), S('undo'), S('redo'), S('ping')]
    return [dict(steps=steps)]


def session_scenario():
    p6 = os.path.join(PAR, 'p6_pens.plt')
    first = [S('state'), S('open', path=p6), S('move', ids=[1], dx=1, dy=1), S('__upload', name='p7_curve.plt', file=os.path.join(PAR, 'p7_curve.plt')),
             S('rotate', ids=[1, 2], angle=90), S('save', ['{out}\\first.stitchline']), S('scale', ids=[2], sx=2, sy=2),
             S('open', path='{out}\\first.stitchline'), S('state'), S('move', ids=[2], dx=-3, dy=0)]
    second = [S('state'), S('save_machine', ['{out}\\restored.slw']), S('save'), S('state')]
    return [dict(steps=first), dict(steps=second, restore_autosave=True)]


def scenarios():
    out = {}
    files = sorted(os.path.join(PAR, n) for n in os.listdir(PAR) if n.lower().endswith(('.dxf', '.plt')))
    files += [os.path.join(REF, 'test.dxf'), os.path.join(PAR, 'known', 's5_short.dxf'),
              os.path.join(PAR, 'p3_circles_arcs.slw'), os.path.join(PAR, 's2_corner.stitch.slw'), os.path.join(REF, 'test_default.slw')]
    files += [os.path.join(DRAW, n) for n in ('synthetic.dxf', 'synthetic.dst', 'synthetic.dsb', 'synthetic_ps.ai', 'synthetic_pdf.ai',
                                               'mixed.plt', 'mixed.hpgl')]
    files += [p for p in EXTRA if os.path.exists(p)]
    for f in files:
        out['open_' + os.path.basename(f)] = format_scenario(f)
    out['edits'] = edits_scenario()
    out['stitch'] = stitch_scenario()
    out['errors'] = errors_scenario()
    out['session'] = session_scenario()
    return out


# ------------------------------------------------------------------ running and comparing

def subst(obj, out):
    if isinstance(obj, str):
        return obj.replace('{out}', out)
    if isinstance(obj, list):
        return [subst(v, out) for v in obj]
    if isinstance(obj, dict):
        return {k: subst(v, out) for k, v in obj.items()}
    return obj


def run_side(side, scripts, root):
    home, out = os.path.join(root, side, 'home'), os.path.join(root, side, 'out')
    os.makedirs(home)
    os.makedirs(out)
    env = dict(os.environ, STITCHLINE_HOME=home, STITCHLINE_FIXED_TIME=FIXED_TIME, PYTHONDONTWRITEBYTECODE='1')
    replies = []
    for i, sc in enumerate(scripts):
        path = os.path.join(root, side, 'script%d.json' % i)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(subst(sc, out), f)
        cmd = [sys.executable, os.path.join(HERE, 'python_side.py'), path] if side == 'py' else [CLI, path]
        p = subprocess.run(cmd, env=env, capture_output=True)
        if p.returncode != 0:
            raise SystemExit('%s side failed:\n%s' % (side, p.stderr.decode('utf-8', 'replace')))
        replies += [json.loads(line) for line in p.stdout.decode('utf-8').splitlines() if line.strip()]
    return replies, home, out


def norm(v, side_paths):
    if isinstance(v, str):
        for a, b in side_paths:
            v = v.replace(a, b)
        return v
    if isinstance(v, list):
        return [norm(x, side_paths) for x in v]
    if isinstance(v, dict):
        return {norm(k, side_paths): norm(x, side_paths) for k, x in v.items()}
    return v


def diff(a, b, path, out, limit=40):
    if len(out) >= limit:
        return
    if isinstance(a, bool) or isinstance(b, bool):
        if a is not b:
            out.append('%s: %r != %r' % (path, a, b))
        return
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if float(a) != float(b):
            out.append('%s: %r != %r' % (path, a, b))
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append('%s.%s: only in %s' % (path, k, 'python' if k in a else 'rust'))
            else:
                diff(a[k], b[k], '%s.%s' % (path, k), out, limit)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append('%s: length %d != %d' % (path, len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, '%s[%d]' % (path, i), out, limit)
        return
    if a != b:
        out.append('%s: %r != %r' % (path, a, b))


def compare(name, scripts, verbose=False):
    root = tempfile.mkdtemp(prefix='stitchline_cmp_')
    try:
        rp, hp, op = run_side('py', scripts, root)
        rr, hr, orr = run_side('rs', scripts, root)
        pp = [(op, '<OUT>'), (hp, '<HOME>')]
        pr = [(orr, '<OUT>'), (hr, '<HOME>')]
        problems = []
        if len(rp) != len(rr):
            problems.append('reply count %d != %d' % (len(rp), len(rr)))
        steps = [s for sc in scripts for s in sc['steps']]
        for i, (a, b) in enumerate(zip(rp, rr)):
            d = []
            diff(norm(a, pp), norm(b, pr), 'reply', d)
            if d:
                problems.append('step %d (%s): %s' % (i, steps[i]['op'], '; '.join(d[:40 if verbose else 4])))
        fp, fr = sorted(os.listdir(op)), sorted(os.listdir(orr))
        if fp != fr:
            problems.append('files differ: python %s, rust %s' % (fp, fr))
        nfiles = 0
        for fn in sorted(set(fp) & set(fr)):
            a, b = open(os.path.join(op, fn), 'rb').read(), open(os.path.join(orr, fn), 'rb').read()
            nfiles += 1
            if fn.endswith('.stitchline'):
                d = []
                diff(norm(json.loads(a), pp), norm(json.loads(b), pr), fn, d)
                if d:
                    problems.append('file %s: %s' % (fn, '; '.join(d[:6])))
            elif a != b:
                k = next((i for i in range(min(len(a), len(b))) if a[i] != b[i]), min(len(a), len(b)))
                problems.append('file %s differs at byte %d (sizes %d, %d)' % (fn, k, len(a), len(b)))
        for fn in ('prefs.json', 'autosave.stitchline'):
            a, b = os.path.join(hp, fn), os.path.join(hr, fn)
            if os.path.exists(a) != os.path.exists(b):
                problems.append('%s exists only on one side' % fn)
            elif os.path.exists(a):
                d = []
                diff(norm(json.load(open(a, encoding='utf-8')), pp), norm(json.load(open(b, encoding='utf-8')), pr), fn, d)
                if d:
                    problems.append('%s: %s' % (fn, '; '.join(d[:6])))
        status = 'SAME' if not problems else 'DIFF'
        print('%s %-40s %3d replies, %2d files' % (status, name, len(rp), nfiles))
        for p in problems[:(100 if verbose else 8)]:
            print('     ', p)
        return not problems
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    verbose = '-v' in sys.argv
    pick = [a for a in sys.argv[1:] if not a.startswith('-')]
    ok = True
    for name, scripts in scenarios().items():
        if pick and not any(p in name for p in pick):
            continue
        ok &= compare(name, scripts, verbose)
    print('ALL SAME' if ok else 'SOME DIFFER')
    sys.exit(0 if ok else 1)
