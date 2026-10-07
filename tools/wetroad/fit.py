#!/usr/bin/env python3
"""Fits Kjørevær's wet-road bucket (js/route.js WR) on Statens vegvesen road-surface states from Frost (prep.py output).

  tools/wetroad/fit.py DATA.npz OUT.json [--starts 20] [--boot 100] [--procs 10] [--fi DIR]

The model (the same in route.js), per hour k, W = water on the road in mm:
  W_k = max(0, min(Wmax, W_{k-1} + P_k) - E_k)
  E_k = e0 * (1 + aT*max(0,T_k)) * (1 + aD*max(0,D_k)) * (1 + aG*G_k) * (sun_k ? sSun : day_k ? sDay : 1),  D = T - Td
  E_k = 0 when D_k < dCond (air near saturation: the road does not dry)
  W >= thWet: wet, W >= thMoist: moist, else dry. G_k missing -> G_ref.
Loss: the event drying time, |ln((T_obs+10)/(T_hat+10))| (minutes) for events that dried; for censored ones only when the
model dries before the censor time; plus 0.2 x the hourly log-loss of (>= moist) and (wet) on post-rain hours (no rain in the
hour, rain in the 12 h before), through a logistic in ln W with a fitted slope (a nuisance, not shipped), which anchors the
two thresholds. Nelder-Mead from N random starts; scales and thresholds on a log scale, the a-terms linear so a wrong sign
can show. CIs: bootstrap by station. A term with the wrong sign or a 95 % CI that holds 0 is fixed to 0 (sDay/sSun to 1;
sSun to sDay when only the sun part fails) and the model refitted: dropped, not guessed.
Splits: train = stations not held out, 2022-2024; test 'time' = the same stations 2025-2026; test 'space' = the held-out
stations (prep.py: 20 %, by county), every year. Baselines: B0 dry as soon as the rain stops; B1 a fixed lag per rain-amount
bin and day/night, fitted with the same event loss on the same training data.
"""
import json, os, sys, time, ctypes, subprocess, tempfile, argparse, collections, datetime as dt
import numpy as np
from scipy.optimize import minimize

C_SRC = r'''
#include <math.h>
/* the bucket over n series of L hours; prm: Wmax e0 aT aD aG sDay sSun dCond Gref pisun */
void bucket(int n, int L, const float*P, const float*T, const float*Td, const float*G, const unsigned char*day, const float*sun, const double*prm, float*W, float*CE) {
  double Wmax=prm[0],e0=prm[1],aT=prm[2],aD=prm[3],aG=prm[4],sD=prm[5],sS=prm[6],dC=prm[7],Gr=prm[8],pi=prm[9];
  double fD=sD, fU=pi*sS+(1-pi)*sD;   /* day factor when the sky is not known: the sunny share of daytime hours */
  for (int s=0;s<n;s++) { double w=0, ce=0; const int o=s*L;
    for (int k=0;k<L;k++) { int i=o+k; double p=P[i]; if (p!=p) p=0;
      double t=T[i], d=t-Td[i], g=G[i]; if (g!=g) g=Gr;
      double e=0;
      if (t==t && d==d && d>=dC) {
        double m1=1+aT*(t>0?t:0), m2=1+aD*(d>0?d:0), m3=1+aG*g; if(m1<0.05)m1=0.05; if(m2<0.05)m2=0.05; if(m3<0.05)m3=0.05;
        double f = day[i] ? (sun[i]!=sun[i] ? fU : (sun[i]>0.5 ? sS : fD)) : 1;
        e=e0*m1*m2*m3*f; }
      w+=p; if (w>Wmax) w=Wmax; w-=e; if (w<0) w=0; W[i]=(float)w; ce+=e; CE[i]=(float)ce; } } }
'''
_lib = None
def lib():
    global _lib
    if _lib is None:
        # Build fresh into a private (0700) directory each run: a fixed name under a shared temp dir could be pre-planted.
        d = tempfile.mkdtemp(prefix='wetroad_bucket_')
        c, so = os.path.join(d, 'b.c'), os.path.join(d, 'b.so')
        with open(c, 'w') as fh: fh.write(C_SRC)
        subprocess.check_call(['gcc', '-O2', '-shared', '-fPIC', '-o', so, c, '-lm'])
        _lib = ctypes.CDLL(so); _lib.bucket.restype = None
        import atexit, shutil; atexit.register(shutil.rmtree, d, True)
    return _lib

