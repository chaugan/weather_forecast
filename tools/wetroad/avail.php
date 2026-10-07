<?php
// Which Frost series exist for the wet-road fit (road state, 10-min rain, temperature, dew point, gust ...), from when to when,
// and where the road stations are. Runs on the server over ssh-php like frost_pull.php; prints JSON (series + src), never the key.
$cfg = require getenv('HOME') . '/wefo-config.php'; $id = (string)($cfg['frost_client_id'] ?? '');
function fg($path, $q) { global $id; $c = curl_init('https://frost.met.no' . $path . '?' . http_build_query($q)); curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => 1, CURLOPT_USERPWD => $id . ':', CURLOPT_TIMEOUT => 120, CURLOPT_ENCODING => '']); $b = curl_exec($c); $s = curl_getinfo($c, CURLINFO_HTTP_CODE); curl_close($c); return [$s, json_decode($b, true)]; }
$out = ['series' => [], 'src' => []];
foreach (['road_surface_condition', 'sum(precipitation_amount PT10M)', 'road_water_film_thickness', 'dew_point_temperature', 'air_temperature', 'max(wind_speed_of_gust PT10M)', 'wind_speed_of_gust', 'mean(road_surface_temperature PT1M)', 'wind_speed'] as $el) {
  [$s, $j] = fg('/observations/availableTimeSeries/v0.jsonld', ['elements' => $el, 'fields' => 'sourceId,validFrom,validTo,timeResolution,level']);
  foreach ($j['data'] ?? [] as $r) $out['series'][] = [$el, $r['sourceId'], substr($r['validFrom'] ?? '', 0, 10), substr($r['validTo'] ?? '', 0, 10), $r['timeResolution'] ?? '', $r['level']['value'] ?? null];
  fwrite(STDERR, "$el HTTP $s n=" . count($j['data'] ?? []) . "\n");
}
$ids = []; foreach ($out['series'] as $r) if ($r[0] === 'road_surface_condition') $ids[explode(':', $r[1])[0]] = 1;
[$s, $j] = fg('/sources/v0.jsonld', ['ids' => implode(',', array_keys($ids)), 'fields' => 'id,name,masl,county,geometry,stationHolders']);
foreach ($j['data'] ?? [] as $x) $out['src'][$x['id']] = ['name' => $x['name'] ?? '', 'county' => $x['county'] ?? '', 'masl' => $x['masl'] ?? null, 'lon' => $x['geometry']['coordinates'][0] ?? null, 'lat' => $x['geometry']['coordinates'][1] ?? null, 'h' => implode(',', $x['stationHolders'] ?? [])];
echo json_encode($out, JSON_UNESCAPED_UNICODE);
