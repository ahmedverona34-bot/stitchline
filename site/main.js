/* Stitchline site: language switch, nav, and the four small animations (yarn, simulation, laser card,
   sewing order). Everything is readable without this script; it only adds motion and the English text. */
(function () {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SPEED = 1.1; // animation speed for the whole page (CSS has the same number in --spd)
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---- language */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } },
  };
  let lang = "ar";
  function setLang(next) {
    lang = next;
    const html = document.documentElement;
    html.lang = next;
    html.dir = next === "ar" ? "rtl" : "ltr";
    $$("[data-en]").forEach((el) => {
      if (el.dataset.ar === undefined) el.dataset.ar = el.innerHTML;
      el.innerHTML = next === "en" ? el.dataset.en : el.dataset.ar;
    });
    $("#lang").textContent = next === "en" ? "ع" : "EN";
    $("#lang").setAttribute("aria-label", next === "en" ? "التحويل للعربي" : "Switch to English");
    store.set("stl.site.lang", next);
    if (order) order.draw(false);
  }
  $("#lang").addEventListener("click", () => setLang(lang === "ar" ? "en" : "ar"));

  /* ---- nav: dropdowns (click for touch, hover for mouse) and the phone menu */
  $$(".dd").forEach((dd) => {
    const b = $(".dd-btn", dd);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !dd.classList.contains("open");
      $$(".dd.open").forEach((o) => { o.classList.remove("open"); $(".dd-btn", o).setAttribute("aria-expanded", "false"); });
      dd.classList.toggle("open", open);
      b.setAttribute("aria-expanded", String(open));
    });
  });
  document.addEventListener("click", () => $$(".dd.open").forEach((o) => o.classList.remove("open")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".dd.open").forEach((o) => o.classList.remove("open")); });
  const burger = $("#burger"), mnav = $("#mnav");
  burger.addEventListener("click", () => {
    const open = !mnav.classList.contains("open");
    mnav.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
  });
  $$("#mnav a").forEach((a) => a.addEventListener("click", () => { mnav.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); }));

  /* ---- helpers */
  function fitCanvas(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    return { w: r.width, h: r.height, dpr };
  }
  function whenVisible(el, on, off) {
    if (!("IntersectionObserver" in window)) { on(); return; }
    new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? on() : off && off())), { rootMargin: "80px" }).observe(el);
  }
  function onWidthChange(fn) { // phones fire resize when the address bar slides; only a new width matters here
    let w = innerWidth, t = 0;
    addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (innerWidth !== w) { w = innerWidth; fn(); } }, 120); });
  }
  function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

  /* ---- hero: a thread twisted from fibres you can explore. Drag the thread to turn it; grab one fibre and
     pull it out like an elastic. Letting go: a soft flash and two thin rings open where it was released,
     and one clean pulse runs both ways along the thread with light riding its front while the fibres it
     passes open up and twist shut again. A click plucks a smaller pulse. Hovering lights and names a fibre; the page scroll untwists the thread.
     Drawing is batched: points are sorted into a few colour/alpha buckets and each bucket is filled with one
     style, and the frame cost is watched so slower machines drop to fewer points instead of stuttering.
     Left alone the thread only drifts, so it is drawn at about 30 frames a second; any touch, pulse or pull
     brings it back to every frame. */
  (function yarn() {
    const c = $("#yarn"); if (!c) return;
    const ctx = c.getContext("2d", { alpha: true });
    const tip = $("#yarnTip");
    const R = rng(7);
    const FIB = 60, SEG = 220, N = SEG + 1;
    const fibres = [];
    for (let i = 0; i < FIB; i++) {
      const kind = i % 12 === 0 ? "pink" : i === 29 ? "blue" : "white";
      const r = Math.sqrt(R());
      fibres.push({ r, a0: R() * Math.PI * 2, kind, fly: R() * 0.07, n: i + 1, lag: Math.round(r * 4) });
    }
    const names = {
      pink: { ar: "خيط الغرزة", en: "Stitch thread" },
      blue: { ar: "خيط المكوك", en: "Bobbin thread" },
      white: { ar: "شعيرة قطن", en: "Cotton fibre" },
    };
    const pulledWord = { ar: "اتشدّت", en: "pulled" }, mmWord = { ar: "مم", en: "mm" };
    const dust = Array.from({ length: 70 }, () => ({ u: R(), off: (R() - 0.5) * 0.9, sp: 0.00003 + R() * 0.00008, s: R() }));
    const waves = [], bursts = [];
    let clock = 0, lastNow = null; // the thread's own clock, at page speed
    let size, running = false;
    // camera. HOME is the pose the page opens on (the curl seen from above); when left alone the thread
    // sways gently around it, and a few seconds after a drag it drifts back there
    const HOME_RY = -0.475, HOME_RX = -0.9;
    let ry = HOME_RY, rx = HOME_RX, vy = 0, vx = 0, lastTouch = -1e9;
    const P = { x: -1e4, y: -1e4, ex: -1e4, ey: -1e4, on: 0, str: 0, down: false, lx: 0, ly: 0, moved: 0, hit: null, pending: false };
    let grab = null, spring = null;
    let tipOff = 0;
    const MAXPULL = 230;
    // per-frame tables along the thread (they depend on u only, not on the fibre)
    const cX = new Float32Array(N), cY = new Float32Array(N), cZ = new Float32Array(N), nX = new Float32Array(N), nZ = new Float32Array(N);
    const taper = new Float32Array(N), flyT = new Float32Array(N), edgeT = new Float32Array(N);
    for (let i = 0; i < N; i++) { const u = i / SEG; taper[i] = 0.35 + 0.65 * Math.sin(u * Math.PI); flyT[i] = Math.pow(Math.abs(u - 0.5) * 2, 6); edgeT[i] = Math.min(1, Math.min(u, 1 - u) * 9); }
    const wdx = new Float32Array(N), wdy = new Float32Array(N), wen = new Float32Array(N);
    // buckets: [style][alpha level] -> flat x,y,size list
    const LV = 12;
    const STY = {
      white: (a) => `rgba(222,228,242,${a})`, warm: (a) => `rgba(255,170,200,${a})`, litB: (a) => `rgba(150,190,255,${a})`,
      pink: (a) => `rgba(255,92,141,${a})`, blue: (a) => `rgba(110,160,255,${a})`, dust: (a) => `rgba(255,255,255,${a})`,
    };
    const styles = {}, pts = {};
    for (const k in STY) { styles[k] = []; pts[k] = []; for (let l = 0; l < LV; l++) { styles[k].push(STY[k](((l + 1) / LV).toFixed(3))); pts[k].push([]); } }
    const lines = { pink: [], blue: [] }; for (const k in lines) for (let l = 0; l < LV; l++) lines[k].push([]);
    const lvl = (a) => Math.max(0, Math.min(LV - 1, Math.round(a * LV) - 1));
    // quality: 1 draws every point; 2 draws every other white point and uses a lower resolution
    let quality = (navigator.hardwareConcurrency || 8) <= 4 ? 2 : 1, cost = 0, frames = 0, lag = 0;
    let tipX = 0, tipY = 0; // the canvas's offset inside .hero-art, read once per size instead of every frame
    const scrollTwist = () => Math.min(1, Math.max(0, scrollY / Math.max(1, innerHeight * 0.9)));
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, quality === 1 ? 1.5 : 1);
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
      size = { w: r.width, h: r.height, dpr };
      tipX = c.offsetLeft; tipY = c.offsetTop;
    }
    onWidthChange(resize);
    function local(e) { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    function elastic(dx, dy) { // past a point the fibre resists, like stretching an elastic
      const d = Math.hypot(dx, dy) || 1, k = (MAXPULL * (1 - Math.exp(-d / MAXPULL))) / d;
      return [dx * k, dy * k];
    }
    c.addEventListener("pointerenter", () => { P.on = 1; });
    c.addEventListener("pointerleave", () => { if (!grab) { P.on = 0; tip && tip.classList.remove("on"); } });
    c.addEventListener("pointermove", (e) => {
      [P.x, P.y] = local(e); P.on = 1;
      if (!P.down) { c.style.cursor = P.hit ? "grab" : ""; return; }
      const dx = e.clientX - P.lx, dy = e.clientY - P.ly;
      P.lx = e.clientX; P.ly = e.clientY; P.moved += Math.abs(dx) + Math.abs(dy);
      if (!grab) { vy = dx * 0.0065; vx = dy * 0.004; ry += vy; rx = Math.max(-0.9, Math.min(1.3, rx + vx)); }
    });
    c.addEventListener("pointerdown", (e) => {
      [P.x, P.y] = local(e); P.ex = P.x; P.ey = P.y;
      P.down = true; P.moved = 0; P.lx = e.clientX; P.ly = e.clientY; lastTouch = clock;
      P.pending = true; // the next frame picks the fibre under the press (touch has no hover)
      grab = null; spring = null;
      c.style.cursor = "grabbing";
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
    });
    function release() {
      if (!P.down) return;
      lastTouch = clock;
      P.down = false; c.style.cursor = "";
      if (grab) {
        const len = grab.pull ? Math.hypot(grab.pull[0], grab.pull[1]) : 0;
        if (len > 8) {
          const dir = [grab.pull[0] / len, grab.pull[1] / len], power = Math.min(1, len / MAXPULL);
          spring = { f: grab.f, u: grab.u, s: grab.s, d: grab.pull, t: clock };
          waves.push({ u: grab.u, t: clock, amp: 18 + 62 * power, dir });
          bursts.push({ x: P.ex, y: P.ey, t: clock, power });
          vy -= dir[0] * 0.0025 * power; // a small recoil of the camera
        } else pluck();
        grab = null;
      } else if (P.moved < 6 && P.hit) pluck();
      P.pending = false;
    }
    function pluck() {
      if (!P.hit) return;
      const a = R() * Math.PI * 2;
      waves.push({ u: P.hit.u, t: clock, amp: 22, dir: [Math.cos(a), Math.sin(a)] });
      bursts.push({ x: P.x, y: P.y, t: clock, power: 0.35 });
    }
    c.addEventListener("pointerup", (e) => { release(); if (e.pointerType !== "mouse") { P.on = 0; tip && tip.classList.remove("on"); } });
    c.addEventListener("pointercancel", () => { release(); P.on = 0; });

    function glowDot(x, y, r, inner, a) { // a soft round light; gradients are made only for these few
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${inner},${a.toFixed(3)})`); g.addColorStop(1, `rgba(${inner},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    const busy = () => P.on || P.down || grab || spring || waves.length || bursts.length || P.str > 0.02 || Math.abs(vy) > 1e-4;
    function frame(now) {
      if (!running) return;
      const fast = busy();
      if (!fast && lastNow !== null && now - lastNow < 30) { requestAnimationFrame(frame); return; } // idle: every other frame
      const work0 = performance.now();
      const rawDt = lastNow === null ? 16 : now - lastNow;
      const realDt = Math.min(50, rawDt); lastNow = now;
      clock += realDt * SPEED;
      const t = clock, step = (realDt / 16.7) * SPEED;
      const { w, h, dpr } = size;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!P.down) {
        ry += vy; vy *= 0.94; vx *= 0.9;
        const idle = t - lastTouch;
        if (idle > 2500) { // ease back toward home, then breathe around it (a slow sway, never a full turn)
          const k = Math.min(1, (idle - 2500) / 3000) * 0.02 * step * (1 - Math.min(1, Math.abs(vy) * 40));
          const target = HOME_RY + Math.sin(t * 0.00022) * 0.22;
          const d = ((target - ry + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // the short way round
          ry += d * k; rx += (HOME_RX - rx) * k;
        }
      }
      const tw = scrollTwist();
      P.ex += (P.x - P.ex) * 0.2; P.ey += (P.y - P.ey) * 0.2;
      P.str += ((P.on && !P.down ? 1 : 0) - P.str) * 0.08;
      const cyR = Math.cos(ry + tw * 1.2), syR = Math.sin(ry + tw * 1.2), cxR = Math.cos(rx), sxR = Math.sin(rx);
      const S = Math.min(w, h) * 0.47, ox = w / 2, oy = h / 2;
      const ivw = 4 / (w * w), ivh = 4 / (h * h); // for the soft round fade toward the canvas edge
      // the thread's centre line, once per frame
      const turns = Math.PI * (2.3 - tw * 0.5);
      for (let i = 0; i < N; i++) {
        const u = i / SEG, a = u * turns - 0.7;
        cX[i] = 0.62 * Math.sin(a) * (0.75 + 0.25 * Math.cos(u * 3)); cY[i] = (u - 0.5) * 1.62; cZ[i] = 0.5 * Math.cos(a);
        nX[i] = Math.sin(a); nZ[i] = Math.cos(a);
      }
      // the pulse (only computed while one is running)
      for (let i = waves.length - 1; i >= 0; i--) if (t - waves[i].t > 4200) waves.splice(i, 1);
      const waving = waves.length > 0, fronts = [];
      if (waving) {
        wdx.fill(0); wdy.fill(0); wen.fill(0);
        for (const v of waves) {
          const age = (t - v.t) / 1000, env = Math.exp(-age * 1.05) * (1 - Math.exp(-age * 14)), wd = 0.045 + age * 0.022;
          const f1 = v.u + age * 0.36, f2 = v.u - age * 0.36;
          fronts.push({ u: f1, env, amp: v.amp }, { u: f2, env, amp: v.amp });
          const lo = Math.max(0, Math.floor((Math.min(f2, f1) - wd * 4) * SEG)), hi = Math.min(SEG, Math.ceil((Math.max(f1, f2) + wd * 4) * SEG));
          for (let i = lo; i <= hi; i++) {
            const u = i / SEG, d1 = (u - f1) / wd, d2 = (u - f2) / wd;
            const g1 = Math.exp(-d1 * d1 / 2), g2 = Math.exp(-d2 * d2 / 2);
            const a = v.amp * env * ((1 - d1 * d1) * g1 + (1 - d2 * d2) * g2) * edgeT[i];
            wdx[i] += v.dir[0] * a; wdy[i] += v.dir[1] * a; wen[i] = Math.min(1, wen[i] + (g1 + g2) * env * edgeT[i]);
          }
        }
      }
      // the pull
      let pull = null, pf = null, pu = 0, ps = 0.04;
      if (grab) { pf = grab.f; pu = grab.u; }
      else if (spring) { // let go: it flies back past its place, then settles
        const age = (t - spring.t) / 1000, damp = Math.exp(-age * 3.6) * Math.cos(age * 10.5);
        if (age > 2.2) spring = null;
        else { pf = spring.f; pu = spring.u; ps = spring.s; pull = [spring.d[0] * damp, spring.d[1] * damp]; }
      }
      const tPh = t * 0.00035, twist = 15 - tw * 7;
      const project = (f, i, e, out) => { // fibre f at table index i, opened up by pulse energy e
        const rad = (0.13 * taper[i] * f.r + f.fly * flyT[i]) * (1 + e * 1.15) + tw * 0.03 * f.r;
        const phi = f.a0 + (i / SEG) * twist + tPh + e * 0.9, cp = Math.cos(phi);
        const x = cX[i] + nX[i] * rad * cp, y = cY[i] + rad * Math.sin(phi), z = cZ[i] + nZ[i] * rad * cp;
        const x1 = x * cyR + z * syR, z1 = -x * syR + z * cyR, y1 = y * cxR - z1 * sxR, z2 = y * sxR + z1 * cxR;
        const k = 2.6 / (2.6 + z2);
        out[0] = ox + x1 * S * k; out[1] = oy + y1 * S * k; out[2] = z2; out[3] = k;
      };
      const pt = [0, 0, 0, 0];
      if (grab) {
        project(grab.f, Math.round(pu * SEG), 0, pt);
        pull = elastic(P.ex - pt[0], P.ey - pt[1]);
        ps = 0.025 + Math.min(Math.hypot(pull[0], pull[1]) / 1400, 0.13);
        grab.pull = pull; grab.s = ps;
      }
      const SOFT2 = 70 * 70, nudge = 10 * P.str, near = P.str > 0.02;
      let best = null, bestD = P.pending ? 40 * 40 : 22 * 22;
      const keepF = !P.down && P.hit ? P.hit.f : null; let keepD = 36 * 36, kept = null; // the lit fibre stays lit while it is close
      const findHit = (!P.down || P.pending) && P.on;
      const hl = !P.down && P.hit && P.str > 0.3 ? P.hit.f : null;
      let needle = null;
      const needleI = Math.floor(((t * 0.00006) % 1) * SEG);
      for (const k in pts) for (const b of pts[k]) b.length = 0;
      for (const k in lines) for (const b of lines[k]) b.length = 0;
      for (const f of fibres) {
        const isPulled = f === pf, lit = f === hl || isPulled;
        const white = f.kind === "white" && !lit, give = 1 - f.r * 0.3;
        const inc = white && quality === 2 ? 2 : 1;
        let px = 0, py = 0, has = false;
        for (let i = 0; i < N; i += inc) {
          const j = i - f.lag < 0 ? 0 : i - f.lag;
          const e = waving ? wen[j] : 0;
          project(f, i, e, pt);
          let X = pt[0], Y = pt[1];
          if (waving) { X += wdx[j] * give; Y += wdy[j] * give; }
          let glow = e * 0.9;
          const dx = X - P.ex, dy = Y - P.ey, d2 = dx * dx + dy * dy;
          if (findHit && d2 < bestD && i > 13 && i < SEG - 13) { bestD = d2; best = { f, u: i / SEG }; }
          if (f === keepF && d2 < keepD && i > 13 && i < SEG - 13) { keepD = d2; kept = { f, u: i / SEG }; }
          if (near && d2 < SOFT2 && !isPulled) {
            const g = Math.exp(-d2 / (SOFT2 * 0.35)), d = Math.sqrt(d2) || 1;
            X += (dx / d) * g * nudge; Y += (dy / d) * g * nudge; if (g * P.str > glow) glow = g * P.str;
          }
          if (pull) {
            const du = i / SEG - pu, bell = Math.exp(-(du * du) / (2 * ps * ps));
            const m = isPulled ? bell : bell * 0.07 * (1 - f.r * 0.5);
            X += pull[0] * m; Y += pull[1] * m;
            if (isPulled && bell > glow) glow = bell;
          }
          const ex = X - ox, ey = Y - oy, rr = ex * ex * ivw + ey * ey * ivh; // soft round fade at the edge
          const vig = rr < 0.62 ? 1 : rr > 1 ? 0 : (1 - rr) / 0.38;
          const depth = Math.max(0.12, Math.min(1, 0.75 - pt[2] * 0.55));
          const al = Math.min(1, depth * edgeT[i] * vig * (1 + glow * 1.3));
          if (lit) {
            if (i % 2 === 0 || isPulled) pts[f.kind === "blue" ? "litB" : "warm"][lvl(0.35 + al * 0.6)].push(X, Y, 1.3 + glow * (isPulled ? 1.6 : 1.2));
          } else if (white) {
            if (al > 0.04) pts[e > 0.12 ? "warm" : "white"][lvl(al * (0.5 + e * 0.3))].push(X, Y, (0.7 + pt[3] * 0.75 * depth) * (1 + e * 0.9));
          } else if (has && i % 3 !== 0 && al > 0.04) {
            lines[f.kind][lvl(f.kind === "blue" ? al * 0.9 : al)].push(px, py, X, Y);
          }
          px = X; py = Y; has = true;
          if (f === fibres[0] && i === needleI) needle = [X, Y, al];
        }
      }
      if (!P.down) P.hit = kept || best;
      if (P.pending) { // grab the fibre under the press, or the one whose name was showing when it was pressed
        P.pending = false;
        const g = best || P.hit;
        if (g) { grab = { f: g.f, u: g.u }; P.hit = g; }
      }
      // dust drifting round the thread
      for (const d of dust) {
        const u = (d.u + t * d.sp) % 1, i = Math.round(u * SEG);
        const x = cX[i] + d.off * 0.5, y = cY[i] + d.off * 0.25, z = cZ[i] + d.off * 0.4;
        const x1 = x * cyR + z * syR, z1 = -x * syR + z * cyR, y1 = y * cxR - z1 * sxR, z2 = y * sxR + z1 * cxR, k = 2.6 / (2.6 + z2);
        let X = ox + x1 * S * k, Y = oy + y1 * S * k;
        if (P.str > 0.05) { X += (P.ex - X) * 0.04 * P.str; Y += (P.ey - Y) * 0.04 * P.str; }
        const al = Math.max(0, 0.5 - z2 * 0.3) * (0.3 + 0.7 * Math.abs(Math.sin(t * 0.001 + d.s * 9))) * Math.min(1, Math.min(u, 1 - u) * 6) * 0.6;
        if (al > 0.03) pts.dust[lvl(al)].push(X, Y, 1.3);
      }
      // flush the buckets: one style per bucket, additive light
      ctx.globalCompositeOperation = "lighter";
      for (const k in pts) {
        const bs = pts[k];
        for (let l = 0; l < LV; l++) {
          const b = bs[l]; if (!b.length) continue;
          ctx.fillStyle = styles[k][l];
          for (let q = 0; q < b.length; q += 3) { const s = b[q + 2]; ctx.fillRect(b[q] - s * 0.5, b[q + 1] - s * 0.5, s, s); }
        }
      }
      ctx.lineWidth = 1.5;
      for (const k in lines) {
        const bs = lines[k];
        for (let l = 0; l < LV; l++) {
          const b = bs[l]; if (!b.length) continue;
          ctx.strokeStyle = styles[k][l];
          ctx.beginPath();
          for (let q = 0; q < b.length; q += 4) { ctx.moveTo(b[q], b[q + 1]); ctx.lineTo(b[q + 2], b[q + 3]); }
          ctx.stroke();
        }
      }
      // light riding each front of the pulse
      for (const fr of fronts) {
        if (fr.env < 0.02 || fr.u < 0.03 || fr.u > 0.97) continue;
        const i = Math.round(fr.u * SEG);
        const x1 = cX[i] * cyR + cZ[i] * syR, z1 = -cX[i] * syR + cZ[i] * cyR, y1 = cY[i] * cxR - z1 * sxR, z2 = cY[i] * sxR + z1 * cxR, k = 2.6 / (2.6 + z2);
        glowDot(ox + x1 * S * k + wdx[i], oy + y1 * S * k + wdy[i], 34 + fr.amp * 0.5 * fr.env, "255,150,190", Math.min(0.42, fr.env * (0.18 + fr.amp / 260)));
      }
      // the release: a soft flash and two thin rings opening out
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i], age = (t - b.t) / 1000;
        if (age > 1.8) { bursts.splice(i, 1); continue; }
        const fl = Math.exp(-age * 6) * (0.25 + 0.35 * b.power);
        if (fl > 0.01) glowDot(b.x, b.y, 90, "255,200,220", fl);
        for (const [delay, strength] of [[0, 1], [0.16, 0.55]]) {
          const q = (age - delay) / 1.5; if (q <= 0 || q >= 1) continue;
          ctx.strokeStyle = `rgba(255,214,228,${(0.5 * strength * (1 - q) * (1 - q) * (0.5 + b.power * 0.5)).toFixed(3)})`;
          ctx.lineWidth = 1.2 * (1 - q) + 0.3;
          ctx.beginPath(); ctx.arc(b.x, b.y, 6 + (1 - Math.pow(1 - q, 3)) * (110 + 150 * b.power), 0, 7); ctx.stroke();
        }
      }
      if (grab && pull) { // the fingertip on the pulled fibre
        glowDot(P.ex, P.ey, 16, "255,150,185", 0.55);
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(P.ex, P.ey, 2.2, 0, 7); ctx.fill();
      }
      if (needle && needle[2] > 0.05) {
        glowDot(needle[0], needle[1], 18, "255,140,175", 0.8 * needle[2]);
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(needle[0], needle[1], 1.8, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      if (tip) {
        const f = grab ? grab.f : P.hit && P.on && P.str > 0.3 ? P.hit.f : null;
        if (f) {
          let txt = `${names[f.kind][lang]} · ${String(f.n).padStart(2, "0")}/${FIB}`;
          if (grab && grab.pull) txt += ` · ${pulledWord[lang]} ${(Math.hypot(grab.pull[0], grab.pull[1]) / 22).toFixed(1)} ${mmWord[lang]}`;
          if (tip.textContent !== txt) tip.textContent = txt;
          tip.style.transform = `translate(${(P.ex + tipX + 16).toFixed(1)}px, ${(P.ey + tipY - 34).toFixed(1)}px)`;
          tip.classList.add("on"); tipOff = 0;
        } else if (++tipOff > 8) tip.classList.remove("on"); // a few frames' grace: no blinking at the edge
      }
      // watch the frame cost and the frame rate: a slow machine steps down once to fewer points
      if (++frames > 60) { // skip the warm-up frames, then watch smoothed values
        cost = cost ? cost * 0.95 + (performance.now() - work0) * 0.05 : performance.now() - work0;
        if (rawDt < 200) lag = lag * 0.95 + (rawDt / (fast ? 16.7 : 33.4)) * 0.05; // 1 = on time; a hidden or throttled tab is ignored
        if (quality === 1 && frames > 150 && (cost > 7 || lag > 1.45)) { quality = 2; resize(); } // once, and it stays
      } else lag = 1;
      requestAnimationFrame(frame);
    }
    resize();
    if (reduce) { clock = 4000; running = true; frame(performance.now()); running = false; return; }
    whenVisible(c, () => { if (!running) { running = true; lastNow = null; requestAnimationFrame(frame); } }, () => { running = false; });
  })();

  /* ---- statement: a sewing simulation of two pattern pieces with cross-quilting, like the app's */
  (function sim() {
    const c = $("#simc"); if (!c) return;
    const ctx = c.getContext("2d");
    const W = 560, H = 350, STEP = 4.4; // 2 px per mm, 2.2 mm stitches
    const quad = (a, b, k, n) => Array.from({ length: n }, (_, i) => { const t = (i + 1) / n; return [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * k[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * k[1] + t * t * b[1]]; });
    const front = [[60, 318], [60, 92], ...quad([60, 92], [140, 46], [118, 96], 10), [222, 84], ...quad([222, 84], [262, 176], [228, 160], 10), [254, 318]];
    const sleeve = [[318, 318], [304, 180]];
    for (let i = 0; i <= 20; i++) { const a = Math.PI - (i / 20) * Math.PI; sleeve.push([410 + 106 * Math.cos(a), 180 - 132 * Math.sin(a)]); }
    sleeve.push([502, 318]);
    const inside = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const runs = [];
    for (const poly of [front, sleeve]) {
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      for (const dir of [1, -1]) {
        let flip = false;
        for (let cc = -(y1 - y0); cc < x1 - x0 + (y1 - y0); cc += 24) {
          // a line at 45 degrees, cut into runs where it crosses the piece's edge
          const pts = [];
          let run = [];
          for (let s = 0; s < (y1 - y0) + 2; s += STEP / Math.SQRT2) {
            const p = [x0 + cc + dir * s, y1 - s];
            if (inside(p, poly)) run.push(p); else if (run.length) { if (run.length > 2) pts.push(run); run = []; }
          }
          if (run.length > 2) pts.push(run);
          for (const r of pts) runs.push(flip ? r.reverse() : r);
          flip = !flip;
        }
      }
      // the outline, sewn last
      const ol = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = 0; s < d; s += STEP) ol.push([a[0] + ((b[0] - a[0]) * s) / d, a[1] + ((b[1] - a[1]) * s) / d]);
      }
      ol.push(ol[0]);
      runs.push(ol);
    }
    const total = runs.reduce((n, r) => n + r.length, 0);
    const acc = document.createElement("canvas"), back = document.createElement("canvas");
    const actx = acc.getContext("2d"), bctx = back.getContext("2d");
    const fill = $("#simfill"), count = $("#simcount");
    const fmt = (n) => n.toLocaleString("en-US");
    let size, k = 1, ri = 0, pi = 0, done = 0, hold = 0, pace = 0, running = false, last = null;
    function resize() {
      size = fitCanvas(c);
      acc.width = back.width = c.width; acc.height = back.height = c.height;
      k = (size.w / W) * size.dpr;
      drawBack();
      restart();
    }
    function restart() { ri = 0; pi = 0; done = 0; hold = 0; last = null; actx.setTransform(1, 0, 0, 1, 0, 0); actx.clearRect(0, 0, acc.width, acc.height); }
    function drawBack() { // the grid and the pattern outlines never change: draw them once per size
      bctx.setTransform(k, 0, 0, k, 0, 0);
      bctx.clearRect(0, 0, W, H);
      bctx.strokeStyle = "rgba(255,255,255,0.035)"; bctx.lineWidth = 1 / k * size.dpr;
      bctx.beginPath();
      for (let x = 0; x <= W; x += 20) { bctx.moveTo(x, 0); bctx.lineTo(x, H); }
      for (let y = 0; y <= H; y += 20) { bctx.moveTo(0, y); bctx.lineTo(W, y); }
      bctx.stroke();
      bctx.strokeStyle = "rgba(155,135,255,0.55)"; bctx.lineWidth = 1.2;
      for (const poly of [front, sleeve]) { bctx.beginPath(); poly.forEach((p, i) => (i ? bctx.lineTo(p[0], p[1]) : bctx.moveTo(p[0], p[1]))); bctx.closePath(); bctx.stroke(); }
      bctx.fillStyle = "rgba(255,255,255,0.3)"; bctx.font = "9px ui-monospace, Consolas, monospace"; bctx.fillText("0, 0", 54, 334);
    }
    function bg() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(back, 0, 0);
    }
    function step(n) {
      actx.setTransform(k, 0, 0, k, 0, 0);
      for (let q = 0; q < n && ri < runs.length; q++) {
        const run = runs[ri], p = run[pi];
        if (pi === 0) {
          if (last) { actx.strokeStyle = "rgba(110,160,255,0.16)"; actx.lineWidth = 0.7; actx.setLineDash([3, 3]); actx.beginPath(); actx.moveTo(last[0], last[1]); actx.lineTo(p[0], p[1]); actx.stroke(); actx.setLineDash([]); }
          actx.fillStyle = "#3ccf7f"; actx.beginPath(); actx.arc(p[0], p[1], 2.3, 0, 7); actx.fill();
        } else {
          const a = run[pi - 1];
          actx.strokeStyle = "#ff5c8d";
          actx.lineWidth = 1.15;
          actx.beginPath(); actx.moveTo(a[0] + (p[0] - a[0]) * 0.12, a[1] + (p[1] - a[1]) * 0.12); actx.lineTo(p[0] - (p[0] - a[0]) * 0.12, p[1] - (p[1] - a[1]) * 0.12); actx.stroke();
          actx.fillStyle = "rgba(255,180,200,0.9)"; actx.fillRect(p[0] - 0.6, p[1] - 0.6, 1.2, 1.2);
        }
        last = p; done++; pi++;
        if (pi >= run.length) { ri++; pi = 0; }
      }
    }
    function paint() {
      bg();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(acc, 0, 0);
      if (last) {
        ctx.setTransform(k, 0, 0, k, 0, 0);
        const g = ctx.createRadialGradient(last[0], last[1], 0, last[0], last[1], 12);
        g.addColorStop(0, "rgba(255,92,141,0.55)"); g.addColorStop(1, "rgba(255,92,141,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(last[0], last[1], 12, 0, 7); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(last[0], last[1], 2, 0, 7); ctx.fill();
      }
      fill.style.transform = `scaleX(${(done / total).toFixed(4)})`;
      const txt = fmt(done) + " / " + fmt(total);
      if (count.textContent !== txt) count.textContent = txt;
    }
    function frame() {
      if (!running) return;
      if (ri < runs.length) { pace += 7 * SPEED; const n = Math.floor(pace); pace -= n; step(n); }
      else if (++hold > 150 / SPEED) restart();
      paint();
      requestAnimationFrame(frame);
    }
    onWidthChange(() => { resize(); if (reduce) { step(total); paint(); } });
    resize();
    if (reduce) { step(total); paint(); return; }
    step(Math.floor(total * 0.38)); // open part-way through, so the first still frame already shows stitches
    paint();
    let seen = false;
    whenVisible(c, () => { if (!running) { if (seen) restart(); seen = true; running = true; requestAnimationFrame(frame); } }, () => { running = false; });
  })();

  /* ---- laser card: flips between the check result and the fixed result */
  (function laser() {
    const card = $("#laserCard"), btn = $("#laserFix"); if (!card) return;
    let auto = !reduce, timer = null;
    const flip = () => (card.dataset.state = card.dataset.state === "slow" ? "fast" : "slow");
    btn.addEventListener("click", () => { auto = false; clearInterval(timer); flip(); });
    whenVisible(card, () => { if (auto && !timer) timer = setInterval(flip, 3800 / SPEED); }, () => { clearInterval(timer); timer = null; });
  })();

  /* ---- sewing order: rows, columns or shortest travel, with the route drawn from the machine origin */
  const order = (function () {
    const svg = $("#orderSvg"); if (!svg) return null;
    const NS = "http://www.w3.org/2000/svg";
    const shapes = [
      { x: 30, y: 26, w: 52, h: 34, t: "r" }, { x: 108, y: 20, w: 40, h: 40, t: "c" }, { x: 178, y: 30, w: 56, h: 30, t: "r" }, { x: 256, y: 18, w: 40, h: 46, t: "r" },
      { x: 24, y: 100, w: 46, h: 46, t: "c" }, { x: 98, y: 106, w: 58, h: 36, t: "r" }, { x: 184, y: 98, w: 46, h: 46, t: "c" }, { x: 250, y: 104, w: 52, h: 40, t: "r" },
    ].map((s, i) => ({ ...s, id: i, cx: s.x + s.w / 2, cy: s.y + s.h / 2 }));
    const origin = { cx: 10, cy: 176 };
    const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const modes = {
      rows: () => [...shapes].sort((a, b) => (Math.round(b.cy / 60) - Math.round(a.cy / 60)) || a.cx - b.cx),
      cols: () => [...shapes].sort((a, b) => (Math.round(a.cx / 60) - Math.round(b.cx / 60)) || b.cy - a.cy),
      short: () => { const left = [...shapes], out = []; let at = origin; while (left.length) { left.sort((a, b) => dist(at, a) - dist(at, b)); at = left.shift(); out.push(at); } return out; },
    };
    let mode = "rows", auto = !reduce, timer = null;
    const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
    function draw(animate = true) {
      const seq = modes[mode]();
      svg.textContent = "";
      for (const s of shapes) {
        if (s.t === "c") {
          svg.append(el("ellipse", { class: "shape", cx: s.cx, cy: s.cy, rx: s.w / 2, ry: s.h / 2 }));
          svg.append(el("ellipse", { class: "stitchfill", cx: s.cx, cy: s.cy, rx: s.w / 2 - 6, ry: s.h / 2 - 6 }));
        } else {
          svg.append(el("rect", { class: "shape", x: s.x, y: s.y, width: s.w, height: s.h, rx: 3 }));
          svg.append(el("rect", { class: "stitchfill", x: s.x + 6, y: s.y + 6, width: s.w - 12, height: s.h - 12, rx: 2 }));
        }
      }
      const pts = [origin, ...seq];
      const d = pts.map((p, i) => (i ? "L" : "M") + p.cx.toFixed(1) + " " + p.cy.toFixed(1)).join(" ");
      const route = el("path", { class: "route", d });
      svg.append(route);
      svg.append(el("path", { d: "M4 176h12M10 170v12", stroke: "rgba(255,255,255,.4)", "stroke-width": 1 }));
      const lab = el("text", { x: 14, y: 172, fill: "rgba(255,255,255,.35)", "font-size": 8, "font-family": "ui-monospace, Consolas, monospace" }); lab.textContent = "0,0"; svg.append(lab);
      seq.forEach((s, i) => {
        const g = el("g", {});
        g.append(el("circle", { class: "badge-c", cx: s.x + s.w - 2, cy: s.y + 2, r: 8 }));
        const tx = el("text", { class: "badge-t", x: s.x + s.w - 2, y: s.y + 2.5 }); tx.textContent = i + 1; g.append(tx);
        svg.append(g);
      });
      let mm = 0; for (let i = 1; i < pts.length; i++) mm += dist(pts[i - 1], pts[i]) * 2;
      $("#travel").textContent = Math.round(mm).toLocaleString("en-US");
      $$(".chip").forEach((c) => c.classList.toggle("on", c.dataset.mode === mode));
      if (animate && !reduce && route.getTotalLength) {
        const L = route.getTotalLength();
        route.style.strokeDasharray = L; route.style.strokeDashoffset = L;
        route.getBoundingClientRect();
        route.style.transition = `stroke-dashoffset ${(1.6 / SPEED).toFixed(2)}s cubic-bezier(.4,.1,.2,1)`;
        route.style.strokeDashoffset = 0;
        setTimeout(() => { route.style.transition = ""; route.style.strokeDasharray = ""; route.style.strokeDashoffset = ""; }, 1700 / SPEED);
      }
    }
    $$(".chip").forEach((c) => c.addEventListener("click", () => { auto = false; clearInterval(timer); mode = c.dataset.mode; draw(); }));
    const next = () => { const ks = Object.keys(modes); mode = ks[(ks.indexOf(mode) + 1) % ks.length]; draw(); };
    draw(false);
    whenVisible(svg, () => { if (!timer) { draw(); if (auto) timer = setInterval(next, 4600 / SPEED); } }, () => { clearInterval(timer); timer = null; });
    return { draw };
  })();

  /* ---- formats grid: tiles light up as if files were being read */
  (function grid() {
    const tiles = $$(".fm-tiles span"); if (!tiles.length || reduce) return;
    let timer = null;
    const tick = () => { tiles.forEach((t) => t.classList.remove("lit")); for (let i = 0; i < 2; i++) tiles[Math.floor(Math.random() * tiles.length)].classList.add("lit"); };
    whenVisible($(".fm-tiles"), () => { if (!timer) timer = setInterval(tick, 900 / SPEED); }, () => { clearInterval(timer); timer = null; });
  })();

  /* ---- closing: stitches streaming out from behind the headline (batched by alpha: one stroke per level;
     the dark centre behind the headline is a CSS layer, not a gradient painted every frame) */
  (function burst() {
    const c = $("#burst"); if (!c) return;
    const ctx = c.getContext("2d");
    const R = rng(11), LV = 8;
    const rays = Array.from({ length: 220 }, () => ({ a: R() * Math.PI * 2, d: R(), sp: 0.5 + R() * 1.3, pink: R() < 0.1 }));
    const white = [], pink = [], ws = [], ps = [];
    for (let l = 0; l < LV; l++) { white.push([]); pink.push([]); ws.push(`rgba(230,234,245,${(((l + 1) / LV) * 0.33).toFixed(3)})`); ps.push(`rgba(255,92,141,${(((l + 1) / LV) * 0.6).toFixed(3)})`); }
    let size, running = false, prev = performance.now();
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5), r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
      size = { w: r.width, h: r.height, dpr };
    }
    onWidthChange(resize);
    function frame(now) {
      const dt = Math.min(50, now - prev); prev = now;
      const { w, h, dpr } = size;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const ox = w / 2, oy = h * 0.46, maxR = Math.hypot(w, h) * 0.55;
      for (let l = 0; l < LV; l++) { white[l].length = 0; pink[l].length = 0; }
      for (const r of rays) {
        r.d += r.sp * dt * 0.00009 * SPEED; if (r.d > 1) r.d -= 1;
        const e = r.d * r.d; // speeds up as it leaves the centre
        const rad = 30 + e * maxR, len = 2 + e * 46;
        const ca = Math.cos(r.a), sa = Math.sin(r.a) * 0.62;
        const x = ox + ca * rad, y = oy + sa * rad;
        const l = Math.min(LV - 1, Math.floor(Math.sin(r.d * Math.PI) * LV));
        if (l < 0) continue;
        if (r.pink) { const q = len / 3; pink[l].push(x, y, x + ca * q, y + sa * q, x + ca * 2 * q, y + sa * 2 * q, x + ca * len, y + sa * len); } // a stitch: two dashes
        else white[l].push(x, y, x + ca * len, y + sa * len);
      }
      ctx.lineWidth = 1; ctx.lineCap = "round";
      for (let l = 0; l < LV; l++) {
        for (const [b, st] of [[white[l], ws[l]], [pink[l], ps[l]]]) {
          if (!b.length) continue;
          ctx.strokeStyle = st; ctx.beginPath();
          for (let q = 0; q < b.length; q += 4) { ctx.moveTo(b[q], b[q + 1]); ctx.lineTo(b[q + 2], b[q + 3]); }
          ctx.stroke();
        }
      }
      if (running) requestAnimationFrame(frame);
    }
    resize();
    if (reduce) { frame(prev); return; }
    whenVisible(c, () => { if (!running) { running = true; prev = performance.now(); requestAnimationFrame(frame); } }, () => { running = false; });
  })();

  /* ---- CSS loops (tickers, sewing rings, scrolling lists, pulses) stop while their section is off screen */
  (function offscreen() {
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("paused", !e.isIntersecting)), { rootMargin: "100px" });
    $$("main > .frame, body > footer").forEach((el) => io.observe(el));
  })();

  /* ---- numbers count up each time they come back into view (they rest at their final value). A number
     only counts again after it has left the screen completely, so a small scroll never restarts it. */
  (function counters() {
    if (reduce || !("IntersectionObserver" in window)) return;
    const els = $$(".count"), armed = new Set(els);
    const run = (el) => {
      const to = parseFloat(el.dataset.to), dec = +(el.dataset.dec || 0), t0 = performance.now();
      const tick = (now) => { const p = Math.min(1, (now - t0) / (1300 / SPEED)), v = to * (1 - Math.pow(1 - p, 3)); el.textContent = v.toFixed(dec); if (p < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    const start = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && armed.has(e.target)) { armed.delete(e.target); run(e.target); } }), { threshold: 0.6 });
    const rearm = new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) armed.add(e.target); }), { threshold: 0 });
    els.forEach((el) => { start.observe(el); rearm.observe(el); });
  })();

  /* ---- reveal: pieces rise into place each time they enter, scrolling down or up. A piece that leaves
     through the top waits above, so on the way back up it comes down from above. Siblings stagger. */
  (function reveal() {
    if (reduce || !("IntersectionObserver" in window)) return;
    const sel = [
      ".hero h1", ".hero .lead", ".hero .cta-row", ".hero .meta", ".step",
      ".say", ".sim-card", ".sim-sub",
      ".f-copy h2", ".f-copy > p", ".mini li", ".f-copy .more", ".stage", ".ruler",
      ".fm-copy > *", ".fm-card",
      ".big", ".pf-say", ".pf-src", ".pf-shot",
      ".n", ".faq-copy > *", ".qa details",
      ".closing h2", ".foot-cols > div", ".foot-bar", ".wordmark",
    ].join(",");
    const els = $$(sel);
    els.forEach((el) => {
      const sibs = Array.from(el.parentElement.children).filter((x) => els.includes(x));
      el.style.setProperty("--d", Math.round((Math.min(sibs.indexOf(el), 6) * 80) / SPEED) + "ms");
      el.classList.add("rv");
    });
    const place = (el, top) => { el.classList.toggle("out-above", top); el.classList.toggle("out-below", !top); };
    // two observers: one brings a piece in once it is a little way onto the screen; the other puts it back
    // only when it has left the screen entirely, so nothing ever disappears while you can still see it
    const show = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) e.target.classList.remove("out-above", "out-below");
    }), { threshold: 0, rootMargin: "0px 0px -6% 0px" });
    const hide = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) place(e.target, e.boundingClientRect.bottom <= 0);
    }), { threshold: 0, rootMargin: "60px 0px 60px 0px" });
    const io = { observe: (el) => { show.observe(el); hide.observe(el); } };
    // start hidden without a transition, then let the observer bring in whatever is on screen
    document.documentElement.classList.add("rv-init");
    els.forEach((el) => place(el, el.getBoundingClientRect().bottom < 0));
    setTimeout(() => { // a timer, not rAF: a page opened in a background tab must still show its content
      document.documentElement.classList.remove("rv-init");
      els.forEach((el) => io.observe(el));
    }, 60);
  })();

  if (store.get("stl.site.lang") === "en") setLang("en");
})();
