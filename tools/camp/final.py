# Nattplass build, stage 2: the final spots, the way in from the public road network, and the static tiles.
#   python3 tools/camp/final.py norway     (after graph.py, build.py, padrun.py)
# Output (served by the site): data/natt/<cc>/<la2>_<lo>.json per cell of 0.5° latitude × 1° longitude:
#   {s: [spot, ...], b: [barrier, ...]}   see FIELDS below; and data/natt/index.json {v, cells: {cc: [...]}, n: {...}}
import sys, os, json, math, subprocess, csv
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import score, nz
import pyarrow.parquet as pq

C = sys.argv[1]; CC = {'norway': 'no', 'sweden': 'se', 'finland': 'fi'}[C]
HERE = os.path.dirname(os.path.abspath(__file__)); D = HERE + '/cache'; OUT = os.path.join(HERE, '../../data/natt')
# the score a spot needs, per country: about 10-17 spots per 100 km² (Sweden and Finland have no terrain check, so more pass)
MIN_SCORE = float(os.environ.get('NATT_MIN') or {'norway': 45, 'sweden': 55, 'finland': 50}[C])
RANK = {0: 'pass', 1: 'toll', 2: 'unknown', 3: 'closed'}

# ---- candidates + pad
Z = np.load(f'{D}/{C}/cand.npz', allow_pickle=True)
ids = Z['all_id'][Z['idx']]
T = pq.read_table(f'{D}/{C}/feat.parquet'); F0 = {k: T.column(k).to_numpy(zero_copy_only=False) for k in T.column_names}
pos = {k: i for i, k in enumerate(F0['id'].astype(str))}
sel = np.array([pos[i] for i in ids]); F = {k: v[sel] for k, v in F0.items()}; del F0, T
padd = {}
id2pk = {i: f'{la:.5f},{lo:.5f}' for i, la, lo in zip(ids, Z['lat'], Z['lon'])}   # older runs kept candidate ids
if os.path.exists(f'{D}/{C}/pad.jsonl'):
    for l in open(f'{D}/{C}/pad.jsonl'):
        r = json.loads(l); k = r['id'] if ',' in r['id'] else id2pk.get(r['id'])
        if k and ('err' not in r or k not in padd): padd[k] = r   # a later good measurement wins over a failed one
road = F['src'].astype(str) == 'road'
pk = [f'{la:.5f},{lo:.5f}' for la, lo in zip(Z['lat'], Z['lon'])]   # pad.jsonl is keyed by position
pad = np.array([padd.get(k, {}).get('pad', np.nan) if r else np.nan for k, r in zip(pk, road)], float)
pad = np.where(pad is None, np.nan, pad)
# outline.py measures the final spots again with the outline (and later without water): its latest record per spot wins
OLF = f'{D}/{C}/outline.jsonl'
olrec = {}
if os.path.exists(OLF):
    for l in open(OLF):
        r = json.loads(l)
        if 'err' not in r and r.get('pad') is not None: olrec[r['id']] = r
pad = np.array([olrec[k]['pad'] if r and k in olrec and olrec[k].get('w') else p for k, r, p in zip(pk, road, pad)], float)
olr = {k: r['ol'] for k, r in olrec.items() if r.get('ol') and r['pad'] >= 40}
s, dw, wk = score(F, pad if padd else None)
st = Z['st']
s = s - np.select([st == 1, st >= 2], [4, 1000], 0)
keep = s >= MIN_SCORE
keep &= ~(road & (pad < 40))                          # a road point needs room to stop where that was measured; unmeasured stays
# a bog or a lake is open, flat and level too: the measured area minus OpenStreetMap's wetland and water (lakes, rivers, reservoirs
# as areas; the sea by the coastline, land on its left) must still be 40 m² (outline.py), and a road point without an outline
# yet goes when wetland or water covers most of the ground within 30 m
CRS = {'norway': 'EPSG:25833', 'finland': 'EPSG:3067', 'sweden': 'EPSG:3006'}[C]
kk = np.where(keep)[0]
with open(f'{D}/{C}/final_wet_in.csv', 'w') as fh:
    fh.write('i\tlat\tlon\tw\n')
    for i in kk: fh.write(f"{i}\t{F['lat'][i]}\t{F['lon'][i]}\t{olr.get(f'{float(F['lat'][i]):.5f},{float(F['lon'][i]):.5f}', '')}\n")
