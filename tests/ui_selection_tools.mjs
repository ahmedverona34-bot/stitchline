// End-to-end check of the black (V) and white (A) arrows in the running app, with real mouse and key input.
// Start the test build first (tests/dev_run.ps1: fresh profile, DevTools on port 9333), then:
//   node tests/ui_selection_tools.mjs [drawing]          default: reference/parity/p3_circles_arcs.dxf
// Positions on screen come from the app's own X/Y readout, geometry from the engine (/api/state).
// Keep the real mouse off the window while it runs: its moves mix with the test's drags (no button held = drag ends).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || path.join(root, 'reference', 'parity', 'p3_circles_arcs.dxf');
const port = process.env.CDP_PORT || 9333;
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => (ws.onopen = r));
const send = (method, params = {}) => new Promise(r => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); if (!ok) failed++; };

// ---------------------------------------------------------------- input
const MOD = { alt: 1, ctrl: 2, shift: 8 };
const mods = m => (m || []).reduce((a, k) => a | MOD[k], 0);
const mouse = (type, x, y, m) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers: mods(m) });
async function move(x, y, m) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods(m) }); await sleep(30); }
async function dragFromTo(x0, y0, x1, y1, m, between) {
  await move(x0, y0, m);
  await mouse('mousePressed', x0, y0, m);
  for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8, buttons: 1, button: 'left', modifiers: mods(m) }); await sleep(16); }
  if (between) await between();
  await mouse('mouseReleased', x1, y1, m);
  await sleep(350);
}
async function click(x, y, m) { await move(x, y, m); await mouse('mousePressed', x, y, m); await mouse('mouseReleased', x, y, m); await sleep(250); }
async function key(k, code, m) {
  const p = { key: k, code, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Escape: 27, Shift: 16, Alt: 18 }[k], modifiers: mods(m) };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }); await sleep(120);
}

// ---------------------------------------------------------------- app state
const engine = () => js(`fetch('/api/state', { method: 'POST', body: '{}' }).then(r => r.json()).then(d => ({ shapes: d.job.shapes, can_undo: d.can_undo }))`);
const toolNow = () => js(`document.querySelector('.rail [aria-pressed="true"]')?.dataset.tool`);
const cursor = () => js(`document.getElementById('cv').className`);
const selectedRows = () => js(`[...document.querySelectorAll('#layers .shape-row[aria-selected="true"]')].map(r => +r.dataset.s)`);
/** screen <-> drawing mapping from the X / Y readout at two points */
async function mapping() {
  // the view settles after a file opens (fit, panels laid out): calibrate until two readings agree
  let m = await mapping1();
  for (let i = 0; i < 20; i++) { await sleep(150); const n = await mapping1(); if (Math.abs(n.k - m.k) < 1e-3 * m.k && Math.abs(n.X(0) - m.X(0)) < 0.5 && Math.abs(n.Y(0) - m.Y(0)) < 0.5) return n; m = n; }
  throw new Error('the view does not settle');
}
async function mapping1() {
  const at = async (x, y) => { await move(x, y); return js(`[+document.getElementById('cx').textContent * 10, +document.getElementById('cy').textContent * 10]`); };   // readout in cm
  // the readout follows the pointer only over the canvas, so both points must be on bare canvas (not under a panel)
  const [p, q] = await js(`(() => { const cv = document.getElementById('cv'), ok = (x, y) => document.elementFromPoint(x, y) === cv, pts = [];
    for (let fy = 0.3; fy <= 0.7; fy += 0.05) for (let fx = 0.2; fx <= 0.8; fx += 0.05) { const x = Math.round(innerWidth * fx), y = Math.round(innerHeight * fy); if (ok(x, y)) pts.push([x, y]); }
    let best = null, d = 0; for (const a of pts) for (const b of pts) { const e = Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); if (e > d) { d = e; best = [a, b]; } }
    return best; })()`);
  const a = await at(...p), b = await at(...q);
  const k = (q[0] - p[0]) / (b[0] - a[0]);
  return { k, X: x => p[0] + (x - a[0]) * k, Y: y => p[1] - (y - a[1]) * k };
}
const bbox = pts => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
/** a point on a shape away from its ends and from other shapes */
function pickPoint(shapes, s) {
  const P = s.pts;
  for (let i = 1; i < P.length; i++) {
    const m = [(P[i - 1][0] + P[i][0]) / 2, (P[i - 1][1] + P[i][1]) / 2];
    if (Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) > 2) return m;
  }
  return P[0];
}

