#!/usr/bin/env python3
"""The fixed-lag fallback (B1) in a form Kjørevær can ship, fitted on the same training data as fit.py.

  tools/wetroad/b1.py DATA.npz FIT.json OUT.json [--boot 200]

  lag[bin][day]     minutes the road counts as wet-or-moist after the end of the last rain hour: the event loss of fit.py
                    (the same lags fit.py reports as B1), bin = the spell's rain (consecutive hours >= 0.1 mm):
                    0.1-0.5, 0.5-2, 2-5, >= 5 mm; day = is_day at the end of the last rain hour
  wetLag[bin][day]  of that, the minutes it counts as 'wet' (the rest is 'moist'): the lag with the best hourly Peirce
                    score of wet vs not wet on the training post-rain hours (whole hours, the state is hourly)
  carry[lvl][day]   after an observed road state 'moist' or 'wet' at a time with no rain (Vegvesen / Trafikverket /
                    Fintraffic inside their horizon), the minutes until it is dry: the event loss on every training hour
                    with that state and no rain (hourly states; censored at rain, a hole, the ice regime, 48 h)
CIs: bootstrap by station. Scores of all three on both test sets.
"""
import json, sys, argparse, collections
import numpy as np
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import fit as F

GRID = np.arange(0, 1441, 10.0)

def lag_fit(T, C, unc, w):
    """the lag minimising the event loss (weighted)"""
    best = None
    for g in GRID:
        l = np.where(unc, np.abs(np.log((T + 10) / (g + 10))), np.where(g < C, np.abs(np.log((C + 10) / (g + 10))), 0.0))
        v = (l * w).sum()
        if best is None or v < best[0]: best = (v, g)
    return best[1]

def spell_amt(p):
    amt = np.zeros(len(p.hs)); P0 = np.nan_to_num(p.P); alive = p.hlast >= 0
    for j in range(48):
        k = p.hlast - j; r = P0[p.hs, np.maximum(k, 0)]; alive &= (k >= 0) & (r >= 0.1); amt += np.where(alive, r, 0)
    return amt

