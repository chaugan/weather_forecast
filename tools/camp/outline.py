# Nattplass: the outline of the open, level area at each final spot (cache/<c>/final.csv, from final.py), for the page to draw when a
# spot is picked. pad.py measures again with shape=True; the outlines are kept by position ("lat,lon" to 5 decimals) in
# cache/<c>/outline.jsonl, in the country's CRS (final.py turns them into lat/lon). Resumable: only positions not seen are measured.
#   python3 tools/camp/outline.py norway     (Sweden: with tools/camp/.venv/bin/python, for the tree heights)
import sys, os, json, csv, subprocess
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pad import pad, CRS
from shapely import wkt
C = sys.argv[1]; D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
OUT = f'{D}/{C}/outline.jsonl'
pkey = lambda la, lo: f'{float(la):.5f},{float(lo):.5f}'
done = {r['id'] for r in map(json.loads, open(OUT)) if 'err' not in r} if os.path.exists(OUT) else set()
todo = {pkey(r['lat'], r['lon']): r for r in csv.DictReader(open(f'{D}/{C}/final.csv'))}
todo = [(k, r['lat'], r['lon']) for k, r in todo.items() if k not in done]
print('todo', len(todo), file=sys.stderr)
with open(f'{D}/{C}/olpts.csv', 'w') as fh:
    fh.write('id,lat,lon\n')
    for i, la, lo in todo: fh.write(f'"{i}",{la},{lo}\n')
sql = f"""LOAD spatial;
CREATE OR REPLACE TEMP TABLE q AS SELECT id, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:3035', always_xy := true) g FROM read_csv('{D}/{C}/olpts.csv');
COPY (SELECT q.id, ST_AsText(ST_Transform(q.g, 'EPSG:3035', '{CRS[C]}', always_xy := true)) pt,
  list(ST_AsText(ST_Transform(ST_Intersection(r.g, ST_Buffer(q.g, 75)), 'EPSG:3035', '{CRS[C]}', always_xy := true))) roads
  FROM q JOIN roads r ON ST_DWithin(q.g, r.g, 75) AND r.hw <> 'ferry' GROUP BY ALL) TO '{D}/{C}/olroads.json' (FORMAT JSON);"""
subprocess.run(['duckdb', f'{D}/{C}.duckdb'], input=sql, text=True, check=True)
def lines(w):
    g = wkt.loads(w)
    if g.is_empty: return []
    if g.geom_type == 'LineString': return [list(g.coords)]
    return [list(p.coords) for p in getattr(g, 'geoms', []) if p.geom_type == 'LineString']
rows = [json.loads(l) for l in open(f'{D}/{C}/olroads.json')]
rows.sort(key=lambda r: (lambda p: (int(p.y // 5000), p.x))(wkt.loads(r['pt'])))   # neighbours together
def run(r):
    p = wkt.loads(r['pt'])
    try: m = pad(p.x, p.y, [c for w in r['roads'] if w for c in lines(w)], C, shape=True) or {}
    except Exception as e: return r['id'], {'err': str(e)[:80]}
    return r['id'], {'pad': m.get('pad'), 'ol': m.get('ol')}
with open(OUT, 'a') as fh, ThreadPoolExecutor(4 if C in ('finland', 'sweden') else 6) as ex:
    for k, (i, m) in enumerate(ex.map(run, rows)):
        fh.write(json.dumps({'id': i, **m}) + '\n')
        if k % 2000 == 0: print(k, file=sys.stderr, flush=True); fh.flush()
print('done', file=sys.stderr)
