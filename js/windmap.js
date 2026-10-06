'use strict';
/* ================= The wind map: MET Nordic's wind forecast (10 m) as moving streaks over a speed colour field, the "Vind" side
   of the radar map. api/wind.php hands over one hour at a time for the part of the map on screen, on a regular lat/lon grid
   (u east, v north, 0.1 m/s, null where MET has nothing). The streaks move in screen pixels at a speed that grows with the wind
   but not with the zoom, so a close view never turns into a storm. Playing glides between the hours (u and v blended), the
   slider snaps to whole hours. Reduced motion or data saving: still arrows instead of streaks, no gliding.
   Two canvases in a pane under the place marker: they ride along while the map is dragged and are redrawn when it stops. ================= */
window.WindMap = (() => {
  // colour by speed (m/s): pale cyan through blue and indigo to magenta, away from the temperature map's yellow and orange;
  // calm air is nearly see-through so the map still reads
  const STOPS = [[0, [205, 236, 245], 0.10], [2, [168, 222, 240], 0.28], [5, [96, 182, 230], 0.42], [8, [52, 140, 214], 0.52], [11, [40, 100, 196], 0.58],
    [14, [58, 70, 178], 0.62], [17, [88, 50, 164], 0.65], [21, [122, 40, 150], 0.68], [25, [160, 36, 134], 0.7], [30, [196, 30, 108], 0.72], [36, [222, 28, 76], 0.74]];
  const LUT = (() => {   // 0.1 m/s steps up to 40 m/s: [r, g, b, a(0-255)]
    const out = new Uint8ClampedArray(401 * 4);
    for (let k = 0; k <= 400; k++) {
      const s = k / 10; let i = 0; while (i < STOPS.length - 2 && s > STOPS[i + 1][0]) i++;
      const [s0, c0, a0] = STOPS[i], [s1, c1, a1] = STOPS[i + 1], f = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
      for (let j = 0; j < 3; j++) out[k * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
      out[k * 4 + 3] = 255 * (a0 + (a1 - a0) * f);
    }
    return out;
  })();
  const css = (s) => { const k = Math.min(400, Math.round(s * 10)) * 4; return `rgb(${LUT[k]},${LUT[k + 1]},${LUT[k + 2]})`; };

  /* MET Nordic's area: Lambert conformal (lat_0 = lat_1 = lat_2 = 63, lon_0 = 15, sphere), 1 km, 1796 x 2321 */
  const LCC = (() => { const p1 = 63 * Math.PI / 180, n = Math.sin(p1), F = Math.cos(p1) * Math.tan(Math.PI / 4 + p1 / 2) ** n / n; return { n, F, rho0: 6371000 * F / Math.tan(Math.PI / 4 + p1 / 2) ** n }; })();
  function covers(lat, lon) {
    const rho = 6371000 * LCC.F / Math.tan(Math.PI / 4 + lat * Math.PI / 360) ** LCC.n, th = LCC.n * (lon - 15) * Math.PI / 180;
    const i = (rho * Math.sin(th) + 897442.2) / 1000, j = (LCC.rho0 - rho * Math.cos(th) + 1104322.0) / 1000;
    return i > 5 && j > 5 && i < 1790 && j < 2315;
  }

  const W = {
    map: null, o: null, on: false, pane: null, fld: null, prt: null, dpr: 1, w: 0, h: 0,
    meta: null, metaAt: 0, times: [], idx: 0, tau: 0, frames: new Map(), view: null, err: '',
    bad: new Map(), acc: 0, parts: [], raf: 0, playing: false, moving: false, visible: true, last: 0, fieldAt: 0, lonAt: null, latAt: null, ref: null, pop: null, token: 0,
  };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || !!(navigator.connection && navigator.connection.saveData);
  const dark = () => { const th = document.documentElement.getAttribute('data-theme'); return th === 'dark' || (th !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches); };
  const fetchJSON = async (url) => {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 25000);   // past the server's own 18 s deadline
    try { const r = await fetch(url, { signal: ac.signal }); const j = await r.json().catch(() => null); if (!r.ok || !j || j.error) { const e = new Error((j && j.error) || 'HTTP ' + r.status); e.status = r.status; throw e; } return j; }
    finally { clearTimeout(tm); }
  };

  /* ---- data: the run and its hours, then one frame per hour for the current view ---- */
  async function loadMeta() {
    if (W.meta && Date.now() - W.metaAt < 10 * 60e3) return W.meta;
    const m = await fetchJSON('api/wind.php?meta=1');
    if (!W.meta || W.meta.run !== m.run) W.frames.clear();
    W.meta = m; W.metaAt = Date.now(); return m;
  }
  // the box fetched for the view: the map plus a margin, a point every ~10 px, never finer than the grid: 3 km, or MET's own 1 km
  // once the points would be closer than 2.5 km (about zoom 9 and in)
  function viewFor() {
    const m = W.map, b = m.getBounds().pad(0.25), size = m.getSize();
    const s = Math.max(40.5, b.getSouth()), n = Math.min(79.5, b.getNorth()), w = Math.max(-29.5, b.getWest()), e = Math.min(59.5, b.getEast());
    const kmX = (e - w) * 111.3 * Math.cos(((s + n) / 2) * Math.PI / 180), kmY = (n - s) * 111.3;
    const fine = kmX / (size.x * 1.5 / 10) < 2.5, km = fine ? 1 : 3;
    const nx = Math.max(6, Math.min(140, Math.round(Math.min(size.x * 1.5 / 10, kmX / km)))), ny = Math.max(6, Math.min(140, Math.round(Math.min(size.y * 1.5 / 10, kmY / km))));
    const r = (v) => Math.round(v * 1000) / 1000;
    const v = { s: r(s), w: r(w), n: r(n), e: r(e), nx, ny, z: m.getZoom(), fine };
    v.key = `${v.s},${v.w},${v.n},${v.e},${nx},${ny}${fine ? ',f' : ''}`; return v;
  }
  const inside = (v) => { const b = W.map.getBounds(); return v && v.z === W.map.getZoom() && b.getSouth() >= v.s && b.getNorth() <= v.n && b.getWest() >= v.w && b.getEast() <= v.e; };
  function frame(i, view = W.view) {
    const t = W.times[i]; if (t == null || !view || !W.meta) return null;
    const k = `${W.meta.run}|${t}|${view.key}`;
    let f = W.frames.get(k);
    if (!f && Date.now() - (W.bad.get(k) || 0) < 30e3) return { t, ready: false, failed: true, p: Promise.reject(new Error('failed')).catch(() => null) };   // a failed hour is not asked again for 30 s
    if (!f) {
      f = { t, ready: false, failed: false, p: null };
      f.p = fetchJSON(`api/wind.php?run=${W.meta.run}&t=${t}&s=${view.s}&w=${view.w}&n=${view.n}&e=${view.e}&nx=${view.nx}&ny=${view.ny}${view.fine ? '&r=1' : ''}`).then((j) => {
        const n = j.nx * j.ny, u = new Float32Array(n), v = new Float32Array(n);
        for (let q = 0; q < n; q++) { u[q] = j.u[q] == null ? NaN : j.u[q] / 10; v[q] = j.v[q] == null ? NaN : j.v[q] / 10; }
        Object.assign(f, { s: j.s, w: j.w, n: j.n, e: j.e, nx: j.nx, ny: j.ny, u, v, run: j.run, ready: true });
        return f;
      }).catch((e) => { f.failed = true; W.frames.delete(k); W.bad.set(k, Date.now()); throw e; });
      W.frames.set(k, f);
      if (W.frames.size > 80) W.frames.delete(W.frames.keys().next().value);
    }
    return f;
  }
  // bilinear; null where any corner has no data
  function sample(f, lat, lon) {
    if (!f || !f.ready) return null;
    const x = (lon - f.w) / (f.e - f.w) * (f.nx - 1), y = (lat - f.s) / (f.n - f.s) * (f.ny - 1);
    if (!(x >= 0 && y >= 0 && x <= f.nx - 1 && y <= f.ny - 1)) return null;
    const i = Math.min(f.nx - 2, Math.floor(x)), j = Math.min(f.ny - 2, Math.floor(y)), a = x - i, b = y - j, q = j * f.nx + i;
    const u = f.u[q] * (1 - a) * (1 - b) + f.u[q + 1] * a * (1 - b) + f.u[q + f.nx] * (1 - a) * b + f.u[q + f.nx + 1] * a * b;
    const v = f.v[q] * (1 - a) * (1 - b) + f.v[q + 1] * a * (1 - b) + f.v[q + f.nx] * (1 - a) * b + f.v[q + f.nx + 1] * a * b;
    return Number.isNaN(u) || Number.isNaN(v) ? null : [u, v];
  }
  // the wind shown now: the current hour, or on the way to the next one while playing
  function windAt(lat, lon) {
    const a = sample(frame(W.idx), lat, lon); if (!a || !W.tau) return a;
    const b = sample(frame(W.idx + 1), lat, lon); if (!b) return a;
    return [a[0] + (b[0] - a[0]) * W.tau, a[1] + (b[1] - a[1]) * W.tau];
  }

  /* ---- screen: the canvases sit at the map's top left; lon is linear in x, lat in Mercator y ---- */
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const unmerc = (m) => (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI;
  function place() {
    const m = W.map, size = m.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    W.w = size.x; W.h = size.y; W.dpr = dpr;
    const tl = m.containerPointToLayerPoint([0, 0]);
    for (const c of [W.fld, W.prt]) { L.DomUtil.setPosition(c, tl); c.style.width = size.x + 'px'; c.style.height = size.y + 'px'; }
    if (W.prt.width !== Math.round(size.x * dpr) || W.prt.height !== Math.round(size.y * dpr)) { W.prt.width = Math.round(size.x * dpr); W.prt.height = Math.round(size.y * dpr); }
    const a = m.containerPointToLatLng([0, 0]), b = m.containerPointToLatLng([size.x, size.y]);
    const m0 = merc(a.lat), m1 = merc(b.lat);
    W.lonAt = (x) => a.lng + (b.lng - a.lng) * x / size.x;
    W.latAt = (y) => unmerc(m0 + (m1 - m0) * y / size.y);
  }
  function drawField() {
    if (!W.on || !W.latAt) return;
    const f = frame(W.idx); if (!f || !f.ready) return;
    const S = 4, gw = Math.ceil(W.w / S), gh = Math.ceil(W.h / S);
    if (W.fld.width !== gw || W.fld.height !== gh) { W.fld.width = gw; W.fld.height = gh; }
    const ctx = W.fld.getContext('2d'), img = ctx.createImageData(gw, gh), d = img.data;
    const lons = new Float64Array(gw); for (let x = 0; x < gw; x++) lons[x] = W.lonAt(x * S + S / 2);
    for (let y = 0; y < gh; y++) {
      const lat = W.latAt(y * S + S / 2);
      for (let x = 0; x < gw; x++) {
        const uv = windAt(lat, lons[x]); if (!uv) continue;
        const k = Math.min(400, Math.round(Math.hypot(uv[0], uv[1]) * 10)) * 4, o = (y * gw + x) * 4;
        d[o] = LUT[k]; d[o + 1] = LUT[k + 1]; d[o + 2] = LUT[k + 2]; d[o + 3] = LUT[k + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    W.fieldAt = performance.now();
  }

  /* ---- streaks: a fixed number for the map's area, each living 1-3 s ---- */
  // fewer streaks the closer the view (all of them up to zoom 6, a third at street level), so a town does not look like rain
  const count = () => Math.round(Math.max(150, Math.min(900, W.w * W.h / 600)) * Math.max(0.35, Math.min(1, 1.4 - 0.07 * (W.map ? W.map.getZoom() : 7))));
  const spawn = (p) => { p.x = Math.random() * W.w; p.y = Math.random() * W.h; p.age = 0; p.max = 50 + Math.random() * 110; return p; };
  function seed() { W.parts = Array.from({ length: count() }, () => spawn({})); clearParticles(); }
  function clearParticles() { const c = W.prt.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W.prt.width, W.prt.height); }
  function stepParticles() {
    const c = W.prt.getContext('2d'), dpr = W.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = 'rgba(0,0,0,0.075)'; c.fillRect(0, 0, W.prt.width, W.prt.height);
    c.globalCompositeOperation = 'source-over';
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // light map: dark streaks where the field is pale (under 9 m/s), white where it is deep; dark map: white throughout
    const lite = new Path2D(), deep = new Path2D(), dk = dark();
    for (const p of W.parts) {
      if (++p.age > p.max) { spawn(p); continue; }
      const uv = windAt(W.latAt(p.y), W.lonAt(p.x));
      if (!uv) { spawn(p); continue; }
      const sp = Math.hypot(uv[0], uv[1]), px = 0.32 * sp ** 0.8;   // pixels per frame: 1 m/s 0.3, 10 m/s 2, 25 m/s 4
      let dx = sp ? uv[0] / sp * px : 0, dy = sp ? -uv[1] / sp * px : 0;
      const len = Math.hypot(dx, dy); if (len < 0.35 && len > 0) { dx *= 0.35 / len; dy *= 0.35 / len; }
      const path = dk || sp >= 9 ? deep : lite;
      path.moveTo(p.x, p.y); p.x += dx; p.y += dy; path.lineTo(p.x, p.y);
      if (p.x < 0 || p.y < 0 || p.x > W.w || p.y > W.h) spawn(p);
    }
    c.lineCap = 'round'; c.lineWidth = 1.3;
    c.strokeStyle = 'rgba(22,32,58,0.62)'; c.stroke(lite);
    c.strokeStyle = 'rgba(255,255,255,0.92)'; c.stroke(deep);
  }
  // reduced motion: an arrow every ~46 px, pointing where the wind goes
  function drawArrows() {
    const c = W.prt.getContext('2d'); clearParticles(); c.setTransform(W.dpr, 0, 0, W.dpr, 0, 0);
    const gap = 46, path = new Path2D();
    for (let y = gap / 2; y < W.h; y += gap) for (let x = gap / 2; x < W.w; x += gap) {
      const uv = windAt(W.latAt(y), W.lonAt(x)); if (!uv) continue;
      const sp = Math.hypot(uv[0], uv[1]); if (sp < 0.3) continue;
      const ux = uv[0] / sp, uy = -uv[1] / sp, l = 7 + Math.min(10, sp * 0.6), hx = x + ux * l, hy = y + uy * l;
      path.moveTo(x - ux * l, y - uy * l); path.lineTo(hx, hy);
      path.moveTo(hx - ux * 6 - uy * 4, hy - uy * 6 + ux * 4); path.lineTo(hx, hy); path.lineTo(hx - ux * 6 + uy * 4, hy - uy * 6 - ux * 4);
    }
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(15,23,42,0.45)'; c.lineWidth = 3.4; c.stroke(path);
    c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 1.6; c.stroke(path);
  }

  /* ---- the loop: streaks every frame, the colour field again a few times a second while gliding between hours ---- */
  const HOUR_MS = 1100;
  function loop(now) {
    W.raf = 0;
    if (!W.on || W.moving || !W.visible || document.hidden) return;
    const dt = Math.min(100, now - (W.last || now)); W.last = now;
    const still = reduced();
    if (W.playing) {
      const nf = frame(W.idx + 1);
      if (!nf || nf.failed) { stop(); return; }
      if (nf.ready && still) {   // still arrows: whole hours, no gliding
        W.acc += dt;
        if (W.acc >= HOUR_MS) { W.acc = 0; W.idx++; if (W.pop) W.map.closePopup(W.pop); prefetch(); ui(); drawField(); drawArrows(); if (W.idx >= W.times.length - 1) stop(); }
      } else if (nf.ready) {
        W.tau += dt / HOUR_MS;
        if (W.tau >= 1) { W.tau = 0; W.idx++; if (W.pop) W.map.closePopup(W.pop); prefetch(); ui(); if (W.idx >= W.times.length - 1) stop(); }
        if (now - W.fieldAt > 120 || !W.tau) drawField();
      }
    }
    if (still) { if (W.playing) W.raf = requestAnimationFrame(loop); return; }
    stepParticles();
    W.raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!W.raf && W.on) { W.last = 0; W.raf = requestAnimationFrame(loop); } };
  function play() {
    if (W.idx >= W.times.length - 1) { W.idx = 0; W.tau = 0; }
    W.playing = true; W.acc = 0; ui(); prefetch(); kick();
  }
  function stop() { W.playing = false; if (W.tau) { W.tau = 0; drawField(); } ui(); }
  // the hour on screen and the next six (three when zoomed in, where each hour is 1 km tiles), one request at a time
  let pre = 0;
  async function prefetch() {
    const my = ++pre;
    for (let k = 0; k <= (W.view && W.view.fine ? 3 : 6); k++) {
      const f = frame(W.idx + k); if (!f) break;
      try { await f.p; } catch (e) { /* shown when it is the hour on screen */ }
      if (my !== pre) return;
    }
  }

  /* ---- showing an hour ---- */
  async function seek(i, byUser) {
    i = Math.max(0, Math.min(W.times.length - 1, i));
    if (byUser && W.playing) stop();
    if (i !== W.idx && W.pop) W.map.closePopup(W.pop);   // the spot's reading was for the hour that was
    W.idx = i; W.tau = 0; ui();
    const my = ++W.token, f = frame(i);
    if (!f) return;
    if (!f.ready) {
      busy(true);
      let failed = f.failed;
      if (!failed) { try { await f.p; } catch (e) { failed = e.status === 503 ? 'down' : 'net'; } }
      busy(false);
      if (my !== W.token || !W.on) return;
      if (failed) {   // the hour could not be had: say so, and show no colours that belong to another hour
        W.err = failed === true ? 'net' : failed; W.fld.getContext('2d').clearRect(0, 0, W.fld.width, W.fld.height); clearParticles(); ui(); return;
      }
    }
    if (my !== W.token || !W.on) return;
    W.err = ''; drawField(); if (reduced()) drawArrows(); ui(); prefetch(); kick();
  }
  function busy(on) { const b = W.o.els.slider; if (b) b.classList.toggle('busy', on); }   // a spinner by the time while an hour loads
  function onView() {   // the map stopped moving: new box if the view left the old one, canvases back in place
    W.moving = false;
    place(); seed();   // seeding clears the streak canvas, so it comes before any arrows are drawn
    if (!inside(W.view)) { W.view = viewFor(); seek(W.idx); }
    else { drawField(); if (reduced()) drawArrows(); }
    kick();
  }

  /* ---- the controls: slider (the time once, the days marked under it), play, the legend and one line; the rest behind "Om kartet" ---- */
  function ui() {
    const o = W.o, e = o.els, t = W.times[W.idx];
    if (!e.slider) return;
    const inp = e.slider.querySelector('input'), lab = e.slider.querySelector('b');
    e.slider.hidden = W.times.length < 2;
    inp.max = String(Math.max(0, W.times.length - 1)); if (document.activeElement !== inp) inp.value = String(W.idx);
    lab.innerHTML = t ? `${o.clock(t)}<small>${o.day(t)}</small>` : ''; inp.setAttribute('aria-valuetext', t ? o.label(t) : '');
    e.play.setAttribute('aria-pressed', W.playing ? 'true' : 'false'); e.play.setAttribute('aria-label', o.t(W.playing ? 'lm.radar.pause' : 'lm.radar.play'));
    const ticks = e.slider.querySelector('.rm-ticks'), n = W.times.length;
    if (ticks && n > 1) {   // a mark where each new day starts, named
      const marks = []; for (let k = 1; k < n; k++) if (o.clock(W.times[k]) === '00:00') marks.push([k, o.day(W.times[k])]);
      const key = JSON.stringify([n, marks]);
      if (ticks.dataset.k !== key) { ticks.dataset.k = key; ticks.innerHTML = marks.map(([k, d]) => `<span style="left:calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${(k / (n - 1)).toFixed(4)})">${d}</span>`).join(''); }
    }
    const stops = [0, 5, 10, 15, 20, 25, 30], marks = [0, 10, 20, 30];
    const legend = `<div class="rm-legend wm-legend" aria-hidden="true"><div class="wm-bar" style="background:linear-gradient(90deg,${stops.map((s) => css(s)).join(',')})"></div><div class="wm-ticks">${marks.map((s, k) => `<span>${o.fmt(o.speed(s))}${k === marks.length - 1 ? ` <b class="wm-unit">${o.unit()}</b>` : ''}</span>`).join('')}</div></div>`;
    const run = W.meta ? o.clock(W.meta.ref) : '';
    const msg = W.err === 'down' ? o.t('wm.err.down') : W.err ? o.t('wm.err.net') : !W.meta ? `<span class="spinner small"></span> ${o.t('wm.loading')}` : '';
    e.cap.innerHTML = `${legend}<div class="rm-line">${msg || `${o.t(reduced() ? 'wm.hint.still' : 'wm.hint')} ${o.about()}`}</div>${msg ? '' : `<div class="rm-about">${o.t('wm.cap', { run })}</div>`}`;
  }

  /* ---- tap: the wind at that spot and hour ---- */
  function probe(ev) {
    if (!W.on) return;
    const uv = windAt(ev.latlng.lat, ev.latlng.lng), o = W.o;
    if (!uv) return;
    const sp = Math.hypot(uv[0], uv[1]), from = (Math.atan2(-uv[0], -uv[1]) * 180 / Math.PI + 360) % 360;
    const html = `<b>${o.fmt(o.speed(sp))} ${o.unit()}</b> ${o.t('wm.from', { d: o.t('dir.' + ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(from / 45) % 8]) })}<br><small>${o.label(W.times[W.idx])}</small>`;
    if (!W.pop) W.pop = L.popup({ closeButton: false, autoPan: false, className: 'wm-pop', offset: [0, -4] });
    W.pop.setLatLng(ev.latlng).setContent(html).openOn(W.map);
  }

  /* ---- public: show at an hour (unix s, or now), hide ---- */
  function attach(map, o) {
    if (W.map === map) return;
    W.map = map; W.o = o;
    W.pane = map.createPane('wmPane'); W.pane.style.zIndex = 380; W.pane.style.pointerEvents = 'none';
    W.fld = L.DomUtil.create('canvas', 'wm-field', W.pane); W.prt = L.DomUtil.create('canvas', 'wm-parts', W.pane);
    W.pane.hidden = true;
    map.on('movestart', () => { if (!W.on) return; W.moving = true; });
    map.on('zoomstart', () => { if (!W.on) return; W.moving = true; W.pane.style.visibility = 'hidden'; });
    map.on('zoomend', () => { if (W.on) W.pane.style.visibility = ''; });
    map.on('moveend', () => { if (W.on) onView(); });
    map.on('resize', () => { if (W.on) onView(); });
    map.on('click', probe);
    const inp = o.els.slider.querySelector('input');
    inp.addEventListener('input', () => seek(+inp.value, true));
    o.els.play.addEventListener('click', () => (W.playing ? stop() : play()));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { freshen(); kick(); } });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { W.visible = es[0].isIntersecting; if (W.visible) kick(); }, { threshold: 0.1 }).observe(map.getContainer());
    new MutationObserver(() => { if (W.on) { drawField(); if (reduced()) drawArrows(); } }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  function hours(want) {   // this hour to +48 h, and the index nearest the wanted time
    const now = Math.floor(Date.now() / 3600e3) * 3600;
    W.times = W.meta.times.filter((x) => x >= now && x <= now + 48 * 3600);
    if (!W.times.length) W.times = W.meta.times.slice(-1);
    let best = 0; W.times.forEach((x, i) => { if (Math.abs(x - (want || now)) < Math.abs(W.times[best] - (want || now))) best = i; });
    return best;
  }
  async function show(at) {
    W.on = true; W.pane.hidden = false; W.err = '';
    place(); seed(); ui();
    try { await loadMeta(); }
    catch (e) { W.err = e.status === 503 ? 'down' : 'net'; ui(); return; }
    if (!W.on) return;
    W.view = viewFor();
    seek(hours(at));
  }
  // a map left open: a newer run (MET makes one an hour) or the clock passing an hour moves the timeline, at the same time of day
  async function freshen() {
    if (!W.on || W.playing || !W.meta || Date.now() - W.metaAt < 10 * 60e3) return;
    const t = W.times[W.idx], run = W.meta.run, first = W.times[0];
    try { await loadMeta(); } catch (e) { return; }
    if (!W.on || W.playing) return;
    if (W.meta.run !== run || Math.floor(Date.now() / 3600e3) * 3600 !== first) seek(hours(t));
  }
  setInterval(() => { if (!document.hidden && W.visible) freshen(); }, 60e3);
  function hide() {
    W.on = false; W.playing = false; W.tau = 0; W.token++; pre++;
    if (W.raf) cancelAnimationFrame(W.raf); W.raf = 0;
    if (W.pane) W.pane.hidden = true;
    if (W.pop && W.map) W.map.closePopup(W.pop);
    const e = W.o && W.o.els; if (e) e.slider.hidden = true;
  }
  return { attach, show, hide, covers, retext: () => { if (W.on) ui(); }, get on() { return W.on; }, get _state() { return W; } };   // _state: for the tests
})();