NAMES = ['Wmax', 'e0', 'aT', 'aD', 'aG', 'sDay', 'sSun', 'dCond', 'thMoist', 'thWet', 'k']
# x: free coordinates; tr: x -> model values. Scales chosen so one Nelder-Mead step of ~0.3 means something in each.
def to_vals(x):
    return dict(Wmax=float(np.exp(x[0])), e0=float(np.exp(x[1])), aT=x[2] / 10, aD=x[3] / 10, aG=x[4] / 10, sDay=float(np.exp(x[5])),
                sSun=float(np.exp(x[5] + x[6])), dCond=x[7], thMoist=float(np.exp(x[8])), thWet=float(np.exp(x[8]) + np.exp(x[9])), k=float(np.exp(x[10])))
def from_vals(v):
    return np.array([np.log(v['Wmax']), np.log(v['e0']), v['aT'] * 10, v['aD'] * 10, v['aG'] * 10, np.log(v['sDay']), np.log(v['sSun'] / v['sDay']),
                     v['dCond'], np.log(v['thMoist']), np.log(max(1e-6, v['thWet'] - v['thMoist'])), np.log(v['k'])])
DROP_X = {'aT': (2, 0.0), 'aD': (3, 0.0), 'aG': (4, 0.0), 'sDay': (5, 0.0), 'sSun': (6, 0.0), 'dCond': (7, 0.0)}   # term -> (x index, value when dropped)

class Pack:
    """a subset of series, with its events and post-rain hours, ready for the kernel"""
    def __init__(self, D, sel, name):
        self.name = name; self.sel = np.flatnonzero(sel); s = self.sel; self.n, self.L = len(s), D['P'].shape[1]
        c = lambda a, t: np.ascontiguousarray(a[s], t)
        self.P, self.T, self.Td, self.G, self.sun = c(D['P'], 'f4'), c(D['T'], 'f4'), c(D['Td'], 'f4'), c(D['G'], 'f4'), c(D['sun'], 'f4')
        self.day = c(D['day'], 'u1'); self.st = D['st'][s]; self.sid = D['sid'][s]
        self.W = np.zeros((self.n, self.L), 'f4'); self.CE = np.zeros_like(self.W)
        # events of these series (prep columns: series, k_end, amount, T_obs, censor, day)
        m = np.isin(D['ev'][:, 0].astype(int), s); e = D['ev'][m]; pos = {g: i for i, g in enumerate(s)}
        self.es = np.array([pos[int(g)] for g in e[:, 0]], int); self.ek = e[:, 1].astype(int); self.eamt = e[:, 2]; self.eT = e[:, 3]; self.ec = e[:, 4]; self.eday = e[:, 5]
        self.unc = self.eT >= 0
        cols = self.ek[:, None] + np.arange(0, 50)[None, :]; self.ecols = np.minimum(cols, self.L - 1); self.eix = self.es[:, None] * self.L + self.ecols
        # post-rain hours: no rain in the hour, rain in the 12 h before, a dry/moist/wet state, not the ice regime, inputs there
        P0 = np.nan_to_num(self.P); R = P0 >= 0.1
        last = np.full(self.n, -10 ** 6)
        lastk = np.full((self.n, self.L), -10 ** 6, int)
        for k in range(self.L):
            last = np.where(R[:, k], k, last); lastk[:, k] = last
        since = np.arange(self.L)[None, :] - np.concatenate([np.full((self.n, 1), -10 ** 6), lastk[:, :-1]], 1)   # hours since the last rain hour before k
        ice = (self.T <= 1) | (D['Ts'][s] <= 0.5)
        ok = ~R & (since >= 1) & (since <= 12) & (self.st >= 1) & (self.st <= 3) & ~ice & ~np.isnan(self.P) & ~np.isnan(self.T) & ~np.isnan(self.Td)
        self.hs, self.hk = np.nonzero(ok); self.hix = self.hs * self.L + self.hk; self.hst = self.st[ok]; self.hsince = since[ok]
        lk = np.concatenate([np.full((self.n, 1), -1), lastk[:, :-1]], 1)[ok]; self.hlast = lk   # the rain hour that ended that spell
        self.w_s = np.ones(self.n)   # series weights (bootstrap)
    def run(self, v, Gref, pisun):
        prm = (ctypes.c_double * 10)(v['Wmax'], v['e0'], v['aT'], v['aD'], v['aG'], v['sDay'], v['sSun'], v['dCond'], Gref, pisun)
        f = lambda a, t: a.ctypes.data_as(ctypes.POINTER(t))
        lib().bucket(self.n, self.L, f(self.P, ctypes.c_float), f(self.T, ctypes.c_float), f(self.Td, ctypes.c_float), f(self.G, ctypes.c_float),
                     f(self.day, ctypes.c_ubyte), f(self.sun, ctypes.c_float), prm, f(self.W, ctypes.c_float), f(self.CE, ctypes.c_float))
    def that(self, th):
        """model drying time (min) per event: W below thMoist, interpolated within the hour; 48 h+ if never"""
        Wf = self.W.ravel()[self.eix]; below = Wf < th
        q = np.where(below.any(1), below.argmax(1), 49)
        w1 = Wf[np.arange(len(q)), np.maximum(q - 1, 0)]; w2 = Wf[np.arange(len(q)), q]
        frac = np.where(q > 0, np.clip((w1 - th) / np.maximum(w1 - w2, 1e-9), 0, 1), 0)
        return np.where(q == 0, 0.0, (q - 1 + frac) * 60.0)