def carry_events(p, ice_ts):
    """(series, lvl 2/3, day, T_obs, censor) for each hour with an observed moist/wet state and no rain in it"""
    P0 = np.nan_to_num(p.P); R = P0 >= 0.1; bad = np.isnan(p.P) | np.isnan(p.T) | (p.T <= 1) | ice_ts
    out = []
    for s in range(p.n):
        st = p.st[s]; L = len(st)
        for h in np.flatnonzero(((st == 2) | (st == 3)) & ~R[s] & ~bad[s]):
            Tobs = -1; cens = -1
            for q in range(h + 1, min(L, h + 49)):
                if R[s, q] or bad[s, q] or st[q] == 0 or st[q] == 4: cens = (q - 1 - h) * 60; break
                if st[q] == 1: Tobs = (q - h) * 60; break
            else: cens = 48 * 60
            out.append((s, st[h], int(p.day[s, h]), Tobs, cens))
    return np.array(out, float).reshape(-1, 5)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('data'); ap.add_argument('fit'); ap.add_argument('out'); ap.add_argument('--boot', type=int, default=200); a = ap.parse_args()
    D = dict(np.load(a.data)); F.lib(); yr, hold = D['year'], D['hold']
    packs = {n: F.Pack(D, m, n) for n, m in (('train', ~hold & (yr <= 2024)), ('test_time', ~hold & (yr >= 2025)), ('test_space', hold))}
    tr = packs['train']; sids = sorted(set(tr.sid)); rng = np.random.default_rng(7)
    ice = {n: (D['Ts'][p.sel] <= 0.5) for n, p in packs.items()}
    CE = {n: carry_events(p, ice[n]) for n, p in packs.items()}
    pre = {n: (spell_amt(p), p.day[p.hs, np.maximum(p.hlast, 0)].astype(bool)) for n, p in packs.items()}

    def fit_all(w_st):
        ws = np.array([w_st.get(s, 0) for s in tr.sid], float)
        b = F.b1_bin(tr.eamt, tr.eday.astype(bool)); lag = np.full(8, np.nan)
        for i in range(8):
            m = b == i
            if m.any(): lag[i] = lag_fit(tr.eT[m], tr.ec[m], tr.unc[m], ws[tr.es[m]])
        amt, dayk = pre['train']; hb = F.b1_bin(amt, dayk); ow = tr.hst == 3; wl = np.full(8, np.nan); hw = ws[tr.hs]
        for i in range(8):
            m = (hb == i) & (hw > 0)
            if not m.any(): continue
            best = None
            for g in np.arange(0, lag[i] + 1, 60.0):
                pr = (tr.hsince[m] * 60) <= g; o = ow[m]; w = hw[m]
                pod = (w * (pr & o)).sum() / max((w * o).sum(), 1e-9); pofd = (w * (pr & ~o)).sum() / max((w * ~o).sum(), 1e-9)
                if best is None or pod - pofd > best[0] + 1e-9: best = (pod - pofd, g)
            wl[i] = best[1]
        c = CE['train']; cw = ws[c[:, 0].astype(int)]; carry = {}
        for lvl in (2, 3):
            for d in (0, 1):
                m = (c[:, 1] == lvl) & (c[:, 2] == d)
                carry[(lvl, d)] = lag_fit(c[m, 3], c[m, 4], c[m, 3] >= 0, cw[m]) if m.any() else np.nan
        return lag, wl, carry
    lag, wl, carry = fit_all({s: 1 for s in sids})
    B = []
    for i in range(a.boot):
        cnt = collections.Counter(rng.choice(sids, len(sids), replace=True)); l, w, c = fit_all(cnt); B.append((l, w, [c[(2, 0)], c[(2, 1)], c[(3, 0)], c[(3, 1)]]))
    ci = lambda arr: np.percentile(np.array(arr), [2.5, 97.5], axis=0).T.tolist()
    names = [f'{lo}-{hi}mm' for lo, hi in zip(F.BINS[:-1], ['0.5', '2', '5', 'inf'])]
    # scores
    def score(n):
        p = packs[n]; amt, dayk = pre[n]; hb = F.b1_bin(amt, dayk); since = p.hsince * 60
        lvl = np.where(since <= np.nan_to_num(wl[hb]), 3, np.where(since <= np.nan_to_num(lag[hb]), 2, 1))
        obs = p.hst; c = CE[n]; u = c[:, 3] >= 0
        cl = np.array([carry[(int(a_), int(d_))] for a_, d_ in zip(c[:, 1], c[:, 2])])
        return dict(pss_wet_or_moist=F.pss(lvl >= 2, obs >= 2), pss_wet=F.pss(lvl == 3, obs == 3), acc3=float((lvl == obs).mean()),
                    carry=dict(events=int(len(c)), uncensored=int(u.sum()), mdae_min=float(np.median(np.abs(cl[u] - c[u, 3]))) if u.any() else None,
                               mdae_min_if_dry_at_once=float(np.median(c[u, 3])) if u.any() else None,
                               median_obs_min={f'{"moist" if l_ == 2 else "wet"}_{"day" if d_ else "night"}': float(np.median(c[u & (c[:, 1] == l_) & (c[:, 2] == d_), 3])) for l_ in (2, 3) for d_ in (0, 1)}))
    fitres = json.load(open(a.fit))
    res = dict(bins_mm=F.BINS[:-1], lag_min={names[i // 2] + ('_day' if i % 2 else '_night'): lag[i] for i in range(8)},
               lag_ci95={names[i // 2] + ('_day' if i % 2 else '_night'): ci([b[0] for b in B])[i] for i in range(8)},
               wetLag_min={names[i // 2] + ('_day' if i % 2 else '_night'): wl[i] for i in range(8)},
               wetLag_ci95={names[i // 2] + ('_day' if i % 2 else '_night'): ci([b[1] for b in B])[i] for i in range(8)},
               carry_min={'moist_night': carry[(2, 0)], 'moist_day': carry[(2, 1)], 'wet_night': carry[(3, 0)], 'wet_day': carry[(3, 1)]},
               carry_ci95=dict(zip(['moist_night', 'moist_day', 'wet_night', 'wet_day'], ci([b[2] for b in B]))),
               scores={n: score(n) for n in packs}, same_as_fit_B1=bool(np.allclose(lag, list(fitres['B1_lags_min'].values()))))
    json.dump(res, open(a.out, 'w'), indent=1); print(json.dumps(res, indent=1))

if __name__ == '__main__':
    main()
