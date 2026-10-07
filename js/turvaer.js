'use strict';
/* ================= Turvær: the weather along a marked hiking trail =================
   A hike between two named points (huts, car parks, summits, viewpoints) on Norway's marked trails, or a classic
   hike from the list; walked in either direction, starting now or up to three days ahead, at a chosen pace. The route
   is found on the marked trails alone (Kartverket's Turrutebasen as static tiles in data/tur/, routed in the browser;
   see tools/tur/build.mjs), the heights come from Kartverket's terrain model, the walking time from DNT's rule of
   thumb, and the forecast is read at the time you reach each point through the engine shared with Kjørevær
   (js/kvcore.js). Saved hikes live only in this browser (localStorage 'glett.turer'). */
(function () {
  const { fetchT, pad2, hm, wday, dayKey, hav, dur, cssv, cellKey, elevate, fetchForecast, classify, KV_CLASSES, wxAt, fetchEnsemble, keyPoints, nearKey, weightAreas,
    ensAt, vote, ensHints, FAM, segments, crossings, alertAt, loadAlerts, snowCell, osloDay } = KVCore;
  const DATA = 'data/tur/';
  const MAX_AHEAD_H = 72;
  const MET_H = 60;                     // MET Nordic's forecast reaches about 60 hours; beyond that only the global models
  const START_H = [4, 16];              // sensible start hours for the "when should you go" bars
  const STEP_M = 100;                   // the profile spacing
  const WX_KM = 1, WX_MIN = 20;         // a weather sample every kilometre or 20 minutes of walking
  const DMI_KM = 5, DMI_REACH = 6;      // DMI HARMONIE (visibility, thunder potential, freezing level) at key points
  const GUST = 15, GUST_HARD = 20;      // m/s: hard to walk; dangerous on ridges
  const EXPOSED_Z = 800;                // above this the terrain counts as exposed (over the tree line in most of Norway)
  const WX_VARS = ['temperature_2m', 'precipitation', 'weather_code', 'wind_gusts_10m', 'is_day', 'dew_point_2m', 'wind_speed_10m', 'apparent_temperature', 'visibility', 'cape'];   // visibility and CAPE: the best match's global model, used where DMI's 60 hours end
  const DMI_VARS = ['visibility', 'cape', 'freezing_level_height'];
  // DNT's rule of thumb: 3.5 km/h on the flat, 15 minutes per 100 m of climb, an hour of breaks per five hours; a
  // little for steep descents (which the rule leaves out); the pace presets scale the walking, not the breaks
  const PACE = { slow: 1.25, normal: 1, fast: 0.8 };
  // steep ground: the gradient of each 100 m step from the terrain model; from 25 % (14°) a step takes a tenth longer,
  // from 40 % (22°) a quarter longer, up or down (DNT's rule charges for the climb already; this is for how it is spread,
  // and the 50 m terrain model sees the slope beside a zigzagging trail, so the factor stays mild)
  const STEEP = 25, STEEP_HARD = 40, STEEP_RUN_M = 150;
  const grade = (d, i) => (i ? Math.abs(((d[i].z ?? d[i - 1].z ?? 0) - (d[i - 1].z ?? 0)) / Math.max(20, (d[i].km - d[i - 1].km) * 1000)) * 100 : 0);
  const gradeAt = (R, km) => {   // the steepest 150 m window within 50 m of km on the fine profile: the chips' measure, reachable from the 100 m scrub points
    const f = R.fine; if (!f || !f.length) return 0; let lo = 0, hi = f.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f[m].km < km) lo = m; else hi = m; }
    let g = 0; for (let i = Math.max(0, lo - 3); i <= Math.min(f.length - 1, hi + 3); i++) if (Math.abs(f[i].km - km) <= 0.0501) g = Math.max(g, f[i].g || 0);
    return g;
  };
  const steepFactor = (g) => (g >= STEEP_HARD ? 1.25 : g >= STEEP ? 1.1 : 1);
  // [{a, b, km, max}] on the 100 m profile d: stretches at least 150 m long where the gradient over a 100 m window,
  // read every 25 m on the fine profile f, is 25 % or more; the fine step keeps the answer the same whatever the grid
  function steepRuns(d, f) {
    // the gradient over a 150 m window (±3 points of the 25 m profile); at the ends the window slides inwards, and a window
    // shorter than 120 m is not judged: the last profile point can lie a few metres after the previous one, and a few
    // metres of height over a few metres of distance gave gradients of 176 % that no trail has
    const g = f.map((p, i) => { let ia = Math.max(0, i - 3), ib = Math.min(f.length - 1, i + 3); if (ib - ia < 6) { ia = Math.max(0, ib - 6); ib = Math.min(f.length - 1, ia + 6); } const a = f[ia], b = f[ib], dk = (b.km - a.km) * 1000; return a.z == null || b.z == null || dk < 120 ? 0 : Math.abs(b.z - a.z) / dk * 100; });
    f.forEach((p, i) => { p.g = g[i]; });   // kept on the fine profile: the scrub readout shows the same measure, so "opptil 66 %" can be found
    const at = (km) => d.reduce((b, p, i) => (Math.abs(p.km - km) < Math.abs(d[b].km - km) ? i : b), 0), out = []; let run = null;
    g.forEach((x, i) => {
      if (x >= STEEP) { if (!run) run = { i0: i, i1: i, max: x }; else { run.i1 = i; run.max = Math.max(run.max, x); } }
      else if (run) { if ((f[run.i1].km - f[run.i0].km) * 1000 + 150 >= STEEP_RUN_M) out.push(run); run = null; }   // the windows cover 75 m beyond their centres each way
    });
    if (run && (f[run.i1].km - f[run.i0].km) * 1000 + 150 >= STEEP_RUN_M) out.push(run);
    return out.map((r) => ({ a: at(f[r.i0].km - 0.075), b: Math.max(at(f[r.i0].km - 0.075) + 1, at(f[r.i1].km + 0.075)), max: r.max, km: f[r.i1].km - f[r.i0].km + 0.15 }));
  }
  const MIN_KM = 60 / 3.5, MIN_UP = 0.15, MIN_DOWN = 0.05, BREAKS = 1.1;   // Besseggen: 7¾ h at normal pace, as DNT says
  const TRACK_KM = 60 / 5.5, TRACK_UP = 0.10;   // on a road the flat pace is 5.5 km/h, a climb costs 10 min per 100 m and a descent nothing: no roots, stones or bog (33 km of Nordmarka gravel: about 6 h at a fast pace)
  // what counts when scoring a start time: minutes in each weather class, gusts, darkness, cold
  const W = { dry: 0, fog: 3, wet: 2, heavy: 5, sleet: 6, snow: 7, ice: 9, thunder: 12 };

  /* ---------------- data: the trail tiles, the names, the classics, the named routes ---------------- */
  // the two networks, loaded cell by cell: cell -> loaded; node -> [lat, lon]; node -> [[node, m, edge]]; node -> {n, ty}
  // summer also has the tracks (forest roads from OpenStreetMap) as a second class: loaded from t/, costing TRACK_COST
  // times their length when routing, so a marked trail is preferred and a track is taken where it opens a way
  const NET = { summer: { dir: 'g/', cells: 'cells', dir2: 't/', cells2: 'tcells', tiles: new Map(), nodes: new Map(), adj: new Map(), named: new Map() }, winter: { dir: 's/', cells: 'scells', tiles: new Map(), nodes: new Map(), adj: new Map(), named: new Map() } };
  // the router minimises walking time, not length: a road surface walks at 5 km/h against 3.5 on a path, so a road costs
  // 0.7 of its length and is taken when it is quicker (the data build routes the classics and named routes on the marked trails alone)
  const TRACK_COST = { least: 1.6, most: 0.6 };   // the setting "Skogsbilvei og grusvei: Minst mulig | Mest mulig": a road metre costs this many trail metres
  const net = () => NET[tv.season];
  let index = null, names = null, classics = null, ruter = null;
  const getJson = async (u, o) => { const r = await fetchT(u, o); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };
  // the index is always revalidated and carries the build's date; the other files are asked for with it, so a browser
  // never mixes the tiles of two builds (the node ids change with every build)
  const loadIndex = () => (index ||= getJson(DATA + 'index.json', { cache: 'no-cache' }));
  const vers = async (file) => `${DATA}${file}?v=${encodeURIComponent((await loadIndex()).v || '')}`;
  const loadNames = () => (names ||= vers('names.json').then(getJson));
  const loadClassics = () => (classics ||= vers('classics.json').then(getJson));
  const loadRuter = () => (ruter ||= vers('ruter.json').then(getJson));
  const cellOf = (la, lo) => `${Math.floor(la * 4)}_${Math.floor(lo * 2)}`;
  async function loadCells(pts, margin = 0.12) {   // the tiles covering the points, with a margin for detours
    const { tiles, nodes, adj, named } = net();
    const idx = await loadIndex(), have = new Set(idx[net().cells] || []), have2 = new Set(net().cells2 ? idx[net().cells2] || [] : []);
    const las = pts.map((p) => p[0]), los = pts.map((p) => p[1]);
    const la0 = Math.floor((Math.min(...las) - margin) * 4), la1 = Math.floor((Math.max(...las) + margin) * 4);
    const lo0 = Math.floor((Math.min(...los) - margin * 2) * 2), lo1 = Math.floor((Math.max(...los) + margin * 2) * 2);
    const want = [];
    for (let a = la0; a <= la1; a++) for (let b = lo0; b <= lo1; b++) { const k = `${a}_${b}`; if ((have.has(k) || have2.has(k)) && !tiles.has(k)) want.push(k); }
    if (want.length > 40) throw new Error(t('tv.err.far'));
    const none = { e: [], p: [] };
    await Promise.all(want.map(async (k) => {
      tiles.set(k, true);
      const v = `?v=${encodeURIComponent(idx.v || '')}`;
      const [tl, t2] = await Promise.all([have.has(k) ? getJson(`${DATA}${net().dir}${k}.json${v}`) : none, have2.has(k) ? getJson(`${DATA}${net().dir2}${k}.json${v}`) : none]).catch((e) => { tiles.delete(k); throw e; });
      const add = (es, kind) => es.forEach((e) => {
        const c = []; for (let i = 0; i < e[3].length; i += 2) c.push([e[3][i], e[3][i + 1], e[4] ? e[4][i / 2] : null]);   // [lat, lon, z]: the heights come with the tiles
        const edge = { a: e[0], b: e[1], m: e[2], c, k: kind, rd: kind === 2 || e[5] === 1 };   // k: 1 a marked trail, 2 a road; rd: a road surface (a marked trail may follow a road)
        if (!nodes.has(edge.a)) nodes.set(edge.a, c[0]); if (!nodes.has(edge.b)) nodes.set(edge.b, c[c.length - 1]);
        if (!adj.has(edge.a)) adj.set(edge.a, []); if (!adj.has(edge.b)) adj.set(edge.b, []);
        adj.get(edge.a).push([edge.b, edge.m, edge]); adj.get(edge.b).push([edge.a, edge.m, edge]);
      });
      add(tl.e, 1); add(t2.e, 2);
      tl.p.forEach((p) => { named.set(p[0], { n: p[1], ty: p[2] }); if (!nodes.has(p[0])) nodes.set(p[0], [p[3], p[4]]); });
    }));
  }
  function nearestNode(p, maxM = 300) {   // the nearest loaded node to [lat, lon]
    const { nodes } = net(); let best = -1, bd = Infinity;
    nodes.forEach((q, id) => { const d = hav(p, q) * 1000; if (d < bd) { bd = d; best = id; } });
    return bd <= maxM ? best : -1;
  }
  // the nearest point of a segment to p, in a local flat metric: {t: 0..1, d: metres, q: [lat, lon]}
  function projSeg(p, a, b) {
    const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    return { t, d: Math.hypot(ax + t * dx, ay + t * dy), q: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
  }
  function nearestOnNet(p, maxM = 400) {   // the nearest point on any loaded trail or track within maxM: {e, s, t, q, d}
    const { adj } = net(), seen = new Set(), dla = maxM / 110540, dlo = maxM / (111320 * Math.cos(p[0] * Math.PI / 180)); let best = null;
    adj.forEach((list) => list.forEach(([, , e]) => {
      if (seen.has(e)) return; seen.add(e); const c = e.c;
      for (let s = 0; s < c.length - 1; s++) {
        const a = c[s], b = c[s + 1]; if (Math.max(a[0], b[0]) < p[0] - dla || Math.min(a[0], b[0]) > p[0] + dla || Math.max(a[1], b[1]) < p[1] - dlo || Math.min(a[1], b[1]) > p[1] + dlo) continue;
        const r = projSeg(p, a, b); if (r.d <= maxM && (!best || r.d < best.d)) best = { e, s, ...r };
      }
    }));
    return best;
  }
  let splitSeq = 0;
  function nodeAt(p, maxM = 400) {   // a node at the nearest point of the network within maxM: an existing node when one is about as close, else the edge is split there
    const { nodes, adj } = net(), id0 = nearestNode(p, maxM), h = nearestOnNet(p, maxM);
    if (!h) return id0;
    if (id0 >= 0 && hav(p, nodes.get(id0)) * 1000 <= h.d + 15) return id0;
    const e = h.e; if (hav(h.q, e.c[0]) * 1000 < 10) return e.a; if (hav(h.q, e.c[e.c.length - 1]) * 1000 < 10) return e.b;
    const za = e.c[h.s][2], zb = e.c[h.s + 1][2], P = [+h.q[0].toFixed(5), +h.q[1].toFixed(5), za != null && zb != null ? za + h.t * (zb - za) : null], id = 1e9 + ++splitSeq;
    const len = (c) => Math.round(c.reduce((a, x, i) => a + (i ? hav(c[i - 1], x) * 1000 : 0), 0));
    const c1 = [...e.c.slice(0, h.s + 1), P], c2 = [P, ...e.c.slice(h.s + 1)], e1 = { a: e.a, b: id, m: len(c1), c: c1, k: e.k, rd: e.rd }, e2 = { a: id, b: e.b, m: len(c2), c: c2, k: e.k, rd: e.rd };
    [e.a, e.b].forEach((n) => adj.set(n, (adj.get(n) || []).filter((x) => x[2] !== e)));   // the edge becomes two
    adj.get(e.a).push([id, e1.m, e1]); adj.get(e.b).push([id, e2.m, e2]); adj.set(id, [[e.a, e1.m, e1], [e.b, e2.m, e2]]);
    nodes.set(id, P);
    return id;
  }
  const cost = (w, e) => (e.rd ? w * (TRACK_COST[tv.roads] || TRACK_COST.least) : w);   // a road surface, marked or not, weighed by the visitor's choice
  function dijkstra(from, to, pen) {   // pen: a Set of edges that cost ten times as much (for an alternative way; its real length is judged afterwards)
    const { nodes, adj } = net(), dist = new Map([[from, 0]]), prev = new Map(), heap = [[0, from]];
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop(); if (u === to) break; if (d > dist.get(u)) continue;
      for (const [v, w, e] of adj.get(u) || []) { const nd = d + (pen && pen.has(e) ? cost(w, e) * 10 : cost(w, e)); if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, e]); push([nd, v]); } }
    }
    if (!dist.has(to)) return null;
    // tk: per coordinate, 1 when the stretch ending there has a road surface (a road, or a marked trail along one)
    const coords = [], tk = [], ns = [to], edges = []; let at = to, m = 0;
    while (at !== from) { const [u, e] = prev.get(at); const c = e.a === u ? e.c : [...e.c].reverse(); coords.unshift(...c.slice(1)); tk.unshift(...c.slice(1).map(() => (e.rd ? 1 : 0))); ns.unshift(u); edges.push(e); m += e.m; at = u; }
    coords.unshift(nodes.get(from)); tk.unshift(0);
    return { m, coords, tk, nodes: ns, edges };
  }
  async function routeVia(points, pen) {   // points: [lat, lon] in order -> {coords, nodes, edges, m} on the marked trails
    await loadCells(points);
    const ids = points.map((p) => nodeAt(p, 400));   // a picked point off the trail carries its snap, so the route starts on the trail
    if (ids.includes(-1)) throw new Error(t(tv.season === 'winter' ? 'tv.err.offtrail.w' : 'tv.err.offtrail'));
    let m = 0; const coords = [], tk = [], ns = [], edges = [];
    for (let i = 1; i < ids.length; i++) {
      const r = dijkstra(ids[i - 1], ids[i], pen); if (!r) throw new Error(t(tv.season === 'winter' ? 'tv.err.nopath.w' : 'tv.err.nopath'));
      m += r.m; coords.push(...(coords.length ? r.coords.slice(1) : r.coords)); tk.push(...(tk.length ? r.tk.slice(1) : r.tk)); ns.push(...(ns.length ? r.nodes.slice(1) : r.nodes)); edges.push(...r.edges);
    }
    return { m, coords, tk, nodes: ns, edges, ids };
  }
  function reach(from, maxM) {   // Dijkstra over the loaded cells from a node, bounded: {dist: node -> m, first: node -> the first node out of `from` on its way}
    const { adj } = net(), dist = new Map([[from, 0]]), first = new Map(), heap = [[0, from]];
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop(); if (d > dist.get(u) || d > maxM) continue;
      for (const [v, w, e] of adj.get(u) || []) { const nd = d + cost(w, e); if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); first.set(v, u === from ? v : first.get(u)); push([nd, v]); } }
    }
    return { dist, first };
  }
  // suggestions: another marked way between the same points (the first way's trails cost ten times as much; kept
  // when it shares less than 60 % of them and is at most 60 % longer), and other named starting points with a marked
  // trail to the destination, one per approach
  async function suggest(r, points) {
    const out = { alts: [], alt: null, starts: [] };
    // up to two other marked ways between the same points: the ways found so far cost ten times as much in the next
    // search; a way is kept when it shares under 60 % of its trails with each of them and is at most three times as long
    try {
      const found = [r];
      for (let k = 0; k < 2; k++) {
        const pen = new Set(found.flatMap((x) => x.edges)), r2 = await routeVia(points, pen);
        if (r2.m > r.m * 3) break;
        const sharedMax = Math.max(...found.map((x) => { const P = new Set(x.edges); return r2.edges.filter((e) => P.has(e)).length / Math.max(1, r2.edges.length); }));
        if (sharedMax >= 0.6) break;
        const { named, nodes } = net(), onFound = new Set(found.flatMap((x) => x.nodes)), via = r2.nodes.find((id) => named.has(id) && !onFound.has(id));
        let pick = via != null ? { n: named.get(via).n, p: nodes.get(via) } : null;
        if (!pick) {   // no named point on the way: name it by the nearest named point within 300 m of its middle third, else leave it unnamed
          const mid = r2.nodes[Math.floor(r2.nodes.length / 2)], third = r2.coords.slice(Math.floor(r2.coords.length / 3), Math.ceil(r2.coords.length * 2 / 3));
          let best = null; named.forEach((nm, id) => { if (onFound.has(id)) return; const q = nodes.get(id); const d = Math.min(...third.map((c) => hav(c, q))); if (d < 0.3 && (!best || d < best.d)) best = { d, n: nm.n }; });
          pick = { n: best ? best.n : '', p: nodes.get(mid) };
        }
        out.alts.push({ km: r2.m / 1000, via: pick, shared: sharedMax, route: r2 }); found.push(r2);
      }
    } catch (e) { /* no alternative */ }
    out.alt = out.alts[0] || null;
    // other starts: the network reached from the destination, bounded at 12 km
    const { named, nodes } = net(), to = r.ids[r.ids.length - 1], from = r.ids[0];
    const { dist, first } = reach(to, 12000);
    const firstOfStart = first.get(from), byApproach = new Map();
    dist.forEach((d, id) => {
      const nm = named.get(id); if (!nm || id === from || id === to || d < 800 || !/^(hytte|parkering|dagsturhytte)$/.test(nm.ty)) return;
      const key = first.get(id), list = byApproach.get(key) || []; list.push({ id, n: nm.n, ty: nm.ty, km: d / 1000, p: nodes.get(id), same: key === firstOfStart }); byApproach.set(key, list);
    });
    byApproach.forEach((list) => { list.sort((a, b) => a.km - b.km); out.starts.push(...list.slice(0, list[0].same ? 2 : 1)); });   // the nearest per approach, two on your own
    out.starts.sort((a, b) => (a.same === b.same ? a.km - b.km : a.same ? 1 : -1)); out.starts = out.starts.slice(0, 4);
    return out;
  }

  /* ---------------- the hike: profile, time, samples ---------------- */
  function profile(R, STEP_M = 100) {   // a point every 100 m (or step) along the route, with its km
    const c = R.coords, tk = R.tk || [], zOf = (a, b, f) => (a[2] != null && b[2] != null ? a[2] + f * (b[2] - a[2]) : null), out = [{ lat: c[0][0], lon: c[0][1], z: c[0][2] ?? null, km: 0, tk: 0 }]; let acc = 0, tot = 0;
    for (let i = 1; i < c.length; i++) {
      const d = hav(c[i - 1], c[i]) * 1000; let s = 0;
      while (acc + (d - s) >= STEP_M) { const f = (STEP_M - acc + s) / d; s += STEP_M - acc; out.push({ lat: c[i - 1][0] + f * (c[i][0] - c[i - 1][0]), lon: c[i - 1][1] + f * (c[i][1] - c[i - 1][1]), z: zOf(c[i - 1], c[i], f), km: (tot + s) / 1000, tk: tk[i] ? 1 : 0 }); acc = 0; }   // tk: the step ends on a track
      acc += d - s; tot += d;
    }
    out.push({ lat: c[c.length - 1][0], lon: c[c.length - 1][1], z: c[c.length - 1][2] ?? null, km: tot / 1000, tk: tk[c.length - 1] ? 1 : 0 });
    R.cumKm = []; let k = 0; c.forEach((p, i) => { if (i) k += hav(c[i - 1], p); R.cumKm.push(k); });
    R.km = tot / 1000;
    return out;
  }
  function smoothZ(d) {   // the terrain model is noisy on a 100 m step: a light 3-point smoothing, and 5 m hysteresis for the sums
    const z = d.map((p) => p.z);
    d.forEach((p, i) => { const a = z[i - 1] ?? z[i], b = z[i + 1] ?? z[i]; if (z[i] != null && a != null && b != null) p.z = (a + 2 * z[i] + b) / 4; });
    let up = 0, down = 0, ref = d[0].z ?? 0;
    d.forEach((p) => { if (p.z == null) return; if (p.z - ref >= 5) { up += p.z - ref; ref = p.z; } else if (ref - p.z >= 5) { down += ref - p.z; ref = p.z; } });
    return { up: Math.round(up), down: Math.round(down) };
  }
  function tops(d) {   // the highest point, and local tops with at least 80 m of climb on both sides
    const out = [], zs = d.map((p) => p.z ?? 0); let hi = 0;
    zs.forEach((z, i) => { if (z > zs[hi]) hi = i; });
    for (let i = 1; i < d.length - 1; i++) {
      if (zs[i] < zs[i - 1] || zs[i] < zs[i + 1]) continue;
      let l = zs[i], r = zs[i]; for (let k = i - 1; k >= 0 && zs[k] <= zs[i]; k--) l = Math.min(l, zs[k]); for (let k = i + 1; k < d.length && zs[k] <= zs[i]; k++) r = Math.min(r, zs[k]);
      if (zs[i] - l >= 80 && zs[i] - r >= 80 && !out.some((j) => Math.abs(d[j].km - d[i].km) < 1)) out.push(i);
    }
    if (!out.includes(hi)) out.push(hi);
    return out.sort((a, b) => a - b);
  }
  function topName(p) {   // a summit name from the place names near a local top, else its height
    const { nodes, named } = net(); let best = null, bd = 0.4;
    named.forEach((v, id) => { if (v.ty !== 'topp') return; const d = hav([p.lat, p.lon], nodes.get(id)); if (d < bd) { bd = d; best = v.n; } });
    return best || t('tv.height', { z: Math.round(p.z ?? 0) });
  }
  // on skis: 4 km/h on the flat, 10 minutes per 100 m of climb, nothing for the descents (a rule of thumb for touring, not DNT's)
  const SKI = { km: 60 / 4, up: 0.10, down: 0 };
  function walkMinutes(d, pace) {   // minutes from the start to each profile point
    const f = PACE[pace] || 1, out = [0], w = tv.season === 'winter' ? SKI : { km: MIN_KM, up: MIN_UP, down: MIN_DOWN };
    for (let i = 1; i < d.length; i++) {
      const dz = (d[i].z ?? d[i - 1].z ?? 0) - (d[i - 1].z ?? 0), dk = d[i].km - d[i - 1].km;
      const road = tv.season !== 'winter' && d[i].tk, km = road ? TRACK_KM : w.km, up = road ? TRACK_UP : w.up, down = road ? 0 : w.down;
      out.push(out[i - 1] + (dk * km + Math.max(0, dz) * up + Math.max(0, -dz) * down) * f * BREAKS * steepFactor(grade(d, i)));
    }
    return out;
  }
  function pickSamples(R) {   // every km or 20 minutes, the tops, the named points and both ends
    const d = R.dense, out = new Set([0, d.length - 1]); let lastK = -1e9, lastM = -1e9;
    d.forEach((p, i) => { if (p.km - lastK >= WX_KM || R.mins[i] - lastM >= WX_MIN) { out.add(i); lastK = p.km; lastM = R.mins[i]; } });
    R.tops.forEach((i) => out.add(i));
    R.legs.forEach((l) => out.add(l.di));
    if (R.turnDi >= 0) { out.add(R.turnDi); out.add(Math.min(d.length - 1, R.turnDi + 1)); }   // the pause: a sample just after the turn
    return [...out].sort((a, b) => a - b);
  }
  function legsOf(R) {   // the named points the route passes, as the itinerary's rows: {di, name, ty, km}
    const { nodes, named } = net(), out = []; let k = 0;
    R.nodes.forEach((id, i) => {
      if (i) k += hav(nodes.get(R.nodes[i - 1]), nodes.get(id));   // along the straight lines between nodes: close enough to find the profile point
      const nm = named.get(id); if (!nm) return;
      const pos = nodes.get(id), di = R.dense.reduce((b, p, j) => (hav([p.lat, p.lon], pos) < hav([R.dense[b].lat, R.dense[b].lon], pos) ? j : b), 0);
      if (!out.some((l) => Math.abs(l.di - di) < 3)) out.push({ di, name: nm.n, ty: nm.ty, km: R.dense[di].km });
    });
    if (ownVia()) tv.via.forEach((v) => {   // the user's own via points are rows too, every time the route passes them
      R.nodes.forEach((id, i) => {
        const pos = nodes.get(id); if (!pos || Math.abs(pos[0] - v[0]) > 1e-5 || Math.abs(pos[1] - v[1]) > 1e-5) return;
        const di = R.dense.reduce((b, p, j) => (hav([p.lat, p.lon], pos) < hav([R.dense[b].lat, R.dense[b].lon], pos) ? j : b), 0);
        if (!out.some((l) => Math.abs(l.di - di) < 3)) out.push({ di, name: v[2] || t('tv.via.point'), ty: 'via', km: R.dense[di].km });
      });
    });
    return out.sort((a, b) => a.di - b.di);
  }

  /* ---------------- DMI at the key points: visibility, thunder potential, freezing level ---------------- */
  const dmiCache = new Map();
  async function fetchDmi(pts) {
    const now = Date.now(), need = pts.filter((p) => { const c = dmiCache.get(p.key); return !c || now - c.at > 30 * 60e3; });
    for (let i = 0; i < need.length; i += 50) {
      const ch = need.slice(i, i + 50);
      const q = new URLSearchParams({ latitude: ch.map((s) => s.lat.toFixed(3)).join(','), longitude: ch.map((s) => s.lon.toFixed(3)).join(','), elevation: ch.map((s) => (s.z == null ? 'nan' : Math.round(s.z))).join(','),
        hourly: DMI_VARS.join(','), models: 'dmi_harmonie_arome_europe', forecast_days: '3', timeformat: 'unixtime', timezone: 'GMT' });
      const r = await fetchT(`https://api.open-meteo.com/v1/forecast?${q}`, {}, 45000); if (!r.ok) throw new Error('DMI ' + r.status);
      let j = await r.json(); if (!Array.isArray(j)) j = [j];
      j.forEach((f, k) => dmiCache.set(ch[k].key, { at: now, t: f.hourly.time, h: f.hourly }));
    }
  }
  function dmiAt(key, ms) {
    const c = dmiCache.get(key); if (!c) return null;
    const x = (ms / 1000 - c.t[0]) / 3600; if (x < 0 || x > c.t.length - 1) return null;
    const k = Math.min(c.t.length - 1, Math.round(x)), h = c.h;
    return { vis: h.visibility && h.visibility[k], cape: h.cape && h.cape[k], frz: h.freezing_level_height && h.freezing_level_height[k] };
  }

  /* ---------------- MET's own fog and thunder at the key points (Locationforecast 2.0, browser-direct as the forecast page) ---------------- */
  const metCache = new Map();
  async function fetchMet(pts) {
    const now = Date.now(), need = pts.filter((p) => { const c = metCache.get(p.key); return !c || now - c.at > 60 * 60e3; });
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(3, need.length) }, async () => { while (i < need.length) {
      const p = need[i++];
      try {
        const r = await fetchT(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}${p.z != null ? '&altitude=' + Math.round(p.z) : ''}`);
        if (!r.ok) continue;
        const ts = (await r.json()).properties.timeseries;
        metCache.set(p.key, { at: now, t: ts.map((x) => +new Date(x.time)), fog: ts.map((x) => x.data.instant.details.fog_area_fraction ?? null), th: ts.map((x) => (x.data.next_1_hours ? x.data.next_1_hours.details.probability_of_thunder ?? null : null)) });
      } catch (e) { console.warn('Turvær MET', e); }
    } }));
  }
  function metAt(key, ms) {   // the nearest hour within 3½ hours (hourly for two days, then every six hours)
    const c = metCache.get(key); if (!c) return null;
    let k = -1, bd = 3.5 * 3600e3; c.t.forEach((x, i) => { const d = Math.abs(x - ms); if (d < bd) { bd = d; k = i; } });
    return k < 0 ? null : { fog: c.fog[k], th: c.th[k] };
  }
  /* ---------------- Varsom: NVE's regional avalanche danger for the day (winter) ---------------- */
  const varsomCache = new Map();
  async function fetchVarsom(points, day) {   // [{lat, lon}] -> [{level, region, text}], one per region
    const d = `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`, out = [], seen = new Set();
    for (const p of points) {
      const k = `${p.lat.toFixed(2)},${p.lon.toFixed(2)},${d}`;
      if (!varsomCache.has(k)) varsomCache.set(k, fetchT(`https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/AvalancheWarningByCoordinates/Simple/${p.lat.toFixed(4)}/${p.lon.toFixed(4)}/${LANG === 'nb' ? 1 : 2}/${d}/${d}`).then((r) => (r.ok ? r.json() : [])).catch(() => []));
      (await varsomCache.get(k)).forEach((w) => { if (!seen.has(w.RegionId)) { seen.add(w.RegionId); out.push({ level: +w.DangerLevel || 0, region: w.RegionName, text: w.MainText || '', typeB: w.RegionTypeName === 'B' }); } });
    }
    return out;
  }

  /* ---------------- snow depth on the trail (winter): NVE's seNorge model through api/snow.php ----------------
     Daily values at 07 for each 1 km cell, today and NVE's nine forecast days; read for the day you pass each point. Modelled,
     not measured on the trail: it tells, never scores (the start-time ranking is unchanged; only the verdict's colour moves). */
  const SNOW_MAX = 400, SNOW_MEMO_MS = 30 * 60e3;
  const SNOWSIM = (/[?&]snowsim=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search) || [])[1] || '';   // a past winter replayed (the local test copy only; never in a shared link)
  const snowMemo = new Map();
  function loadSnow(routes, tok) {   // after the first render, like the model weights: one call for the cells of all routes, the chosen route's first
    if (tv.season !== 'winter') return;
    const list = [], seen = new Set();
    [tv.R, ...routes.filter((R) => R !== tv.R)].forEach((R) => {
      R.snowIdx = Int32Array.from(R.dense, (p) => snowCell(p.lat, p.lon));
      R.snowIdx.forEach((i) => { if (i >= 0 && !seen.has(i) && list.length < SNOW_MAX) { seen.add(i); list.push(i); } });   // beyond the cap a cell has no data
    });
    const today = osloDay(new Date()); tv.snowFor = today;   // the Oslo date this fetch is for: a new day fetches again (render)
    if (!list.length) { tv.snow = { cells: {}, days: [], tiles: [], dayIx: new Map(), wx: true }; render(); return; }
    const wx = tv.wax ? '&w=1' : '';   // the wax tips: NVE's history too (the same POSTs on the server), and a replay's hours
    const key = today + '|' + SNOWSIM + '|' + wx + '|' + [...list].sort((a, b) => a - b).join(','), hit = snowMemo.get(key);
    let p = hit && Date.now() - hit.at < SNOW_MEMO_MS ? hit.p : null;
    if (!p) {   // &d: the day in the address, so the browser's 10-minute copy of yesterday's answer is never used today (the server ignores it)
      p = fetchT(`api/snow.php?c=${list.join(',')}${SNOWSIM ? '&sim=' + SNOWSIM : ''}&d=${today}${wx}`, {}, 20000).then((r) => { if (!r.ok) throw new Error('snow ' + r.status); return r.json(); });
      p.then((j) => { if (SNOWSIM && wx && !j.t1from) snowMemo.delete(key); }, () => snowMemo.delete(key)); snowMemo.set(key, { at: Date.now(), p });   // a replay without its hours (budget spent) asks again next time
    }
    const mine = {}; tv.snowLoad = mine;   // while this is out, the wax card waits instead of saying "not available"
    p.then((j) => { if (tok !== tv.token || tv.snowLoad !== mine) return; tv.snowLoad = null; tv.snow = { ...j, dayIx: new Map(j.days.map((d, i) => [d, i])) }; render(); syncForm(); })
      .catch((e) => { if (tok !== tv.token || tv.snowLoad !== mine) return; tv.snowLoad = null; console.warn('Turvær snow', e); tv.snow = { err: true }; render(); });
  }
  const dayIxMemo = new Map();
  const snowDayIx = (ms) => {   // the index of NVE's day for a moment (per hour; Intl is slow in the start-time bars)
    const h = Math.floor(ms / 3600e3); if (!dayIxMemo.has(h)) { if (dayIxMemo.size > 2000) dayIxMemo.clear(); dayIxMemo.set(h, osloDay(new Date(h * 3600e3))); }
    return tv.snow.dayIx.get(dayIxMemo.get(h));
  };
  // the snow at dense point i at a moment: {sd (cm), ski (NVE's class), nf (new snow, cm), a (the model cell's height), st}
  // st: 'bare', 'thin', 'ok', 'glacier' (over 4 m: the model keeps growing snow on glaciers) or 'na' (no cell or no value: never bare)
  function snowAt(R, i, ms) {
    const S = tv.snow; if (!S || !S.cells || !R.snowIdx) return null;
    const k = snowDayIx(ms), c = S.cells[R.snowIdx[i]];
    if (k == null || !c) return { st: 'na', a: c ? c.a : null };
    const sd = c.sd[k], ski = c.ski[k], nf = c.nf[k];
    if (sd == null && ski == null) return { st: 'na', a: c.a };
    // NVE's ski class decides (0 bare, 1 little snow, 2 moist, 3 dry); without it the depth, as the class went in 2025–26 (class 1 is about 7–30 cm)
    const st = sd != null && sd > 400 ? 'glacier' : ski != null ? (ski === 0 ? 'bare' : ski === 1 ? 'thin' : 'ok') : sd < 10 ? 'bare' : sd < 25 ? 'thin' : 'ok';
    return { sd, ski, nf, a: c.a, st };
  }
  const SNOW_LOW = { bare: 1, thin: 1 };
  const snowKm = (v) => Math.floor(v * 2 + 1e-9) / 2;   // down to half a kilometre: under 0.5 is nothing, and never longer than the route
  const snowKmTxt = (v) => { const r = snowKm(v); return fmt(r, r % 1 ? 1 : 0); };
  // the route's snow for a start: the stretches with little or no snow, the typical and the thinnest depth, how sure; per point st[] and at[]
  // for the chart and the stages. Out and back the same way: only the way out is counted (the same trail twice is not twice as bad).
  // The values are daily, so the answer depends on the start only through which of NVE's days each point falls on: kept per that
  // pattern (the start bars ask for some 40 starts, nearly all on one day each)
  function snowSum(R, depMs, pace) {
    const S = tv.snow; if (!S || !S.cells || !R.snowIdx) return null;
    const D = R.dense, f = (PACE[pace] || 1) / (PACE[R.pace] || 1), last = R.turnDi >= 0 && /^(direct|up|up2)$/.test(R.kind) ? R.turnDi : D.length - 1;
    const etaOf = (i) => depMs + R.mins[i] * f * 60e3 + (R.turnDi >= 0 && i > R.turnDi ? (R.pause || 0) * 60e3 : 0);
    const k0 = snowDayIx(etaOf(0)); let pat = String(k0);
    if (snowDayIx(etaOf(D.length - 1)) !== k0) { let k = k0; for (let i = 1; i < D.length; i++) { const x = snowDayIx(etaOf(i)); if (x !== k) { pat += `,${i}:${x}`; k = x; } } }   // over midnight: where the day changes
    const memo = (R.snowMemo ||= new Map()), key = `${S.at}|${S.sim || ''}|${pat}`;
    if (memo.has(key)) return memo.get(key);
    const st = new Array(D.length), at = new Array(D.length), sds = [], cellZ = new Map(), cB = new Set(), cT = new Set();
    let kmBare = 0, kmThin = 0, kmNa = 0, kmGlacier = 0, kmTot = 0, nfMax = 0, nfK = null, dry = 0, okN = 0, anyBareSd = false, allBelow1 = true;
    const runs = { bare: null, low: null }, best = { bare: null, low: null };
    const close = (k, i) => { const r = runs[k]; if (r) { r.km = D[r.b].km - (r.a ? D[r.a - 1].km : 0); if (!best[k] || r.km > best[k].km) best[k] = r; runs[k] = null; } };
    for (let i = 0; i < D.length; i++) {
      const eta = etaOf(i), x = snowAt(R, i, eta);
      st[i] = x ? x.st : 'na'; at[i] = x;
      if (i > last) continue;
      const w = i ? D[i].km - D[i - 1].km : 0, c = R.snowIdx[i]; kmTot += w;
      if (x.st === 'na') kmNa += w; else if (x.st === 'glacier') kmGlacier += w;
      else { if (x.sd != null) sds.push(x.sd); if (x.st === 'ok') { okN++; if (x.ski === 3) dry++; } }
      if (x.st === 'bare') { kmBare += w; cB.add(c); if (x.sd != null && x.sd >= 1) anyBareSd = true; }
      if (x.st === 'thin') { kmThin += w; cT.add(c); }
      if (x.st !== 'na' && x.sd != null && x.sd >= 1) allBelow1 = false;
      if (x.nf != null && x.nf > nfMax) { nfMax = x.nf; nfK = snowDayIx(eta); }
      if (x.a != null && D[i].z != null && c >= 0) { const g = cellZ.get(c) || { a: x.a, z: 0, n: 0, i }; g.z += D[i].z; g.n++; cellZ.set(c, g); }
      ['bare', 'low'].forEach((k) => { const on = k === 'bare' ? x.st === 'bare' : SNOW_LOW[x.st]; if (on) { if (runs[k]) runs[k].b = i; else runs[k] = { a: i, b: i }; } else close(k, i); });
    }
    close('bare'); close('low');
    ['bare', 'low'].forEach((k) => { if (best[k]) best[k].mid = Math.round((best[k].a + best[k].b) / 2); });
    sds.sort((a, b) => a - b);
    const q = (p) => (sds.length ? sds[Math.min(sds.length - 1, Math.floor(p * sds.length))] : null);
    const gaps = [...cellZ.values()].map((g) => ({ d: g.a - g.z / g.n, i: g.i })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    const gap = gaps.length ? gaps[gaps.length - 1] : null, gapMed = gaps.length ? Math.abs(gaps[Math.floor(gaps.length / 2)].d) : 0;
    const na = kmTot ? kmNa / kmTot : 1;
    const out = { kmBare, kmThin, kmNa, kmGlacier, kmTot, cellsBare: cB.size, cellsThin: cT.size, med: q(0.5), p10: q(0.1), dry: okN ? dry / okN : null, nfMax, nfK,
      scant: anyBareSd, worst: best.bare || best.low, worstBare: best.bare, worstLow: best.low, gap, allZero: kmTot > 0 && kmBare >= 0.9 * kmTot && allBelow1, allBare: kmTot > 0 && kmBare >= 0.9 * kmTot, st, at, last,
      conf: !kmTot || na >= 0.9 ? 'none' : na > 0.2 || gapMed > 250 ? 'low' : 'ok' };
    memo.set(key, out); return out;
  }
  const snowOk = (s) => (tv.season === 'winter' && s.snow && s.snow.conf === 'ok' ? s.snow : null);
  const snowBareH = (w) => w.allBare || (w.kmBare >= 1 && w.cellsBare >= 2 && w.worstBare);   // the headline rules, also for the day chips
  const snowThinH = (w) => (w.kmThin + w.kmBare >= 2 || (w.kmTot && (w.kmThin + w.kmBare) / w.kmTot >= 0.2)) && w.cellsThin + w.cellsBare >= 2 && w.worstLow && snowKm(w.kmThin + w.kmBare) >= 0.5;
  const nextDay = (iso) => new Date(Date.parse(iso + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10);
  const snowDayName = (k) => {   // NVE's day k as "i dag", "i morgen" or its weekday and date, by the date (after midnight day 0 is yesterday)
    const S = tv.snow, iso = S && S.days ? S.days[k] : null; if (!iso) return '';
    const today = osloDay(new Date()), d = new Date(iso + 'T12:00:00');
    return iso === today ? t('kv.today').toLowerCase() : iso === nextDay(today) ? t('kv.tomorrow').toLowerCase() : `${wday(d)} ${d.getDate()}.`;
  };
  const snowDayLabel = (ms) => snowDayName(tv.snow && tv.snow.dayIx ? snowDayIx(ms) : null);

  /* ---------------- smøretips (winter, an option): grip wax for the air temperature when you are there and NVE's snow history ----------------
     Every maker uses one colour order: grønn → blå → blå ekstra → fiolett → rød → gul (hard wax), and blå, fiolett, universal and rød
     klister. The tip is the colour with its band; brands are only examples. Sources and measurements: the wax research and spec
     (2026-10-07; source keys as there). "eget anslag" marks our own estimates. Read for the chosen route only, once a render, never in
     the start-time bars. Intervals run cold to warm: the lower edge is exclusive, the upper inclusive. */
  const WAX = {
    // hard wax by snow group, [class, upper edge °C]. Swix V-series (swix_v), checked against holmenkol, rode (North Europe), vauhti
    NEW: [['green', -10], ['blue', -7], ['bluex', -3], ['violet', 0], ['red', 1], ['yellow', 3]],   // new / fine-grained snow (swix_v new ranges; -10 and -7 split brand overlaps: eget anslag); above +3 -> KL (no maker's yellow goes past +4; swix_vp VP70)
    OLD: [['green', -15], ['blue', -10], ['bluex', -4], ['violet', -1], ['red', 0], ['yellow', 1]],        // older, transformed snow (swix_v old ranges; -4 splits V40/V45: eget anslag); above +1 -> KL
    KL: [['kblue', -3], ['kviolet', 0], ['kuni', 3], ['kred', Infinity]],                                 // klister (swix_k KX30, KX45N, K22, KX65/KX75; holmenkol, vauhti)
    WET_HI: 3,            // falling or fresh snow from this warm = very wet new snow -> klister, lead 'rain' (swix_vp VP70; the edge: eget anslag)
    ZERO_LO: -1,          // new or falling snow warmer than this = nullføre (swix_zero "-1…+1")
    NEW_CM: 2,            // new snow (sdfsw) from this many cm counts as a snowfall (NVE's legend class "<5" starts at 2; eget anslag)
    NEW_DAYS: 7,          // snow this many days after the last snowfall counts as older snow (eget anslag)
    THAW_DAYS: 8,         // NVE ski class 2 on D-7..D (all of hs) = a thaw; the crust it leaves stays until new snow covers it (swix_k KX30, Swix snow group 5; the window: eget anslag)
    COVER_CM: 3,          // this much new snow since the thaw hides the crust: hard wax again (eget anslag)
    EDGE: 0.5, EDGE0: 1,  // within this many degrees under the softer edge: "ta med" the next softer class; EDGE0 for edges from -3 to +1, where a 1–2 °C forecast error flips the class (eget anslag)
    MAJOR_PC: 0.15, MAJOR_KM: 2,   // a class counts on the route from 15 % of the km with a class, or 2 km (eget anslag)
    ZERO_PC: 0.2, ZERO_KM: 2,      // nullføre or rain on this much leads the card (eget anslag)
    MIN_PC: 0.6,          // under 60 % of the km with a class -> "ingen smøretips" (eget anslag)
    DRY_TD: -2, DRY_HI: 1.5,   // thawed snow at 0…DRY_HI with the dew point at or under DRY_TD -> violet klister (raleigh2013: a tie-breaker only, eget anslag; KX45N goes to +1, Holmenkol to +2)
    HUMID: 2,             // Ta - Td at or under this on new snow near 0 -> "kork godt" (swix_v V40 note, holmenkol Blue Spezial: eget anslag)
    LAPSE: 0.0065,        // °C per metre, sim only: from the NVE cell's height to the trail (standard atmosphere: eget anslag for this use)
    SOFT_PC: 0.2, CRUST_PC: 0.2, UNSURE_PC: 0.5,   // shares of km for the edge, crust and "usikkert" lines (eget anslag)
    NOW_MIN: 15,          // a softer class from within this many minutes of the start: "ta med … i tilfelle", no clock time
  };
  const WAX_HARD = ['green', 'blue', 'bluex', 'violet', 'red', 'yellow'], WAX_KL = ['kblue', 'kviolet', 'kuni', 'kred'];   // hardest first
  const WAX_HIST = 7;   // api/snow.php's hs/hn: NVE's days D-7..D-1
  const WAX_COL = { new: WAX.NEW, old: WAX.OLD, kl: WAX.KL };
  // examples only, A–Z by brand, each with the maker's own range (wax research §1–2); never the tip itself
  const WAX_EX = { green: 'Holmenkol Grip Green, Rode P20, Swix V20', blue: 'Holmenkol Grip Blue, Rode P36, Swix V30', bluex: 'Holmenkol Grip Blue Extra, Rode P38, Swix V40',
    violet: 'Holmenkol Grip Violet Spezial, Rode P46, Swix V45', red: 'Holmenkol Grip Red, Rode P42, Swix V55', yellow: 'Holmenkol Grip Yellow, Rode P60, Swix V60',
    kblue: 'Holmenkol Klister Blue, Swix KX30, Vauhti KS Blue', kviolet: 'Holmenkol Klister Violet, Swix KX45N, Vauhti KS Violet', kuni: 'Holmenkol Klister Universal, Swix K22, Vauhti KS Universal', kred: 'Swix KX65, Vauhti KS Red' };
  const isKl = (c) => WAX_KL.includes(c);
  const waxRank = (c) => (isKl(c) ? 10 + WAX_KL.indexOf(c) : WAX_HARD.indexOf(c));   // harder first; klister after all hard wax
  const waxIx = (C, Ta) => { const i = C.findIndex(([, e]) => Ta <= e); return i < 0 ? C.length - 1 : i; };
  // the replay's air temperature (sim only): NVE's hourly tm1h for the replayed day at the same Oslo clock time, from the cell's height to the trail's
  const OSLO_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const osloParts = (ms) => { const o = {}; OSLO_HM.formatToParts(new Date(ms)).forEach((x) => { if (x.type !== 'literal') o[x.type] = +x.value; }); return o; };
  const osloUtc = (y, mo, d, h, mi) => { const w = Date.UTC(y, mo - 1, d, h, mi); let g = w; for (let k = 0; k < 2; k++) { const o = osloParts(g); g = w - (Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute) - g); } return g; };   // CET or CEST by that date, from Intl
  function simTa(p, c) {
    const S = tv.snow; if (!S.sim || !S.t1from || !c.t1) return null;
    const o = osloParts(+p.at), off = Math.round((Date.UTC(o.year, o.month - 1, o.day) - Date.parse(S.d0 + 'T00:00:00Z')) / 86400e3);   // days after today
    const d = new Date(Date.parse(S.sim + 'T00:00:00Z') + off * 86400e3);
    const x = (osloUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), o.hour, o.minute) - S.t1from * 1000) / 3600e3, i = Math.floor(x);
    if (i < 0 || i >= c.t1.length) return null;
    const a = c.t1[i], b = i + 1 < c.t1.length ? c.t1[i + 1] : a; if (a == null || b == null) return null;
    const T = a + (b - a) * (x - i);
    return p.z != null && c.a != null ? T + WAX.LAPSE * (c.a - p.z) : T;
  }
  // the wax at a sample point: {c, type, col, soft, unsure, cork, cover, crust, lead, Ta}; null without a tip; {noTa} when a replay has no temperature
  function waxAt(R, p, sim) {
    const x = snowAt(R, p.di, +p.at); if (!x || x.st === 'bare' || x.st === 'na') return null;
    const c = tv.snow.cells[R.snowIdx[p.di]], k = snowDayIx(+p.at); if (!c || k == null) return null;
    const Ta = sim ? simTa(p, c) : p.t; if (!Number.isFinite(Ta)) return sim ? { noTa: true } : null;   // a replay never takes today's forecast
    let unknown = false; const need = (v) => { if (v == null) unknown = true; return v ?? 0; };
    const ski = (j) => (j < 0 ? (c.hs ? c.hs[WAX_HIST + j] : null) : c.ski[j]) ?? null, nf = (j) => (j < 0 ? (c.hn ? c.hn[WAX_HIST + j] : null) : c.nf[j]) ?? null;
    // in a replay NVE has no hour of precipitation. Thunder (kvcore: code 95+ whatever the temperature) is rain from +1, falling snow under
    const cls = sim ? null : p.cls, th = cls === 'thunder', ice = cls === 'ice';
    const fall = cls === 'snow' || (th && Ta < 1), sleet = cls === 'sleet', rain = cls === 'wet' || cls === 'heavy' || ice || (th && Ta >= 1);
    const fresh = need(nf(k)) >= WAX.NEW_CM || need(nf(k - 1)) >= WAX.NEW_CM;   // a snowfall in the ~48 h to 07 on the day
    let thawJ = null; for (let j = k; j > k - WAX.THAW_DAYS; j--) if (need(ski(j)) === 2) { thawJ = j; break; }
    let since = 0; if (thawJ != null) for (let j = thawJ + 1; j <= k; j++) since += need(nf(j));   // new snow on the crust
    let fallJ = null; for (let j = k; j > k - WAX.NEW_DAYS; j--) if (need(nf(j)) >= WAX.NEW_CM) { fallJ = j; break; }
    let thawAfter = false; if (fallJ != null) for (let j = fallJ + 1; j <= k; j++) if (need(ski(j)) === 2) thawAfter = true;
    // snow falling on the crust at -1 or colder: new snow, hard wax, the crust noted (once fresh snow lies, hard wax is what counts: swix_k)
    const type = rain || (sleet && Ta >= 1) || ((fall || fresh) && Ta >= WAX.WET_HI) ? 'rain' : (fall || sleet || fresh) && Ta > WAX.ZERO_LO ? 'zero'
      : unknown ? 'new' : thawJ != null && since < WAX.COVER_CM && !fall ? 'thawed' : fall || (fallJ != null && !thawAfter) ? 'new' : 'old';   // unknown history: the harder wax, which a softer one can go on top of
    const Td = sim ? NaN : p.dew;
    let col = type === 'rain' || type === 'thawed' ? 'kl' : type === 'old' ? 'old' : 'new';
    if (col !== 'kl' && Ta > WAX_COL[col][WAX_COL[col].length - 1][1]) col = 'kl';   // warmer than yellow: klister
    const C = WAX_COL[col]; let i = waxIx(C, Ta);
    if (type === 'rain' && !(ice && Ta <= 0)) i = Math.max(i, 2);   // rain on snow: never colder than universal klister; freezing rain under 0 glazes the track: klister by the temperature
    const dryKv = type === 'thawed' && Ta > 0 && Ta <= WAX.DRY_HI && Number.isFinite(Td) && Td <= WAX.DRY_TD; if (dryKv) i = 1;
    const e = C[i][1], edge = e >= -3 && e <= 1 ? WAX.EDGE0 : WAX.EDGE;
    const soft = !dryKv && i + 1 < C.length && Number.isFinite(e) && Ta > e - edge && Ta <= e ? C[i + 1][0] : null;
    const cover = type === 'thawed' && since >= 1;   // a little new snow on the crust: a thin layer of the hard wax for new snow over the klister
    return { c: C[i][0], type, col, soft, unsure: unknown, Ta, lead: type === 'rain' || type === 'zero' ? type : null, lbl: type === 'thawed' && Ta > 0 ? 'wet' : type,
      cork: type === 'zero' && Number.isFinite(Td) && Ta - Td <= WAX.HUMID, cover, coverC: cover ? WAX.NEW[waxIx(WAX.NEW, Ta)][0] : null, crust: (type === 'new' || type === 'old') && thawJ != null,
      fallAgo: unknown ? null : fallJ != null ? k - fallJ : -1, thawAgo: unknown ? null : thawJ != null ? k - thawJ : -1 };   // for the basis line: days since; -1 none in the window, null unknown
  }
  // the chosen route's wax: per point, the classes that count, stretches, what the card leads with, where to rewax. Memoised on s.
  function waxSum(s) {
    if (s.waxS !== undefined) return s.waxS;
    const S = tv.snow, R = s.R; if (!S || !S.cells || !S.wx || !R.snowIdx) return (s.waxS = null);
    const sim = !!S.sim, pts = s.pts, n = pts.length, P = [];
    let kmTot = 0, kmCl = 0, kmNoTa = 0;
    for (let q = 0; q < n; q++) {   // a point's class holds to the next point; out and back both count (two passes, two times)
      const p = pts[q], km = q + 1 < n ? Math.max(0, pts[q + 1].km - p.km) : 0, w = waxAt(R, p, sim), ok = !!(w && w.c);
      kmTot += km; if (ok) kmCl += km; else if (w && w.noTa) kmNoTa += km;
      P.push({ di: p.di, at: p.at, km, w: ok ? w : null });
    }
    const quiet = !s.snow || s.snow.allBare || s.snow.conf === 'none';   // the snow card already says there is no snow (or no model)
    if (!kmTot || kmCl / kmTot < WAX.MIN_PC) return (s.waxS = { none: true, quiet, na: kmNoTa > 0 && kmNoTa >= kmTot - kmCl - kmNoTa, kmClassed: kmCl, kmTot, pts: P.map((x) => ({ di: x.di, at: +x.at, wax: x.w })) });
    const kmC = {}; P.forEach((x) => { if (x.w) kmC[x.w.c] = (kmC[x.w.c] || 0) + x.km; });
    let major = Object.keys(kmC).filter((c) => kmC[c] >= WAX.MAJOR_PC * kmCl || kmC[c] >= WAX.MAJOR_KM);
    if (!major.length) major = [Object.keys(kmC).sort((a, b) => kmC[b] - kmC[a])[0]];
    // a minor class goes to the major before it in time (at the start: the one after): no flicker between colours
    let prev = null; const mc = P.map((x) => (x.w ? (major.includes(x.w.c) ? (prev = x.w.c) : prev) : null));
    for (let q = mc.length - 1, nx = null; q >= 0; q--) { if (P[q].w && major.includes(P[q].w.c)) nx = P[q].w.c; if (P[q].w && mc[q] == null) mc[q] = nx; }
    const st = [];   // stretches of one class; a point without a class stays in the stretch it is in
    P.forEach((x, q) => { if (!x.w) { if (st.length) st[st.length - 1].q1 = q; return; } const c = mc[q], z = st[st.length - 1];
      if (z && z.c === c) { z.q1 = q; z.km += x.km; z.cols[x.w.col] = (z.cols[x.w.col] || 0) + x.km; z.types[x.w.lbl] = (z.types[x.w.lbl] || 0) + x.km; }
      else st.push({ c, q0: q, q1: q, km: x.km, cols: { [x.w.col]: x.km }, types: { [x.w.lbl]: x.km } }); });
    const most = (o) => Object.keys(o).sort((a, b) => o[b] - o[a])[0], add = (o, x) => { for (const k in x) o[k] = (o[k] || 0) + x[k]; };
    // two major classes can still take turns near an edge (Finse 2026-03-01: blue and blue extra around -7 °C, 1 km each): a stretch under
    // MAJOR_KM goes to the one before it (the first: the one after), then equal neighbours join (eget anslag). Never across hard wax and
    // klister, and never a class's last stretch: every class that counts keeps a stretch, so the card, the rows and the stages agree
    for (let j = 0; st.length > 1 && j < st.length; ) {
      const z = st[j], fam = (o) => o && isKl(o.c) === isKl(z.c), o = fam(st[j - 1]) ? st[j - 1] : fam(st[j + 1]) ? st[j + 1] : null;
      if (z.km >= WAX.MAJOR_KM || !o || !st.some((y) => y !== z && y.c === z.c)) { j++; continue; }
      o.km += z.km; add(o.cols, z.cols); add(o.types, z.types); if (o === st[j - 1]) o.q1 = z.q1; else o.q0 = z.q0; st.splice(j, 1);
      for (let k = 1; k < st.length; ) { if (st[k].c === st[k - 1].c) { const a = st[k - 1], b = st[k]; a.km += b.km; add(a.cols, b.cols); add(a.types, b.types); a.q1 = b.q1; st.splice(k, 1); } else k++; }
      j = 0;
    }
    const stretches = st.map((z, j) => ({ c: z.c, di: P[z.q0].di, t0: +P[z.q0].at, t1: +(j + 1 < st.length ? P[st[j + 1].q0].at : s.end), km: z.km, col: isKl(z.c) ? 'kl' : (z.cols.new || 0) >= (z.cols.old || 0) ? 'new' : 'old', type: most(z.types) }));
    const kmT = (f) => P.reduce((a, x) => a + (x.w && f(x.w) ? x.km : 0), 0), big = (km) => km >= WAX.ZERO_KM || km >= WAX.ZERO_PC * kmCl;
    const majors = [...new Set(major)].sort((a, b) => waxRank(a) - waxRank(b));   // each has a stretch (above)
    const lead = big(kmT((w) => w.type === 'rain')) ? 'rain' : big(kmT((w) => w.type === 'zero')) ? 'zero' : majors.some(isKl) && majors.some((c) => !isKl(c)) ? 'mixed' : null;
    const out = { sim, lead, stretches, kmClassed: kmCl, kmTot, main: majors[0], add: null, then: [], notes: {}, tag: null, pts: P.map((x) => ({ di: x.di, at: +x.at, Ta: x.w ? +x.w.Ta.toFixed(1) : null, wax: x.w })) };
    // the hardest first, always: a softer wax goes on top of a harder one, not the other way round (swix_turbirken2026), and near 0 a harder
    // start ices less (swix_zero)
    const start = +pts[0].at;
    if (lead) {   // the safe choice first, then "ellers <hardest>" and up to two softer classes in the order they come (as the stages' "Smør om")
      let on = out.main;
      stretches.forEach((z) => { if (waxRank(z.c) > waxRank(on) && out.then.length < 2) { on = z.c; out.then.push({ c: z.c, at: z.t0, now: z.t0 - start <= WAX.NOW_MIN * 60e3 }); } });
    } else {
      const soft = majors[majors.length - 1], first = stretches.find((z) => z.c === soft);
      const ofMain = P.filter((x) => x.w && x.w.c === out.main), softKm = ofMain.reduce((a, x) => a + (x.w.soft ? x.km : 0), 0), crust = P.filter((x) => x.w && x.w.crust), crustKm = crust.reduce((a, x) => a + x.km, 0);
      if (majors.length > 1) out.add = { k: first.t0 - start <= WAX.NOW_MIN * 60e3 ? 'addn' : 'add', c: soft, at: first.t0 };
      else if (kmC[out.main] && softKm >= WAX.SOFT_PC * kmC[out.main]) { const sc = {}; ofMain.forEach((x) => { if (x.w.soft) sc[x.w.soft] = (sc[x.w.soft] || 0) + x.km; }); out.add = { k: 'addn', c: most(sc) }; out.notes.unsure = true; }
      else if (crustKm >= WAX.CRUST_PC * kmCl) { const ta = crust.map((x) => x.w.Ta).sort((a, b) => a - b)[Math.floor(crust.length / 2)]; out.add = { k: 'crustadd', c: ta <= -3 ? 'kblue' : 'kviolet' }; }
      // the collapsed card's short tail: the crust when the line says something else, or a thin hard-wax layer over the klister
      const cov = P.filter((x) => x.w && x.w.cover && x.w.c === out.main);
      if (out.add && out.add.k !== 'crustadd' && crustKm >= WAX.CRUST_PC * kmCl) out.tag = { k: 'tcrust' };
      else if (isKl(out.main) && cov.reduce((a, x) => a + x.km, 0) >= WAX.CRUST_PC * kmCl) { const cc = {}; cov.forEach((x) => { cc[x.w.coverC] = (cc[x.w.coverC] || 0) + x.km; }); out.tag = { k: 'tcover', c: most(cc) }; }
    }
    out.weak = (s.snow && s.snow.conf === 'low') || majors.some((c) => { const all = kmC[c] || 0, uns = P.reduce((a, x) => a + (x.w && x.w.c === c && x.w.unsure ? x.km : 0), 0); return all > 0 && uns >= WAX.UNSURE_PC * all; });
    ['cover', 'crust', 'cork'].forEach((k) => { if (P.some((x) => x.w && x.w[k])) out.notes[k] = true; });
    const ta = P.filter((x) => x.w).map((x) => x.w.Ta); out.tmin = Math.min(...ta); out.tmax = Math.max(...ta);
    const colC = {}; P.forEach((x) => { if (x.w) { const o = (colC[x.w.c] = colC[x.w.c] || {}); o[x.w.col] = (o[x.w.col] || 0) + x.km; } });
    out.colOf = {}; for (const c in colC) out.colOf[c] = isKl(c) ? 'kl' : most(colC[c]);   // the column a class's band comes from (new or older snow)
    // the basis line: the snow history at the middle of the km with a class (days since the last snowfall and the last thaw)
    let acc = 0; const mid = P.find((x) => x.w && (acc += x.km) >= kmCl / 2) || P.find((x) => x.w); out.hist = { fall: mid.w.fallAgo, thaw: mid.w.thawAgo };
    // where to rewax: where a softer class than the one on the skis starts (a harder one cannot go on top: no mark when it gets colder again).
    // The skis start with the card's class (the head says it, with "ta med" for a softer one from the start)
    let on = out.main; out.change = [];
    stretches.forEach((z, j) => { if (waxRank(z.c) <= waxRank(on)) return; on = z.c; if (j && z.t0 - start > WAX.NOW_MIN * 60e3) out.change.push({ di: z.di, c: z.c, at: z.t0 }); });
    return (s.waxS = out);
  }

  /* ---------------- the weather along the trail ---------------- */
  function along(R, depMs, pace) {
    const base = R.mins, f = (PACE[pace] || 1) / (PACE[R.pace] || 1), pts = [];
    R.samples.forEach((i, si) => {
      const s = R.dense[i], eta = depMs + base[i] * f * 60e3 + (R.turnDi >= 0 && i > R.turnDi ? R.pause * 60e3 : 0);
      const w = wxAt(s.key, eta) || { t: NaN, mm: 0, code: 0, g: 0, day: 1, dew: NaN, wind: null, app: NaN };
      const p = { ...s, di: i, at: new Date(eta), ...w, top: R.tops.includes(i) };
      p.cls = classify(p.code, p.mm, p.t);
      const ek = R.ensNear[si], others = ek && Number.isFinite(p.t) ? ensAt(ek, eta) : [];
      if (others.length >= 2) vote(p, others, { far: eta - Date.now() >= 48 * 3600e3, pass: p.top || (p.z != null && p.z >= EXPOSED_Z), gust: GUST, wAreas: R.wAreas, km: p.km });
      const dk = R.dmiNear[si] ? dmiAt(R.dmiNear[si], eta) : null, mt = R.dmiNear[si] ? metAt(R.dmiNear[si], eta) : null;
      p.vis = dk && dk.vis != null ? dk.vis : w.vis; p.cape = dk && dk.cape != null ? dk.cape : w.cape; p.frz = dk ? dk.frz : null;   // DMI where it reaches, else the main forecast's values
      p.exposed = p.top || (p.z != null && p.z >= EXPOSED_Z);
      p.gust = p.g >= GUST; p.gustHard = p.g >= GUST_HARD;
      p.dark = !p.day;
      p.fogMet = mt && mt.fog != null ? mt.fog : null; p.thP = mt && mt.th != null ? mt.th : null;   // MET's fog area fraction (%) and thunder probability (%)
      p.fog = p.cls === 'fog' || (p.vis != null && p.vis < 400 && p.exposed) || (p.fogMet != null && p.fogMet >= 50 && p.exposed);
      p.thunder = p.cls === 'thunder' || (p.cape != null && p.cape >= 800 && p.mm >= 0.5) || (p.thP != null && p.thP >= 30);
      p.coldHard = Number.isFinite(p.app) && p.app <= -15;
      p.whiteout = tv.season === 'winter' && p.exposed && (p.fog || p.cls === 'snow') && p.wind != null && p.wind >= 8;   // snow or fog in wind on open ground
      p.freezing = p.frz != null && p.z != null && p.frz < p.z && Number.isFinite(p.t) && p.t <= 1;   // snow on the ground up here, by this model
      p.slick = p.t > -4 && p.t <= 3 && (p.mm >= 0.1 || (Number.isFinite(p.dew) && p.t - p.dew < 1.5 && !p.day));
      p.cold = Number.isFinite(p.app) && p.app <= -8;
      p.alert = alertAt(p);
      pts.push(p);
    });
    return pts;
  }
  function summarise(R, depMs, pace) {
    const pts = along(R, depMs, pace), seg = segments(pts, W), x = crossings(pts);
    const mins = {}; let sc = 0;
    pts.forEach((p, i) => { if (!i) return; const q = pts[i - 1], m = (p.at - q.at) / 60e3; mins[q.cls] = (mins[q.cls] || 0) + m;
      const ex = q.exposed ? 1.5 : 1;
      sc += m * (W[q.cls] + (q.thunder && q.exposed ? 8 : 0) + (q.gustHard ? 8 * ex : q.gust ? 4 * ex : 0) + (q.fog && q.exposed ? 3 : 0) + (q.dark ? 8 : 0) + (q.cold ? 2 : 0) + (q.coldHard ? 4 : 0) + (q.whiteout ? 8 : 0) + (q.slick && q.exposed ? 2 : 0) + (q.alert ? 4 : 0)); });
    const valid = pts.every((p) => Number.isFinite(p.t));
    return { R, pts, seg, x, mins, sc, valid, end: pts[pts.length - 1].at, tmin: Math.min(...pts.map((p) => p.t)), gmax: Math.max(...pts.map((p) => p.g)), snow: tv.season === 'winter' ? snowSum(R, depMs, pace) : null };   // the snow is told, not scored
  }
  function sunTimes(R, dayMs) {   // sunrise and sunset at the end of the hike on that day, from the forecast's is_day
    const key = R.dense[R.dense.length - 1].key, d0 = new Date(dayMs); d0.setHours(0, 0, 0, 0);
    let rise = null, set = null;
    for (let h = 0; h < 24; h++) { const a = wxAt(key, +d0 + h * 3600e3), b = wxAt(key, +d0 + (h + 1) * 3600e3); if (!a || !b) continue; if (!a.day && b.day && !rise) rise = new Date(+d0 + (h + 1) * 3600e3); if (a.day && !b.day && !set) set = new Date(+d0 + (h + 1) * 3600e3); }
    return { rise, set };
  }
  const placeName = (R, p) => { const l = R.legs.filter((x) => Math.abs(x.km - p.km) <= 1.5)[0]; return l ? l.name : p.km < 0.75 && tv.a ? tv.a.n : R.km - p.km < 0.75 && tv.b ? tv.b.n : p.top ? topName(p) : null; };   // near an end: its name, not "etter 0 km"
  const placeOf = (R, p) => placeName(R, p) || t('tv.at.km', { km: Math.round(p.km) });
  const placeDi = (R, i) => placeOf(R, { ...R.dense[i], top: R.tops.includes(i) });
  // where on the route, with its own preposition: "ved Mylla" or "ca. 19 km inn"; most: "mest ved Mylla" (the longest of several stretches)
  const snowWhere = (R, i, most) => { const n = placeName(R, { ...R.dense[i], top: R.tops.includes(i) }), w = n ? t('tv.snow.p.at', { p: n }) : t('tv.snow.p.km', { km: Math.round(R.dense[i].km) }); return most ? t('tv.snow.p.most', { p: w }) : w; };
  // the headline's and the card's snow line: the total km (as the chips), placed at the longest stretch
  const snowBareTxt = (R, w, pre) => t(w.scant ? pre + 'scant' : pre + 'bare', { km: snowKmTxt(Math.max(0.5, w.kmBare)), p: snowWhere(R, w.worstBare.mid, snowKm(w.kmBare) - snowKm(w.worstBare.km) >= 0.5) });
  const snowThinTxt = (R, w, pre) => { const km = w.kmThin + w.kmBare; return t(pre + 'thin', { km: snowKmTxt(Math.max(0.5, km)), p: snowWhere(R, w.worstLow.mid, snowKm(km) - snowKm(w.worstLow.km) >= 0.5) }); };
  // the one line that changes the plan, in priority order; then the smaller things
  function headline(s) {
    const pts = s.pts, R = s.R, place = (p) => placeOf(R, p), sw = snowOk(s);
    const when = (p) => t('tv.about', { h: hm(p.at) });
    const av = (R.varsom || []).filter((v) => v.level >= 3).sort((a, b) => b.level - a.level)[0];
    if (av) return { kind: 'bad', text: t('tv.h.avalanche', { l: av.level, n: t('tv.av.' + av.level), r: av.region }) };
    const th = pts.find((p) => p.thunder && p.exposed) || pts.find((p) => p.thunder);
    if (th) return { kind: 'bad', text: t('tv.h.thunder', { p: place(th), h: when(th) }) };
    const wo = pts.find((p) => p.whiteout);
    if (wo) return { kind: 'bad', text: t('tv.h.whiteout', { p: place(wo), h: when(wo) }) };
    const ch = pts.filter((p) => p.coldHard && p.exposed).sort((a, b) => a.app - b.app)[0];
    if (ch) return { kind: 'bad', text: t('tv.h.cold', { t: Math.round(ch.app), p: place(ch), h: when(ch) }) };
    const gh = pts.filter((p) => p.gustHard && p.exposed).sort((a, b) => b.g - a.g)[0];
    if (gh) return { kind: 'bad', text: t('tv.h.gusthard', { g: Math.round(gh.g), p: place(gh), h: when(gh) }) };
    const sn = pts.find((p) => (p.cls === 'snow' || p.cls === 'sleet' || p.cls === 'ice') && p.exposed);
    if (sn) return { kind: 'bad', text: t('tv.h.' + FAM[sn.cls], { p: place(sn), h: when(sn) }) };
    if (sw && snowBareH(sw)) return { kind: 'mid', snow: true, text: sw.allZero ? t('tv.snow.h.none') : sw.allBare ? t('tv.snow.h.scantall') : snowBareTxt(R, sw, 'tv.snow.h.') };   // nearly the whole route: no place to name   // NVE's model: no skiing there (after the dangerous weather, never over it)
    const fg = pts.find((p) => p.fog && p.exposed);
    if (fg) return { kind: 'mid', text: t('tv.h.fog', { p: place(fg), h: when(fg) }) };
    const g = pts.filter((p) => p.gust && p.exposed).sort((a, b) => b.g - a.g)[0];
    if (g) return { kind: 'mid', text: t('tv.h.gust', { g: Math.round(g.g), p: place(g), h: when(g) }) };
    const sun = sunTimes(R, +s.end);
    if (sun.set && s.end > sun.set) return { kind: 'mid', text: t(R.turnDi >= 0 || isLoop() ? 'tv.h.dark.back' : 'tv.h.dark', { set: hm(sun.set), end: hm(s.end) }) };
    const hv = pts.find((p) => p.cls === 'heavy');
    if (hv) return { kind: 'mid', text: t('tv.h.heavy', { p: place(hv), h: when(hv) }) };
    if (sw && snowThinH(sw)) return { kind: 'mid', snow: true, text: snowThinTxt(R, sw, 'tv.snow.h.') };
    const worst = KV_CLASSES.filter((c) => c !== 'dry' && (s.mins[c] || 0) >= 10).sort((a, b) => W[b] - W[a])[0];
    if (worst) return { kind: 'ok', text: t('tv.h.some', { w: t('kv.c.' + worst).toLowerCase(), d: dur(s.mins[worst]) }) };
    return { kind: 'good', text: t('tv.h.fine') };
  }
  function smallThings(s, h) {   // the chips under the headline (h: the headline, when the caller has it)
    const out = [], pts = s.pts, top = pts.filter((p) => p.top).sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0];
    if (top && Number.isFinite(top.app)) out.push(['cold', t('tv.s.feels', { t: Math.round(top.app), p: t('tv.at.top') })]);
    if (top && Number.isFinite(top.g)) out.push([top.gust ? 'warn' : '', t('tv.s.gust', { g: Math.round(top.g) })]);
    const ap = s.R.approach || {}; [['a', tv.a], ['b', tv.b]].forEach(([k, p]) => { if (ap[k] >= 20) out.push(['warn', t(tv.season === 'winter' ? 'tv.approach.w' : 'tv.approach', { m: ap[k], p: p.n })]); });
    if (s.R.steepKm >= 0.1) out.push([s.R.steepMax >= STEEP_HARD ? 'bad' : 'warn', t('tv.steep.chip', { km: fmt(s.R.steepKm, 1), g: s.R.steepMax })]);
    if (s.R.trackKm >= 0.1) out.push(['', t('tv.track.chip', { km: fmt(s.R.trackKm, 1) })]);
    if (pts.some((p) => p.freezing) && !(tv.snow && tv.snow.cells && s.snow && s.snow.conf !== 'none')) out.push(['warn', t('tv.s.snowline')]);   // the freezing level's guess, until NVE's snow is there
    if (pts.some((p) => p.slick && p.exposed)) out.push(['warn', t('kv.slick')]);
    const sun = sunTimes(s.R, +s.end); if (sun.set) out.push([s.end > sun.set ? 'warn' : '', t(s.R.turnDi >= 0 || isLoop() ? 'tv.s.sunset.back' : 'tv.s.sunset', { h: hm(sun.set), e: hm(s.end) })]);
    const darkStart = pts[0].dark; if (darkStart && sun.rise) out.push(['warn', t('tv.s.darkstart', { h: hm(sun.rise) })]);
    [...new Set(pts.filter((p) => p.alert).map((p) => p.alert))].slice(0, 1).forEach((a) => out.push(['warn', '⚠ ' + a]));
    (s.R.varsom || []).forEach((v) => { if (v.level >= 1) out.push([v.level >= 3 ? 'bad' : 'warn', t('tv.av.chip', { l: v.level, n: t('tv.av.' + v.level), r: v.region })]); });
    const sw = snowOk(s);   // after the avalanche chips: the map's verdict card copies the first three; not when the headline already says it, nor for the whole route
    if (sw && !sw.allBare && !(h || headline(s)).snow) {
      if (snowKm(sw.kmBare) >= 0.5) out.push(['warn', t(sw.scant ? 'tv.snow.c.scant' : 'tv.snow.c.bare', { km: snowKmTxt(sw.kmBare) })]);   // a few cm (class 0 with snow) is not called bare
      else if (snowKm(sw.kmThin) >= 0.5) out.push(['warn', t('tv.snow.c.thin', { km: snowKmTxt(sw.kmThin) })]);
    }
    const eh = ensHints(pts, pts.reduce((m, p) => (W[p.cls] > W[m] ? p.cls : m), 'dry'))[0];
    if (eh) out.push(['ens', t(eh.share >= 0.35 ? 'kv.ens.maybe' : 'kv.ens.unlikely', { x: t('kv.ens.n.' + eh.f) }) + ' ' + t('kv.ens.time', { h: hm(eh.p.at) })]);
    return out;
  }

  /* ---------------- state ---------------- */
  // ret: minutes of pause at the far end when the return is planned, else null
  const winterNow = () => [10, 11, 0, 1, 2, 3].includes(new Date().getMonth());   // November to April
  const tv = { season: ['summer', 'winter'].includes(lsGet('glett.tv.season')) ? lsGet('glett.tv.season') : winterNow() ? 'winter' : 'summer', a: null, b: null, via: [], classic: null, name: '', dep: null, ret: null, sel: 'direct', routes: null, pace: lsGet('glett.tv.pace') || 'normal', roads: lsGet('glett.tv.roads') === 'most' ? 'most' : 'least', hours: lsGet('glett.tv.hours') === 'all' ? 'all' : 'day', R: null, S: null, busy: false, token: 0, started: false, fitted: false, clOpen: false, clReg: lsGet('glett.tv.clreg') || 'all', snow: null, snowOpen: lsGet('glett.tv.snowOpen') === '1', snowMap: lsGet('glett.tv.snowmap') === '1', wax: lsGet('glett.tv.wax') === '1', waxOpen: lsGet('glett.tv.waxOpen') === '1', snowLoad: null };
  const depOptions = () => KVCore.depOptions(MAX_AHEAD_H).filter((d, i) => !i || tv.hours === 'all' || (d.getHours() >= START_H[0] && d.getHours() <= START_H[1]));   // daytime starts, or every hour when asked
  // Open-Meteo's minute is full (js/omgate.js): the plan waits instead of failing, and says how long
  let omTick = null, omPrev = null;
  window.addEventListener('glett:omwait', (e) => {
    clearInterval(omTick);
    if (!tv.busy || !e.detail.until) { if (omPrev && tv.st && tv.st.key === 'om.wait') status(t(omPrev.key), omPrev.kind, omPrev.key); omPrev = null; return; }
    if (!omPrev && tv.st && tv.st.key !== 'om.wait') omPrev = tv.st;
    const show = () => status(t('om.wait', { s: Math.max(1, Math.ceil((e.detail.until - Date.now()) / 1000)) }), 'busy', 'om.wait');
    show(); omTick = setInterval(() => { if (!tv.busy || Date.now() > e.detail.until + 2000) { clearInterval(omTick); return; } show(); }, 1000);
  });
  function status(msg, kind, key) {
    tv.st = msg ? { key, kind, msg } : null;
    const el = $('tvStatus'); el.hidden = !msg; el.className = 'kv-status ' + (kind || '');
    el.innerHTML = kind === 'busy' ? `<span class="spinner"></span> ${esc(msg)}` : esc(msg);
  }
  const tripTitle = () => (tv.name || `${tv.a ? tv.a.n : '?'} → ${tv.b ? tv.b.n : '?'}`) + (tv.ret != null ? ' · ' + t(tv.R && (tv.R.kind === 'loop' || tv.R.kind === 'loop2') ? 'tv.ret.loop' : 'tv.ret.title') : '');
  const isLoop = () => tv.a && tv.b && hav([tv.a.lat, tv.a.lon], [tv.b.lat, tv.b.lon]) < 0.2;
  const PAUSES = [0, 15, 30, 45, 60, 90, 120, 180];
  const pauseText = (m) => (m ? (m >= 60 ? t('tv.ret.h', { h: m % 60 ? (m / 60).toFixed(1).replace('.', ',') : m / 60 }) : t('tv.ret.min', { m })) : t('tv.ret.none'));

  /* ---------------- main flow ---------------- */
  // a route from a path on the network: the profile, the heights, the times, the legs, the samples and the key points
  const withApproach = (path) => {   // the straight off-trail stretch from a picked point to the trail, at each end
    const c = path.coords.slice(), tk = (path.tk || path.coords.map(() => 0)).slice(), a = tv.a && tv.a.snap ? [tv.a.lat, tv.a.lon, null] : null, b = tv.b && tv.b.snap ? [tv.b.lat, tv.b.lon, null] : null;
    if (a) { c.unshift(a); tk.unshift(0); } if (b) { c.push(b); tk.push(0); }
    return { ...path, coords: c, tk, approach: { a: a ? tv.a.off : 0, b: b ? tv.b.off : 0 } };
  };
  async function buildRoute(path, back, kind) {
    const sameBack = back === path;   // the same trail back (withApproach makes new objects, so compare first)
    path = withApproach(path); back = back && withApproach(back);
    const R = { coords: path.coords, tk: path.tk, nodes: path.nodes, pace: tv.pace, kind, approach: path.approach };
    if (back) {   // the return: the same trail or the other way back, a pause at the far end
      R.turnKm = 0; for (let i = 1; i < path.coords.length; i++) R.turnKm += hav(path.coords[i - 1], path.coords[i]);
      R.coords = [...path.coords, ...[...back.coords].reverse().slice(1)]; R.tk = [...path.tk, ...back.tk.slice(1).reverse()]; R.nodes = [...path.nodes, ...[...back.nodes].reverse().slice(1)]; R.pause = tv.ret;
    }
    R.trackKm = R.coords.reduce((a, p, i) => a + (i && R.tk[i] ? hav(R.coords[i - 1], p) : 0), 0);   // km on a road surface
    R.dense = profile(R);
    const noZ = R.dense.filter((p) => p.z == null); if (noZ.length) await elevate(noZ, ['kartverket', 'terrarium', 'valhalla', 'openmeteo']);   // only where the tiles carry no height
    Object.assign(R, smoothZ(R.dense));
    R.top = Math.round(Math.max(...R.dense.map((p) => p.z ?? 0)));
    R.tops = tops(R.dense);
    R.mins = walkMinutes(R.dense, tv.pace);
    R.turnDi = R.turnKm != null ? R.dense.reduce((b, p, i) => (Math.abs(p.km - R.turnKm) < Math.abs(R.dense[b].km - R.turnKm) ? i : b), 0) : -1;
    R.fine = profile({ coords: R.coords }, 25); R.steep = steepRuns(R.dense, R.fine);
    if (sameBack) {   // the same trail back: the steep stretches found on the way out, mirrored, so both legs agree (the 100 m steps sit on another grid on the way back)
      const D = R.dense, ti = R.turnDi, tk = D[ti].km, out = R.steep.filter((r) => r.b <= ti), at = (km) => D.reduce((b, p, i) => (Math.abs(p.km - km) < Math.abs(D[b].km - km) ? i : b), 0);
      // mirrored about the profile point at the far end (not the exact turn distance): the two legs then share the grid, and no stretch starts before the pause
      R.steep = [...out, ...out.map((r) => ({ a: Math.max(ti, at(2 * tk - D[r.b].km)), b: Math.max(ti, at(2 * tk - D[r.a].km)), max: r.max, km: r.km })).filter((r) => r.b > r.a).reverse()];
    }
    R.steepKm = R.steep.reduce((a, r) => a + r.km, 0); R.steepMax = Math.round(Math.max(0, ...R.steep.map((r) => r.max)));
    R.legs = legsOf(R);
    R.dense.forEach((p) => { p.key = cellKey(p); });
    R.samples = pickSamples(R);
    R.S = R.samples.map((i, si) => ({ ...R.dense[i], top: R.tops.includes(i), si }));
    R.kp = keyPoints(R.S); R.ensNear = nearKey(R.S, R.kp);
    let last = -1e9; R.dk = R.S.filter((p) => { if (p.top || p.km - last >= DMI_KM) { last = p.km; return true; } return false; });
    R.dmiNear = R.S.map((x) => { let b = null; R.dk.forEach((q) => { if (Math.abs(q.km - x.km) <= DMI_REACH && (!b || Math.abs(q.km - x.km) < Math.abs(b.km - x.km))) b = q; }); return b ? b.key : null; });
    return R;
  }
  const suggestFor = (r, pa, pb) => (tv.via.length && !ownVia() ? Promise.resolve({ alt: null, starts: [] }) : suggest(r, [pa, ...tv.via.map((v) => [v[0], v[1]]), pb]).catch(() => ({ alt: null, starts: [] })));
  const waySig = (r, sugg) => [r, ...(sugg.alts || []).map((a) => a.route)].map((x) => x.nodes.join(',')).join('|');   // the trails of the routes offered
  /* "Skogsbilvei og grusvei" changed with a trip shown: the trails are found again (in the browser, no weather) and only when
     another way comes out is the trip planned again; most hikes (Munkebu from Sørvågen) have no forest road to prefer or avoid */
  async function rerouteIfChanged() {
    const tok = tv.token;
    try {
      const pa = tv.a.snap || [tv.a.lat, tv.a.lon], pb = tv.b.snap || [tv.b.lat, tv.b.lon];
      const r = await routeVia([pa, ...tv.via, pb]), sugg = await suggestFor(r, pa, pb);
      if (tok !== tv.token || tv.busy) return;
      if (waySig(r, sugg) === tv.wsig) { writeHash(); return; }
    } catch (e) { if (tok !== tv.token) return; }
    go();
  }
  async function plan() {
    if (!tv.a || !tv.b) return;
    const tok = ++tv.token; tv.busy = true; $('tvGo').classList.add('busy'); status(t('tv.loading.route'), 'busy', 'tv.loading.route'); $('tvResult').hidden = true;
    let routes;
    try {
      await loadCells([[tv.a.lat, tv.a.lon], [tv.b.lat, tv.b.lon]]);
      [tv.a, tv.b].forEach((p) => {   // a point off the trail (picked, from a link or a saved hike): its snap and the way to it
        if (p.snap) return; const id = nodeAt([p.lat, p.lon], 400); if (id < 0) return;
        const q = net().nodes.get(id), off = hav([p.lat, p.lon], q) * 1000; if (off >= 20) { p.snap = q; p.off = Math.round(off); }
      });
      const pa = tv.a.snap || [tv.a.lat, tv.a.lon], pb = tv.b.snap || [tv.b.lat, tv.b.lon];
      const r = await routeVia([pa, ...tv.via, pb]);
      if (tok !== tv.token) return;
      const sugg = await suggestFor(r, pa, pb); tv.wsig = waySig(r, sugg);
      // a route's own ends (Turrutebasen's named routes) take the name of the nearest named place within 500 m
      [[tv.a, r.nodes[0]], [tv.b, r.nodes[r.nodes.length - 1]]].forEach(([p, id]) => {
        if (!p.gen) return; const { named, nodes } = net(), at = nodes.get(id); let best = null;
        named.forEach((nm, nid) => { const d = hav(at, nodes.get(nid)); if (d < 0.5 && (!best || d < best.d)) best = { d, n: nm.n }; });
        if (best) { p.n = best.n; p.gen = false; }
      });
      syncForm();   // the form shows the names found
      status(t('tv.loading.wx'), 'busy', 'tv.loading.wx');
      // the routes: the direct way (and back), and when there is another marked way, up that way (and back) and, with a
      // return planned, the loop; the alternatives are drawn on the map and can be chosen there, as in Kjørevær
      const ret = tv.ret != null && !isLoop(), alts = sugg.alts || [], alt = alts[0] && alts[0].route, alt2 = alts[1] && alts[1].route;
      routes = [await buildRoute(r, ret ? r : null, 'direct')];
      if (alt) {
        routes.push(await buildRoute(alt, ret ? alt : null, 'up'));
        if (ret) { routes.push(await buildRoute(r, alt, 'loop')); routes.push(await buildRoute(alt, r, 'loop2')); }   // the loop both ways round
      }
      if (alt2) routes.push(await buildRoute(alt2, ret ? alt2 : null, 'up2'));   // a third way, there (and back)
      if (tok !== tv.token) return;
      routes.forEach((R) => { R.sugg = sugg; R.alt = R.kind === 'up2' ? alts[1] : alts[0]; });
      await loadAlerts();
      const S = routes.flatMap((R) => R.S), kp = routes.flatMap((R) => R.kp), dk = routes.flatMap((R) => R.dk);
      await Promise.all([fetchForecast(S, WX_VARS), fetchEnsemble(kp).catch((e) => console.warn('Turvær models', e)), fetchDmi(dk).catch((e) => console.warn('Turvær DMI', e)), fetchMet(dk)]);
      if (tv.season === 'winter') { const R = routes[0], hi = R.dense.reduce((b, p) => ((p.z ?? 0) > (b.z ?? 0) ? p : b), R.dense[0]); const v = await fetchVarsom([R.dense[0], hi], tv.dep || new Date()); routes.forEach((x) => { x.varsom = v; }); }
    } catch (e) { if (tok === tv.token) { tv.busy = false; $('tvGo').classList.remove('busy'); status(e.message || t('kv.err.wx'), 'err'); } return; }
    if (tok !== tv.token) return;
    tv.routes = routes; tv.R = routes.find((R) => R.kind === tv.sel) || routes[0]; tv.sel = tv.R.kind; tv.snow = null;
    tv.busy = false; tv.dirty = false; tv.fitted = false; $('tvGo').classList.remove('busy');   // a new trip: the map shows all of it
    $('view-tur').classList.remove('kv-isstale', 'kv-noroute'); showMap(); if (tv.pick) endPick();
    status('', ''); $('tvResult').hidden = false;
    writeHash(); render();
    if (tv.scrollTo) {   // to the result; in the map-first layout the result starts at the question line, so only back up when that is off screen
      tv.scrollTo = false; const head = document.querySelector('.topbar'), kart = document.documentElement.dataset.ui === 'kart', el = kart ? $('tvSum') || $('tvHead') : $('tvHead'), top = el.getBoundingClientRect().top;
      if (kart ? (top < 0 || top > innerHeight * 0.6) : top > innerHeight * 0.6) window.scrollTo({ top: top + window.scrollY - (head ? head.offsetHeight : 60) - 8, behavior: 'smooth' });
    }
    weightAreas(tv.R.dense, tv.R.tops).then((a) => { if (tok === tv.token) { routes.forEach((R) => { R.wAreas = a; }); if (a.length) render(); } }).catch(() => {});
    loadSnow(routes, tok);
  }
  function selectRoute(kind) {   // one of the drawn routes becomes the chosen one, without planning again
    const R = tv.routes && tv.routes.find((x) => x.kind === kind); if (!R || R === tv.R) return;
    tv.R = R; tv.sel = kind; writeHash(); render();
    const C = tv.snow && tv.snow.cells; if (C && R.snowIdx && R.snowIdx.some((i) => i >= 0 && !(i in C))) loadSnow(tv.routes, tv.token);   // cells past the first call's cap: asked for now, this route first
  }
  const routeName = (R) => (R.kind === 'direct' ? t('tv.rt.direct') : R.kind === 'up' || R.kind === 'up2' ? (R.alt && R.alt.via.n ? t('tv.rt.up', { p: R.alt.via.n }) : t(R.kind === 'up2' ? 'tv.rt.up3' : 'tv.rt.up2')) : R.kind === 'loop2' ? t('tv.rt.loop2') : t('tv.rt.loop'));
  function render() {
    if (!tv.R) return;
    const dep = tv.dep || new Date(), s = summarise(tv.R, +dep, tv.pace); tv.S = s;
    tv.SS = (tv.routes || [tv.R]).map((R) => (R === tv.R ? s : summarise(R, +dep, tv.pace)));   // the alternatives too, for the map labels and the chips
    snowBtn(); renderHead(s); renderDeps(); renderChart(s); renderMap(s); renderIt(s); fullLabel();
    if (PHONE && PHONE.on) PHONE.refresh();
    $('tvSource').textContent = t('tv.source') + (tv.season === 'winter' ? ' ' + t('tv.source.w') : '');
    if (tv.season === 'winter' && tv.routes && tv.snowFor && tv.snowFor !== osloDay(new Date())) loadSnow(tv.routes, tv.token);   // past midnight: today's snow (once a day)
    if (window.GlettUI) GlettUI.render('tv', s);   // the prototype layout (?ui=kart)
  }

  /* ---------------- rendering: the headline card ---------------- */
  function renderHead(s) {
    const R = s.R, h = headline(s), small = smallThings(s, h), pts = s.pts;
    $('tvHead').innerHTML = `<div class="tv-hd-top"><b>${esc(tripTitle())}</b><button type="button" class="kv-chip small" id="tvRev" title="${esc(t('tv.reverse'))}">⇄ ${esc(t('tv.reverse'))}</button></div>` +
      `<div class="kv-rc-meta">${esc(tv.ret != null && !isLoop() ? `${tv.a.n} → ${tv.b.n} → ${tv.a.n}` : `${tv.a.n} → ${tv.b.n}`)}</div>` +
      `<div class="tv-facts">${esc(fmt(R.km, 1))} km · ↑ ${R.up} m · ↓ ${R.down} m · ${esc(t('tv.top', { z: R.top }))} · <b>${esc(dur((s.end - pts[0].at) / 60e3))}</b></div>` +
      `<div class="kv-rc-meta">${esc(t(R.turnDi >= 0 || isLoop() ? 'tv.times.back' : 'tv.times', { a: wday(pts[0].at) + ' ' + hm(pts[0].at), b: hm(s.end) }))}</div>` +

      `<div class="tv-headline ${h.kind}">${esc(h.text)}</div>` +
      `<div class="kv-badges">${small.map(([k, txt]) => `<span class="kv-badge ${k}">${esc(txt)}</span>`).join('')}</div>` +
      snowCard(s) + waxCard(s) +
      ((tv.routes && tv.routes.length > 1) || (R.sugg && R.sugg.starts.length) ? `<div class="tv-sugg"><div class="kv-lbl">${esc(t('tv.sg.title'))}</div>` +
        (tv.routes && tv.routes.length > 1 ? `<div class="kv-badges">${tv.SS.map((x) => { const dm = Math.round((x.end - x.pts[0].at - (s.end - s.pts[0].at)) / 60e3); return `<button type="button" class="kv-chip small${x.R === R ? ' on' : ''}" data-route="${esc(x.R.kind)}">${esc(routeName(x.R))} · ${fmt(x.R.km, 1)} km${x.R === R ? '' : ' · ' + (Math.abs(dm) < 1 ? t('kv.alt.same') : (dm > 0 ? '+' : '−') + dur(Math.abs(dm)))}${x.R.steepKm >= 0.1 ? ' · ' + esc(t('tv.rt.steep', { km: fmt(x.R.steepKm, 1) })) : ''}${x.R.trackKm >= 0.1 ? ' · ' + esc(t('tv.rt.track', { km: fmt(x.R.trackKm, 1) })) : ''}${snowRt(x)}</button>`; }).join('')}</div>` : '') +
        (R.sugg.starts.length ? `<div class="kv-rc-meta">${esc(t('tv.sg.starts', { b: tv.b.n }))}</div><div class="kv-badges">${R.sugg.starts.map((x, i) => `<button type="button" class="kv-chip small" data-start="${i}">${esc(x.n)} · ${fmt(x.km, 1)} km${x.same ? '' : ' · ' + esc(t('tv.sg.other'))}</button>`).join('')}</div>` : '') + '</div>' : '') +
      (s.R.varsom || []).filter((v) => v.level >= 1).map((v) => `<p class="tv-blurb"><b>${esc(t('tv.av.title', { r: v.region }))}:</b> ${esc(v.text)} <a href="https://www.varsom.no/${LANG === 'nb' ? '' : 'en/'}snoskred/varsling/" target="_blank" rel="noopener">varsom.no ↗</a></p>`).join('') +
      (tv.classic && tv.classic.blurb ? `<p class="tv-blurb">${esc(tv.classic.blurb)}${tv.classic.why ? ' <span class="kv-rc-meta">' + esc(tv.classic.why) + '</span>' : ''}${tv.classic.wiki ? ` <a href="${esc(tv.classic.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}</p>` : '');
  }
  // on the route chips: the share of the route without skiing (NVE's class 0, bare or a few cm), else the share with little snow; a share,
  // so an out-and-back counted one way compares with a loop, and the same words on every chip. Nothing when every route is nearly all
  // without skiing (the headline says it once)
  const snowPc = (x) => { const w = snowOk(x); return !w || !w.kmTot ? null : { bare: w.kmBare / w.kmTot, thin: w.kmThin / w.kmTot }; };
  const snowRt = (x) => {
    const p = snowPc(x); if (!p || (tv.SS || []).every((y) => { const q = snowPc(y); return !q || q.bare >= 0.9; })) return '';
    const pc = (v) => Math.round(v * 20) * 5;   // to 5 %
    return p.bare >= 0.1 ? ' · ' + esc(t('tv.snow.rt.bare', { pc: pc(p.bare) })) : p.thin >= 0.1 ? ' · ' + esc(t('tv.snow.rt.thin', { pc: pc(p.thin) })) : '';
  };
  const snowSki = (dry) => t(dry >= 0.7 ? 'tv.snow.k3' : dry <= 0.3 ? 'tv.snow.k2' : 'tv.snow.mix');
  // the snow card under the chips: the worst stretch first, the typical depth after; opens to the ten days of NVE's model
  function snowCard(s) {
    const S = tv.snow; if (tv.season !== 'winter' || !S) return '';
    const sim = S.sim ? `<span class="tv-snow-sim" title="${esc(t('tv.snow.sim', { d: S.sim.split('-').reverse().join('.') }))}">${esc(t('tv.snow.simshort', { d: S.sim.split('-').reverse().join('.') }))}</span> ` : '';
    if (S.err) return `<p class="tv-snow-muted">${esc(t('tv.snow.err'))}</p>`;
    const w = s.snow, R = s.R; if (!w || w.conf === 'none') return `<p class="tv-snow-muted">${sim}${esc(t('tv.snow.out'))}</p>`;
    const ok = w.conf === 'ok', dep = +s.pts[0].at, sum = w.med == null || w.med < 1 ? '' : w.dry == null ? t('tv.snow.sumn', { cm: Math.round(w.med) }) : t('tv.snow.sum', { cm: Math.round(w.med), ski: snowSki(w.dry) });   // no ski word without NVE's class
    let l1, l2;
    if (w.allBare && !w.allZero) { l1 = t('tv.snow.scantall'); l2 = ''; }
    else if (ok && w.worstBare && snowKm(w.kmBare) >= 0.5 && !w.allZero) { l1 = snowBareTxt(R, w, 'tv.snow.c1.'); l2 = sum; }
    else if (ok && w.worstLow && snowKm(w.kmThin + w.kmBare) >= 0.5 && !w.allZero) { l1 = snowThinTxt(R, w, 'tv.snow.c1.'); l2 = sum; }
    else if (w.allZero) { l1 = t('tv.snow.none'); l2 = ''; }
    else { l1 = sum; const i = w.p10 == null ? -1 : w.at.findIndex((x, k) => k <= w.last && x && x.st !== 'na' && x.st !== 'glacier' && x.sd != null && x.sd <= w.p10); l2 = i >= 0 ? t('tv.snow.thinnest', { cm: Math.round(w.p10), p: snowWhere(R, i) }) : ''; }
    l2 = (l2 ? l2 + ' · ' : '') + t('tv.snow.at', { d: snowDayLabel(dep) });
    const open = !!tv.snowOpen;
    return `<div class="tv-snowbox${open ? ' open' : ''}"><button type="button" class="tv-snow" aria-expanded="${open}" aria-controls="tvSnowX"><span class="tv-snow-l1">${sim}❄ ${esc(l1)}</span><span class="tv-snow-l2">${esc(l2)}</span></button>` +
      `<div id="tvSnowX" class="tv-snow-x"${open ? '' : ' hidden'}>${open ? snowMore(s) : ''}</div></div>`;
  }
  function snowMore(s) {   // the expanded card: the ten days, the ski conditions, new snow, the notes, where the numbers come from
    const S = tv.snow, w = s.snow, R = s.R, D = R.dense, dep = +s.pts[0].at, kDep = snowDayIx(dep), n = S.days.length;
    const cols = S.days.map((d, k) => {   // the route's median and thinnest per day (the way out), the same cells and days as the card
      const v = []; for (let i = 0; i <= w.last; i++) { const c = S.cells[R.snowIdx[i]], x = c ? c.sd[k] : null; if (x != null && x <= 400) v.push(x); }
      v.sort((a, b) => a - b); return v.length >= Math.max(1, 0.1 * (w.last + 1)) ? { med: v[Math.floor(v.length / 2)], p10: v[Math.floor(v.length * 0.1)] } : null;
    });
    const mx = Math.max(0, ...cols.map((c) => (c ? c.med : 0))), out = [];
    if (cols.some(Boolean) && mx < 10) out.push(`<p>${esc(t(mx < 1 ? 'tv.snow.strip.none' : 'tv.snow.strip.low', { d: snowDayName(n - 1) }))}</p>`);   // next to no snow on all ten days: one line, not ten empty columns
    else {
    const top = Math.min(400, Math.max(50, mx)), Wd = 300, Hs = 104, base = Hs - 26, cw = Wd / n, Y = (v) => base - Math.sqrt(Math.max(0, v) / top) * (base - 16);
    let svg = '';
    cols.forEach((c, k) => {
      const x = k * cw + 3, bw = cw - 6, d = new Date(S.days[k] + 'T12:00:00'), lab = S.days[k] === osloDay(new Date()) ? [t('kv.today').toLowerCase(), ''] : [wday(d), d.getDate() + '.'];   // two lines: the weekday over the date
      if (c) {
        svg += `<rect class="tv-snow-bar${k > 3 ? ' fc' : ''}${k === kDep ? ' on' : ''}" x="${x.toFixed(1)}" y="${Y(c.med).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, base - Y(c.med)).toFixed(1)}" rx="2"/>`;
        svg += `<line class="tv-snow-tick${k > 3 ? ' fc' : ''}" x1="${x.toFixed(1)}" x2="${(x + bw).toFixed(1)}" y1="${Y(c.p10).toFixed(1)}" y2="${Y(c.p10).toFixed(1)}"/>`;
        if (k === kDep) svg += `<text class="tv-snow-val" x="${(k === 0 ? x : k === n - 1 ? x + bw : x + bw / 2).toFixed(1)}" y="${(Y(c.med) - 4).toFixed(1)}" text-anchor="${k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle'}">${esc(c.med > 400 ? '>400 cm' : Math.round(c.med) + ' cm')}</text>`;
      }
      svg += `<text class="tv-snow-day${k === kDep ? ' on' : ''}" x="${(x + bw / 2).toFixed(1)}" y="${Hs - 13}" text-anchor="middle">${esc(lab[0])}${lab[1] ? `<tspan x="${(x + bw / 2).toFixed(1)}" dy="10">${esc(lab[1])}</tspan>` : ''}</text>`;
    });
    out.push(`<svg class="tv-snow-strip" viewBox="0 0 ${Wd} ${Hs}" role="img" aria-label="${esc(t('tv.snow.strip'))}"><line class="tv-snow-base" x1="0" x2="${Wd}" y1="${base}" y2="${base}"/>${svg}</svg>`, `<p class="tv-snow-cap">${esc(t('tv.snow.strip'))}</p>`);
    }
    const p = (txt) => out.push(`<p>${esc(txt)}</p>`);
    if (w.dry != null) p(t('tv.snow.fore', { txt: t(w.dry >= 0.7 ? 'tv.snow.fore.dry' : w.dry <= 0.3 ? 'tv.snow.fore.wet' : 'tv.snow.fore.mix') }));
    if (w.nfMax >= 5) p(t('tv.snow.new', { d: snowDayName(w.nfK), cm: Math.round(w.nfMax) }) + (w.nfMax >= 20 ? ' ' + t('tv.snow.newav') : ''));
    if (snowKm(w.kmNa) >= 0.5) p(t('tv.snow.part', { km: snowKmTxt(w.kmNa) }));
    if (w.kmGlacier >= 0.3) p(t('tv.snow.glacier', { km: snowKmTxt(Math.max(0.5, w.kmGlacier)) }));
    if (w.gap && Math.abs(w.gap.d) > 150) p(t('tv.snow.alt', { p: snowWhere(R, w.gap.i), m: Math.round(Math.abs(w.gap.d) / 10) * 10, dir: t(w.gap.d > 0 ? 'tv.snow.hi' : 'tv.snow.lo') }));
    if (w.conf === 'low') p(t('tv.snow.low'));
    out.push(`<p class="tv-snow-muted">${esc(t('tv.snow.model'))} ${esc(t('tv.snow.got', { h: hm(new Date(S.at * 1000)) }))}${S.stale ? ' ' + esc(t('tv.snow.stale')) : ''}</p>`);
    if (snowCan()) { const on = snowMapOn(); out.push(`<button type="button" class="kv-chip small" data-snowmap>❄ ${esc(t(on ? 'tv.snow.map.off' : 'tv.snow.map'))}</button>`); }
    return out.join('');
  }

  // the wax card under the snow card (the option on): two lines, opens to the stretches, the basis, examples and the disclaimer
  const waxNum = (v) => (v < 0 ? '−' + Math.abs(v) : v > 0 ? '+' + v : '0');
  const waxName = (c) => t('tv.wax.c.' + c);
  const waxCap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const waxSw = (c) => `<i class="tv-wax-sw w-${c}${isKl(c) ? ' k' : ''}" aria-hidden="true"></i>`;
  function waxBand(c, col) {   // "fiolett (ca. −3 til 0 °C)": the edges of the column the rule used
    const C = WAX_COL[col] || (isKl(c) ? WAX.KL : WAX.NEW), i = C.findIndex(([x]) => x === c); if (i < 0) return waxName(c);
    const hi = C[i][1], lo = i ? C[i - 1][1] : null;
    return lo == null ? t('tv.wax.below', { c: waxName(c), b: waxNum(hi) }) : !Number.isFinite(hi) ? t('tv.wax.above', { c: waxName(c), a: waxNum(lo) }) : t('tv.wax.band', { c: waxName(c), a: waxNum(lo), b: waxNum(hi) });
  }
  function waxBand2(cs, col) {   // several classes of one family: "grønn til blå ekstra (ca. −15 til −3 °C)", the hardest's lower edge to the softest's upper
    const a = cs[0], b = cs[cs.length - 1]; if (a === b) return waxBand(a, col);
    const C = WAX_COL[col] || (isKl(a) ? WAX.KL : WAX.NEW), i = C.findIndex(([x]) => x === a), j = C.findIndex(([x]) => x === b), c = t('tv.wax.to', { a: waxName(a), b: waxName(b) });
    if (i < 0 || j < 0) return c;
    const hi = C[j][1], lo = i ? C[i - 1][1] : null;
    return lo == null ? t('tv.wax.below', { c, b: waxNum(hi) }) : !Number.isFinite(hi) ? t('tv.wax.above', { c, a: waxNum(lo) }) : t('tv.wax.band', { c, a: waxNum(lo), b: waxNum(hi) });
  }
  /* The open card's rows: what you would do on the skis, not every class change (eget anslag). Stretches next to each other in one
     family (hard wax, or klister) make one row when there are more than three, from the hardest to the softest (the hardest goes on first, a softer one on top);
     a stretch under a minute (the last point) goes. When the families take turns more than once (klister, hard wax, klister, …)
     the rows give way to one line and a row for each family, without clock times. */
  function waxRows(w) {
    const g = [], most = (o) => Object.keys(o).sort((a, b) => o[b] - o[a])[0], add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
    const zs = w.stretches.filter((z) => z.t1 - z.t0 >= 60e3 || w.stretches.length === 1);
    if (zs.length <= 3) return { rows: zs.map((z) => ({ cs: [z.c], t0: z.t0, t1: z.t1, band: waxBand(z.c, z.col), type: z.type })) };   // a few stretches: each says when to rewax
    zs.forEach((z) => {
      const kl = isKl(z.c), o = g[g.length - 1];
      if (o && o.kl === kl) { o.cs.add(z.c); o.t1 = z.t1; add(o.types, z.type, z.km); add(o.cols, z.col, z.km); }
      else g.push({ kl, cs: new Set([z.c]), t0: z.t0, t1: z.t1, types: { [z.type]: z.km }, cols: { [z.col]: z.km } });
    });
    const row = (x) => { const cs = [...x.cs].sort((a, b) => waxRank(a) - waxRank(b)); return { cs, t0: x.t0, t1: x.t1, band: waxBand2(cs, x.kl ? 'kl' : most(x.cols)), type: most(x.types) }; };
    if (g.length < 4) return { rows: g.map(row) };
    const fam = (kl) => { const f = g.filter((x) => x.kl === kl), o = { kl, cs: new Set(), types: {}, cols: {} }; f.forEach((x) => { x.cs.forEach((c) => o.cs.add(c)); for (const k in x.types) add(o.types, k, x.types[k]); for (const k in x.cols) add(o.cols, k, x.cols[k]); }); return row(o); };
    return { alt: { n: g.length - 1, a: g[0].t0, b: g[g.length - 1].t1 }, rows: [fam(g[0].kl), fam(!g[0].kl)] };
  }
  const waxT = (key, vars, c, txt) => esc(t(key, { ...vars, c: '\u0001' })).replace('\u0001', waxSw(c) + esc(txt));   // the swatch in front of the class, inside the sentence
  const waxColOf = (w, c) => w.colOf[c] || (isKl(c) ? 'kl' : 'new');
  const simDate = (S) => S.sim.split('-').reverse().join('.');
  const waxHour = (ms) => hm(new Date(Math.floor(ms / 1800e3) * 1800e3));   // the card's "ca. kl. 10:30": down to the half hour (ready a little early; the stages keep the minute)
  function waxCard(s) {
    const S = tv.snow; if (tv.season !== 'winter' || !tv.wax || !S || S.err) return '';   // no snow data: the snow card says so
    const na = `<p class="tv-snow-muted">${esc(t('tv.wax.na'))}</p>`;
    if (!S.wx || (S.sim && !S.t1from)) return tv.snowLoad ? '' : na;   // a replay without its hours never falls back to the forecast
    const w = waxSum(s); if (!w || (w.none && w.quiet)) return '';
    if (w.none) return w.na ? na : `<p class="tv-snow-muted">${esc(t('tv.wax.none'))}</p>`;
    const sim = S.sim ? `<span class="tv-snow-sim" title="${esc(t('tv.wax.sim', { d: simDate(S) }))}">${esc(t('tv.wax.simp'))}</span> ` : '';   // short, grey, on the second line: the snow card above has the date
    let l1, l2 = '';
    if (w.lead) {
      l1 = '⚠ ' + esc(t('tv.wax.' + w.lead));
      l2 = waxT('tv.wax.else', {}, w.main, waxBand(w.main, waxColOf(w, w.main))) + w.then.map((x) => ', ' + waxT(x.now ? 'tv.wax.thenn' : 'tv.wax.then', { h: waxHour(x.at) }, x.c, waxName(x.c))).join('');
    } else {
      l1 = waxSw(w.main) + esc(t('tv.wax.lbl', { c: waxBand(w.main, waxColOf(w, w.main)) }));
      if (w.add) l2 = esc(t('tv.wax.' + w.add.k, { c: waxName(w.add.c), h: w.add.at ? waxHour(w.add.at) : '' }));
      if (w.tag) l2 = (l2 ? l2 + ' · ' : '') + esc(t('tv.wax.' + w.tag.k, { c: w.tag.c ? waxName(w.tag.c) : '' }));
    }
    if (w.weak) l2 = (l2 ? l2 + ' · ' : '') + esc(t('tv.wax.uns'));
    if (!l2) l2 = esc(t('tv.wax.range', { a: waxNum(Math.round(w.tmin)), b: waxNum(Math.round(w.tmax)) }));
    const open = !!tv.waxOpen;
    return `<div class="tv-waxbox${open ? ' open' : ''}"><button type="button" class="tv-wax" aria-expanded="${open}" aria-controls="tvWaxX"><span class="tv-wax-l1">${l1}</span><span class="tv-wax-l2">${sim}${l2}</span></button>` +
      `<div id="tvWaxX" class="tv-wax-x"${open ? '' : ' hidden'}>${open ? waxMore(w) : ''}</div></div>`;
  }
  function waxMore(w) {   // the stretches in time order, the notes, the basis, brand examples (A–Z, at most three a class) and the disclaimer
    const S = tv.snow, out = [], p = (txt, cls) => out.push(`<p${cls ? ` class="${cls}"` : ''}>${esc(txt)}</p>`);
    const W = waxRows(w);
    if (W.alt) p(t('tv.wax.alt', { n: W.alt.n, a: hm(new Date(W.alt.a)), b: hm(new Date(W.alt.b)) }));
    W.rows.forEach((z) => out.push(`<p class="tv-wax-row">${z.cs.map(waxSw).join('')}<b>${esc(waxCap(z.band))}</b> ${W.alt ? '· ' : esc(t('tv.wax.from', { a: hm(new Date(z.t0)), b: hm(new Date(z.t1)) })) + ' · '}${esc(t('tv.wax.s.' + z.type))}</p>`));
    const z0 = w.stretches[0].c;
    if (!w.lead && waxRank(z0) > waxRank(w.main)) p(t('tv.wax.first', { c: waxName(w.main), s: waxName(z0) }));   // the card's class is not where the trip starts
    if (w.lead === 'mixed' && !W.alt) p(t('tv.wax.mixedx'));
    if (w.lead) p(t('tv.wax.waxless'));
    ['cover', 'crust', 'cork', 'unsure'].forEach((k) => { if (w.notes[k]) p(t('tv.wax.' + k)); });
    if (w.sim) p(t('tv.wax.sim', { d: simDate(S) }));
    const H = w.hist, ago = (v, k, n) => (v == null ? '' : v < 0 ? t(`tv.wax.${k}x`, { n }) : v <= 1 ? t(`tv.wax.${k}${v}`) : t(`tv.wax.${k}n`, { n: v }));
    const hist = H.fall == null && H.thaw == null ? t('tv.wax.hx') : [ago(H.fall, 'f', WAX.NEW_DAYS), ago(H.thaw, 'm', WAX.THAW_DAYS)].filter(Boolean).join(', ');
    p(t('tv.wax.why', { a: waxNum(Math.round(w.tmin)), b: waxNum(Math.round(w.tmax)), h: hist }));
    const shown = [...new Set([...w.stretches.map((z) => z.c), ...(w.add ? [w.add.c] : [])])].sort((a, b) => waxRank(a) - waxRank(b));
    p(t('tv.wax.ex', { x: shown.map((c) => `${waxCap(waxName(c))}: ${WAX_EX[c]}`).join('; ') }), 'tv-wax-ex');
    p(t('tv.wax.note'), 'tv-snow-muted');
    return out.join('');
  }
  // the stage list: "Smør om: fiolett ca. kl. 13:20" on the stage where the wax changes (the head says the first)
  const waxStage = (s, a, b) => { const w = tv.season === 'winter' && tv.wax ? waxSum(s) : null; if (!w || w.none || !w.change) return '';
    return w.change.filter((x) => x.di >= a && x.di < b).map((x) => `<div class="tv-wax-st">${waxT('tv.wax.rewax', { h: hm(new Date(x.at)) }, x.c, waxName(x.c))}</div>`).join(''); };

  /* ---------------- "when should you go": a bar for each start hour ---------------- */
  function renderDeps() {
    const el = $('tvDep'), horizon = Date.now() + MAX_AHEAD_H * 3600e3, SS = depOptions().map((d) => [d, summarise(tv.R, +d, tv.pace)]).filter(([d, s], k) => !k || +s.end <= horizon);   // the whole hike inside the three days the bars show
    const opts = SS.map((x) => x[0]), sc = SS.map(([, s]) => (s.valid ? s.sc : Infinity)), HS = SS.map(([, s]) => (s.valid ? headline(s) : null)), kinds = HS.map((x) => (x ? x.kind : ''));   // the colour follows the headline's verdict, not the ranking; its text is the hover
    const fin = sc.filter(Number.isFinite), mx = Math.max(1, ...fin), mn = Math.min(...fin);
    const cur = tv.dep ? +tv.dep : +opts[0];
    const handicap = opts.map((d, k) => sc[k] * (1 + 0.15 * Math.max(0, (d - Date.now()) / 3600e3 - 48) / 24) + Math.max(0, (d - Date.now()) / 3600e3 - 48) * 0.5);   // +15 % and +12 points a day beyond 48 h
    const metEnd = Date.now() + MET_H * 3600e3, endOf = (k) => +SS[k][1].end;   // the hike must end while MET Nordic (1 km) still covers it to be the suggestion
    const inReach = handicap.map((v, k) => (Number.isFinite(v) && endOf(k) <= metEnd ? v : Infinity)), pool = inReach.some(Number.isFinite) ? inReach : handicap;
    const bestK = Number.isFinite(mn) ? pool.indexOf(Math.min(...pool.filter(Number.isFinite))) : -1;
    let h = '', lastDay = null;
    opts.forEach((d, k) => {
      if (lastDay !== null && dayKey(d) !== lastDay) h += '<i class="kv-dsep"></i>';
      lastDay = dayKey(d);
      const v = Number.isFinite(sc[k]) ? (sc[k] - mn) / Math.max(1, mx - mn) : 1, lead = (d - Date.now()) / 3600e3;
      const col = !Number.isFinite(sc[k]) ? 'var(--line)' : { good: 'var(--good)', ok: '#84cc16', mid: 'var(--mid)', bad: 'var(--bad)' }[kinds[k]] || 'var(--mid)';   // green: fine; light green: some rain; amber: gusts, fog, dark; red: thunder, cold, avalanche
      const sel = Math.abs(+d - cur) < 1800e3 || (k === 0 && !tv.dep);
      h += `<button type="button" data-k="${k}" data-day="${dayKey(d)}" data-t="${+d}" class="${sel ? 'sel' : ''}${k === bestK ? ' best' : ''}" style="height:${(12 + 40 * (1 - v)).toFixed(0)}px;background:${lead > 48 ? `color-mix(in srgb, ${col} 55%, var(--panel))` : lead > 24 ? `color-mix(in srgb, ${col} 75%, var(--panel))` : col}" title="${esc(wday(d) + ' ' + hm(d) + (HS[k] ? ' · ' + HS[k].text : ''))}" aria-label="${esc(wday(d) + ' ' + hm(d) + (HS[k] ? ' · ' + HS[k].text : ''))}"></button>`;
    });
    // after the last start: the hours up to the latest arrival as empty slots, so no hike seems to run off the chart
    const endMax = Math.max(...SS.map(([, x]) => +x.end)), ghosts = [];
    for (let tt = Math.floor(+opts[opts.length - 1] / 3600e3) * 3600e3 + 3600e3; tt < endMax + 3600e3; tt += 3600e3) { const d = new Date(tt); if (dayKey(d) !== lastDay) { h += '<i class="kv-dsep"></i>'; lastDay = dayKey(d); } ghosts.push(d); h += `<i class="kv-dep-ghost${tt > metEnd ? ' beyond' : ''}" data-day="${dayKey(d)}" data-t="${tt}" title="${esc(wday(d) + ' ' + hm(d))}"></i>`; }
    el.innerHTML = h;
    const days = []; [...opts, ...ghosts].forEach((d) => { const k = dayKey(d); if (!days.includes(k)) days.push(k); });
    const selStart = opts.find((d) => Math.abs(+d - cur) < 1800e3) || opts[0];
    $('tvDepAxis').innerHTML = days.map((k) => { const d = [...opts, ...ghosts].find((x) => dayKey(x) === k); return `<span data-day="${esc(k)}">${esc(wday(d) + ' ' + d.getDate() + '.')}</span>`; }).join('');
    KVCore.wireDepAxis($('tvDep'), $('tvDepAxis'), tv.S && tv.S.valid ? { start: +selStart, end: +tv.S.end, label: t('kv.dep.arrive', { h: hm(tv.S.end) }), short: hm(tv.S.end), met: metEnd } : { met: metEnd });   // each label centred under its day's slots; the chosen hike as a band
    const bd = opts[bestK], curK = Math.max(0, opts.findIndex((d) => Math.abs(+d - cur) < 1800e3));
    const better = bestK >= 0 && Number.isFinite(sc[curK]) ? handicap[curK] - handicap[bestK] >= Math.max(10, handicap[bestK] * 0.1) : bestK >= 0;
    $('tvDepHint').innerHTML = bestK < 0 ? '' : better
      ? `<div class="kv-best"><div class="kv-best-txt"><b>${esc(t('tv.dep.best', { d: wday(bd) + ' ' + t('kv.dep.at') + ' ' + hm(bd) }))}</b><small>${esc(headline(summarise(tv.R, +bd, tv.pace)).text)}</small>${(bd - Date.now()) / 3600e3 > MET_H ? `<small>${esc(t('tv.dep.far', { n: Math.floor((bd - Date.now()) / 86400e3 * 2) / 2 }))}</small>` : ''}</div>` +
        `<button type="button" class="btn primary kv-best-go" id="tvUseBest" data-k="${bestK}">${esc(t('kv.dep.use2', { d: wday(bd) + ' ' + hm(bd) }))}</button></div>`
      : `<div class="kv-best ok"><b>✓ ${esc(t('tv.dep.isbest'))}</b></div>`;
    $('tvDepHelp').textContent = t('tv.dep.help');
    tv.depOpts = opts;
  }

  /* ---------------- the chart: the profile as the shape, the weather on top ---------------- */
  function renderChart(s) {
    const H = $('tvMap').classList.contains('big') && innerHeight < 1000 ? 206 : 236, svg = $('tvChart'), W = Math.max(300, svg.clientWidth || 700), pts = s.pts, D = s.R.dense, km = s.R.km || 1;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    // a pause gets room on the axis: its minutes at the hike's average pace, as if it were distance
    const turn = s.R.turnDi >= 0 && s.R.pause > 0, turnKm = turn ? D[s.R.turnDi].km : Infinity, pk = turn ? s.R.pause * (km / Math.max(1, s.R.mins[D.length - 1])) : 0, tot = km + pk;
    const posK = (k, after) => k + (after ? pk : 0), posP = (p) => posK(p.km, turn && p.di > s.R.turnDi), posD = (i) => posK(D[i].km, turn && i > s.R.turnDi);
    const L = 64, X = (v) => L + (W - L - 10) * v / tot;
    const zs = D.map((p) => p.z ?? 0), zmin = Math.min(...zs), zmax = Math.max(zmin + 300, ...zs);
    const ts = pts.map((p) => p.t).filter(Number.isFinite), tmin = Math.min(-4, ...ts), tmax = Math.max(12, ...ts);
    const Zy = (z) => (H - 14) - (z - zmin) / (zmax - zmin) * (H * 0.5), Ty = (v) => (H - 60) - (v - tmin) / (tmax - tmin) * (H - 180);
    const C = (v) => cssv(v), line = C('--line'), muted = C('--muted');
    let h = '';
    for (let tt = Math.ceil(+pts[0].at / 3600e3) * 3600e3; tt <= +s.end; tt += 3600e3) {
      let k = 0; for (let i = 1; i < pts.length; i++) if (+pts[i].at >= tt) { const f = (tt - pts[i - 1].at) / Math.max(1, pts[i].at - pts[i - 1].at); k = posP(pts[i - 1]) + f * (posP(pts[i]) - posP(pts[i - 1])); break; }
      h += `<line x1="${X(k)}" x2="${X(k)}" y1="14" y2="${H - 12}" stroke="${line}"/><text x="${X(k)}" y="10" font-size="11" text-anchor="middle" fill="${muted}">${pad2(new Date(tt).getHours())}:00</text>`;
    }
    s.seg.forEach((g) => { const a = X(posP(pts[g.a])), b = X(posP(pts[Math.min(g.b + 1, pts.length - 1)])); h += `<rect class="kvc-${g.cls}" x="${a}" y="16" width="${Math.max(1, b - a)}" height="24"/>`; });
    const row = (y, test, cls) => pts.forEach((p, i) => { if (i < pts.length - 1 && test(p)) { const a = X(posP(p)), b = X(posP(pts[i + 1])); h += `<rect class="${cls}" x="${a}" y="${y}" width="${Math.max(2, b - a)}" height="8" rx="2"/>`; } });
    row(46, (p) => p.gust, 'kv-gustbar'); row(58, (p) => p.dark, 'kv-darkbar'); row(70, (p) => p.fog, 'tv-fogbar');
    // a steep stretch that runs through the far end is drawn in two parts, either side of the pause: nobody climbs while standing still
    const ti = s.R.turnDi, runs = s.R.steep.flatMap((r) => (turn && r.a < ti && r.b > ti ? [{ ...r, b: ti, km: D[ti].km - D[r.a].km }, { ...r, a: ti, back: true, km: D[r.b].km - D[ti].km }] : turn && r.a === ti && r.b > ti ? [{ ...r, back: true }] : [r]));
    const xr = (r, i) => X(r.back && i === ti ? turnKm + pk : posD(i));   // a part on the way back starts after the pause's band
    const lab = (y, txt, cls = 'kv-lab') => `<text x="${L - 6}" y="${y}" text-anchor="end" class="${cls}">${esc(txt)}</text>`;
    h += lab(32, t('kv.ch.wx')) + lab(54, t('kv.ch.wind')) + lab(66, t('kv.ch.dark')) + lab(78, t('tv.ch.fog'));   // the steep stretches are shown on the profile itself, not as a row
    if (turn) { const a = X(turnKm), b = X(turnKm + pk); h += `<rect class="tv-pauseband" x="${a}" y="14" width="${Math.max(2, b - a)}" height="${H - 26}"/>`; }
    h += `<path class="kv-elev" d="M${X(0)} ${H - 14} ${D.map((p, i) => `L${X(posD(i)).toFixed(1)} ${Zy(p.z ?? zmin).toFixed(1)}` + (turn && i === s.R.turnDi ? ` L${X(turnKm + pk).toFixed(1)} ${Zy(p.z ?? zmin).toFixed(1)}` : '')).join(' ')} L${X(tot)} ${H - 14} Z"/>`;
    runs.forEach((r) => {   // the steep stretches coloured on the profile itself, where the shape shows why
      const seg = D.slice(r.a, r.b + 1), pa = xr(r, r.a), pb = xr(r, r.b);
      h += `<path class="tv-steepfill${r.max >= STEEP_HARD ? ' hard' : ''}" d="M${pa.toFixed(1)} ${H - 14} ${seg.map((p, k) => `L${xr(r, r.a + k).toFixed(1)} ${Zy(p.z ?? zmin).toFixed(1)}`).join(' ')} L${pb.toFixed(1)} ${H - 14} Z"><title>${esc(t('tv.steep.chip', { km: fmt(r.km, 1), g: Math.round(r.max) }))}</title></path>`;
    });
    const sw = tv.season === 'winter' && s.snow && s.snow.conf !== 'none' ? s.snow : null, snowUsed = new Set();
    if (sw) {   // little or no snow (NVE's model, at the time you are there): a stroke along the top of the profile; split at the pause like the steep stretches
      let run = null; const flush = () => { if (!run) return; const back = turn && run.a > ti, i0 = run.a ? run.a - 1 : 0, ids = []; for (let j = i0; j <= run.b; j++) ids.push(j);
        const km = D[run.b].km - D[i0].km; snowUsed.add(run.st);
        h += `<path class="tv-snow${run.st}" d="${ids.map((j, k) => `${k ? 'L' : 'M'}${X(back && j === ti ? turnKm + pk : posD(j)).toFixed(1)} ${(Zy(D[j].z ?? zmin) - 2).toFixed(1)}`).join(' ')}"><title>${esc(t(run.st === 'bare' ? 'tv.snow.c.bare' : 'tv.snow.c.thin', { km: snowKmTxt(Math.max(0.5, km)) }))}</title></path>`; run = null; };
      sw.st.forEach((x, i) => { const on = x === 'bare' || x === 'thin', side = turn && i > ti; if (run && (!on || run.st !== x || run.side !== side)) flush(); if (on) { if (run) run.b = i; else run = { a: i, b: i, st: x, side }; } });
      flush();
    }
    h += lab(H - 20, t('kv.ch.elev'));
    if (turn) { const a = X(turnKm), b = X(turnKm + pk); if (b - a >= 44) h += `<text class="tv-pauselab" x="${(a + b) / 2}" y="${H - 24}" font-size="11" text-anchor="middle">${esc(pauseText(s.R.pause))}</text>`; }   // low in the band, over the profile (the summit's label stays at the summit)
    s.R.tops.forEach((i) => { const p = D[i], x = X(posD(i)), anchor = x > W - 28 ? 'end' : x < L + 28 ? 'start' : 'middle'; h += `<text x="${x}" y="${Zy(p.z) - 4}" font-size="10" text-anchor="${anchor}" fill="${muted}">${Math.round(p.z)} m</text>`; });   // a top at either end: the label stays inside the chart
    s.R.legs.forEach((l) => { h += `<line x1="${X(posD(l.di))}" x2="${X(posD(l.di))}" y1="${Zy(D[l.di].z ?? zmin)}" y2="${H - 12}" stroke="${muted}" stroke-dasharray="2 3"/>`; });
    for (let k = 2; k < km && X(posK(k, k > turnKm)) < W - 24; k += km > 12 ? 5 : 2) h += `<text x="${X(posK(k, k > turnKm))}" y="${H - 2}" font-size="10" text-anchor="middle" fill="${muted}">${k} km</text>`;
    if (tmin < 0 && tmax > 0) h += `<line x1="${L}" x2="${W - 10}" y1="${Ty(0)}" y2="${Ty(0)}" class="kv-zero"/>${lab(Ty(0) + 4, '0°', 'kv-lab kv-zero-t')}`;
    const tp = pts.filter((p) => Number.isFinite(p.t));
    if (tp.length) h += `<path class="kv-temp" d="${tp.map((p, i) => `${i ? 'L' : 'M'}${X(posP(p)).toFixed(1)} ${Ty(p.t).toFixed(1)}`).join(' ')}"/>`;
    h += lab(Ty(tmax) + 8, Math.round(tmax) + '°', 'kv-lab kv-temp-t');
    h += `<line id="tvCur" x1="-10" x2="-10" y1="14" y2="${H - 12}" class="kv-cur"/>`;
    svg.innerHTML = h;
    $('tvTitle').textContent = `${tripTitle()} · ${wday(pts[0].at)} ${hm(pts[0].at)}–${hm(s.end)} · ${dur((s.end - pts[0].at) / 60e3)}`;
    const used = new Set(pts.map((p) => p.cls));
    $('tvLegend').innerHTML = `<div class="kv-lg-row">${KV_CLASSES.map((c) => `<span class="${used.has(c) ? '' : 'kv-lg-off'}"><i class="kvc-${c}"></i>${t('kv.c.' + c)}</span>`).join('')}</div>` +
      `<div class="kv-lg-row"><span><i class="kv-l-temp"></i>${t('kv.ch.temp')}</span><span><i class="kv-l-gust"></i>${t('tv.lg.gust', { g: GUST })}</span><span><i class="kv-l-dark"></i>${t('kv.lg.dark')}</span><span><i class="tv-l-fog"></i>${t('tv.lg.fog')}</span><span><i class="tv-l-steep"></i>${t('tv.lg.steep', { g: STEEP })}</span><span><i class="tv-l-steep hard"></i>${t('tv.lg.steephard', { g: STEEP_HARD })}</span>${snowUsed.has('thin') ? `<span><i class="tv-l-snowthin"></i>${t('tv.snow.lg.thin')}</span>` : ''}${snowUsed.has('bare') ? `<span><i class="tv-l-snowbare"></i>${t('tv.snow.lg.bare')}</span>` : ''}<span><i class="kv-l-elev"></i>${t('kv.ch.elev')}</span></div>` +
      `<div class="kv-lg-row"><span><i class="tv-l-place"></i>${t('tv.lg.place')}</span><span><i class="tv-l-top">▲</i>${t('tv.lg.top')}</span><span><i class="tv-l-hour"></i>${t('tv.lg.hour')}</span><span><i class="tv-l-cur"></i>${t('tv.lg.cur')}</span>${tv.season === 'winter' ? '' : `<span><i class="tv-l-trk"></i>${t('tv.lg.track')}</span>`}</div>`;
    const posAt = (k) => { const R = s.R; let lo = 0, hi = R.cumKm.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.cumKm[m] <= k) lo = m; else hi = m; }
      const a = R.cumKm[lo], b = R.cumKm[hi], f = b > a ? (k - a) / (b - a) : 0, p = R.coords[lo], q = R.coords[hi]; return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]; };
    const seek = (v) => {   // v: a position on the axis (km, with the pause's band)
      v = Math.max(0, Math.min(tot, v)); const x = X(v);
      let i = 0; while (i < pts.length - 2 && posP(pts[i + 1]) <= v) i++;
      let p = pts[i], q = pts[i + 1] || p, pa = posP(p), qa = posP(q), f = qa > pa ? Math.max(0, Math.min(1, (v - pa) / (qa - pa))) : 0;
      let k = p.km + f * (q.km - p.km), at = new Date(+p.at + f * (q.at - p.at));
      if (turn && v >= turnKm && v <= turnKm + pk) {   // inside the pause: standing at the far end, the clock running
        p = pts.find((x) => x.di === s.R.turnDi) || p; q = p; k = turnKm; at = new Date(+p.at + (pk ? (v - turnKm) / pk : 0) * s.R.pause * 60e3);
      }
      const tc = Number.isFinite(p.t) && Number.isFinite(q.t) ? p.t + f * (q.t - p.t) : p.t;
      const d = turn && v >= turnKm && v <= turnKm + pk ? D[s.R.turnDi] : D.reduce((a, o, j) => (Math.abs(posD(j) - v) < Math.abs(posD(D.indexOf(a)) - v) ? o : a), D[0]);
      const di = D.indexOf(d), gi = Math.min(D.length - 1, Math.max(1, di)), rise = (D[gi].z ?? 0) - (D[gi - 1].z ?? 0), g = Math.round(gradeAt(s.R, d.km));   // the gradient of the 150 m around you, as the chips measure it
      const steepTxt = g >= 5 ? ` · <span class="tv-grade${g >= STEEP_HARD ? ' hard' : g >= STEEP ? ' steep' : ''}">${rise >= 0 ? '↗' : '↘'} ${g} %</span>` : '';
      const c = svg.querySelector('#tvCur'); c.setAttribute('x1', x); c.setAttribute('x2', x);
      $('tvRead').innerHTML = `<span class="kv-r1"><b>${hm(at)}</b> · ${fmt(k, 1)} km · ${Math.round(d.z ?? p.z ?? 0)} ${t('kv.masl')}${steepTxt} · <b>${fmt(tc, 1)}°</b>${Number.isFinite(p.app) ? ' (' + t('tv.feels', { t: Math.round(p.app) }) + ')' : ''}</span>` +
        `<span class="kv-r2">${t('kv.c.' + p.cls)}${p.mm >= 0.1 ? ' ' + fmt(p.mm, 1) + ' mm/t' : ''} · ${t('kv.gusts', { g: Math.round(p.g) })}${p.vis != null && p.vis < 1000 ? ' · ' + t('tv.vis', { m: Math.round(p.vis / 100) * 100 }) : ''}${p.dark ? ' · ' + t('kv.dark') : ''}${sw ? ' · ' + esc(snowRead(sw.at[di], d)) : ''}</span>`;
      const pos = posAt(k); MAP.cursor(pos);
      return { k, at, pos };
    };
    tv.seek = (k) => seek(posK(k, k > turnKm + 0.01));   // by km, from the map and the stages
    const pick = (ev) => { const r = svg.getBoundingClientRect(), x = Math.max(L, Math.min(W - 10, (ev.clientX - r.left) / r.width * W)); seek((x - L) / (W - L - 10) * tot); };
    let down = null;
    svg.onpointermove = pick;
    svg.onpointerdown = (ev) => { pick(ev); down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; };
    svg.onpointerup = (ev) => { if (!down) return; const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), quick = performance.now() - down.t < 600; down = null;
      if (moved > 6 || !quick) return; const r = svg.getBoundingClientRect(), x = Math.max(L, Math.min(W - 10, (ev.clientX - r.left) / r.width * W)); MAP.focus(seek((x - L) / (W - L - 10) * tot).pos); };
  }

  function snowRead(x, d) {   // the snow at the point under the cursor, for the readout's second line (and the phone strip)
    if (!x || x.st === 'na') return t('tv.snow.r.na');
    const txt = x.st === 'glacier' ? t('tv.snow.r.deep') : x.st === 'bare' ? (x.sd != null && x.sd >= 1 ? t('tv.snow.r.scant', { cm: Math.round(x.sd) }) : t('tv.snow.r.bare'))
      : x.st === 'thin' ? t('tv.snow.r.thin', { cm: Math.round(x.sd ?? 0) }) : x.sd == null ? t('tv.snow.r.na') : x.ski === 3 || x.ski === 2 ? t('tv.snow.r.ok', { cm: Math.round(x.sd), ski: t(x.ski === 3 ? 'tv.snow.k3' : 'tv.snow.k2') }) : t('tv.snow.r.okn', { cm: Math.round(x.sd) });
    return txt + (x.a != null && d.z != null && Math.abs(x.a - d.z) > 150 ? ` (${t('tv.snow.r.alt', { a: Math.round(x.a) })})` : '');
  }

  /* ---------------- the map: MapLibre with terrain and the 2D / 3D button (shared bootstrap in js/kvcore.js), Leaflet where WebGL is missing ---------------- */
  const { hasGL, isDark, glMap, glMark, lineFeature, BASE_TILES } = KVCore;
  const LINE = { dry: '#22c55e', fog: '#a3a3a3', wet: '#3b82f6', heavy: '#1e40af', sleet: '#8b5cf6', snow: '#38bdf8', ice: '#f43f5e', thunder: '#f59e0b' };
  const snowCan = () => tv.season === 'winter' && hasGL && !!tv.snow && !!tv.snow.days && tv.snow.days.length > 0;   // the snowflake can be offered
  const snowMapOn = () => snowCan() && !!tv.snowMap;   // tv.snowMap is the choice; the browser's storage only remembers it
  // the casing under the route; over NVE's snow colours wider and white (dark: near black): the winter route's light blue is close to 1–1.5 m of snow
  const casing = () => (snowMapOn() ? { c: isDark() ? '#0b1220' : '#fff', o: 0.95, w: 11 } : isDark() ? { c: '#f8fafc', o: 0.85, w: 9 } : { c: '#0f172a', o: 0.55, w: 9 });
  // NVE's snow-depth map for a day (seNorge, the ImageServer's colour rendering; numbers never come from it): a raster per tile, the day chosen by name
  const snowTiles = (name) => 'https://gis3.nve.no/image/rest/services/seNorgeGrid/sd/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image&interpolation=RSP_NearestNeighbor&noData=1,1,1&noDataInterpretation=esriNoDataMatchAll&mosaicRule=' + encodeURIComponent(JSON.stringify({ where: `Name='${name}'` }));
  const SNOW_SWATCH = ['204,245,122', '217,255,255', '179,255,255', '128,235,255', '64,204,255', '0,153,255', '0,25,255', '0,0,153'];   // NVE's legend, as measured on the tiles
  const SNOW_TICKS = [['0', 0.5], ['25', 2], ['50', 3], ['100', 4], ['150', 5], ['200', 6], ['400', 7]];   // cm: 0 under the bare swatch, the rest at the borders between the swatches
  function snowRuns(s) {   // the chosen route's stretches with little or no snow as lines for the map: [{coords, st}]
    const w = snowOk(s); if (!w || w.allBare) return [];   // the whole route dashed tells nothing the headline does not
    const D = s.R.dense, out = []; let run = null;
    w.st.forEach((x, i) => { const on = x === 'bare' || x === 'thin'; if (run && (!on || run.st !== x)) { out.push(run); run = null; } if (on) { if (!run) run = { st: x, coords: i ? [[D[i - 1].lat, D[i - 1].lon]] : [] }; run.coords.push([D[i].lat, D[i].lon]); } });
    if (run) out.push(run);
    return out.filter((r) => r.coords.length >= 2);
  }
  function segsOf(s) {   // the trail coloured by the weather of each stretch: a sample colours the trail up to the next one
    const R = s.R, out = [];
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i], b = s.pts[i + 1], seg = [[a.lat, a.lon]];
      for (let j = 0; j < R.coords.length; j++) if (R.cumKm[j] > a.km && R.cumKm[j] < b.km) seg.push(R.coords[j]);
      seg.push([b.lat, b.lon]); out.push({ coords: seg, c: LINE[a.cls] || '#22c55e' });
    }
    return out;
  }
  const MAPS = {
    gl: {
      m: null, ready: null, marks: [], cur: null, fitTok: 0,
      init() {
        if (this.ready) return this.ready;
        this.ready = glMap('tvMap', (m) => {
          this.m = m;
          const empty = { type: 'FeatureCollection', features: [] }, round = { 'line-join': 'round', 'line-cap': 'round' };
          ['tv-hover', 'tv-alt', 'tv-casing', 'tv-sel', 'tv-walk', 'tv-trk'].forEach((id) => m.addSource(id, { type: 'geojson', data: empty }));
          m.addLayer({ id: 'tv-alt', type: 'line', source: 'tv-alt', layout: round, paint: { 'line-color': '#64748b', 'line-width': 5, 'line-opacity': 0.6 } });
          m.addLayer({ id: 'tv-hover', type: 'line', source: 'tv-hover', layout: round, paint: { 'line-color': '#f59e0b', 'line-width': 14, 'line-opacity': 0.55, 'line-blur': 1 } }, 'tv-alt');   // the route under the pointer on a chip: a halo under it
          m.on('click', 'tv-alt', (e) => { if (tv.pick || m.queryRenderedFeatures(e.point, { layers: ['tv-hit'] }).length) return; selectRoute(e.features[0].properties.kind); });   // a shared trail belongs to the chosen route
          m.on('mouseenter', 'tv-alt', () => { if (!tv.pick) m.getCanvas().style.cursor = 'pointer'; }); m.on('mouseleave', 'tv-alt', () => { if (!tv.pick) m.getCanvas().style.cursor = ''; });
          m.addLayer({ id: 'tv-casing', type: 'line', source: 'tv-casing', layout: round, paint: { 'line-color': '#0f172a', 'line-width': 9, 'line-opacity': 0.5 } });
          m.addLayer({ id: 'tv-sel', type: 'line', source: 'tv-sel', layout: round, paint: { 'line-color': ['get', 'c'], 'line-width': 6 } });
          m.addSource('tv-snowbad', { type: 'geojson', data: empty });
          m.addLayer({ id: 'tv-snowbad', type: 'line', source: 'tv-snowbad', layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 4, 'line-dasharray': [2, 2] } });   // little or no snow (NVE), dashed over the route
          m.addLayer({ id: 'tv-trk', type: 'line', source: 'tv-trk', layout: { 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 2.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 } });   // the stretches on tracks, dashed over the line
          m.addLayer({ id: 'tv-hit', type: 'line', source: 'tv-casing', layout: round, paint: { 'line-color': '#000', 'line-width': 28, 'line-opacity': 0 } });   // easy to hit, also with a finger
          m.addLayer({ id: 'tv-walk', type: 'line', source: 'tv-walk', layout: round, paint: { 'line-color': '#fff', 'line-width': 2, 'line-dasharray': [1.5, 2] } });   // the way to the trail, off the marked trails
          m.on('click', 'tv-hit', (e) => { if (tv.pick) return; if (tv.R && tv.seek) tv.seek(nearestKm(tv.R, e.lngLat.lat, e.lngLat.lng)); });
          m.on('click', (e) => { if (tv.pick) pickAt(e.lngLat.lat, e.lngLat.lng); });   // a point on the map as start or end
          m.on('mouseenter', 'tv-hit', () => { if (!tv.pick) m.getCanvas().style.cursor = 'pointer'; });
          m.on('mouseleave', 'tv-hit', () => { if (!tv.pick) m.getCanvas().style.cursor = ''; });
        }, () => { if (tv.S) this.draw(tv.S); });
        return this.ready;
      },
      hover(kind) {   // a route chip under the pointer: that route gets a halo on the map
        const m = this.m; if (!m || !m.getSource('tv-hover')) return; const R = kind ? (tv.routes || []).find((x) => x.kind === kind) : null;
        m.getSource('tv-hover').setData(R ? lineFeature(R.coords, {}) : { type: 'FeatureCollection', features: [] });
      },
      async draw(s) {
        await this.init(); const m = this.m, R = s.R, cs = casing();
        m.setPaintProperty('tv-casing', 'line-color', cs.c); m.setPaintProperty('tv-casing', 'line-opacity', cs.o); m.setPaintProperty('tv-casing', 'line-width', cs.w);
        m.setPaintProperty('tv-alt', 'line-color', isDark() ? '#cbd5e1' : '#334155'); m.setPaintProperty('tv-alt', 'line-opacity', isDark() ? 0.75 : 0.8);
        m.getSource('tv-alt').setData({ type: 'FeatureCollection', features: (tv.routes || []).filter((x) => x !== R).map((x) => lineFeature(x.coords, { kind: x.kind })) });
        m.getSource('tv-casing').setData({ type: 'FeatureCollection', features: [lineFeature(R.coords, {})] });
        m.getSource('tv-sel').setData({ type: 'FeatureCollection', features: segsOf(s).map((g) => lineFeature(g.coords, { c: g.c })) });
        m.getSource('tv-walk').setData({ type: 'FeatureCollection', features: approachLines(R).map((l) => lineFeature(l, {})) });
        m.getSource('tv-trk').setData({ type: 'FeatureCollection', features: (tv.routes || [R]).flatMap((x) => trackLines(x)).map((l) => lineFeature(l, {})) });
        const sc = { thin: cssv('--mid'), bare: cssv('--bad') }; m.getSource('tv-snowbad').setData({ type: 'FeatureCollection', features: snowRuns(s).map((r) => lineFeature(r.coords, { c: sc[r.st] })) });
        this.snow();
        this.marks.forEach((k) => k.remove()); this.marks = [];
        R.legs.forEach((l) => { const p = R.dense[l.di]; this.marks.push(glMark(m, [p.lat, p.lon], '', 'tv-dotmk', `${l.name} · ${Math.round(p.z ?? 0)} ${t('kv.masl')}`)); });
        R.tops.forEach((i) => { const p = R.dense[i]; this.marks.push(glMark(m, [p.lat, p.lon], '▲', 'kv-mk tv-topmk', `${Math.round(p.z)} ${t('kv.masl')}`)); });
        [[tv.a, 'A'], [tv.b, 'B']].forEach(([p, k]) => this.marks.push(glMark(m, [+p.lat, +p.lon], k, 'kv-abm', p.n)));
        if (ownVia()) tv.via.forEach((v, i) => this.marks.push(glMark(m, [v[0], v[1]], String(i + 1), 'kv-abm', v[2] || t('tv.via.point'))));
        this.labels = altLabels().map((lb) => {   // the time of each route where it is farthest from the other routes; a tap chooses
          const el = document.createElement('button'); el.type = 'button'; el.className = 'kv-altlabel' + (lb.sel ? ' sel' : ''); el.textContent = lb.text; el.title = lb.title;
          if (!lb.sel) el.addEventListener('click', () => selectRoute(lb.kind));
          const mk = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lb.at[1], lb.at[0]]).addTo(m); this.marks.push(mk);
          return { ...lb, mk, el };
        });
        this.cur = glMark(m, [s.pts[0].lat, s.pts[0].lon], '', 'tv-curmk'); this.cur.getElement().style.opacity = '0'; this.marks.push(this.cur);
        if (window.GlettUI) GlettUI.map('tv', m, s, this.marks);
        if (!this.placeWired) { this.placeWired = true; m.on('moveend', () => this.placeLabels()); m.on('resize', () => this.placeLabels()); }
        requestAnimationFrame(() => this.placeLabels());
        if (tv.pick) this.pickMode(true);   // a redraw while aiming (the model weights arriving) keeps the trip hidden
        m.resize();
        if (!tv.fitted) {   // the whole trip in view: now, on the next frame and once the layout has settled (the container may still be resizing)
          tv.fitted = true; const tok = ++this.fitTok, fit = () => { if (tok === this.fitTok && tv.R === R) { m.resize(); this.fitAll(allCoords(), true); } };
          fit(); requestAnimationFrame(fit); setTimeout(fit, 400); m.once('idle', fit);   // once more when the terrain tiles are in: they move the projection
        }
      },
      placeLabels() {   // each route label on a free spot: no trail under it, no other label, no weather icon or button; hidden when there is no room
        const m = this.m; if (!m || !this.labels || !tv.SS) return;
        const box = m.getContainer().getBoundingClientRect(), pts = [];
        tv.SS.forEach((x) => { const c = x.R.coords, st = Math.max(1, Math.floor(c.length / 1500)); for (let i = 0; i < c.length; i += st) { const q = m.project([c[i][1], c[i][0]]); if (q.x > -50 && q.y > -50 && q.x < box.width + 50 && q.y < box.height + 50) pts.push(q); } });
        const hitsRoute = (r) => pts.some((q) => q.x > r.l - 3 && q.x < r.r + 3 && q.y > r.t - 3 && q.y < r.b + 3);
        const shown = [], pad = 4;
        m.getContainer().parentElement.querySelectorAll('.kv-bigbtn, .gl-wxmk:not([hidden]), .gl-verdict').forEach((e) => { const q = e.getBoundingClientRect(); if (q.width) shown.push({ l: q.left - box.left, r: q.right - box.left, t: q.top - box.top, b: q.bottom - box.top }); });
        this.labels.forEach((lb) => {
          lb.el.hidden = false;
          const a = m.project([lb.at[1], lb.at[0]]), w = lb.el.offsetWidth, h = lb.el.offsetHeight;
          const dirs = [0, 45, -45, 90, -90, 135, -135, 180].map((d) => { const r = (d - 90) * Math.PI / 180; return [Math.cos(r), Math.sin(r)]; });   // above first, then round
          let pick = null;
          for (const avoidLines of [true, false]) { for (const dist of [6, 20, 38]) { for (const [dx, dy] of dirs) {
            const cx = a.x + dx * (w / 2 + dist), cy = a.y + dy * (h / 2 + dist), r = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
            if (r.l < 4 || r.t < 4 || r.r > box.width - 4 || r.b > box.height - 4) continue;
            if ((avoidLines && hitsRoute(r)) || shown.some((o) => r.l < o.r + pad && r.r > o.l - pad && r.t < o.b + pad && r.b > o.t - pad)) continue;
            pick = { off: [cx - a.x, cy - a.y], r }; break; } if (pick) break; } if (pick) break; }
          if (!pick) { lb.el.hidden = true; return; }
          lb.mk.setOffset(pick.off); shown.push(pick.r);
        });
      },
      cursor(p) { if (this.cur) { this.cur.setLngLat([p[1], p[0]]); this.cur.getElement().style.opacity = '1'; } },
      focus(p) { if (this.m) this.m.flyTo({ center: [p[1], p[0]], zoom: Math.max(this.m.getZoom(), 13), duration: 1000 }); },
      view(p, z) { if (this.m) this.m.jumpTo({ center: [p[1], p[0]], zoom: z }); },
      applyBase() { KVCore.applyBase(this.m); },   // only the base layers' visibility: the snow layer stays
      snow() {   // NVE's snow-depth layer for the planned day, under every route layer; added, moved to another day or removed
        const m = this.m; if (!m || !m.getLayer('tv-hover')) return;
        const S = tv.snow, k = snowMapOn() ? snowDayIx(+(tv.dep || new Date())) : null, name = k != null && S.tiles ? S.tiles[k] : null, id = name ? name + '|' + LANG : null;
        // under NVE's colours the base map is greyed, so the pale green of bare ground is not lost in the topo map's green forest; the theme's own values come back after
        if (name) ['osm', 'base'].forEach((b) => { if (m.getLayer(b)) m.setPaintProperty(b, 'raster-saturation', -0.85); }); else if (this.snowId) KVCore.glTheme(m);
        if (id === this.snowId) return;
        if (m.getLayer('tv-snow')) m.removeLayer('tv-snow'); if (m.getSource('tv-snow')) m.removeSource('tv-snow'); this.snowId = id;
        if (!name) return;
        m.addSource('tv-snow', { type: 'raster', tileSize: 256, maxzoom: 10, tiles: [snowTiles(name)], attribution: t('tv.snow.attr') });   // beyond zoom 10 the 1 km squares are enlarged, not smoothed
        m.addLayer({ id: 'tv-snow', type: 'raster', source: 'tv-snow', paint: { 'raster-opacity': 0.65, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, 'tv-hover');
      },
      pickMode(on) {   // the trip is hidden while aiming, and the cursor stays a crosshair
        const m = this.m; if (!m) return; m.getCanvas().style.cursor = on ? 'crosshair' : '';
        ['tv-alt', 'tv-casing', 'tv-sel', 'tv-snowbad', 'tv-hit', 'tv-walk', 'tv-trk'].forEach((id) => { if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible'); });
        this.marks.forEach((k) => { k.getElement().style.display = on ? 'none' : ''; });
      },
      bounds(coords) { if (this.m) this.m.fitBounds([[Math.min(...coords.map((c) => c[1])), Math.min(...coords.map((c) => c[0]))], [Math.max(...coords.map((c) => c[1])), Math.max(...coords.map((c) => c[0]))]], { padding: 50, maxZoom: 14, duration: 1200 }); },
      fitAll(coords, reset) {   // fitBounds does not account for the terrain, so the fit is checked on screen and widened until every point is inside; reset: a new trip is seen flat and north up
        const m = this.m; if (!m) return;
        m.fitBounds([[Math.min(...coords.map((c) => c[1])), Math.min(...coords.map((c) => c[0]))], [Math.max(...coords.map((c) => c[1])), Math.max(...coords.map((c) => c[0]))]], { padding: 30, duration: 0, pitch: reset ? 0 : m.getPitch(), bearing: reset ? 0 : m.getBearing() });
        const w = m.getCanvas().clientWidth, h = m.getCanvas().clientHeight, step = Math.max(1, Math.floor(coords.length / 400));
        for (let k = 0; k < 4; k++) {
          const out = coords.some((c, i) => { if (i % step) return false; const q = m.project([c[1], c[0]]); return q.x < 20 || q.y < 20 || q.x > w - 20 || q.y > h - 20; });
          if (!out) break; m.setZoom(m.getZoom() - 0.4);
        }
      },
      resize() { if (this.m) this.m.resize(); },
    },
    leaflet: {
      m: null, layers: [], cur: null, fitTok: 0,
      init() {
        if (this.m) return Promise.resolve();
        const m = this.m = L.map('tvMap', { zoomControl: true, attributionControl: true });
        this.osm = L.tileLayer(BASE_TILES.osm.tiles[0], { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(m);
        this.kart = L.tileLayer(BASE_TILES.kartverket.tiles[0], { maxZoom: 18, attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>' }).addTo(m);
        m.setView([62, 9], 5); this.applyBase();
        m.on('click', (e) => { if (tv.pick) pickAt(e.latlng.lat, e.latlng.lng); });
        return Promise.resolve();
      },
      hover() { /* no halo on the fallback map */ },
      snow() { /* no snow layer on the fallback map */ },
      async draw(s) {
        this.init(); const m = this.m, R = s.R, cs = casing();
        this.layers.forEach((l) => m.removeLayer(l)); this.layers = [];
        const add = (l) => { this.layers.push(l.addTo(m)); return l; };
        (tv.routes || []).filter((x) => x !== R).forEach((x) => add(L.polyline(x.coords, { color: isDark() ? '#cbd5e1' : '#334155', weight: 5, opacity: 0.75 })).on('click', () => selectRoute(x.kind)));
        add(L.polyline(R.coords, { color: cs.c, weight: 9, opacity: cs.o, interactive: false }));
        add(L.polyline(R.coords, { color: '#000', weight: 26, opacity: 0.001 })).on('click', (e) => { if (tv.pick) return; if (tv.seek) tv.seek(nearestKm(R, e.latlng.lat, e.latlng.lng)); });
        altLabels().forEach((lb) => add(L.marker(lb.at, { opacity: 0, interactive: false })).bindTooltip(esc(lb.text), { permanent: true, direction: 'auto', className: 'kv-altlabel-lf' }));
        segsOf(s).forEach((g) => add(L.polyline(g.coords, { color: g.c, weight: 6, opacity: 1, interactive: false })));
        approachLines(R).forEach((l) => add(L.polyline(l, { color: '#fff', weight: 2, dashArray: '3 4', interactive: false })));
        (tv.routes || [R]).flatMap((x) => trackLines(x)).forEach((l) => add(L.polyline(l, { color: '#fff', weight: 2.5, dashArray: '6 4', interactive: false })));
        R.legs.forEach((l) => { const p = R.dense[l.di]; add(L.circleMarker([p.lat, p.lon], { radius: 5, color: '#111', fillColor: '#fff', fillOpacity: 1, weight: 2 })).bindTooltip(`${esc(l.name)} · ${Math.round(p.z ?? 0)} ${t('kv.masl')}`); });
        R.tops.forEach((i) => { const p = R.dense[i]; add(L.marker([p.lat, p.lon], { icon: L.divIcon({ html: '▲', className: 'kv-mk tv-topmk', iconSize: [22, 22] }) })).bindTooltip(`${Math.round(p.z)} ${t('kv.masl')}`); });
        [[tv.a, 'A'], [tv.b, 'B']].forEach(([p, k]) => add(L.marker([+p.lat, +p.lon], { icon: L.divIcon({ html: k, className: 'kv-abm', iconSize: [22, 22] }) })).bindTooltip(esc(p.n)));
        if (ownVia()) tv.via.forEach((v, i) => add(L.marker([v[0], v[1]], { icon: L.divIcon({ html: String(i + 1), className: 'kv-abm', iconSize: [22, 22] }) })).bindTooltip(esc(v[2] || t('tv.via.point'))));
        this.cur = add(L.circleMarker([s.pts[0].lat, s.pts[0].lon], { radius: 7, color: '#fff', fillColor: '#2563eb', fillOpacity: 0, opacity: 0, weight: 3, interactive: false }));
        if (tv.pick) this.pickMode(true);
        if (!tv.fitted) { tv.fitted = true; const tok = ++this.fitTok, fit = () => { if (tok === this.fitTok && tv.R === R) { m.invalidateSize(); this.fitAll(allCoords()); } }; setTimeout(fit, 30); setTimeout(fit, 400); }
        else setTimeout(() => m.invalidateSize(), 30);
      },
      cursor(p) { if (this.cur) this.cur.setLatLng(p).setStyle({ opacity: 1, fillOpacity: 1 }); },
      focus(p) { if (this.m) this.m.flyTo(p, Math.max(this.m.getZoom(), 13), { duration: 1 }); },
      view(p, z) { if (this.m) this.m.setView(p, z); },
      applyBase() { const m = this.m; if (!m) return; if (KVCore.baseChoice() === 'osm') { if (m.hasLayer(this.kart)) m.removeLayer(this.kart); } else if (!m.hasLayer(this.kart)) this.kart.addTo(m); },
      pickMode(on) { const m = this.m; if (!m) return; m.getContainer().style.cursor = on ? 'crosshair' : ''; this.layers.forEach((l) => (on ? m.removeLayer(l) : l.addTo(m))); },
      bounds(coords) { if (this.m) this.m.flyToBounds(L.latLngBounds(coords), { padding: [50, 50], maxZoom: 14, duration: 1.2 }); },
      fitAll(coords) { if (this.m) this.m.fitBounds(L.latLngBounds(coords), { padding: [24, 24] }); },
      resize() { if (this.m) this.m.invalidateSize(); },
    },
  };
  const MAP = hasGL ? MAPS.gl : MAPS.leaflet;
  function bigLabel() { const b = $('tvBig'), on = $('tvMap').classList.contains('big') || !!(PHONE && PHONE.on); b.innerHTML = `${BIG_ICON[on ? 'shrink' : 'grow']}<span>${t(on ? 'kv.map.small' : 'kv.map.big')}</span>`; b.setAttribute('aria-pressed', on ? 'true' : 'false'); KVCore.baseLabel($('tvBase')); fullLabel(); }
  let FULL = null;   // "Enda større kart": built on first use
  const fullIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3z"/><path d="M15 3v18"/></svg>';
  function fullLabel() {
    const f = $('tvFull'); if (!f) return; const on = !!(FULL && FULL.on);
    f.hidden = !tv.R || !!tv.pick; f.innerHTML = `${fullIcon}<span>${t(on ? 'kv.map.normal' : 'kv.map.full')}</span>`; f.setAttribute('aria-pressed', on ? 'true' : 'false');
    const below = [$('tvBig'), $('tvBase')].filter((b) => b && !b.hidden && b.offsetParent).reduce((m, b) => Math.max(m, b.offsetTop + b.offsetHeight), 4); f.style.top = (below + 6) + 'px';
  }
  function setFull(on) {
    if (!tv.R) return;
    if (!FULL) FULL = KVCore.fullMap({ wrap: $('tvMapWrap'), cards: [$('tvChartCard'), document.querySelector('#view-tur .kv-itcard')], onToggle: () => fullLabel(),
      onLayout: (final) => { MAP.resize(); if (final && tv.R) { MAP.fitAll(allCoords()); if (tv.S) renderChart(tv.S); } } });
    if (on && $('tvMap').classList.contains('big')) setBig(false);
    FULL.open(on);
  }
  function fitBig() {   // the map takes the screen height the chart leaves
    const m = $('tvMap'), card = $('tvChartCard'), head = document.querySelector('.topbar');
    m.style.height = Math.max(240, Math.min(900, innerHeight - (head ? head.offsetHeight : 60) - card.offsetHeight - 24)) + 'px'; MAP.resize();
  }
  let PHONE = null;   // phones: the whole screen with a scrubber strip
  function phoneView() {
    return PHONE ||= KVCore.phoneMap({ wrap: $('tvMapWrap'), onToggle: () => bigLabel(),
      lane: () => { const s = tv.S; if (!s) return { segs: [] }; const tot = s.R.km || 1; return { segs: s.seg.map((g) => ({ f0: s.pts[g.a].km / tot, f1: s.pts[Math.min(g.b + 1, s.pts.length - 1)].km / tot, cls: g.cls })) }; },
      seek: (f) => { if (tv.S && tv.seek) tv.seek(f * (tv.S.R.km || 1)); },
      read: () => { const r = $('tvRead'); return [(r.querySelector('.kv-r1') || r).textContent, (r.querySelector('.kv-r2') || {}).textContent || '']; },
      onLayout: (final) => { MAP.resize(); if (final && tv.R) MAP.fitAll(allCoords()); } });
  }
  function setBig(on) {   // larger: the map and the chart move to the top of the page together (a placeholder marks their home)
    if (!tv.R) return;   // nothing to show large before a trip
    if (FULL && FULL.on) FULL.open(false);   // from the whole window straight to the larger map: the page first
    if (PHONE && PHONE.on) { PHONE.open(false); return; }   // the same button again: back to the page
    if (KVCore.phoneLike()) { phoneView().open(on); return; }   // phones: the whole screen
    const m = $('tvMap'), wrap = $('tvMapWrap'), card = $('tvChartCard'), top = $('tvMapTop'), lg = card.querySelector('details');
    if (on === m.classList.contains('big')) return;
    if (on) { if (!card._home) { card._home = document.createComment('tv-chart-home'); card.parentElement.insertBefore(card._home, card); } wrap._bhome = wrap._bhome || document.createComment('tv-map-home'); wrap.parentElement.insertBefore(wrap._bhome, wrap); top.appendChild(wrap); top.appendChild(card); lg._was = lg.open; lg.open = false; }
    else { card._home.after(card); wrap._bhome.after(wrap); m.style.height = ''; if (lg._was != null) lg.open = lg._was; }   // each back to its own place: the map and the chart may live in different columns
    m.classList.toggle('big', on); bigLabel();
    if (on) { if (tv.S) renderChart(tv.S); fitBig(); }
    setTimeout(() => { MAP.resize(); if (tv.R) { MAP.fitAll(allCoords()); if (tv.S) renderChart(tv.S); } }, 60);
    const head = document.querySelector('.topbar');
    setTimeout(() => window.scrollTo({ top: (on ? top : card).getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 60) - 8, behavior: 'smooth' }), 90);
  }
  const approachLines = (R) => {   // the off-trail stretches: from the tapped start to the trail, and from the trail to the tapped end (both ways with a return)
    const out = [], c = R.coords, ap = R.approach || {};
    if (ap.a >= 20) { out.push([c[0], c[1]]); if (R.turnDi >= 0) out.push([c[c.length - 2], c[c.length - 1]]); }
    if (ap.b >= 20) { if (R.turnDi >= 0) { const k = c.findIndex((p) => p[0] === tv.b.lat && p[1] === tv.b.lon); if (k > 0) out.push([c[k - 1], c[k]], [c[k], c[k + 1]]); } else out.push([c[c.length - 2], c[c.length - 1]]); }
    return out;
  };
  const trackLines = (R) => {   // the stretches of a route on tracks, as runs of coordinates
    const out = []; let run = null;
    R.coords.forEach((p, i) => { if (i && R.tk && R.tk[i]) { if (!run) run = [R.coords[i - 1]]; run.push(p); } else if (run) { out.push(run); run = null; } });
    if (run) out.push(run); return out;
  };
  const allCoords = () => (tv.routes || [tv.R]).flatMap((x) => x.coords);
  function altLabels() {   // [{kind, at, text, title, sel}]: each route's label where it is farthest from the other routes
    const SS = tv.SS || []; if (SS.length < 2) return [];
    const step = (a, n) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0), d2 = (a, b) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180)) ** 2;
    const near = (p, pts) => pts.reduce((m, q) => Math.min(m, d2(p, q)), Infinity), sel = tv.S, out = [];
    const placed = [], SEP = 0.0025 ** 2;   // ~250 m between labels
    [...SS].sort((a, b) => (a === sel ? -1 : b === sel ? 1 : 0)).forEach((x) => {
      const others = SS.filter((y) => y !== x).map((y) => step(y.R.coords, 300)).flat(), cands = [];
      step(x.R.coords, 200).forEach((p, j, arr) => { if (j < arr.length * 0.1 || j > arr.length * 0.9) return; cands.push({ p, d: near(p, others) }); });
      cands.sort((a, b) => b.d - a.d);
      const best = cands.find((c) => placed.every((q) => d2(c.p, q) > SEP)) || cands[0];
      if (!best) return; placed.push(best.p);
      const mine = x.end - x.pts[0].at, dm = Math.round((mine - (sel.end - sel.pts[0].at)) / 60e3);
      out.push({ kind: x.R.kind, at: best.p, sel: x === sel, title: routeName(x.R), text: x === sel ? dur(mine / 60e3) : t('tv.rt.short.' + x.R.kind) + ' ' + (Math.abs(dm) < 1 ? t('kv.alt.same') : (dm > 0 ? '+' : '−') + dur(Math.abs(dm))) });
    });
    return out;
  }
  function nearestKm(R, lat, lon) { let best = 0, bd = Infinity; R.coords.forEach((c, i) => { const d = hav(c, [lat, lon]); if (d < bd) { bd = d; best = i; } }); return R.cumKm[best]; }
  function showMap() { MAP.init(); setTimeout(() => MAP.resize(), 50); }
  function renderMap(s) { MAP.draw(s).catch((e) => console.warn('Turvær map', e)); }
  function snowBtn() {   // the snowflake on the map (winter, MapLibre, NVE's days at hand) and the legend under the map while the layer is on
    const b = $('tvSnow'), S = tv.snow, can = snowCan(), on = snowMapOn();
    b.hidden = !can; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = '❄ ' + t(on ? 'tv.snow.map.off' : 'tv.snow.map'); b.title = b.textContent;
    const lg = $('tvSnowLg'); lg.hidden = !on; if (!on) { lg.innerHTML = ''; return; }
    const all = SNOW_SWATCH.map((c, i) => t('tv.snow.b' + i)).join(', ');   // the bar in words, for screen readers and as the swatches' titles
    lg.setAttribute('aria-label', t('tv.snow.lgmap', { d: snowDayLabel(+(tv.dep || new Date())) }) + ': ' + all);
    lg.innerHTML = `<div class="tv-snowlg-t">${S.sim ? `<span class="tv-snow-sim">${esc(t('tv.snow.simshort', { d: S.sim.split('-').reverse().join('.') }))}</span> ` : ''}${esc(t('tv.snow.lgmap', { d: snowDayLabel(+(tv.dep || new Date())) }))}</div>` +
      `<div class="tv-snowlg-s" aria-hidden="true">${SNOW_SWATCH.map((c, i) => `<i style="background:rgb(${c})" title="${esc(t('tv.snow.b' + i))}"></i>`).join('')}</div>` +
      `<div class="tv-snowlg-k" aria-hidden="true">${SNOW_TICKS.map(([v, x]) => `<span style="left:${(x / SNOW_SWATCH.length * 100).toFixed(2)}%">${v}</span>`).join('')}<b>cm</b></div>`;
  }

  /* ---------------- the itinerary: a row per named point, the tops and the end ---------------- */
  const TY = { parkering: 'tv.ty.parkering', hytte: 'tv.ty.hytte', dagsturhytte: 'tv.ty.dagsturhytte', gapahuk: 'tv.ty.gapahuk', rastebu: 'tv.ty.rastebu', utsikt: 'tv.ty.utsikt', topp: 'tv.ty.topp' };
  function renderIt(s) {
    const R = s.R, pts = s.pts, rows = [];
    const at = (di) => pts.reduce((b, p) => (Math.abs(p.di - di) < Math.abs(b.di - di) ? p : b), pts[0]);
    const turn = R.turnDi >= 0 ? [{ di: R.turnDi, name: tv.b.n, ty: '', turn: true }] : [];
    const marks = [{ di: 0, name: tv.a.n, ty: '' }, ...turn, ...R.legs.filter((l) => l.di > 2 && l.di < R.dense.length - 3 && (R.turnDi < 0 || Math.abs(l.di - R.turnDi) > 3)), ...R.tops.filter((i) => !R.legs.some((l) => Math.abs(l.di - i) < 3)).map((i) => ({ di: i, name: topName(R.dense[i]), ty: 'topp' })), { di: R.dense.length - 1, name: R.turnDi >= 0 ? tv.a.n : tv.b.n, ty: '', end: true }]
      .sort((a, b) => a.di - b.di).filter((m, i, arr) => !i || m.di - arr[i - 1].di >= 2);
    marks.forEach((m, i) => {
      let p = at(m.di); const next = marks[i + 1], d = R.dense[m.di];
      if (m.turn && R.pause > 0) {   // arriving at the far end, the pause with its own forecast, then the way back
        const dep = wxPoint(R, m.di, +p.at + R.pause * 60e3), mid = wxPoint(R, m.di, +p.at + R.pause * 30e3);   // leaving again at the same spot, after the pause
        rows.push(`<li class="kv-stage" data-k0="${d.km.toFixed(3)}" data-k1="${d.km.toFixed(3)}" tabindex="0"><span><b>${hm(p.at)}</b></span><span><b>${esc(m.name)}</b> <small>${Math.round(d.z ?? 0)} ${t('kv.masl')}</small><div class="tv-leg">${esc(t('tv.pause.arrive'))}</div></span>${wxCell(p)}</li>`);
        const flags = [];
        if (mid.thunder) flags.push(['bad', '⚡ ' + t('tv.thunderrisk')]);
        if (mid.gustHard) flags.push(['bad', t('tv.s.gust', { g: Math.round(mid.g) })]); else if (mid.gust) flags.push(['warn', t('tv.s.gust', { g: Math.round(mid.g) })]);
        if (mid.cold) flags.push(['cold', t('tv.feels', { t: Math.round(mid.app) })]);
        if (mid.dark) flags.push(['warn', t('kv.dark')]);
        rows.push(`<li class="kv-stage tv-pause" data-k0="${d.km.toFixed(3)}" data-k1="${d.km.toFixed(3)}" tabindex="0"><span><b>${hm(p.at)}</b><small>${esc(t('tv.pause.to', { h: hm(dep.at) }))}</small></span>` +
          `<span><b>${esc(pauseText(R.pause))}</b> <small class="tv-ty">${esc(t('tv.pause.at', { p: m.name }))}</small>${flags.length ? `<div class="kv-badges">${flags.map(([k, x]) => `<span class="kv-badge ${k}">${esc(x)}</span>`).join('')}</div>` : ''}</span>${wxCell(mid)}</li>`);
        p = dep;   // the row below is the departure back
      }
      let leg = '';
      if (next) {
        const seg = pts.filter((x) => x.di >= m.di && x.di <= next.di), up = sumUp(R.dense, m.di, next.di), kmL = R.dense[next.di].km - d.km;
        const q = at(next.di), mins = (q.at - p.at) / 60e3;
        const worst = seg.reduce((w, x) => (W[x.cls] > W[w.cls] ? x : w), seg[0]);
        const flags = [];
        if (seg.some((x) => x.thunder && x.cls !== 'thunder')) flags.push(['bad', '⚡ ' + t('tv.thunderrisk')]); else if (seg.some((x) => x.thunder)) flags.push(['bad', '⚡ ' + t('kv.c.thunder')]);
        if (seg.some((x) => x.gustHard)) flags.push(['bad', t('tv.s.gust', { g: Math.round(Math.max(...seg.map((x) => x.g))) })]); else if (seg.some((x) => x.gust)) flags.push(['warn', t('tv.s.gust', { g: Math.round(Math.max(...seg.map((x) => x.g))) })]);
        if (i === 0 && (R.approach || {}).a >= 20) flags.push(['warn', t(tv.season === 'winter' ? 'tv.approach.leg.w' : 'tv.approach.leg', { m: R.approach.a })]);
        if (next.end && (R.approach || {}).b >= 20) flags.push(['warn', t(tv.season === 'winter' ? 'tv.approach.leg.w' : 'tv.approach.leg', { m: R.approach.b })]);
        const st = R.steep.filter((r) => r.b > m.di && r.a < next.di); if (st.length) flags.push([Math.max(...st.map((r) => r.max)) >= STEEP_HARD ? 'bad' : 'warn', t('tv.steep.leg', { g: Math.round(Math.max(...st.map((r) => r.max))) })]);
        if (seg.some((x) => x.fog)) flags.push(['warn', t('kv.c.fog')]);
        if (seg.some((x) => x.dark)) flags.push(['warn', t('kv.dark')]);
        if (seg.some((x) => x.slick)) flags.push(['warn', t('kv.slick')]);
        const sw = snowOk(s);
        if (sw && !sw.allBare) {   // the stage's own stretch, each point at its own time (not when the whole route is without snow: the headline says it once)
          let b = 0, th = 0, sc = false; for (let j = m.di + 1; j <= next.di; j++) { const w = R.dense[j].km - R.dense[j - 1].km; if (sw.st[j] === 'bare') { b += w; if (sw.at[j].sd >= 1) sc = true; } else if (sw.st[j] === 'thin') th += w; }
          if (b >= 0.3) flags.push(['warn', t(sc ? 'tv.snow.c.scant' : 'tv.snow.c.bare', { km: snowKmTxt(Math.max(0.5, b)) })]); else if (th >= 0.3) flags.push(['warn', t('tv.snow.c.thin', { km: snowKmTxt(Math.max(0.5, th)) })]);
        }
        const eh = ensHints(seg, worst.cls)[0];
        leg = `<div class="tv-leg">→ ${esc(next.name)} · ${fmt(kmL, 1)} km · ↑ ${up.up} m ↓ ${up.down} m · ${esc(dur(mins))}</div>` +
          (flags.length ? `<div class="kv-badges">${flags.map(([k, x]) => `<span class="kv-badge ${k}">${esc(x)}</span>`).join('')}</div>` : '') + waxStage(s, m.di, next.di) +
          (eh ? `<div class="kv-ens">${esc(t(eh.share >= 0.35 ? 'kv.ens.maybe' : 'kv.ens.unlikely', { x: t('kv.ens.n.' + eh.f) }) + ' ' + t('kv.ens.time', { h: hm(eh.p.at) }))}</div>` : '');
      }
      rows.push(`<li class="kv-stage" data-k0="${d.km.toFixed(3)}" data-k1="${(next ? R.dense[next.di].km : d.km).toFixed(3)}" tabindex="0"><span><b>${hm(p.at)}</b></span>` +
        `<span><b>${esc(m.name)}</b>${m.turn ? ` <small class="tv-ty">${esc(R.pause > 0 ? t(R.kind === 'loop' ? 'tv.pause.leave2' : R.kind === 'loop2' ? 'tv.pause.leave3' : 'tv.pause.leave') : t('tv.ret.pause', { d: pauseText(R.pause) }))}</small>` : ''}${m.ty && TY[m.ty] ? ` <small class="tv-ty">${esc(t(TY[m.ty]))}</small>` : ''} <small>${Math.round(d.z ?? 0)} ${t('kv.masl')}</small>${leg}</span>` +
        wxCell(p) + '</li>');
    });
    $('tvIt').innerHTML = rows.join('');
  }
  function wxPoint(R, di, ms) {   // the forecast at a profile point and a moment, as a sample-like object (the pause)
    const d = R.dense[di], w = wxAt(d.key, ms) || { t: NaN, mm: 0, code: 0, g: 0, day: 1, dew: NaN, app: NaN };
    const p = { ...d, di, at: new Date(ms), ...w }; p.cls = classify(p.code, p.mm, p.t); p.gust = p.g >= GUST; p.gustHard = p.g >= GUST_HARD; p.dark = !p.day; p.cold = Number.isFinite(p.app) && p.app <= -8;
    p.thunder = p.cls === 'thunder' || (p.cape != null && p.cape >= 800 && p.mm >= 0.5); return p;
  }
  const wxCell = (p) => `<span class="kv-wx"><span class="kvc-${p.cls} kv-wxdot"></span>${esc(t('kv.c.' + p.cls))}<small>${fmt(p.t, 0)}°${Number.isFinite(p.app) ? ', ' + t('tv.feels', { t: Math.round(p.app) }) : ''}</small><small>${esc(t('kv.gusts', { g: Math.round(p.g) }))}</small></span>`;
  function sumUp(d, i0, i1) { let up = 0, down = 0, ref = d[i0].z ?? 0; for (let i = i0 + 1; i <= i1; i++) { const z = d[i].z; if (z == null) continue; if (z - ref >= 5) { up += z - ref; ref = z; } else if (ref - z >= 5) { down += ref - z; ref = z; } } return { up: Math.round(up), down: Math.round(down) }; }

  /* ---------------- finding a hike: the classics, search, near me ---------------- */
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s-]+/g, ' ').trim();
  async function searchAll(q) {   // [{kind: 'classic'|'rute'|'point', ...}]
    q = norm(q); if (q.length < 2) return [];
    const [nm, cl, ru] = await Promise.all([loadNames(), loadClassics(), loadRuter()]);
    const out = [];
    if (tv.season === 'summer') cl.forEach((c) => { if ([c.n, ...c.alias, c.a.n, c.b.n].some((x) => norm(x).includes(q))) out.push({ kind: 'classic', c, label: c.n, sub: `${c.a.n} → ${c.b.n} · ${c.km} km` }); });
    const starts = [], subs = [], pt = (p) => ({ kind: 'point', p, label: p[0], sub: t(TY[p[1]] || 'tv.ty.topp') });
    nm.forEach((p) => { const n = norm(p[0]); if (n.startsWith(q)) starts.push(p); else if (n.includes(q)) subs.push(p); });
    starts.slice(0, 6).forEach((p) => out.push(pt(p)));
    if (tv.season === 'summer') ru.forEach((r) => { if (norm(r.n).includes(q)) out.push({ kind: 'rute', r, label: r.n, sub: `${r.km} km${r.g ? ' · ' + t('tv.g.' + r.g) : ''} · Turrutebasen` }); });
    [...starts.slice(6), ...subs].slice(0, 6).forEach((p) => out.push(pt(p)));
    return out.slice(0, 14);
  }
  function wireSearch(input, list, onPick) {
    let tm = null, seq = 0;
    const close = () => { list.hidden = true; list.innerHTML = ''; };
    input.addEventListener('input', () => {
      clearTimeout(tm); const q = input.value, my = ++seq;
      if (q.trim().length < 2) { close(); return; }
      tm = setTimeout(async () => {
        const res = await searchAll(q).catch(() => []); if (my !== seq) return;
        list.innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}"><b>${r.kind !== 'point' ? '🥾 ' : ''}${esc(r.label)}</b><small> · ${esc(r.sub)}</small></li>`).join('') : `<li class="kv-empty">${esc(t('tv.none'))}</li>`;
        list.hidden = false;
        list.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => { onPick(res[+li.dataset.i]); close(); }));
      }, 250);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { const li = list.querySelector('li[data-i]'); if (li) li.click(); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('.kv-search')) close(); });
  }
  const pointOf = (p) => ({ n: p[0], lat: p[2], lon: p[3], ty: p[1] });
  const MAX_VIA = 5;
  const ownVia = () => tv.via.length > 0 && !tv.classic && !tv.name;   // via points the user set (a classic's or a named route's are the route itself)
  const dropRoute = () => { if (tv.classic || tv.name) tv.via = []; tv.classic = null; tv.name = ''; };   // a new start or end: a classic or named route is gone, the user's own via points stay
  function setClassic(c, dir) {
    tv.classic = c; tv.name = c.n; dir = dir || c.dir || 'ab';
    const A = { n: c.a.n, lat: c.c[0][0], lon: c.c[0][1] }, B = { n: c.b.n, lat: c.c[c.c.length - 1][0], lon: c.c[c.c.length - 1][1] };
    tv.a = dir === 'ab' ? A : B; tv.b = dir === 'ab' ? B : A; tv.via = dir === 'ab' ? c.via.slice() : c.via.slice().reverse();
  }
  function setRute(r) {
    tv.classic = null; tv.name = r.n;
    const P = r.p; tv.a = { n: r.loop ? r.n : t('tv.start'), lat: P[0][0], lon: P[0][1], gen: true }; tv.b = { n: r.loop ? r.n : t('tv.end'), lat: P[P.length - 1][0], lon: P[P.length - 1][1], gen: true }; tv.via = P.slice(1, -1);
  }
  function pick(r, field) {
    tv.sel = 'direct';
    if (r.kind === 'classic') setClassic(r.c);
    else if (r.kind === 'rute') setRute(r.r);
    else if (field === 'v') { if (tv.via.length < MAX_VIA) tv.via.push([r.p[2], r.p[3], r.p[0]]); }
    else { dropRoute(); tv[field] = pointOf(r.p); }
    syncForm(); markDirty();
    if (r.kind !== 'point') { tv.scrollTo = true; go(); }   // a classic or a named route is a whole trip: plan at once; a point only fills the field, the button plans
    else if (field === 'a' && !tv.b) $('tvTo').focus();
  }
  // The classics panel: the button names the chosen classic (or just "Klassikere"); the panel lists them by region, with a region filter
  const REGIONS = ['jotun', 'rondane', 'ost', 'rog', 'vest', 'more', 'nord'];
  const classicMins = (c) => {   // the rough Normal-pace time from the built profile, for the card
    let dn = 0; (c.prof || []).forEach((p, i) => { if (i && p[1] < c.prof[i - 1][1]) dn += c.prof[i - 1][1] - p[1]; });
    return (c.km * MIN_KM + c.up * MIN_UP + dn * MIN_DOWN) * BREAKS;
  };
  async function renderClassics() {
    const cl = await loadClassics().catch(() => []), sel = tv.classic, open = !!tv.clOpen && tv.season !== 'winter';
    $('tvClBtn').classList.toggle('on', !!sel); $('tvClBtn').setAttribute('aria-expanded', open ? 'true' : 'false'); $('tvClBtn').querySelector('span').textContent = sel ? sel.n : t('tv.classics');
    $('tvClHint').textContent = sel ? t('tv.classics.change') : t('tv.classics.n', { n: cl.length });
    $('tvClPanel').hidden = !open; if (!open) return;
    const regs = REGIONS.filter((r) => cl.some((c) => c.reg === r)); if (!regs.includes(tv.clReg)) tv.clReg = 'all';
    $('tvClRegs').innerHTML = [['all', t('tv.reg.all')], ...regs.map((r) => [r, t('tv.reg.' + r)])].map(([r, lb]) => `<button type="button" class="kv-chip small${tv.clReg === r ? ' on' : ''}" data-reg="${r}">${esc(lb)}</button>`).join('');
    const card = (c) => `<button type="button" class="tv-clc${sel && sel.id === c.id ? ' sel' : ''}" data-cid="${esc(c.id)}"><span class="tv-clc-top"><b>${esc(c.n)}</b>${c.grade ? `<span class="tv-gr"><i class="tv-gdot ${c.grade}"></i>${esc(t('tv.g.' + c.grade))}</span>` : ''}</span><span class="tv-clc-sub">${esc(t('tv.cl.sub', { a: c.a.n, b: c.b.n, km: fmt(c.km, 1), up: c.up, t: dur(classicMins(c)) }))}</span><span class="tv-clc-blurb">${esc(c.blurb)}</span></button>`;
    $('tvClList').innerHTML = (tv.clReg === 'all' ? regs : [tv.clReg]).map((r) => `${tv.clReg === 'all' ? `<div class="tv-cl-reg">${esc(t('tv.reg.' + r))}</div>` : ''}${cl.filter((c) => c.reg === r).map(card).join('')}`).join('');
    const on = $('tvClList').querySelector('.sel'); if (on && tv.clScroll) { on.scrollIntoView({ block: 'nearest' }); tv.clScroll = false; }
  }
  async function nearMe() {
    if (!navigator.geolocation) { status(t('err.geo.unsupported'), 'err', 'err.geo.unsupported'); return; }
    status(t('pb.geo.loading'), 'busy', 'pb.geo.loading');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const me = [pos.coords.latitude, pos.coords.longitude]; status('', '');
      const [cl, ru] = await Promise.all([loadClassics(), loadRuter()]);
      if (tv.season === 'winter') {   // no summer trips on skis: the huts, shelters and summits reached on ski trails from here, 1–25 km of trail
        try {
          await loadCells([me], 0.25); const sid = nearestNode(me, 1500);
          if (sid >= 0) {
            const { named, nodes } = net(), { dist } = reach(sid, 25000), dests = [];
            dist.forEach((d, id) => { const nm = named.get(id); if (nm && d >= 1000 && /^(hytte|dagsturhytte|gapahuk|topp)$/.test(nm.ty)) dests.push({ id, n: nm.n, ty: nm.ty, km: d / 1000, p: nodes.get(id) }); });
            dests.sort((a, b) => a.km - b.km);
            if (dests.length) {
              let sn = null, sd = 0.3; named.forEach((nm, id) => { const d = hav(nodes.get(sid), nodes.get(id)); if (d < sd) { sd = d; sn = nm.n; } });   // the start named when a named point is within 300 m
              const start = { n: sn || t('pb.geo.name'), lat: nodes.get(sid)[0], lon: nodes.get(sid)[1] };
              $('tvNear').innerHTML = `<div class="kv-lbl">${esc(t('tv.near.ski', { s: start.n }))}</div><ul class="tv-nearlist">${dests.slice(0, 12).map((x, i) => `<li data-i="${i}"><b>${esc(x.n)}</b><small>${esc(t(TY[x.ty]))} · ${fmt(x.km, 1)} km ${esc(t('tv.near.trail'))}</small></li>`).join('')}</ul>`;
              $('tvNear').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { const x = dests[+li.dataset.i]; $('tvNear').innerHTML = ''; dropRoute(); tv.sel = 'direct'; tv.a = start; tv.b = { n: x.n, lat: x.p[0], lon: x.p[1], ty: x.ty }; syncForm(); tv.scrollTo = true; go(); }));
              return;
            }
          }
        } catch (e) { console.warn('Turvær near (ski)', e); }
        const nm = await loadNames(), near = nm.map((p) => ({ p, d: hav(me, [p[2], p[3]]) })).filter((x) => x.d <= 40 && (x.p[1] === 'hytte' || x.p[1] === 'parkering' || x.p[1] === 'dagsturhytte')).sort((a, b) => a.d - b.d).slice(0, 12);
        $('tvNear').innerHTML = near.length ? `<div class="kv-lbl">${esc(t('tv.near.start'))}</div><ul class="tv-nearlist">${near.map((x, i) => `<li data-i="${i}"><b>${esc(x.p[0])}</b><small>${esc(t(TY[x.p[1]]))} · ${x.d < 1 ? '<1' : Math.round(x.d)} km ${esc(t('tv.near.away'))}</small></li>`).join('')}</ul>` : `<p class="hint">${esc(t('tv.near.none'))}</p>`;
        $('tvNear').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { dropRoute(); tv.a = pointOf(near[+li.dataset.i].p); syncForm(); markDirty(); $('tvNear').innerHTML = ''; $('tvTo').focus(); }));
        return;
      }
      const all = [...cl.map((c) => ({ kind: 'classic', c, label: c.n, sub: `${c.km} km`, d: hav(me, c.c[0]) })), ...ru.map((r) => ({ kind: 'rute', r, label: r.n, sub: `${r.km} km${r.g ? ' · ' + t('tv.g.' + r.g) : ''}`, d: hav(me, r.p[0]) }))]
        .filter((x) => x.d <= 80).sort((a, b) => a.d - b.d).slice(0, 12);
      $('tvNear').innerHTML = all.length ? `<div class="kv-lbl">${esc(t('tv.near.title'))}</div><ul class="tv-nearlist">${all.map((x, i) => `<li data-i="${i}"><b>${esc(x.label)}</b><small>${esc(x.sub)} · ${x.d < 1 ? '<1' : Math.round(x.d)} km ${esc(t('tv.near.away'))}</small></li>`).join('')}</ul>` : `<p class="hint">${esc(t('tv.near.none'))}</p>`;
      $('tvNear').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { $('tvNear').innerHTML = ''; pick(all[+li.dataset.i]); }));
    }, () => status(t('err.geo.fail'), 'err', 'err.geo.fail'), { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  }

  /* ---------------- a point picked on the map: snapped to the nearest trail of the season, named by reverse geocoding ---------------- */
  function startPick(field) {
    tv.pick = field; const v = $('view-tur'), head = document.querySelector('.topbar'); v.classList.add('tv-picking');
    $('tvPickBar').hidden = false; $('tvPickBar').classList.remove('err'); $('tvPickText').textContent = t(field === 'a' ? 'tv.pick.hint.a' : field === 'v' ? 'tv.pick.hint.v' : 'tv.pick.hint.b');
    if (!$('tvMap').classList.contains('big')) $('tvMap').style.height = Math.max(360, innerHeight - (head ? head.offsetHeight : 60) - 110) + 'px';   // room to aim
    Promise.resolve(MAP.init()).then(() => {   // the map may still be loading on the first pick
      MAP.pickMode(true); MAP.resize();
      if (tv.R) return;   // a trip is shown: aim within it
      const c = typeof state !== 'undefined' && state.current ? [state.current.lat, state.current.lon] : null;
      if (c) MAP.view(c, 11);   // the forecast's place; the user's own position only on the button in the pick bar
    });
    setTimeout(() => window.scrollTo({ top: $('tvMapWrap').getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 60) - 8, behavior: 'smooth' }), 80);
  }
  function pickMe() {   // the map centred on the user's position, only when asked for
    if (!tv.pick) return;
    if (!navigator.geolocation) { $('tvPickBar').classList.add('err'); $('tvPickText').textContent = t('err.geo.unsupported'); return; }
    const b = $('tvPickMe'); b.classList.add('busy');
    navigator.geolocation.getCurrentPosition((pos) => { b.classList.remove('busy'); if (tv.pick) MAP.view([pos.coords.latitude, pos.coords.longitude], 13); },
      () => { b.classList.remove('busy'); if (tv.pick) { $('tvPickBar').classList.add('err'); $('tvPickText').textContent = t('err.geo.fail'); } }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }
  function endPick() { tv.pick = null; setTimeout(fullLabel, 0); $('view-tur').classList.remove('tv-picking'); $('tvPickBar').hidden = true; if (!$('tvMap').classList.contains('big')) $('tvMap').style.height = ''; MAP.pickMode(false); MAP.resize(); }
  async function pickAt(lat, lon) {
    if (!tv.pick) return;
    const field = tv.pick;
    try {
      $('tvPickText').textContent = t('tv.loading.route');
      await loadCells([[lat, lon]], 0.05);
      const id = nodeAt([lat, lon], 400);
      if (id < 0) { $('tvPickBar').classList.add('err'); $('tvPickText').textContent = t(tv.season === 'winter' ? 'tv.pick.none.w' : 'tv.pick.none'); return; }   // stay in pick mode: aim again
      endPick(); status(t('tv.loading.route'), 'busy', 'tv.loading.route');
      const q = net().nodes.get(id), nm = net().named.get(id), off = hav([lat, lon], q) * 1000;
      let name = off < 60 && nm ? nm.n : '';
      if (!name) {   // the nearest place name from Kartverket (a street, a farm, a lake), the forecast's reverse geocoder as the fallback
        try { const r = await fetchT(`https://ws.geonorge.no/stedsnavn/v1/punkt?nord=${lat.toFixed(5)}&ost=${lon.toFixed(5)}&koordsys=4258&radius=300&treffPerSide=1&utkoordsys=4258`); const j = r.ok ? await r.json() : null; const h = j && j.navn && j.navn[0]; if (h) name = h.stedsnavn[0].skrivemåte; } catch (e) { /* next */ }
        if (!name) { try { const r = await WEFO.reverse(lat, lon, LANG, true); if (r) name = String(r).split(',')[0]; } catch (e) { /* unnamed */ } }
      }
      // the point stays where it was tapped; the way to the trail (a straight line, off the marked trails) is part of the trip
      if (field === 'v') { if (tv.via.length < MAX_VIA) tv.via.push([q[0], q[1], name || t('tv.via.point')]); }   // a via point sits on the network
      else { tv[field] = off < 20 ? { n: name || t('tv.pick.name'), lat: q[0], lon: q[1], picked: true } : { n: name || t('tv.pick.name'), lat: +lat.toFixed(5), lon: +lon.toFixed(5), picked: true, snap: q, off: Math.round(off) }; dropRoute(); }
      tv.sel = 'direct';
      status('', ''); syncForm(); markDirty();
      if (tv.a && tv.b) { tv.scrollTo = true; go(); } else if (field !== 'v') $(field === 'a' ? 'tvTo' : 'tvFrom').focus();
    } catch (e) { if (tv.pick) endPick(); status(e.message || t('kv.err.wx'), 'err'); }
  }

  /* ---------------- form, share, save, gpx ---------------- */
  function syncForm() {
    $('tvFrom').value = tv.a ? tv.a.n : ''; $('tvTo').value = tv.b ? tv.b.n : '';
    $('tvReset').hidden = !(tv.a || tv.b || tv.via.length || tv.classic || tv.R);   // something to clear
    $('tvVias').innerHTML = ownVia() ? tv.via.map((v, i) => `<div class="kv-field kv-viarow"><b>${t('tv.via.label')} ${i + 1}</b><span>${esc(v[2] || t('tv.via.point'))}</span><button type="button" class="kv-x" data-unvia="${i}" aria-label="${esc(t('pb.remove'))}">×</button></div>`).join('') : '';
    $('tvAddVia').hidden = (tv.via.length >= MAX_VIA && ownVia()) || (tv.via.length > 0 && !ownVia());
    $('tvPace').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === tv.pace));
    $('tvHours').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.h === tv.hours));
    $('tvRoads').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.w === tv.roads)); $('tvRoadsRow').hidden = tv.season === 'winter';   // no forest roads on skis
    $('tvSeason').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === tv.season));
    const retOn = tv.ret != null, loop = isLoop(); $('tvRetOpt').classList.toggle('on', retOn); $('tvRetOpt').setAttribute('aria-pressed', retOn ? 'true' : 'false'); $('tvRetOpt').hidden = !!loop;
    $('tvWaxRow').hidden = tv.season !== 'winter'; $('tvWaxOpt').classList.toggle('on', !!tv.wax); $('tvWaxOpt').setAttribute('aria-pressed', tv.wax ? 'true' : 'false');
    $('tvPause').hidden = !retOn || !!loop; $('tvPause').previousElementSibling.hidden = !retOn || !!loop;
    $('tvPause').innerHTML = PAUSES.map((m) => `<option value="${m}"${m === tv.ret ? ' selected' : ''}>${esc(pauseText(m))}</option>`).join('');
    $('tvPaceHelp').textContent = t(tv.season === 'winter' ? 'tv.pace.help.w' : 'tv.pace.help');
    $('tvClBtn').parentElement.hidden = tv.season === 'winter';
    const opts = depOptions(), cur = tv.dep ? +tv.dep : +opts[0], days = [];
    opts.forEach((d) => { const k = dayKey(d); if (!days.includes(k)) days.push(k); });
    const h0 = (tv.dep || new Date()).getHours(), chipAt = (k) => { const same = opts.filter((d) => dayKey(d) === k); return same.find((d) => d.getHours() === Math.max(h0, same[0].getHours())) || same[0]; };   // the start a day chip picks
    const snowDay = (k) => {   // NVE's snow on that day, by the headline's rules: a dot on the chip, said in its title
      if (tv.season !== 'winter' || !tv.R || !tv.snow || !tv.snow.cells) return null; const w = snowSum(tv.R, +chipAt(k), tv.pace);
      return !w || w.conf !== 'ok' ? null : snowBareH(w) ? 'bare' : snowThinH(w) ? 'thin' : null;
    };
    const marks = days.map(snowDay), allSame = marks.every((x) => x && x === marks[0]);   // the same dot on every day tells nothing the headline does not
    $('tvDays').innerHTML = days.map((k, i) => { const d = opts.find((x) => dayKey(x) === k), on = dayKey(tv.dep || new Date()) === k, sd = allSame ? null : marks[i]; return `<button type="button" class="kv-chip${on ? ' on' : ''}${sd ? ' snow-' + sd : ''}" data-day="${k}"${sd ? ` title="${esc(t('tv.snow.day.' + sd))}"` : ''}>${esc(i === 0 ? t('kv.today') : i === 1 ? t('kv.tomorrow') : wday(d) + ' ' + d.getDate() + '.')}</button>`; }).join('');
    const sel = $('tvHour'), same = opts.filter((d) => dayKey(d) === dayKey(tv.dep || new Date()));
    sel.innerHTML = same.map((d, i) => `<option value="${+d}"${Math.abs(+d - cur) < 1800e3 ? ' selected' : ''}>${i === 0 && !tv.dep && dayKey(d) === dayKey(new Date()) ? esc(t('kv.now')) : hm(d)}</option>`).join('');
    $('tvGo').disabled = !(tv.a && tv.b);
    renderClassics();
  }
  function setDep(d) { tv.dep = d; syncForm(); if (tv.R) { render(); writeHash(); } }
  function markDirty() { tv.fitted = false; tv.dirty = true; $('tvGo').disabled = !(tv.a && tv.b); $('view-tur').classList.toggle('kv-isstale', !!tv.R); if (tv.R && tv.a && tv.b) status(t('kv.stale'), 'info', 'kv.stale'); else if (tv.st && tv.st.kind !== 'busy') status('', ''); }
  function go() { markDirty(); if (tv.a && tv.b) plan(); }
  const pStr = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)},${encodeURIComponent(p.n || '').replace(/%2C/gi, ' ')}`;   // a picked point off the trail is snapped again when the link opens
  const pParse = (s) => { const [la, lo, ...n] = String(s || '').split(','); return Number.isFinite(+la) && Number.isFinite(+lo) && la !== '' ? { lat: +la, lon: +lo, n: decodeURIComponent(n.join(',')) } : null; };
  function hashFor() {
    const d = tv.dep ? `${tv.dep.getFullYear()}${pad2(tv.dep.getMonth() + 1)}${pad2(tv.dep.getDate())}${pad2(tv.dep.getHours())}` : '';
    return `#tv?a=${pStr(tv.a)}&b=${pStr(tv.b)}${tv.via.length ? '&v=' + tv.via.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}${p[2] ? ',' + encodeURIComponent(p[2]).replace(/%2C/gi, ' ') : ''}`).join(';') : ''}${tv.classic ? '&c=' + tv.classic.id : ''}${tv.roads === 'most' ? '&w=m' : ''}${tv.hours === 'all' ? '&h=a' : ''}${tv.name && !tv.classic ? '&n=' + encodeURIComponent(tv.name) : ''}&p=${tv.pace}${tv.season === 'winter' ? '&s=w' : ''}${tv.wax && tv.season === 'winter' ? '&m=1' : ''}${d ? '&d=' + d : ''}${tv.ret != null ? '&r=' + tv.ret : ''}${tv.sel !== 'direct' ? '&x=' + tv.sel : ''}`;
  }
  function writeHash() { try { history.replaceState(null, '', hashFor()); } catch (e) { /* ignore */ } }
  async function readHash() {
    const h = location.hash; if (!h.startsWith('#tv')) return false;
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    const a = pParse(q.get('a')), b = pParse(q.get('b')); if (!a || !b) return false;
    [a, b].forEach((p) => { p.picked = true; }); tv.a = a; tv.b = b; tv.via = (q.get('v') || '').split(';').map((s) => { const [la, lo, ...n] = s.split(','); const v = [+la, +lo]; if (n.length) v.push(decodeURIComponent(n.join(','))); return v; }).filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] !== 0);
    tv.pace = PACE[q.get('p')] ? q.get('p') : 'normal'; tv.roads = q.get('w') === 'm' ? 'most' : 'least'; if (q.get('h') === 'a') tv.hours = 'all'; if (q.get('m') === '1') tv.wax = true; tv.season = q.get('s') === 'w' ? 'winter' : 'summer'; tv.name = q.get('n') || ''; tv.classic = null; tv.ret = q.has('r') && Number.isFinite(+q.get('r')) ? Math.max(0, Math.min(180, +q.get('r'))) : null; tv.sel = ['up', 'up2', 'loop', 'loop2'].includes(q.get('x')) ? q.get('x') : 'direct';
    if (q.get('c')) { const cl = await loadClassics().catch(() => []); const c = cl.find((x) => x.id === q.get('c')); if (c) { tv.classic = c; tv.name = c.n; } }
    const d = q.get('d'); tv.dep = null;
    if (d && /^\d{10}$/.test(d)) { const x = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10)); if (x > Date.now() && x - Date.now() < MAX_AHEAD_H * 3600e3) tv.dep = x; }
    if (tv.dep && (tv.dep.getHours() < START_H[0] || tv.dep.getHours() > START_H[1])) tv.hours = 'all';   // a shared start in the evening or night: the bars show the whole day
    return true;
  }
  const savedList = () => { const a = lsJson('glett.turer', []); return Array.isArray(a) ? a : []; };
  function renderSaved() {
    const list = savedList(), el = $('tvSaved');
    el.innerHTML = list.length ? list.map((r, i) => `<li><span><b>${esc(r.name)}</b><small>${esc(`${r.a.n} → ${r.b.n}`)}</small></span><span class="kv-sv-act"><button type="button" class="kv-chip small" data-open="${i}">${t('kv.saved.open')}</button><button type="button" class="kv-x" data-del="${i}" title="${esc(t('saved.delete'))}" aria-label="${esc(t('saved.delete'))}">×</button></span></li>`).join('')
      : `<li class="kv-empty">${t('tv.saved.none')}</li>`;
  }
  function saveTrip() {
    if (!tv.a || !tv.b) return;
    kvAsk({ title: t('tv.save.title'), text: t('kv.save.name'), value: tripTitle(), ok: t('kv.save.ok') }).then((name) => {
      if (name == null) return;
      const list = savedList().filter((r) => !(r.a.lat === tv.a.lat && r.b.lat === tv.b.lat && r.a.lon === tv.a.lon && r.b.lon === tv.b.lon));
      list.unshift({ id: Date.now().toString(36), name: name.trim() || tripTitle(), a: tv.a, b: tv.b, via: tv.via, c: tv.classic ? tv.classic.id : '', pace: tv.pace, ret: tv.ret, sel: tv.sel, season: tv.season, created: new Date().toISOString() });
      lsSet('glett.turer', JSON.stringify(list.slice(0, 50))); renderSaved(); kvToast(t('kv.saved.ok'));
    });
  }
  function gpx() {
    const R = tv.R, x = (v) => esc(String(v));
    const wpt = (p, n) => `<wpt lat="${(+p.lat).toFixed(6)}" lon="${(+p.lon).toFixed(6)}"><name>${x(n)}</name></wpt>`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Glett Turvær" xmlns="http://www.topografix.com/GPX/1/1">\n` + wpt(tv.a, tv.a.n) + wpt(tv.b, tv.b.n) +
      R.legs.map((l) => wpt(R.dense[l.di], l.name)).join('') + `<trk><name>${x(tripTitle())}</name><trkseg>${R.coords.map((c) => `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"/>`).join('')}</trkseg></trk></gpx>`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'application/gpx+xml' }));
    a.download = `glett-${tripTitle()}.gpx`.replace(/[^\wæøåÆØÅ.-]+/g, '-'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- wiring ---------------- */
  let wired = false;
  function wire() {
    if (wired) return; wired = true;
    wireSearch($('tvFrom'), $('tvFromRes'), (r) => pick(r, 'a'));
    wireSearch($('tvTo'), $('tvToRes'), (r) => pick(r, 'b'));
    $('tvSwap').addEventListener('click', () => { [tv.a, tv.b] = [tv.b, tv.a]; tv.via.reverse(); syncForm(); if (tv.R && !tv.busy) go(); else markDirty(); });
    $('tvHead').addEventListener('mouseover', (e) => { const rt = e.target.closest('[data-route]'); if (rt) MAP.hover(rt.dataset.route); });   // the route of the chip under the pointer lights up on the map
    $('tvHead').addEventListener('mouseleave', () => MAP.hover(null));
    $('tvHead').addEventListener('click', (e) => { if (e.target.closest('#tvRev')) $('tvSwap').click();
      if (e.target.closest('.tv-snow')) { tv.snowOpen = !tv.snowOpen; lsSet('glett.tv.snowOpen', tv.snowOpen ? '1' : null); if (tv.S) renderHead(tv.S); const b = $('tvHead').querySelector('.tv-snow'); if (b) b.focus(); return; }
      if (e.target.closest('[data-snowmap]')) { $('tvSnow').click(); return; }
      if (e.target.closest('.tv-wax')) { tv.waxOpen = !tv.waxOpen; lsSet('glett.tv.waxOpen', tv.waxOpen ? '1' : null); if (tv.S) renderHead(tv.S); const b = $('tvHead').querySelector('.tv-wax'); if (b) b.focus(); return; }
      const rt = e.target.closest('[data-route]'), st = e.target.closest('[data-start]'); if (!tv.R || !tv.R.sugg) return;
      if (rt) selectRoute(rt.dataset.route);
      if (st) { const x = tv.R.sugg.starts[+st.dataset.start]; tv.a = { n: x.n, lat: x.p[0], lon: x.p[1], ty: x.ty }; dropRoute(); syncForm(); go(); } });
    // the return, chosen in the planner: on or off re-plans (the trail doubles), the pause only re-times
    $('tvWaxOpt').addEventListener('click', () => {   // the wax tips: off by default, kept; never plans again
      tv.wax = !tv.wax; lsSet('glett.tv.wax', tv.wax ? '1' : null); syncForm(); if (tv.R) writeHash();
      if (tv.wax && tv.routes && !(tv.snow && tv.snow.wx)) loadSnow(tv.routes, tv.token); else if (tv.S) render(); });
    $('tvRetOpt').addEventListener('click', () => { tv.ret = tv.ret == null ? 30 : null; if (tv.sel === 'loop' || tv.sel === 'loop2') tv.sel = 'direct'; syncForm(); if (tv.R && !tv.busy) go(); else markDirty(); });
    $('tvPause').addEventListener('change', (e) => { tv.ret = +e.target.value; if (tv.R) { (tv.routes || [tv.R]).forEach((R) => { R.pause = tv.ret; }); render(); writeHash(); } });
    $('tvClBtn').addEventListener('click', () => { tv.clOpen = !tv.clOpen; tv.clScroll = true; renderClassics(); });
    $('tvClRegs').addEventListener('click', (e) => { const b = e.target.closest('[data-reg]'); if (!b) return; tv.clReg = b.dataset.reg; lsSet('glett.tv.clreg', tv.clReg); renderClassics(); });
    $('tvClList').addEventListener('click', async (e) => { const b = e.target.closest('[data-cid]'); if (!b) return; const c = (await loadClassics()).find((x) => x.id === b.dataset.cid); if (c) { setClassic(c); tv.clOpen = false; syncForm(); tv.scrollTo = true; markDirty(); } });   // the hike is filled in; "Finn turvær" calculates it
    $('tvNearBtn').addEventListener('click', nearMe);
    $('tvPickA').addEventListener('click', () => (tv.pick === 'a' ? endPick() : startPick('a')));
    $('tvPickB').addEventListener('click', () => (tv.pick === 'b' ? endPick() : startPick('b')));
    $('tvPickV').addEventListener('click', () => (tv.pick === 'v' ? endPick() : startPick('v')));
    wireSearch($('tvViaIn'), $('tvViaRes'), (r) => { if (r.kind === 'point') { $('tvViaBox').hidden = true; $('tvViaIn').value = ''; pick(r, 'v'); } });
    $('tvAddVia').addEventListener('click', () => { $('tvViaBox').hidden = false; $('tvViaIn').focus(); });
    $('tvVias').addEventListener('click', (e) => { const b = e.target.closest('[data-unvia]'); if (b) { tv.via.splice(+b.dataset.unvia, 1); tv.sel = 'direct'; syncForm(); if (tv.R && !tv.busy) go(); else markDirty(); } });
    $('tvPickOff').addEventListener('click', endPick);
    $('tvPickMe').addEventListener('click', pickMe);
    $('tvSeason').addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (!b || b.dataset.s === tv.season) return; tv.season = b.dataset.s; lsSet('glett.tv.season', tv.season);
      [tv.a, tv.b].forEach((p) => { if (p && p.snap) { delete p.snap; delete p.off; } });   // a picked point snaps again, to the other season's trails
      if (tv.season === 'winter' && (tv.classic || (tv.name && !tv.ret))) { tv.classic = null; } syncForm(); if (tv.R && !tv.busy) go(); else markDirty(); });
    $('tvFull').addEventListener('click', () => setFull(!(FULL && FULL.on)));
    KVCore.mapControls($('tvMap'), { big: $('tvBig'), full: $('tvFull'), base: $('tvBase'), snow: $('tvSnow') });
    $('tvSnow').addEventListener('click', () => { tv.snowMap = !tv.snowMap; lsSet('glett.tv.snowmap', tv.snowMap ? '1' : null); snowBtn(); if (tv.S) renderMap(tv.S); if (tv.S && tv.snowOpen) renderHead(tv.S); });   // off by default; the choice is kept
    $('tvBig').addEventListener('click', () => setBig(!$('tvMap').classList.contains('big')));
    $('tvBase').addEventListener('click', () => { KVCore.setBaseChoice(KVCore.baseChoice() === 'osm' ? 'kartverket' : 'osm'); bigLabel(); MAP.applyBase(); });
    $('tvHours').addEventListener('click', (e) => { const b = e.target.closest('button[data-h]'); if (!b || b.dataset.h === tv.hours) return; tv.hours = b.dataset.h; lsSet('glett.tv.hours', tv.hours === 'all' ? 'all' : null); syncForm(); if (tv.R) { render(); writeHash(); } });   // the bars only: no new route
    $('tvRoads').addEventListener('click', (e) => { const b = e.target.closest('button[data-w]'); if (!b || b.dataset.w === tv.roads) return; tv.roads = b.dataset.w; lsSet('glett.tv.roads', tv.roads === 'most' ? 'most' : null); syncForm(); if (tv.R && !tv.busy && !tv.dirty) rerouteIfChanged(); else if (tv.R && !tv.busy) go(); else markDirty(); });   // the way may change: planned again only if it does
    $('tvReset').addEventListener('click', () => {   // a blank planner: the trip, its points and the result go; season, pace and the other choices stay
      tv.roads = 'least'; lsSet('glett.tv.roads', null);   // forest roads back to "Minst mulig"
      fresh(); syncForm(); renderClassics();
    });
    $('tvPace').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (!b || b.dataset.p === tv.pace) return; tv.pace = b.dataset.p; lsSet('glett.tv.pace', tv.pace); syncForm(); if (tv.R) { render(); writeHash(); } });
    $('tvDays').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return; const opts = depOptions(), h = (tv.dep || new Date()).getHours(), same = opts.filter((d) => dayKey(d) === b.dataset.day); setDep(same.find((d) => d.getHours() === Math.max(h, same[0].getHours())) || same[0]); });
    $('tvHour').addEventListener('change', (e) => setDep(new Date(+e.target.value)));
    $('tvDep').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) setDep(tv.depOpts[+b.dataset.k]); });
    $('tvDepHint').addEventListener('click', (e) => { const ub = e.target.closest('#tvUseBest'); if (ub) setDep(tv.depOpts[+ub.dataset.k]); });
    $('tvGo').addEventListener('click', () => { if (!tv.busy) go(); });
    $('tvIt').addEventListener('click', (e) => { const li = e.target.closest('.kv-stage'); if (!li || !tv.R) return; const k0 = +li.dataset.k0, k1 = +li.dataset.k1, R = tv.R;
      const coords = R.coords.filter((_, i) => R.cumKm[i] >= k0 - 0.05 && R.cumKm[i] <= k1 + 0.05); if (coords.length < 2) return;
      const wrap = $('tvMapWrap'), head = document.querySelector('.topbar'); window.scrollTo({ top: wrap.getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 60) - 12, behavior: 'smooth' });
      setTimeout(() => MAP.bounds(coords), 350); if (tv.seek) tv.seek(k0); });
    $('tvSave').addEventListener('click', saveTrip);
    $('tvGpx').addEventListener('click', gpx);
    $('tvShare').addEventListener('click', async () => {
      const url = location.origin + location.pathname + hashFor();
      try { if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: 'Glett Turvær', url }); return; } await navigator.clipboard.writeText(url); kvToast(t('kv.share.ok')); } catch (e) { kvAsk({ title: t('kv.share'), text: t('kv.share.copy'), value: url, readonly: true, ok: t('kv.dlg.ok') }); }
    });
    $('tvSaved').addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]'), list = savedList();
      if (o) { const r = list[+o.dataset.open]; tv.a = r.a; tv.b = r.b; tv.via = r.via || []; tv.name = r.name; tv.pace = PACE[r.pace] ? r.pace : tv.pace; tv.ret = r.ret ?? null; tv.sel = ['up', 'up2', 'loop', 'loop2'].includes(r.sel) ? r.sel : 'direct'; tv.season = r.season === 'winter' ? 'winter' : 'summer'; tv.classic = null;
        loadClassics().then((cl) => { tv.classic = cl.find((x) => x.id === r.c) || null; syncForm(); go(); }); }
      if (d) { const r = list[+d.dataset.del]; kvAsk({ title: t('kv.del.title'), text: t('kv.saved.del', { n: r.name }), ok: t('saved.delete'), danger: true }).then((yes) => { if (!yes) return; lsSet('glett.turer', JSON.stringify(list.filter((x) => x.id !== r.id))); renderSaved(); }); }
    });
    addEventListener('resize', () => { if ($('tvMap').classList.contains('big')) fitBig(); if (tv.S) renderChart(tv.S); });
    const retheme = () => { if (tv.S) { renderMap(tv.S); setTimeout(() => renderChart(tv.S), 0); } };   // the chart's colours are read when it is drawn
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  }
  function fresh() {
    tv.token++; if (tv.pick) endPick(); setBig(false);   // the large map goes back to its place before the trip is forgotten (it sits above the form, outside the result)
    Object.assign(tv, { a: null, b: null, via: [], classic: null, name: '', dep: null, ret: null, R: null, S: null, SS: null, routes: null, sel: 'direct', fitted: false, dirty: false, clOpen: false, snow: null });
    snowBtn(); MAP.snow();
    $('tvResult').hidden = true; $('tvGo').classList.remove('busy'); status('', ''); $('tvNear').innerHTML = '';
    $('view-tur').classList.remove('kv-isstale'); $('view-tur').classList.add('kv-noroute');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  window.tvShow = async function () {
    wire();
    const fromLink = location.hash.startsWith('#tv');
    tv.started = true;
    let ok = false;
    if (fromLink) { try { ok = await readHash(); } catch (e) { ok = false; } }
    if (!ok) fresh();
    $('view-tur').classList.toggle('kv-noroute', !tv.R);
    syncForm(); renderSaved(); bigLabel(); if (tv.R) showMap();
    if (ok && tv.a && tv.b) { tv.fitted = false; plan(); }
  };
  window.tvLang = function () { if (!tv.started) return; syncForm(); renderSaved(); bigLabel(); if (tv.st && tv.st.key) status(t(tv.st.key), tv.st.kind, tv.st.key); if (tv.R) render(); };
  window.tvEngine = { state: () => tv, net, routeVia, walkMinutes, summarise, suggest, profile, steepRuns, startPick, pickAt, map: () => MAP.m, renderDeps, snowSum, headline, waxSum: () => tv.S && waxSum(tv.S) };   // for tests
  if (location.hash.startsWith('#tv')) setTimeout(() => showView('tur'), 0);
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#tv')) showView('tur'); });
})();
