'use strict';
/* ================= Nattplass: quiet places to stop for the night by car or motorhome =================
   Suggestions in Norway, Sweden and Finland, computed offline from open data (tools/camp/: OpenStreetMap, Statens vegvesen's
   NVDB, Kartverket's 1 m terrain and surface models; in Finland NLS' 2 m terrain and the Forest Centre's canopy heights) and served as static tiles in data/natt/: a place by a minor road, near
   water, away from houses and main roads, with room to stop (measured in the terrain where we could), and reachable without
   passing a closed barrier. Each spot carries its way in from the public road network (the last stretch, with the barriers on
   it: cattle grids, toll gates, unknown gates); a route to it is Valhalla to that hand-off point, checked against the closed
   barriers we know of (avoided and asked again), plus the way in. Tonight's weather comes through the engine shared with
   Kjørevær (js/kvcore.js). Nothing here says you may legally stay: the page says so. */
(function () {
  const { fetchT, hav, fetchForecast, wxAt, WX_VARS, glMap, glMark, lineFeature, hasGL, mapControls, baseChoice, setBaseChoice, applyBase, baseLabel, fullMap } = KVCore;
  const DATA = 'data/natt/';
  const RADII = [10, 25, 50];
  const SPAN_MAX = 250;                     // km, the longest side of an area drawn on the map
  const LIST_N = 12, WX_N = 30;             // spots in the list; spots that get tonight's weather (one Open-Meteo request)
  const NIGHT = [20, 8];                    // the night: 20:00 to 08:00, local time
  const ROUTE_TRIES = 3, BAR_HIT_M = 6, BAR_ANG = 35;   // re-route round closed barriers at most this often; a barrier this close to the line, on a road that runs
                                                        // the same way (±35°), is on it: one on a side road that starts at a junction of the route is not
  const VARS = [...WX_VARS, 'wind_speed_10m', 'cloud_cover'];
  const BCOL = { closed: '#dc2626', unknown: '#f59e0b', toll: '#7c3aed', pass: '#16a34a' };
  const np = { center: null, origin: null, r: 25, veh: 'car', night: 0, mode: 'n', opts: { water: true, tent: false, lay: false, gravel: false, gate: false }, bars: false,
    idx: null, list: [], all: [], found: [], sel: null, route: null, busy: 0, box: null, ref: {}, sun: false, drawing: false };
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } return v; };
  const km = (m) => (m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1).replace('.', LANG === 'nb' ? ',' : '.'));
  const status = (msg, cls) => { const s = $('npStatus'); s.hidden = !msg; s.className = 'kv-status' + (cls ? ' ' + cls : ''); s.textContent = msg || ''; };

  /* ---------------- data: index, spot cells, way-in cells, barrier cells ---------------- */
  let idxP = null;
  function built() {   // "spots last built" under How the spots are found: the index's v is the build time, yyyymmddhhmm
    const el = $('npBuilt'), v = String((np.idx && np.idx.v) || '');
    if (!el || v.length < 8) return;
    el.textContent = t('np.built', { d: new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)).toLocaleDateString(LANG === 'nb' ? 'nb-NO' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) });
    el.hidden = false;
  }
  const loadIndex = () => (idxP ||= fetch(DATA + 'index.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('index ' + r.status); return r.json(); }).then((j) => {
    np.idx = j; built();
    return j;
  }));
  const cellKey = (la, lo) => `${Math.floor(la * 2)}_${Math.floor(lo)}`;
  const files = new Map();
  const getJSON = (path) => {
    if (!files.has(path)) files.set(path, fetch(`${DATA}${path}?v=${np.idx.v}`).then((r) => (r.ok ? r.json() : [])).catch(() => { files.delete(path); return []; }));
    return files.get(path);
  };
  const cellsAround = (la, lo, rKm) => {   // the cell keys a circle touches
    const dLa = rKm / 111, dLo = rKm / (111 * Math.cos(la * Math.PI / 180)), out = [];
    for (let a = Math.floor((la - dLa) * 2); a <= Math.floor((la + dLa) * 2); a++) for (let b = Math.floor(lo - dLo); b <= Math.floor(lo + dLo); b++) out.push(`${a}_${b}`);
    return out;
  };
  // a row of a spot file as an object (the field names are in index.json), with where it came from: country, cell, row
  const asObj = (row, f, cc, key, i) => { const o = { cc, key, i }; f.forEach((n, j) => { o[n] = row[j]; }); return o; };
  async function loadSpots(keys) {
    const idx = await loadIndex(), out = [];
    await Promise.all(Object.entries(idx.cells).flatMap(([cc, c]) => keys.filter((k) => c.s.includes(k)).map(async (k) => {
      (await getJSON(`${cc}/s/${k}.json`)).forEach((row, i) => out.push(asObj(row, idx.f.s, cc, k, i)));
    })));
    return out;
  }
  async function loadBars(keys) {
    const idx = await loadIndex(), out = [];
    await Promise.all(Object.entries(idx.cells).flatMap(([cc, c]) => keys.filter((k) => c.b.includes(k)).map(async (k) => {
      (await getJSON(`${cc}/b/${k}.json`)).forEach((row) => out.push(asObj(row, idx.f.b, cc, k)));
    })));
    return out;
  }
  async function wayIn(s) {   // the stretch from the public road to the spot: {coords: [[lat, lon]...], m, bars: [...]}, with the open area's
    const idx = await loadIndex(), a = (await getJSON(`${s.cc}/a/${s.key}.json`))[s.i];   // outline (ol) and the nearest services' names (nm)
    if (!a) return null;
    return { coords: a[0] ? decode5(a[0]) : [], m: a[1] || 0, bars: (a[2] || []).map((b) => asObj(b, idx.f.b, s.cc)), ol: a[3] ? decode5(a[3]) : null, nm: a[4] || [] };
  }
  function decode5(str) {
    let i = 0, la = 0, lo = 0; const out = [];
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let sh = 0, r = 0, b;
        do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
        const d = r & 1 ? ~(r >> 1) : r >> 1; if (k) lo += d; else la += d;
      }
      out.push([la / 1e5, lo / 1e5]);
    }
    return out;
  }

  /* ---------------- what a spot is, in words ---------------- */
  const KIND = { v: 'np.k.v', p: 'np.k.p', s: 'np.k.s', l: 'np.k.l', r: 'np.k.r' };
  const WATER = { 1: 'np.w.lake', 2: 'np.w.sea', 3: 'np.w.river' };
  function title(s) {
    if (s.k === 'v' && s.wn) return t('np.t.by', { n: s.wn });
    if (s.k === 'v' && s.wk) return t(WATER[s.wk] + '.t');
    return t(KIND[s.k] || 'np.k.p');
  }
  const where = (s) => (s.pl ? t('np.t.near', { km: km(s.pd_km * 1000), p: s.pl }) : '');
  function reasons(s) {   // [icon, text, tone]  tone: good | warn | info
    const out = [];
    if (s.wk) out.push(['💧', t('np.r.water', { w: t(WATER[s.wk]).toLowerCase(), m: s.wd, n: s.wn ? ` (${s.wn})` : '' }), 'good']);
    if (s.k !== 'v') out.push(['🅿', t('np.r.mapped', { k: t(KIND[s.k]).toLowerCase() }), 'good']);
    else if (s.pad != null) out.push(['▭', t('np.r.pad', { a: s.pad >= 400 ? '400+' : s.pad }), 'good']);
    else out.push(['▭', t('np.r.nopad'), 'warn']);
    if (s.hb == null) out.push(['🏠', t('np.r.nohouse'), 'good']);
    else out.push(['🏠', t(s.h5 ? 'np.r.house' : 'np.r.house0', { m: s.hb, n: s.h5 }), s.hb >= 150 ? 'good' : 'info']);
    if (s.mj == null) out.push(['🛣', t('np.r.quiet'), 'good']);
    else out.push(['🛣', t('np.r.main', { km: km(s.mj) }), s.mj >= 800 ? 'good' : 'info']);
    const road = s.hw === 'track' ? t('np.road.track') : s.sf === 'g' ? t('np.road.gravel') : s.sf === 'a' ? t('np.road.asphalt') : t('np.road.unknown');
    out.push(['〰', road, s.hw === 'track' ? 'warn' : 'info']);
    if (s.pic) out.push(['🪑', t('np.r.pic'), 'good']);
    if (s.wp || s.bch) out.push(['🏊', t('np.r.swim'), 'good']);
    if (s.vw) out.push(['🔭', t('np.r.view'), 'good']);
    if (s.wc) out.push(['🚻', t('np.r.wc'), 'good']);
    if (np.mode !== 'd') out.push(['⛺', t(s.tent ? 'np.r.tent' : 'np.r.notent'), s.tent ? 'good' : 'info']);
    if (s.prot) out.push(['🌲', t(s.prot === 2 ? 'np.r.np' : 'np.r.prot'), 'warn']);
    if (s.st === 1) out.push(['⚠', t('np.r.gate'), 'warn']);
    if (s.z != null) out.push(['⛰', t('np.r.z', { z: s.z }), 'info']);
    return out;
  }
  const SVC = [['food', '🛒', 'fd'], ['fuel', '⛽', 'gd'], ['ev', '🔌', 'ed'], ['evf', '⚡', 'efd']];
  function svcHtml(s, nm) {   // the nearest food shop, fuel, charger and fast charger (final.py, OpenStreetMap), names once the way-in record is in
    if (s.fd === undefined) return '';
    const rows = SVC.filter(([k]) => !(k === 'ev' && s.ed != null && s.ed === s.efd)).map(([k, ic, f]) => {
      let name = nm && nm[SVC.findIndex((x) => x[0] === k)];
      if (name && name[0] === '@') name = t('np.svc.near', { p: name.slice(1) });   // no name in OpenStreetMap: where it is
      return `<li class="info"><span aria-hidden="true">${ic}</span><span>${esc(t('np.svc.' + k))}: ${s[f] == null ? esc(t('np.svc.none')) : `${name ? `<b>${esc(name)}</b>, ` : ''}${esc(t('np.svc.km', { km: km(s[f] * 1000) }))}`}</span></li>`;
    });
    return `<ul class="np-why np-svc">${rows.join('')}</ul><p class="hint">${esc(t('np.svc.note'))}</p>`;
  }
  const BAR_KIND = (b) => {
    const k = b.k || '';
    if (k === 'cattle_grid' || k === 'dyresperre') return t('np.b.grid');
    if (k === 'toll_booth' || b.c === 'toll') return t('np.b.toll');
    if (k === 'remote') return t('np.b.remote');
    if (/gate|bom|bar/.test(k)) return t('np.b.gate');
    if (k === 'bollard' || k === 'block') return t('np.b.block');
    return k.replace(/_/g, ' ') || t('np.b.gate');
  };
  const barText = (b) => `${BAR_KIND(b)} · ${t('np.bc.' + b.c)}`;
  // the facts behind a barrier (final.py binfo: 'f:Låst sperring|kat:S|...' or OpenStreetMap's 'acc:yes|fee:80') in words
  function barInfo(b) {
    if (!b.info) return '';
    const f = Object.fromEntries(b.info.split('|').map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)])), out = [];
    if (b.src === 'n') {
      if (f.f) out.push(f.f.replace(/_/g, ' '));
      if (f.bruk && /tunnel|ferje|fjellovergang|jernbane/i.test(f.bruk)) out.push(t('np.bi.event', { b: f.bruk.toLowerCase() }));
      if (f.kat) out.push(t('np.bi.kat.' + f.kat));
      if (f.winter) out.push(t('np.bi.winter'));
      out.push('NVDB');
    } else {
      if (f.acc) out.push(t(/^(no|private)$/.test(f.acc) ? 'np.bi.acc.no' : /^(yes|permissive|destination|designated)$/.test(f.acc) ? 'np.bi.acc.yes' : 'np.bi.acc', { a: f.acc }));
      if (f.locked) out.push(t(f.locked === 'yes' ? 'np.bi.locked' : 'np.bi.unlocked'));
      if (f.fee) out.push(/^(yes|no)$/.test(f.fee) ? t(f.fee === 'yes' ? 'np.bi.fee' : 'np.bi.nofee') : t('np.bi.feeis', { f: f.fee }));
      out.push('OpenStreetMap');
    }
    return out.join(' · ');
  }

  /* ---------------- tonight's weather at a spot ---------------- */
  function nightSpan(n) {   // [start, end] ms of the night n nights from now (0: tonight), local time; tonight starts now if it already has
    const d = new Date(); d.setHours(NIGHT[0], 0, 0, 0); d.setDate(d.getDate() + n);
    if (n === 0 && new Date().getHours() < NIGHT[1]) d.setDate(d.getDate() - 1);   // after midnight: the night we are in
    const end = new Date(d); end.setDate(end.getDate() + 1); end.setHours(NIGHT[1], 0, 0, 0);
    return [Math.max(+d, n === 0 ? Date.now() - 3600e3 : 0), +end];
  }
  function daySpan(n) {   // [start, end] ms of the day stop: the next 6 hours today, else 10:00 to 18:00 that day
    if (n === 0) { const a = Date.now(), e = new Date(); e.setHours(22, 0, 0, 0); return [a, Math.max(a + 3600e3, Math.min(a + 6 * 3600e3, +e))]; }   // today: up to 22:00
    const d = new Date(); d.setDate(d.getDate() + n); d.setHours(10, 0, 0, 0); return [+d, +d + 8 * 3600e3];
  }
  const span = () => (np.mode === 'd' ? daySpan(np.night) : nightSpan(np.night));
  const whenLabel = () => t((np.mode === 'd' ? 'np.day.' : 'np.night.') + np.night);
  const wxKey = (s) => `np:${s.la.toFixed(3)},${s.lo.toFixed(3)}`;
  function nightWx(s) {   // the weather over the stay: the night, or the day window
    const [a, b] = span(), hrs = [];
    for (let ms = a - a % 3600e3 + 3600e3; ms <= b; ms += 3600e3) { const w = wxAt(wxKey(s), ms); if (w) hrs.push({ ms, ...w }); }
    if (!hrs.length) return null;
    const num = (v) => (Number.isFinite(v) ? v : null);
    const ts = hrs.map((h) => num(h.t)).filter((v) => v != null), gs = hrs.map((h) => num(h.g)).filter((v) => v != null), ws = hrs.map((h) => num(h.wind)).filter((v) => v != null);
    const mm = hrs.reduce((x, h) => x + (h.mm || 0), 0), cl = hrs.map((h) => num(h.cloud)).filter((v) => v != null);
    const dh = hrs.filter((h) => num(h.t) != null && num(h.dew) != null), cold = dh.reduce((a, h) => (!a || h.t < a.t ? h : a), null);
    return { hrs, tmin: ts.length ? Math.min(...ts) : null, tmax: ts.length ? Math.max(...ts) : null, gust: gs.length ? Math.max(...gs) : null,
      wind: ws.length ? Math.max(...ws) : null, mm, cloud: cl.length ? cl.reduce((x, y) => x + y, 0) / cl.length : null,
      dew: cold ? cold.dew : null, spread: dh.length ? Math.min(...dh.map((h) => h.t - h.dew)) : null };   // dew point at the coldest hour; the closest the air comes to it
  }
  // the weather only nudges the order (the place leads): a wet or windy stay costs a few points
  const wxAdj = (w) => (!w ? 0 : -(w.mm >= 5 ? 6 : w.mm >= 1 ? 3 : 0) - (w.gust >= 15 ? 4 : w.gust >= 10 ? 2 : 0) - (np.mode === 'n' && w.tmin != null && w.tmin < -10 ? 2 : 0));
  const RAD = Math.PI / 180;
  function sunDec(ms) {   // the sun's declination that day, degrees
    const d = ms / 864e5 - 10957.5, g = (357.529 + 0.98560028 * d) * RAD, L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    return Math.asin(Math.sin((23.439 - 3.6e-7 * d) * RAD) * Math.sin(L)) / RAD;
  }
  function sunAz(la, ms) {   // compass direction (° from north) of sunrise and sunset; {up: true} in midnight sun, {up: false} in polar night
    const dec = sunDec(ms) * RAD, f = la * RAD, h0 = -0.833 * RAD;
    const c = (Math.sin(dec) - Math.sin(h0) * Math.sin(f)) / (Math.cos(h0) * Math.cos(f));
    if (c < -1) return { up: true };
    if (c > 1) return { up: false };
    const a = Math.acos(c) / RAD; return { rise: a, set: 360 - a };
  }
  function starry(s, w) {   // a clear night: does it get dark (sun 12° below the horizon at midnight), and how much of the moon is lit
    if (!w || w.cloud == null || w.cloud > 25 || w.mm >= 0.2) return null;
    const ms = nightSpan(np.night)[0] + 4 * 3600e3;   // the night of the chosen date
    const dark = s.la + sunDec(ms) - 90 < -12;
    const age = (((ms - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % 29.530589 + 29.530589) % 29.530589;
    return { dark, moon: Math.round((1 - Math.cos(2 * Math.PI * age / 29.530589)) / 2 * 100) };
  }
  function dewHtml(w) {   // the dew point, and whether dew, condensation or frost is likely (air close to saturation, or a clear calm night)
    if (!w || w.dew == null || w.spread == null) return '';
    const calm = w.cloud != null && w.cloud < 30 && (w.wind ?? 9) < 3;
    const wet = w.spread <= 3 || (calm && w.spread <= 5);
    const txt = wet ? t(w.tmin != null && w.tmin <= 0.5 ? 'np.dew.frost' : 'np.dew.wet') : w.spread > 6 ? t('np.dew.dry') : '';
    return `<p class="np-dew${wet ? ' wet' : ''}"><span aria-hidden="true">💧</span>${esc(t('np.dew', { d: Math.round(w.dew) }))}${txt ? ' · ' + esc(txt) : ''}</p>`;
  }
  function starsHtml(s, w) {
    const st = starry(s, w); if (!st) return '';
    const moon = st.moon >= 60 ? t('np.stars.moon', { p: st.moon }) : st.moon <= 25 ? t('np.stars.dark') : '';
    return `<div class="np-stars${st.dark ? '' : ' light'}"><b>${st.dark ? '✨ ' : ''}${esc(t('np.stars'))}</b><small>${esc(st.dark ? `${t('np.stars.t')} ${moon}` : t('np.stars.light'))}</small></div>`;
  }
  function wxChips(w, s) {
    if (!w) return `<span class="np-wx muted">${esc(t('np.wx.none'))}</span>`;
    const rain = w.mm >= 0.5 ? t('np.wx.rain', { mm: w.mm < 10 ? w.mm.toFixed(1).replace('.', LANG === 'nb' ? ',' : '.') : Math.round(w.mm) }) : t('np.wx.dry');
    const cls = w.mm >= 5 || w.gust >= 15 ? 'bad' : w.mm >= 1 || w.gust >= 10 ? 'mid' : 'good';
    const st = np.mode === 'n' && s && starry(s, w), star = st && st.dark ? ` · <span class="np-star" title="${esc(t('np.stars'))}">✨ ${esc(t('np.stars'))}</span>` : '';
    return `<span class="np-wx ${cls}"><b>${Math.round(np.mode === 'd' ? w.tmax : w.tmin)}°</b> · ${esc(rain)} · ${esc(t('np.wx.wind', { w: Math.round(w.wind ?? 0), g: Math.round(w.gust ?? 0) }))}${star}</span>`;
  }
  function sunTimes(la, lo, ms) {   // sunset that evening and sunrise next morning (NOAA's approximation; null in polar day or night)
    const rad = Math.PI / 180, day = (x) => { const d = new Date(x); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
    const at = (dayMs, rise) => {
      const n = Math.ceil((dayMs - Date.UTC(2000, 0, 1, 12)) / 864e5) + 0.0008, J = n - lo / 360;
      const M = (357.5291 + 0.98560028 * J) % 360, C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
      const L = (M + C + 180 + 102.9372) % 360, Jt = 2451545 + J + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
      const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.44 * rad)), cw = (Math.sin(-0.833 * rad) - Math.sin(la * rad) * Math.sin(dec)) / (Math.cos(la * rad) * Math.cos(dec));
      if (cw < -1 || cw > 1) return null;
      const w = Math.acos(cw) / rad, j = rise ? Jt - w / 360 : Jt + w / 360;
      return (j - 2440587.5) * 864e5;
    };
    const d0 = day(ms); return { set: at(d0, false), rise: at(d0 + 864e5, true) };
  }
  // the terrain's horizon round a spot, from the same elevation tiles as the shadow on the map (Terrarium): per whole degree of
  // azimuth the highest angle up to 30 km away, seen 2 m above the ground, with the earth's curve and normal refraction. Detailed
  // close in (zoom 13, about 10 m), coarser far out (zoom 11 to 8 km, zoom 9 to 30 km)
  const TERR = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium', demTiles = new Map(), skylines = new Map();
  const SKY_LV = [[13, 1500], [11, 8000], [9, 30000]];
  function demTile(z, x, y) {   // metres per pixel of one 256 px tile (the sea floor counts as sea level), null if it fails
    const k = `${z}/${x}/${y}`;
    if (!demTiles.has(k)) {
      if (demTiles.size > 150) demTiles.clear();
      demTiles.set(k, new Promise((ok) => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = c.height = 256;
          const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
          const p = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
          for (let i = 0; i < 65536; i++) h[i] = Math.max(0, p[4 * i] * 256 + p[4 * i + 1] + p[4 * i + 2] / 256 - 32768);
          ok(h);
        };
        img.onerror = () => ok(null);
        img.src = `${TERR}/${z}/${x}/${y}.png`;
      }));
    }
    return demTiles.get(k);
  }
  const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
  const tileY = (lat, z) => { const r = lat * RAD; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
  function skyline(la, lo) {   // Float32Array(360): the horizon's height in degrees per azimuth (0 = north), or null
    const key = `${la.toFixed(4)},${lo.toFixed(4)}`;
    if (skylines.has(key)) return skylines.get(key);
    const job = (async () => {
      const lv = await Promise.all(SKY_LV.map(async ([z, R]) => {
        const dLa = R / 110540, dLo = R / (111320 * Math.cos(la * RAD)), g = new Map(), jobs = [];
        for (let x = Math.floor(tileX(lo - dLo, z)); x <= Math.floor(tileX(lo + dLo, z)); x++)
          for (let y = Math.floor(tileY(la + dLa, z)); y <= Math.floor(tileY(la - dLa, z)); y++) jobs.push(demTile(z, x, y).then((h) => g.set(`${x}/${y}`, h)));
        await Promise.all(jobs);
        return { z, R, g };
      }));
      const px = (L, ix, iy) => { const h = L.g.get(`${ix >> 8}/${iy >> 8}`); return h ? h[(iy & 255) * 256 + (ix & 255)] : NaN; };
      const at = (L, lat, lon) => {   // bilinear, across tile edges
        const fx = tileX(lon, L.z) * 256 - 0.5, fy = tileY(lat, L.z) * 256 - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
        return (px(L, ix, iy) * (1 - u) + px(L, ix + 1, iy) * u) * (1 - v) + (px(L, ix, iy + 1) * (1 - u) + px(L, ix + 1, iy + 1) * u) * v;
      };
      const h0 = at(lv[0], la, lo) + 2;
      if (!Number.isFinite(h0)) return null;
      const ds = []; for (let d = 15; d <= 30000; d += Math.max(15, d * 0.02)) ds.push(d);
      const hz = new Float32Array(360), kLa = 1 / 110540, kLo = 1 / (111320 * Math.cos(la * RAD));
      for (let a = 0; a < 360; a++) {
        const sa = Math.sin(a * RAD), ca = Math.cos(a * RAD); let best = -90;
        for (const d of ds) {
          const L = d <= lv[0].R ? lv[0] : d <= lv[1].R ? lv[1] : lv[2], h = at(L, la + d * ca * kLa, lo + d * sa * kLo);
          if (!Number.isFinite(h)) continue;
          const e = Math.atan2(h - h0 - (0.87 * d * d) / 12742000, d) / RAD;
          if (e > best) best = e;
        }
        hz[a] = Math.max(best, -2);
      }
      return hz;
    })().catch(() => null);
    skylines.set(key, job);
    return job;
  }
  // the sun on the spot with the terrain: of the 24 hours from noon on the day of ms, the longest stretch without direct sun is the
  // night behind the hills, so the evening sun lasts until it starts and the morning sun comes when it ends. {set, rise} as ms, with
  // the sun's direction then; {never} if the sun does not clear the terrain at all, {always} if it never leaves it
  const sunVis = (la, lo, hz, ms) => {   // the sun's upper edge above the terrain (refraction as the flat-horizon times use it)
    const p = sunPos(ms, la, lo); if (p.el < -2) return false;
    return p.el + 1.02 / Math.tan((p.el + 10.3 / (p.el + 5.11)) * RAD) / 60 + 0.27 > hz[Math.round(p.az) % 360];
  };
  function moonPos(ms, la, lo) {   // the moon's direction and height (low precision, a degree or two; no parallax): {az, el} in degrees
    const d = ms / 864e5 - 10957.5, L = 218.316 + 13.176396 * d, M = (134.963 + 13.064993 * d) * RAD, F = (93.272 + 13.22935 * d) * RAD;
    const lam = (L + 6.289 * Math.sin(M)) * RAD, bet = 5.128 * Math.sin(F) * RAD, e = 23.439 * RAD;
    const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(bet) * Math.sin(e), Math.cos(lam)), dec = Math.asin(Math.sin(bet) * Math.cos(e) + Math.cos(bet) * Math.sin(e) * Math.sin(lam));
    const ha = (((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lo) * RAD - ra, f = la * RAD;
    const el = Math.asin(Math.sin(f) * Math.sin(dec) + Math.cos(f) * Math.cos(dec) * Math.cos(ha));
    const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(f) - Math.sin(f) * Math.cos(ha));
    return { az: (az / RAD + 360) % 360, el: el / RAD };
  }
  function terrainSun(la, lo, hz, ms) {
    if (!hz || typeof sunPos !== 'function') return null;
    const d = new Date(ms); d.setHours(12, 0, 0, 0);
    const t0 = +d, STEP = 60000, vis = [];
    for (let t = t0; t <= t0 + 864e5; t += STEP) vis.push(sunVis(la, lo, hz, t));
    if (!vis.includes(true)) return { never: true };
    if (!vis.includes(false)) return { always: true };
    let best = [0, 0];
    for (let i = 0; i < vis.length;) {
      if (vis[i]) { i++; continue; }
      let j = i; while (j < vis.length && !vis[j]) j++;
      if (j - i > best[1] - best[0]) best = [i, j];
      i = j;
    }
    const set = best[0] > 0 ? t0 + best[0] * STEP : null, rise = best[1] < vis.length ? t0 + best[1] * STEP : null;
    return { set, rise, setAz: set && sunPos(set, la, lo).az, riseAz: rise && sunPos(rise, la, lo).az };
  }
  function sunLine(s, sun) {   // the line under the night's weather: with the terrain when it is known
    const ts = s.hz && terrainSun(s.la, s.lo, s.hz, span()[0]), flat = t('np.sun', { s: sun.set ? fmtHM(sun.set) : '–', r: sun.rise ? fmtHM(sun.rise) : '–' });
    if (!ts || ts.always) return flat;
    if (ts.never) return `${t('np.sun.never')} ${flat}.`;
    const near = (a, b) => a && b && Math.abs(a - b) < 5 * 60000;
    if (near(ts.set, sun.set) && near(ts.rise, sun.rise)) return flat;
    return t('np.sun.t', { s: ts.set ? fmtHM(ts.set) : '–', r: ts.rise ? fmtHM(ts.rise) : '–', s0: sun.set ? fmtHM(sun.set) : '–', r0: sun.rise ? fmtHM(sun.rise) : '–' });
  }

  /* ---------------- the search: spots within the radius, filtered, the best with tonight's weather ---------------- */
  const keepSpot = (s) => {
    const o = np.opts;
    const day = np.mode === 'd';
    if (!day && !o.lay && (s.k === 'l' || s.k === 'r')) return false;
    if (o.water && !s.wk) return false;
    if (!day && o.tent && !s.tent) return false;
    if (o.gate && s.st !== 0) return false;
    if (o.gravel && (s.sf === 'g' || s.hw === 'track')) return false;
    if (np.veh === 'van' && (s.hw === 'track' || (s.pad != null && s.pad < 80))) return false;
    return true;
  };
  const REF = [   // filters on the spots found: [key, icon, test, modes (n night, d day)]; the page shows how many would be left with each
    ['sea', '🌊', (s) => s.wk === 2, 'nd'], ['lake', '💧', (s) => s.wk === 1, 'nd'],
    ['pic', '🪑', (s) => !!s.pic, 'd'], ['swim', '🏊', (s) => !!(s.wp || s.bch), 'd'], ['rest', '🅿', (s) => s.k === 'r' || s.k === 'l' || s.k === 'p', 'd'],
    ['wc', '🚻', (s) => !!s.wc, 'd'], ['view', '🔭', (s) => !!s.vw, 'd'],
    ['nohouse', '🏠', (s) => s.hb == null || s.hb >= 300, 'n'], ['quiet', '🤫', (s) => s.mj == null || s.mj >= 1000, 'n'],
    ['nobar', '🚧', (s) => !s.nb && s.st === 0, 'nd'], ['big', '▭', (s) => s.pad >= 100 || s.k === 'p' || s.k === 'r', 'nd'],
    ['food', '🛒', (s) => s.fd != null && s.fd <= 10, 'nd'], ['fuel', '⛽', (s) => s.gd != null && s.gd <= 15, 'nd'],
    ['ev', '🔌', (s) => s.ed != null && s.ed <= 15, 'nd'], ['evf', '⚡', (s) => s.efd != null && s.efd <= 30, 'nd'],
    ['noprot', '🌲', (s) => !s.prot, 'nd'],
  ];
  // the place's score for the stay: the offline score is made for the night (houses within 150 m, quiet); by day the houses do not
  // count, quiet counts half, and tables, bathing, views, toilets and mapped rest areas add
  function placeScore(s, mode = np.mode) {
    if (mode !== 'd') return s.sc;
    const hb = s.hb == null ? 2000 : s.hb, h5 = s.h5 || 0, mj = s.mj == null ? 5000 : s.mj;
    const house = (hb >= 300 ? 15 : hb >= 150 ? 10 : hb >= 80 ? 3 : 0) + (h5 === 0 ? 10 : h5 <= 3 ? 7 : h5 <= 10 ? 3 : 0);
    const quiet = (mj >= 2000 ? 10 : mj >= 800 ? 7 : mj >= 300 ? 3 : 0) / 2;
    const day = (s.k === 'r' ? 10 : s.k === 'l' || s.k === 'p' ? 5 : 0) + (s.pic ? 8 : 0) + (s.wp || s.bch ? 8 : 0) + (s.vw ? 8 : 0) + (s.wc ? 6 : 0);
    return s.sc - house - quiet + day + 18;
  }
  const refHere = () => REF.filter((r) => r[3].includes(np.mode));
  const refOk = (s) => refHere().every(([k, , f]) => !np.ref[k] || f(s));
  const refActive = () => refHere().some(([k]) => np.ref[k]);
  function filtHtml() {
    if (!np.found.length) return '';
    const chips = refHere().map(([k, ic, f]) => {
      const on = !!np.ref[k], n = on ? np.all.length : np.all.filter(f).length;
      if (!on && !n) return '';   // nothing found would be left: not offered
      return `<button type="button" class="kv-chip small kv-opt${on ? ' on' : ''}" data-f="${k}" aria-pressed="${on}">${ic} ${esc(t('np.f.' + k))} <b>${n}</b></button>`;
    }).join('');
    // folded behind "Avgrens" (computers: closed at first, so the list starts high; phones: open), with how many are on
    if (np.filtOpen == null) np.filtOpen = innerWidth <= 900;
    const nOn = refHere().filter(([k]) => np.ref[k]).length;
    return `<details class="np-filtd"${np.filtOpen || nOn ? ' open' : ''}><summary><span class="np-filt-h">${esc(t('np.f.h'))}</span>${nOn ? ` <b class="np-filt-n">${esc(t('np.f.on', { n: nOn }))}</b>` : ''}</summary>
      <div class="np-filtc">${chips}${refActive() ? `<button type="button" class="kv-chip small" data-f="">✕ ${esc(t('np.f.clear'))}</button>` : ''}</div></details>`;
  }
  // the list should offer a choice: no two spots within 1.5 km of each other (further apart in a large drawn area), at most two by the same water
  function spread(list, n) {
    const out = [], byName = new Map(), d = np.box ? boxKm(np.box) : null, gap = d ? Math.max(1.5, Math.sqrt(d.w * d.h) / 25) : 1.5;
    for (const s of list) {
      if (out.length >= n) break;
      if (out.some((o) => hav([o.la, o.lo], [s.la, s.lo]) < gap)) continue;
      if (s.wn && (byName.get(s.wn) || 0) >= 2) continue;
      out.push(s); if (s.wn) byName.set(s.wn, (byName.get(s.wn) || 0) + 1);
    }
    return out;
  }
  async function search() {
    if (!np.center) { status(t('np.err.where'), 'err'); return; }
    const tok = ++np.busy;
    status(t('np.loading')); $('npGo').disabled = true;
    try {
      const all = await loadSpots(np.box ? cellsBox(np.box) : cellsAround(np.center.lat, np.center.lon, np.r));
      if (tok !== np.busy) return;
      all.forEach((s) => { s.dist = hav([np.center.lat, np.center.lon], [s.la, s.lo]); });
      np.found = all.filter(inArea);
      if (!(await rank(tok, true))) return;
      const v = $('view-natt'); if (v.classList.contains('np-empty')) { v.classList.remove('np-empty'); v.classList.remove('np-form-open'); $('npEdit').setAttribute('aria-expanded', 'false'); }
      if (np.list.length) select(np.list[0], false);
    } catch (e) {
      if (tok === np.busy) status(t('np.err.data', { e: e.message || e }), 'err');
    } finally { if (tok === np.busy) $('npGo').disabled = false; }
  }

  async function rank(tok, fit) {   // the found spots through the choices and filters; the best of them with the night's weather
    np.all = np.found.filter((s) => keepSpot(s) && refOk(s));
    fairShare(np.all);
    np.all.sort((a, b) => b.scx - a.scx);
    const top = spread(np.all, WX_N);
    status(np.all.length ? t('np.loading.wx') : '');
    try {
      await fetchForecast(top.map((s) => ({ key: wxKey(s), lat: s.la, lon: s.lo, z: s.z })), VARS);
    } catch (e) { if (tok === np.busy) kvToast(t('np.err.wx')); }
    if (tok !== np.busy) return false;
    top.forEach((s) => { s.wx = nightWx(s); s.rank = s.scx + wxAdj(s.wx); });
    abroadBase();
    np.list = top.sort((a, b) => b.rank - a.rank).slice(0, LIST_N);
    const none = np.found.length && refActive() ? 'np.f.none' : np.box ? 'np.none.box' : 'np.none';
    status(np.all.length ? '' : t(none, { r: np.r }), np.all.length ? '' : 'info');
    np.sel = null; np.route = null; np.fit = fit;   // the map shows the whole result once
    render(); writeHash();
    return true;
  }
  // an area across a border: each country's spots ranked within their own country (the data behind the score differs: Norway has
  // the road authority's barriers and 1 m terrain), then given the score at the same rank of the whole area, so neither side crowds out the other
  function fairShare(list) {
    list.forEach((s) => { s.base = placeScore(s); s.scx = s.base; });
    const by = new Map(); list.forEach((s) => { if (!by.has(s.cc)) by.set(s.cc, []); by.get(s.cc).push(s); });
    if (by.size < 2) return;
    const all = list.map((s) => s.base).sort((a, b) => a - b), N = all.length;
    by.forEach((g) => { g.sort((a, b) => a.base - b.base); g.forEach((s, i) => { s.scx = all[Math.round((g.length > 1 ? i / (g.length - 1) : 0.5) * (N - 1))]; }); });
  }
  // OpenStreetMap as the base map when the area reaches outside Norway (Kartverket's map stops at the border), unless picked on this page
  function abroadBase() {
    const m = MAP.m; if (!m) return;
    const want = ls('glett.np.basepicked') !== '1' && np.found.some((s) => s.cc !== 'no') ? 'osm' : undefined;
    if (m.__base === want) return;
    if (want) m.__base = want; else delete m.__base;
    applyBase(m); baseLabel($('npBase'), m);
  }
  async function refine(k) {   // a filter chip: on or off (k '' clears them all), then the list again from the spots already loaded
    if (k) np.ref[k] = !np.ref[k]; else np.ref = {};
    const tok = ++np.busy;
    if (await rank(tok, false) && np.list.length) select(np.list[0], false);
    else { $('npDetail').hidden = true; $('npSel').hidden = true; }
  }
  const inArea = (s) => (np.box ? s.la >= np.box.s && s.la <= np.box.n && s.lo >= np.box.w && s.lo <= np.box.e : s.dist <= np.r);
  const boxKm = (b) => ({ w: Math.abs(b.e - b.w) * 111.32 * Math.cos((b.s + b.n) / 2 * RAD), h: Math.abs(b.n - b.s) * 110.57 });
  const cellsBox = (b) => { const out = []; for (let a = Math.floor(b.s * 2); a <= Math.floor(b.n * 2); a++) for (let o = Math.floor(b.w); o <= Math.floor(b.e); o++) out.push(`${a}_${o}`); return out; };

  /* ---------------- rendering: question line, list, detail ---------------- */
  function summary() {
    const n = np.center ? np.center.name || `${np.center.lat.toFixed(3)}, ${np.center.lon.toFixed(3)}` : '–';
    const night = `${t('np.mode.' + np.mode + '.s')} · ${whenLabel()}`;
    $('npSumTxt').innerHTML = `<b>${esc(np.box ? t('np.sum.box', { w: Math.round(boxKm(np.box).w), h: Math.round(boxKm(np.box).h) }) : t('np.sum', { p: n, r: np.r }))}</b><small>${esc(night)} · ${esc(t('np.veh.' + np.veh))}${np.all.length ? ' · ' + esc(t('np.found', { n: np.all.length })) : ''}</small>`;
  }
  function render() {
    summary();
    const L = $('npList');
    L.innerHTML = np.list.map((s, i) => `<li><button type="button" class="np-item${np.sel === s ? ' on' : ''}" data-i="${i}">
      <span class="np-num">${i + 1}</span>
      <span class="np-main"><span class="np-hl"><b>${isCamp(s) ? '★ ' : ''}${esc(title(s))}</b><small>${esc([where(s), np.box ? '' : t('np.dist', { km: km(s.dist * 1000) })].filter(Boolean).join(' · '))}</small></span>
      <span class="np-meta"><span class="np-tags">${tags(s)}</span>${wxChips(s.wx, s)}</span></span></button></li>`).join('');
    $('npListCard').hidden = !np.found.length; $('npKey').hidden = !np.all.length; $('npFit').hidden = !np.list.length; $('npFilt').innerHTML = filtHtml();
    $('npMore').textContent = np.all.length > np.list.length ? t('np.more', { n: np.all.length - np.list.length }) : '';
    MAP.spots();
  }
  function tags(s) {
    const out = [];
    if (s.wk) out.push(`💧 ${s.wd} m`);
    if (s.hb == null || s.hb >= 300) out.push(t('np.tag.alone')); else if (s.hb >= 150) out.push(t('np.tag.house', { m: s.hb }));
    if (s.k !== 'v') out.push(t(KIND[s.k]));
    if (s.st === 1) out.push('⚠ ' + t('np.tag.gate'));
    if (s.nb) out.push(t('np.tag.bars', { n: s.nb }));
    if (s.tent) out.push('⛺');
    return out.map((x) => `<i>${esc(x)}</i>`).join('');
  }
  async function select(s, fly = true) {
    np.sel = s; np.route = null; np.fly = fly;
    document.querySelectorAll('.np-item').forEach((b) => b.classList.toggle('on', np.list[+b.dataset.i] === s));
    const D = $('npDetail'); D.hidden = false;
    const sun = sunTimes(s.la, s.lo, span()[0]);
    D.innerHTML = `<h2>${esc(title(s))}</h2><p class="np-where">${esc([where(s), `${s.la.toFixed(5)}, ${s.lo.toFixed(5)}`].filter(Boolean).join(' · '))}</p>
      <ul class="np-why">${reasons(s).map(([ic, txt, tone]) => `<li class="${tone}"><span aria-hidden="true">${ic}</span>${esc(txt)}</li>`).join('')}</ul>
      <p id="npOlNote" class="hint np-olnote" hidden>${esc(t('np.ol.note'))}</p>
      ${s.fd !== undefined ? `<h3>${esc(t('np.svc.h'))}</h3><div id="npSvc">${svcHtml(s, null)}</div>` : ''}
      <details class="np-wxd"><summary><b>${esc(wxHead())}</b> <span id="npWxSum">${wxChips(s.wx, s)}</span></summary><div id="npNightWx">${nightHtml(s, sun, !s.wx)}</div></details>
      <h3>${esc(t('np.in.h'))}</h3><div id="npIn" class="np-in"><p class="hint">${esc(t('np.loading'))}</p></div>
      <div class="kv-actions np-acts"><button id="npDrive" class="btn primary" type="button">${esc(t('np.drive'))}</button>
        <a id="npGmaps" class="btn" target="_blank" rel="noopener" href="#">Google Maps ↗</a>
        <button id="npWx" class="btn" type="button">${esc(t('np.wx.open'))}</button>
        <button id="npShare" class="btn" type="button">${esc(t('kv.share'))}</button>
        <button id="npSave" class="btn" type="button" aria-pressed="${isCamp(s)}">${esc(t(isCamp(s) ? 'np.saved' : 'np.save'))}</button></div>
      <div id="npRoute" class="np-route" hidden></div>
      <p class="hint np-law">${esc(t(np.mode === 'd' ? 'np.law.day' : 'np.law.' + s.cc))} ${esc(t('np.law.all'))}</p>`;
    $('npDrive').addEventListener('click', () => drive(s));
    $('npWx').addEventListener('click', () => { if (typeof setCurrent === 'function') { setCurrent({ name: title(s), lat: s.la, lon: s.lo }, true); showView('forecast'); } });
    $('npShare').addEventListener('click', () => share(s));
    $('npSave').addEventListener('click', () => { const on = toggleCamp(s), b = $('npSave'); b.textContent = t(on ? 'np.saved' : 'np.save'); b.setAttribute('aria-pressed', String(on)); render(); });
    $('npSel').hidden = false;
    $('npSel').innerHTML = `<div><b>${esc(title(s))}</b><small>${esc([where(s), np.box ? '' : t('np.dist', { km: km((s.dist || 0) * 1000) })].filter(Boolean).join(' · '))}</small><span id="npSelWx">${wxChips(s.wx, s)}</span></div>
      <div class="np-selbtns"><button type="button" class="kv-chip small" id="npSelMore">${esc(t('np.sel.more'))}</button><button type="button" class="btn primary" id="npSelDrive">${esc(t('np.drive'))}</button></div>`;
    $('npSelMore').addEventListener('click', () => $('npDetail').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    $('npSelDrive').addEventListener('click', () => { $('npDetail').scrollIntoView({ behavior: 'smooth', block: 'start' }); drive(s); });
    MAP.select(s, fly);
    writeHash(); syncFloat();
    if (fly && !(FULL && FULL.on) && innerWidth > 900) {   // computers: the list stays beside the map; scrolled down to read, the map comes back
      const head = document.querySelector('.topbar'), top = $('npMapWrap').getBoundingClientRect().top - (head ? head.offsetHeight : 60) - 8;
      if (top < 0) window.scrollBy({ top, behavior: 'smooth' });
    }
    if (!s.wx) spotWx(s);   // a dot outside the list: its weather is fetched now
    if (!s.hz) skyline(s.la, s.lo).then((hz) => {   // the terrain's horizon: the sun times on the spot, and the ring on the map
      if (!hz) return; s.hz = hz;
      if (np.sel !== s) return;
      const el = $('npSunLine'); if (el) el.textContent = sunLine(s, sunTimes(s.la, s.lo, span()[0]));
      if (np.sun) MAP.sun();
    });
    const w = await wayIn(s).catch(() => null);
    if (np.sel !== s) return;
    s.way = w;
    $('npIn').innerHTML = wayHtml(s, w);
    $('npGmaps').href = gmaps(s, w);
    if (w && $('npSvc')) $('npSvc').innerHTML = svcHtml(s, w.nm);
    $('npOlNote').hidden = !(w && w.ol);
    MAP.way(w); MAP.pad(w && w.ol);
  }
  function wxHead() {
    const [a, b] = span();
    return np.mode === 'd' ? t('np.day.h', { n: whenLabel().toLowerCase(), a: fmtHM(a), b: fmtHM(b) }) : t('np.night.h', { n: whenLabel().toLowerCase() });
  }
  function nightHtml(s, sun, busy) {
    if (!s.wx) return `<p class="hint">${esc(t(busy ? 'np.loading.wx' : 'np.wx.later'))}</p>`;
    const hrs = s.wx.hrs.filter((h, i) => i % (np.mode === 'd' ? 2 : 3) === 0);
    return `<div class="np-night">${hrs.map((h) => `<span><b>${fmtHM(h.ms)}</b>${Math.round(h.t)}°<small>${h.mm >= 0.1 ? h.mm.toFixed(1) + ' mm' : '–'} · ${Math.round(h.g)} m/s</small></span>`).join('')}</div>
        <p class="np-sun" id="npSunLine">${esc(sunLine(s, sun))}</p>${np.mode === 'n' ? dewHtml(s.wx) + starsHtml(s, s.wx) : ''}`;
  }
  async function spotWx(s) {
    if (s.wxBusy) return; s.wxBusy = true;
    try { await fetchForecast([{ key: wxKey(s), lat: s.la, lon: s.lo, z: s.z }], VARS); s.wx = nightWx(s); } catch (e) { /* keeps "not loaded" */ }
    s.wxBusy = false;
    if (np.sel !== s) return;
    const box = $('npNightWx'); if (box) box.innerHTML = nightHtml(s, sunTimes(s.la, s.lo, span()[0]), false);
    const chip = $('npSelWx'); if (chip) chip.innerHTML = wxChips(s.wx, s);
    const sum = $('npWxSum'); if (sum) sum.innerHTML = wxChips(s.wx, s);
  }
  const fmtHM = (ms) => new Date(ms).toLocaleTimeString(LANG === 'nb' ? 'nb-NO' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  function wayHtml(s, w) {
    if (!w || !w.coords.length) return `<p>${esc(t(s.k === 'v' ? 'np.in.road' : 'np.in.direct'))}</p>`;
    const head = w.m < 150 ? t('np.in.direct') : t('np.in.len', { km: km(w.m) });
    const bars = w.bars.length ? `<ul class="np-bars">${w.bars.map((b) => `<li><i style="background:${BCOL[b.c]}"></i>${esc(barText(b))}${b.info ? `<small>${esc(barInfo(b))}</small>` : ''}</li>`).join('')}</ul>` : `<p class="np-ok">${esc(t('np.in.nobars'))}</p>`;
    return `<p>${esc(head)}</p>${bars}`;
  }
  function gmaps(s, w) {   // Google Maps cannot avoid our barriers: lead it along the way in with up to three points on it
    const ll = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`, via = [];
    if (w && w.coords.length > 2 && w.m > 300) [0, 0.4, 0.75].forEach((f) => via.push(w.coords[Math.min(w.coords.length - 1, Math.round(f * (w.coords.length - 1)))]));
    const o = np.origin ? `&origin=${ll([np.origin.lat, np.origin.lon])}` : '';
    return `https://www.google.com/maps/dir/?api=1${o}&destination=${ll([s.la, s.lo])}&travelmode=driving${via.length ? '&waypoints=' + encodeURIComponent(via.map(ll).join('|')) : ''}`;
  }
  async function share(s) {
    writeHash();
    const url = location.href, title_ = `${t('np.title')}: ${title(s)}`;
    try { if (navigator.share) { await navigator.share({ title: title_, url }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(url); kvToast(t('kv.copied')); } catch (e) { kvToast(url); }
  }

  /* ---------------- saved spots (localStorage 'glett.camps', exported with Mine steder) ---------------- */
  const CAMPS = 'glett.camps', ckey = (c) => `${(+c.lat).toFixed(5)},${(+c.lon).toFixed(5)}`;
  const camps = () => { try { const a = JSON.parse(ls(CAMPS) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const isCamp = (s) => camps().some((c) => ckey(c) === ckey({ lat: s.la, lon: s.lo }));
  function toggleCamp(s) {
    const all = camps(), k = ckey({ lat: s.la, lon: s.lo }), had = all.some((c) => ckey(c) === k);
    const next = had ? all.filter((c) => ckey(c) !== k) : [{ name: title(s), lat: s.la, lon: s.lo, pl: where(s), cc: s.cc, mode: np.mode, at: new Date().toISOString() }, ...all].slice(0, 200);
    ls(CAMPS, JSON.stringify(next)); if (!had) kvToast(t('np.saved.ok'));
    renderCamps(); return !had;
  }
  function renderCamps() {
    const all = camps(); $('npSavedCard').hidden = !all.length;
    $('npSaved').innerHTML = all.map((c, i) => `<li><button type="button" class="np-savedgo" data-i="${i}"><b>★ ${esc(c.name)}</b><small>${esc([c.pl, `${(+c.lat).toFixed(4)}, ${(+c.lon).toFixed(4)}`].filter(Boolean).join(' · '))}</small></button>
      <button type="button" class="kv-chip small np-savedrm" data-i="${i}" aria-label="${esc(t('np.saved.rm'))}">✕</button></li>`).join('');
  }
  async function openCamp(c) {   // a saved spot: search round it and open it, or show the area when it is no longer in the data
    setCenter({ lat: +c.lat, lon: +c.lon, name: c.name }, false);
    await search();
    const k = ckey(c), s = np.found.find((x) => ckey({ lat: x.la, lon: x.lo }) === k) || np.found.find((x) => Math.abs(x.la - c.lat) < 2e-4 && Math.abs(x.lo - c.lon) < 2e-4);
    if (s) select(s, true); else kvToast(t('np.saved.gone'));
  }

  /* ---------------- the drive: Valhalla to the hand-off point, closed barriers avoided, then the way in ---------------- */
  function distToSeg(p, a, b) {   // metres from p to the segment a-b ([lat, lon]), flat earth (short distances)
    const k = Math.cos(p[0] * Math.PI / 180) * 111320, ax = (a[1] - p[1]) * k, ay = (a[0] - p[0]) * 110540, bx = (b[1] - p[1]) * k, by = (b[0] - p[0]) * 110540;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1e-9, u = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2));
    return Math.hypot(ax + u * vx, ay + u * vy);
  }
  function sameWay(brg, a, b) {   // the segment a-b runs along a road of bearing brg (0-180°); no bearing known: yes
    if (brg == null) return true;
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-7) return true;
    const r = (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 180;
    const d = Math.abs(r - brg) % 180; return Math.min(d, 180 - d) <= BAR_ANG;
  }
  async function barriersOn(coords) {   // known barriers on a line (within BAR_HIT_M): the cells it passes, at most 60
    const keys = [...new Set(coords.map((c) => cellKey(c[0], c[1])))].slice(-60);
    const bars = await loadBars(keys), hits = [];
    // a coarse grid of the line's segments, so each barrier is tested against a few of them
    const grid = new Map(), G = 0.01, gk = (la, lo) => `${Math.floor(la / G)}:${Math.floor(lo / G)}`;
    for (let i = 1; i < coords.length; i++) { const k = gk(coords[i][0], coords[i][1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    bars.forEach((b) => {
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
        const segs = grid.get(`${Math.floor(b.la / G) + da}:${Math.floor(b.lo / G) + db}`); if (!segs) continue;
        if (segs.some((i) => distToSeg([b.la, b.lo], coords[i - 1], coords[i]) <= BAR_HIT_M && sameWay(b.brg, coords[i - 1], coords[i]))) { hits.push(b); return; }
      }
    });
    return hits;
  }
  async function drive(s) {
    const out = $('npRoute'); out.hidden = false;
    if (!np.origin) {
      out.innerHTML = `<p class="hint">${esc(t('np.drive.geo'))}</p>`;
      const p = await geo().catch(() => null);
      if (!p) { out.innerHTML = `<p class="kv-status err">${esc(t('np.drive.nogeo'))}</p>`; return; }
      np.origin = p;
    }
    out.innerHTML = `<p class="hint">${esc(t('np.drive.busy'))}</p>`;
    const w = s.way !== undefined ? s.way : await wayIn(s).catch(() => null);
    const to = w && w.coords.length ? { lat: w.coords[0][0], lon: w.coords[0][1] } : { lat: s.la, lon: s.lo };
    const E = window.kvEngine; let R = null, avoid = [], hits = [], tries = 0;
    try {
      for (; tries < ROUTE_TRIES; tries++) {
        const rs = await E.KV_ROUTERS.valhalla.route({ from: np.origin, to, via: [], depart: new Date(), profile: E.KV_PROFILES.car, opts: {}, avoid });
        if (!rs || !rs.length) break;
        R = rs[0];
        hits = (await barriersOn(R.coords)).filter((b) => b.c === 'closed' || b.c === 'unknown');
        const fresh = hits.filter((b) => !avoid.some((a) => a[0] === b.la && a[1] === b.lo));
        if (!fresh.length) break;
        avoid = avoid.concat(fresh.map((b) => [b.la, b.lo]));
      }
    } catch (e) { out.innerHTML = `<p class="kv-status err">${esc(t('np.drive.err', { e: e.message || e }))}</p>`; return; }
    if (np.sel !== s) return;
    if (!R) { out.innerHTML = `<p class="kv-status err">${esc(t('np.drive.none'))}</p>`; return; }
    const passed = (await barriersOn(R.coords)).filter((b) => b.c === 'toll' || b.c === 'pass');
    const inM = w ? w.m : 0, sec = R.sec + inM / 1000 / 30 * 3600;   // the way in at about 30 km/h
    const closedLeft = hits.filter((b) => b.c === 'closed'), unknownLeft = hits.filter((b) => b.c === 'unknown');
    np.route = { coords: R.coords.concat(w ? w.coords : [[s.la, s.lo]]) };
    MAP.route(np.route.coords);
    const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
    const lines = [`<p><b>${esc(t('np.drive.sum', { t: h ? `${h} t ${m} min` : `${m} min`, km: km(R.km * 1000 + inM) }))}</b>${inM >= 150 ? ' · ' + esc(t('np.drive.in', { km: km(inM) })) : ''}</p>`];
    const eta = Date.now() + sec * 1000, sun = sunTimes(s.la, s.lo, eta), dark = sun.set && eta > sun.set && (!sun.rise || eta < sun.rise);
    lines.push(`<p class="${dark ? 'np-warn' : ''}">${esc(t(dark ? 'np.drive.etadark' : 'np.drive.eta', { a: fmtHM(eta), s: sun.set ? fmtHM(sun.set) : '–' }))}</p>`);
    if (closedLeft.length) lines.push(`<p class="kv-status err">${esc(t('np.drive.closed', { n: closedLeft.length }))}</p>`);
    else if (unknownLeft.length) lines.push(`<p class="kv-status info">${esc(t('np.drive.unknown', { n: unknownLeft.length }))}</p>`);
    else lines.push(`<p class="np-ok">${esc(t(avoid.length ? 'np.drive.avoided' : 'np.drive.clear', { n: avoid.length }))}</p>`);
    const all = passed.concat(w ? w.bars : []);
    if (all.length) lines.push(`<ul class="np-bars">${all.map((b) => `<li><i style="background:${BCOL[b.c]}"></i>${esc(barText(b))}</li>`).join('')}</ul>`);
    lines.push(`<p class="hint">${esc(t('np.drive.note'))}</p>`);
    out.innerHTML = lines.join('');
  }
  const geo = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('geo'));
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, name: t('np.mypos') }), rej, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  });

  /* ---------------- the map ---------------- */
  const CLEAR = ['step', ['zoom'], ['case', ['<=', ['get', 'nz'], 0], 1, 0], ...[...Array(19)].flatMap((_, j) => [j + 1, ['case', ['<=', ['get', 'nz'], j + 1], 1, 0]])];   // see nzOf in spots()
  const MAP = {
    m: null, ready: null, marks: [],
    init() {
      if (this.ready || !hasGL) return this.ready;
      this.ready = glMap('npMap', (m) => {
        this.m = m;
        const empty = { type: 'FeatureCollection', features: [] }, round = { 'line-join': 'round', 'line-cap': 'round' };
        ['np-spots', 'np-bars', 'np-way', 'np-route', 'np-center', 'np-pad', 'np-sun'].forEach((id) => m.addSource(id, { type: 'geojson', data: empty }));
        m.addLayer({ id: 'np-pad', type: 'fill', source: 'np-pad', paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.3 } });
        m.addLayer({ id: 'np-pad-l', type: 'line', source: 'np-pad', paint: { 'line-color': '#c2410c', 'line-width': 2 } });
        m.addLayer({ id: 'np-sun', type: 'line', source: 'np-sun', layout: round, paint: { 'line-color': ['get', 'col'], 'line-width': ['get', 'w'], 'line-opacity': 0.9 } });
        m.addLayer({ id: 'np-center', type: 'line', source: 'np-center', paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } });
        m.addLayer({ id: 'np-route-c', type: 'line', source: 'np-route', layout: round, paint: { 'line-color': '#0f172a', 'line-width': 7, 'line-opacity': 0.45 } });
        m.addLayer({ id: 'np-route', type: 'line', source: 'np-route', layout: round, paint: { 'line-color': '#2563eb', 'line-width': 4 } });
        m.addLayer({ id: 'np-way', type: 'line', source: 'np-way', layout: round, paint: { 'line-color': '#f59e0b', 'line-width': 4, 'line-dasharray': [1.5, 1.2] } });
        m.addLayer({ id: 'np-bars', type: 'circle', source: 'np-bars', minzoom: 8, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 6], 'circle-color': ['get', 'col'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
        m.addLayer({ id: 'np-spots', type: 'circle', source: 'np-spots', paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, ['case', ['get', 'top'], 5, 2.5], 13, ['case', ['get', 'top'], 9, 6]],
          'circle-color': ['case', ['get', 'sel'], '#f59e0b', ['get', 'lay'], '#64748b', ['>=', ['get', 'sc'], 65], '#1d4ed8', ['>=', ['get', 'sc'], 55], '#3b82f6', '#93c5fd'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': ['case', ['get', 'top'], 2, 1], 'circle-opacity': CLEAR, 'circle-stroke-opacity': CLEAR } });
        m.on('click', 'np-spots', (e) => { if (np.drawing) return; const f = e.features[0]; const s = np.all[f.properties.i]; if (s) { if (!np.list.includes(s)) { s.wx = s.wx || null; } select(s, true); } });
        m.on('click', 'np-bars', (e) => { const p = e.features[0].properties; new maplibregl.Popup({ closeButton: true, maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(`<b>${esc(p.txt)}</b><br><small>${esc(p.info || (p.src === 'n' ? 'NVDB' : 'OpenStreetMap'))}</small>`).addTo(m); });
        ['np-spots', 'np-bars'].forEach((id) => { m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer'; }); m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; }); });
        m.on('moveend', () => { if (np.bars) this.bars(); });
        m.on('zoomend', () => { if (np.sun && np.sel) this.sun(); });
        m.on('moveend', () => { if (this.shade) this.shade.update(); });
        // drawing an area: press, drag, let go (the map does not pan meanwhile)
        const down = (e) => { if (!np.drawing) return; e.preventDefault(); this.bx = [e.lngLat, e.lngLat]; };
        const move = (e) => { if (!np.drawing || !this.bx) return; this.bx[1] = clampBox(this.bx[0], e.lngLat); this.box(boxOf(...this.bx)); };
        const up = () => { if (!np.drawing || !this.bx) return; const b = boxOf(...this.bx); this.bx = null; endBox(b); };
        m.on('mousedown', down); m.on('touchstart', down); m.on('mousemove', move); m.on('touchmove', move); m.on('mouseup', up); m.on('touchend', up);
        if (np.drawing) m.dragPan.disable();
        m.on('click', (e) => { if (!np.pick) return; np.pick = false; $('npMap').classList.remove('np-picking'); setCenter({ lat: e.lngLat.lat, lon: e.lngLat.lng, name: null }, true); });
        if (np.all.length) { abroadBase(); this.spots(); if (np.sel) { this.select(np.sel, np.fly); this.way(np.sel.way); this.pad(np.sel.way && np.sel.way.ol); this.sun(); } if (np.route) this.route(np.route.coords); }   // a search that finished before the map
      });
      return this.ready;
    },
    spots() {
      const m = this.m; if (!m) return;
      this.marks.forEach((x) => x.remove()); this.marks = [];
      // a spot next to a numbered one (the twelve keep 1.5 km apart, so the next best is often right beside one) looked like the
      // number sitting off its dot: its dot waits until the zoom puts it 18 px clear of the number (nz: that zoom). A numbered spot
      // has no dot under its number (99): with 3D terrain the two are drawn a few pixels apart and the dot showed at the edge
      const nzOf = (s) => { if (np.list.includes(s)) return 99; let d = Infinity; np.list.forEach((t) => { d = Math.min(d, hav([s.la, s.lo], [t.la, t.lo]) * 1000); }); return d === Infinity ? 0 : Math.log2(156543 * Math.cos(s.la * Math.PI / 180) * 18 / Math.max(d, 1)); };
      m.getSource('np-spots').setData({ type: 'FeatureCollection', features: np.all.map((s, i) => ({ type: 'Feature', properties: { i, sc: s.sc, top: np.list.includes(s), sel: np.sel === s, lay: s.k === 'l' || s.k === 'r', nz: nzOf(s) }, geometry: { type: 'Point', coordinates: [s.lo, s.la] } })) });
      np.list.forEach((s, i) => { const mk = glMark(m, [s.la, s.lo], String(i + 1), 'np-mark' + (np.sel === s ? ' on' : ''), title(s)); mk.getElement().addEventListener('click', (e) => { e.stopPropagation(); if (!np.drawing) select(s, true); }); this.marks.push(mk); });   // centred on the spot
      if (np.center) {
        const c = np.center, ring = [];
        if (np.box) this.box(np.box);
        else { for (let a = 0; a <= 64; a++) { const th = a / 64 * 2 * Math.PI; ring.push([c.lat + np.r / 111 * Math.sin(th), c.lon + np.r / (111 * Math.cos(c.lat * Math.PI / 180)) * Math.cos(th)]); } m.getSource('np-center').setData(lineFeature(ring, {})); }
        if (np.fit) { np.fit = false; this.fitAll(0); }
        else if (!np.list.length && !np.box) m.jumpTo({ center: [c.lon, c.lat], zoom: 9 });
      }
      if (np.bars) this.bars();
    },
    select(s, fly) {   // fly: in close, so the open area's outline shows
      const m = this.m; if (!m) return;
      this.spots();
      ['np-way', 'np-route', 'np-pad'].forEach((id) => m.getSource(id).setData({ type: 'FeatureCollection', features: [] }));
      if (fly) m.easeTo({ center: [s.lo, s.la], zoom: Math.max(m.getZoom(), 16), duration: 700 });
      this.sun();
    },
    fitAll(duration = 600) {   // the whole result: the list, and the circle's centre or the drawn area
      const m = this.m; if (!m) return;
      const c = np.center, pts = np.list.map((s) => [s.lo, s.la]);
      if (np.box) pts.push([np.box.w, np.box.s], [np.box.e, np.box.n]); else if (c) pts.push([c.lon, c.lat]);
      if (!pts.length) return;
      const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
      m.fitBounds(b, { padding: 60, maxZoom: 12, duration });
    },
    pad(ol) {   // the open, level ground measured at the spot (outline.py)
      const m = this.m; if (!m) return;
      m.getSource('np-pad').setData(ol && ol.length > 2 ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ol.concat([ol[0]]).map((p) => [p[1], p[0]])] } } : { type: 'FeatureCollection', features: [] });
    },
    box(b) {
      const m = this.m; if (!m) return;
      m.getSource('np-center').setData(lineFeature([[b.s, b.w], [b.s, b.e], [b.n, b.e], [b.n, b.w], [b.s, b.w]], {}));
    },
    sunMarks: [], shade: null,
    sun() {   // np.sun: a ring round the picked spot with the directions of that evening's sunset and the next sunrise, the sun at the
      const m = this.m; if (!m) return;   // slider's time, and the terrain's shadow then (sunshade.js, as on the shadow map)
      this.sunMarks.forEach((x) => x.remove()); this.sunMarks = [];
      const s = np.sel, src = m.getSource('np-sun');
      if (!np.sun) { src.setData({ type: 'FeatureCollection', features: [] }); if (this.shade) { this.shade.remove(); this.shade = null; } return; }
      const d0 = sunDay(), c = s ? { la: s.la, lo: s.lo } : (({ lat, lng }) => ({ la: lat, lo: lng }))(m.getCenter());
      const ms = d0 + sunMin(c) * 60000, pos = typeof sunPos === 'function' ? sunPos(ms, c.la, c.lo) : null;
      sunText(ms, pos, c);
      if (!this.shade && window.GlettShade && typeof smImageLayer === 'function') {
        this.shade = GlettShade.create(m, { tileBase: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium', opacity: 0.47, imageLayer: (map, id, cv, co, before) => smImageLayer(map, id, cv, co, before || 'np-pad') });
        if (this.shade) this.shade.update();
      }
      if (this.shade && pos) this.shade.setSun(pos.az * RAD, pos.el * RAD);
      if (!s) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
      // that evening's last sun and the next morning's first on the spot: behind the terrain once its horizon is known
      const a = d0 + 12 * 3600e3, ts = s.hz && terrainSun(s.la, s.lo, s.hz, a);
      let sun = sunTimes(s.la, s.lo, a), az = sunAz(s.la, a);
      if (ts && ts.never) az = { never: true };
      else if (ts && !ts.always) { sun = { set: ts.set, rise: ts.rise }; az = { set: ts.setAz ?? az.set, rise: ts.riseAz ?? az.rise }; }
      const px = Math.min(110, m.getContainer().clientWidth * 0.22), R = px * 40075016.686 * Math.cos(s.la * RAD) / Math.pow(2, m.getZoom() + 9);   // about 110 px (less on a narrow map), in metres
      const pt = (deg, r) => [s.lo + r * Math.sin(deg * RAD) / (111320 * Math.cos(s.la * RAD)), s.la + r * Math.cos(deg * RAD) / 110540];
      const line = (c, col, w) => ({ type: 'Feature', properties: { col, w }, geometry: { type: 'LineString', coordinates: c } });
      const ring = []; for (let i = 0; i <= 72; i++) ring.push(pt(i * 5, R));
      // sunset and sunrise both to the side: the labels reach in towards each other and would overlap on a narrow map, so the one
      // whose ray ends lower moves down a line and the other up
      const side = (deg) => deg != null && Math.abs(Math.sin(deg * RAD)) > 0.3;
      const apart = az.set != null && side(az.set) && side(az.rise) && Math.sign(Math.sin(az.set * RAD)) !== Math.sign(Math.sin(az.rise * RAD));
      const lower = apart && (Math.cos(az.set * RAD) < Math.cos(az.rise * RAD) ? az.set : az.rise);
      const fs = [line(ring, '#f59e0b', 1.5)], lab = (deg, txt, cls) => {
        const el = document.createElement('div'); el.className = 'np-sunlab ' + cls; el.textContent = txt;
        // the label reaches in from the ray's end (east: to the left of it), so it stays on a narrow map
        const anchor = deg == null ? 'bottom' : Math.sin(deg * RAD) > 0.3 ? 'right' : Math.sin(deg * RAD) < -0.3 ? 'left' : Math.cos(deg * RAD) > 0 ? 'bottom' : 'top';
        const offset = apart ? [0, deg === lower ? 15 : -15] : [0, 0];
        this.sunMarks.push(new maplibregl.Marker({ element: el, anchor, offset, opacityWhenCovered: '1' }).setLngLat(deg == null ? [s.lo, s.la + R * 1.3 / 110540] : pt(deg, R * 1.2)).addTo(m));
      };
      if (az.set != null) {
        fs.push(line([[s.lo, s.la], pt(az.set, R * 1.15)], '#ea580c', 3), line([[s.lo, s.la], pt(az.rise, R * 1.15)], '#eab308', 3));
        lab(az.set, `🌇 ${t('np.sunmap.set', { t: sun.set ? fmtHM(sun.set) : '–' })}`, 'set');
        lab(az.rise, `🌅 ${t('np.sunmap.rise', { t: sun.rise ? fmtHM(sun.rise) : '–' })}`, 'rise');
      } else lab(null, t(az.never ? 'np.sunmap.never' : az.up ? 'np.sunmap.mid' : 'np.sunmap.polar'), az.up ? 'rise' : 'set');
      if (pos && pos.el > 0) {   // the sun at the slider's time; faint, with a thin ray, while it is behind the terrain
        const hid = s.hz && !sunVis(s.la, s.lo, s.hz, ms);
        fs.push(line([[s.lo, s.la], pt(pos.az, R * 0.92)], hid ? '#94a3b8' : '#facc15', hid ? 2 : 5));
        const el = document.createElement('div'); el.className = 'np-sundot' + (hid ? ' hid' : ''); el.textContent = '☀';
        this.sunMarks.push(new maplibregl.Marker({ element: el, opacityWhenCovered: '1' }).setLngLat(pt(pos.az, R)).addTo(m));
      } else if (pos) {   // the sun is down: the moon in its direction (faint while it is below the horizon too)
        const mo = moonPos(ms, s.la, s.lo), up = mo.el > 0;
        if (up) fs.push(line([[s.lo, s.la], pt(mo.az, R * 0.92)], '#cbd5e1', 3));
        const el = document.createElement('div'); el.className = 'np-moondot' + (up ? '' : ' down');
        el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3a9 9 0 1 0 6 15A7.5 7.5 0 0 1 15 3z"/></svg>';
        this.sunMarks.push(new maplibregl.Marker({ element: el, opacityWhenCovered: '1' }).setLngLat(pt(mo.az, R)).addTo(m));
      }
      src.setData({ type: 'FeatureCollection', features: fs });
    },
    way(w) {
      const m = this.m; if (!m || !w || w.coords.length < 2) return;
      m.getSource('np-way').setData(lineFeature(w.coords, {}));
    },
    route(coords) {
      const m = this.m; if (!m) return;
      m.getSource('np-route').setData(lineFeature(coords, {}));
      const b = coords.reduce((bb, c) => bb.extend([c[1], c[0]]), new maplibregl.LngLatBounds([coords[0][1], coords[0][0]], [coords[0][1], coords[0][0]]));
      m.fitBounds(b, { padding: 50, duration: 600 });
    },
    async bars() {
      const m = this.m; if (!m) return;
      if (!np.bars || m.getZoom() < 8) { m.getSource('np-bars').setData({ type: 'FeatureCollection', features: [] }); $('npBarHint').hidden = !np.bars; return; }
      $('npBarHint').hidden = true;
      const b = m.getBounds(), keys = [];
      for (let a = Math.floor(b.getSouth() * 2); a <= Math.floor(b.getNorth() * 2); a++) for (let o = Math.floor(b.getWest()); o <= Math.floor(b.getEast()); o++) keys.push(`${a}_${o}`);
      if (keys.length > 16) return;
      const bars = await loadBars(keys);
      m.getSource('np-bars').setData({ type: 'FeatureCollection', features: bars.map((x) => ({ type: 'Feature', properties: { col: BCOL[x.c], txt: barText(x), info: barInfo(x), src: x.src }, geometry: { type: 'Point', coordinates: [x.lo, x.la] } })) });
    },
  };

  /* ---------------- the sun panel: a date (any day of the year) and a time of day ---------------- */
  function sunDay() {   // local midnight of the chosen date; none chosen: the evening of the night asked about
    if (np.sunDay) { const d = new Date(np.sunDay + 'T00:00'); if (!isNaN(d)) return +d; }
    const d = new Date(nightSpan(np.night)[0]); if (np.night === 0 && d.getHours() < NIGHT[1]) d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return +d;
  }
  function sunMin(c) {   // the slider's minutes; first an hour before sunset (noon in polar day or night)
    if (np.sunMin == null) { const st = sunTimes(c.la, c.lo, sunDay() + 12 * 3600e3); np.sunMin = st.set ? Math.max(0, Math.round((st.set - sunDay()) / 60000 / 5) * 5 - 60) : 720; }
    const sl = $('npSunT'); if (sl && +sl.value !== np.sunMin) sl.value = np.sunMin;
    return np.sunMin;
  }
  function sunText(ms, pos, c) {
    const di = $('npSunDate'), d = new Date(sunDay()), iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (di && di.value !== iso) di.value = iso;
    const tt = fmtHM(ms), dirs = t('np.dir').split('|');
    const s = np.sel, hid = pos && pos.el > 0 && s && s.hz && !sunVis(s.la, s.lo, s.hz, ms);   // above the horizon, behind a hill
    $('npSunTxt').textContent = !pos ? '' : pos.el > 0 ? t(hid ? 'np.sunbox.hid' : 'np.sunbox.up', { t: tt, e: Math.round(pos.el), d: dirs[Math.round(pos.az / 45) % 8], h: s && s.hz ? Math.round(s.hz[Math.round(pos.az) % 360]) : '' }) : t('np.sunbox.down', { t: tt });
    if (pos && pos.el <= 0 && c) {   // and the moon then
      const mo = moonPos(ms, c.la, c.lo), mh = mo.el > 0 && s && s.hz && s.la === c.la && s.lo === c.lo && mo.el < s.hz[Math.round(mo.az) % 360];
      $('npSunTxt').textContent += '. ' + (mo.el > 0 ? t(mh ? 'np.sunbox.moonhid' : 'np.sunbox.moon', { e: Math.round(mo.el), d: dirs[Math.round(mo.az / 45) % 8] }) : t('np.sunbox.moondown'));
    }
  }

  /* ---------------- drawing an area (at most SPAN_MAX km a side) ---------------- */
  function clampBox(a, b) {   // the far corner moved in so neither side is longer than SPAN_MAX
    const maxLo = SPAN_MAX / (111.32 * Math.cos((a.lat + b.lat) / 2 * RAD)), maxLa = SPAN_MAX / 110.57;
    return { lng: a.lng + Math.max(-maxLo, Math.min(maxLo, b.lng - a.lng)), lat: a.lat + Math.max(-maxLa, Math.min(maxLa, b.lat - a.lat)) };
  }
  const boxOf = (a, b) => ({ s: Math.min(a.lat, b.lat), n: Math.max(a.lat, b.lat), w: Math.min(a.lng, b.lng), e: Math.max(a.lng, b.lng) });
  function drawing(on) {
    np.drawing = on; np.pick = false;
    $('npMap').classList.toggle('np-picking', on); if (np.syncR) np.syncR();
    if (MAP.m) { if (on) MAP.m.dragPan.disable(); else MAP.m.dragPan.enable(); }
    if (on) { MAP.init(); kvToast(t('np.box.hint')); $('npMap').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
  function endBox(b) {
    const d = boxKm(b);
    if (d.w < 1 && d.h < 1) return;   // a tap: still drawing
    drawing(false); setBox(b, true);
  }
  function setBox(b, go) {
    const d = boxKm(b);
    np.box = b; np.center = { lat: (b.s + b.n) / 2, lon: (b.w + b.e) / 2, name: t('np.box.name', { w: Math.round(d.w), h: Math.round(d.h) }) };
    if (np.syncR) np.syncR();
    $('npWhere').value = np.center.name;
    if (go) search();
  }

  /* ---------------- the form ---------------- */
  function setCenter(c, go) {
    np.box = null; np.center = c; if (np.syncR) np.syncR(); $('npWhere').value = c.name || `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`;
    if (!c.name && WEFO && WEFO.reverse) WEFO.reverse(c.lat, c.lon, LANG).then((n) => { if (np.center === c && n) { c.name = typeof n === 'string' ? n : n.name; $('npWhere').value = c.name; summary(); } }).catch(() => {});
    if (go) search();
  }
  function seg(id, key, val, onPick) {
    const el = $(id);
    const sync = () => el.querySelectorAll('button').forEach((b) => { const on = b.dataset[key] === String(np[val]); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; np[val] = /^\d+$/.test(b.dataset[key]) ? +b.dataset[key] : b.dataset[key]; sync(); ls('glett.np.' + val, String(np[val])); if (onPick) onPick(); });
    sync();
  }
  function opt(id, key) {
    const b = $(id);
    const sync = () => { b.classList.toggle('on', !!np.opts[key]); b.setAttribute('aria-pressed', String(!!np.opts[key])); };
    b.addEventListener('click', () => { np.opts[key] = !np.opts[key]; sync(); ls('glett.np.o.' + key, np.opts[key] ? '1' : '0'); if (np.center && np.all) search(); });
    sync();
  }
  function writeHash() {
    if (!np.center) return;
    const q = new URLSearchParams({ la: np.center.lat.toFixed(4), lo: np.center.lon.toFixed(4), r: np.r });
    if (np.center.name) q.set('n', np.center.name);
    if (np.night) q.set('nt', np.night);
    if (np.mode === 'd') q.set('m', 'd');
    if (np.box) q.set('bb', [np.box.s, np.box.w, np.box.n, np.box.e].map((x) => x.toFixed(4)).join(','));
    if (np.sel) q.set('s', `${np.sel.la},${np.sel.lo}`);
    try { history.replaceState(null, '', '#np?' + q); } catch (e) { /* ignore */ }
  }
  function readHash() {
    if (!location.hash.startsWith('#np')) return false;
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const la = parseFloat(q.get('la')), lo = parseFloat(q.get('lo'));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return true;
    const r = +q.get('r'); if (RADII.includes(r)) np.r = r;
    np.night = Math.max(0, Math.min(2, +q.get('nt') || 0));
    np.mode = q.get('m') === 'd' ? 'd' : 'n'; document.querySelectorAll('#npMode button').forEach((b) => { const on = b.dataset.m === np.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); syncMode();
    const want = (q.get('s') || '').split(',').map(Number);
    np.center = { lat: la, lon: lo, name: q.get('n') || null };
    $('npWhere').value = np.center.name || `${la}, ${lo}`;
    const bb = (q.get('bb') || '').split(',').map(Number);
    if (bb.length === 4 && bb.every(Number.isFinite)) { const b = clampBox({ lat: bb[0], lng: bb[1] }, { lat: bb[2], lng: bb[3] }); setBox({ s: bb[0], w: bb[1], n: b.lat, e: b.lng }, false); }
    search().then(() => { if (want.length === 2) { const s = np.all.find((x) => Math.abs(x.la - want[0]) < 1e-4 && Math.abs(x.lo - want[1]) < 1e-4); if (s) select(s, true); } });
    return true;
  }
  function syncMode() {   // the day labels or the night labels; the night-only and day-only options
    document.querySelectorAll('#npNight button').forEach((b) => { b.textContent = t((np.mode === 'd' ? 'np.day.' : 'np.night.') + b.dataset.n); });
    $('npOptTent').hidden = np.mode === 'd'; $('npOptLay').hidden = np.mode === 'd';
    document.getElementById('view-natt').classList.toggle('np-day', np.mode === 'd');
  }
  let wired = false;
  function wire() {
    if (wired) return; wired = true;
    ['r', 'veh', 'night', 'mode'].forEach((k) => { const v = ls('glett.np.' + k); if (v != null) np[k] = /^\d+$/.test(v) ? +v : v; });
    if (!RADII.includes(np.r)) np.r = 25;
    if (np.mode !== 'd') np.mode = 'n';
    Object.keys(np.opts).forEach((k) => { const v = ls('glett.np.o.' + k); if (v != null) np.opts[k] = v === '1'; });
    // the area: a radius round a place, or a rectangle drawn on the map (np.box)
    const rad = $('npRad'), syncR = () => rad.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.r === 'box' ? !!(np.box || np.drawing) : !np.box && !np.drawing && +b.dataset.r === np.r;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    rad.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.r === 'box') { drawing(true); return; }
      np.r = +b.dataset.r; ls('glett.np.r', String(np.r)); const had = np.box; drawing(false);
      if (had) setCenter({ lat: np.center.lat, lon: np.center.lon, name: null }, true); else { syncR(); if (np.center) search(); }
    });
    np.syncR = syncR; syncR();
    seg('npVeh', 'v', 'veh', () => np.center && search());
    seg('npNight', 'n', 'night', () => np.center && search());
    seg('npMode', 'm', 'mode', () => { syncMode(); if (np.center) search(); });
    syncMode();
    opt('npOptWater', 'water'); opt('npOptTent', 'tent'); opt('npOptLay', 'lay'); opt('npOptGravel', 'gravel'); opt('npOptGate', 'gate');
    const bb = $('npBars'), syncB = () => { bb.classList.toggle('on', np.bars); bb.setAttribute('aria-pressed', String(np.bars)); $('npLegend').hidden = !np.bars; };
    np.bars = ls('glett.np.bars') === '1'; syncB();
    bb.addEventListener('click', () => { np.bars = !np.bars; ls('glett.np.bars', np.bars ? '1' : null); syncB(); MAP.bars(); });
    $('npGo').addEventListener('click', async () => {
      const q = $('npWhere').value.trim();
      if (np.center && (q === np.center.name || q === `${np.center.lat.toFixed(4)}, ${np.center.lon.toFixed(4)}`)) return search();
      const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (ll) return setCenter({ lat: +ll[1], lon: +ll[2], name: null }, true);
      if (!q) return status(t('np.err.where'), 'err');
      try {
        const res = await WEFO.search(q, LANG);
        const ll2 = (r) => [r.lat ?? r.latitude, r.lon ?? r.longitude];
        const nordic = (r) => { const [la, lo] = ll2(r); return la > 54 && la < 71.5 && lo > 4 && lo < 32; };   // the data's area
        const hit = (res || []).find(nordic) || (res || [])[0];
        if (!hit) return status(t('np.err.noplace', { q }), 'err');
        const [la, lo] = ll2(hit);
        setCenter({ lat: +la, lon: +lo, name: hit.name }, true);
      } catch (e) { status(t('np.err.data', { e: e.message || e }), 'err'); }
    });
    $('npWhere').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('npGo').click(); });
    $('npGeo').addEventListener('click', async () => {
      const b = $('npGeo'); b.classList.add('busy'); status(t('np.drive.geo'));
      try { const p = await geo(); np.origin = p; status(''); setCenter(p, true); } catch (e) { status(t('np.drive.nogeo'), 'err'); } finally { b.classList.remove('busy'); }
    });
    $('npFit').addEventListener('click', () => MAP.fitAll());
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && np.drawing) drawing(false); });
    $('npSaved').addEventListener('click', (e) => {
      const rm = e.target.closest('.np-savedrm'), go = e.target.closest('.np-savedgo'), all = camps();
      if (rm) { const c = all[+rm.dataset.i]; if (c) { ls(CAMPS, JSON.stringify(all.filter((x) => x !== c))); renderCamps(); if (np.list.length) render(); } }
      else if (go && all[+go.dataset.i]) openCamp(all[+go.dataset.i]);
    });
    renderCamps();
    $('npFilt').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (b) refine(b.dataset.f); });
    $('npFilt').addEventListener('toggle', (e) => { if (e.target.classList.contains('np-filtd')) np.filtOpen = e.target.open; }, true);
    const sb = $('npSun'), syncS = () => { sb.classList.toggle('on', np.sun); sb.setAttribute('aria-pressed', String(np.sun)); sb.title = t('np.sunmap.note'); $('npSunBox').hidden = !np.sun; };
    $('npSunDate').addEventListener('change', (e) => { np.sunDay = e.target.value || null; np.sunMin = null; MAP.sun(); });
    $('npSunT').addEventListener('input', (e) => { np.sunMin = +e.target.value; MAP.sun(); });
    np.sun = ls('glett.np.sun') === '1'; syncS();
    sb.addEventListener('click', () => { np.sun = !np.sun; ls('glett.np.sun', np.sun ? '1' : null); syncS(); MAP.sun(); if (np.sun) kvToast(t('np.sunmap.note')); });
    $('npPick').addEventListener('click', () => { drawing(false); np.pick = true; $('npMap').classList.add('np-picking'); kvToast(t('np.pick')); MAP.init(); });
    $('npList').addEventListener('click', (e) => { const b = e.target.closest('.np-item'); if (b) select(np.list[+b.dataset.i], true); });
    $('npEdit').addEventListener('click', () => { const v = $('view-natt'); v.classList.toggle('np-form-open'); $('npEdit').setAttribute('aria-expanded', String(v.classList.contains('np-form-open'))); });
    const baseBtn = $('npBase'); baseLabel(baseBtn);
    baseBtn.addEventListener('click', () => {   // a pick here wins over the automatic map abroad
      const m = MAP.m, now = (m && m.__base) || baseChoice();
      setBaseChoice(now === 'osm' ? 'kartverket' : 'osm'); ls('glett.np.basepicked', '1'); if (m) delete m.__base; baseLabel(baseBtn, m); applyBase(m);
    });
    $('npFull').addEventListener('click', () => setFull(!(FULL && FULL.on))); fullLabel();
    mapControls($('npMap'), { base: baseBtn, full: $('npFull') });
    summary();
  }
  /* The whole window (computers, as Kjørevær's): the map on the left, the list in a side panel on the right (its width dragged
     by the grip), and the picked spot's details floating over the map's lower left corner, folded to its name when wanted */
  let FULL = null;
  function fullLabel() {
    const b = $('npFull'), on = !!(FULL && FULL.on);
    b.textContent = t(on ? 'kv.map.normal' : 'kv.map.full'); b.setAttribute('aria-pressed', String(on));
  }
  function setFull(on) {
    if (!FULL) FULL = fullMap({ wrap: $('npMapWrap'), cards: [$('npListCard'), $('npSavedCard')], key: 'glett.np.side', side: Math.max(20, Math.min(35, 36000 / innerWidth)), onToggle: (v) => { floatDetail(v); fullLabel(); },
      onLayout: () => { if (MAP.m) MAP.m.resize(); } });
    FULL.open(on);
  }
  function floatDetail(on) {
    const D = $('npDetail');
    let f = $('npFloat');
    if (!on) { if (D._home) D._home.after(D); if (f) f.remove(); return; }
    if (!f) {
      f = document.createElement('div'); f.id = 'npFloat'; f.className = 'np-float';
      f.innerHTML = '<button type="button" class="np-float-bar" aria-expanded="true"><b></b><span class="np-float-chev" aria-hidden="true"></span></button>';
      f.firstChild.addEventListener('click', () => fold(!f.classList.contains('folded')));
      // the panel sits inside the map's container: the map must not take its scrolling, drags and double clicks
      ['wheel', 'mousedown', 'pointerdown', 'touchstart', 'dblclick'].forEach((ev) => f.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
      new MutationObserver(syncFloat).observe(D, { attributes: true, attributeFilter: ['hidden'] });
    }
    if (!D._home) { D._home = document.createComment('np-detail-home'); D.parentElement.insertBefore(D._home, D); }
    f.appendChild(D); $('npMap').appendChild(f);
    fold(ls('glett.np.float') === '1'); syncFloat();
  }
  function fold(on) {
    const f = $('npFloat'); if (!f) return;
    f.classList.toggle('folded', on); f.firstChild.setAttribute('aria-expanded', String(!on)); f.firstChild.title = t(on ? 'np.float.open' : 'np.float.fold');
    ls('glett.np.float', on ? '1' : null);
  }
  function syncFloat() {   // the floating panel: the picked spot's name on its bar, gone while nothing is picked
    const f = $('npFloat'); if (!f || !f.isConnected) return;
    f.hidden = $('npDetail').hidden || !np.sel;
    f.firstChild.querySelector('b').textContent = np.sel ? `${np.list.includes(np.sel) ? np.list.indexOf(np.sel) + 1 + '. ' : ''}${title(np.sel)}` : '';
  }
  window.npShow = function () {
    wire();
    if (!hasGL) { $('npMap').innerHTML = `<p class="hint np-nogl">${esc(t('np.nogl'))}</p>`; }
    MAP.init();
    loadIndex().catch(() => status(t('np.err.data', { e: 'index' }), 'err'));
    if (!readHash() && np.center) writeHash();
  };
  window.npLang = function () { built(); if (!wired) return; syncMode(); summary(); if (np.list.length) render(); if (np.sel) select(np.sel, false); };
  // for Kjørevær's stops along a route (js/route.js): the spot tiles, the score per mode, the words, the way in, saved spots
  window.npStops = { loadIndex, loadSpots, placeScore, title, where, reasons, wayIn, svcHtml, isCamp, toggleCamp: (s) => toggleCamp(s), cellKey,
    open: (s, mode) => `#np?la=${s.la.toFixed(4)}&lo=${s.lo.toFixed(4)}&r=10${mode === 'd' ? '&m=d' : ''}&s=${s.la},${s.lo}` };
  window.npEngine = { map: () => MAP.m, np, setBox, sunAz, starry, loadIndex, loadSpots, loadBars, wayIn, barriersOn, cellsAround, decode5, nightSpan, sunTimes };   // for tests
  if (location.hash.startsWith('#np')) setTimeout(() => showView('natt'), 0);
  addEventListener('hashchange', () => { if (location.hash.startsWith('#np') && !$('view-natt').classList.contains('active')) showView('natt'); });
})();
