#!/usr/bin/env python3
"""Turns the Frost road-station pull (pull.sh) into the hourly arrays and rain events that fit.py reads.

  tools/wetroad/prep.py --jobs AVAIL.json JOBS.txt         the pull jobs: station x 2 months, 15 Apr - 15 Oct 2022-2026,
                                                          where road state and 10-min rain overlap (AVAIL from avail.php)
  tools/wetroad/prep.py --sunjobs JOBS.txt PAIR.json SUNJOBS.txt SUNPAIRS.json   the cloud/radiation pull (PAIR from frost_pair.php)
  tools/wetroad/prep.py FROSTDIR SUNDIR SUNPAIRS.json AVAIL.json OUT.npz

Per station and season (15 April 00Z to 15 October 00Z, the frost regime kept out), hourly, on Kjørevær's terms:
  P   rain in the hour ending at the hour (sum of the six 10-min sums; Frost stamps a 10-min sum at its end)
  T, Td, Ts  air, dew point and road-surface temperature at the hour (the 10-min sample nearest HH:00, +-10 min)
  G   the highest 10-min gust in the hour (NaN at stations without a gust sensor: fit.py gives them G_ref)
  st  the road state at the hour (nearest 10-min sample, +-10 min): 1 dry (Vaisala 256), 2 moist (512), 3 wet (1024),
      4 slush/snow/ice, 0 missing (codes 0, 13 and anything else)
  day the sun above the horizon (refraction included), the same NOAA formula as api/met.php met_day()
  sun day and the sky at the paired cloud/radiation station counts as weather_code <= 2 (clear, fair, partly cloudy):
      cloud cover <= 6 oktas, or (radiation only) a clearness index above the cut that best matches that on stations
      with both; NaN where the road station has no pair within 25 km. A rain hour is never sunny (its code is rain).
Duplicate timestamps: the lowest sensor index was kept by frost_pull.php.

Quality check, per station-season (a failing one is dropped and listed in the summary):
  - moist or wet in more than 15 % of the hours with no rain in the 24 h before (a sensor that reads wet when dry)
  - more than 20 % of the road states missing (in the hours the rain gauge reported), or under 30 days of data
  - no rain sensor (no rain values, or less than 5 mm in the whole season: a dead gauge)
Hours with air <= 1 C or road surface <= 0.5 C are flagged (the ice regime, out of scope) and leave the events and scores.

Events: a rain hour (>= 0.1 mm) followed by at least one hour without. Observed drying time: from the end of the last
rain hour to the first dry state that lasts two 10-min samples in a row. Censored when rain comes back (the start of the
next rain hour), the data has a hole, the ice regime starts, the season ends, or after 48 h.
"""
import gzip, json, math, os, sys, glob, collections, datetime as dt
import numpy as np

SEASON = ('04-15', '10-15')
YEARS = range(2022, 2027)
CAP_MIN = 48 * 60

def jobs(avail, out):
    d = json.load(open(avail)); S = collections.defaultdict(lambda: collections.defaultdict(list))
    for el, sid, a, b, res, lev in d['series']: S[sid.split(':')[0]][el].append((a, b or '2100-01-01'))
    today = dt.date.today().isoformat(); J = []
    for s, e in S.items():
        if 'road_surface_condition' not in e or 'sum(precipitation_amount PT10M)' not in e: continue
        for y in YEARS:
            for a, b in (('04-15', '06-15'), ('06-15', '08-15'), ('08-15', '10-15')):
                A = f'{y}-{a}'; B = min(f'{y}-{b}', today)
                if A < B and all(any(lo < B and hi > A for lo, hi in e[k]) for k in ('road_surface_condition', 'sum(precipitation_amount PT10M)')): J.append(f'{s}:{A}/{B}')
    open(out, 'w').write('\n'.join(sorted(J)) + '\n'); print(len(J), 'jobs ->', out)

def sunjobs(jobsf, pairf, out, pairsout):
    """the cloud/radiation pull: for each road station, its nearest cloud and PT1H radiation station within 25 km, same periods"""
    p = json.load(open(pairf))['pairs']; J = [l.strip() for l in open(jobsf) if l.strip()]; sun = set(); pairs = {}
    for j in J:
        s, per = j.split(':'); v = p.get(s) or {}
        c = v.get('cloud'); r = v.get('rad') if v.get('rad') and 'PT1H' in v['rad'][2] else None
        if c or r: pairs[s] = {'cloud': c, 'rad': r}
        for o in (c, r):
            if o: sun.add(o[0] + ':' + per)
    json.dump(pairs, open(pairsout, 'w')); open(out, 'w').write('\n'.join(sorted(sun)) + '\n'); print(len(pairs), 'paired road stations,', len(sun), 'jobs ->', out)

