// Kjørevær: sights along the route. Builds data/poi/ from open Norwegian data (all NLOD unless noted):
//   - top.json (hand-picked well-known sights, positions from Kartverket's place names; see geocode-top.mjs)   rank 3
//   - Riksantikvaren, protected buildings: the standing stave churches (rank 3), medieval churches (rank 2),
//     other protected churches (rank 1)
//   - NGU, geological heritage: sites NGU marks for tourism, and its geological viewpoints (rank 2)
//   - Statens vegvesen NVDB: the National Tourist Routes (object type 777) as simplified lines
// Run monthly on a developer machine (needs node 18+ and the duckdb CLI with the spatial extension):
//   node tools/poi/build.mjs
// The downloads are kept in tools/poi/cache/ (not in git, not deployed); the output is small static files:
//   data/poi/index.json   {v, cells: ["la2_lo", ...]}   which grid cells have a file
//   data/poi/<la2>_<lo>.json   [[id, cat, rank, sub, name, lat, lon, url], ...]   cells of 0.5° latitude × 1° longitude
//   data/poi/turistveg.json   [{n, url, l: [[[lat, lon], ...], ...]}]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIR = new URL('.', import.meta.url).pathname, ROOT = DIR + '../../', CACHE = DIR + 'cache/', OUT = ROOT + 'data/poi/';
fs.mkdirSync(CACHE, { recursive: true });
const MAX_AGE = 25 * 86400e3;
const fresh = (f) => fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < MAX_AGE;
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opt });
const duck = (sql) => JSON.parse(sh('duckdb', ['-json', '-c', 'LOAD spatial; SET geometry_always_xy = true; ' + sql]) || '[]');

async function download(url, file) {
  if (fresh(file)) return file;
  console.log('download', url);
  const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
async function geonorge(uuid, file) {   // Geonorge's download API: order the whole country (UTM 33, FGDB), then fetch it
  if (fresh(file)) return file;
  const r = await fetch('https://nedlasting.geonorge.no/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderLines: [{ metadataUuid: uuid, areas: [{ code: '0000', type: 'landsdekkende', name: 'Hele landet' }], projections: [{ code: '25833' }], formats: [{ name: 'FGDB' }] }] }) });
  const j = await r.json(); const f = (j.files || [])[0];
  if (!f || !f.downloadUrl) throw new Error('Geonorge order without a file: ' + uuid);
  return download(f.downloadUrl, file);
}
function unzip(zip, dir) { if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); sh('unzip', ['-q', '-o', zip, '-d', dir]); } return dir; }
const findExt = (dir, ext) => { for (const e of fs.readdirSync(dir, { recursive: true })) if (String(e).endsWith(ext)) return dir + e; throw new Error(`no ${ext} in ${dir}`); };

const items = [];
const add = (id, cat, rank, sub, name, la, lo, url) => items.push([id, cat, rank, sub, String(name).trim(), +(+la).toFixed(5), +(+lo).toFixed(5), url || '']);

// 1. the hand-picked list
const SUB = { Foss: 'foss', Isbre: 'bre', Fjell: 'fjell', Fjellside: 'fjell', Fjellområde: 'fjell', Juv: 'juv', Fjord: 'fjord', Dal: 'dal', Stein: 'stein', Havstrøm: 'vann', Vegstrekning: 'veg', Bru: 'bru', Banestrekning: 'veg', Kirke: 'kirke', Fyrstasjon: 'fyr' };
JSON.parse(fs.readFileSync(DIR + 'top.json', 'utf8')).forEach((t) => add('kv' + t.id, t.k, 3, SUB[t.t] || (t.k === 'natur' ? 'natur' : 'kultur'), t.n, t.la, t.lo, ''));

