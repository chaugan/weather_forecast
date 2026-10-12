# Nattplass: reachability of the drivable road network past barriers, for one country.
# Reads cache/<c>/roads.geojsonl and cache/<c>/barriers.geojsonl (extract.sh) and, for Norway, cache/nvdb_barriers.json (nvdb.py).
# Writes cache/<c>/graph.npz: vertex coordinates (E7) and a status per vertex, and cache/<c>/road_barriers.json (the barriers that
# sit on a drivable road, with their class).
#
# Barrier classes (physical passability for a car, kept apart from legal access, see classify()):
#   pass     drive over / through: cattle grid, NVDB dyresperre, toll booth, border control, an explicitly open gate
#   toll     a gate that takes a fee (bomvei): passable, costs money
#   unknown  a gate or bom with nothing said about it (most forest-road boms): may be locked
#   closed   locked, a physical block (bollard, block, jersey barrier, chain, log, ...) or access=no/private for motor vehicles
# Vertex status (best way in from any public road, i.e. any vertex on motorway..tertiary incl. ferries):
#   0 open      reached without passing any closed or unknown barrier and without private roads
#   1 gate      only past an unknown gate (no known closed one)
#   2 closed    only past a closed barrier
#   3 private   only on roads tagged private/no for motor vehicles
#   4 isolated  not connected to any public road at all
import json, sys, os, math
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

C = sys.argv[1]
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
PUBLIC = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'ferry'}
NOCAR = {'no', 'private', 'agricultural', 'forestry', 'delivery', 'emergency', 'military', 'permit', 'customers_no', 'disabled', 'bus', 'psv'}
OPEN = {'yes', 'permissive', 'designated', 'destination', 'customers'}
PASS_KINDS = {'cattle_grid', 'border_control', 'entrance', 'height_restrictor', 'kerb', 'no', 'sump_buster', 'dyresperre', 'ferist', 'yes'}
GATES = {'gate', 'lift_gate', 'swing_gate', 'sliding_gate', 'hampshire_gate', 'wicket_gate', 'sliding_beam', 'chain', 'rope', 'bar', 'barrier_board'}
BLOCK = {'bollard', 'block', 'jersey_barrier', 'log', 'spikes', 'debris', 'planter', 'cycle_barrier', 'kissing_gate', 'stile', 'turnstile',
         'full-height_turnstile', 'motorcycle_barrier', 'horse_stile', 'fence', 'wall', 'ditch', 'bump_gate', 'tank_trap', 'dragons_teeth', 'rock', 'stone'}

def car_access(p):
    for k in ('motorcar', 'motor_vehicle', 'vehicle', 'access'):
        v = p.get(k)
        if v: return v.split(';')[0].strip()
    return None

def classify(p):
    k = p.get('barrier') or ''
    acc = car_access(p)
    if k == 'toll_booth': return 'toll'
    if k in PASS_KINDS: return 'pass'
    if p.get('locked') == 'yes': return 'closed'
    if acc in NOCAR: return 'closed'
    if p.get('fee') == 'yes' or p.get('toll') == 'yes' or p.get('toll:motorcar') == 'yes': return 'toll'
    if acc in OPEN or p.get('locked') == 'no' or p.get('opening') == 'automatic': return 'pass'
    if k in GATES: return 'unknown'
    if k in BLOCK: return 'closed'
    return 'unknown'

def nvdb_class(r):
    """NVDB class from the measured field values (2026-10): 607 Vegsperring has Funksjon; 23 Vegbom has none, only Type and Bruksområde.
    Returns (class, kind) or (None, None) for a bom that is not on a car road (footpath / cycleway gates)."""
    if r['t'] == 273: return 'pass', 'dyresperre'
    e = r['e']; f = (e.get('Funksjon') or '').lower(); typ = (e.get('Type') or '').lower(); bruk = (e.get('Bruksområde') or '').lower()
    kind = 'swing_gate' if 'sving' in typ else 'block' if any(s in typ for s in ('blokk', 'betong', 'stein')) else \
           'bollard' if any(s in typ for s in ('stolpe', 'pullert', 'kjegle')) else 'bar' if 'gelender' in typ else 'lift_gate'
    if r['t'] == 607:
        if 'betaling' in f: return 'toll', kind                   # Betalingssperre: pay and pass
        if 'ulåst' in f: return 'pass', kind                      # physically open (legal access not implied)
        if 'buss' in f: return 'closed', 'bussluse'
        if 'fjernstyrt' in f: return 'unknown', 'remote'          # opens by remote, phone or tag: may open for you, may not
        return 'closed', kind                                     # Låst sperring, Trafikkavviser
    if 'gang' in bruk or 'sykkel' in bruk: return None, None      # gates on footpaths and cycleways, not on car roads
    if any(s in bruk for s in ('tunnel', 'ferje', 'fjellovergang', 'jernbane', 'bomstasjon')): return 'pass', kind   # shut only in an event
    if kind in ('block', 'bollard', 'bar') or 'ikke åpne' in (e.get('Type åpning/lukking') or '').lower(): return 'closed', kind
    return 'unknown', kind

