<?php
// "Measured nearby right now": a robust average of the public Netatmo weather stations around a point.
// Netatmo's public-data API needs an OAuth token (so this runs on the server), gives no history, and its sensors sit on
// balconies and walls, so the endpoint takes the median, drops outliers, and requires a minimum number of stations.
// The bounding box grows (0.1° -> 0.25° -> 0.5°) until enough stations report. Cached 10 minutes per 0.05° cell, and every
// fetch also stores one hourly snapshot per cell (Glett's own local observation series, since Netatmo keeps none).
declare(strict_types=1);
require __DIR__ . '/db.php';

const NETATMO_TTL = 600;             // cache per cell
const NETATMO_MIN_STATIONS = 5;      // fewer than this after outlier removal = widen the box / no answer
const NETATMO_MAX_AGE = 1800;        // ignore readings older than this (s)
const NETATMO_RADII = [0.05, 0.1, 0.25, 0.5];   // degrees of latitude (about 5, 11, 28, 55 km); longitude is scaled by cos(lat)

rate_limit();
housekeeping();
$cfg = app_config();
if (empty($cfg['netatmo_client_id']) || empty($cfg['netatmo_client_secret']) || empty($cfg['netatmo_refresh_token'])) json_out(['error' => 'Netatmo is not configured', 'unavailable' => true], 503);
[$lat, $lon] = coords();
$cell = sprintf('%.2f:%.2f', round($lat * 20) / 20, round($lon * 20) / 20);

/* ?history=1&lat=&lon=&days=N: Glett's own stored hourly snapshots for this cell (used to score the models locally) */
if (isset($_GET['history'])) {
    $days = max(1, min(35, (int)($_GET['days'] ?? 28)));
    $rows = [];
    try {
        foreach (q('SELECT hour, n, temp, hum, rain1h, wet_share FROM obs_local WHERE cell = ? AND hour >= ? ORDER BY hour', [$cell, time() - $days * 86400])->fetchAll() as $r) {
            $rows[gmdate('Y-m-d\\TH:00', (int)$r['hour'])] = ['n' => (int)$r['n'], 't' => $r['temp'] !== null ? (float)$r['temp'] : null, 'h' => $r['hum'] !== null ? (float)$r['hum'] : null,
                'r' => $r['rain1h'] !== null ? (float)$r['rain1h'] : null, 'ws' => $r['wet_share'] !== null ? (float)$r['wet_share'] : null];
        }
    } catch (PDOException $e) { /* table not created yet: no snapshots */ }
    json_out(['cell' => $cell, 'obs' => $rows]);
}

/* Small key/value store (survives the cache table's size cap) for the rotating refresh token */
function kv_get(string $k): ?string
{
    try { $r = q('SELECT v FROM kv WHERE k = ?', [$k])->fetch(); return $r ? (string)$r['v'] : null; }
    catch (PDOException $e) { return null; }
}
function kv_put(string $k, string $v): void
{
    try { q('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = ?, updated_at = ?', [$k, $v, time(), $v, time()]); }
    catch (PDOException $e) {
        db()->exec('CREATE TABLE IF NOT EXISTS kv (k VARCHAR(64) NOT NULL PRIMARY KEY, v TEXT NOT NULL, updated_at INT UNSIGNED NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        q('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = ?, updated_at = ?', [$k, $v, time(), $v, time()]);
    }
}

/* Access token: cached until shortly before it expires; refreshed with the newest refresh token we hold (Netatmo rotates them) */
function netatmo_token(): ?string
{
    $acc = cache_get('netatmo:access');
    if ($acc !== null) return $acc;
    $got = (int)(q('SELECT GET_LOCK(?, 10) l', ['glett:netatmo'])->fetch()['l'] ?? 0);
    try {
        $acc = cache_get('netatmo:access');
        if ($acc !== null) return $acc;
        $c = app_config();
        $candidates = array_values(array_unique(array_filter([kv_get('netatmo:refresh'), (string)$c['netatmo_refresh_token']])));
        foreach ($candidates as $rt) {
            $ch = curl_init('https://api.netatmo.com/oauth2/token');
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_TIMEOUT => 10, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_USERAGENT => user_agent(),
                CURLOPT_POSTFIELDS => http_build_query(['grant_type' => 'refresh_token', 'refresh_token' => $rt, 'client_id' => $c['netatmo_client_id'], 'client_secret' => $c['netatmo_client_secret']])]);
            $body = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
            $j = $body ? json_decode($body, true) : null;
            if ($status === 200 && !empty($j['access_token'])) {
                if (!empty($j['refresh_token'])) kv_put('netatmo:refresh', (string)$j['refresh_token']);   // rotated: keep the new one
                cache_put('netatmo:access', (string)$j['access_token'], max(60, (int)($j['expires_in'] ?? 10800) - 120));
                return (string)$j['access_token'];
            }
            error_log('Glett netatmo token: HTTP ' . $status . ' ' . substr((string)$body, 0, 160));
        }
        return null;
    } finally {
        if ($got === 1) q('SELECT RELEASE_LOCK(?)', ['glett:netatmo']);
    }
}

