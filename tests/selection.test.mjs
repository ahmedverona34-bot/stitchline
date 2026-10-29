// Unit tests of ui/selection.js, the geometry of the black (V) and white (A) arrows.
//   node --test tests/selection.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const SL = createRequire(import.meta.url)('../ui/selection.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);
const box = [10, 5, 50, 25];                     // 40 x 20 mm, y up
const mapBox = (t, bb = box) => SL.applyBox(t, bb);

test('move is a pure translation: every point gets the same offset', () => {
  const t = SL.translation(3.5, -2);
  assert.equal(SL.isScale(t), false);
  const pts = [[0, 0], [1, 2], [-4.25, 7], [1e6, -1e6]];
  const out = pts.map(([x, y]) => SL.apply(t, x, y));
  pts.forEach(([x, y], i) => { near(out[i][0] - x, 3.5); near(out[i][1] - y, -2); });
  // relative geometry (segment vectors) is unchanged
  for (let i = 1; i < pts.length; i++) {
    near(out[i][0] - out[i - 1][0], pts[i][0] - pts[i - 1][0]);
    near(out[i][1] - out[i - 1][1], pts[i][1] - pts[i - 1][1]);
  }
});

test('corner handle scales about the opposite corner', () => {
  // drag the top right corner (ne) 20 mm right and 10 mm up: 60 x 30, bottom left stays
  const t = SL.resize(box, 'ne', 20, 10);
  assert.deepEqual([t.ax, t.ay], [10, 5]);
  near(t.sx, 1.5); near(t.sy, 1.5);
  const b = mapBox(t); near(b[0], 10); near(b[1], 5); near(b[2], 70); near(b[3], 35);
  // bottom left corner (sw) dragged: the top right corner is the anchor
  const u = SL.resize(box, 'sw', -10, 5);
  assert.deepEqual([u.ax, u.ay], [50, 25]);
  const c = mapBox(u); near(c[0], 0); near(c[1], 10); near(c[2], 50); near(c[3], 25);
});

test('edge handles change one axis only', () => {
  const e = SL.resize(box, 'e', 40, 999);        // vertical pointer movement is ignored
  near(e.sx, 2); near(e.sy, 1);
  const be = mapBox(e); near(be[0], 10); near(be[2], 90); near(be[1], 5); near(be[3], 25);
  const n = SL.resize(box, 'n', 999, -10);       // top edge down by 10: half the height, bottom fixed
  near(n.sx, 1); near(n.sy, 0.5);
  const bn = mapBox(n); near(bn[1], 5); near(bn[3], 15); near(bn[0], 10); near(bn[2], 50);
  const w = SL.resize(box, 'w', 10, 0);          // left edge in by 10, right edge fixed
  const bw = mapBox(w); near(bw[0], 20); near(bw[2], 50);
  const s = SL.resize(box, 's', 0, -5);          // bottom edge down by 5, top fixed
  const bs = mapBox(s); near(bs[1], 0); near(bs[3], 25);
});

test('Shift keeps proportions, Alt resizes from the centre', () => {
  const p = SL.resize(box, 'se', 40, -2, true);  // the larger change wins
  near(p.sx, p.sy); near(p.sx, 2);
  const pe = SL.resize(box, 'e', 20, 0, true);   // an edge with Shift scales both axes about the centre of the other
  near(pe.sx, 1.5); near(pe.sy, 1.5); near(pe.ay, 15);
  const a = SL.resize(box, 'e', 10, 0, false, true);
  near(a.ax, 30); near(a.sx, 1.5);
  const ba = mapBox(a); near((ba[0] + ba[2]) / 2, 30); near(ba[2] - ba[0], 60);
});

test('a resize never flips or collapses the box', () => {
  for (const [k, dx, dy] of [['e', -100, 0], ['ne', -40, -20], ['w', 40, 0], ['n', 0, -20], ['se', -1000, 1000]]) {
    const t = SL.resize(box, k, dx, dy);
    assert.ok(t.sx > 0 && t.sy > 0, `${k} flips`);
    const b = mapBox(t);
    assert.ok(b[2] - b[0] >= SL.MIN_SIZE - 1e-12 && b[3] - b[1] >= SL.MIN_SIZE - 1e-12, `${k} collapses`);
    assert.ok([t.sx, t.sy, t.ax, t.ay].every(Number.isFinite));
  }
  const p = SL.resize(box, 'ne', -40, -20, true);
  near(p.sx, p.sy, 'proportional stays proportional when clamped');
});

test('zero-width and zero-height boxes are safe', () => {
  const vline = [10, 0, 10, 20], hline = [0, 3, 30, 3], dot = [4, 4, 4, 4];
  assert.deepEqual(SL.visibleHandles(vline, 0, 200), ['n', 's']);
  assert.deepEqual(SL.visibleHandles(hline, 300, 0), ['e', 'w']);
  assert.deepEqual(SL.visibleHandles(dot, 0, 0), []);
  const t = SL.resize(vline, 'n', 5, 20);        // stretches the length, width stays 0
  near(t.sx, 1); near(t.sy, 2);
  const c = SL.resize(vline, 'ne', 5, 20);       // a corner of a line only scales the axis it has
  assert.ok([t.sx, t.sy, c.sx, c.sy].every(Number.isFinite));
  near(c.sx, 1);
  const tp = SL.resize(hline, 'e', 30, 0, true); // proportional on a flat line: finite, length doubles
  near(tp.sx, 2); assert.ok(Number.isFinite(tp.sy));
});

