# Nattplass: read a small window from a Cloud-Optimized GeoTIFF over HTTP range requests, or from a local tiled GeoTIFF
# (no GDAL on the dev server).
# Handles classic and BigTIFF, tiled, uncompressed / deflate / LZW / PackBits, predictors 1-3, one band. Used for Sweden: Lantmäteriet's
# 1 m ground model (Markhöjdmodell, dtm-cog, Basic auth with the Geotorget login) and a canopy height model.
#   c = COG(url, auth='user:pass', level=1); a = c.window(x0, y0, x1, y1)   # CRS units, north-up grid; cells outside -> nan;
#   level 0 is full resolution, 1.. the overviews
import struct, zlib, base64, threading, urllib.request
from collections import OrderedDict
import numpy as np

TYPES = {1: ('B', 1), 2: ('c', 1), 3: ('H', 2), 4: ('I', 4), 5: ('II', 8), 6: ('b', 1), 7: ('B', 1), 8: ('h', 2), 9: ('i', 4),
         10: ('ii', 8), 11: ('f', 4), 12: ('d', 8), 16: ('Q', 8), 17: ('q', 8), 18: ('Q', 8)}

def lzw(data):
    """TIFF LZW (MSB first, early change)"""
    out = bytearray(); tab = [bytes([i]) for i in range(256)] + [b'', b'']
    bits, nb, acc, prev = 9, 0, 0, None
    for byte in data:
        acc = (acc << 8) | byte; nb += 8
        while nb >= bits:
            nb -= bits; code = (acc >> nb) & ((1 << bits) - 1)
            if code == 257: return bytes(out)
            if code == 256: tab = tab[:258]; bits = 9; prev = None; continue
            if prev is None: e = tab[code]
            else:
                e = tab[code] if code < len(tab) else prev + prev[:1]
                tab.append(prev + e[:1])
            out += e; prev = e
            if len(tab) + 1 >= (1 << bits) and bits < 12: bits += 1
    return bytes(out)

def packbits(data):
    out = bytearray(); i = 0; n = len(data)
    while i < n:
        h = data[i]; i += 1
        if h < 128: out += data[i:i + h + 1]; i += h + 1
        elif h > 128: out += bytes([data[i]]) * (257 - h); i += 1
    return bytes(out)

CACHE = OrderedDict(); CACHE_MB = 256   # decoded blocks of all open files together, oldest dropped first
_size = [0]

