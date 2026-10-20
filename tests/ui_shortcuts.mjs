// End-to-end check of the Illustrator-style keyboard shortcuts in the running app, with real key and mouse input.
// Start the test build first (tests/dev_run.ps1: fresh profile, DevTools on port 9333), then:
//   node tests/ui_shortcuts.mjs [drawing]                 default: reference/parity/p3_circles_arcs.dxf
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
const VK = { Escape: 27, Shift: 16, Alt: 18, Enter: 13, ArrowRight: 39, '[': 219, ']': 221, '-': 189, '=': 187 };
async function key(k, code, m) {
  const p = { key: k, code, windowsVirtualKeyCode: VK[k] || k.toUpperCase().charCodeAt(0), modifiers: mods(m) };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }); await sleep(250);
}

// screen <-> drawing mapping, as in ui_selection_tools.mjs
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

// ---------------------------------------------------------------- app state
const engine = () => js(`fetch('/api/state', { method: 'POST', body: '{}' }).then(r => r.json()).then(d => ({ shapes: d.job.shapes, order: d.job.order }))`);
const toolNow = () => js(`document.querySelector('.rail [aria-pressed="true"]')?.dataset.tool`);
const selectedRows = () => js(`[...document.querySelectorAll('#layers .shape-row[aria-selected="true"]')].map(r => +r.dataset.s)`);
const pickRow = id => js(`document.querySelector('#layers .shape-row[data-s="${id}"]').click()`);
const sheetNow = () => js(`document.getElementById('sheetScrim').hidden ? null : document.getElementById('sheet').dataset.k`);
const focused = () => js(`document.activeElement?.id || ''`);
const pressed = id => js(`document.getElementById('${id}').getAttribute('aria-pressed')`);
const shapeOf = (st, id) => st.shapes.find(s => s.id === id);
const bbox = pts => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const samePts = (a, b, dx = 0, dy = 0) => a.length === b.length && a.every((p, i) => near(p[0] + dx, b[i][0], 1e-6) && near(p[1] + dy, b[i][1], 1e-6));
const newIds = (before, after) => after.shapes.map(s => s.id).filter(id => !before.shapes.some(s => s.id === id));
async function blur() { await js(`document.activeElement?.blur()`); }

