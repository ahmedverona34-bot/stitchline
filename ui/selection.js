/* Stitchline: geometry of the selection tools (and the split-line check of the layers list), kept apart from app.js so it can be tested with Node.
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

  /** Lines that look whole but are split into pieces: open shapes on the same layer whose ends touch (within tol
      mm) and carry straight on, turning at most maxTurn degrees at the joint, like one straight line cut in half.
      A corner where two lines meet at an angle is not a split. Shapes are { id, layer, pts, closed }; returns a
      Map from the id of every piece to the ids of all the pieces of its line. */
  function splitLines(shapes, tol = 0.05, maxTurn = 15) {
    const ends = [];                                    // each free end and the direction the line leaves it
    const away = (P, i, step) => {
      for (let j = i + step; j >= 0 && j < P.length; j += step) {
        const dx = P[i][0] - P[j][0], dy = P[i][1] - P[j][1], d = Math.hypot(dx, dy);
        if (d > 1e-6) return [dx / d, dy / d];
      }
      return null;
    };
    for (const s of shapes) {
      const P = s.pts;
      if (s.closed || P.length < 2) continue;
      for (const [i, step] of [[0, 1], [P.length - 1, -1]]) { const d = away(P, i, step); if (d) ends.push({ s, p: P[i], d }); }
    }
    const cell = Math.max(tol, 1e-6), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    const grid = new Map();
    ends.forEach((e, k) => { const g = key(e.p[0], e.p[1]); grid.has(g) ? grid.get(g).push(k) : grid.set(g, [k]); });
    const root = new Map(), find = id => { while (root.get(id) !== id) { root.set(id, root.get(root.get(id))); id = root.get(id); } return id; };
    const straight = -Math.cos(maxTurn * Math.PI / 180);
    ends.forEach((a, ka) => {
      const cx = Math.floor(a.p[0] / cell), cy = Math.floor(a.p[1] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) for (const kb of grid.get(gx + ',' + gy) || []) {
        const b = ends[kb];
        if (kb <= ka || b.s === a.s || b.s.layer !== a.s.layer) continue;
        if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) > tol) continue;
        if (a.d[0] * b.d[0] + a.d[1] * b.d[1] > straight) continue;   // the two pieces leave the joint in opposite directions
        for (const id of [a.s.id, b.s.id]) if (!root.has(id)) root.set(id, id);
        root.set(find(a.s.id), find(b.s.id));
      }
    });
    const groups = new Map();
    for (const id of root.keys()) { const r = find(id); groups.has(r) ? groups.get(r).push(id) : groups.set(r, [id]); }
    const out = new Map();
    for (const ids of groups.values()) for (const id of ids) out.set(id, ids);
    return out;
  }

  const api = { splitLines, MIN_SIZE, HANDLES, CURSOR, identity, translation, apply, applyBox, isScale, visibleHandles, handlePos, resize, segmentTouchesBox, touchesBox, insideBox };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.STL_SEL = api;
})();
