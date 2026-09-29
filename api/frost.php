<?php
// Weather history for Norwegian places from MET Norway's Frost API (daily station observations, https://frost.met.no).
// Frost needs a registered client ID, so the browser talks to this endpoint, which caches everything in MySQL:
//   ?lat=&lon=                      -> nearest station with a long daily temperature series (cached 30 days per 0.05° cell)
//   ?station=SN18700&from=1991&to=1995 -> compact daily series for up to 5 years (closed years cached 90 days, the current one 6 h)
// The browser stores the assembled series in IndexedDB, so a station is fetched once per visitor, not per visit.
declare(strict_types=1);
require __DIR__ . '/db.php';

const FROST = 'https://frost.met.no';
const FROST_MAX_KM = 40;            // farthest station still considered representative
const FROST_MIN_YEARS = 20;         // prefer the closest station with at least this much history
const FROST_STATION_TTL = 30 * 86400;
const FROST_CLOSED_TTL = 90 * 86400;
const FROST_OPEN_TTL = 6 * 3600;
const FROST_MAX_SPAN = 10;          // years per chunk (a chunk is ~50 KB compressed; keeps a long station chain within the per-client request limit)
// Frost element -> column of the series (values as the browser expects them: °C, mm, km/h, cm)
const FROST_ELEMENTS = [
    'max(air_temperature P1D)' => 'tmax', 'min(air_temperature P1D)' => 'tmin', 'mean(air_temperature P1D)' => 'tmean',
    'sum(precipitation_amount P1D)' => 'prcp', 'max(wind_speed P1D)' => 'wmax', 'max(wind_speed_of_gust P1D)' => 'gust',
    'surface_snow_thickness' => 'snow',
];
// Frost keeps several daily series per element, one per time window (offset from 00 UTC). The oldest records are
// usually under the classic climatological windows (18-18 UTC for max/min, 06-06 for precipitation and snow), so
// all offsets are requested and, per day and column, the first one in this preference list wins.
const FROST_OFFSETS = [
    'tmax' => ['PT18H', 'PT0H', 'PT6H'], 'tmin' => ['PT18H', 'PT0H', 'PT6H'], 'tmean' => ['PT0H', 'PT6H', 'PT18H'],
    'prcp' => ['PT6H', 'PT18H', 'PT0H'], 'wmax' => ['PT0H', 'PT18H', 'PT6H'], 'gust' => ['PT18H', 'PT0H', 'PT6H'], 'snow' => ['PT6H', 'PT0H', 'PT18H'],
];

rate_limit();
housekeeping();
$clientId = (string)(app_config()['frost_client_id'] ?? '');
if ($clientId === '') json_out(['error' => 'Frost is not configured on this server', 'unavailable' => true], 503);

/* Frost answer as an array; a 404/412 ("no data for this request") comes back as ['error' => ...] so the caller can treat it as empty */
function frost_get(string $path, array $params, int $timeout = 12): ?array
{
    global $clientId;
    [$status, $body] = http_get_status(FROST . $path . '?' . http_build_query($params), $timeout, [], $clientId);
    if ($body === null || ($status !== 200 && $status !== 404 && $status !== 412)) {
        if ($status) error_log("Glett frost: HTTP $status for $path " . substr((string)$body, 0, 200));
        return null;
    }
    $j = json_decode($body, true);
    return is_array($j) ? $j : null;
}

function haversine(float $la1, float $lo1, float $la2, float $lo2): float
{
    $dLa = deg2rad($la2 - $la1);
    $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 2 * 6371.0 * asin(min(1.0, sqrt($a)));
}

/* ------------------------------------------------------------ hourly observations to score the models against ("truth")
   ?truth=1&lat=&lon=&from=YYYY-MM-DD&to=YYYY-MM-DD (at most 35 days, up to today)
   For each measurement the nearest MET station (within 40 km) that currently reports it; hourly values in UTC.
   Clouds are often manual (every 6 h, e.g. Blindern): those hours are used as they come. */
