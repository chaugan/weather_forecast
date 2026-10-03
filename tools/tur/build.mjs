// Turvær: the marked trail network for hiking (summer) and the marked ski trails (winter). Builds data/tur/ from open
// Norwegian data (Kartverket, CC BY 4.0):
//   - Turrutebasen: the marked hiking trails (Fotrute with merking JA), the marked ski trails (Skiløype with merking JA
//     or SM), and the info points on them (car parks, tourist huts, open day huts, shelters, rest huts, viewpoints)
//   - Stedsnavn (the complete SSR): tourist huts and summits that lie on or next to a marked trail
//   - tools/tur/classics.json: hand-picked classic hikes, routed on the network here and checked against known figures
//   - OpenStreetMap (ODbL, the Geofabrik extract of Norway): the tracks (highway=track and the forest roads tagged unclassified),
//     a second-class network for summer. The router prefers the marked trails and takes a track where it opens a way
//     or another way; a route says how far it goes on tracks, and the map draws them dashed
// Run on a developer machine (node 18+, the duckdb CLI with the spatial extension, `npm install` in tools/tur for the
// GeoTIFF reader; the SSR file is 7 GB, scanned once; Kartverket's DTM 50 is 76 cells, ~130 MB, downloaded once):
//   cd tools/tur && npm install && cd ../.. && node tools/tur/build.mjs
// Downloads stay in tools/tur/cache/ (not in git, not deployed). The output is small static files:
//   data/tur/index.json          {v, cells: [...], scells: [...], ...counts}   which grid cells have a file (summer, winter)
//   data/tur/g/<la4>_<lo2>.json  {e: [[a, b, metres, [lat, lon, lat, lon, ...], [z, z, ...]], ...], p: [[node, name, type, lat, lon], ...]}
//                                z: the height of each vertex from Kartverket's terrain model (metres), so the browser
//                                draws the profile without asking a height service
//                                the hiking trails: cells of 0.25° latitude × 0.5° longitude; a, b are node ids shared
//                                across cells, an edge lies in the cell of its first point; p = the named points in the cell
//   data/tur/t/<la4>_<lo2>.json  the same for the tracks (summer; the node ids are shared with g/, so a track joins the
//                                trails at the nodes it meets; no named points of its own)
//   data/tur/s/<la4>_<lo2>.json  the same for the ski trails (node ids from 10 000 000)
//   data/tur/names.json          [[name, type, lat, lon, node, cell], ...]   the search index of named points (both networks)
//   data/tur/ruter.json          [{n, g, km, p: [[lat, lon], ...]}, ...]   Turrutebasen's own named hiking routes of 5 km and
//                                more, as their two ends and two waypoints (the browser routes through them on the network)
//   data/tur/classics.json       [{id, n, alias, a, b, via, dir, why, blurb, wiki, km, up, top, c: [[lat, lon], ...]}, ...]
import fs from 'node:fs';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const DIR = new URL('.', import.meta.url).pathname, ROOT = DIR + '../../', CACHE = DIR + 'cache/', OUT = ROOT + 'data/tur/';
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT + 'g/', { recursive: true }); fs.mkdirSync(OUT + 's/', { recursive: true }); fs.mkdirSync(OUT + 't/', { recursive: true });
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

