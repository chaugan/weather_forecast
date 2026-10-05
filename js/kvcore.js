'use strict';
/* ================= The route-weather engine shared by Kjørevær (driving) and Turvær (hiking) =================
   Everything here is about points along a line and the forecast at the time you reach them; nothing here knows about
   roads, trails or screens. Points are {lat, lon, z, km, key}. Loaded before js/route.js and js/turvaer.js.
     - fetchT, small helpers (time, distance, durations)
     - heights for a list of points (Kartverket's terrain model in Norway, Open-Meteo as the fallback)
     - the forecast at each point (one Open-Meteo multi-location request; the server never proxies it) and the four
       other models at the key points, with the weighted vote that decides what is shown (see the note at `vote`)
     - weather classes, run-length segments, 0 °C crossings, MET warnings, departure options */
(function () {
  const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const OM_ELEV = 'https://api.open-meteo.com/v1/elevation';
  const WX_VARS = ['temperature_2m', 'precipitation', 'weather_code', 'wind_gusts_10m', 'is_day', 'dew_point_2m'];
  const FC_TTL = 30 * 60e3;        // a forecast set is refetched after half an hour
  const FETCH_MS = 25000;

  function fetchT(url, o = {}, ms = FETCH_MS) {   // fetch with a time limit; a hung server becomes an error the page can show
    const c = new AbortController(), tm = setTimeout(() => c.abort(), ms);
    return fetch(url, { ...o, signal: c.signal }).catch((e) => { throw e.name === 'AbortError' ? new Error(t('kv.err.timeout', { host: new URL(url, location.href).host })) : e; }).finally(() => clearTimeout(tm));
  }

  /* ---------------- small helpers ---------------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  const hm = (d) => d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const wday = (d) => d.toLocaleDateString(dateLocale(), { weekday: 'short' }).replace('.', '');
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const hav = (a, b) => { const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const dur = (min) => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h ? t('kv.dur.hm', { h, m }) : t('kv.dur.m', { m }); };
  const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const cellKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)},${p.z == null ? 'x' : Math.round(p.z / 100)}`;   // ~1 km and 100 m of height: shared stretches of different routes share samples
  // the day labels under the start bars: each span placed under its day's bars (data-day on bars and spans), again on resize
  function depAxis(dep, axis) {
    if (!dep || !axis) return; const box = dep.getBoundingClientRect(); if (!box.width) return;
    axis.style.position = 'relative'; axis.style.display = 'block'; axis.style.height = '16px';
    axis.querySelectorAll('span[data-day]').forEach((sp) => {
      const bars = dep.querySelectorAll(`[data-day="${sp.dataset.day}"]`); if (!bars.length) { sp.hidden = true; return; }
      const l = bars[0].getBoundingClientRect().left - box.left, r = bars[bars.length - 1].getBoundingClientRect().right - box.left;
      sp.hidden = false; sp.style.position = 'absolute'; sp.style.left = l + 'px'; sp.style.width = Math.max(28, r - l) + 'px'; sp.style.textAlign = 'center';
    });
  }
  // the chosen trip as a band over the bars: from its start bar to its arrival, read off the hour slots (bars and the empty slots after the last start)
  function depBand(dep) {
    let band = dep.querySelector('.kv-dep-band'); const spec = dep.__band || {};
    const box = dep.getBoundingClientRect(), slots = [...dep.querySelectorAll('[data-t]')].map((e) => ({ t: +e.dataset.t, l: e.getBoundingClientRect().left - box.left, r: e.getBoundingClientRect().right - box.left })).sort((x, y) => x.t - y.t);
    const xAt = (ms) => {   // where a moment falls on the slot axis
      let x = slots.length ? slots[slots.length - 1].r : 0;
      for (let i = 0; i < slots.length; i++) { const a = slots[i], b = slots[i + 1]; if (ms <= a.t) { x = a.l; break; } if (!b || ms < b.t) { x = b ? a.l + (ms - a.t) / (b.t - a.t) * (b.l - a.l) : a.l + Math.min(1, (ms - a.t) / 3600e3) * (a.r - a.l); break; } }
      return x;
    };
    // the line where MET Nordic's forecast ends: beyond it only the global models
    let met = dep.querySelector('.kv-dep-met'); if (spec.met && slots.length && spec.met < slots[slots.length - 1].t + 3600e3 && spec.met > slots[0].t) { if (!met) { met = document.createElement('i'); met.className = 'kv-dep-met'; met.title = t('kv.dep.metline'); dep.prepend(met); } met.style.left = xAt(spec.met) + 'px'; } else if (met) met.remove();
    if (!spec.start) { if (band) band.remove(); const l = dep.querySelector('.kv-dep-arr'); if (l) l.remove(); return; }
    const from = slots.find((x) => x.t === spec.start); if (!from || !slots.length) { if (band) band.remove(); return; }
    const x = xAt(spec.end);
    if (!band) { band = document.createElement('i'); band.className = 'kv-dep-band'; dep.prepend(band); }
    band.style.left = from.l + 'px'; band.style.width = Math.max(4, x - from.l) + 'px';
    let lab = dep.querySelector('.kv-dep-arr'); if (!lab) { lab = document.createElement('i'); lab.className = 'kv-dep-arr'; dep.prepend(lab); }   // the arrival time above the band's end, kept inside the chart
    lab.textContent = spec.label || ''; lab.style.left = Math.max(0, Math.min(x, box.width - lab.offsetWidth)) + 'px'; lab.classList.toggle('flip', x + lab.offsetWidth > box.width);
  }
  const depAxes = new Set();
  const wireDepAxis = (dep, axis, band) => { dep.__band = band || null; depAxes.add([dep, axis]); depAxis(dep, axis); depBand(dep); };
  addEventListener('resize', () => depAxes.forEach(([d, a]) => { depAxis(d, a); depBand(d); }));
  /* "Enda større kart" (computers): the map fills the window under the top bar, the chart and the stages sit in a panel on
     the right whose width can be dragged between 15 and 50 % (kept in the browser). o = {wrap, cards, onLayout(final), key} */
  function fullMap(o) {
    const el = document.createElement('div'); el.className = 'gl-full'; el.hidden = true;
    const mapSlot = document.createElement('div'); mapSlot.className = 'gl-full-map';
    const side = document.createElement('div'); side.className = 'gl-full-side';
    const grip = document.createElement('div'); grip.className = 'gl-full-grip'; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.tabIndex = 0;
    const cards = document.createElement('div'); cards.className = 'gl-full-cards';
    side.append(grip, cards); el.append(mapSlot, side); document.body.appendChild(el);
    const KEY = 'glett.map.side', clamp = (v) => Math.max(15, Math.min(50, v));
    let pct = clamp(+(lsGet(KEY) || 25) || 25), raf = 0;
    const apply = () => { el.style.setProperty('--gl-side', pct + '%'); };
    const top = () => { const h = document.querySelector('.topbar'); el.style.top = Math.max(0, h ? h.getBoundingClientRect().bottom : 60) + 'px'; };   // where the top bar ends on screen
    let lastMap = 0;   // while dragging, the map is resized at most every 150 ms: a redraw with terrain can take longer than a frame and would hold the panel back
    const layout = (final) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { top(); if (!o.onLayout) return; const now = performance.now(); if (final || now - lastMap > 150) { lastMap = now; o.onLayout(final); } }); };
    const F = { on: false };
    F.open = (on) => {
      if (on === F.on) return; F.on = on;
      if (on) {
        window.scrollTo(0, 0);
        o.wrap._home = o.wrap._home || document.createComment('map-home'); o.wrap.parentElement.insertBefore(o.wrap._home, o.wrap); mapSlot.appendChild(o.wrap);
        o.cards.forEach((c) => { c._fhome = c._fhome || document.createComment('card-home'); c.parentElement.insertBefore(c._fhome, c); cards.appendChild(c); });
        apply(); el.hidden = false; document.documentElement.classList.add('gl-fullmode'); grip.title = t('kv.map.drag'); layout(true);
      } else {
        el.hidden = true; document.documentElement.classList.remove('gl-fullmode');
        o.wrap._home.after(o.wrap); o.cards.forEach((c) => c._fhome.after(c));
        if (o.onLayout) setTimeout(() => o.onLayout(true), 60);
      }
      if (o.onToggle) o.onToggle(on);
    };
    // the grip: pointer drag, or arrow keys
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId); el.classList.add('dragging');
      const r = el.getBoundingClientRect();
      const move = (ev) => { pct = clamp((r.right - ev.clientX) / r.width * 100); apply(); layout(false); };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); el.classList.remove('dragging'); lsSet(KEY, String(Math.round(pct))); layout(true); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => { const d = e.key === 'ArrowLeft' ? 2 : e.key === 'ArrowRight' ? -2 : 0; if (!d) return; e.preventDefault(); pct = clamp(pct + d); apply(); lsSet(KEY, String(Math.round(pct))); layout(true); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && F.on) F.open(false); });
    document.addEventListener('glett:view', () => { if (F.on) F.open(false); });
    addEventListener('resize', () => { if (!F.on) return; if (innerWidth < 1000) F.open(false); else layout(true); });
    return F;
  }
  /* The planners' map switches in the control column, as icon buttons: større, hele vinduet, kartkilde, webkamera. The
     engines keep their own buttons as the switches (hidden); each icon presses one and follows its state. */
  const CTRL_ICON = {
    big: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M20 14v6h-6M4 4l7 7M20 20l-7-7"/></svg>',
    full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg>',
    base: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 5-9 5-9-5 9-5zM3 14l9 5 9-5"/></svg>',
    cams: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  };
  function mapControls(container, spec) { container.__ctrls = spec; }   // called by the engines at wiring time; glMap picks it up
  function addMapControls(m, o) {
    const wrap = m.getContainer().closest('.kv-mapwrap'); if (wrap) wrap.classList.add('has-ctrls');
    const pressed = (b) => !!b && !b.hidden && b.getAttribute('aria-pressed') === 'true';
    const canFull = () => !!o.full && !o.full.hidden && matchMedia('(min-width: 1000px) and (pointer: fine)').matches;
    const mk = (key, target) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'gl-ctrl-' + key; b.innerHTML = `<span class="maplibregl-ctrl-icon">${CTRL_ICON[key]}</span>`; b.addEventListener('click', (e) => { e.stopPropagation(); target.click(); }); return b; };
    const group = (keys) => { const c = document.createElement('div'); c.className = 'maplibregl-ctrl-group gl-ctrl'; keys.forEach(([k, el]) => el && c.appendChild(mk(k, el))); return c; };
    const g1 = group([['big', o.big], ['full', o.full]]), g2 = group([['base', o.base], ['cams', o.cams]]);
    const ctl = { onAdd() { const d = document.createElement('div'); d.className = 'maplibregl-ctrl gl-ctrls'; d.append(g1, g2); this.d = d; return d; }, onRemove() { this.d.remove(); } };   // maplibregl-ctrl: stacks under the compass and 3D like the other controls
    m.addControl(ctl, 'top-right');   // the switches on the right, the compass and 3D on the left
    const label = (b, txt) => { if (!b) return; b.title = txt; b.setAttribute('aria-label', txt); };
    const sync = () => {
      const big = g1.querySelector('.gl-ctrl-big'), full = g1.querySelector('.gl-ctrl-full'), base = g2.querySelector('.gl-ctrl-base'), cams = g2.querySelector('.gl-ctrl-cams');
      if (big) { big.hidden = !!o.big.hidden; big.setAttribute('aria-pressed', pressed(o.big)); label(big, t(pressed(o.big) ? 'kv.map.small' : 'kv.map.big')); }
      if (full) { full.hidden = !canFull(); full.setAttribute('aria-pressed', pressed(o.full)); label(full, t(pressed(o.full) ? 'kv.map.normal' : 'kv.map.full')); }
      if (base) { const osm = baseChoice() === 'osm'; base.setAttribute('aria-pressed', osm); label(base, t('kv.ctrl.base', { b: t(osm ? 'kv.map.osm' : 'kv.map.kartverket'), o: t(osm ? 'kv.map.kartverket' : 'kv.map.osm') })); }
      if (cams) { cams.hidden = !!o.cams.hidden; cams.setAttribute('aria-pressed', pressed(o.cams)); label(cams, t('kv.cam.btn') + ': ' + t(pressed(o.cams) ? 'kv.ctrl.on' : 'kv.ctrl.off') + '. ' + t('kv.cam.help')); }
      g1.hidden = !g1.querySelector('button:not([hidden])'); g2.hidden = !g2.querySelector('button:not([hidden])');
    };
    const mo = new MutationObserver(sync); [o.big, o.full, o.base, o.cams].filter(Boolean).forEach((b) => mo.observe(b, { attributes: true, attributeFilter: ['aria-pressed', 'hidden', 'class', 'title'] }));
    addEventListener('resize', sync); document.addEventListener('glett:lang', sync); sync();
  }
  /* Phones: "større" makes the map fill the screen under the top bar, with a strip at the foot (about a tenth) holding the
     weather lane of the trip as a scrubber and two short lines about the point you are at. o = {wrap, lane(): {segs: [{f0, f1, cls}]},
     seek(frac), read(): [line1, line2], onLayout(final), onToggle(on)} */
  function phoneMap(o) {
    const el = document.createElement('div'); el.className = 'gl-phone'; el.hidden = true;
    const mapSlot = document.createElement('div'); mapSlot.className = 'gl-phone-map';
    const strip = document.createElement('div'); strip.className = 'gl-strip';
    strip.innerHTML = '<div class="gl-lane"><i class="gl-lane-cur"></i></div><div class="gl-read"><span class="gl-r1"></span><span class="gl-r2"></span></div>';
    el.append(mapSlot, strip); document.body.appendChild(el);
    const lane = strip.querySelector('.gl-lane'), cur = strip.querySelector('.gl-lane-cur'), r1 = strip.querySelector('.gl-r1'), r2 = strip.querySelector('.gl-r2');
    const F = { on: false, frac: 0 };
    const tip = document.createElement('div'); tip.className = 'gl-scrubtip'; tip.hidden = true; tip.innerHTML = '<b></b><span></span>'; el.appendChild(tip);   // over the finger while scrubbing
    const placeTip = () => { const lr = lane.getBoundingClientRect(), er = el.getBoundingClientRect(), x = lr.left - er.left + F.frac * lr.width, w = tip.offsetWidth, l = Math.max(8, Math.min(er.width - w - 8, x - w / 2)); tip.style.left = l + 'px'; tip.style.top = (lr.top - er.top - tip.offsetHeight - 14) + 'px'; tip.style.setProperty('--ax', Math.max(12, Math.min(w - 12, x - l)) + 'px'); };   // inside the screen at both ends; the arrow follows the finger
    const show = (frac) => { F.frac = Math.max(0, Math.min(1, frac)); o.seek(F.frac); const [a, b] = o.read(); r1.textContent = a; r2.textContent = b; tip.firstChild.textContent = a; tip.lastChild.textContent = b; if (!tip.hidden) placeTip(); cur.style.left = `clamp(2px, ${F.frac * 100}%, calc(100% - 2px))`; };   // the marker stays inside the lane at both ends
    const paint = () => { lane.querySelectorAll('.gl-lane-seg').forEach((e) => e.remove()); (o.lane().segs || []).forEach((g) => { const i = document.createElement('i'); i.className = 'gl-lane-seg kvc-' + g.cls; i.style.left = (g.f0 * 100) + '%'; i.style.width = (Math.max(0, g.f1 - g.f0) * 100) + '%'; lane.insertBefore(i, cur); }); };
    const top = () => { const h = document.querySelector('.topbar'); el.style.top = Math.max(0, h ? h.getBoundingClientRect().bottom : 60) + 'px'; };   // where the top bar ends on screen; the page is scrolled to the top first, and iOS, which scrolls a page under a fixed layer anyway, is followed on every scroll
    addEventListener('scroll', () => { if (F.on) top(); }, { passive: true });
    F.open = (on) => {
      if (on === F.on) return; F.on = on;
      if (on) { window.scrollTo(0, 0); o.wrap._phome = o.wrap._phome || document.createComment('map-home'); o.wrap.parentElement.insertBefore(o.wrap._phome, o.wrap); mapSlot.appendChild(o.wrap); top(); el.hidden = false; document.documentElement.classList.add('gl-fullmode'); paint(); show(0); requestAnimationFrame(() => o.onLayout && o.onLayout(true)); }
      else { el.hidden = true; document.documentElement.classList.remove('gl-fullmode'); o.wrap._phome.after(o.wrap); if (o.onLayout) setTimeout(() => o.onLayout(true), 60); }
      if (o.onToggle) o.onToggle(on);
    };
    F.refresh = () => { if (F.on) { paint(); show(F.frac); } };   // a new plan or a new start while open
    const at = (ev) => { const r = lane.getBoundingClientRect(); show((ev.clientX - r.left) / r.width); };
    strip.addEventListener('pointerdown', (ev) => { ev.preventDefault(); strip.setPointerCapture(ev.pointerId); tip.hidden = false; at(ev); const mv = (e) => at(e), up = () => { tip.hidden = true; strip.removeEventListener('pointermove', mv); strip.removeEventListener('pointerup', up); strip.removeEventListener('pointercancel', up); }; strip.addEventListener('pointermove', mv); strip.addEventListener('pointerup', up); strip.addEventListener('pointercancel', up); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && F.on) F.open(false); });
    document.addEventListener('glett:view', () => { if (F.on) F.open(false); });   // another page: back to the page first
    addEventListener('resize', () => { if (F.on) { top(); if (o.onLayout) o.onLayout(true); } });
    return F;
  }
  const phoneLike = () => innerWidth < 1000 && matchMedia('(pointer: coarse)').matches;   // where "større" means the whole screen
  function depOptions(maxH) {   // whole hours from the next hour, up to maxH ahead; "now" first
    const out = [new Date()], s = new Date(); s.setMinutes(0, 0, 0);
    for (let k = 1; k <= maxH; k++) out.push(new Date(+s + k * 3600e3));
    return out;
  }

  /* ---------------- heights (cached in memory for the session) ---------------- */
  const elevCache = new Map(), fcCache = new Map();
  // Kartverket's 1 m terrain model in Norway, Open-Meteo last (it counts every coordinate against the visitor's quota)
  const ELEV_SOURCES = {
    kartverket: { per: 50, async get(ch) {
      const r = await fetchT(`https://ws.geonorge.no/hoydedata/v1/punkt?koordsys=4326&geojson=false&punkter=${encodeURIComponent(JSON.stringify(ch.map((k) => k.split(',').reverse().map(Number))))}`);
      if (!r.ok) throw new Error('kartverket elevation ' + r.status);
      return (await r.json()).punkter.map((p) => p.z);
    } },
    openmeteo: { per: 100, async get(ch) {
      const r = await fetchT(`${OM_ELEV}?latitude=${ch.map((k) => k.split(',')[0]).join(',')}&longitude=${ch.map((k) => k.split(',')[1]).join(',')}`);
      if (!r.ok) throw new Error('elevation ' + r.status);
      return (await r.json()).elevation;
    } },
  };
  async function elevate(pts, sources) {   // fills p.z for the points without one; sources: source ids in order of preference
    const key = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    const need = [...new Set(pts.map(key))].filter((k) => !elevCache.has(k));
    for (const id of sources.filter(Boolean)) {
      const src = ELEV_SOURCES[id], left = need.filter((k) => !elevCache.has(k));
      if (!left.length) break;
      const chunks = []; for (let i = 0; i < left.length; i += src.per) chunks.push(left.slice(i, i + src.per));
      let next = 0;   // four requests at a time: Kartverket's service answers each in 0.5–9 s, so one after another was the slow part
      try { await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => { while (next < chunks.length) { const ch = chunks[next++]; (await src.get(ch)).forEach((z, k) => { if (z != null && Number.isFinite(+z)) elevCache.set(ch[k], +z); }); } })); }
      catch (e) { console.warn('elevation', id, e); }
    }
    pts.forEach((p) => { const z = elevCache.get(key(p)); if (z != null) p.z = z; });   // unknown stays unknown
  }

  /* ---------------- the forecast at each point ---------------- */
  async function fetchForecast(samples, vars = WX_VARS) {   // samples: [{key, lat, lon, z}]
    const now = Date.now(), need = [];
    const seen = new Set();
    samples.forEach((s) => { const c = fcCache.get(s.key); if ((!c || now - c.at > FC_TTL) && !seen.has(s.key)) { seen.add(s.key); need.push(s); } });
    // 50 places per request, 3 at a time, 45 s each and one retry: Open-Meteo takes ~10 s for 60 places when busy, and a
    // single 150-place request could pass a 25 s limit on long routes
    const chunks = []; for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50));
    const one = async (ch) => {
      const q = new URLSearchParams({ latitude: ch.map((s) => s.lat.toFixed(3)).join(','), longitude: ch.map((s) => s.lon.toFixed(3)).join(','),
        // an unknown height is sent as nan: Open-Meteo then uses its own terrain model for that place
        elevation: ch.map((s) => (s.z == null ? 'nan' : Math.round(s.z))).join(','), hourly: vars.join(','), forecast_days: '5', timeformat: 'unixtime', wind_speed_unit: 'ms', timezone: 'GMT' });
      let r = null, lastErr = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try { r = await fetchT(`${OM_FORECAST}?${q}`, {}, 45000); if (r.status >= 500) { lastErr = new Error(t('err.upstream', { host: 'api.open-meteo.com', s: r.status })); r = null; } } catch (e) { lastErr = e; }
      }
      if (!r) throw lastErr;
      if (r.status === 429) throw new Error(t('err.quota', { host: 'api.open-meteo.com' }));
      if (!r.ok) throw new Error(t('err.upstream', { host: 'api.open-meteo.com', s: r.status }));
      let j = await r.json(); if (!Array.isArray(j)) j = [j];
      j.forEach((f, k) => { fcCache.set(ch[k].key, { at: now, t: f.hourly.time, h: f.hourly }); if (ch[k].z == null && Number.isFinite(f.elevation)) ch[k].z = f.elevation; });
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => { while (next < chunks.length) await one(chunks[next++]); }));
  }
  function classify(code, mm, tc) {   // weather classes: similar weather is one class (drizzle and rain are both "wet")
    if (code >= 95) return 'thunder';
    if ([56, 57, 66, 67].includes(code)) return 'ice';
    if (code === 45 || code === 48) return 'fog';
    const precip = mm >= 0.1 || (code >= 51 && code <= 86);
    if (!precip) return 'dry';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return tc > 1.5 ? 'sleet' : 'snow';
    if (tc <= 1.5) return tc <= 0.3 ? 'snow' : 'sleet';          // rain near 0 °C falls as sleet or snow
    if (mm >= 4 || code === 65 || code === 82) return 'heavy';
    return 'wet';
  }
  const KV_CLASSES = ['dry', 'fog', 'wet', 'heavy', 'sleet', 'snow', 'ice', 'thunder'];
  function wxAt(key, ms) {   // the forecast at a place and time: temperature and dew point interpolated, the rest from the hour you are in
    const c = fcCache.get(key); if (!c) return null;
    const x = (ms / 1000 - c.t[0]) / 3600;
    if (x < 0 || x > c.t.length - 1) return null;
    const i = Math.min(c.t.length - 2, Math.floor(x)), f = x - i, h = c.h;
    const k = Math.min(c.t.length - 1, Math.ceil(x));   // precipitation, weather code and gusts describe the hour that ends at k
    const lerp = (a) => (a && Number.isFinite(a[i]) && Number.isFinite(a[i + 1]) ? a[i] * (1 - f) + a[i + 1] * f : NaN);   // a missing value stays missing, never 0 °C
    const at = (a) => (a ? a[k] : null);
    return { t: lerp(h.temperature_2m), mm: h.precipitation[k] ?? 0, code: h.weather_code[k] ?? 0, g: h.wind_gusts_10m[k] ?? 0,
      day: h.is_day[Math.round(x)] ?? 1, dew: lerp(h.dew_point_2m), i, k, f, h,   // i, k, f, h: for extra variables a caller asked for
      vis: at(h.visibility), cape: at(h.cape), frz: at(h.freezing_level_height), wind: at(h.wind_speed_10m), cloud: at(h.cloud_cover), app: lerp(h.apparent_temperature) };
  }

  /* Model agreement. The main forecast is Open-Meteo's best match: in Norway MET Nordic (1 km, the next ~2½ days), then
     global models. At the key points of each route (the passes and about every 25 km) four other models are asked as
     well: ECMWF, DWD ICON, NOAA GFS and UK Met Office (temperature, precipitation, weather code, gusts; 4 × 4 series count
     as 1.6 Open-Meteo calls a place, ~70 a search on top of the main forecast's 100–250; the free limits are per visitor).
     Reviewed with the panel (Codex, Grok, GLM) on 2026-10-02:
     - Within 48 hours MET Nordic decides what is shown; the other models only flag doubt.
     - From 48 hours ahead the weighted majority decides, with weights from the main forecast's 28-day scoring
       (WEFO.fetchVerify, up to 4 areas per route) shrunk toward equal (0.75–1.4): that skill is measured on short-lead
       forecasts. At a pass the global models (10–25 km) vote on wet or dry only; MET Nordic decides rain or snow there.
     - Five correlated models are no probability: the stages never repeat their own weather, only name a worse
       alternative worth knowing, in two steps ("Kanskje snø", "Liten sjanse for snø"), with where and when, at
       thresholds by severity, and not what "mulig glatt" or the gust mark already say. */
  const ENS_MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'ukmo_seamless'];
  const ENS_VARS = ['temperature_2m', 'precipitation', 'weather_code', 'wind_gusts_10m'];
  const ENS_KM = 25, ENS_REACH_KM = 12;
  const ensCache = new Map();
  async function fetchEnsemble(samples) {
    const now = Date.now(), need = [], seen = new Set();
    samples.forEach((x) => { const c = ensCache.get(x.key); if ((!c || now - c.at > FC_TTL) && !seen.has(x.key)) { seen.add(x.key); need.push(x); } });
    const chunks = []; for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50));
    for (const ch of chunks) {
      const q = new URLSearchParams({ latitude: ch.map((x) => x.lat.toFixed(3)).join(','), longitude: ch.map((x) => x.lon.toFixed(3)).join(','),
        elevation: ch.map((x) => (x.z == null ? 'nan' : Math.round(x.z))).join(','), hourly: ENS_VARS.join(','), models: ENS_MODELS.join(','), forecast_days: '5', timeformat: 'unixtime', wind_speed_unit: 'ms', timezone: 'GMT' });
      const r = await fetchT(`${OM_FORECAST}?${q}`, {}, 45000); if (!r.ok) throw new Error('Open-Meteo models: HTTP ' + r.status);
      let j = await r.json(); if (!Array.isArray(j)) j = [j];
      j.forEach((f, k) => ensCache.set(ch[k].key, { at: now, t: f.hourly.time, h: f.hourly }));
    }
  }
  // the main forecast is Open-Meteo's best match: MET Nordic in Norway, scored as metno_seamless in the main forecast
  const ENS_MAIN = 'metno_seamless', ENS_AREAS = 4;
  const verifyRuns = new Map();
  function areaVerify(lat, lon) { const k = `${lat.toFixed(1)},${lon.toFixed(1)}`; if (!verifyRuns.has(k)) verifyRuns.set(k, WEFO.fetchVerify(lat, lon).catch(() => { verifyRuns.delete(k); return null; })); return verifyRuns.get(k); }
  async function weightAreas(dense, tops) {   // the scored areas of one line: start, end, the highest point and the middle -> [{km, m}]
    const d = dense, hi = tops.length ? tops.reduce((a, b) => ((d[b].z ?? 0) > (d[a].z ?? 0) ? b : a)) : Math.floor(d.length / 2);
    const pick = [0, d.length - 1, hi, Math.floor(d.length / 2)].slice(0, ENS_AREAS).map((i) => d[i]);
    const got = await Promise.all(pick.map((p) => areaVerify(p.lat, p.lon).then((v) => (v && v.models ? { km: p.km, m: v.models } : null))));
    return got.filter(Boolean);
  }
  const ensW = (A, km, m, key, far) => {   // a model's weight for one quantity at km (the nearest scored area), 1 if unknown; shrunk at range
    if (!A || !A.length) return 1;
    const a = A.reduce((b, x) => (Math.abs(x.km - km) < Math.abs(b.km - km) ? x : b)), w = a.m[m] && a.m[m].weights;
    const v = (w && (w[key] ?? (key === 'precip' ? w.weather : null))) || 1;
    return far ? Math.min(1.4, Math.max(0.75, 1 + (v - 1) * 0.5)) : v;
  };
  const wMedian = (vals) => { const v = vals.filter((x) => Number.isFinite(x.v)).sort((a, b) => a.v - b.v), tot = v.reduce((t, x) => t + x.w, 0); let c = 0; for (const x of v) { c += x.w; if (c >= tot / 2) return x.v; } return NaN; };
  function ensAt(key, ms) {   // each other model's weather class, temperature and precipitation at a place and time
    const c = ensCache.get(key); if (!c) return [];
    const x = (ms / 1000 - c.t[0]) / 3600; if (x < 0 || x > c.t.length - 1) return [];
    const i = Math.min(c.t.length - 2, Math.floor(x)), f = x - i, k = Math.min(c.t.length - 1, Math.ceil(x)), out = [];
    ENS_MODELS.forEach((m) => {
      const T = c.h['temperature_2m_' + m], P = c.h['precipitation_' + m], W = c.h['weather_code_' + m], G = c.h['wind_gusts_10m_' + m];
      if (!T || !Number.isFinite(T[i]) || !Number.isFinite(T[i + 1]) || !P || !W || P[k] == null || W[k] == null) return;
      const t = T[i] * (1 - f) + T[i + 1] * f; out.push({ m, t, mm: P[k], g: G && Number.isFinite(G[k]) ? G[k] : NaN, cls: classify(W[k], P[k], t) });
    });
    return out;
  }
  const WET = (c) => c !== 'dry' && c !== 'fog', SNOWY = (c) => c === 'snow' || c === 'sleet' || c === 'ice';
  // the five models' weighted votes for one point p (already holding the main forecast): doubt within 48 hours, the
  // majority beyond. o: {far, pass, gust (threshold), wAreas, km}. Sets p.vote and, when far, p.t / p.mm / p.g / p.cls.
  function vote(p, others, o) {
    const all = [{ m: ENS_MAIN, t: p.t, mm: p.mm, g: p.g, cls: p.cls }, ...others].map((v) => ({ ...v, wp: ensW(o.wAreas, o.km, v.m, 'precip', o.far), wt: ensW(o.wAreas, o.km, v.m, 'temperature_2m', o.far), ww: ensW(o.wAreas, o.km, v.m, 'wind', o.far) }));
    const tot = all.reduce((a, v) => a + v.wp, 0), fam = {}, cnt = {};
    all.forEach((v) => { const f = FAM[v.cls]; fam[f] = (fam[f] || 0) + v.wp / tot; cnt[f] = (cnt[f] || 0) + 1; });
    const gs = all.filter((v) => Number.isFinite(v.g)), gTot = gs.reduce((a, v) => a + v.ww, 0), gHi = gs.filter((v) => v.g >= o.gust);
    p.vote = { fam, cnt, gust: gTot ? gHi.reduce((a, v) => a + v.ww, 0) / gTot : 0, gustN: gHi.length, main: p.cls };
    if (!o.far) return;
    p.t = wMedian(all.map((v) => ({ v: v.t, w: v.wt }))); p.mm = wMedian(all.map((v) => ({ v: v.mm, w: v.wp })));
    if (gs.length) p.g = wMedian(gs.map((v) => ({ v: v.g, w: v.ww })));
    const wetS = all.filter((v) => WET(v.cls)).reduce((a, v) => a + v.wp, 0) / tot, main = p.cls;
    if (wetS > 0.5 && o.pass && WET(main)) p.cls = main;   // at a pass MET Nordic decides the kind
    else {
      const pool = all.filter((v) => WET(v.cls) === wetS > 0.5), by = (key, list) => { const c = {}; list.forEach((v) => { c[key(v)] = (c[key(v)] || 0) + v.wp; }); return c; };
      const top = (c, pref) => Object.entries(c).sort((a, b) => b[1] - a[1] || (a[0] === pref ? -1 : b[0] === pref ? 1 : 0))[0][0];
      const f = top(by((v) => FAM[v.cls], pool), FAM[main]);
      p.cls = top(by((v) => v.cls, pool.filter((v) => FAM[v.cls] === f)), main);
    }
  }
  // the doubt in words: only a worse alternative than what a stretch shows, by severity, with where and when
  const FAM = { dry: 'dry', fog: 'fog', wet: 'rain', heavy: 'rain', sleet: 'sleet', snow: 'snow', ice: 'ice', thunder: 'thunder' };
  const FAM_RANK = { dry: 0, fog: 1, rain: 2, sleet: 3, snow: 4, ice: 5, thunder: 6 };
  // [family, share needed, models needed]: freezing rain is worth knowing at 10 %; rain where the stage is dry only at 35 % and two models
  const ENS_ALTS = [['ice', 0.1, 1], ['thunder', 0.2, 1], ['snow', 0.2, 1], ['sleet', 0.2, 1], ['rain', 0.35, 2]];
  const ENS_GUST = [0.25, 2];
  function ensHints(pts, cls) {   // [{f, share, p}], the most severe first, at most two
    const v = pts.filter((p) => p.vote); if (!v.length) return [];
    const shown = FAM_RANK[FAM[cls]], slick = pts.some((p) => p.slick), out = [];
    ENS_ALTS.forEach(([f, need, n]) => {
      if (FAM_RANK[f] <= shown) return;
      if ((f === 'snow' || f === 'sleet' || f === 'ice') && slick) return;   // "mulig glatt" says it already
      const c = v.filter((p) => (p.vote.fam[f] || 0) >= need && (p.vote.cnt[f] || 0) >= n && (f === 'rain' || f === 'thunder' || p.t <= 4 || p.top));
      if (!c.length || out.some((h) => (h.f === 'snow' || h.f === 'sleet') && (f === 'snow' || f === 'sleet'))) return;
      const p = c.reduce((a, b) => (b.vote.fam[f] > a.vote.fam[f] ? b : a)); out.push({ f, share: p.vote.fam[f], p });
    });
    if (!pts.some((p) => p.gust)) { const c = v.filter((p) => p.vote.gust >= ENS_GUST[0] && p.vote.gustN >= ENS_GUST[1]); if (c.length) { const p = c.reduce((a, b) => (b.vote.gust > a.vote.gust ? b : a)); out.push({ f: 'gust', share: p.vote.gust, p }); } }
    return out.slice(0, 2);
  }
  function keyPoints(samples) {   // the key points: the passes and one about every 25 km
    let last = -1e9; return samples.filter((x) => { if (x.top || x.km - last >= ENS_KM) { last = x.km; return true; } return false; });
  }
  function nearKey(samples, kp) {   // each sample's nearest key point within 12 km along the line -> [key | null]
    return samples.map((x) => { let b = null; kp.forEach((q) => { if (Math.abs(q.km - x.km) <= ENS_REACH_KM && (!b || Math.abs(q.km - x.km) < Math.abs(b.km - x.km))) b = q; }); return b ? b.key : null; });
  }

  /* ---------------- stretches and crossings ---------------- */
  function segments(pts, w) {   // run-length merge of classes; a one-sample run between two others joins the worse neighbour
    const runs = [];
    pts.forEach((p, i) => { const r = runs[runs.length - 1]; if (r && r.cls === p.cls) r.b = i; else runs.push({ cls: p.cls, a: i, b: i }); });
    const out = [];
    runs.forEach((r, i) => {
      const prev = out[out.length - 1], next = runs[i + 1];
      if (r.a === r.b && prev && next && w[r.cls] <= Math.max(w[prev.cls], w[next.cls])) {   // never hide weather worse than both neighbours
        if (w[next.cls] > w[prev.cls]) next.a = r.a; else prev.b = r.b;
        return;
      }
      if (prev && prev.cls === r.cls) prev.b = r.b; else out.push({ ...r });
    });
    return out;
  }
  function crossings(pts) {   // 0 °C crossings in the order you travel, with ±1 °C hysteresis; the start counts by its sign
    const out = []; let st = null;
    pts.forEach((p, i) => {
      if (!Number.isFinite(p.t)) return;
      if (st === null) { st = p.t > 0 ? '+' : '-'; return; }
      const s = p.t >= 1 ? '+' : p.t <= -1 ? '-' : null;
      if (s && s !== st) { out.push({ i, dir: s === '-' ? 'down' : 'up' }); st = s; }
    });
    return out;
  }

  /* ---------------- MET warnings ---------------- */
  let alerts = [];
  function inRing(pt, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
  function inGeom(lon, lat, g) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.some((p) => inRing([lon, lat], p[0]) && !p.slice(1).some((h) => inRing([lon, lat], h)));
  }
  function alertAt(p) {   // p: {lat, lon, at}
    for (const a of alerts) {
      if (a.from && p.at < new Date(a.from)) continue;
      if (a.to && p.at > new Date(a.to)) continue;
      if (a.bbox && (p.lon < a.bbox[0] || p.lon > a.bbox[2] || p.lat < a.bbox[1] || p.lat > a.bbox[3])) continue;
      if (inGeom(p.lon, p.lat, a.geometry)) return `${a.name}${a.level ? ' (' + t('kv.level.' + a.level) + ')' : ''}`;
    }
    return null;
  }
  async function loadAlerts() {
    const j = await WEFO.fetchAlerts(LANG).catch(() => null);
    alerts = j && Array.isArray(j.alerts) ? j.alerts.filter((a) => a.domain !== 'marine' && a.geometry).map((a) => {
      const all = (a.geometry.type === 'Polygon' ? [a.geometry.coordinates] : a.geometry.coordinates).flat(2);
      return { ...a, bbox: [Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[1])), Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[1]))] };
    }) : [];
  }

  /* ---------------- the map: MapLibre with terrain and the shadow map's 2D / 3D button; Leaflet where WebGL is missing ----------------
     glMap(container, onLoad) builds the base (OpenStreetMap under Kartverket, the terrain source, the controls, the theme),
     calls onLoad(m) for the caller's own sources and layers, and resolves with the map. Points are [lat, lon]. */
  const BASE_TILES = {
    kartverket: { tiles: ['https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png'], maxzoom: 18, attribution: '© Kartverket' },
    osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap' },
  };
  const NORWAY = [[57.9, 4.6], [71.2, 31.1]];   // [[south, west], [north, east]]
  const hasGL = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } })();
  const isDark = () => (typeof effectiveTheme === 'function' ? effectiveTheme() === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  function glTheme(m) {   // dark theme: the map's lightness turned around, colours kept (as the Leaflet maps do with a CSS filter)
    if (!m || !m.getLayer('base')) return;
    const d = isDark();
    ['osm', 'base'].forEach((id) => { m.setPaintProperty(id, 'raster-brightness-min', d ? 0.92 : 0); m.setPaintProperty(id, 'raster-brightness-max', d ? 0.06 : 1); m.setPaintProperty(id, 'raster-saturation', d ? -0.25 : 0); });
  }
  function glMap(container, onLoad, onTheme) {
    return smLoadLib().then(() => new Promise((res) => {   // MapLibre is loaded on first use, shared with the shadow map
      const m = new maplibregl.Map({ container, bounds: [[NORWAY[0][1], NORWAY[0][0]], [NORWAY[1][1], NORWAY[1][0]]], pitch: 0, maxPitch: 60, attributionControl: { compact: true },
        // no paint transitions: with 3D terrain MapLibre draws layers onto the ground once per change (see the shadow map)
        style: { version: 8, transition: { duration: 0, delay: 0 }, sources: {
          osm: { type: 'raster', tileSize: 256, ...BASE_TILES.osm },   // under Kartverket: shows where Kartverket's map is empty (abroad)
          base: { type: 'raster', tileSize: 256, ...BASE_TILES.kartverket },
          contours: { type: 'raster', tileSize: 512, maxzoom: 18, attribution: '© Kartverket', tiles: ['https://wms.geonorge.no/skwms1/wms.kartdata?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=TRUE&STYLES=&WIDTH=512&HEIGHT=512&CRS=EPSG:3857&LAYERS=kd_hoydekurver&BBOX={bbox-epsg-3857}'] },   // Kartverket's contour lines (CC BY 4.0), over OpenStreetMap only
          dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 12, encoding: 'terrarium', attribution: 'Terreng: Mapzen/AWS' },
        }, layers: [{ id: 'osm', type: 'raster', source: 'osm' },
          { id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#ffffff', 'hillshade-illumination-direction': 315 } },   // relief over OpenStreetMap (Kartverket's map has its own); light from the north-west as on Kartverket's, kept light so valleys do not turn to grey at zoom 8–11
          { id: 'contours', type: 'raster', source: 'contours', minzoom: 11, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 } },   // the WMS draws nothing useful below zoom 11
          { id: 'base', type: 'raster', source: 'base' }] } });
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: false }), 'top-left');   // the compass; zooming is the wheel, a pinch or a double tap
      m.addControl(new SmTiltControl(), 'top-left');   // the same 2D / 3D button as the shadow map
      const spec = document.getElementById(container).__ctrls; if (spec) addMapControls(m, spec);   // the planners' switches, registered before the map existed
      m.on('load', () => {
        m.setTerrain({ source: 'dem', exaggeration: 1.5 });
        // tilted: one zoom level for the whole base map (the near one), instead of coarser tiles towards the horizon; up to 30 times the tiles of a flat view
        if (m.setSourceTileLodParams) ['osm', 'base'].forEach((id) => m.setSourceTileLodParams(1, 30, id));
        if (onLoad) onLoad(m);
        glTheme(m); applyBase(m);
        // the (i) attribution starts folded (MapLibre opens it on wide maps), as on the shadow map
        const at = m.getContainer().querySelector('.maplibregl-ctrl-attrib'); if (at) at.classList.remove('maplibregl-compact-show');
        const retheme = () => { glTheme(m); if (onTheme) onTheme(m); };   // the line colours follow the theme too
        new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
        res(m);
      });
    }));
  }
  // the base map: Kartverket's topographic map, or OpenStreetMap (which lies under it anyway); the choice is kept in the browser
  const baseChoice = () => (lsGet('glett.map.base') === 'osm' ? 'osm' : 'kartverket');
  const setBaseChoice = (id) => lsSet('glett.map.base', id === 'osm' ? 'osm' : null);
  // OpenStreetMap under Kartverket's map is only loaded when the view reaches beyond Norway (Sweden, Finland, Russia, or outside
  // Kartverket's extent): inside Norway it would cost tiles and time for nothing. The country outlines are Kjørevær's js/borders.js.
  let bordersReady = null;
  const loadBorders = () => (bordersReady ||= new Promise((res) => {
    if (typeof KV_ABROAD !== 'undefined') return res(true);
    const sc = document.createElement('script'); sc.src = 'js/borders.js?v=' + ((document.querySelector('script[src*="js/kvcore.js"]') || {}).src || '').split('v=')[1];
    sc.onload = () => res(true); sc.onerror = () => res(false); document.head.appendChild(sc);
  }));
  const inRingLL = (la, lo, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [yi, xi] = r[i], [yj, xj] = r[j]; if ((yi > la) !== (yj > la) && lo < (xj - xi) * (la - yi) / (yj - yi) + xi) c = !c; } return c; };
  const abroad = (la, lo) => typeof KV_ABROAD !== 'undefined' && Object.values(KV_ABROAD).some((rings) => rings.some((r) => inRingLL(la, lo, r)));
  const needOsm = (m) => {
    if (m.getZoom() < 5) return true;
    const b = m.getBounds(), s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) {
      const la = s + (n - s) * i / 3, lo = w + (e - w) * j / 3;
      if (la < NORWAY[0][0] || la > NORWAY[1][0] || lo < NORWAY[0][1] || lo > NORWAY[1][1] || abroad(la, lo)) return true;
    }
    return false;
  };
  const applyBase = (m) => {
    if (!m || !m.getLayer || !m.getLayer('base')) return; const osm = baseChoice() === 'osm';
    m.setLayoutProperty('base', 'visibility', osm ? 'none' : 'visible');
    ['hillshade', 'contours'].forEach((id) => { if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', osm ? 'visible' : 'none'); });
    const want = osm || needOsm(m) ? 'visible' : 'none'; if (m.getLayoutProperty('osm', 'visibility') !== want) m.setLayoutProperty('osm', 'visibility', want);
    if (!m.__osmWired) { m.__osmWired = true; let tm = 0; m.on('moveend', () => { clearTimeout(tm); tm = setTimeout(() => applyBase(m), 150); }); loadBorders().then(() => applyBase(m)); }
  };
  const BASE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 5-9 5-9-5 9-5zM3 14l9 5 9-5"/></svg>';
  const baseLabel = (btn) => { btn.innerHTML = `${BASE_ICON}<span>${t(baseChoice() === 'osm' ? 'kv.map.osm' : 'kv.map.kartverket')}</span>`; btn.setAttribute('aria-pressed', baseChoice() === 'osm' ? 'true' : 'false'); btn.title = t('kv.map.base'); };
  const glMark = (m, p, text, cls, title) => {   // a text marker at [lat, lon]
    const el = document.createElement('div'); el.className = cls; el.textContent = text; if (title) el.title = title;
    return new maplibregl.Marker({ element: el }).setLngLat([+p[1], +p[0]]).addTo(m);
  };
  const lineFeature = (coords, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[1], c[0]]) } });

  window.KVCore = { fetchT, pad2, hm, wday, dayKey, hav, dur, cssv, cellKey, depOptions, depAxis, wireDepAxis, fullMap, phoneMap, phoneLike, mapControls, elevate, fetchForecast, classify, KV_CLASSES, wxAt,
    fetchEnsemble, keyPoints, nearKey, weightAreas, ensAt, ensW, wMedian, vote, ensHints, FAM, FAM_RANK, WET, SNOWY, segments, crossings, alertAt, loadAlerts, WX_VARS,
    BASE_TILES, NORWAY, hasGL, isDark, glMap, glTheme, glMark, lineFeature, baseChoice, setBaseChoice, applyBase, baseLabel };
})();