// ---------------------------------------------------------------- run
// these tools are in the advanced mode (a fresh profile starts in the simple one)
if (await js(`localStorage.getItem('stl.simple')`) !== 'false') {
  await js(`localStorage.setItem('stl.simple', 'false'); location.reload()`).catch(() => {});
  await sleep(3000);
}
const b64 = fs.readFileSync(file).toString('base64');
await js(`(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(path.basename(file))})); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
await sleep(1500);
await js(`document.querySelector('.stage[data-stage="arrange"]').click()`);
await sleep(300);
let st = await engine();
const target = st.shapes.filter(s => s.pts.length > 2).sort((a, b) => b.pts.length - a.pts.length)[0];
console.log(`opened ${path.basename(file)}: ${st.shapes.length} shapes, language ${await js('document.documentElement.lang')}`);
await js(`document.getElementById('cv').dispatchEvent(new PointerEvent('pointermove'))`);
await key('Escape', 'Escape');

// --- tools
for (const [k, code, want] of [['c', 'KeyC', 'start'], ['i', 'KeyI', 'measure'], ['h', 'KeyH', 'pan'], ['a', 'KeyA', 'direct'], ['v', 'KeyV', 'select']])
  { await key(k, code); check(await toolNow() === want, `${k.toUpperCase()} picks the ${want} tool`); }
await key('s', 'KeyS'); check(await sheetNow() === null, 'S with nothing selected opens nothing');
await key('m', 'KeyM'); check(await sheetNow() === 'add', 'M opens Add shape'); await key('Escape', 'Escape');
await key('k', 'KeyK', ['ctrl', 'alt', 'shift']); check(await sheetNow() === 'keys', 'Ctrl+Alt+Shift+K opens the shortcut list');
check(await js(`document.getElementById('sheet').textContent.includes('Illustrator')`), '   and it says the keys follow Illustrator');
await key('Escape', 'Escape');

// --- view
await key('0', 'Digit0', ['ctrl']); const fitZoom = await js(`document.getElementById('zoomTxt').textContent`);
await key('1', 'Digit1', ['ctrl']); check(await js(`document.getElementById('zoomTxt').textContent`) === '100%', 'Ctrl+1 zooms to real size', fitZoom);
await key('=', 'Equal', ['ctrl']); check(await js(`document.getElementById('zoomTxt').textContent`) === '125%', 'Ctrl++ zooms in');
await key('-', 'Minus', ['ctrl']); check(await js(`document.getElementById('zoomTxt').textContent`) === '100%', 'Ctrl+− zooms out');
await key('0', 'Digit0', ['ctrl']); check(await js(`document.getElementById('zoomTxt').textContent`) === fitZoom, 'Ctrl+0 fits the drawing');
check(await js(`devicePixelRatio`) === await js(`devicePixelRatio`) && await js(`Math.round(outerWidth / innerWidth * 100)`) === 100, '   the page itself is not zoomed');
for (const [k, code, id] of [['y', 'KeyY', 'showStitch'], ['h', 'KeyH', 'showOrder']]) {
  const was = await pressed(id); await key(k, code, ['ctrl']);
  check(await pressed(id) !== was, `Ctrl+${k.toUpperCase()} switches ${id}`); await key(k, code, ['ctrl']);
}
{ const was = await pressed('showStitch'); await key('t', 'KeyT'); check(await pressed('showStitch') === was, 'T no longer switches the stitches'); }

// --- selection-driven keys
await pickRow(target.id); await sleep(200);
check(JSON.stringify(await selectedRows()) === JSON.stringify([target.id]), 'a shape is selected from the layer list');
await key('r', 'KeyR'); check(await focused() === 'ang', 'R puts the cursor in the Rotate angle'); await blur();
await key('Enter', 'Enter'); check(await focused() === 'mvx', 'Enter puts the cursor in the Move fields'); await blur();
await key('s', 'KeyS'); check(await sheetNow() === 'resize', 'S opens Resize'); await key('Escape', 'Escape');

// mirror and transform again
st = await engine(); let s0 = shapeOf(st, target.id);
await key('o', 'KeyO'); let s1 = shapeOf(await engine(), target.id);
const b0 = bbox(s0.pts), b1 = bbox(s1.pts);
check(!samePts(s0.pts, s1.pts) && near(b0[0], b1[0], 1e-6) && near(b0[2], b1[2], 1e-6), 'O mirrors left–right in place');
await key('d', 'KeyD', ['ctrl']); check(samePts(s0.pts, shapeOf(await engine(), target.id).pts), 'Ctrl+D mirrors again (back to the start)');
await key('ArrowRight', 'ArrowRight'); s1 = shapeOf(await engine(), target.id);
const step = s1.pts[0][0] - s0.pts[0][0];
check(step > 0 && samePts(s0.pts, s1.pts, step, 0), 'the arrow key nudges', `${step} mm`);
await key('d', 'KeyD', ['ctrl']); check(samePts(s0.pts, shapeOf(await engine(), target.id).pts, 2 * step, 0), 'Ctrl+D repeats the nudge');
for (let i = 0; i < 4; i++) await key('z', 'KeyZ', ['ctrl']);
check(samePts(s0.pts, shapeOf(await engine(), target.id).pts), 'four undos restore the shape');
await key('z', 'KeyZ', ['ctrl', 'shift']); check(!samePts(s0.pts, shapeOf(await engine(), target.id).pts), 'Ctrl+Shift+Z redoes');
await key('z', 'KeyZ', ['ctrl']);

// reverse
await key('r', 'KeyR', ['ctrl', 'alt']); await blur();
check(!samePts(s0.pts, shapeOf(await engine(), target.id).pts) && JSON.stringify(bbox(shapeOf(await engine(), target.id).pts)) === JSON.stringify(bbox(s0.pts)), 'Ctrl+Alt+R reverses the direction');
await key('z', 'KeyZ', ['ctrl']);

// copy, paste, cut
st = await engine();
await key('c', 'KeyC', ['ctrl']); await key('f', 'KeyF', ['ctrl']);
let st2 = await engine(), add = newIds(st, st2);
check(add.length === 1 && samePts(s0.pts, shapeOf(st2, add[0]).pts) && st2.order.at(-1) === add[0], 'Ctrl+C, Ctrl+F pastes in place, sewn last');
check(JSON.stringify(await selectedRows()) === JSON.stringify(add), '   and selects the copy');
await key('b', 'KeyB', ['ctrl']); let st3 = await engine(); add = newIds(st2, st3);
check(add.length === 1 && samePts(s0.pts, shapeOf(st3, add[0]).pts) && st3.order[0] === add[0], 'Ctrl+B pastes in place, sewn first');
await key('v', 'KeyV', ['ctrl']); let st4 = await engine(); add = newIds(st3, st4);
const c4 = add.length === 1 && shapeOf(st4, add[0]);
check(c4 && c4.pts.length === s0.pts.length && samePts(s0.pts, c4.pts, c4.pts[0][0] - s0.pts[0][0], c4.pts[0][1] - s0.pts[0][1]), 'Ctrl+V pastes a copy (same shape, moved to the view)');
await key('x', 'KeyX', ['ctrl']); check((await engine()).shapes.length === st3.shapes.length, 'Ctrl+X cuts the selection');
await key('v', 'KeyV', ['ctrl']); check((await engine()).shapes.length === st4.shapes.length, 'Ctrl+V after a cut brings it back');
await key('a', 'KeyA', ['ctrl', 'shift']); check((await selectedRows()).length === 0, 'Ctrl+Shift+A clears the selection');
for (let i = 0; i < 5; i++) await key('z', 'KeyZ', ['ctrl']);
check((await engine()).shapes.length === st.shapes.length, 'undo removes the pasted copies');

// sewing order
st = await engine(); await pickRow(target.id); await sleep(200);
const pos = o => o.indexOf(target.id);
const p0 = pos(st.order);
if (p0 < st.order.length - 1) { await key(']', 'BracketRight', ['ctrl']); check(pos((await engine()).order) === p0 + 1, 'Ctrl+] sews it one step later'); await key('[', 'BracketLeft', ['ctrl']); check(pos((await engine()).order) === p0, 'Ctrl+[ one step earlier'); }
await key('[', 'BracketLeft', ['ctrl', 'shift']); check(pos((await engine()).order) === 0, 'Ctrl+Shift+[ sews it first');
await key(']', 'BracketRight', ['ctrl', 'shift']); check(pos((await engine()).order) === st.order.length - 1, 'Ctrl+Shift+] sews it last');
await key('z', 'KeyZ', ['ctrl']); await key('z', 'KeyZ', ['ctrl']);
if (p0 < st.order.length - 1) { await key('z', 'KeyZ', ['ctrl']); await key('z', 'KeyZ', ['ctrl']); }
check(JSON.stringify((await engine()).order) === JSON.stringify(st.order), 'undo restores the sewing order');

// Alt-drag copies, then Ctrl+D copies again by the same step
{
  const M = await mapping();
  const P = target.pts, mid = [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2];
  st = await engine();
  await key('v', 'KeyV');
  await dragFromTo(M.X(mid[0]), M.Y(mid[1]), M.X(mid[0]) + 60, M.Y(mid[1]) + 40, ['alt']);
  const sa = await engine(), na = newIds(st, sa);
  check(na.length === 1 && samePts(s0.pts, shapeOf(sa, target.id).pts), 'Alt-drag leaves the shape where it was', JSON.stringify(na));
  const dx = na.length && shapeOf(sa, na[0]).pts[0][0] - s0.pts[0][0], dy = na.length && shapeOf(sa, na[0]).pts[0][1] - s0.pts[0][1];
  check(na.length === 1 && dx > 0 && dy < 0 && samePts(s0.pts, shapeOf(sa, na[0]).pts, dx, dy), '   and puts a moved copy where it was dropped', `${dx?.toFixed?.(2)}, ${dy?.toFixed?.(2)} mm`);
  await key('d', 'KeyD', ['ctrl']);
  const sb = await engine(), nb = newIds(sa, sb);
  check(nb.length === 1 && samePts(s0.pts, shapeOf(sb, nb[0]).pts, 2 * dx, 2 * dy), 'Ctrl+D makes the next copy one more step along');
  await key('z', 'KeyZ', ['ctrl']); await key('z', 'KeyZ', ['ctrl']);
  check((await engine()).shapes.length === st.shapes.length, 'two undos remove both copies');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
ws.close();
process.exit(failed ? 1 : 0);