/* ---------------- 1b. OpenStreetMap: the tracks (forest roads, tractor roads) of Norway ---------------- */
// highway=track, and the forest roads tagged unclassified or service (with a tracktype, closed to private motor traffic, or
// with a gravel-like surface: Norway's forest roads are tagged either way), open to walkers (no foot=no, no access=private);
// each way as its vertices, simplified to 5 m like the trails
const PBF = CACHE + 'norway-latest.osm.pbf';
const tracks = cached(CACHE + 'tracks.json', () => {
  if (!fresh(PBF)) { log('download', 'https://download.geofabrik.de/europe/norway-latest.osm.pbf'); sh('curl', ['-sL', '-o', PBF + '.part', 'https://download.geofabrik.de/europe/norway-latest.osm.pbf']); fs.renameSync(PBF + '.part', PBF); }
  log('reading tracks');
  duck(`CREATE TABLE w AS SELECT id, refs FROM ST_ReadOSM('${PBF}') WHERE kind = 'way'
      AND (tags['highway'] = 'track'
        OR (tags['highway'] IN ('unclassified', 'service') AND (tags['tracktype'] IS NOT NULL OR coalesce(tags['motor_vehicle'], '') IN ('private', 'no', 'forestry', 'agricultural')))
        OR (tags['highway'] = 'unclassified' AND coalesce(tags['surface'], '') IN ('gravel', 'compacted', 'unpaved', 'ground', 'dirt', 'fine_gravel', 'grass')))
      AND coalesce(tags['foot'], '') NOT IN ('no', 'private') AND coalesce(tags['access'], '') NOT IN ('private', 'no');
    CREATE TABLE x AS SELECT id, unnest(refs) AS ref, generate_subscripts(refs, 1) AS i FROM w;
    CREATE TABLE n AS SELECT id, lat, lon FROM ST_ReadOSM('${PBF}') WHERE kind = 'node' AND id IN (SELECT DISTINCT ref FROM x);
    COPY (SELECT x.id, list([round(n.lat, 5), round(n.lon, 5)] ORDER BY x.i) AS c FROM x JOIN n ON n.id = x.ref GROUP BY x.id) TO '${CACHE}tracks.raw.json' (FORMAT JSON, ARRAY true)`);
  return JSON.parse(fs.readFileSync(CACHE + 'tracks.raw.json', 'utf8')).map((w) => ({ c: simplify(w.c, 5), k: 2 })).filter((w) => w.c.length >= 2);
});
log('tracks', tracks.length, 'ways,', Math.round(tracks.reduce((a, w) => a + lineLen(w.c), 0) / 1000), 'km');

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
  let v = String(s || '').replace(/\s+/g, ' ').trim().replace(/\s+[-–]\s+(Beliggenhet|Registrert|Posisjon|Koordinat|Plassering|Hentet|Henta|Innmålt)\b.*$/i, '').replace(/[.,;:\s-]+$/, '');   // registration notes after a dash are not part of the name
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
  // k: 1 a marked trail, 2 a track (OpenStreetMap); a track costs TRACK_COST times its length when routing
  rawEdges.forEach((e) => (e.c ? [e.c] : parseGeom(e.geom)).forEach((c) => { if (c.length >= 2) N.edges.push({ c, g: e.g || [], n: e.n || [], r: e.r || [], k: e.k || 1 }); }));
  N.edges.forEach((e, i) => { const seen = new Set(); e.c.forEach((p) => { const k = gkey(p[0], p[1]); if (!seen.has(k)) { seen.add(k); if (!N.grid.has(k)) N.grid.set(k, []); N.grid.get(k).push(i); } }); });
  N.nearestSeg = (p, maxM, cls) => {   // the closest segment within maxM (of class cls when given): {e, s, t, d, p}
    const la = Math.floor(p[0] / GC), lo = Math.floor(p[1] / (GC * 2)), cand = new Set(); let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (N.grid.get(`${la + a}_${lo + b}`) || []).forEach((i) => cand.add(i));
    cand.forEach((i) => { if (cls && N.edges[i].k !== cls) return; const c = N.edges[i].c; for (let s = 0; s < c.length - 1; s++) { const q = projSeg(p, c[s], c[s + 1]); if (q.d <= maxM && (!best || q.d < best.d)) best = { e: i, s, ...q }; } });
    return best;
  };
  const snaps = [];
  named.forEach((x) => { const q = N.nearestSeg(x.p, REACH[x.ty], 1) || N.nearestSeg(x.p, REACH[x.ty], 2); if (q) snaps.push({ ...q, ty: x.ty, n: x.n }); });   // a marked trail first, then a track
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
  // close small gaps: trail ends within 25 m of another trail end become one node. Turrutebasen's trails often stop a
  // few metres short of the trail they join (2 859 of 14 277 dead ends lay within 30 m of another node), which cut
  // the network into islands; the end with most trails keeps its position
  {
    const ends = new Map();   // "lat,lon" -> {p, n: edges touching it}
    N.final.forEach((e) => [e.c[0], e.c[e.c.length - 1]].forEach((p) => { const k = `${p[0]},${p[1]}`; const v = ends.get(k) || { p, n: 0 }; v.n++; ends.set(k, v); }));
    const eg = new Map(); ends.forEach((v, k) => { const g = gkey(v.p[0], v.p[1]); if (!eg.has(g)) eg.set(g, []); eg.get(g).push(k); });
    const parent = new Map(); const find = (k) => { while (parent.has(k) && parent.get(k) !== k) k = parent.get(k); return k; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return; const A = ends.get(ra), B = ends.get(rb); if (A.n >= B.n) parent.set(rb, ra); else parent.set(ra, rb); };
    let joins = 0;
    ends.forEach((v, k) => {
      if (v.n !== 1) return;   // only a dead end reaches out
      const la = Math.floor(v.p[0] / GC), lo = Math.floor(v.p[1] / (GC * 2)); let best = null;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (eg.get(`${la + a}_${lo + b}`) || []).forEach((k2) => { if (k2 === k) return; const d = hav(v.p, ends.get(k2).p); if (d <= 25 && (!best || d < best[0])) best = [d, k2]; });
      if (best) { union(k, best[1]); joins++; }
    });
    N.final.forEach((e) => { [0, e.c.length - 1].forEach((i) => { const k = `${e.c[i][0]},${e.c[i][1]}`, r = find(k); if (r !== k) e.c[i] = ends.get(r).p; }); });
    N.final = N.final.filter((e) => lineLen(e.c) > 0.5);
    N.kept.forEach((q) => { if (!q.node) return; const k = `${q.node[0]},${q.node[1]}`, r = find(k); if (r !== k) q.node = ends.get(r).p; });   // a named point on a moved end moves with it
    log(label, 'gaps closed', joins);
  }
  // a dead end that stops beside another trail (within 40 m of its line, not of its end) is joined onto that line
  {
    const sg = new Map();   // grid cell -> [[edge index, segment index]]
    N.final.forEach((e, i) => { for (let k = 0; k < e.c.length - 1; k++) { const keys = new Set([gkey(e.c[k][0], e.c[k][1]), gkey(e.c[k + 1][0], e.c[k + 1][1])]); keys.forEach((g) => { if (!sg.has(g)) sg.set(g, []); sg.get(g).push([i, k]); }); } });
    const cnt = new Map(); N.final.forEach((e) => [e.c[0], e.c[e.c.length - 1]].forEach((p) => { const k = `${p[0]},${p[1]}`; cnt.set(k, (cnt.get(k) || 0) + 1); }));
    const cuts = new Map(), moved = new Map(); let snapped = 0;   // edge index -> [{s, t, p}]; old end -> new position
    N.final.forEach((e, i) => [0, e.c.length - 1].forEach((ei) => {
      const p = e.c[ei]; if (cnt.get(`${p[0]},${p[1]}`) !== 1) return;
      const la = Math.floor(p[0] / GC), lo = Math.floor(p[1] / (GC * 2)); let best = null;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (sg.get(`${la + a}_${lo + b}`) || []).forEach(([j, k]) => { if (j === i) return; const q = projSeg(p, N.final[j].c[k], N.final[j].c[k + 1]); if (q.d <= 40 && (!best || q.d < best.d)) best = { j, k, ...q }; });   // a vertex hit (t = 0 or 1) joins at that vertex
      if (!best) return;
      const P = [R5(best.p[0]), R5(best.p[1])]; moved.set(`${p[0]},${p[1]}`, P); e.c[ei] = P;   // the dead end moves onto the line
      if (!cuts.has(best.j)) cuts.set(best.j, []); cuts.get(best.j).push({ s: best.k, t: best.t, p: P }); snapped++;
    }));
    const out = [];
    N.final.forEach((e, i) => {
      const cs = (cuts.get(i) || []).sort((a, b) => a.s - b.s || a.t - b.t);
      if (!cs.length) { out.push(e); return; }
      let cur = [e.c[0]], s = 0;
      cs.forEach((q) => { for (; s < q.s; s++) cur.push(e.c[s + 1]); if (hav(cur[cur.length - 1], q.p) > 0.5) cur.push(q.p); if (cur.length >= 2 && lineLen(cur) > 0.5) out.push({ ...e, c: cur }); cur = [q.p]; });
      for (; s < e.c.length - 1; s++) if (hav(cur[cur.length - 1], e.c[s + 1]) > 0.5) cur.push(e.c[s + 1]);
      if (cur.length >= 2 && lineLen(cur) > 0.5) out.push({ ...e, c: cur });
    });
    N.final = out;
    N.kept.forEach((q) => { if (!q.node) return; const np = moved.get(`${q.node[0]},${q.node[1]}`); if (np) q.node = np; });   // a named point at a moved end moves with it
    log(label, 'dead ends joined onto a trail', snapped);
  }
  // a track crossing a marked trail without a shared vertex (the two sources are drawn apart) gets a junction at the
  // crossing, so the router can turn from the one onto the other
  if (N.final.some((e) => e.k === 2)) {
    const cellsOf = (p, q) => {   // the grid cells of a segment's bounding box
      const out = [], la0 = Math.floor(Math.min(p[0], q[0]) / GC), la1 = Math.floor(Math.max(p[0], q[0]) / GC), lo0 = Math.floor(Math.min(p[1], q[1]) / (GC * 2)), lo1 = Math.floor(Math.max(p[1], q[1]) / (GC * 2));
      for (let a = la0; a <= la1; a++) for (let b = lo0; b <= lo1; b++) out.push(`${a}_${b}`);
      return out;
    };
    const sg = new Map();   // grid cell -> [[edge index, segment index]] of the marked trails
    N.final.forEach((e, i) => { if (e.k === 2) return; for (let k = 0; k < e.c.length - 1; k++) cellsOf(e.c[k], e.c[k + 1]).forEach((g) => { if (!sg.has(g)) sg.set(g, []); sg.get(g).push([i, k]); }); });
    const cross = (p, q, a, b) => {   // where the segments p-q and a-b cross, in a flat metric around p: {t, u, p} or null
      const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540, X = (v) => [(v[1] - p[1]) * kx, (v[0] - p[0]) * ky];
      const [x2, y2] = X(q), [x3, y3] = X(a), [x4, y4] = X(b);
      const den = -x2 * (y3 - y4) + y2 * (x3 - x4); if (Math.abs(den) < 1e-9) return null;
      const t = (-x3 * (y3 - y4) + y3 * (x3 - x4)) / den, u = (x2 * y3 - y2 * x3) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) return null;
      return { t, u, p: [R5(p[0] + t * (q[0] - p[0])), R5(p[1] + t * (q[1] - p[1]))] };
    };
    const cuts = new Map(), cut = (i, s, t, p) => { if (!cuts.has(i)) cuts.set(i, []); cuts.get(i).push({ s, t, p }); }; let x = 0;
    N.final.forEach((e, i) => { if (e.k !== 2) return; for (let s = 0; s < e.c.length - 1; s++) {
      const p = e.c[s], q = e.c[s + 1], seen = new Set();
      cellsOf(p, q).forEach((g) => (sg.get(g) || []).forEach(([j, k]) => { const key = j + '_' + k; if (seen.has(key)) return; seen.add(key); const r = cross(p, q, N.final[j].c[k], N.final[j].c[k + 1]); if (!r) return; cut(i, s, r.t, r.p); cut(j, k, r.u, r.p); x++; }));
    } });
    const out = [];
    N.final.forEach((e, i) => {
      const cs = (cuts.get(i) || []).sort((a, b) => a.s - b.s || a.t - b.t);
      if (!cs.length) { out.push(e); return; }
      let cur = [e.c[0]], s = 0;
      cs.forEach((q) => { for (; s < q.s; s++) cur.push(e.c[s + 1]); if (hav(cur[cur.length - 1], q.p) > 0.5) cur.push(q.p); if (cur.length >= 2 && lineLen(cur) > 0.5) out.push({ ...e, c: cur }); cur = [q.p]; });
      for (; s < e.c.length - 1; s++) if (hav(cur[cur.length - 1], e.c[s + 1]) > 0.5) cur.push(e.c[s + 1]);
      if (cur.length >= 2 && lineLen(cur) > 0.5) out.push({ ...e, c: cur });
    });
    N.final = out;
    log(label, 'tracks crossing a trail joined', x);
  }
  const nid = (p) => { const k = `${p[0]},${p[1]}`; if (!N.nodeId.has(k)) { N.nodeId.set(k, idBase + N.nodes.length); N.nodes.push(p); } return N.nodeId.get(k); };
  N.pos = (id) => N.nodes[id - idBase];
  N.final.forEach((e) => { e.a = nid(e.c[0]); e.b = nid(e.c[e.c.length - 1]); e.m = Math.round(lineLen(e.c)); });
  N.adj = new Map(); N.final.forEach((e, i) => { if (!N.adj.has(e.a)) N.adj.set(e.a, []); if (!N.adj.has(e.b)) N.adj.set(e.b, []); N.adj.get(e.a).push([e.b, e.m, i]); N.adj.get(e.b).push([e.a, e.m, i]); });
  N.nameOf = new Map(); N.kept.forEach((s) => { const id = N.nodeId.get(`${s.node[0]},${s.node[1]}`); if (id != null) N.nameOf.set(id, s); });
  log(label, 'edges', N.final.length, '(tracks', N.final.filter((e) => e.k === 2).length + ')', 'nodes', N.nodes.length, 'named points on it', N.kept.length);
  // Dijkstra with a binary heap -> {m, path: [edge index...], nodes: [node...]} or null; m is the real length, a track
  // costs TRACK_COST times its length on the way (and is left out with marked = true)
  N.dijkstra = (from, to, marked) => {
    const dist = new Map([[from, 0]]), prev = new Map(), pe = new Map(), heap = [[0, from]];
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop(); if (u === to) break; if (d > dist.get(u)) continue;
      for (const [v, w, ei] of N.adj.get(u) || []) { const k = N.final[ei].k; if (marked && k === 2) continue; const nd = d + (k === 2 ? w * TRACK_COST : w); if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); pe.set(v, ei); push([nd, v]); } }
    }
    if (!dist.has(to)) return null;
    const path = [], ns = [to]; let m = 0; for (let v = to; v !== from; v = prev.get(v)) { path.push(pe.get(v)); m += N.final[pe.get(v)].m; ns.push(prev.get(v)); }
    return { m, path: path.reverse(), nodes: ns.reverse() };
  };
  N.geometry = (route) => {   // the edges of a Dijkstra answer joined in walking order
    const out = []; let at = route.nodes[0];
    route.path.forEach((ei) => { const e = N.final[ei], c = e.a === at ? e.c : [...e.c].reverse(); out.push(...(out.length ? c.slice(1) : c)); at = e.a === at ? e.b : e.a; });
    return out;
  };
  N.routeVia = (points, marked) => {   // points: node ids
    let m = 0; const c = [];
    for (let i = 1; i < points.length; i++) { const r = N.dijkstra(points[i - 1], points[i], marked); if (!r) return null; m += r.m; const g = N.geometry(r); c.push(...(c.length ? g.slice(1) : g)); }
    return { m, c };
  };
  const ngrid = new Map(), onMarked = new Set(); N.nodes.forEach((q, i) => { const k = gkey(q[0], q[1]); if (!ngrid.has(k)) ngrid.set(k, []); ngrid.get(k).push(idBase + i); });
  N.final.forEach((e) => { if (e.k !== 2) { onMarked.add(e.a); onMarked.add(e.b); } });
  N.nearestNode = (p, maxM = 300, cls) => {   // the nearest node of the network within maxM (the split points and trail ends; any trail is split at its named points); cls = 1: on a marked trail
    const la = Math.floor(p[0] / GC), lo = Math.floor(p[1] / (GC * 2)); let best = -1, bd = maxM;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) (ngrid.get(`${la + a}_${lo + b}`) || []).forEach((n) => { if (cls === 1 && !onMarked.has(n)) return; const d = hav(N.pos(n), p); if (d <= bd) { bd = d; best = n; } });
    return best;
  };
  return N;
}
const TRACK_COST = 1.3;   // the browser uses the same factor (js/turvaer.js): a road is taken when it saves over 23 % of the way
const SUMMER = network([...raw, ...tracks], 0, 'hiking trails and tracks'), WINTER = network(rawSki, 10000000, 'ski trails');