const TRUTH_ELEMENTS = [
    'air_temperature' => 't', 'wind_speed' => 'w', 'relative_humidity' => 'h', 'air_pressure_at_sea_level' => 'p',
    'cloud_area_fraction' => 'c', 'sum(precipitation_amount PT1H)' => 'r',
];
const TRUTH_MAX_KM = 40;
if (isset($_GET['truth'])) {
    [$lat, $lon] = coords();
    $from = (string)($_GET['from'] ?? ''); $to = (string)($_GET['to'] ?? '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) || $to < $from
        || strtotime($to) > time() + 86400 || (strtotime($to) - strtotime($from)) / 86400 > 35) json_out(['error' => 'Invalid parameters'], 400);
    $cell = sprintf('%.2f:%.2f', round($lat * 20) / 20, round($lon * 20) / 20);
    // 1) which station for which measurement (cached a week per cell)
    $pick = cached("frost:truthst3:$cell", 7 * 86400, function () use ($lat, $lon) {
        $src = frost_get('/sources/v0.jsonld', ['types' => 'SensorSystem', 'geometry' => sprintf('nearest(POINT(%.4f %.4f))', $lon, $lat), 'nearestmaxcount' => 150], 12);
        if ($src === null) return null;
        $c = [];
        foreach ($src['data'] ?? [] as $x) {
            if (empty($x['id']) || empty($x['geometry']['coordinates'])) continue;
            $km = haversine($lat, $lon, (float)$x['geometry']['coordinates'][1], (float)$x['geometry']['coordinates'][0]);
            if ($km <= TRUTH_MAX_KM) $c[$x['id']] = ['id' => $x['id'], 'name' => (string)($x['name'] ?? $x['id']), 'km' => round($km, 1)];
        }
        if (!$c) return ['stations' => []];
        $has = [];
        foreach (array_chunk(array_keys($c), 50) as $chunk) {
            $ts = frost_get('/observations/availableTimeSeries/v0.jsonld', ['sources' => implode(',', $chunk), 'elements' => implode(',', array_keys(TRUTH_ELEMENTS)),
                'referencetime' => gmdate('Y-m-d', time() - 3 * 86400) . '/' . gmdate('Y-m-d', time() + 86400)], 12);
            if ($ts === null) return null;
            foreach ($ts['data'] ?? [] as $t) {
                $sid = explode(':', (string)($t['sourceId'] ?? ''))[0]; $res = (string)($t['timeResolution'] ?? ''); $el = (string)($t['elementId'] ?? '');
                $ok = $el === 'cloud_area_fraction' ? in_array($res, ['PT1H', 'PT3H', 'PT6H', 'PT12H'], true) : $res === 'PT1H';   // hourly series (clouds: manual every 3-12 h is fine)
                if (isset($c[$sid]) && $ok) $has[$el][$sid] = true;
            }
        }
        $out = [];
        foreach (TRUTH_ELEMENTS as $el => $k) {
            $list = array_map(fn($sid) => $c[$sid], array_keys($has[$el] ?? []));
            usort($list, fn($a, $b) => $a['km'] <=> $b['km']);
            if ($list) $out[$k] = array_slice($list, 0, 4);   // nearest first; the next one is used if a station returns too little
        }
        return ['candidates' => $out];
    });
    if ($pick === null) json_out(['error' => 'Frost did not answer', 'unavailable' => true], 502);
    // 2) the observations, grouped per station (cached 6 hours per cell and period)
    $res = cached("frost:truth4:$cell:$from:$to", 6 * 3600, function () use ($pick, $from, $to) {
        $obs = []; $used = [];
        $fetch = function (string $sid, array $els) use (&$obs, $from, $to): ?int {
            $j = frost_get('/observations/v0.jsonld', ['sources' => $sid, 'elements' => implode(',', $els), 'referencetime' => $from . '/' . gmdate('Y-m-d', strtotime($to) + 86400),
                'timeresolutions' => 'PT1H,PT6H,PT12H', 'fields' => 'referenceTime,elementId,value,qualityCode,timeResolution'], 20);
            if ($j === null) return null;
            $n = 0;
            foreach ($j['data'] ?? [] as $row) {
                $rt = (string)($row['referenceTime'] ?? '');
                if (substr($rt, 14, 5) !== '00:00') continue;   // full hours only
                $hk = substr($rt, 0, 13) . ':00';
                foreach ($row['observations'] ?? [] as $o) {
                    $k = TRUTH_ELEMENTS[$o['elementId'] ?? ''] ?? null;
                    if ($k === null || !isset($o['value']) || (int)($o['qualityCode'] ?? 0) >= 6 || isset($obs[$hk][$k])) continue;
                    $v = (float)$o['value'];
                    if ($k === 'w') $v = round($v * 3.6, 1);                       // m/s -> km/h (the models' unit here)
                    if ($k === 'c') { if ($v > 8) $v = 8; $v = round($v / 8 * 100); } // oktas -> %; 9 (sky obscured) = overcast
                    $obs[$hk][$k] = $v; $n++;
                }
            }
            return $n;
        };
        $count = function (string $k) use (&$obs): int { return count(array_filter($obs, fn($o) => isset($o[$k]))); };   // by reference: counts what has been fetched so far
        // first pass: the nearest station per measurement, grouped per station (one request each)
        $byStation = []; $stInfo = [];
        foreach ($pick['candidates'] ?? [] as $k => $list) { $byStation[$list[0]['id']][] = array_search($k, TRUTH_ELEMENTS, true); $stInfo[$list[0]['id']] = $list[0]; $used[$k] = $list[0]; }
        foreach ($byStation as $sid => $els) if ($fetch($sid, $els) === null) return null;
        // measurements that came back (nearly) empty: try the next stations in turn
        foreach ($pick['candidates'] ?? [] as $k => $list) {
            for ($i = 1; $i < count($list) && $count($k) < 24; $i++) {
                if ($fetch($list[$i]['id'], [array_search($k, TRUTH_ELEMENTS, true)]) === null) return null;
                $used[$k] = $list[$i];
            }
            if ($count($k) < 24) unset($used[$k]);
        }
        ksort($obs);
        return ['stations' => $used, 'obs' => $obs];
    });
    if ($res === null) json_out(['error' => 'Frost did not answer', 'unavailable' => true], 502);
    json_out($res);
}

