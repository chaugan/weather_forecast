# Nattplass: run pad.py on the road clusters of cand.npz (Norway, Finland, Sweden). Results are kept by position ("lat,lon" to 5 decimals) in
# cache/<c>/pad.jsonl, so a rebuild measures only the points it has not seen (the candidate ids change between builds).
import sys, os, json, math, subprocess
import numpy as np
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pad import pad, CRS
C = sys.argv[1]; D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
Z = np.load(f'{D}/{C}/cand.npz', allow_pickle=True)
ids = Z['all_id'][Z['idx']]; road = Z['all_road'][Z['idx']]
pkey = lambda la, lo: f'{la:.5f},{lo:.5f}'
# only points that can still make final.py's cut (the pad adds at most 15) and are not behind a closed barrier
MIN = float(os.environ.get('NATT_MIN') or {'norway': 45, 'sweden': 55, 'finland': 50}[C]) - {'sweden': 10}.get(C, 15)   # Sweden: 40-44 would need the full bonus
todo = [(pkey(la, lo), la, lo) for la, lo, r, s, st in zip(Z['lat'], Z['lon'], road, Z['s'], Z['st']) if r and s >= MIN and st < 2]
done = set()
OUT = f'{D}/{C}/pad.jsonl'
if os.path.exists(OUT): done = {r['id'] for r in map(json.loads, open(OUT)) if 'err' not in r}   # a failed point is tried again
todo = [t for t in todo if t[0] not in done]
print('todo', len(todo), file=sys.stderr)
# roads near each point, in the country's CRS, from DuckDB; then measured with neighbours together, so fetched terrain
# blocks are reused
with open(f'{D}/{C}/padpts.csv', 'w') as fh:
    fh.write('id,lat,lon\n')
    for i, la, lo in todo: fh.write(f'"{i}",{la},{lo}\n')
sql = f"""LOAD spatial;
CREATE OR REPLACE TEMP TABLE q AS SELECT id, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:3035', always_xy := true) g, lat, lon FROM read_csv('{D}/{C}/padpts.csv');
COPY (SELECT q.id, ST_AsText(ST_Transform(q.g, 'EPSG:3035', '{CRS[C]}', always_xy := true)) pt,
  list(ST_AsText(ST_Transform(ST_Intersection(r.g, ST_Buffer(q.g, 75)), 'EPSG:3035', '{CRS[C]}', always_xy := true))) roads
  FROM q JOIN roads r ON ST_DWithin(q.g, r.g, 75) AND r.hw <> 'ferry' GROUP BY ALL) TO '{D}/{C}/padroads.json' (FORMAT JSON);"""
subprocess.run(['duckdb', f'{D}/{C}.duckdb'], input=sql, text=True, check=True)
from shapely import wkt
def lines(w):
    g = wkt.loads(w)
    if g.is_empty: return []
    if g.geom_type == 'LineString': return [list(g.coords)]
    return [list(p.coords) for p in getattr(g, 'geoms', []) if p.geom_type == 'LineString']
rows = [json.loads(l) for l in open(f'{D}/{C}/padroads.json')]
rows.sort(key=lambda r: (lambda p: (int(p.y // 5000), p.x))(wkt.loads(r['pt'])))   # DuckDB's grouping loses the order
def run(r):
    p = wkt.loads(r['pt'])
    try: m = pad(p.x, p.y, [c for w in r['roads'] if w for c in lines(w)], C)
    except Exception as e: m = {'err': str(e)[:80]}
    return r['id'], m
with open(OUT, 'a') as fh, ThreadPoolExecutor(4 if C in ('finland', 'sweden') else 6) as ex:   # gentle on the free services
    for k, (i, m) in enumerate(ex.map(run, rows)):
        fh.write(json.dumps({'id': i, **(m or {'pad': None})}) + '\n')
        if k % 2000 == 0: print(k, file=sys.stderr, flush=True); fh.flush()
print('done', file=sys.stderr)
