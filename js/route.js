'use strict';
/* ================= Kjørevær: the weather along a driving route =================
   A -> B by car, up to three alternative routes, the forecast at the time you will be at each point, for a departure
   now or up to four days ahead. No turn-by-turn: a road-number itinerary and a hand-off to a navigation app.
   Three registries keep it expandable without touching the engine:
     KV_ROUTERS   – routing services (Statens vegvesen via api/route.php, Valhalla/OpenStreetMap in the browser)
     KV_REGIONS   – where Kjørevær works, which routers, map and road-number style apply (Norway first)
     KV_PROFILES  – vehicles: routing options per router plus weather thresholds and weights (car; motorcycle with
                    the same roads for now, a curvy-road router can be added to its `routers` later)
   Weather: MET's Locationforecast for every sample through api/met.php (shared by all visitors on the server; Open-Meteo
   for what MET does not give), the chosen route first and shown as soon as it is in, the other routes and the four other
   models (Open-Meteo, in the browser) after; elevations from Kartverket or Open-Meteo, MET warnings through api/alerts.php. Saved routes live only in this
   browser (localStorage 'glett.routes') and go with the saved places in export / import. */
(function () {
  const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';   // FOSSGIS demo: fair use, so results are cached and calls kept few
  const MAX_AHEAD_H = 96;   // departures up to four days ahead (the forecasts reach 7 days, so a long drive after a late start is covered): measured skill falls day by day, rain most
  const MET_H = 60;                     // MET Nordic's forecast reaches about 60 hours; beyond that only the global models (used where MET did not answer)
  const DENSE_KM = 2;              // elevation profile spacing
  const WX_MIN = 10, WX_KM = 20;   // a weather sample every 10 minutes of driving or 20 km, whichever comes first

  // the engine shared with Turvær (js/kvcore.js): fetches, the forecast at a point and time, the model vote, stretches, warnings
  const { fetchT, pad2, hm, wday, dayKey, hav, dur, cssv, cellKey, elevate, fetchForecast, classify, KV_CLASSES, wxAt, fcEnd, fcHourly, fetchEnsemble, keyPoints, nearKey, weightAreas,
    ensAt, vote, ensHints, FAM, FAM_RANK, WET, SNOWY, segments, crossings, alertAt, loadAlerts, fetchRain, rainCache } = KVCore;
  // Kjørevær's classes: the engine's, with "våt vei" (damp) after dry: no rain now, but the road still wet after rain (motorcycle only)
  const KV_CLS = ['dry', 'damp', ...KV_CLASSES.slice(1)];

  /* ---------------- registries ---------------- */
  const KV_ROUTERS = {
    vegvesen: {   // Statens vegvesen Ruteplantjeneste v3 through api/route.php (credentials stay on the server)
      label: 'Statens vegvesen', can: { noFerry: true, curvy: false, noGravel: false, narrow: true }, maxAvoid: 80,
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
        const r = await fetchT(`api/route.php?stops=${encodeURIComponent(stops)}&kind=${req.profile.routers.vegvesen.kind}&start=${st}&lang=${LANG}${req.opts.noFerry ? '&noferry=1' : ''}${req.avoid && req.avoid.length ? '&barriers=' + req.avoid.map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(';') : ''}`);
        const j = await r.json().catch(() => null);
        if (req.avoid && j && j.noroute) return [];   // every way passes a blocked stretch (also when remembered by the server)
        if (!r.ok || !j) throw new Error('vegvesen ' + r.status);
        return fromVegvesen(j, req);
      },
    },
    valhalla: {   // OpenStreetMap; the FOSSGIS server allows browser calls (CORS *)
      label: 'Valhalla / OpenStreetMap', can: { noFerry: true, curvy: true, noGravel: true, narrow: true }, maxAvoid: 50,
      async available() { return true; },
      async route(req) {
        const pts = [req.from, ...req.via, req.to];
        const o = req.opts.curvy && req.profile.routers.valhalla.curvy ? req.profile.routers.valhalla.curvy : req.profile.routers.valhalla;
        const co = { ...(o.options || {}), ...(req.opts.noFerry ? { use_ferry: 0 } : {}), ...(req.opts.noGravel ? { exclude_unpaved: true } : {}) };
        const body = { locations: pts.map((p, i) => ({ lat: +p.lat, lon: +p.lon, type: i === 0 || i === pts.length - 1 ? 'break' : 'through' })),
          costing: o.costing, costing_options: { [o.costing]: co }, alternates: req.via.length ? 0 : 2, units: 'kilometers', elevation_interval: 200,
          ...(typeof KV_RU_EXCLUDE !== 'undefined' ? { exclude_polygons: [KV_RU_EXCLUDE] } : {}),   // the border with Russia is in practice closed
          ...(req.avoid && req.avoid.length ? { exclude_locations: req.avoid.slice(0, 50).map(([la, lo]) => ({ lat: la, lon: lo })) } : {}),   // narrow stretches (on the route line, so they snap to the right road)
          language: LANG === 'nb' ? 'nb-NO' : 'en-US', directions_type: 'maneuvers' };
        let noPath = false;   // Valhalla's own "no path" (442), as opposed to an error
        const ask = async (b) => { const r = await fetchT(VALHALLA_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); if (r.ok) return r.json(); const e = await r.json().catch(() => ({})); noPath = noPath || e.error_code === 442; return null; };
        let j = await ask(body), forced = false;
        if (!j && body.exclude_polygons) { delete body.exclude_polygons; j = await ask(body); }   // refused: route without it (the Russia check on the result remains)
        if (req.avoid && (!j || !j.trip)) { if (noPath) return []; throw new Error('valhalla: no answer'); }   // no way round the narrow stretches (the planner keeps its best attempt), or an error
        if ((!j || !j.trip) && co.exclude_unpaved) {   // no route without gravel: route anyway and say so on the cards
          delete co.exclude_unpaved; j = await ask(body); forced = true;
        }
        if (!j || !j.trip) throw new Error('valhalla: no route');
        let trips = [j.trip, ...(j.alternates || []).map((a) => a.trip)];
        // Valhalla's forward search can miss the motorway on long trips (Oslo–Kristiansand: an inland road 36 min slower than
        // E 18); a search backwards from the arrival time finds it. Ask that way too and put a clearly faster route first.
        if (!req.via.length && j.trip.summary && j.trip.summary.length > 120) {
          const arrive = new Date(+req.depart + j.trip.summary.time * 1000), iso = `${arrive.getFullYear()}-${String(arrive.getMonth() + 1).padStart(2, '0')}-${String(arrive.getDate()).padStart(2, '0')}T${String(arrive.getHours()).padStart(2, '0')}:${String(arrive.getMinutes()).padStart(2, '0')}`;
          const back = await ask({ ...body, alternates: 0, date_time: { type: 2, value: iso } }).catch(() => null);
          if (back && back.trip && back.trip.summary.time < j.trip.summary.time * 0.97) trips = [back.trip, ...trips.filter((tr) => Math.abs(tr.summary.length - back.trip.summary.length) > 2 || Math.abs(tr.summary.time - back.trip.summary.time) > 120)];
        }
        return trips.map((tr) => Object.assign(fromValhalla(tr), { gravelForced: forced }));
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
      ref: refNorway, status: { url: 'https://www.vegvesen.no/trafikk/' }, elevation: 'kartverket', addresses: 'geonorge', roads: 'nvdb', live: 'datex', cams: 'datex', sights: true, rest: true },
    // next: { id: 'se', contains: …, routers: ['valhalla'], tiles: 'osm', ref: refSweden, status: null }
  ];
  const KV_PROFILES = {
    car: { id: 'car', routers: { valhalla: { costing: 'auto', curvy: { costing: 'auto', options: { use_highways: 0, use_tolls: 0.5 } } }, vegvesen: { kind: 'best' } }, gust: 20,
      w: { dry: 0, damp: 0, fog: 2, wet: 1, heavy: 3, sleet: 4, snow: 6, ice: 9, thunder: 4 }, gustW: 2, darkW: 0 },
    // Motorcycle: normal routing for now; weather counts for more. A curvy-road router (Kurviger, BRouter, Valhalla
    // motorcycle costing with use_highways) plugs in here later, e.g. routers: { curvy: {...}, valhalla: {...} }
    // curvy: Valhalla's motorcycle costing kept off motorways and trunk roads (tested Oslo-Lillehammer: 34 -> 91-106 degrees of
    // turning per km, about 2 h longer). A dedicated curvy-road service (Kurviger) could replace it here later.
    mc: { id: 'mc', routers: { valhalla: { costing: 'auto', curvy: { costing: 'motorcycle', options: { use_highways: 0, use_tolls: 0.5 } } }, vegvesen: { kind: 'best' } }, gust: 13,
      w: { dry: 0, damp: 1.5, fog: 3, wet: 3, heavy: 6, sleet: 8, snow: 10, ice: 12, thunder: 8 }, gustW: 4, darkW: 1,
      // a wet road after rain (WR below) counts half of rain a minute, a damp one a quarter: a judgement weight like the others
      wetRoad: true, dampMoist: 0.5,
      // cold in the riding wind (feelCold below), a minute: felt under +5 °C, felt under 0 °C, and rain with the air under +8 °C
      // on top; judgement weights like the others (darkness 1, rain 3)
      cold: { cool: 0.5, freeze: 1.5, wet: 1 },
      // low grip (gripCold below): tyres and asphalt grip less under +5 °C, which matters most in bends: a minute of it counts
      // 0.5, and a minute on a bendy kilometre (80 degrees of turning per km or more: bendLevel 'high') 1.5 more; judgement weights
      grip: { t: 5, w: 0.5, bend: 80, bendW: 1.5 } },
  };
  const PACE = { snow: 1.25, sleet: 1.15, ice: 1.3, heavy: 1.05, fog: 1.1 };   // slower driving in bad weather moves the later samples

  /* ---------------- small helpers ---------------- */
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
  /* Where the bends are: the turning (degrees) of each 100 m of road, as in bendiness(), and a prefix sum over it, so the
     degrees per km within ±500 m of any point are one subtraction. {step: 0.1, cum: [...]}, index = km / 0.1. */
  function bendProfile(R) {
    const out = [], at = (km) => { let j = 0; while (j < R.cumKm.length - 2 && R.cumKm[j + 1] < km) j++; const a = R.cumKm[j], b = R.cumKm[j + 1] ?? a, f = b > a ? (km - a) / (b - a) : 0, p = R.coords[j], q = R.coords[j + 1] || p; return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]; };
    for (let km = 0; km <= R.km; km += 0.1) out.push(at(km));
    const cum = [0, 0];
    for (let i = 2; i < out.length; i++) {
      const [a, b, c] = [out[i - 2], out[i - 1], out[i]], k = Math.cos(b[0] * Math.PI / 180);
      const h1 = Math.atan2((b[1] - a[1]) * k, b[0] - a[0]), h2 = Math.atan2((c[1] - b[1]) * k, c[0] - b[0]);
      const d = Math.hypot(c[0] - b[0], (c[1] - b[1]) * k) < 1e-9 || Math.hypot(b[0] - a[0], (b[1] - a[1]) * k) < 1e-9 ? 0 : Math.abs(((h2 - h1) * 180 / Math.PI + 540) % 360 - 180);
      cum.push(cum[i - 1] + d);
    }
    return { step: 0.1, cum };
  }
  // the share of the road from km a to km b (100 m steps) that turns at least deg degrees per km within ±500 m
  function bendShare(R, a, b, deg) {
    const P = R.bendP; if (!P || b <= a) return 0;
    const n = P.cum.length - 1, i0 = Math.max(0, Math.round(a / P.step)), i1 = Math.min(n, Math.round(b / P.step));
    let k = 0, all = 0;
    for (let i = i0; i <= i1; i++) { const lo = Math.max(0, i - 5), hi = Math.min(n, i + 5); all++; if (hi > lo && (P.cum[hi] - P.cum[lo]) / ((hi - lo) * P.step) >= deg) k++; }
    return all ? k / all : 0;
  }

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
  const NARROW_W = [3.5, 4, 4.5, 5], NARROW_MAX = 6, NARROW_MIN_KM = 0.3;   // "Smale veier: bare bredere enn …"; a stretch counts from 300 m (NVDB computes width per 100 m, and short bits at junctions and bridges are noise)
  const ROAD_SOURCES = {
    nvdb: {
      cache: new Map(),
      async widths(ref, bbox) {
        // a step without a road number (the planner often names a fylkesveg by its street name only): every road in its area,
        // and the match along the route below keeps the one driven
        const code = ref === '*' ? '' : ref.replace(/^E\s?/, 'EV').replace(/^Rv\s?/, 'RV').replace(/^Fv\s?/, 'FV').replace(/\s/g, ''), key = (code || '*') + '|' + bbox;
        if (this.cache.has(key)) return this.cache.get(key);
        const out = []; let url = `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/838?trafikantgruppe=K&${code ? `vegsystemreferanse=${code}&` : ''}kartutsnitt=${bbox}&srid=4326&inkluder=egenskaper,geometri,lokasjon&antall=1000`;
        for (let page = 0; url && page < 5; page++) {
          let j; try { const r = await fetchT(url, { headers: { Accept: 'application/json' } }); if (!r.ok) { out.failed = true; break; } j = await r.json(); } catch (e) { out.failed = true; break; }
          (j.objekter || []).forEach((o) => {
            const e = o.egenskaper || [], w = (e.find((x) => x.navn === 'Kjørebanebredde') || e.find((x) => x.navn === 'Dekkebredde') || {}).verdi;
            const wkt = o.geometri && o.geometri.wkt; if (w == null || !wkt) return;
            // ramps and side facilities (KD / SD in the road reference) are one-lane one-way roads: narrow by design, not a warning
            if (((o.lokasjon && o.lokasjon.vegsystemreferanser) || []).some((v) => / (KD|SD)\d/.test(v.kortform || ''))) return;
            const pts = wkt.replace(/[A-Z]+/g, '').replace(/[()]/g, '').split(',').map((q) => q.trim().split(/\s+/).map(Number)).filter((a) => a.length >= 2).map((a) => [a[0], a[1]]);   // srid 4326: lat lon
            if (pts.length) out.push({ w: +w, pts });
          });
          const n = j.metadata && j.metadata.neste; url = (j.objekter || []).length >= 1000 && n && n.href ? n.href : null;
        }
        if (url) out.failed = true;   // more pages than read
        if (!out.failed) this.cache.set(key, out);   // a failed lookup is asked again next time, never remembered as "no narrow road"
        return out;
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
    routes.forEach((R, ri) => R.steps.forEach((st) => { if (st.km < 0.2 || st.ferry || st.country || (!st.ref && st.km > 40)) return; const ref = st.ref || '*', k = ref + '|' + box(R, st); if (!jobs.has(k)) jobs.set(k, { ref, bbox: k.split('|')[1] }); use[ri].push(k); }));   // an unnumbered step over 40 km would ask for a whole region
    const keys = [...jobs.keys()].slice(0, 120), got = new Map();
    if (jobs.size > 120) console.warn('Kjørevær road data: only the first 120 of', jobs.size, 'stretches are checked');
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (next < keys.length) { const k = keys[next++], jb = jobs.get(k); got.set(k, await src.widths(jb.ref, jb.bbox).catch(() => Object.assign([], { failed: true }))); } }));
    routes.forEach((R, ri) => {
      const at = routeIndex(R), spans = [];
      [...new Set(use[ri])].forEach((k) => (got.get(k) || []).forEach((o) => {
        if (o.w >= NARROW_MAX) return;
        const ks = o.pts.map(([la, lo]) => at(la, lo)).filter((v) => v != null);
        if (ks.length && ks.length >= o.pts.length * 0.5) spans.push({ a: Math.min(...ks), b: Math.max(...ks), w: o.w });   // most of it along the route, not a road that touches it
      }));
      spans.sort((x, y) => x.a - y.a);
      R.narrowAll = spans; R._nar = null; R.widthGap = [...new Set(use[ri])].some((k) => (got.get(k) || {}).failed) || jobs.size > 120;   // merged per chosen limit in narrowOf(), so a 5.8 m stretch never lengthens "under 5,5 m"
    });
  }
  // the narrow stretches under the chosen limit, neighbours less than 300 m apart merged
  function narrowOf(R) {
    if (!R.narrowAll) return null; const lim = narrowW();
    if (R._nar && R._nar.lim === lim) return R._nar.v;
    const merged = []; R.narrowAll.filter((sp) => sp.w < lim).forEach((sp) => { const l = merged[merged.length - 1]; if (l && sp.a - l.b < 0.05) { l.b = Math.max(l.b, sp.b); l.w = Math.min(l.w, sp.w); } else merged.push({ ...sp }); });
    const long = merged.filter((x) => x.b - x.a >= NARROW_MIN_KM);
    const v = { spans: long, km: long.reduce((t, x) => t + (x.b - x.a), 0), min: long.length ? Math.min(...long.map((x) => x.w)) : null };
    R._nar = { lim, v }; return v;
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

  /* ---------------- data fetches (browser-side, cached in memory for the session) ---------------- */
  // Heights for the profile and the forecast: the router's own road heights first (Valhalla elevation_interval, Vegvesen
  // GeometryZ); otherwise the region's height service (Kartverket's 1 m terrain model in Norway), and Open-Meteo last
  async function fetchElev(routes) {
    const pts = [];
    routes.forEach((R) => R.dense.forEach((p) => { const z = R.elevAt ? R.elevAt(p.km) : null; if (z != null && Number.isFinite(z)) p.z = z; else pts.push(p); }));
    if (pts.length) await elevate(pts, [kv.region && kv.region.elevation, 'terrarium', 'valhalla', 'openmeteo']);   // Open-Meteo last: it counts every point
    routes.forEach((R) => { tunnelFlat(R); roadGrade(R.dense); });
  }
  // Vegvesen lists the tunnels with their length: inside one the road runs straight between the portals, whatever the mountain above
  function tunnelFlat(R) {
    const d = R.dense;
    (R.features.tunnels || []).filter((tn) => tn.km != null && tn.m >= 300).forEach((tn) => {
      // the location is one portal, not the middle: the tunnel runs its length on the side where the terrain rises (the mountain)
      const L = tn.m / 1000, mean = (lo, hi) => { const z = d.filter((p) => p.km >= lo && p.km <= hi && p.z != null).map((p) => p.z); return z.length ? z.reduce((x, y) => x + y, 0) / z.length : -Infinity; };
      const ahead = mean(tn.km, tn.km + L) >= mean(tn.km - L, tn.km), k0 = (ahead ? tn.km : tn.km - L) - 0.3, k1 = (ahead ? tn.km + L : tn.km) + 0.3;
      const a = [...d].reverse().find((p) => p.km <= k0 && p.z != null), b = d.find((p) => p.km >= k1 && p.z != null);
      if (!a || !b || b.km <= a.km) return;
      d.forEach((p) => { if (p.km > a.km && p.km < b.km) p.z = a.z + (b.z - a.z) * (p.km - a.km) / (b.km - a.km); });
    });
  }
  // The height lookup reads the terrain at a point, so inside a tunnel it gives the mountain above (Mælefjelltunnelen on E 134:
  // 1 367 m where the road is at 400). A road climbs at most about 12 %: each point is capped at its neighbours' height plus
  // 12 % of the distance, swept both ways. Only lowers, so valleys under bridges are untouched.
  function roadGrade(d, g = 0.12) {
    for (let i = 1; i < d.length; i++) if (d[i].z != null && d[i - 1].z != null) d[i].z = Math.min(d[i].z, d[i - 1].z + g * (d[i].km - d[i - 1].km) * 1000);
    for (let i = d.length - 2; i >= 0; i--) if (d[i].z != null && d[i + 1].z != null) d[i].z = Math.min(d[i].z, d[i + 1].z + g * (d[i + 1].km - d[i].km) * 1000);
  }

  /* Model agreement: the engine's weighted vote (js/kvcore.js). The key points are the passes and one about every 25 km;
     the doubt is worded here, with the pass name. */
  const ensPoints = (R) => keyPoints(R.samples);
  async function loadWeights(routes, tok) {   // start, end, the highest point and the middle of each route
    await Promise.all(routes.map(async (R) => { R.wAreas = await weightAreas(R.dense, R.tops); }));
    if (tok === kv.token && routes.some((R) => R.wAreas && R.wAreas.length)) render();
  }
  const ensPlace = (R, p) => (R.passName && R.passAt && Math.abs(R.passAt.km - p.km) <= 10 ? R.passName : '');
  const ensSay = (R, h) => { const pl = ensPlace(R, h.p); return t(h.share >= 0.35 ? 'kv.ens.maybe' : 'kv.ens.unlikely', { x: t('kv.ens.n.' + h.f) }) + (pl ? ' ' + t('kv.ens.at', { p: pl }) : '') + ' ' + t('kv.ens.time', { h: hm(h.p.at) }); };
  const ensWords = (R, pts, cls) => ensHints(pts, cls).map((h, k) => { const x = ensSay(R, h); return k ? x.charAt(0).toLowerCase() + x.slice(1) : x; }).join(' · ');

  /* ---------------- the weather along the road ---------------- */
  /* The via points on a route: their km in order along it (each searched after the one before, so a road that passes a via
     twice takes the first time), cached per route and via list. A via's pause (kv.via[j].pause, minutes) is spent there. */
  function viaKms(R) {
    const key = kv.via.map((v) => `${(+v.lat).toFixed(4)},${(+v.lon).toFixed(4)}`).join(';');
    if (R._vk && R._vk.key === key) return R._vk.km;
    let from = 0;
    const km = kv.via.map((v) => {
      let b = -1, bd = Infinity;
      for (let i = from; i < R.coords.length; i++) { const c = R.coords[i], d = (c[0] - v.lat) ** 2 + ((c[1] - v.lon) * Math.cos(c[0] * Math.PI / 180)) ** 2; if (d < bd) { bd = d; b = i; } }
      if (b < 0 || bd > 0.05 ** 2) return null;   // more than about 5 km from the road: not on this route
      from = b; return R.cumKm[b];
    });
    R._vk = { key, km }; return km;
  }
  const PAUSES = [0, 15, 30, 45, 60, 90, 120, 180];   // as in Turvær
  const pauseShort = (m) => (m >= 60 ? t('kv.pause.h', { h: m % 60 ? (m / 60).toFixed(1).replace('.', document.documentElement.lang === 'en' ? '.' : ',') : m / 60 }) : t('kv.pause.min', { m }));
  const pauseMs = (j) => Math.max(0, +(kv.via[j] && kv.via[j].pause) || 0) * 60e3;
  /* The weather along the road. At a via point two points are added at its km: arriving (stop) and leaving after the
     pause (leave); the clock runs through the pause, so everything after it is later. Only times change: the forecasts
     are already loaded for five days, so a pause never asks a weather service again. */
  function along(R, depMs, prof) {
    const pts = []; let eta = depMs, extra = 0, prev = depMs, si = 0;
    const stops = viaKms(R).map((km, j) => ({ km, j, ms: pauseMs(j) })).filter((x) => x.km != null).sort((a, b) => a.km - b.km);
    R.samples.forEach((s, i) => {
      if (i) { const dt = s.s - R.samples[i - 1].s, f = PACE[pts[pts.length - 1].cls] || 1; eta += dt * f * 1000; extra += dt * (f - 1); }
      while (i && si < stops.length && stops[si].km <= s.km) {   // a via between the last sample and this one
        const st = stops[si++], a = R.samples[i - 1], f = s.km > a.km ? Math.max(0, Math.min(1, (st.km - a.km) / (s.km - a.km))) : 1;
        const tA = prev + f * (eta - prev), nb = f < 0.5 ? a : s, nk = f < 0.5 ? i - 1 : i, v = kv.via[st.j];
        const base = { ...nb, km: st.km, s: a.s + f * (s.s - a.s), lat: +v.lat, lon: +v.lon, top: false, ferry: false };
        pts.push({ ...pointAt(R, prof, base, tA, nk), stop: st }, { ...pointAt(R, prof, base, tA + st.ms, nk), leave: st });
        eta += st.ms; prev = tA + st.ms;
      }
      pts.push(pointAt(R, prof, s, eta, i)); prev = eta;
    });
    return { pts, extraMin: extra / 60 };
  }
  function pointAt(R, prof, s, eta, i) {   // one point on the road at a moment: the forecast then, the road forecast, the warnings
    {
      const w0 = wxAt(s.key, eta), w = w0 || { t: NaN, mm: 0, code: 0, g: 0, day: 1, dew: NaN };   // no forecast: summarise() marks the route as missing data
      const p = { ...s, at: new Date(eta), ...w, nofc: !w0 };   // nofc: past the end of the forecast (long pauses, a late departure)
      p.cls = classify(p.code, p.mm, p.t);
      const ek = R.ensNear && R.ensNear[i], others = ek && Number.isFinite(p.t) ? ensAt(ek, eta) : [];
      if (others.length >= 2) vote(p, others, { far: eta - Date.now() >= 48 * 3600e3, pass: p.top || (p.z != null && p.z >= 900), gust: prof.gust, wAreas: R.wAreas, km: p.km });
      p.gust = p.g >= prof.gust;
      p.dark = !p.day;
      p.slick = p.t > -4 && p.t <= 3 && (p.mm >= 0.1 || (Number.isFinite(p.dew) && p.t - p.dew < 1.5 && !p.day));   // air ≤ +3 °C with precipitation, or a damp clear night
      const rf = roadAt(R, p, eta);   // Statens vegvesen's road forecast where there is one
      if (rf) { p.road = rf; if (rf.k === 'ice' || rf.k === 'snow' || rf.k === 'slush') { p.slick = true; p.slickVV = true; } else if (rf.s != null && rf.s >= 2) p.slick = false; }
      if (prof.wetRoad && !p.nofc) { p.wr = wetRoad(R, p, s.key, eta, rf, w0); if (p.wr && p.wr.unk) { p.wrUnk = true; p.wr = null; } if (p.cls === 'dry' && p.wr) p.cls = 'damp'; }   // a wet road after rain (motorcycle)
      p.drift = (p.cls === 'snow' || p.cls === 'sleet') && p.g >= 15 && p.z != null && p.z >= 600;          // drifting snow on exposed high ground
      p.alert = alertAt(p);
      return p;
    }
  }
  function summarise(R, depMs, prof) {
    const { pts, extraMin } = along(R, depMs, prof), seg = segments(pts, prof.w), x = crossings(pts);
    if (prof.cold) feelCold(pts);
    if (prof.grip) gripCold(R, pts, prof.grip);
    const mins = {};
    pts.forEach((p, i) => { if (!i || pts[i - 1].stop || pts[i - 1].nofc) return; const m = (p.at - pts[i - 1].at) / 60e3; mins[pts[i - 1].cls] = (mins[pts[i - 1].cls] || 0) + m; });   // a pause is not driving
    let sc = 0;
    pts.forEach((p, i) => { if (!i) return; const q = pts[i - 1], m = (p.at - q.at) / 60e3; if (q.ferry || q.stop || q.nofc) return;
      sc += m * (prof.w[q.cls] * (q.cls === 'damp' && q.wr.lvl === 'moist' ? prof.dampMoist : 1) + (q.gust ? prof.gustW : 0) + (q.slick ? 5 : 0) + (q.drift ? 6 : 0) + (q.dark ? prof.darkW : 0) + (q.alert ? 4 : 0)
        + (prof.cold ? (q.cold === 2 ? prof.cold.freeze : q.cold === 1 ? prof.cold.cool : 0) + (q.wetCold ? prof.cold.wet : 0) : 0)
        + (q.grip ? prof.grip.w + q.gripBend * prof.grip.bendW : 0)); });
    const valid = pts.every((p) => Number.isFinite(p.t));
    const rush = rushOn(R, pts); sc += RUSH_W * rush.length;
    // the forecast ends before the trip does (long pauses): the weather stops there, and the trip says so instead of guessing
    const cut = pts.findIndex((p) => p.nofc), beyond = cut > 0 ? { km: pts[cut].km, at: new Date(Math.min(...R.samples.map((x) => fcEnd(x.key) ?? Infinity))) } : null;   // usual weekday rush where the car passes: counts in the departure bars
    return { R, pts, seg, x, mins, extraMin, sc, valid, rush, beyond, tmin: Math.min(...pts.map((p) => p.t)), gmax: Math.max(...pts.map((p) => p.g)),
      ...(prof.cold ? coldSum(pts) : {}), ...(prof.grip ? gripSum(pts) : {}), slick: pts.filter((p) => p.slick), alerts: [...new Set(pts.filter((p) => p.alert).map((p) => p.alert))],
      end: pts[pts.length - 1].at };
  }

  /* Cold in the riding wind (motorcycle): the air as it feels at the speed you ride, by the wind chill formula of
     Environment Canada and the US National Weather Service (2001): 13.12 + 0.6215 T - 11.37 V^0.16 + 0.3965 T V^0.16, T the
     air in °C, V the wind in km/h, here the speed on the stretch (the route's own driving time; the weather's wind is not
     added). The formula is defined for air at +10 °C or colder and wind over 4.8 km/h, so it is only worked out there; above
     that nothing is said. At 80 km/h, +6 °C feels like -1 °C and +10 °C like +4 °C. On each point (the stretch to the next):
     v (km/h), feel (°C | null), cold (0, 1 under +5 °C felt, 2 under 0 °C), wetCold (rain falling, air under +8 °C). */
  const degS = (v) => String(Math.round(v) || 0).replace('-', '−');   // whole degrees with a real minus sign (and no −0)
  const windChill = (tc, v) => (Number.isFinite(tc) && tc <= 10 && v >= 4.8 ? 13.12 + 0.6215 * tc - 11.37 * v ** 0.16 + 0.3965 * tc * v ** 0.16 : null);
  function feelCold(pts) {
    let v = 0;
    pts.forEach((q, i) => {
      const p = pts[i + 1];
      if (p && !q.stop && !q.ferry && p.s > q.s) v = (p.km - q.km) / ((p.s - q.s) / 3600);   // a stop, a ferry or the last point: the speed before
      q.v = q.ferry || q.stop ? 0 : v; q.feel = q.nofc ? null : windChill(q.t, q.v);
      q.cold = q.feel == null ? 0 : q.feel < 0 ? 2 : q.feel < 5 ? 1 : 0;
      q.wetCold = !q.nofc && (q.cls === 'wet' || q.cls === 'heavy' || q.cls === 'thunder') && q.t < 8;
    });
  }
  function coldSum(pts) {   // driving minutes felt under +5 °C and in cold rain, and the coldest felt (with its speed)
    let coldMin = 0, wetColdMin = 0, feelMin = null;
    pts.forEach((p, i) => {
      if (p.feel != null && (!feelMin || p.feel < feelMin.feel)) feelMin = p;
      if (!i) return; const q = pts[i - 1], m = (p.at - q.at) / 60e3; if (q.ferry || q.stop || q.nofc) return;
      if (q.cold) coldMin += m; if (q.wetCold) wetColdMin += m;
    });
    return { coldMin, wetColdMin, feelMin };
  }

  /* Low grip (motorcycle): under +5 °C tyres and asphalt grip less, most of all in bends; this is about the road, not how
     cold the rider is (feelCold). A point (the stretch to the next) is "grip" when the air is under +5 °C, or the road
     surface is where a road authority gives its temperature (roadAt: Statens vegvesen's forecast, Fintraffic, Trafikverket);
     gripBend is the share of the stretch on bendy road (bendShare). */
  function gripCold(R, pts, g) {
    pts.forEach((q, i) => {
      const p = pts[i + 1], rs = q.road && Number.isFinite(q.road.s) ? q.road.s : null;
      q.grip = !q.nofc && !q.ferry && ((Number.isFinite(q.t) && q.t < g.t) || (rs != null && rs < g.t));
      q.gripRoad = q.grip && rs != null && rs < g.t;
      q.gripBend = q.grip && p ? bendShare(R, q.km, p.km, g.bend) : 0;
    });
  }
  function gripSum(pts) {   // driving minutes under +5 °C, and of those on bendy road; whether a road temperature said so
    let gripMin = 0, gripBendMin = 0, gripRoad = false;
    pts.forEach((p, i) => {
      if (!i) return; const q = pts[i - 1], m = (p.at - q.at) / 60e3; if (q.ferry || q.stop || q.nofc || !q.grip) return;
      gripMin += m; gripBendMin += m * q.gripBend; gripRoad = gripRoad || q.gripRoad;
    });
    return { gripMin, gripBendMin, gripRoad };
  }

  /* ---------------- rush hours: Statens vegvesen's traffic counts (Trafikkdata, NLOD), built by tools/traffic/counts.py ----------------
     data/traffic/counts.json holds, per counting point on E- and R-roads and per direction, the usual weekday rush hours
     (busiest hours with a commuter signature). A route matches a point within 80 m whose direction has a bearing within
     50 degrees of the route's; the car is "in the rush" when it passes on a weekday in one of those hours (Oslo time).
     Counts are demand, not speed: the wording says "usually rush hour", never minutes. */
  const RUSH_W = 12;   // per rush area in the departure score: about 12 minutes of rain for a car
  let rushData = null;
  const loadRush = () => (rushData ||= fetchT('data/traffic/counts.json?v=' + encodeURIComponent((document.querySelector('script[src*="js/route.js"]') || {}).src?.split('v=')[1] || '')).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const rushFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', hour: '2-digit', hour12: false });
  function bearingAtKm(R, km) {
    let i = R.cumKm.findIndex((k) => k >= km); if (i < 0) i = R.coords.length - 1;
    let a = i, b = i; while (a > 0 && R.cumKm[i] - R.cumKm[a] < 0.15) a--; while (b < R.coords.length - 1 && R.cumKm[b] - R.cumKm[i] < 0.15) b++;
    const p = R.coords[a], q = R.coords[b], cs = Math.cos(p[0] * Math.PI / 180);
    return (Math.atan2((q[1] - p[1]) * cs, q[0] - p[0]) * 180 / Math.PI + 360) % 360;
  }
  const rushName = (n) => String(n || '').replace(/^(?:E|Rv\.?|Fv\.?)\s?\d+\s+/i, '').replace(/\s+(nord|sør|syd|øst|vest)(gående)?(\s.*)?$/i, '').trim();   // 'Alnabru sydgående Furuset Helsfyr' is Alnabru
  function matchRush(R, data) {
    const near = routeNear(R, 80); R.rush = [];
    (data && data.pts || []).forEach(([, name, la, lo, road, dirs]) => {
      if (/rampe|sykkel|gang/i.test(name)) return;   // ramps and cycle counters say little about the main road
      const km = near(la, lo); if (km == null) return;
      const rb = bearingAtKm(R, km), d = dirs.find((x) => x[1] != null && Math.abs(((x[1] - rb + 540) % 360) - 180) <= 50);
      if (d && d[4].length) R.rush.push({ km, name: rushName(name), full: name, road, hours: d[4], wd: d[2], we: d[3], pos: [la, lo] });
    });
    R.rush.sort((p, q) => p.km - q.km);
  }
  function rushOn(R, pts) {   // the rush areas the car passes in their rush hour; points within 15 km are one area
    const out = [];
    (R.rush || []).forEach((m) => {
      const i = pts.findIndex((p) => p.km >= m.km); if (i < 0) return;
      const a = pts[Math.max(0, i - 1)], b = pts[i], f = (m.km - a.km) / Math.max(1e-6, b.km - a.km), at = new Date(+a.at + f * (b.at - a.at));
      const pr = Object.fromEntries(rushFmt.formatToParts(at).map((x) => [x.type, x.value]));
      if (pr.weekday === 'Sat' || pr.weekday === 'Sun' || !m.hours.includes(+pr.hour % 24)) return;
      const last = out[out.length - 1];
      const lp = last && last.pts[last.pts.length - 1];
      if (lp && m.km - lp.km < 2) { if (Math.max(...m.wd) > Math.max(...lp.wd)) { last.pts[last.pts.length - 1] = { ...m, at }; if (last.pts.length === 1) Object.assign(last, { km0: m.km, at, name: m.name, road: m.road, pos: m.pos }); } last.km1 = Math.max(last.km1, m.km); }
      else if (last && m.km - last.km1 < 15) { last.km1 = m.km; last.pts.push({ ...m, at }); } else out.push({ km0: m.km, km1: m.km, at, name: m.name, road: m.road, pos: m.pos, pts: [{ ...m, at }] });
    });
    return out;
  }

  /* ---------------- state ---------------- */
  const kv = {
    from: null, to: null, via: [], veh: lsGet('glett.kv.veh') === 'mc' ? 'mc' : 'car', dep: null,
    routes: [], sel: 0, region: null, source: '', busy: false, token: 0, probe: 0, rawSig: '', map: null, layers: [], cur: null, started: false,
    opts: Object.assign({ noFerry: false, noDark: false, curvy: false, noGravel: false, noNarrow: false, narrowW: 4 }, lsJson('glett.kv.opts', {})),
    narrowSkip: false,   // "Vis raskeste rute": this plan without avoiding narrow roads (until the trip or the options change)
  };
  // the profile with the visitor's choices applied: "avoid driving in the dark" makes every dark minute count heavily
  const prof = () => { const b = KV_PROFILES[kv.veh]; return kv.opts.noDark ? { ...b, darkW: 25 } : b; };
  const curvyOn = () => !!kv.opts.curvy;
  const MAX_VIA = 8;   // via stops: Statens vegvesen's route planner takes up to 8 (api/route.php), Valhalla more
  const routeKey = () => [kv.from, ...kv.via, kv.to].map((p) => `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}`).join(';');
  const depOptions = () => KVCore.depOptions(MAX_AHEAD_H);   // whole hours up to four days ahead, now first

  /* ---------------- main flow ---------------- */
  // the routes as a signature: the same roads (and closures) for another start need nothing fetched again
  // (length, the order of road numbers, closures: the line and the steps can come back split differently for the same roads)
  const routeSig = (routes) => routes.map((R) => `${R.km.toFixed(1)}|${R.steps.map((x) => x.ref || '').filter((r, i, a) => r && r !== a[i - 1]).join(',')}|${R.obstructed ? 1 : 0}`).join(';');
  /* want: the route to show first (a new plan for a changed departure keeps the one chosen). quiet: a new start time with
     Statens vegvesen (its answer can depend on the time: closures); the routes are asked in the background while the result
     stays, and when they are the same roads nothing more is done: the weather for every start is loaded already */
  async function plan(want = 0, quiet = false) {
    if (!kv.from || !kv.to) { status(t('kv.err.ab'), 'err', 'kv.err.ab'); return; }
    const reg = regionOf(kv.from), reg2 = regionOf(kv.to);
    if (!reg || !reg2 || reg !== reg2 || kv.via.some((v) => regionOf(v) !== reg)) { status(t('kv.err.region'), 'err', 'kv.err.region'); return; }
    if (hav([+kv.from.lat, +kv.from.lon], [+kv.to.lat, +kv.to.lon]) < 1) { status(t('kv.err.same'), 'err', 'kv.err.same'); return; }
    kv.region = reg;
    let tok = quiet ? kv.token : ++kv.token; const probe = ++kv.probe;
    const stop = () => tok !== kv.token;   // cancelled or overtaken: no more weather is asked for
    if (!quiet) { kv.busy = true; $('kvGo').classList.add('busy'); workOpen(); status(t('kv.loading.route'), 'busy', 'kv.loading.route'); $('kvResult').hidden = true; }
    await loadBorders();
    const req = { from: kv.from, to: kv.to, via: kv.via, depart: kv.dep || new Date(), profile: prof(), opts: { noFerry: kv.opts.noFerry, curvy: curvyOn(), noGravel: kv.opts.noGravel } };
    let routes = null, used = '', sel = 0, ens = null;
    for (const id of reg.routers) {
      const r = KV_ROUTERS[id];
      if ((req.opts.curvy && !r.can.curvy) || (req.opts.noFerry && !r.can.noFerry) || (req.opts.noGravel && !r.can.noGravel)) continue;   // a router that cannot do what was asked is skipped
      try { if (await r.available()) { routes = await r.route(req); used = id; if (routes.length) break; } } catch (e) { console.warn('Kjørevær router', id, e); routes = null; }
    }
    if (tok !== kv.token || probe !== kv.probe) return;
    if (quiet) {
      if (!routes || !routes.length || (kv.routes.length && used === kv.source && routeSig(routes) === kv.rawSig)) { kv.routedAt = +req.depart; return; }   // the same roads, or no answer: the result stands
      tok = ++kv.token; kv.busy = true; status(t('kv.loading.wx'), 'busy', 'kv.loading.wx');   // other roads at that time: calculated again, the old result shown meanwhile
    }
    $('kvGo').classList.remove('busy');
    if (!routes || !routes.length) { kv.busy = false; status(t('kv.err.route'), 'err', 'kv.err.route'); return; }
    kv.routedAt = +req.depart; kv.rawSig = routeSig(routes);
    kv.ensWait = false;
    kv.source = used; kv.narrow = null;
    if (kv.opts.noNarrow && reg.roads && KV_ROUTERS[used].can.narrow) {   // "Smale veier": route again round the narrow stretches, or (overridden) only measure them
      try { const r = kv.narrowSkip ? await measureNarrow(routes) : await avoidNarrow(routes.slice(0, 3), req, used, tok); if (tok !== kv.token) return; routes = r.routes; kv.narrow = r.info; }
      catch (e) { console.warn('Kjørevær narrow roads', e); }
    }
    try {
      status(t('kv.loading.wx'), 'busy', 'kv.loading.wx');
      routes = routes.slice(0, 3); if (working()) workFound(routes);
      for (const R of routes) { R.dense = densify(R); R.bend = bendiness(R); R.bendP = bendProfile(R); markCountries(R); }
      await fetchElev(routes);
      await loadAlerts();
      routes.forEach((R) => {
        R.tops = passTops(R.dense);
        R.samples = pickSamples(R.dense, R.tops).map((i) => ({ ...R.dense[i], di: i, key: cellKey(R.dense[i]), top: R.tops.includes(i) }));
      });
      routes.forEach((R) => {   // each sample's nearest key point within 12 km along the route
        R.ensNear = nearKey(R.samples, ensPoints(R));
      });
      // the chosen route's weather first: the page shows it as soon as it is in. The other routes and the four other models
      // (Open-Meteo, the visitor's own quota) come after; until then their cards wait and the best departure is not suggested
      sel = Math.min(want, routes.length - 1);
      kv.ensWait = true; kv.ensFail = false;
      ens = fetchEnsemble(routes.flatMap(ensPoints), stop).then(() => true, (e) => { console.warn('Kjørevær models', e); return false; });
      ens.then((ok) => { if (tok !== kv.token) return; kv.ensWait = false; kv.ensFail = !ok; if (kv.routes === routes) render(); });
      const prog = (d, n) => { if (tok !== kv.token) return; if (working()) workProg(d, n); else if (n >= 20) status(t('kv.loading.wxn', { d, n }), 'busy', 'kv.loading.wx'); };
      kv.omMain = false;   // set when MET could not give the chosen route and Open-Meteo has to: then its wait holds the page
      await fetchForecast(routes[sel].samples, undefined, { met: true, progress: prog, om: () => { kv.omMain = true; }, stop });
      routes.forEach((R, i) => { R.wxWait = i !== sel; });
    } catch (e) { if (tok === kv.token) { kv.busy = false; kv.ensWait = false; $('kvGo').classList.remove('busy'); status(e.message || t('kv.err.wx'), 'err'); } return; }
    if (tok !== kv.token) return;
    nameRoutes(routes);
    kv.routes = routes; kv.sel = sel; kv.busy = false; kv.dirty = false;
    $('view-route').classList.remove('kv-isstale', 'kv-noroute'); showMap();   // the map was hidden before the first route: size it
    status('', ''); $('kvResult').hidden = false;
    saveLast(); writeHash();
    render();
    if (camOn()) camsShow();
    namePasses(routes, tok);
    enrichRoads(routes, kv.region).then(() => { if (tok === kv.token) render(); }).catch((e) => console.warn('Kjørevær road data', e));
    liveRoads(routes, kv.region, tok).catch((e) => console.warn('Kjørevær road reports', e));
    loadSights(routes, kv.region, tok).catch((e) => console.warn('Kjørevær sights', e));
    loadRest(routes, kv.region, tok);
    loadRush().then((d) => { if (d && tok === kv.token) { routes.forEach((R) => matchRush(R, d)); render(); } });
    loadWeights(routes, tok).catch((e) => console.warn('Kjørevær model weights', e));
    const rest = routes.filter((R) => R.wxWait);
    if (rest.length) fetchForecast(rest.flatMap((R) => R.samples), undefined, { met: true, stop }).catch((e) => console.warn('Kjørevær other routes', e))
      .finally(() => { rest.forEach((R) => { R.wxWait = false; }); if (tok === kv.token) render(); });
  }
  /* "Smale veier: bare bredere enn …": neither route planner knows road widths, but both can be told to keep off given
     points. So: route, look up the widths along the routes in NVDB, put a point in the middle of each narrow stretch (on the
     route line, 150 m or more from its ends, so it never snaps to a side road), route again, and repeat while new narrow
     stretches appear (tested: Oslo–Trondheim and 13 other trips need no extra call at 4 m; Voss–Odda at 5 m one). When no
     way round exists (the destination on a narrow road), the attempt with the least narrow road is kept and the card says so;
     "Vis raskeste rute" plans once more without avoiding, and the stage list shows the narrow stretches to fly to. */
  const coordAt = (R, km) => { let i = R.cumKm.findIndex((k) => k >= km); if (i <= 0) return R.coords[Math.max(0, i)]; const f = (km - R.cumKm[i - 1]) / Math.max(1e-9, R.cumKm[i] - R.cumKm[i - 1]); return [R.coords[i - 1][0] + f * (R.coords[i][0] - R.coords[i - 1][0]), R.coords[i - 1][1] + f * (R.coords[i][1] - R.coords[i - 1][1])]; };
  async function measureNarrow(routes) {
    await enrichRoads(routes, kv.region); const n = narrowOf(routes[0]) || { km: 0 };
    return { routes, info: { lim: narrowW(), skipped: true, km: n.km, fastKm: n.km, gap: routes.some((R) => R.widthGap) } };
  }
  async function avoidNarrow(routes0, req, used, tok) {
    const lim = narrowW(), cap = KV_ROUTERS[used].maxAvoid || 50;
    await enrichRoads(routes0, kv.region);
    const kmOf = (R) => (narrowOf(R) || { km: 0 }).km, km0 = kmOf(routes0[0]);
    // a stretch with a stop on it (a cabin at the end of a narrow road) cannot be avoided: no point there, or every route is blocked
    const stops = [req.from, ...req.via, req.to].map((p) => [+p.lat, +p.lon]);
    const idx = new Map(), atOf = (R) => { if (!idx.has(R)) idx.set(R, routeIndex(R)); return idx.get(R); };
    const atStop = (R, sp) => stops.some((q) => { const at = atOf(R)(q[0], q[1]); return (at != null && at >= sp.a - 0.3 && at <= sp.b + 0.3) || (sp.a < 0.3 && hav(q, R.coords[0]) < 0.5) || (sp.b > R.km - 0.3 && hav(q, R.coords[R.coords.length - 1]) < 0.5); });
    // a first route that had to use gravel: the rounds may too (else every round fails)
    const rq = { ...req, opts: { ...req.opts, noGravel: req.opts.noGravel && !routes0[0].gravelForced } };
    let best = routes0, bestKm = km0, cur = routes0, avoid = [], rounds = 0, blocked = false, error = false;
    while (bestKm > 0 && rounds < 5 && tok === kv.token) {
      const add = [];
      cur.forEach((R) => ((narrowOf(R) || {}).spans || []).forEach((sp) => {
        if (atStop(R, sp)) return;
        const p = coordAt(R, (sp.a + sp.b) / 2);
        if (![...avoid, ...add].some((q) => hav(q, p) < 0.05)) add.push(p);
      }));
      if (!add.length || avoid.length >= cap) break;
      avoid = avoid.concat(add).slice(0, cap); rounds++;
      status(t('kv.loading.narrow'), 'busy', 'kv.loading.narrow');
      let next = null; try { next = await KV_ROUTERS[used].route({ ...rq, avoid }); } catch (e) { console.warn('Kjørevær narrow roads', e); error = true; break; }
      if (!next || !next.length) { blocked = true; break; }
      cur = next.slice(0, 3); await enrichRoads(cur, kv.region);
      if (kmOf(cur[0]) < bestKm - 1e-6) { best = cur; bestKm = kmOf(cur[0]); }
    }
    if (bestKm <= 0) best = best.filter((R, i) => !i || kmOf(R) <= 0);   // the alternatives too keep off narrow roads (no extra call: one using them is left out)
    return { routes: best, info: { lim, km0, km: bestKm, rounds, avoided: best[0] !== routes0[0], blocked, error, gap: best.some((R) => R.widthGap), fastSec: routes0[0].sec, fastKm: km0 } };
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
  // Open-Meteo's minute is full (js/omgate.js): the plan waits instead of failing, and says how long
  let omTick = null, omPrev = null;
  window.addEventListener('glett:omwait', (e) => {
    clearInterval(omTick);
    if (kv.ensWait && (!kv.busy || !kv.omMain)) {   // only the model comparison waits (the route is shown, or comes from MET): the line under the departure bars counts down
      const say = () => { const el = document.querySelector('#kvDepHint .kv-best.wait span:last-child'), left = Math.ceil(((e.detail.until || 0) - Date.now()) / 1000);
        if (el) el.textContent = left > 0 ? t('kv.dep.ensq', { s: left }) : t('kv.dep.ens'); return left > 0 && kv.ensWait; };
      if (say()) omTick = setInterval(() => { if (!say()) clearInterval(omTick); }, 1000);
      return;
    }
    if (!kv.busy || !e.detail.until) { if (omPrev && kv.st && kv.st.key === 'om.wait') status(t(omPrev.key), omPrev.kind, omPrev.key); omPrev = null; return; }
    if (!omPrev && kv.st && kv.st.key !== 'om.wait') omPrev = kv.st;
    const show = () => status(t('om.wait', { s: Math.max(1, Math.ceil((e.detail.until - Date.now()) / 1000)) }), 'busy', 'om.wait');
    show(); omTick = setInterval(() => { if (!kv.busy || Date.now() > e.detail.until + 2000) { clearInterval(omTick); return; } show(); }, 1000);
  });
  /* While a new search loads (not a quiet one for a new start time) the planner lies blurred under a card: the trip, the
     two steps (routes, then the weather with how many places are in), Open-Meteo's wait if any, and Avbryt. It goes when the
     chosen route is shown: the other routes and the four other models keep their own small waits on the result */
  const working = () => !$('kvWork').hidden;
  function workOpen() {
    const nm = (p) => String((p && p.name) || '').split(',')[0].trim(), d = kv.dep;
    $('kvWorkTrip').textContent = [kv.from, ...kv.via, kv.to].map(nm).join(' → ');
    $('kvWorkWhen').textContent = t('kv.veh.' + kv.veh) + ' · ' + (d ? `${wday(d)} ${t('kv.dep.at')} ${hm(d)}` : t('kv.now'));
    $('kvWork').querySelectorAll('li').forEach((li) => { li.className = ''; li.querySelector('span').textContent = t('kv.work.' + li.dataset.step); });
    ['kvWorkSum', 'kvWorkBar', 'kvWorkNote'].forEach((id) => { $(id).hidden = true; });
    $('kvWork').hidden = false; $('view-route').classList.add('kv-working');
    $('kvStop').focus({ preventScroll: true });
  }
  function workClose() { if (!working()) return; $('kvWork').hidden = true; $('view-route').classList.remove('kv-working'); }
  function workSay(key, msg) {   // a busy status while the card is up: which step, or the wait under it
    const step = key === 'kv.loading.route' || key === 'kv.loading.narrow' ? 'route' : key === 'kv.loading.wx' ? 'wx' : '';
    if (step) $('kvWork').querySelectorAll('li').forEach((li) => {
      const s = li.dataset.step, on = s === step, done = s === 'route' && step === 'wx';
      li.className = on ? 'on' : done ? 'done' : '';
      li.querySelector('span').textContent = on ? msg.replace(/…$/, '') : t('kv.work.' + s);
    });
    const note = $('kvWorkNote'); note.hidden = key !== 'om.wait'; if (!note.hidden) note.textContent = msg;
  }
  function workFound(routes) {
    const R = routes.reduce((a, b) => (b.sec < a.sec ? b : a)), v = { n: routes.length, km: Math.round(R.km), d: dur(R.sec / 60) };
    $('kvWorkSum').textContent = t(routes.length > 1 ? 'kv.work.found' : 'kv.work.found1', v); $('kvWorkSum').hidden = false;
  }
  function workProg(d, n) {
    const bar = $('kvWorkBar'); bar.hidden = false;
    bar.querySelector('i').style.width = Math.round(100 * d / Math.max(1, n)) + '%';
    bar.querySelector('small').textContent = t('kv.work.n', { d, n });
  }
  function stopPlan() {   // Avbryt: the search is dropped (nothing more is fetched for it) and the page is as before it
    if (!kv.busy) return;
    kv.token++; kv.probe++; kv.busy = false; kv.ensWait = false;
    $('kvGo').classList.remove('busy'); workClose();
    if (kv.routes.length) $('kvResult').hidden = false;   // the earlier result, still marked as not matching the form
    status(t('kv.work.stopped'), 'info', 'kv.work.stopped');
    $('kvGo').focus({ preventScroll: true });
  }
  function status(msg, kind, key) {   // key: the text key, so a language change can redraw it
    kv.st = msg ? { key, kind, msg } : null;
    if (kind === 'busy' && working()) workSay(key, msg); else if (kind !== 'busy') workClose();
    const el = $('kvStatus'); el.hidden = !msg || (kind === 'busy' && working()); el.className = 'kv-status ' + (kind || '');
    el.innerHTML = kind === 'busy' ? `<span class="spinner"></span> ${esc(msg)}` : esc(msg);
  }
  function choose(i) {   // a route picked on a card or the map; one still waiting for its weather cannot be
    const R = kv.routes[i]; if (!R || R.wxWait) return;
    kv.sel = i; render();
  }
  function render() {
    if (!kv.routes.length) return;
    const P = prof(), dep = kv.dep || new Date();
    if (P.wetRoad) loadRain(kv.token);   // the rain in the last hours (asked once an hour; a render again when it comes)
    const S = kv.routes.map((R) => summarise(R, +dep, P));
    S.forEach((s) => { s.live = liveOn(s); });
    kv.S = S;
    renderDeps(); renderNarrow(); renderCards(S); renderChart(S[kv.sel]); renderMap(S); renderIt(S[kv.sel]); fullLabel();
    if (PHONE && PHONE.on) PHONE.refresh();
    if (window.GlettUI) GlettUI.render('kv', S, kv.sel);   // the prototype layout (?ui=kart)
    $('kvSource').innerHTML = t('kv.source.' + kv.source) + (kv.region && kv.region.live ? ' ' + t('kv.source.live') + liveAbroad(kv.routes).map((c) => ' ' + t('kv.source.live.' + c)).join('') : '') + (kv.region && kv.region.sights && sightsOn() ? ' ' + t('kv.source.sights') : '') + (kv.region && kv.region.rest && showRest() ? ' ' + t('kv.source.rest') : '') + ' ' + t('kv.source.ens') + (P.wetRoad ? ' ' + t('kv.source.rain') : '');
  }
  function verdicts(S) {
    const ok = S.map((s) => s.valid && !blocked(s) && !s.R.russia);
    if (S.some((s) => s.R.wxWait)) return { best: null, fastest: S.reduce((b, s, i) => (s.R.sec < S[b].R.sec ? i : b), 0), ok, tie: false, wait: true };
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
    if (s.beyond) b.push(['warn', t('kv.b.beyond', { k: Math.round(s.R.km - s.beyond.km) })]);
    const live = shownLive(s).filter((e) => e.on).sort((x, y) => (y.veto - x.veto) || ((y.it.k === 'closed') - (x.it.k === 'closed')));
    const serious = live.filter((e) => !/^(works|limit)$/.test(e.it.k)), works = live.filter((e) => e.it.k === 'works');
    serious.slice(0, 2).forEach((e) => b.push(liveBadge(e)));
    if (serious.length > 2) b.push(['warn', t('kv.b.dmore', { n: serious.length - 2 })]);
    if (works.length) b.push(['warn', works.length === 1 ? t('kv.b.dworks1', { p: placeOf(works[0].it) }) : t('kv.b.dworks', { n: works.length })]);   // roadworks: one badge
    tvgFor(s).slice(0, 1).forEach((r) => b.push(['tvg', t('kv.b.tvg', { n: r.n })]));
    const abroad = [...(s.R.countries || [])].filter((c) => c !== 'RU');
    if (abroad.length) b.push(['', t('kv.b.abroad', { c: abroad.map((c) => t('kv.cn.' + c)).join(', ') })]);
    const eh = s.slick.length ? null : ensHints(s.pts, s.pts.reduce((m, p) => (P.w[p.cls] > P.w[m] ? p.cls : m), 'dry')).find((h) => h.f === 'snow' || h.f === 'sleet' || h.f === 'ice');
    if (eh) b.push(['warn', '❄ ' + ensSay(s.R, eh)]);   // snow or freezing rain worth knowing, unless "mulig glatt" is on the card
    const vv = s.slick.find((p) => p.slickVV);   // Vegvesen's road forecast says slippery, snow or slush: always shown
    if (vv) b.push(['ice', t(vv.road.cc === 'no' ? 'kv.b.vvslick' : 'kv.b.vvslick.' + vv.road.cc, { c: t('kv.rcb.' + vv.road.k), p: vv.road.n.replace(/^(E|Rv|Fv|Kv)\s?\d+\s*/, '') || vv.road.n, h: hm(vv.at) })]);
    if (s.x.length) { const p = s.pts[s.x[0].i]; b.push(['ice', t(s.x[0].dir === 'down' ? 'kv.b.minus' : 'kv.b.plus', { km: Math.round(p.km), h: hm(p.at) })]); }
    else if (s.slick.length && !vv) b.push(['ice', t('kv.b.slick', { h: hm(s.slick[0].at) })]);
    s.alerts.slice(0, 1).forEach((a) => b.push(['warn', '⚠ ' + a]));
    KV_CLS.filter((c) => c !== 'dry' && (s.mins[c] || 0) >= 5).sort((a, c) => P.w[c] - P.w[a]).forEach((c) => b.push([c === 'ice' ? 'ice' : '', t('kv.c.' + c) + ' ' + dur(s.mins[c]), c === 'damp' ? wrSources(s.pts) : '']));
    if (s.pts.some((p) => p.drift)) b.push(['warn', t('kv.b.drift')]);
    if (s.gmax >= P.gust) b.push(['warn', t('kv.b.gust', { g: Math.round(s.gmax) })]);
    // MC (prof.cold): the lowest with how it feels in the riding wind, and the time felt under +5 °C and in cold rain
    const fl = s.feelMin && s.feelMin.feel < s.tmin - 0.5;
    if (Number.isFinite(s.tmin)) b.push(['', t('kv.b.tmin', { t: Math.round(s.tmin) }) + (fl ? ' ' + t('kv.b.feel', { f: degS(s.feelMin.feel) }) : ''), fl ? t('kv.cold.help') : '']);
    if (s.coldMin >= 10 || s.wetColdMin >= 10) b.push(['', [s.coldMin >= 10 ? t('kv.b.cold', { d: dur(s.coldMin) }) : '',
      s.wetColdMin >= 10 ? t(s.coldMin >= 10 ? 'kv.b.wetcold.and' : 'kv.b.wetcold', { d: dur(s.wetColdMin) }) : ''].join(''), t('kv.cold.help')]);
    // MC (prof.grip): the time under +5 °C, where tyres and asphalt grip less, and how much of it is in bends
    if (s.gripMin >= 10) b.push(['warn', t('kv.b.grip', { d: dur(s.gripMin) }) + (s.gripBendMin >= 5 ? t('kv.b.grip.bend', { d: dur(s.gripBendMin) }) : ''), t(s.gripRoad ? 'kv.grip.help.road' : 'kv.grip.help')]);
    const darkMin = s.pts.reduce((m, p, i) => (i && s.pts[i - 1].dark && !s.pts[i - 1].stop ? m + (p.at - s.pts[i - 1].at) / 60e3 : m), 0);
    if (kv.opts.noDark && darkMin >= 5) b.push(['warn', t('kv.b.darkwarn', { d: dur(darkMin) })]);
    else if (darkMin >= 15) b.push(['', t('kv.b.dark', { d: dur(darkMin) })]);
    if (curvyOn() && s.R.bend) b.push(['bend', t('kv.bend.' + bendLevel(s.R.bend), { n: Math.round(s.R.bend) })]);
    const nw = showNarrow() && narrowOf(s.R); if (nw && nw.km > 0) b.push(['warn', t('kv.b.narrow', { km: mtr(+nw.km.toFixed(nw.km < 10 ? 1 : 0)), w: mtr(+nw.min.toFixed(1)) })]);
    if (s.R.gravelForced) b.push(['warn', t('kv.b.gravel')]);
    if (s.extraMin >= 5) b.push(['', t('kv.b.slow', { m: Math.round(s.extraMin) })]);
    if (s.rush && s.rush.length) b.push(['warn', t(s.rush.length > 2 ? 'kv.b.rushn' : s.rush.length === 2 ? 'kv.b.rush1' : 'kv.b.rush', { p: s.rush[0].name, h: hm(s.rush[0].at), n: s.rush.length - 1 })]);
    if (!blocked(s) && !live.length && !s.x.length && !s.slick.length && !s.alerts.length && KV_CLS.every((c) => c === 'dry' || (s.mins[c] || 0) < 5)) b.unshift(['', t('kv.b.dry')]);
    return b;
  }
  function why(s, S, v, i) {
    if (!s.valid) return s.beyond ? t('kv.why.beyond', { h: wday(s.beyond.at) + ' ' + hm(s.beyond.at), k: Math.round(s.R.km - s.beyond.km) }) : t('kv.why.nodata');
    if (s.R.obstructed) return t('kv.why.closed');
    if (blocked(s)) return t('kv.why.dclosed');
    if (v.tie) return t('kv.why.tie');
    if (i === v.best) {
      const dt = Math.round((s.R.sec - S[v.fastest].R.sec) / 60);
      return dt > 2 ? t('kv.why.best_slower', { m: dt }) : t('kv.why.best');
    }
    const worst = KV_CLS.filter((c) => c !== 'dry' && s.mins[c] >= 5).sort((a, b) => prof().w[b] * s.mins[b] - prof().w[a] * s.mins[a])[0];
    return worst ? t('kv.why.worse', { c: t('kv.c.' + worst).toLowerCase(), d: dur(s.mins[worst]) }) + (s.x.length ? ' ' + t('kv.why.freeze') : '') : t('kv.why.other');
  }
  function routeTitle(R) { return (R.via ? t('kv.via', { r: R.via + (R.viaCountry ? ' (' + t('kv.cn.' + R.viaCountry) + ')' : '') }) : t('kv.route')) + (R.passName ? ' · ' + R.passName : ''); }
  // "Smale veier": what avoiding cost, or why it could not, with the way back to the fastest route (and from it)
  function renderNarrow() {
    const el = $('kvNarrowNote'), n = kv.narrow; let h = '';
    if (n && kv.opts.noNarrow) {
      const w = mtr(n.lim), km = (v) => mtr(+v.toFixed(v < 10 ? 1 : 0)), R = kv.routes[0];
      const btn = (k) => `<button type="button" class="kv-chip small" data-nar="${k}">${esc(t(k === 'fast' ? 'kv.nar.fast' : 'kv.nar.avoid'))}</button>`;
      if (n.skipped) { if (n.km > 0) h = `${esc(t('kv.nar.forced', { km: km(n.km), w }))} ${btn('avoid')}`; }
      else if (n.km <= 0 && n.avoided) { const d = R ? (R.sec - n.fastSec) / 60 : 0; h = `✓ ${esc(t(d >= 1 ? 'kv.nar.avoided' : 'kv.nar.avoided0', { km: km(n.km0), w, d: dur(d) }))} ${btn('fast')}`; }
      else if (n.km > 0) h = `⚠ ${esc(t(n.error ? 'kv.nar.err' : n.avoided ? 'kv.nar.partial' : 'kv.nar.none', { km: km(n.km), w }))}${n.avoided ? ' ' + btn('fast') : ''}`;
      if (n.gap) h += `${h ? ' ' : ''}<small class="kv-nargap">${esc(t('kv.nar.gap'))}</small>`;
    }
    el.innerHTML = h; el.hidden = !h;
  }
  function renderCards(S) {
    const v = verdicts(S), el = $('kvCards');
    el.innerHTML = S.map((s, i) => {
      if (s.R.wxWait) return `<button type="button" class="card kv-rc wait" data-i="${i}" aria-disabled="true">
        <span class="kv-rc-top"><b>${esc(routeTitle(s.R))}</b><span class="kv-verdict"><span class="spinner small"></span> ${t('kv.v.wait')}</span></span>
        <span class="kv-rc-meta">${dur(s.R.sec / 60)} · ${Math.round(s.R.km)} km</span><span class="kv-mini"></span></button>`;
      const total = s.pts[s.pts.length - 1].km || 1;
      const mini = s.seg.map((g) => `<i class="kvc-${g.cls}" style="width:${((s.pts[Math.min(g.b + 1, s.pts.length - 1)].km - s.pts[g.a].km) / total * 100).toFixed(2)}%"></i>`).join('');
      const bendiest = curvyOn() && S.length > 1 && S.every((x, k) => k === i || x.R.bend <= s.R.bend);
      const tag = !v.ok[i] ? `<span class="kv-verdict bad">${t(blocked(s) ? 'kv.v.closed' : 'kv.v.nodata')}</span>` : i === v.best ? `<span class="kv-verdict best">${t('kv.v.best')}</span>` : i === v.fastest ? `<span class="kv-verdict ok">${t('kv.v.fastest')}</span>` : bendiest ? `<span class="kv-verdict ok">${t('kv.v.bendy')}</span>` : '';
      const zmax = Math.max(...s.R.dense.map((p) => p.z ?? 0));
      return `<button type="button" class="card kv-rc${i === kv.sel ? ' sel' : ''}" data-i="${i}" aria-pressed="${i === kv.sel}">
        <span class="kv-rc-top"><b>${esc(routeTitle(s.R))}</b>${tag}</span>
        <span class="kv-rc-meta">${dur(s.R.sec / 60)}${(() => { const m = s.pts.reduce((a, p) => a + (p.stop ? p.stop.ms / 60e3 : 0), 0); return m ? ' ' + esc(t('kv.pause.incl', { d: pauseShort(m) })) : ''; })()} · ${Math.round(s.R.km)} km · ${t('kv.highest', { z: Math.round(zmax) })} · ${t('kv.arrive', { h: hm(s.end) + (dayKey(s.end) !== dayKey(s.pts[0].at) ? ' ' + t('kv.nextday') : '') })}</span>
        <span class="kv-mini">${mini}</span>
        <span class="kv-badges">${badges(s).map((b) => `<span class="kv-badge ${b[0]}"${b[2] ? ` title="${esc(b[2])}"` : ''}>${esc(b[1])}</span>`).join('')}</span>
        <span class="kv-why">${esc(why(s, S, v, i))}</span></button>`;
    }).join('');
  }
  function renderDeps() {
    const el = $('kvDep'), P = prof();
    // every start in the four days, however long the drive: a trip the forecast does not cover to the end has no score (a
    // grey bar, never the suggestion); a route still waiting for its weather is left out
    const SS = depOptions().map((d) => [d, kv.routes.filter((R) => !R.wxWait).map((R) => summarise(R, +d, P))]);
    const opts = SS.map((x) => x[0]), sc = SS.map(([, ss]) => Math.min(...(ss.length ? ss : [{ valid: false }]).map((s) => (s.valid ? s.sc : Infinity))));
    const fin = sc.filter(Number.isFinite), mx = Math.max(1, ...fin), mn = Math.min(...fin);
    const cur = kv.dep ? +kv.dep : +opts[0];
    // a departure more than 48 hours ahead must be clearly better than a nearer one, more so the further ahead (15 % and 12
    // points a day): measured on 7 stations, Sep–Oct 2026, ECMWF's skill falls day by day (temperature error 1.1 °C a day
    // ahead, 1.5 °C five days ahead; rain ETS 0.42 to 0.24), with no step where MET Nordic ends
    const handicap = opts.map((d, k) => sc[k] * (1 + 0.15 * Math.max(0, (d - Date.now()) / 3600e3 - 48) / 24) + Math.max(0, (d - Date.now()) / 3600e3 - 48) * 0.5);
    const hr = kv.routes.flatMap((R) => R.samples.map((x) => fcHourly(x.key))).filter(Number.isFinite);   // MET's own hourly end where it answered
    const metEnd = hr.length ? Math.min(...hr) : Date.now() + MET_H * 3600e3, endOf = (k) => Math.min(...(SS[k][1].length ? SS[k][1] : [{ end: Infinity }]).map((x) => +x.end));   // the line marks where MET Nordic (1 km) ends, no limit
    // the suggestion: any departure whose whole trip the forecast covers (a trip running past its end has no score); the
    // visitor can still pick any bar
    const bestK = Number.isFinite(mn) ? handicap.indexOf(Math.min(...handicap.filter(Number.isFinite))) : -1;
    const sayWx = (k) => {   // the weather of the best route at that departure, in a few words
      const all = (SS[k] ? SS[k][1] : []).filter((x) => x.valid).sort((a, b) => a.sc - b.sc), x = all[0]; if (!x) return '';
      const c = KV_CLS.filter((q) => q !== 'dry' && (x.mins[q] || 0) >= 5).sort((a, b) => P.w[b] * x.mins[b] - P.w[a] * x.mins[a])[0];
      const dark = x.pts.reduce((m, p, i) => (i && x.pts[i - 1].dark && !x.pts[i - 1].stop ? m + (p.at - x.pts[i - 1].at) / 60e3 : m), 0);
      // what makes the difference: the weather, plus darkness when it counts (avoid the dark, or on a motorcycle) and strong gusts
      return [c ? `${t('kv.c.' + c)} ${dur(x.mins[c])}` : t('kv.dep.dry'), (kv.opts.noDark || kv.veh === 'mc') && dark >= 15 ? t('kv.dep.dark', { d: dur(dark) }) : '', x.coldMin >= 15 ? t('kv.dep.cold', { d: dur(x.coldMin) }) : '', x.gripMin >= 15 ? t('kv.dep.grip', { d: dur(x.gripMin) }) : '',
        x.gmax >= P.gust ? t('kv.gusts', { g: Math.round(x.gmax) }) : '', x.rush && x.rush.length ? t(x.rush.length > 1 ? 'kv.dep.rush' : 'kv.dep.rush1', { n: x.rush.length }) : ''].filter(Boolean).join(' · ');
    };
    let h = '', lastDay = null;
    opts.forEach((d, k) => {
      if (lastDay !== null && dayKey(d) !== lastDay) h += '<i class="kv-dsep"></i>';
      lastDay = dayKey(d);
      const v = Number.isFinite(sc[k]) ? (sc[k] - mn) / Math.max(1, mx - mn) : 1, lead = (d - Date.now()) / 3600e3;
      const col = !Number.isFinite(sc[k]) ? 'var(--line)' : v < 0.2 ? 'var(--good)' : v < 0.5 ? '#84cc16' : v < 0.75 ? 'var(--mid)' : 'var(--bad)';
      const sel = Math.abs(+d - cur) < 1800e3 || (k === 0 && !kv.dep);
      h += `<button type="button" data-k="${k}" data-day="${dayKey(d)}" data-t="${+d}" class="${sel ? 'sel' : ''}${k === bestK && !kv.ensWait && !kv.routes.some((R) => R.wxWait) ? ' best' : ''}" style="height:${(12 + 40 * (1 - v)).toFixed(0)}px;background:${lead > 72 ? `color-mix(in srgb, ${col} 40%, var(--panel))` : lead > 48 ? `color-mix(in srgb, ${col} 55%, var(--panel))` : lead > 24 ? `color-mix(in srgb, ${col} 75%, var(--panel))` : col}" title="${esc(wday(d) + ' ' + hm(d) + (Number.isFinite(sc[k]) ? ' · ' + sayWx(k) : ''))}" aria-label="${esc(wday(d) + ' ' + hm(d) + (Number.isFinite(sc[k]) ? ' · ' + sayWx(k) : ''))}"></button>`;
    });
    // after the last start: the hours up to the latest arrival as empty slots, so no trip seems to run off the chart
    const endMax = Math.max(...SS.map(([, ss]) => Math.max(0, ...ss.map((x) => +x.end)))), ghosts = [];
    for (let tt = Math.floor(+opts[opts.length - 1] / 3600e3) * 3600e3 + 3600e3; tt < endMax + 3600e3; tt += 3600e3) { const d = new Date(tt); if (dayKey(d) !== lastDay) { h += '<i class="kv-dsep"></i>'; lastDay = dayKey(d); } ghosts.push(d); h += `<i class="kv-dep-ghost" data-day="${dayKey(d)}" data-t="${tt}" title="${esc(wday(d) + ' ' + hm(d))}"></i>`; }
    el.innerHTML = h;
    const days = []; [...opts, ...ghosts].forEach((d) => { const k = dayKey(d); if (!days.includes(k)) days.push(k); });
    const selS = kv.S && kv.S[kv.sel], selStart = opts.find((d) => Math.abs(+d - cur) < 1800e3) || opts[0];
    $('kvDepAxis').innerHTML = days.map((k) => { const d = [...opts, ...ghosts].find((x) => dayKey(x) === k); return `<span data-day="${esc(k)}">${esc(wday(d) + ' ' + d.getDate() + '.')}</span>`; }).join('');
    KVCore.wireDepAxis($('kvDep'), $('kvDepAxis'), selS && selS.valid ? { start: +selStart, end: +selS.end, label: t('kv.dep.arrive', { h: hm(selS.end) }), short: hm(selS.end) } : {});   // no MET Nordic line: it limits nothing, and the bars fade with the days ahead   // each label centred under its day's slots; the chosen trip as a band
    // the suggestion: a clear box with the best departure and one button, unless the chosen one is about as good
    const bd = opts[bestK], curK = Math.max(0, opts.findIndex((d) => Math.abs(+d - cur) < 1800e3));
    const better = bestK >= 0 && Number.isFinite(sc[curK]) ? handicap[curK] - handicap[bestK] >= Math.max(10, handicap[bestK] * 0.1) : bestK >= 0;
    $('kvDepHint').innerHTML = kv.ensWait || kv.routes.some((R) => R.wxWait) ? `<div class="kv-best wait"><span class="spinner small"></span><span>${esc(t(kv.ensWait ? 'kv.dep.ens' : 'kv.dep.wait'))}</span></div>`
      : bestK < 0 ? '' : better
      ? `<div class="kv-best"><div class="kv-best-txt"><b>${esc(t('kv.dep.best', { d: wday(bd) + ' ' + t('kv.dep.at') + ' ' + hm(bd) }))}</b><small><span class="kv-best-l">${esc(t('kv.dep.then', { d: wday(bd) + ' ' + hm(bd) }))}:</span> ${esc(sayWx(bestK))}</small><small><span class="kv-best-l">${esc(t('kv.dep.chosen', { d: wday(opts[curK]) + ' ' + hm(opts[curK]) }))}:</span> ${esc(sayWx(curK))}</small>${endOf(bestK) > metEnd ? `<small>${esc(t('tv.dep.far', { n: Math.floor((bd - Date.now()) / 86400e3 * 2) / 2 }))}</small>` : ''}</div>` +
        `<button type="button" class="btn primary kv-best-go" id="kvUseBest" data-k="${bestK}">${esc(t('kv.dep.use2', { d: wday(bd) + ' ' + hm(bd) }))}</button></div>`
      : `<div class="kv-best ok"><b>✓ ${esc(t('kv.dep.isbest'))}</b></div>`;
    if (kv.ensFail && bestK >= 0) $('kvDepHint').insertAdjacentHTML('beforeend', `<small class="kv-ensfail">${esc(t('kv.dep.ensfail'))}</small>`);   // past MET's hourly steps the gusts were the other models'
    $('kvDepHelp').textContent = t('kv.dep.help');
    kv.depOpts = opts;
  }
  function renderChart(s) {
    // a lower chart when the large map shares a short screen with it
    const H = $('kvMap').classList.contains('big') && innerHeight < 1000 ? 206 : 236;
    const svg = $('kvChart'), W = Math.max(300, svg.clientWidth || 700), pts = s.pts, D = s.R.dense, km = s.R.km || 1;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    // a pause gets room on the axis: its minutes at the trip's average driving speed, as if it were road (u: the axis position)
    const stops = pts.filter((p) => p.stop), pauseMin = stops.reduce((a, p) => a + p.stop.ms / 60e3, 0), driveMin = Math.max(1, (s.end - pts[0].at) / 60e3 - pauseMin);
    const band = stops.map((p) => ({ km: p.km, w: p.stop.ms / 60e3 * km / driveMin, p }));
    const uOf = (k) => k + band.reduce((a, b) => a + (b.km < k ? b.w : 0), 0), U = km + band.reduce((a, b) => a + b.w, 0);
    pts.forEach((p) => { p.u = uOf(p.km) + (p.leave ? band.find((b) => b.p.stop === p.leave).w : 0); });
    const L = 64, X = (u) => L + (W - L - 10) * u / U, Xk = (k) => X(uOf(k));   // a label column wide enough for "Vindkast" at a readable size
    const zs = D.map((p) => p.z ?? 0), zmax = Math.max(1200, ...zs);
    const ts = pts.map((p) => p.t).filter(Number.isFinite), tmin = Math.min(-4, ...ts), tmax = Math.max(12, ...ts);
    const Ty = (v) => (H - 66) - (v - tmin) / (tmax - tmin) * Math.max(34, H - 176), Zy = (z) => (H - 14) - z / zmax * (H * 0.25);
    const C = (v) => cssv(v), line = C('--line'), muted = C('--muted');
    let h = '';
    const hPx = (W - L - 10) / Math.max(1, (s.end - pts[0].at) / 3600e3), hStep = hPx >= 22 ? 1 : hPx >= 11 ? 2 : hPx >= 7 ? 3 : 6;   // a long trip labels every 2nd, 3rd or 6th hour
    for (let tt = Math.ceil(+pts[0].at / 3600e3) * 3600e3; tt <= +s.end; tt += 3600e3) {   // clock ticks where you are at each full hour
      if (new Date(tt).getHours() % hStep) continue;
      let k = 0; for (let i = 1; i < pts.length; i++) if (+pts[i].at >= tt) { const f = (tt - pts[i - 1].at) / Math.max(1, pts[i].at - pts[i - 1].at); k = pts[i - 1].u + f * (pts[i].u - pts[i - 1].u); break; }
      h += `<line x1="${X(k)}" x2="${X(k)}" y1="14" y2="${H - 12}" stroke="${line}"/><text x="${X(k)}" y="10" font-size="11" text-anchor="middle" fill="${muted}">${pad2(new Date(tt).getHours())}</text>`;
    }
    s.seg.forEach((g) => {
      const a = X(pts[g.a].u), b = X(pts[Math.min(g.b + 1, pts.length - 1)].u);
      h += `<rect class="kvc-${g.cls}" x="${a}" y="16" width="${Math.max(1, b - a)}" height="24"/>` + (g.cls === 'snow' && b - a > 16 ? `<text x="${(a + b) / 2}" y="32" font-size="12" text-anchor="middle" class="kv-snowmark">❄</text>` : '');
    });
    const nf = pts.findIndex((p) => p.nofc);   // past the end of the forecast: grey, no weather drawn
    if (nf > 0) { const a = X(pts[nf].u); h += `<rect class="kv-nofc" x="${a}" y="16" width="${Math.max(2, X(U) - a)}" height="24"/>` + (X(U) - a >= 70 ? `<text class="kv-nofc-t" x="${(a + X(U)) / 2}" y="32" font-size="11" text-anchor="middle">${esc(t('kv.nofc'))}</text>` : ''); }
    // ferries: the stretch on board, hatched over the weather band
    s.R.features.ferries.forEach((f) => { if (f.km != null) {  const a = Xk(f.km), b = Xk(f.km1 ?? f.km + 1); h += `<rect x="${a}" y="16" width="${Math.max(3, b - a)}" height="24" fill="url(#kvHatch)"/>`; } });
    // two thin rows under the band: strong gusts (the vehicle's threshold) and darkness, each sample colouring the road to the next
    const row = (y, test, cls) => pts.forEach((p, i) => { if (i < pts.length - 1 && !p.nofc && test(p)) {  if (p.stop) return; const a = X(p.u), b = X(pts[i + 1].u); h += `<rect class="${cls}" x="${a}" y="${y}" width="${Math.max(2, b - a)}" height="8" rx="2"/>`; } });
    row(46, (p) => p.gust, 'kv-gustbar'); row(58, (p) => p.dark, 'kv-darkbar');
    pts.forEach((p) => { if (p.alert) h += `<path class="kv-alertmk" d="M${X(p.u)} 68l4.5 7.5h-9z"/>`; });
    // the road reports in force when you are there (closures, detours, convoys, roadworks), at their place on the road
    let lastX = -99;
    shownLive(s).filter((e) => e.on).forEach((e) => { const x = Math.max(L + 9, Xk(e.km0)); if (x - lastX < 13) return; lastX = x; h += `<text x="${x}" y="89" font-size="13" text-anchor="middle" class="kv-chev"><title>${esc(liveTitle(e))}</title>${evIcon(e)}</text>`; });
    h += `<defs><pattern id="kvHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" class="kv-hatch"/></pattern></defs>`;
    // row names: readable, right-aligned against the rows they name
    const lab = (y, txt, cls = 'kv-lab') => `<text x="${L - 6}" y="${y}" text-anchor="end" class="${cls}">${esc(txt)}</text>`;
    h += lab(32, t('kv.ch.wx')) + lab(54, t('kv.ch.wind')) + lab(66, t('kv.ch.dark')) + (s.R.reports && showReports() ? lab(88, t('kv.ch.ev')) : '');
    const zAt = (k) => { const d = D.reduce((a, o) => (Math.abs(o.km - k) < Math.abs(a.km - k) ? o : a), D[0]); return d.z ?? 0; };
    const ez = D.map((p) => [uOf(p.km), p.z ?? 0]).concat(band.flatMap((b) => [[uOf(b.km), zAt(b.km)], [uOf(b.km) + b.w, zAt(b.km)]])).sort((a, b) => a[0] - b[0]);   // standing still: flat through the pause
    h += `<path class="kv-elev" d="M${X(0)} ${H - 14} ${ez.map(([u, z]) => `L${X(u).toFixed(1)} ${Zy(z).toFixed(1)}`).join(' ')} L${X(U)} ${H - 14} Z"/>`;
    // the via points: a line where you arrive, and the pause as a band with its length
    band.forEach((b) => { const a = X(uOf(b.km)), e = X(uOf(b.km) + b.w), j = b.p.stop.j;
      if (e - a >= 1) h += `<rect class="kv-pauseband" x="${a}" y="14" width="${e - a}" height="${H - 26}"/>`;
      const cy = H - 30;
      h += `<line class="kv-vialine" x1="${a}" x2="${a}" y1="14" y2="${H - 12}"/><circle class="kv-viadot" cx="${a}" cy="${cy}" r="9"/><text class="kv-viadot-t" x="${a}" y="${cy + 4}" text-anchor="middle" font-size="11">${j + 1}</text>` +
''; });   // only the number: the pause's length is in the readout when the line is on it
    h += lab(H - 20, t('kv.ch.elev'));
     s.R.tops.forEach((i) => { const p = D[i]; h += `<text x="${Xk(p.km)}" y="${Zy(p.z) - 4}" font-size="10" text-anchor="middle" fill="${muted}">${Math.round(p.z)} m</text>`; });
    const kStep = [100, 200, 500, 1000].find((d) => (W - L - 10) * d / U >= 52) || 1000;   // the km labels never overlap
    for (let k = kStep; k < km && Xk(k) < W - 24; k += kStep) h += `<text x="${Xk(k)}" y="${H - 2}" font-size="10" text-anchor="middle" fill="${muted}">${k} km</text>`;
    if (tmin < 0 && tmax > 0) h += `<line x1="${L}" x2="${W - 10}" y1="${Ty(0)}" y2="${Ty(0)}" class="kv-zero"/>${lab(Ty(0) + 4, '0°', 'kv-lab kv-zero-t')}`;
     s.slick.forEach((p) => { h += `<circle cx="${X(p.u)}" cy="${Ty(p.t)}" r="7" class="kv-halo"/>`; });
    const tp = pts.filter((p) => Number.isFinite(p.t));
    if (tp.length) h += `<path class="kv-temp" d="${tp.map((p, i) => `${i ? 'L' : 'M'}${X(p.u).toFixed(1)} ${Ty(p.t).toFixed(1)}`).join(' ')}"/>`;
    h += lab(Ty(tmax) + 8, Math.round(tmax) + '°', 'kv-lab kv-temp-t');
    s.x.forEach((c) => { const p = pts[c.i]; h += `<circle cx="${X(p.u)}" cy="${Ty(p.t)}" r="4.5" class="kv-xmk ${c.dir}"/><text x="${X(p.u)}" y="${Ty(p.t) - 9}" font-size="12" font-weight="700" text-anchor="middle" class="kv-xmk-t">${XING[c.dir]}</text>`; });
    h += `<line id="kvCur" x1="-10" x2="-10" y1="14" y2="${H - 12}" class="kv-cur"/>`;
    svg.innerHTML = h;
    $('kvTitle').textContent = `${routeTitle(s.R)} · ${wday(pts[0].at)} ${hm(pts[0].at)}–${hm(s.end)} · ${dur((s.end - pts[0].at) / 60e3)}`;
    const used = new Set(pts.map((p) => p.cls));
    $('kvLegend').innerHTML = `<div class="kv-lg-row">${KV_CLS.filter((c) => c !== 'damp' || prof().wetRoad).map((c) => `<span class="${used.has(c) ? '' : 'kv-lg-off'}"${c === 'damp' ? ` title="${esc(t('kv.wr.help'))}"` : ''}><i class="kvc-${c}"></i>${t('kv.c.' + c)}</span>`).join('')}</div>` +
      `<div class="kv-lg-row"><span><i class="kv-l-temp"></i>${t('kv.ch.temp')}</span><span><i class="kv-l-zero"></i>${t('kv.lg.zero')}</span><span><i class="kv-l-x"></i>${t('kv.lg.cross')}</span><span><i class="kv-l-halo"></i>${t('kv.slick')}</span>` +
      `<span><i class="kv-l-gust"></i>${t('kv.lg.gust', { g: prof().gust })}</span><span><i class="kv-l-dark"></i>${t('kv.lg.dark')}</span><span><i class="kv-l-ferry"></i>${t('kv.ferry')}</span><span><i class="kv-l-alert"></i>${t('kv.lg.alert')}</span>${s.R.reports && showReports() ? `<span>🚧 ${t('kv.lg.ev')}</span>` : ''}<span><i class="kv-l-elev"></i>${t('kv.ch.elev')}</span><span><i class="kv-l-tick"></i>${t('kv.lg.tick')}</span></div>`;
    // The line follows the pointer exactly. Each sample colours the road up to the next one, so the readout shows the
    // block under the line (weather, gusts, dark, warning) with time, km, height and temperature interpolated at that point.
    const R = s.R;
    const posAt = (k) => {   // the point on the road at k km, for the map marker
      let lo = 0, hi = R.cumKm.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.cumKm[m] <= k) lo = m; else hi = m; }
      const a = R.cumKm[lo], b = R.cumKm[hi], f = b > a ? (k - a) / (b - a) : 0, p = R.coords[lo], q = R.coords[hi];
      return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
    };
    const seekU = (u) => {   // put the time line at axis position u: chart line, readout and the map dot; returns what is there
      u = Math.max(0, Math.min(U, u)); const x = X(u);
      let i = 0; while (i < pts.length - 2 && pts[i + 1].u <= u) i++;
      const p = pts[i], q = pts[i + 1] || p, f = q.u > p.u ? Math.max(0, Math.min(1, (u - p.u) / (q.u - p.u))) : 0;
      const k = p.km + f * (q.km - p.km), at = new Date(+p.at + f * (q.at - p.at));   // inside a pause: standing at the via, the clock running
      const tc = Number.isFinite(p.t) && Number.isFinite(q.t) ? p.t + f * (q.t - p.t) : p.t;
      const d = D.reduce((a, o) => (Math.abs(o.km - k) < Math.abs(a.km - k) ? o : a), D[0]);
      const c = svg.querySelector('#kvCur'); c.setAttribute('x1', x); c.setAttribute('x2', x);
      // always two lines, each cut rather than wrapped, so nothing under the chart moves while scrubbing
      if (p.stop && q.leave === p.stop) {   // inside a pause: say so, with the stop and its times
        const v = kv.via[p.stop.j] || {};
        $('kvRead').innerHTML = `<span class="kv-r1"><b>${hm(at)}</b> · <b>${esc(t('kv.pause.read', { d: pauseShort(p.stop.ms / 60e3), p: v.name || t('kv.via.label') }))}</b> · ${hm(p.at)}–${hm(q.at)}</span>` +
          `<span class="kv-r2">${t('kv.c.' + (f < 0.5 ? p : q).cls)} · <b>${fmt(tc, 1)}°</b> · km ${Math.round(k)}</span>`;
        const pos = posAt(k); MAP.cursor(pos);
        return { k, at, t: tc, cls: p.cls, pos };
      }
      $('kvRead').innerHTML = `<span class="kv-r1"><b>${hm(at)}</b> · km ${Math.round(k)} · ${Math.round(d.z ?? p.z ?? 0)} ${t('kv.masl')} · <b>${fmt(tc, 1)}°</b>${p.feel != null ? ' ' + t('kv.r.feel', { f: degS(p.feel), v: Math.round(p.v / 10) * 10 }) : ''}</span>` +
        `<span class="kv-r2">${t('kv.c.' + p.cls)}${p.cls === 'damp' ? ' · ' + esc(wrSay(p)) : p.wrUnk && p.cls === 'dry' ? ' · ' + esc(t('kv.wr.unk')) : ''}${p.mm >= 0.1 ? ' ' + fmt(p.mm, 1) + ' mm/t' : ''} ${p.gNa ? '' : ' · ' + t('kv.gusts', { g: Math.round(p.g) })}${p.slick ? ` · <b class="kv-slick">${t('kv.slick')}</b>` : ''}${p.dark ? ' · ' + t('kv.dark') : ''}${p.alert ? ' · ⚠ ' + esc(p.alert) : ''}</span>`;
      const pos = posAt(k); MAP.cursor(pos);
      return { k, at, t: tc, cls: p.cls, pos };
    };
    const seek = (k) => seekU(uOf(Math.max(0, Math.min(km, k))));   // by km (from the map and the phone layout)
    kv.seek = seek;
    const pick = (ev) => { const r = svg.getBoundingClientRect(), x = Math.max(L, Math.min(W - 10, (ev.clientX - r.left) / r.width * W)); seekU((x - L) / (W - L - 10) * U); };
    // a click (not a drag) also takes the map to that spot, at a regional zoom (closer zoom is kept)
    let down = null;
    svg.onpointermove = pick;
    svg.onpointerdown = (ev) => { pick(ev); down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; };
    svg.onpointerup = (ev) => {
      if (!down) return; const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), quick = performance.now() - down.t < 600; down = null;
      if (moved > 6 || !quick) return;
      const r = svg.getBoundingClientRect(), x = Math.max(L, Math.min(W - 10, (ev.clientX - r.left) / r.width * W)), info = seekU((x - L) / (W - L - 10) * U);
      MAP.focus(info.pos);
    };
  }
  /* ---------------- the map: MapLibre with a 2D / 3D button (terrain at 1.5x, as the shadow map), Leaflet where WebGL is missing ----------------
     Both behind one small interface: init, base, fit, resize, draw, cursor, stale. Points are [lat, lon] everywhere here. */
  const { BASE_TILES, NORWAY, hasGL, isDark } = KVCore;
  const boundsOf = (S) => { let s = 90, w = 180, n = -90, e = -180; S.forEach((x) => x.R.coords.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); })); return [[s, w], [n, e]]; };
  // route lines on the map: saturated weather colours in both themes; a light outline and light grey alternatives on the
  // dark map, a dark outline and grey alternatives on the light map
  const DARK_LINE = { dry: '#22c55e', damp: '#14b8a6', fog: '#a3a3a3', wet: '#3b82f6', heavy: '#1e40af', sleet: '#8b5cf6', snow: '#38bdf8', ice: '#f43f5e', thunder: '#f59e0b' };
  const lineStyle = () => (isDark() ? { cls: (c) => DARK_LINE[c] || '#22c55e', casing: '#f8fafc', casingOp: 0.85, alt: '#cbd5e1', altOp: 0.75 }
    : { cls: (c) => DARK_LINE[c] || '#22c55e', casing: '#0f172a', casingOp: 0.55, alt: '#334155', altOp: 0.8 });   // saturated on the light map too (pale green vanished in green terrain)
  const MAPS = {
    gl: {
      m: null, ready: null, marks: [], cur: null, popup: null, tiles: 'kartverket',
      init() {
        if (this.ready) return this.ready;
        this.ready = KVCore.glMap('kvMap', (m) => {   // the base map is shared with Turvær (js/kvcore.js); the route layers are Kjørevær's
            this.m = m;
            const empty = { type: 'FeatureCollection', features: [] }, round = { 'line-join': 'round', 'line-cap': 'round' };
            ['kv-hover', 'kv-alt', 'kv-casing', 'kv-sel'].forEach((id) => m.addSource(id, { type: 'geojson', data: empty }));
            m.addSource('kv-vern', { type: 'geojson', data: empty });   // national parks on the route, under the route lines
            m.addLayer({ id: 'kv-vern', type: 'fill', source: 'kv-vern', paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.12 } });
            m.addLayer({ id: 'kv-vern-line', type: 'line', source: 'kv-vern', paint: { 'line-color': '#15803d', 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } });
            m.addLayer({ id: 'kv-alt', type: 'line', source: 'kv-alt', layout: round, paint: { 'line-color': '#64748b', 'line-width': 5, 'line-opacity': 0.6 } });
            m.addLayer({ id: 'kv-hover', type: 'line', source: 'kv-hover', layout: round, paint: { 'line-color': '#f59e0b', 'line-width': 14, 'line-opacity': 0.55, 'line-blur': 1 } }, 'kv-alt');   // the route under the pointer on a tile: a halo under it
            m.addLayer({ id: 'kv-casing', type: 'line', source: 'kv-casing', layout: round, paint: { 'line-color': '#0f172a', 'line-width': 9, 'line-opacity': 0.5 } });
            m.addLayer({ id: 'kv-sel', type: 'line', source: 'kv-sel', layout: round, paint: { 'line-color': ['get', 'c'], 'line-width': 6 } });
            m.addSource('kv-stage', { type: 'geojson', data: empty });   // a stage picked in the itinerary: a pulsing glow over the route
            m.addLayer({ id: 'kv-stage-glow', type: 'line', source: 'kv-stage', layout: round, paint: { 'line-color': '#facc15', 'line-width': 16, 'line-opacity': 0, 'line-blur': 3 } });
            m.addLayer({ id: 'kv-stage-core', type: 'line', source: 'kv-stage', layout: round, paint: { 'line-color': '#fde047', 'line-width': 4, 'line-opacity': 0 } });
            m.addLayer({ id: 'kv-hit', type: 'line', source: 'kv-casing', layout: round, paint: { 'line-color': '#000', 'line-width': 28, 'line-opacity': 0 } });   // easy to hit, also with a finger
            const overCam = (e) => !!m.getLayer('kv-cams') && m.queryRenderedFeatures(e.point, { layers: ['kv-cams'] }).length > 0;   // a camera on the road wins
            this.overCam = overCam;
            m.on('click', 'kv-hit', (e) => { if (!overCam(e)) routeClick(e.lngLat.lat, e.lngLat.lng); });
            m.on('mouseenter', 'kv-hit', () => { m.getCanvas().style.cursor = 'pointer'; if (!this.sv) { if (!this.popup) this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }); } });
            const noHover = () => !matchMedia('(hover: hover)').matches;   // a finger: a tap also sends a mouse move, and the hover label would stick
            m.on('mousemove', 'kv-hit', (e) => { if (noHover() || (this.sv && this.sv.isOpen()) || overCam(e)) return; if (!this.popup) this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }); this.popup.setLngLat(e.lngLat).setText(t('kv.sv.hover')).addTo(m); });
            m.on('mouseleave', 'kv-hit', () => { m.getCanvas().style.cursor = ''; if (this.popup) this.popup.remove(); });
            // the other routes: name on hover, tap to choose
            m.on('click', 'kv-alt', (e) => { if (overCam(e) || m.queryRenderedFeatures(e.point, { layers: ['kv-hit'] }).length) return; choose(+e.features[0].properties.i); });   // a shared road belongs to the chosen route
            m.on('mouseenter', 'kv-alt', () => { m.getCanvas().style.cursor = 'pointer'; });
            m.on('mouseleave', 'kv-alt', () => { m.getCanvas().style.cursor = ''; if (this.popup) this.popup.remove(); });
            m.on('mousemove', 'kv-alt', (e) => { if (noHover()) return; if (!this.popup) this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }); this.popup.setLngLat(e.lngLat).setText(e.features[0].properties.title).addTo(m); });
          }, () => { if (kv.S) this.draw(kv.S); });
        return this.ready;
      },
      theme() { KVCore.glTheme(this.m); },
      applyBase() { KVCore.applyBase(this.m); },
      base(id) { if (this.m && id !== this.tiles && BASE_TILES[id]) { this.m.getSource('base').setTiles(BASE_TILES[id].tiles); this.tiles = id; } },
      fit(b, reset) { if (this.m) this.m.fitBounds([[b[0][1], b[0][0]], [b[1][1], b[1][0]]], { padding: 30, duration: 0, pitch: reset ? 0 : this.m.getPitch(), bearing: reset ? 0 : this.m.getBearing() }); },   // reset: a new trip is seen flat and north up
      resize() { if (this.m) this.m.resize(); },
      mark(p, text, cls, title) {
        const el = document.createElement('div'); el.className = cls; el.textContent = text; if (title) el.title = title;
        const mk = new maplibregl.Marker({ element: el }).setLngLat([+p[1], +p[0]]).addTo(this.m); this.marks.push(mk); return mk;
      },
      hover(i) {   // a tile under the pointer: that route gets a halo on the map
        const m = this.m; if (!m || !m.getSource('kv-hover')) return; const R = i != null && kv.S && kv.S[i] ? kv.S[i].R : null;
        m.getSource('kv-hover').setData(R ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: R.coords.map((c) => [c[1], c[0]]) } } : { type: 'FeatureCollection', features: [] });
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
        const vset = new Set(); m.getSource('kv-vern').setData({ type: 'FeatureCollection', features: vernFor(s).filter((v) => !vset.has(v.a) && vset.add(v.a)).map((v) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: v.a.g.map((pl) => pl.map((r) => r.map(([la, lo]) => [lo, la]))) } })) });
        const segs = [];   // the chosen route coloured by weather class: each sample colours the road up to the next one
        for (let i = 0; i < s.pts.length - 1; i++) {
          const a = s.pts[i], b = s.pts[i + 1], seg = [[a.lat, a.lon]];
          for (let j = 0; j < s.R.coords.length; j++) if (s.R.cumKm[j] > a.km && s.R.cumKm[j] < b.km) seg.push(s.R.coords[j]);
          seg.push([b.lat, b.lon]); segs.push(line(seg, { c: a.nofc ? '#94a3b8' : ls.cls(a.cls) }));
        }
        m.getSource('kv-sel').setData({ type: 'FeatureCollection', features: segs });
        this.marks.forEach((mk) => mk.remove()); this.marks = [];
        // the street view popup closes only when what it describes changes (route, departure, vehicle), not on a redraw
        const pk = [kv.sel, kv.routes.indexOf(s.R), +(kv.dep || 0), kv.veh, kv.token].join('|'); if (pk !== this.popKey) { this.closePopup(); this.popKey = pk; }
        s.x.forEach((c) => { const p = s.pts[c.i], mk = this.mark([p.lat, p.lon], '', 'kv-xingmk', xingTitle(c.dir, p)), el = mk.getElement();
          el.innerHTML = xingPill(c.dir); mk.setOffset([0, -13]);   // just above its point on the road: a pass top or a camera there stays visible, and so does the pill
          el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-label', xingTitle(c.dir, p));
          const open = (ev) => { ev.stopPropagation(); xingPopup(c.dir, p); };
          el.addEventListener('click', open); el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev); } }); });
        s.R.tops.forEach((i) => { const p = s.R.dense[i]; this.mark([p.lat, p.lon], '', 'kv-topmk', `${Math.round(p.z)} ${t('kv.masl')}`); });
        shownLive(s).filter(liveOnMap).forEach((e) => { const mk = this.mark(e.pos, evIcon(e), 'kv-evmk ' + (e.veto ? 'stop' : e.on ? 'on' : 'off'), liveTitle(e)); mk.getElement().addEventListener('click', (ev) => { ev.stopPropagation(); livePopup(e); }); });
        (s.rush || []).forEach((r) => { const mk = this.mark(r.pos, '🚙', 'kv-rushmk', rushTitle(r)); mk.getElement().addEventListener('click', (ev) => { ev.stopPropagation(); rushPopup(r); }); });
        restFor(s).forEach((x) => { const mk = this.mark(x.pos, '', 'kv-restmk' + (x.it[5] ? ' main' : ''), restTitle(x)); mk.getElement().innerHTML = REST_ICON; mk.getElement().addEventListener('click', (ev) => { ev.stopPropagation(); restPopup(x); }); });
        sightsFor(s).forEach((x) => { const mk = this.mark(x.pos, sightIcon(x.it), 'kv-sightmk r' + x.it[2] + (x.p.dark ? ' dark' : ''), sightTitle(x)); mk.getElement().addEventListener('click', (ev) => { ev.stopPropagation(); sightPopup(x); }); });
        this.mark([kv.from.lat, kv.from.lon], 'A', 'kv-abm'); this.mark([kv.to.lat, kv.to.lon], 'B', 'kv-abm');
        s.pts.filter((p) => p.stop).forEach((p) => { const mk = this.mark([p.lat, p.lon], String(p.stop.j + 1), 'kv-abm kv-viamk', viaTitle(p, s.pts)); mk.getElement().addEventListener('click', (ev) => { ev.stopPropagation(); viaPopup(p, s.pts); }); });
        this.labels = altLabels(S).map((lb) => {
          const el = document.createElement('button'); el.type = 'button'; el.className = 'kv-altlabel' + (lb.sel ? ' sel' : ''); el.textContent = lb.text; el.title = lb.title;
          el.addEventListener('click', (e) => { e.stopPropagation(); if (!lb.sel) choose(lb.i); });
          const mk = new maplibregl.Marker({ element: el }).setLngLat([lb.at[1], lb.at[0]]).addTo(m); this.marks.push(mk);
          return { ...lb, mk, el };
        });
        if (!this.placeWired) { this.placeWired = true; m.on('moveend', () => this.placeLabels()); m.on('resize', () => this.placeLabels()); }
        requestAnimationFrame(() => this.placeLabels());
        this.cur = this.mark([s.pts[0].lat, s.pts[0].lon], '', 'kv-curmk'); this.cur.getElement().hidden = true;   // shown once the chart is scrubbed (it would cover A)
        if (window.GlettUI) GlettUI.map('kv', m, s, this.marks);
        this.stale(false);
        if (!kv.fitted) { this.resize(); this.fit(boundsOf(S), true); kv.fitted = true; }
        if (camOn() && camList) this.cams(camList, camsNearRoute());
      },
      async cams(list, near) {   // the webcams as one symbol layer: crowded icons give way (the ones on the route first)
        await this.init(); const m = this.m;
        if (!m.getSource('kv-cams')) {
          m.addImage('kv-cam', camIcon(false), { pixelRatio: 2 }); m.addImage('kv-cam-near', camIcon(true), { pixelRatio: 2 });
          m.addSource('kv-cams', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          m.addLayer({ id: 'kv-cams', type: 'symbol', source: 'kv-cams', layout: { 'icon-image': ['case', ['get', 'r'], 'kv-cam-near', 'kv-cam'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 10, 1.05], 'symbol-sort-key': ['case', ['get', 'r'], 0, 1], 'icon-padding': 1 },
          paint: { 'icon-opacity': ['case', ['get', 'f'], 0.45, 1] } });
          const tip = () => (this.popup ||= new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 }));
          m.on('click', 'kv-cams', (e) => camClick(+e.features[0].properties.i));
          m.on('mouseenter', 'kv-cams', () => { m.getCanvas().style.cursor = 'pointer'; });
          m.on('mousemove', 'kv-cams', (e) => { if (this.sv && this.sv.isOpen()) return; const f = e.features[0]; tip().setLngLat(f.geometry.coordinates).setText(f.properties.n).addTo(m); });
          m.on('mouseleave', 'kv-cams', () => { m.getCanvas().style.cursor = ''; if (this.popup) this.popup.remove(); });
        }
        m.getSource('kv-cams').setData({ type: 'FeatureCollection', features: (list || []).map((c, i) => (near && near.has(i) ? { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lo, c.la] },
          properties: { i, r: true, f: c.c.every((x) => x.f), n: camTip(c), cc: c.cc || 'no' } } : null)).filter(Boolean) });
      },
      cursor(p) { if (this.cur) { this.cur.setLngLat([p[1], p[0]]); this.cur.getElement().hidden = false; } },
      focus(p) { if (this.m) this.m.flyTo({ center: [p[1], p[0]], zoom: Math.max(this.m.getZoom(), 9), duration: 1200, essential: true }); },   // about 40 km across
      placeLabels() {   // each label beside its route on a free spot: no route line under it, no other label, away from the chosen route first
        const m = this.m; if (!m || !this.labels || !kv.S) return;
        const box = m.getContainer().getBoundingClientRect(), pts = [];
        kv.S.forEach((x) => { const c = x.R.coords, st = Math.max(1, Math.floor(c.length / 1500)); for (let i = 0; i < c.length; i += st) { const q = m.project([c[i][1], c[i][0]]); if (q.x > -50 && q.y > -50 && q.x < box.width + 50 && q.y < box.height + 50) pts.push(q); } });
        const hitsRoute = (r) => pts.some((q) => q.x > r.l - 3 && q.x < r.r + 3 && q.y > r.t - 3 && q.y < r.b + 3);
        const shown = [], pad = 4;
        // the buttons on the map (larger map, webcams) are taken already
        m.getContainer().parentElement.querySelectorAll('.kv-bigbtn, .gl-wxmk:not([hidden])').forEach((btn) => { const q = btn.getBoundingClientRect(); if (q.width) shown.push({ l: q.left - box.left, r: q.right - box.left, t: q.top - box.top, b: q.bottom - box.top }); });   // the buttons and the weather icons are taken already
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
      async highlight(coords, maxZoom = 13, also = []) {   // also: points to keep in the frame (a sight off the road), not drawn
        await this.init(); const m = this.m; clearInterval(this.pulse);
        m.getSource('kv-stage').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[1], c[0]]) } });
        // always fly to the stage, framed with a margin (also when it was already somewhere in view)
        let s = 90, w = 180, n = -90, e = -180; coords.concat(also).forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); });
        m.fitBounds([[w, s], [e, n]], { padding: 50, duration: 1400, maxZoom, pitch: m.getPitch(), bearing: m.getBearing() });
        m.once('moveend', () => this.fitPopup());   // a popup opened before the flight (a pill's details): fully in view where it lands
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
      base(id) { const m = this.m; if (!m.hasLayer(m._kvBase.osm)) m._kvBase.osm.addTo(m); const b = m._kvBase[id]; if (b && !m.hasLayer(b)) b.addTo(m); this.applyBase(); },
      applyBase() { const m = this.m; if (!m) return; const k = m._kvBase.kartverket; if (KVCore.baseChoice() === 'osm') { if (m.hasLayer(k)) m.removeLayer(k); } else if (!m.hasLayer(k)) k.addTo(m); },
      fit(b) { if (this.m) this.m.fitBounds(b, { padding: [16, 16] }); },
      resize() { if (this.m) this.m.invalidateSize(); },
      hover() { /* no halo on the fallback map */ },
      async draw(S) {
        await this.init(); const m = this.m, s = S[kv.sel];
        this.base(kv.region && kv.region.tiles);
        const pk = [kv.sel, +(kv.dep || 0), kv.veh, kv.token].join('|'); if (pk !== this.popKey) { this.closePopup(); this.popKey = pk; }
        this.layers.forEach((l) => m.removeLayer(l)); this.layers = [];
        const add = (l) => { this.layers.push(l.addTo(m)); return l; };
        const vset = new Set(); vernFor(s).forEach((v) => { if (vset.has(v.a)) return; vset.add(v.a); add(L.polygon(v.a.g, { color: '#15803d', weight: 1.5, dashArray: '4 4', fillColor: '#16a34a', fillOpacity: 0.12, interactive: false })); });
        S.forEach((x, i) => { if (i === kv.sel) return;
          add(L.polyline(x.R.coords, { color: lineStyle().alt, weight: 5, opacity: lineStyle().altOp })).bindTooltip(esc(routeTitle(x.R)), { sticky: true }).on('click', () => choose(i)); });
        add(L.polyline(s.R.coords, { color: lineStyle().casing, weight: 9, opacity: lineStyle().casingOp, interactive: false }));
        { const hit = add(L.polyline(s.R.coords, { color: '#000', weight: 26, opacity: 0.001 })).on('click', (e) => routeClick(e.latlng.lat, e.latlng.lng)); if (matchMedia('(hover: hover)').matches) hit.bindTooltip(esc(t('kv.sv.hover')), { sticky: true }); }
        for (let i = 0; i < s.pts.length - 1; i++) {
          const a = s.pts[i], b = s.pts[i + 1], seg = [[a.lat, a.lon]];
          for (let j = 0; j < s.R.coords.length; j++) if (s.R.cumKm[j] > a.km && s.R.cumKm[j] < b.km) seg.push(s.R.coords[j]);
          seg.push([b.lat, b.lon]); add(L.polyline(seg, { color: a.nofc ? '#94a3b8' : lineStyle().cls(a.cls), weight: 6, opacity: 1, interactive: false }));
        }
        s.x.forEach((c) => { const p = s.pts[c.i]; add(L.marker([p.lat, p.lon], { icon: L.divIcon({ html: xingPill(c.dir), className: 'kv-xingmk', iconSize: [38, 22], iconAnchor: [19, 24] }), zIndexOffset: 500, keyboard: true, title: xingTitle(c.dir, p) })).on('click', () => xingPopup(c.dir, p)); });
        s.R.tops.forEach((i) => { const p = s.R.dense[i]; add(L.circleMarker([p.lat, p.lon], { radius: 5, color: '#111', fillColor: '#fff', fillOpacity: 1, weight: 2 })).bindTooltip(`${Math.round(p.z)} ${esc(t('kv.masl'))}`); });
        shownLive(s).filter(liveOnMap).forEach((e) => add(L.marker(e.pos, { icon: L.divIcon({ html: evIcon(e), className: 'kv-evmk ' + (e.veto ? 'stop' : e.on ? 'on' : 'off'), iconSize: [24, 24] }) })).bindTooltip(esc(liveTitle(e))).on('click', () => livePopup(e)));
        (s.rush || []).forEach((r) => add(L.marker(r.pos, { icon: L.divIcon({ html: '🚙', className: 'kv-rushmk', iconSize: [24, 24] }) })).bindTooltip(esc(rushTitle(r))).on('click', () => rushPopup(r)));
        restFor(s).forEach((x) => add(L.marker(x.pos, { icon: L.divIcon({ html: REST_ICON, className: 'kv-restmk' + (x.it[5] ? ' main' : ''), iconSize: [24, 24] }) })).bindTooltip(esc(restTitle(x))).on('click', () => restPopup(x)));
        sightsFor(s).forEach((x) => add(L.marker(x.pos, { icon: L.divIcon({ html: sightIcon(x.it), className: 'kv-sightmk r' + x.it[2] + (x.p.dark ? ' dark' : ''), iconSize: [24, 24] }) })).bindTooltip(esc(sightTitle(x))).on('click', () => sightPopup(x)));
        [kv.from, kv.to].forEach((p, k) => add(L.marker([+p.lat, +p.lon], { icon: L.divIcon({ html: k ? 'B' : 'A', className: 'kv-abm', iconSize: [22, 22] }) })));
        s.pts.filter((p) => p.stop).forEach((p) => add(L.marker([p.lat, p.lon], { icon: L.divIcon({ html: String(p.stop.j + 1), className: 'kv-abm kv-viamk', iconSize: [22, 22] }) })).bindTooltip(esc(viaTitle(p, s.pts))).on('click', () => viaPopup(p, s.pts)));
        altLabels(S).forEach((lb) => add(L.marker(lb.at, { opacity: 0, interactive: false })).bindTooltip(esc(lb.text), { permanent: true, direction: 'auto', className: 'kv-altlabel-lf' }));
        this.cur = add(L.circleMarker([s.pts[0].lat, s.pts[0].lon], { radius: 7, color: '#fff', fillColor: '#2563eb', fillOpacity: 0, opacity: 0, weight: 3, interactive: false }));   // shown once the chart is scrubbed
        setTimeout(() => { m.invalidateSize(); if (!kv.fitted) { this.fit(boundsOf(S)); kv.fitted = true; } }, 30);
        if (camOn() && camList) this.cams(camList, camsNearRoute());
      },
      cams(list, near) {
        if (!this.m) return;
        if (this.camLayer) { this.m.removeLayer(this.camLayer); this.camLayer = null; }
        if (!list) return;
        this.camLayer = L.layerGroup(list.map((c, i) => (near && near.has(i) ? L.marker([c.la, c.lo], { icon: L.divIcon({ html: '📷', className: 'kv-cammk near' + (c.c.every((x) => x.f) ? ' off' : ''), iconSize: [24, 24] }) })
          .bindTooltip(esc(camTip(c))).on('click', () => camClick(i)) : null)).filter(Boolean)).addTo(this.m);
      },
      cursor(p) { if (this.cur) this.cur.setLatLng(p).setStyle({ opacity: 1, fillOpacity: 1 }); },
      focus(p) { if (this.m) this.m.flyTo(p, Math.max(this.m.getZoom(), 9), { duration: 1.2 }); },
      async highlight(coords, maxZoom = 13, also = []) {
        await this.init(); const m = this.m; if (this.hl) m.removeLayer(this.hl); clearTimeout(this.hlT);
        this.hl = L.polyline(coords, { color: '#facc15', weight: 14, opacity: 0.85, className: 'kv-stage-pulse', interactive: false }).addTo(m);
        m.flyToBounds(L.latLngBounds(coords.concat(also)), { padding: [50, 50], maxZoom, duration: 1.4 });
        m.once('moveend', () => { if (this.sv && !this.sv.isSheet && this.sv.isOpen() && this.sv._adjustPan) this.sv._adjustPan(); });   // a popup opened before the flight: in view where it lands
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
    sightsLabel(); showLabels();
    const c = $('kvCams');   // the webcam button beside it
    c.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg><span>${t('kv.cam.btn')}</span>`; c.setAttribute('aria-pressed', camOn() ? 'true' : 'false'); c.title = t('kv.cam.help');
    const b = $('kvBig'), on = $('kvMap').classList.contains('big') || !!(PHONE && PHONE.on);
    b.innerHTML = `${BIG_ICON[on ? 'shrink' : 'grow']}<span>${t(on ? 'kv.map.small' : 'kv.map.big')}</span>`; b.setAttribute('aria-pressed', on ? 'true' : 'false');
    KVCore.baseLabel($('kvBase')); fullLabel();
  }
  let FULL = null;   // "Enda større kart": built on first use
  const fullIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3z"/><path d="M15 3v18"/></svg>';
  function fullLabel() {   // the button sits under the other map buttons; "Tilbake til siden" while the map fills the window
    const f = $('kvFull'); if (!f) return; const on = !!(FULL && FULL.on);
    f.hidden = !kv.routes.length; f.innerHTML = `${fullIcon}<span>${t(on ? 'kv.map.normal' : 'kv.map.full')}</span>`; f.setAttribute('aria-pressed', on ? 'true' : 'false');
    const below = [$('kvBig'), $('kvCams'), $('kvBase')].filter((b) => b && !b.hidden && b.offsetParent).reduce((m, b) => Math.max(m, b.offsetTop + b.offsetHeight), 4); f.style.top = (below + 6) + 'px';
  }
  function setFull(on) {
    if (!kv.routes.length) return;
    if (!FULL) FULL = KVCore.fullMap({ wrap: $('kvMapWrap'), cards: [$('kvChartCard'), document.querySelector('#view-route .kv-itcard')], onToggle: () => fullLabel(),
      onLayout: (final) => { MAP.resize(); if (final && kv.S) { MAP.fit(boundsOf(kv.S)); renderChart(kv.S[kv.sel]); } } });
    if (on && $('kvMap').classList.contains('big')) setBig(false);
    FULL.open(on);
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
  let PHONE = null;   // phones: the whole screen with a scrubber strip
  function phoneView() {
    return PHONE ||= KVCore.phoneMap({ wrap: $('kvMapWrap'), onToggle: () => bigLabel(),
      lane: () => { const s = kv.S && kv.S[kv.sel]; if (!s) return { segs: [] }; const tot = s.pts[s.pts.length - 1].km || 1; return { segs: s.seg.map((g) => ({ f0: s.pts[g.a].km / tot, f1: s.pts[Math.min(g.b + 1, s.pts.length - 1)].km / tot, cls: g.cls })) }; },
      seek: (f) => { const s = kv.S && kv.S[kv.sel]; if (s && kv.seek) kv.seek(f * (s.pts[s.pts.length - 1].km || 1)); },
      read: () => { const r = $('kvRead'); return [(r.querySelector('.kv-r1') || r).textContent, (r.querySelector('.kv-r2') || {}).textContent || '']; },
      onLayout: (final) => { MAP.resize(); if (final && kv.S) MAP.fit(boundsOf(kv.S)); } });
  }
  function setBig(on) {
    if (FULL && FULL.on) FULL.open(false);   // from the whole window straight to the larger map: the page first
    if (PHONE && PHONE.on) { PHONE.open(false); return; }   // the same button again: back to the page
    if (KVCore.phoneLike()) { phoneView().open(on); return; }   // phones: the whole screen
    const m = $('kvMap'), wrap = $('kvMapWrap'), card = $('kvChartCard'), top = $('kvMapTop');
    if (on === m.classList.contains('big')) return;
    const lg = $('kvLgDet');
    // a placeholder marks where the chart and the map live in the column: a neighbouring element can itself have moved
    // (after one round trip the chart's next sibling is the map, which goes to the top too)
    if (on) { if (!card._home) { card._home = document.createComment('kv-chart-home'); card.parentElement.insertBefore(card._home, card); } wrap._bhome = wrap._bhome || document.createComment('kv-map-home'); wrap.parentElement.insertBefore(wrap._bhome, wrap); top.appendChild(wrap); top.appendChild(card); lg._was = lg.open; lg.open = false; }
    else { card._home.after(card); wrap._bhome.after(wrap); m.style.height = ''; if (lg._was != null) lg.open = lg._was; }   // each back to its own place: the map and the chart may live in different columns
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
    const at = (km) => { const p = pts.find((q) => q.km >= km && !q.stop) || pts[pts.length - 1]; return p.at; };   // a leg that starts at a via starts when you drive on
    const vstops = pts.filter((p) => p.stop), legs = [];
    legsOf(R).forEach((g) => {   // a via inside a leg splits it: the same road, before and after the stop
      let a = g; vstops.forEach((v) => { if (v.km > a.km0 + 0.3 && v.km < a.km1 - 0.3) { legs.push({ ...a, km1: v.km }); a = { ...a, km0: v.km }; } }); legs.push(a);
    });
    let unkSaid = false, estSaid = '';
    const rows = legs.map((g) => {
      const sub = pts.filter((p) => p.km >= g.km0 - 0.1 && p.km <= g.km1 + 0.1);
      const fc = sub.filter((p) => !p.nofc), nofc = !fc.length && sub.length, cutP = fc.length && fc.length < sub.length ? sub.find((p) => p.nofc) : null;
      const cls = fc.reduce((m, p) => (P.w[p.cls] > P.w[m] ? p.cls : m), 'dry');
      // the stage shows its worst weather; on a long stage that may be only part of it: then when (the first to the last
      // stretch with it), so "19:39 Våt vei" does not read as wet from 19:39
      const wi = cls === 'dry' ? [] : fc.map((p, i) => (p.cls === cls ? i : -1)).filter((i) => i >= 0);
      const wA = wi.length ? fc[wi[0]].at : null, wB = wi.length ? (fc[wi[wi.length - 1] + 1] || sub[sub.length - 1]).at : null;
      const t0 = at(g.km0), t1 = at(g.km1), when = wA && (wA - t0 > 5 * 60e3 || t1 - wB > 5 * 60e3) ? t('kv.it.span', { a: hm(wA), b: hm(new Date(Math.max(wB, +wA + 60e3))) }) : '';
      const tt = sub.map((p) => p.t).filter(Number.isFinite);
      const tops = R.tops.map((i) => R.dense[i]).filter((p) => p.km >= g.km0 && p.km <= g.km1);
      const rdc = g.country ? (g.ref && g.ref.startsWith('E') ? 'e' : 'ab') : g.ref && g.ref.startsWith('E') ? 'e' : g.ref && g.ref.startsWith('Rv') ? 'rv' : 'fv';
      const cc = g.country ? `<span class="kv-cc" title="${esc(t('kv.cn.' + g.country))}">${esc(t('kv.cn.' + g.country))}</span>` : '';
      const label = g.ferry ? `⛴ ${esc(g.name || t('kv.ferry'))}` : `${g.ref ? `<span class="kv-rd ${rdc}">${esc(g.ref)}</span>` : ''}${esc(g.name || '')}${g.toward ? ' ' + esc(t('kv.toward', { p: g.toward })) : ''}${cc}`;
      const nar = ((showNarrow() && narrowOf(R)) || { spans: [] }).spans.filter((x) => x.b > g.km0 && x.a < g.km1);
      const narKm = nar.reduce((q, x) => q + Math.min(x.b, g.km1) - Math.max(x.a, g.km0), 0);
      const rushes = (s.rush || []).filter((r) => r.km0 >= g.km0 - 0.05 && r.km0 < g.km1).map((r) => `<button type="button" class="kv-rush kv-fly" data-fly="${r.km0.toFixed(3)}|${r.km1.toFixed(3)}" title="${esc(t('kv.fly'))}">🚙 ${esc(rushTitle(r))}</button>`).join('');
      const narrow = nar.map((x) => { const a = Math.max(g.km0, x.a), z = Math.min(g.km1, x.b); return z - a < 0.02 ? '' : `<button type="button" class="kv-narrow kv-fly" data-fly="${a.toFixed(3)}|${z.toFixed(3)}" title="${esc(t('kv.fly'))}">${esc(t('kv.it.narrow', { km: mtr(+Math.max(0.1, z - a).toFixed(1)), w: mtr(+x.w.toFixed(1)) }))}</button>`; }).join('');   // each stretch (all 300 m or more) to fly to, like the road reports
      const last = g === legs[legs.length - 1];
      const evs = shownLive(s).filter((e) => e.km0 >= g.km0 - 0.05 && (e.km0 < g.km1 || last));
      const evHtml = (e) => `<button type="button" class="kv-ev kv-fly ${e.veto ? 'stop' : e.on ? 'on' : 'off'}" data-fly="${e.km0.toFixed(3)}|${(e.km1 ?? e.km0).toFixed(3)}" title="${esc(t('kv.fly'))}">${evIcon(e)} <b>${esc(evLabel(e))}</b> · ${esc(placeOf(e.it))}: ${esc(evText(e.it))}${e.it.more && !e.it.fx ? ` <small>${esc(e.it.more)}</small>` : ''} <i>${esc(evWhen(e))}</i></button>`;
      // the ones in force when you are there in full; the rest folded away
      const evOff = evs.filter((e) => !e.on);
      const ev = evs.filter((e) => e.on).map(evHtml).join('') + (evOff.length ? `<details class="kv-evmore"><summary>${esc(t('kv.ev.more', { n: evOff.length }))}</summary>${evOff.map(evHtml).join('')}</details>` : '');
      const sg = sightsFor(s).filter((x) => x.km >= g.km0 - 0.05 && (x.km < g.km1 || last)), SG_MAX = 6;
      const sgHtml = (x) => `<button type="button" class="kv-sight" data-sk="${x.km.toFixed(3)}|${esc(x.it[0])}">${sightIcon(x.it)} ${esc(x.it[4])} <i>${hm(x.at)}${x.p.dark ? ' · ' + esc(t('kv.sg.dark')) : ''}${x.d >= 1.5 ? ' · ' + esc(sightOff(x)) : ''}</i></button>`;
      const vern = vernFor(s).filter((v) => v.km0 >= g.km0 - 0.05 && (v.km0 < g.km1 || last)).map((v) => `<a class="kv-tvg kv-vern" href="${esc(v.u)}" target="_blank" rel="noopener">🌲 ${esc(t('kv.sg.vern', { n: v.n, a: hm(new Date(timeAtKm(s, v.km0))), b: hm(new Date(timeAtKm(s, v.km1))) }))} ↗</a>`).join('');
      const tvg = vern + tvgFor(s).filter((r) => r.km1 > g.km0 && r.km0 < g.km1).map((r) => `<a class="kv-tvg" href="${esc(r.url)}" target="_blank" rel="noopener">🛣 ${esc(t('kv.sg.tvg', { n: r.n }))} ↗</a>`).join('');
      const sights = tvg + (sg.length ? `<span class="kv-sights">${sg.slice(0, SG_MAX).map(sgHtml).join('')}${sg.length > SG_MAX ? `<details class="kv-evmore"><summary>${esc(t('kv.sg.more1', { n: sg.length - SG_MAX }))}</summary>${sg.slice(SG_MAX).map(sgHtml).join('')}</details>` : ''}</span>` : '');
      const rs0 = restFor(s).filter((x) => x.km >= g.km0 - 0.05 && (x.km < g.km1 || last));
      const rsHtml = (x) => `<button type="button" class="kv-sight kv-restbtn" data-rk="${x.km.toFixed(3)}|${esc(x.it[0])}" data-fly="${x.km.toFixed(3)}|${x.km.toFixed(3)}" title="${esc(t('kv.fly'))}">${REST_ICON} ${esc(restName(x))}${toiletOpen(x) ? ` <span title="${esc(t('kv.rest.wc'))}">🚻</span>` : ''} <i>${hm(x.at)}</i></button>`;
      const rests = rs0.length ? `<span class="kv-sights">${rs0.slice(0, REST_MAX).map(rsHtml).join('')}${rs0.length > REST_MAX ? `<details class="kv-evmore"><summary>${esc(t('kv.rest.more', { n: rs0.length - REST_MAX }))}</summary>${rs0.slice(REST_MAX).map(rsHtml).join('')}</details>` : ''}</span>` : '';
      const passOk = s.R.reports && showReports() && !evs.some((e) => e.on && !/^(hazard|limit)$/.test(e.it.k)) ? ` <span class="kv-passok">✓ ${esc(t('kv.pass.clear'))}</span>` : '';
      const pass = tops.length && !g.country && kv.region && kv.region.status ? `<span class="kv-passrow"><a class="kv-pass" href="${kv.region.status.url}" target="_blank" rel="noopener">${t('kv.pass', { z: Math.round(Math.max(...tops.map((p) => p.z))) })} ↗</a>${passOk}</span>` : '';
      const lo = Math.round(Math.min(...tt)), hi = Math.round(Math.max(...tt));
      const fm = fc.reduce((m, p) => (p.feel != null && (!m || p.feel < m.feel) ? p : m), null);   // MC: the coldest felt in the riding wind
      const temp = tt.length ? t('kv.it.temp', { t: lo === hi ? `${lo}°` : `${lo}–${hi}°` }) + (fm && fm.feel < Math.min(...tt) - 0.5 ? t('kv.it.feel', { f: degS(fm.feel), v: Math.round(fm.v / 10) * 10 }) : '') : '';
      const rd = sub.filter((p) => p.road), rs = rd.map((p) => p.road.s).filter((v) => v != null);
      const rk = rd.reduce((m, p) => (ROAD_ORDER.indexOf(p.road.k) > ROAD_ORDER.indexOf(m) ? p.road.k : m), 'dry');
      const rlo = Math.round(Math.min(...rs)), rhi = Math.round(Math.max(...rs));
      const ew = ensWords(s.R, sub, cls), ens = ew ? `<small class="kv-ens" title="${esc(t('kv.ens.help'))}">${esc(ew)}</small>` : '';
      const road = rd.length ? `<small class="kv-roadfc${['ice', 'snow', 'slush'].includes(rk) ? ' bad' : ''}" title="${esc([...new Set(rd.map((p) => p.road.cc))].map((c) => t(c === 'no' ? 'kv.it.roadsrc' : 'kv.it.roadsrc.' + c)).join(' '))}">${esc(t('kv.it.road', { t: rs.length ? (rlo === rhi ? `${rlo}°` : `${rlo}–${rhi}°`) + ', ' : '', c: t('kv.rc.' + rk) }))}</small>` : '';
      const we = fc.filter((p) => p.cls === 'damp' && p.wr.src === 'est'), wl = we.some((p) => p.wr.lvl === 'wet') ? 'wet' : 'moist', wd = Math.max(...we.map((p) => p.wr.dryAt || 0));
      const ob = we.length && rainCache.get(we[0].key), obMm = ob && ob.r && we[0].at - ob.t * 1000 < 3 * 3600e3 ? ob.r.reduce((a, v) => a + (v || 0), 0) / 10 : null;   // near the departure: the rain measured there
      // the estimate under "Våt vei", in the stage's second row (the whole width, so it wraps on a phone); only when it says
      // something new (another level or dry-by time than the stage before)
      const estTxt = we.length ? t('kv.it.roadEst', { lvl: t('kv.wr.' + wl), src: t('kv.wr.src.est'), d: wd > 0 ? ', ' + t('kv.wr.dryBy', { t: hm(new Date(wd)) }) : '' }) : '';
      const roadEst = estTxt && estTxt !== estSaid ? `<small class="kv-roadest" title="${esc(t('kv.wr.help') + (obMm != null ? ' ' + t('kv.wr.recent', { h: ob.r.length, mm: fmt(obMm, 1) }) : ''))}">${esc(estTxt)}</small>`
        : !estTxt && !rd.length && !unkSaid && fc.some((p) => p.wrUnk && p.cls === 'dry') && (unkSaid = true) ? `<small class="kv-roadest">${esc(t('kv.wr.unk'))}</small>` : '';   // once, on the first stage it touches
      estSaid = estTxt;
      // MC: under +5 °C on this stage (gripCold), when, and how much of it in bends; "hele etappen" when all of it
      let gm = 0, gb = 0, ga = null, gz = null;
      sub.forEach((p, i) => { const n = sub[i + 1]; if (!n || !p.grip || p.stop || p.ferry) return; const m = (n.at - p.at) / 60e3; gm += m; gb += m * p.gripBend; ga = ga || p.at; gz = n.at; });
      const gAll = ga && +ga - +at(g.km0) < 5 * 60e3 && +at(g.km1) - +gz < 5 * 60e3;
      const grip = gm >= 5 ? `<small class="kv-roadest kv-gripst" title="${esc(t(fc.some((p) => p.gripRoad) ? 'kv.grip.help.road' : 'kv.grip.help'))}">${esc(t(gAll ? 'kv.it.grip.all' : 'kv.it.grip', { a: hm(ga), b: hm(gz) }) + (gb >= 3 ? t('kv.it.grip.bend', { d: dur(gb) }) : ''))}</small>` : '';
      const cutNote = cutP ? `<span class="kv-nofc-note">${esc(t('kv.nofc.from', { k: Math.round(cutP.km), h: hm(cutP.at) }))}</span>` : '';
      const more = cutNote + ens + roadEst + grip + pass + rushes + narrow + ev + sights + rests;   // the second row, the whole width: the doubt and the wet-road estimate (right-aligned, under the weather), the pass, narrow road, reports, sights, rest areas
      return `<li class="kv-stage" data-k0="${g.km0.toFixed(2)}" data-k1="${g.km1.toFixed(2)}" tabindex="0" role="button" aria-label="${esc(t('kv.it.show'))}"><span class="kv-clk">${hm(at(g.km0))}</span><span>${label || esc(t('kv.road'))}<small>${Math.max(1, Math.round(g.km1 - g.km0))} km</small></span><span class="kv-wx">${nofc ? `<span class="kv-nofc-w">${esc(t('kv.nofc'))}</span>` : `${t('kv.c.' + cls)}${when ? `<small class="kv-when">${esc(when)}</small>` : ''}<small>${esc(temp)}</small>${road}`}</span>${more ? `<div class="kv-stmore">${more}</div>` : ''}</li>`;
    });
    rows.push(`<li><span class="kv-clk">${hm(s.end)}</span><span><b>${esc(t('kv.arrived', { p: kv.to.name || 'B' }))}</b></span><span></span></li>`);
    // the via points as their own rows, before the leg that leaves them: when you are there, the pause, the weather then
    const out = []; let vi = 0;
    legs.forEach((g, k) => { while (vi < vstops.length && vstops[vi].km <= g.km0 + 0.3) out.push(viaRow(vstops[vi++], pts)); out.push(rows[k]); });
    while (vi < vstops.length) out.push(viaRow(vstops[vi++], pts));
    out.push(rows[rows.length - 1]);
    $('kvIt').innerHTML = out.join('');
    renderOpen(s);
  }

  const viaTitle = (p, pts) => { const q = pts.find((x) => x.leave === p.stop) || p; return `${(kv.via[p.stop.j] || {}).name || t('kv.via.label')} · ${hm(p.at)}${p.stop.ms ? ' – ' + hm(q.at) : ''}`; };
  /* A via on the map: what it is (a stop you chose), when you are there, the pause (changed here as in the list), the
     weather on arriving and leaving, and a button to take it out of the route */
  function viaPlace(j, p) {
    const S = kv.S && kv.S[kv.sel], v = kv.via[j]; if (!S || !v) return null;
    const at = [+v.lat, +v.lon], r = (S.R.rest || []).find((x) => hav(x.pos, at) < 0.2);
    if (r) return { kind: 'rest', x: { ...r, at: p.at, p } };
    const g = (S.R.sights || []).find((x) => hav(x.pos, at) < 0.2);
    return g ? { kind: 'sight', x: { ...g, at: p.at, p } } : null;
  }
  const placeTag = (pl) => (pl.kind === 'rest' ? `${REST_ICON} ${esc(restKind(pl.x.it))}` : `${sightIcon(pl.x.it)} ${esc(sightKind(pl.x.it))}`);
  function viaPopup(p, pts) {
    const st = p.stop, j = st.j, v = kv.via[j] || {}, q = pts.find((x) => x.leave === st) || p, min = st.ms / 60e3;
    const wx = (x) => (x.nofc ? t('kv.nofc') : `${t('kv.c.' + x.cls)}${Number.isFinite(x.t) ? ', ' + Math.round(x.t) + '°' : ''}`);
    const el = document.createElement('div'); el.className = 'kv-sv kv-evpop kv-viapop';
    const pl = viaPlace(j, p), facts = pl ? (pl.kind === 'rest' ? restFacts(pl.x) : sightFacts(pl.x)) : [];
    el.innerHTML = `<div class="kv-sv-head"><span class="kv-viatag">${j + 1}</span><b>${esc(v.name || t('kv.via.label'))}</b></div>
      <p>${pl ? `<span class="kv-viakind">${placeTag(pl)}</span> · ` : ''}${esc(t('kv.via.what', { n: j + 1, k: Math.round(p.km) }))}</p>
      <p class="kv-ev on"><i>${esc(min ? t('kv.via.when2', { a: hm(p.at), b: hm(q.at) }) : t('kv.via.when', { a: hm(p.at) }))}</i></p>
      <p>${esc(t('kv.via.wx', { w: wx(p) }))}${min ? '<br>' + esc(t('kv.via.leave', { h: hm(q.at), w: wx(q) })) : ''}</p>
      ${facts.length ? `<ul class="kv-restfacts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
      <label class="kv-pausepick">${esc(t('kv.pause.lab'))} <select>${PAUSES.map((m) => `<option value="${m}"${m === min ? ' selected' : ''}>${esc(m ? pauseShort(m) : t('kv.pause.none'))}</option>`).join('')}</select></label>
      <p><button type="button" class="btn kv-viarm">${esc(t('kv.via.rm'))}</button></p>${pl ? `<div class="kv-sv-meta">${esc(pl.kind === 'rest' ? restSrc(pl.x.it) : sightSrc(pl.x))}</div>` : ''}`;
    el.querySelector('select').addEventListener('change', (e) => { v.pause = +e.target.value; MAP.closePopup(); render(); writeHash(); saveLast(); const S = kv.S[kv.sel], np = S.pts.find((x) => x.stop && x.stop.j === j); if (np) viaPopup(np, S.pts); });   // re-timed only; the popup reopens with the new times
    el.querySelector('.kv-viarm').addEventListener('click', () => { kv.via.splice(j, 1); MAP.closePopup(); syncForm(); go(); });   // a different route: planned again
    MAP.openPopup([p.lat, p.lon], el);
  }
  function viaRow(p, pts) {
    const st = p.stop, j = st.j, v = kv.via[j] || {}, q = pts.find((x) => x.leave === st) || p, min = st.ms / 60e3;
    const wx = (x) => (x.nofc ? t('kv.nofc') : `${t('kv.c.' + x.cls)}${Number.isFinite(x.t) ? ', ' + Math.round(x.t) + '°' : ''}`);
    const opts = PAUSES.map((m) => `<option value="${m}"${m === min ? ' selected' : ''}>${esc(m ? pauseShort(m) : t('kv.pause.none'))}</option>`).join('');
    // the pauses take the end of the trip past the forecast: said once, at the last via with a pause before the forecast ends
    const S = kv.S && kv.S[kv.sel], lastP = S && S.beyond ? S.pts.filter((x) => x.stop && x.stop.ms && !x.nofc).pop() : null;
    const past = lastP && lastP.stop === st ? `<span class="kv-nofc-note">${esc(t('kv.pause.past', { h: wday(S.beyond.at) + ' ' + hm(S.beyond.at) }))}</span>` : '';
    return `<li class="kv-stage kv-viastage" data-k0="${Math.max(0, p.km - 0.5).toFixed(2)}" data-k1="${(p.km + 0.5).toFixed(2)}" tabindex="0" role="button" aria-label="${esc(t('kv.it.show'))}">` +
      `<span class="kv-clk"><b>${hm(p.at)}</b>${min ? `<small>${esc(t('kv.pause.to', { h: hm(q.at) }))}</small>` : ''}</span>` +
      `<span><span class="kv-viatag">${j + 1}</span><b>${esc(v.name || t('kv.via.label'))}</b><small>${esc(t('kv.pause.km', { k: Math.round(p.km) }))}</small>` +
      (() => { const pl = viaPlace(j, p); return pl ? `<button type="button" class="kv-sight kv-viaplace" data-vj="${j}" title="${esc(t('kv.fly'))}">${placeTag(pl)}${pl.kind === 'rest' && pl.x.it[17] ? ' 🚻' : ''}</button>` : ''; })() +
      `<label class="kv-pausepick">${esc(t('kv.pause.lab'))} <select data-pause="${j}">${opts}</select></label>${past}</span>` +
      `<span class="kv-wx">${wx(p)}<small>${esc(min ? t('kv.pause.leave', { h: hm(q.at), w: wx(q) }) : t('kv.pause.here'))}</small></span></li>`;
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
  // the top strip of a full-screen view: its title, and a close button in the upper right corner (above Google's frame, never over its controls)
  function fullTop(title, close) {
    const top = document.createElement('div'); top.className = 'kv-svfull-top';
    const h = document.createElement('span'); h.textContent = title;
    const x = document.createElement('button'); x.type = 'button'; x.className = 'kv-svfull-cx'; x.textContent = '✕'; x.title = x.ariaLabel = t('kv.sv.close'); x.onclick = close;
    top.append(h, x); return top;
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
    o.append(fullTop(t('kv.sv.title'), close), stage, bar); document.body.appendChild(o); document.body.classList.add('kv-noscroll'); x.focus();
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

  /* ---------------- live road reports and webcams (Statens vegvesen DATEX) ----------------
     Road reports: closures, short closures, convoy driving (kolonnekjøring) and obstructions, matched to the stretch of
     the route they lie on and checked against the time you are there (Oslo time, with recurring periods such as 20–06 on
     weekdays). A closure in both directions with no signed detour, in force when you pass, stops the route; the rest are
     warnings. Webcams: Vegvesen's cameras on the map behind a button; a site can have cameras looking several ways.
     api/datex.php keeps the DATEX credentials on the server; the camera images are public. */
  const LIVE_SOURCES = {
    datex: {
      at: 0, p: null,
      reports() {   // the server refreshes every 5 minutes; so does this page
        if (!this.p || Date.now() - this.at > 5 * 60e3) { this.at = Date.now(); this.p = fetchT('api/datex.php?sit=1').then((r) => (r.ok ? r.json() : null)).then((j) => (j && Array.isArray(j.items) ? j.items : null)).catch(() => null); }
        return this.p;
      },
      cp: null, cat: 0,
      cams() {
        if (!this.cp || Date.now() - this.cat > 10 * 60e3) { this.cat = Date.now(); this.cp = fetchT('api/datex.php?cams=1').then((r) => (r.ok ? r.json() : null)).then((j) => (j && Array.isArray(j.cams) ? j.cams : null)).catch(() => null); }
        return this.cp;
      },
      rp: null, rat: 0,
      road() {   // the road-surface forecast (~400 points, ~25 hours ahead); the server refreshes every 15 minutes
        if (!this.rp || Date.now() - this.rat > 15 * 60e3) { this.rat = Date.now(); this.rp = fetchT('api/datex.php?road=1').then((r) => (r.ok ? r.json() : null)).then((j) => (j && Array.isArray(j.pts) ? j : null)).catch(() => null); }
        return this.rp;
      },
      img: (id) => `https://kamera.atlas.vegvesen.no/api/images/${encodeURIComponent(id)}?t=${Math.floor(Date.now() / 60e3)}`,   // a new image about every minute
      credit: 'Statens vegvesen',
    },
    /* Sweden and Finland (api/roads.php: Trafikverket, Fintraffic Digitraffic), in the same shapes; asked only for a route
       that goes there. Each answer is kept as long as the server keeps it. */
    abroad: {
      got: {},
      get(c, what, ttl) {
        const k = c + what, g = this.got[k];
        if (g && Date.now() - g.at < ttl) return g.p;
        const p = fetchT(`api/roads.php?c=${c}&what=${what}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        this.got[k] = { at: Date.now(), p }; p.then((j) => { if (!j) delete this.got[k]; });
        return p;
      },
      reports(c) { return this.get(c, 'sit', 5 * 60e3).then((j) => (j && Array.isArray(j.items) ? j.items : null)); },
      cams(c) { return this.get(c, 'cams', 10 * 60e3).then((j) => (j && Array.isArray(j.cams) ? j.cams : null)); },
      road(c) { return this.get(c, 'road', 15 * 60e3).then((j) => (j && Array.isArray(j.pts) ? j : null)); },
    },
  };
  const LIVE_CREDIT = { no: 'Statens vegvesen', se: 'Trafikverket', fi: 'Fintraffic / Digitraffic, CC BY 4.0' };
  const liveCredit = (cc) => LIVE_CREDIT[cc || 'no'];
  const ABROAD_LIVE = ['se', 'fi'];
  const liveAbroad = (routes) => ABROAD_LIVE.filter((c) => (routes || []).some((R) => R.countries && R.countries.has(c.toUpperCase())));
  // a camera image: Vegvesen's by id; Sweden's and Finland's at their own address (always the latest image there)
  const camImg = (c, big) => { if (!c.u) return LIVE_SOURCES.datex.img(c.id); const u = (big && c.ub) || c.u; return u + (u.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60e3); };
  function routeNear(R, maxM) {   // like routeIndex, with its own distance limit
    const g = new Map(); R.coords.forEach((c, i) => { const k = `${Math.round(c[0] * 100)},${Math.round(c[1] * 50)}`; if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
    return (lat, lon) => {
      let best = null, bd = maxM * maxM;
      const k0 = Math.round(lat * 100), k1 = Math.round(lon * 50), cs = Math.cos(lat * Math.PI / 180);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (g.get(`${k0 + a},${k1 + b}`) || []).forEach((i) => {
        const c = R.coords[i], d = ((c[0] - lat) * 111200) ** 2 + ((c[1] - lon) * 111200 * cs) ** 2; if (d < bd) { bd = d; best = R.cumKm[i]; } });
      return best;
    };
  }
  // the reports on a route: a line must run along the road (most of its points next to the route), not just cross it
  function matchReports(R, items) {
    let s = 90, w = 180, n = -90, e = -180; R.coords.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); });
    const at = routeNear(R, 40), atP = routeNear(R, 80), atRamp = routeNear(R, 15), out = [];
    items.forEach((it) => {
      if (!it.p.some(([la, lo]) => la > s - 0.01 && la < n + 0.01 && lo > w - 0.02 && lo < e + 0.02)) return;
      // a closed exit or entry ramp lies beside the main road: it counts only when the route drives along all of it
      if ((it.ramp || /avkjøringsveg|påkjøringsveg|rampe/i.test(it.loc)) && it.p.some(([la, lo]) => atRamp(la, lo) == null)) return;
      const distinct = new Set(it.p.map((q) => q.join())).size;
      const ks = it.p.map(([la, lo]) => (distinct <= 2 ? atP : at)(la, lo)), hit = ks.filter((v) => v != null);
      if (!hit.length || (distinct > 2 && hit.length < ks.length * 0.6)) return;
      const k = it.p[ks.findIndex((v) => v != null)], km0 = Math.min(...hit), km1 = Math.max(...hit);
      // Sweden and Finland give the whole stretch as a line (and the route abroad has no road numbers to compare): the
      // route must run along at least half of it, not cross it or touch its end (a side road, a connection to the main road)
      if (it.cc && it.cc !== 'no' && distinct > 1) { let len = 0; for (let i = 1; i < it.p.length; i++) len += hav(it.p[i - 1], it.p[i]); if (len > 0.15 && km1 - km0 < len * 0.5) return; }
      // another road beside the route (Fv 577 along E 16): out when the route's own road numbers there are all known and differ
      const ref = it.r ? roadName(it.r).replace(/^E(\d)/, 'E $1') : '', on = R.steps.filter((st) => st.km1 >= km0 - 0.05 && st.km0 <= km1 + 0.05);
      if (ref && on.length && on.every((st) => st.ref) && !on.some((st) => st.ref === ref)) return;
      out.push({ it, km0, km1, pos: k });
    });
    return out.sort((a, b) => a.km0 - b.km0);
  }
  async function liveRoads(routes, region, tok) {
    const src = region && LIVE_SOURCES[region.live]; if (!src) return;
    const ab = LIVE_SOURCES.abroad, cs = liveAbroad(routes);
    const [items, fc, ...more] = await Promise.all([src.reports(), src.road ? src.road() : null, ...cs.flatMap((c) => [ab.reports(c), ab.road(c)])]);
    if (tok !== kv.token) return;
    // each road-condition point carries its own start hour (t0) and steps (h, hours after it; Norway's are hourly)
    const pts = (fc ? fc.pts.map((q) => ({ ...q, t0: fc.t0 })) : []).concat(...cs.map((c, i) => ((more[2 * i + 1] || {}).pts || []).map((q) => ({ ...q, cc: c }))));
    const all = items || cs.some((c, i) => more[2 * i]) ? (items || []).concat(...cs.map((c, i) => more[2 * i] || [])) : null;
    routes.forEach((R) => { R.reports = all ? matchReports(R, all) : null; R.roadFc = pts.length ? matchRoadFc(R, { pts }) : null; });
    await Promise.all(routes.flatMap((R) => (R.reports || []).filter((r) => r.it.one).map(async (r) => { r.dir = await dirOnRoute(R, r); })));
    if (tok !== kv.token) return;
    render();
  }
  /* One direction only: DATEX names it ("i retning mot Oslo (Sørenga)") but its line does not say it reliably, and on a
     motorway both carriageways lie within the matching distance. The named place (Geonorge's place names, the town or
     district of that name nearest the report) tells it: does the route get closer to it there ('with') or further away ('opp')?
     Unknown (no such place, or the place is right there) stays null and the report shows as before, naming the direction. */
  const PLACE_TYPES = ['By', 'Tettsted', 'Bydel', 'Tettstedsdel', 'Tettbebyggelse', 'Kommune', 'Grend', 'Bygdelag (bygd)'];
  const placeHits = new Map();
  /* Geonorge's error answers carry no CORS header, so the browser sees only a failed fetch (and logs it). The names are
     asked three at a time, and after a failure the rest wait a minute: a few errors in the console, not one for every report.
     A name that failed is asked again on the next plan. */
  const placeQ = [Promise.resolve(), Promise.resolve(), Promise.resolve()]; let placeN = 0, placeDown = 0;
  function placeNamed(name) {
    const q = name.replace(/\s*\(.*\)\s*/g, ' ').trim();
    if (!q) return Promise.resolve([]);   // an empty search is a 422
    if (!placeHits.has(q)) {
      const ask = () => (Date.now() < placeDown ? Promise.reject(new Error('down')) : fetchT(`https://ws.geonorge.no/stedsnavn/v1/navn?sok=${encodeURIComponent(q)}&fuzzy=false&treffPerSide=30&utkoordsys=4258`, {}, 8000)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((j) => ((j && j.navn) || []).filter((x) => x.representasjonspunkt && String(x.skrivemåte).toLowerCase() === q.toLowerCase())
          .map((x) => ({ la: x.representasjonspunkt.nord, lo: x.representasjonspunkt.øst, rank: (PLACE_TYPES.indexOf(x.navneobjekttype) + 1) || 99 })))
        .catch((e) => { if (e.message !== 'down') placeDown = Date.now() + 60e3; throw e; }));
      const lane = placeN++ % placeQ.length, job = placeQ[lane].then(ask).catch(() => { placeHits.delete(q); return []; });
      placeQ[lane] = job; placeHits.set(q, job);
    }
    return placeHits.get(q);
  }
  // abroad: Open-Meteo's place names (GeoNames) in that country; towns first
  const abroadHits = new Map();
  function placeAbroad(name, cc) {
    const k = cc + '|' + name;
    if (!abroadHits.has(k)) abroadHits.set(k, fetchT(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&format=json&countryCode=${cc.toUpperCase()}`, {}, 8000)
      .then((r) => (r.ok ? r.json() : null)).then((j) => ((j && j.results) || []).filter((x) => String(x.name).toLowerCase() === name.toLowerCase())
        .map((x) => ({ la: x.latitude, lo: x.longitude, rank: /^PPL/.test(x.feature_code || '') ? 1 : 2 })))
      .catch(() => { abroadHits.delete(k); return []; }));
    return abroadHits.get(k);
  }
  const dirPlace = (it) => it.dp || (it.cc && it.cc !== 'no' ? null : (String(it.loc).match(/i retning mot (.+)$/) || [])[1]) || null;
  async function dirOnRoute(R, r) {
    const dp = dirPlace(r.it); if (!dp) return null;
    const hits = r.it.cc && r.it.cc !== 'no' ? await placeAbroad(dp, r.it.cc) : await placeNamed(dp); if (!hits.length) return null;
    const best = Math.min(...hits.map((h) => h.rank)), near = hits.filter((h) => h.rank === best).map((h) => ({ ...h, d: hav(r.pos, [h.la, h.lo]) })).sort((a, b) => a.d - b.d)[0];
    if (near.d > 300 || near.d < 1.5) return null;   // too far to be the place meant, or right there
    const posAt = (k) => R.coords[Math.max(0, R.cumKm.findIndex((v) => v >= k))] || R.coords[R.coords.length - 1];
    const x = [near.la, near.lo], a = hav(posAt(Math.max(0, r.km0 - 1)), x), b = hav(posAt(r.km1 + 1), x);
    return b < a - 0.3 ? 'with' : b > a + 0.3 ? 'opp' : null;
  }
  /* The road-surface forecast (Statens vegvesen): its points on or by the route (within 300 m). A weather sample uses the
     nearest one within 10 km along the route at about the same height (±200 m), at the time you are there; it is better
     than our own guess from the air temperature, so it confirms or clears "possibly slippery" there. */
  const ROAD_FC_KM = 10, ROAD_FC_DZ = 200;
  const ROAD_ORDER = ['dry', 'moist', 'wet', 'slush', 'snow', 'ice'];
  const roadKind = (c) => (!c ? null : c === 'dry' ? 'dry' : /^(moist|damp)$/i.test(c) ? 'moist' : /^(wet|surfaceWater|streamingWater|roadSurfaceMelting)$/i.test(c) ? 'wet'
    : /slush/i.test(c) ? 'slush' : /snow|winter/i.test(c) ? 'snow' : 'ice');   // slippery, icy, frost, black ice, freezing…
  function matchRoadFc(R, fc) {
    const at = routeNear(R, 300), zAt = (km) => { let b = null; R.dense.forEach((p) => { if (p.z != null && (!b || Math.abs(p.km - km) < Math.abs(b.km - km))) b = p; }); return b ? b.z : null; };
    const pts = []; fc.pts.forEach((q) => { const km = at(q.la, q.lo); if (km != null) pts.push({ ...q, km, z: zAt(km) }); });
    return { pts: pts.sort((a, b) => a.km - b.km) };
  }
  function roadAt(R, p, ms) {
    const F = R.roadFc; if (!F || !F.pts.length) return null;
    let best = null;
    F.pts.forEach((q) => { const d = Math.abs(q.km - p.km); if (d <= ROAD_FC_KM && !(q.z != null && p.z != null && Math.abs(q.z - p.z) > ROAD_FC_DZ) && (!best || d < best.d)) best = { q, d }; });
    if (!best) return null;
    // the steps: hourly from t0 (Norway), or at the hours in h (Finland: now, +2, +4, +6, +12; Sweden: now, valid 3 hours)
    const q = best.q, H = q.h || q.c.map((_, i) => i), h = Math.max(0, (ms / 1000 - q.t0) / 3600);
    if (h > H[H.length - 1] + (q.h ? 0 : 0.5)) return null;   // past the end of the forecast (~25 hours in Norway)
    let k = 0; while (k < H.length - 2 && H[k + 1] <= h) k++;
    const f = H.length > 1 ? Math.min(1, (h - H[k]) / Math.max(1e-6, H[k + 1] - H[k])) : 0, a = q.s[k], b = q.s[Math.min(k + 1, q.s.length - 1)];
    const i = f < 0.5 || H.length < 2 ? k : k + 1;   // the nearest step: its road condition, and its temperature when one of the two is missing
    const sv = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Number.isFinite(q.s[i]) ? q.s[i] : null;
    let kind = roadKind(q.c[i]);
    if (kind == null) return null;
    if ((kind === 'moist' || kind === 'wet') && sv != null && sv <= 0.5) kind = 'ice';   // a damp road at freezing: ice likely
    return { k: kind, s: sv, n: q.n, km: q.km, cc: q.cc || 'no', ob: roadObs(q, H[i]) };
  }
  // when the state used was seen, not forecast: Trafikverket's report (its own time when the server sends it, else the
  // fetch) and Fintraffic's step 0 (the observation); null for a forecast (Statens vegvesen, Fintraffic's +2 h on)
  const roadObs = (q, hs) => (q.cc === 'se' ? (q.seen || q.t0) * 1000 : q.cc === 'fi' && hs === 0 ? q.t0 * 1000 : null);
  // past the end of the road forecast (roadAt null): the nearest point's last state and its time, for the wet-road estimate
  function roadLast(R, p, ms) {
    const F = R.roadFc; if (!F || !F.pts.length) return null;
    let best = null;
    F.pts.forEach((q) => { const d = Math.abs(q.km - p.km); if (d <= ROAD_FC_KM && !(q.z != null && p.z != null && Math.abs(q.z - p.z) > ROAD_FC_DZ) && (!best || d < best.d)) best = { q, d }; });
    if (!best) return null;
    const q = best.q, H = q.h || q.c.map((_, i) => i), i = H.length - 1, at = (q.t0 + H[i] * 3600) * 1000;
    if (ms <= at) return null;
    let kind = roadKind(q.c[i]); if (kind == null) return null;
    if ((kind === 'moist' || kind === 'wet') && q.s[i] != null && q.s[i] <= 0.5) kind = 'ice';
    return { k: kind, at, ob: roadObs(q, H[i]), cc: q.cc || 'no' };
  }
  /* ---------------- a wet road after rain (motorcycle) ----------------
     Where a road authority says how the road surface is (Statens vegvesen's forecast ~25 hours, Fintraffic's 12 hours,
     Trafikverket's report now, used for 3 hours: roadAt), its moist or wet counts as "våt vei" and its dry clears it. Beyond
     that, an estimate: the road stays wet for a while after the last hour with rain, by the rain in that spell and day or
     night when it ended. The rain is MET Nordic's analysis for the last hours (api/rain.php, kvcore fetchRain) and the forecast
     after. A road the authority last saw (or forecast) moist or wet dries from that time by the `carry` minutes.
     WR is tools/wetroad/params.json, fitted 2026-10-07 on MET Frost: Statens vegvesen's road weather stations (Vaisala road
     state dry / moist / wet, 10-min rain gauges), 15 April-15 October 2022-2026, 64 stations after the quality check, 13,417
     rain events that dried before the next rain. These fixed lags ("B1") ship because the drying bucket the plan preferred
     missed its pre-set bar on the held-out stations (median drying-time error 75 vs 90 min, the bar 0.8x); B1 on test data:
     Peirce skill 0.46-0.48 (0 for "dry when the rain stops"). Its drying time is not better than that naive rule everywhere:
     on the held-out stations the median error is 90 min vs 70 for dry-at-once (mean 115 vs 123); a Finnish check day gave
     Peirce skill only 0.15. The fit is 15 April-15 October with air above +1 °C (the ice regime left out), so no estimate is
     made at or below +1 °C or after snow, sleet or freezing rain (that is the slick logic's). See tools/wetroad/README.md. */
  const WR = {
    rain: 0.1,                       // mm in an hour that counts as a rain hour
    tMin: 1,                         // °C: the fit's data had air above this (b1.py drops the ice regime)
    bins: [0.1, 0.5, 2, 5],          // the spell's rain (consecutive rain hours), mm: 0.1-0.5, 0.5-2, 2-5, 5+
    lag: [[300, 90], [360, 150], [340, 180], [350, 170]],   // minutes after the rain ends that the road is moist or wet, [bin][night, day]
    wet: [[300, 60], [240, 120], [300, 180], [300, 120]],   // of those, the minutes it is wet
    carry: { moist: [240, 60], wet: [420, 180] },           // after an observed moist / wet road: minutes until dry, [night, day] then
  };
  const WR_BACK = Math.max(...WR.lag.flat()) * 60e3;   // how far back rain can matter: the longest lag (6 hours)
  const sunUp = (lat, lon, ms) => {   // the sun above the horizon (refraction included), as api/met.php's is_day and the fit
    const d = ms / 864e5 - 10957.5, r = Math.PI / 180, g = (357.529 + 0.98560028 * d) * r, L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r, e = (23.439 - 0.00000036 * d) * r;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), ha = (((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon) * r - ra, la = lat * r;
    return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / r > -0.833;
  };
  /* The rain hours at a place: the forecast's hours (MET's first hour is a copy of the next, so not known), the observed
     hours over them where the analysis has them. F marks hours outside the fit: snow, sleet or freezing rain, or air at or
     below +1 °C (the observed hours before the forecast have no temperature: the forecast's first stands in). Kept per
     forecast set (a new fetch is a new h) and rain answer. */
  const wrMemo = new WeakMap();
  function wetRun(key, h, src) {
    const ob = rainCache.get(key), m = wrMemo.get(h);
    if (m && m.ob === ob) return m;
    const ft = h.time, obs = ob && !ob.fail && ob.r ? ob : null, t0 = Math.min(ft[0], obs ? obs.h[0] : Infinity), n = Math.round((ft[ft.length - 1] - t0) / 3600) + 1;
    const P = new Float32Array(n).fill(NaN), D = new Int8Array(n).fill(-1), T = h.temperature_2m || [], C = h.weather_code || [], T0 = T.find(Number.isFinite);
    const F = new Uint8Array(n).fill(T0 != null && T0 <= WR.tMin ? 1 : 0);
    for (let k = 0; k < ft.length; k++) { const j = Math.round((ft[k] - t0) / 3600), tk = T[k], v = h.precipitation[k]; F[j] = (Number.isFinite(tk) && tk <= WR.tMin) || SNOWY(classify(C[k] ?? 0, v ?? 0, tk)) ? 1 : 0; if ((k || src !== 'met') && Number.isFinite(v)) P[j] = v; }
    if (obs) obs.h.forEach((te, i) => { const j = Math.round((te - t0) / 3600), v = obs.r[i]; if (j >= 0 && j < n && v != null) P[j] = v / 10; });
    const [la, lo] = key.split(',').map(Number);
    const run = { ob, t0: t0 * 1000, P, F, D, day: (j) => (D[j] < 0 ? (D[j] = sunUp(la, lo, t0 * 1000 + j * 3600e3) ? 1 : 0) : D[j]), pending: !ob };   // pending: the rain answer has not come (no "not known" then)
    wrMemo.set(h, run); return run;
  }
  /* The estimate at a moment: -> {lvl, rainEnd, dryAt} | {unk: true} (an hour that could have had rain is not known) | null.
     A not-known hour does not end the search: rain before it still gives at least its wet road (rain in the hour not known
     could only make it wetter); "not known" when nothing older decides. A spell with an hour outside the fit (F) gives no
     wet road (lvl null), but its end still counts as rain after an authority's dry. */
  function estWet(key, ms, w0) {
    const W = wetRun(key, w0.h, w0.src), P = W.P;
    let j = Math.floor((ms - W.t0) / 3600e3), unk = false;   // the last hour that ends at or before ms
    if (j >= P.length) j = P.length - 1;
    for (; j >= 0 && W.t0 + j * 3600e3 >= ms - WR_BACK; j--) {
      const v = P[j];
      if (Number.isNaN(v)) { if (W.pending) return null; unk = true; continue; }
      if (v < WR.rain) continue;
      let spell = 0, cold = false; for (let q = j; q >= 0 && P[q] >= WR.rain; q--) { spell += P[q]; cold = cold || !!W.F[q]; }
      const b = spell < WR.bins[1] ? 0 : spell < WR.bins[2] ? 1 : spell < WR.bins[3] ? 2 : 3, d = W.day(j), end = W.t0 + j * 3600e3, dt = (ms - end) / 60e3;
      if (cold) return unk ? { unk: true } : { lvl: null, rainEnd: end, dryAt: end };
      const lvl = dt <= WR.wet[b][d] ? 'wet' : dt <= WR.lag[b][d] ? 'moist' : null;
      return !lvl && unk ? { unk: true } : { lvl, rainEnd: end, dryAt: end + WR.lag[b][d] * 60e3 };
    }
    return unk || (j < 0 && !W.pending && W.t0 - 3600e3 >= ms - WR_BACK) ? { unk: true } : null;   // an hour before the series (not known) could still matter
  }
  /* The road at a sample: the authority's state inside its horizon, else the estimate (with the authority's last state
     drying from its time). A forecast's dry clears; an observed dry (Trafikverket's report, Fintraffic's now: rf.ob) stands
     only until it rains after it. No estimate at or below +1 °C (outside the fit).
     -> {lvl: 'moist'|'wet', src: 'no'|'se'|'fi'|'est', from?, seen?, rainEnd?, dryAt?} | {unk: true} | null */
  function wetRoad(R, p, key, ms, rf, w0) {
    if (rf && rf.k !== 'dry') return rf.k === 'moist' || rf.k === 'wet' ? { lvl: rf.k, src: rf.cc } : null;   // slush, snow and ice are "mulig glatt"
    if (!w0 || !(p.t > WR.tMin)) return null;
    const e = estWet(key, ms, w0);
    if (rf) return rf.ob && e && e.lvl && e.rainEnd > rf.ob ? { lvl: e.lvl, src: 'est', rainEnd: e.rainEnd, dryAt: e.dryAt } : null;
    const L = roadLast(R, p, ms);
    let out = e && e.lvl ? { lvl: e.lvl, src: 'est', rainEnd: e.rainEnd, dryAt: e.dryAt } : null;
    if (L) {
      const wetL = L.k === 'moist' || L.k === 'wet', since = e && e.rainEnd > (L.ob || L.at);   // rain after the authority's last state (an observation's own time)
      if (!since && !wetL) return null;   // its dry road stands until it rains again
      const until = wetL ? L.at + WR.carry[L.k][sunUp(p.lat, p.lon, L.at) ? 1 : 0] * 60e3 : 0;
      if (wetL && ms <= until && (!out || until > out.dryAt)) out = { lvl: L.k, src: 'est', from: L.cc, seen: L.at, dryAt: until };
      if (!out && !since) return null;
    }
    return out || (e && e.unk ? e : null);
  }
  // the wet road in words: whose word it is, or the estimate with the rain's end and when it is probably dry
  const wrSrc = (c) => t('kv.wr.src.' + c);
  function wrSay(p) {
    const w = p.wr; if (!w) return '';
    if (w.src !== 'est') return `${wrSrc(w.src)}: ${t('kv.wr.' + w.lvl)}`;
    const x = [w.from ? t('kv.wr.seen', { src: wrSrc(w.from), lvl: t('kv.wr.' + w.lvl), t: hm(new Date(w.seen)) }) : w.rainEnd ? t('kv.wr.rainEnd', { t: hm(new Date(w.rainEnd)) }) : '', w.dryAt ? t('kv.wr.dryAt', { t: hm(new Date(w.dryAt)) }) : ''];
    return x.filter(Boolean).join(', ') + ` (${wrSrc('est')})`;
  }
  const wrSources = (pts) => t('kv.wr.help') + ' (' + [...new Set(pts.filter((p) => p.cls === 'damp').map((p) => wrSrc(p.wr.src)))].join(', ') + ')';
  // MC: the rain in the last hours at the samples (api/rain.php), the chosen route first, then the others; a render when new
  // answers come (kvcore keeps them to the next analysis, so most renders ask nothing)
  function loadRain(tok) {
    const R0 = kv.routes[kv.sel], keys = (Rs) => Rs.flatMap((R) => (R.samples || []).map((x) => x.key));
    if (!R0) return;
    const stop = () => tok !== kv.token || kv.veh !== 'mc';
    fetchRain(keys([R0]), stop).then((n) => { if (n && !stop()) render(); return stop() ? 0 : fetchRain(keys(kv.routes.filter((R) => R !== R0)), stop); })
      .then((n) => { if (n && !stop()) render(); }).catch((e) => console.warn('Kjørevær recent rain', e));
  }
  const tzFmts = {};
  const tzFmt = (tz) => (tzFmts[tz] ||= new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }));
  const inHours = (h, s, e) => (s <= e ? h >= s && h <= e : h >= s || h <= e);
  function inForce(it, ms) {   // is the report in force at this moment (the recurring periods in the report's own time: Oslo, Stockholm, Helsinki)
    if (it.from && ms < it.from * 1000) return false;
    if (it.to && ms > it.to * 1000) return false;
    if ((!it.per || !it.per.length) && !it.win) return true;
    const pr = Object.fromEntries(tzFmt(it.tz || 'Europe/Oslo').formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(pr.weekday) + 1, h = `${pr.hour === '24' ? '00' : pr.hour}:${pr.minute}`;
    // dated windows (Sweden): inside one, and at its times of day when it has them
    if (it.win) return it.win.some(([a, b, s, e]) => ms >= a * 1000 && ms <= b * 1000 && (!s || inHours(h, s, e)));
    return it.per.some((q) => q.d.includes(dow) && inHours(h, q.s, q.e));
  }
  function timeAtKm(s, km) {
    const pts = s.pts; let i = pts.findIndex((p) => p.km >= km); if (i <= 0) return +pts[i < 0 ? pts.length - 1 : 0].at;
    const a = pts[i - 1], b = pts[i], f = (km - a.km) / Math.max(1e-6, b.km - a.km); return +a.at + f * (b.at - a.at);
  }
  function liveOn(s) {   // the route's reports with the time you are there
    return (s.R.reports || []).map((r) => {
      const at = timeAtKm(s, r.km0), opp = r.dir === 'opp', on = !opp && inForce(r.it, at);
      return { ...r, at: new Date(at), on, opp, veto: on && r.it.k === 'closed' && !r.it.one && !r.it.det };
    });
  }
  const placeLoc = (loc) => String(loc || '').split(' - ')[0].replace(/^(E\s?\d+|[RFK]v\.\s?\d+)\s*(\([^)]*\)\s*)?(\[\d+\]\s*)?/, '').replace(/,.*$/, '').trim() || loc;
  const placeOf = (it) => it.pl || placeLoc(it.loc);
  const dirOf = (it, dir) => { const p = dirPlace(it); return !p ? t('kv.dir.one') : t(dir === 'with' ? 'kv.dir.yours' : dir === 'opp' ? 'kv.dir.opp' : 'kv.dir.to', { p }); };
  // what the report says: Finland's in words of the page's language (its own texts are Finnish only; they show as the details)
  const FX_ORDER = ['closed', 'sclosed', 'stops', 'onecw', 'lanes', 'narrow', 'alt', 'contra', 'lights', 'detour', 'accident', 'queue', 'speed', 'delay', 'gravel', 'milled'];
  const evText = (it) => {
    if (!it.fx) return it.t;
    const xs = it.fx.map((c) => c.split(':')).filter(([k]) => FX_ORDER.includes(k)).sort((a, b) => FX_ORDER.indexOf(a[0]) - FX_ORDER.indexOf(b[0]));
    return xs.map(([k, n]) => t('kv.fx.' + k, { n })).join('. ') || it.t;
  };
  // a closure with a signed detour is a detour for you, not a closed road
  const evKind = (e) => (e.it.k === 'closed' && e.it.det && !e.veto ? 'detour' : e.it.k);
  const evLabel = (e) => t('kv.ev.' + evKind(e)) + (e.it.rw && /^(closed|detour|short)$/.test(evKind(e)) ? ' · ' + t('kv.ev.rw') : '') + (e.it.one && /^(closed|detour|short)$/.test(evKind(e)) ? ' ' + dirOf(e.it, e.dir) : '');
  const evWhen = (e) => t(e.opp ? 'kv.ev.opp' : e.on ? 'kv.ev.when' : 'kv.ev.notnow', { h: hm(e.at) });
  const evIcon = (e) => LIVE_ICON[evKind(e)];
  /* "Vis:" in the planner: the road reports and the narrow roads, both on by default. Off is off everywhere (route
     cards and their verdict, stages, chart and map), closures included; the slippery-road warnings, the darkness and
     the weather always show. Only what is shown changes, so the routes are not fetched again. */
  const showReports = () => lsGet('glett.kv.reports') !== '0', showRest = () => lsGet('glett.kv.rest') === '1';
  const showNarrow = () => !!kv.opts.noNarrow, narrowW = () => (NARROW_W.includes(+kv.opts.narrowW) ? +kv.opts.narrowW : 4);   // the route option "Smale veier: bare bredere enn …" also marks what is left
  const mtr = (w) => w.toLocaleString(dateLocale());
  const shownLive = (s) => (showReports() ? s.live || [] : []);
  const blocked = (s) => s.R.obstructed || shownLive(s).some((e) => e.veto);
  function showLabels() {
    [['kvReports', showReports(), 'kv.show.reportsHelp'], ['kvRest', showRest(), 'kv.show.restHelp']].forEach(([id, on, help]) => { const b = $(id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.title = t(help); });
    showSum();
  }
  // "Vis langs ruten": what is on, in one line while the section is closed (so rest areas on the map never surprise)
  function showSum() {
    const el = $('kvShowSum'); if (!el) return; const P = sightPrefs(), name = (k) => t(k).replace(/^[^\p{L}]+/u, '');
    const on = [[showReports(), t('kv.show.reports')], [showRest(), t('kv.show.rest')]].filter(([v]) => v).map(([, x]) => x)
      .concat(SIGHT_CATS.filter((c) => P.cats[c]).map((c) => name('kv.sg.c.' + c)));
    el.textContent = !on.length ? t('kv.show.none') : on.length > 3 ? on.slice(0, 3).join(', ') + ' +' + (on.length - 3) : on.join(', ');
  }
  const liveOnMap = (e) => !e.opp && (e.on || !/^(works|limit)$/.test(e.it.k));   // roadworks only when they are in force when you pass
  const LIVE_ICON = { closed: '⛔', detour: '↪\uFE0E', short: '⛔', convoy: '🚙', hazard: '⚠', works: '🚧', limit: '⚠' };
  function liveBadge(e) {
    const p = placeOf(e.it), k = e.it.k;
    // one direction only: DATEX names the direction ("i retning mot Oslo"); the line itself does not say it reliably
    if (k === 'closed') return e.veto ? ['ice', t('kv.b.dclosed', { p, h: hm(e.at) })] : e.it.det ? ['warn', t('kv.b.ddetour', { p, d: e.it.one ? ' ' + dirOf(e.it, e.dir) : '' })] : ['warn', t('kv.b.done', { p, d: dirOf(e.it, e.dir) })];
    return ['warn', t('kv.b.d' + k, { p, x: evText(e.it).replace(/\.$/, '') })];
  }

  /* webcams: a button on the map; the icons; a click shows the camera (the directions as buttons), the image larger on a click */
  const roadName = (r) => String(r).replace(/^([ERFK])(\d)/, (m, a, b) => ({ E: 'E', R: 'Rv ', F: 'Fv ', K: 'Kv ' }[a] + b));   // DATEX "R5" -> "Rv 5"
  const camOn = () => lsGet('glett.kv.cams') === '1';
  const camDir = (c, i) => (c.sfc ? t('kv.cam.sfc') : c.deg != null ? t('kv.sv.facing', { d: t('kv.dir.' + ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round((((c.deg % 360) + 360) % 360) / 45) % 8]) })
    : !c.d ? t('kv.cam.n', { n: i + 1 }) : /^varier/i.test(c.d) ? t('kv.cam.varies') : t('kv.cam.toward', { p: c.d }));
  let camList = null;
  async function loadCams() {
    const src = LIVE_SOURCES[(kv.region || KV_REGIONS[0]).cams]; if (!src) return null;
    const cs = liveAbroad(kv.routes), [no, ...ab] = await Promise.all([src.cams(), ...cs.map((c) => LIVE_SOURCES.abroad.cams(c))]);
    camList = no || ab.some(Boolean) ? (no || []).concat(...ab.filter(Boolean)) : null; return camList;
  }
  const CAM_NEAR_M = 500;   // cameras by the chosen route only (500 m: the ones at a junction too)
  function camsNearRoute() {
    const near = new Set(); if (!camList || !kv.S) return near;
    const at = routeNear(kv.S[kv.sel].R, CAM_NEAR_M); camList.forEach((c, i) => { if (at(c.la, c.lo) != null) near.add(i); });
    return near;
  }
  async function camsShow() {
    $('kvCams').setAttribute('aria-pressed', camOn() ? 'true' : 'false');
    if (!camOn()) { MAP.cams(null); return; }
    $('kvCams').classList.add('busy');
    const list = await loadCams();
    $('kvCams').classList.remove('busy');
    if (!list) { toast(t('kv.cam.fail')); return; }
    if (!camOn()) return;
    const near = camsNearRoute(); MAP.cams(list, near);
    if (kv.S && !near.size) toast(t('kv.cam.none'));
  }
  function camShot(site, idx, big) {   // the image with the direction it looks; the directions as buttons below
    const box = document.createElement('div'); box.className = 'kv-cam' + (big ? ' big' : '');
    const shot = document.createElement('div'); shot.className = 'kv-sv-shot kv-cam-shot';
    const img = document.createElement('img'); img.alt = ''; img.draggable = false; img.decoding = 'async';
    const dir = document.createElement('span'); dir.className = 'kv-sv-dir';
    const msg = document.createElement('div'); msg.className = 'kv-sv-msg'; msg.hidden = true;
    shot.append(img, dir, msg);
    const row = document.createElement('div'); row.className = 'kv-cam-dirs';
    const set = (i) => {
      idx = i; const c = site.c[i];
      dir.textContent = camDir(c, i); img.alt = `${site.n} – ${camDir(c, i)}`;
      msg.hidden = true; img.hidden = false; shot.classList.add('loading');
      if (c.f) { img.hidden = true; msg.hidden = false; msg.textContent = t('kv.cam.fault'); shot.classList.remove('loading'); }
      else img.src = camImg(c, big);
      row.querySelectorAll('button').forEach((b, k) => b.setAttribute('aria-pressed', k === i ? 'true' : 'false'));
      box.onchange && box.onchange(i);
      if (!big) MAP.fitPopup();
    };
    img.onload = () => { shot.classList.remove('loading'); if (!big) MAP.fitPopup(); };
    img.onerror = () => { shot.classList.remove('loading'); img.hidden = true; msg.hidden = false; msg.textContent = t('kv.cam.err'); };
    if (site.c.length > 1) site.c.forEach((c, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'kv-chip small'; b.textContent = camDir(c, i) + (c.f ? ' ✕' : ''); b.onclick = (e) => { e.stopPropagation(); set(i); }; row.appendChild(b); });
    box.append(shot); if (site.c.length > 1) box.append(row);
    box.set = set; box.idx = () => idx; box.shot = shot;
    set(idx);
    // a fresh image every minute while it is open
    box.timer = setInterval(() => { if (!box.isConnected) { clearInterval(box.timer); return; } if (!site.c[idx].f) img.src = camImg(site.c[idx], big); }, 60e3);
    return box;
  }
  function camFull(site, idx) {   // the camera large, over the whole screen; Escape or ✕ closes, ← → change direction
    const o = document.createElement('div'); o.className = 'kv-svfull kv-camfull'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', site.n);
    const stage = document.createElement('div'); stage.className = 'kv-svfull-stage';
    const cam = camShot(site, idx, true); stage.appendChild(cam);
    const bar = document.createElement('div'); bar.className = 'kv-sv-ctl';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'kv-svfull-x'; x.textContent = '✕ ' + t('kv.sv.close');
    const name = document.createElement('span'); name.className = 'kv-svfull-hint'; name.textContent = `${site.n}${site.r ? ' · ' + roadName(site.r) : ''} · © ${liveCredit(site.cc)}`;
    bar.append(x, name);
    const close = () => { clearInterval(cam.timer); o.remove(); document.removeEventListener('keydown', key); document.body.classList.remove('kv-noscroll'); };
    const key = (e) => { if (e.key === 'Escape') close(); else if (site.c.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) cam.set((cam.idx() + (e.key === 'ArrowRight' ? 1 : site.c.length - 1)) % site.c.length); };
    x.onclick = close; document.addEventListener('keydown', key);
    o.append(fullTop(site.n + (site.r ? ' · ' + roadName(site.r) : ''), close), stage, bar); document.body.appendChild(o); document.body.classList.add('kv-noscroll'); x.focus();
  }
  const camTip = (c) => `${c.n} · ${c.c.length > 1 ? t('kv.cam.dirs', { n: c.c.length }) : camDir(c.c[0], 0)}${c.c.every((x) => x.f) ? ' · ' + t('kv.cam.fault') : ''}`;
  const liveTitle = (e) => `${evLabel(e)}: ${placeOf(e.it)} – ${evText(e.it)} (${evWhen(e)})`;
  const rushTitle = (r) => { const z = r.pts && r.pts.length > 1 && r.pts[r.pts.length - 1]; return z ? t('kv.it.rusha', { p: r.name, q: z.name, h: hm(r.at), h2: hm(z.at) }) : t('kv.it.rush', { p: r.name, h: hm(r.at) }); };
  const rushSpans = (hs) => { const out = []; [...hs].sort((a, b) => a - b).forEach((h) => { const l = out[out.length - 1]; if (l && h === l[1]) l[1] = h + 1; else out.push([h, h + 1]); }); return out.map(([a, b]) => `${String(a).padStart(2, '0')}–${String(b % 24).padStart(2, '0')}`).join(t('kv.rush.and')); };
  // a typical weekday (bars, the rush hours stronger) against a weekend (line) at one counting point; the hour you pass is marked
  function rushChart(m) {
    const W = 240, H = 64, bw = W / 24, top = Math.max(1, ...m.wd, ...m.we), y = (v) => H - 2 - (v / top) * (H - 6), hr = +Object.fromEntries(rushFmt.formatToParts(m.at).map((x) => [x.type, x.value])).hour % 24;
    const bars = m.wd.map((v, h) => `<rect x="${(h * bw + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - 2 - y(v)).toFixed(1)}" class="${m.hours.includes(h) ? 'r' : ''}"/>`).join('');
    const we = m.we.map((v, h) => `${(h * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const ticks = [0, 6, 12, 18].map((h) => `<text x="${(h * bw + 1).toFixed(1)}" y="${H + 11}">${String(h).padStart(2, '0')}</text>`).join('');
    return `<svg class="kv-rushchart" viewBox="0 -2 ${W} ${H + 14}" role="img" aria-label="${esc(t('kv.rush.chart'))}">${bars}<polyline points="${we}"/><rect class="you" x="${(hr * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H - 2}"/>${ticks}</svg>
      <div class="kv-rushkey"><span class="b"></span>${esc(t('kv.rush.wd'))} <span class="l"></span>${esc(t('kv.rush.we'))} <span class="y"></span>${esc(t('kv.rush.you'))}</div>`;
  }
  function rushPopup(r, j = 0) {   // one counting point of a rush area: where, when you pass, the usual rush hours and the day's traffic
    const m = r.pts[j], peak = Math.max(...m.wd), more = r.pts.length < 2 ? [] : r.pts.map((x, k) => `<button type="button" class="kv-rushgo${k === j ? ' on' : ''}" data-j="${k}" aria-pressed="${k === j}">${esc(x.name)} <span>${hm(x.at)}</span></button>`);
    const el = document.createElement('div'); el.className = 'kv-sv kv-rushpop';
    el.innerHTML = `<div class="kv-sv-head">🚙 <b>${esc(t('kv.rush.head'))}</b> · km ${Math.round(m.km)}</div>
      <p><b>${esc(m.full)}</b>${m.road ? ` · ${esc(m.road)}` : ''}</p>
      <p>${esc(t('kv.rush.pass', { h: hm(m.at) }))}<br>${esc(t('kv.rush.hours', { s: rushSpans(m.hours) }))}<br><small>${esc(t('kv.rush.peak', { n: (Math.round(peak / 100) * 100).toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'nb-NO') }))}</small></p>
      ${rushChart(m)}
      ${more.length ? `<div class="kv-rushmore"><small>${esc(t('kv.rush.more', { n: r.pts.length }))}</small><div>${more.join('')}</div></div>` : ''}
      <p><small>${esc(t('kv.rush.note'))}</small></p>
      <div class="kv-sv-meta">© Statens vegvesen, Trafikkdata (NLOD)</div>`;
    el.addEventListener('click', (ev) => { const b = ev.target.closest('.kv-rushgo:not(.on)'); if (b) { ev.stopPropagation(); rushGo(r, +b.dataset.j); } });
    MAP.openPopup(m.pos, el);
  }
  function rushGo(r, j) {   // from one point's popup to another's: the map flies there, pulses a kilometre of road, and opens it
    const s = kv.S && kv.S[kv.sel], m = r.pts[j]; if (!s) return; MAP.closePopup();
    const coords = s.R.coords.filter((_, i) => Math.abs(s.R.cumKm[i] - m.km) <= 0.5);
    if (coords.length > 1) MAP.highlight(coords, 15); else MAP.focus(m.pos);
    setTimeout(() => rushPopup(r, j), 1500);
  }
  function livePopup(e) {   // a road report on the map: the whole message
    const el = document.createElement('div'); el.className = 'kv-sv kv-evpop';
    el.innerHTML = `<div class="kv-sv-head">${evIcon(e)} <b>${esc(evLabel(e))}</b> · km ${Math.round(e.km0)}</div>
      <p><b>${esc(e.it.loc)}</b></p><p>${esc(evText(e.it))}</p>${e.it.fx && e.it.t ? `<p lang="fi">${esc(e.it.t)}</p>` : ''}${e.it.more ? `<p${e.it.cc === 'fi' ? ' lang="fi"' : ''}>${esc(e.it.more)}</p>` : ''}
      <p class="kv-ev ${e.veto ? 'stop' : e.on ? 'on' : 'off'}"><i>${esc(evWhen(e))}</i></p>
      <div class="kv-sv-meta">${e.it.cc && e.it.cc !== 'no' ? esc(t('kv.cn.' + e.it.cc.toUpperCase())) + ' · ' : ''}© ${esc(liveCredit(e.it.cc))}</div>`;
    MAP.openPopup(e.pos, el);
  }
  function camClick(i) {
    const site = camList && camList[i]; if (!site) return;
    const el = document.createElement('div'); el.className = 'kv-sv kv-campop';
    const head = document.createElement('div'); head.className = 'kv-sv-head';
    head.innerHTML = `<span>📷 <b>${esc(site.n)}</b>${site.r ? ' · ' + esc(roadName(site.r)) : ''}</span>`;
    const start = Math.max(0, site.c.findIndex((c) => !c.f));
    const cam = camShot(site, start, false);
    cam.shot.tabIndex = 0; cam.shot.setAttribute('role', 'button'); cam.shot.setAttribute('aria-label', t('kv.cam.big'));
    const zoom = document.createElement('span'); zoom.className = 'kv-sv-zoom'; zoom.textContent = '⛶'; zoom.setAttribute('aria-hidden', 'true'); cam.shot.appendChild(zoom);
    cam.shot.onclick = () => camFull(site, cam.idx()); cam.shot.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); camFull(site, cam.idx()); } };
    const meta = document.createElement('div'); meta.className = 'kv-sv-meta';
    meta.textContent = `${site.cc ? t('kv.cn.' + site.cc.toUpperCase()) + ' · ' : ''}© ${liveCredit(site.cc)} · ${t(site.cc === 'fi' ? 'kv.cam.meta10' : site.cc === 'se' ? 'kv.cam.metaFew' : 'kv.cam.meta')} · ${t('kv.cam.big')}`;
    el.append(head, cam, meta);
    MAP.openPopup([site.la, site.lo], el);
  }
  /* ---------------- sights along the route ----------------
     Built monthly from open data by tools/poi/build.mjs into data/poi/ (grid cells of 0.5° latitude × 1° longitude): a
     hand-picked list of well-known sights (rank 3), Riksantikvaren's stave churches (3), medieval (2) and other protected
     churches (1), NGU's geosites for tourism (2), and Statens vegvesen's National Tourist Routes. Each sight gets its km on
     the route, so the time you pass it, the weather then and whether it is dark. How far off the road it may be: a
     well-known sight 10 km (a detour), a church 3 km, the rest 1 km (seen from the road). Nothing within 10 km of A or B:
     the places you start and end in, you know. */
  const SIGHT_CATS = ['natur', 'kultur', 'turistveg', 'vern'];
  const SIGHT_ICON = { foss: '💧', bre: '🧊', fjell: '⛰', stav: '⛪', kirke: '⛪', fyr: '🗼', bru: '🌉', veg: '🛣', utsikt: '🔭' };
  const sightIcon = (it) => SIGHT_ICON[it[3]] || (it[1] === 'natur' ? '🏞' : '🏛');
  const SIGHT_END_KM = 10, SIGHT_TVG_M = 150;
  const sightMax = (it) => (it[2] >= 3 ? 10 : /^(stav|kirke)$/.test(it[3]) ? 3 : 1);
  function sightPrefs() {   // {cats: {natur, kultur, turistveg}, more}; none chosen = off
    let v = null; try { v = JSON.parse(lsGet('glett.kv.sights') || 'null'); } catch (e) { /* default */ }
    return v && v.cats ? v : { cats: {}, more: false };
  }
  const sightsOn = () => { const p = sightPrefs(); return SIGHT_CATS.some((c) => p.cats[c]); };
  const SIGHTS = {
    idx: null, cells: new Map(), tv: null, vn: null,
    index() { return (this.idx ||= fetchT('data/poi/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => { this.idx = null; return null; })); },
    cell(c, v) { if (!this.cells.has(c)) this.cells.set(c, fetchT(`data/poi/${c}.json?v=${v}`).then((r) => (r.ok ? r.json() : [])).catch(() => { this.cells.delete(c); return []; })); return this.cells.get(c); },
    routes(v) { return (this.tv ||= fetchT(`data/poi/turistveg.json?v=${v}`).then((r) => (r.ok ? r.json() : [])).catch(() => { this.tv = null; return []; })); },
    vern(v) { return (this.vn ||= fetchT(`data/poi/vern.json?v=${v}`).then((r) => (r.ok ? r.json() : [])).catch(() => { this.vn = null; return []; })); },
  };
  async function loadSights(routes, region, tok) {
    if (!region || !region.sights) return;
    const idx = await SIGHTS.index(); if (!idx || tok !== kv.token) return;
    const have = new Set(idx.cells), need = new Set();   // the cells within reach of each route (10 km: ±0.1° latitude, ±0.3° longitude)
    routes.forEach((R) => R.coords.forEach(([la, lo], i) => { if (i % 3) return; for (const a of [-0.1, 0, 0.1]) for (const b of [-0.3, 0, 0.3]) { const c = `${Math.floor((la + a) * 2)}_${Math.floor(lo + b)}`; if (have.has(c)) need.add(c); } }));
    const [lists, tv, vn] = await Promise.all([Promise.all([...need].map((c) => SIGHTS.cell(c, idx.v))), SIGHTS.routes(idx.v), SIGHTS.vern(idx.v)]);
    if (tok !== kv.token) return;
    const all = lists.flat();
    routes.forEach((R) => { R.sights = matchSights(R, all); R.tvg = matchTvg(R, tv); R.vern = matchVern(R, vn); });
    render();
  }
  function matchSights(R, all) {
    const S = []; R.coords.forEach((c, i) => { if (!S.length || R.cumKm[i] - S[S.length - 1].km >= 0.25) S.push({ la: c[0], lo: c[1], km: R.cumKm[i] }); });
    const A = [+kv.from.lat, +kv.from.lon], B = [+kv.to.lat, +kv.to.lon], out = [];
    all.forEach((it) => {
      const p = [it[5], it[6]]; if (hav(p, A) < SIGHT_END_KM || hav(p, B) < SIGHT_END_KM) return;
      const mx = sightMax(it), cs = Math.cos(p[0] * Math.PI / 180); let best = null;
      for (const q of S) { const dy = (q.la - p[0]) * 111.2; if (Math.abs(dy) > mx) continue; const dx = (q.lo - p[1]) * 111.2 * cs, d = Math.hypot(dx, dy); if (d <= mx && (!best || d < best.d)) best = { d, km: q.km }; }
      if (best) out.push({ it, d: best.d, km: best.km, pos: p });
    });
    return out.sort((a, b) => a.km - b.km);
  }
  function matchTvg(R, tv) {   // the stretches of the route along a National Tourist Route (2 km or more)
    const at = routeNear(R, SIGHT_TVG_M), out = [];
    tv.forEach((r) => {
      const ks = []; r.l.forEach((l) => l.forEach((q, i) => { const nx = l[i + 1], n = nx ? Math.max(1, Math.ceil(hav(q, nx) / 0.2)) : 1; for (let j = 0; j < n; j++) { const f = j / n, k = at(q[0] + (nx ? (nx[0] - q[0]) * f : 0), q[1] + (nx ? (nx[1] - q[1]) * f : 0)); if (k != null) ks.push(k); } }));
      if (ks.length < 10) return;
      const km0 = Math.min(...ks), km1 = Math.max(...ks); if (km1 - km0 >= 2) out.push({ n: r.n, url: r.url, km0, km1 });
    });
    return out.sort((a, b) => a.km0 - b.km0);
  }
  // national parks and landscape protection areas the route runs through: stretches inside (gaps under 2 km closed, 1 km or more)
  const inLaLoRing = (la, lo, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [ya, xa] = r[i], [yb, xb] = r[j]; if ((ya > la) !== (yb > la) && lo < (xb - xa) * (la - ya) / (yb - ya) + xa) c = !c; } return c; };
  const inArea = (la, lo, a) => la >= a.b[0] && la <= a.b[2] && lo >= a.b[1] && lo <= a.b[3] && a.g.some((pl) => inLaLoRing(la, lo, pl[0]) && !pl.slice(1).some((h) => inLaLoRing(la, lo, h)));
  function matchVern(R, vn) {
    let s = 90, w = 180, n = -90, e = -180; R.coords.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); });
    const cand = vn.filter((a) => a.b[0] <= n && a.b[2] >= s && a.b[1] <= e && a.b[3] >= w); if (!cand.length) return [];
    const S = []; R.coords.forEach((c, i) => { if (!S.length || R.cumKm[i] - S[S.length - 1].km >= 0.5) S.push({ la: c[0], lo: c[1], km: R.cumKm[i] }); });
    const out = [];
    cand.forEach((a) => {
      const spans = []; S.forEach((q) => { if (!inArea(q.la, q.lo, a)) return; const l = spans[spans.length - 1]; if (l && q.km - l.km1 < 2) l.km1 = q.km; else spans.push({ km0: q.km, km1: q.km }); });
      spans.filter((x) => x.km1 - x.km0 >= 1).forEach((x) => out.push({ n: a.n, r: a.r, u: a.u, a, km0: x.km0, km1: x.km1 }));
    });
    return out.sort((x, y) => x.km0 - y.km0);
  }
  const vernFor = (s) => { const P = sightPrefs(); return P.cats.vern && s.R.vern ? s.R.vern.filter((v) => P.more || v.r >= 3) : []; };
  function sightsFor(s) {   // the chosen categories, with the time you are there, the weather then and the light
    const P = sightPrefs(); if (!s.R.sights) return [];
    return s.R.sights.filter((x) => P.cats[x.it[1]] && (P.more || x.it[2] >= 3) && !isVia(x.pos)).map((x) => {
      const at = timeAtKm(s, x.km), p = s.pts.reduce((b, q) => (Math.abs(q.km - x.km) < Math.abs(b.km - x.km) ? q : b), s.pts[0]);
      return { ...x, at: new Date(at), p };
    });
  }
  const tvgFor = (s) => (sightPrefs().cats.turistveg && s.R.tvg) || [];
  const sightKind = (it) => t('kv.sg.s.' + (it[3] === 'kirke' && it[2] === 2 ? 'mkirke' : it[3]));
  const sightOff = (x) => (x.d >= 1.5 ? t('kv.sg.detour', { km: Math.round(x.d) }) : x.d >= 0.4 ? t('kv.sg.off', { m: Math.round(x.d * 10) * 100 }) : '');
  const sightWhen = (x) => [t('kv.sg.when', { h: hm(x.at) }), Number.isFinite(x.p.t) ? `${t('kv.c.' + x.p.cls)}, ${Math.round(x.p.t)}°` : '', x.p.dark ? t('kv.sg.dark') : ''].filter(Boolean).join(' · ');
  const sightTitle = (x) => `${x.it[4]} – ${sightKind(x.it)} · ${sightWhen(x)}`;
  const SIGHT_SRC = { kv: 'Kartverket', ra: 'Riksantikvaren', ngu: 'NGU' };
  const sightSrc = (x) => { const src = SIGHT_SRC[(String(x.it[0]).match(/^[a-z]+/) || [''])[0]] || ''; return src ? '© ' + src : ''; };
  const sightFacts = (x) => { const off = sightOff(x); return [esc(off || ''), x.it[7] ? `<a href="${esc(x.it[7])}" target="_blank" rel="noopener">${esc(t('kv.sg.read'))} ↗</a>` : ''].filter(Boolean); };   // a sight as a via: how far off the road, and where to read more
  function sightPopup(x) {
    const el = document.createElement('div'); el.className = 'kv-sv kv-evpop kv-sightpop';
    const src = SIGHT_SRC[(String(x.it[0]).match(/^[a-z]+/) || [''])[0]] || '', off = sightOff(x);
    el.innerHTML = `<div class="kv-sv-head">${sightIcon(x.it)} <b>${esc(x.it[4])}</b></div>
      <p>${esc(sightKind(x.it))} · km ${Math.round(x.km)}${off ? ' · ' + esc(off) : ''}</p>
      <p class="kv-ev ${x.p.dark ? 'off' : 'on'}"><i>${esc(sightWhen(x))}</i></p>
      ${x.it[7] ? `<p><a href="${esc(x.it[7])}" target="_blank" rel="noopener">${esc(t('kv.sg.read'))} ↗</a></p>` : ''}
      <p><button type="button" class="btn kv-sgstop">${esc(t(stopAt(x.pos) >= 0 ? 'kv.sg.unstop' : 'kv.sg.stop'))}</button></p>
      <div class="kv-sv-meta">${src ? '© ' + esc(src) : ''}</div>`;
    el.querySelector('.kv-sgstop').addEventListener('click', () => sightStop(x));
    MAP.openPopup(x.pos, el);
  }
  const stopAt = (p) => kv.via.findIndex((v) => hav([+v.lat, +v.lon], p) < 0.2);
  /* A sight as a stop: a via point in its order along the route, and the routes again; the same button takes it out */
  const sightStop = (x) => addStop(x.pos, x.km, x.it[4]);
  function addStop(pos, km, name) {
    const k = stopAt(pos);
    if (k >= 0) kv.via.splice(k, 1);
    else {
      if (kv.via.length >= MAX_VIA) { toast(t('kv.sg.full')); return; }
      const R = kv.S[kv.sel].R, kmOf = (p) => { let b = 0, bd = Infinity; R.coords.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + ((c[1] - p[1]) * Math.cos(c[0] * Math.PI / 180)) ** 2; if (d < bd) { bd = d; b = R.cumKm[i]; } }); return b; };
      let i = kv.via.findIndex((v) => kmOf([+v.lat, +v.lon]) > km); if (i < 0) i = kv.via.length;
      kv.via.splice(i, 0, { lat: pos[0], lon: pos[1], name });
    }
    MAP.closePopup(); syncForm(); go();
  }
  /* ---------------- rest areas along the route ----------------
     Statens vegvesen's rest areas (NVDB object type 39, NLOD), built monthly by tools/rest/build.py into data/rest/rest.json.
     Abroad, for a route that goes there: Sweden (Trafikverket, CC0) and Finland (Väylävirasto, CC BY 4.0) through
     api/rest.php, in the same rows plus the country and the facts Norway's rows have no column for.
     A rest area within 250 m of the route counts; one closed for the winter on the day you pass is left out (no dates in
     NVDB: closed November to April). Off unless chosen under "Vis:". */
  const REST_M = 250, REST_MAX = 4;
  const REST_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 9h16M7 9l-3 9M17 9l3 9M3 14h18"/></svg>';
  const restSets = {};   // 'no', 'se', 'fi': a promise of the rows (a failed one is dropped, so it is asked again next time)
  const restSet = (c) => (restSets[c] ||= fetchT(c === 'no' ? 'data/rest/rest.json' : `api/rest.php?c=${c}`, c === 'no' ? { cache: 'no-cache' } : {})
    .then((r) => (r.ok ? r.json() : null)).then((j) => (j && Array.isArray(j.pts) ? j.pts : null)).catch(() => null)
    .then((pts) => { if (!pts) delete restSets[c]; return pts; }));
  function loadRest(routes, region, tok) {
    if (!region || !region.rest || !showRest() || !routes) return;
    const abroad = ['se', 'fi'].filter((c) => routes.some((R) => R.countries && R.countries.has(c.toUpperCase())));
    Promise.all(['no', ...abroad].map(restSet)).then((sets) => {
      if (tok !== kv.token || !sets[0]) return;
      const all = sets.flatMap((x) => x || []);
      routes.forEach((R) => { if (!R.rest) R.rest = matchRest(R, all); }); render();
    });
  }
  function matchRest(R, all) {
    let s = 90, w = 180, n = -90, e = -180; R.coords.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); });
    const at = routeNear(R, REST_M), out = [];
    all.forEach((it) => { if (it[2] < s - 0.01 || it[2] > n + 0.01 || it[3] < w - 0.02 || it[3] > e + 0.02) return; const km = at(it[2], it[3]); if (km != null) out.push({ it, km, pos: [it[2], it[3]] }); });
    return out.sort((a, b) => a.km - b.km);
  }
  const osloMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', month: '2-digit', day: '2-digit' });
  function restClosed(it, d) {   // closed for the winter on that day
    if (it[14] !== 'closed') return false;
    return inSpan(d, it[15] || '11-01', it[16] || '04-30');
  }
  const inSpan = (d, a, b) => { const md = osloMD.format(d); return a <= b ? md >= a && md <= b : md >= a || md <= b; };
  const toiletOpen = (x) => { const w = x.it[17]; return !!w && !(w[3] === 1 && inSpan(x.at, w[4] || '10-15', w[5] || '05-01')); };   // a toilet there and open on the day you pass
  function restFor(s) {   // with the time you are there and the weather then; the ones closed for the winter left out
    if (!showRest() || !s.R.rest) return [];
    return s.R.rest.map((x) => ({ ...x, at: new Date(timeAtKm(s, x.km)), p: s.pts.reduce((b, q) => (Math.abs(q.km - x.km) < Math.abs(b.km - x.km) ? q : b), s.pts[0]) })).filter((x) => !restClosed(x.it, x.at) && !isVia(x.pos));
  }
  const isVia = (pos) => kv.via.some((v) => hav([+v.lat, +v.lon], pos) < 0.2);   // a place chosen as a stop shows as the stop, not twice
  const restName = (x) => x.it[1] || t('kv.rest.noname');
  const restKind = (it) => t(it[23] === 'fi' && it[5] ? 'kv.rest.service' : it[5] ? 'kv.rest.main' : 'kv.rest.kind');
  const restSrc = (it) => (it[23] === 'se' ? 'Källa: Trafikverket, CC0' : it[23] === 'fi' ? 'Lähde: Väylävirasto / Avoin API, CC BY 4.0' : '© Statens vegvesen (NVDB), NLOD');
  const restTitle = (x) => `${restName(x)} – ${restKind(x.it)} · ${sightWhen(x)}`;
  function restFacts(x) {   // what there is at a rest area, as escaped lines (the rest area's popup and a via there)
    const it = x.it;
    const park = [[it[6], 'kv.rest.cars'], [it[7], 'kv.rest.trucks'], [it[8], 'kv.rest.hc']].filter(([v]) => v).map(([v, k]) => t(k, { n: v })).join(', ');
    const w = it[17], wDays = w && w[3] === 1 ? (w[4] && w[5] ? `${restDay(w[4])}–${restDay(w[5])}` : t('kv.rest.novapr')) : '';
    const wc = !w ? '' : [w[0] === 0 ? t('kv.rest.wcany') : t(w[1] === 'd' ? 'kv.rest.wcdry' : 'kv.rest.wcwater', { n: w[0] || 1 }), w[2] === 1 ? t('kv.rest.wcuu') : '',
      w[3] === 1 ? (toiletOpen(x) ? t('kv.rest.wcwinter', { d: wDays }) : t('kv.rest.wcshut', { d: wDays })) : w[3] === 0 ? t('kv.rest.wcyear') : ''].filter(Boolean).join(', ');
    const furn = [it[18] ? t('kv.rest.tables', { n: it[18] }) + (it[19] ? ' ' + t('kv.rest.roofed', { n: it[19] }) : '') : '', it[20] ? t('kv.rest.benches', { n: it[20] }) : ''].filter(Boolean).join(', ');
    const has = [[it[10], 'kv.rest.water'], [it[11], 'kv.rest.shower'], [it[12], 'kv.rest.power']].filter(([v]) => v === 1).map(([, k]) => t(k));
    const winter = it[14] === 'closed' ? (it[15] && it[16] ? t('kv.rest.wclosed', { a: restDay(it[15]), b: restDay(it[16]) }) : t('kv.rest.wclosed0')) : it[14] === 'cleared' ? t('kv.rest.wcleared') : it[14] === 'open' ? t('kv.rest.wopen') : '';
    const ex = it[24] || [], exf = (k) => ex.find((e) => e.startsWith(k + ':'));   // abroad: what Sweden's and Finland's data say beyond Norway's columns
    const food = exf('food'), kit = exf('kit');
    const facts = [wc ? '🚻 ' + wc : '', park ? '🅿 ' + t('kv.rest.park', { p: park }) : '', it[9] ? '⚡ ' + t('kv.rest.charge', { n: it[9] }) : '', furn ? '🪑 ' + furn : '',
      ex.includes('picnic') ? '🪑 ' + t('kv.rest.picnic') : '', food ? '☕ ' + t('kv.rest.food.' + food.slice(5)) : '', kit ? t('kv.rest.kit.' + kit.slice(4)) : '',
      has.length ? has.join(' · ') : '', ex.includes('dump') ? t('kv.rest.dump') : '', ex.includes('light') ? t('kv.rest.light') : '',
      it[21] ? t('kv.rest.bins') : '', it[22] ? t('kv.rest.play') : '', it[13] ? t('kv.rest.oneway') : '', winter].filter(Boolean);
    if (!w && it[23] !== 'fi') facts.push(t('kv.rest.nowc'));   // Finland's data has no toilet column: not said is not 'none'
    return facts.map(esc);
  }
  /* 0 °C along the road: where it drops below (blue −0°) and rises above again (orange +0°), as text pills (an arrow or a
     snowflake drawn as an emoji read as a link or as snow), on the map, the chart and the badges; a tap tells what it means */
  const XING = { down: '−0°', up: '+0°' };
  const xingPill = (dir) => `<span class="kv-xing ${dir}">${XING[dir]}</span>`;
  const xingTitle = (dir, p) => t(dir === 'down' ? 'kv.b.minus' : 'kv.b.plus', { km: Math.round(p.km), h: hm(p.at) });
  function xingPopup(dir, p) {
    const el = document.createElement('div'); el.className = 'kv-sv kv-evpop kv-xingpop';
    el.innerHTML = `<div class="kv-sv-head">${xingPill(dir)}<b>${esc(t('kv.x.' + dir))}</b></div>
      <p class="kv-ev on"><i>${esc(t('kv.x.where', { k: Math.round(p.km), h: hm(p.at) }))}</i></p>
      <p>${esc(t('kv.x.' + dir + '.txt', { t: Number.isFinite(p.t) ? String(Math.round(p.t)).replace('-', '−') : '–' }))}</p>`;
    MAP.openPopup([p.lat, p.lon], el);
  }
  function restPopup(x) {
    const it = x.it, el = document.createElement('div'), facts = restFacts(x); el.className = 'kv-sv kv-evpop kv-sightpop kv-restpop';
    el.innerHTML = `<div class="kv-sv-head"><span class="kv-restmk${it[5] ? ' main' : ''}">${REST_ICON}</span> <b>${esc(restName(x))}</b></div>
      <p>${esc(restKind(it))}${it[4] ? ' · ' + esc(it[4]) : ''}${it[23] ? ' · ' + esc(t('kv.cn.' + it[23].toUpperCase())) : ''} · km ${Math.round(x.km)}</p>
      <p class="kv-ev ${x.p.dark ? 'off' : 'on'}"><i>${esc(sightWhen(x))}</i></p>
      ${facts.length ? `<ul class="kv-restfacts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
      <p><button type="button" class="btn kv-sgstop">${esc(t(stopAt(x.pos) >= 0 ? 'kv.sg.unstop' : 'kv.sg.stop'))}</button></p>
      <div class="kv-sv-meta">${esc(restSrc(it))}</div>`;
    el.querySelector('.kv-sgstop').addEventListener('click', () => addStop(x.pos, x.km, restName(x)));
    MAP.openPopup(x.pos, el);
  }
  const restDay = (md) => new Date(`2001-${md}T12:00:00`).toLocaleDateString(document.documentElement.lang === 'en' ? 'en-GB' : 'nb-NO', { day: 'numeric', month: 'long' });
  /* "Severdigheter:" in the planner: one chip per category, and "Mindre kjente" for the lower-ranked ones */
  function sightsSet(c, on) {
    const P = sightPrefs(); if (c === 'more') P.more = on; else P.cats[c] = on;
    lsSet('glett.kv.sights', JSON.stringify(P)); sightsLabel(); if (kv.S) render();
  }
  function sightsLabel() {
    const row = $('kvSightRow'); if (!row) return; const P = sightPrefs();
    row.querySelectorAll('[data-sg], .kv-break').forEach((b) => b.remove());
    SIGHT_CATS.concat('more').forEach((c) => {
      const on = c === 'more' ? !!P.more : !!P.cats[c], b = document.createElement('button');
      b.type = 'button'; b.className = 'kv-chip kv-opt' + (on ? ' on' : ''); b.dataset.sg = c; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.innerHTML = `<span>${esc(t(c === 'more' ? 'kv.sg.morechip' : 'kv.sg.c.' + c))}</span>`;
      if (c === 'more') { const any = SIGHT_CATS.some((x) => P.cats[x]); b.disabled = !any; b.classList.add('kv-sgmore'); b.title = t(any ? 'kv.sg.more' : 'kv.sg.moreoff'); }   // a modifier of the categories: on its own line, and only with one of them
      if (c === 'more') { const br = document.createElement('i'); br.className = 'kv-break'; row.appendChild(br); }
      row.appendChild(b);
    });
    showSum();
  }

  function camIcon(near) {   // a small camera in a round badge, drawn once (MapLibre symbol layers need images, not text)
    const c = document.createElement('canvas'); c.width = c.height = 44; const g = c.getContext('2d');
    g.beginPath(); g.arc(22, 22, 19, 0, Math.PI * 2); g.fillStyle = near ? '#2563eb' : '#334155'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect ? g.roundRect(11, 16, 22, 14, 3) : g.rect(11, 16, 22, 14); g.fill(); g.fillRect(17, 13, 8, 4);
    g.beginPath(); g.arc(22, 23, 4.5, 0, Math.PI * 2); g.fillStyle = near ? '#2563eb' : '#334155'; g.fill();
    return g.getImageData(0, 0, 44, 44);
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
    const o = (kv.opts.noFerry ? 'f' : '') + (kv.opts.noDark ? 'd' : '') + (kv.opts.curvy ? 'c' : '') + (kv.opts.noGravel ? 'g' : '') + (kv.opts.noNarrow ? 'n' : '');
    const vp = kv.via.some((x) => x.pause > 0) ? kv.via.map((x) => +x.pause || 0).join(',') : '';
    return `#kv?a=${pStr(kv.from)}&b=${pStr(kv.to)}${v ? '&v=' + v : ''}${vp ? '&vp=' + vp : ''}&p=${kv.veh}${d ? '&d=' + d : ''}${o ? '&o=' + o : ''}${kv.opts.noNarrow ? '&nw=' + narrowW() : ''}`;
  }
  function writeHash() { try { history.replaceState(null, '', hashFor()); } catch (e) { /* ignore */ } }
  function readHash() {
    const h = location.hash; if (!h.startsWith('#kv')) return false;
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    const a = pParse(q.get('a')), b = pParse(q.get('b'));
    kv.via = (q.get('v') || '').split(';').map(pParse).filter(Boolean).slice(0, MAX_VIA);
    (q.get('vp') || '').split(',').forEach((m, j) => { if (kv.via[j] && PAUSES.includes(+m)) kv.via[j].pause = +m; });
    kv.veh = q.get('p') === 'mc' ? 'mc' : 'car';
    if (q.has('o')) { const o = q.get('o') || ''; kv.opts = { noFerry: o.includes('f'), noDark: o.includes('d'), curvy: o.includes('c'), noGravel: o.includes('g'), noNarrow: o.includes('n'), narrowW: NARROW_W.includes(+q.get('nw')) ? +q.get('nw') : 4 }; }
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
    $('kvAddVia').hidden = kv.via.length >= MAX_VIA;
    $('kvReset').hidden = !(kv.to || kv.via.length || kv.routes.length || kv.dep);   // something to clear (From is filled in from the forecast page anyway)
    document.querySelectorAll('#kvVeh button').forEach((b) => b.classList.toggle('on', b.dataset.v === kv.veh));
    document.querySelectorAll('#kvOpts [data-opt]').forEach((b) => { const on = !!kv.opts[b.dataset.opt]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    const nsel = $('kvNarrowMin'), non = !!kv.opts.noNarrow;   // off "Unngå smale veier"; on "Smale veier | bare bredere enn …", the limit joined to the chip
    const nlab = $('kvOptNarrow').firstElementChild; nlab.dataset.i18n = non ? 'kv.opt.narrow' : 'kv.opt.narrowOff'; nlab.textContent = t(nlab.dataset.i18n);
    nsel.hidden = !non; $('kvOptNarrow').classList.toggle('kv-pair-l', non); $('kvOptNarrow').title = t('kv.opt.narrowHelp'); nsel.setAttribute('aria-label', t('kv.opt.narrowLab')); nsel.title = t('kv.opt.narrowLab');
    nsel.innerHTML = NARROW_W.map((w) => `<option value="${w}"${w === narrowW() ? ' selected' : ''}>${esc(t('kv.opt.narrowW', { w: mtr(w) }))}</option>`).join('');
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
    if (kv.source === 'vegvesen' && Math.abs(+(kv.dep || new Date()) - (kv.routedAt || 0)) >= 3600e3) setDep.t = setTimeout(() => plan(kv.sel, true), 800);
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
    kv.fitted = false; kv.dirty = true; kv.narrowSkip = false;
    if (kv.busy) { kv.token++; kv.busy = false; $('kvGo').classList.remove('busy'); workClose(); }   // a change while planning: that plan is no longer what was asked for
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
    $('kvVias').addEventListener('click', (e) => { const b = e.target.closest('[data-unvia]'); if (b) { kv.via.splice(+b.dataset.unvia, 1); syncForm(); if (kv.routes.length && !kv.busy) go(); else markDirty(); } });   // with a route shown: the routes again at once
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
    $('kvVehInfo').addEventListener('click', () => { const b = $('kvVehInfo'), on = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', on); $('kvVehHelp').hidden = !on; });   // what MC changes, on request
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
    $('kvDep').addEventListener('click', (e) => {   // four days of bars are 2 px wide on a phone: a tap between them takes the nearest (within 12 px)
      let b = e.target.closest('button[data-k]');
      if (!b) b = [...$('kvDep').querySelectorAll('button[data-k]')].reduce((m, x) => { const r = x.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - e.clientX); return d < m.d ? { d, x } : m; }, { d: 12, x: null }).x;
      if (b) setDep(kv.depOpts[+b.dataset.k]);
    });
    $('kvDepHint').addEventListener('click', (e) => { const ub = e.target.closest('#kvUseBest'); if (ub) setDep(kv.depOpts[+ub.dataset.k]); });
    // a road report or a rush note in the stage list: the map flies to that piece of road (at least 1 km, a point gets
    // 500 m each side) and pulses it for 20 s, as a stage does; the note stays marked meanwhile
    const flyTo = (btn, also = []) => {
      if (!kv.S) return; const R = kv.S[kv.sel].R; let [k0, k1] = btn.dataset.fly.split('|').map(Number);
      if (k1 - k0 < 1) { const m = (k0 + k1) / 2; k0 = m - 0.5; k1 = m + 0.5; }
      const coords = R.coords.filter((_, i) => R.cumKm[i] >= k0 && R.cumKm[i] <= k1);
      if (coords.length < 2) return;
      document.querySelectorAll('#kvIt .kv-fly.lit, #kvIt .kv-sight.lit, #kvIt .kv-stage.on').forEach((x) => x.classList.remove('lit', 'on')); btn.classList.add('lit');
      clearTimeout(flyTo.t); flyTo.t = setTimeout(() => btn.classList.remove('lit'), 20000);
      const head = document.querySelector('.topbar'), wrap = $('kvMapWrap');
      if (!document.documentElement.classList.contains('gl-fullmode')) window.scrollTo({ top: wrap.getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 60) - 12, behavior: 'smooth' });
      setTimeout(() => MAP.highlight(coords, 15, also), 350);
    };
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
    $('kvIt').addEventListener('click', (e) => {
      const sb = e.target.closest('.kv-sight:not(.kv-restbtn):not(.kv-viaplace)');
      if (sb) { const [k, id] = sb.dataset.sk.split('|'), s = kv.S && kv.S[kv.sel], x = s && sightsFor(s).find((y) => y.it[0] === id && y.km.toFixed(3) === k); if (x) { sb.dataset.fly = `${x.km.toFixed(3)}|${x.km.toFixed(3)}`; sightPopup(x); flyTo(sb, [x.pos]); } return; }   // like the rest areas: to the map, the road and the sight in the frame
      const vb = e.target.closest('.kv-viaplace');
      if (vb) { const s = kv.S && kv.S[kv.sel], p = s && s.pts.find((y) => y.stop && y.stop.j === +vb.dataset.vj); if (p) { vb.dataset.fly = `${p.km.toFixed(3)}|${p.km.toFixed(3)}`; viaPopup(p, s.pts); flyTo(vb); } return; }
      const rb = e.target.closest('.kv-restbtn');
      if (rb) { const [k, id] = rb.dataset.rk.split('|'), s = kv.S && kv.S[kv.sel], x = s && restFor(s).find((y) => String(y.it[0]) === id && y.km.toFixed(3) === k); if (x) { restPopup(x); flyTo(rb); } return; }   // like the other pills: to the map, the spot marked, its details first, then the flight
      const fb = e.target.closest('.kv-fly'); if (fb) { flyTo(fb); return; }
      if (e.target.closest('a, details, select, label')) return; stageClick(e.target.closest('.kv-stage'));
    });
    $('kvIt').addEventListener('change', (e) => {   // a pause re-times what comes after it; the routes and forecasts stay (nothing is fetched)
      const sel = e.target.closest('[data-pause]'); if (!sel || !kv.via[+sel.dataset.pause]) return;
      kv.via[+sel.dataset.pause].pause = +sel.value; render(); writeHash(); saveLast();
    });
    $('kvIt').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('kv-stage')) { e.preventDefault(); stageClick(e.target); } });
    $('kvCards').addEventListener('click', (e) => { const c = e.target.closest('.kv-rc'); if (c) choose(+c.dataset.i); });
    $('kvCards').addEventListener('mouseover', (e) => { const c = e.target.closest('.kv-rc'); if (c) MAP.hover(+c.dataset.i); });   // the route of the tile under the pointer lights up on the map
    $('kvCards').addEventListener('mouseleave', () => MAP.hover(null));
    $('kvSave').addEventListener('click', saveRoute);
    $('kvGpx').addEventListener('click', gpx);
    $('kvShare').addEventListener('click', async () => {
      const url = location.origin + location.pathname + hashFor();
      try { if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: 'Glett Kjørevær', url }); return; } await navigator.clipboard.writeText(url); toast(t('kv.share.ok')); } catch (e) { ask({ title: t('kv.share'), text: t('kv.share.copy'), value: url, readonly: true, ok: t('kv.dlg.ok') }); }
    });
    $('kvSaved').addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]'), list = savedList();
      if (o) { const r = list[+o.dataset.open]; kv.from = r.from; kv.to = r.to; kv.via = r.via || []; kv.veh = r.veh || 'car'; if (r.opts) kv.opts = { noFerry: !!r.opts.noFerry, noDark: !!r.opts.noDark, curvy: !!r.opts.curvy, noGravel: !!r.opts.noGravel, noNarrow: !!r.opts.noNarrow, narrowW: NARROW_W.includes(+r.opts.narrowW) ? +r.opts.narrowW : 4 }; syncForm(); go(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (d) { const k = +d.dataset.del, r = list[k];
        ask({ title: t('kv.del.title'), text: t('kv.saved.del', { n: r.name }), ok: t('saved.delete'), danger: true }).then((yes) => {
          if (!yes) return; const now = savedList().filter((x) => !(x.id === r.id && x.key === r.key)); lsSet('glett.routes', JSON.stringify(now)); renderSaved(); }); }
    });
    $('kvGo').addEventListener('click', () => { if (!kv.busy) go(); });
    $('kvStop').addEventListener('click', stopPlan);
    $('kvReset').addEventListener('click', () => {   // a blank planner, as from the menu: From is the forecast page's place; the vehicle and the route options stay
      freshPlanner(); MAP.stale(false); syncForm(); $('kvGo').disabled = !(kv.from && kv.to);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && working()) stopPlan(); });
    $('kvFull').addEventListener('click', () => setFull(!(FULL && FULL.on)));
    KVCore.mapControls($('kvMap'), { big: $('kvBig'), full: $('kvFull'), base: $('kvBase'), cams: $('kvCams') });   // the switches as icons in the map's control column
    $('kvBig').addEventListener('click', () => setBig(!$('kvMap').classList.contains('big')));
    $('kvBase').addEventListener('click', () => { KVCore.setBaseChoice(KVCore.baseChoice() === 'osm' ? 'kartverket' : 'osm'); bigLabel(); MAP.applyBase(); });
    $('kvCams').addEventListener('click', () => { lsSet('glett.kv.cams', camOn() ? '0' : '1'); camsShow(); });
    { const box = $('kvShowBox'); box.open = lsGet('glett.kv.showOpen') === '1'; box.addEventListener('toggle', () => lsSet('glett.kv.showOpen', box.open ? '1' : '0')); }   // closed at first, then as the user left it
    $('kvSightRow').addEventListener('click', (e) => { const b = e.target.closest('[data-sg]'); if (b) sightsSet(b.dataset.sg, b.getAttribute('aria-pressed') !== 'true'); });
    $('kvReports').addEventListener('click', () => { lsSet('glett.kv.reports', showReports() ? '0' : '1'); showLabels(); if (kv.S) render(); });
    $('kvNarrowNote').addEventListener('click', (e) => { const b = e.target.closest('[data-nar]'); if (!b || kv.busy) return; kv.narrowSkip = b.dataset.nar === 'fast'; plan(); });   // the override: the fastest route, or back
    $('kvNarrowMin').addEventListener('change', (e) => { kv.opts.narrowW = +e.target.value; lsSet('glett.kv.opts', JSON.stringify(kv.opts)); syncForm(); writeHashIfDone(); if (kv.opts.noNarrow) markDirty(); });   // a new limit is a new route
    $('kvRest').addEventListener('click', () => { lsSet('glett.kv.rest', showRest() ? '0' : '1'); showLabels(); if (!kv.S) return; render(); if (showRest()) loadRest(kv.routes, kv.region, kv.token); });
    addEventListener('resize', () => { if ($('kvMap').classList.contains('big')) fitBig(); });
    $('kvLgDet').addEventListener('toggle', () => { if ($('kvMap').classList.contains('big')) fitBig(); });
    let rt = null;
    addEventListener('resize', () => { if (!$('view-route').classList.contains('active') || !kv.S) return; clearTimeout(rt); rt = setTimeout(() => renderChart(kv.S[kv.sel]), 150); });
    // the chart's colours are read when it is drawn: again when the theme changes (the toggle, or the phone turning light at dawn)
    const rechart = () => { if (kv.S) setTimeout(() => renderChart(kv.S[kv.sel]), 0); };
    new MutationObserver(rechart).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rechart);
  }

  /* ---------------- entry points used by app.js ---------------- */
  /* A fresh planner: nothing calculated, To and via empty, departure now; From is the place shown on the forecast page.
     The vehicle and the route options (preferences) are kept. */
  function freshPlanner() {
    kv.token++;   // anything still loading is dropped
    setBig(false);   // the large map goes back to its place (it sits above the form, outside the result)
    Object.assign(kv, { routes: [], S: null, sel: 0, to: null, via: [], dep: null, fitted: false, dirty: false, seek: null });
    kv.from = typeof state !== 'undefined' && state.current ? { lat: state.current.lat, lon: state.current.lon, name: state.current.name } : null;
    MAP.closePopup && MAP.closePopup();
    $('kvResult').hidden = true; $('kvGo').classList.remove('busy'); kv.busy = false; status('', '');
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
  window.kvEngine = { classify, crossings, segments, viaPicks, addressCandidates, map: () => MAP.m, KV_ROUTERS, KV_REGIONS, KV_PROFILES, LIVE_SOURCES, state: () => kv };   // for tests and future regions / routers
  window.kvAsk = ask; window.kvToast = toast;   // the dialog and the toast serve Turvær too
  window.kvLang = function () { if (!kv.started) return; syncForm(); renderSaved(); bigLabel(); if (kv.st && kv.st.key) status(t(kv.st.key), kv.st.kind, kv.st.key); if (kv.routes.length) render(); };
  // a shared link (#kv?a=…&b=…) opens Kjørevær directly
  if (location.hash.startsWith('#kv')) setTimeout(() => showView('route'), 0);
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#kv') && readHash()) { syncForm(); showView('route'); go(); } });
})();