def sun_alt(lat, lon, ts):
    """degrees; NOAA's approximation as in api/met.php met_day()"""
    d = ts / 86400 - 10957.5
    g = np.radians(np.mod(357.529 + 0.98560028 * d, 360)); q = np.mod(280.459 + 0.98564736 * d, 360)
    L = np.radians(q + 1.915 * np.sin(g) + 0.020 * np.sin(2 * g)); e = np.radians(23.439 - 0.00000036 * d)
    dec = np.arcsin(np.sin(e) * np.sin(L)); ra = np.arctan2(np.cos(e) * np.sin(L), np.cos(L))
    gmst = np.mod(18.697374558 + 24.06570982441908 * d, 24) * 15
    ha = np.radians(gmst + lon) - ra; la = math.radians(lat)
    return np.degrees(np.arcsin(math.sin(la) * np.sin(dec) + math.cos(la) * np.cos(dec) * np.cos(ha)))

COLS = ['c', 'w', 'p', 'pt', 'T', 'Td', 'G', 'Gi', 'Ts', 'ws']
STATE = {256: 1, 512: 2, 1024: 3, 2048: 4, 4096: 4, 8192: 4}

def season_grid(y):
    t0 = int(dt.datetime.fromisoformat(f'{y}-{SEASON[0]}T00:00+00:00').timestamp()); t1 = int(dt.datetime.fromisoformat(f'{y}-{SEASON[1]}T00:00+00:00').timestamp())
    return t0, (t1 - t0) // 600

def load_station(files):
    """{year: (10-min array [n, len(COLS)] with NaN)}"""
    out = {}
    for f in files:
        for line in gzip.open(f, 'rt'):
            r = line.rstrip('\n').split(',')
            if len(r) != 2 + len(COLS) or r[0] == 'sid': continue
            y = int(r[1][:4]); t0, n = season_grid(y)
            if y not in out: out[y] = np.full((n, len(COLS)), np.nan, 'f4')
            k = (int(dt.datetime.fromisoformat(r[1] + '+00:00').timestamp()) - t0) // 600
            if 0 <= k < n: out[y][k] = [float(x) if x != '' else np.nan for x in r[2:]]
    return out

def load_sun(files):
    """{station: {epoch hour: (N, Q)}}"""
    out = collections.defaultdict(dict)
    for f in files:
        for line in gzip.open(f, 'rt'):
            r = line.rstrip('\n').split(',')
            if len(r) != 4 or r[0] == 'sid': continue
            t = int(dt.datetime.fromisoformat(r[1] + '+00:00').timestamp())
            if t % 3600 == 0: out[r[0]][t] = (float(r[2]) if r[2] else np.nan, float(r[3]) if r[3] else np.nan)
    return out

def at_hour(a):
    """10-min column a -> value at each HH:00, nearest sample within +-10 min (HH:00 first)"""
    n = len(a) // 6; h = a[:n * 6].reshape(n, 6)
    v = h[:, 0].copy()   # block m holds slots 6m .. 6m+5; v[m] is the value at slot 6m (HH:00)
    prev = np.concatenate([[np.nan], h[:-1, 5]]); nxt = h[:, 1]
    v = np.where(np.isnan(v), prev, v); v = np.where(np.isnan(v), nxt, v); return v

def clearsky(cosz):
    return np.where(cosz > 0.01, 1098 * cosz * np.exp(-0.057 / np.maximum(cosz, 0.01)), np.nan)   # Haurwitz (W/m2)

