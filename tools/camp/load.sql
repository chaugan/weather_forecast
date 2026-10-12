-- Nattplass: load one country's theme files (extract.sh) into DuckDB, geometry in EPSG:3035 (metres).
-- Run in tools/camp/cache with: sed s/@C@/norway/g ../load.sql | duckdb norway.duckdb
LOAD spatial; SET geometry_always_xy = true;
CREATE OR REPLACE MACRO src(f) AS TABLE SELECT properties AS p, ST_Transform(ST_GeomFromGeoJSON(geometry), 'EPSG:4326', 'EPSG:3035', always_xy := true) AS g
  FROM read_json(f, format = 'newline_delimited', columns = {geometry: 'JSON', properties: 'JSON'});
CREATE OR REPLACE TABLE roads AS SELECT (p->>'@id') AS id, coalesce((p->>'highway'), CASE WHEN (p->>'route') = 'ferry' THEN 'ferry' END) AS hw, (p->>'surface') AS surf, (p->>'tracktype') AS tt, coalesce((p->>'motor_vehicle'), (p->>'motorcar'), (p->>'vehicle'), (p->>'access')) AS acc,
  (p->>'name') AS name, (p->>'ref') AS ref, (p->>'toll') AS toll, (p->>'service') AS svc, (p->>'tracktype') AS grade, g FROM src('@C@/roads.geojsonl');
CREATE OR REPLACE TABLE water AS SELECT (p->>'@id') AS id, CASE WHEN (p->>'natural') = 'coastline' THEN 'coast' WHEN (p->>'waterway') IN ('river','canal') THEN 'river'
  WHEN (p->>'water') IN ('river','canal','stream','oxbow') THEN 'river' ELSE 'lake' END k, (p->>'name') AS name,
  CASE WHEN ST_GeometryType(g) IN ('POLYGON','MULTIPOLYGON') THEN ST_Area(g) END area, CASE WHEN ST_GeometryType(g) IN ('POLYGON','MULTIPOLYGON') THEN ST_Boundary(g) ELSE g END g
  FROM src('@C@/water.geojsonl') WHERE coalesce((p->>'water'),'') NOT IN ('wastewater','basin','reflecting_pool','fountain','swimming_pool');
-- water as areas (lakes, rivers, reservoirs), for final.py: a lake is open and level too, so the room to stop must lie outside it
CREATE OR REPLACE TABLE wpoly AS SELECT g FROM src('@C@/water.geojsonl') WHERE ST_GeometryType(g) IN ('POLYGON','MULTIPOLYGON');
CREATE OR REPLACE TABLE cover AS SELECT CASE WHEN (p->>'landuse') = 'forest' OR (p->>'natural') = 'wood' THEN 'forest' ELSE coalesce((p->>'natural'), (p->>'landuse')) END k, g FROM src('@C@/cover.geojsonl');
CREATE OR REPLACE TABLE build AS SELECT ST_Centroid(g) AS g, (p->>'building') AS k FROM src('@C@/build.geojsonl');
CREATE OR REPLACE TABLE places AS SELECT (p->>'place') AS k, (p->>'name') AS name, g FROM src('@C@/places.geojsonl');
CREATE OR REPLACE TABLE pois AS SELECT coalesce((p->>'tourism'), (p->>'amenity'), (p->>'leisure'), (p->>'natural'), (p->>'highway')) AS k, (p->>'name') AS name, (p->>'fee') AS fee, (p->>'access') AS acc, ST_Centroid(g) AS g FROM src('@C@/pois.geojsonl');
-- services for the night: food shops, fuel, chargers for cars (fast: a DC socket)
CREATE OR REPLACE TABLE svc AS SELECT CASE WHEN (p->>'amenity') = 'fuel' THEN 'fuel' WHEN (p->>'amenity') = 'charging_station' THEN 'ev' ELSE 'food' END k,
  coalesce((p->>'name'), (p->>'brand'), (p->>'operator')) AS name,
  coalesce((p->>'socket:type2_combo'), (p->>'socket:chademo'), (p->>'socket:tesla_supercharger'), (p->>'socket:ccs')) IS NOT NULL AS fast, ST_Centroid(g) AS g
  FROM src('@C@/svc.geojsonl') WHERE coalesce((p->>'access'), '') NOT IN ('private', 'no', 'customers')
  AND NOT ((p->>'amenity') = 'charging_station' AND (coalesce((p->>'motorcar'), '') = 'no' OR coalesce((p->>'bicycle'), '') = 'designated'));
CREATE OR REPLACE TABLE barriers AS SELECT (p->>'@id') AS id, (p->>'@type') AS t, (p->>'barrier') AS k, (p->>'access') AS acc, (p->>'motor_vehicle') AS mv, (p->>'locked') AS locked, (p->>'fee') AS fee, g FROM src('@C@/barriers.geojsonl');
CREATE OR REPLACE TABLE protect AS SELECT coalesce((p->>'protect_class'), '') AS cls, (p->>'boundary') AS b, (p->>'leisure') AS l, (p->>'name') AS name, g FROM src('@C@/protect.geojsonl');
SELECT 'roads', count(*) FROM roads UNION ALL SELECT 'water', count(*) FROM water UNION ALL SELECT 'cover', count(*) FROM cover UNION ALL SELECT 'build', count(*) FROM build
UNION ALL SELECT 'pois', count(*) FROM pois UNION ALL SELECT 'barriers', count(*) FROM barriers UNION ALL SELECT 'protect', count(*) FROM protect UNION ALL SELECT 'svc', count(*) FROM svc;
