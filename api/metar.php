<?php
// Real observations for the reliability score: nearest METAR station (aviationweather.gov, which does not allow
// browser requests) and its hourly reports of the last 15 days. The browser (js/data.js) matches these with the
// archived model forecasts. Station per 0.1° cell cached 30 days, observations per station cached 24 h.
declare(strict_types=1);
require __DIR__ . '/db.php';

const METAR_HOURS = 360;      // how far back to ask (the API caps the number of reports)
const MAX_STATION_KM = 60;    // farthest station still considered representative
const STATION_TTL = 30 * 86400;
const OBS_TTL = 86400;

rate_limit();
housekeeping();
[$lat, $lon] = coords();
$lat = round($lat, 1);
$lon = round($lon, 1);

function haversine(float $la1, float $lo1, float $la2, float $lo2): float
{
    $dLa = deg2rad($la2 - $la1);
    $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 2 * 6371.0 * asin(min(1.0, sqrt($a)));
}

/* Nearest station that reported in the last 6 hours: array, null = none within range, false = upstream failure */
function find_station(float $lat, float $lon)
{
    $failed = false;
    foreach ([1.0, 2.5] as $d) {
        $bbox = sprintf('%.3f,%.3f,%.3f,%.3f', $lat - $d, $lon - $d, $lat + $d, $lon + $d);
        $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=6&bbox=' . $bbox, 7);
        if ($body === null) { $failed = true; continue; }
        $list = json_decode($body, true);
        if (!is_array($list) || !$list) continue;
        $best = null;
        foreach ($list as $o) {
            if (!isset($o['icaoId'], $o['lat'], $o['lon'])) continue;
            $km = haversine($lat, $lon, (float)$o['lat'], (float)$o['lon']);
            if ($best === null || $km < $best['km']) {
                $best = ['id' => (string)$o['icaoId'], 'name' => (string)($o['name'] ?? $o['icaoId']), 'lat' => (float)$o['lat'], 'lon' => (float)$o['lon'],
                         'km' => round($km, 1), 'elev' => isset($o['elev']) ? (float)$o['elev'] : null];
            }
        }
        if ($best && $best['km'] <= MAX_STATION_KM) return $best;
    }
    return $failed ? false : null;
}

/* Hourly observations (UTC hour key => values), one report per hour (the one closest to the full hour) */
function metar_hourly(string $icao): ?array
{
    $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=' . METAR_HOURS . '&ids=' . rawurlencode($icao), 10);
    if ($body === null) return null;
    $list = json_decode($body, true);
    if (!is_array($list)) return null;
    $cloudPct = ['CLR' => 0, 'SKC' => 0, 'NCD' => 0, 'NSC' => 0, 'CAVOK' => 0, 'FEW' => 19, 'SCT' => 44, 'BKN' => 81, 'OVC' => 100, 'VV' => 100];
    $best = [];
    $dts = [];
    foreach ($list as $o) {
        if (!isset($o['obsTime'])) continue;
        $ts = (int)$o['obsTime'];
        $hour = (int)(round($ts / 3600) * 3600);
        $dt = abs($ts - $hour);
        if ($dt > 1800) continue;
        $hk = gmdate('Y-m-d\TH:00', $hour);
        if (isset($dts[$hk]) && $dts[$hk] <= $dt) continue;

        $temp = isset($o['temp']) ? (float)$o['temp'] : null;
        $dew = isset($o['dewp']) ? (float)$o['dewp'] : null;
        $rh = null;
        if ($temp !== null && $dew !== null) {
            $rh = 100 * exp(17.625 * $dew / (243.04 + $dew)) / exp(17.625 * $temp / (243.04 + $temp));
            $rh = max(0.0, min(100.0, $rh));
        }
        $cover = $o['cover'] ?? null;
        $cloud = null;
        if (isset($o['clouds']) && is_array($o['clouds'])) {
            $cloud = 0;
            foreach ($o['clouds'] as $l) $cloud = max($cloud, $cloudPct[$l['cover'] ?? ''] ?? 0);
        } elseif ($cover !== null && isset($cloudPct[$cover])) {
            $cloud = $cloudPct[$cover];
        }
        $wx = strtoupper((string)($o['wxString'] ?? ''));
        $wet = (bool)preg_match('/(RA|DZ|SN|SG|PL|GR|GS|SH|TS|UP)/', $wx);
        if (str_contains($wx, 'TS')) $c = 'thunder';
        elseif (preg_match('/(SN|SG|PL|GS)/', $wx)) $c = 'snow';
        elseif ($wet) $c = 'rain';
        elseif (str_contains($wx, 'FG') && !str_contains($wx, 'BR')) $c = 'fog';
        elseif ($cloud !== null) $c = $cloud <= 25 ? 'clear' : ($cloud <= 70 ? 'partly' : 'cloudy');
        else $c = null;

        $dts[$hk] = $dt;
        $best[$hk] = [
            't' => $temp,
            'w' => isset($o['wspd']) ? round((float)$o['wspd'] * 1.852, 1) : null,   // knots -> km/h
            'c' => $cloud,
            'h' => $rh !== null ? round($rh, 1) : null,
            'p' => isset($o['slp']) ? (float)$o['slp'] : (isset($o['altim']) ? (float)$o['altim'] : null),
            'wet' => $wet,
            'cat' => $c,
        ];
    }
    ksort($best);
    return $best;
}

$cell = sprintf('%.1f:%.1f', $lat, $lon);
$st = cached("st:$cell", STATION_TTL, function () use ($lat, $lon) {
    $s = find_station($lat, $lon);
    return $s === false ? null : ['station' => $s];
});
if ($st === null) json_out(['error' => 'The METAR service did not answer'], 502);
$station = $st['station'] ?? null;
if (!$station) json_out(['station' => null, 'obs' => new stdClass()]);

$obs = cached('obs:' . $station['id'], OBS_TTL, function () use ($station) {
    $h = metar_hourly($station['id']);
    return $h === null ? null : ['obs' => $h];
});
if ($obs === null) json_out(['error' => 'The METAR service did not answer'], 502);
json_out(['station' => $station, 'obs' => $obs['obs'] ?: new stdClass()]);
