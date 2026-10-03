// Turvær: the marked trail network for hiking (summer) and the marked ski trails (winter). Builds data/tur/ from open
// Norwegian data (Kartverket, CC BY 4.0):
//   - Turrutebasen: the marked hiking trails (Fotrute with merking JA), the marked ski trails (Skiløype with merking JA
//     or SM), and the info points on them (car parks, tourist huts, open day huts, shelters, rest huts, viewpoints)
//   - Stedsnavn (the complete SSR): tourist huts and summits that lie on or next to a marked trail
//   - tools/tur/classics.json: hand-picked classic hikes, routed on the network here and checked against known figures
// Run on a developer machine (node 18+, the duckdb CLI with the spatial extension; the SSR file is 7 GB, scanned once):
//   node tools/tur/build.mjs
// Downloads stay in tools/tur/cache/ (not in git, not deployed). The output is small static files:
//   data/tur/index.json          {v, cells: [...], scells: [...], ...counts}   which grid cells have a file (summer, winter)
//   data/tur/g/<la4>_<lo2>.json  {e: [[a, b, metres, [lat, lon, lat, lon, ...], [z, z, ...]], ...], p: [[node, name, type, lat, lon], ...]}
//                                z: the height of each vertex from Kartverket's terrain model (metres), so the browser
//                                draws the profile without asking a height service
//                                the hiking trails: cells of 0.25° latitude × 0.5° longitude; a, b are node ids shared
//                                across cells, an edge lies in the cell of its first point; p = the named points in the cell
//   data/tur/s/<la4>_<lo2>.json  the same for the ski trails (node ids from 10 000 000)
//   data/tur/names.json          [[name, type, lat, lon, node, cell], ...]   the search index of named points (both networks)
//   data/tur/ruter.json          [{n, g, km, p: [[lat, lon], ...]}, ...]   Turrutebasen's own named hiking routes of 5 km and
//                                more, as their two ends and two waypoints (the browser routes through them on the network)
//   data/tur/classics.json       [{id, n, alias, a, b, via, dir, why, blurb, wiki, km, up, top, c: [[lat, lon], ...]}, ...]
import fs from 'node:fs';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const DIR = new URL('.', import.meta.url).pathname, ROOT = DIR + '../../', CACHE = DIR + 'cache/', OUT = ROOT + 'data/tur/';
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT + 'g/', { recursive: true }); fs.mkdirSync(OUT + 's/', { recursive: true });
const MAX_AGE = 25 * 86400e3;
const fresh = (f) => fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < MAX_AGE;
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opt });
const duck = (sql) => sh('duckdb', ['-c', 'LOAD spatial; SET geometry_always_xy = true; ' + sql]);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function download(url, file) {
  if (fresh(file)) return file;
  log('download', url);
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
async function geonorge(uuid, proj, file) {   // Geonorge's download API: order the whole country as GML, then fetch it
  if (fresh(file)) return file;
  const r = await fetch('https://nedlasting.geonorge.no/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderLines: [{ metadataUuid: uuid, areas: [{ code: '0000', type: 'landsdekkende', name: 'Hele landet' }], projections: [{ code: proj }], formats: [{ name: 'GML' }] }] }) });
  const j = await r.json(); const f = (j.files || [])[0];
  if (!f || !f.downloadUrl) throw new Error('Geonorge order without a file: ' + uuid);
  return download(f.downloadUrl, file);
}
function unzip(zip, dir) { if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); sh('unzip', ['-q', '-o', zip, '-d', dir]); } return dir; }
const findExt = (dir, ext) => { for (const e of fs.readdirSync(dir, { recursive: true })) if (String(e).endsWith(ext)) return dir + e; throw new Error(`no ${ext} in ${dir}`); };
const cached = (file, make) => { if (fresh(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); const v = make(); fs.writeFileSync(file, JSON.stringify(v)); return v; };

/* ---------------- geometry helpers (points are [lat, lon]) ---------------- */
const R5 = (x) => Math.round(x * 1e5) / 1e5;
const hav = (a, b) => { const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(x)); };
const lineLen = (c) => { let m = 0; for (let i = 1; i < c.length; i++) m += hav(c[i - 1], c[i]); return m; };
// the nearest point of a segment to p, in a local flat metric: {t: 0..1, d: metres, p: [lat, lon]}
function projSeg(p, a, b) {
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { t, d: Math.hypot(x, y), p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
}
function simplify(c, tolM) {   // Douglas-Peucker, tolerance in metres
  if (c.length < 3) return c;
  const keep = new Uint8Array(c.length); keep[0] = keep[c.length - 1] = 1;
  const stack = [[0, c.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); let best = 0, bi = -1;
    for (let k = i + 1; k < j; k++) { const d = projSeg(c[k], c[i], c[j]).d; if (d > best) { best = d; bi = k; } }
    if (best > tolM) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return c.filter((_, k) => keep[k]);
}
const cellOf = (la, lo) => `${Math.floor(la * 4)}_${Math.floor(lo * 2)}`;
const GC = 0.005;   // the grid for nearest-segment searches: ~500 m cells
const gkey = (la, lo) => `${Math.floor(la / GC)}_${Math.floor(lo / (GC * 2))}`;

/* ---------------- 1. Turrutebasen: trails, ski trails and info points ---------------- */
const TRB = findExt(unzip(await geonorge('d1422d17-6d95-4ef1-96ab-8af31744dd63', '25833', CACHE + 'turrutebasen.zip'), CACHE + 'turrutebasen/'), '.gml');
const readLayer = (layer, where, file) => cached(CACHE + file + '.json', () => {
  log('reading', layer);
  duck(`COPY (SELECT lokalId id, gradering g, rutenavn n, rutenummer r, ST_AsGeoJSON(ST_Transform(ST_Simplify(senterlinje, 5), 'EPSG:25833', 'EPSG:4326')) geom
    FROM ST_Read('${TRB}', layer='${layer}') WHERE ${where}) TO '${CACHE}${file}.raw.json' (FORMAT JSON, ARRAY true)`);
  return JSON.parse(fs.readFileSync(`${CACHE}${file}.raw.json`, 'utf8'));
});
const raw = readLayer('Fotrute', "merking IN ('JA', 'SM')", 'edges');
const rawSki = readLayer('Skiløype', "merking IN ('JA', 'SM')", 'skiedges');
const INFO = { 22: 'parkering', 43: 'hytte', 44: 'dagsturhytte', 45: 'gapahuk', 12: 'rastebu', 46: 'utsikt' };   // Turrutebasen's tilrettelegging codes
const info = cached(CACHE + 'infopoints.json', () => {
  log('reading info points');
  duck(`COPY (SELECT tilrettelegging k, informasjon i, ST_AsGeoJSON(ST_Transform(posisjon, 'EPSG:25833', 'EPSG:4326')) geom
    FROM ST_Read('${TRB}', layer='RuteInfoPunkt') WHERE tilrettelegging IN (${Object.keys(INFO).join(',')})) TO '${CACHE}info.raw.json' (FORMAT JSON, ARRAY true)`);
  return JSON.parse(fs.readFileSync(CACHE + 'info.raw.json', 'utf8'));
});
log('trail segments', raw.length, 'ski segments', rawSki.length, 'info points', info.length);

/* ---------------- 2. SSR: tourist huts and summits (one streaming pass over the 7 GB file) ---------------- */
const SSR_TYPES = { turisthytte: 'hytte', topp: 'topp', fjell: 'topp' };
const ssr = await (async () => {
  const file = CACHE + 'ssr.json'; if (fresh(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const gml = findExt(unzip(await geonorge('e1c50348-962d-4047-8325-bdc265c853ed', '4258', CACHE + 'ssr.zip'), CACHE + 'ssr/'), '.gml');
  log('scanning place names', gml);
  const out = []; let buf = '', n = 0;
  const take = (chunk) => {   // one <app:Sted> … </app:Sted>
    const ty = (chunk.match(/<app:navneobjekttype>([^<]+)/) || [])[1]; if (!ty || !SSR_TYPES[ty]) return;
    if (!/<app:stedstatus>aktiv</.test(chunk)) return;
    const pos = chunk.match(/<app:posisjon>[\s\S]*?<gml:pos>([\d.]+) ([\d.]+)/); if (!pos) return;
    // the preferred spelling of the main name (prioritertSkrivemåte), the first one otherwise
    const names = [...chunk.matchAll(/<app:Skrivemåte>([\s\S]*?)<\/app:Skrivemåte>/g)].map((m) => m[1]);
    const pick = names.find((s) => /<app:prioritertSkrivemåte>true/.test(s) && !/<app:skrivemåtestatus>(avslått|historisk)/.test(s)) || names[0];
    const name = pick && (pick.match(/<app:langnavn>([^<]+)/) || [])[1]; if (!name) return;
    const imp = (chunk.match(/<app:sortering1Kode>viktighet([A-Z])/) || [])[1] || 'Z';
    out.push([SSR_TYPES[ty], name.trim(), +pos[1], +pos[2], imp]);
  };
  for await (const line of readline.createInterface({ input: fs.createReadStream(gml, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    buf += line + '\n';
    if (line.includes('</app:Sted>')) { take(buf); buf = ''; if (++n % 200000 === 0) log(' …', n, 'places,', out.length, 'kept'); }
  }
  fs.writeFileSync(file, JSON.stringify(out)); return out;
})();
log('place names kept', ssr.length);

/* ---------------- 3. the named points: info points with usable names, then SSR huts and summits ---------------- */
const REACH = { parkering: 60, hytte: 120, dagsturhytte: 80, gapahuk: 60, rastebu: 60, utsikt: 60, topp: 150 };
const PRI = { hytte: 6, dagsturhytte: 5, topp: 4, parkering: 3, rastebu: 2, gapahuk: 2, utsikt: 1 };
const cleanInfo = (s) => {
  let v = String(s || '').replace(/\s+/g, ' ').trim().replace(/[.,;:\s-]+$/, '');
  if (!v || /^(parkering|p-plass|parkeringsplass|informasjonstavle|infotavle|skilt|start|startpunkt|turrute|utsiktspunkt|rastebu|gapahuk|hytte)$/i.test(v)) return '';
  v = v.replace(/^(parkering(splass)?|p-plass)\s*(for|ved|til|:|-)?\s*/i, '').replace(/^(turrute(r)?|tursti)\s*(til|:|-)?\s*/i, '').replace(/^start(punkt)?\s*(for|ved|:|-)?\s*/i, '');
  return v.length > 60 ? v.slice(0, 57).replace(/\s\S*$/, '') + '…' : v;
};
const named = [];
// DuckDB's JSON export hands GeoJSON over as an object already
const geomOf = (j) => (typeof j === 'string' ? JSON.parse(j) : j);
info.forEach((p) => { const g = geomOf(p.geom); const nm = cleanInfo(p.i); if (nm) named.push({ ty: INFO[p.k], n: nm, p: [R5(g.coordinates[1]), R5(g.coordinates[0])] }); });
ssr.forEach(([ty, n, la, lo]) => named.push({ ty, n, p: [R5(la), R5(lo)] }));
log('named points', named.length);

/* ---------------- 4. a network: edges, a grid index, the named points snapped in as nodes, routing ---------------- */
const parseGeom = (j) => { const g = geomOf(j); return (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).map((l) => l.map(([lo, la]) => [R5(la), R5(lo)])); };
function network(rawEdges, idBase, label) {
  const N = { edges: [], grid: new Map(), final: [], nodes: [], nodeId: new Map(), kept: [] };
  rawEdges.forEach((e) => parseGeom(e.geom).forEach((c) => { if (c.length >= 2) N.edges.push({ c, g: e.g || [], n: e.n || [], r: e.r || [] }); }));
  N.edges.forEach((e, i) => { const seen = new Set(); e.c.forEach((p) => { const k = gkey(p[0], p[1]); if (!seen.has(k)) { seen.add(k); if (!N.grid.has(k)) N.grid.set(k, []); N.grid.get(k).push(i); } }); });
  N.nearestSeg = (p, maxM) => {   // the closest segment within maxM: {e, s, t, d, p}
    const la = Math.floor(p[0] / GC), lo = Math.floor(p[1] / (GC * 2)), cand = new Set(); let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (N.grid.get(`${la + a}_${lo + b}`) || []).forEach((i) => cand.add(i));
    cand.forEach((i) => { const c = N.edges[i].c; for (let s = 0; s < c.length - 1; s++) { const q = projSeg(p, c[s], c[s + 1]); if (q.d <= maxM && (!best || q.d < best.d)) best = { e: i, s, ...q }; } });
    return best;
  };
  const snaps = [];
  named.forEach((x) => { const q = N.nearestSeg(x.p, REACH[x.ty]); if (q) snaps.push({ ...q, ty: x.ty, n: x.n }); });
  // the same place twice (an info point and a place name, two spellings): keep the better type, then the shorter name
  snaps.sort((a, b) => PRI[b.ty] - PRI[a.ty] || a.n.length - b.n.length);
  const kgrid = new Map();
  snaps.forEach((s) => {
    const k = gkey(s.p[0], s.p[1]); let dup = false;
    for (let a = -1; a <= 1 && !dup; a++) for (let b = -1; b <= 1 && !dup; b++) (kgrid.get(`${Math.floor(s.p[0] / GC) + a}_${Math.floor(s.p[1] / (GC * 2)) + b}`) || []).forEach((o) => {
      const d = hav(o.p, s.p), same = o.n.toLowerCase() === s.n.toLowerCase();
      if (d < 30 || (same && d < 600) || (o.ty === s.ty && (o.ty === 'parkering' || o.ty === 'utsikt') && d < 120)) dup = true;
    });
    if (dup) return; N.kept.push(s); if (!kgrid.has(k)) kgrid.set(k, []); kgrid.get(k).push(s);
  });
  // split the edges at the snapped points, so every named point is a node
  const byEdge = new Map(); N.kept.forEach((s) => { if (!byEdge.has(s.e)) byEdge.set(s.e, []); byEdge.get(s.e).push(s); });
  N.edges.forEach((e, i) => {
    const cuts = (byEdge.get(i) || []).sort((a, b) => a.s - b.s || a.t - b.t);
    if (!cuts.length) { N.final.push(e); return; }
    let cur = [e.c[0]], s = 0;
    cuts.forEach((q) => {
      for (; s < q.s; s++) cur.push(e.c[s + 1]);   // vertices up to the cut's segment
      const P = [R5(q.p[0]), R5(q.p[1])]; q.node = P;
      if (hav(cur[cur.length - 1], P) > 0.5) cur.push(P);
      if (cur.length >= 2) N.final.push({ ...e, c: cur });
      cur = [P];
    });
    for (; s < e.c.length - 1; s++) cur.push(e.c[s + 1]);
    if (cur.length >= 2 && lineLen(cur) > 0.5) N.final.push({ ...e, c: cur });
  });
  const nid = (p) => { const k = `${p[0]},${p[1]}`; if (!N.nodeId.has(k)) { N.nodeId.set(k, idBase + N.nodes.length); N.nodes.push(p); } return N.nodeId.get(k); };
  N.pos = (id) => N.nodes[id - idBase];
  N.final.forEach((e) => { e.a = nid(e.c[0]); e.b = nid(e.c[e.c.length - 1]); e.m = Math.round(lineLen(e.c)); });
  N.adj = new Map(); N.final.forEach((e, i) => { if (!N.adj.has(e.a)) N.adj.set(e.a, []); if (!N.adj.has(e.b)) N.adj.set(e.b, []); N.adj.get(e.a).push([e.b, e.m, i]); N.adj.get(e.b).push([e.a, e.m, i]); });
  N.nameOf = new Map(); N.kept.forEach((s) => { const id = N.nodeId.get(`${s.node[0]},${s.node[1]}`); if (id != null) N.nameOf.set(id, s); });
  log(label, 'edges', N.final.length, 'nodes', N.nodes.length, 'named points on it', N.kept.length);
  // Dijkstra with a binary heap -> {m, path: [edge index...], nodes: [node...]} or null
  N.dijkstra = (from, to) => {
    const dist = new Map([[from, 0]]), prev = new Map(), pe = new Map(), heap = [[0, from]];
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop(); if (u === to) break; if (d > dist.get(u)) continue;
      for (const [v, w, ei] of N.adj.get(u) || []) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); pe.set(v, ei); push([nd, v]); } }
    }
    if (!dist.has(to)) return null;
    const path = [], ns = [to]; for (let v = to; v !== from; v = prev.get(v)) { path.push(pe.get(v)); ns.push(prev.get(v)); }
    return { m: dist.get(to), path: path.reverse(), nodes: ns.reverse() };
  };
  N.geometry = (route) => {   // the edges of a Dijkstra answer joined in walking order
    const out = []; let at = route.nodes[0];
    route.path.forEach((ei) => { const e = N.final[ei], c = e.a === at ? e.c : [...e.c].reverse(); out.push(...(out.length ? c.slice(1) : c)); at = e.a === at ? e.b : e.a; });
    return out;
  };
  N.routeVia = (points) => {   // points: node ids
    let m = 0; const c = [];
    for (let i = 1; i < points.length; i++) { const r = N.dijkstra(points[i - 1], points[i]); if (!r) return null; m += r.m; const g = N.geometry(r); c.push(...(c.length ? g.slice(1) : g)); }
    return { m, c };
  };
  N.nearestNode = (p, maxM = 300) => {   // any node of the network near a point
    const q = N.nearestSeg(p, maxM); if (!q) return -1;
    const e = N.edges[q.e], cand = [];   // the split parts of that original edge: nearest node among their ends
    N.final.forEach((f) => { if (f.g === e.g && f.n === e.n && f.r === e.r) cand.push(f.a, f.b); });
    let best = -1, bd = Infinity; cand.forEach((n) => { const d = hav(N.pos(n), p); if (d < bd) { bd = d; best = n; } });
    return bd <= maxM * 2 ? best : -1;
  };
  return N;
}
const SUMMER = network(raw, 0, 'hiking trails'), WINTER = network(rawSki, 10000000, 'ski trails');

/* ---------------- 5. heights (Kartverket's terrain model) for the classics ---------------- */
async function heights(c) {   // every ~50 m along c -> {up, top, prof: [[km, z]...]}
  const s = [c[0]]; let acc = 0, km = [0], tot = 0;
  for (let i = 1; i < c.length; i++) { const d = hav(c[i - 1], c[i]); acc += d; tot += d; if (acc >= 50) { s.push(c[i]); km.push(tot / 1000); acc = 0; } }
  if (s[s.length - 1] !== c[c.length - 1]) { s.push(c[c.length - 1]); km.push(tot / 1000); }
  const z = [];
  for (let i = 0; i < s.length; i += 50) {
    const ch = s.slice(i, i + 50);
    const r = await fetch(`https://ws.geonorge.no/hoydedata/v1/punkt?koordsys=4258&geojson=false&punkter=${encodeURIComponent(JSON.stringify(ch.map((p) => [+p[1].toFixed(6), +p[0].toFixed(6)])))}`);
    if (!r.ok) throw new Error('hoydedata ' + r.status);
    (await r.json()).punkter.forEach((p) => z.push(p.z));
  }
  let up = 0, ref = z[0], top = -1e9;   // 5 m hysteresis against terrain-model noise
  z.forEach((v) => { if (v == null) return; top = Math.max(top, v); if (v - ref >= 5) { up += v - ref; ref = v; } else if (ref - v >= 5) ref = v; });
  return { up: Math.round(up), top: Math.round(top), prof: s.map((_, i) => [+km[i].toFixed(2), z[i] == null ? null : Math.round(z[i])]) };
}

/* ---------------- 6. Turrutebasen's own named hiking routes of 5 km and more ---------------- */
const GRADE = { G: 'g', B: 'b', R: 'r', S: 's' };   // grønn, blå, rød, svart
const mode = (arr) => { const c = {}; arr.forEach((x) => { if (x) c[x] = (c[x] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || ''; };
// maintainers' labels are not names for walkers: anything with a digit, a campaign word or an organisation gets the
// route's two named ends instead ("Rondvassbu – Rondslottet"), or is dropped when the ends are nameless
const badName = (n) => !n || /\d/.test(n) || /ukjent|turer|turmål|trim|lysløyp|løype|runde\b|^tur\b|kommune|idrettslag|\bil\b|fjellstyre|turlag|\bdnt\b|turforslag|kart|prosjekt|stiftelse/i.test(n);
const ruter = [];
{
  const N = SUMMER, byNum = new Map();
  N.final.forEach((e, i) => e.r.forEach((num) => { if (!num) return; if (!byNum.has(num)) byNum.set(num, []); byNum.get(num).push(i); }));
  byNum.forEach((eis, num) => {
    const m = eis.reduce((a, i) => a + N.final[i].m, 0); if (m < 5000 || m > 45000) return;
    const deg = new Map(); eis.forEach((i) => { const e = N.final[i]; deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); });
    const ends = [...deg].filter(([, d]) => d === 1).map(([n]) => n); if ([...deg.values()].some((d) => d > 2)) return;
    const loop = ends.length === 0; if (!loop && ends.length !== 2) return;
    // walk the chain from one end (or from the node nearest a car park on a loop)
    const set = new Set(eis), start = loop ? (() => { let best = eis[0], bd = Infinity; eis.forEach((i) => N.kept.filter((k) => k.ty === 'parkering').forEach((k) => { const d = hav(N.pos(N.final[i].a), k.p); if (d < bd) { bd = d; best = i; } })); return N.final[best].a; })() : ends[0];
    const order = []; let at = start; const used = new Set();
    for (;;) { const nx = (N.adj.get(at) || []).find(([, , ei]) => set.has(ei) && !used.has(ei)); if (!nx) break; used.add(nx[2]); order.push([at, nx[2]]); at = nx[0]; }
    if (used.size !== eis.length) return;   // not one chain
    let acc = 0; const marks = [m / 3, 2 * m / 3], wp = []; let k = 0;
    order.forEach(([n, ei]) => { acc += N.final[ei].m; while (k < 2 && acc >= marks[k]) { const e = N.final[ei]; wp.push(e.a === n ? e.b : e.a); k++; } });
    const last = order[order.length - 1], endB = loop ? start : (N.final[last[1]].a === last[0] ? N.final[last[1]].b : N.final[last[1]].a);
    const pts = [start, ...wp, endB];
    const v = N.routeVia(pts); if (!v || Math.abs(v.m - m) / m > 0.03) return;   // the network must reproduce it
    let name = mode(eis.flatMap((i) => N.final[i].n.filter((x) => x && !/ukjent/i.test(x))));
    if (badName(name)) {
      const a = N.nameOf.get(start), b = N.nameOf.get(endB);
      if (loop ? !a : !(a && b)) return;
      name = loop ? `${a.n} rundt` : `${a.n} – ${b.n}`;
    }
    ruter.push({ n: name, num, g: GRADE[mode(eis.flatMap((i) => N.final[i].g))] || '', km: +(m / 1000).toFixed(1), loop, p: pts.map((n) => N.pos(n)) });
  });
  ruter.sort((a, b) => a.n.localeCompare(b.n, 'nb'));
}
log('named routes kept', ruter.length);

/* ---------------- 7. the classics ---------------- */
const classics = [];
for (const c of JSON.parse(fs.readFileSync(DIR + 'classics.json', 'utf8'))) {
  const N = SUMMER, pts = [c.a, ...(c.via || []), c.b].map((p) => N.nearestNode([p.lat ?? p[0], p.lon ?? p[1]], 400));
  if (pts.includes(-1)) { log('classic', c.id, 'off the network at point', pts.indexOf(-1)); continue; }
  const v = N.routeVia(pts); if (!v) { log('classic', c.id, 'no route'); continue; }
  const h = await heights(v.c);
  log('classic', c.id, (v.m / 1000).toFixed(1), 'km', h.up, 'm up, top', h.top, 'm');
  classics.push({ id: c.id, n: c.n, alias: c.alias || [], a: { n: c.a.n, node: pts[0] }, b: { n: c.b.n, node: pts[pts.length - 1] }, via: pts.slice(1, -1).map((n) => N.pos(n)),
    dir: c.dir || 'ab', why: c.why || '', blurb: c.blurb || '', wiki: c.wiki || '', grade: c.grade || '', km: +(v.m / 1000).toFixed(1), up: h.up, top: h.top, prof: h.prof, c: simplify(v.c, 8).map(([la, lo]) => [la, lo]) });
}

/* ---------------- 8. heights for every vertex of both networks (Kartverket's height API, cached across builds) ---------------- */
const Z = cached(CACHE + 'heights.json', () => ({}));   // "lat,lon" -> metres
{
  const want = new Set();
  [SUMMER, WINTER].forEach((N) => N.final.forEach((e) => e.c.forEach((p) => { const k = `${p[0]},${p[1]}`; if (Z[k] == null) want.add(k); })));
  const keys = [...want], chunks = []; for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));
  log('heights to fetch', keys.length, 'in', chunks.length, 'calls');
  let next = 0, done = 0, fails = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < chunks.length) {
    const ch = chunks[next++];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`https://ws.geonorge.no/hoydedata/v1/punkt?koordsys=4258&geojson=false&punkter=${encodeURIComponent(JSON.stringify(ch.map((k) => k.split(',').map(Number).reverse())))}`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        (await r.json()).punkter.forEach((p, i) => { if (p.z != null) Z[ch[i]] = Math.round(p.z); });
        break;
      } catch (e) { if (attempt === 2) fails++; await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); }
    }
    if (++done % 500 === 0) { log(' … heights', done, '/', chunks.length); fs.writeFileSync(CACHE + 'heights.json', JSON.stringify(Z)); }
  } }));
  fs.writeFileSync(CACHE + 'heights.json', JSON.stringify(Z));
  log('heights known', Object.keys(Z).length, 'failed calls', fails);
}