/* ---------------- 5. a profile from the sampled vertex heights (for the classics) ---------------- */
function heights(c) {   // every ~50 m along c, heights interpolated between the vertices -> {up, top, prof: [[km, z]...]}
  const zAt = (p) => Z[`${p[0]},${p[1]}`] ?? null, s = [], km = []; let tot = 0;
  for (let i = 0; i < c.length; i++) {
    if (i) tot += hav(c[i - 1], c[i]);
    if (!i || tot - (km[km.length - 1] || 0) * 1000 >= 50 || i === c.length - 1) { s.push(c[i]); km.push(tot / 1000); }
  }
  const z = s.map(zAt);
  let up = 0, ref = z.find((v) => v != null) ?? 0, top = -1e9;   // 5 m hysteresis against terrain-model noise
  z.forEach((v) => { if (v == null) return; top = Math.max(top, v); if (v - ref >= 5) { up += v - ref; ref = v; } else if (ref - v >= 5) ref = v; });
  return { up: Math.round(up), top: Math.round(top), prof: s.map((_, i) => [+km[i].toFixed(2), z[i]]) };
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
    const v = N.routeVia(pts, true); if (!v || Math.abs(v.m - m) / m > 0.03) return;   // the marked network must reproduce it
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

/* ---------------- 7. heights for every vertex of both networks: Kartverket's DTM 50 (76 GeoTIFF cells, cached) ---------------- */
// WGS84 -> UTM zone 33 (the DTM's EPSG:25833); the GRS80 / WGS84 difference is far below the 50 m cell
function utm33(lat, lon) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, lon0 = 15 * Math.PI / 180, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - lon0, N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * lam;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi) + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120), k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720))];
}
const Z = cached(CACHE + 'heights.json', () => ({}));   // "lat,lon" -> metres (kept across builds; a vertex is only sampled once)
{
  const { fromFile } = await import('geotiff');
  const DTM = 'e25d0104-0858-4d06-bba8-d154514c11d2', dir = CACHE + 'dtm50/';
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir + '.complete')) {   // all 76 cells of the country, one zip each (~130 MB in all)
    const areas = await (await fetch(`https://nedlasting.geonorge.no/api/codelists/area/${DTM}`)).json();
    const r = await fetch('https://nedlasting.geonorge.no/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderLines: [{ metadataUuid: DTM, areas: areas.map((x) => ({ code: x.code, type: x.type, name: x.name })), projections: [{ code: '25833' }], formats: [{ name: 'TIFF' }] }] }) });
    for (const f of (await r.json()).files || []) { if (!fs.existsSync(dir + f.name)) await download(f.downloadUrl, dir + f.name); }
    fs.writeFileSync(dir + '.complete', new Date().toISOString());
  }
  for (const z of fs.readdirSync(dir).filter((f) => f.endsWith('.zip'))) unzip(dir + z, dir + z.replace(/\.zip$/, '') + '/');
  const tifs = [];
  for (const e of fs.readdirSync(dir, { recursive: true })) if (String(e).endsWith('.tif')) tifs.push(dir + e);
  // which vertices still need a height, and which cell each lies in (by the cells' bounds)
  const want = new Map();
  [SUMMER, WINTER].forEach((N) => N.final.forEach((e) => e.c.forEach((p) => { const k = `${p[0]},${p[1]}`; if (Z[k] == null && !want.has(k)) want.set(k, utm33(p[0], p[1])); })));
  log('heights to sample', want.size, 'from', tifs.length, 'cells');
  let sampled = 0;
  for (const f of tifs) {
    if (!want.size) break;
    const tif = await fromFile(f), img = await tif.getImage(), bb = img.getBoundingBox(), w = img.getWidth(), h = img.getHeight(), nd = img.getGDALNoData();
    const mine = [...want].filter(([, [x, y]]) => x >= bb[0] && x < bb[2] && y > bb[1] && y <= bb[3]);
    if (!mine.length) continue;
    const ras = (await img.readRasters())[0];
    mine.forEach(([k, [x, y]]) => { const px = Math.floor((x - bb[0]) / 50), py = Math.floor((bb[3] - y) / 50); if (px < 0 || py < 0 || px >= w || py >= h) return; const v = ras[py * w + px]; if (v != null && v !== nd && Number.isFinite(v)) { Z[k] = Math.round(v); sampled++; } want.delete(k); });
  }
  fs.writeFileSync(CACHE + 'heights.json', JSON.stringify(Z));
  log('heights sampled', sampled, 'known', Object.keys(Z).length, 'without a height (sea, abroad, gaps)', want.size);
}

