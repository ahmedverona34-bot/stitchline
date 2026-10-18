"""Run a script of UI actions through the Python version of Stitchline (stitchline.py) without its window.

    python tests/python_side.py script.json        prints one JSON reply per step

Same script format as stitchline-cli (engine/src/bin/cli.rs). Set STITCHLINE_HOME before starting;
STITCHLINE_FIXED_TIME pins the SLW time stamp. The Python app is only imported, never changed.
"""
import json, os, shutil, sys, tempfile, time, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
# the Python Stitchline app (not part of this repository): STITCHLINE_PY_APP, or ../../app next to this project
APP = os.path.abspath(os.environ.get('STITCHLINE_PY_APP') or os.path.join(HERE, '..', '..', 'app'))
sys.dont_write_bytecode = True
sys.path.insert(0, APP)
import stitchline as app  # noqa: E402
from engine import importers, machine, ops  # noqa: E402

FIXED = os.environ.get('STITCHLINE_FIXED_TIME')
if FIXED:
    class _Time:
        def __getattr__(self, k):
            return getattr(time, k)

        @staticmethod
        def localtime(stamp=None):
            return time.localtime(int(FIXED) if stamp is None else stamp)
    machine.time = _Time()

ANSWERS = []


def _next(*a, **k):
    return ANSWERS.pop(0) if ANSWERS else None


app.ask_open = _next
app.ask_save = _next


def upload(name, raw):
    """The /api/upload branch of stitchline.Handler.do_POST."""
    folder = tempfile.mkdtemp(prefix='stitchline_')
    tmp = os.path.join(folder, name)
    with open(tmp, 'wb') as f:
        f.write(raw)
    try:
        msg = app.open_path(tmp, keep_in_recent=False)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    app.S.job.source = name
    st = app.state()
    return st, msg


def run(script):
    if script.get('restore_autosave'):
        app.restore_autosave()
    for step in script['steps']:
        ANSWERS[:] = step.get('answers', [])
        op, args = step['op'], step.get('args', {})
        try:
            if op == '__upload':
                with open(args['file'], 'rb') as f:
                    st, msg = upload(args['name'], f.read())
            else:
                st, msg = app.handle(op, args)
            if isinstance(st, dict) and 'job' in st:
                st['message'] = msg
            out = dict(status=200, body=st)
        except (ops.OpError, importers.ImportError_, ValueError, KeyError, StopIteration) as e:
            text = str(e) if not isinstance(e, (KeyError, StopIteration)) else 'That item no longer exists.'
            out = dict(status=400, body={'error': text or 'Something went wrong.'})
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            out = dict(status=500, body={'error': 'Unexpected error: %s' % e})
        print(json.dumps(out, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as f:
        run(json.load(f))