function haversine(float $la1, float $lo1, float $la2, float $lo2): float
{
    $dLa = deg2rad($la2 - $la1); $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 2 * 6371.0 * asin(min(1.0, sqrt($a)));
}
function median(array $v): ?float { if (!$v) return null; sort($v); $n = count($v); return $n % 2 ? $v[intdiv($n, 2)] : ($v[$n / 2 - 1] + $v[$n / 2]) / 2; }
/* Median-based robust mean: drop values further than 2.5 scaled MADs (at least $minDev) from the median */
function robust(array $vals, float $minDev): ?array
{
    if (count($vals) < 3) return null;
    $med = median($vals);
    $mad = median(array_map(fn($x) => abs($x - $med), $vals)) * 1.4826;
    $tol = max($minDev, 2.5 * $mad);
    $kept = array_values(array_filter($vals, fn($x) => abs($x - $med) <= $tol));
    if (count($kept) < 3) return null;
    return ['v' => round(array_sum($kept) / count($kept), 1), 'median' => round($med, 1), 'n' => count($kept), 'dropped' => count($vals) - count($kept), 'min' => round(min($kept), 1), 'max' => round(max($kept), 1)];
}

/* The stations as an anonymised field for the local map: averaged per 0.01° cell (about 1 km), no ids, nearest 150 cells,
   obviously broken sensors (more than 8° from the median: indoor units, sun-baked walls) left out. [lat, lon, altitude, temp, n, rain_1h] */
function points_1km(array $pts, ?float $median, float $lat, float $lon, int $limit = 150): array
{
    $cells = [];
    foreach ($pts as [$la, $lo, $alt, $t, $rain]) {
        if ($median !== null && abs($t - $median) > 8.0) continue;
        $k = sprintf('%.2f:%.2f', round($la * 100) / 100, round($lo * 100) / 100);
        $c = &$cells[$k];
        if (!$c) $c = ['la' => round($la * 100) / 100, 'lo' => round($lo * 100) / 100, 'n' => 0, 't' => 0.0, 'alt' => 0.0, 'na' => 0, 'r' => null, 'nr' => 0];
        $c['n']++; $c['t'] += $t;
        if ($alt !== null) { $c['alt'] += $alt; $c['na']++; }
        if ($rain !== null) { $c['r'] = ($c['r'] ?? 0.0) + $rain; $c['nr']++; }
        unset($c);
    }
    $out = [];
    foreach ($cells as $c) {
        $out[] = [$c['la'], $c['lo'], $c['na'] ? (int)round($c['alt'] / $c['na']) : null, round($c['t'] / $c['n'], 1), $c['n'], $c['nr'] ? round($c['r'] / $c['nr'], 1) : null];
    }
    usort($out, fn($a, $b) => haversine($lat, $lon, $a[0], $a[1]) <=> haversine($lat, $lon, $b[0], $b[1]));
    return array_slice($out, 0, $limit);
}

function netatmo_fetch(float $lat, float $lon, float $r, string $token, int $limit = 150): ?array
{
    $dlon = $r / max(0.2, cos(deg2rad($lat)));
    $url = 'https://api.netatmo.com/api/getpublicdata?' . http_build_query(['lat_ne' => round($lat + $r, 4), 'lon_ne' => round($lon + $dlon, 4), 'lat_sw' => round($lat - $r, 4), 'lon_sw' => round($lon - $dlon, 4), 'filter' => 'true']);
    [$status, $body] = http_get_status($url, 12, ['Authorization: Bearer ' . $token]);
    if ($status >= 500 || $status === 0) { usleep(400000); [$status, $body] = http_get_status($url, 12, ['Authorization: Bearer ' . $token]); }   // Netatmo hiccups: one retry
    if ($status !== 200 || !$body) { error_log('Glett netatmo public data: HTTP ' . $status); return null; }
    $j = json_decode($body, true);
    $now = time(); $temps = []; $hums = []; $press = []; $rain = []; $wind = []; $gust = []; $ages = []; $n = 0; $pts = [];
    foreach ($j['body'] ?? [] as $s) {
        $n++;
        $sLat = $s['place']['location'][1] ?? null; $sLon = $s['place']['location'][0] ?? null; $sAlt = $s['place']['altitude'] ?? null; $sTemp = null; $sRain = null;
        foreach ($s['measures'] ?? [] as $m) {
            if (isset($m['type'], $m['res']) && is_array($m['res'])) {
                $ts = (int)array_key_first($m['res']); $vals = array_values($m['res'])[0] ?? [];
                if ($now - $ts > NETATMO_MAX_AGE) continue;
                foreach ($m['type'] as $i => $ty) {
                    $v = $vals[$i] ?? null; if ($v === null) continue;
                    if ($ty === 'temperature') { $temps[] = (float)$v; $ages[] = $now - $ts; $sTemp = (float)$v; }
                    elseif ($ty === 'humidity') $hums[] = (float)$v;
                    elseif ($ty === 'pressure') $press[] = (float)$v;
                }
            }
            if (isset($m['rain_60min']) && isset($m['rain_timeutc']) && $now - (int)$m['rain_timeutc'] <= NETATMO_MAX_AGE) { $rain[] = (float)$m['rain_60min']; $sRain = (float)$m['rain_60min']; }
            if (isset($m['wind_strength']) && isset($m['wind_timeutc']) && $now - (int)$m['wind_timeutc'] <= NETATMO_MAX_AGE) { $wind[] = (float)$m['wind_strength']; if (isset($m['gust_strength'])) $gust[] = (float)$m['gust_strength']; }
        }
        if ($sTemp !== null && is_numeric($sLat) && is_numeric($sLon)) $pts[] = [(float)$sLat, (float)$sLon, is_numeric($sAlt) ? (float)$sAlt : null, $sTemp, $sRain];
    }
    $t = robust($temps, 1.0);
    return ['stations' => $n, 'pts' => points_1km($pts, $t ? $t['median'] : null, $lat, $lon, $limit), 'radius_km' => round(haversine($lat, $lon, $lat + $r, $lon), 0), 'age_s' => $ages ? (int)median($ages) : null,
        'temp' => $t, 'hum' => robust($hums, 5.0), 'pres' => robust($press, 2.0),
        'rain' => $rain ? ['n' => count($rain), 'mm_1h' => round(median($rain), 1), 'wet_share' => round(count(array_filter($rain, fn($x) => $x >= 0.2)) / count($rain), 2)] : null,
        'wind' => $wind ? ['n' => count($wind), 'kmh' => round(median($wind), 1), 'gust_kmh' => $gust ? round(median($gust), 1) : null] : null];
}