// 2. Riksantikvaren: protected buildings (churches)
const STAVE = ['Borgund', 'Eidsborg', 'Flesberg', 'Garmo', 'Gol', 'Grip', 'Hedalen', 'Heddal', 'Hegge', 'Holtålen', 'Hopperstad', 'Høre', 'Høyjord', 'Kaupanger',
  'Kvernes', 'Lom', 'Nore', 'Reinli', 'Ringebu', 'Rollag', 'Rødven', 'Røldal', 'Torpo', 'Undredal', 'Urnes', 'Uvdal', 'Øye'];   // the 27 standing stave churches (Garmo and Gol in museums)
{
  const gdb = findExt(unzip(await geonorge('a4bfd879-120f-490e-9907-68ba870664b1', CACHE + 'fredabygninger.zip'), CACHE + 'fredabygninger/'), '.gdb');
  const rows = duck(`SELECT navn, kulturminnedatering d, linkkulturminnesok url, ST_Y(p) la, ST_X(p) lo FROM (SELECT *, ST_Transform(ST_Centroid(SHAPE), 'EPSG:25833', 'EPSG:4326', true) p
    FROM ST_Read('${gdb}') WHERE kulturminneopprinneligfunksjon = '2700' AND navn IS NOT NULL)`);
  // one point per church: "Aurskog kirkested / Aurskog kirke 3" -> "Aurskog kirke"
  const clean = (n) => { let v = n.includes(' / ') ? n.split(' / ').pop() : n; v = v.split(/ - |, /).find((x) => /kirke|kyrkje|kyrkja|kapell|stav/i.test(x)) || v.split(' - ')[0]; return v.replace(/\s+\d+$/, '').trim(); };
  const seen = new Map();
  rows.forEach((r) => { const n = clean(r.navn); if (!/kirke|kyrkje|kyrkja|kapell/i.test(n) || /kirkested|kyrkjestad|kirkegård|gravkapell|støpul/i.test(n)) return; if (!seen.has(n)) seen.set(n, r); });
  // the standing stave churches: the protected-buildings register lacks the medieval ones, so they come from the heritage register's names below
  seen.forEach((r, n) => { const stave = /stav/i.test(n); if (stave) return; add('ra' + (r.url.match(/\d+$/) || [n])[0], 'kultur', r.d === '050' ? 2 : 1, 'kirke', n, r.la, r.lo, r.url); });
  console.log('churches:', seen.size);
}
{
  const gdb = findExt(unzip(await geonorge('c72906a0-2bc2-41d7-bea2-c92d368e3c49', CACHE + 'kulturminner.zip'), CACHE + 'kulturminner/'), '.gdb');
  const rows = duck(`SELECT navn, linkkulturminnesok url, ST_Y(p) la, ST_X(p) lo FROM (SELECT *, ST_Transform(ST_Centroid(SHAPE), 'EPSG:25833', 'EPSG:4326', true) p
    FROM ST_Read('${gdb}', layer = 'lokalitet') WHERE lokalitetskategori = 'L-KRK' AND synlig = 1 AND regexp_matches(navn, '(?i)stav(kirke|kyrkje)'))`);
  const got = new Set();
  rows.forEach((r) => {
    const s = STAVE.find((x) => new RegExp(`(^|[ /-])${x}( |$)`, 'i').test(r.navn.replace(/\s*\(.*?\)/g, '')) && !/stav(kirke|kyrkje)\s*\d/i.test(r.navn));
    if (!s || got.has(s)) return; got.add(s);
    const word = /kyrkje/i.test(r.navn) ? 'stavkyrkje' : 'stavkirke';
    add('ra' + (r.url.match(/\d+$/) || [s])[0], 'kultur', 3, 'stav', `${s} ${word}`, r.la, r.lo, r.url);
  });
  console.log('stave churches:', got.size, 'missing:', STAVE.filter((s) => !got.has(s)).join(', ') || '-');
}