def key(lon, lat):
    return (int(round(lon * 1e7)) + 1_800_000_000) * 4_000_000_000 + (int(round(lat * 1e7)) + 900_000_000)

# --- roads -> edges over vertex keys
keys = []; ea = []; eb = []; ecls = []   # ecls: 0 normal, 1 private (no car access), and per-edge public flag
epub = []; etrk = []
segs = []   # (lon1, lat1, lon2, lat2, edge index) for NVDB snapping
kid = {}
def vid(lon, lat):
    k = key(lon, lat)
    i = kid.get(k)
    if i is None:
        i = kid[k] = len(keys); keys.append((lon, lat))
    return i
with open(f'{D}/{C}/roads.geojsonl') as fh:
    for line in fh:
        f = json.loads(line); p = f['properties']; c = f['geometry']['coordinates']
        hw = p.get('highway') or ('ferry' if p.get('route') == 'ferry' else None)
        if not hw or len(c) < 2: continue
        acc = car_access(p)
        if hw == 'ferry' and p.get('motorcar') == 'no': continue
        priv = 1 if (acc in NOCAR and hw not in PUBLIC) else 0
        pub = 1 if hw in PUBLIC and acc not in NOCAR else 0
        prev = vid(*c[0])
        for j in range(1, len(c)):
            cur = vid(*c[j])
            if cur != prev:
                ea.append(prev); eb.append(cur); ecls.append(priv); epub.append(pub); etrk.append(1 if hw == 'track' else 0)
                if C == 'norway': segs.append((c[j - 1][0], c[j - 1][1], c[j][0], c[j][1]))
            prev = cur
N = len(keys); ea = np.array(ea, np.int64); eb = np.array(eb, np.int64); ecls = np.array(ecls, np.int8); epub = np.array(epub, np.int8)
etrk = np.array(etrk, np.int8)   # a forest or farm track (highway=track): the page tells how much of the way in is one
print(C, 'vertices', N, 'edges', len(ea), file=sys.stderr)

# --- barriers on road vertices (OSM nodes share coordinates with the way vertices)
vbar = {}   # vertex -> class rank (closed 3 > unknown 2 > toll 1 > pass 0)
RANK = {'pass': 0, 'toll': 1, 'unknown': 2, 'closed': 3}
out = []
with open(f'{D}/{C}/barriers.geojsonl') as fh:
    for line in fh:
        f = json.loads(line); p = f['properties']
        if f['geometry']['type'] != 'Point': continue
        lon, lat = f['geometry']['coordinates']
        v = kid.get(key(lon, lat))
        if v is None: continue
        cl = classify(p)
        vbar[v] = max(vbar.get(v, -1), RANK[cl])
        out.append({'src': 'osm', 'id': p.get('@id'), 'lat': round(lat, 6), 'lon': round(lon, 6), 'k': p.get('barrier'), 'c': cl,
                    'acc': car_access(p), 'locked': p.get('locked'), 'fee': p.get('fee') or p.get('toll'), 'v': v})
# OSM barrier ways (a gate drawn as a line across the road): cut the road edges they cross is rare; ignore for now.

# --- NVDB (Norway): snap to the nearest road segment within 15 m, cut that segment (both of its vertices act as the barrier)
cut_edges = {}   # edge index -> rank
if C == 'norway' and os.path.exists(f'{D}/nvdb_barriers.json'):
    S = np.array(segs, np.float64)
    lat0 = np.radians((S[:, 1] + S[:, 3]) / 2)
    mx = (S[:, 0] + S[:, 2]) / 2 * 111320 * np.cos(lat0); my = (S[:, 1] + S[:, 3]) / 2 * 110540
    tree = cKDTree(np.c_[mx, my])
    osm_pts = np.array([[o['lon'], o['lat']] for o in out]) if out else np.zeros((0, 2))
    otree = cKDTree(np.c_[osm_pts[:, 0] * 111320 * np.cos(np.radians(osm_pts[:, 1])), osm_pts[:, 1] * 110540]) if len(out) else None
    nv = json.load(open(f'{D}/nvdb_barriers.json')); snapped = 0
    for r in nv:
        cl, kind = nvdb_class(r)
        if cl is None: continue
        x = r['lon'] * 111320 * math.cos(math.radians(r['lat'])); y = r['lat'] * 110540
        dd, ii = tree.query((x, y), k=8, distance_upper_bound=400)
        best = None
        for d0, i in zip(np.atleast_1d(dd), np.atleast_1d(ii)):
            if not np.isfinite(d0): continue
            a = S[i]; cl0 = math.cos(math.radians(r['lat']))
            ax, ay, bx, by = a[0] * 111320 * cl0, a[1] * 110540, a[2] * 111320 * cl0, a[3] * 110540
            vx, vy = bx - ax, by - ay; L2 = vx * vx + vy * vy or 1e-9
            t = max(0, min(1, ((x - ax) * vx + (y - ay) * vy) / L2))
            dist = math.hypot(ax + t * vx - x, ay + t * vy - y)
            if best is None or dist < best[0]: best = (dist, int(i))
        dup = otree is not None and len(otree.query_ball_point((x, y), 15)) > 0
        rec = {'src': 'nvdb', 'id': r['id'], 'lat': round(r['lat'], 6), 'lon': round(r['lon'], 6), 'k': kind, 'c': cl, 'kat': r.get('kat'),
               'f': r['e'].get('Funksjon'), 'winter': r['e'].get('Fjernes i vintersesong'), 'bruk': r['e'].get('Bruksområde'), 'typ': r['e'].get('Type'), 'dup': dup}
        if best and best[0] <= 15:
            rec['snap'] = round(best[0], 1); rec['e'] = best[1]; snapped += 1
            cut_edges[best[1]] = max(cut_edges.get(best[1], -1), RANK[cl])
        out.append(rec)
    print('nvdb', len(nv), 'snapped', snapped, file=sys.stderr)

