<?php
// Lists, for each SVV road station with road_surface_condition, the nearest Frost station within 25 km that has cloud cover
// (cloud_area_fraction) or global radiation (mean(surface_downwelling_shortwave_flux_in_air PT1H)). Decides whether the
// sun factor sSun can be fitted (tools/wetroad/README.md). Runs on the server over ssh-php like frost_pull.php; prints JSON only.
$cfg = require getenv('HOME') . '/wefo-config.php'; $id = (string)($cfg['frost_client_id'] ?? '');
function fg($path, $q) { global $id; $c = curl_init('https://frost.met.no' . $path . '?' . http_build_query($q)); curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => 1, CURLOPT_USERPWD => $id . ':', CURLOPT_TIMEOUT => 120, CURLOPT_ENCODING => '']); $b = curl_exec($c); $s = curl_getinfo($c, CURLINFO_HTTP_CODE); curl_close($c); return [$s, json_decode($b, true)]; }
$ser = []; foreach (['road_surface_condition', 'cloud_area_fraction', 'mean(surface_downwelling_shortwave_flux_in_air PT1H)', 'mean(surface_downwelling_shortwave_flux_in_air PT1M)'] as $el) {
  [$s, $j] = fg('/observations/availableTimeSeries/v0.jsonld', ['elements' => $el, 'fields' => 'sourceId,validFrom,validTo']);
  foreach ($j['data'] ?? [] as $r) { $sid = explode(':', $r['sourceId'])[0]; if (empty($r['validTo']) || $r['validTo'] > '2022-04-15') $ser[$el][$sid] = 1; }
}
$all = array_unique(array_merge(...array_map('array_keys', array_values($ser)))); $pos = [];
foreach (array_chunk($all, 100) as $ch) { [$s, $j] = fg('/sources/v0.jsonld', ['ids' => implode(',', $ch), 'fields' => 'id,geometry']); foreach ($j['data'] ?? [] as $x) if (isset($x['geometry'])) $pos[$x['id']] = $x['geometry']['coordinates']; }
function km($a, $b) { $r = M_PI / 180; $x = ($b[0] - $a[0]) * $r * cos(($a[1] + $b[1]) / 2 * $r); $y = ($b[1] - $a[1]) * $r; return 6371 * sqrt($x * $x + $y * $y); }
$out = [];
foreach (array_keys($ser['road_surface_condition']) as $rs) { if (!isset($pos[$rs])) continue; $best = [];
  foreach (['cloud' => ['cloud_area_fraction'], 'rad' => ['mean(surface_downwelling_shortwave_flux_in_air PT1H)', 'mean(surface_downwelling_shortwave_flux_in_air PT1M)']] as $k => $els)
    foreach ($els as $el) foreach (array_keys($ser[$el] ?? []) as $o) if (isset($pos[$o]) && ($d = km($pos[$rs], $pos[$o])) <= 25 && (!isset($best[$k]) || $d < $best[$k][1])) $best[$k] = [$o, round($d, 1), $el];
  $out[$rs] = $best;
}
echo json_encode(['n' => count($out), 'withCloud' => count(array_filter($out, fn($b) => isset($b['cloud']))), 'withRad' => count(array_filter($out, fn($b) => isset($b['rad']))), 'withEither' => count(array_filter($out)), 'pairs' => $out]);