/* ---------------- 8. the classics ---------------- */
const classics = [];
for (const c of JSON.parse(fs.readFileSync(DIR + 'classics.json', 'utf8'))) {
  const N = SUMMER, pts = [c.a, ...(c.via || []), c.b].map((p) => N.nearestNode([p.lat ?? p[0], p.lon ?? p[1]], 400, 1));
  if (pts.includes(-1)) { log('classic', c.id, 'off the network at point', pts.indexOf(-1)); continue; }
  const v = N.routeVia(pts, true); if (!v) { log('classic', c.id, 'no route'); continue; }
  const h = heights(v.c);
  log('classic', c.id, (v.m / 1000).toFixed(1), 'km', h.up, 'm up, top', h.top, 'm');
  classics.push({ id: c.id, n: c.n, alias: c.alias || [], a: { n: c.a.n, node: pts[0] }, b: { n: c.b.n, node: pts[pts.length - 1] }, via: pts.slice(1, -1).map((n) => N.pos(n)),
    dir: c.dir || 'ab', why: c.why || '', blurb: c.blurb || '', wiki: c.wiki || '', grade: c.grade || '', km: +(v.m / 1000).toFixed(1), up: h.up, top: h.top, prof: h.prof, c: simplify(v.c, 8).map(([la, lo]) => [la, lo]) });
}