# --- the bearing (0-180°) of the road a barrier sits on, so the page can tell a barrier on its route from one on a side road
#     that starts at a junction of the route
def bearing(i):
    a, b = keys[ea[i]], keys[eb[i]]
    return int(round(math.degrees(math.atan2((b[0] - a[0]) * math.cos(math.radians(a[1])), b[1] - a[1])) % 180))
bvert = np.array([o['v'] for o in out if o.get('v') is not None], np.int64)
first = {}
if len(bvert):
    for arr in (ea, eb):
        hit = np.where(np.isin(arr, bvert))[0]
        for i in hit: first.setdefault(int(arr[i]), int(i))
for o in out:
    if o.get('v') is not None and o['v'] in first: o['brg'] = bearing(first[o['v']])
    elif o.get('e') is not None: o['brg'] = bearing(o['e'])

# --- components: drop edges touching a barrier vertex of rank >= r, and edges cut by NVDB of rank >= r
vb = np.full(N, -1, np.int8)
for v, rk in vbar.items(): vb[v] = rk
ecut = np.full(len(ea), -1, np.int8)
for i, rk in cut_edges.items(): ecut[i] = rk
seed = np.zeros(N, bool); seed[ea[epub == 1]] = True; seed[eb[epub == 1]] = True
def reached(min_rank, allow_private):
    keep = (np.maximum(vb[ea], vb[eb]) < min_rank) & (ecut < min_rank)
    if not allow_private: keep &= ecls == 0
    g = coo_matrix((np.ones(keep.sum(), np.int8), (ea[keep], eb[keep])), shape=(N, N))
    n, lab = connected_components(g, directed=False)
    pubc = np.zeros(n, bool); pubc[lab[seed]] = True
    ok = pubc[lab]
    # a barrier vertex itself is cut off by the rule; it belongs to the side it is reached from: treat as reached if any neighbour is
    return ok
st = np.full(N, 4, np.int8)
r_priv = reached(99, True); st[r_priv] = 3
r_all = reached(99, False); st[r_all] = 2
r_loose = reached(3, False); st[r_loose] = 1
r_strict = reached(2, False); st[r_strict] = 0
for name, val in (('open', 0), ('gate', 1), ('closed', 2), ('private', 3), ('isolated', 4)):
    print(f'  {name:9s} {np.mean(st == val):.3f}', file=sys.stderr)
xy = np.array(keys, np.float64)
np.savez_compressed(f'{D}/{C}/graph.npz', lon=xy[:, 0].astype(np.float64), lat=xy[:, 1].astype(np.float64), st=st,
                    ea=ea.astype(np.int32), eb=eb.astype(np.int32), ecls=ecls, epub=epub, etrk=etrk, vb=vb, ecut=ecut)
# road ends (a vertex on one road edge only): turning places, the end of a forest road at a lake, a quay
deg = np.bincount(ea, minlength=N) + np.bincount(eb, minlength=N)
ends = np.where(deg == 1)[0]
with open(f'{D}/{C}/ends.csv', 'w') as fh:
    fh.write('lon,lat,st\n')
    for v in ends: fh.write(f'{xy[v, 0]:.7f},{xy[v, 1]:.7f},{st[v]}\n')
print('road ends', len(ends), file=sys.stderr)
for o in out:
    v = o.get('v')
    if v is not None: o['st'] = int(st[v])
    elif o.get('e') is not None: o['st'] = int(min(st[ea[o['e']]], st[eb[o['e']]]))
json.dump(out, open(f'{D}/{C}/road_barriers.json', 'w'), ensure_ascii=False)
from collections import Counter
print(Counter((o['src'], o['c']) for o in out).most_common(), file=sys.stderr)
