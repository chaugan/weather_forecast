#!/usr/bin/env python3
"""External check of the fitted wet-road model on Finnish road weather stations (Digitraffic), not used in the fit.

  tools/wetroad/check_fi.py PARAMS.json FI_FILE_OR_DIR [--ana DIR] [--out OUT.json]

FI_FILE_OR_DIR: fi_hist_*.json.gz (the 24 h research pull) or the collector's archive (collect.py: DIR/YYYY/MM/*.json.gz,
overlapping windows are merged). Per station, hourly on Kjørevær's terms: rain in the hour ending at the hour from the
SADESUMMA gauge (increments, a drop is a reset), T (ILMA), Td (KASTEPISTE) and the road surface (TIE_1) at the hour, the
highest MAKSIMITUULI in the hour as the gust, day from the same sun formula as api/met.php; no cloud data, so the sky is
"not known" (the sunny share of daytime from the fit stands in). Road state at the hour from KELI_1: 1 dry, 2 and 8 moist,
3 and 4 wet, 5/6/7/9 ice/snow/slush; 0 and 13 missing. Scored on post-rain hours (no rain in the hour, rain in the 12 h
before; air > 1 C and road > 0.5 C), the first 6 hours of a series left out (the bucket has no history there).
--ana DIR: the production-input check: the MET Nordic analysis (DIR/YYYYMMDDTHHZ.npy, 1 km, the hour ending then)
replaces the gauge as the rain input; the road states stay the measured ones.
"""
import gzip, json, os, sys, glob, math, argparse, collections
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit as F
from prep import sun_alt

KELI = {1: 1, 2: 2, 8: 2, 3: 3, 4: 3, 5: 4, 6: 4, 7: 4, 9: 4}

def load(path):
    files = [path] if os.path.isfile(path) else sorted(glob.glob(os.path.join(path, '**', '*.json.gz'), recursive=True))
    S = {}
    for f in files:
        d = json.load(gzip.open(f))
        for sid, s in d['stations'].items():
            o = S.setdefault(sid, {'lat': s['lat'], 'lon': s['lon'], 'name': s.get('name'), 's': collections.defaultdict(dict)})
            for k, v in s['s'].items():
                for t, x in v: o['s'][k][int(t)] = x   # epoch minutes; overlapping windows collapse
    return S