wsql = f"""LOAD spatial;
CREATE OR REPLACE TEMP TABLE c AS SELECT i, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:3035', always_xy := true) p,
  CASE WHEN w IS NOT NULL AND w <> '' THEN ST_Transform(ST_GeomFromText(w), '{CRS}', 'EPSG:3035', always_xy := true) END ol
  FROM read_csv('{D}/{C}/final_wet_in.csv', delim = '\t', header = true, quote = '', columns = {{'i': 'BIGINT', 'lat': 'DOUBLE', 'lon': 'DOUBLE', 'w': 'VARCHAR'}});
CREATE OR REPLACE TEMP TABLE wet AS SELECT i, ST_Union_Agg(g) g FROM (
  SELECT c.i, x.g FROM c JOIN cover x ON x.k = 'wetland' AND ST_Intersects(x.g, ST_Buffer(c.p, 60))
  UNION ALL SELECT c.i, x.g FROM c JOIN wpoly x ON ST_Intersects(x.g, ST_Buffer(c.p, 60))) GROUP BY i;
CREATE OR REPLACE TEMP TABLE coast AS SELECT c.i, ST_Union_Agg(ST_Intersection(x.g, ST_Buffer(c.p, 80))) g
  FROM c JOIN water x ON x.k = 'coast' AND c.ol IS NOT NULL AND ST_Intersects(x.g, c.ol) GROUP BY c.i;
COPY (SELECT c.i, c.ol IS NOT NULL AS hasol,
  CASE WHEN c.ol IS NOT NULL THEN ST_AsText(CASE WHEN w.g IS NULL THEN c.ol ELSE ST_Difference(c.ol, w.g) END) END AS dryw,
  coalesce(ST_Area(ST_Intersection(ST_Buffer(c.p, 30), w.g)) / ST_Area(ST_Buffer(c.p, 30)), 0) AS wshare, ST_AsText(k.g) AS coast
  FROM c LEFT JOIN wet w USING (i) LEFT JOIN coast k USING (i) WHERE w.i IS NOT NULL OR k.i IS NOT NULL) TO '{D}/{C}/final_wet.csv' (HEADER);"""
subprocess.run(['duckdb', f'{D}/{C}.duckdb'], input=wsql, text=True, check=True)
from shapely import wkt as _wkt
from shapely.ops import split as _split, unary_union as _union
from shapely.geometry import LineString
def landside(poly, lines):
    # the pieces of the outline on the land side of the coastline (OpenStreetMap draws the coastline with land on the left)
    segs = [(a, b) for ln in getattr(lines, 'geoms', [lines]) if ln.geom_type == 'LineString' for a, b in zip(ln.coords, ln.coords[1:])]
    if not segs: return poly
    keep_ = []
    for g in getattr(poly, 'geoms', [poly]):
        for piece in _split(g, lines).geoms:
            if piece.area < 1: continue
            q = piece.representative_point()
            a, b = min(segs, key=lambda ab: LineString(ab).distance(q))
            if (b[0] - a[0]) * (q.y - a[1]) - (b[1] - a[1]) * (q.x - a[0]) > 0: keep_.append(piece)
    return _union(keep_) if keep_ else None
