-- Nattplass: OSM surroundings of the points in table pts(id, src, g) (EPSG:3035). One row per point.
LOAD spatial;
CREATE OR REPLACE TEMP TABLE f_road AS SELECT id, arg_min(hw, d) hw, arg_min(surf, d) surf, arg_min(tt, d) tt, arg_min(acc, d) acc, arg_min(toll, d) toll, min(d) d_road, count(*) n_road300
  FROM (SELECT p.id, r.hw, r.surf, r.tt, r.acc, r.toll, ST_Distance(p.g, r.g) d FROM pts p JOIN roads r ON ST_DWithin(p.g, r.g, 300)) GROUP BY id;
CREATE OR REPLACE TEMP TABLE f_cls AS SELECT p.id,
  min(CASE WHEN r.hw IN ('motorway','trunk','primary','motorway_link','trunk_link','primary_link') THEN ST_Distance(p.g, r.g) END) d_major,
  min(CASE WHEN r.hw IN ('secondary','secondary_link') THEN ST_Distance(p.g, r.g) END) d_sec,
  min(CASE WHEN r.hw IN ('tertiary','tertiary_link') THEN ST_Distance(p.g, r.g) END) d_ter
  FROM pts p JOIN (SELECT * FROM roads WHERE hw IN ('motorway','trunk','primary','motorway_link','trunk_link','primary_link','secondary','secondary_link','tertiary','tertiary_link')) r
  ON ST_DWithin(p.g, r.g, 3000) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_water AS SELECT p.id,
  min(CASE WHEN w.k = 'lake' THEN ST_Distance(p.g, w.g) END) d_lake,
  arg_min(CASE WHEN w.k = 'lake' THEN w.area END, CASE WHEN w.k = 'lake' THEN ST_Distance(p.g, w.g) END) lake_area,
  min(CASE WHEN w.k = 'river' THEN ST_Distance(p.g, w.g) END) d_river,
  min(CASE WHEN w.k = 'coast' THEN ST_Distance(p.g, w.g) END) d_coast
  FROM pts p JOIN water w ON ST_DWithin(p.g, w.g, 1000) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_cover AS SELECT p.id,
  max(CASE WHEN c.k = 'forest' AND ST_Contains(c.g, p.g) THEN 1 ELSE 0 END) in_forest,
  max(CASE WHEN c.k = 'forest' THEN 1 ELSE 0 END) forest100,
  max(CASE WHEN c.k IN ('farmland','meadow','grassland') AND ST_Contains(c.g, p.g) THEN 1 ELSE 0 END) in_farm,
  max(CASE WHEN c.k IN ('residential','industrial','quarry','military') THEN 1 ELSE 0 END) urban100,
  max(CASE WHEN c.k IN ('heath','bare_rock','fell','moor','scrub') AND ST_Contains(c.g, p.g) THEN 1 ELSE 0 END) in_open,
  max(CASE WHEN c.k = 'wetland' AND ST_Contains(c.g, p.g) THEN 1 ELSE 0 END) in_wet
  FROM pts p JOIN cover c ON ST_DWithin(p.g, c.g, 100) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_build AS SELECT p.id, min(ST_Distance(p.g, b.g)) d_build,
  count(*) FILTER (WHERE ST_Distance(p.g, b.g) < 150) nb150, count(*) nb500
  FROM pts p JOIN build b ON ST_DWithin(p.g, b.g, 500) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_place AS SELECT p.id,
  min(CASE WHEN x.k IN ('city','town') THEN ST_Distance(p.g, x.g) END) d_town,
  min(CASE WHEN x.k = 'village' THEN ST_Distance(p.g, x.g) END) d_village,
  min(CASE WHEN x.k IN ('hamlet','isolated_dwelling') THEN ST_Distance(p.g, x.g) END) d_hamlet
  FROM pts p JOIN places x ON ST_DWithin(p.g, x.g, 8000) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_poi AS SELECT p.id,
  min(CASE WHEN x.k = 'parking' THEN ST_Distance(p.g, x.g) END) d_parking,
  min(CASE WHEN x.k = 'viewpoint' THEN ST_Distance(p.g, x.g) END) d_view,
  min(CASE WHEN x.k IN ('camp_site','caravan_site') THEN ST_Distance(p.g, x.g) END) d_camp,
  min(CASE WHEN x.k IN ('picnic_site','picnic_table','bbq','firepit') THEN ST_Distance(p.g, x.g) END) d_picnic,
  min(CASE WHEN x.k IN ('shelter','wilderness_hut') THEN ST_Distance(p.g, x.g) END) d_shelter,
  min(CASE WHEN x.k = 'beach' THEN ST_Distance(p.g, x.g) END) d_beach,
  min(CASE WHEN x.k = 'rest_area' THEN ST_Distance(p.g, x.g) END) d_rest,
  min(CASE WHEN x.k IN ('slipway', 'bathing_place', 'fishing') THEN ST_Distance(p.g, x.g) END) d_wpoi,
  min(CASE WHEN x.k IN ('parking', 'turning_circle', 'turning_loop') THEN ST_Distance(p.g, x.g) END) d_ostop
  FROM pts p JOIN pois x ON ST_DWithin(p.g, x.g, 1000) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_stop AS SELECT p.id, min(ST_Distance(p.g, s.g)) d_stop, arg_min(s.kind, ST_Distance(p.g, s.g)) stop_kind
  FROM pts p JOIN nstops s ON ST_DWithin(p.g, s.g, 300) GROUP BY p.id;
CREATE OR REPLACE TEMP TABLE f_prot AS SELECT p.id, max(CASE WHEN x.b = 'national_park' OR x.cls = '2' THEN 1 ELSE 0 END) in_np, 1 in_prot
  FROM pts p JOIN protect x ON ST_Contains(x.g, p.g) GROUP BY p.id;
COPY (SELECT p.id, p.src, ST_X(ST_Transform(p.g, 'EPSG:3035', 'EPSG:4326', always_xy := true)) lon, ST_Y(ST_Transform(p.g, 'EPSG:3035', 'EPSG:4326', always_xy := true)) lat,
  r.* EXCLUDE (id), c.* EXCLUDE (id), w.* EXCLUDE (id), v.* EXCLUDE (id), b.* EXCLUDE (id), pl.* EXCLUDE (id), po.* EXCLUDE (id), coalesce(pr.in_np, 0) in_np, coalesce(pr.in_prot, 0) in_prot, st.d_stop, st.stop_kind
  FROM pts p LEFT JOIN f_road r USING (id) LEFT JOIN f_cls c USING (id) LEFT JOIN f_water w USING (id) LEFT JOIN f_cover v USING (id) LEFT JOIN f_build b USING (id)
  LEFT JOIN f_place pl USING (id) LEFT JOIN f_poi po USING (id) LEFT JOIN f_prot pr USING (id) LEFT JOIN f_stop st USING (id)) TO '@OUT@' (FORMAT PARQUET);