def ev_loss(Th, p, w=None):
    lu = np.abs(np.log((p.eT + 10) / (Th + 10))); lc = np.where(Th < p.ec, np.abs(np.log((p.ec + 10) / (Th + 10))), 0.0)
    l = np.where(p.unc, lu, lc); ww = p.w_s[p.es] if w is None else w
    return float((l * ww).sum() / max(ww.sum(), 1e-9))

def sig(z): return 1 / (1 + np.exp(-np.clip(z, -30, 30)))
def hour_loss(p, v):
    lw = np.log(p.W.ravel()[p.hix] + 0.01); pm = np.clip(sig(v['k'] * (lw - np.log(v['thMoist'] + 0.01))), 1e-6, 1 - 1e-6); pw = np.clip(sig(v['k'] * (lw - np.log(v['thWet'] + 0.01))), 1e-6, 1 - 1e-6)
    ym = p.hst >= 2; yw = p.hst == 3
    l = -(ym * np.log(pm) + (~ym) * np.log(1 - pm)) - (yw * np.log(pw) + (~yw) * np.log(1 - pw)); ww = p.w_s[p.hs]
    return float((l * ww).sum() / max(ww.sum(), 1e-9))

def objective(x, p, fixed, G):
    xx = fixed.copy(); xx[np.isnan(fixed)] = x; v = to_vals(xx)
    if not (0.02 <= v['Wmax'] <= 20 and 1e-4 <= v['e0'] <= 5 and -0.5 <= v['dCond'] <= 6 and v['thMoist'] < v['Wmax'] and 0.1 <= v['k'] <= 30): return 50.0
    p.run(v, G['Gref'], G['pisun'])
    return ev_loss(p.that(v['thMoist']), p) + 0.2 * hour_loss(p, v)

def fit(p, fixed, G, starts, seed, x0s=None, maxfev=4000):
    rng = np.random.default_rng(seed); best = None; free = np.isnan(fixed)
    X = list(x0s or [])
    while len(X) < starts:
        v = dict(Wmax=np.exp(rng.uniform(np.log(0.3), np.log(5))), e0=np.exp(rng.uniform(np.log(0.02), np.log(0.5))), aT=rng.uniform(0, 0.1), aD=rng.uniform(0, 0.3), aG=rng.uniform(0, 0.1),
                 sDay=rng.uniform(1, 3), sSun=0, dCond=rng.uniform(0, 2), thMoist=np.exp(rng.uniform(np.log(0.01), np.log(0.3))), thWet=0, k=rng.uniform(1, 5))
        v['sSun'] = v['sDay'] * rng.uniform(1, 2); v['thWet'] = v['thMoist'] + np.exp(rng.uniform(np.log(0.05), np.log(1))); X.append(from_vals(v))
    for x0 in X:
        x0 = x0[free]; simp = np.vstack([x0] + [x0 + 0.4 * np.eye(len(x0))[i] for i in range(len(x0))])
        r = minimize(objective, x0, args=(p, fixed, G), method='Nelder-Mead', options=dict(maxfev=maxfev, xatol=1e-3, fatol=1e-5, adaptive=True, initial_simplex=simp))
        if best is None or r.fun < best.fun: best = r
    xx = fixed.copy(); xx[free] = best.x; return xx, best.fun

# baselines -------------------------------------------------------------------------------------------------------------
BINS = [0.1, 0.5, 2, 5, 1e9]
def b1_bin(amt, day): return np.clip(np.searchsorted(BINS, amt, 'right') - 1, 0, 3) * 2 + day.astype(int)
def fit_b1(p):
    b = b1_bin(p.eamt, p.eday); lags = np.zeros(8); grid = np.arange(0, 1441, 10.0)
    for i in range(8):
        m = b == i
        if not m.any(): lags[i] = np.nan; continue
        L = [ev_loss_sub(np.full(m.sum(), g), p, m) for g in grid]; lags[i] = grid[int(np.argmin(L))]
    return lags
