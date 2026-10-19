/* Stitchline: geometry of the selection tools, kept apart from app.js so it can be tested with Node.
   Coordinates are drawing millimetres with y up, as in the engine. A transform is
   { ax, ay, sx, sy, dx, dy }: p -> (ax + (x - ax) * sx + dx, ay + (y - ay) * sy + dy), the same map the
   engine's 'move' (dx, dy) and 'scale' about (ox, oy) = (ax, ay) apply to every point of a shape. */
(() => {
  'use strict';
  const MIN_SIZE = 0.01;                 // mm: a resize never makes the box smaller than this, and never flips it
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const CURSOR = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
  const EPS = 1e-9;

  const identity = () => ({ ax: 0, ay: 0, sx: 1, sy: 1, dx: 0, dy: 0 });
  const translation = (dx, dy) => ({ ax: 0, ay: 0, sx: 1, sy: 1, dx, dy });
  const apply = (t, x, y) => [t.ax + (x - t.ax) * t.sx + t.dx, t.ay + (y - t.ay) * t.sy + t.dy];
  const isScale = t => !!t && (t.sx !== 1 || t.sy !== 1);

  /** Bounding box [x0, y0, x1, y1] after a transform (the map keeps boxes axis-aligned). */
  function applyBox(t, bb) {
    const [a, b] = apply(t, bb[0], bb[1]), [c, d] = apply(t, bb[2], bb[3]);
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }

  /** Which handles a box shows. A box with no width has no left / right handles (nothing to stretch), and a box
      that is small on screen keeps only its corners so the handles stay big enough to grab. */
  function visibleHandles(bb, screenW, screenH, minSpan = 24) {
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    if (w < EPS && h < EPS) return [];
    if (w < EPS) return ['n', 's'];
    if (h < EPS) return ['e', 'w'];
    return HANDLES.filter(k => !((k === 'n' || k === 's') && screenW < minSpan) && !((k === 'e' || k === 'w') && screenH < minSpan));
  }

  /** Handle position in drawing coordinates. North is the top of the screen, which is the larger y. */
  function handlePos(bb, k) {
    const [x0, y0, x1, y1] = bb;
    const x = k.includes('w') ? x0 : k.includes('e') ? x1 : (x0 + x1) / 2;
    const y = k.includes('n') ? y1 : k.includes('s') ? y0 : (y0 + y1) / 2;
    return [x, y];
  }

  /** Transform for dragging handle k of box bb by (dx, dy) mm.
      Corners scale both axes about the opposite corner, edges one axis about the opposite edge.
      proportional (Shift): same factor on both axes. fromCentre (Alt): about the centre of the box. */
  function resize(bb, k, dx, dy, proportional = false, fromCentre = false) {
    const [x0, y0, x1, y1] = bb;
    const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const t = { ax: cx, ay: cy, sx: 1, sy: 1, dx: 0, dy: 0 };
    const hasX = (k.includes('e') || k.includes('w')) && w > EPS;
    const hasY = (k.includes('n') || k.includes('s')) && h > EPS;
    if (hasX) {
      const edge = k.includes('e') ? x1 : x0;
      t.ax = fromCentre ? cx : (k.includes('e') ? x0 : x1);
      t.sx = (edge + dx - t.ax) / (edge - t.ax);
    }
    if (hasY) {
      const edge = k.includes('n') ? y1 : y0;
      t.ay = fromCentre ? cy : (k.includes('n') ? y0 : y1);
      t.sy = (edge + dy - t.ay) / (edge - t.ay);
    }
    if (proportional && (hasX || hasY)) {
      const s = hasX && hasY ? (Math.abs(t.sx - 1) >= Math.abs(t.sy - 1) ? t.sx : t.sy) : hasX ? t.sx : t.sy;
      t.sx = t.sy = s;
    }
    // never flip or collapse the box (a flip is Mirror, a collapse would lose the shape)
    const lo = Math.max(w > EPS ? MIN_SIZE / w : 0, h > EPS ? MIN_SIZE / h : 0);
    if (proportional) { const s = Math.max(t.sx, lo); t.sx = t.sy = s; }
    else {
      if (w > EPS) t.sx = Math.max(t.sx, MIN_SIZE / w);
      if (h > EPS) t.sy = Math.max(t.sy, MIN_SIZE / h);
    }
    if (!Number.isFinite(t.sx) || w <= EPS && !proportional) t.sx = 1;
    if (!Number.isFinite(t.sy) || h <= EPS && !proportional) t.sy = 1;
    return t;
  }

  /** Does the segment a-b reach into the box [x0, y0, x1, y1] (edges included)? Liang–Barsky clipping. */
  function segmentTouchesBox(a, b, bb) {
    const [x0, y0, x1, y1] = bb, dx = b[0] - a[0], dy = b[1] - a[1];
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
      if (p === 0) { if (q < 0) return false; continue; }      // parallel to this edge and outside it
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  }

  /** Marquee rule of both arrows (as in Illustrator): a shape is picked when any part of it is inside the box,
      a point or a piece of a line crossing it. Closed shapes include the segment back to the start. */
  function touchesBox(P, closed, bb) {
    const n = P.length;
    if (!n) return false;
    if (n === 1) return P[0][0] >= bb[0] && P[0][0] <= bb[2] && P[0][1] >= bb[1] && P[0][1] <= bb[3];
    const segs = closed && n > 2 ? n : n - 1;
    for (let i = 0; i < segs; i++) if (segmentTouchesBox(P[i], P[(i + 1) % n], bb)) return true;
    return false;
  }

  /** Alt-marquee rule: only shapes that lie completely inside the box. */
  const insideBox = (P, bb) => P.length > 0 && P.every(([x, y]) => x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3]);

  const api = { MIN_SIZE, HANDLES, CURSOR, identity, translation, apply, applyBox, isScale, visibleHandles, handlePos, resize, segmentTouchesBox, touchesBox, insideBox };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.STL_SEL = api;
})();
