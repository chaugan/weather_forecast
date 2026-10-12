# Nattplass, Sweden: tree height from Skogsstyrelsen's "Trädhöjd Laserdata skog" (1 m, decimetres, Int16, from Lantmäteriet's
# forest laser scans 2018 on; open data on Skogsstyrelsen's public FTPS server, user and password published on
# skogsstyrelsen.se/sjalvservice/karttjanster/geodatatjanster/ftp/). Files are MRF tiles of 2.5 km (SWEREF99 TM, EPSG:3006)
# in folders per scan year, each with a small .idx (offset, size per 128 x 128 page) and a LERC-compressed .lrc; only the
# pages around a point are read (FTP REST). Decoding needs the "lerc" package's library (tools/camp/.venv, see build.sh).
#   python3 thl.py index        list the server once -> cache/thl/index.json {"N_E": "folder/file stem"} (newest scan wins)
#   win(x0, y0, x1, y1)         tree height in metres per 1 m cell (nan where the tile is missing)
import os, re, io, json, threading, ftplib, sys, time
import numpy as np

HOST, USER, PASS = 'ftpsks.skogsstyrelsen.se', 'SGD', '0N!nd=I9EJ'   # published on Skogsstyrelsen's FTP page
ROOT = 'Tradhojd_LaserdataSkog'
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'thl')
T, P = 2500, 128            # tile size (m), page size (cells)
NP = T // P + 1             # pages per row of a full tile (2500 / 128 -> 20, the last one partial)

_local = threading.local()
def ftp():
    f = getattr(_local, 'f', None)
    if f is None:
        f = ftplib.FTP_TLS(HOST, timeout=60); f.login(USER, PASS); f.prot_p(); f.encoding = 'utf-8'
        _local.f = f
    return f

def reset():
    try: _local.f.close()
    except Exception: pass
    _local.f = None

def read(path, off, size):
    for k in range(4):
        try:
            f = ftp(); out = bytearray()
            with f.transfercmd('RETR ' + path, rest=off) as c:
                while len(out) < size:
                    b = c.recv(min(65536, size - len(out)))
                    if not b: break
                    out += b
            try: f.voidresp()
            except ftplib.error_temp: pass   # 426: we closed the transfer early, as intended
            except Exception: reset()
            return bytes(out)
        except Exception:
            reset(); time.sleep(2 + 3 * k)
    raise RuntimeError('ftp')

def build_index():
    """walk the year folders (names come back without their path) and keep the newest scan per 2.5 km tile"""
    f = ftp(); idx = {}; found = []
    def ls(d):
        try: return f.nlst(d)
        except ftplib.error_perm: return []
    stack = [ROOT + '/' + n for n in ls(ROOT) if re.fullmatch(r'\d{4}|Omdrev ?\d', n)]
    while stack:
        d = stack.pop()
        for n in ls(d):
            if n.endswith('.mrf'): found.append(d + '/' + n)
            elif '.' not in n: stack.append(d + '/' + n)
    for n in found:
        m = re.search(r'THL_[^_]+_(\d+)_(\d+)_(\d{4})\.mrf$', n)
        if not m: continue
        k = f'{int(m.group(1)) * 100 // T}_{int(m.group(2)) * 100 // T}'   # tile corner in 2.5 km units
        yr = int(m.group(3))
        if k not in idx or yr >= idx[k][1]: idx[k] = (n[:-4], yr)
    os.makedirs(D, exist_ok=True)
    json.dump({k: v[0] for k, v in idx.items()}, open(f'{D}/index.json', 'w'))
    return len(found), len(idx)

_IDX = None; _PAGES = {}; _LOCK = threading.Lock()
def tile_pages(stem):
    with _LOCK:
        if stem in _PAGES: return _PAGES[stem]
    f = f'{D}/idx/' + stem.replace('/', '_') + '.idx'
    if os.path.exists(f): b = open(f, 'rb').read()
    else:
        out = io.BytesIO()
        for k in range(4):
            try: ftp().retrbinary('RETR ' + stem + '.idx', out.write); break
            except Exception: reset(); out = io.BytesIO(); time.sleep(2 + 3 * k)
        b = out.getvalue(); os.makedirs(f'{D}/idx', exist_ok=True); open(f, 'wb').write(b)
    pages = np.frombuffer(b, '>u8').reshape(-1, 2).astype(np.int64)   # (offset, size) per page
    with _LOCK:
        _PAGES[stem] = pages
        if len(_PAGES) > 4000: _PAGES.pop(next(iter(_PAGES)))       # oldest first; the .idx files stay on disk
    return pages