wet_ol = {}; nwet = 0
for r in csv.DictReader(open(f'{D}/{C}/final_wet.csv')):
    i = int(r['i'])
    if r['hasol'] == 'true':
        g = _wkt.loads(r['dryw']) if r['dryw'] else None
        if g is not None and r['coast']:
            g = landside(g, _wkt.loads(r['coast']))
        g = max(getattr(g, 'geoms', [g]), key=lambda x: x.area) if g is not None and not g.is_empty else None
        if g is None or g.area < 40: keep[i] = False; nwet += 1
        else: wet_ol[i] = g.wkt; pad[i] = min(pad[i], g.area) if np.isfinite(pad[i]) else pad[i]
    elif road[i] and float(r['wshare'] or 0) > 0.5: keep[i] = False; nwet += 1
# the dry outlines back to lat/lon
with open(f'{D}/{C}/final_dry.tsv', 'w') as fh:
    fh.write('i\tw\n')
    for i, w in wet_ol.items(): fh.write(f'{i}\t{w}\n')
subprocess.run(['duckdb', f'{D}/{C}.duckdb'], text=True, check=True, input=f"""LOAD spatial; COPY (SELECT i, ST_AsText(ST_Transform(ST_GeomFromText(w),
  'EPSG:3035', 'EPSG:4326', always_xy := true)) w FROM read_csv('{D}/{C}/final_dry.tsv', delim = '\t', header = true, quote = '',
  columns = {{'i': 'BIGINT', 'w': 'VARCHAR'}})) TO '{D}/{C}/final_dry4326.csv' (HEADER);""")
wet_ol = {int(r['i']): r['w'] for r in csv.DictReader(open(f'{D}/{C}/final_dry4326.csv'))}
print(C, 'wetland/water drops', nwet, 'clipped', len(wet_ol), file=sys.stderr)
print(C, 'final', keep.sum(), 'of', len(s), file=sys.stderr)
fin = {int(i): j for j, i in enumerate(np.where(keep)[0])}; wet_ol = {fin[i]: w for i, w in wet_ol.items() if i in fin}
F = {k: v[keep] for k, v in F.items()}; s, dw, wk, st, pad, road, ids = s[keep], dw[keep], wk[keep], st[keep], pad[keep], road[keep], ids[keep]
lat, lon = F['lat'].astype(float), F['lon'].astype(float)
zz = np.array([padd.get(k, {}).get('z', np.nan) for k, kp in zip(pk, keep) if kp], float)

# ---- the way in: shortest path from any public road over roads without a closed (or, second pass, unknown) barrier
G = np.load(f'{D}/{C}/graph.npz')
glat, glon, ea, eb = G['lat'], G['lon'], G['ea'].astype(np.int64), G['eb'].astype(np.int64)
vb, ecut, ecls, epub = G['vb'], G['ecut'], G['ecls'], G['epub']
N = len(glat)
c0 = np.cos(np.radians((glat[ea] + glat[eb]) / 2))
elen = np.hypot((glon[ea] - glon[eb]) * 111320 * c0, (glat[ea] - glat[eb]) * 110540) + 0.01
seed = np.zeros(N, bool); seed[ea[epub == 1]] = True; seed[eb[epub == 1]] = True
src_idx = np.where(seed)[0]
def run(max_rank):
    ok = (ecls == 0) & (np.maximum(vb[ea], vb[eb]) < max_rank) & (ecut < max_rank) & (epub == 0)   # public roads: the router's job
    A = csr_matrix((np.r_[elen[ok], elen[ok]], (np.r_[ea[ok], eb[ok]], np.r_[eb[ok], ea[ok]])), shape=(N, N))
    d, pred, srcs = dijkstra(A, directed=True, indices=src_idx, min_only=True, return_predecessors=True, limit=60000)
    return d, pred
paths = {}
cm = math.cos(math.radians(np.mean(lat)))
gtree = cKDTree(np.c_[glon * 111320 * cm, glat * 110540])
cand_v = gtree.query(np.c_[lon * 111320 * cm, lat * 110540], k=6, distance_upper_bound=120)[1]
bars = json.load(open(f'{D}/{C}/road_barriers.json'))
bv = {}; be = {}
for i, b in enumerate(bars):
    if b.get('v') is not None: bv[b['v']] = i
    if b.get('e') is not None: be[(int(ea[b['e']]), int(eb[b['e']]))] = i; be[(int(eb[b['e']]), int(ea[b['e']]))] = i