/* ------------------------------------------------------------ nearest station with a long daily series */
if (isset($_GET['lat'], $_GET['lon'])) {
    [$lat, $lon] = coords();
    $lat = round($lat, 2);   // ~1 km cells share one lookup (rounded to 0.05° below)
    $lon = round($lon, 2);
    $cell = sprintf('%.2f:%.2f', round($lat * 20) / 20, round($lon * 20) / 20);
    $res = cached("frost:st:$cell", FROST_STATION_TTL, function () use ($lat, $lon) {
        // Every station that ever operated near the point (closed ones included: the old records live there)
        $src = frost_get('/sources/v0.jsonld', [
            'types' => 'SensorSystem', 'validtime' => '1850-01-01/2100-01-01',
            'geometry' => sprintf('nearest(POINT(%.4f %.4f))', $lon, $lat), 'nearestmaxcount' => 60,
        ], 10);
        if ($src === null) return null;
        if (isset($src['error'])) return ['station' => null];
        $cands = [];
        foreach ($src['data'] ?? [] as $s) {
            if (empty($s['id']) || empty($s['geometry']['coordinates'])) continue;
            $sLon = (float)$s['geometry']['coordinates'][0];
            $sLat = (float)$s['geometry']['coordinates'][1];
            $km = haversine($lat, $lon, $sLat, $sLon);
            if ($km > FROST_MAX_KM) continue;
            $cands[$s['id']] = ['id' => $s['id'], 'name' => (string)($s['name'] ?? $s['id']), 'lat' => $sLat, 'lon' => $sLon, 'km' => round($km, 1), 'masl' => isset($s['masl']) ? (float)$s['masl'] : null];
        }
        if (!$cands) return ['station' => null];
        // Period covered by each station's daily mean temperature (any time window)
        $ts = frost_get('/observations/availableTimeSeries/v0.jsonld', [
            'sources' => implode(',', array_keys($cands)), 'elements' => 'mean(air_temperature P1D)', 'timeresolutions' => 'P1D',
        ], 10);
        if ($ts === null) return null;
        if (isset($ts['error'])) return ['station' => null];
        foreach ($ts['data'] ?? [] as $t) {
            $id = explode(':', (string)($t['sourceId'] ?? ''))[0];
            if (!isset($cands[$id]) || empty($t['validFrom'])) continue;
            $from = substr((string)$t['validFrom'], 0, 10);
            $to = empty($t['validTo']) ? null : substr((string)$t['validTo'], 0, 10);
            $c = &$cands[$id];
            if (!isset($c['from']) || $from < $c['from']) $c['from'] = $from;
            if (!array_key_exists('to', $c) || $to === null || ($c['to'] !== null && $to > $c['to'])) $c['to'] = $to;
            unset($c);
        }
        $cands = array_filter($cands, fn($c) => isset($c['from']));
        if (!$cands) return ['station' => null];
        $alive = array_filter($cands, fn($c) => $c['to'] === null || strtotime($c['to']) > time() - 30 * 86400);
        if (!$alive) return ['station' => null];
        // Current station: the closest one still reporting with a long record, else the longest still reporting
        $years = fn($c) => (int)date('Y') - (int)substr($c['from'], 0, 4);
        usort($alive, fn($a, $b) => $a['km'] <=> $b['km']);
        $primary = null;
        foreach ($alive as $c) if ($years($c) >= FROST_MIN_YEARS) { $primary = $c; break; }
        if (!$primary) { usort($alive, fn($a, $b) => $b['from'] <=> $a['from']); $primary = end($alive); }
        // Predecessors: closed (or other) stations whose record starts well before the chain's earliest day and
        // reaches (nearly) up to it, closest first. This is how a town keeps its history across station moves.
        $chain = [$primary];
        $used = [$primary['id'] => true];
        while (count($chain) < 6) {
            $earliest = end($chain)['from'];
            $need = date('Y-m-d', strtotime($earliest . ' -5 years'));
            $best = null;
            foreach ($cands as $c) {
                if (isset($used[$c['id']]) || $c['from'] > $need) continue;                                   // must add at least 5 years
                $to = $c['to'] ?? date('Y-m-d');
                if ($to < date('Y-m-d', strtotime($earliest . ' -2 years'))) continue;                        // must (nearly) connect
                if ($best === null || $c['km'] < $best['km']) $best = $c;
            }
            if (!$best) break;
            $chain[] = $best; $used[$best['id']] = true;
        }
        $out = array_map(fn($c) => ['id' => $c['id'], 'name' => $c['name'], 'lat' => $c['lat'], 'lon' => $c['lon'], 'km' => $c['km'], 'masl' => $c['masl'], 'from' => $c['from'], 'to' => $c['to']], $chain);
        $st = $out[0]; $st['from'] = end($out)['from'];   // the primary carries the chain's earliest day
        return ['station' => $st, 'chain' => $out];
    });
    if ($res === null) json_out(['error' => 'Frost did not answer', 'unavailable' => true], 502);
    json_out($res);
}

