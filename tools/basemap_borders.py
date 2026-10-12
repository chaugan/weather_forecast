# The country outlines the base-map proxy (api/tile.php) cuts the Finnish and Swedish map tiles to: those maps paint their
# neighbours (Norway, the other one) white or grey, and Kartverket's or the other country's map belongs there. From
# OpenStreetMap's national boundary relations (admin_level 2, territorial sea included), simplified to about 5 m.
#   python3 tools/basemap_borders.py   (needs tools/camp/cache/<country>-latest.osm.pbf and osmium) -> api/borders.json
import json, subprocess, os
from shapely.geometry import shape
from shapely.ops import unary_union
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'camp', 'cache')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api', 'borders.json')
REL = {'fi': ('finland', 54224), 'se': ('sweden', 52822)}
out = {}
for cc, (c, rel) in REL.items():
    os.makedirs(f'{D}/borders', exist_ok=True)
    subprocess.run(['osmium', 'getid', '-r', '-O', '--no-progress', '-o', f'{D}/borders/{c}_b.osm.pbf', f'{D}/{c}-latest.osm.pbf', f'r{rel}'], check=True)
    subprocess.run(['osmium', 'export', '-O', '-f', 'geojson', '--geometry-types=polygon', '-o', f'{D}/borders/{c}.geojson', f'{D}/borders/{c}_b.osm.pbf'], check=True)
    fs = json.load(open(f'{D}/borders/{c}.geojson'))['features']
    nat = [f for f in fs if f['properties'].get('admin_level') == '2'] or fs
    g = unary_union([shape(f['geometry']) for f in nat]).simplify(0.00005)
    polys = getattr(g, 'geoms', [g])
    r5 = lambda ring: [[round(x, 5), round(y, 5)] for x, y in ring.coords]
    out[cc] = {'bbox': [round(v, 4) for v in g.bounds], 'outer': [r5(p.exterior) for p in polys], 'holes': [r5(i) for p in polys for i in p.interiors]}
    print(cc, len(polys), 'polygons', sum(len(r) for r in out[cc]['outer']), 'points', len(out[cc]['holes']), 'holes')
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print(OUT, os.path.getsize(OUT))
