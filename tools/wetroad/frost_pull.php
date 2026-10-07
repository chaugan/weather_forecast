<?php
// Pulls Statens vegvesen road-station series from MET Frost for the wet-road fit (tools/wetroad/README.md).
// Runs on the server, piped over ssh (the Frost client id lives only in ~/wefo-config.php there; it is never printed):
//   ssh -o BatchMode=yes glettno@linweb21.hmg9.webhuset.no 'php -d date.timezone=Europe/Oslo -- [--sun] SN27055:2025-04-15/2025-06-15 ...' < frost_pull.php
// Each job is one station x one period (at most ~2 months, Frost's answer stays under its row limit). Writes nothing on the
// server: CSV goes to stdout, one block per job, opened by "#job <job> <http status> <rows>" and closed by "#end <job>" (a block
// cut off by a broken connection has no end line and is thrown away by pull.sh). 404 and 412 mean no data (an empty block).
// Several sensors of one element (timeSeriesId 0, 1, ...): the lowest index is kept.
$cfg = require getenv('HOME') . '/wefo-config.php'; $id = (string)($cfg['frost_client_id'] ?? '');
if ($id === '') { echo "#error no frost id\n"; exit(1); }
$E = ['road_surface_condition' => 'c', 'road_water_film_thickness' => 'w', 'sum(precipitation_amount PT10M)' => 'p', 'over_time(precipitation_type_road PT10M)' => 'pt',
  'air_temperature' => 'T', 'dew_point_temperature' => 'Td', 'max(wind_speed_of_gust PT10M)' => 'G', 'wind_speed_of_gust' => 'Gi', 'mean(road_surface_temperature PT1M)' => 'Ts', 'wind_speed' => 'ws'];
$args = array_slice($argv, 1);
if (($args[0] ?? '') === '--sun') {   // the cloud / sun stations paired by frost_pair.php: hourly cloud cover (oktas) and global radiation (W/m2)
  array_shift($args); $E = ['cloud_area_fraction' => 'N', 'mean(surface_downwelling_shortwave_flux_in_air PT1H)' => 'Q'];
}
$cols = array_values($E);
echo "#cols sid,t," . implode(',', $cols) . "\n";
foreach ($args as $job) {
  if (!preg_match('~^(SN\d+):(\d{4}-\d\d-\d\d)/(\d{4}-\d\d-\d\d)$~', $job, $m)) { echo "#job $job 400 0\n"; continue; }
  $c = curl_init('https://frost.met.no/observations/v0.jsonld?' . http_build_query(['sources' => $m[1], 'elements' => implode(',', array_keys($E)), 'referencetime' => "$m[2]/$m[3]"]));
  curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => 1, CURLOPT_USERPWD => $id . ':', CURLOPT_TIMEOUT => 240, CURLOPT_ENCODING => '', CURLOPT_USERAGENT => 'Glett wet-road research (+' . ($cfg['site_url'] ?? 'https://glett.no') . '; ' . ($cfg['contact_email'] ?? '') . ')']);
  $b = curl_exec($c); $s = (int)curl_getinfo($c, CURLINFO_HTTP_CODE); curl_close($c);
  $j = $s === 200 ? json_decode($b, true) : null; $rows = [];
  foreach ($j['data'] ?? [] as $o) {
    $t = substr($o['referenceTime'], 0, 16); $r = $rows[$t] ?? array_fill_keys($cols, ''); $ix = $r['_ix'] ?? [];
    foreach ($o['observations'] as $x) { $k = $E[$x['elementId']] ?? null; if ($k === null) continue; $si = (int)($x['timeSeriesId'] ?? 0);
      if (!isset($ix[$k]) || $si < $ix[$k]) { $ix[$k] = $si; $r[$k] = $x['value']; } }
    $r['_ix'] = $ix; $rows[$t] = $r;
  }
  echo "#job $job $s " . count($rows) . "\n";
  ksort($rows); foreach ($rows as $t => $r) { unset($r['_ix']); echo $m[1], ',', $t, ',', implode(',', $r), "\n"; }
  echo "#end $job\n"; flush();
  unset($j, $b, $rows);
}
