# Nattplass: is there room to stop? Measures the open, flat ground beside a road point.
#   norway   Kartverket's 1 m terrain (DTM) and surface (DOM) models (Nasjonal detaljert høydemodell, WCS, CC BY 4.0), EPSG:25833
#   finland  Maanmittauslaitos' 2 m terrain model (korkeusmalli_2m, WCS, CC BY 4.0, API key in ~/.config/nls/key) and the Finnish
#            Forest Centre's canopy height model (CHM_newest, WMS drawn as a grey ramp, white 0 m to black 30 m), EPSG:3067
#   sweden   Lantmäteriet's 1 m ground model (Markhöjdmodell, Cloud-Optimized GeoTIFFs read in windows by cog.py, CC BY 4.0,
#            Geotorget login (e-mail:password) in ~/.config/lantmateriet/auth) and Skogsstyrelsen's tree height (Trädhöjd
#            Laserdata skog, 1 m, thl.py, needs the lerc package: run with tools/camp/.venv/bin/python); Naturvårdsverket's
#            10 m land cover (NMD2023, CC0) where there is no tree-height tile
# pad(x, y, roads, c) -> dict, x/y in the country's CRS (CRS[c]), roads = list of LineString coordinate lists within ~60 m.
#   pad    m² of the largest open (DOM-DTM < 1.5 m), flat (slope < 6°) patch at road height (±1.2 m) that touches the road edge
#          (4-6 m from a centreline), within 35 m of the point and 4-30 m from the road, is not water (water()) and is roomy (room())
#   flat   share of flat cells in the 4-30 m band (open or not)
#   open   share of open cells in that band
#   canopy median DOM-DTM in the band (m)
import os, io, math, time, threading, urllib.request, urllib.error
import numpy as np
from PIL import Image
from scipy import ndimage
from cog import COG

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'dtm')
os.makedirs(D, exist_ok=True)
H = 60   # half window, metres
CRS = {'norway': 'EPSG:25833', 'finland': 'EPSG:3067', 'sweden': 'EPSG:3006'}
CELL = {'norway': 1, 'finland': 2, 'sweden': 2}   # metres per grid cell
URL = {'dtm': 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?service=WCS&request=GetCoverage&version=1.0.0&coverage=nhm_dtm_topo_25833'
              '&crs=EPSG:25833&bbox={},{},{},{}&width={}&height={}&format=GeoTIFF',
       'dom': 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dom-nhm-25833?service=WCS&request=GetCoverage&version=1.0.0&coverage=nhm_dom_topo_25833'
              '&crs=EPSG:25833&bbox={},{},{},{}&width={}&height={}&format=GeoTIFF',
       'fdtm': 'https://avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2?service=WCS&version=2.0.1&request=GetCoverage'
               '&coverageId=korkeusmalli_2m&subset=E({},{})&subset=N({},{})&format=image/tiff&api-key={}',
       'fchm': 'https://avoin.metsakeskus.fi/rajapinnat/v1/ows?service=WMS&version=1.3.0&request=GetMap&layers=CHM_newest&styles='
               '&crs=EPSG:3067&bbox={},{},{},{}&width={}&height={}&format=image/png&transparent=true'}
NLS_KEY = None
FCHM_ONE = threading.Semaphore(1)   # the Forest Centre's WMS slows to ~60 s a map when asked in parallel; one at a time stays ~0.4 s

KEEP = False   # keep the raw windows on disk (tests only: 57 KB each)
def url(kind, x0, y0):
    global NLS_KEY
    if kind == 'fdtm':
        NLS_KEY = NLS_KEY or open(os.path.expanduser('~/.config/nls/key')).read().strip()
        return URL[kind].format(x0 - H, x0 + H, y0 - H, y0 + H, NLS_KEY)
    n = 2 * H // (2 if kind == 'fchm' else 1)   # the canopy map at 2 m, like the Finnish terrain
    return URL[kind].format(x0 - H, y0 - H, x0 + H, y0 + H, n, n)

LM = {}; LM_LOCK = threading.Lock()
def lm_tile(N, E):
    """Lantmäteriet's 10 km ground-model tile (northing and easting in 10 km), opened once; None where there is none"""
    with LM_LOCK:
        if (N, E) not in LM: LM[(N, E)] = threading.Lock()
        lk = LM[(N, E)]
    with lk:
        c = LM.get(('c', N, E), 0)
        if c == 0:
            auth = open(os.path.expanduser('~/.config/lantmateriet/auth')).read().strip()
            try: c = COG(f'https://dl1.lantmateriet.se/hojd/data/grid/mhm/{N // 10}_{E // 10}/m{N}_{E}.tif', auth, level=1)   # the 2 m overview
            except urllib.error.HTTPError as e:
                if e.code != 404: raise
                c = None
            LM[('c', N, E)] = c
        return c

