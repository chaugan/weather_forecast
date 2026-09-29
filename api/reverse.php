<?php
// Place name for a map click (reverse geocoding) through Nominatim, which does not allow browser requests and
// allows at most one request per second for the whole site. Results are cached permanently per 0.001° and a
// site-wide gate (MySQL lock + timestamp) guarantees >= 1.1 s between upstream calls. If the gate is busy for
// more than 3 s the answer is {name:null} and the visitor simply types a name.
declare(strict_types=1);
require __DIR__ . '/db.php';

const NOMINATIM_MIN_INTERVAL = 1.1;   // seconds between upstream calls
const NOMINATIM_LOCK_WAIT = 3;        // seconds a request waits for its turn before giving up

rate_limit();
housekeeping();
[$lat, $lon] = coords();
$lang = (($_GET['lang'] ?? 'nb') === 'en') ? 'en' : 'nb';
$zoom = (int)($_GET['z'] ?? 12) === 14 ? 14 : 12;   // 12 = town/city, 14 = nearest locality (suburb, village, district) + municipality
$latR = number_format(round($lat, 3), 3, '.', '');
$lonR = number_format(round($lon, 3), 3, '.', '');
$ckey = "rev$zoom:$latR:$lonR:$lang";

/* Place name from a Nominatim address block */
function place_name(array $a, int $zoom): ?string
{
    $city = $a['city'] ?? $a['town'] ?? $a['municipality'] ?? $a['county'] ?? null;
    if ($zoom === 14) {
        $local = $a['suburb'] ?? $a['neighbourhood'] ?? $a['quarter'] ?? $a['village'] ?? $a['hamlet'] ?? $a['city_district'] ?? $a['borough'] ?? $a['town'] ?? null;
        if ($local && $local !== $city) return $local . ($city ? ', ' . $city : '');
    }
    $place = $a['city'] ?? $a['town'] ?? $a['village'] ?? $a['municipality'] ?? $a['county'] ?? null;
    return $place ? $place . (isset($a['country']) && $zoom === 12 ? ', ' . $a['country'] : '') : null;
}

$hit = $zoom === 12 ? q('SELECT name FROM geocode_rev WHERE lat_r = ? AND lon_r = ? AND lang = ?', [$latR, $lonR, $lang])->fetch() : null;
if ($hit) json_out(['name' => $hit['name']]);
if ($zoom === 14) { $c = cache_get($ckey); if ($c !== null) json_out(json_decode($c, true)); }

$got = (int)(q('SELECT GET_LOCK(?, ?) l', ['glett:nominatim', NOMINATIM_LOCK_WAIT])->fetch()['l'] ?? 0);
if ($got !== 1) json_out(['name' => null, 'busy' => true]);

$name = null;
$ok = false;
try {
    $hit = $zoom === 12 ? q('SELECT name FROM geocode_rev WHERE lat_r = ? AND lon_r = ? AND lang = ?', [$latR, $lonR, $lang])->fetch() : null;
    $c14 = $zoom === 14 ? cache_get($ckey) : null;
    if ($hit) { $name = $hit['name']; $ok = true; }
    elseif ($c14 !== null) { $name = json_decode($c14, true)['name'] ?? null; $ok = true; }
    else {
        $last = q('SELECT last_at FROM throttle WHERE name = ?', ['nominatim'])->fetch();
        $wait = $last ? NOMINATIM_MIN_INTERVAL - (microtime(true) - (float)$last['last_at']) : 0;
        if ($wait > 0) usleep((int)ceil($wait * 1e6));
        $now = microtime(true);
        q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_at = ?, calls = calls + 1', ['nominatim', $now, $now]);
        $body = http_get("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=$zoom&accept-language=$lang&lat=$latR&lon=$lonR", 6, ['Accept-Language: ' . $lang]);
        $j = $body ? json_decode($body, true) : null;
        if (is_array($j)) {
            $ok = true;
            $name = place_name($j['address'] ?? [], $zoom);
            if ($name !== null) $name = mb_substr($name, 0, 200);
            if ($zoom === 12) q('INSERT IGNORE INTO geocode_rev (lat_r, lon_r, lang, name, fetched_at) VALUES (?, ?, ?, ?, ?)', [$latR, $lonR, $lang, $name, time()]);
            else cache_put($ckey, json_encode(['name' => $name], JSON_UNESCAPED_UNICODE), 365 * 86400);
        }
    }
} finally {
    q('SELECT RELEASE_LOCK(?)', ['glett:nominatim']);
}
json_out($ok ? ['name' => $name] : ['name' => null, 'error' => 'Reverse geocoding unavailable']);
