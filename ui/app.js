/* Stitchline UI: talks to the local engine (stitchline.py) through /api/<action>. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('stl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('stl.' + k, JSON.stringify(v)); } catch {} },
  };
  const fmt = (v, n = 2) => (+v).toFixed(n);
  const cm = mm => (mm / 10).toFixed(4);   // the canvas readout shows centimetres (the drawing itself is in mm)

  /* ------------------------------------------------------------------ state */
  let S = null;                          // last state from the engine
  let sel = new Set();                   // selected shape ids
  let stage = store.get('stage', 'import');
  // the simple mode (the default): layers, laser, stitch length, simulation and saving; Settings turns on the rest
  let simple = store.get('simple', true);
  const stg = () => simple ? 'simple' : stage;   // the panel shown: the simple one, or the stage's
  let curLayer = null;
  let tool = 'select';
  let viewMode = 'all';
  let showOrder = store.get('showOrder', false);
  let showStitch = store.get('showStitch', true);
  let progSel = -1;
  const view = { cx: 50, cy: 30, k: 4 };   // k = screen px per mm
  let autoFit = true;                      // refit on window resize until the user zooms or pans
  const sim = { on: false, playing: false, pos: 0, speed: 1, seq: [], raf: 0, last: 0 };
  const SIM_BASE = 1.8;   // the simulation's 1× runs a little under twice the machine's stitch rate
  const STAGES = ['import', 'arrange', 'stitch', 'sequence', 'output'];

  const shapeById = id => S.job.shapes.find(s => s.id === id);
  const layerById = id => S.job.layers.find(l => l.id === id);
  const layerOf = s => layerById(s.layer);
  const plen = (pts, closed) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (closed && pts.length > 2) d += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]); return d; };
  const nameOf = s => s.name || (s.pts.length === 1 ? 'Point' : s.closed ? 'Closed shape' : s.pts.length === 2 ? 'Line' : 'Path') + ' ' + s.id;
  const pathOf = s => s.closed && s.pts.length > 2 ? [...s.pts, s.pts[0]] : s.pts;
  const selected = () => [...sel].map(shapeById).filter(Boolean);
  /** Black or white, whichever reads better on a #rrggbb fill (the layer colour). */
  const inkOn = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m) return '#fff'; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 160 ? '#111' : '#fff'; };
  // a layer colour as drawn: white (the first layer's) and other very light colours are drawn in ink on the light canvas
  const ink = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m || document.documentElement.dataset.theme === 'dark') return c; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 215 ? colors.fg : c; };
  const isSewn = s => { const L = layerOf(s); return L.output && S.job.refs.align !== L.id; };

  /* ------------------------------------------------------------------ engine calls */
  let busyT = 0;
  async function api(op, args = {}, opts = {}) {
    clearTimeout(busyT);
    busyT = setTimeout(() => { $('#busyTxt').textContent = opts.busy || 'Working…'; $('#busy').hidden = false; }, 350);
    try {
      const r = await fetch('/api/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const d = await r.json();
      if (!r.ok) { toast(d.error || 'Something went wrong.', true); return null; }
      apply(d);
      if (d.message && !opts.quiet) toast(d.message);
      return d;
    } catch (e) {
      toast('Stitchline lost its connection. Close this window and start Stitchline again.', true);
      return null;
    } finally { clearTimeout(busyT); $('#busy').hidden = true; }
  }
  async function upload(file) {
    $('#busyTxt').textContent = 'Opening ' + file.name + '…'; $('#busy').hidden = false;
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: await file.arrayBuffer() });
      const d = await r.json();
      if (!r.ok) return toast(d.error || 'That file could not be opened.', true);
      sel.clear(); apply(d); opened(); if (d.message) toast(d.message);
    } finally { $('#busy').hidden = true; }
  }
  // a file was opened (or dropped) in place of the job
  function opened() {
    bestDone = false;
    pristine = true; sel.clear(); hideHome(); fitView();
    if (stage === 'import') setStage('arrange');
  }

  let stitchCache = {};
  function apply(d) {
    const firstLoad = !S;
    if (d.stitched_full || firstLoad) stitchCache = {};
    Object.assign(stitchCache, d.stitched);
    const live = {};
    for (const sh of d.job.shapes) if (stitchCache[sh.id]) live[sh.id] = stitchCache[sh.id];
    stitchCache = live; d.stitched = live;
    S = d;
    const ids = new Set(S.job.shapes.map(s => s.id));
    sel = new Set([...sel].filter(i => ids.has(i)));
    if (d.new_id != null) sel = new Set([d.new_id]);
    if (d.new_ids) sel = new Set(d.new_ids);
    if (!curLayer || !layerById(curLayer)) curLayer = S.job.layers[0]?.id || null;
    const fs = selected()[0]; if (fs) curLayer = fs.layer;
    buildSim();
    renderAll();
    renderHome();
    if (sim.on) { renderSeq(); syncSim(); simPaint(); seqTip(); }
    if (firstLoad) requestAnimationFrame(fitView);
  }

  /* ------------------------------------------------------------------ top bar */
  function renderTop() {
    $('#fileName').textContent = S.file.name + (S.file.dirty ? ' — edited' : '');
    $('#dirtyDot').classList.toggle('dirty', S.file.dirty);
    document.title = S.file.name + ' · Stitchline';
    $('#undo').disabled = !S.can_undo; $('#redo').disabled = !S.can_redo;
    $('#groupSel').disabled = !sel.size;
    $$('.stage').forEach(b => { b.setAttribute('aria-selected', b.dataset.stage === stage); b.classList.toggle('done', STAGES.indexOf(b.dataset.stage) < STAGES.indexOf(stage)); });
    const si = STAGES.indexOf(stage), last = si === STAGES.length - 1;
    $('#stepPrev').disabled = si === 0;
    $('#stepNext').disabled = !S.job.shapes.length;
    $('#stepNextLb').textContent = last ? 'Save machine file' : 'Next step';
    $('#stepNext').title = last ? 'Save machine file (Ctrl+Alt+E)' : 'Next step (Page Down)';
    $('#empty').hidden = S.job.shapes.length > 0;
    $('#heroRecent').innerHTML = S.recent.length ? `<div class="eyebrow" style="text-align:left;padding:8px 8px 2px">Recent</div>` + S.recent.slice(0, 5).map(p => `<button data-act="openRecent" data-path="${esc(p)}"><svg class="i" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg><span>${esc(p.split(/[\\/]/).pop())}</span></button>`).join('') : '';
    $('#showOrder').setAttribute('aria-pressed', showOrder);
    $('#showStitch').setAttribute('aria-pressed', showStitch);
    $('#showOrig').setAttribute('aria-pressed', !showStitch);
  }

  /* window buttons: the window has no Windows title bar; the top bar (and Home's top strip) drags it */
  const winctl = (action) => window.__TAURI_INTERNALS__?.invoke('window_ctl', { action }).then(maxed => {
    const w = $('#winctl'), b = $('#winctl [data-win="max"]');
    w.classList.toggle('maxed', maxed); b.title = maxed ? 'Restore' : 'Maximize'; b.setAttribute('aria-label', b.title);
  }).catch(() => {});
  $$('#winctl [data-win]').forEach(b => b.addEventListener('click', () => winctl(b.dataset.win)));
  addEventListener('resize', () => winctl('state'));
  winctl('state');

  /* ------------------------------------------------------------------ layers sidebar */
  const openLayers = new Set(store.get('openLayers', []));
  const thumb = (pts, closed) => {
    if (pts.length < 2) return `<svg viewBox="0 0 22 16"><circle cx="11" cy="8" r="2.2" fill="currentColor"/></svg>`;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = Math.min(18 / Math.max(1e-6, x1 - x0), 12 / Math.max(1e-6, y1 - y0));
    const step = Math.max(1, Math.floor(pts.length / 60));
    const pp = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(([x, y]) => `${(11 + (x - (x0 + x1) / 2) * k).toFixed(1)},${(8 - (y - (y0 + y1) / 2) * k).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 22 16"><${closed ? 'polygon' : 'polyline'} points="${pp}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  };
  // a newly selected shape opens its layer once; after that only the caret decides, so a layer closes over a selection
  let seenSel = new Set();
  function openForNewSel() {
    const fresh = [...sel].filter(id => !seenSel.has(id));
    seenSel = new Set(sel);
    if (!fresh.length) return;
    const layerOfId = new Map(S.job.shapes.map(s => [s.id, s.layer]));
    const n = openLayers.size;
    fresh.forEach(id => layerOfId.has(id) && openLayers.add(layerOfId.get(id)));
    if (openLayers.size !== n) store.set('openLayers', [...openLayers]);
  }
  function renderLayers() {
    const max = 300;
    openForNewSel();
    const rank = new Map(S.job.order.map((id, i) => [id, i]));   // shapes are listed in sewing order
    $('#layers').innerHTML = S.job.layers.map(L => {
      const shapes = S.job.shapes.filter(s => s.layer === L.id).sort((a, b) => (rank.get(a.id) ?? 1e15) - (rank.get(b.id) ?? 1e15));
      const open = openLayers.has(L.id);
      const align = S.job.refs.align === L.id;
      return `<div class="layer ${open ? '' : 'closed'} ${L.output ? '' : 'off'} ${L.id === curLayer ? 'cur' : ''}" data-l="${L.id}">
        <div class="layer-row" data-layer="${L.id}" draggable="true">
          <button class="caret-btn" data-toggle="${L.id}" aria-label="Show shapes"><svg class="caret" viewBox="0 0 12 12"><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" fill="none" stroke-width="1.5"/></svg></button>
          <span class="swatch" style="background:${esc(L.color)}" title="Layer colour"><input type="color" value="${esc(L.color)}" data-color="${L.id}" aria-label="Layer colour"></span>
          <span class="name" data-rename="${L.id}" title="Double-click to rename">${esc(L.name)}${align ? ' · align' : ''} <span class="cnt">${shapes.length}</span></span>
          ${simple ? `<button class="kind-pill ${isLaser(L) ? 'laser' : ''}" data-kindl="${L.id}" title="${isLaser(L) ? 'Laser cut: click to sew it' : 'Sewing: click to make it laser cut'}">${isLaser(L) ? 'Laser' : 'Sewing'}</button>`
                   : `<button class="needle" data-needle="${L.id}" title="Needle (click to change)">${isLaser(L) ? 'Laser' : 'N' + L.needle}</button>`}
          <button class="switch" role="switch" aria-checked="${L.output}" data-out="${L.id}" aria-label="Sew ${esc(L.name)}" title="Sew this layer"></button>
        </div>
        <div class="shapes">${shapes.slice(0, max).map(s => `
          <button class="shape-row" data-s="${s.id}" draggable="true" aria-selected="${sel.has(s.id)}">${thumb(s.pts, s.closed)}<span class="nm">${esc(nameOf(s))}</span><span class="meta">${plen(s.pts, s.closed).toFixed(0)} mm</span></button>`).join('')}
          ${shapes.length > max ? `<div class="more">+ ${shapes.length - max} more · select them on the drawing</div>` : ''}
        </div>
      </div>`;
    }).join('') || `<p class="hint" style="padding:8px 18px">No layers yet. Open a drawing or add a shape.</p>`;
  }
  $('#layers').addEventListener('click', e => {
    const sh = e.target.closest('[data-s]');
    if (sh) { pick(+sh.dataset.s, e.ctrlKey || e.metaKey, e.shiftKey); return; }
    const t = e.target.closest('[data-toggle]');
    if (t) { const id = t.dataset.toggle; openLayers.has(id) ? openLayers.delete(id) : openLayers.add(id); store.set('openLayers', [...openLayers]); renderLayers(); return; }
    const o = e.target.closest('[data-out]');
    if (o) { const L = layerById(o.dataset.out); api('update_layer', { id: L.id, fields: { output: !L.output } }, { quiet: true }); return; }
    const n = e.target.closest('[data-needle]');
    const kd = e.target.closest('[data-kindl]');
    if (kd) { const L = layerById(kd.dataset.kindl); curLayer = L.id; setKind(L.id, isLaser(L) ? 'sew' : 'laser'); return; }
    if (n) { const L = layerById(n.dataset.needle); const r = n.getBoundingClientRect(); menu(r.left, r.bottom + 4, [1, 2, 3].map(k => [`${k === L.needle ? '✓ ' : ''}Needle ${k}`, () => api('update_layer', { id: L.id, fields: { needle: k } }, { quiet: true })])); return; }
    if (e.target.closest('[data-color]')) return;
    const row = e.target.closest('[data-layer]');
    if (row) { curLayer = row.dataset.layer; selChanged(); }
  });
  $('#layers').addEventListener('change', e => {
    const c = e.target.closest('[data-color]');
    if (c) api('update_layer', { id: c.dataset.color, fields: { color: c.value } }, { quiet: true });
  });
  $('#layers').addEventListener('dblclick', e => {
    const r = e.target.closest('[data-rename]'); if (!r) return;
    const L = layerById(r.dataset.rename);
    r.innerHTML = `<input class="rename" value="${esc(L.name)}">`;
    r.closest('.layer-row').draggable = false;   // so the mouse selects text in the field instead of dragging the layer
    const inp = $('input', r); inp.focus(); inp.select();
    const done = ok => { if (ok && inp.value.trim() && inp.value !== L.name) api('update_layer', { id: L.id, fields: { name: inp.value.trim() } }, { quiet: true }); else renderLayers(); };
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
    inp.addEventListener('blur', () => done(true));
  });
  /* drag in the layers list. A shape row moves the shape (and the rest of the selection, when it is selected) in the
     sewing order, into the layer of the row it lands on; dropped on a layer's own row it goes to the end of that layer.
     A layer row moves the layer. The top half of a row means above it, the bottom half below it. */
  function wireDrag(box) {
    let lDrag = null;   // { ids, set } while dragging shapes, { layer } while dragging a layer
    const below = (e, el) => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    const clear = () => $$('.over, .under, .into', box).forEach(el => el.classList.remove('over', 'under', 'into'));
    const target = e => {
      if (lDrag.layer) {
        const L = e.target.closest('.layer');
        return L && L.dataset.l !== lDrag.layer ? { el: L, cls: below(e, L) ? 'under' : 'over', layer: L.dataset.l } : null;
      }
      const r = e.target.closest('.shape-row');
      if (r) return lDrag.set.has(+r.dataset.s) ? null : { el: r, cls: below(e, r) ? 'under' : 'over', shape: +r.dataset.s };
      const lr = e.target.closest('.layer-row');
      return lr ? { el: lr, cls: 'into', layer: lr.dataset.layer } : null;
    };
    box.addEventListener('dragstart', e => {
      const sr = e.target.closest('.shape-row'), lr = e.target.closest('.layer-row');
      if (sr) { const id = +sr.dataset.s; const ids = sel.has(id) ? S.job.order.filter(i => sel.has(i)) : [id]; lDrag = { ids, set: new Set(ids) }; sr.classList.add('drag'); }
      else if (lr) { lDrag = { layer: lr.dataset.layer }; lr.closest('.layer').classList.add('drag'); }
      else return;
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', '');
    });
    box.addEventListener('dragend', () => { $$('.drag', box).forEach(el => el.classList.remove('drag')); clear(); lDrag = null; });
    box.addEventListener('dragover', e => {
      if (!lDrag) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; clear();
      const t = target(e); if (t) t.el.classList.add(t.cls);
    });
    box.addEventListener('drop', e => {
      if (!lDrag) return;
      e.preventDefault(); clear();
      const t = target(e); if (!t) return;
      if (lDrag.layer) {
        const from = S.job.layers.findIndex(l => l.id === lDrag.layer);
        const rest = S.job.layers.map(l => l.id).filter(id => id !== lDrag.layer);
        const to = rest.indexOf(t.layer) + (t.cls === 'under' ? 1 : 0);
        if (to !== from) moveLayer(lDrag.layer, to - from);
        return;
      }
      const { ids, set } = lDrag;
      const layerOfId = new Map(S.job.shapes.map(s => [s.id, s.layer]));
      const rest = S.job.order.filter(i => !set.has(i));
      let at = null, layer;
      if (t.shape != null) { at = rest.indexOf(t.shape) + (t.cls === 'under' ? 1 : 0); layer = layerOfId.get(t.shape); }
      else { layer = t.layer; const last = rest.findLastIndex(i => layerOfId.get(i) === layer); if (last >= 0) at = last + 1; }
      const order = at == null ? S.job.order : [...rest.slice(0, at), ...ids, ...rest.slice(at)];
      const moved = ids.some(i => layerOfId.get(i) !== layer);
      if (!moved && order.every((v, i) => v === S.job.order[i])) return;   // dropped where it already was
      api('place', { ids, order, ...(moved ? { layer } : {}) }, { quiet: true });
    });
  }
  wireDrag($('#layers'));
  $('#layers').addEventListener('contextmenu', e => {
    // a shape row: right-click a row outside the selection selects it, then the menu makes a group of the selection
    const sr = e.target.closest('.shape-row');
    if (sr) {
      e.preventDefault(); const id = +sr.dataset.s;
      if (!sel.has(id)) { sel = new Set([id]); selChanged(); }
      return menu(e.clientX, e.clientY, [['Create group', () => ACT.groupSheet(), 'Ctrl G']]);
    }
    const row = e.target.closest('[data-layer]'); if (!row) return;
    e.preventDefault(); const id = row.dataset.layer;
    const gi = S.job.layers.findIndex(l => l.id === id);
    if (simple) return menu(e.clientX, e.clientY, [
      ['Rename…', () => $(`[data-rename="${id}"]`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))],
      isLaser(layerById(id)) ? ['Make this a sewing layer', () => setKind(id, 'sew')] : ['Make this a laser cut layer', () => setKind(id, 'laser')],
      ...(gi > 0 ? [['Sew this layer earlier', () => moveLayer(id, -1)]] : []),
      ...(gi < S.job.layers.length - 1 ? [['Sew this layer later', () => moveLayer(id, 1)]] : []),
    ]);
    menu(e.clientX, e.clientY, [
      ['Select all shapes in this layer', () => { sel = new Set(S.job.shapes.filter(s => s.layer === id).map(s => s.id)); selChanged(); }],
      ['Rename…', () => $(`[data-rename="${id}"]`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))],
      isLaser(layerById(id)) ? ['Make this a sewing layer', () => setKind(id, 'sew')] : ['Make this a laser cut layer', () => setKind(id, 'laser')],
      ...(isLaser(layerById(id)) ? [] : [['Use these stitch settings for every layer', () => copySettings(id)]]),
      ...(gi > 0 ? [['Move layer up', () => moveLayer(id, -1)]] : []),
      ...(gi < S.job.layers.length - 1 ? [['Move layer down', () => moveLayer(id, 1)]] : []),
      null,
      ...(S.job.layers.length > 1 ? [['Delete layer, keep its shapes', () => api('ungroup', { id }, { quiet: true }).then(d => d && toast('Layer removed; its shapes moved to the layer above'))]] : []),
      ['Delete layer and its shapes', () => confirmSheet('Delete layer?', `“${esc(layerById(id).name)}” and all of its shapes will be removed. You can undo this.`, 'Delete', () => api('delete_layer', { id }))],
    ]);
  });

  // in the simple mode (and in the sequence window) the layers are sewn in the order of the list, so moving one also
  // moves its shapes in the sewing order
  const moveLayer = (id, delta) => api('move_group', { id, delta, follow: simple || sim.on }, { quiet: true });

  function pick(id, toggle, add) {
    if (toggle) sel.has(id) ? sel.delete(id) : sel.add(id);
    else if (add) sel.add(id);
    else sel = new Set([id]);
    const s = shapeById(id); if (s) curLayer = s.layer;
    selChanged();
  }

  /* ------------------------------------------------------------------ inspector helpers */
  const ICO = {
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>', down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>', right: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    centre: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    usb: '<svg viewBox="0 0 24 24"><path d="M12 2v14M8 6l4-4 4 4M7 12v2a5 5 0 0 0 10 0v-2"/><circle cx="12" cy="20" r="2"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  };
  const fld = (id, v, u = 'mm', cls = '', set = '') => `<span class="field ${cls}"><input id="${id}" value="${esc(v)}" inputmode="decimal" ${set ? `data-set="${set}"` : ''} autocomplete="off"><u>${u}</u></span>`;
  const row = (label, ctl, forId = '') => `<div class="row"><label ${forId ? `for="${forId}"` : ''}>${label}</label>${ctl}</div>`;
  const sw = (id, on, set = '', cls = 'blue') => `<button class="switch ${cls}" role="switch" id="${id}" aria-checked="${!!on}" ${set ? `data-set="${set}"` : ''}></button>`;
  const sec = (key, title, sum, body, open = false) => `<details class="sec" data-key="${key}" ${(openSecs[key] ?? open) ? 'open' : ''}><summary><svg class="chev" viewBox="0 0 12 12"><path d="M4.5 3 7.5 6 4.5 9" stroke="currentColor" fill="none" stroke-width="1.6"/></svg>${title}<span class="sum">${sum}</span></summary><div class="sec-body">${body}</div></details>`;
  const openSecs = store.get('openSecs', {});
  const LS = () => layerById(curLayer)?.settings || {};
  const nextLayerName = () => { const used = new Set(S.job.layers.map(l => l.name.toLowerCase())); let n = S.job.layers.length + 1; while (used.has('layer' + n)) n++; return 'Layer' + n; };
  // Laser cutting follows the line once: head 3 (switches the laser output), no needle points, nothing sewn twice.
  const LASER = { convert: false, bt_start: 0, bt_end: 0, cl_start: 0, cl_end: 0, end_repeat: 0, corner_slow: false, corner_dense: false, se_dense: false, double_on: false };
  const SEWING = { convert: true, bt_start: 1, bt_end: 1, bt_start_rep: 2, bt_end_rep: 2, corner_slow: true };
  const isLaser = L => L && L.needle === 3 && !L.settings.convert && !L.settings.bt_start && !L.settings.bt_end && !L.settings.cl_start && !L.settings.cl_end && !L.settings.end_repeat;
  // waits the machine program adds around every laser cut (Head 3 shape start / end, in ms)
  const laserWaitMs = () => ['Head 3 shape start', 'Head 3 shape end'].reduce((a, ev) => a + (S.defaults[ev] || [])
    .filter(i => i.name === 'Delay').reduce((b, i) => b + (parseFloat(i.value) || 0), 0), 0);
  function laserSpeedSection(L) {
    const c = S.laser && S.laser[L.id];
    if (!c) return '';
    const wait = c.shapes * laserWaitMs() / 1000;
    const slow = c.tiny > 0 || c.joinable > 0;
    return sec('laserspeed', 'Laser speed', slow ? 'may cut slowly' : 'ready', `
      ${slow ? `<div class="callout warn" style="margin:0"><svg viewBox="0 0 24 24"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg><div>This layer may cut slowly.</div></div>`
             : `<div class="callout" style="margin:0"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg><div>Paths are clean: the laser can cut at full speed.</div></div>`}
      ${row('Separate cuts', `<b class="num">${c.shapes}</b>`)}
      ${row('Waiting at cut starts and ends', `<b class="num">${wait.toFixed(1)} s</b>`)}
      ${row('Points', `<b class="num">${c.points}</b>`)}
      ${row('Tiny segments (under 0.5 mm)', `<b class="num" style="color:${c.tiny ? 'var(--warn)' : 'inherit'}">${c.tiny}</b>`)}
      ${row('Line ends that touch (can be one cut)', `<b class="num" style="color:${c.joinable ? 'var(--warn)' : 'inherit'}">${c.joinable}</b>`)}
      <button class="btn primary" data-act="laserFix" ${slow ? '' : 'disabled'}>Speed up laser paths</button>
      <p class="hint">Joins lines that touch into one cut, removes points the cut does not need and cuts in the shortest order. The cut stays within 0.05 mm of the drawing. You can undo it.</p>`, slow);
  }
  // a laser layer is red and cut after all the sewing (the layer goes last); back to sewing, a red layer turns white
  const LASER_RED = '#ff3b30';
  const setKind = (lid, kind, color = LASER_RED) => api('update_layer', { id: lid, laser_last: true, fields: kind === 'laser' ? { needle: 3, settings: LASER, color }
    : { needle: 1, settings: SEWING, ...(layerById(lid)?.color?.toLowerCase() === LASER_RED ? { color: '#ffffff' } : {}) } }, { quiet: true })
    .then(d => d && toast(kind === 'laser' ? 'This layer is now laser cut (needle 3)' : 'This layer is now sewn (needle 1)'));
  const J = () => S.job.settings;
  const lsf = (key, u = 'mm', cls = '') => fld('ls_' + key, LS()[key], u, cls, 'layer:' + key);
  const jf = (key, u = 'mm', cls = '') => fld('j_' + key, J()[key], u, cls, 'job:' + key);
  const lsw = key => sw('ls_' + key, LS()[key], 'layer:' + key);
  const jsw = key => sw('j_' + key, J()[key], 'job:' + key);
  const num = id => { const v = parseFloat(String($('#' + id)?.value ?? '').replace(',', '.')); return Number.isFinite(v) ? v : 0; };
  const needSel = () => { if (!sel.size) { toast('Select a shape first — click it on the drawing or in Layers.', true); return false; } return true; };

  /* ------------------------------------------------------------------ inspector panels */
  const PANELS = {
    // the simple mode: one panel for the current layer (sewing or laser, stitch length), the simulation and saving
    simple: () => {
      if (!S.job.shapes.length) return {
        title: 'Start a job', sub: 'Open a pattern drawing to sew or cut it.',
        body: `<div class="ss"><button class="btn primary big" data-act="open">Open drawing…</button><div class="fmt">DXF · AI · PLT · PRT · DST · DSB · SLW</div></div>`,
        foot: '',
      };
      const L = layerById(curLayer);
      const laser = isLaser(L), st = S.stats;
      const n = S.job.shapes.filter(x => x.layer === L.id).reduce((a, x) => a + (S.stitched[x.id]?.f.length || 0), 0);
      const c = S.laser && S.laser[L.id], slow = laser && c && (c.tiny > 0 || c.joinable > 0);
      return {
        title: 'Your job', sub: 'Pick a layer, set it, try it, then save it for the machine.',
        pick: `<div class="layer-pick"><span class="swatch" style="background:${esc(L.color)}"></span><select class="sel" id="stitchLayer" style="flex:1" aria-label="Layer">${S.job.layers.map(l => `<option value="${l.id}" ${l.id === L.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`,
        body: `
          <div class="ss">
            <h4>This layer is</h4>
            <div class="seg kind-seg" role="group" aria-label="This layer is"><button aria-pressed="${!laser}" data-act="kind" data-kind="sew"><svg viewBox="0 0 24 24"><path d="M3 17c4-2 6-8 9-10s6 0 9-2" stroke-dasharray="2.5 2.5"/></svg>Sewing</button><button aria-pressed="${laser}" data-act="kind" data-kind="laser"><svg viewBox="0 0 24 24"><path d="M12 3v7M12 14v7M3 12h7M14 12h7"/><circle cx="12" cy="12" r="1.5"/></svg>Laser cut</button></div>
            ${laser ? `<p class="hint">Laser cut: needle 3 switches the laser on (output IO 5) and the cut follows each line once, with no stitches, back-tack or overlap.</p>` : ''}
          </div>
          ${laser ? (slow ? `<div class="ss">
            <div class="callout warn" style="margin:0"><svg viewBox="0 0 24 24"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg><div>This layer may cut slowly.</div></div>
            <button class="btn primary" data-act="laserFix">Speed up laser paths</button></div>` : '') : `
          <div class="ss big-slider">${row('Stitch length', fld('lenNum', +(+L.settings.stitch_len).toFixed(2), 'mm', '', 'layer:stitch_len'), 'lenNum')}
            <input type="range" id="lenRange" min="0.5" max="12" step="0.1" value="${L.settings.stitch_len}" aria-label="Stitch length">
            <p class="hint">${n.toLocaleString()} needle positions in this layer</p></div>`}
          <div class="ss">
            <h4>Try it</h4>
            <button class="btn big" data-act="sequence"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01" stroke-width="3"/></svg>Sequence</button>
            <button class="btn big" data-act="simulate"><svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>Simulate sewing</button>
            <p class="hint">See and change the order of sewing and laser cutting, and watch the needle and the laser go over the job.</p>
          </div>`,
        foot: `<div class="simple-stats"><div><span class="k">Needle positions</span><b class="num">${st.stitches.toLocaleString()}</b></div><div><span class="k">Estimated time</span><b class="num">${fmtTime(st.seconds)}</b></div></div>
          <button class="btn primary big" data-act="saveMachine">${ICO.save}Save machine file…</button>` +
          S.drives.map(d => `<button class="btn big" data-act="saveUsb" data-drive="${esc(d)}">${ICO.usb}Save to USB drive ${esc(d.replace('\\', ''))}</button>`).join(''),
      };
    },
    import: () => {
      const dpi = J().dpi;
      return {
        title: 'Import', sub: 'Bring in a drawing and set how it is read.',
        body: `
          <div class="drop"><svg viewBox="0 0 24 24" style="width:26px;height:26px;stroke:var(--fg-3);fill:none;stroke-width:1.5"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
            <div>Drop a drawing anywhere in the window, or</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn primary" data-act="open">Open file…</button><button class="btn" data-act="insert" ${S.job.shapes.length ? '' : 'disabled'}>Insert into job…</button></div>
            <div class="fmt">DXF · AI · PLT · PRT · DST · DSB · SLW</div></div>
          ${S.recent.length ? sec('recent', 'Recent files', S.recent.length + '', `<div class="recent">${S.recent.map(p => `<button data-act="openRecent" data-path="${esc(p)}" title="${esc(p)}"><span>${esc(p.split(/[\\/]/).pop())}</span></button>`).join('')}</div>`, true) : ''}
          ${sec('opening', 'When opening a file', 'clean-up', `
            ${row('Remove overlapping shapes', jsw('remove_overlap'))}
            ${row("Don't join lines automatically", jsw('no_join'))}
            ${row('Work without a reference point', jsw('no_reference'))}`, true)}
          ${sec('res', 'Resolution', dpi + ' dpi', `
            <div class="seg" role="group" style="justify-self:start"><button aria-pressed="${dpi == 1016}" data-act="dpi" data-v="1016">1016 dpi</button><button aria-pressed="${dpi == 1000}" data-act="dpi" data-v="1000">1000 dpi</button></div>
            ${row('Custom', jf('dpi', 'dpi'))}
            <p class="hint">Used for PLT and PRT files. Open the file again after changing it.</p>`)}
          ${sec('scale', 'Scale drawing', `X ${fmt(J().scale_x, 3)} · Y ${fmt(J().scale_y, 3)}`, `
            ${row('Horizontal (X)', jf('scale_x', '×'))}${row('Vertical (Y)', jf('scale_y', '×'))}
            ${row('Apply when opening a file', jsw('scale_on_open'))}
            <div class="grid2"><button class="btn" data-act="scaleNow">Scale drawing now</button><button class="btn" data-act="sheet" data-sheet="calc">From a measurement…</button></div>`)}
          ${sec('table', 'Machine table', `${J().table_w} × ${J().table_h} mm`, `${row('Width', jf('table_w'))}${row('Height', jf('table_h'))}`)}`,
        foot: `<button class="btn primary big" data-goto="arrange" ${S.job.shapes.length ? '' : 'disabled'}>Continue to Arrange</button>`,
      };
    },
    arrange: () => {
      const ss = selected();
      if (!ss.length) return {
        title: 'Arrange', sub: `${S.job.shapes.length} shapes in ${S.job.layers.length} layers. Click a shape to edit it.`,
        body: `
          <div class="callout">${ICO.info}<div>Click a shape on the drawing or in Layers. Hold <kbd>Ctrl</kbd> to pick several, or drag a box around them.</div></div>
          ${sec('whole', 'Whole drawing', 'all shapes', `
            <div class="grid2"><button class="btn" data-act="selectAll">Select all</button><button class="btn" data-act="sheet" data-sheet="add">Add a shape…</button></div>
            <div class="grid2"><button class="btn" data-act="allOp" data-op="remove_overlaps">Remove overlaps</button><button class="btn" data-act="allOp" data-op="join">Join lines &lt; 2 mm</button></div>`, true)}`,
        foot: `<button class="btn primary big" data-goto="stitch">Continue to Stitch</button>`,
      };
      const one = ss.length === 1 ? ss[0] : null;
      const L = layerOf(ss[0]);
      const total = ss.reduce((a, s) => a + plen(s.pts, s.closed), 0);
      return {
        title: one ? esc(nameOf(one)) : `${ss.length} shapes`,
        sub: one ? `${esc(L.name)} · ${plen(one.pts, one.closed).toFixed(1)} mm · ${one.pts.length} points · ${one.closed ? 'closed' : 'open'}` : `${total.toFixed(1)} mm in total`,
        body: `
          ${sec('move', 'Move', 'nudge', `
            <div style="display:flex;gap:16px;align-items:center">
              <div class="pad"><span></span><button data-act="nudge" data-dx="0" data-dy="1" aria-label="Up">${ICO.up}</button><span></span><button data-act="nudge" data-dx="-1" data-dy="0" aria-label="Left">${ICO.left}</button><button data-act="toOrigin" title="Move to the origin (0, 0)" aria-label="Move to origin">${ICO.centre}</button><button data-act="nudge" data-dx="1" data-dy="0" aria-label="Right">${ICO.right}</button><span></span><button data-act="nudge" data-dx="0" data-dy="-1" aria-label="Down">${ICO.down}</button><span></span></div>
              <div style="display:grid;gap:6px;flex:1"><label for="ns" style="color:var(--fg-2)">Step</label>${fld('ns', store.get('nudge', '0.10'))}</div>
            </div>
            <div class="row">${fld('mvx', '0.000', 'X')}${fld('mvy', '0.000', 'Y')}<button class="btn grow" data-act="moveBy" title="Move (Enter)">Move</button></div>`, true)}
          ${sec('rot', 'Rotate, mirror & size', '', `
            <div class="row">${fld('ang', store.get('ang', '90.00'), '°')}<button class="btn grow" data-act="rotate" title="Rotate (R)">Rotate</button></div>
            <div class="grid2"><button class="btn" data-act="mirror" data-axis="h" title="Mirror left–right (O)">Mirror left–right</button><button class="btn" data-act="mirror" data-axis="v" title="Mirror up–down (Shift+O)">Mirror up–down</button></div>
            <button class="btn" data-act="sheet" data-sheet="resize" title="Resize (S)">Resize…</button>`, true)}
          ${sec('path', 'Shape path', 'start · direction · ends', `
            <div class="grid2"><button class="btn" data-act="tool" data-tool="start" title="Pick start point (C)">Pick start point</button><button class="btn" data-act="op" data-op="reverse" title="Reverse direction (Ctrl+Alt+R)">Reverse direction</button></div>
            <span class="lbl" style="color:var(--fg-2)">Start every shape at the</span>
            <div class="grid4"><button class="btn sm" data-act="startAt" data-side="top">Top</button><button class="btn sm" data-act="startAt" data-side="bottom">Bottom</button><button class="btn sm" data-act="startAt" data-side="left">Left</button><button class="btn sm" data-act="startAt" data-side="right">Right</button></div>
            ${row('Extend start (+) / shorten (−)', fld('es', '0.000'))}${row('Extend end (+) / shorten (−)', fld('ee', '0.000'))}
            <button class="btn" style="justify-self:end" data-act="extend">Apply to ends</button>
            ${one ? `<button class="btn ghost" style="justify-self:start" data-act="sheet" data-sheet="points">Edit points one by one…</button>` : ''}`)}
          ${sec('org', 'Organize', esc(L.name), `
            <button class="btn primary" data-act="groupSheet">Make a layer from the selection</button>
          ${row('Layer', `<select class="sel" id="layerSel">${S.job.layers.map(l => `<option value="${l.id}" ${l.id === L.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}<option value="__new">New layer…</option></select>`)}
            ${one ? row('Name', `<span class="field wide" style="width:170px"><input id="shapeName" value="${esc(one.name)}" placeholder="${esc(nameOf(one))}"></span>`) : ''}
            <div class="grid2"><button class="btn" data-act="sheet" data-sheet="dup">Duplicate…</button><button class="btn" data-act="sheet" data-sheet="ref">Reference point…</button></div>
            <div class="grid2"><button class="btn" data-act="sheet" data-sheet="marks">Sections (zigzag…)</button><button class="btn danger" data-act="op" data-op="delete">Delete</button></div>`)}
          ${sec('clean', 'Clean up', '', `
            <div class="row">${fld('cp', '0.30')}<button class="btn grow" data-act="merge">Merge close points</button></div>
            <div class="row">${fld('sl', '3.50')}<button class="btn grow" data-act="short">Delete shorter lines</button></div>
            <div class="row">${fld('jt', '2.00')}<button class="btn grow" data-act="join" title="Join line ends (Ctrl+J)">Join line ends</button></div>
            <button class="btn" data-act="op" data-op="remove_overlaps">Remove overlapping copies</button>`)}`,
        foot: `<button class="btn primary big" data-goto="stitch">Continue to Stitch</button>`,
      };
    },
    stitch: () => {
      const L = layerById(curLayer);
      if (!L) return { title: 'Stitch', sub: 'Open a drawing first.', body: '', foot: '' };
      const s = LS(), j = J(); const comp = j.comp || {};
      const n = S.job.shapes.filter(x => x.layer === L.id).reduce((a, x) => a + (S.stitched[x.id]?.f.length || 0), 0);
      return {
        title: 'Stitch', sub: 'Settings apply to every shape in the layer.',
        pick: `<div class="layer-pick"><span class="swatch" style="background:${esc(L.color)}"></span><select class="sel" id="stitchLayer" style="flex:1">${S.job.layers.map(l => `<option value="${l.id}" ${l.id === L.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`,
        body: `
          <div class="sec plain"><div class="sec-body">
            ${row('This layer is', `<div class="seg" role="group"><button aria-pressed="${!isLaser(L)}" data-act="kind" data-kind="sew">Sewing</button><button aria-pressed="${isLaser(L)}" data-act="kind" data-kind="laser">Laser cut</button></div>`)}
            ${isLaser(L) ? `<p class="hint">Laser cut: needle 3 switches the laser on (output IO 5) and the cut follows each line once, with no stitches, back-tack or overlap.</p>` : ''}
          </div></div>
          ${L.needle === 3 ? laserSpeedSection(L) : ''}
          <div class="sec plain" ${isLaser(L) ? 'hidden' : ''}><div class="sec-body">
            <div class="big-slider">${row('Stitch length', fld('lenNum', +(+s.stitch_len).toFixed(2), 'mm', '', 'layer:stitch_len'), 'lenNum')}
              <input type="range" id="lenRange" min="0.5" max="12" step="0.1" value="${s.stitch_len}" aria-label="Stitch length">
              <p class="hint">${n.toLocaleString()} needle positions in this layer</p></div>
            ${row('Convert lines to stitches', lsw('convert'))}
            ${s.convert ? '' : `<p class="hint">Off: the machine sews along each line with its own stitch length.</p>`}
            ${row('Sewing head', `<select class="sel" id="needleSel">${[1, 2, 3].map(k => `<option value="${k}" ${L.needle === k ? 'selected' : ''}>Needle ${k}</option>`).join('')}</select>`)}
            ${row('Sew this layer', sw('lout', L.output, '', 'blue'))}
          </div></div>
          ${isLaser(L) ? '' : `
          ${sec('bt', 'Back-tack (open lines)', `${s.bt_start} start · ${s.bt_end} end`, `
            ${row('Start stitches', lsf('bt_start', 'st'))}${row('Start repeats', lsf('bt_start_rep', '×'))}
            ${row('End stitches', lsf('bt_end', 'st'))}${row('End repeats', lsf('bt_end_rep', '×'))}`)}
          ${sec('cl', 'Closed shapes', `${s.cl_start} · ${s.cl_end} · ${s.end_repeat}`, `
            ${row('Start reinforcement', lsf('cl_start', 'st'))}${row('Repeats', lsf('cl_start_rep', '×'))}
            ${row('Overlap past the start', lsf('cl_end', 'st'))}${row('Repeats', lsf('cl_end_rep', '×'))}
            ${row('End repeat stitches', lsf('end_repeat', 'st'))}`)}
          ${sec('corner', 'Corners', `${s.corner_angle}°${s.corner_slow ? ' · slow ' + s.corner_slow_n : ''}${s.corner_dense ? ' · dense' : ''}`, `
            ${row('Corner angle', lsf('corner_angle', '°'))}
            ${row('Slow down at corners', lsw('corner_slow'))}${row('Slow stitches', lsf('corner_slow_n', 'st'))}
            ${row('Dense stitches at corners', lsw('corner_dense'))}${row('Dense stitch count', lsf('corner_dense_n', 'st'))}${row('Density factor', lsf('corner_dense_f', '×'))}`)}
          ${sec('se', 'Dense start & end', s.se_dense ? s.se_dense_n + ' st' : 'off', `
            ${row('Dense stitches at start / end', lsw('se_dense'))}${row('Dense stitch count', lsf('se_dense_n', 'st'))}${row('Density factor', lsf('se_dense_f', '×'))}`)}
          ${sec('sp', 'Special & double length', s.double_on ? 'double on' : (s.special_len ? 'special ' + s.special_len : 'off'), `
            ${row('Special stitch length', lsf('special_len'))}<p class="hint">For sections marked “special”. 0 keeps the drawn points.</p>
            ${row('Special speed', lsf('special_speed', 'rpm'))}${row('Separate speed for special parts', lsw('special_needle'))}
            ${row('Use double stitch length', lsw('double_on'))}${row('Double length', lsf('double_len'))}
            <div class="grid2">${row('Odd stitches', sw('ls_double_odd', s.double_odd, 'layer:double_odd'))}${row('Even', sw('ls_double_even', s.double_even, 'layer:double_even'))}</div>`)}
`}
          ${sec('mach', 'Machine', `origin ${({ bl: 'bottom-left', br: 'bottom-right', tl: 'top-left', tr: 'top-right' })[j.origin]}`, `
            <span style="color:var(--fg-2)">Machine origin (corner of the drawing)</span>
            <div class="origin">${[['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']].map(([c, t]) => `<button data-c="${c}" data-act="origin" aria-pressed="${j.origin === c}">${t}</button>`).join('')}</div>
            ${row('Small closed shapes become one point', jsw('points_on'))}${row('…when smaller than', jf('points_range'))}
            ${row('Backlash compensation', sw('compOn', comp.on))}
            ${row('X− / X+', `<span style="display:flex;gap:4px">${fld('cxm', comp['x-'] ?? 0, 'mm', 'sm')}${fld('cxp', comp['x+'] ?? 0, 'mm', 'sm')}</span>`)}
            ${row('Y− / Y+', `<span style="display:flex;gap:4px">${fld('cym', comp['y-'] ?? 0, 'mm', 'sm')}${fld('cyp', comp['y+'] ?? 0, 'mm', 'sm')}</span>`)}`)}
          <div class="callout"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><div><div class="legend"><span><i style="background:var(--thread)"></i>stitch</span><span><i style="background:var(--tack)"></i>back-tack</span><span><i style="background:var(--dense)"></i>dense</span><span><i style="background:var(--warn)"></i>slow</span><span><i style="background:var(--zig)"></i>zigzag</span><span><i style="background:var(--special)"></i>special</span></div></div></div>
          ${isLaser(L) ? '' : `<div style="padding:0 10px"><button class="btn ghost" data-act="copySettings" style="width:100%">Use these settings for every layer</button></div>`}`,
        foot: `<button class="btn primary big" data-goto="sequence">Continue to Sequence</button>`,
      };
    },
    sequence: () => {
      const all = S.job.order.map(shapeById).filter(Boolean);
      return {
        title: 'Sewing order', sub: 'Drag to reorder. Point at a shape to see its number and the shapes sewn before and after it.',
        body: `
          <div class="sec plain"><div class="sec-body">
            <ol class="order" id="order">${all.map((s, i) => `<li draggable="true" data-id="${s.id}" class="${sel.has(s.id) ? 'sel' : ''}" style="${isSewn(s) ? '' : 'opacity:.45'}"><span class="badge" style="background:${esc(layerOf(s).color)};color:${inkOn(layerOf(s).color)}">${i + 1}</span>${thumb(s.pts, s.closed)}<span class="nm">${esc(nameOf(s))}</span><span class="mono" style="color:var(--fg-3);font-size:11px">${esc(layerOf(s).name)}</span></li>`).join('')}</ol>
          </div></div>
          ${sec('sort', 'Sort automatically', 'rows', `
            <div class="grid2"><button class="btn" data-act="sort" data-dir="tb">Top → bottom</button><button class="btn" data-act="sort" data-dir="bt">Bottom → top</button><button class="btn" data-act="sort" data-dir="lr">Left → right</button><button class="btn" data-act="sort" data-dir="rl">Right → left</button></div>
            <button class="btn primary" data-act="byGroup">Layer by layer (follow the layer list)</button>
            <p class="hint">Sews each layer completely before the next one, e.g. all sewing first and the laser cut layer last. Move a layer up or down by right-clicking it.</p>
            <button class="btn" data-act="nearest">Shortest travel (nearest next)</button>
            ${row('Sort by end point', jsw('sort_by_end'))}${row('Row spacing', jf('row_spacing'))}`, true)}
          ${sec('travel', 'Travel moves', `${(S.stats.travel / 1000).toFixed(2)} m`, `
            ${row('Corner instructions on travel moves', jsw('travel_corners'))}${row('Corner angle', jf('travel_corner_angle', '°'))}`)}`,
        foot: `<p class="hint" style="text-align:center">The simulation shows the order and path. ×1 is not the machine's real speed; laser pauses show the waits written to the machine file.</p><button class="btn big" data-act="simulate"><svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>Simulate sewing</button><button class="btn primary big" data-goto="output">Continue to Output</button>`,
      };
    },
    output: () => {
      const st = S.stats, j = J();
      const anchor = progAnchor();
      return {
        title: 'Output to machine', sub: 'Check the program, then save it for the machine.',
        body: `
          ${S.job.layers.filter(l => S.laser && S.laser[l.id] && (S.laser[l.id].tiny || S.laser[l.id].joinable)).map(l => `<div class="callout warn"><svg viewBox="0 0 24 24"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg><div><span>Laser layer may cut slowly:</span> <b data-notr>${esc(l.name)}</b>. <button class="btn sm" data-act="gotoLaser" data-l="${l.id}">Fix it in Stitch</button></div></div>`).join('')}
          <div class="stat-grid">
            <div class="stat"><div class="k">Needle positions</div><div class="v">${st.stitches.toLocaleString()}</div></div>
            <div class="stat"><div class="k">Sewing length</div><div class="v">${(st.sew_len / 1000).toFixed(2)}<small>m</small></div></div>
            <div class="stat"><div class="k">Shapes sewn</div><div class="v">${st.shapes}<small>of ${st.total_shapes}</small></div></div>
            <div class="stat"><div class="k">Estimated time</div><div class="v">${fmtTime(st.seconds)}</div>${st.waits ? `<div class="k">${st.waits.toFixed(1)} s <span>of waits</span></div>` : ''}</div>
          </div>
          ${sec('prog', 'Program', `${S.program.length} steps`, `
            <ul class="prog" id="prog">${S.program.map((p, i) => `<li class="${p.kind} ${i === progSel ? 'sel' : ''}" data-i="${i}"><span class="ix">${i + 1}</span><span class="tx">${esc(p.text)}</span><span class="tag">${esc(p.tag)}</span></li>`).join('')}</ul>
            <div class="row"><select class="sel" id="insName" style="flex:1">${S.instructions.map(n => `<option value="${n}">${n}</option>`).join('')}</select>${fld('insVal', '', '', 'sm')}<button class="btn" data-act="insIns">Insert</button></div>
            <p class="hint">Speed goes into the machine file; steps marked “job only” are saved with the job but not written to the machine yet. Inserted ${anchor === 'end' ? 'at the end of the job' : 'before “' + esc(nameOf(shapeById(anchor))) + '”'}. Pick a program step to choose where.</p>
            <div class="grid3"><button class="btn sm" data-act="insMove" data-d="-1">Move up</button><button class="btn sm" data-act="insMove" data-d="1">Move down</button><button class="btn sm danger" data-act="insDel">Delete</button></div>`, true)}
          ${sec('auto', 'Automatic instructions', 'job, layer, shape', `
            <button class="btn" data-act="sheet" data-sheet="defaults" style="justify-self:start">Default instructions…</button>
            ${row('Sewing speed', jf('speed', 'rpm'))}
            ${row('Gradual speed start', jsw('speed_ramp_on'))}${row('Start speed', jf('speed_ramp_from', 'rpm'))}
            <div class="grid2"><button class="btn" data-act="sheet" data-sheet="io">Output IO at positions…</button><button class="btn" data-act="sheet" data-sheet="ioRev">IO on reverse…</button></div>`)}
          ${sec('file', 'Machine file', `SLW · ${j.out_scale_on ? fmt(j.out_scale_x, 1) + '%' : '100%'}`, `
            ${row('Scale output', jsw('out_scale_on'))}
            ${row('Scale X / Y', `<span style="display:flex;gap:4px">${fld('j_out_scale_x', j.out_scale_x, '%', 'sm', 'job:out_scale_x')}${fld('j_out_scale_y', j.out_scale_y, '%', 'sm', 'job:out_scale_y')}</span>`)}
            <p class="hint">Coordinates are measured from the machine origin set in Stitch → Machine.</p>`)}
          ${sec('export', 'Other formats', 'PLT · DXF · SVG · CSV', `
            ${row('DXF / PLT contents', `<div class="seg" role="group"><button aria-pressed="${j.dxf_mode !== 'stitches'}" data-act="dxfMode" data-v="geometry">Lines</button><button aria-pressed="${j.dxf_mode === 'stitches'}" data-act="dxfMode" data-v="stitches">Stitches</button></div>`)}
            <div class="grid2"><button class="btn sm" data-act="export" data-kind="plt">PLT…</button><button class="btn sm" data-act="export" data-kind="dxf">DXF…</button></div>
            <div class="grid2"><button class="btn sm" data-act="export" data-kind="svg">Picture…</button><button class="btn sm" data-act="export" data-kind="csv">Stitch list…</button></div>
            <p class="hint">PLT uses the resolution set in Import (${j.dpi} dpi).</p>
            <button class="btn" data-act="save" style="justify-self:start">Save job (.stitchline)…</button>`)}`,
        foot: `<button class="btn primary big" data-act="saveMachine">${ICO.save}Save machine file…</button>` +
          (S.drives.length ? S.drives.map(d => `<button class="btn big" data-act="saveUsb" data-drive="${esc(d)}">${ICO.usb}Save to USB drive ${esc(d.replace('\\', ''))}</button>`).join('') : `<p class="hint" style="text-align:center">Plug in a USB drive to save straight onto it.</p>`),
      };
    },
  };
  const fmtTime = s => s < 90 ? `${Math.ceil(s)}<small>s</small>` : `${Math.floor(s / 60)}<small>m</small> ${Math.round(s % 60)}<small>s</small>`;
  function progAnchor() {
    const p = S.program[progSel];
    if (!p) return 'end';
    for (let i = progSel; i < S.program.length; i++) if (S.program[i].shape != null) return S.program[i].shape;
    return 'end';
  }

  // the focused control, found again after the panel is rebuilt: by its id, or by its data-* attributes (buttons)
  const focusKey = el => el.id ? '#' + CSS.escape(el.id) : Object.entries(el.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${CSS.escape(v)}"]`).join('') || null;
  function renderInspector() {
    const sc = $('#insp').scrollTop;
    const osc = $('#order')?.scrollTop;   // the sewing order list scrolls on its own; keep its place across re-renders
    // a value committed with Tab re-renders the panel while the next field has focus: keep that field focused
    const fa = document.activeElement, fk = fa && fa.closest('.inspector') && focusKey(fa);
    const fv = fk && fa.tagName === 'INPUT' ? { v: fa.value, typed: fa.value !== fa.defaultValue, s: fa.selectionStart, e: fa.selectionEnd } : null;
    const p = PANELS[stg()]();
    $('#insp').innerHTML = `<div class="i-title"><h2>${p.title}</h2><p>${p.sub}</p>${p.pick || ''}</div>${p.body}`;
    $('#ifoot').innerHTML = p.foot;
    $('#ifoot').hidden = !p.foot;
    $('#insp').scrollTop = sc;
    if (osc != null && $('#order')) $('#order').scrollTop = osc;
    const nf = fk && $('.inspector ' + fk);
    if (nf) {
      nf.focus({ preventScroll: true });
      if (fv?.typed) nf.value = fv.v;   // typed into while the engine was busy
      if (fv && fv.s != null) try { fv.s === 0 && fv.e === fv.v.length ? nf.select() : nf.setSelectionRange(fv.s, fv.e); } catch {}
    }
    $$('#insp details[data-key]').forEach(d => d.addEventListener('toggle', () => { openSecs[d.dataset.key] = d.open; store.set('openSecs', openSecs); }));
    const r = $('#lenRange');
    if (r) {
      let t;
      r.addEventListener('input', () => { $('#lenNum').value = (+r.value).toFixed(1); clearTimeout(t); t = setTimeout(() => setLayer({ stitch_len: +r.value }), 220); });
      $('#lenNum').addEventListener('input', () => { const v = num('lenNum'); if (v > 0) r.value = v; });   // the slider follows what is typed; Tab or Enter saves it
    }
    const ol = $('#order'); if (ol) wireOrder(ol);
  }

  /* every sewing layer takes this layer's stitch settings, after asking (the engine leaves laser layers alone). Never
     from a laser layer: that would switch off the stitches and back-tack of every sewing layer */
  function copySettings(id) {
    const L = layerById(id); if (!L) return;
    if (isLaser(L)) return toast('Pick a sewing layer to copy its stitch settings.', true);
    const same = o => Object.keys({ ...o, ...L.settings }).every(k => JSON.stringify(o[k]) === JSON.stringify(L.settings[k]));
    const n = S.job.layers.filter(l => l.id !== id && !isLaser(l) && !same(l.settings)).length;
    if (!n) return toast('Every layer already uses these stitch settings');
    confirmSheet('Use these settings for every layer?', `${n} ${n === 1 ? 'layer gets' : 'layers get'} the stitch settings of “${esc(L.name)}”. You can undo this.`, 'Use for every layer',
      () => api('copy_layer_settings', { id }, { quiet: true }).then(d => d && toast('Every layer now uses these stitch settings')));
  }
  function setLayer(settings) { return api('update_layer', { id: curLayer, fields: { settings } }, { quiet: true }); }
  function setJob(values) { return api('set_job', { values }, { quiet: true }); }

  /* value changes inside the inspector */
  function readSet(el) {
    const [scope, key] = el.dataset.set.split(':');
    let v;
    if (el.classList.contains('switch')) {
      v = el.getAttribute('aria-checked') !== 'true';
      const cur = scope === 'layer' ? LS()[key] : J()[key];
      if (typeof cur === 'number') v = v ? 1 : 0;
    } else {
      v = parseFloat(String(el.value).replace(',', '.'));
      if (!Number.isFinite(v)) { toast('Enter a number.', true); renderInspector(); return; }
      if (/(_n|_start|_end|_rep|end_repeat|bt_|cl_)/.test(key) && !/_len|_f$/.test(key)) v = Math.max(0, Math.round(v));
      if (key === 'stitch_len') v = Math.min(12, Math.max(0.5, v));   // the slider's range
    }
    scope === 'layer' ? setLayer({ [key]: v }) : setJob({ [key]: v });
  }
  $('#insp').addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.set) return readSet(el);
    if (el.id === 'stitchLayer') { curLayer = el.value; renderAll(); return; }
    if (el.id === 'needleSel') return api('update_layer', { id: curLayer, fields: { needle: +el.value } }, { quiet: true });
    if (el.id === 'layerSel') {
      if (el.value === '__new') return promptSheet('New layer', 'Name of the new layer', 'Layer ' + (S.job.layers.length + 1), async name => { const d = await api('add_layer', { name }, { quiet: true }); if (d) { const L = d.job.layers.at(-1); api('set_layer', { ids: [...sel], layer: L.id }); } });
      return api('set_layer', { ids: [...sel], layer: el.value });
    }
    if (el.id === 'shapeName') return api('rename_shape', { id: [...sel][0], name: el.value }, { quiet: true });
    if (['cxm', 'cxp', 'cym', 'cyp'].includes(el.id)) return setComp();
    if (el.id === 'ns') store.set('nudge', el.value);
    if (el.id === 'ang') store.set('ang', el.value);
  });
  function setComp(on) {
    const c = J().comp || {};
    setJob({ comp: { on: on ?? !!c.on, 'x-': num('cxm'), 'x+': num('cxp'), 'y-': num('cym'), 'y+': num('cyp') } });
  }
  // Enter commits the field (on blur) and stops there: the window's own Enter (Move: type the distance) must not see it
  $('#insp').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.target.blur(); e.stopPropagation(); } });

  /* ------------------------------------------------------------------ transform again, clipboard */
  // the last move / rotate / mirror / resize / copy-while-moving: Ctrl+D does it again to the selection
  let lastXf = null;
  function xform(op, args) {
    if (!needSel()) return;
    lastXf = { op, args };
    return api(op, { ids: [...sel], ...args }, { quiet: true });
  }
  const again = () => lastXf ? xform(lastXf.op, lastXf.args) : toast('Move, rotate, mirror or resize something first.', true);
  // Ctrl+C / X keep the shapes here (not on the system clipboard), so Ctrl+V works after a cut too
  let clip = null;
  function copySel(cut) {
    if (!needSel()) return;
    clip = selected().map(s => ({ layer: s.layer, pts: s.pts, closed: s.closed, marks: s.marks || [], name: s.name || '' }));
    if (cut) api('delete', { ids: [...sel] }, { quiet: true }).then(d => d && toast(clip.length > 1 ? `${clip.length} shapes cut` : 'Shape cut'));
    else toast(clip.length > 1 ? `${clip.length} shapes copied` : 'Shape copied');
  }
  // Ctrl+V: the copy lands in the middle of the view; Ctrl+F / Ctrl+B: in place, sewn last / first
  function paste(where, at = [view.cx, view.cy]) {
    if (!clip) return toast('Copy a shape first (Ctrl+C).', true);
    let dx = 0, dy = 0;
    if (where === 'view') { const [x0, y0, x1, y1] = bounds(clip); dx = at[0] - (x0 + x1) / 2; dy = at[1] - (y0 + y1) / 2; }
    return api('paste', { shapes: clip, dx, dy, layer: curLayer, back: where === 'back' }, { quiet: true });
  }
  // Ctrl+] / Ctrl+[ : one place later / earlier in the sewing order; with Shift: sewn last / first
  function sewOrder(delta, toEnd) {
    if (!needSel()) return;
    let o = [...S.job.order];
    const picked = o.filter(i => sel.has(i));
    if (toEnd) o = delta > 0 ? [...o.filter(i => !sel.has(i)), ...picked] : [...picked, ...o.filter(i => !sel.has(i))];
    else if (delta > 0) { for (let i = o.length - 2; i >= 0; i--) if (sel.has(o[i]) && !sel.has(o[i + 1])) [o[i], o[i + 1]] = [o[i + 1], o[i]]; }
    else { for (let i = 1; i < o.length; i++) if (sel.has(o[i]) && !sel.has(o[i - 1])) [o[i], o[i - 1]] = [o[i - 1], o[i]]; }
    if (o.some((v, i) => v !== S.job.order[i])) api('reorder', { ids: o }, { quiet: true });
  }
  // R / Enter: the Rotate angle / the Move fields of the Arrange panel, ready to type in
  function focusField(id) {
    if (!needSel()) return;
    if (stage !== 'arrange') setStage('arrange');
    const f = $('#' + id); if (!f) return;
    const d = f.closest('details'); if (d) d.open = true;
    f.focus(); f.select();
  }

  /* ------------------------------------------------------------------ actions (buttons with data-act) */
  const ACT = {
    open: () => guardUnsaved(() => api('open', {}, { busy: 'Waiting for the file…' }).then(d => { if (d && d.message) opened(); })),
    openRecent: b => guardUnsaved(() => api('open', { path: b.dataset.path }).then(d => { if (d) opened(); })),
    insert: () => api('insert', {}, { busy: 'Waiting for the file…' }).then(d => d && fitView()),
    save: () => api('save', { as_new: !S.file.path }),
    selectAll: () => { sel = new Set(S.job.shapes.map(s => s.id)); selChanged(); },
    allOp: b => api(b.dataset.op, { ids: S.job.shapes.map(s => s.id), tol: 2 }),
    op: b => needSel() && api(b.dataset.op, { ids: [...sel] }),
    nudge: b => { if (!needSel()) return; const st = num('ns') || 0.1; store.set('nudge', $('#ns').value); xform('move', { dx: +b.dataset.dx * st, dy: +b.dataset.dy * st }); },
    moveBy: () => xform('move', { dx: num('mvx'), dy: num('mvy') }),
    toOrigin: () => { if (!needSel()) return; const bb = bounds(selected()); api('move', { ids: [...sel], dx: -bb[0], dy: -bb[1] }, { quiet: true }); },
    rotate: () => xform('rotate', { angle: num('ang') }),
    mirror: b => xform('mirror', { axis: b.dataset.axis }),
    startAt: b => needSel() && api('start_at', { ids: [...sel], side: b.dataset.side }, { quiet: true }),
    extend: () => needSel() && api('extend', { ids: [...sel], start: num('es'), end: num('ee') }, { quiet: true }),
    merge: () => needSel() && api('merge_points', { ids: [...sel], tol: num('cp') }),
    short: () => needSel() && api('delete_short', { ids: [...sel], min: num('sl') }),
    join: () => needSel() && api('join', { ids: [...sel], tol: num('jt') }),
    tool: b => setTool(b.dataset.tool),
    sheet: b => openSheet(b.dataset.sheet),
    groupSheet: () => needSel() && openSheet('group'),
    dpi: b => setJob({ dpi: +b.dataset.v }),
    gotoLaser: b => { curLayer = b.dataset.l; setStage('stitch'); },
    laserFix: () => api('laser_fix', { id: curLayer }).then(d => { if (d) fitView(); }),
    kind: b => setKind(curLayer, b.dataset.kind),
    scaleNow: () => api('scale_all', { sx: J().scale_x, sy: J().scale_y }).then(d => d && fitView()),
    origin: b => setJob({ origin: b.dataset.c }),
    copySettings: () => copySettings(curLayer),
    sort: b => api('sort', { dir: b.dataset.dir, spacing: J().row_spacing, by_end: J().sort_by_end }).then(d => d && toast('Sewing order updated')),
    nearest: () => api('nearest').then(d => d && toast('Sewing order updated for the shortest travel')),
    byGroup: () => api('order_by_group').then(d => d && toast('Sewing order now follows the layer list')),
    simulate: () => startSim(true),
    sequence: () => startSim(false),
    insIns: () => { const n = $('#insName').value; api('insert_instruction', { before: progAnchor(), name: n, value: $('#insVal').value }, { quiet: true }); },
    insMove: b => { const p = S.program[progSel]; if (!p || p.kind !== 'user') return toast('Select an instruction you inserted (shown in blue).', true); progSel += +b.dataset.d; api('move_instruction', { iid: p.iid, delta: +b.dataset.d }, { quiet: true }); },
    insDel: () => { const p = S.program[progSel]; if (!p || p.kind !== 'user') return toast('Select an instruction you inserted (shown in blue).', true); progSel = -1; api('delete_instruction', { iid: p.iid }, { quiet: true }); },
    dxfMode: b => setJob({ dxf_mode: b.dataset.v }),
    export: b => api('export', { kind: b.dataset.kind, mode: J().dxf_mode }, { busy: 'Waiting for a file name…' }),
    saveMachine: () => api('save_machine', {}, { busy: 'Waiting for a file name…' }),
    saveUsb: b => api('save_machine', { drive: b.dataset.drive }, { busy: 'Saving to the USB drive…' }),
    addShapeSheet: () => openSheet('add'),
  };
  document.addEventListener('click', e => {
    if (!S) return;
    const g = e.target.closest('[data-goto]');
    if (g) { setStage(g.dataset.goto); return; }
    const a = e.target.closest('[data-act]');
    if (a && ACT[a.dataset.act] && !a.closest('#sheet')) { ACT[a.dataset.act](a); return; }
    const swt = e.target.closest('#insp .switch, #ifoot .switch');
    if (swt) {
      if (swt.dataset.set) return readSet(swt);
      if (swt.id === 'lout') return api('update_layer', { id: curLayer, fields: { output: swt.getAttribute('aria-checked') !== 'true' } }, { quiet: true });
      if (swt.id === 'compOn') return setComp(swt.getAttribute('aria-checked') !== 'true');
      if (swt.id === 'liteSw') return setLite(swt.getAttribute('aria-checked') === 'true');
    }
    const li = e.target.closest('#prog li');
    if (li) { progSel = +li.dataset.i; const p = S.program[progSel]; if (p.shape != null) { sel = new Set([p.shape]); } renderInspector(); draw(); return; }
    // the layer row's needle button opens #ctx on this same click: leave it open
    if (!e.target.closest('#ctx, #layers [data-needle]')) $('#ctx').hidden = true;
  });

  /* drag to reorder: dropping on the top half of a row puts the shape above it, on the bottom half below it
     (always "above" made a drag one row down land where it started) */
  function wireOrder(ol) {
    let dragId = null;
    const below = (e, li) => { const r = li.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    const clear = () => $$('li', ol).forEach(l => l.classList.remove('over', 'under'));
    ol.addEventListener('dragstart', e => { const li = e.target.closest('li'); dragId = +li.dataset.id; li.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', li.dataset.id); });
    ol.addEventListener('dragend', e => { e.target.closest('li')?.classList.remove('drag'); clear(); dragId = null; });
    ol.addEventListener('dragover', e => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const t = e.target.closest('li'); clear();
      if (t && +t.dataset.id !== dragId) t.classList.add(below(e, t) ? 'under' : 'over');
    });
    ol.addEventListener('drop', e => {
      e.preventDefault(); clear(); const t = e.target.closest('li'); if (!t || dragId == null) return;
      const to = +t.dataset.id; if (to === dragId) return;
      const order = S.job.order.filter(i => i !== dragId);
      order.splice(order.indexOf(to) + (below(e, t) ? 1 : 0), 0, dragId);
      if (order.every((v, i) => v === S.job.order[i])) return;   // dropped where it already was
      api('reorder', { ids: order }, { quiet: true });
    });
    ol.addEventListener('click', e => { const li = e.target.closest('li'); if (li) pick(+li.dataset.id, e.ctrlKey, e.shiftKey); });
    ol.addEventListener('mouseover', e => { const id = +e.target.closest('li')?.dataset.id; if (id >= 0 && id !== hoverId) { hoverId = id; draw(); } });
    ol.addEventListener('mouseleave', () => { if (hoverId != null) { hoverId = null; draw(); } });
  }

  /* ------------------------------------------------------------------ stages */
  function setStage(s) {
    stage = s; store.set('stage', s); progSel = -1;
    renderAll();
  }
  $$('.stage').forEach(b => b.addEventListener('click', () => S && setStage(b.dataset.stage)));
  function stepBy(d) {
    if (!S) return;
    const i = STAGES.indexOf(stage) + d;
    if (i >= STAGES.length) return ACT.saveMachine();
    if (i >= 0 && (d < 0 || S.job.shapes.length)) setStage(STAGES[i]);
  }
  $('#stepPrev').addEventListener('click', () => stepBy(-1));
  $('#stepNext').addEventListener('click', () => stepBy(1));

  function selChanged() {
    if (!S) return;
    openForNewSel();
    $$('#layers .layer').forEach(el => {
      el.classList.toggle('cur', el.dataset.l === curLayer);
      el.classList.toggle('closed', !openLayers.has(el.dataset.l));
    });
    $$('#layers .shape-row').forEach(r => r.setAttribute('aria-selected', sel.has(+r.dataset.s)));
    $('#groupSel').disabled = !sel.size;
    renderInspector(); draw(); updateReadout();
  }
  function renderAll() {
    if (!S) return;
    renderTop(); renderLayers(); renderInspector(); draw(); updateReadout();
  }

  /* ------------------------------------------------------------------ canvas */
  const cv = $('#cv');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['canvas', 'grid', 'grid-major', 'fg', 'fg-2', 'fg-3', 'line-strong', 'accent', 'accent-soft', 'thread', 'thread-soft', 'guide', 'ok', 'warn', 'tack', 'dense', 'zig', 'special', 'bad', 'laser', 'laser-glow']) colors[k] = cs.getPropertyValue('--' + k).trim();
  }
  function resize() {
    dpr = window.devicePixelRatio || 1; W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    paint();
  }
  const insets = () => {
    const a = $('.side').getBoundingClientRect(), b = $('.inspector').getBoundingClientRect();
    const [lp, rp] = a.left < b.left ? [a, b] : [b, a];
    // above: the title and step bars and the readout; below: the show and zoom bars (stacked in small windows)
    const top = Math.max(...['.topbar', '.stepbar'].map(q => $(q).getBoundingClientRect().bottom));
    const bars = $$('.viewbar, .zoombar').map(el => el.getBoundingClientRect()).filter(r => r.height);
    return { l: lp.right + 16, r: W - rp.left + 16, t: top + 40, b: bars.length ? H - Math.min(...bars.map(r => r.top)) + 12 : 76 };
  };
  const sx = x => W / 2 + (x - view.cx) * view.k;
  const sy = y => H / 2 - (y - view.cy) * view.k;
  const wx = px => view.cx + (px - W / 2) / view.k;
  const wy = py => view.cy - (py - H / 2) / view.k;
  function bounds(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of list) for (const [x, y] of s.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x0 === Infinity ? [0, 0, 100, 60] : [x0, y0, x1, y1];
  }
  function fitView() {
    if (!S) return;
    const list = S.job.shapes.length ? S.job.shapes : [];
    const [x0, y0, x1, y1] = list.length ? bounds(list) : [0, 0, 200, 120];
    const ins = insets(); const aw = Math.max(100, W - ins.l - ins.r), ah = Math.max(100, H - ins.t - ins.b);
    view.k = Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0)) * 0.88;
    view.cx = (x0 + x1) / 2 - ((ins.l - ins.r) / 2) / view.k;
    view.cy = (y0 + y1) / 2 + ((ins.t - ins.b) / 2) / view.k;
    draw(); updateZoom(); autoFit = true;
  }
  function zoomAt(f, px = W / 2, py = H / 2) {
    autoFit = false;
    const x = wx(px), y = wy(py);
    view.k = Math.min(2000, Math.max(0.02, view.k * f));
    view.cx = x - (px - W / 2) / view.k; view.cy = y + (py - H / 2) / view.k;
    draw(); updateZoom();
  }
  const updateZoom = () => { $('#zoomTxt').textContent = Math.round(view.k / 3.78 * 100) + '%'; };   // 100% ≈ real size on a 96-dpi screen

  let drag = null, hoverId = null, measure = null;
  const flagColor = f => ({ b: colors.tack, d: colors.dense, w: colors.warn, z: colors.zig, x: colors.special, r: colors.tack, p: colors.fg })[f];

  let drawQueued = false;
  function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; paint(); }); } }
  function paint() {
    if (!S || !W) return;
    readColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // labels are positioned from their left edge; an RTL page would otherwise right-align and reorder them
    ctx.direction = 'ltr'; ctx.textAlign = 'left';
    ctx.fillStyle = colors.canvas; ctx.fillRect(0, 0, W, H);
    drawGrid();
    const stitchMode = showStitch && ['stitch', 'sequence', 'output', 'simple'].includes(stg());
    // live preview of a move or resize in progress; the engine applies the same map when the drag ends
    const xf = dragXF(), scaling = SL.isScale(xf);
    const T = xf ? (x, y) => SL.apply(xf, x, y) : null;
    // machine origin & table
    const [bx0, by0, bx1, by1] = bounds(S.job.shapes);
    const o = J().origin || 'bl';
    const ox = o[1] === 'r' ? bx1 : bx0, oy = o[0] === 't' ? by1 : by0;
    ctx.save(); ctx.strokeStyle = colors['line-strong']; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
    const tw = J().table_w, th = J().table_h;
    ctx.strokeRect(sx(o[1] === 'r' ? ox - tw : ox), sy(o[0] === 't' ? oy : oy + th), tw * view.k, th * view.k);
    ctx.restore();
    ctx.strokeStyle = colors['fg-3']; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx(ox) - 9, sy(oy)); ctx.lineTo(sx(ox) + 9, sy(oy)); ctx.moveTo(sx(ox), sy(oy) - 9); ctx.lineTo(sx(ox), sy(oy) + 9); ctx.stroke();
    ctx.fillStyle = colors['fg-3']; ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono'); ctx.fillText('0, 0', sx(ox) + 5, sy(oy) + 14);

    const curL = curLayer;
    const k = view.k;
    const vx0 = wx(0), vx1 = wx(W), vy0 = wy(H), vy1 = wy(0);
    const world = (ox, oy) => ctx.setTransform(dpr * k, 0, 0, -dpr * k, dpr * (W / 2 + (ox - view.cx) * k), dpr * (H / 2 + (view.cy - oy) * k));
    const screen = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // lines keep one width on screen at every zoom, with or without stitches; the stitch dots keep one size and are
    // left out where they would run together into a thick line (needle positions less than 4 px apart)
    const LW = 1;
    const dotsFor = L => stitchMode && k * (+L.settings.stitch_len || 2) >= 4;
    // start marks shrink a little when zoomed out so they do not pile up; the simple mode's original shape has none
    const markK = Math.min(1, Math.max(0.55, k / 1.5)), marks = !(simple && !showStitch);
    ctx.lineJoin = ctx.lineCap = 'round';
    const band = drag && drag.kind === 'box' ? boxWorld(drag) : null;   // shapes a rubber band will pick light up
    for (const s of S.job.shapes) {
      const bb = s._bb || (s._bb = bounds([s]));
      const isSel = sel.has(s.id) || !!(band && inBox(s, band, drag.enclose));
      const t = sel.has(s.id) ? T : null;               // this shape follows the drag
      const vb = t ? SL.applyBox(xf, bb) : bb;
      if (vb[2] < vx0 || vb[0] > vx1 || vb[3] < vy0 || vb[1] > vy1) continue;   // off screen
      const L = layerOf(s), LC = ink(L.color);
      const dim = viewMode === 'layer' && s.layer !== curL;
      const alpha = dim ? 0.12 : 1;
      const P0 = pathOf(s);
      const P = t && scaling ? P0.map(([x, y]) => t(x, y)) : P0;   // a move only shifts the cached path
      const d = t && !scaling ? [xf.dx, xf.dy] : [0, 0];
      const guide = !isSewn(s);
      if (P.length === 1) {
        screen(); ctx.globalAlpha = alpha;
        ctx.fillStyle = guide ? colors.guide : (isSel ? colors.accent : LC);
        ctx.beginPath(); ctx.arc(sx(P[0][0] + d[0]), sy(P[0][1] + d[1]), isSel ? 5 : 4, 0, 7); ctx.fill();
        continue;
      }
      if (!s._p) { s._p = new Path2D(); P0.forEach(([x, y], i) => i ? s._p.lineTo(x, y) : s._p.moveTo(x, y)); }
      let path = s._p;
      if (P !== P0) { path = new Path2D(); P.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y)); }
      if (t && drag.copy) { world(0, 0); ctx.globalAlpha = alpha; ctx.strokeStyle = LC; ctx.lineWidth = 1.4 / k; ctx.stroke(s._p); }   // Alt-drag: the original stays
      world(d[0], d[1]);
      if (isSel || s.id === hoverId) { ctx.globalAlpha = alpha; ctx.strokeStyle = colors['accent-soft']; ctx.lineWidth = (isSel ? 9 : 6) / k; ctx.stroke(path); }
      // White arrow: the selected path is drawn dashed (gaps cut in the canvas colour) inside its glow:
      // no box, no handles, no points
      const directMark = () => { if (isSel && tool === 'direct') { ctx.globalAlpha = alpha; ctx.setLineDash([5 / k, 4 / k]); ctx.strokeStyle = colors.canvas; ctx.lineWidth = 2.6 / k; ctx.stroke(path); ctx.setLineDash([]); } };
      if (guide) { ctx.globalAlpha = alpha; ctx.setLineDash([5 / k, 4 / k]); ctx.strokeStyle = colors.guide; ctx.lineWidth = 1 / k; ctx.stroke(path); ctx.setLineDash([]); directMark(); continue; }
      const laser = isLaser(L), dots = dotsFor(L);
      if (laser) {
        // laser cuts keep the layer's colour, with a soft glow in that colour
        ctx.globalAlpha = alpha * 0.25; ctx.strokeStyle = LC; ctx.lineWidth = 6 / k; ctx.stroke(path);
        ctx.globalAlpha = alpha; ctx.strokeStyle = isSel && !stitchMode ? colors.accent : LC; ctx.lineWidth = 1.4 / k; ctx.stroke(path);
      } else {
        ctx.strokeStyle = isSel && !stitchMode ? colors.accent : LC;
        ctx.lineWidth = LW / k; ctx.globalAlpha = alpha * (dots ? 0.45 : 1); ctx.stroke(path);
      }
      ctx.globalAlpha = alpha;
      directMark();
      for (const m of s.marks || []) {
        const seg = subPath(P, m.a, m.b); if (seg.length < 2) continue;
        const mp = new Path2D(); seg.forEach(([x, y], i) => i ? mp.lineTo(x, y) : mp.moveTo(x, y));
        ctx.strokeStyle = m.kind === 'zigzag' ? colors.zig : m.kind === 'special' ? colors.special : colors.tack; ctx.globalAlpha = 0.35; ctx.lineWidth = 7 / k; ctx.stroke(mp); ctx.globalAlpha = alpha;
      }
      if (dots && !dim && !laser) {
        const st = S.stitched[s.id];
        if (st) {
          screen();
          const r = 1.3, p = st.p, f = st.f;
          let last = '';
          for (let i = 0, j = 0; i < p.length; i += 2, j++) {
            const fl = f[j]; const c = fl === 's' ? LC : (flagColor(fl) || LC);
            if (c !== last) { ctx.fillStyle = c; last = c; }
            const rr = fl === 's' ? r : r * 1.3;
            const q = t ? t(p[i], p[i + 1]) : [p[i], p[i + 1]];
            ctx.fillRect(sx(q[0]) - rr, sy(q[1]) - rr, rr * 2, rr * 2);
          }
        }
      }
      // start point & direction
      if (!dim && marks && (isSel || stg() !== 'import')) {
        screen(); ctx.save(); ctx.translate(sx(P[0][0] + d[0]), sy(P[0][1] + d[1])); ctx.scale(markK, markK); ctx.translate(-sx(P[0][0] + d[0]), -sy(P[0][1] + d[1]));
        const a = P[0], b = P.find(q => Math.hypot(q[0] - a[0], q[1] - a[1]) > 1e-6) || P[1];
        const X = sx(a[0] + d[0]), Y = sy(a[1] + d[1]); const ang = Math.atan2(sy(b[1]) - sy(a[1]), sx(b[0]) - sx(a[0]));
        ctx.fillStyle = colors.ok; ctx.beginPath(); ctx.arc(X, Y, 4.5, 0, 7); ctx.fill();
        ctx.strokeStyle = colors.ok; ctx.lineWidth = 1.6; ctx.beginPath();
        const tx = X + Math.cos(ang) * 12, ty = Y + Math.sin(ang) * 12;
        ctx.moveTo(X + Math.cos(ang) * 6, Y + Math.sin(ang) * 6); ctx.lineTo(tx, ty);
        ctx.moveTo(tx, ty); ctx.lineTo(tx + Math.cos(ang + 2.5) * 5, ty + Math.sin(ang + 2.5) * 5);
        ctx.moveTo(tx, ty); ctx.lineTo(tx + Math.cos(ang - 2.5) * 5, ty + Math.sin(ang - 2.5) * 5); ctx.stroke();
        ctx.restore();
      }
    }
    screen();
    ctx.globalAlpha = 1;
    // Black arrow: bounding box of the selection with its eight resize handles
    const box = selBox();
    if (box) {
      const X0 = Math.round(sx(box[0])) + .5, X1 = Math.round(sx(box[2])) + .5, Yt = Math.round(sy(box[3])) + .5, Yb = Math.round(sy(box[1])) + .5;
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 1;
      ctx.strokeRect(X0, Yt, X1 - X0, Yb - Yt);
      ctx.fillStyle = colors.canvas;
      for (const [hk, X, Y] of handlesOn(box)) {
        const r = hk === hoverHandle ? HS + 1 : HS;
        ctx.fillRect(X - r, Y - r, r * 2, r * 2); ctx.strokeRect(Math.round(X - r) + .5, Math.round(Y - r) + .5, Math.round(r * 2), Math.round(r * 2));
      }
    }
    // reference points
    for (const k of ['r1', 'r2']) {
      const s = S.job.refs[k] != null && shapeById(S.job.refs[k]); if (!s) continue;
      const X = sx(s.pts[0][0]), Y = sy(s.pts[0][1]);
      ctx.strokeStyle = colors.bad; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X, Y, 8, 0, 7); ctx.moveTo(X - 12, Y); ctx.lineTo(X + 12, Y); ctx.moveTo(X, Y - 12); ctx.lineTo(X, Y + 12); ctx.stroke();
      ctx.fillStyle = colors.bad; ctx.font = '600 11px system-ui'; ctx.fillText(k.toUpperCase(), X + 10, Y - 10);
    }
    // sewing order
    if (showOrder || stg() === 'sequence') drawOrder();
    // simulation
    // rubber band / measure
    if (drag && drag.kind === 'box') {
      // translucent so the pieces under the box stay visible
      const x = Math.min(drag.x0, drag.x), y = Math.min(drag.y0, drag.y), w = Math.abs(drag.x - drag.x0), h = Math.abs(drag.y - drag.y0);
      ctx.fillStyle = colors.accent; ctx.globalAlpha = 0.1; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.strokeRect(x + .5, y + .5, w, h); ctx.setLineDash([]);
    }
    if (measure) {
      const { x0, y0, x1, y1 } = measure; ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(sx(x0), sy(y0)); ctx.lineTo(sx(x1), sy(y1)); ctx.stroke(); ctx.setLineDash([]);
      const dd = Math.hypot(x1 - x0, y1 - y0), an = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
      const label = `${dd.toFixed(2)} mm · ${an.toFixed(1)}°  (Δx ${(x1 - x0).toFixed(2)}, Δy ${(y1 - y0).toFixed(2)})`;
      ctx.font = '600 12px system-ui'; const tw2 = ctx.measureText(label).width;
      const lx = (sx(x0) + sx(x1)) / 2 - tw2 / 2, ly = (sy(y0) + sy(y1)) / 2 - 12;
      ctx.fillStyle = colors.fg; ctx.beginPath(); ctx.roundRect(lx - 8, ly - 15, tw2 + 16, 22, 8); ctx.fill();
      ctx.fillStyle = colors.canvas; ctx.fillText(label, lx, ly);
    }
  }
  // rubber band in world coords, and whether it picks a shape: any shape it touches (as in Illustrator),
  // or with Alt held only shapes completely inside it
  function boxWorld(d) { return [wx(Math.min(d.x0, d.x)), wy(Math.max(d.y0, d.y)), wx(Math.max(d.x0, d.x)), wy(Math.min(d.y0, d.y))]; }
  function inBox(s, b, enclose = false) {
    if (viewMode === 'layer' && s.layer !== curLayer) return false;
    const bb = s._bb || (s._bb = bounds([s]));
    if (bb[2] < b[0] || bb[0] > b[2] || bb[3] < b[1] || bb[1] > b[3]) return false;    // nowhere near
    if (bb[0] >= b[0] && bb[2] <= b[2] && bb[1] >= b[1] && bb[3] <= b[3]) return true;  // all of it inside
    return !enclose && SL.touchesBox(s.pts, s.closed, b);
  }
  function drawGrid() {
    if (!ui.grid) return;
    let step = 1; while (step * view.k < 9) step *= step % 10 === 1 || step === 1 ? 5 : 2;
    const major = step * 5;
    const x0 = Math.floor(wx(0) / step) * step, x1 = wx(W), y0 = Math.floor(wy(H) / step) * step, y1 = wy(0);
    if ((x1 - x0) / step > 600) return;
    for (const [s, c] of [[step, colors.grid], [major, colors['grid-major']]]) {
      ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = Math.floor(x0 / s) * s; x <= x1; x += s) { const X = Math.round(sx(x)) + .5; ctx.moveTo(X, 0); ctx.lineTo(X, H); }
      for (let y = Math.floor(y0 / s) * s; y <= y1; y += s) { const Y = Math.round(sy(y)) + .5; ctx.moveTo(0, Y); ctx.lineTo(W, Y); }
      ctx.stroke();
    }
  }
  function subPath(P, a, b) {
    const out = []; let acc = 0;
    for (let i = 1; i < P.length; i++) {
      const p = P[i - 1], q = P[i], seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const lerp = t => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      if (acc + seg >= a && acc <= b && seg > 0) {
        if (!out.length) out.push(lerp(Math.max(0, (a - acc) / seg)));
        out.push(lerp(Math.min(1, (b - acc) / seg)));
      }
      acc += seg;
    }
    return out;
  }
  /* sewing order on the drawing. Numbers would pile up where pieces start close together, so each badge looks for a free
     spot around its start point and is left out when there is none; the shape under the pointer (or the selection)
     always shows its number, those of the shapes sewn just before and after it, and the travel moves between them */
  function drawOrder() {
    const items = [];
    S.job.order.forEach((id, n) => {
      const s = shapeById(id), st = s && isSewn(s) && S.stitched[s.id];
      if (st && st.p.length) items.push({ id, n: n + 1, a: [sx(st.p[0]), sy(st.p[1])], z: [sx(st.p.at(-2)), sy(st.p.at(-1))] });
    });
    const focus = new Set(hoverId != null ? [hoverId] : sel.size <= 3 ? sel : []);   // a big selection would bring the pile back
    const near = new Set();
    items.forEach((it, i) => { if (focus.has(it.id)) { near.add(i); if (i) near.add(i - 1); if (i + 1 < items.length) near.add(i + 1); } });
    // travel moves: quiet dashed lines, the ones next to the focused shape solid with an arrow
    items.forEach((it, i) => {
      if (!i) return;
      const [x0, y0] = items[i - 1].z, [x1, y1] = it.a, on = focus.has(it.id) || focus.has(items[i - 1].id);
      ctx.strokeStyle = on ? colors.accent : colors['fg-3']; ctx.globalAlpha = on ? 1 : (focus.size ? .25 : .5);
      ctx.lineWidth = on ? 1.5 : 1; ctx.setLineDash(on ? [] : [3, 4]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
      if (on && Math.hypot(x1 - x0, y1 - y0) > 40) {
        const ang = Math.atan2(y1 - y0, x1 - x0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        ctx.fillStyle = colors.accent; ctx.beginPath(); ctx.moveTo(mx + Math.cos(ang) * 6, my + Math.sin(ang) * 6);
        ctx.lineTo(mx + Math.cos(ang + 2.4) * 6, my + Math.sin(ang + 2.4) * 6); ctx.lineTo(mx + Math.cos(ang - 2.4) * 6, my + Math.sin(ang - 2.4) * 6); ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    // badges: the focused shape and its neighbours first, so they always find a place
    const OFF = [[-12, -12], [12, -12], [-12, 12], [12, 12], [0, -17], [17, 0], [0, 17], [-17, 0]];
    const placed = [], rank = i => focus.has(items[i].id) ? 0 : near.has(i) ? 1 : 2;
    const idx = items.map((_, i) => i).sort((p, q) => rank(p) - rank(q) || p - q);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const i of idx) {
      const it = items[i], big = rank(i) === 0, r = big ? 11 : 9;
      const free = ([dx, dy]) => placed.every(([X, Y, R]) => Math.hypot(it.a[0] + dx - X, it.a[1] + dy - Y) > r + R + 2);
      const off = OFF.find(free) || (rank(i) < 2 ? OFF[0] : null);
      if (!off) continue;
      const X = it.a[0] + off[0], Y = it.a[1] + off[1];
      placed.push([X, Y, r]);
      ctx.globalAlpha = focus.size && rank(i) === 2 ? .3 : 1;
      ctx.fillStyle = big ? colors.accent : colors.fg; ctx.beginPath(); ctx.arc(X, Y, r, 0, 7); ctx.fill();
      ctx.fillStyle = colors.canvas; ctx.font = `600 ${big ? 12 : 11}px system-ui`; ctx.fillText(String(it.n), X, Y + .5);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  /* selection tools: black arrow (tool 'select', V) moves and resizes whole shapes inside a bounding box;
     white arrow (tool 'direct', A) selects single paths and only moves them: no box, no handles, no point editing */
  const SL = window.STL_SEL;
  const HS = 4.5;                                    // half the size of a resize handle, in screen pixels
  let hoverHandle = null;
  /** Bounding box of the selection as drawn now (following a drag in progress), or null when there is none. */
  function selBox() {
    if (tool !== 'select' || !sel.size) return null;
    const ss = selected(); if (!ss.length) return null;
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of ss) { const b = s._bb || (s._bb = bounds([s])); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; }
    const xf = dragXF();
    return xf ? SL.applyBox(xf, bb) : bb;
  }
  /** [handle, screen x, screen y] for the handles the box shows. */
  const handlesOn = bb => SL.visibleHandles(bb, (bb[2] - bb[0]) * view.k, (bb[3] - bb[1]) * view.k)
    .map(hk => { const [x, y] = SL.handlePos(bb, hk); return [hk, sx(x), sy(y)]; });
  function hitHandle(px, py) {
    if (drag) return null;
    const bb = selBox(); if (!bb) return null;
    // corners first: on a small box the corner handles win over the edge handles next to them
    const hs = handlesOn(bb).sort((a, b) => b[0].length - a[0].length);
    const r = HS + 3;
    return hs.find(([, X, Y]) => Math.abs(px - X) <= r && Math.abs(py - Y) <= r)?.[0] || null;
  }
  function insideSel(px, py) {
    const bb = selBox(); if (!bb) return false;
    const x = wx(px), y = wy(py), tol = 3 / view.k;
    return x >= bb[0] - tol && x <= bb[2] + tol && y >= bb[1] - tol && y <= bb[3] + tol;
  }
  /** The transform of the drag in progress (null before it has moved past the click threshold). */
  function dragXF(d = drag) {
    if (!d || !d.moved) return null;
    const dx = wx(d.x) - d.w0[0], dy = wy(d.y) - d.w0[1];   // drawing mm, right at any zoom
    if (d.kind === 'move') return SL.translation(dx, dy);
    if (d.kind === 'resize') return SL.resize(d.bb, d.h, dx, dy, d.shift, d.alt);
    return null;
  }
  function cancelDrag() {
    if (!drag) return false;
    if (drag.kind === 'measure') measure = null;
    drag = null; cv.classList.remove('panning'); cv.className = ''; draw();
    return true;
  }

  /* hit testing */
  function hit(px, py) {
    const tol = 7 / view.k, x = wx(px), y = wy(py);
    let best = null, bd = tol;
    for (const s of S.job.shapes) {
      if (viewMode === 'layer' && s.layer !== curLayer) continue;
      const bb = s._bb || (s._bb = bounds([s]));
      if (x < bb[0] - tol || x > bb[2] + tol || y < bb[1] - tol || y > bb[3] + tol) continue;
      const P = pathOf(s);
      if (P.length === 1) { const d = Math.hypot(P[0][0] - x, P[0][1] - y); if (d <= bd) { bd = d; best = s; } continue; }
      for (let i = 1; i < P.length; i++) {
        const [ax, ay] = P[i - 1], [bx, by] = P[i]; const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
        if (d <= bd) { bd = d; best = s; }   // on a tie the shape drawn on top wins
      }
    }
    return best;
  }

  /* pointer */
  let spaceDown = false, hoverQueued = false, hoverAt = null;
  /** what is under the pointer: highlight and cursor */
  function hover(px, py) {
    if (!S) return;
    const arrow = tool === 'select' || tool === 'direct';
    const h = (arrow || tool === 'start') ? hit(px, py) : null;
    const hh = tool === 'select' && !spaceDown ? hitHandle(px, py) : null;
    const id = h && !hh ? h.id : null;
    if (id !== hoverId || hh !== hoverHandle) { hoverId = id; hoverHandle = hh; draw(); }
    cv.className = tool === 'pan' || spaceDown ? 'pan'
      : !arrow ? 'pick'
      : hh ? 'rs-' + SL.CURSOR[hh]
      : h ? (sel.has(h.id) ? 'movable' : 'hover')
      : tool === 'select' && insideSel(px, py) ? 'movable' : '';
  }
  cv.addEventListener('pointerdown', e => {
    if (!S) return;
    $('#ctx').hidden = true;
    if (drag) {
      if (e.button !== 0 || (e.buttons & 6)) return;   // another button while a drag is going on
      cancelDrag();                                     // a left press during a left drag: that drag never got its release
    }
    cv.setPointerCapture(e.pointerId);
    const panning = e.button === 1 || tool === 'pan' || spaceDown;
    if (panning) { drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, cx: view.cx, cy: view.cy }; cv.classList.add('panning'); return; }
    if (e.button !== 0) return;
    if (tool === 'measure') { measure = { x0: wx(e.clientX), y0: wy(e.clientY), x1: wx(e.clientX), y1: wy(e.clientY) }; drag = { kind: 'measure' }; return; }
    const s = hit(e.clientX, e.clientY);
    if (tool === 'start') {
      if (!s) return toast('Click on a shape to set where it starts.', true);
      sel = new Set([s.id]); api('set_start', { id: s.id, x: wx(e.clientX), y: wy(e.clientY) }, { quiet: true }).then(d => d && toast('Start point set'));
      return;
    }
    const at = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, w0: [wx(e.clientX), wy(e.clientY)], moved: false };
    // black arrow: a handle of the selection box resizes, before anything else is picked
    const hh = tool === 'select' ? hitHandle(e.clientX, e.clientY) : null;
    // (a click on a handle without dragging still picks the shape under it: see pointerup)
    if (hh) { drag = { kind: 'resize', h: hh, bb: selBox(), ids: [...sel], shift: e.shiftKey, alt: e.altKey, under: s, ctrl: e.ctrlKey || e.metaKey, ...at }; return; }
    if (s) {
      if (e.ctrlKey || e.metaKey) { sel.has(s.id) ? sel.delete(s.id) : sel.add(s.id); selChanged(); return; }
      if (!sel.has(s.id)) { if (!e.shiftKey) sel.clear(); sel.add(s.id); curLayer = s.layer; selChanged(); }
      drag = { kind: 'move', ids: [...sel], copy: e.altKey, ...at };
    } else if (tool === 'select' && !e.shiftKey && !e.ctrlKey && insideSel(e.clientX, e.clientY)) {
      drag = { kind: 'move', ids: [...sel], empty: true, copy: e.altKey, ...at };   // black arrow: anywhere inside the box moves the selection
    } else {
      drag = { kind: 'box', add: e.ctrlKey || e.shiftKey, enclose: e.altKey, ...at };
    }
  });
  cv.addEventListener('pointermove', e => {
    if (!S) return;
    $('#cx').textContent = cm(wx(e.clientX)); $('#cy').textContent = cm(wy(e.clientY));
    if (!drag) {
      // hover once per frame, always for the latest pointer position (a move between frames is not lost)
      hoverAt = [e.clientX, e.clientY];
      if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(() => { hoverQueued = false; if (!drag && hoverAt) hover(...hoverAt); }); }
      return;
    }
    if (drag.kind === 'pan') { autoFit = false; view.cx = drag.cx - (e.clientX - drag.x0) / view.k; view.cy = drag.cy + (e.clientY - drag.y0) / view.k; draw(); return; }
    if (drag.kind === 'measure') { measure.x1 = wx(e.clientX); measure.y1 = wy(e.clientY); draw(); return; }
    if (!(e.buttons & 1)) { cancelDrag(); return; }   // the button came up where this window could not see it
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 3) drag.moved = true;   // a click is not a drag
    if (drag.kind === 'resize') { drag.shift = e.shiftKey; drag.alt = e.altKey; }
    if (drag.kind === 'box') drag.enclose = e.altKey;
    if (drag.kind === 'move') drag.copy = e.altKey;   // Alt: leave the shapes where they are and move a copy
    if (drag.moved && drag.kind === 'move') cv.className = drag.copy ? 'copying' : 'moving';
    if (drag.moved && drag.kind === 'resize') { cv.className = 'rs-' + SL.CURSOR[drag.h]; updateReadout(); }
    draw();
  });
  // a drag the system takes away (touch cancelled) changes nothing. (Not lostpointercapture: WebView2 can drop
  // the capture in the middle of a drag that still ends with a normal pointerup.)
  cv.addEventListener('pointercancel', cancelDrag);
  cv.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag; drag = null; cv.classList.remove('panning');
    if (d.kind === 'move' || d.kind === 'resize') {
      const xf = dragXF(d);
      if (!xf && d.empty) { sel.clear(); selChanged(); }   // a click (not a drag) on empty space deselects
      else if (!xf && d.under && !sel.has(d.under.id)) pick(d.under.id, d.ctrl, d.shift);   // a click on a handle that covers a shape
      else if (!xf) draw();
      // one engine edit per drag: one undo step; the shapes keep their points, order, start and closed flag
      else if (d.kind === 'move') { lastXf = { op: d.copy ? 'duplicate' : 'move', args: { dx: xf.dx, dy: xf.dy } }; api(lastXf.op, { ids: d.ids, ...lastXf.args }, { quiet: true }); }
      else if (SL.isScale(xf)) { lastXf = { op: 'scale', args: { sx: xf.sx, sy: xf.sy } }; api('scale', { ids: d.ids, sx: xf.sx, sy: xf.sy, ox: xf.ax, oy: xf.ay }, { quiet: true }); }
      else draw();
    } else if (d.kind === 'box') {
      if (Math.hypot(d.x - d.x0, d.y - d.y0) < 4) { if (!d.add) { sel.clear(); selChanged(); } return; }
      if (!d.add) sel.clear();
      const band = boxWorld(d);
      for (const s of S.job.shapes) if (inBox(s, band, d.enclose)) sel.add(s.id);
      const f = selected()[0]; if (f) curLayer = f.layer;
      selChanged();
    } else draw();
  });
  cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.pow(1.0018, -e.deltaY), e.clientX, e.clientY); }, { passive: false });
  cv.addEventListener('dblclick', e => { if (simple) return; const s = hit(e.clientX, e.clientY); if (s) { sel = new Set([s.id]); if (stage !== 'arrange') setStage('arrange'); else renderAll(); } });
  cv.addEventListener('contextmenu', e => {
    e.preventDefault(); if (!S) return;
    const s = hit(e.clientX, e.clientY);
    if (simple) {
      const L = s && layerOf(s);
      if (s) { sel = new Set([s.id]); curLayer = L.id; selChanged(); }
      return menu(e.clientX, e.clientY, [
        ...(L ? [isLaser(L) ? ['Make this a sewing layer', () => setKind(L.id, 'sew')] : ['Make this a laser cut layer', () => setKind(L.id, 'laser')]] : []),
        ['Fit drawing', fitView, 'Ctrl 0']]);
    }
    if (s && !sel.has(s.id)) { sel = new Set([s.id]); selChanged(); }
    if (!sel.size) { const at = [wx(e.clientX), wy(e.clientY)]; return menu(e.clientX, e.clientY, [['Add a shape here…', () => openSheet('add', { x: at[0], y: at[1] })], ...(clip ? [['Paste here', () => paste('view', at), 'Ctrl V']] : []), ['Fit drawing', fitView, 'Ctrl 0'], ['Select all', ACT.selectAll, 'Ctrl A']]); }
    const x = wx(e.clientX), y = wy(e.clientY);
    menu(e.clientX, e.clientY, [
      ['Start sewing here', () => api('set_start', { id: [...sel][0], x, y }, { quiet: true }), ''],
      ['Reverse direction', () => api('reverse', { ids: [...sel] }, { quiet: true }), 'Ctrl Alt R'],
      ['Copy', () => copySel(false), 'Ctrl C'],
      ['Duplicate', () => api('duplicate', { ids: [...sel], dx: 5, dy: -5 })],
      ['Mirror left–right', () => xform('mirror', { axis: 'h' }), 'O'],
      ['Mirror up–down', () => xform('mirror', { axis: 'v' }), 'Shift O'],
      ['Split at the nearest point', () => { const sh = shapeById([...sel][0]); let bi = 0, bd = Infinity; sh.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bi = i; } }); api('split', { id: sh.id, index: bi }); }],
      ['Edit points…', () => openSheet('points')],
      ['Sections (zigzag, back-tack)…', () => openSheet('marks')],
      null,
      ['Delete', () => api('delete', { ids: [...sel] }, { quiet: true }), 'Del'],
    ]);
  });
  function menu(x, y, items) {
    const m = $('#ctx');
    m.innerHTML = items.map((it, i) => it ? `<button data-mi="${i}"><span>${it[0]}</span>${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>` : '<hr>').join('');
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    m.onclick = e => { const b = e.target.closest('[data-mi]'); if (b) { m.hidden = true; items[+b.dataset.mi][1](); } };
  }

  function updateReadout() {
    const list = sel.size ? selected() : S.job.shapes;
    const [x0, y0, x1, y1] = list.length ? bounds(list) : [0, 0, 0, 0];
    $('#rw').textContent = cm(x1 - x0); $('#rh').textContent = cm(y1 - y0);
    $('#rsel').textContent = sel.size ? `${sel.size} selected` : '';
  }

  /* dock */
  function setTool(t) {
    if (t !== tool) cancelDrag();
    tool = t; $$('[data-tool]').forEach(x => x.setAttribute('aria-pressed', x.dataset.tool === t));
    cv.className = t === 'pan' ? 'pan' : t === 'select' || t === 'direct' ? '' : 'pick';
    cv.dataset.tool = t;                              // arrow cursors (app.css)
    hoverHandle = null;
    if (t !== 'measure') measure = null;
    draw();                                           // the selection keeps; only the black arrow shows its box
    if (t === 'start') toast('Click a shape where its sewing should start.');
  }
  $$('.rail [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('[data-view]').forEach(b => b.addEventListener('click', () => { viewMode = b.dataset.view; $$('[data-view]').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); }));
  $('#zoomIn').onclick = () => zoomAt(1.25); $('#zoomOut').onclick = () => zoomAt(0.8); $('#fit').onclick = fitView;
  $('#showOrder').onclick = () => { showOrder = !showOrder; store.set('showOrder', showOrder); renderTop(); draw(); };
  $('#showStitch').onclick = $('#showOrig').onclick = () => { showStitch = !showStitch; store.set('showStitch', showStitch); renderTop(); draw(); };
  $('#undo').onclick = () => api('undo', {}, { quiet: true });
  $('#redo').onclick = () => api('redo', {}, { quiet: true });
  $('#btnOpen').onclick = () => ACT.open();
  $('#btnSave').onclick = () => ACT.save();
  $('#addShape').onclick = () => openSheet('add');
  $('#railAdd').onclick = () => openSheet('add');
  $('#keys').onclick = () => { closeSettings(); openSheet('keys'); };
  $('#saveTop').onclick = () => S && ACT.saveMachine();
  $('#groupSel').onclick = () => ACT.groupSheet();
  $('#addLayer').onclick = () => promptSheet('New layer', 'Name of the new empty layer', 'Layer ' + ((S?.job.layers.length || 0) + 1), name => api('add_layer', { name }, { quiet: true }).then(d => { if (d) curLayer = d.job.layers.at(-1).id; renderAll(); }));
  $('#fileChip').onclick = () => promptSheet('Job name', 'Used for the machine file and exports', S.job.name, name => api('rename_job', { name }, { quiet: true }));
  // the page reloads in the other language and comes back to the same place: Home if it was open, else the editor,
  // and the Settings window on the same section if the language was changed there
  function setLang(l) {
    store.set('lang', l);
    try { sessionStorage.setItem('stl.langReload', homeOpen() ? 'home' : 'editor'); if (setOpen()) sessionStorage.setItem('stl.setReload', curPage); } catch {}
    location.reload();
  }
  /* light / dark: the user's choice, or the same as Windows while nothing is chosen */
  const darkOS = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() { document.documentElement.dataset.theme = store.get('theme', null) || (darkOS.matches ? 'dark' : 'light'); }
  function setTheme(t) { store.set('theme', t === 'system' ? null : t); applyTheme(); syncSettings(); draw(); }
  function toggleTheme() { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
  applyTheme();
  darkOS.addEventListener('change', () => { applyTheme(); syncSettings(); draw(); });
  let lite = store.get('lite', true);
  function setLite(v) { lite = v; store.set('lite', v); document.documentElement.classList.toggle('lite', v); draw(); }
  setLite(lite);
  /* simple / advanced mode (Settings › General): the simple mode hides the steps, tools and every setting but the few
     a job needs; the drawing can only be looked at and picked from */
  function setSimple(v) {
    simple = v; store.set('simple', v);
    document.documentElement.classList.toggle('simple', v);
    if (v) {
      cancelDrag(); setTool('select'); $('#paletteScrim').hidden = true;
      viewMode = 'all'; $$('[data-view]').forEach(x => x.setAttribute('aria-pressed', x.dataset.view === 'all'));   // its bar is hidden
    }
    if (!S) return;
    syncSettings(); renderAll();
    if (autoFit) fitView();
  }
  document.documentElement.classList.toggle('simple', simple);

  /* font, text size, accent colour, interface size and the parts of the window that are shown (Settings) */
  const FONTS = {
    thmanyah: '"Thmanyah Sans", "Readex Pro", "Segoe UI", system-ui, sans-serif',
    readex: '"Readex Pro", "Segoe UI", system-ui, sans-serif',
    segoe: '"Segoe UI", Tahoma, system-ui, sans-serif',
    tahoma: 'Tahoma, "Segoe UI", sans-serif',
  };
  const UI_DEF = { font: 'thmanyah', ts: 1, bold: false, accent: 'blue', zoom: 1, side: true, readout: true, viewbar: true, zoombar: true, grid: false, kbd: true };
  let ui = { ...UI_DEF, ...store.get('ui', {}) };
  // the grid used to be on by default: switch it off once for everyone, Settings turns it back on
  if (!store.get('gridOff1', false)) { ui.grid = false; store.set('gridOff1', true); if (store.get('ui', null)) store.set('ui', ui); }
  if (!FONTS[ui.font]) ui.font = UI_DEF.font;
  let zoomNow = null;
  function applyUI() {
    const r = document.documentElement;
    r.style.setProperty('--font', FONTS[ui.font]); r.style.setProperty('--font-d', FONTS[ui.font]);
    r.style.setProperty('--ts', ui.ts);
    r.classList.toggle('text-bold', ui.bold);
    if (ui.accent === 'blue') delete r.dataset.accent; else r.dataset.accent = ui.accent;
    for (const k of ['side', 'readout', 'viewbar', 'zoombar', 'kbd']) r.classList.toggle('hide-' + k, !ui[k]);
    // the interface size is the WebView's own zoom: everything grows together and the drawing stays sharp
    if (ui.zoom !== zoomNow) { zoomNow = ui.zoom; window.__TAURI_INTERNALS__?.invoke('set_zoom', { scale: ui.zoom })?.catch(() => {}); }
  }
  function setUI(k, v) {
    ui[k] = v; store.set('ui', ui); applyUI(); syncSettings();
    if (k === 'side' && autoFit) fitView(); else draw();
  }
  applyUI();
  function resetUI() {
    ui = { ...UI_DEF }; store.set('ui', ui); store.set('theme', null);
    applyTheme(); applyUI(); setLite(true); setInspector(true); setSimple(true); syncSettings();
    if (autoFit) fitView(); else draw();
    toast('Settings are back to their defaults');
  }

  /* the Settings window: sections on the start side, every change applies at once */
  const setOpen = () => !$('#setScrim').hidden;
  let curPage = store.get('setPage', 'general'), setFrom = null;
  function showPage(k) {
    if (!$('#swp-' + k)) k = 'general';
    curPage = k; store.set('setPage', k);
    $$('.sw-tab').forEach(b => { const on = b.dataset.sp === k; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $$('.sw-page').forEach(p => { p.hidden = p.id !== 'swp-' + k; });
    $('#swTitle').textContent = $('#swt-' + k).textContent;
    $('#swSub').textContent = $('#swp-' + k).dataset.sub;
    $('.sw-body').scrollTop = 0;
  }
  function syncSettings() {
    const pressed = (q, f) => $$('#setWin ' + q).forEach(b => b.setAttribute('aria-pressed', f(b)));
    const th = store.get('theme', null) || 'system';
    pressed('[data-lang]', b => b.dataset.lang === window.STL_LANG);
    pressed('[data-theme-v]', b => b.dataset.themeV === th);
    pressed('.acc', b => b.dataset.accent === ui.accent);
    pressed('[data-font]', b => b.dataset.font === ui.font);
    pressed('[data-ts]', b => +b.dataset.ts === ui.ts);
    pressed('[data-zoom]', b => +b.dataset.zoom === ui.zoom);
    const on = (id, v) => $('#' + id).setAttribute('aria-checked', !!v);
    on('swHome', store.get('homeOnStart', true)); on('swAnim', !lite); on('swBold', ui.bold); on('swAdvanced', !simple);
    on('swInsp', !document.documentElement.classList.contains('insp-off'));
    for (const k of ['side', 'readout', 'viewbar', 'zoombar', 'grid', 'kbd']) on('sw' + k[0].toUpperCase() + k.slice(1), ui[k]);
  }
  function openSettings(page) {
    if (setOpen()) return;
    $('#paletteScrim').hidden = true; $('#ctx').hidden = true;
    setFrom = document.activeElement;
    syncSettings(); showPage(page || curPage);
    $('#setScrim').hidden = false;
    $('#swt-' + curPage).focus();
  }
  function closeSettings() {
    if (!setOpen()) return;
    $('#setScrim').hidden = true;
    if (setFrom?.isConnected) setFrom.focus({ preventScroll: true });
    setFrom = null;
  }
  $('#settings').onclick = () => openSettings();
  $('#setScrim').addEventListener('click', e => { if (e.target === e.currentTarget) closeSettings(); });
  $('#setWin').addEventListener('click', e => {
    const t = e.target;
    const tab = t.closest('[data-sp]'); if (tab) return showPage(tab.dataset.sp);
    if (t.closest('[data-close-set]')) return closeSettings();
    if (t.closest('#swReset')) return resetUI();
    const l = t.closest('[data-lang]'); if (l) { if (l.dataset.lang !== window.STL_LANG) setLang(l.dataset.lang); return; }
    const th = t.closest('[data-theme-v]'); if (th) return setTheme(th.dataset.themeV);
    const a = t.closest('.acc'); if (a) return setUI('accent', a.dataset.accent);
    const f = t.closest('[data-font]'); if (f) return setUI('font', f.dataset.font);
    const z = t.closest('[data-ts]'); if (z) return setUI('ts', +z.dataset.ts);
    const zm = t.closest('[data-zoom]'); if (zm) return setUI('zoom', +zm.dataset.zoom);
    // a switch, or anywhere on its row
    const s = t.closest('.switch') || (!t.closest('button') && t.closest('.sw-row')?.querySelector('.switch'));
    if (!s) return;
    const v = s.getAttribute('aria-checked') !== 'true';
    if (s.id === 'swHome') { store.set('homeOnStart', v); $('#homeOnStart').setAttribute('aria-checked', v); }
    else if (s.id === 'swAnim') setLite(!v);
    else if (s.id === 'swAdvanced') setSimple(!v);
    else if (s.id === 'swInsp') setInspector(v);
    else return setUI(s.id === 'swBold' ? 'bold' : s.id[2].toLowerCase() + s.id.slice(3), v);
    syncSettings();
  });
  $('#setWin').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.code === 'Comma')) { e.preventDefault(); return closeSettings(); }
    // Tab and Shift+Tab stay in the window; the arrow keys move between the sections
    if (e.key === 'Tab') {
      const f = $$('#setWin button').filter(x => !x.disabled && x.offsetParent && x.tabIndex >= 0);
      const i = f.indexOf(document.activeElement);
      if (f.length && (i < 0 || (e.shiftKey ? i === 0 : i === f.length - 1))) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      return;
    }
    const tab = e.target.closest?.('.sw-tab');
    if (tab && /^Arrow(Up|Down)$/.test(e.key)) {
      e.preventDefault();
      const ts = $$('.sw-tab'), n = ts[(ts.indexOf(tab) + (e.key === 'ArrowDown' ? 1 : ts.length - 1)) % ts.length];
      showPage(n.dataset.sp); n.focus();
    }
  });

  /* ------------------------------------------------------------------ simulation */
  // sim.seq: one entry per needle position [x, y, first point of a shape, layer colour, laser, shape id]
  function buildSim() {
    const keep = sim.on ? curSimShape() : null;   // an order change in the window: stay on the same shape
    sim.seq = []; sim.starts = new Map();
    if (!S) return;
    const ids = S.program.filter(p => p.kind === 'travel').map(p => p.shape);
    for (const id of ids) {
      const s = shapeById(id); if (!s || !isSewn(s)) continue;
      const st = S.stitched[id]; if (!st) continue;
      const L = layerOf(s), laser = isLaser(L);
      if (!sim.starts.has(id)) sim.starts.set(id, sim.seq.length);
      for (let i = 0; i < st.p.length; i += 2) sim.seq.push([st.p[i], st.p[i + 1], i === 0, L.color, laser, id]);
    }
    // the laser goes as fast as the needle: the millimetres a stitch of the sewing layers covers, per stitch time
    const sewn = S.job.layers.filter(L => L.output && !isLaser(L)).map(L => +L.settings.stitch_len).filter(v => v > 0);
    sim.mmPerStitch = sewn.length ? sewn.reduce((a, b) => a + b, 0) / sewn.length : 2.5;
    sim.box = null;
    sim.pos = keep != null && sim.starts.has(keep) ? sim.starts.get(keep) + 1 : Math.min(sim.pos, sim.seq.length);
    $('#simPos').max = Math.max(1, sim.seq.length);
  }
  // the shape the head is on (or about to start)
  const curSimShape = () => sim.seq[Math.max(0, Math.ceil(sim.pos) - 1)]?.[5] ?? null;
  /* the sequence window: opens over the job and stays until it is closed (X or Esc), also when the run is over */
  let simFrom = null;
  function startSim(play) {
    if (!sim.seq.length) return toast('Nothing to sew yet: turn on a layer with shapes.', true);
    if (!sim.on) {
      simFrom = document.activeElement;
      $('#ctx').hidden = true; $('#paletteScrim').hidden = true;
      sim.on = true; sim.pos = 0; seqCur = undefined; $('#simScrim').hidden = false;
      renderSeq(); seqTip();
      $('#simPlay').focus();
    }
    if (play) { if (sim.pos >= sim.seq.length) sim.pos = 0; sim.playing = true; sim.last = performance.now(); seqFollow = true; loop(); }
    syncSim(); simPaint();
  }
  function stopSim() {
    sim.on = false; sim.playing = false; cancelAnimationFrame(sim.raf); $('#simScrim').hidden = true; $('#seqTip').hidden = true;
    if (simFrom?.isConnected) simFrom.focus({ preventScroll: true });
    simFrom = null;
  }
  function loop() {
    cancelAnimationFrame(sim.raf);
    sim.raf = requestAnimationFrame(now => {
      if (!sim.playing) return;
      let dt = Math.max(0, Math.min(0.1, (now - sim.last) / 1000)); sim.last = now;
      const base = (J().speed || 1800) / 60 * SIM_BASE * sim.speed;   // needle: stitches per second
      // the frame's time is spent segment by segment, each at its own rate, so a short segment's rate never carries
      // the head along the next (long) one
      while (dt > 0 && sim.pos < sim.seq.length) {
        const i = Math.floor(sim.pos), a = sim.seq[i - 1], b = sim.seq[i];
        let rate = base;
        // the laser's points are the line's corners, not stitches: it covers the same millimetres per second as the needle
        if (a && b && b[4] && !b[2]) rate *= sim.mmPerStitch / Math.max(0.05, Math.hypot(b[0] - a[0], b[1] - a[1]));
        const left = (i + 1 - sim.pos) / rate;
        if (left > dt) { sim.pos += dt * rate; break; }
        sim.pos = i + 1; dt -= left;
      }
      sim.pos = Math.min(sim.seq.length, sim.pos);
      if (sim.pos >= sim.seq.length) sim.playing = false;          // the end: the window stays open on the finished job
      syncSim(); simPaint();
      if (sim.playing) loop();
    });
  }
  // ← → one needle position (held down: faster), Shift a shape at a time
  function simStep(dir, byShape, fast) {
    sim.playing = false; seqFollow = true;
    const N = sim.seq.length;
    if (byShape) {
      const at = [...sim.starts.values()].map(i => i + 1).sort((a, b) => a - b);
      sim.pos = dir > 0 ? (at.find(i => i > Math.floor(sim.pos)) ?? N) : (at.findLast(i => i < sim.pos - 1e-9) ?? 0);
    } else {
      const step = fast ? Math.max(1, Math.round(N / 400)) : 1;
      sim.pos = dir > 0 ? Math.min(N, Math.floor(sim.pos) + step) : Math.max(0, Math.ceil(sim.pos) - step);
    }
    syncSim(); simPaint();
  }
  let seqCur;
  /* the list follows the shape being sewn until the user scrolls it; Play, a step or a click on a row follows again.
     seqTop is where the list itself last scrolled to, so its own scrolling is not taken for the user's */
  let seqFollow = true, seqTop = -1;
  function showRow(r) {
    const L = $('#seqList'), lb = L.getBoundingClientRect(), rb = r.getBoundingClientRect();
    const head = r.closest('.layer')?.querySelector('.layer-row')?.offsetHeight || 0;   // the sticky layer row covers the top
    let t = L.scrollTop;
    if (rb.top < lb.top + head) t += rb.top - lb.top - head - 4; else if (rb.bottom > lb.bottom) t += rb.bottom - lb.bottom + 4;
    if (Math.round(t) === Math.round(L.scrollTop)) return;
    L.scrollTop = t; seqTop = L.scrollTop;
  }
  $('#seqList').addEventListener('scroll', () => { if (Math.abs($('#seqList').scrollTop - seqTop) > 1) seqFollow = false; }, { passive: true });
  function syncSim() {
    $('#simPos').max = sim.seq.length; $('#simPos').value = Math.floor(sim.pos);
    $('#simTxt').textContent = `${Math.floor(sim.pos).toLocaleString()} / ${sim.seq.length.toLocaleString()}`;
    $('#simDone').hidden = sim.pos < sim.seq.length;
    $('#simIcon').innerHTML = sim.playing ? '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>' : '<path d="M7 5v14l11-7z" fill="currentColor"/>';
    // the shape being sewn: marked in the list (kept in view while it plays) and named over the drawing
    const id = sim.pos > 0 ? curSimShape() : null;
    if (id === seqCur) return;
    seqCur = id;
    $$('#seqList [aria-current]').forEach(r => r.removeAttribute('aria-current'));
    const r = id != null && $(`#seqList .shape-row[data-s="${id}"]`);
    if (r) { r.setAttribute('aria-current', 'true'); if (seqFollow) showRow(r); }
    const s = id != null && shapeById(id), L = s && layerOf(s), tr = window.tr || (x => x);
    $('#simNow').hidden = !s;
    if (s) $('#simNow').textContent = `${L.name} · ${tr(nameOf(s))} · ${tr(isLaser(L) ? 'Laser cut' : 'Sewing')}`;
  }
  /* the order of the run: the layers as they are sewn, each with its shapes in sewing order. Drag to change it
     (as in the layers list); a click on a shape goes to it in the simulation */
  function renderSeq() {
    if (!S) return;
    const rank = new Map(S.job.order.map((id, i) => [id, i]));
    $('#seqList').innerHTML = S.job.layers.map((L, li) => {
      const shapes = S.job.shapes.filter(s => s.layer === L.id).sort((a, b) => (rank.get(a.id) ?? 1e15) - (rank.get(b.id) ?? 1e15));
      const laser = isLaser(L);
      return `<div class="layer ${L.output ? '' : 'off'} ${laser ? 'laser' : ''}" data-l="${L.id}">
        <div class="layer-row" data-layer="${L.id}" draggable="true" title="${L.output ? 'Drag to sew this layer earlier or later' : 'This layer is not sewn (turned off in Layers)'}">
          <span class="step">${li + 1}</span><span class="swatch" style="background:${esc(L.color)}"></span>
          <span class="name">${esc(L.name)} <span class="cnt">${shapes.length}</span></span>
          <span class="kind-pill ${laser ? 'laser' : ''}">${laser ? 'Laser' : 'Sewing'}</span>
          <button class="icon-btn best" data-best="${L.id}" title="Best order: the least travel between this layer's shapes" aria-label="Best order"><svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h4a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3"/></svg></button>
        </div>
        <div class="shapes">${shapes.slice(0, 500).map(s => `
          <button class="shape-row" data-s="${s.id}" draggable="true" aria-selected="${sel.has(s.id)}" ${s.id === seqCur ? 'aria-current="true"' : ''}><span class="no">${(rank.get(s.id) ?? -1) + 1}</span>${thumb(s.pts, s.closed)}<span class="nm">${esc(nameOf(s))}</span></button>`).join('')}
          ${shapes.length > 500 ? `<div class="more">+ ${shapes.length - 500} more</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
  wireDrag($('#seqList'));
  $('#seqList').addEventListener('click', e => {
    const b = e.target.closest('[data-best]');
    if (b) { bestDone = true; return api('best_order', { id: b.dataset.best }); }
    const r = e.target.closest('.shape-row'), lr = e.target.closest('.layer-row');
    const id = r ? +r.dataset.s : lr ? S.job.order.find(i => sim.starts.has(i) && shapeById(i).layer === lr.dataset.layer) : null;
    if (r) { pick(id, e.ctrlKey || e.metaKey, e.shiftKey); $$('#seqList .shape-row').forEach(x => x.setAttribute('aria-selected', sel.has(+x.dataset.s))); }
    if (id != null && sim.starts.has(id)) { sim.playing = false; seqFollow = true; sim.pos = sim.starts.get(id) + 1; syncSim(); simPaint(); }
  });
  $('#seqSewLaser').onclick = () => api('sew_then_laser');
  /* the suggestion over the list: the engine works the best order out on a copy; when it would save at least 5 cm
     and 3 % of the travel, the window says how much (and about how long, at the machine's 150 mm/s travel) */
  // the suggestion is shown until the best order has been used once on this job: after that the user's own changes
  // to the order are not second-guessed
  let tipT = 0, tipN = 0, bestDone = false;
  function seqTip() {
    clearTimeout(tipT);
    // its numbers are of the order before this change; the focus (its button, just pressed) stays in the window
    if ($('#seqTip').contains(document.activeElement)) $('#simPlay').focus();
    $('#seqTip').hidden = true;
    const n = ++tipN;
    if (bestDone) return;
    tipT = setTimeout(async () => {
      let p;
      try { p = await (await fetch('/api/best_order_preview', { method: 'POST', body: '{}' })).json(); } catch { return; }
      if (n !== tipN) return;      // a later change asked again
      const save = p.travel - p.best, show = sim.on && !bestDone && save >= 50 && save >= p.travel * 0.03;
      $('#seqTip').hidden = !show;
      if (!show) return;
      const t = Math.max(1, Math.round(save / 150));
      $('#seqTipSave').textContent = `Best order saves ${save >= 1000 ? (save / 1000).toFixed(1) + ' m' : Math.round(save) + ' mm'} of travel`;
      $('#seqTipTime').textContent = `About ${t >= 60 ? Math.floor(t / 60) + ' min ' : ''}${t % 60 || t < 60 ? (t % 60) + ' s ' : ''}less on the machine`;
    }, 200);
  }
  $('#seqBest').onclick = () => { bestDone = true; api('best_order_all'); };

  /* only what has been sewn or cut so far is drawn, over a faint copy of the whole run: the drawing appears as the
     needle and the laser go. The view fits the whole run from the start, so nothing moves while it grows */
  const scv = $('#simCv'), sctx = scv.getContext('2d');
  function simPaint() {
    if (!sim.on) return;
    const R = scv.getBoundingClientRect(), dp = window.devicePixelRatio || 1, w = Math.max(1, R.width), h = Math.max(1, R.height);
    if (scv.width !== Math.round(w * dp) || scv.height !== Math.round(h * dp)) { scv.width = Math.round(w * dp); scv.height = Math.round(h * dp); }
    readColors();
    const c = sctx, dark = document.documentElement.dataset.theme === 'dark';
    c.setTransform(dp, 0, 0, dp, 0, 0); c.direction = 'ltr'; c.textAlign = 'left';
    c.fillStyle = colors.canvas; c.fillRect(0, 0, w, h);
    if (!sim.seq.length) return;
    if (!sim.box) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of sim.seq) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      sim.box = [x0, y0, x1, y1];
    }
    const [x0, y0, x1, y1] = sim.box, pad = 40;
    const k = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0));
    const SX = x => w / 2 + (x - (x0 + x1) / 2) * k, SY = y => h / 2 - (y - (y0 + y1) / 2) * k;
    c.lineJoin = c.lineCap = 'round';
    // the whole run, faint, so the order can be followed before it is sewn
    c.globalAlpha = dark ? 0.16 : 0.12; c.strokeStyle = colors['fg-3']; c.lineWidth = 1; c.beginPath();
    for (const q of sim.seq) { if (q[2]) c.moveTo(SX(q[0]), SY(q[1])); else c.lineTo(SX(q[0]), SY(q[1])); }
    c.stroke(); c.globalAlpha = 1;
    const n = Math.floor(sim.pos);
    const frac = Math.min(1, sim.pos - n);
    // the head moves smoothly towards the next point
    const nx = sim.seq[n], onSeg = n > 0 && nx && !nx[2] && frac > 0;
    let [x, y, , , onLaser] = sim.seq[Math.max(0, n - 1)];
    if (onSeg) { x += (nx[0] - x) * frac; y += (nx[1] - y) * frac; }
    // sewn thread, laser cuts and travel moves so far; a run of the same kind and colour is one stroke
    let kind = null, col = null, path = null;
    const flush = () => {
      if (!path) return;
      if (kind === 'travel') { c.strokeStyle = colors['fg-3']; c.lineWidth = 1; c.setLineDash([3, 4]); c.stroke(path); c.setLineDash([]); }
      else { c.strokeStyle = ink(col); c.lineWidth = 2; c.stroke(path); }   // sewn or cut: the same line, in the layer's colour
    };
    for (let i = 1; i < n; i++) {
      const p = sim.seq[i - 1], q = sim.seq[i];
      const kd = q[2] ? 'travel' : 'S' + q[3];
      if (kd !== kind) { flush(); kind = kd; col = q[3]; path = new Path2D(); path.moveTo(SX(p[0]), SY(p[1])); }
      path.lineTo(SX(q[0]), SY(q[1]));
    }
    // the segment the head is on is drawn up to the head, so the line keeps up with it (a laser segment can be long)
    if (onSeg) {
      const p = sim.seq[n - 1], kd = 'S' + nx[3];
      if (kd !== kind) { flush(); kind = kd; col = nx[3]; path = new Path2D(); path.moveTo(SX(p[0]), SY(p[1])); }
      path.lineTo(SX(x), SY(y));
    }
    flush();
    if (!n) return;
    const X = SX(x), Y = SY(y), lc = onLaser ? ink(sim.seq[n - 1][3]) : null;
    // the head: a ring and a point, thread-coloured for the needle and in the layer's colour for the laser
    c.globalAlpha = onLaser ? 0.25 : 1; c.fillStyle = onLaser ? lc : colors['thread-soft']; c.beginPath(); c.arc(X, Y, 11, 0, 7); c.fill(); c.globalAlpha = 1;
    c.fillStyle = onLaser ? lc : colors.thread; c.beginPath(); c.arc(X, Y, 4, 0, 7); c.fill();
    const label = (window.tr || (x => x))(onLaser ? 'Laser' : 'Needle');
    c.font = '600 11px ' + getComputedStyle(document.body).getPropertyValue('--font'); c.fillStyle = onLaser ? lc : colors.thread; c.fillText(label, X + 14, Y - 14);
  }
  $('#simPlay').onclick = () => { if (sim.playing) { sim.playing = false; syncSim(); } else startSim(true); };
  $('#simBack').onclick = e => simStep(-1, e.shiftKey);
  $('#simFwd').onclick = e => simStep(1, e.shiftKey);
  $('#simPos').addEventListener('input', e => { sim.playing = false; sim.pos = +e.target.value; syncSim(); simPaint(); });
  $('#simSpeed').addEventListener('change', e => { sim.speed = +e.target.value; });
  $('#simClose').onclick = stopSim;
  $('#simScrim').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); return stopSim(); }
    if (e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); return $('#simPlay').click(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); return simStep(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey, e.repeat); }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); sim.playing = false; sim.pos = e.key === 'Home' ? 0 : sim.seq.length; syncSim(); simPaint(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return api(e.shiftKey ? 'redo' : 'undo', {}, { quiet: true }); }
    if (e.key === 'Tab') {   // Tab stays in the window
      const f = $$('#simScrim button, #simScrim input, #simScrim select'), i = f.indexOf(document.activeElement);
      if (i < 0 || (e.shiftKey ? i === 0 : i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    }
  });

  /* ------------------------------------------------------------------ sheets */
  let sheetCtx = {};
  // the shortcuts follow Adobe Illustrator's; 1 marks the ones that changed to match it
  const KEYS = [
    ['File', [['Open a drawing or job', 'Ctrl O'], ['Save job', 'Ctrl S'], ['Save job as…', 'Ctrl Shift S'], ['Save machine file', 'Ctrl Alt E', 1], ['New job', 'Ctrl N'], ['Insert a drawing', 'Ctrl Shift P', 1], ['Home: new job, open, recent files', 'Ctrl Shift H', 1]]],
    ['Edit', [['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z', 1], ['Select all', 'Ctrl A'], ['Clear the selection', 'Ctrl Shift A', 1], ['Clear the selection, leave a tool', 'Esc'],
      ['Copy', 'Ctrl C', 1], ['Cut', 'Ctrl X', 1], ['Paste in the middle of the view', 'Ctrl V', 1], ['Paste in place, sewn last', 'Ctrl F', 1], ['Paste in place, sewn first', 'Ctrl B', 1],
      ['Copy while dragging', 'Alt', 1], ['Do the last move, rotate, mirror or resize again', 'Ctrl D', 1], ['Delete selected', 'Delete'], ['Nudge the selection', '← ↑ → ↓'], ['Nudge ×10', 'Shift ← ↑ → ↓'],
      ['Join line ends', 'Ctrl J', 1], ['Reverse direction', 'Ctrl Alt R', 1], ['Make a layer from the selection', 'Ctrl G'], ['Delete layer, keep its shapes', 'Ctrl Shift G'],
      ['Sew one step later', 'Ctrl ]', 1], ['Sew one step earlier', 'Ctrl [', 1], ['Sew last', 'Ctrl Shift ]', 1], ['Sew first', 'Ctrl Shift [', 1]]],
    ['Tools', [['Selection: move and resize whole shapes', 'V'], ['Direct selection: move one path', 'A'], ['Resize keeping proportions', 'Shift'], ['Resize from the centre', 'Alt'], ['Box: only shapes fully inside', 'Alt'],
      ['Pan', 'H'], ['Pan while held', 'Space'], ['Rotate: type the angle', 'R', 1], ['Mirror left–right', 'O', 1], ['Mirror up–down', 'Shift O', 1], ['Resize: type the size', 'S', 1], ['Move: type the distance', 'Enter', 1],
      ['Set start point', 'C', 1], ['Measure', 'I', 1], ['Add shape', 'M', 1]]],
    ['View', [['Fit the drawing', 'Ctrl 0', 1], ['Real size (100%)', 'Ctrl 1', 1], ['Zoom in', 'Ctrl +', 1], ['Zoom out', 'Ctrl −', 1], ['Show stitches', 'Ctrl Y', 1], ['Show sewing order', 'Ctrl H', 1],
      ['Hide / show the stage panel', 'Shift Tab', 1], ['Find any tool', 'Ctrl K'], ['Light / dark', 'Ctrl Shift L'], ['Settings', 'Ctrl ,', 1], ['Keyboard shortcuts', 'Ctrl Alt Shift K', 1], ['Keyboard shortcuts', '?']]],
    ['Stages', [['Import', '1'], ['Arrange', '2'], ['Stitch', '3'], ['Sequence', '4'], ['Output', '5'], ['Next step', 'PageDown', 1], ['Previous step', 'PageUp', 1]]],
  ];
  const KEYS_SIMPLE = [
    ['File', [['Open a drawing or job', 'Ctrl O'], ['Save job', 'Ctrl S'], ['Save machine file', 'Ctrl Alt E'], ['New job', 'Ctrl N'], ['Home: new job, open, recent files', 'Ctrl Shift H']]],
    ['Edit', [['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z'], ['Stop the simulation, clear the selection', 'Esc'], ['Delete selected', 'Delete'], ['Create group from the selection', 'Ctrl G'], ['Sequence window: step through the run', '← →'], ['Sequence window: a shape at a time', 'Shift ← →'], ['Nudge the selection', '← ↑ → ↓'], ['Nudge ×10', 'Shift ← ↑ → ↓']]],
    ['Tools', [['Selection: move and resize whole shapes', 'V'], ['Direct selection: move one path', 'A'], ['Pan', 'H'], ['Set start point', 'C'], ['Measure', 'I'], ['Add shape', 'M']]],
    ['View', [['Fit the drawing', 'Ctrl 0'], ['Real size (100%)', 'Ctrl 1'], ['Zoom in', 'Ctrl +'], ['Zoom out', 'Ctrl −'], ['Pan while held', 'Space'], ['Original shape / stitches', 'Ctrl Y'],
      ['Light / dark', 'Ctrl Shift L'], ['Settings', 'Ctrl ,'], ['Keyboard shortcuts', '?']]],
  ];
  const keyCaps = k => k === '← ↑ → ↓' ? `<kbd>${k}</kbd>` : k.startsWith('Shift ←') ? `<kbd>Shift</kbd><kbd>← ↑ → ↓</kbd>` : k.split(' ').map(x => `<kbd>${x}</kbd>`).join('');
  const SHEETS = {
    newjob: () => {
      const w = sheetCtx.w ?? +J().table_w, h = sheetCtx.h ?? +J().table_h;
      return `<header><h3>New job</h3><p>Name the job and set the size of the machine table.</p></header>
      <div class="body"><div style="display:grid;gap:6px"><label class="eyebrow" for="njName">Job name</label><span class="field wide"><input id="njName" placeholder="Untitled" autocomplete="off" maxlength="80"></span></div>
      <div style="display:grid;gap:6px"><span class="eyebrow">Machine table</span><div class="nj-presets" id="njPresets">${tableSizes().map(([a, b]) => `<button class="btn sm" data-njsize="${a}x${b}" aria-pressed="${a === w && b === h}">${sizeTxt(a, b)}</button>`).join('')}</div></div>
      ${row('Table width', fld('njW', +(+w).toFixed(3)))}${row('Table height', fld('njH', +(+h).toFixed(3)))}</div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Create</button></footer>`;
    },
    keys: () => `<header><h3>Keyboard shortcuts</h3><p>The same keys as Adobe Illustrator. Point at any button to see its shortcut.</p></header>
      <div class="body"><div class="keys-grid">${(simple ? [[KEYS_SIMPLE[0], KEYS_SIMPLE[2]], [KEYS_SIMPLE[1]], [KEYS_SIMPLE[3]]] : [[KEYS[0], KEYS[4]], [KEYS[1]], [KEYS[2], KEYS[3]]]).map(col => `<div>${col.map(([g, list]) => `<h4>${g}</h4>${list.map(([n, k, isNew]) => `<div class="k"><span>${n}${isNew ? '<span class="new">new</span>' : ''}</span><span data-notr>${keyCaps(k)}</span></div>`).join('')}`).join('')}</div>`).join('')}</div></div>
      <footer><button class="btn primary" data-close>Close</button></footer>`,
    group: () => `<header><h3>Make a layer</h3><p>${sel.size} selected shape${sel.size > 1 ? 's' : ''} move into a new layer with its own needle.</p></header>
      <div class="body">${row('Name', `<span class="field wide" style="width:200px"><input id="gName" value="${nextLayerName()}"></span>`)}
      ${row('Use', `<div class="seg" role="group" id="gKind"><button aria-pressed="true" data-k="sew">Sewing</button><button aria-pressed="false" data-k="laser">Laser cut</button></div>`)}
      ${simple ? '' : row('Needle', `<div class="seg" role="group" id="gNeedle">${[1, 2, 3].map(k => `<button aria-pressed="${k === 1}" data-k="${k}">Needle ${k}</button>`).join('')}</div>`)}
      ${row('Colour', `<input type="color" id="gColor" value="${['#e8336d', '#7a5cff', '#13a3a3', '#f08c00', '#2f9e44', '#1c7ed6'][S.job.layers.length % 6]}" style="width:44px;height:28px;border:0;background:none;padding:0">`)}
      <p class="hint">Example: put everything that is embroidered in one layer on Needle 1, and the laser cut lines in another layer on Needle 3.</p></div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Make layer</button></footer>`,
    add: () => `<header><h3>Add shape</h3><p>Places a new shape at an exact position (mm).</p></header>
      <div class="body"><div class="seg" role="group" id="addKind" style="justify-self:start">${[['point', 'Point'], ['line', 'Line'], ['rect', 'Rectangle'], ['circle', 'Circle']].map(([k, t], i) => `<button aria-pressed="${i === 1}" data-k="${k}">${t}</button>`).join('')}</div>
      ${row('Position X', fld('ax', fmt(sheetCtx.x ?? 0, 3)))}${row('Position Y', fld('ay', fmt(sheetCtx.y ?? 0, 3)))}
      ${row('Length / width / radius', fld('ar', '20.000'))}${row('Height (rectangle)', fld('ah', '10.000'))}
      ${row('Layer', `<select class="sel" id="aLayer">${S.job.layers.map(l => `<option value="${l.id}" ${l.id === curLayer ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}${S.job.layers.length ? '' : '<option value="">Layer 1</option>'}</select>`)}</div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Add</button></footer>`,
    dup: () => `<header><h3>Duplicate</h3><p>Copies the selected shapes.</p></header>
      <div class="body">${row('Offset X', fld('ox', '10.000'))}${row('Offset Y', fld('oy', '0.000'))}
      ${row('Mirror the copy left–right', sw('dmh', false))}${row('Mirror the copy up–down', sw('dmv', false))}
      ${row('Number of copies', fld('dn', '1', '×'))}</div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Duplicate</button></footer>`,
    ref: () => { const id = [...sel][0]; const r = S.job.refs; const s = shapeById(id);
      return `<header><h3>Reference points</h3><p>Use the start of the selected shape to line the job up on the machine.</p></header>
      <div class="body">${row('Reference point 1', sw('rf1', r.r1 === id))}${row('Reference point 2', sw('rf2', r.r2 === id))}
      ${row(`Layer “${esc(layerOf(s).name)}” is for alignment only (not sewn)`, sw('rfa', r.align === s.layer))}
      <p class="hint">${J().no_reference ? 'Import is set to work without a reference point.' : ''}</p></div>
      <footer><button class="btn left ghost" data-clear>Remove all</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Done</button></footer>`; },
    calc: () => `<header><h3>Scale from a measurement</h3><p>Sew a test piece, measure a known distance, and enter both values.</p></header>
      <div class="body">${row('Length in the drawing', fld('cv1', '100.000'))}${row('Measured on the fabric', fld('cv2', '100.000'))}
      ${row('Apply to', `<select class="sel" id="cvAxis"><option value="xy">X and Y</option><option value="x">X only</option><option value="y">Y only</option></select>`)}</div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Use this scale</button></footer>`,
    points: () => { const s = shapeById([...sel][0]);
      return `<header><h3>Edit points</h3><p>${esc(nameOf(s))} · ${s.pts.length} points</p></header>
      <div class="body"><div class="ptable-wrap"><table class="ptable"><thead><tr><th>#</th><th>X (mm)</th><th>Y (mm)</th><th></th></tr></thead><tbody id="ptBody">${s.pts.slice(0, 2000).map((p, i) => ptRow(i, p)).join('')}</tbody></table></div>
      ${s.pts.length > 2000 ? '<p class="hint">Only the first 2000 points are shown.</p>' : ''}
      ${row('Closed shape', sw('ptClosed', s.closed))}</div>
      <footer><button class="btn left" data-addpt>Add point</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Apply</button></footer>`; },
    marks: () => { const s = shapeById([...sel][0]); const total = plen(s.pts, s.closed);
      return `<header><h3>Sections</h3><p>Sew part of “${esc(nameOf(s))}” differently. The shape is ${total.toFixed(1)} mm long, measured from its start.</p></header>
      <div class="body"><div class="seg" role="group" id="mKind" style="justify-self:start"><button aria-pressed="true" data-k="zigzag">Zigzag</button><button aria-pressed="false" data-k="backtack">Back-tack</button><button aria-pressed="false" data-k="special">Special length</button></div>
      ${row('From', fld('ma', '0.000'))}${row('To', fld('mb', Math.min(total, 10).toFixed(3)))}
      <div id="zzOpts" style="display:grid;gap:9px">${row('Zigzag width', fld('mw', '2.40'))}${row('Zigzag step', fld('mspan', '2.00'))}
      ${row('Zigzag shape', `<select class="sel" id="mshape"><option>V</option><option>W</option></select>`)}${row('Start position', `<select class="sel" id="mstart"><option value="middle">Middle</option><option value="left">Left</option><option value="right">Right</option></select>`)}</div>
      ${(s.marks || []).length ? `<div class="marks">${s.marks.map(m => `<div><span>${m.kind}</span><span class="mono">${fmt(m.a, 1)} – ${fmt(m.b, 1)} mm</span></div>`).join('')}</div>` : ''}</div>
      <footer><button class="btn left ghost" data-clear ${(s.marks || []).length ? '' : 'disabled'}>Clear sections</button><button class="btn" data-close>Close</button><button class="btn primary" data-ok>Add section</button></footer>`; },
    defaults: () => { const d = JSON.parse(JSON.stringify(S.defaults)); sheetCtx.defaults = d;
      return `<header><h3>Default instructions</h3><p>Added automatically at these points of every job.</p></header>
      <div class="body"><div class="stage-list" id="defList">${defRows(d)}</div>
      <div class="row"><select class="sel" id="dEvent">${S.events.map(e => `<option value="${e}">${e}</option>`).join('')}</select><select class="sel" id="dName">${S.instructions.map(n => `<option value="${n}">${n}</option>`).join('')}</select>${fld('dVal', '', '', 'sm')}<button class="btn" data-adddef>Add</button></div></div>
      <footer><button class="btn left ghost" data-resetdef>Reset</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button></footer>`; },
    io: () => { const list = JSON.parse(JSON.stringify(J().io_positions || [])); sheetCtx.io = list;
      return `<header><h3>Output IO at positions</h3><p>Switch a machine output on at a given stitch of a shape.</p></header>
      <div class="body"><div class="stage-list" id="ioList">${ioRows(list)}</div>
      <div class="row"><select class="sel" id="ioShape" style="flex:1">${S.job.order.map(shapeById).filter(Boolean).map(s => `<option value="${s.id}" ${sel.has(s.id) ? 'selected' : ''}>${esc(nameOf(s))}</option>`).join('')}</select>${fld('ioAt', '1', 'st', 'sm')}${fld('ioPort', '1', 'IO', 'sm')}<button class="btn" data-addio>Add</button></div></div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button></footer>`; },
    resize: () => {
      const [x0, y0, x1, y1] = bounds(selected()); const u = store.get('rzUnit', 'cm');
      Object.assign(sheetCtx, { w: x1 - x0, h: y1 - y0, unit: u });
      return `<header><h3>Resize</h3><p>Type the new size. The selection keeps its centre.</p></header>
      <div class="body">${row('Unit', `<div class="seg" role="group" id="rzUnit"><button aria-pressed="${u === 'cm'}" data-k="cm">cm</button><button aria-pressed="${u === 'mm'}" data-k="mm">mm</button></div>`)}
      ${row('Now', `<b class="num" id="rzNow"></b>`)}
      ${row('Width', fld('rzW', '', u))}${row('Height', fld('rzH', '', u))}
      ${row('Keep proportions', sw('rzLock', true))}
      <p class="hint num" id="rzPct" data-notr></p></div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Resize</button></footer>`; },
    ioRev: () => `<header><h3>IO on reverse</h3><p>Switch an output while the machine sews backwards (back-tacks).</p></header>
      <div class="body">${row('Use an output on reverse stitching', sw('iorOn', J().io_on_reverse))}${row('Output number', fld('iorPort', J().io_reverse_port, 'IO'))}</div>
      <footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button></footer>`,
  };
  /* Resize dialog: sizes are shown in cm or mm, the engine works in mm */
  const rzK = () => sheetCtx.unit === 'cm' ? 10 : 1;
  const rzShow = mm => (mm / rzK()).toFixed(sheetCtx.unit === 'cm' ? 4 : 3);
  function rzFill(wmm, hmm) {
    const c = sheetCtx, t = window.tr || (x => x);
    $('#rzW').value = rzShow(wmm); $('#rzH').value = rzShow(hmm);
    $('#rzW').disabled = c.w < 1e-9; $('#rzH').disabled = c.h < 1e-9;   // a straight line has no width or no height to change
    $$('#sheet .field u').forEach(x => { x.textContent = t(c.unit); });
    $('#rzNow').textContent = `${rzShow(c.w)} × ${rzShow(c.h)} ${t(c.unit)}`;
    rzPct();
  }
  function rzPct() {
    const c = sheetCtx, nw = num('rzW') * rzK(), nh = num('rzH') * rzK();
    $('#rzPct').textContent = `${c.w > 1e-9 ? (nw / c.w * 100).toFixed(1) : '100.0'}% × ${c.h > 1e-9 ? (nh / c.h * 100).toFixed(1) : '100.0'}%`;
  }
  const ptRow = (i, p) => `<tr data-i="${i}"><td>${i + 1}</td><td><span class="field"><input value="${p[0].toFixed(3)}" data-c="0"></span></td><td><span class="field"><input value="${p[1].toFixed(3)}" data-c="1"></span></td><td><button class="icon-btn" data-delpt aria-label="Delete point"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td></tr>`;
  const defRows = d => S.events.map(ev => `<div><span style="color:var(--fg)">${ev}</span><span>${(d[ev] || []).map((x, i) => `<button class="btn sm ghost" data-deldef="${esc(ev)}|${i}" title="Remove">${esc(x.name)}${x.value ? ' ' + esc(x.value) : ''} ✕</button>`).join('') || '—'}</span><span></span></div>`).join('');
  const ioRows = l => l.length ? l.map((x, i) => `<div>${esc(nameOf(shapeById(x.shape) || { id: x.shape, pts: [], name: '' }))}<span>stitch ${x.at} · IO ${x.port}</span><button class="btn sm ghost" data-delio="${i}">Remove</button></div>`).join('') : '<div><span>No outputs yet.</span><span></span><span></span></div>';

  function openSheet(k, c = {}) {
    if (!S) return;
    if (['ref', 'points', 'marks', 'dup', 'resize'].includes(k) && !needSel()) return;
    if (k === 'keys' && !$('#sheetScrim').hidden && $('#sheet').dataset.k === 'keys') return closeSheet();
    sheetCtx = c;
    const sh = $('#sheet');
    sh.className = 'sheet' + (k === 'points' || k === 'defaults' ? ' wide' : k === 'keys' ? ' keys' : '');
    sh.innerHTML = SHEETS[k](); sh.dataset.k = k;
    showSheet();
    if (k === 'resize') { rzFill(sheetCtx.w, sheetCtx.h); const f = $('#rzW').disabled ? $('#rzH') : $('#rzW'); f.focus(); f.select(); return; }
    ($('#sheet input') || $('#sheet [data-ok]') || $('#sheet [data-close]'))?.focus();
  }
  // a dialog is named by its heading; closing it puts the focus back where it was before
  let sheetFrom = null;
  function showSheet() {
    if ($('#sheetScrim').hidden) sheetFrom = document.activeElement;
    const h = $('#sheet h3'); if (h) h.id = 'sheetTitle';
    $('#sheetScrim').hidden = false;
  }
  const closeSheet = () => { $('#sheetScrim').hidden = true; if (sheetFrom?.isConnected) sheetFrom.focus({ preventScroll: true }); sheetFrom = null; };
  // Tab and Shift+Tab go round the open dialog's own controls, never to the window behind it
  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const f = $$('#sheet button, #sheet input, #sheet select').filter(x => !x.disabled && x.offsetParent);
    const i = f.indexOf(document.activeElement);
    if (f.length && (i < 0 || (e.shiftKey ? i === 0 : i === f.length - 1))) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
  }
  function confirmSheet(title, text, okText, fn) {
    const sh = $('#sheet'); sh.className = 'sheet'; sh.dataset.k = 'confirm';
    sh.innerHTML = `<header><h3>${title}</h3><p>${text}</p></header><footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${okText}</button></footer>`;
    sheetCtx = { fn }; showSheet(); $('#sheet [data-ok]').focus();
  }
  /* Unsaved changes that would be lost: Save / Don't save / Cancel. Asked when the window closes (the engine stops
     the close and calls closeQuestion) and before anything replaces the job: open, drop, recent file, new job */
  const quit = discard => window.__TAURI_INTERNALS__?.invoke('quit', { discard });
  // the job is a drawing opened (or a new job made) in this window and not edited since: the file it came from still
  // has all of it, so replacing it asks nothing. After a restart the autosave is always treated as work to keep.
  let pristine = false;
  const unsaved = () => S.file.dirty && S.job.shapes.length > 0 && !(pristine && !S.can_undo && !S.can_redo);
  function askSave(title, text, saved, discard, closing = false) {
    const sh = $('#sheet'); sh.className = 'sheet'; sh.dataset.k = 'unsaved';
    sh.innerHTML = `<header><h3>${title}</h3><p>${text}</p></header>
      <footer><button class="btn left" data-nosave>Don't save</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button></footer>`;
    sheetCtx = { saved, discard, closing }; showSheet(); $('#sheet [data-ok]').focus();
  }
  function closeQuestion() {
    if (!S || !S.file.dirty) return quit(false);
    if (!$('#sheetScrim').hidden && sheetCtx.closing) return;
    askSave(`Save changes to “${esc(S.file.name)}” before closing?`, "If you don't save, your changes will be lost.", () => quit(false), () => quit(true), true);
  }
  window.__stitchlineClose = closeQuestion;
  /** Runs go() at once, or after the user saved or dropped the unsaved changes it would replace (false while asking). */
  function guardUnsaved(go) {
    if (!unsaved()) return go();
    askSave(`Save changes to “${esc(S.file.name)}” first?`, "Opening a file or starting a new job replaces this one. If you don't save, your changes will be lost.", go, go);
    return false;
  }
  function promptSheet(title, text, value, fn) {
    const sh = $('#sheet'); sh.className = 'sheet'; sh.dataset.k = 'prompt';
    sh.innerHTML = `<header><h3>${title}</h3><p>${text}</p></header><div class="body"><span class="field wide"><input id="pv" value="${esc(value)}"></span></div><footer><button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>OK</button></footer>`;
    sheetCtx = { fn }; showSheet(); const i = $('#pv'); i.focus(); i.select();
  }
  const segVal = id => $(`#${id} button[aria-pressed="true"]`)?.dataset.k;
  const swOn = id => $('#' + id)?.getAttribute('aria-checked') === 'true';

  const SHEET_OK = {
    newjob: async () => {
      const w = num('njW'), h = num('njH'), name = $('#njName').value.trim();
      if (!(w > 0 && h > 0)) { toast('The table size must be more than 0 mm.', true); return false; }
      return guardUnsaved(async () => {
        const d = await api('new', { name, table_w: w, table_h: h }, { quiet: true });
        if (!d) return false;
        rememberSize(w, h); pristine = true; bestDone = false; sel.clear(); hideHome(); setStage('import'); fitView(); toast('New job');
      });
    },
    group: async () => {
      // the simple mode has no needle choice: a sewing group keeps the needle its shapes were sewn with
      const sewNeedle = () => { const L = layerOf(shapeById([...sel][0])); return L && !isLaser(L) ? L.needle : 1; };
      const laser = segVal('gKind') === 'laser';
      const d = await api('group', { ids: [...sel], name: $('#gName').value.trim(), needle: laser ? 3 : simple ? sewNeedle() : +segVal('gNeedle'), color: $('#gColor').value }, { quiet: true });
      if (d) {
        const L = d.job.layers.find(l => S.job.shapes.some(s => sel.has(s.id) && s.layer === l.id)); if (L) curLayer = L.id;
        if (laser && L) await setKind(L.id, 'laser', $('#gColor').value); else { renderAll(); toast('Layer made'); }
      }
    },
    confirm: () => sheetCtx.fn(),
    unsaved: async () => { const { saved } = sheetCtx; closeSheet(); const d = await api('save'); if (d && !d.file.dirty) saved(); },
    prompt: () => { const v = $('#pv').value.trim(); if (v) sheetCtx.fn(v); },
    add: async () => {
      let layer = $('#aLayer').value;
      const k = segVal('addKind'), size = num('ar');
      if (k === 'circle' && size <= 0) return toast('Enter a radius.', true);
      const d = await api('add_shape', { kind: k, x: num('ax'), y: num('ay'), size, w: size, h: num('ah'), layer: layer || null }, { quiet: true });
      if (d) { toast('Shape added'); if (d.job.shapes.length === 1) fitView(); }
    },
    dup: async () => {
      const n = Math.max(1, Math.min(200, Math.round(num('dn'))));
      let ids = [...sel]; const all = [];
      for (let i = 0; i < n; i++) { const d = await api('duplicate', { ids, dx: num('ox'), dy: num('oy'), mh: swOn('dmh'), mv: swOn('dmv') }, { quiet: true }); if (!d) break; ids = d.new_ids; all.push(...ids); }
      sel = new Set(all); renderAll(); toast(n > 1 ? `${n} copies made` : 'Shape duplicated');
    },
    ref: async () => {
      const id = [...sel][0]; const r = S.job.refs; const s = shapeById(id);
      if (swOn('rf1') !== (r.r1 === id)) await api('set_ref', { which: 'r1', id: swOn('rf1') ? id : null }, { quiet: true });
      if (swOn('rf2') !== (r.r2 === id)) await api('set_ref', { which: 'r2', id: swOn('rf2') ? id : null }, { quiet: true });
      if (swOn('rfa') !== (r.align === s.layer)) await api('set_ref', { which: 'align', id: swOn('rfa') ? id : null }, { quiet: true });
    },
    calc: () => {
      const a = num('cv1'), b = num('cv2'); if (a <= 0 || b <= 0) return toast('Both lengths must be more than 0.', true);
      const f = a / b, ax = $('#cvAxis').value;
      const v = {}; if (ax !== 'y') v.scale_x = +(J().scale_x * f).toFixed(5); if (ax !== 'x') v.scale_y = +(J().scale_y * f).toFixed(5);
      setJob(v).then(d => d && toast(`Scale set to ${fmt(f, 4)}×. Use “Scale drawing now” to apply it to this job.`));
    },
    points: () => {
      const pts = $$('#ptBody tr').map(tr => $$('input', tr).map(i => parseFloat(i.value.replace(',', '.'))));
      if (pts.some(p => p.some(v => !Number.isFinite(v)))) { toast('Every point needs a number for X and Y.', true); return false; }
      api('set_points', { id: [...sel][0], pts, closed: swOn('ptClosed') }, { quiet: true });
    },
    marks: async () => {
      const kind = segVal('mKind'), id = [...sel][0];
      await api('add_mark', { id, kind, a: num('ma'), b: num('mb'), params: { width: num('mw'), span: num('mspan'), shape: $('#mshape').value, start: $('#mstart').value } }, { quiet: true });
      toast('Section added'); return false;
    },
    defaults: () => setJob({ defaults: sheetCtx.defaults }),
    io: () => setJob({ io_positions: sheetCtx.io }),
    resize: () => {
      const c = sheetCtx, nw = num('rzW') * rzK(), nh = num('rzH') * rzK();
      if ((c.w > 1e-9 && !(nw > 0)) || (c.h > 1e-9 && !(nh > 0))) { toast('Enter a size more than 0.', true); return false; }
      const sx = c.w > 1e-9 ? nw / c.w : 1, sy = c.h > 1e-9 ? nh / c.h : 1;
      if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return;   // same size: nothing to do
      xform('scale', { sx, sy });                                        // about the centre, one undo step
    },
    ioRev: () => setJob({ io_on_reverse: swOn('iorOn'), io_reverse_port: Math.max(1, Math.round(num('iorPort'))) }),
  };
  $('#sheetScrim').addEventListener('click', async e => {
    const t = e.target;
    const k = $('#sheet').dataset.k;
    // a click outside closes only the dialogs that change nothing, so it never throws away what was typed
    if (t === e.currentTarget) return ['keys', 'confirm', 'unsaved'].includes(k) && closeSheet();
    if (t.closest('[data-close]')) return closeSheet();
    const sb = t.closest('.seg button');
    if (sb) {
      $$('button', sb.parentElement).forEach(b => b.setAttribute('aria-pressed', b === sb));
      if (sb.parentElement.id === 'mKind') $('#zzOpts').hidden = sb.dataset.k !== 'zigzag';
      if (sb.parentElement.id === 'rzUnit') { const wmm = num('rzW') * rzK(), hmm = num('rzH') * rzK(); sheetCtx.unit = sb.dataset.k; store.set('rzUnit', sheetCtx.unit); rzFill(wmm, hmm); }
      if (sb.parentElement.id === 'gKind') {
        const k = sb.dataset.k === 'laser' ? '3' : '1'; $$('#gNeedle button').forEach(b => b.setAttribute('aria-pressed', b.dataset.k === k));
        // a laser layer starts red; back to sewing, the colour it was offered first
        const c = $('#gColor'); c.dataset.sew ??= c.value; c.value = k === '3' ? LASER_RED : c.dataset.sew;
      }
      return;
    }
    const s = t.closest('.switch'); if (s) { s.setAttribute('aria-checked', s.getAttribute('aria-checked') !== 'true'); return; }
    if (t.closest('[data-nosave]')) { const { discard } = sheetCtx; closeSheet(); return discard(); }
    const nz = t.closest('[data-njsize]');
    if (nz) { const [w, h] = nz.dataset.njsize.split('x'); $('#njW').value = w; $('#njH').value = h; $$('#njPresets button').forEach(b => b.setAttribute('aria-pressed', b === nz)); return; }
    if (t.closest('[data-ok]')) { const r = await SHEET_OK[k]?.(); if (r !== false) closeSheet(); else if (k === 'marks') openSheet('marks'); return; }
    if (t.closest('[data-clear]')) {
      if (k === 'ref') { await api('set_ref', { which: 'r1', id: null }, { quiet: true }); await api('set_ref', { which: 'r2', id: null }, { quiet: true }); await api('set_ref', { which: 'align', id: null }, { quiet: true }); closeSheet(); }
      if (k === 'marks') { await api('clear_marks', { ids: [...sel] }, { quiet: true }); openSheet('marks'); }
      return;
    }
    if (t.closest('[data-addpt]')) { const tb = $('#ptBody'); const last = $$('tr', tb).at(-1); const p = last ? $$('input', last).map(i => +i.value + 5) : [0, 0]; tb.insertAdjacentHTML('beforeend', ptRow(tb.children.length, p)); return; }
    if (t.closest('[data-delpt]')) { t.closest('tr').remove(); $$('#ptBody tr').forEach((tr, i) => { tr.firstElementChild.textContent = i + 1; }); return; }
    if (t.closest('[data-adddef]')) { const ev = $('#dEvent').value; (sheetCtx.defaults[ev] ||= []).push({ name: $('#dName').value, value: $('#dVal').value }); $('#defList').innerHTML = defRows(sheetCtx.defaults); return; }
    const dd = t.closest('[data-deldef]'); if (dd) { const [ev, i] = dd.dataset.deldef.split('|'); sheetCtx.defaults[ev].splice(+i, 1); $('#defList').innerHTML = defRows(sheetCtx.defaults); return; }
    if (t.closest('[data-resetdef]')) { setJob({ defaults: null }); closeSheet(); return; }
    if (t.closest('[data-addio]')) { sheetCtx.io.push({ shape: +$('#ioShape').value, at: Math.max(1, Math.round(num('ioAt'))), port: Math.max(1, Math.round(num('ioPort'))) }); $('#ioList').innerHTML = ioRows(sheetCtx.io); return; }
    const di = t.closest('[data-delio]'); if (di) { sheetCtx.io.splice(+di.dataset.delio, 1); $('#ioList').innerHTML = ioRows(sheetCtx.io); }
  });
  $('#sheet').addEventListener('input', e => {
    if ($('#sheet').dataset.k === 'newjob' && /^nj[WH]$/.test(e.target.id)) $$('#njPresets button').forEach(b => b.setAttribute('aria-pressed', b.dataset.njsize === `${num('njW')}x${num('njH')}`));
    if ($('#sheet').dataset.k !== 'resize' || !/^rz[WH]$/.test(e.target.id)) return;
    const c = sheetCtx;
    if (swOn('rzLock') && c.w > 1e-9 && c.h > 1e-9) {
      const f = e.target.id === 'rzW' ? num('rzW') * rzK() / c.w : num('rzH') * rzK() / c.h;
      if (f > 0) $(e.target.id === 'rzW' ? '#rzH' : '#rzW').value = rzShow((e.target.id === 'rzW' ? c.h : c.w) * f);
    }
    rzPct();
  });
  $('#sheet').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('#sheet [data-ok]')?.click(); } e.stopPropagation(); trapTab(e); if (e.key === 'Escape') closeSheet(); });

  /* ------------------------------------------------------------------ command palette */
  const TOOLS = [
    ['Open file', 'import', () => ACT.open()], ['Insert another drawing into the job', 'import', () => ACT.insert()], ['Save job', 'import', () => ACT.save()], ['Save job as…', 'import', () => api('save', { as_new: true })],
    ['Remove overlapping shapes on open', 'import'], ["Don't join lines automatically", 'import'], ['Work without reference point', 'import'], ['Drawing resolution (dpi)', 'import'], ['Scale drawing', 'import'], ['Calculate scale from a measurement', 'import', () => openSheet('calc')], ['Machine table size', 'import'], ['New job', 'import', () => openSheet('newjob')], ['Home: new job, open, recent files', 'import', () => showHome()],
    ['Add shape (point, line, rectangle, circle)', 'arrange', () => openSheet('add')], ['Duplicate', 'arrange', () => openSheet('dup')], ['Move shape to another layer', 'arrange'], ['New empty layer', 'arrange', () => $('#addLayer').click()], ['Reference point', 'arrange', () => openSheet('ref')], ['Nudge / move', 'arrange'], ['Rotate', 'arrange'], ['Mirror', 'arrange'], ['Resize selected shapes', 'arrange', () => openSheet('resize')], ['Pick start point', 'arrange', () => setTool('start')], ['Reverse direction', 'arrange', () => ACT.op({ dataset: { op: 'reverse' } })], ['Extend or shorten ends', 'arrange'], ['Edit points one by one', 'arrange', () => openSheet('points')], ['Split a shape', 'arrange'], ['Merge close points', 'arrange'], ['Delete short lines', 'arrange'], ['Join line ends', 'arrange'], ['Select all', 'arrange', () => ACT.selectAll()], ['Delete selected', 'arrange', () => ACT.op({ dataset: { op: 'delete' } })], ['Start every shape at top / bottom / left / right', 'arrange'], ['Sections: zigzag, back-tack, special length', 'arrange', () => openSheet('marks')], ['Measure distance', 'arrange', () => setTool('measure')], ['Undo', 'arrange', () => api('undo')], ['Redo', 'arrange', () => api('redo')],
    ['Make a layer from the selection (Ctrl+G)', 'arrange', () => ACT.groupSheet()], ['Delete layer, keep its shapes (Ctrl+Shift+G)', 'arrange'], ['Set the needle of a layer', 'arrange'],
    ['Light / dark (Ctrl+Shift+L)', 'import', () => toggleTheme()],
    ['Hide / show the stage panel (Shift+Tab)', 'import', () => toggleInspector()],
    ['Keyboard shortcuts', 'import', () => openSheet('keys')],
    ['Settings: language, theme, fonts, text size, interface (Ctrl+,)', '', () => openSettings()],
    ['Simple mode: only layers, laser, stitch length, simulation and saving', '', () => setSimple(true)],
    ['Language: العربية / English', 'import', () => setLang(window.STL_LANG === 'ar' ? 'en' : 'ar')],
    ['Make a layer laser cut', 'stitch', () => setKind(curLayer, 'laser')],
    ['Speed up laser paths', 'stitch', () => api('laser_fix', { id: curLayer })],
    ['Stitch length', 'stitch'], ['Convert lines to stitches', 'stitch'], ['Sewing head (needle 1–3)', 'stitch'], ['Back-tack', 'stitch'], ['Closed-shape reinforcement', 'stitch'], ['Slow down at corners', 'stitch'], ['Dense stitches at corners', 'stitch'], ['Dense stitches at start / end', 'stitch'], ['Special stitch length', 'stitch'], ['Double stitch length', 'stitch'], ['Machine origin', 'stitch'], ['Backlash compensation', 'stitch'], ['Small closed shapes to points', 'stitch'], ['Copy stitch settings to all layers', 'stitch', () => ACT.copySettings()],
    ['Sewing order', 'sequence'], ['Sort top → bottom / left → right', 'sequence'], ['Shortest travel order', 'sequence', () => ACT.nearest()], ['Sort by end point', 'sequence'], ['Row spacing', 'sequence'], ['Corners on travel moves', 'sequence'], ['Simulate sewing', 'sequence', () => startSim(true)], ['Show sewing order on the drawing', 'sequence', () => $('#showOrder').click()],
    ['Program instructions (insert, move, delete)', 'output'], ['Default instructions', 'output', () => openSheet('defaults')], ['Output IO at positions', 'output', () => openSheet('io')], ['IO on reverse', 'output', () => openSheet('ioRev')], ['Sewing speed', 'output'], ['Gradual speed start', 'output'], ['Scale output', 'output'], ['Save machine file (SLW)', 'output', () => ACT.saveMachine()], ['Save to USB drive', 'output'], ['Export PLT', 'output', () => api('export', { kind: 'plt', mode: J().dxf_mode })], ['Export DXF', 'output', () => api('export', { kind: 'dxf', mode: J().dxf_mode })], ['Export picture (SVG)', 'output', () => api('export', { kind: 'svg' })], ['Export stitch list (CSV)', 'output', () => api('export', { kind: 'csv' })],
  ];
  const NAMES = { import: 'Import', arrange: 'Arrange', stitch: 'Stitch', sequence: 'Sequence', output: 'Output' };
  let hits = [], hi = 0;
  // lower case, and Arabic as people type it: any alef, ة / ه and ى / ي alike, no diacritics
  const fold = s => s.toLowerCase().replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  function renderPalette() {
    const q = fold($('#pq').value.trim());
    // a tool is found by its English name and by the name shown (the Arabic one when the interface is in Arabic)
    const t = window.tr || (x => x);
    const words = ([n, s]) => fold([n, t(n), NAMES[s], t(NAMES[s])].join(' '));
    hits = TOOLS.filter(tl => { const ws = words(tl); return !q || q.split(/\s+/).every(w => ws.includes(w)); });
    hi = Math.min(hi, Math.max(0, hits.length - 1));
    $('#plist').innerHTML = hits.map(([n, s], i) => `<li class="${i === hi ? 'on' : ''}" data-i="${i}"><span>${n}</span><span class="st">${NAMES[s] || ''}</span></li>`).join('') || '<li><span class="st">No tool matches. Try “stitch”, “mirror” or “USB”.</span></li>';
    $('#pcount').textContent = `${hits.length} of ${TOOLS.length} tools`;
    $('#plist .on')?.scrollIntoView({ block: 'nearest' });
  }
  function openPalette() { if (!S) return; $('#paletteScrim').hidden = false; $('#pq').value = ''; hi = 0; renderPalette(); $('#pq').focus(); }
  function runTool(i) {
    const t = hits[i]; if (!t) return;
    $('#paletteScrim').hidden = true;
    if (t[1] && t[1] !== stage) setStage(t[1]);
    if (t[2]) t[2]();
  }
  $('#openPalette').onclick = openPalette;
  $('#pq').addEventListener('input', () => { hi = 0; renderPalette(); });
  $('#plist').addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) runTool(+li.dataset.i); });
  $('#paletteScrim').addEventListener('click', e => { if (e.target === e.currentTarget) $('#paletteScrim').hidden = true; });

  /* ------------------------------------------------------------------ keyboard */
  document.addEventListener('keydown', e => {
    if (!S) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || !!document.activeElement?.isContentEditable;
    const ctrl = e.ctrlKey || e.metaKey;
    // the physical key, so shortcuts also work with the Arabic keyboard layout (Ctrl+Z types ئ there)
    const k = /^(Key[A-Z]|Digit[0-9])$/.test(e.code || '') ? e.code.slice(-1).toLowerCase() : e.key.toLowerCase();
    if (sim.on) {   // the simulation window has the keys while it is open, wherever the focus is
      if (e.key === 'Escape') { e.preventDefault(); stopSim(); }
      else if (e.key === ' ') { e.preventDefault(); $('#simPlay').click(); }
      return;
    }
    if (ctrl && e.code === 'Comma' && $('#sheetScrim').hidden) { e.preventDefault(); return openSettings(); }
    if (!$('#paletteScrim').hidden) {
      if (e.key === 'ArrowDown') { hi = Math.min(hits.length - 1, hi + 1); renderPalette(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); renderPalette(); e.preventDefault(); }
      if (e.key === 'Enter') runTool(hi);
      if (e.key === 'Escape') $('#paletteScrim').hidden = true;
      return;
    }
    if (!$('#sheetScrim').hidden) {
      trapTab(e);
      if (e.key === 'Escape') closeSheet();
      if (e.key === 'Enter' && $('#sheet').dataset.k === 'newjob' && e.target.tagName === 'INPUT') { e.preventDefault(); $('#sheet [data-ok]').click(); }
      return;
    }
    if (homeOpen()) {
      if (e.key === 'Escape' && !$('#homeBack').hidden) { e.preventDefault(); return hideHome(); }
      if (ctrl && k === 'o') { e.preventDefault(); return ACT.open(); }
      if (ctrl && k === 'n') { e.preventDefault(); return openSheet('newjob'); }
      if (ctrl && e.shiftKey && k === 'h') { e.preventDefault(); if (!$('#homeBack').hidden) hideHome(); return; }
      if (ctrl && e.shiftKey && k === 'l') { e.preventDefault(); return toggleTheme(); }
      if (e.key === 'F1' || (ctrl && e.altKey && e.shiftKey && k === 'k')) { e.preventDefault(); return openSheet('keys'); }
      if (ctrl && k === 'k') e.preventDefault();
      return;
    }
    if (ctrl && k === 'k' && e.altKey && e.shiftKey) { e.preventDefault(); return openSheet('keys'); }
    if (ctrl && k === 'k') { e.preventDefault(); return simple || openPalette(); }
    if (ctrl && k === 'o') { e.preventDefault(); return ACT.open(); }
    if (ctrl && k === 's') { e.preventDefault(); return e.shiftKey ? api('save', { as_new: true }) : ACT.save(); }
    if (ctrl && e.altKey && k === 'e') { e.preventDefault(); return ACT.saveMachine(); }
    if (ctrl && k === 'n') { e.preventDefault(); return openSheet('newjob'); }
    if (ctrl && e.shiftKey && k === 'h') { e.preventDefault(); return homeOpen() ? (!$('#homeBack').hidden && hideHome()) : showHome(); }
    if (ctrl && e.shiftKey && k === 'p') { e.preventDefault(); return ACT.insert(); }
    if (ctrl && e.shiftKey && k === 'l') { e.preventDefault(); return toggleTheme(); }
    if (e.key === 'F1') { e.preventDefault(); return openSheet('keys'); }
    // the WebView's own page zoom, find bar, history and print would take these: here they belong to the drawing
    if (ctrl && (/^[fhjp]$/.test(k) || /^(Digit0|Digit1|Numpad0|Numpad1|Equal|Minus|NumpadAdd|NumpadSubtract)$/.test(e.code))) e.preventDefault();
    if (typing) return;
    // during a move or resize: Esc cancels it, Shift / Alt change the resize (or the copy) at once, other keys wait
    if (drag && (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'box')) {
      if (e.key === 'Escape') { e.preventDefault(); cancelDrag(); }
      else if (drag.kind === 'resize' && (e.key === 'Shift' || e.key === 'Alt')) { e.preventDefault(); drag.shift = e.shiftKey; drag.alt = e.altKey; draw(); }
      else if (drag.kind === 'box' && e.key === 'Alt') { e.preventDefault(); drag.enclose = true; draw(); }
      else if (drag.kind === 'move' && e.key === 'Alt') { e.preventDefault(); drag.copy = true; if (drag.moved) cv.className = 'copying'; draw(); }
      return;
    }
    if (e.key === '?' || e.key === '؟') { e.preventDefault(); return openSheet('keys'); }
    if (simple) return simpleKey(e, ctrl, k);
    if (e.key === 'Tab' && e.shiftKey && !ctrl && !e.altKey) { e.preventDefault(); return toggleInspector(); }
    // edit
    if (ctrl && k === 'z') { e.preventDefault(); return api(e.shiftKey ? 'redo' : 'undo', {}, { quiet: true }); }
    if (ctrl && k === 'a') { e.preventDefault(); if (e.shiftKey) { sel.clear(); selChanged(); } else ACT.selectAll(); return; }
    if (ctrl && k === 'c') { e.preventDefault(); return copySel(false); }
    if (ctrl && k === 'x') { e.preventDefault(); return copySel(true); }
    if (ctrl && k === 'v') { e.preventDefault(); return paste('view'); }
    if (ctrl && k === 'f') return paste('front');
    if (ctrl && k === 'b') { e.preventDefault(); return paste('back'); }
    if (ctrl && k === 'd') { e.preventDefault(); return again(); }
    if (ctrl && k === 'g') { e.preventDefault(); if (e.shiftKey) { const L = layerById(curLayer); if (L) api('ungroup', { id: L.id }, { quiet: true }); } else ACT.groupSheet(); return; }
    if (ctrl && k === 'j') return needSel() && api('join', { ids: [...sel], tol: parseFloat($('#jt')?.value) || 2 });
    if (ctrl && e.altKey && k === 'r') { e.preventDefault(); return needSel() && api('reverse', { ids: [...sel] }, { quiet: true }); }
    if (ctrl && (e.code === 'BracketRight' || e.code === 'BracketLeft')) { e.preventDefault(); return sewOrder(e.code === 'BracketRight' ? 1 : -1, e.shiftKey); }
    // view
    if (ctrl && (e.code === 'Digit0' || e.code === 'Numpad0')) return fitView();
    if (ctrl && (e.code === 'Digit1' || e.code === 'Numpad1')) return zoomAt(3.78 / view.k);   // 100%: real size
    if (ctrl && (e.code === 'Equal' || e.code === 'NumpadAdd')) return zoomAt(1.25);
    if (ctrl && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return zoomAt(0.8);
    if (ctrl && k === 'y') { e.preventDefault(); return $('#showStitch').click(); }
    if (ctrl && k === 'h') return $('#showOrder').click();
    if (e.key === 'Escape') { $('#ctx').hidden = true; if (sim.on) return stopSim(); if (tool !== 'select' && tool !== 'direct') return setTool('select'); sel.clear(); selChanged(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) return api('delete', { ids: [...sel] }, { quiet: true });
    if (e.key.startsWith('Arrow') && sel.size) {
      e.preventDefault(); const st = (parseFloat(store.get('nudge', '0.10')) || 0.1) * (e.shiftKey ? 10 : 1);
      const d = { ArrowUp: [0, st], ArrowDown: [0, -st], ArrowLeft: [-st, 0], ArrowRight: [st, 0] }[e.key];
      return xform('move', { dx: d[0], dy: d[1] });
    }
    if (e.key === ' ' && !spaceDown) { spaceDown = true; cv.className = 'pan'; e.preventDefault(); return; }
    if (ctrl || e.altKey) return;
    if (e.key === 'Enter') { e.preventDefault(); return focusField('mvx'); }
    // tools, with Illustrator's letters
    if (k === 'v') setTool('select'); if (k === 'a') setTool('direct'); if (k === 'h') setTool('pan'); if (k === 'c') setTool('start'); if (k === 'i') setTool('measure');
    if (k === 'm') openSheet('add', { x: view.cx, y: view.cy });
    if (k === 'r') { e.preventDefault(); focusField('ang'); }
    if (k === 'o') xform('mirror', { axis: e.shiftKey ? 'v' : 'h' });
    if (k === 's') openSheet('resize');
    if (/^[1-5]$/.test(k)) setStage(STAGES[+k - 1]);
    if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); stepBy(e.key === 'PageDown' ? 1 : -1); }
  });
  // the simple mode's keys: undo, zoom, pan, Esc, the tools of the rail, delete and nudge
  function simpleKey(e, ctrl, k) {
    if (ctrl && k === 'z') { e.preventDefault(); return api(e.shiftKey ? 'redo' : 'undo', {}, { quiet: true }); }
    if (ctrl && (e.code === 'Digit0' || e.code === 'Numpad0')) return fitView();
    if (ctrl && (e.code === 'Digit1' || e.code === 'Numpad1')) return zoomAt(3.78 / view.k);
    if (ctrl && (e.code === 'Equal' || e.code === 'NumpadAdd')) return zoomAt(1.25);
    if (ctrl && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return zoomAt(0.8);
    if (ctrl && k === 'y') { e.preventDefault(); return $('#showOrig').click(); }
    if (ctrl && k === 'g' && !e.shiftKey) { e.preventDefault(); return ACT.groupSheet(); }
    if (e.key === 'Escape') { $('#ctx').hidden = true; if (sim.on) return stopSim(); sel.clear(); selChanged(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) return api('delete', { ids: [...sel] }, { quiet: true });
    if (e.key.startsWith('Arrow') && sel.size) {
      e.preventDefault(); const st = (parseFloat(store.get('nudge', '0.10')) || 0.1) * (e.shiftKey ? 10 : 1);
      const d = { ArrowUp: [0, st], ArrowDown: [0, -st], ArrowLeft: [-st, 0], ArrowRight: [st, 0] }[e.key];
      return xform('move', { dx: d[0], dy: d[1] });
    }
    if (e.key === ' ' && !spaceDown) { spaceDown = true; cv.className = 'pan'; e.preventDefault(); return; }
    if (ctrl || e.altKey) return;
    const t = { v: 'select', a: 'direct', h: 'pan', c: 'start', i: 'measure' }[k]; if (t) return setTool(t);
    if (k === 'm') openSheet('add', { x: view.cx, y: view.cy });
  }
  document.addEventListener('keyup', e => {
    if (e.key === ' ') { spaceDown = false; cv.className = tool === 'pan' ? 'pan' : ''; }
    if (drag && drag.kind === 'resize' && (e.key === 'Shift' || e.key === 'Alt')) { e.preventDefault(); drag.shift = e.shiftKey; drag.alt = e.altKey; draw(); }
    if (drag && drag.kind === 'box' && e.key === 'Alt') { e.preventDefault(); drag.enclose = false; draw(); }
    if (drag && drag.kind === 'move' && e.key === 'Alt') { e.preventDefault(); drag.copy = false; if (drag.moved) cv.className = 'moving'; draw(); }
  });

  /* ------------------------------------------------------------------ drag & drop files */
  let dragDepth = 0;
  addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dropping'); e.preventDefault(); } });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  addEventListener('drop', e => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
    const f = e.dataTransfer.files[0];
    if (S) guardUnsaved(() => upload(f)); else upload(f);
  });

  /* ------------------------------------------------------------------ home: the start screen */
  // Shown at every start (unless turned off) and with the Home button: new job, open, the job left open, recent files.
  const home = { info: null, previews: new Map(), loading: false, view: store.get('homeView', 'grid'), used: false };
  const homeOpen = () => !$('#home').hidden;
  /* engine calls that answer with something other than the state (home, preview, forget_recent) */
  async function call(op, args = {}) {
    try {
      const r = await fetch('/api/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const d = await r.json();
      if (!r.ok) { toast(d.error || 'Something went wrong.', true); return null; }
      return d;
    } catch { return null; }
  }
  function showHome() {
    $('#ctx').hidden = true; $('#paletteScrim').hidden = true;
    if (sim.on) stopSim();
    $('#home').hidden = false;
    renderHome(); refreshHome();
  }
  function hideHome() { if (!homeOpen()) return; $('#home').hidden = true; home.used = true; resize(); draw(); }
  async function refreshHome() { const d = await call('home'); if (d) { home.info = d; renderHome(); loadPreviews(); } }

  /* a drawing as a small SVG, y up like the canvas; each path is a flat [x, y, x, y, ...] list */
  function drawingSvg(paths, closed, box) {
    if (!paths.length || !box) return '';
    const [x0, y0, x1, y1] = box, w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6), pad = Math.max(w, h) * 0.02;
    const el = paths.map((p, i) => {
      if (p.length === 2) return `<circle cx="${(p[0] - x0).toFixed(2)}" cy="${(y1 - p[1]).toFixed(2)}" r="${(Math.max(w, h) * 0.008).toFixed(3)}"/>`;
      let pts = '';
      for (let j = 0; j < p.length; j += 2) pts += `${(p[j] - x0).toFixed(2)},${(y1 - p[j + 1]).toFixed(2)} `;
      return `<${closed[i] ? 'polygon' : 'polyline'} points="${pts}"/>`;
    }).join('');
    return `<svg class="drawing" viewBox="${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${el}</svg>`;
  }
  /* the open job's shapes in the same form (thinned out for large jobs) */
  function jobSvg() {
    const shapes = S.job.shapes, total = shapes.reduce((n, s) => n + s.pts.length, 0), step = Math.max(1, Math.ceil(total / 4000));
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const paths = shapes.map(s => {
      const out = [];
      s.pts.forEach(([x, y], i) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); if (i % step === 0 || i === s.pts.length - 1) out.push(x, y); });
      return out;
    });
    return drawingSvg(paths, shapes.map(s => s.closed), shapes.length ? b : null);
  }
  const FILE_ICON = '<svg class="ftype" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  const extOf = p => (p.match(/\.([^.\\/]+)$/)?.[1] || '').toUpperCase();
  const locale = () => window.STL_LANG === 'ar' ? 'ar-u-nu-latn' : 'en';
  function when(secs) {
    if (secs == null) return '';
    const d = (Date.now() / 1000 - secs), rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    if (d < 60) return rtf.format(0, 'second');
    if (d < 3600) return rtf.format(-Math.floor(d / 60), 'minute');
    if (d < 86400) return rtf.format(-Math.floor(d / 3600), 'hour');
    if (d < 7 * 86400) return rtf.format(-Math.floor(d / 86400), 'day');
    return new Date(secs * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const previewKey = r => r.path + '|' + r.modified;
  const thumbHtml = r => { const p = home.previews.get(previewKey(r)); return p === undefined ? '<span class="loading"></span>' : (p && drawingSvg(p.paths, p.closed, p.box)) || FILE_ICON; };

  /* machine table sizes for a new job: this job's, the ones used before, and the standard one */
  function tableSizes() {
    const seen = new Set(), out = [];
    for (const [w, h] of [[+J().table_w, +J().table_h], ...store.get('tableSizes', []), [1000, 800]]) {
      const k = w + 'x' + h; if (!(w > 0 && h > 0) || seen.has(k)) continue; seen.add(k); out.push([w, h]);
    }
    return out.slice(0, 4);
  }
  const rememberSize = (w, h) => store.set('tableSizes', [[w, h], ...store.get('tableSizes', []).filter(([a, b]) => a !== w || b !== h)].slice(0, 4));
  const sizeTxt = (w, h) => `<span data-notr dir="ltr" class="num">${+(+w).toFixed(1)} × ${+(+h).toFixed(1)}</span> <span>mm</span>`;

  function renderHome() {
    if (!S || !homeOpen()) return;
    $('#homeOnStart').setAttribute('aria-checked', store.get('homeOnStart', true));
    const has = S.job.shapes.length > 0;
    $('#homeBack').hidden = !(has || home.used);
    // the job left open: autosaved, so it comes back even when it was never saved
    const c = $('#homeContinue'); c.hidden = !has;
    if (has) {
      const nl = S.job.layers.length;
      c.innerHTML = `<h2>Continue</h2><button class="home-cont" data-home="editor">
        <div class="thumb">${jobSvg() || FILE_ICON}</div>
        <div class="t"><span class="eyebrow">Pick up where you left off</span><b>${esc(S.file.name)}</b>
          <span class="meta"><span>${S.job.shapes.length} ${S.job.shapes.length === 1 ? 'shape' : 'shapes'}</span>·<span>${nl} ${nl === 1 ? 'layer' : 'layers'}</span>${S.file.dirty ? '·<span class="unsaved">Unsaved changes</span>' : S.file.path ? '·<span>Saved</span>' : ''}</span></div>
        <span class="btn primary">Continue</span></button>`;
    }
    $('#homeQuick').innerHTML = tableSizes().map(([w, h], i) => {
      const k = Math.min(132 / w, 66 / h);
      return `<button class="qcard" data-size="${w}x${h}" title="New job with this machine table">
        <div class="pv"><div class="sheetbox" style="width:${Math.max(8, w * k).toFixed(0)}px;height:${Math.max(8, h * k).toFixed(0)}px"></div></div>
        <div class="tx"><b>${sizeTxt(w, h)}</b><small>${i === 0 ? 'Machine table' : 'Used before'}</small></div></button>`;
    }).join('') + `<button class="qcard" data-home="new" title="New job (Ctrl+N)">
        <div class="pv dashed"><svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg></div>
        <div class="tx"><b>Custom size…</b><small>Name and table size</small></div></button>
      <button class="qcard" data-home="open" title="Open (Ctrl+O)">
        <div class="pv"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>
        <div class="tx"><b>Open a drawing</b><small data-notr>DXF · AI · PLT · DST · DSB · SLW</small></div></button>`;
    $$('#homeView button').forEach(b => b.setAttribute('aria-pressed', b.dataset.k === home.view));
    renderRecent();
  }
  function renderRecent() {
    const box = $('#homeRecent'); box.className = 'home-recent ' + home.view;
    const n = home.info?.recent.length || 0, cnt = $('#homeCount');
    cnt.hidden = !n; cnt.textContent = n;
    if (!home.info) { box.innerHTML = ''; return; }
    const q = $('#homeFilter').value.trim().toLowerCase();
    const list = home.info.recent.filter(r => !q || r.name.toLowerCase().includes(q));
    if (!home.info.recent.length) { box.className = 'home-recent'; box.innerHTML = `<div class="home-empty">${FILE_ICON.replace('ftype', 'i')}<span>No recent files yet. Drawings and jobs you open or save show up here.</span></div>`; return; }
    if (!list.length) { box.className = 'home-recent'; box.innerHTML = '<div class="home-empty"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>No recent file matches this filter.</span></div>'; return; }
    box.innerHTML = list.map(r => {
      const ext = extOf(r.name), cls = ext === 'STITCHLINE' ? 'job' : ext === 'SLW' ? 'slw' : '';
      return `<div class="rcard" role="button" tabindex="0" data-open="${esc(r.path)}" title="${esc(r.path)}">
        <div class="thumb" data-thumb="${esc(previewKey(r))}">${thumbHtml(r)}</div>
        <div class="t"><span class="nm" data-notr>${esc(r.name)}</span><span class="meta"><span class="badge ${cls}" data-notr>${esc(ext === 'STITCHLINE' ? 'JOB' : ext)}</span><span class="when" data-notr>${esc(when(r.modified))}</span></span></div>
        <span class="folder" data-notr>${esc(r.folder)}</span>
        <button class="x" data-forget="${esc(r.path)}" title="Remove from recent" aria-label="Remove from recent"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
    }).join('');
  }
  /* thumbnails, one file at a time (the engine reads each drawing; large files get the file icon) */
  async function loadPreviews() {
    if (home.loading) return;
    home.loading = true;
    try {
      for (const r of home.info?.recent || []) {
        const key = previewKey(r);
        if (home.previews.has(key)) continue;
        const d = await call('preview', { path: r.path });
        home.previews.set(key, d && d.paths ? d : null);
        const el = $$('#homeRecent [data-thumb]').find(t => t.dataset.thumb === key);
        if (el) el.innerHTML = thumbHtml(r);
      }
    } finally { home.loading = false; }
  }
  function openFromHome(path) {
    guardUnsaved(() => api('open', { path }).then(d => { if (d) opened(); else if (homeOpen()) refreshHome(); }));
  }
  // a project double-clicked in Explorer: the file Stitchline started with, or one a second start hands to this window
  function openLaunched(path) {
    if (path) guardUnsaved(() => api('open', { path }).then(d => { if (d) opened(); }));
  }
  window.__stitchlineOpen = openLaunched;
  const HOME_ACT = {
    new: () => openSheet('newjob'),
    open: () => ACT.open(),
    editor: () => hideHome(),
    keys: () => openSheet('keys'),
    lang: () => setLang(window.STL_LANG === 'ar' ? 'en' : 'ar'),
    theme: () => toggleTheme(),
    settings: () => openSettings(),
    update: () => askUpdate(),
  };
  $('#home').addEventListener('click', async e => {
    if (!S) return;
    const t = e.target;
    const f = t.closest('[data-forget]');
    if (f) {
      e.stopPropagation();
      const d = await call('forget_recent', { path: f.dataset.forget });
      if (d) { home.info = d; S.recent = S.recent.filter(p => p !== f.dataset.forget); renderRecent(); }
      return;
    }
    const o = t.closest('[data-open]'); if (o) return openFromHome(o.dataset.open);
    const sz = t.closest('[data-size]'); if (sz) { const [w, h] = sz.dataset.size.split('x').map(Number); return openSheet('newjob', { w, h }); }
    const a = t.closest('[data-home]'); if (a) return HOME_ACT[a.dataset.home]?.();
    const vb = t.closest('#homeView button'); if (vb) { home.view = vb.dataset.k; store.set('homeView', home.view); renderHome(); return; }
    if (t.closest('.home-check')) { const on = !store.get('homeOnStart', true); store.set('homeOnStart', on); $('#homeOnStart').setAttribute('aria-checked', on); }
  });
  $('#home').addEventListener('keydown', e => {
    const o = e.target.closest?.('[data-open]');
    if (o && e.target === o && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFromHome(o.dataset.open); }
  });
  $('#homeFilter').addEventListener('input', renderRecent);
  $('#btnHome').onclick = showHome;

  /* ------------------------------------------------------------------ updates */
  /* Stitchline looks for a new version (the latest GitHub release) at start-up and every few hours; when there is one,
     the Update button shows in the top bar and on Home. Settings › General › Check for updates looks at once. The
     installer is downloaded and checked by the app, then it closes Stitchline and opens the new version. */
  const tauri = (cmd, args) => window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke(cmd, args) : Promise.reject(new Error('not in the app'));
  let upd = null, updating = false;
  const updTxt = (t, err = false) => { const e = $('#updTxt'); e.textContent = t; e.style.color = err ? 'var(--bad)' : ''; };
  tauri('plugin:app|version').then(v => { $('#updVer').textContent = `Version ${v}`; }).catch(() => {});
  function showUpdate(u) {
    upd = u;
    $$('.tb-update').forEach(b => { b.hidden = !u; if (u) { b.title = `Update to ${u.version}`; b.setAttribute('aria-label', b.title); } });
  }
  async function checkUpdates(manual) {
    if (updating) return;
    const b = $('#updCheck');
    if (manual) { b.disabled = true; updTxt('Checking for updates…'); }
    try {
      const r = await tauri('update_check');
      showUpdate(r.version ? r : null);
      if (manual) {
        updTxt(r.version ? `Version ${r.version} is ready to install.` : 'Stitchline is up to date.');
        if (r.version) askUpdate();
      }
    } catch {
      if (manual) updTxt("Couldn't check for updates. Check the internet connection and try again.", true);
    } finally { b.disabled = false; }
  }
  function askUpdate() {
    if (!upd || updating) return;
    closeSettings();
    const notes = upd.notes ? `<br><br><span data-notr style="white-space:pre-line">${esc(upd.notes)}</span>` : '';
    confirmSheet(`Update Stitchline to ${esc(upd.version)}?`, `Stitchline downloads the new version, closes and opens again. Your job is kept.${notes}`, 'Update now',
      () => { installUpdate(); });
  }
  async function installUpdate() {
    updating = true;
    const msg = (got, total) => total ? `Downloading the update… ${Math.min(100, Math.round(got / total * 100))}%` : 'Downloading the update…';
    $('#busyTxt').textContent = msg(0, 0); $('#busy').hidden = false;
    const tick = setInterval(() => tauri('update_progress').then(([got, total]) => { $('#busyTxt').textContent = msg(got, total); }).catch(() => {}), 250);
    try {
      await tauri('update_install');                       // returns only if it failed: the installer closes the app
    } catch {
      toast("The update couldn't be installed. Try again later.", true);
    } finally { clearInterval(tick); $('#busy').hidden = true; updating = false; }
  }
  $('#updCheck').addEventListener('click', () => checkUpdates(true));
  $('#btnUpdate').addEventListener('click', askUpdate);
  if (window.__TAURI_INTERNALS__) { setTimeout(() => checkUpdates(false), 5000); setInterval(() => checkUpdates(false), 6 * 3600e3); }

  /* ------------------------------------------------------------------ toast */
  let tt;
  function toast(msg, err = false) {
    const t = $('#toast');
    t.className = 'toast' + (err ? ' err' : '');
    t.innerHTML = (err ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' : '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>') + `<span>${esc(msg)}</span>`;
    t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, err ? 4200 : 2400);
  }

  /* ------------------------------------------------------------------ boot */
  addEventListener('resize', () => { resize(); if (autoFit) fitView(); simPaint(); });
  function setInspector(open) {
    document.documentElement.classList.toggle('insp-off', !open); store.set('inspOff', !open);
    const b = $('#inspToggle'), t = `${open ? 'Hide' : 'Show'} the panel (Shift+Tab)`;
    b.setAttribute('aria-expanded', open); b.title = t; b.setAttribute('aria-label', t);
    if (autoFit) fitView(); else draw();
  }
  const toggleInspector = () => setInspector(document.documentElement.classList.contains('insp-off'));
  $('#inspToggle').addEventListener('click', toggleInspector);
  setInspector(!store.get('inspOff', false));
  setInterval(() => fetch('/api/ping', { method: 'POST', body: '{}' }).catch(() => {}), 5000);
  resize();
  setTool('select');
  { let back = null; try { back = sessionStorage.getItem('stl.langReload'); sessionStorage.removeItem('stl.langReload'); } catch {}
    if (back ? back === 'home' : store.get('homeOnStart', true)) $('#home').hidden = false; }
  api('state', {}, { quiet: true }).then(d => {
    if (!d) return;
    if (!d.job.shapes.length && stage !== 'import') setStage('import');
    fitView(); if (homeOpen()) showHome();
    let sp = null; try { sp = sessionStorage.getItem('stl.setReload'); sessionStorage.removeItem('stl.setReload'); } catch {}
    if (sp) openSettings(sp);
    tauri('launch_file').then(openLaunched, () => {});
  });
})();