def ev_loss_sub(Th, p, m):
    eT, ec, unc = p.eT[m], p.ec[m], p.unc[m]
    l = np.where(unc, np.abs(np.log((eT + 10) / (Th + 10))), np.where(Th < ec, np.abs(np.log((ec + 10) / (Th + 10))), 0.0)); return float(l.mean())
def b1_hours(p, lags):
    """B1's call on each post-rain hour: wet-or-moist while the time since the spell's last rain hour < its lag"""
    amt = np.zeros(len(p.hs)); P0 = np.nan_to_num(p.P); alive = p.hlast >= 0
    for j in range(48):   # the rain of the spell that ended at hlast: back over consecutive rain hours
        k = p.hlast - j; r = P0[p.hs, np.maximum(k, 0)]; alive &= (k >= 0) & (r >= 0.1); amt += np.where(alive, r, 0)
    dayk = p.day[p.hs, np.maximum(p.hlast, 0)].astype(bool)
    lag = np.nan_to_num(lags[b1_bin(amt, dayk)]); return (p.hsince * 60) <= lag   # the state at the end of hour k: (k - k_end) h after the rain

# metrics ---------------------------------------------------------------------------------------------------------------
def pss(pred, obs):
    pod = (pred & obs).sum() / max(obs.sum(), 1); pofd = (pred & ~obs).sum() / max((~obs).sum(), 1); return float(pod - pofd), float(pod), float(pofd)
def metrics(p, v, G, lags):
    p.run(v, G['Gref'], G['pisun']); Th = p.that(v['thMoist']); u = p.unc
    Wh = p.W.ravel()[p.hix]; obs = p.hst >= 2
    mdl = Wh >= v['thMoist']; b1 = b1_hours(p, lags)
    cls = np.where(Wh >= v['thWet'], 3, np.where(Wh >= v['thMoist'], 2, 1))
    b1T = np.nan_to_num(lags[b1_bin(p.eamt, p.eday.astype(bool))])
    r = dict(series=int(p.n), stations=int(len(set(p.sid))), events=int(len(p.eT)), events_uncensored=int(u.sum()), post_rain_hours=int(len(p.hs)),
             wet_share_post_rain=float(obs.mean()),
             mdae_min=dict(model=float(np.median(np.abs(Th[u] - p.eT[u]))), B0=float(np.median(np.abs(0 - p.eT[u]))), B1=float(np.median(np.abs(b1T[u] - p.eT[u])))),
             mae_min=dict(model=float(np.mean(np.abs(Th[u] - p.eT[u]))), B0=float(np.mean(p.eT[u])), B1=float(np.mean(np.abs(b1T[u] - p.eT[u])))),
             event_loss=dict(model=ev_loss(Th, p, np.ones(len(Th))), B0=ev_loss(np.zeros(len(Th)), p, np.ones(len(Th))), B1=ev_loss(b1T, p, np.ones(len(Th)))),
             pss=dict(model=pss(mdl, obs), B0=pss(np.zeros_like(obs), obs), B1=pss(b1, obs)),
             acc3_model=float((cls == p.hst).mean()), obs_median_dry_min=float(np.median(p.eT[u])) if u.any() else None)
    r['pass'] = bool(r['pss']['model'][0] >= r['pss']['B1'][0] + 0.05 and r['mdae_min']['model'] <= 0.8 * r['mdae_min']['B1'])
    return r