class COG:
    _lock = threading.Lock()
    def __init__(self, url, auth=None, cache=None, level=0):   # cache: unused, kept for callers
        self.url = url; self.h = {'User-Agent': 'glett-nattplass'}
        if auth: self.h['Authorization'] = 'Basic ' + base64.b64encode(auth.encode()).decode()
        self.level = level
        head = self.get(0, 15); self.bo = '<' if head[:2] == b'II' else '>'
        big = struct.unpack(self.bo + 'H', head[2:4])[0] == 43
        off = struct.unpack(self.bo + ('Q' if big else 'I'), head[8:16] if big else head[4:8])[0]
        n_fmt, ent, val = ('Q', 20, 8) if big else ('H', 12, 4)
        nsz = 8 if big else 2
        T0 = None
        for lev in range(level + 1):   # level 0 = full resolution, 1.. = the overviews in file order
            # only the bytes of this directory are read (it may sit at the end of a large file)
            buf = self.get(off, off + 65535)
            n = struct.unpack(self.bo + n_fmt, buf[:nsz])[0]
            need = nsz + n * ent + (8 if big else 4)
            if need > len(buf): buf = self.get(off, off + need - 1)
            T = self.ifd(buf, off, n, big, ent, val, nsz)
            if T0 is None: T0 = T
            nxt = nsz + n * ent
            off = struct.unpack(self.bo + ('Q' if big else 'I'), buf[nxt:nxt + (8 if big else 4)])[0]
            if lev < level and off == 0: raise ValueError('no such overview')
        self.T = T
        self.w, self.hgt = T[256][0], T[257][0]
        if 322 not in T: raise ValueError('not a tiled TIFF')
        self.tw, self.th = T[322][0], T[323][0]
        self.offs, self.cnts = T[324], T[325]; self.comp = T.get(259, (1,))[0]; self.pred = T.get(317, (1,))[0]
        bps = T.get(258, (8,))[0]; sf = T.get(339, (1,))[0]
        self.dt = np.dtype({1: 'u', 2: 'i', 3: 'f'}[sf] + str(bps // 8)).newbyteorder(self.bo)
        f = T0[256][0] / self.w   # overviews carry no georeferencing of their own
        sx, sy = T0[33550][:2]; self.x0, self.y0, self.sx, self.sy = T0[33922][3], T0[33922][4], sx * f, sy * f
        nd = T0.get(42113); self.nodata = float(nd) if nd not in (None, '') else None
        self.ntx = -(-self.w // self.tw)

    def ifd(self, buf, base, n, big, ent, val, nsz):
        """the tags of one directory; buf holds the file from byte base on"""
        T = {}; head = buf
        for i in range(n):
            e = nsz + i * ent
            tag, ty = struct.unpack(self.bo + 'HH', head[e:e + 4])
            cnt = struct.unpack(self.bo + ('Q' if big else 'I'), head[e + 4:e + 4 + (8 if big else 4)])[0]
            f, sz = TYPES[ty]; raw = head[e + 4 + (8 if big else 4):e + ent]; size = sz * cnt
            if size > val:
                p = struct.unpack(self.bo + ('Q' if big else 'I'), raw[:val])[0]
                raw = head[p - base:p - base + size] if base <= p and p - base + size <= len(head) else self.get(p, p + size - 1)
            if ty == 2: T[tag] = raw[:size].rstrip(b'\0').decode(errors='replace'); continue
            T[tag] = struct.unpack(self.bo + f[0] * (cnt * len(f)), raw[:size])
        return T
    def get(self, a, b):
        if self.url.startswith('/'):   # a local file
            with open(self.url, 'rb') as fh: fh.seek(a); return fh.read(b - a + 1)
        r = urllib.request.Request(self.url, headers={**self.h, 'Range': f'bytes={a}-{b}'})
        for k in range(4):
            try: return urllib.request.urlopen(r, timeout=60).read()
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 404): raise
                err = e
            except Exception as e: err = e
            import time; time.sleep(2 + 3 * k)
        raise err
    def tile(self, i):
        key = (self.url, self.level, i)
        with self._lock:
            if key in CACHE: CACHE.move_to_end(key); return CACHE[key]
        o, c = self.offs[i], self.cnts[i]
        if c == 0: a = np.full((self.th, self.tw), np.nan, np.float32)
        else:
            b = self.get(o, o + c - 1)
            if self.comp in (8, 32946): b = zlib.decompress(b)
            elif self.comp == 5: b = lzw(b)
            elif self.comp == 32773: b = packbits(b)
            elif self.comp != 1: raise ValueError(f'compression {self.comp}')
            if self.pred == 3:   # floating-point predictor: byte planes, differenced along the row
                u = np.frombuffer(b, np.uint8).reshape(self.th, -1)
                u = np.cumsum(u, axis=1, dtype=np.uint8)
                nb = self.dt.itemsize
                u = u.reshape(self.th, nb, self.tw).transpose(0, 2, 1)
                a = np.ascontiguousarray(u).view(np.dtype(self.dt.str.replace('<', '>').replace('|', '>'))).reshape(self.th, self.tw).astype(np.float32)
            else:
                a = np.frombuffer(b, self.dt).reshape(self.th, self.tw)
                if self.pred == 2: a = np.cumsum(a, axis=1, dtype=a.dtype)
                a = a.astype(np.float32)
            if self.nodata is not None: a[a == self.nodata] = np.nan
        with self._lock:
            if key not in CACHE: CACHE[key] = a; _size[0] += a.nbytes
            while _size[0] > CACHE_MB * 2**20 and CACHE: _size[0] -= CACHE.popitem(last=False)[1].nbytes
        return a
    def window(self, x0, y0, x1, y1):
        c0 = int(round((x0 - self.x0) / self.sx)); c1 = int(round((x1 - self.x0) / self.sx))
        r0 = int(round((self.y0 - y1) / self.sy)); r1 = int(round((self.y0 - y0) / self.sy))
        out = np.full((r1 - r0, c1 - c0), np.nan, np.float32)
        for ty in range(max(r0, 0) // self.th, (min(r1, self.hgt) - 1) // self.th + 1):
            for tx in range(max(c0, 0) // self.tw, (min(c1, self.w) - 1) // self.tw + 1):
                t = self.tile(ty * self.ntx + tx)
                ra, rb = max(r0, ty * self.th), min(r1, (ty + 1) * self.th, self.hgt)
                ca, cb = max(c0, tx * self.tw), min(c1, (tx + 1) * self.tw, self.w)
                if ra < rb and ca < cb:
                    out[ra - r0:rb - r0, ca - c0:cb - c0] = t[ra - ty * self.th:rb - ty * self.th, ca - tx * self.tw:cb - tx * self.tw]
        return out
