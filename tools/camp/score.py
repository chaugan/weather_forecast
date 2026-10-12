# Nattplass: rule-based score for a candidate (no learned weights; a sample of known spots only measures recall, see build.py).
# Every rule adds points and a reason flag the page can show. Input: dict-of-numpy-arrays from feat.parquet.
import numpy as np

def nz(a, v):
    a = np.asarray(a, dtype=float); return np.where(np.isnan(a), v, a)

def score(F, pad=None):
    n = len(F['id']); s = np.zeros(n)
    dl, dr, dc = nz(F['d_lake'], 1e4), nz(F['d_river'], 1e4), nz(F['d_coast'], 1e4)
    dw = np.minimum(np.minimum(dl, dr), dc)
    wk = np.where(dc == dw, 2, np.where(dl == dw, 1, 3))          # 1 lake, 2 sea, 3 river
    w = np.select([dw <= 40, dw <= 80, dw <= 150, dw <= 300], [30, 25, 18, 8], 0).astype(float)
    w = np.where(wk == 3, w * 0.8, w)
    area = nz(F['lake_area'], 0)
    w += np.where((wk == 1) & (dw <= 150), np.select([area >= 1e6, area >= 5e4], [7, 4], 0), 0)
    s += w
    db, nb = nz(F['d_build'], 2000), nz(F['nb500'], 0)
    s += np.select([db >= 300, db >= 150, db >= 80], [15, 10, 3], 0)
    s += np.select([nb == 0, nb <= 3, nb <= 10], [10, 7, 3], 0)
    dm = np.minimum(nz(F['d_major'], 5000), nz(F['d_sec'], 5000) * 1.5)
    s += np.select([dm >= 2000, dm >= 800, dm >= 300], [10, 7, 3], 0)
    stop = nz(F['d_stop'], 999) <= 40; ostop = nz(F['d_ostop'], 999) <= 40
    s += np.where(stop | ostop, 12, 0)
    s += np.where(nz(F['d_picnic'], 999) <= 200, 4, 0) + np.where(nz(F['d_wpoi'], 999) <= 150, 5, 0)
    s -= np.where(np.asarray(F['tt'], dtype=object) == 'grade4', 6, 0)
    if pad is not None:
        p = nz(pad, -1)
        s += np.select([p >= 150, p >= 60, (p >= 0) & (p < 40)], [15, 8, -20], 0)
    return s, dw, wk
