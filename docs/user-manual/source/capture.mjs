// Takes every screenshot of the user manual from the running test build, and records where the parts of the window
// are (rects.json, in screenshot pixels) so annotate.py can draw its call-outs on the right places.
//
//   powershell -File tests/dev_run.ps1           (fresh profile, DevTools on port 9333)
//   node docs/user-manual/source/capture.mjs     (keep the mouse off the Stitchline window while it runs)
//
// Uses only the demo drawings in tests/data; the job files it saves go to %TEMP%\stitchline-manual.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SHOTS = path.resolve(HERE, '../screenshots');
const WORK = path.join(os.tmpdir(), 'stitchline-manual');
const win = p => p.split('/').join('\\');
const DEMO = win(path.join(ROOT, 'tests/data/drawings/demo.plt'));
const SYNTH = win(path.join(ROOT, 'tests/data/drawings/synthetic.dxf'));
const JOB = win(path.join(WORK, 'demo.stitchline'));
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------------ a saved demo job (laser outline), made by the engine CLI
{
  const script = { steps: [
    { op: '__upload', args: { name: 'demo.plt', file: path.join(ROOT, 'tests/data/drawings/demo.plt') } },
    { op: 'update_layer', args: { id: 'L2', fields: { needle: 3, settings: { convert: false, bt_start: 0, bt_end: 0, cl_start: 0, cl_end: 0, end_repeat: 0, corner_slow: false, corner_dense: false, se_dense: false, double_on: false } } } },
    { op: 'save', args: { as_new: true }, answers: [JOB] },
  ] };
  fs.writeFileSync(path.join(WORK, 'job.json'), JSON.stringify(script));
  execFileSync(path.join(ROOT, 'target/debug/stitchline-cli.exe'), [path.join(WORK, 'job.json')], { env: { ...process.env, STITCHLINE_HOME: path.join(WORK, 'cli') } });
}

