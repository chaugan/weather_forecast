<?php
// MET Nordic (MET Norway, CC BY 4.0) on thredds.met.no: what the wind map (api/wind.php) and the recent rain along a route
// (api/rain.php) share. Functions and constants only: the including script sets $GLOBALS['wind_t0'] (its start, for the
// deadline) and does its own rate limit. Never served on its own (.htaccess).
declare(strict_types=1);

const WIND_BASE = 'https://thredds.met.no/thredds/';
const WIND_CATALOG = WIND_BASE . 'catalog/metpplatest/catalog.xml';
// MET Nordic's grid: Lambert conformal, lat_0 = lat_1 = lat_2 = 63, lon_0 = 15, sphere R = 6371000, 1 km, 1796 x 2321
// (the forecast and the analysis files have the same grid)
const WIND_NX = 1796, WIND_NY = 2321, WIND_X0 = -897442.2, WIND_Y0 = -1104322.0, WIND_DX = 1000.0;
const WIND_STRIDE = 3;                                   // every 3rd point: 3 km, 599 x 774, 1.85 MB a field
const WIND_SX = 599, WIND_SY = 774;                      // ceil(1796 / 3), ceil(2321 / 3)
const WIND_UPSTREAM_PER_HOUR = 300;                      // site-wide budget of uncached thredds calls for whole wind hours (3 km), and the catalog
const WIND_DEADLINE = 18;                                // seconds: no new upstream call after this (the host stops a request at 30 s)
const MN_CATALOG_TTL = 300;                              // MET's catalog is asked at most every 5 minutes, for wind and rain together

function wind_dir(): string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/wind';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    if (!is_dir($d) || !is_writable($d)) throw new RuntimeException('wind cache not writable');
    return $d;
}
function wind_left(): float { return WIND_DEADLINE - (microtime(true) - ($GLOBALS['wind_t0'] ?? microtime(true))); }   // seconds left for upstream calls
function wind_get(string $url, int $timeout): array
{
    $left = wind_left();
    if ($left < 3) return [0, ''];   // too late in this request for another call
    $timeout = (int)min($timeout, $left);
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => $timeout, CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $body = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    return [$body === false ? 0 : $status, $body === false ? '' : (string)$body];
}
/* The site-wide budget for thredds calls, so a scraper cannot make Glett hammer MET */
function wind_budget(string $name = 'wind:upstream', int $limit = WIND_UPSTREAM_PER_HOUR): bool
{
    $hour = time() - time() % 3600;
    q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + 1, 1), last_at = ?', [$name, $hour, $hour, $hour]);
    return (int)(q('SELECT calls FROM throttle WHERE name = ?', [$name])->fetch()['calls'] ?? 0) <= $limit;
}
/* One fetch per key at a time; a request that does not get the lock within 8 s gets $busy (it never fetches alongside) */
function wind_locked(string $key, callable $fn, $busy = null)
{
    $lock = 'glett:wind:' . md5($key);
    $got = (int)(q('SELECT GET_LOCK(?, 8) l', [$lock])->fetch()['l'] ?? 0);
    if ($got !== 1) return $busy;
    try { return $fn(); } finally { q('SELECT RELEASE_LOCK(?)', [$lock]); }
}
function wind_write(string $f, string $body): void   // a file of its own first, then renamed: readers never see half a file
{
    $tmp = $f . '.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $body) === strlen($body)) @rename($tmp, $f); else @unlink($tmp);
}
function wind_out(array $data, int $maxAge): void   // json_out() says no-store; these answers may be kept
{
    header('Content-Type: application/json; charset=utf-8');
    header("Cache-Control: public, max-age=$maxAge");
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

/* MET's catalog of the newest files (metpplatest: about 2½ days of hourly forecast runs and analyses) as
   [file name => modified (unix s)], kept as a file and asked again after MN_CATALOG_TTL. When MET does not answer, the
   list we had (asked again in 5 minutes); null when there never was one. */
function mn_catalog(): ?array
{
    $f = wind_dir() . '/catalog.json';
    $old = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null;
    if (is_array($old) && filemtime($f) > time() - MN_CATALOG_TTL) return $old;
    if (!is_array($old) && is_file("$f.fail") && filemtime("$f.fail") > time() - 60) return null;   // none to be had a moment ago: a minute's rest
    return wind_locked('catalog', function () use ($f, $old) {
        clearstatcache(true, $f);
        if (is_file($f) && filemtime($f) > time() - MN_CATALOG_TTL) return json_decode((string)@file_get_contents($f), true);
        $list = [];
        if (wind_budget()) {
            [$st, $xml] = wind_get(WIND_CATALOG, 8);
            if ($st === 200 && preg_match_all('~name="(met_(?:forecast|analysis)_1_0km_nordic_\d{8}T\d{2}Z\.nc)".*?<date type="modified">([^<]+)</date>~s', $xml, $m, PREG_SET_ORDER))
                foreach ($m as $x) { $t = strtotime($x[2]); if ($t) $list[$x[1]] = $t; }
        }
        if (!$list) { if (is_array($old)) @touch($f); else @touch("$f.fail"); return $old; }
        wind_write($f, json_encode($list));
        return $list;
    }, $old);
}

/* ---- MET's Lambert grid: lat/lon to a (fractional) index in the 1 km grid */
function wind_index(float $lat, float $lon): array
{
    static $c = null;
    if ($c === null) { $p1 = deg2rad(63.0); $n = sin($p1); $F = cos($p1) * tan(M_PI / 4 + $p1 / 2) ** $n / $n; $c = [$n, $F, 6371000.0 * $F / tan(M_PI / 4 + $p1 / 2) ** $n]; }
    [$n, $F, $rho0] = $c;
    $rho = 6371000.0 * $F / tan(M_PI / 4 + deg2rad($lat) / 2) ** $n; $th = $n * deg2rad($lon - 15.0);
    $x = $rho * sin($th); $y = $rho0 - $rho * cos($th);
    return [($x - WIND_X0) / WIND_DX, ($y - WIND_Y0) / WIND_DX];
}