_META = {}
def tile_meta(stem, tn, te):
    """(west edge, north edge, width, height, pages per row) of a tile: a full tile is 2500 x 2500 cells (459 index entries
    with the overviews); a cut one, at the coast or the border, says its size in its .mrf header"""
    if len(tile_pages(stem)) == 459: return te * T, (tn + 1) * T, T, T, NP - 1 if T % P == 0 else NP
    with _LOCK:
        if stem in _META: return _META[stem]
    f = f'{D}/idx/' + stem.replace('/', '_') + '.mrf'
    if os.path.exists(f): x = open(f, encoding='utf-8', errors='replace').read()
    else:
        out = io.BytesIO()
        for k in range(4):
            try: ftp().retrbinary('RETR ' + stem + '.mrf', out.write); break
            except Exception: reset(); out = io.BytesIO(); time.sleep(2 + 3 * k)
        x = out.getvalue().decode('utf-8', 'replace'); open(f, 'w').write(x)
    w, h = (int(v) for v in re.search(r'<Size x="(\d+)" y="(\d+)"', x).groups())
    bb = dict(re.findall(r'(minx|miny|maxx|maxy)="([^"]+)"', x))
    m = (round(float(bb['minx'])), round(float(bb['maxy'])), w, h, -(-w // P))
    with _LOCK: _META[stem] = m
    return m

_DEC = None
def decode(b):
    """one 128 x 128 Int16 page; the C function is called directly, because the lerc package's Python wrapper leaks a few KB
    a call (its ctypes buffers), which adds up to gigabytes over a country"""
    global _DEC
    if _DEC is None:
        import ctypes as ct, lerc
        fn = ct.CDLL(os.path.join(os.path.dirname(lerc.__file__), 'libLerc.so.4')).lerc_decode_4D
        fn.restype = ct.c_uint
        fn.argtypes = (ct.c_char_p, ct.c_uint, ct.c_int, ct.c_void_p, ct.c_int, ct.c_int, ct.c_int, ct.c_int, ct.c_uint,
                       ct.c_void_p, ct.c_void_p, ct.c_void_p)
        _DEC = fn
    out = np.empty((P, P), np.int16); mask = np.empty((P, P), np.uint8); hnd = np.zeros(1, np.uint8); nd = np.zeros(1, np.float64)
    r = _DEC(b, len(b), 1, mask.ctypes.data, 1, P, P, 1, 2, out.ctypes.data, hnd.ctypes.data, nd.ctypes.data)   # 2 = Int16
    if r: raise ValueError(f'lerc {r}')
    a = out.astype(np.float32); a[(mask == 0) | (out < 0)] = np.nan
    if hnd[0]: a[out == nd[0]] = np.nan
    return a / 10

def pages(stem, ids):
    """decoded pages (tree height in m) of one tile, read as one span of the .lrc: a window needs at most 4 pages, and one
    transfer is far cheaper than four"""
    idx = tile_pages(stem); want = [i for i in ids if idx[i, 1] > 0]
    out = {i: np.full((P, P), np.nan, np.float32) for i in ids}
    if not want: return out
    a = int(min(idx[i, 0] for i in want)); b = int(max(idx[i, 0] + idx[i, 1] for i in want))
    buf = read(stem + '.lrc', a, b - a)
    for i in want:
        off, size = int(idx[i, 0]), int(idx[i, 1])
        out[i] = decode(buf[off - a:off - a + size])
    return out

def win(x0, y0, x1, y1):
    """tree height (m) on the 1 m cells of [x0, x1) x [y0, y1), north row first; nan where there is no tile"""
    global _IDX
    if _IDX is None: _IDX = json.load(open(f'{D}/index.json'))
    out = np.full((y1 - y0, x1 - x0), np.nan, np.float32)
    for tn in range(y0 // T, (y1 - 1) // T + 1):
        for te in range(x0 // T, (x1 - 1) // T + 1):
            stem = _IDX.get(f'{tn}_{te}')
            if not stem: continue
            tx0, ty1, tw, th, per = tile_meta(stem, tn, te)   # the tile's west and north edges, size, pages per row
            c0, c1 = max(x0, tx0) - tx0, min(x1, tx0 + tw) - tx0
            r0, r1 = ty1 - min(y1, ty1), ty1 - max(y0, ty1 - th)
            if c0 >= c1 or r0 >= r1: continue
            ids = [(pr, pc) for pr in range(r0 // P, (r1 - 1) // P + 1) for pc in range(c0 // P, (c1 - 1) // P + 1)]
            got = pages(stem, [pr * per + pc for pr, pc in ids])
            for pr, pc in ids:
                a = got[pr * per + pc]
                ra, rb = max(r0, pr * P), min(r1, (pr + 1) * P); ca, cb = max(c0, pc * P), min(c1, (pc + 1) * P)
                if ra >= rb or ca >= cb: continue
                # tile row ra is northing ty1 - ra; output row 0 is northing y1
                out[(y1 - ty1) + ra:(y1 - ty1) + rb, tx0 + ca - x0:tx0 + cb - x0] = a[ra - pr * P:rb - pr * P, ca - pc * P:cb - pc * P]
    return out

if __name__ == '__main__' and sys.argv[1:] == ['index']:
    print('files, tiles', build_index())
