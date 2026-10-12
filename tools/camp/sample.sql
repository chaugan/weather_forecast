-- Nattplass: candidate road points every 60 m along drivable minor roads, plus the mapped stopping places, into table pts.
LOAD spatial;
CREATE OR REPLACE TABLE pts AS
WITH r AS (SELECT row_number() OVER () rid, hw, surf, grade, g, ST_Length(g) len FROM roads
  WHERE hw IN ('unclassified', 'track', 'tertiary', 'service') AND coalesce(svc, '') NOT IN ('driveway', 'parking_aisle', 'alley', 'drive-through', 'emergency_access', 'queue_lane')
    AND coalesce(acc, '') NOT IN ('no', 'private', 'agricultural', 'forestry', 'delivery', 'emergency', 'military', 'permit', 'bus', 'psv')
    AND coalesce(grade, '') NOT IN ('grade5') AND coalesce(surf, '') NOT IN ('mud', 'sand', 'grass') AND ST_Length(g) >= 30)
SELECT 's' || rid || '_' || i AS id, 'road' AS src, ST_LineInterpolatePoint(g, (i + 0.5) / greatest(1, floor(len / 60))) AS g
FROM r, range(0, CAST(greatest(1, floor(len / 60)) AS BIGINT)) t(i);
INSERT INTO pts SELECT 'n' || row_number() OVER () id, 'stop:' || kind src, g FROM nstops;
INSERT INTO pts SELECT 'o' || row_number() OVER () id, 'osm:' || k src, g FROM pois WHERE k IN ('parking', 'rest_area', 'turning_circle', 'turning_loop') AND coalesce(acc, '') NOT IN ('private', 'no', 'customers');
SELECT src, count(*) FROM pts GROUP BY 1 ORDER BY 2 DESC;