BG = {}   # the data for the bootstrap workers (inherited through fork, not pickled per task)
def boot_one(args):
    fixed, G, x0, seed = args; D, trsel = BG['D'], BG['trsel']
    rng = np.random.default_rng(seed); p = Pack(D, trsel, 'boot'); st = sorted(set(p.sid)); draw = rng.choice(st, len(st), replace=True)
    c = collections.Counter(draw); p.w_s = np.array([c.get(s, 0) for s in p.sid], float)
    xx, f = fit(p, fixed, G, 1, seed, [x0], maxfev=2500); return xx

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('data'); ap.add_argument('out'); ap.add_argument('--starts', type=int, default=20); ap.add_argument('--boot', type=int, default=100)
    ap.add_argument('--procs', type=int, default=10); ap.add_argument('--fi'); ap.add_argument('--summary'); a = ap.parse_args()
    D = dict(np.load(a.data)); t0 = time.time(); lib()
    yr, hold = D['year'], D['hold']
    trsel = ~hold & (yr <= 2024); tts = ~hold & (yr >= 2025); tsp = hold
    tr, te_t, te_s = Pack(D, trsel, 'train'), Pack(D, tts, 'test_time'), Pack(D, tsp, 'test_space')
    Gv = tr.G[tr.hs, tr.hk]; Gref = float(np.nanmedian(Gv)) if np.isfinite(Gv).any() else 8.0
    sv = tr.sun[tr.day.astype(bool) & ~np.isnan(tr.sun)]; pisun = float(sv.mean()) if len(sv) else 0.5
    G = dict(Gref=Gref, pisun=pisun)
    info = dict(train=dict(series=tr.n, stations=len(set(tr.sid)), events=len(tr.eT), uncensored=int(tr.unc.sum()), post_rain_hours=len(tr.hs)),
                Gref=Gref, pisun=pisun, sun_known_share=float((~np.isnan(tr.sun[tr.day.astype(bool)])).mean()))
    print(json.dumps(info)); sys.stdout.flush()
    lags = fit_b1(tr); print('B1 lags (min) [amount bin x night/day]', lags.tolist()); sys.stdout.flush()
    enough = info['train']['stations'] >= 40 and info['train']['events'] >= 1500
    fixed = np.full(len(NAMES), np.nan); dropped = {}
    sun_ok = sum(1 for s in set(tr.sid) if (~np.isnan(tr.sun[tr.sid == s])).any()) >= 30
    if not sun_ok: fixed[6] = 0.0; dropped['sSun'] = 'fewer than 30 training stations with a cloud/radiation pair: sSun = sDay'
    from multiprocessing import get_context; Pool = get_context("fork").Pool   # fork: the workers inherit the data (BG)
    boots = None
    for rnd in range(3):
        xx, f = fit(tr, fixed, G, a.starts if rnd == 0 else max(4, a.starts // 4), 1000 + rnd, None if rnd == 0 else [np.where(np.isnan(fixed), xx, fixed)])
        print(f'round {rnd}: loss {f:.4f}', {k: round(v, 4) for k, v in to_vals(xx).items()}, f'{time.time() - t0:.0f}s'); sys.stdout.flush()
        BG.update(D=D, trsel=trsel)
        with Pool(a.procs) as pool: boots = np.array(pool.map(boot_one, [(fixed, G, xx, 5000 + 100 * rnd + i) for i in range(a.boot)]))
        ci = {n: (float(np.percentile(boots[:, i], 2.5)), float(np.percentile(boots[:, i], 97.5))) for n, (i, _) in DROP_X.items()}
        print('  bootstrap 95% CI (x scale):', {k: tuple(round(c, 3) for c in v) for k, v in ci.items()}, f'{time.time() - t0:.0f}s'); sys.stdout.flush()
        new = False
        for n, (i, val) in DROP_X.items():
            if not np.isnan(fixed[i]): continue
            if xx[i] <= 0 or ci[n][0] <= 0: fixed[i] = val; dropped[n] = f'value {xx[i]:.3f} (x scale), 95% CI {ci[n][0]:.3f}..{ci[n][1]:.3f}: ' + ('wrong sign' if xx[i] <= 0 else 'holds 0'); new = True
        if not new: break
    v = to_vals(xx); cis = {}
    for n in NAMES:
        vals = [to_vals(b)[n] for b in boots]; cis[n] = (float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5)))
    res = dict(values=v, ci95=cis, dropped=dropped, Gref=Gref, pisun=pisun, B1_lags_min=dict(zip([f'{lo}-{hi}mm_{"day" if d else "night"}' for lo, hi in zip(BINS[:-1], BINS[1:]) for d in (0, 1)], lags.tolist())),
               info=info, enough_data=enough)
    res['metrics'] = {pk.name: metrics(pk, v, G, lags) for pk in (tr, te_t, te_s)}
    res['success'] = bool(enough and res['metrics']['test_time']['pass'] and res['metrics']['test_space']['pass'])
    if a.fi:   # Finland from the collector (collect.py) as a third test set, once it holds three months
        import check_fi
        S = check_fi.load(a.fi); span = (max(max(v) for s in S.values() for v in s['s'].values() if v) - min(min(v) for s in S.values() for v in s['s'].values() if v)) / 1440
        res['metrics']['test_fi'] = dict(days=round(span, 1), **(check_fi.score(check_fi.build(S), res) if span >= 90 else {'skipped': 'less than 3 months collected'}))
    res['seconds'] = round(time.time() - t0)
    json.dump(res, open(a.out, 'w'), indent=1); print(json.dumps(res['metrics'], indent=1)); print('success', res['success'], 'dropped', dropped)

if __name__ == '__main__':
    main()