used_bars = set()
for rank, which in ((2, st == 0), (3, st == 1)):
    if not which.any(): continue
    d, pred = run(rank)
    for k in np.where(which)[0]:
        v = next((int(v) for v in cand_v[k] if v < N and np.isfinite(d[v])), None)
        if v is None: continue
        chain = [v]
        while pred[chain[-1]] >= 0 and len(chain) < 20000: chain.append(int(pred[chain[-1]]))
        hb = []
        for a, b in zip(chain[:-1], chain[1:]):
            for x in (bv.get(a), be.get((a, b))):
                if x is not None and bars[x]['c'] in ('pass', 'toll', 'unknown'): hb.append(x)
        hb = list(dict.fromkeys(hb)); used_bars.update(hb)
        paths[k] = (chain[::-1], float(d[v]), hb)    # from the hand-off on the public road to the spot
print('paths', len(paths), file=sys.stderr)

def enc(coords):   # Google polyline, 5 decimals, [lat, lon]
    out = []; pl = plo = 0
    for la, lo in coords:
        a, b = int(round(la * 1e5)), int(round(lo * 1e5))
        for v in (a - pl, b - plo):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20: out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        pl, plo = a, b
    return ''.join(out)
from shapely.geometry import LineString

# ---- names: the water and the nearest place (DuckDB)
with open(f'{D}/{C}/final.csv', 'w') as fh:
    fh.write('k,lat,lon\n')
    for k in range(len(lat)): fh.write(f'{k},{lat[k]},{lon[k]}\n')
sql = f"""LOAD spatial;
CREATE OR REPLACE TEMP TABLE q AS SELECT k, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:3035', always_xy := true) g FROM read_csv('{D}/{C}/final.csv');
COPY (SELECT q.k, arg_min(w.name, ST_Distance(q.g, w.g)) wname FROM q JOIN water w ON ST_DWithin(q.g, w.g, 300) AND w.name IS NOT NULL GROUP BY q.k) TO '{D}/{C}/final_w.csv' (HEADER);
COPY (SELECT q.k, arg_min(x.name, ST_Distance(q.g, x.g)) pname, round(min(ST_Distance(q.g, x.g))) pd FROM q JOIN places x ON ST_DWithin(q.g, x.g, 15000) AND x.name IS NOT NULL AND x.k IN ('city','town','village','hamlet') GROUP BY q.k) TO '{D}/{C}/final_p.csv' (HEADER);"""
# toilets within 300 m (OpenStreetMap), for a stop by day
sql += f"""
COPY (SELECT q.k, round(min(ST_Distance(q.g, x.g))) d FROM q JOIN pois x ON x.k = 'toilets' AND ST_DWithin(q.g, x.g, 300) GROUP BY q.k) TO '{D}/{C}/final_wc.csv' (HEADER);"""
# the services for the night (load.sql: svc): food shops, fuel, chargers (fast: a DC socket), with lat/lon for the road graph below
sql += f"""
COPY (SELECT x.k, x.fast, coalesce(x.name, '@' || (SELECT arg_min(p.name, ST_Distance(p.g, x.g)) FROM places p WHERE ST_DWithin(p.g, x.g, 8000) AND p.name IS NOT NULL), '') AS nm,
  ST_Y(ST_Transform(x.g, 'EPSG:3035', 'EPSG:4326', always_xy := true)) lat, ST_X(ST_Transform(x.g, 'EPSG:3035', 'EPSG:4326', always_xy := true)) lon FROM svc x) TO '{D}/{C}/final_svcpts.csv' (HEADER);"""   # no name: '@' + the nearest place
