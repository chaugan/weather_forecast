#!/bin/sh
# Leirplass (camp spots: overnight and rest stops): rebuild data/natt/ for Norway, Sweden and Finland from open data.
#   sh tools/camp/build.sh            (dev server: osmium-tool, the duckdb CLI with spatial, python3 with numpy, scipy, shapely,
#                                       pyarrow, PIL; ~50 GB in tools/camp/cache, not in git, not deployed)
# Steps per country: Geofabrik extract (downloaded when older than 25 days) -> extract.sh (theme files) -> load.sql (DuckDB)
# -> graph.py (drivable graph, barriers, reachability) -> sample.sql + features.sql (candidate points and their surroundings)
# -> build.py (filter, score, cluster) -> padrun.py (room to stop from the national terrain models; kept by position, so a
# rebuild measures only new points; Finland needs the NLS API key in ~/.config/nls/key, Sweden the Geotorget login in
# ~/.config/lantmateriet/auth as e-mail:password, Skogsstyrelsen's tree height and Naturvårdsverket's land cover, below) -> final.py (the way
# in, names, services, tiles) -> outline.py (the open area's outline at each final spot, kept by position like the pad, so only new
# spots are measured; water left out and only room a vehicle fits counts) -> final.py again, now with the outlines (the drawn area,
# the wetland and water check). Norway also fetches NVDB
# barriers and stopping places (nvdb.py). Data: © OpenStreetMap contributors (ODbL), NVDB (NLOD), Kartverket, Maanmittauslaitos,
# Suomen metsäkeskus, Lantmäteriet and Skogsstyrelsen (CC BY 4.0), Naturvårdsverket (CC0).
set -e
H=$(cd "$(dirname "$0")" && pwd); C=$H/cache; mkdir -p $C; cd $C
old() { [ ! -f "$1" ] || [ -n "$(find "$1" -mtime +25)" ]; }
for c in norway sweden finland; do
  f=$c-latest.osm.pbf
  [ "$c" = norway ] && [ -L $f ] && rm $f          # the tur cache link used during development
  if old $f; then curl -sS -L -o $f.part https://download.geofabrik.de/europe/$f && mv $f.part $f; fi
done
# Sweden's land cover (Naturvårdsverket NMD2023, 10 m, CC0) for padrun.py: 2.7 GB zip, the 11 GB GeoTIFF is kept
if [ ! -f nmd/NMD2023bas_v2_1.tif ]; then
  mkdir -p nmd
  curl -sS -L -o nmd/nmd.zip https://geodata.naturvardsverket.se/nedladdning/marktacke/NMD2023/Basskikt_v2_x/NMD2023_basskikt_v2_1.zip
  unzip -o -j -d nmd nmd/nmd.zip NMD2023_basskikt_v2_1/NMD2023bas_v2_1.tif > /dev/null && rm nmd/nmd.zip
fi
# Sweden's tree height (Skogsstyrelsen, read in pages by thl.py): the LERC decoder lives in a venv that also sees the system
# packages, and the list of 2.5 km tiles is refreshed with the extracts
[ -x $H/.venv/bin/python ] || { python3 -m venv --system-site-packages $H/.venv && $H/.venv/bin/pip install -q lerc; }
if old thl/index.json; then $H/.venv/bin/python $H/thl.py index; fi
python3 $H/nvdb.py; python3 $H/nvdb.py stops
python3 - <<'PY'
import json, csv
R = json.load(open('nvdb_stops.json')); w = csv.writer(open('nvdb_stops.csv', 'w')); w.writerow(['t', 'kind', 'kat', 'lon', 'lat'])
SKIP47 = ('Busslomme', 'Møteplass', 'Arbeidslomme', 'Lastelomme', 'Passeringslomme i T-kryss', 'Havarilomme')
for r in R:
    e, t = r['e'], r['t']
    if t == 47:
        b = e.get('Bruksområde') or ''
        if b in SKIP47: continue
        kind = 'pause' if b == 'Kjørepause/parkering' else 'lomme'
    elif t == 39: kind = 'rast'
    elif t == 40:
        if (e.get('Type') or '').startswith('Snunisje'): continue
        kind = 'snu'
    else:
        if (e.get('Bruksområde') or '') in ('Handel', 'Skole', 'v kollektivterminal/kai', 'Idrett') or e.get('Type') == 'Parkeringshus': continue
        kind = 'park'
    w.writerow([t, kind, r['kat'], r['lon'], r['lat']])
PY
for c in norway sweden finland; do
  sh $H/extract.sh $c
  rm -f $c.duckdb; sed s/@C@/$c/g $H/load.sql | duckdb $c.duckdb > /dev/null
  if [ $c = norway ]; then duckdb $c.duckdb -c "LOAD spatial; CREATE OR REPLACE TABLE nstops AS SELECT kind, kat, ST_Transform(ST_Point(lon, lat), 'EPSG:4326', 'EPSG:3035', always_xy := true) g FROM read_csv('nvdb_stops.csv');"
  else duckdb $c.duckdb -c "LOAD spatial; CREATE OR REPLACE TABLE nstops (kind VARCHAR, kat VARCHAR, g GEOMETRY);"; fi
  python3 $H/graph.py $c
  duckdb $c.duckdb < $H/sample.sql > /dev/null
  sed "s#@OUT@#$c/feat.parquet#" $H/features.sql | duckdb $c.duckdb
  python3 $H/build.py $c
  $H/.venv/bin/python $H/padrun.py $c
  python3 $H/final.py $c
  $H/.venv/bin/python $H/outline.py $c
  $H/.venv/bin/python $H/outline.py $c cut    # older records to the current patch rule (pad.SHAPE_V); nothing to do when none
  python3 $H/final.py $c
done
echo "data/natt rebuilt"