/* ?map=1&lat=&lon=: cells only for one map area (a fixed box of ±0.25°, about 55 km, up to 300 cells), for the temperature map as it is
   panned; cached per 0.05° cell like the main answer, no snapshot */
if (isset($_GET['map'])) {
    $res = cached("netatmo:map:$cell", NETATMO_TTL, function () use ($lat, $lon) {
        $token = netatmo_token();
        if ($token === null) return null;
        $out = netatmo_fetch($lat, $lon, 0.25, $token, 300);
        return $out === null ? null : ['ok' => true, 'stations' => $out['stations'], 'pts' => $out['pts']];
    });
    if ($res === null) json_out(['error' => 'Netatmo did not answer', 'unavailable' => true], 502);
    json_out($res);
}

$res = cached("netatmo:$cell", NETATMO_TTL, function () use ($lat, $lon, $cell) {
    $token = netatmo_token();
    if ($token === null) return null;
    $out = null;
    foreach (NETATMO_RADII as $r) {
        $out = netatmo_fetch($lat, $lon, $r, $token);
        if ($out === null) return null;
        if ($out['temp'] && $out['temp']['n'] >= NETATMO_MIN_STATIONS) break;
    }
    if (!$out || !$out['temp'] || $out['temp']['n'] < NETATMO_MIN_STATIONS) return ['ok' => false, 'stations' => $out['stations'] ?? 0];
    $out['ok'] = true; $out['fetched'] = time();
    // Glett's own local observation series: one row per cell and hour (later usable for the reliability score)
    try {
        $hour = time() - time() % 3600;
        q('INSERT IGNORE INTO obs_local (cell, hour, n, temp, hum, pres, rain1h, wet_share, wind_kmh) VALUES (?,?,?,?,?,?,?,?,?)',
          [$cell, $hour, $out['temp']['n'], $out['temp']['v'], $out['hum']['v'] ?? null, $out['pres']['v'] ?? null, $out['rain']['mm_1h'] ?? null, $out['rain']['wet_share'] ?? null, $out['wind']['kmh'] ?? null]);
    } catch (PDOException $e) {
        db()->exec('CREATE TABLE IF NOT EXISTS obs_local (cell VARCHAR(16) NOT NULL, hour INT UNSIGNED NOT NULL, n SMALLINT UNSIGNED NOT NULL, temp DECIMAL(4,1) NULL, hum DECIMAL(4,1) NULL, pres DECIMAL(6,1) NULL, rain1h DECIMAL(5,1) NULL, wet_share DECIMAL(3,2) NULL, wind_kmh DECIMAL(5,1) NULL, PRIMARY KEY (cell, hour)) ENGINE=InnoDB');
        try { q('INSERT IGNORE INTO obs_local (cell, hour, n, temp, hum, pres, rain1h, wet_share, wind_kmh) VALUES (?,?,?,?,?,?,?,?,?)',
          [$cell, time() - time() % 3600, $out['temp']['n'], $out['temp']['v'], $out['hum']['v'] ?? null, $out['pres']['v'] ?? null, $out['rain']['mm_1h'] ?? null, $out['rain']['wet_share'] ?? null, $out['wind']['kmh'] ?? null]); } catch (PDOException $e2) { error_log('Glett obs_local: ' . $e2->getMessage()); }
    }
    return $out;
});
if ($res === null) json_out(['error' => 'Netatmo did not answer', 'unavailable' => true], 502);
json_out($res);