/* ------------------------------------------------------------ one chunk of daily observations */
$station = (string)($_GET['station'] ?? '');
$from = (int)($_GET['from'] ?? 0);
$to = (int)($_GET['to'] ?? 0);
$thisYear = (int)gmdate('Y');
if (!preg_match('/^SN\d{1,6}$/', $station) || $from < 1800 || $to < $from || $to > $thisYear || $to - $from + 1 > FROST_MAX_SPAN) json_out(['error' => 'Invalid parameters'], 400);

$ttl = $to < $thisYear ? FROST_CLOSED_TTL : FROST_OPEN_TTL;
$res = cached("frost:obs:$station:$from-$to", $ttl, function () use ($station, $from, $to) {
    $j = frost_get('/observations/v0.jsonld', [
        'sources' => $station, 'referencetime' => sprintf('%04d-01-01/%04d-01-01', $from, $to + 1),
        'elements' => implode(',', array_keys(FROST_ELEMENTS)), 'timeresolutions' => 'P1D', 'levels' => 'default',
        'fields' => 'referenceTime,elementId,value,qualityCode,timeOffset',
    ], 12);
    if ($j === null) return null;
    if (isset($j['error'])) {
        // 404 / 412 = no data for that period at this station: a legitimate, cacheable empty answer
        if (in_array((int)($j['error']['code'] ?? 0), [404, 412], true)) return ['d' => [], 'tmax' => [], 'tmin' => [], 'tmean' => [], 'prcp' => [], 'wmax' => [], 'gust' => [], 'snow' => []];
        error_log('Glett frost: ' . json_encode($j['error']));
        return null;
    }
    $days = []; $rank = [];
    foreach ($j['data'] ?? [] as $row) {
        $d = substr((string)($row['referenceTime'] ?? ''), 0, 10);
        if (strlen($d) !== 10) continue;
        foreach ($row['observations'] ?? [] as $o) {
            $col = FROST_ELEMENTS[$o['elementId'] ?? ''] ?? null;
            if ($col === null || !isset($o['value']) || (int)($o['qualityCode'] ?? 0) >= 6) continue;   // 6, 7 = erroneous
            $r = array_search((string)($o['timeOffset'] ?? ''), FROST_OFFSETS[$col], true);
            $r = $r === false ? 9 : $r;
            if (isset($rank[$d][$col]) && $rank[$d][$col] <= $r) continue;   // a preferred window already gave this day
            $v = (float)$o['value'];
            if ($col === 'wmax' || $col === 'gust') $v = round($v * 3.6, 1);   // m/s -> km/h
            $days[$d][$col] = $v; $rank[$d][$col] = $r;
        }
    }
    ksort($days);
    $out = ['d' => [], 'tmax' => [], 'tmin' => [], 'tmean' => [], 'prcp' => [], 'wmax' => [], 'gust' => [], 'snow' => []];
    foreach ($days as $d => $v) {
        if (!isset($v['tmax']) && !isset($v['tmin']) && !isset($v['tmean']) && !isset($v['prcp'])) continue;
        $out['d'][] = $d;
        foreach (['tmax', 'tmin', 'tmean', 'prcp', 'wmax', 'gust', 'snow'] as $c) $out[$c][] = $v[$c] ?? null;
    }
    return $out;
});
if ($res === null) json_out(['error' => 'Frost did not answer', 'unavailable' => true], 502);
json_out($res);