def sdtm(x0, y0):
    a = np.full((H, H), np.nan, np.float32)   # 2 m cells
    for N in range((y0 - H) // 10000, (y0 + H - 1) // 10000 + 1):
        for E in range((x0 - H) // 10000, (x0 + H - 1) // 10000 + 1):
            c = lm_tile(N, E)
            if c is None: continue
            w = c.window(x0 - H, y0 - H, x0 + H, y0 + H)
            a = np.where(np.isnan(a), w, a)
    return a

# Naturvårdsverket's land cover (NMD2023 base layer, 10 m, CC0), WMS colours back to classes. Open = places a car could stand
# or ground with no trees: built-up ground that is not a building (gravel areas, car parks), bare open ground, heath and grass.
NMD_URL = ('https://geodata.naturvardsverket.se/geoserver/ows?service=WMS&version=1.1.1&request=GetMap'
           '&layers=lc-nmd:LC.LandCoverRaster.Bas.2023.v2.x&styles=&srs=EPSG:3006&bbox={},{},{},{}&width={}&height={}&format=image/png')
NMD_COL = {0xFFFFBE: 3, 0x00E6A9: 23, 0x55FF00: 43, 0x5A1414: 51, 0xE5464B: 52, 0x191919: 53, 0x800080: 54, 0x6699CD: 61,
           0x8ACCFA: 62, 0x6E8C05: 111, 0x2D5F00: 112, 0x4E7000: 113, 0x38A800: 114, 0x4CE600: 115, 0xAAFF00: 116, 0x97E600: 117,
           0xCDCD66: 118, 0x598C55: 121, 0x305E50: 122, 0x23735A: 123, 0x438870: 124, 0x89CD9B: 125, 0xA5F578: 126, 0xABCD78: 127,
           0x898944: 128, 0xC29ED7: 200, 0x894465: 211, 0xCD6699: 212, 0xF57AB6: 213, 0xD69DBC: 214, 0x73004C: 215, 0xA80084: 216,
           0xE600A9: 217, 0xFF00C5: 218, 0x704489: 221, 0xAA66CD: 222, 0xCA7AF5: 223, 0x4C0073: 225, 0x8400A8: 226, 0xA900E6: 227,
           0xC500FF: 228, 0xE1E1E1: 411, 0xCCD79E: 4211, 0xABC9A6: 4212, 0x9EB591: 4213, 0xD7C29E: 4221, 0xCDAA66: 4222,
           0x897044: 4223, 0xFFEBAF: 4231, 0xFFD37F: 4232, 0xFFBF7F: 4233}
NMD_OPEN = {52, 411, 4221, 4222, 4223, 4231, 4232, 4233}
NMD_TIF = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'nmd', 'NMD2023bas_v2_1.tif')
NMD_LOCAL = None
def nmd(x0, y0, k=2):
    """NMD class per k m cell (0 = no data or an unknown colour): from the downloaded GeoTIFF when it is there (build.sh
    fetches it), else from the WMS"""
    global NMD_LOCAL
    if os.path.exists(NMD_TIF):
        with LM_LOCK:
            NMD_LOCAL = NMD_LOCAL or COG(NMD_TIF)
        c = NMD_LOCAL; n = 2 * H // k
        cx = x0 - H + k / 2 + k * np.arange(n); cy = y0 + H - k / 2 - k * np.arange(n)
        col = np.floor((cx - c.x0) / c.sx).astype(int); row = np.floor((c.y0 - cy) / c.sy).astype(int)
        w = c.window(c.x0 + col[0] * c.sx, c.y0 - (row[-1] + 1) * c.sy, c.x0 + (col[-1] + 1) * c.sx, c.y0 - row[0] * c.sy)
        return np.nan_to_num(w[np.ix_(row - row[0], col - col[0])], nan=0).astype(np.int32)
    for attempt in range(4):
        try:
            im = Image.open(io.BytesIO(urllib.request.urlopen(NMD_URL.format(x0 - H, y0 - H, x0 + H, y0 + H, 2 * H // k, 2 * H // k), timeout=60).read()))
            g = np.array(im.convert('RGBA')).astype(np.int64); break
        except Exception:
            time.sleep(2 + 3 * attempt); g = None
    if g is None: raise RuntimeError('nmd')
    rgb = (g[..., 0] << 16) | (g[..., 1] << 8) | g[..., 2]
    out = np.zeros(rgb.shape, np.int32)
    for col, cl in NMD_COL.items(): out[rgb == col] = cl
    out[g[..., 3] == 0] = 0
    return out

# water in the window: a lake's surface is open, flat and level too. Norway: Kartverket's FKB water areas (WMS, lakes, rivers and
# the sea, true to a metre or two; OpenStreetMap's lakes come from N50 and can lie 10 m off) and AR5's marsh (Myr, drawn as blue
# hatching on white: the hatching closed into an area); Sweden: the land cover's lake and sea classes (10 m); Finland: the terrain
# model gives a lake one exact height, so cells whose 3 × 3 neighbourhood is exactly level
FKB_WMS = ('https://wms.geonorge.no/skwms1/wms.fkb?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=TRUE&STYLES='
           '&CRS=EPSG:25833&LAYERS={}&BBOX={},{},{},{}&WIDTH={}&HEIGHT={}')
def water(c, x0, y0, z=None, lc=None):
    n = 2 * H // CELL[c]
    if c == 'norway':
        def wms(layer):
            for attempt in range(4):
                try: return np.array(Image.open(io.BytesIO(urllib.request.urlopen(FKB_WMS.format(layer, x0 - H, y0 - H, x0 + H, y0 + H, n, n),
                                                                                  timeout=60).read())).convert('RGBA')).astype(np.int16)
                except Exception: time.sleep(2 + 3 * attempt)
            raise RuntimeError('fkb ' + layer)
        a = wms('ar5'); hatch = (a[..., 3] > 200) & (np.abs(a[..., :3] - (130, 200, 240)).max(-1) < 30)
        bog = ndimage.binary_closing(hatch, iterations=3) & (a[..., 3] > 0) & ((a[..., :3].min(-1) > 240) | hatch)
        return (wms('vann_omrade')[..., 3] > 0) | bog
    if c == 'sweden': return np.isin(lc if lc is not None else nmd(x0, y0), (61, 62))
    z = grid('fdtm', x0, y0) if z is None else z
    with np.errstate(invalid='ignore'): f = (ndimage.maximum_filter(z, 3) - ndimage.minimum_filter(z, 3)) < 0.001
    lab, m = ndimage.label(f)
    if m: f = np.isin(lab, 1 + np.flatnonzero(ndimage.sum(f, lab, index=np.arange(1, m + 1)) >= 4))
    return ndimage.binary_dilation(f)

def grid(kind, x0, y0):
    f = f'{D}/{kind}_{x0}_{y0}.npy'
    if KEEP and os.path.exists(f): return np.load(f)
    for attempt in range(4):
        try:
            if kind == 'fchm':
                with FCHM_ONE: raw = urllib.request.urlopen(url(kind, x0, y0), timeout=120).read()
            else: raw = urllib.request.urlopen(url(kind, x0, y0), timeout=60).read()
            im = Image.open(io.BytesIO(raw))
            if kind == 'fchm':   # grey ramp back to metres; transparent = no data
                g = np.array(im.convert('RGBA'), dtype=np.float32)
                a = (255 - g[..., 0]) / 255 * 30; a[g[..., 3] == 0] = np.nan
            else: a = np.array(im, dtype=np.float32)
            break
        except Exception:
            time.sleep(2 + 3 * attempt); a = None
    if a is None: raise RuntimeError('wcs')
    if kind != 'fchm': a[(a < -100) | (a > 3000)] = np.nan
    if KEEP: np.save(f, a)
    return a

def seg_dist(px, py, coords):
    """distance from the cell centres (px, py arrays) to a polyline"""
    c = np.asarray(coords, float); d = np.full(px.shape, np.inf)
    for (ax, ay), (bx, by) in zip(c[:-1], c[1:]):
        vx, vy = bx - ax, by - ay; L2 = vx * vx + vy * vy or 1e-9
        t = np.clip(((px - ax) * vx + (py - ay) * vy) / L2, 0, 1)
        d = np.minimum(d, np.hypot(ax + t * vx - px, ay + t * vy - py))
    return d

def pad(x, y, roads, c='norway', shape=False):   # shape: also the outline of the open area (outline.py)
    x0, y0 = int(round(x)), int(round(y)); k = CELL[c]; n = 2 * H // k
    if c == 'finland':
        # the terrain first (NLS, fast); the trees can only make the open area smaller, so the canopy map is asked for only
        # when the level ground alone reaches 40 m²
        x0 -= x0 % 2; y0 -= y0 % 2; z = grid('fdtm', x0, y0)
        if z.shape != (n, n) or np.isnan(z).mean() > 0.3: return None
        wt = water(c, x0, y0, z)
        m = measure(x, y, x0, y0, k, z, np.zeros((n, n), np.float32), roads, water=wt)
        if m['pad'] < 40: return {**m, 'open': None, 'canopy': None, 'lc': 0}
        canopy = grid('fchm', x0, y0)
    elif c == 'sweden':
        # trees from Skogsstyrelsen's tree height (1 m, averaged to the 2 m cells), land cover where there is no tile. The
        # open area alone comes first: the terrain can only make it smaller, so the ground model is fetched only when the
        # open area reaches 40 m²
        import thl
        x0 -= x0 % 2; y0 -= y0 % 2
        th = thl.win(x0 - H, y0 - H, x0 + H, y0 + H)
        with np.errstate(all='ignore'): th = np.nanmean(th.reshape(n, 2, n, 2), axis=(1, 3))
        nm = nmd(x0, y0); wt = water(c, x0, y0, lc=nm)
        lc = np.where(np.isin(nm, list(NMD_OPEN)), 0, 10).astype(np.float32)
        canopy = np.where(np.isfinite(th), th, lc)
        m = measure(x, y, x0, y0, k, np.zeros((n, n), np.float32), canopy, roads, water=wt)
        if m['pad'] < 40: return {**m, 'z': None, 'src': 'thl', 'noz': 1}
        z = sdtm(x0, y0)
        if z.shape != (n, n) or np.isnan(z).mean() > 0.3: return None
        return {**measure(x, y, x0, y0, k, z, canopy, roads, shape, wt), 'src': 'thl'}
    else: z = grid('dtm', x0, y0); canopy = grid('dom', x0, y0) - z; wt = water(c, x0, y0)
    if z.shape != (n, n) or canopy.shape != (n, n) or np.isnan(z).mean() > 0.3: return None
    return measure(x, y, x0, y0, k, z, canopy, roads, shape, wt)

def measure(x, y, x0, y0, k, z, canopy, roads, shape=False, water=None):
    n = z.shape[0]
    # rows go north -> south
    cx = x0 - H + k / 2 + k * np.arange(n); cy = y0 + H - k / 2 - k * np.arange(n)
    px, py = np.meshgrid(cx, cy)
    droad = np.full(px.shape, np.inf)
    for r in roads: droad = np.minimum(droad, seg_dist(px, py, r))
    dpt = np.hypot(px - x, py - y)
    zs = ndimage.uniform_filter(np.nan_to_num(z, nan=np.nanmean(z)), 3)
    gy, gx = np.gradient(zs, k)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    canopy = np.nan_to_num(canopy, nan=0)
    near = (droad <= 3) & (dpt <= 15)
    zroad = np.nanmedian(z[near]) if near.any() else z[n // 2, n // 2]
    band = (droad >= 4) & (droad <= 30) & (dpt <= 35)
    flat = slope < 6; opn = canopy < 1.5; level = np.abs(z - zroad) < 1.2
    ok = flat & opn & level & band
    if water is not None and water.shape == ok.shape: ok &= ~water
    best, patch = room(ok, (droad >= 4) & (droad <= 6), k)
    ol = outline(patch, x0, y0, k) if shape and best else None
    return {**({'ol': ol} if ol else {}), 'pad': best, 'flat': round(float(flat[band].mean()), 3), 'open': round(float(opn[band].mean()), 3),
            'canopy': round(float(np.median(canopy[band])), 1), 'z': round(float(zroad), 1)}

# room for a vehicle, not just square metres: a strip 0.5 m wide and 80 m long is 40 m² too. Only ground where a square about 3 m
# across fits counts (an opening: 3 × 3 cells of 1 m, 2 × 2 cells of 2 m), so spikes and slivers fall away, and the rest must still
# reach the road edge
ROOM = {1: np.ones((3, 3), bool), 2: np.ones((2, 2), bool)}
SHAPE_V = 3   # the version of the patch rule (water left out, room for a vehicle); outline.py cuts records made by an older one

def room(ok, edge, k):
    """m² of the largest roomy patch that touches the road edge, and its cells"""
    ok = ndimage.binary_opening(ok, ROOM[k])
    lab, m = ndimage.label(ok)
    if not m: return 0, None
    sizes = ndimage.sum(ok, lab, index=np.arange(1, m + 1))
    touch = ndimage.maximum(edge, lab, index=np.arange(1, m + 1)) > 0
    if not touch.any(): return 0, None
    j = np.flatnonzero(touch)[np.argmax(sizes[touch])]
    return int(sizes[j]) * k * k, lab == j + 1

def outline(mask, x0, y0, k):
    """The outline of a patch of cells, in the grid's CRS, as WKT rounded to 0.1 m (its largest part, no holes)."""
    from shapely.geometry import box, Polygon
    from shapely.ops import unary_union
    from shapely import wkt
    parts = []
    for r in range(mask.shape[0]):   # one box per run of cells in a row
        row = np.flatnonzero(np.diff(np.r_[0, mask[r].astype(np.int8), 0]))
        for a, b in zip(row[::2], row[1::2]): parts.append(box(x0 - H + a * k, y0 + H - (r + 1) * k, x0 - H + b * k, y0 + H - r * k))
    g = unary_union(parts).simplify(k)
    if g.geom_type == 'MultiPolygon': g = max(g.geoms, key=lambda p: p.area)
    return wkt.dumps(Polygon(g.exterior), rounding_precision=1) if g.geom_type == 'Polygon' else None