/* ---------------- 9. write ---------------- */
function writeTiles(N, dir) {
  const tiles = new Map(), tile = (k) => { if (!tiles.has(k)) tiles.set(k, { e: [], p: [] }); return tiles.get(k); };
  N.final.forEach((e) => tile(cellOf(e.c[0][0], e.c[0][1])).e.push([e.a, e.b, e.m, e.c.flat(), e.c.map((p) => Z[`${p[0]},${p[1]}`] ?? null)]));
  const names = [];
  N.kept.forEach((s) => { const n = N.nodeId.get(`${s.node[0]},${s.node[1]}`); if (n == null) return; const k = cellOf(s.node[0], s.node[1]); tile(k).p.push([n, s.n, s.ty, s.node[0], s.node[1]]); names.push([s.n, s.ty, s.node[0], s.node[1], n, k]); });
  for (const f of fs.readdirSync(OUT + dir)) fs.unlinkSync(OUT + dir + f);
  let bytes = 0;
  tiles.forEach((v, k) => { const s = JSON.stringify(v); bytes += s.length; fs.writeFileSync(`${OUT}${dir}${k}.json`, s); });
  log('wrote', dir, tiles.size, 'cells,', (bytes / 1e6).toFixed(1), 'MB');
  return { cells: [...tiles.keys()].sort(), names };
}
const S = writeTiles(SUMMER, 'g/'), W = writeTiles(WINTER, 's/');
// the search index: the summer points, and the winter-only ones (a ski hut with no trail in summer)
const names = S.names.slice(), ng = new Map();
names.forEach((x) => { const k = gkey(x[2], x[3]); if (!ng.has(k)) ng.set(k, []); ng.get(k).push(x); });
W.names.forEach((x) => { let dup = false; for (let a = -1; a <= 1 && !dup; a++) for (let b = -1; b <= 1 && !dup; b++) (ng.get(`${Math.floor(x[2] / GC) + a}_${Math.floor(x[3] / (GC * 2)) + b}`) || []).forEach((o) => { if (hav([o[2], o[3]], [x[2], x[3]]) < 60) dup = true; }); if (!dup) names.push(x); });
names.sort((a, b) => a[0].localeCompare(b[0], 'nb'));
fs.writeFileSync(OUT + 'names.json', JSON.stringify(names));
fs.writeFileSync(OUT + 'ruter.json', JSON.stringify(ruter));
fs.writeFileSync(OUT + 'classics.json', JSON.stringify(classics));
fs.writeFileSync(OUT + 'index.json', JSON.stringify({ v: new Date().toISOString().slice(0, 10), cells: S.cells, scells: W.cells, edges: SUMMER.final.length, nodes: SUMMER.nodes.length, sedges: WINTER.final.length, snodes: WINTER.nodes.length, names: names.length, ruter: ruter.length, classics: classics.length }));
log('names', names.length, '(winter-only', names.length - S.names.length + ');', ruter.length, 'routes;', classics.length, 'classics');
