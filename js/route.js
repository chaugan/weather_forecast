'use strict';
/* ================= Kjørevær: the weather along a driving route =================
   A -> B by car, up to three alternative routes, the forecast at the time you will be at each point, for a departure
   now or up to three days ahead. No turn-by-turn: a road-number itinerary and a hand-off to a navigation app.
   Three registries keep it expandable without touching the engine:
     KV_ROUTERS   – routing services (Statens vegvesen via api/route.php, Valhalla/OpenStreetMap in the browser)
     KV_REGIONS   – where Kjørevær works, which routers, map and road-number style apply (Norway first)
     KV_PROFILES  – vehicles: routing options per router plus weather thresholds and weights (car; motorcycle with
                    the same roads for now, a curvy-road router can be added to its `routers` later)
   Weather: one Open-Meteo multi-location request for every sample of every route (the server never proxies it),
   elevations from Open-Meteo's elevation API, MET warnings through api/alerts.php. Saved routes live only in this
   browser (localStorage 'glett.routes') and go with the saved places in export / import. */
(function () {
  const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';   // FOSSGIS demo: fair use, so results are cached and calls kept few
  const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const OM_ELEV = 'https://api.open-meteo.com/v1/elevation';
  const MAX_AHEAD_H = 72;          // departures up to three days ahead
  const DENSE_KM = 2;              // elevation profile spacing
  const WX_MIN = 10, WX_KM = 20;   // a weather sample every 10 minutes of driving or 20 km, whichever comes first
  const WX_VARS = ['temperature_2m', 'precipitation', 'weather_code', 'wind_gusts_10m', 'is_day', 'dew_point_2m'];
  const FC_TTL = 30 * 60e3;        // a forecast set is refetched after half an hour

  const FETCH_MS = 25000;
  function fetchT(url, o = {}) {   // fetch with a time limit; a hung server becomes an error the page can show
    const c = new AbortController(), tm = setTimeout(() => c.abort(), FETCH_MS);
    return fetch(url, { ...o, signal: c.signal }).catch((e) => { throw e.name === 'AbortError' ? new Error(t('kv.err.timeout', { host: new URL(url, location.href).host })) : e; }).finally(() => clearTimeout(tm));
  }

  /* ---------------- registries ---------------- */
  const KV_ROUTERS = {
    vegvesen: {   // Statens vegvesen Ruteplantjeneste v3 through api/route.php (credentials stay on the server)
      label: 'Statens vegvesen', can: { noFerry: true, curvy: false, noGravel: false },
      _ok: null, _at: 0,
      async available() {   // a yes is kept; a no is asked again after ten minutes (credentials added, server back)
        if (this._ok === null || (!this._ok && Date.now() - this._at > 10 * 60e3)) {
          this._at = Date.now();
          try { const r = await fetchT('api/route.php?status=1'); this._ok = r.ok && !!(await r.json()).vegvesen; } catch (e) { this._ok = false; }
        }
        return this._ok;
      },
      async route(req) {
        const stops = [req.from, ...req.via, req.to].map((p) => `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}`).join(';');
        const o = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(req.depart).map((x) => [x.type, x.value]));
        const st = `${o.year}${o.month}${o.day}${o.hour}00`;   // the server reads it as Oslo time
        const r = await fetchT(`api/route.php?stops=${encodeURIComponent(stops)}&kind=${req.profile.routers.vegvesen.kind}&start=${st}&lang=${LANG}${req.opts.noFerry ? '&noferry=1' : ''}`);
        if (!r.ok) throw new Error('vegvesen ' + r.status);
        return fromVegvesen(await r.json(), req);
      },
    },
    valhalla: {   // OpenStreetMap; the FOSSGIS server allows browser calls (CORS *)
      label: 'Valhalla / OpenStreetMap', can: { noFerry: true, curvy: true, noGravel: true },
      async available() { return true; },
      async route(req) {
        const pts = [req.from, ...req.via, req.to];
        const o = req.opts.curvy && req.profile.routers.valhalla.curvy ? req.profile.routers.valhalla.curvy : req.profile.routers.valhalla;
        const co = { ...(o.options || {}), ...(req.opts.noFerry ? { use_ferry: 0 } : {}), ...(req.opts.noGravel ? { exclude_unpaved: true } : {}) };
        const body = { locations: pts.map((p, i) => ({ lat: +p.lat, lon: +p.lon, type: i === 0 || i === pts.length - 1 ? 'break' : 'through' })),
          costing: o.costing, costing_options: { [o.costing]: co }, alternates: req.via.length ? 0 : 2, units: 'kilometers', elevation_interval: 200,
          ...(typeof KV_RU_EXCLUDE !== 'undefined' ? { exclude_polygons: [KV_RU_EXCLUDE] } : {}),   // the border with Russia is in practice closed
          language: LANG === 'nb' ? 'nb-NO' : 'en-US', directions_type: 'maneuvers' };
        const ask = async (b) => { const r = await fetchT(VALHALLA_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.ok ? r.json() : null; };
        let j = await ask(body), forced = false;
        if (!j && body.exclude_polygons) { delete body.exclude_polygons; j = await ask(body); }   // refused: route without it (the Russia check on the result remains)
        if ((!j || !j.trip) && co.exclude_unpaved) {   // no route without gravel: route anyway and say so on the cards
          delete co.exclude_unpaved; j = await ask(body); forced = true;
        }
        if (!j || !j.trip) throw new Error('valhalla: no route');
        return [j.trip, ...(j.alternates || []).map((a) => a.trip)].map((tr) => Object.assign(fromValhalla(tr), { gravelForced: forced }));
      },
    },
  };
  // Road numbers as people say them in Norway: E 16, Rv 7 (one or two digits), Fv 243 (three or four)
  const refNorway = (s) => {
    s = String(s || '').trim();
    let m = s.match(/^E\s?(\d{1,3})$/i); if (m) return 'E ' + m[1];
    m = s.match(/^(?:rv\.?|riksvei|riksveg)?\s?(\d{1,2})$/i); if (m) return 'Rv ' + m[1];
    m = s.match(/^(?:fv\.?|fylkesvei|fylkesveg)?\s?(\d{3,4})$/i); if (m) return 'Fv ' + m[1];
    return null;
  };
  const KV_REGIONS = [
    { id: 'no', contains: (la, lo) => la >= 57.8 && la <= 71.3 && lo >= 4.5 && lo <= 31.3, routers: ['vegvesen', 'valhalla'], tiles: 'kartverket',
      ref: refNorway, status: { url: 'https://www.vegvesen.no/trafikk/' }, elevation: 'kartverket', addresses: 'geonorge', roads: 'nvdb' },
    // next: { id: 'se', contains: …, routers: ['valhalla'], tiles: 'osm', ref: refSweden, status: null }
  ];
  const KV_PROFILES = {
    car: { id: 'car', routers: { valhalla: { costing: 'auto', curvy: { costing: 'auto', options: { use_highways: 0, use_tolls: 0.5 } } }, vegvesen: { kind: 'best' } }, gust: 20,
      w: { dry: 0, fog: 2, wet: 1, heavy: 3, sleet: 4, snow: 6, ice: 9, thunder: 4 }, gustW: 2, darkW: 0 },
    // Motorcycle: normal routing for now; weather counts for more. A curvy-road router (Kurviger, BRouter, Valhalla
    // motorcycle costing with use_highways) plugs in here later, e.g. routers: { curvy: {...}, valhalla: {...} }
    // curvy: Valhalla's motorcycle costing kept off motorways and trunk roads (tested Oslo-Lillehammer: 34 -> 91-106 degrees of
    // turning per km, about 2 h longer). A dedicated curvy-road service (Kurviger) could replace it here later.
    mc: { id: 'mc', routers: { valhalla: { costing: 'auto', curvy: { costing: 'motorcycle', options: { use_highways: 0, use_tolls: 0.5 } } }, vegvesen: { kind: 'best' } }, gust: 13,
      w: { dry: 0, fog: 3, wet: 3, heavy: 6, sleet: 8, snow: 10, ice: 12, thunder: 8 }, gustW: 4, darkW: 1 },
  };
  // Driver weather classes: similar weather is one class (drizzle and rain are both "wet")
  const KV_CLASSES = ['dry', 'fog', 'wet', 'heavy', 'sleet', 'snow', 'ice', 'thunder'];
  const PACE = { snow: 1.25, sleet: 1.15, ice: 1.3, heavy: 1.05, fog: 1.1 };   // slower driving in bad weather moves the later samples

  /* ---------------- small helpers ---------------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  const hm = (d) => d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const wday = (d) => d.toLocaleDateString(dateLocale(), { weekday: 'short' }).replace('.', '');
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const hav = (a, b) => { const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const dur = (min) => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h ? t('kv.dur.hm', { h, m }) : t('kv.dur.m', { m }); };
  const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const regionOf = (p) => KV_REGIONS.find((r) => r.contains(+p.lat, +p.lon)) || null;
  function decode6(s) {
    let i = 0, lat = 0, lon = 0; const out = [];
    while (i < s.length) {
      for (let k = 0; k < 2; k++) {
        let sh = 0, r = 0, b;
        do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
        const d = r & 1 ? ~(r >> 1) : r >> 1;
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lat / 1e6, lon / 1e6]);
    }
    return out;
  }

  /* ---------------- router answers -> one route model ----------------
     { coords: [[lat, lon]], cumKm: [], cumS: [], km, sec, steps: [{i0, i1, km, sec, ref, name, toward, ferry, text}],
       features: { ferries: [{km, name}], tunnels: [], exposed: [], closures: [] }, obstructed, source } */
  function finish(coords, steps, source) {
    const cumKm = [0];
    for (let i = 1; i < coords.length; i++) cumKm.push(cumKm[i - 1] + hav(coords[i - 1], coords[i]));
    const cumS = new Array(coords.length).fill(0); let T = 0;
    steps.forEach((s) => {
      const L = Math.max(cumKm[s.i1] - cumKm[s.i0], 1e-9);
      for (let j = s.i0; j <= s.i1; j++) cumS[j] = T + s.sec * (cumKm[j] - cumKm[s.i0]) / L;
      T += s.sec;
    });
    for (let j = 1; j < cumS.length; j++) if (cumS[j] < cumS[j - 1]) cumS[j] = cumS[j - 1];
    steps.forEach((s) => { s.km0 = cumKm[s.i0]; s.km1 = cumKm[s.i1]; });
    return { coords, cumKm, cumS, km: cumKm[cumKm.length - 1], sec: T, steps, source, features: { ferries: [], tunnels: [], exposed: [], closures: [] }, obstructed: false };
  }
  function fromValhalla(trip) {
    const coords = [], steps = [], elev = [];   // elev: road height every 200 m along the route (Valhalla elevation_interval)
    trip.legs.forEach((leg) => {
      if (Array.isArray(leg.elevation)) leg.elevation.forEach((z, i) => { if (!(elev.length && i === 0)) elev.push(z); });
      const off = coords.length ? coords.length - 1 : 0, shape = decode6(leg.shape);
      shape.forEach((p, i) => { if (!(off && i === 0)) coords.push(p); });
      leg.maneuvers.forEach((m) => {
        if (m.begin_shape_index === m.end_shape_index && !m.length) return;
        const name = (m.street_names || m.begin_street_names || [])[0] || '';
        const tw = m.sign && m.sign.exit_toward_elements && m.sign.exit_toward_elements[0] ? m.sign.exit_toward_elements[0].text : '';
        steps.push({ i0: off + m.begin_shape_index, i1: off + m.end_shape_index, sec: m.time || 0, km: m.length || 0, ref: refNorway(name) || refFromText(name), name, toward: tw,
          ferry: m.travel_type === 'ferry' || m.type === 28 || m.type === 29, text: m.instruction || '' });
      });
    });
    const r = finish(coords, steps, 'valhalla');
    if (elev.length > 1) r.elevAt = (km) => elev[Math.max(0, Math.min(elev.length - 1, Math.round(km / 0.2)))];
    r.steps.filter((s) => s.ferry).forEach((s) => r.features.ferries.push({ km: s.km0, km1: s.km1, name: s.name }));
    return r;
  }
  function refFromText(s) {
    const m = String(s || '').match(/\b(E\s?\d{1,3}|(?:Rv|Fv|riksvei|riksveg|fylkesvei|fylkesveg)\.?\s?\d{1,4})\b/i);
    return m ? refNorway(m[1].replace(/^(rv|fv|riksvei|riksveg|fylkesvei|fylkesveg)\.?\s?/i, (x) => (/^r/i.test(x) ? 'rv ' : 'fv '))) : null;
  }
  /* Vegvesen v3: each route is a GeoJSON FeatureCollection of route parts with time, length, maneuverText and the road
     features along it. Units are checked against the straight distance (km vs m, minutes vs seconds), since the spec
     does not state them; to be confirmed with the first real answer. */
  function fromVegvesen(j, req) {
    if (!j || !Array.isArray(j.routes)) throw new Error('vegvesen: no routes');
    const straight = hav([+req.from.lat, +req.from.lon], [+req.to.lat, +req.to.lon]);
    return j.routes.map((rt) => {
      const coords = [], parts = [], zs = [];
      (rt.features || []).forEach((f) => {
        const g = f.geometry && f.geometry.coordinates || [], off = coords.length ? coords.length - 1 : 0;
        g.forEach((c, i) => { if (!(off && i === 0)) { coords.push([c[1], c[0]]); zs.push(c.length > 2 ? +c[2] : null); } });
        parts.push({ i0: off, i1: Math.max(off, coords.length - 1), p: f.properties || {} });
      });
      let L = parts.reduce((s, x) => s + (+x.p.length || 0), 0), T = parts.reduce((s, x) => s + (+x.p.time || 0), 0);
      const kmK = L > straight * 50 ? 0.001 : 1;
      const secK = (() => { const km = L * kmK; return [60, 1, 3600].find((k) => { const v = km / (T * k / 3600); return v > 15 && v < 140; }) || 60; })();
      const steps = parts.map((x) => ({ i0: x.i0, i1: x.i1, km: (+x.p.length || 0) * kmK, sec: (+x.p.time || 0) * secK, ref: refFromText(x.p.maneuverText), name: '', toward: '',
        ferry: /ferje|ferge|ferry/i.test(x.p.maneuverText || ''), text: x.p.maneuverText || '' }));
      const r = finish(coords, steps, 'vegvesen');
      if (zs.some((z) => z != null && Number.isFinite(z))) r.elevAt = (km) => { let i = r.cumKm.findIndex((k) => k >= km); if (i < 0) i = zs.length - 1; return zs[i]; };
      const near = (loc) => { if (!loc) return null; const p = [+loc.y, +loc.x]; let b = 0, bd = 1e9; r.coords.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2; if (d < bd) { bd = d; b = i; } }); return r.cumKm[b]; };
      parts.forEach((x) => {
        const rf = x.p.roadFeatures || {};
        (rf.ferger || []).forEach((f) => r.features.ferries.push({ km: near(f.location), name: f.navn }));
        (rf.tunneler || []).forEach((f) => r.features.tunnels.push({ km: near(f.location), name: f.navn, m: +f.lengde || 0 }));
        (rf.varutsatteVeger || []).forEach((f) => r.features.exposed.push({ km: near(f.location), name: f.navn }));
        [...(rf.vegsperringer || []), ...(rf.trafficMessages || []).filter((m) => /clos|steng/i.test(m.type + ' ' + m.trafficImpact))]
          .forEach((f) => r.features.closures.push({ km: near(f.location), name: f.note || f.type || '', url: f.simpleDetailsUrl || '' }));
      });
      r.obstructed = !!rt.isObstructed;
      return r;
    });
  }

  /* How bendy a route is: degrees of heading change per km, measured on the road resampled every 100 m (so the router's
     point density does not matter). Oslo-Lillehammer on the E6 is about 34, the motorcycle's bendy alternatives 90-106. */
  function bendiness(R) {
    const pts = [R.coords[0]], toKm = (a, b) => Math.hypot((b[0] - a[0]) * 111.2, (b[1] - a[1]) * 111.2 * Math.cos(a[0] * Math.PI / 180));
    for (const c of R.coords) if (toKm(pts[pts.length - 1], c) >= 0.1) pts.push(c);
    let turn = 0, km = 0;
    for (let i = 2; i < pts.length; i++) {
      const [a, b, c] = [pts[i - 2], pts[i - 1], pts[i]], k = Math.cos(b[0] * Math.PI / 180);
      const h1 = Math.atan2((b[1] - a[1]) * k, b[0] - a[0]), h2 = Math.atan2((c[1] - b[1]) * k, c[0] - b[0]);
      turn += Math.abs(((h2 - h1) * 180 / Math.PI + 540) % 360 - 180); km += toKm(b, c);
    }
    return km > 1 ? turn / km : 0;
  }
  const bendLevel = (b) => (b < 45 ? 'low' : b < 80 ? 'mid' : b < 120 ? 'high' : 'max');

  /* ---------------- countries along the route ----------------
     Valhalla may route through Sweden, Finland or (rarely) Russia. js/borders.js (loaded on first use) has their outlines;
     a stretch is abroad only when it lies inside one of them. Abroad: road numbers keep their own form ("E 10", "21"), the
     Norway-only extras (NVDB widths, Vegvesen pass link) are skipped, and Russia is avoided (Valhalla exclude_polygons). */
  let bordersReady = null;
  const loadBorders = () => (bordersReady ||= new Promise((res) => {
    if (typeof KV_ABROAD !== 'undefined') return res(true);
    const sc = document.createElement('script'); sc.src = 'js/borders.js?v=' + ((document.querySelector('script[src*="js/route.js"]') || {}).src || '').split('v=')[1];
    sc.onload = () => res(true); sc.onerror = () => res(false); document.head.appendChild(sc);
  }));
  const ringBox = new Map();
  function inLatLonRing(la, lo, r) {   // rings are [lat, lon]; a bounding box first
    let b = ringBox.get(r); if (!b) { b = r.reduce((m, [a, o]) => [Math.min(m[0], a), Math.min(m[1], o), Math.max(m[2], a), Math.max(m[3], o)], [90, 180, -90, -180]); ringBox.set(r, b); }
    if (la < b[0] || la > b[2] || lo < b[1] || lo > b[3]) return false;
    let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [yi, xi] = r[i], [yj, xj] = r[j]; if ((yi > la) !== (yj > la) && lo < (xj - xi) * (la - yi) / (yj - yi) + xi) c = !c; }
    return c;
  }
  function countryAt(la, lo) {
    if (typeof KV_ABROAD === 'undefined') return 'NO';
    for (const cc in KV_ABROAD) if (KV_ABROAD[cc].some((r) => inLatLonRing(la, lo, r))) return cc;
    return 'NO';
  }
  const foreignRef = (name) => { const v = String(name || '').trim(); const e = v.match(/^E\s?(\d{1,3})$/i); return e ? 'E ' + e[1] : /^\d{1,4}$/.test(v) ? v : null; };
  function markCountries(R) {
    R.countries = new Set();
    R.steps.forEach((st) => {
      const c = R.coords[Math.floor((st.i0 + st.i1) / 2)] || R.coords[st.i0], cc = countryAt(c[0], c[1]);
      if (cc !== 'NO') { st.country = cc; st.ref = foreignRef(st.name); R.countries.add(cc); }
    });
    R.russia = R.countries.has('RU');
  }

  /* ---------------- road facts along the route: narrow roads ----------------
     Each region may name a road-data source. In Norway that is NVDB, the Norwegian Public Roads Administration's open road
     database (no key, CORS open): the carriageway width (object type 838, "Kjørebanebredde") of every stretch of the
     E-, Rv- and Fv-roads the routes use, one request per road number limited to the routes' area. A stretch narrower than
     NARROW_M counts as narrow (two cars meet with care; around 4 m it is in practice one lane with passing places).
     Municipal and private roads are not covered. The result arrives after the weather and redraws the cards. */
  const NARROW_M = 5.5;
  const ROAD_SOURCES = {
    nvdb: {
      cache: new Map(),
      async widths(ref, bbox) {
        const code = ref.replace(/^E\s?/, 'EV').replace(/^Rv\s?/, 'RV').replace(/^Fv\s?/, 'FV').replace(/\s/g, ''), key = code + '|' + bbox;
        if (this.cache.has(key)) return this.cache.get(key);
        const out = []; let url = `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/838?vegsystemreferanse=${code}&kartutsnitt=${bbox}&srid=4326&inkluder=egenskaper,geometri&antall=1000`;
        for (let page = 0; url && page < 5; page++) {
          let j; try { const r = await fetchT(url, { headers: { Accept: 'application/json' } }); if (!r.ok) break; j = await r.json(); } catch (e) { break; }
          (j.objekter || []).forEach((o) => {
            const e = o.egenskaper || [], w = (e.find((x) => x.navn === 'Kjørebanebredde') || e.find((x) => x.navn === 'Dekkebredde') || {}).verdi;
            const wkt = o.geometri && o.geometri.wkt; if (w == null || !wkt) return;
            const pts = wkt.replace(/[A-Z]+/g, '').replace(/[()]/g, '').split(',').map((q) => q.trim().split(/\s+/).map(Number)).filter((a) => a.length >= 2).map((a) => [a[0], a[1]]);   // srid 4326: lat lon
            if (pts.length) out.push({ w: +w, pts });
          });
          const n = j.metadata && j.metadata.neste; url = (j.objekter || []).length >= 1000 && n && n.href ? n.href : null;
        }
        this.cache.set(key, out); return out;
      },
    },
  };
  function routeIndex(R) {   // route vertices bucketed by ~1 km cells, for "where along the route is this point"
    const g = new Map(); R.coords.forEach((c, i) => { const k = `${Math.round(c[0] * 100)},${Math.round(c[1] * 50)}`; if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
    return (lat, lon) => {
      let best = null, bd = 60 * 60;   // within 60 m
      const k0 = Math.round(lat * 100), k1 = Math.round(lon * 50), cs = Math.cos(lat * Math.PI / 180);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (g.get(`${k0 + a},${k1 + b}`) || []).forEach((i) => {
        const c = R.coords[i], d = ((c[0] - lat) * 111200) ** 2 + ((c[1] - lon) * 111200 * cs) ** 2; if (d < bd) { bd = d; best = R.cumKm[i]; } });
      return best;
    };
  }
  async function enrichRoads(routes, region) {
    const src = region && ROAD_SOURCES[region.roads]; if (!src) return;
    // one small request per stage (a stretch of one road number), limited to that stretch's own area, 4 at a time;
    // stages shared by several routes are asked once
    const box = (R, st) => { let s = 90, w = 180, n = -90, e = -180; for (let i = st.i0; i <= st.i1; i++) { const [la, lo] = R.coords[i]; s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
      return [w - 0.01, s - 0.01, e + 0.01, n + 0.01].map((v) => (Math.round(v * 100) / 100).toFixed(2)).join(','); };
    const jobs = new Map(), use = routes.map(() => []);
    routes.forEach((R, ri) => R.steps.forEach((st) => { if (!st.ref || st.km < 0.2 || st.ferry || st.country) return; const k = st.ref + '|' + box(R, st); if (!jobs.has(k)) jobs.set(k, { ref: st.ref, bbox: k.split('|')[1] }); use[ri].push(k); }));
    const keys = [...jobs.keys()].slice(0, 80), got = new Map();
    if (jobs.size > 80) console.warn('Kjørevær road data: only the first 80 of', jobs.size, 'stretches are checked');
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (next < keys.length) { const k = keys[next++], jb = jobs.get(k); got.set(k, await src.widths(jb.ref, jb.bbox).catch(() => [])); } }));
    routes.forEach((R, ri) => {
      const at = routeIndex(R), spans = [];
      [...new Set(use[ri])].forEach((k) => (got.get(k) || []).forEach((o) => {
        if (o.w >= NARROW_M) return;
        const ks = o.pts.map(([la, lo]) => at(la, lo)).filter((v) => v != null);
        if (ks.length) spans.push({ a: Math.min(...ks), b: Math.max(...ks), w: o.w });
      }));
      spans.sort((x, y) => x.a - y.a);
      const merged = []; spans.forEach((sp) => { const l = merged[merged.length - 1]; if (l && sp.a - l.b < 0.3) { l.b = Math.max(l.b, sp.b); l.w = Math.min(l.w, sp.w); } else merged.push({ ...sp }); });
      R.narrow = { spans: merged, km: merged.reduce((t, x) => t + (x.b - x.a), 0), min: merged.length ? Math.min(...merged.map((x) => x.w)) : null };
    });
  }

  /* ---------------- sampling ---------------- */
  function densify(r) {   // a point every DENSE_KM, with its driving time and whether it is on a ferry
    const out = []; let j = 0;
    for (let km = 0; km <= r.km + 1e-6; km = Math.min(r.km, km + DENSE_KM)) {
      while (j < r.cumKm.length - 2 && r.cumKm[j + 1] < km) j++;
      const a = r.cumKm[j], b = r.cumKm[j + 1] ?? a, f = b > a ? (km - a) / (b - a) : 0, p = r.coords[j], q = r.coords[j + 1] || p;
      out.push({ lat: p[0] + f * (q[0] - p[0]), lon: p[1] + f * (q[1] - p[1]), km, s: r.cumS[j] + f * ((r.cumS[j + 1] ?? r.cumS[j]) - r.cumS[j]), ferry: r.steps.some((s) => s.ferry && km >= s.km0 && km <= s.km1) });
      if (km >= r.km) break;
    }
    return out;
  }
  function passTops(d) {   // local maxima with real climbs on both sides: mountain crossings
    const tops = [];
    d.forEach((p, i) => {
      if (p.z == null || p.z < 550) return;
      const win = (k) => d.slice(Math.max(0, i - k), i + k + 1);
      if (win(8).some((q) => q.z > p.z)) return;   // highest within ±16 km
      const left = Math.min(...d.slice(Math.max(0, i - 25), i + 1).map((q) => q.z)), right = Math.min(...d.slice(i, i + 26).map((q) => q.z));
      if (p.z - left >= 350 && p.z - right >= 350) tops.push(i);
    });
    return tops;
  }
  function pickSamples(d, tops) {
    const idx = new Set([0, d.length - 1, ...tops]); let lt = 0, lk = 0;
    d.forEach((p, i) => { if (p.s - lt >= WX_MIN * 60 || p.km - lk >= WX_KM) { idx.add(i); lt = p.s; lk = p.km; } });
    return [...idx].sort((a, b) => a - b);
  }
  const cellKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)},${p.z == null ? 'x' : Math.round(p.z / 100)}`;   // ~1 km and 100 m of height: shared stretches of different routes share samples

  /* ---------------- data fetches (browser-side, cached in memory for the session) ---------------- */
  const elevCache = new Map(), fcCache = new Map();
  // Heights for the profile and the forecast: the router's own road heights first (Valhalla elevation_interval, Vegvesen
  // GeometryZ); otherwise the region's height service (Kartverket's 1 m terrain model in Norway), and Open-Meteo last
  // (it counts every coordinate against the visitor's quota, so it is only the fallback)
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
  async function fetchElev(routes) {
    const pts = [];
    routes.forEach((R) => R.dense.forEach((p) => { const z = R.elevAt ? R.elevAt(p.km) : null; if (z != null && Number.isFinite(z)) p.z = z; else pts.push(p); }));
    if (!pts.length) return;
    const key = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    const need = [...new Set(pts.map(key))].filter((k) => !elevCache.has(k));
    for (const id of [kv.region && kv.region.elevation, 'openmeteo'].filter(Boolean)) {
      const src = ELEV_SOURCES[id], left = need.filter((k) => !elevCache.has(k));
      if (!left.length) break;
      try { for (let i = 0; i < left.length; i += src.per) { const ch = left.slice(i, i + src.per); (await src.get(ch)).forEach((z, k) => { if (z != null && Number.isFinite(+z)) elevCache.set(ch[k], +z); }); } }
      catch (e) { console.warn('Kjørevær elevation', id, e); }
    }
    pts.forEach((p) => { const z = elevCache.get(key(p)); if (z != null) p.z = z; });   // unknown stays unknown
  }
  async function fetchForecast(samples) {   // samples: [{key, lat, lon, z}], one Open-Meteo request per 150 places
    const now = Date.now(), need = [];
    const seen = new Set();
    samples.forEach((s) => { const c = fcCache.get(s.key); if ((!c || now - c.at > FC_TTL) && !seen.has(s.key)) { seen.add(s.key); need.push(s); } });
    for (let i = 0; i < need.length; i += 150) {
      const ch = need.slice(i, i + 150);
      const q = new URLSearchParams({ latitude: ch.map((s) => s.lat.toFixed(3)).join(','), longitude: ch.map((s) => s.lon.toFixed(3)).join(','),
        // an unknown height is sent as nan: Open-Meteo then uses its own terrain model for that place
        elevation: ch.map((s) => (s.z == null ? 'nan' : Math.round(s.z))).join(','), hourly: WX_VARS.join(','), forecast_days: '5', timeformat: 'unixtime', wind_speed_unit: 'ms', timezone: 'GMT' });
      const r = await fetchT(`${OM_FORECAST}?${q}`);
      if (r.status === 429) throw new Error(t('err.quota', { host: 'api.open-meteo.com' }));
      if (!r.ok) throw new Error(t('err.upstream', { host: 'api.open-meteo.com', s: r.status }));
      let j = await r.json(); if (!Array.isArray(j)) j = [j];
      j.forEach((f, k) => { fcCache.set(ch[k].key, { at: now, t: f.hourly.time, h: f.hourly }); if (ch[k].z == null && Number.isFinite(f.elevation)) ch[k].z = f.elevation; });
    }
  }

  /* ---------------- weather engine ---------------- */
  function classify(code, mm, tc) {
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
  function wxAt(key, ms) {   // the forecast at a place and time: temperature and dew point interpolated, the rest from the hour you are in
    const c = fcCache.get(key); if (!c) return null;
    const x = (ms / 1000 - c.t[0]) / 3600;
    if (x < 0 || x > c.t.length - 1) return null;
    const i = Math.min(c.t.length - 2, Math.floor(x)), f = x - i, h = c.h;
    const k = Math.min(c.t.length - 1, Math.ceil(x));   // precipitation, weather code and gusts describe the hour that ends at k
    const lerp = (a) => (Number.isFinite(a[i]) && Number.isFinite(a[i + 1]) ? a[i] * (1 - f) + a[i + 1] * f : NaN);   // a missing value stays missing, never 0 °C
    return { t: lerp(h.temperature_2m), mm: h.precipitation[k] ?? 0, code: h.weather_code[k] ?? 0, g: h.wind_gusts_10m[k] ?? 0,
      day: h.is_day[Math.round(x)] ?? 1, dew: lerp(h.dew_point_2m) };   // is_day is an instant: the nearest hour
  }
  function along(R, depMs, prof) {
    const pts = []; let eta = depMs, extra = 0;
    R.samples.forEach((s, i) => {
      if (i) { const dt = s.s - R.samples[i - 1].s, f = PACE[pts[i - 1].cls] || 1; eta += dt * f * 1000; extra += dt * (f - 1); }
      const w = wxAt(s.key, eta) || { t: NaN, mm: 0, code: 0, g: 0, day: 1, dew: NaN };   // no forecast: summarise() marks the route as missing data
      const p = { ...s, at: new Date(eta), ...w };
      p.cls = classify(p.code, p.mm, p.t);
      p.gust = p.g >= prof.gust;
      p.dark = !p.day;
      p.slick = p.t > -4 && p.t <= 3 && (p.mm >= 0.1 || (Number.isFinite(p.dew) && p.t - p.dew < 1.5 && !p.day));   // air ≤ +3 °C with precipitation, or a damp clear night
      p.drift = (p.cls === 'snow' || p.cls === 'sleet') && p.g >= 15 && p.z != null && p.z >= 600;          // drifting snow on exposed high ground
      p.alert = alertAt(p);
      pts.push(p);
    });
    return { pts, extraMin: extra / 60 };
  }
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
  function crossings(pts) {   // 0 °C crossings in the order you drive, with ±1 °C hysteresis; the start counts by its sign
    const out = []; let st = null;
    pts.forEach((p, i) => {
      if (!Number.isFinite(p.t)) return;
      if (st === null) { st = p.t > 0 ? '+' : '-'; return; }
      const s = p.t >= 1 ? '+' : p.t <= -1 ? '-' : null;
      if (s && s !== st) { out.push({ i, dir: s === '-' ? 'down' : 'up' }); st = s; }
    });
    return out;
  }

  function summarise(R, depMs, prof) {
    const { pts, extraMin } = along(R, depMs, prof), seg = segments(pts, prof.w), x = crossings(pts);
    const mins = {};
    pts.forEach((p, i) => { if (!i) return; const m = (p.at - pts[i - 1].at) / 60e3; mins[pts[i - 1].cls] = (mins[pts[i - 1].cls] || 0) + m; });
    let sc = 0;
    pts.forEach((p, i) => { if (!i) return; const q = pts[i - 1], m = (p.at - q.at) / 60e3; if (q.ferry) return;
      sc += m * (prof.w[q.cls] + (q.gust ? prof.gustW : 0) + (q.slick ? 5 : 0) + (q.drift ? 6 : 0) + (q.dark ? prof.darkW : 0) + (q.alert ? 4 : 0)); });
    const valid = pts.every((p) => Number.isFinite(p.t));
    return { R, pts, seg, x, mins, extraMin, sc, valid, tmin: Math.min(...pts.map((p) => p.t)), gmax: Math.max(...pts.map((p) => p.g)),
      slick: pts.filter((p) => p.slick), alerts: [...new Set(pts.filter((p) => p.alert).map((p) => p.alert))],
      end: pts[pts.length - 1].at };
  }

  /* ---------------- MET warnings along the route ---------------- */
  let alerts = [];
  function inRing(pt, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
  function inGeom(lon, lat, g) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.some((p) => inRing([lon, lat], p[0]) && !p.slice(1).some((h) => inRing([lon, lat], h)));
  }
  function alertAt(p) {
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

  /* ---------------- state ---------------- */
  const kv = {
    from: null, to: null, via: [], veh: lsGet('glett.kv.veh') === 'mc' ? 'mc' : 'car', dep: null,
    routes: [], sel: 0, region: null, source: '', busy: false, token: 0, map: null, layers: [], cur: null, started: false,
    opts: Object.assign({ noFerry: false, noDark: false, curvy: false, noGravel: false }, lsJson('glett.kv.opts', {})),
  };
  // the profile with the visitor's choices applied: "avoid driving in the dark" makes every dark minute count heavily
  const prof = () => { const b = KV_PROFILES[kv.veh]; return kv.opts.noDark ? { ...b, darkW: 25 } : b; };
  const curvyOn = () => !!kv.opts.curvy;
  const routeKey = () => [kv.from, ...kv.via, kv.to].map((p) => `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}`).join(';');
  function depOptions() {   // whole hours from the next hour, up to three days ahead; "now" first
    const out = [new Date()], s = new Date(); s.setMinutes(0, 0, 0);
    for (let k = 1; k <= MAX_AHEAD_H; k++) out.push(new Date(+s + k * 3600e3));
    return out;
  }

  /* ---------------- main flow ---------------- */
  async function plan() {
    if (!kv.from || !kv.to) { status(t('kv.err.ab'), 'err', 'kv.err.ab'); return; }
    const reg = regionOf(kv.from), reg2 = regionOf(kv.to);
    if (!reg || !reg2 || reg !== reg2 || kv.via.some((v) => regionOf(v) !== reg)) { status(t('kv.err.region'), 'err', 'kv.err.region'); return; }
    if (hav([+kv.from.lat, +kv.from.lon], [+kv.to.lat, +kv.to.lon]) < 1) { status(t('kv.err.same'), 'err', 'kv.err.same'); return; }
    kv.region = reg;
    const tok = ++kv.token; kv.busy = true; $('kvGo').classList.add('busy'); status(t('kv.loading.route'), 'busy', 'kv.loading.route'); $('kvResult').hidden = true;
    await loadBorders();
    const req = { from: kv.from, to: kv.to, via: kv.via, depart: kv.dep || new Date(), profile: prof(), opts: { noFerry: kv.opts.noFerry, curvy: curvyOn(), noGravel: kv.opts.noGravel } };
    kv.routedAt = +req.depart;
    let routes = null, used = '';
    for (const id of reg.routers) {
      const r = KV_ROUTERS[id];
      if ((req.opts.curvy && !r.can.curvy) || (req.opts.noFerry && !r.can.noFerry) || (req.opts.noGravel && !r.can.noGravel)) continue;   // a router that cannot do what was asked is skipped
      try { if (await r.available()) { routes = await r.route(req); used = id; if (routes.length) break; } } catch (e) { console.warn('Kjørevær router', id, e); routes = null; }
    }
    if (tok !== kv.token) return;
    $('kvGo').classList.remove('busy');
    if (!routes || !routes.length) { kv.busy = false; status(t('kv.err.route'), 'err', 'kv.err.route'); return; }
    kv.source = used;
    try {
      status(t('kv.loading.wx'), 'busy', 'kv.loading.wx');
      routes = routes.slice(0, 3);
      for (const R of routes) { R.dense = densify(R); R.bend = bendiness(R); markCountries(R); }
      await fetchElev(routes);
      await loadAlerts();
      routes.forEach((R) => {
        R.tops = passTops(R.dense);
        R.samples = pickSamples(R.dense, R.tops).map((i) => ({ ...R.dense[i], di: i, key: cellKey(R.dense[i]), top: R.tops.includes(i) }));
      });
      await fetchForecast(routes.flatMap((R) => R.samples));
    } catch (e) { if (tok === kv.token) { kv.busy = false; $('kvGo').classList.remove('busy'); status(e.message || t('kv.err.wx'), 'err'); } return; }
    if (tok !== kv.token) return;
    nameRoutes(routes);
    kv.routes = routes; kv.sel = 0; kv.busy = false; kv.dirty = false;
    $('view-route').classList.remove('kv-isstale', 'kv-noroute'); showMap();   // the map was hidden before the first route: size it
    status('', ''); $('kvResult').hidden = false;
    saveLast(); writeHash();
    render();
    namePasses(routes, tok);
    enrichRoads(routes, kv.region).then(() => { if (tok === kv.token) render(); }).catch((e) => console.warn('Kjørevær road data', e));
  }
  function nameRoutes(routes) {   // "via Rv 7": the road this route uses most compared with the others
    const kmByRef = routes.map((R) => { const m = {}; R.steps.forEach((s) => { if (s.ref) m[s.ref] = (m[s.ref] || 0) + s.km; }); return m; });
    routes.forEach((R, i) => {
      const score = Object.entries(kmByRef[i]).map(([ref, km]) => [ref, km - Math.max(0, ...kmByRef.filter((_, k) => k !== i).map((m) => m[ref] || 0))]).sort((a, b) => b[1] - a[1]);
      R.via = score.length && (routes.length === 1 || score[0][1] >= 10) ? score[0][0] : '';
      R.viaCountry = (R.steps.find((x) => x.ref === R.via && x.country) || {}).country || '';
      R.passName = '';
    });
  }
  async function namePasses(routes, tok) {   // the highest pass of each route gets a place name (cached reverse geocoding on the server)
    for (const R of routes) {
      if (!R.tops.length) continue;
      const top = R.tops.map((i) => R.dense[i]).reduce((a, p) => (p.z > a.z ? p : a));
      try { const n = await WEFO.reverse(top.lat, top.lon, LANG, true); if (tok !== kv.token) return; if (n) { R.passName = String(n).split(',')[0]; R.passAt = top; } } catch (e) { /* keep it unnamed */ }
    }
    if (tok === kv.token) render();
  }

  /* ---------------- rendering ---------------- */
  function status(msg, kind, key) {   // key: the text key, so a language change can redraw it
    kv.st = msg ? { key, kind, msg } : null;
    const el = $('kvStatus'); el.hidden = !msg; el.className = 'kv-status ' + (kind || '');
    el.innerHTML = kind === 'busy' ? `<span class="spinner"></span> ${esc(msg)}` : esc(msg);
  }
  function render() {
    if (!kv.routes.length) return;
    const P = prof(), dep = kv.dep || new Date();
    const S = kv.routes.map((R) => summarise(R, +dep, P));
    kv.S = S;
    renderDeps(); renderCards(S); renderChart(S[kv.sel]); renderMap(S); renderIt(S[kv.sel]);
    $('kvSource').innerHTML = t('kv.source.' + kv.source);
  }
  function verdicts(S) {
    const ok = S.map((s) => s.valid && !s.R.obstructed && !s.R.russia);
    const order = S.map((s, i) => i).filter((i) => ok[i]).sort((a, b) => S[a].sc - S[b].sc);
    const fastest = S.reduce((b, s, i) => (s.R.sec < S[b].R.sec ? i : b), 0);
    const best = order[0], second = order[1];
    const clear = best != null && (second == null || S[second].sc - S[best].sc >= Math.max(10, S[best].sc * 0.15));
    return { best: clear ? best : null, fastest, ok, tie: !clear && order.length > 1 };
  }
  function badges(s) {
    const P = prof(), b = [];
    if (s.R.obstructed) b.push(['ice', t('kv.b.closed')]);
    if (s.R.russia) b.push(['ice', t('kv.b.russia')]);
    const abroad = [...(s.R.countries || [])].filter((c) => c !== 'RU');
    if (abroad.length) b.push(['', t('kv.b.abroad', { c: abroad.map((c) => t('kv.cn.' + c)).join(', ') })]);
    if (s.x.length) { const p = s.pts[s.x[0].i]; b.push(['ice', t(s.x[0].dir === 'down' ? 'kv.b.minus' : 'kv.b.plus', { km: Math.round(p.km), h: hm(p.at) })]); }
    else if (s.slick.length) b.push(['ice', t('kv.b.slick', { h: hm(s.slick[0].at) })]);
    s.alerts.slice(0, 1).forEach((a) => b.push(['warn', '⚠ ' + a]));
    KV_CLASSES.filter((c) => c !== 'dry' && (s.mins[c] || 0) >= 5).sort((a, c) => P.w[c] - P.w[a]).forEach((c) => b.push([c === 'ice' ? 'ice' : '', t('kv.c.' + c) + ' ' + dur(s.mins[c])]));
    if (s.pts.some((p) => p.drift)) b.push(['warn', t('kv.b.drift')]);
    if (s.gmax >= P.gust) b.push(['warn', t('kv.b.gust', { g: Math.round(s.gmax) })]);
    if (Number.isFinite(s.tmin)) b.push(['', t('kv.b.tmin', { t: Math.round(s.tmin) })]);
    const darkMin = s.pts.reduce((m, p, i) => (i && s.pts[i - 1].dark ? m + (p.at - s.pts[i - 1].at) / 60e3 : m), 0);
    if (kv.opts.noDark && darkMin >= 5) b.push(['warn', t('kv.b.darkwarn', { d: dur(darkMin) })]);
    else if (darkMin >= 15) b.push(['', t('kv.b.dark', { d: dur(darkMin) })]);
    if ((kv.veh === 'mc' || curvyOn()) && s.R.bend) b.push(['bend', t('kv.bend.' + bendLevel(s.R.bend), { n: Math.round(s.R.bend) })]);
    if (s.R.narrow && s.R.narrow.km >= 0.5) b.push(['warn', t('kv.b.narrow', { km: fmt(s.R.narrow.km, s.R.narrow.km < 10 ? 1 : 0), w: fmt(s.R.narrow.min, 1) })]);
    if (s.R.gravelForced) b.push(['warn', t('kv.b.gravel')]);
    if (s.extraMin >= 5) b.push(['', t('kv.b.slow', { m: Math.round(s.extraMin) })]);
    if (!s.R.obstructed && !s.x.length && !s.slick.length && !s.alerts.length && KV_CLASSES.every((c) => c === 'dry' || (s.mins[c] || 0) < 5)) b.unshift(['', t('kv.b.dry')]);
    return b;
  }
  function why(s, S, v, i) {
    if (!s.valid) return t('kv.why.nodata');
    if (s.R.obstructed) return t('kv.why.closed');
    if (v.tie) return t('kv.why.tie');
    if (i === v.best) {
      const dt = Math.round((s.R.sec - S[v.fastest].R.sec) / 60);
      return dt > 2 ? t('kv.why.best_slower', { m: dt }) : t('kv.why.best');
    }
    const worst = KV_CLASSES.filter((c) => c !== 'dry' && s.mins[c] >= 5).sort((a, b) => prof().w[b] * s.mins[b] - prof().w[a] * s.mins[a])[0];
    return worst ? t('kv.why.worse', { c: t('kv.c.' + worst).toLowerCase(), d: dur(s.mins[worst]) }) + (s.x.length ? ' ' + t('kv.why.freeze') : '') : t('kv.why.other');
  }
  function routeTitle(R) { return (R.via ? t('kv.via', { r: R.via + (R.viaCountry ? ' (' + t('kv.cn.' + R.viaCountry) + ')' : '') }) : t('kv.route')) + (R.passName ? ' · ' + R.passName : ''); }
  function renderCards(S) {
    const v = verdicts(S), el = $('kvCards');
    el.innerHTML = S.map((s, i) => {
      const total = s.pts[s.pts.length - 1].km || 1;
      const mini = s.seg.map((g) => `<i class="kvc-${g.cls}" style="width:${((s.pts[Math.min(g.b + 1, s.pts.length - 1)].km - s.pts[g.a].km) / total * 100).toFixed(2)}%"></i>`).join('');
      const bendiest = curvyOn() && S.length > 1 && S.every((x, k) => k === i || x.R.bend <= s.R.bend);
      const tag = !v.ok[i] ? `<span class="kv-verdict bad">${t(s.R.obstructed ? 'kv.v.closed' : 'kv.v.nodata')}</span>` : i === v.best ? `<span class="kv-verdict best">${t('kv.v.best')}</span>` : i === v.fastest ? `<span class="kv-verdict ok">${t('kv.v.fastest')}</span>` : bendiest ? `<span class="kv-verdict ok">${t('kv.v.bendy')}</span>` : '';
      const zmax = Math.max(...s.R.dense.map((p) => p.z ?? 0));
      return `<button type="button" class="card kv-rc${i === kv.sel ? ' sel' : ''}" data-i="${i}" aria-pressed="${i === kv.sel}">
        <span class="kv-rc-top"><b>${esc(routeTitle(s.R))}</b>${tag}</span>
        <span class="kv-rc-meta">${dur(s.R.sec / 60)} · ${Math.round(s.R.km)} km · ${t('kv.highest', { z: Math.round(zmax) })} · ${t('kv.arrive', { h: hm(s.end) + (dayKey(s.end) !== dayKey(s.pts[0].at) ? ' ' + t('kv.nextday') : '') })}</span>
        <span class="kv-mini">${mini}</span>
        <span class="kv-badges">${badges(s).map((b) => `<span class="kv-badge ${b[0]}">${esc(b[1])}</span>`).join('')}</span>
        <span class="kv-why">${esc(why(s, S, v, i))}</span></button>`;
    }).join('');
  }
  function renderDeps() {
    const el = $('kvDep'), opts = depOptions(), P = prof();
    const sc = opts.map((d) => Math.min(...kv.routes.map((R) => { const s = summarise(R, +d, P); return s.valid ? s.sc : Infinity; })));
    const fin = sc.filter(Number.isFinite), mx = Math.max(1, ...fin), mn = Math.min(...fin);
    const cur = kv.dep ? +kv.dep : +opts[0];
    const bestK = Number.isFinite(mn) ? sc.indexOf(mn) : -1;
    let h = '', lastDay = null;
    opts.forEach((d, k) => {
      if (lastDay !== null && dayKey(d) !== lastDay) h += '<i class="kv-dsep"></i>';
      lastDay = dayKey(d);
      const v = Number.isFinite(sc[k]) ? (sc[k] - mn) / Math.max(1, mx - mn) : 1, lead = (d - Date.now()) / 3600e3;
      const col = !Number.isFinite(sc[k]) ? 'var(--line)' : v < 0.2 ? 'var(--good)' : v < 0.5 ? '#84cc16' : v < 0.75 ? 'var(--mid)' : 'var(--bad)';
      const sel = Math.abs(+d - cur) < 1800e3 || (k === 0 && !kv.dep);
      h += `<button type="button" data-k="${k}" class="${sel ? 'sel' : ''}${k === bestK ? ' best' : ''}" style="height:${(12 + 40 * (1 - v)).toFixed(0)}px;background:${col};opacity:${lead > 48 ? 0.55 : lead > 24 ? 0.75 : 0.95}" title="${esc(wday(d) + ' ' + hm(d))}" aria-label="${esc(wday(d) + ' ' + hm(d))}"></button>`;
    });
    el.innerHTML = h;
    const days = []; opts.forEach((d) => { const k = dayKey(d); if (!days.includes(k)) days.push(k); });
    $('kvDepAxis').innerHTML = days.map((k) => { const d = opts.find((x) => dayKey(x) === k); return `<span>${esc(wday(d) + ' ' + d.getDate() + '.')}</span>`; }).join('');
    // the suggestion: a clear box with the best departure and one button, unless the chosen one is about as good
    const bd = opts[bestK], curK = Math.max(0, opts.findIndex((d) => Math.abs(+d - cur) < 1800e3));
    const sayWx = (d) => {   // the weather of the best route at that departure, in a few words
      const all = kv.routes.map((R) => summarise(R, +d, P)).filter((x) => x.valid).sort((a, b) => a.sc - b.sc), x = all[0]; if (!x) return '';
      const c = KV_CLASSES.filter((k) => k !== 'dry' && (x.mins[k] || 0) >= 5).sort((a, b) => P.w[b] * x.mins[b] - P.w[a] * x.mins[a])[0];
      const dark = x.pts.reduce((m, p, i) => (i && x.pts[i - 1].dark ? m + (p.at - x.pts[i - 1].at) / 60e3 : m), 0);
      // what makes the difference: the weather, plus darkness when it counts (avoid the dark, or on a motorcycle) and strong gusts
      return [c ? `${t('kv.c.' + c)} ${dur(x.mins[c])}` : t('kv.dep.dry'), (kv.opts.noDark || kv.veh === 'mc') && dark >= 15 ? t('kv.dep.dark', { d: dur(dark) }) : '',
        x.gmax >= P.gust ? t('kv.gusts', { g: Math.round(x.gmax) }) : ''].filter(Boolean).join(' · ');
    };
    const better = bestK >= 0 && Number.isFinite(sc[curK]) ? sc[curK] - mn >= Math.max(10, mn * 0.1) : bestK >= 0;
    $('kvDepHint').innerHTML = bestK < 0 ? '' : better
      ? `<div class="kv-best"><div class="kv-best-txt"><b>${esc(t('kv.dep.best', { d: wday(bd) + ' ' + t('kv.dep.at') + ' ' + hm(bd) }))}</b><small>${esc(t('kv.dep.then'))}: ${esc(sayWx(bd))}</small><small>${esc(t('kv.dep.chosen'))}: ${esc(sayWx(opts[curK]))}</small></div>` +
        `<button type="button" class="btn primary kv-best-go" id="kvUseBest" data-k="${bestK}">${esc(t('kv.dep.use2', { d: wday(bd) + ' ' + hm(bd) }))}</button></div>`
      : `<div class="kv-best ok"><b>✓ ${esc(t('kv.dep.isbest'))}</b></div>`;
    $('kvDepHelp').textContent = t('kv.dep.help');
    kv.depOpts = opts;
  }
  function renderChart(s) {
    // a lower chart when the large map shares a short screen with it
    const H = $('kvMap').classList.contains('big') && innerHeight < 1000 ? 190 : 236;
    const svg = $('kvChart'), W = Math.max(300, svg.clientWidth || 700), pts = s.pts, D = s.R.dense, km = s.R.km || 1;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    const L = 64, X = (k) => L + (W - L - 10) * k / km;   // a label column wide enough for "Vindkast" at a readable size
    const zs = D.map((p) => p.z ?? 0), zmax = Math.max(1200, ...zs);
    const ts = pts.map((p) => p.t).filter(Number.isFinite), tmin = Math.min(-4, ...ts), tmax = Math.max(12, ...ts);
    const Ty = (v) => (H - 66) - (v - tmin) / (tmax - tmin) * (H - 144), Zy = (z) => (H - 14) - z / zmax * (H * 0.25);
    const C = (v) => cssv(v), line = C('--line'), muted = C('--muted');
    let h = '';
    for (let tt = Math.ceil(+pts[0].at / 3600e3) * 3600e3; tt <= +s.end; tt += 3600e3) {   // clock ticks where you are at each full hour
      let k = 0; for (let i = 1; i < pts.length; i++) if (+pts[i].at >= tt) { const f = (tt - pts[i - 1].at) / Math.max(1, pts[i].at - pts[i - 1].at); k = pts[i - 1].km + f * (pts[i].km - pts[i - 1].km); break; }
      h += `<line x1="${X(k)}" x2="${X(k)}" y1="14" y2="${H - 12}" stroke="${line}"/><text x="${X(k)}" y="10" font-size="11" text-anchor="middle" fill="${muted}">${pad2(new Date(tt).getHours())}</text>`;
    }
    s.seg.forEach((g) => {
      const a = X(pts[g.a].km), b = X(pts[Math.min(g.b + 1, pts.length - 1)].km);
      h += `<rect class="kvc-${g.cls}" x="${a}" y="16" width="${Math.max(1, b - a)}" height="24"/>` + (g.cls === 'snow' && b - a > 16 ? `<text x="${(a + b) / 2}" y="32" font-size="12" text-anchor="middle" class="kv-snowmark">❄</text>` : '');
    });
    // ferries: the stretch on board, hatched over the weather band
    s.R.features.ferries.forEach((f) => { if (f.km != null) { const a = X(f.km), b = X(f.km1 ?? f.km + 1); h += `<rect x="${a}" y="16" width="${Math.max(3, b - a)}" height="24" fill="url(#kvHatch)"/>`; } });
    // two thin rows under the band: strong gusts (the vehicle's threshold) and darkness, each sample colouring the road to the next
    const row = (y, test, cls) => pts.forEach((p, i) => { if (i < pts.length - 1 && test(p)) { const a = X(p.km), b = X(pts[i + 1].km); h += `<rect class="${cls}" x="${a}" y="${y}" width="${Math.max(2, b - a)}" height="8" rx="2"/>`; } });
    row(46, (p) => p.gust, 'kv-gustbar'); row(58, (p) => p.dark, 'kv-darkbar');
    pts.forEach((p) => { if (p.alert) h += `<path class="kv-alertmk" d="M${X(p.km)} 68l4.5 7.5h-9z"/>`; });
    h += `<defs><pattern id="kvHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" class="kv-hatch"/></pattern></defs>`;
    // row names: readable, right-aligned against the rows they name
    const lab = (y, txt, cls = 'kv-lab') => `<text x="${L - 6}" y="${y}" text-anchor="end" class="${cls}">${esc(txt)}</text>`;
    h += lab(32, t('kv.ch.wx')) + lab(54, t('kv.ch.wind')) + lab(66, t('kv.ch.dark'));
    h += `<path class="kv-elev" d="M${X(0)} ${H - 14} ${D.map((p) => `L${X(p.km).toFixed(1)} ${Zy(p.z ?? 0).toFixed(1)}`).join(' ')} L${X(km)} ${H - 14} Z"/>`;
    h += lab(H - 20, t('kv.ch.elev'));
    s.R.tops.forEach((i) => { const p = D[i]; h += `<text x="${X(p.km)}" y="${Zy(p.z) - 4}" font-size="10" text-anchor="middle" fill="${muted}">${Math.round(p.z)} m</text>`; });
    for (let k = 100; k < km && X(k) < W - 24; k += 100) h += `<text x="${X(k)}" y="${H - 2}" font-size="10" text-anchor="middle" fill="${muted}">${k} km</text>`;
    if (tmin < 0 && tmax > 0) h += `<line x1="${L}" x2="${W - 10}" y1="${Ty(0)}" y2="${Ty(0)}" class="kv-zero"/>${lab(Ty(0) + 4, '0°', 'kv-lab kv-zero-t')}`;
    s.slick.forEach((p) => { h += `<circle cx="${X(p.km)}" cy="${Ty(p.t)}" r="7" class="kv-halo"/>`; });
    const tp = pts.filter((p) => Number.isFinite(p.t));
    if (tp.length) h += `<path class="kv-temp" d="${tp.map((p, i) => `${i ? 'L' : 'M'}${X(p.km).toFixed(1)} ${Ty(p.t).toFixed(1)}`).join(' ')}"/>`;
    h += lab(Ty(tmax) + 8, Math.round(tmax) + '°', 'kv-lab kv-temp-t');
    s.x.forEach((c) => { const p = pts[c.i]; h += `<circle cx="${X(p.km)}" cy="${Ty(p.t)}" r="4.5" class="kv-xmk ${c.dir}"/><text x="${X(p.km)}" y="${Ty(p.t) - 9}" font-size="12" font-weight="700" text-anchor="middle" class="kv-xmk-t">${c.dir === 'down' ? '↘0°' : '↗0°'}</text>`; });
    h += `<line id="kvCur" x1="-10" x2="-10" y1="14" y2="${H - 12}" class="kv-cur"/>`;
    svg.innerHTML = h;
    $('kvTitle').textContent = `${routeTitle(s.R)} · ${wday(pts[0].at)} ${hm(pts[0].at)}–${hm(s.end)}`;
    const used = new Set(pts.map((p) => p.cls));
    $('kvLegend').innerHTML = `<div class="kv-lg-row">${KV_CLASSES.map((c) => `<span class="${used.has(c) ? '' : 'kv-lg-off'}"><i class="kvc-${c}"></i>${t('kv.c.' + c)}</span>`).join('')}</div>` +
      `<div class="kv-lg-row"><span><i class="kv-l-temp"></i>${t('kv.ch.temp')}</span><span><i class="kv-l-zero"></i>${t('kv.lg.zero')}</span><span><i class="kv-l-x"></i>${t('kv.lg.cross')}</span><span><i class="kv-l-halo"></i>${t('kv.slick')}</span>` +
      `<span><i class="kv-l-gust"></i>${t('kv.lg.gust', { g: prof().gust })}</span><span><i class="kv-l-dark"></i>${t('kv.lg.dark')}</span><span><i class="kv-l-ferry"></i>${t('kv.ferry')}</span><span><i class="kv-l-alert"></i>${t('kv.lg.alert')}</span><span><i class="kv-l-elev"></i>${t('kv.ch.elev')}</span><span><i class="kv-l-tick"></i>${t('kv.lg.tick')}</span></div>`;
    // The line follows the pointer exactly. Each sample colours the road up to the next one, so the readout shows the
    // block under the line (weather, gusts, dark, warning) with time, km, height and temperature interpolated at that point.
    const R = s.R;
    const posAt = (k) => {   // the point on the road at k km, for the map marker
      let lo = 0, hi = R.cumKm.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.cumKm[m] <= k) lo = m; else hi = m; }
      const a = R.cumKm[lo], b = R.cumKm[hi], f = b > a ? (k - a) / (b - a) : 0, p = R.coords[lo], q = R.coords[hi];
      return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
    };
    const seek = (k) => {   // put the time line at k km: chart line, readout and the map dot; returns what is there
      k = Math.max(0, Math.min(km, k)); const x = X(k);
      let i = 0; while (i < pts.length - 2 && pts[i + 1].km <= k) i++;
      const p = pts[i], q = pts[i + 1] || p, f = q.km > p.km ? Math.max(0, Math.min(1, (k - p.km) / (q.km - p.km))) : 0;
      const at = new Date(+p.at + f * (q.at - p.at));
      const tc = Number.isFinite(p.t) && Number.isFinite(q.t) ? p.t + f * (q.t - p.t) : p.t;
      const d = D.reduce((a, o) => (Math.abs(o.km - k) < Math.abs(a.km - k) ? o : a), D[0]);
      const c = svg.querySelector('#kvCur'); c.setAttribute('x1', x); c.setAttribute('x2', x);
      // always two lines, each cut rather than wrapped, so nothing under the chart moves while scrubbing
      $('kvRead').innerHTML = `<span class="kv-r1"><b>${hm(at)}</b> · km ${Math.round(k)} · ${Math.round(d.z ?? p.z ?? 0)} ${t('kv.masl')} · <b>${fmt(tc, 1)}°</b></span>` +
        `<span class="kv-r2">${t('kv.c.' + p.cls)}${p.mm >= 0.1 ? ' ' + fmt(p.mm, 1) + ' mm/t' : ''} · ${t('kv.gusts', { g: Math.round(p.g) })}${p.slick ? ` · <b class="kv-slick">${t('kv.slick')}</b>` : ''}${p.dark ? ' · ' + t('kv.dark') : ''}${p.alert ? ' · ⚠ ' + esc(p.alert) : ''}</span>`;
      const pos = posAt(k); MAP.cursor(pos);
      return { k, at, t: tc, cls: p.cls, pos };
    };
    kv.seek = seek;
    const pick = (ev) => { const r = svg.getBoundingClientRect(), x = Math.max(L, Math.min(W - 10, (ev.clientX - r.left) / r.width * W)); seek((x - L) / (W - L - 10) * km); };
    // a click (not a drag) also takes the map to that spot, at a regional zoom (closer zoom is kept)
    let down = null;
    svg.onpointermove = pick;
    svg.onpointerdown = (ev) => { pick(ev); down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; };
    svg.onpointerup = (ev) => {
      if (!down) return; const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), quick = performance.now() - down.t < 600; down = null;
      if (moved > 6 || !quick) return;
      const r = svg.getBoundingClientRect(), x = Math.max(L, Math.min(W - 10, (ev.clientX - r.left) / r.width * W)), info = seek((x - L) / (W - L - 10) * km);
      MAP.focus(info.pos);
    };
  }
  /* ---------------- the map: MapLibre with a 2D / 3D button (terrain at 1.5x, as the shadow map), Leaflet where WebGL is missing ----------------
     Both behind one small interface: init, base, fit, resize, draw, cursor, stale. Points are [lat, lon] everywhere here. */
  const BASE_TILES = {
    kartverket: { tiles: ['https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png'], maxzoom: 18, attribution: '© Kartverket' },
    osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap' },
  };
  const NORWAY = [[57.9, 4.6], [71.2, 31.1]];   // [[south, west], [north, east]]
  const boundsOf = (S) => { let s = 90, w = 180, n = -90, e = -180; S.forEach((x) => x.R.coords.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); })); return [[s, w], [n, e]]; };
  const hasGL = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } })();
  const isDark = () => (typeof effectiveTheme === 'function' ? effectiveTheme() === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  // route lines on the map: saturated weather colours in both themes; a light outline and light grey alternatives on the
  // dark map, a dark outline and grey alternatives on the light map
  const DARK_LINE = { dry: '#22c55e', fog: '#a3a3a3', wet: '#3b82f6', heavy: '#1e40af', sleet: '#8b5cf6', snow: '#38bdf8', ice: '#f43f5e', thunder: '#f59e0b' };
  const lineStyle = () => (isDark() ? { cls: (c) => DARK_LINE[c] || '#22c55e', casing: '#f8fafc', casingOp: 0.85, alt: '#cbd5e1', altOp: 0.75 }
    : { cls: (c) => DARK_LINE[c] || '#22c55e', casing: '#0f172a', casingOp: 0.55, alt: '#334155', altOp: 0.8 });   // saturated on the light map too (pale green vanished in green terrain)
  const MAPS = {
    gl: {
      m: null, ready: null, marks: [], cur: null, popup: null, tiles: 'kartverket',
      init() {
        if (this.ready) return this.ready;
        this.ready = smLoadLib().then(() => new Promise((res) => {   // MapLibre is loaded on first use, shared with the shadow map
          const m = this.m = new maplibregl.Map({ container: 'kvMap', bounds: [[NORWAY[0][1], NORWAY[0][0]], [NORWAY[1][1], NORWAY[1][0]]], pitch: 0, maxPitch: 60, attributionControl: { compact: true },
            // no paint transitions: with 3D terrain MapLibre draws layers onto the ground once per change (see the shadow map)
            style: { version: 8, transition: { duration: 0, delay: 0 }, sources: {
              osm: { type: 'raster', tileSize: 256, ...BASE_TILES.osm },   // under Kartverket: shows where Kartverket's map is empty (abroad)
              base: { type: 'raster', tileSize: 256, ...BASE_TILES.kartverket },
              dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 12, encoding: 'terrarium', attribution: 'Terreng: Mapzen/AWS' },
            }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }, { id: 'base', type: 'raster', source: 'base' }] } });
          m.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: !matchMedia('(pointer: coarse)').matches }), 'top-left');
          m.addControl(new SmTiltControl(), 'top-left');   // the same 2D / 3D button as the shadow map
          m.on('load', () => {
            m.setTerrain({ source: 'dem', exaggeration: 1.5 });
            const empty = { type: 'FeatureCollection', features: [] }, round = { 'line-join': 'round', 'line-cap': 'round' };
            ['kv-alt', 'kv-casing', 'kv-sel'].forEach((id) => m.addSource(id, { type: 'geojson', data: empty }));
            m.addLayer({ id: 'kv-alt', type: 'line', source: 'kv-alt', layout: round, paint: { 'line-color': '#64748b', 'line-width': 5, 'line-opacity': 0.6 } });
            m.addLayer({ id: 'kv-casing', type: 'line', source: 'kv-casing', layout: round, paint: { 'line-color': '#0f172a', 'line-width': 9, 'line-opacity': 0.5 } });
            m.addLayer({ id: 'kv-sel', type: 'line', source: 'kv-sel', layout: round, paint: { 'line-color': ['get', 'c'], 'line-width': 6 } });
            m.addSource('kv-stage', { type: 'geojson', data: empty });   // a stage picked in the itinerary: a pulsing glow over the route
            m.addLayer({ id: 'kv-stage-glow', type: 'line', source: 'kv-stage', layout: round, paint: { 'line-color': '#facc15', 'line-width': 16, 'line-opacity': 0, 'line-blur': 3 } });
            m.addLayer({ id: 'kv-stage-core', type: 'line', source: 'kv-stage', layout: round, paint: { 'line-color': '#fde047', 'line-width': 4, 'line-opacity': 0 } });
            m.addLayer({ id: 'kv-hit', type: 'line', source: 'kv-casing', layout: round, paint: { 'line-color': '#000', 'line-width': 28, 'line-opacity': 0 } });   // easy to hit, also with a finger
            m.on('click', 'kv-hit', (e) => routeClick(e.lngLat.lat, e.lngLat.lng));
            m.on('mouseenter', 'kv-hit', () => { m.getCanvas().style.cursor = 'pointer'; if (!this.sv) { if (!this.popup) this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }); } });
            m.on('mousemove', 'kv-hit', (e) => { if (this.sv && this.sv.isOpen()) return; if (!this.popup) this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }); this.popup.setLngLat(e.lngLat).setText(t('kv.sv.hover')).addTo(m); });
            m.on('mouseleave', 'kv-hit', () => { m.getCanvas().style.cursor = ''; if (this.popup) this.popup.remove(); });
            // the other routes: name on hover, tap to choose
            m.on('click', 'kv-alt', (e) => { if (m.queryRenderedFeatures(e.point, { layers: ['kv-hit'] }).length) return; kv.sel = +e.features[0].properties.i; render(); });   // a shared road belongs to the chosen route
            m.on('mouseenter', 'kv-alt', () => { m.getCanvas().style.cursor = 'pointer'; });
            m.on('mouseleave', 'kv-alt', () => { m.getCanvas().style.cursor = ''; if (this.popup) this.popup.remove(); });
            m.on('mousemove', 'kv-alt', (e) => { if (!this.popup) this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }); this.popup.setLngLat(e.lngLat).setText(e.features[0].properties.title).addTo(m); });
            this.theme();
            // the (i) attribution starts folded (MapLibre opens it on wide maps), as on the shadow map
            const at = m.getContainer().querySelector('.maplibregl-ctrl-attrib'); if (at) at.classList.remove('maplibregl-compact-show');
            const retheme = () => { this.theme(); if (kv.S) this.draw(kv.S); };   // the route colours follow the theme too
            new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
            matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
            res();
          });
        }));
        return this.ready;
      },
      theme() {   // dark theme: the map's lightness turned around, colours kept (as the Leaflet maps do with a CSS filter)
        if (!this.m || !this.m.getLayer('base')) return;
        const d = isDark();
        ['osm', 'base'].forEach((id) => { this.m.setPaintProperty(id, 'raster-brightness-min', d ? 0.92 : 0); this.m.setPaintProperty(id, 'raster-brightness-max', d ? 0.06 : 1); this.m.setPaintProperty(id, 'raster-saturation', d ? -0.25 : 0); });
      },
      base(id) { if (this.m && id !== this.tiles && BASE_TILES[id]) { this.m.getSource('base').setTiles(BASE_TILES[id].tiles); this.tiles = id; } },
      fit(b) { if (this.m) this.m.fitBounds([[b[0][1], b[0][0]], [b[1][1], b[1][0]]], { padding: 30, duration: 0, pitch: this.m.getPitch(), bearing: this.m.getBearing() }); },
      resize() { if (this.m) this.m.resize(); },
      mark(p, text, cls, title) {
        const el = document.createElement('div'); el.className = cls; el.textContent = text; if (title) el.title = title;
        const mk = new maplibregl.Marker({ element: el }).setLngLat([+p[1], +p[0]]).addTo(this.m); this.marks.push(mk); return mk;
      },
      async draw(S) {
        await this.init(); const m = this.m, s = S[kv.sel];
        this.base(kv.region && kv.region.tiles);
        const line = (coords, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[1], c[0]]) } });
        const ls = lineStyle();
        m.setPaintProperty('kv-alt', 'line-color', ls.alt); m.setPaintProperty('kv-alt', 'line-opacity', ls.altOp);
        m.setPaintProperty('kv-casing', 'line-color', ls.casing); m.setPaintProperty('kv-casing', 'line-opacity', ls.casingOp);
        this.ls = ls;
        m.getSource('kv-alt').setData({ type: 'FeatureCollection', features: S.map((x, i) => (i === kv.sel ? null : line(x.R.coords, { i, title: routeTitle(x.R) }))).filter(Boolean) });
        m.getSource('kv-casing').setData({ type: 'FeatureCollection', features: [line(s.R.coords, {})] });
        const segs = [];   // the chosen route coloured by weather class: each sample colours the road up to the next one
        for (let i = 0; i < s.pts.length - 1; i++) {
          const a = s.pts[i], b = s.pts[i + 1], seg = [[a.lat, a.lon]];
          for (let j = 0; j < s.R.coords.length; j++) if (s.R.cumKm[j] > a.km && s.R.cumKm[j] < b.km) seg.push(s.R.coords[j]);
          seg.push([b.lat, b.lon]); segs.push(line(seg, { c: ls.cls(a.cls) }));
        }
        m.getSource('kv-sel').setData({ type: 'FeatureCollection', features: segs });
        this.marks.forEach((mk) => mk.remove()); this.marks = [];
        // the street view popup closes only when what it describes changes (route, departure, vehicle), not on a redraw
        const pk = [kv.sel, kv.routes.indexOf(s.R), +(kv.dep || 0), kv.veh, kv.token].join('|'); if (pk !== this.popKey) { this.closePopup(); this.popKey = pk; }
        s.x.forEach((c) => { const p = s.pts[c.i]; this.mark([p.lat, p.lon], c.dir === 'down' ? '❄' : '↗', 'kv-mk', t(c.dir === 'down' ? 'kv.b.minus' : 'kv.b.plus', { km: Math.round(p.km), h: hm(p.at) })); });
        s.R.tops.forEach((i) => { const p = s.R.dense[i]; this.mark([p.lat, p.lon], '', 'kv-topmk', `${Math.round(p.z)} ${t('kv.masl')}`); });
        this.mark([kv.from.lat, kv.from.lon], 'A', 'kv-abm'); this.mark([kv.to.lat, kv.to.lon], 'B', 'kv-abm');
        this.labels = altLabels(S).map((lb) => {
          const el = document.createElement('button'); el.type = 'button'; el.className = 'kv-altlabel' + (lb.sel ? ' sel' : ''); el.textContent = lb.text; el.title = lb.title;
          el.addEventListener('click', (e) => { e.stopPropagation(); if (!lb.sel) { kv.sel = lb.i; render(); } });
          const mk = new maplibregl.Marker({ element: el }).setLngLat([lb.at[1], lb.at[0]]).addTo(m); this.marks.push(mk);
          return { ...lb, mk, el };
        });
        if (!this.placeWired) { this.placeWired = true; m.on('moveend', () => this.placeLabels()); m.on('resize', () => this.placeLabels()); }
        requestAnimationFrame(() => this.placeLabels());
        this.cur = this.mark([s.pts[0].lat, s.pts[0].lon], '', 'kv-curmk'); this.cur.getElement().hidden = true;   // shown once the chart is scrubbed (it would cover A)
        this.stale(false);
        if (!kv.fitted) { this.resize(); this.fit(boundsOf(S)); kv.fitted = true; }
      },
      cursor(p) { if (this.cur) { this.cur.setLngLat([p[1], p[0]]); this.cur.getElement().hidden = false; } },
      focus(p) { if (this.m) this.m.flyTo({ center: [p[1], p[0]], zoom: Math.max(this.m.getZoom(), 9), duration: 1200, essential: true }); },   // about 40 km across
      placeLabels() {   // each label beside its route on a free spot: no route line under it, no other label, away from the chosen route first
        const m = this.m; if (!m || !this.labels || !kv.S) return;
        const box = m.getContainer().getBoundingClientRect(), pts = [];
        kv.S.forEach((x) => { const c = x.R.coords, st = Math.max(1, Math.floor(c.length / 1500)); for (let i = 0; i < c.length; i += st) { const q = m.project([c[i][1], c[i][0]]); if (q.x > -50 && q.y > -50 && q.x < box.width + 50 && q.y < box.height + 50) pts.push(q); } });
        const hitsRoute = (r) => pts.some((q) => q.x > r.l - 3 && q.x < r.r + 3 && q.y > r.t - 3 && q.y < r.b + 3);
        const shown = [], pad = 4;
        this.labels.forEach((lb) => {
          lb.el.hidden = false;
          const a = m.project([lb.at[1], lb.at[0]]), q = lb.away ? m.project([lb.away[1], lb.away[0]]) : null, w = lb.el.offsetWidth, h = lb.el.offsetHeight;
          let ux = 0, uy = -1; if (q) { const len = Math.hypot(a.x - q.x, a.y - q.y); if (len > 1) { ux = (a.x - q.x) / len; uy = (a.y - q.y) / len; } }
          // candidate directions: away from the chosen route first, then turning round in 45° steps; two distances
          const dirs = [0, 45, -45, 90, -90, 135, -135, 180].map((d) => { const r = d * Math.PI / 180; return [ux * Math.cos(r) - uy * Math.sin(r), ux * Math.sin(r) + uy * Math.cos(r)]; });
          let pick = null;
          // first a spot clear of every route line; on a small map (phones) as a last resort over a line, never over a label
          for (const avoidLines of [true, false]) { for (const dist of [8, 22, 40]) { for (const [dx, dy] of dirs) {
            const cx = a.x + dx * (w / 2 + dist), cy = a.y + dy * (h / 2 + dist), r = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
            if (r.l < 4 || r.t < 4 || r.r > box.width - 4 || r.b > box.height - 4) continue;
            if ((avoidLines && hitsRoute(r)) || shown.some((o) => r.l < o.r + pad && r.r > o.l - pad && r.t < o.b + pad && r.b > o.t - pad)) continue;
            pick = { off: [cx - a.x, cy - a.y], r }; break; } if (pick) break; } if (pick) break; }
          if (!pick) { lb.el.hidden = true; return; }   // nowhere free at this zoom: hidden until there is room
          lb.mk.setOffset(pick.off); shown.push(pick.r);
        });
      },
      // a stage of the itinerary: fly there when it is not fully in view, then let it pulse slowly for 20 s
      async highlight(coords) {
        await this.init(); const m = this.m; clearInterval(this.pulse);
        m.getSource('kv-stage').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[1], c[0]]) } });
        // always fly to the stage, framed with a margin (also when it was already somewhere in view)
        let s = 90, w = 180, n = -90, e = -180; coords.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); });
        m.fitBounds([[w, s], [e, n]], { padding: 50, duration: 1400, maxZoom: 13, pitch: m.getPitch(), bearing: m.getBearing() });
        const t0 = performance.now();
        this.pulse = setInterval(() => {
          const el = performance.now() - t0, done = el > 20000, a = done ? 0 : matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.8 : 0.55 + 0.4 * Math.sin(el / 1000 * Math.PI * 0.9);   // about one breath every 2.2 s
          m.setPaintProperty('kv-stage-glow', 'line-opacity', done ? 0 : a); m.setPaintProperty('kv-stage-core', 'line-opacity', done ? 0 : 0.95);
          if (done) { clearInterval(this.pulse); m.getSource('kv-stage').setData({ type: 'FeatureCollection', features: [] }); }
        }, 80);
      },
      openPopup(p, el) {
        this.closePopup(); if (this.popup) this.popup.remove();
        const box = this.m.getContainer().getBoundingClientRect();
        if (box.height < 380 || box.width < 560) { this.sv = svSheet(el); return; }   // a small map (phones): a panel at the bottom instead
        this.sv = new maplibregl.Popup({ maxWidth: 'none', className: 'kv-svpop', anchor: 'bottom', offset: 12, focusAfterOpen: false }).setLngLat([p[1], p[0]]).setDOMContent(el).addTo(this.m);
        requestAnimationFrame(() => this.fitPopup());
      },
      fitPopup() {   // the map slides so the whole popup is inside it (MapLibre does not pan for popups); again when its content grows
        if (!this.sv || this.sv.isSheet || !this.sv.isOpen()) return;
        const box = this.m.getContainer().getBoundingClientRect(), r = this.sv.getElement().getBoundingClientRect();
        const up = r.top - box.top - 8, l = r.left - box.left - 8, rt = box.right - r.right - 8;
        const dx = l < 0 ? l : rt < 0 ? -rt : 0, dy = up < 0 ? up : 0;
        if (dx || dy) this.m.panBy([dx, dy], { duration: 300 });
      },
      closePopup() { if (this.sv) { this.sv.remove(); this.sv = null; } },
      stale(on) {
        if (!this.m || !this.m.getLayer('kv-sel')) return;
        const ls = this.ls || lineStyle();
        this.m.setPaintProperty('kv-sel', 'line-opacity', on ? 0.35 : 1); this.m.setPaintProperty('kv-casing', 'line-opacity', on ? 0.2 : ls.casingOp); this.m.setPaintProperty('kv-alt', 'line-opacity', on ? 0.25 : ls.altOp);
      },
    },
    leaflet: {
      m: null, layers: [], cur: null,
      init() {
        if (this.m) return Promise.resolve();
        const m = this.m = L.map('kvMap', { zoomControl: true, attributionControl: true });
        m._kvBase = { kartverket: L.tileLayer(BASE_TILES.kartverket.tiles[0], { maxZoom: 18, attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>' }),
          osm: L.tileLayer(BASE_TILES.osm.tiles[0], { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }) };
        m._kvBase.osm.addTo(m); m._kvBase.kartverket.addTo(m); m.fitBounds(NORWAY);   // OpenStreetMap under Kartverket, for abroad
        return Promise.resolve();
      },
      base(id) { const m = this.m; if (!m.hasLayer(m._kvBase.osm)) m._kvBase.osm.addTo(m); const b = m._kvBase[id]; if (b && !m.hasLayer(b)) b.addTo(m); },
      fit(b) { if (this.m) this.m.fitBounds(b, { padding: [16, 16] }); },
      resize() { if (this.m) this.m.invalidateSize(); },
      async draw(S) {
        await this.init(); const m = this.m, s = S[kv.sel];
        this.base(kv.region && kv.region.tiles);
        const pk = [kv.sel, +(kv.dep || 0), kv.veh, kv.token].join('|'); if (pk !== this.popKey) { this.closePopup(); this.popKey = pk; }
        this.layers.forEach((l) => m.removeLayer(l)); this.layers = [];
        const add = (l) => { this.layers.push(l.addTo(m)); return l; };
        S.forEach((x, i) => { if (i === kv.sel) return;
          add(L.polyline(x.R.coords, { color: lineStyle().alt, weight: 5, opacity: lineStyle().altOp })).bindTooltip(esc(routeTitle(x.R)), { sticky: true }).on('click', () => { kv.sel = i; render(); }); });
        add(L.polyline(s.R.coords, { color: lineStyle().casing, weight: 9, opacity: lineStyle().casingOp, interactive: false }));
        add(L.polyline(s.R.coords, { color: '#000', weight: 26, opacity: 0.001 })).on('click', (e) => routeClick(e.latlng.lat, e.latlng.lng)).bindTooltip(esc(t('kv.sv.hover')), { sticky: true });
        for (let i = 0; i < s.pts.length - 1; i++) {
          const a = s.pts[i], b = s.pts[i + 1], seg = [[a.lat, a.lon]];
          for (let j = 0; j < s.R.coords.length; j++) if (s.R.cumKm[j] > a.km && s.R.cumKm[j] < b.km) seg.push(s.R.coords[j]);
          seg.push([b.lat, b.lon]); add(L.polyline(seg, { color: lineStyle().cls(a.cls), weight: 6, opacity: 1, interactive: false }));
        }
        s.x.forEach((c) => { const p = s.pts[c.i]; add(L.marker([p.lat, p.lon], { icon: L.divIcon({ html: c.dir === 'down' ? '❄' : '↗', className: 'kv-mk', iconSize: [22, 22] }) })).bindTooltip(esc(t(c.dir === 'down' ? 'kv.b.minus' : 'kv.b.plus', { km: Math.round(p.km), h: hm(p.at) }))); });
        s.R.tops.forEach((i) => { const p = s.R.dense[i]; add(L.circleMarker([p.lat, p.lon], { radius: 5, color: '#111', fillColor: '#fff', fillOpacity: 1, weight: 2 })).bindTooltip(`${Math.round(p.z)} ${esc(t('kv.masl'))}`); });
        [kv.from, kv.to].forEach((p, k) => add(L.marker([+p.lat, +p.lon], { icon: L.divIcon({ html: k ? 'B' : 'A', className: 'kv-abm', iconSize: [22, 22] }) })));
        altLabels(S).forEach((lb) => add(L.marker(lb.at, { opacity: 0, interactive: false })).bindTooltip(esc(lb.text), { permanent: true, direction: 'auto', className: 'kv-altlabel-lf' }));
        this.cur = add(L.circleMarker([s.pts[0].lat, s.pts[0].lon], { radius: 7, color: '#fff', fillColor: '#2563eb', fillOpacity: 0, opacity: 0, weight: 3, interactive: false }));   // shown once the chart is scrubbed
        setTimeout(() => { m.invalidateSize(); if (!kv.fitted) { this.fit(boundsOf(S)); kv.fitted = true; } }, 30);
      },
      cursor(p) { if (this.cur) this.cur.setLatLng(p).setStyle({ opacity: 1, fillOpacity: 1 }); },
      focus(p) { if (this.m) this.m.flyTo(p, Math.max(this.m.getZoom(), 9), { duration: 1.2 }); },
      async highlight(coords) {
        await this.init(); const m = this.m; if (this.hl) m.removeLayer(this.hl); clearTimeout(this.hlT);
        this.hl = L.polyline(coords, { color: '#facc15', weight: 14, opacity: 0.85, className: 'kv-stage-pulse', interactive: false }).addTo(m);
        m.flyToBounds(L.latLngBounds(coords), { padding: [50, 50], maxZoom: 13, duration: 1.4 });
        this.hlT = setTimeout(() => { if (this.hl) { m.removeLayer(this.hl); this.hl = null; } }, 20000);
      },
      openPopup(p, el) {
        this.closePopup(); const box = this.m.getContainer().getBoundingClientRect();
        this.sv = box.height < 380 || box.width < 560 ? svSheet(el) : L.popup({ maxWidth: 420, className: 'kv-svpop', autoPanPadding: [20, 20] }).setLatLng(p).setContent(el).openOn(this.m);
      },
      closePopup() { if (this.sv) { if (this.sv.isSheet) this.sv.remove(); else this.m.closePopup(this.sv); this.sv = null; } },
      fitPopup() { if (this.sv && !this.sv.isSheet) this.sv.update(); },   // Leaflet pans an open popup into view on update
      stale() { /* CSS fades the overlay and marker panes */ },
    },
  };
  const MAP = hasGL ? MAPS.gl : MAPS.leaflet;
  /* A small label on each alternative route with its time against the chosen one ("+1 t 20 min"). It sits where the
     alternative is farthest from the chosen route and the other alternatives, and knows the chosen route's nearest point
     there, so it can be pushed off to the side away from it. */
  function altLabels(S) {
    const sel = S[kv.sel], step = (a, n) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0);
    const selPts = step(sel.R.coords, 400), d2 = (a, b) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180)) ** 2;
    const near = (p, pts) => pts.reduce((m, q) => { const d = d2(p, q); return d < m.d ? { d, q } : m; }, { d: Infinity, q: null });
    const out = [];
    S.forEach((x, i) => {
      if (i === kv.sel) return;
      const others = S.filter((_, k) => k !== i && k !== kv.sel).map((y) => step(y.R.coords, 300));
      let best = null;
      step(x.R.coords, 200).forEach((p, j, arr) => {
        if (j < arr.length * 0.1 || j > arr.length * 0.9) return;   // not where the routes start and end together
        const ns = near(p, selPts), score = Math.min(ns.d, ...others.map((o) => near(p, o).d));
        if (!best || score > best.score) best = { p, q: ns.q, score };
      });
      if (!best) return;
      const dm = Math.round((x.R.sec - sel.R.sec) / 60);
      out.push({ i, at: best.p, away: best.q, text: Math.abs(dm) < 1 ? t('kv.alt.same') : (dm > 0 ? '+' : '−') + dur(Math.abs(dm)), title: routeTitle(x.R), rank: Math.abs(dm) });
    });
    // the chosen route: its total time, where it is farthest from the alternatives
    const altPts = S.filter((_, k) => k !== kv.sel).map((y) => step(y.R.coords, 300)).flat();
    let bs = null;
    step(sel.R.coords, 200).forEach((p, j, arr) => { if (j < arr.length * 0.1 || j > arr.length * 0.9) return; const nn = altPts.length ? near(p, altPts) : { d: 1, q: null }; if (!bs || nn.d > bs.score) bs = { p, q: nn.q, score: nn.d }; });
    if (bs) out.push({ i: kv.sel, at: bs.p, away: bs.q, text: dur(sel.R.sec / 60), title: routeTitle(sel.R), rank: -1, sel: true });
    return out.sort((a, b) => a.rank - b.rank);   // the chosen route first, then the closest alternative, when labels would collide
  }
  function bigLabel() {
    const b = $('kvBig'), on = $('kvMap').classList.contains('big');
    b.innerHTML = `${BIG_ICON[on ? 'shrink' : 'grow']}<span>${t(on ? 'kv.map.small' : 'kv.map.big')}</span>`; b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  /* Larger map: the map and the chart move together to the top of the page, the chart under the map, and the map takes
     the screen height that is left, so the whole time line and the whole map are visible at once. Smaller: both go back
     to the right column (chart, then the map). */
  function fitBig() {
    const m = $('kvMap'), card = $('kvChartCard'), head = document.querySelector('.topbar');
    const free = innerHeight - (head ? head.offsetHeight : 60) - card.offsetHeight - 24;
    m.style.height = Math.max(240, Math.min(900, free)) + 'px';
    MAP.resize();
  }
  function setBig(on) {
    const m = $('kvMap'), wrap = $('kvMapWrap'), card = $('kvChartCard'), top = $('kvMapTop');
    if (on === m.classList.contains('big')) return;
    const lg = $('kvLgDet');
    if (on) { card._home = { parent: card.parentElement, next: card.nextSibling }; top.appendChild(wrap); top.appendChild(card); lg._was = lg.open; lg.open = false; }
    else { card._home.parent.insertBefore(card, card._home.next); card.parentElement.insertBefore(wrap, card.nextSibling); m.style.height = ''; if (lg._was != null) lg.open = lg._was; }
    m.classList.toggle('big', on); bigLabel();
    if (on) { if (kv.S) renderChart(kv.S[kv.sel]); fitBig(); }
    setTimeout(() => { MAP.resize(); if (kv.S) { MAP.fit(boundsOf(kv.S)); renderChart(kv.S[kv.sel]); } }, 60);
    const head = document.querySelector('.topbar');
    setTimeout(() => window.scrollTo({ top: (on ? top : card).getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 60) - 8, behavior: 'smooth' }), 90);
  }
  function showMap() {
    MAP.init().then(() => { if (!kv.routes.length && !kv.fitted) MAP.fit(NORWAY); setTimeout(() => MAP.resize(), 50); }).catch((e) => console.warn('Kjørevær map', e));
  }
  function renderMap(S) { MAP.draw(S).catch((e) => console.warn('Kjørevær map', e)); }
  function legsOf(R) {   // the router's steps collapsed to road-number stages; short connectors join their neighbours
    const legs = [];
    R.steps.forEach((s) => {
      const last = legs[legs.length - 1];
      if (s.ferry) { legs.push({ ferry: true, km0: s.km0, km1: s.km1, name: s.name || '' }); return; }
      if (last && !last.ferry && (last.country || '') === (s.country || '') && (s.ref === last.ref || (!s.ref && s.km < 3))) { last.km1 = s.km1; if (!last.toward && s.toward) last.toward = s.toward; return; }
      legs.push({ ref: s.ref, km0: s.km0, km1: s.km1, name: s.ref ? '' : s.name, toward: s.toward, country: s.country || '' });
    });
    const out = [];
    legs.forEach((g) => { const p = out[out.length - 1]; const same = p && (p.country || '') === (g.country || '');
      if (same && !g.ferry && !p.ferry && g.km1 - g.km0 < 5) { p.km1 = g.km1; return; } if (same && !p.ferry && !g.ferry && p.ref && p.ref === g.ref) { p.km1 = g.km1; return; } out.push(g); });
    return out;
  }
  function renderIt(s) {
    const pts = s.pts, R = s.R, P = prof();
    const at = (km) => { const p = pts.find((q) => q.km >= km) || pts[pts.length - 1]; return p.at; };
    const rows = legsOf(R).map((g) => {
      const sub = pts.filter((p) => p.km >= g.km0 - 0.1 && p.km <= g.km1 + 0.1);
      const cls = sub.reduce((m, p) => (P.w[p.cls] > P.w[m] ? p.cls : m), 'dry');
      const tt = sub.map((p) => p.t).filter(Number.isFinite);
      const tops = R.tops.map((i) => R.dense[i]).filter((p) => p.km >= g.km0 && p.km <= g.km1);
      const rdc = g.country ? (g.ref && g.ref.startsWith('E') ? 'e' : 'ab') : g.ref && g.ref.startsWith('E') ? 'e' : g.ref && g.ref.startsWith('Rv') ? 'rv' : 'fv';
      const cc = g.country ? `<span class="kv-cc" title="${esc(t('kv.cn.' + g.country))}">${esc(t('kv.cn.' + g.country))}</span>` : '';
      const label = g.ferry ? `⛴ ${esc(g.name || t('kv.ferry'))}` : `${g.ref ? `<span class="kv-rd ${rdc}">${esc(g.ref)}</span>` : ''}${esc(g.name || '')}${g.toward ? ' ' + esc(t('kv.toward', { p: g.toward })) : ''}${cc}`;
      const nar = (R.narrow ? R.narrow.spans : []).filter((x) => x.b > g.km0 && x.a < g.km1);
      const narKm = nar.reduce((q, x) => q + Math.min(x.b, g.km1) - Math.max(x.a, g.km0), 0);
      const narrow = narKm >= 0.3 ? `<span class="kv-narrow">${esc(t('kv.it.narrow', { km: fmt(narKm, 1), w: fmt(Math.min(...nar.map((x) => x.w)), 1) }))}</span>` : '';   // short bits are noise
      const pass = tops.length && !g.country && kv.region && kv.region.status ? `<a class="kv-pass" href="${kv.region.status.url}" target="_blank" rel="noopener">${t('kv.pass', { z: Math.round(Math.max(...tops.map((p) => p.z))) })} ↗</a>` : '';
      const lo = Math.round(Math.min(...tt)), hi = Math.round(Math.max(...tt));
      const temp = tt.length ? t('kv.it.temp', { t: lo === hi ? `${lo}°` : `${lo}–${hi}°` }) : '';
      return `<li class="kv-stage" data-k0="${g.km0.toFixed(2)}" data-k1="${g.km1.toFixed(2)}" tabindex="0" role="button" aria-label="${esc(t('kv.it.show'))}"><span class="kv-clk">${hm(at(g.km0))}</span><span>${label || esc(t('kv.road'))}<small>${Math.max(1, Math.round(g.km1 - g.km0))} km</small>${pass}${narrow}</span><span class="kv-wx">${t('kv.c.' + cls)}<small>${esc(temp)}</small></span></li>`;
    });
    rows.push(`<li><span class="kv-clk">${hm(s.end)}</span><span><b>${esc(t('kv.arrived', { p: kv.to.name || 'B' }))}</b></span><span></span></li>`);
    $('kvIt').innerHTML = rows.join('');
    renderOpen(s);
  }

  /* ---------------- Street View at a spot on the route ----------------
     Click the chosen route: the time line jumps there and a popup shows the time, km and weather with Google Street View
     (the free Maps Embed API in an iframe, looking along the road; drag inside to look around, the arrows turn it 45°,
     full screen, and a link to Google Maps). Nothing is loaded from Google before the visitor asks for it once (the iframe
     sets cookies); "Husk valget" remembers that in this browser. The key never reaches the page source: api/streetview.php
     answers a free metadata check (is there a panorama within 50 m, where, from when) and redirects the iframe to Google. */
  let svReady = null;
  const svAvailable = () => (svReady ||= fetchT('api/streetview.php?status=1').then((r) => r.json()).then((j) => !!j.ok).catch(() => false));
  const svRemember = () => lsGet('glett.sv.ok') === '1';
  function nearestOnRoute(R, lat, lon) {   // km along the route of the point nearest to lat/lon, and the road's bearing there
    const k = Math.cos(lat * Math.PI / 180); let best = { d: Infinity, km: 0, j: 0 };
    for (let j = 0; j < R.coords.length - 1; j++) {
      const [a, b] = [R.coords[j], R.coords[j + 1]], ax = (a[1] - lon) * k, ay = a[0] - lat, bx = (b[1] - lon) * k, by = b[0] - lat;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, f = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = (ax + f * dx) ** 2 + (ay + f * dy) ** 2;
      if (d < best.d) best = { d, km: R.cumKm[j] + f * (R.cumKm[j + 1] - R.cumKm[j]), j };
    }
    const a = R.coords[best.j], b = R.coords[Math.min(best.j + 1, R.coords.length - 1)];
    const brg = (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 360;
    return { km: best.km, heading: Math.round(brg) };
  }
  const svUrl = (v) => `api/streetview.php?embed=1${v.pano ? '&pano=' + encodeURIComponent(v.pano) : ''}&lat=${v.lat.toFixed(6)}&lon=${v.lon.toFixed(6)}&heading=${v.heading}&pitch=0&fov=80`;
  const svGmaps = (v) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${v.lat.toFixed(6)},${v.lon.toFixed(6)}&heading=${v.heading}${v.pano ? '&pano=' + encodeURIComponent(v.pano) : ''}`;
  function svFrame(v) {
    const f = document.createElement('iframe');
    f.src = svUrl(v); f.title = t('kv.sv.title'); f.loading = 'lazy'; f.referrerPolicy = 'strict-origin-when-cross-origin'; f.allowFullscreen = true;
    return f;
  }
  function svSheet(el) {   // the street view panel at the bottom of the screen on phones (same content as the popup)
    const o = document.createElement('div'); o.className = 'kv-svsheet'; o.setAttribute('role', 'dialog');
    const x = document.createElement('button'); x.type = 'button'; x.className = 'kv-svsheet-x'; x.textContent = '✕'; x.title = t('kv.sv.close'); x.setAttribute('aria-label', t('kv.sv.close'));
    let open = true; const remove = () => { if (!open) return; open = false; o.remove(); document.removeEventListener('keydown', key); };
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.kv-svfull')) remove(); };
    x.onclick = remove; document.addEventListener('keydown', key);
    o.append(x, el); document.body.appendChild(o);
    return { isSheet: true, isOpen: () => open, remove };
  }
  function svConsent(onYes) {   // the one-time question before Google's own frame is loaded (it sets cookies)
    const box = document.createElement('div'); box.className = 'kv-sv-consent';
    const p = document.createElement('p'); p.textContent = t('kv.sv.consent');
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary'; go.textContent = t('kv.sv.load');
    const lab = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; lab.append(cb, ' ' + t('kv.sv.remember'));
    go.onclick = () => { if (cb.checked) lsSet('glett.sv.ok', '1'); onYes(); };
    box.append(p, go, lab); return box;
  }
  function svFull(v) {   // full screen: Google's interactive Street View (free Embed API), drag to look all around
    const o = document.createElement('div'); o.className = 'kv-svfull'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', t('kv.sv.title'));
    const stage = document.createElement('div'); stage.className = 'kv-svfull-stage';
    const bar = document.createElement('div'); bar.className = 'kv-sv-ctl';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'kv-svfull-x'; x.textContent = '✕ ' + t('kv.sv.close');   // in our bar, never over Google's own controls
    const a = document.createElement('a'); a.href = svGmaps(v); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Google Maps ↗';
    const hint = document.createElement('span'); hint.className = 'kv-svfull-hint'; hint.textContent = t('kv.sv.drag');
    bar.append(x, hint, a);
    // Escape closes. A click or drag in Google's frame moves the keyboard focus into it, and a page never sees key presses
    // inside another site's frame, so the focus is taken back to the page each time (dragging needs no focus).
    const refocus = () => setTimeout(() => { if (document.activeElement && document.activeElement.tagName === 'IFRAME' && o.contains(document.activeElement)) x.focus({ preventScroll: true }); }, 0);
    const close = () => { o.remove(); document.removeEventListener('keydown', key); window.removeEventListener('blur', refocus); document.body.classList.remove('kv-noscroll'); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    x.onclick = close; document.addEventListener('keydown', key); window.addEventListener('blur', refocus);
    const show = () => stage.replaceChildren(svFrame(v));
    if (svRemember()) show(); else stage.replaceChildren(svConsent(show));
    o.append(stage, bar); document.body.appendChild(o); document.body.classList.add('kv-noscroll'); x.focus();
  }
  async function routeClick(lat, lon) {
    if (!kv.S || $('view-route').classList.contains('kv-isstale')) return;
    const s = kv.S[kv.sel], near = nearestOnRoute(s.R, lat, lon), info = kv.seek ? kv.seek(near.km) : null;
    if (!info) return;
    const v = { lat: info.pos[0], lon: info.pos[1], heading: near.heading, pano: '' };
    const el = document.createElement('div'); el.className = 'kv-sv';
    const head = document.createElement('div'); head.className = 'kv-sv-head';
    head.innerHTML = `<b>${esc(hm(info.at))}</b> · km ${Math.round(info.k)} · ${esc(t('kv.c.' + info.cls))} · ${fmt(info.t, 0)}°`;
    const body = document.createElement('div'); body.className = 'kv-sv-body';
    const meta = document.createElement('div'); meta.className = 'kv-sv-meta';
    el.append(head, body, meta);
    const msg = (k) => body.replaceChildren(Object.assign(document.createElement('div'), { className: 'kv-sv-msg', textContent: t(k) }));
    const link = () => { const a = document.createElement('a'); a.className = 'kv-sv-link'; a.href = svGmaps(v); a.target = '_blank'; a.rel = 'noopener'; a.textContent = t('kv.sv.open'); return a; };
    MAP.openPopup(info.pos, el);
    if (!(await svAvailable())) { body.remove(); meta.replaceChildren(link()); return; }
    msg('kv.sv.loading'); MAP.fitPopup();
    let j = null;   // is there a panorama within 50 m (our server asks Google; free)
    try { const r = await fetchT(`api/streetview.php?meta=1&lat=${v.lat.toFixed(5)}&lon=${v.lon.toFixed(5)}`); j = await r.json(); } catch (e) { j = null; }
    if (j && j.ok === false) { msg('kv.sv.none'); meta.replaceChildren(link()); MAP.fitPopup(); return; }
    // the interactive frame in the popup: when the check or the still image is not available
    const interactive = () => {
      const show = () => { body.replaceChildren(svFrame(v)); meta.replaceChildren(t('kv.sv.unchecked')); MAP.fitPopup(); };
      if (svRemember()) show(); else { body.replaceChildren(svConsent(show)); MAP.fitPopup(); }
    };
    if (!j || j.error || !j.pano) { interactive(); return; }
    Object.assign(v, { pano: j.pano, lat: j.lat, lon: j.lon });
    // as intelmap: a clean still image with ⟲ ⟳ on its sides; a click on it opens the interactive view in full screen
    const shot = document.createElement('div'); shot.className = 'kv-sv-shot';
    const img = document.createElement('img'); img.alt = t('kv.sv.title'); img.draggable = false; img.decoding = 'async';
    // which way the picture looks, in eight directions ("Viser nordvestover")
    const facing = document.createElement('span'); facing.className = 'kv-sv-dir';
    const setImg = () => { shot.classList.add('loading'); img.src = `api/streetview.php?img=1&pano=${encodeURIComponent(v.pano)}&heading=${v.heading}`;
      facing.textContent = t('kv.sv.facing', { d: t('kv.dir.' + ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(((v.heading % 360) + 360) % 360 / 45) % 8]) }); };
    img.onload = () => shot.classList.remove('loading');
    img.onerror = () => interactive();   // monthly image budget used, or Google said no: the free frame instead
    const arrow = (cls, d, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'kv-sv-arrow ' + cls; b.textContent = cls === 'l' ? '‹' : '›'; b.title = label; b.setAttribute('aria-label', label);
      b.onclick = (e) => { e.stopPropagation(); v.heading = (v.heading + d + 360) % 360; setImg(); }; return b; };
    const zoom = document.createElement('span'); zoom.className = 'kv-sv-zoom'; zoom.textContent = '⛶'; zoom.setAttribute('aria-hidden', 'true');
    shot.append(img, facing, arrow('l', -45, t('kv.sv.left')), arrow('r', 45, t('kv.sv.right')), zoom);   // Google's logo is in the image itself
    shot.tabIndex = 0; shot.setAttribute('role', 'button'); shot.setAttribute('aria-label', t('kv.sv.full'));
    shot.onclick = () => svFull({ ...v }); shot.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); svFull({ ...v }); } };
    body.replaceChildren(shot); setImg();
    const when = j.date ? new Date(j.date + (j.date.length === 7 ? '-15' : '')).toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }) : '';
    meta.textContent = [when ? t('kv.sv.date', { d: when }) : '', j.m > 15 ? t('kv.sv.off', { m: j.m }) : '', t('kv.sv.clickfull')].filter(Boolean).join(' · ');
    MAP.fitPopup();
  }

  /* ---------------- hand-off, sharing, GPX, saved routes ---------------- */
  /* Hand-off to a navigation app. Plain https links: on a phone with the app installed the system opens the app.
     Google Maps: up to 9 via points (3 in a phone browser without the app), Apple Maps: several via points from iOS 18.4 /
     macOS 15.4 (older iPhones get start and destination only), Waze: the destination only. Apple Maps is offered on Apple
     devices only. */
  const UA = navigator.userAgent || '';
  const isApple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(UA) && !/Android/.test(UA);
  const isPhone = /Android|iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);   // an iPad says Macintosh
  const iosVer = (() => { const m = UA.match(/OS (\d+)_(\d+)/); return /iPhone|iPad|iPod/.test(UA) && m ? +m[1] * 100 + +m[2] : null; })();   // 18.4 -> 1804
  /* Via points a navigation app cannot misread. Each one sits in the middle of a long stretch of a single road, at least
     2 km from any junction (the router's manoeuvre points), so the app snaps it to that road and not to a side road it
     would drive into and back out of (seen: a stop at Glåmos where Rv 30 meets a side road). Stretches of the road that
     makes this route different from the others count double; points keep apart along the route and away from A and B. */
  function pointAtKm(R, k) {
    let lo = 0, hi = R.cumKm.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.cumKm[m] <= k) lo = m; else hi = m; }
    const a = R.cumKm[lo], b = R.cumKm[hi], f = b > a ? (k - a) / (b - a) : 0, p = R.coords[lo], q = R.coords[hi];
    return { lat: p[0] + f * (q[0] - p[0]), lon: p[1] + f * (q[1] - p[1]), km: k };
  }
  function viaPicks(R, n) {
    const gap = Math.max(10, R.km / (n + 1) / 2);   // apart from each other and from A and B
    const cands = R.steps.filter((st) => !st.ferry && st.km1 - st.km0 >= 4)
      .map((st) => ({ k: (st.km0 + st.km1) / 2, score: (st.km1 - st.km0) * (st.ref && st.ref === R.via ? 2 : 1) }))
      .sort((a, b) => b.score - a.score);
    const picks = [];
    for (const c of cands) {
      if (picks.length >= n) break;
      if (c.k < gap || R.km - c.k < gap || picks.some((p) => Math.abs(p.k - c.k) < gap)) continue;
      picks.push(c);
    }
    return picks.sort((a, b) => a.k - b.k).map((c) => pointAtKm(R, c.k));
  }

  const ll = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)}`;
  function navLinks(s) {
    const R = s.R, out = [];
    out.push({ id: 'google', label: 'Google Maps', href: `https://www.google.com/maps/dir/?api=1&origin=${ll(kv.from)}&destination=${ll(kv.to)}&travelmode=driving&waypoints=${encodeURIComponent(viaPicks(R, isPhone ? 3 : 6).map(ll).join('|'))}` });
    if (isApple) {
      if (iosVer != null && iosVer < 1804) out.push({ id: 'apple', label: 'Apple Maps', href: `https://maps.apple.com/?saddr=${ll(kv.from)}&daddr=${ll(kv.to)}&dirflg=d`, note: 'kv.open.apple.old' });
      else out.push({ id: 'apple', label: 'Apple Maps', href: `https://maps.apple.com/directions?source=${ll(kv.from)}&destination=${ll(kv.to)}${viaPicks(R, isPhone ? 3 : 6).map((p) => '&waypoint=' + ll(p)).join('')}&mode=driving` });
    }
    out.push({ id: 'waze', label: 'Waze', href: `https://waze.com/ul?ll=${ll(kv.to)}&navigate=yes`, note: 'kv.open.waze' });
    return out;
  }
  function renderOpen(s) {
    const links = navLinks(s);
    $('kvOpen').innerHTML = links.map((l) => `<a class="btn kv-navbtn" data-nav="${l.id}" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
    $('kvOpenNote').textContent = [t('kv.open.note'), t('kv.open.between'), ...links.filter((l) => l.note).map((l) => t(l.note)), curvyOn() ? t('kv.open.gpx') : ''].filter(Boolean).join(' ');
  }

  function gpx() {
    const s = kv.S[kv.sel], R = s.R, x = (v) => esc(String(v));
    const wpt = (p, n) => `<wpt lat="${(+p.lat).toFixed(6)}" lon="${(+p.lon).toFixed(6)}"><name>${x(n)}</name></wpt>`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Glett Kjørevær" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      wpt(kv.from, kv.from.name || 'A') + wpt(kv.to, kv.to.name || 'B') + R.tops.map((i) => wpt(R.dense[i], `${Math.round(R.dense[i].z)} moh`)).join('') +
      `<trk><name>${x(routeTitle(R))}</name><trkseg>${R.coords.map((c) => `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"/>`).join('')}</trkseg></trk></gpx>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/gpx+xml' }));
    a.download = `glett-${(kv.from.name || 'A')}-${(kv.to.name || 'B')}.gpx`.replace(/[^\wæøåÆØÅ.-]+/g, '-');
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const pStr = (p) => `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)},${encodeURIComponent(p.name || '').replace(/%2C/gi, ' ')}`;   // a comma would split the name
  const pParse = (s) => { const [la, lo, ...n] = String(s || '').split(','); return Number.isFinite(+la) && Number.isFinite(+lo) && la !== '' ? { lat: +la, lon: +lo, name: n.join(',') } : null; };
  function hashFor() {
    const v = kv.via.map(pStr).join(';'), d = kv.dep ? `${kv.dep.getFullYear()}${pad2(kv.dep.getMonth() + 1)}${pad2(kv.dep.getDate())}${pad2(kv.dep.getHours())}` : '';
    const o = (kv.opts.noFerry ? 'f' : '') + (kv.opts.noDark ? 'd' : '') + (kv.opts.curvy ? 'c' : '') + (kv.opts.noGravel ? 'g' : '');
    return `#kv?a=${pStr(kv.from)}&b=${pStr(kv.to)}${v ? '&v=' + v : ''}&p=${kv.veh}${d ? '&d=' + d : ''}${o ? '&o=' + o : ''}`;
  }
  function writeHash() { try { history.replaceState(null, '', hashFor()); } catch (e) { /* ignore */ } }
  function readHash() {
    const h = location.hash; if (!h.startsWith('#kv')) return false;
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    const a = pParse(q.get('a')), b = pParse(q.get('b'));
    kv.via = (q.get('v') || '').split(';').map(pParse).filter(Boolean).slice(0, 3);
    kv.veh = q.get('p') === 'mc' ? 'mc' : 'car';
    if (q.has('o')) { const o = q.get('o') || ''; kv.opts = { noFerry: o.includes('f'), noDark: o.includes('d'), curvy: o.includes('c'), noGravel: o.includes('g') }; }
    const d = q.get('d'); kv.dep = null;
    if (d && /^\d{10}$/.test(d)) { const x = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10)); if (x > Date.now() && x - Date.now() < MAX_AHEAD_H * 3600e3) kv.dep = x; }
    if (a) kv.from = a; if (b) kv.to = b;
    return !!(a && b);
  }
  function saveLast() { lsSet('glett.kv.last', JSON.stringify({ from: kv.from, to: kv.to, via: kv.via })); }
  const savedList = () => { const a = lsJson('glett.routes', []); return Array.isArray(a) ? a : []; };
  function renderSaved() {
    const list = savedList(), el = $('kvSaved');
    el.innerHTML = list.length ? list.map((r, i) => `<li><span><b>${esc(r.name)}</b><small>${esc([r.from.name, ...(r.via || []).map((v) => v.name), r.to.name].filter(Boolean).join(' → '))} · ${t('kv.veh.' + (r.veh || 'car'))}</small></span>
      <span class="kv-sv-act"><button type="button" class="kv-chip small" data-open="${i}">${t('kv.saved.open')}</button><button type="button" class="kv-x" data-del="${i}" title="${esc(t('saved.delete'))}" aria-label="${esc(t('saved.delete'))}">×</button></span></li>`).join('')
      : `<li class="kv-empty">${t('kv.saved.none')}</li>`;
  }
  function saveRoute() {
    if (!kv.from || !kv.to) return;
    const def = `${kv.from.name || 'A'} → ${kv.to.name || 'B'}`;
    ask({ title: t('kv.save.title'), text: t('kv.save.name'), value: def, ok: t('kv.save.ok') }).then((name) => {
    if (name == null) return;
    const list = savedList().filter((r) => !(r.key === routeKey() && r.veh === kv.veh));
    list.unshift({ id: Date.now().toString(36), key: routeKey(), name: name.trim() || def, from: kv.from, to: kv.to, via: kv.via, veh: kv.veh, opts: { ...kv.opts }, created: new Date().toISOString() });
    lsSet('glett.routes', JSON.stringify(list.slice(0, 50))); renderSaved(); toast(t('kv.saved.ok'));
    });
  }
  /* ask({ title, text, value, ok, danger, readonly }) -> the text typed (value given), true (no value), or null when cancelled */
  function ask(o) {
    return new Promise((resolve) => {
      const d = $('kvDlg'), inp = $('kvDlgInput'), okB = $('kvDlgOk'), form = $('kvDlgForm');
      $('kvDlgTitle').textContent = o.title; $('kvDlgText').textContent = o.text || ''; $('kvDlgText').hidden = !o.text;
      inp.hidden = o.value == null; inp.value = o.value ?? ''; inp.readOnly = !!o.readonly;
      okB.textContent = o.ok || t('kv.dlg.ok'); okB.classList.toggle('danger', !!o.danger); $('kvDlgCancel').textContent = t('kv.dlg.cancel');
      let done = false;
      const finish = (v) => { if (done) return; done = true; form.onsubmit = null; $('kvDlgCancel').onclick = null; d.onclose = null; d.oncancel = null; if (d.open) d.close(); resolve(v); };
      form.onsubmit = (e) => { e.preventDefault(); finish(o.value == null ? true : inp.value); };
      $('kvDlgCancel').onclick = () => finish(null);
      d.oncancel = () => finish(null);
      d.onclick = (e) => { if (e.target === d) finish(null); };   // a click on the backdrop
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      setTimeout(() => { if (!inp.hidden) { inp.focus(); inp.select(); } else okB.focus(); }, 30);
    });
  }
  function toast(msg) { const el = $('kvToast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2200); }

  /* ---------------- search for Fra / Til / Via: street addresses as well as places ----------------
     Place names come from Open-Meteo (as everywhere in Glett). When the text holds a house number, each region's address
     source is asked first; in Norway that is Kartverket's address register (Geonorge, every street address, CORS open,
     no key). The register wants the town as its own parameter, so "Storgata 12, Lillehammer", "Storgata 12 Lillehammer"
     and "Storgata 12, 2609" are split into the street part and a postal town, municipality or postcode. */
  const townCase = (x) => String(x || '').toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
  /* The ways people write an address, as candidates of { street, num, town }, the likeliest first:
     "Storgata 12B, Lillehammer", "Storgata 12 b Lillehammer", "Storgata 12, 2609", and the house number first
     ("12B Storgata, Lillehammer"; without a comma the town may be the last word or two). */
  function addressCandidates(q) {
    q = q.trim().replace(/(\d+)\s*-?\s*([a-zA-ZæøåÆØÅ])(?![\wæøåÆØÅ])/g, (x, n, l) => n + l.toUpperCase());   // 12b, 12 B, 12-B -> 12B
    let m = q.match(/^(\d+[A-ZÆØÅ]?)\s+(.+)$/);   // number first
    if (m) {
      const num = m[1], rest = m[2];
      if (rest.includes(',')) { const [st, ...tw] = rest.split(','); return [{ street: st.trim(), num, town: tw.join(',').trim() }]; }
      const w = rest.split(/\s+/), out = [{ street: rest, num, town: '' }];
      for (let k = 1; k <= 2 && k < w.length; k++) out.push({ street: w.slice(0, -k).join(' '), num, town: w.slice(-k).join(' ') });
      return out;
    }
    m = q.match(/^(.*?)\s+(\d+[A-ZÆØÅ]?)(?![\wæøåÆØÅ])\s*,?\s*(.*)$/);   // number after the street
    return m && m[1] ? [{ street: m[1].trim(), num: m[2], town: m[3].trim().replace(/^,\s*/, '') }] : [];
  }
  const ADDRESS_SOURCES = {
    geonorge: {
      base: 'https://ws.geonorge.no/adresser/v1/sok?utkoordsys=4258',
      // the town as postcode, postal town or municipality (they often differ: poststed Moelv, kommune Ringsaker)
      townFilters: (town) => (!town ? [''] : /^\d{4}$/.test(town) ? ['&postnummer=' + town] : ['&poststed=' + encodeURIComponent(town), '&kommunenavn=' + encodeURIComponent(town)]),
      async get(u) { try { const r = await fetchT(u); if (!r.ok) return []; return ((await r.json()).adresser || []).filter((x) => x.representasjonspunkt); } catch (e) { return []; } },
      async search(q) {   // a full address: exact first, then numbers that start the same (12 -> 120A), then the street in that town
        for (const c of addressCandidates(q)) {
          const f = this.townFilters(c.town), sok = (x) => `${this.base}&treffPerSide=8&sok=${encodeURIComponent(x)}`;
          for (const u of [...f.map((x) => sok(`${c.street} ${c.num}`) + x), ...f.map((x) => sok(`${c.street} ${c.num}*`) + x), ...(c.town ? f.map((x) => sok(c.street) + x) : [])]) {
            const a = await this.get(u);
            if (a.length) return a.map((x) => ({ name: `${x.adressetekst}, ${townCase(x.poststed)}`, sub: `${x.postnummer} ${townCase(x.poststed)}${x.kommunenavn && x.kommunenavn.toLowerCase() !== String(x.poststed).toLowerCase() ? ' · ' + townCase(x.kommunenavn) : ''}`,
              lat: x.representasjonspunkt.lat, lon: x.representasjonspunkt.lon, kind: 'addr' }));
          }
        }
        return [];
      },
      async streets(q) {   // streets whose name starts with the text, one row per street and postcode, placed at a middle house
        const a = await this.get(`${this.base}&treffPerSide=100&adressenavn=${encodeURIComponent(q.trim() + '*')}`), g = new Map();
        a.forEach((x) => { const k = x.adressenavn + '|' + x.postnummer; if (!g.has(k)) g.set(k, []); g.get(k).push(x); });
        return [...g.values()].map((xs) => { xs.sort((u, v) => (u.nummer || 0) - (v.nummer || 0)); const x = xs[Math.floor(xs.length / 2)];
          return { name: `${x.adressenavn}, ${townCase(x.poststed)}`, sub: `${x.postnummer} ${townCase(x.poststed)}`, lat: x.representasjonspunkt.lat, lon: x.representasjonspunkt.lon, kind: 'street' }; });
      },
    },
  };
  async function placeSearch(q) {
    const srcs = [...new Set(KV_REGIONS.map((r) => r.addresses).filter(Boolean))].map((id) => ADDRESS_SOURCES[id]);
    const hasNumber = /\d/.test(q) && !/^\d{4}$/.test(q.trim());
    if (hasNumber) {   // an address: address hits stand alone (as intelmap does); places only when nothing matched
      const addr = (await Promise.all(srcs.map((s) => s.search(q)))).flat();
      if (addr.length) return addr.slice(0, 8);
      const place = q.replace(/\d+[a-zA-Z]?/g, ' ').replace(/[\s,]+/g, ' ').trim();
      return (await WEFO.search(place || q, LANG).catch(() => [])).slice(0, 8).map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, kind: 'place' }));
    }
    // a name: places first (Kongsberg the town), then streets that start with it (Kongsberggata in Oslo)
    const [places, streets] = await Promise.all([WEFO.search(q, LANG).catch(() => []), q.trim().length >= 3 ? Promise.all(srcs.map((s) => s.streets(q))).then((a) => a.flat()) : []]);
    const P = places.slice(0, 5).map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, kind: 'place' }));
    return [...P, ...streets.slice(0, Math.max(3, 8 - P.length))];
  }

  /* ---------------- the form: A, B, via, vehicle, departure ---------------- */
  function syncForm() {
    $('kvFrom').value = kv.from ? kv.from.name || `${(+kv.from.lat).toFixed(3)}, ${(+kv.from.lon).toFixed(3)}` : '';
    $('kvTo').value = kv.to ? kv.to.name || `${(+kv.to.lat).toFixed(3)}, ${(+kv.to.lon).toFixed(3)}` : '';
    $('kvVias').innerHTML = kv.via.map((v, i) => `<div class="kv-field kv-viarow"><b>${t('kv.via.label')}</b><span>${esc(v.name || '')}</span><button type="button" class="kv-x" data-unvia="${i}" aria-label="${esc(t('pb.remove'))}">×</button></div>`).join('');
    $('kvAddVia').hidden = kv.via.length >= 3;
    document.querySelectorAll('#kvVeh button').forEach((b) => b.classList.toggle('on', b.dataset.v === kv.veh));
    document.querySelectorAll('#kvOpts [data-opt]').forEach((b) => { const on = !!kv.opts[b.dataset.opt]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    $('kvOptCurvy').hidden = false;
    renderDayChips();
  }
  function renderDayChips() {
    const opts = depOptions(), cur = kv.dep || opts[0], days = [];
    opts.forEach((d) => { const k = dayKey(d); if (!days.includes(k)) days.push(k); });
    const today = dayKey(new Date()), tmr = dayKey(new Date(Date.now() + 864e5));
    $('kvDays').innerHTML = days.map((k) => { const d = opts.find((x) => dayKey(x) === k);
      const lbl = k === today ? t('kv.today') : k === tmr ? t('kv.tomorrow') : `${wday(d)} ${d.getDate()}.`;
      return `<button type="button" class="kv-chip${k === dayKey(cur) ? ' on' : ''}" data-day="${k}">${esc(lbl)}</button>`; }).join('');
    const sel = $('kvHour');
    sel.innerHTML = opts.filter((d) => dayKey(d) === dayKey(cur)).map((d, i) => { const now = d === opts[0];
      return `<option value="${+d}"${(now && !kv.dep) || (kv.dep && Math.abs(+d - +kv.dep) < 1800e3) ? ' selected' : ''}>${now ? t('kv.now') : esc(hm(d))}</option>`; }).join('');
  }
  function setDep(d) {   // d = null -> now
    kv.dep = d && d - Date.now() > 20 * 60e3 ? d : null;
    renderDayChips(); writeHashIfDone();
    if (kv.routes.length) render();
    // Vegvesen's answer depends on the start time (closures, delays): ask again when the departure moves an hour or more
    clearTimeout(setDep.t);
    if (kv.source === 'vegvesen' && Math.abs(+(kv.dep || new Date()) - (kv.routedAt || 0)) >= 3600e3) setDep.t = setTimeout(() => { const sel = kv.sel; plan().then(() => { if (sel < kv.routes.length) { kv.sel = sel; render(); } }); }, 800);
  }
  function writeHashIfDone() { if (kv.routes.length) writeHash(); }
  function wireSearch(input, list, set) {
    let timer = null, seq = 0;
    const close = () => { list.hidden = true; list.innerHTML = ''; };
    input.addEventListener('input', () => {
      clearTimeout(timer); const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        const my = ++seq; let res = [];
        try { res = await placeSearch(q); } catch (e) { res = []; }
        if (my !== seq) return;
        list.innerHTML = res.length ? res.map((r, i) => r.kind === 'place'
          ? `<li data-i="${i}" class="kv-hit"><span><b>${esc(String(r.name).split(',')[0])}</b><small>${esc(String(r.name).split(',').slice(1).join(',').trim())}</small></span><i class="kv-kind">${t('kv.kind.place')}</i></li>`
          : `<li data-i="${i}" class="kv-hit"><span><b>${esc(r.name.split(',')[0])}</b><small>${esc(r.sub)}</small></span><i class="kv-kind ${r.kind}">${t('kv.kind.' + r.kind)}</i></li>`).join('') : `<li class="none">${t('search.none')}</li>`;
        list.hidden = false;
        // an address keeps "street number, town"; a place keeps its first part, as before
        list.onclick = (e) => { const li = e.target.closest('li[data-i]'); if (!li) return; const r = res[+li.dataset.i]; set({ lat: r.lat, lon: r.lon, name: r.kind === 'place' ? String(r.name).split(',')[0] : r.name }); close(); };
      }, 350);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { const li = list.querySelector('li[data-i]'); if (li) li.click(); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('.kv-search')) close(); });
  }
  // A change to the places only marks the result as stale; the calculation starts with the Finn ruter button.
  // Opening a saved route or a shared link is itself a request, so those calculate at once (go()).
  function markDirty() {
    kv.fitted = false; kv.dirty = true;
    $('kvGo').disabled = !(kv.from && kv.to);
    $('view-route').classList.toggle('kv-isstale', kv.routes.length > 0); MAP.stale(kv.routes.length > 0);
    if (kv.routes.length && kv.from && kv.to) status(t('kv.stale'), 'info', 'kv.stale'); else if (kv.st && kv.st.kind !== 'busy') status('', '');
  }
  function go() { markDirty(); if (kv.from && kv.to) plan(); }
  let wired = false;
  function wire() {
    if (wired) return; wired = true;
    wireSearch($('kvFrom'), $('kvFromRes'), (p) => { kv.from = p; syncForm(); markDirty(); });
    wireSearch($('kvTo'), $('kvToRes'), (p) => { kv.to = p; syncForm(); markDirty(); });
    wireSearch($('kvViaIn'), $('kvViaRes'), (p) => { kv.via.push(p); $('kvViaBox').hidden = true; $('kvViaIn').value = ''; syncForm(); markDirty(); });
    $('kvAddVia').addEventListener('click', () => { $('kvViaBox').hidden = false; $('kvViaIn').focus(); });
    $('kvVias').addEventListener('click', (e) => { const b = e.target.closest('[data-unvia]'); if (b) { kv.via.splice(+b.dataset.unvia, 1); syncForm(); markDirty(); } });
    $('kvSwap').addEventListener('click', () => { [kv.from, kv.to] = [kv.to, kv.from]; kv.via.reverse(); syncForm(); markDirty(); });
    $('kvGeo').addEventListener('click', () => {
      if (!navigator.geolocation) { status(t('err.geo.unsupported'), 'err', 'err.geo.unsupported'); return; }
      status(t('pb.geo.loading'), 'busy', 'pb.geo.loading');
      navigator.geolocation.getCurrentPosition(async (pos) => {
        kv.from = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), name: t('pb.geo.name') };
        syncForm(); status('', '');
        try { const n = await WEFO.reverse(kv.from.lat, kv.from.lon, LANG, true); if (n) { kv.from.name = String(n).split(',')[0]; syncForm(); } } catch (e) { /* keep "Min posisjon" */ }
        markDirty();
      }, () => status(t('err.geo.fail'), 'err', 'err.geo.fail'), { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    });
    $('kvVeh').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b || b.dataset.v === kv.veh) return;
      kv.veh = b.dataset.v; lsSet('glett.kv.veh', kv.veh); syncForm(); writeHashIfDone();
      if (kv.routes.length) render(); });
    // ferries and bendy roads change the route (calculated with Finn ruter); darkness only changes the scoring, at once
    $('kvOpts').addEventListener('click', (e) => { const b = e.target.closest('[data-opt]'); if (!b) return; const k = b.dataset.opt;
      kv.opts[k] = !kv.opts[k]; lsSet('glett.kv.opts', JSON.stringify(kv.opts)); syncForm(); writeHashIfDone();
      if (k === 'noDark') { if (kv.routes.length) render(); } else markDirty(); });
    $('kvDays').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return;
      const opts = depOptions(), h = (kv.dep || new Date()).getHours(), same = opts.filter((d) => dayKey(d) === b.dataset.day);
      setDep(same.find((d) => d.getHours() === Math.max(h, same[0].getHours())) || same[0]); });
    $('kvHour').addEventListener('change', (e) => setDep(new Date(+e.target.value)));
    $('kvDep').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) setDep(kv.depOpts[+b.dataset.k]); });
    $('kvDepHint').addEventListener('click', (e) => { const ub = e.target.closest('#kvUseBest'); if (ub) setDep(kv.depOpts[+ub.dataset.k]); });
    const stageClick = (li) => {
      if (!li || !kv.S) return; const R = kv.S[kv.sel].R, k0 = +li.dataset.k0, k1 = +li.dataset.k1;
      const coords = R.coords.filter((_, i) => R.cumKm[i] >= k0 - 0.05 && R.cumKm[i] <= k1 + 0.05);
      if (coords.length < 2) return;
      document.querySelectorAll('#kvIt .kv-stage.on').forEach((x) => x.classList.remove('on')); li.classList.add('on');
      clearTimeout(stageClick.t); stageClick.t = setTimeout(() => li.classList.remove('on'), 20000);
      const head = document.querySelector('.topbar'), wrap = $('kvMapWrap');   // to the map, so it is clear where to look
      window.scrollTo({ top: wrap.getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 60) - 12, behavior: 'smooth' });
      setTimeout(() => MAP.highlight(coords), 350);
    };
    $('kvIt').addEventListener('click', (e) => { if (e.target.closest('a')) return; stageClick(e.target.closest('.kv-stage')); });
    $('kvIt').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('kv-stage')) { e.preventDefault(); stageClick(e.target); } });
    $('kvCards').addEventListener('click', (e) => { const c = e.target.closest('.kv-rc'); if (!c) return; kv.sel = +c.dataset.i; render(); });
    $('kvSave').addEventListener('click', saveRoute);
    $('kvGpx').addEventListener('click', gpx);
    $('kvShare').addEventListener('click', async () => {
      const url = location.origin + location.pathname + hashFor();
      try { if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: 'Glett Kjørevær', url }); return; } await navigator.clipboard.writeText(url); toast(t('kv.share.ok')); } catch (e) { ask({ title: t('kv.share'), text: t('kv.share.copy'), value: url, readonly: true, ok: t('kv.dlg.ok') }); }
    });
    $('kvSaved').addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]'), list = savedList();
      if (o) { const r = list[+o.dataset.open]; kv.from = r.from; kv.to = r.to; kv.via = r.via || []; kv.veh = r.veh || 'car'; if (r.opts) kv.opts = { noFerry: !!r.opts.noFerry, noDark: !!r.opts.noDark, curvy: !!r.opts.curvy, noGravel: !!r.opts.noGravel }; syncForm(); go(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (d) { const k = +d.dataset.del, r = list[k];
        ask({ title: t('kv.del.title'), text: t('kv.saved.del', { n: r.name }), ok: t('saved.delete'), danger: true }).then((yes) => {
          if (!yes) return; const now = savedList().filter((x) => !(x.id === r.id && x.key === r.key)); lsSet('glett.routes', JSON.stringify(now)); renderSaved(); }); }
    });
    $('kvGo').addEventListener('click', () => { if (!kv.busy) go(); });
    $('kvBig').addEventListener('click', () => setBig(!$('kvMap').classList.contains('big')));
    addEventListener('resize', () => { if ($('kvMap').classList.contains('big')) fitBig(); });
    $('kvLgDet').addEventListener('toggle', () => { if ($('kvMap').classList.contains('big')) fitBig(); });
    let rt = null;
    addEventListener('resize', () => { if (!$('view-route').classList.contains('active') || !kv.S) return; clearTimeout(rt); rt = setTimeout(() => renderChart(kv.S[kv.sel]), 150); });
  }

  /* ---------------- entry points used by app.js ---------------- */
  /* A fresh planner: nothing calculated, To and via empty, departure now; From is the place shown on the forecast page.
     The vehicle and the route options (preferences) are kept. */
  function freshPlanner() {
    kv.token++;   // anything still loading is dropped
    Object.assign(kv, { routes: [], S: null, sel: 0, to: null, via: [], dep: null, fitted: false, dirty: false, seek: null });
    kv.from = typeof state !== 'undefined' && state.current ? { lat: state.current.lat, lon: state.current.lon, name: state.current.name } : null;
    MAP.closePopup && MAP.closePopup();
    $('kvResult').hidden = true; $('kvGo').classList.remove('busy'); status('', '');
    $('view-route').classList.remove('kv-isstale'); $('view-route').classList.add('kv-noroute');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  // Opening Kjørevær from the menu starts fresh; a shared link (#kv?…) opens and calculates that route
  window.kvShow = function () {
    wire();
    const fromLink = location.hash.startsWith('#kv');
    if (!kv.started && matchMedia('(min-width: 901px)').matches) $('kvLgDet').open = true;
    kv.started = true;
    let ok = false;
    if (fromLink) { try { ok = readHash(); } catch (e) { ok = false; } }
    if (!ok) freshPlanner();
    $('view-route').classList.toggle('kv-noroute', !kv.routes.length);   // the chart and the itinerary wait for the first route
    syncForm(); renderSaved(); bigLabel(); showMap();
    $('kvGo').disabled = !(kv.from && kv.to);
    if (ok && kv.from && kv.to) { kv.fitted = false; plan(); }
  };
  window.kvEngine = { classify, crossings, segments, viaPicks, addressCandidates, map: () => MAP.m, KV_ROUTERS, KV_REGIONS, KV_PROFILES, state: () => kv };   // for tests and future regions / routers
  window.kvLang = function () { if (!kv.started) return; syncForm(); renderSaved(); bigLabel(); if (kv.st && kv.st.key) status(t(kv.st.key), kv.st.kind, kv.st.key); if (kv.routes.length) render(); };
  // a shared link (#kv?a=…&b=…) opens Kjørevær directly
  if (location.hash.startsWith('#kv')) setTimeout(() => showView('route'), 0);
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#kv') && readHash()) { syncForm(); showView('route'); go(); } });
})();
