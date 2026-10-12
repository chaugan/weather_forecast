# Nattplass: the outline of the open, level area at each final spot (cache/<c>/final.csv, from final.py), for the page to draw when a
# spot is picked. pad.py measures again with shape=True; the outlines are kept by position ("lat,lon" to 5 decimals) in
# cache/<c>/outline.jsonl, in the country's CRS (final.py turns them into lat/lon). Resumable: only positions not seen are measured.
# Records made under an older patch rule ("w" below pad.SHAPE_V) are cut to the current one from their outline alone, without new
# terrain: water and marsh left out (Finland's level-lake test only within 60 m of mapped water or wetland), the carriageway (pad.lane) and room
# for a vehicle (pad.room); the cut patch is a part of the old one.   python3 tools/camp/outline.py norway cut
#   python3 tools/camp/outline.py norway     (Sweden: with tools/camp/.venv/bin/python, for the tree heights)
import sys, os, json, csv, subprocess
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pad import pad, CRS, CELL, H, water, lane, outline, room, seg_dist, SHAPE_V
from shapely import wkt
C = sys.argv[1]; D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
OUT = f'{D}/{C}/outline.jsonl'
pkey = lambda la, lo: f'{float(la):.5f},{float(lo):.5f}'
if sys.argv[2:] in (['cut'], ['water']):
    import numpy as np
    from shapely import contains_xy
    rec = {}
    for l in open(OUT):
        r = json.loads(l)
        if 'err' not in r: rec[r['id']] = r
    with open(f'{D}/{C}/olpts.csv', 'w') as fh:
        fh.write('id,lat,lon\n')
        for r in csv.DictReader(open(f'{D}/{C}/final.csv')):
            k = pkey(r['lat'], r['lon']); o = rec.get(k)
            if o and o.get('ol') and o.get('w', 0) < SHAPE_V[C]: fh.write(f'"{k}",{r["lat"]},{r["lon"]}\n')
    sql = f"""LOAD spatial;
CREATE OR REPLACE TEMP TABLE q AS SELECT id, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:3035', always_xy := true) g FROM read_csv('{D}/{C}/olpts.csv');
CREATE OR REPLACE TEMP TABLE nw AS SELECT DISTINCT q.id FROM q JOIN (SELECT g FROM water UNION ALL SELECT g FROM cover WHERE k = 'wetland') w ON ST_DWithin(q.g, w.g, 60);
COPY (SELECT q.id, ST_AsText(ST_Transform(any_value(q.g), 'EPSG:3035', '{CRS[C]}', always_xy := true)) pt, any_value(nw.id IS NOT NULL) nearw,
  list(ST_AsText(ST_Transform(ST_Intersection(r.g, ST_Buffer(q.g, 75)), 'EPSG:3035', '{CRS[C]}', always_xy := true))) FILTER (r.g IS NOT NULL) roads
  FROM q LEFT JOIN nw USING (id) LEFT JOIN roads r ON ST_DWithin(q.g, r.g, 75) AND r.hw <> 'ferry' GROUP BY q.id) TO '{D}/{C}/olcut.json' (FORMAT JSON);"""
    subprocess.run(['duckdb', f'{D}/{C}.duckdb'], input=sql, text=True, check=True)
    rows = [json.loads(l) for l in open(f'{D}/{C}/olcut.json')]
    print('todo', len(rows), 'near water', sum(1 for r in rows if r['nearw']), file=sys.stderr)
    k = CELL[C]; n = 2 * H // k
    def lines(w):
        g = wkt.loads(w)
        if g.is_empty: return []
        if g.geom_type == 'LineString': return [list(g.coords)]
        return [list(p.coords) for p in getattr(g, 'geoms', []) if p.geom_type == 'LineString']
    def cut(r):
        p = wkt.loads(r['pt']); x0, y0 = int(round(p.x)), int(round(p.y))
        if C != 'norway': x0 -= x0 % 2; y0 -= y0 % 2
        cx = x0 - H + k / 2 + k * np.arange(n); cy = y0 + H - k / 2 - k * np.arange(n)
        px, py = np.meshgrid(cx, cy)
        ok = contains_xy(wkt.loads(rec[r['id']]['ol']), px, py)
        try: ok &= ~water(C, x0, y0, flat=bool(r['nearw']))
        except Exception: return r['id'], None
        droad = np.full(px.shape, np.inf)
        for w in r['roads'] or []:
            for c in lines(w): droad = np.minimum(droad, seg_dist(px, py, c))
        try: ln = lane(C, x0, y0)
        except Exception: return r['id'], None
        best, patch = room(ok, (droad >= 4) & (droad <= 6), k, ln)
        return r['id'], ({'pad': best, 'ol': outline(patch, x0, y0, k), 'w': SHAPE_V[C]} if best else {'pad': 0, 'w': SHAPE_V[C]})
    from concurrent.futures import ThreadPoolExecutor
    with open(OUT, 'a') as fh, ThreadPoolExecutor(6 if C == 'norway' else 4) as ex:
        for j, (i, m) in enumerate(ex.map(cut, rows)):
            if m: fh.write(json.dumps({'id': i, **m}) + '\n')
            if j % 2000 == 0: print(j, file=sys.stderr, flush=True); fh.flush()
    print('done', file=sys.stderr); sys.exit()
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
    return r['id'], {'pad': m.get('pad'), 'ol': m.get('ol'), 'w': SHAPE_V[C]}
with open(OUT, 'a') as fh, ThreadPoolExecutor(4 if C in ('finland', 'sweden') else 6) as ex:
    for k, (i, m) in enumerate(ex.map(run, rows)):
        fh.write(json.dumps({'id': i, **m}) + '\n')
        if k % 2000 == 0: print(k, file=sys.stderr, flush=True); fh.flush()
print('done', file=sys.stderr)