// ---------------------------------------------------------------- run
const b64 = fs.readFileSync(file).toString('base64');
await js(`(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(path.basename(file))})); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
await sleep(1500);
await js(`document.querySelector('.stage[data-stage="arrange"]').click()`);
await sleep(300);
let st = await engine();
console.log(`opened ${path.basename(file)}: ${st.shapes.length} shapes, language ${await js('document.documentElement.lang')}, dir ${await js('document.documentElement.dir')}`);
// the shape with the most width and height (a line has no top / bottom handles, a point no handles at all)
const span = s => { const b = bbox(s.pts); return Math.min(b[2] - b[0], b[3] - b[1]); };
const target = st.shapes.filter(s => s.pts.length > 1).sort((a, b) => span(b) - span(a))[0];
let M = await mapping();
console.log(`zoom: ${M.k.toFixed(3)} px per mm`);

// --- black arrow
await click(M.X(0) + 5, 5);                                      // focus the canvas area harmlessly
await key('Escape', 'Escape');
await key('v', 'KeyV');
check(await toolNow() === 'select', '1. V activates the black arrow');
let [px, py] = pickPoint(st.shapes, target);
await click(M.X(px), M.Y(py));
let rows = await selectedRows();
check(rows.length === 1 && rows[0] === target.id, '2. one click selects the whole shape', JSON.stringify(rows));
let bb = bbox(target.pts);
await move(M.X(bb[2]), M.Y(bb[3]));
let c = await cursor();
check(c === 'rs-nesw', '3. bounding box handle under the pointer (top right corner)', c);
await move(M.X(bb[2]), M.Y((bb[1] + bb[3]) / 2));
c = await cursor();
check(c === 'rs-ew' || (bb[3] - bb[1]) * M.k < 24, '3. edge handle (right)', c);
await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(process.env.TEMP || '.', 'sl_black.png'), Buffer.from(r.result.data, 'base64')));

// move by dragging the shape
const others0 = st.shapes.filter(s => s.id !== target.id);
await dragFromTo(M.X(px), M.Y(py), M.X(px) + 80, M.Y(py) + 40);
st = await engine();
let moved = st.shapes.find(s => s.id === target.id);
let dx = moved.pts[0][0] - target.pts[0][0], dy = moved.pts[0][1] - target.pts[0][1];
const tol = 1.5 / M.k;
check(near(dx, 80 / M.k, tol) && near(dy, -40 / M.k, tol), '4. dragging moves the shape with the pointer', `dx ${dx.toFixed(3)} dy ${dy.toFixed(3)} mm`);
check(moved.pts.length === target.pts.length && moved.pts.every((p, i) => near(p[0] - target.pts[i][0], dx, 1e-3) && near(p[1] - target.pts[i][1], dy, 1e-3)), '8. every point moved by the same amount (geometry kept)');
check(st.shapes.filter(s => s.id !== target.id).every(s => JSON.stringify(s.pts) === JSON.stringify(others0.find(o => o.id === s.id).pts)), '   other shapes did not move');

// resize from the top right corner: bottom left stays
let cur = moved; bb = bbox(cur.pts);
await dragFromTo(M.X(bb[2]), M.Y(bb[3]), M.X(bb[2]) + 60, M.Y(bb[3]) - 30);
st = await engine(); let rz = st.shapes.find(s => s.id === target.id); let b2 = bbox(rz.pts);
check(near(b2[0], bb[0], 1e-3) && near(b2[1], bb[1], 1e-3) && near(b2[2] - bb[2], 60 / M.k, tol) && near(b2[3] - bb[3], 30 / M.k, tol), '5. corner handle resizes, opposite corner fixed',
  `w ${(bb[2] - bb[0]).toFixed(2)}->${(b2[2] - b2[0]).toFixed(2)} h ${(bb[3] - bb[1]).toFixed(2)}->${(b2[3] - b2[1]).toFixed(2)}`);
check(rz.pts.length === cur.pts.length && rz.closed === cur.closed && rz.layer === cur.layer, '8. resize keeps point count, closed flag and layer');

// right edge: only x changes
cur = rz; bb = b2;
await dragFromTo(M.X(bb[2]), M.Y((bb[1] + bb[3]) / 2), M.X(bb[2]) - 50, M.Y((bb[1] + bb[3]) / 2) + 70);
st = await engine(); rz = st.shapes.find(s => s.id === target.id); b2 = bbox(rz.pts);
check(near(b2[0], bb[0], 1e-3) && near(b2[1], bb[1], 1e-3) && near(b2[3], bb[3], 1e-3) && near(bb[2] - b2[2], 50 / M.k, tol), '6. edge handle resizes along x only');
check(rz.pts.every((p, i) => near(p[1], cur.pts[i][1], 1e-3)), '6. y of every point unchanged');

// Shift on a corner: proportional
cur = rz; bb = b2;
await dragFromTo(M.X(bb[2]), M.Y(bb[1]), M.X(bb[2]) + 90, M.Y(bb[1]) + 10, ['shift']);
st = await engine(); rz = st.shapes.find(s => s.id === target.id); b2 = bbox(rz.pts);
const rx = (b2[2] - b2[0]) / (bb[2] - bb[0]), ry = (b2[3] - b2[1]) / (bb[3] - bb[1]);
check(near(rx, ry, 1e-3) && rx > 1, '   Shift keeps proportions', `${rx.toFixed(4)} x ${ry.toFixed(4)}`);

// Esc during a drag changes nothing
const beforeEsc = JSON.stringify(rz.pts);
[px, py] = pickPoint(st.shapes, rz);
await dragFromTo(M.X(px), M.Y(py), M.X(px) + 120, M.Y(py) + 120, null, () => key('Escape', 'Escape'));
st = await engine();
check(JSON.stringify(st.shapes.find(s => s.id === target.id).pts) === beforeEsc, '   Esc cancels a drag in progress');

// multi-selection: Shift-click a second shape, move both
const second = st.shapes.find(s => s.id !== target.id && s.pts.length > 1);
if (second) {
  const sp = pickPoint(st.shapes, second);
  await click(M.X(sp[0]), M.Y(sp[1]), ['shift']);   // may sit on a handle of the box: a click there still picks the shape
  rows = await selectedRows();
  check(rows.length === 2, '7. Shift-click adds to the selection', JSON.stringify(rows));
  const a0 = st.shapes.find(s => s.id === target.id), s0 = st.shapes.find(s => s.id === second.id);
  // drag from the point of the second shape farthest from the handles of the selection box
  const sb = bbox([...a0.pts, ...s0.pts]);
  const hp = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => [h.includes('w') ? sb[0] : h.includes('e') ? sb[2] : (sb[0] + sb[2]) / 2, h.includes('n') ? sb[3] : h.includes('s') ? sb[1] : (sb[1] + sb[3]) / 2]);
  const mids = s0.pts.slice(1).map((q, i) => [(q[0] + s0.pts[i][0]) / 2, (q[1] + s0.pts[i][1]) / 2]);
  const gp = mids.sort((u, v) => Math.min(...hp.map(h => Math.hypot(v[0] - h[0], v[1] - h[1]))) - Math.min(...hp.map(h => Math.hypot(u[0] - h[0], u[1] - h[1]))))[0];
  await dragFromTo(M.X(gp[0]), M.Y(gp[1]), M.X(gp[0]) - 30, M.Y(gp[1]) + 30);
  st = await engine();
  const a1 = st.shapes.find(s => s.id === target.id), s1 = st.shapes.find(s => s.id === second.id);
  const d1 = [a1.pts[0][0] - a0.pts[0][0], a1.pts[0][1] - a0.pts[0][1]], d2 = [s1.pts[0][0] - s0.pts[0][0], s1.pts[0][1] - s0.pts[0][1]];
  // (the state the window gets has points rounded to 0.0001 mm)
  check(near(d1[0], d2[0], 2e-4) && near(d1[1], d2[1], 2e-4) && Math.abs(d1[0]) > 0, '7. both selected shapes move together', `${d1.map(v => v.toFixed(4))} / ${d2.map(v => v.toFixed(4))} mm`);
}

// undo / redo
const afterAll = JSON.stringify((await engine()).shapes);
for (let i = 0; i < 6; i++) await key('z', 'KeyZ', ['ctrl']);
await sleep(300);
st = await engine();
check(JSON.stringify(st.shapes.find(s => s.id === target.id).pts) === JSON.stringify(target.pts), '18. undo (one step per drag) restores the original geometry');
for (let i = 0; i < 6; i++) await key('y', 'KeyY', ['ctrl']);
await sleep(300);
check(JSON.stringify((await engine()).shapes) === afterAll, '18. redo restores every move and resize');

// --- white arrow
st = await engine();
let w = st.shapes.find(s => s.id === target.id);
await key('a', 'KeyA');
check(await toolNow() === 'direct', '9. A activates the white arrow');
await key('Escape', 'Escape');                                   // Esc clears the selection (the tool stays)
check(await toolNow() === 'direct' && (await selectedRows()).length === 0, '   Esc with the white arrow clears the selection');
[px, py] = pickPoint(st.shapes, w);
await click(M.X(px), M.Y(py));
rows = await selectedRows();
check(rows.length === 1 && rows[0] === w.id, '10. one click selects the whole path', JSON.stringify(rows));
bb = bbox(w.pts);
await move(M.X(bb[2]), M.Y(bb[3]));
c = await cursor();
check(!c.startsWith('rs-'), '11. no resize handles with the white arrow', `cursor "${c}"`);
await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(process.env.TEMP || '.', 'sl_white.png'), Buffer.from(r.result.data, 'base64')));
// dragging where the corner handle would be does not resize (it is empty canvas: a selection box)
await dragFromTo(M.X(bb[2]), M.Y(bb[3]), M.X(bb[2]) + 60, M.Y(bb[3]) - 30);
st = await engine();
check(JSON.stringify(st.shapes.find(s => s.id === w.id).pts) === JSON.stringify(w.pts), '15. the white arrow cannot resize the path');
// zoom in, then move the path
await click(M.X(px), M.Y(py));
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: M.X(px), y: M.Y(py), deltaX: 0, deltaY: -400 });
await sleep(300);
M = await mapping();
console.log(`zoom: ${M.k.toFixed(3)} px per mm`);
await dragFromTo(M.X(px), M.Y(py), M.X(px) - 70, M.Y(py) + 25);
st = await engine();
const wm = st.shapes.find(s => s.id === w.id);
dx = wm.pts[0][0] - w.pts[0][0]; dy = wm.pts[0][1] - w.pts[0][1];
check(near(dx, -70 / M.k, 1.5 / M.k) && near(dy, -25 / M.k, 1.5 / M.k), '12/17. dragging moves the path with the pointer when zoomed in', `dx ${dx.toFixed(3)} dy ${dy.toFixed(3)} mm`);
check(wm.pts.length === w.pts.length && wm.closed === w.closed && wm.layer === w.layer && wm.pts.every((p, i) => near(p[0] - w.pts[i][0], dx, 1e-3) && near(p[1] - w.pts[i][1], dy, 1e-3)), '13. shape, points, closed flag and layer unchanged after the move');
// pressing on a single point of the path and dragging moves the whole path, never just that point
const p0 = wm.pts[0];
await dragFromTo(M.X(p0[0]), M.Y(p0[1]), M.X(p0[0]) + 40, M.Y(p0[1]));
st = await engine();
const wp = st.shapes.find(s => s.id === w.id);
const rel = (s, i) => [s.pts[i][0] - s.pts[0][0], s.pts[i][1] - s.pts[0][1]];
check(wp.pts.every((_, i) => near(rel(wp, i)[0], rel(wm, i)[0], 1e-3) && near(rel(wp, i)[1], rel(wm, i)[1], 1e-3)), '14. dragging at an anchor moves the whole path, not the point');

// --- shortcuts are not taken while typing
await key('v', 'KeyV');
[px, py] = pickPoint(st.shapes, wp);
await click(M.X(px), M.Y(py));
const typed = await js(`(() => { const i = document.querySelector('#insp input'); if (!i) return null; i.focus(); i.select(); return i.id; })()`);
await key('a', 'KeyA');
check(typed && await toolNow() === 'select', '16. A typed into a field does not switch tools', `field #${typed}`);
await js(`document.activeElement.blur()`);
await key('Escape', 'Escape');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots: ${path.join(process.env.TEMP || '.', 'sl_black.png')}, sl_white.png`);
ws.close();
process.exit(failed ? 1 : 0);