// ------------------------------------------------------------------ DevTools connection
const page = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => (ws.onopen = r));
const send = (method, params = {}) => new Promise(r => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = async expr => { const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(expr.slice(0, 80) + ': ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };

const RECTS = {};
let DPR = 1;
async function shot(name, clip) {
  await sleep(400);
  const p = { format: 'png' };
  if (clip) p.clip = { ...clip, scale: 1 };
  const r = await send('Page.captureScreenshot', p);
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
}
/** rects of elements, in pixels of a screenshot whose top-left is (ox, oy) in page px */
async function rec(name, sels, ox = 0, oy = 0) {
  const out = await js(`const r = {}; for (const [k, s] of Object.entries(${JSON.stringify(sels)})) { const e = document.querySelector(s); if (!e || !e.getClientRects().length) continue; const b = e.getBoundingClientRect(); r[k] = [b.left, b.top, b.right, b.bottom]; } return r;`);
  RECTS[name] = { ...(RECTS[name] || {}) };
  for (const [k, b] of Object.entries(out)) RECTS[name][k] = b.map((v, i) => Math.round((v - (i % 2 ? oy : ox)) * DPR));
}
const addRect = (name, key, b) => { RECTS[name] = { ...(RECTS[name] || {}), [key]: b.map(v => Math.round(v * DPR)) }; };

const MOD = { alt: 1, ctrl: 2, shift: 8 };
const mods = m => (m || []).reduce((a, k) => a | MOD[k], 0);
async function move(x, y, m) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods(m) }); await sleep(40); }
async function click(x, y, m, button = 'left') {
  await move(x, y, m);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1, modifiers: mods(m) });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers: mods(m) });
  await sleep(300);
}
async function dragHold(x0, y0, x1, y1) {
  await move(x0, y0);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / 10, y: y0 + (y1 - y0) * i / 10, buttons: 1, button: 'left' }); await sleep(20); }
  return async () => { await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 }); await sleep(400); };
}
const VK = { Escape: 27, Tab: 9, PageDown: 34, PageUp: 33, '?': 191 };
async function key(k, code, m) {
  const p = { key: k, code: code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), windowsVirtualKeyCode: VK[k] || k.toUpperCase().charCodeAt(0), modifiers: mods(m) };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  if (k.length === 1 && !(m || []).some(x => x === 'ctrl' || x === 'alt')) await send('Input.dispatchKeyEvent', { type: 'char', text: k, ...p });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }); await sleep(300);
}
const center = sel => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2];`);
async function clickSel(sel, m, button) { const c = await center(sel); if (!c) throw new Error('no element ' + sel); await click(c[0], c[1], m, button); }
const jsClick = sel => js(`document.querySelector(${JSON.stringify(sel)}).click();`);
const act = (name, data = {}) => js(`const b = document.createElement('button'); b.dataset.act = ${JSON.stringify(name)}; Object.assign(b.dataset, ${JSON.stringify(data)}); b.hidden = true; document.body.appendChild(b); b.click(); b.remove();`);
const openPath = async p => { await act('openRecent', { path: p }); await sleep(1500); };
const state = () => js(`return fetch('/api/state', { method: 'POST', body: '{}' }).then(r => r.json());`);
const stage = async n => { await key(String(n), 'Digit' + n); await sleep(500); };
const closeSheet = () => js(`document.querySelector('#sheet [data-close]')?.click();`);
const hideMenu = () => js(`document.getElementById('ctx').hidden = true;`);
async function viewport(h) {
  if (h) await send('Emulation.setDeviceMetricsOverride', { width: 1480, height: h, deviceScaleFactor: DPR, mobile: false });
  else await send('Emulation.clearDeviceMetricsOverride');
  await sleep(900);
}
/** an element with a margin, as its own picture; its own rects are recorded relative to the picture */
async function boxShot(name, sel, pad = 0, sels = {}) {
  await sleep(300);
  const [x0, y0, x1, y1] = await js(`const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom];`);
  const W = await js('return innerWidth'), H = await js('return innerHeight');
  const x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad);
  const clip = { x, y, width: Math.min(W - x, x1 - x0 + 2 * pad), height: Math.min(H - y, y1 - y0 + 2 * pad) };
  await rec(name, sels, x, y);
  await shot(name, clip);
}
/** the whole stage panel with every section open: the window grows so nothing scrolls; section rects recorded */
async function panelShot(name, extra = 0) {
  await js(`document.querySelectorAll('#insp details').forEach(d => d.open = true);`);
  await sleep(200);
  const need = await js(`const i = document.querySelector('#insp'), f = document.querySelector('#ifoot'); return Math.ceil(i.getBoundingClientRect().top + i.scrollHeight + (f.hidden ? 0 : f.getBoundingClientRect().height) + 40);`);
  await viewport(Math.max(874, need + extra));
  const [x0, y0, x1, y1] = await js(`const b = document.querySelector('.inspector').getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom];`);
  const secs = await js(`const r = {}; document.querySelectorAll('#insp > *, #ifoot').forEach((e, n) => { const b = e.getBoundingClientRect(); if (b.height) r[(e.dataset.key || e.id || e.className.split(' ')[0] || e.tagName.toLowerCase()) + ':' + n] = [b.left, b.top, b.right, b.bottom]; }); return r;`);
  RECTS[name] = {};
  for (const [k, b] of Object.entries(secs)) RECTS[name][k] = [b[0] - x0, b[1] - y0, b[2] - x0, b[3] - y0].map(v => Math.round(v * DPR));
  await shot(name, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  await viewport(0);
}
/** screen position (page px) of a drawing point (mm), from the X / Y readout as in tests/ui_shortcuts.mjs */
async function mapping() {
  const read = async (x, y) => { await move(x, y); return js(`return [+document.getElementById('cx').textContent * 10, +document.getElementById('cy').textContent * 10];`); };
  const W = await js('return innerWidth'), H = await js('return innerHeight');
  const p = [Math.round(W * 0.45), Math.round(H * 0.4)], q = [Math.round(W * 0.6), Math.round(H * 0.7)];
  const a = await read(...p), b = await read(...q);
  const k = (q[0] - p[0]) / (b[0] - a[0]);
  return { X: x => p[0] + (x - a[0]) * k, Y: y => p[1] - (y - a[1]) * k };
}
const shapeBox = (s, id) => { const sh = s.job.shapes.find(x => x.id === id); const xs = sh.pts.map(p => p[0]), ys = sh.pts.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), sh]; };
const EDITOR = {
  home: '#btnHome', file: '#fileChip', palette: '#openPalette', open: '#btnOpen', save: '#btnSave', undo: '#undo', redo: '#redo',
  settings: '#settings', machine: '#saveTop', winctl: '#winctl', topbar: '.topbar', stepbar: '#stepbar', prev: '#stepPrev', next: '#stepNext',
  stages: '#stepbar .stages', st1: '.stage[data-stage=import]', st5: '.stage[data-stage=output]',
  rail: '.rail', t_select: '.rail [data-tool=select]', t_direct: '.rail [data-tool=direct]', t_pan: '.rail [data-tool=pan]',
  t_start: '.rail [data-tool=start]', t_measure: '.rail [data-tool=measure]', t_add: '#railAdd',
  side: '.side', groupSel: '#groupSel', addLayer: '#addLayer', addShape: '#addShape', sidefoot: '.side .p-foot',
  readout: '#readout', viewbar: '.viewbar', zoombar: '.zoombar', insp: '.inspector', ititle: '#insp .i-title', ifoot: '#ifoot',
  toggle: '#inspToggle', toast: '#toast', sim: '#sim', ctx: '#ctx',
};

// ------------------------------------------------------------------ start: light theme, a clean window
await js(`localStorage.setItem('stl.theme', '"light"'); location.reload();`).catch(() => {});
await sleep(3500);
DPR = await js('return devicePixelRatio');

// ------------------------------------------------------------------ Home, new job
await rec('01-home-first-start.png', { brand: '.home-brand', new: '[data-home=new]', open: '.home-acts [data-home=open]', quick: '#homeQuick', filter: '.home-row .home-filter', view: '#homeView', recent: '#homeRecent', start: '.home-check', tools: '.home-tools' });
await shot('01-home-first-start.png');
await clickSel('.home-acts [data-home=new]');
await boxShot('02-new-job-dialog.png', '#sheet', 16);
await jsClick('#sheet [data-ok]'); await sleep(1200);
await rec('03-editor-empty-job.png', { ...EDITOR, empty: '#empty .hero' });
await shot('03-editor-empty-job.png');

// ------------------------------------------------------------------ the demo drawing
await openPath(DEMO); await sleep(800);
await move(5, 600);
await rec('04-arrange-after-open.png', EDITOR);
await shot('04-arrange-after-open.png');
await stage(1);
await rec('05-import-stage.png', EDITOR);
await shot('05-import-stage.png');
await panelShot('08-import-panel-full.png');
await stage(2);
let S = await state();
const M = await mapping();
// select the right-hand piece (shape 41, Layer2) by clicking its outline
{
  const [x0, y0, x1, y1, sh] = shapeBox(S, 41);
  const p = sh.pts[Math.floor(sh.pts.length / 2)];
  await click(M.X(p[0]), M.Y(p[1])); await sleep(400);
  await rec('06-arrange-one-selected.png', { ...EDITOR, row: '#layers .shape-row[aria-selected=true]', l2row: '#layers .layer-row[data-layer=L2]', l2switch: '#layers [data-out=L2]', l2needle: '#layers [data-needle=L2]', l2swatch: '#layers .layer[data-l=L2] .swatch', l2name: '#layers [data-rename=L2]', l2caret: '#layers [data-toggle=L2]' });
  addRect('06-arrange-one-selected.png', 'bbox', [M.X(x0), M.Y(y1), M.X(x1), M.Y(y0)]);
  addRect('06-arrange-one-selected.png', 'start', [M.X(sh.pts[0][0]) - 14, M.Y(sh.pts[0][1]) - 14, M.X(sh.pts[0][0]) + 14, M.Y(sh.pts[0][1]) + 14]);
  addRect('06-arrange-one-selected.png', 'handle', [M.X(x1) - 7, M.Y((y0 + y1) / 2) - 7, M.X(x1) + 7, M.Y((y0 + y1) / 2) + 7]);
  await move(5, 600);
  await shot('06-arrange-one-selected.png');
  await panelShot('07-arrange-panel-full.png');
  // context menu on the shape
  await click(M.X(p[0]), M.Y(p[1]), null, 'right'); await sleep(300);
  await rec('09-canvas-context-menu-shape.png', { ctx: '#ctx' });
  await shot('09-canvas-context-menu-shape.png');
  await hideMenu(); await key('Escape');
  // context menu on empty drawing
  await click(M.X((x0 + x1) / 2), M.Y(y0 - 40), null, 'right'); await sleep(300);
  await rec('10-canvas-context-menu-empty.png', { ctx: '#ctx' });
  await shot('10-canvas-context-menu-empty.png');
  await hideMenu();
  await clickSel('#layers .layer-row[data-layer="L2"] .name', null, 'right'); await sleep(300);
  await rec('11-layer-context-menu.png', { ctx: '#ctx', row: '#layers .layer-row[data-layer=L2]' });
  await shot('11-layer-context-menu.png');
  await hideMenu();
  // direct selection
  await key('a'); await click(M.X(p[0]), M.Y(p[1])); await move(5, 600);
  addRect('13-direct-selection.png', 'shape', [M.X(x0), M.Y(y1), M.X(x1), M.Y(y0)]);
  await shot('13-direct-selection.png');
  await key('Escape'); await key('v'); await key('Escape');
  // measure along the bottom edge of the left piece (shape 40)
  const [a0, b0, a1] = shapeBox(S, 40);
  await key('i');
  const up = await dragHold(M.X(a0), M.Y(b0), M.X(a1), M.Y(b0));
  addRect('14-measure-tool.png', 'line', [M.X(a0) - 6, M.Y(b0) - 40, M.X(a1) + 6, M.Y(b0) + 8]);
  await shot('14-measure-tool.png');
  await up(); await key('Escape');
}

// ------------------------------------------------------------------ stitch, laser
await stage(3);
await js(`const s = document.getElementById('stitchLayer'); s.value = 'L1'; s.dispatchEvent(new Event('change', { bubbles: true }));`); await sleep(500);
await rec('15-stitch-stage.png', { ...EDITOR, picker: '.layer-pick', kind: '#insp [data-act=kind][data-kind=sew]', kind2: '#insp [data-act=kind][data-kind=laser]', len: '#insp .big-slider' });
await move(5, 600);
await shot('15-stitch-stage.png');
await panelShot('16-stitch-panel-full.png');
await js(`const s = document.getElementById('stitchLayer'); s.value = 'L2'; s.dispatchEvent(new Event('change', { bubbles: true }));`); await sleep(500);
await clickSel('#insp [data-act="kind"][data-kind="laser"]'); await sleep(1300);
await rec('17-laser-layer.png', { ...EDITOR, kind: '#insp [data-act=kind][data-kind=sew]', kind2: '#insp [data-act=kind][data-kind=laser]', hint: '#insp .sec.plain .hint', l2needle: '#layers [data-needle=L2]', laserspeed: '#insp details[data-key=laserspeed] summary' });
{ const [x0, y0, x1, y1] = shapeBox(S, 41); addRect('17-laser-layer.png', 'outline', [M.X(x0) - 8, M.Y(y1) - 8, M.X(x1) + 8, M.Y(y0) + 8]); }
await move(5, 600);
await shot('17-laser-layer.png');
await panelShot('18-laser-panel-full.png');

// ------------------------------------------------------------------ sequence, simulation
await stage(4); await sleep(400);
await move(5, 600);
await rec('19-sequence-stage.png', { ...EDITOR, order: '#order', sort: '#insp details[data-key=sort]', simulate: '#ifoot [data-act=simulate]' });
await shot('19-sequence-stage.png');
{ // point at one piece of the crosshatch: its number and the ones sewn before and after it stand out
  S = await state();
  const id = S.job.order[20], sh = S.job.shapes.find(s => s.id === id), p = sh.pts[Math.floor(sh.pts.length / 2)];
  await move(M.X(p[0]), M.Y(p[1])); await sleep(500);
  const xs = [], ys = [];
  for (const j of [S.job.order[19], id, S.job.order[21]]) for (const q of S.job.shapes.find(s => s.id === j).pts) { xs.push(q[0]); ys.push(q[1]); }
  addRect('19b-sequence-hover.png', 'focus', [M.X(Math.min(...xs)) - 30, M.Y(Math.max(...ys)) - 30, M.X(Math.max(...xs)) + 30, M.Y(Math.min(...ys)) + 30]);
  await shot('19b-sequence-hover.png');
  await move(5, 600);
}
await panelShot('20-sequence-panel-full.png', 300);
await clickSel('#ifoot [data-act="simulate"]'); await sleep(300);
await js(`const s = document.getElementById('simSpeed'); s.value = '20'; s.dispatchEvent(new Event('change'));`);
await sleep(2600);
await jsClick('#simPlay'); await sleep(300);
await rec('21-simulation.png', { ...EDITOR, play: '#simPlay', pos: '#simPos', speed: '#simSpeed', txt: '#simTxt', close: '#simClose' });
await shot('21-simulation.png');
await jsClick('#simClose');

// ------------------------------------------------------------------ output
await stage(5); await sleep(500);
await rec('22-output-stage.png', { ...EDITOR, stats: '#insp .stat-grid', prog: '#prog', insrow: '#insName', moverow: '#insp [data-act=insMove]', savebig: '#ifoot [data-act=saveMachine]', usbhint: '#ifoot .hint' });
await shot('22-output-stage.png');
await panelShot('23-output-panel-full.png');

// ------------------------------------------------------------------ dialogs (a shape selected)
await stage(2);
await clickSel('#layers .shape-row[data-s="41"]').catch(async () => { await clickSel('#layers [data-toggle="L2"]'); await clickSel('#layers .shape-row[data-s="41"]'); });
for (const [n, k] of [['24-sheet-add-shape', 'add'], ['25-sheet-duplicate', 'dup'], ['26-sheet-reference', 'ref'], ['27-sheet-scale-calc', 'calc'], ['28-sheet-edit-points', 'points'], ['29-sheet-sections', 'marks'], ['30-sheet-resize', 'resize'], ['32-sheet-io-positions', 'io'], ['33-sheet-io-reverse', 'ioRev']]) {
  await act('sheet', { sheet: k }); await sleep(400);
  await boxShot(n + '.png', '#sheet', 16);
  await closeSheet(); await sleep(200);
}
await act('groupSheet'); await sleep(400); await boxShot('34-sheet-make-layer.png', '#sheet', 16); await closeSheet();
await jsClick('#fileChip'); await sleep(300); await boxShot('36-sheet-rename-job.png', '#sheet', 16); await closeSheet();
await jsClick('#addLayer'); await sleep(300); await boxShot('37-sheet-new-layer.png', '#sheet', 16); await closeSheet();
await viewport(1500);
await act('sheet', { sheet: 'defaults' }); await sleep(500); await boxShot('31-sheet-default-instructions.png', '#sheet', 16); await closeSheet();
await key('?', 'Slash', ['shift']); await sleep(500); await boxShot('35-sheet-shortcuts.png', '#sheet', 16); await closeSheet();
await viewport(0);

// ------------------------------------------------------------------ find any tool, settings
await key('Escape');
await key('k', 'KeyK', ['ctrl']); await sleep(300);
await shot('38-command-palette.png');
await js(`const q = document.getElementById('pq'); q.value = 'عكس'; q.dispatchEvent(new Event('input'));`);
await boxShot('39-command-palette-search.png', '.palette', 0, { q: '.palette .q', r1: '#plist li:nth-child(1)', r2: '#plist li:nth-child(2)', count: '#pcount' });
await key('Escape');
await jsClick('#settings'); await sleep(400);
for (const p of ['general', 'appearance', 'text', 'interface']) {
  await jsClick('#swt-' + p); await sleep(300);
  await boxShot('40-settings-' + p + '.png', '#setWin', 0, { t1: '#swt-general', t2: '#swt-appearance', t3: '#swt-text', t4: '#swt-interface', keys: '#keys', reset: '#swReset', done: '.sw-foot [data-close-set]' });
}
await js(`document.querySelector('.sw-body').scrollTop = 9999;`);
await boxShot('40-settings-interface-2.png', '#setWin', 0);
await key('Escape');

// ------------------------------------------------------------------ confirmations, messages, theme, hidden panel
await clickSel('#layers .layer-row[data-layer="L1"] .name', null, 'right'); await sleep(300);
await js(`[...document.querySelectorAll('#ctx button')].at(-1).click();`); await sleep(300);
await boxShot('41-confirm-delete-layer.png', '#sheet', 16); await closeSheet();
await key('Escape');
await act('op', { op: 'reverse' }); await sleep(200);
await boxShot('42-toast-error-select-first.png', '#toast', 12);
await sleep(4500);
await key('l', 'KeyL', ['ctrl', 'shift']); await sleep(500);
await stage(3);
await js(`const s = document.getElementById('stitchLayer'); s.value = 'L1'; s.dispatchEvent(new Event('change', { bubbles: true }));`); await sleep(500);
await move(5, 600);
await shot('43-dark-theme.png');
await key('l', 'KeyL', ['ctrl', 'shift']); await sleep(500);
await key('Tab', 'Tab', ['shift']); await sleep(700);
await rec('44-panel-hidden.png', EDITOR);
await shot('44-panel-hidden.png');
await key('Tab', 'Tab', ['shift']); await sleep(700);

// ------------------------------------------------------------------ unsaved changes, Home with recent files, a file it cannot open
await openPath(JOB); await sleep(300);
await boxShot('45-unsaved-changes-dialog.png', '#sheet', 16);
await jsClick('#sheet [data-nosave]'); await sleep(1600);
await key('h', 'KeyH', ['ctrl', 'shift']); await sleep(2800);
await rec('46-home-with-recent.png', { cont: '#homeContinue .home-cont', back: '#homeBack', recent: '#homeRecent', count: '#homeCount' });
await shot('46-home-with-recent.png');
await jsClick('#homeView [data-k="list"]'); await sleep(800);
await js(`document.querySelector('.home-main').scrollTop = 9999;`); await sleep(300);
await rec('47-home-recent-list.png', { view: '#homeView', recent: '#homeRecent', card: '#homeRecent .rcard', folders: '#homeRecent' });
const folders = await js(`return [...document.querySelectorAll('#homeRecent .folder')].map(e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });`);
RECTS['47-home-recent-list.png'].blur = folders.map(b => b.map(v => Math.round(v * DPR)));
await shot('47-home-recent-list.png');
await jsClick('#homeView [data-k="grid"]');
await key('Escape'); await sleep(600);
{
  const b64 = fs.readFileSync(path.join(ROOT, 'tests/data/drawings/unknown.xyz')).toString('base64');
  await js(`const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([u], 'unknown.xyz')); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));`);
  await sleep(700);
  await boxShot('48-toast-unsupported-file.png', '#toast', 12);
  await sleep(4500);
}

// ------------------------------------------------------------------ a laser layer that would cut slowly, and its fix
await openPath(SYNTH); await sleep(800);
await stage(3);
await clickSel('#insp [data-act="kind"][data-kind="laser"]'); await sleep(1300);
await js(`document.querySelector('#insp details[data-key="laserspeed"]').open = true;`); await sleep(300);
const LS = { status: '#insp details[data-key=laserspeed] summary .sum', warn: '#insp details[data-key=laserspeed] .callout', fix: '#insp [data-act=laserFix]', tiny: '#insp details[data-key=laserspeed] .row:nth-of-type(4)', toast: '#toast' };
await move(5, 600);
await rec('49-laser-slow-warning.png', { ...EDITOR, ...LS });
await shot('49-laser-slow-warning.png');
await stage(5);
await boxShot('50-output-laser-warning.png', '#insp .callout.warn', 10);
await stage(3);
await js(`document.querySelector('#insp details[data-key="laserspeed"]').open = true;`);
await clickSel('#insp [data-act="laserFix"]'); await sleep(1500);
await js(`document.querySelector('#insp details[data-key="laserspeed"]').open = true;`);
await move(5, 600);
await rec('51-laser-after-fix.png', { ...EDITOR, ...LS });
await shot('51-laser-after-fix.png');

fs.writeFileSync(path.join(SHOTS, 'rects.json'), JSON.stringify(RECTS, null, 1));
console.log('rects.json written:', Object.keys(RECTS).length, 'pictures');
ws.close();