def main(frostdir, sundir, pairsf, srcf, outf):
    src = json.load(open(srcf))['src']; pairs = json.load(open(pairsf)) if os.path.exists(pairsf) else {}
    byst = collections.defaultdict(list)
    for f in sorted(glob.glob(os.path.join(frostdir, 'SN*_*.csv.gz'))): byst[os.path.basename(f).split('_')[0]].append(f)
    sun = load_sun(glob.glob(os.path.join(sundir, 'SN*_*.csv.gz'))) if sundir and os.path.isdir(sundir) else {}
    S = []; dropped = []
    for sid, files in sorted(byst.items()):
        meta = src.get(sid) or {}; lat, lon = meta.get('lat'), meta.get('lon')
        if lat is None: dropped.append((sid, 0, 'no position')); continue
        for y, A in sorted(load_station(files).items()):
            t0, n = season_grid(y); H = n // 6
            # hour k is the hour ending at te[k]; 10-min slot q is the stamp t0 + 600q, so hour k's sums are slots 6k+1 .. 6k+6
            te = t0 + 3600 * (np.arange(H) + 1)
            p10 = A[:, 2]; pk = np.concatenate([p10[1:], [np.nan]])[:H * 6].reshape(H, 6)   # stamps HH:10..HH+1:00
            P = np.where(np.isnan(pk).sum(1) <= 1, np.nansum(pk, 1), np.nan)
            # instantaneous values at the hour end te[k] (block k+1's HH:00 sample, +-10 min)
            def inst(col):
                v = at_hour(A[:, col]); return np.concatenate([v[1:], [np.nan]])[:H]
            c = inst(0); st = np.zeros(H, 'i1')
            for code, s in STATE.items(): st[c == code] = s
            T, Td, Ts = inst(4), inst(5), inst(8)
            g10 = np.where(np.isnan(A[:, 6]), A[:, 7], A[:, 6]); gk = np.concatenate([g10[1:], [np.nan]])[:H * 6].reshape(H, 6)
            G = np.where(np.isnan(gk).all(1), np.nan, np.nanmax(np.where(np.isnan(gk), -1, gk), 1)); G[G < 0] = np.nan
            alt = sun_alt(lat, lon, te.astype('f8')); day = alt > -0.833
            # sky at the pair: cloud (oktas) at te, or radiation over the hour ending te
            N = np.full(H, np.nan, 'f4'); K = np.full(H, np.nan, 'f4'); pr = pairs.get(sid) or {}
            if pr.get('cloud') and pr['cloud'][0] in sun:
                d = sun[pr['cloud'][0]]; N = np.array([d.get(int(t), (np.nan, np.nan))[0] for t in te], 'f4')
            if pr.get('rad') and pr['rad'][0] in sun:
                d = sun[pr['rad'][0]]; Q = np.array([d.get(int(t), (np.nan, np.nan))[1] for t in te], 'f4')
                cz = np.sin(np.radians(sun_alt(lat, lon, (te - 1800).astype('f8')))); K = (Q / clearsky(cz)).astype('f4')
            # the full 10-min state, for drying times
            s10 = np.zeros(n, 'i1')
            for code, s in STATE.items(): s10[A[:, 0] == code] = s
            S.append(dict(sid=sid, year=y, county=meta.get('county') or '?', lat=lat, lon=lon, t0=t0, P=P.astype('f4'), T=T, Td=Td, Ts=Ts, G=G.astype('f4'), st=st, day=day,
                          N=N, K=K, s10=s10, p10=p10.astype('f4')))
    # radiation -> sun: the clearness cut that best matches cloud <= 6 oktas, on series that have both
    nn = np.concatenate([s['N'][s['day']] for s in S]); kk = np.concatenate([s['K'][s['day']] for s in S])
    ok = ~np.isnan(nn) & ~np.isnan(kk) & np.isfinite(kk); kcut = None
    if ok.sum() > 1000:
        yy = nn[ok] <= 6; xs = kk[ok]; cuts = np.arange(0.05, 1.0, 0.01)
        acc = [((xs >= c) == yy).mean() for c in cuts]; kcut = float(cuts[int(np.argmax(acc))])
        print(f'sun from radiation: clearness cut {kcut:.2f} matches cloud<=6 oktas in {max(acc):.1%} of {ok.sum()} daytime pair-hours')
    for s in S:
        sky = np.where(~np.isnan(s['N']), s['N'] <= 6, np.where(np.isfinite(s['K']) & (kcut is not None), s['K'] >= (kcut or 9), np.nan))
        sky = np.where(s['day'], sky, 0.0); sky = np.where(s['P'] >= 0.1, 0.0, sky)
        s['sun'] = np.where(np.isnan(s['N']) & ~np.isfinite(s['K']) & s['day'], np.nan, sky).astype('f4')
    # quality check
    keep = []
    for s in S:
        P, st = s['P'], s['st']; H = len(P)
        rain24 = np.convolve(np.nan_to_num(P) >= 0.1, np.ones(24), 'full')[:H] > 0
        noR = ~rain24 & (st > 0) & (st < 4); fwet = ((st[noR] >= 2) & (st[noR] <= 3)).mean() if noR.sum() > 100 else 1.0
        on = ~np.isnan(P); miss = (st[on] == 0).mean() if on.any() else 1.0; tot = np.nansum(P); why = None   # over the hours the gauge reported
        if on.sum() < 30 * 24: why = f'only {on.sum()} hours with rain data'
        elif tot < 5: why = f'no rain sensor ({tot:.1f} mm)'
        elif miss > 0.20: why = f'{miss:.0%} states missing'
        elif fwet > 0.15: why = f'moist/wet {fwet:.0%} of hours without rain in 24 h'
        if why: dropped.append((s['sid'], s['year'], why))
        else: s['fwet'] = float(fwet); keep.append(s)
    # events
    for s in keep:
        P, st, s10 = s['P'], s['st'], s['s10']; H = len(P)
        ice = (s['T'] <= 1) | (s['Ts'] <= 0.5)
        bad = np.isnan(P) | np.isnan(s['T']) | np.isnan(s['Td']) | ice
        R = np.nan_to_num(P) >= 0.1; ev = []
        for k in range(H - 1):
            if not R[k] or R[k + 1] or bad[k]: continue
            j = k; amt = 0.0
            while j >= 0 and R[j]: amt += P[j]; j -= 1
            # 10-min index of the end of hour k: te[k] = t0 + 3600(k+1) -> slot 6(k+1)
            e10 = 6 * (k + 1); nxt = next((q for q in range(k + 1, min(H, k + 1 + CAP_MIN // 60)) if R[q] or bad[q]), None)
            lim = min(len(s10) - 2, e10 + CAP_MIN // 10, (6 * nxt) if nxt is not None else 10 ** 9)   # rain/hole/ice in hour q starts at te[q]-1h = slot 6q
            Tobs = None; cens = lim - e10
            for q in range(e10, lim):
                if s10[q] == 0 or s10[q] == 4: cens = q - e10; break
                if s10[q] == 1 and s10[q + 1] == 1: Tobs = q - e10; break
            ev.append((k, amt, (Tobs * 10) if Tobs is not None else -1, (cens * 10) if Tobs is None else -1, int(s['day'][k])))
        s['ev'] = np.array(ev, 'f4').reshape(-1, 5)
    # station split: 20 % held out, stratified by county (fixed seed)
    rng = np.random.default_rng(20261007); bc = collections.defaultdict(set)
    for s in keep: bc[s['county']].add(s['sid'])
    hold = set()
    for cty, ss in sorted(bc.items()):
        ss = sorted(ss); m = int(round(0.2 * len(ss)))
        if len(ss) >= 2 and m == 0 and rng.random() < 0.2 * len(ss): m = 1
        hold |= set(rng.choice(ss, m, replace=False).tolist()) if m else set()
    L = max(len(s['P']) for s in keep); n = len(keep)
    def pad(key, fill, dtp): a = np.full((n, L), fill, dtp); [a.__setitem__((i, slice(0, len(s[key]))), s[key]) for i, s in enumerate(keep)]; return a
    evs = np.concatenate([np.column_stack([np.full(len(s['ev']), i), s['ev']]) for i, s in enumerate(keep)]) if keep else np.zeros((0, 6))
    np.savez_compressed(outf, P=pad('P', np.nan, 'f4'), T=pad('T', np.nan, 'f4'), Td=pad('Td', np.nan, 'f4'), Ts=pad('Ts', np.nan, 'f4'), G=pad('G', np.nan, 'f4'),
        st=pad('st', 0, 'i1'), day=pad('day', False, bool), sun=pad('sun', np.nan, 'f4'), ev=evs.astype('f4'),
        sid=np.array([s['sid'] for s in keep]), year=np.array([s['year'] for s in keep]), county=np.array([s['county'] for s in keep]),
        hold=np.array([s['sid'] in hold for s in keep]), lat=np.array([s['lat'] for s in keep]), lon=np.array([s['lon'] for s in keep]),
        t0=np.array([s['t0'] for s in keep]), kcut=np.array(kcut if kcut is not None else np.nan))
    summ = dict(series_in=len(S), series_kept=n, stations_kept=len({s['sid'] for s in keep}), held_out=sorted(hold), dropped=dropped, kcut=kcut,
                events=int(len(evs)), uncensored=int((evs[:, 3] >= 0).sum()) if len(evs) else 0)
    json.dump(summ, open(outf.replace('.npz', '_summary.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps({k: v for k, v in summ.items() if k != 'dropped'}, ensure_ascii=False)); print('dropped', len(dropped))
    for d in dropped: print('  ', *d)

if __name__ == '__main__':
    if sys.argv[1] == '--jobs': jobs(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == '--sunjobs': sunjobs(*sys.argv[2:6])
    else: main(*sys.argv[1:6])
