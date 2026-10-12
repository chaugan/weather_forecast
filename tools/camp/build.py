# Nattplass build, stage 1: filter + score + reachability + cluster for one country.
#   python3 tools/camp/build.py norway          -> cache/<c>/cand.npz (+ recall report against the research sample)
import sys, os, json, math
import numpy as np, pyarrow.parquet as pq
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import score, nz

C = sys.argv[1]; D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
T = pq.read_table(f'{D}/{C}/feat.parquet'); F = {k: T.column(k).to_numpy(zero_copy_only=False) for k in T.column_names}
src = F['src'].astype(str); road = src == 'road'
ok = (nz(F['in_farm'], 0) == 0) & (nz(F['urban100'], 0) == 0)
dw0 = np.minimum(np.minimum(nz(F['d_lake'], 1e4), nz(F['d_river'], 1e4)), nz(F['d_coast'], 1e4))
# Norway: 150 m from inhabited houses and cabins applies to sleeping in a vehicle too (Miljødirektoratet); we cannot tell
# inhabited buildings from barns, so any building counts
ok_road = ok & road & (nz(F['d_build'], 2000) >= (150 if C == 'norway' else 80)) & (nz(F['nb500'], 0) <= 25) & (dw0 <= 300)
ok_stop = ok & ~road & (nz(F['nb500'], 0) <= 40)
keep = ok_road | ok_stop
F = {k: v[keep] for k, v in F.items()}; src = src[keep]; road = road[keep]
print(C, 'kept', keep.sum(), 'road', road.sum(), 'stops', (~road).sum(), file=sys.stderr)
s, dw, wk = score(F)
lat, lon = F['lat'].astype(float), F['lon'].astype(float)

# reachability: status of the nearest graph vertex (graph.py)
G = np.load(f'{D}/{C}/graph.npz')
glat, glon, gst = G['lat'].astype(float), G['lon'].astype(float), G['st']
c0 = math.cos(math.radians(np.mean(lat)))
def xy(la, lo): return np.c_[lo * 111320 * c0, la * 110540]
tree = cKDTree(xy(glat, glon))
dd, ii = tree.query(xy(lat, lon), k=1)
st = np.where(dd <= 80, gst[ii], 4)
print('status', {k: int((st == v).sum()) for k, v in (('open', 0), ('gate', 1), ('closed', 2), ('private', 3), ('isolated', 4))}, file=sys.stderr)
s = s - np.select([st == 1, st >= 2], [4, 1000], 0)        # behind a closed bom / private / isolated: not a vehicle spot

# cluster: best first, nothing else within 400 m
order = np.argsort(-s); P = xy(lat, lon); acc = []; taken = np.zeros(len(s), bool)
ptree = cKDTree(P)
for i in order:
    if s[i] < 20: break
    if taken[i]: continue
    acc.append(i)
    taken[ptree.query_ball_point(P[i], 400)] = True
acc = np.array(acc)
print('clusters', len(acc), file=sys.stderr)
np.savez_compressed(f'{D}/{C}/cand.npz', idx=acc, s=s[acc], lat=lat[acc], lon=lon[acc], st=st[acc], src=src[acc], dw=dw[acc], wk=wk[acc],
                    all_lat=lat, all_lon=lon, all_s=s, all_st=st, all_road=road, all_id=F['id'].astype(str))

# recall against a research sample of known spots (cache/probe, local only, never in git or shipped): share of remote spots with a
# cluster within R
pf = f"{D}/probe/{ {'norway': 'no', 'sweden': 'se', 'finland': 'fi'}[C] }_features.csv"
if os.path.exists(pf):
    import csv
    R = [r for r in csv.DictReader(open(pf)) if r['src'] != 'road']
    def remote(r): return float(r['d_major'] or 1e5) > 300 and float(r['d_build'] or 1e4) >= 100 and float(r['d_rest'] or 1e4) > 200
    for name, sel in (('remote', [r for r in R if remote(r)]), ('all', R)):
        Q = xy(np.array([float(r['lat']) for r in sel]), np.array([float(r['lon']) for r in sel]))
        ct = cKDTree(P[acc])
        for rad in (200, 400):
            hit = np.array([len(x) > 0 for x in ct.query_ball_point(Q, rad)])
            print(f'recall {name} n={len(sel)} within {rad} m: {hit.mean():.3f}', file=sys.stderr)