# the outline of the open area at each spot (outline.py, in the country's CRS) as lat/lon
olk = {f'{lat[k]:.5f},{lon[k]:.5f}': k for k in range(len(lat))}
with open(f'{D}/{C}/final_olin.csv', 'w') as fh:
    fh.write('k\tw\n')
    for k, w in olr.items():
        if k in olk: fh.write(f"{olk[k]}\t{w}\n")
sql += f"""
COPY (SELECT k, ST_AsText(ST_Transform(ST_GeomFromText(w), '{CRS}', 'EPSG:4326', always_xy := true)) w FROM read_csv('{D}/{C}/final_olin.csv', delim = '\t', header = true, quote = '')) TO '{D}/{C}/final_ol.csv' (HEADER);"""
subprocess.run(['duckdb', f'{D}/{C}.duckdb'], input=sql, text=True, check=True)
from shapely import wkt as _wkt
wet_k = wet_ol   # final index -> dry outline (lat/lon WKT)
# the nearest of each by road (km driven, not as the crow flies): one Dijkstra per kind from all its places at once, over roads
# without a closed barrier, up to 50 km; a place joins the nearest road vertex within 250 m, a spot the vertex its way in starts from
SP = list(csv.DictReader(open(f'{D}/{C}/final_svcpts.csv')))
okr = (ecls == 0) & (np.maximum(vb[ea], vb[eb]) < 3) & (ecut < 3)
AR = csr_matrix((np.r_[elen[okr], elen[okr]], (np.r_[ea[okr], eb[okr]], np.r_[eb[okr], ea[okr]])), shape=(N, N))
sv_d, sv_i = gtree.query(np.c_[np.array([float(r['lon']) for r in SP]) * 111320 * cm, np.array([float(r['lat']) for r in SP]) * 110540], distance_upper_bound=250)
wcs = {int(r['k']) for r in csv.DictReader(open(f'{D}/{C}/final_wc.csv'))}
svc = {}
for kind, test in (('food', lambda r: r['k'] == 'food'), ('fuel', lambda r: r['k'] == 'fuel'), ('ev', lambda r: r['k'] == 'ev'), ('evf', lambda r: r['k'] == 'ev' and r['fast'] in ('true', 'True'))):
    at = {}
    for j, r in enumerate(SP):
        if test(r) and sv_i[j] < N: at.setdefault(int(sv_i[j]), r['nm'])
    if not at: continue
    d, _, src = dijkstra(AR, directed=False, indices=np.array(list(at)), min_only=True, return_predecessors=True, limit=50000)
    for k in range(len(lat)):
        v = next((int(v) for v in cand_v[k] if v < N and np.isfinite(d[v])), None)
        if v is not None: svc.setdefault(k, {})['d_' + kind] = d[v]; svc[k]['n_' + kind] = at.get(int(src[v]), '')
    del d, src
del AR
print('services', len(svc), file=sys.stderr)
olp = {}
def olenc(g):   # the largest part's outer ring, closed by the page
    if g.geom_type == 'MultiPolygon': g = max(g.geoms, key=lambda q: q.area)
    return enc([(y, x) for x, y in list(g.exterior.coords)[:-1]]) if g.geom_type == 'Polygon' and not g.is_empty else None
for r in csv.DictReader(open(f'{D}/{C}/final_ol.csv')): olp[int(r['k'])] = olenc(_wkt.loads(r['w']))
for k, w in wet_k.items(): olp[k] = olenc(_wkt.loads(w))
def skm(k, n):   # road distance to the nearest service, km to 0.1
    v = svc.get(k, {}).get('d_' + n); return round(float(v) / 1000, 1) if v is not None else None
def snm(k, n): return svc.get(k, {}).get('n_' + n) or None
wname = {int(r['k']): r['wname'] for r in csv.DictReader(open(f'{D}/{C}/final_w.csv'))}
pname = {int(r['k']): (r['pname'], int(float(r['pd']))) for r in csv.DictReader(open(f'{D}/{C}/final_p.csv'))}