// 3. NGU: geological heritage marked for tourism, and NGU's geological viewpoints
{
  const shp = findExt(unzip(await download('https://nedlasting.ngu.no/api/fileproxy/52a55a3c-bcd2-44d7-ac21-2f4550161937/23806bf0-0e5c-485b-a374-8c33fb00341e', CACHE + 'ngu.zip'), CACHE + 'ngu/'), 'GeologiskNaturarvPkt.shp');
  const rows = duck(`SELECT Geosted n, Typologi t, Fakta_url url, ST_Y(geom) la, ST_X(geom) lo FROM ST_Read('${shp}') WHERE Geosted IS NOT NULL AND (Potensbruk ILIKE '%Turisme%' OR Typologi = 'Utsiktspunkt')`);
  rows.forEach((r, i) => add('ngu' + ((r.url || '').match(/\d+/) || [i])[0], 'natur', 2, r.t === 'Utsiktspunkt' ? 'utsikt' : 'geo', r.n, r.la, r.lo, r.url));
  console.log('geosites:', rows.length);
}

// 4. NVDB: the National Tourist Routes, lines simplified to ~50 m
const simplify = (pts, tol) => {   // Douglas–Peucker in degrees, latitude-scaled
  if (pts.length < 3) return pts;
  const cs = Math.cos(pts[0][0] * Math.PI / 180), d2 = (p, a, b) => { const ax = a[1] * cs, ay = a[0], bx = b[1] * cs, by = b[0], px = p[1] * cs, py = p[0], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0; return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2; };
  let mx = 0, k = 0; for (let i = 1; i < pts.length - 1; i++) { const v = d2(pts[i], pts[0], pts[pts.length - 1]); if (v > mx) { mx = v; k = i; } }
  return mx > tol * tol ? simplify(pts.slice(0, k + 1), tol).slice(0, -1).concat(simplify(pts.slice(k), tol)) : [pts[0], pts[pts.length - 1]];
};
const routes = new Map();
{
  let url = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/777?inkluder=egenskaper,geometri&srid=4326&antall=1000';
  while (url) {
    const j = await (await fetch(url, { headers: { 'X-Client': 'glett', Accept: 'application/json' } })).json();
    (j.objekter || []).forEach((o) => {
      const p = (k) => (o.egenskaper.find((e) => e.navn === k) || {}).verdi;
      if (p('Status') !== 'Nasjonal turistveg') return;
      const n = p('Navn'), lines = String(o.geometri.wkt).replace(/^[A-Z ]+\(\(?/, '').replace(/\)\)?$/, '').split(/\)\s*,\s*\(/)
        .map((s) => s.replace(/[()]/g, '').split(',').map((q) => q.trim().split(/\s+/).slice(0, 2).map(Number)));
      if (!routes.has(n)) routes.set(n, { n, url: p('Lenke til turistveg') || '', l: [] });
      lines.forEach((l) => routes.get(n).l.push(simplify(l, 0.0005).map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)])));
    });
    url = j.metadata && j.metadata.returnert ? j.metadata.neste.href : null;
  }
  console.log('tourist routes:', routes.size);
}

// 5. one sight once: a lower-ranked point within 1 km of a better one with a similar name goes
const hav = (a, b) => { const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
const stem = (n) => n.toLowerCase().split(/[ -]/)[0].replace(/(fossen|foss|kirke|kyrkje|stavkirke|stavkyrkje)$/, '');
items.sort((a, b) => b[2] - a[2]);
const keep = [];
items.forEach((it) => { if (!keep.some((k) => k[2] >= it[2] && hav([k[5], k[6]], [it[5], it[6]]) < 1 && stem(k[4]) === stem(it[4]))) keep.push(it); });

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const cells = new Map();
keep.forEach((it) => { const c = `${Math.floor(it[5] * 2)}_${Math.floor(it[6])}`; if (!cells.has(c)) cells.set(c, []); cells.get(c).push(it); });
cells.forEach((v, c) => fs.writeFileSync(`${OUT}${c}.json`, JSON.stringify(v)));
fs.writeFileSync(OUT + 'turistveg.json', JSON.stringify([...routes.values()]));
const v = new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT + 'index.json', JSON.stringify({ v, cells: [...cells.keys()].sort() }));
const by = {}; keep.forEach((it) => { const k = `${it[1]} r${it[2]}`; by[k] = (by[k] || 0) + 1; });
console.log(`${keep.length} sights in ${cells.size} cells`, by, 'size:', sh('du', ['-sh', OUT]).split('\t')[0]);