test('small boxes keep only their corner handles', () => {
  assert.equal(SL.visibleHandles(box, 400, 200).length, 8);
  assert.deepEqual(SL.visibleHandles(box, 12, 200), ['nw', 'ne', 'e', 'se', 'sw', 'w']);
  assert.deepEqual(SL.visibleHandles(box, 12, 10), ['nw', 'ne', 'se', 'sw']);
});

test('handle positions: north is the top (larger y)', () => {
  assert.deepEqual(SL.handlePos(box, 'nw'), [10, 25]);
  assert.deepEqual(SL.handlePos(box, 'se'), [50, 5]);
  assert.deepEqual(SL.handlePos(box, 'e'), [50, 15]);
  assert.deepEqual(SL.handlePos(box, 's'), [30, 5]);
  for (const h of SL.HANDLES) assert.ok(SL.CURSOR[h], h);
});

test('the resize the engine is asked for maps every point like the preview', () => {
  // engine 'scale' {sx, sy, ox, oy}: p -> o + (p - o) * s ; the preview uses SL.apply with dx = dy = 0
  const t = SL.resize(box, 'nw', -7, 3, false, false);
  assert.equal(t.dx, 0); assert.equal(t.dy, 0);
  for (const [x, y] of [[10, 5], [50, 25], [33.3, 11.1]]) {
    const [u, v] = SL.apply(t, x, y);
    near(u, t.ax + (x - t.ax) * t.sx); near(v, t.ay + (y - t.ay) * t.sy);
  }
});

test('marquee picks every shape it touches, not only shapes fully inside', () => {
  const band = [0, 0, 10, 10];
  const through = [[-5, 5], [15, 5]];               // straight through, both ends outside
  assert.equal(SL.touchesBox(through, false, band), true, 'line through the box');
  assert.equal(SL.insideBox(through, band), false, 'Alt: not fully inside, so not picked');
  assert.equal(SL.touchesBox([[2, 2], [30, 40]], false, band), true, 'one end inside');
  assert.equal(SL.touchesBox([[-5, 16], [16, -5]], false, band), true, 'diagonal through the box');
  assert.equal(SL.touchesBox([[11, 20], [20, 11]], false, band), false, 'diagonal outside a corner');
  assert.equal(SL.touchesBox([[-5, 8], [3, 16]], false, band), false, 'passes just outside the top left corner');
  assert.equal(SL.touchesBox([[-5, 12], [15, 12]], false, band), false, 'line above the box');
  assert.equal(SL.touchesBox([[-5, 10], [15, 10]], false, band), true, 'line on the edge counts');
});

test('marquee and closed shapes: the closing segment counts, an outline around the box does not', () => {
  const band = [4, 4, 6, 6];
  assert.equal(SL.touchesBox([[0, 0], [10, 0], [10, 10], [0, 10]], true, band), false, 'square around the box');
  const U = [[0, 5], [0, -5], [10, -5], [10, 5]];    // open U below the box; closing (10,5) -> (0,5) runs through it
  assert.equal(SL.touchesBox(U, false, band), false, 'open: no segment reaches the box');
  assert.equal(SL.touchesBox(U, true, band), true, 'closed: the closing segment does');
});

test('marquee and single points', () => {
  assert.equal(SL.touchesBox([[5, 5]], false, [0, 0, 10, 10]), true);
  assert.equal(SL.touchesBox([[11, 5]], false, [0, 0, 10, 10]), false);
  assert.equal(SL.touchesBox([], false, [0, 0, 10, 10]), false);
  assert.equal(SL.insideBox([[5, 5]], [0, 0, 10, 10]), true);
});

test('a straight line cut in half is found as split, a corner is not', () => {
  const shapes = [
    { id: 1, layer: 'a', pts: [[100, 100], [400, 100]] },          // the two halves of split-line.svg
    { id: 2, layer: 'a', pts: [[400, 100], [700, 100]] },
    { id: 3, layer: 'a', pts: [[700, 100], [700, 300]] },          // meets the line at a right angle
    { id: 4, layer: 'b', pts: [[100, 100], [-200, 100]] },         // carries straight on, but on another layer
    { id: 5, layer: 'a', pts: [[0, 0], [10, 0], [10, 10]], closed: true },
  ];
  const m = SL.splitLines(shapes);
  assert.deepEqual([...m.keys()].sort(), [1, 2]);
  assert.deepEqual(m.get(1).slice().sort(), [1, 2]);
});

test('pieces drawn against each other, a gentle bend and a chain of three are split; a gap is not', () => {
  const m = SL.splitLines([
    { id: 1, layer: 'a', pts: [[0, 0], [10, 0]] },
    { id: 2, layer: 'a', pts: [[20, 1], [10.01, 0]] },             // drawn backwards, 0.01 mm off, bends ~6°
    { id: 3, layer: 'a', pts: [[20, 1], [30, 2]] },
    { id: 4, layer: 'a', pts: [[30.5, 2], [40, 3]] },              // 0.5 mm gap: really apart
  ]);
  assert.deepEqual(m.get(1).slice().sort(), [1, 2, 3]);
  assert.equal(m.has(4), false);
});