# ---- records, as compact arrays (field order in SF / BF, also written to index.json so the page reads them by name)
SURF = {'asphalt': 'a', 'paved': 'a', 'concrete': 'a', 'chipseal': 'a', 'gravel': 'g', 'fine_gravel': 'g', 'compacted': 'g', 'unpaved': 'g', 'dirt': 'g', 'ground': 'g', 'pebblestone': 'g'}
KIND = {'road': 'v', 'stop:lomme': 'l', 'stop:pause': 'l', 'stop:rast': 'r', 'stop:park': 'p', 'stop:snu': 's', 'osm:parking': 'p', 'osm:rest_area': 'r', 'osm:turning_circle': 's', 'osm:turning_loop': 's'}
SF = ['la', 'lo', 'sc', 'k', 'wk', 'wd', 'wn', 'pl', 'pd_km', 'hb', 'h5', 'mj', 'sf', 'hw', 'st', 'pad', 'z', 'prot', 'tent', 'pic', 'wp', 'hla', 'hlo', 'akm', 'nb',
      'fd', 'gd', 'ed', 'efd',   # km by road to the nearest food shop, fuel, charger, fast charger
      'vw', 'wc', 'bch']         # a viewpoint within 400 m, a toilet within 300 m, a beach within 300 m (OpenStreetMap)
BF = ['la', 'lo', 'c', 'k', 'src', 'info', 'brg']
AF = ['poly', 'm', 'bars', 'ol', 'nm']   # bars: [[la, lo, c, k, src, info], ...] the barriers you pass on the way in (pass, toll, unknown);
# ol: the open area's outline (polyline); nm: names of the nearest [food shop, fuel, charger, fast charger]
def r1(x, n=0):
    if x is None: return None
    x = float(x)
    if math.isnan(x): return None
    return round(x, n) if n else int(round(x))
KAT = {'P': 'privat vei', 'S': 'skogsbilvei', 'K': 'kommunal vei', 'F': 'fylkesvei', 'R': 'riksvei', 'E': 'europavei'}
def binfo(b):   # the facts behind a barrier's class, as short tokens the page turns into words: 'f:Låst sperring', 'kat:S', 'acc:yes', ...
    if b['src'] == 'nvdb':
        return '|'.join(x for x in (b.get('f') and 'f:' + b['f'], b.get('typ') and 'typ:' + b['typ'], b.get('bruk') and 'bruk:' + b['bruk'],
                                     b.get('kat') and 'kat:' + b['kat'], b.get('winter') == 'Ja' and 'winter:1') if x) or None
    return '|'.join(f'{k}:{b[k]}' for k in ('acc', 'locked', 'fee') if b.get(k)) or None