def build(S, ana=None):
    """-> the dict fit.Pack reads (one series per station over the whole span), plus the per-station lists"""
    tmin = min(min(v) for s in S.values() for v in s['s'].values() if v); tmax = max(max(v) for s in S.values() for v in s['s'].values() if v)
    h0 = (tmin // 60 + 1) * 60; H = (tmax - h0) // 60   # hour k ends at minute h0 + 60k... k=0 is the first full hour end
    te = (h0 + 60 * np.arange(H)) * 60
    A = {k: [] for k in ('P', 'T', 'Td', 'Ts', 'G', 'st', 'day', 'sun')}; sids = []; lat = []; lon = []
    if ana:
        AN = {}
        for t in te:
            f = os.path.join(ana, __import__('datetime').datetime.fromtimestamp(int(t), __import__('datetime').timezone.utc).strftime('%Y%m%dT%HZ') + '.npy')
            if os.path.exists(f): AN[int(t)] = np.load(f, mmap_mode='r')
    for sid, s in S.items():
        ss = s['s']
        if 'KELI_1' not in ss or ('SADESUMMA' not in ss and not ana) or s['lat'] is None: continue
        def ser(name):
            d = ss.get(name, {}); t = np.array(sorted(d), int); return t, np.array([d[x] for x in t], float)
        def at(name, tol=10):
            t, v = ser(name); out = np.full(H, np.nan)
            if not len(t): return out
            m = te // 60; i = np.clip(np.searchsorted(t, m), 0, len(t) - 1); j = np.clip(i - 1, 0, len(t) - 1)
            for c in (j, i):
                ok = np.isnan(out) & (np.abs(t[c] - m) <= tol); out[ok] = v[c][ok]
            return out
        if ana:
            fi, fj = idx(s['lat'], s['lon']); P = np.array([float(AN[int(t)][round(fj), round(fi)]) if int(t) in AN else np.nan for t in te])
        else:
            t, v = ser('SADESUMMA'); inc = np.where(np.diff(v) >= 0, np.diff(v), v[1:]); ti = t[1:]
            P = np.full(H, np.nan); m = te // 60
            for k in range(H):
                w = (ti > m[k] - 60) & (ti <= m[k]); n = w.sum()
                if n >= 6: P[k] = inc[w].sum()   # 5-min samples: at least half the hour there
        c = at('KELI_1'); st = np.zeros(H, 'i1')
        for code, x in KELI.items(): st[c == code] = x
        tg, vg = ser('MAKSIMITUULI'); G = np.full(H, np.nan)
        if len(tg):
            m = te // 60
            for k in range(H):
                w = (tg > m[k] - 60) & (tg <= m[k])
                if w.any(): G[k] = vg[w].max()
        A['P'].append(P); A['T'].append(at('ILMA')); A['Td'].append(at('KASTEPISTE')); A['Ts'].append(at('TIE_1')); A['G'].append(G); A['st'].append(st)
        day = sun_alt(s['lat'], s['lon'], te.astype('f8')) > -0.833; A['day'].append(day); A['sun'].append(np.where(day, np.nan, 0.0))
        sids.append(sid); lat.append(s['lat']); lon.append(s['lon'])
    D = {k: np.array(v, 'f4' if k not in ('st', 'day') else ('i1' if k == 'st' else bool)) for k, v in A.items()}
    # no history before the first hours: leave them out of the scores (marked missing)
    D['st'][:, :6] = 0
    D.update(sid=np.array(sids), ev=np.zeros((0, 6), 'f4')); return D

def idx(lat, lon):   # MET Nordic 1 km grid (i, j), as in api/wind.php wind_index
    p1 = math.radians(63); n = math.sin(p1); Fc = math.cos(p1) * math.tan(math.pi / 4 + p1 / 2) ** n / n; rho0 = 6371000 * Fc / math.tan(math.pi / 4 + p1 / 2) ** n
    rho = 6371000 * Fc / math.tan(math.pi / 4 + math.radians(lat) / 2) ** n; th = n * math.radians(lon - 15)
    return ((rho * math.sin(th) + 897442.2) / 1000, (rho0 - rho * math.cos(th) + 1104322.0) / 1000)

def score(D, prm):
    v = prm['values']; G = dict(Gref=prm['Gref'], pisun=prm['pisun'])
    p = F.Pack(D, np.ones(len(D['sid']), bool), 'fi'); p.run(v, G['Gref'], G['pisun'])
    Wh = p.W.ravel()[p.hix]; obs = p.hst >= 2; lags = np.array([prm['B1_lags_min'][k] for k in prm['B1_lags_min']])
    r = dict(stations=int(p.n), stations_with_post_rain_hours=int(len(set(p.hs.tolist()))), post_rain_hours=int(len(p.hs)), wet_share=float(obs.mean()) if len(obs) else None,
             pss=dict(model=F.pss(Wh >= v['thMoist'], obs), B0=F.pss(np.zeros_like(obs), obs), B1=F.pss(F.b1_hours(p, lags), obs)))
    r['model_beats_B0'] = r['pss']['model'][0] > r['pss']['B0'][0]; return r

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('params'); ap.add_argument('fi'); ap.add_argument('--ana'); ap.add_argument('--out'); a = ap.parse_args()
    F.lib(); prm = json.load(open(a.params)); S = load(a.fi)
    res = {'gauge': score(build(S), prm)}
    if a.ana: res['analysis_rain'] = score(build(S, a.ana), prm)
    print(json.dumps(res, indent=1))
    if a.out: json.dump(res, open(a.out, 'w'), indent=1)