/* ---------------- 9. write ---------------- */
function writeTiles(N, dir, cls) {   // cls: which edges (1 the marked trails with the named points, 2 the tracks; all when not given)
  const tiles = new Map(), tile = (k) => { if (!tiles.has(k)) tiles.set(k, { e: [], p: [] }); return tiles.get(k); };
  N.final.forEach((e) => { if (cls && e.k !== cls) return; tile(cellOf(e.c[0][0], e.c[0][1])).e.push([e.a, e.b, e.m, e.c.flat(), e.c.map((p) => Z[`${p[0]},${p[1]}`] ?? null)]); });
  const names = [];
  if (cls !== 2) N.kept.forEach((s) => { const n = N.nodeId.get(`${s.node[0]},${s.node[1]}`); if (n == null) return; const k = cellOf(s.node[0], s.node[1]); tile(k).p.push([n, s.n, s.ty, s.node[0], s.node[1]]); names.push([s.n, s.ty, s.node[0], s.node[1], n, k]); });
  for (const f of fs.readdirSync(OUT + dir)) fs.unlinkSync(OUT + dir + f);
  let bytes = 0;
  tiles.forEach((v, k) => { const s = JSON.stringify(v); bytes += s.length; fs.writeFileSync(`${OUT}${dir}${k}.json`, s); });
  log('wrote', dir, tiles.size, 'cells,', (bytes / 1e6).toFixed(1), 'MB');
  return { cells: [...tiles.keys()].sort(), names };
}
const S = writeTiles(SUMMER, 'g/', 1), T = writeTiles(SUMMER, 't/', 2), W = writeTiles(WINTER, 's/');
// the search index: the summer points, and the winter-only ones (a ski hut with no trail in summer)
const names = S.names.slice(), ng = new Map();
names.forEach((x) => { const k = gkey(x[2], x[3]); if (!ng.has(k)) ng.set(k, []); ng.get(k).push(x); });
W.names.forEach((x) => { let dup = false; for (let a = -1; a <= 1 && !dup; a++) for (let b = -1; b <= 1 && !dup; b++) (ng.get(`${Math.floor(x[2] / GC) + a}_${Math.floor(x[3] / (GC * 2)) + b}`) || []).forEach((o) => { if (hav([o[2], o[3]], [x[2], x[3]]) < 60) dup = true; }); if (!dup) names.push(x); });
names.sort((a, b) => a[0].localeCompare(b[0], 'nb'));
fs.writeFileSync(OUT + 'names.json', JSON.stringify(names));
fs.writeFileSync(OUT + 'ruter.json', JSON.stringify(ruter));
fs.writeFileSync(OUT + 'classics.json', JSON.stringify(classics));
fs.writeFileSync(OUT + 'index.json', JSON.stringify({ v: new Date().toISOString().slice(0, 10), cells: S.cells, tcells: T.cells, scells: W.cells, edges: SUMMER.final.filter((e) => e.k !== 2).length, tedges: SUMMER.final.filter((e) => e.k === 2).length, nodes: SUMMER.nodes.length, sedges: WINTER.final.length, snodes: WINTER.nodes.length, names: names.length, ruter: ruter.length, classics: classics.length }));
log('names', names.length, '(winter-only', names.length - S.names.length + ');', ruter.length, 'routes;', classics.length, 'classics');