def brec(b): return [b['lat'], b['lon'], b['c'], b.get('k') or '', b['src'][0], binfo(b), b.get('brg')]
cells = {}
cell = lambda la, lo: f'{math.floor(la * 2)}_{math.floor(lo)}'
for k in range(len(lat)):
    p = paths.get(k); appr = [None, None, []]; hla = hlo = akm = None; nb = 0
    if p:
        ch, dist, hb = p
        coords = [(float(glat[v]), float(glon[v])) for v in ch]
        hla, hlo, akm = round(coords[0][0], 5), round(coords[0][1], 5), round(dist / 1000, 1)
        if len(coords) >= 2:
            ls = LineString([(b, a) for a, b in coords]).simplify(0.00003)
            appr = [enc([(y, x) for x, y in ls.coords]), r1(dist), [brec(bars[x]) for x in hb]]
        nb = len(hb)
    one = lambda a: a[k] if a[k] is not None else np.nan
    pn = pname.get(k)
    row = [round(float(lat[k]), 5), round(float(lon[k]), 5), r1(s[k]), KIND.get(str(F['src'][k]), 'p'),
           int(wk[k]) if dw[k] <= 300 else 0, r1(dw[k]) if dw[k] <= 300 else None, wname.get(k), pn[0] if pn else None, round(pn[1] / 1000, 1) if pn else None,
           r1(one(F['d_build'])), r1(nz([one(F['nb500'])], 0)[0]), r1(one(F['d_major'])), SURF.get(str(F['surf'][k]), ''), str(F['hw'][k] or ''), int(st[k]),
           r1(pad[k]), r1(zz[k]), 2 if nz([one(F['in_np'])], 0)[0] else (1 if nz([one(F['in_prot'])], 0)[0] else 0),
           1 if nz([one(F['nb150'])], 0)[0] == 0 else 0, 1 if nz([one(F['d_picnic'])], 999)[0] <= 200 else 0, 1 if nz([one(F['d_wpoi'])], 999)[0] <= 150 else 0,
           hla, hlo, akm, nb, skm(k, 'food'), skm(k, 'fuel'), skm(k, 'ev'), skm(k, 'evf'),
           1 if nz([one(F['d_view'])], 999)[0] <= 400 else 0, 1 if k in wcs else 0, 1 if nz([one(F['d_beach'])], 999)[0] <= 300 else 0]
    appr = appr + [olp.get(k), [snm(k, n) for n in ('food', 'fuel', 'ev', 'evf')]]
    c = cells.setdefault(cell(lat[k], lon[k]), {'s': [], 'a': [], 'b': []})
    c['s'].append(row); c['a'].append(appr)
for i, b in enumerate(bars):
    if b['src'] == 'nvdb' and b.get('e') is None: continue          # not on a road we know
    cells.setdefault(cell(b['lat'], b['lon']), {'s': [], 'a': [], 'b': []})['b'].append(brec(b))
for sub in ('s', 'a', 'b'):
    os.makedirs(f'{OUT}/{CC}/{sub}', exist_ok=True)
    for f in os.listdir(f'{OUT}/{CC}/{sub}'): os.remove(f'{OUT}/{CC}/{sub}/{f}')
for f in os.listdir(f'{OUT}/{CC}'):
    if f.endswith('.json'): os.remove(f'{OUT}/{CC}/{f}')
dump = lambda o, f: json.dump(o, open(f, 'w'), ensure_ascii=False, separators=(',', ':'))
for key, c in cells.items():
    order = sorted(range(len(c['s'])), key=lambda i: -c['s'][i][2])
    if c['s']:
        dump([c['s'][i] for i in order], f'{OUT}/{CC}/s/{key}.json'); dump([c['a'][i] for i in order], f'{OUT}/{CC}/a/{key}.json')
    if c['b']: dump(c['b'], f'{OUT}/{CC}/b/{key}.json')
idx_f = f'{OUT}/index.json'
idx = json.load(open(idx_f)) if os.path.exists(idx_f) else {'cells': {}, 'n': {}}
import datetime
idx['v'] = datetime.datetime.now().strftime('%Y%m%d%H%M')   # to the minute: tile URLs carry it, and Cloudflare keeps a URL for a year
idx['f'] = {'s': SF, 'b': BF, 'a': AF}
idx['cells'][CC] = {'s': sorted(k for k, c in cells.items() if c['s']), 'b': sorted(k for k, c in cells.items() if c['b'])}; idx['n'][CC] = {'spots': int(len(lat)), 'barriers': sum(len(c['b']) for c in cells.values())}
json.dump(idx, open(idx_f, 'w'), separators=(',', ':'))
for sub in ('s', 'a', 'b'):
    print(C, sub, len(os.listdir(f'{OUT}/{CC}/{sub}')), 'files', sum(os.path.getsize(f'{OUT}/{CC}/{sub}/{f}') for f in os.listdir(f'{OUT}/{CC}/{sub}')), 'bytes', file=sys.stderr)
