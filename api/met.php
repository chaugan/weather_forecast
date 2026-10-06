<?php
// Kjørevær's main forecast along a route: MET Norway's Locationforecast 2.0 (CC BY 4.0), fetched here and kept as a file per
// place, shared by all visitors, so a route no longer spends the visitor's own Open-Meteo minute (the model comparison still
// does, in the browser). A place is the browser's weather cell (js/kvcore.js cellKey): lat and lon to 2 decimals (~1 km) and
// the height in 100 m, asked at that height so MET corrects the temperature for it.
//   GET api/met.php?k=60.39,5.32,0;60.06,7.53,12;…   (at most MET_MAX_KEYS; a height of x = MET's own terrain)
//   -> {f: {key: {t[], h: {time[], temperature_2m[], dew_point_2m[], precipitation[], weather_code[], wind_gusts_10m[], is_day[]},
//           e, hr}}, pending: [keys not fetched yet: ask again], fail: [keys MET did not give: use Open-Meteo for them]}
// The series is shaped like Open-Meteo's hourly answer (unix seconds, WMO weather codes, an hour's precipitation and gusts
// written at the hour's end), so the browser treats both the same. MET is hourly for about 2½ days, then every 6 hours: those
// hours get the 6 hours' precipitation spread evenly, the period's symbol, temperatures in between drawn straight, and no gust
// (null: the other models' gusts decide out there). hr: the last hourly step.
// MET's terms (api.met.no/doc/TermsOfService): an identifying User-Agent, at most 4 decimals, no new request before the
// answer's Expires (If-Modified-Since after it), and under 20 requests a second for the whole site: MET_PER_SEC below.
// So one visitor cannot spend that pace (or fill the disk) for everyone: places only in the Nordic box Kjørevær drives in, a
// budget of new MET requests per visitor a minute and for the site a day; past either, the places are answered as `fail` and
// the browser asks Open-Meteo for them with its own quota.
declare(strict_types=1);
require __DIR__ . '/db.php';

const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const MET_MAX_KEYS = 40;      // places per call
const MET_PER_SEC = 15;       // upstream requests a second, site-wide
const MET_PARALLEL = 6;       // at once in one call
const MET_DEADLINE = 8.0;     // seconds: no new upstream request after this; the rest is answered as pending
const MET_STALE = 6 * 3600;   // a copy this old is still served when MET fails
const MET_HOURS = 126;        // hours kept from the first step: Kjørevær looks up to three days ahead plus the drive
const MET_RATE_PER_MIN = 90;  // calls per visitor a minute (a long route is about 15, plus repeats for pending places)
const MET_IP_PER_MIN = 600;   // MET requests asked per visitor a minute: Oslo–Alta's three routes are about 300 places (and repeats)
const MET_PER_DAY = 40000;    // new MET requests for the whole site a day (each kept file is ~6 KB, kept 12 hours)
const MET_BOX = [54.0, 3.0, 71.5, 32.0];   // s, w, n, e: Norway, Sweden and Finland, where MET Nordic is
$GLOBALS['met_t0'] = microtime(true);

rate_limit(MET_RATE_PER_MIN, 'met');
housekeeping();

$keys = []; $raw = (string)($_GET['k'] ?? '');
if (strlen($raw) > MET_MAX_KEYS * 20) json_out(['error' => 'Bad request'], 400);
foreach (explode(';', $raw) as $k) {
    if (!preg_match('~^(-?\d{1,2}\.\d{2}),(-?\d{1,3}\.\d{2}),(x|-?\d{1,2})$~', $k, $m)) continue;
    if ((float)$m[1] < MET_BOX[0] || (float)$m[1] > MET_BOX[2] || (float)$m[2] < MET_BOX[1] || (float)$m[2] > MET_BOX[3]) continue;
    $keys[$k] = ['lat' => $m[1], 'lon' => $m[2], 'alt' => $m[3] === 'x' ? null : 100 * (int)$m[3]];
}
if (count($keys) > MET_MAX_KEYS) json_out(['error' => 'Bad request'], 400);

function met_dir(): string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/met';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    if (!is_dir($d) || !is_writable($d)) throw new RuntimeException('met cache not writable');
    return $d;
}
function met_file(string $k): string { return met_dir() . '/' . strtr($k, ',', '_') . '.json'; }
function met_read(string $k): ?array { $f = met_file($k); $j = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null; return is_array($j) && isset($j['d']) ? $j : null; }
function met_write(string $k, array $c): void { $f = met_file($k); $tmp = $f . '.' . getmypid(); if (@file_put_contents($tmp, json_encode($c, JSON_UNESCAPED_SLASHES)) !== false) @rename($tmp, $f); }
function met_clean(): void   // now and then: files not refreshed for 12 hours go
{
    if (random_int(1, 300) !== 1) return;
    $old = time() - 12 * 3600;
    foreach (glob(met_dir() . '/*.json') ?: [] as $f) if (@filemtime($f) < $old) @unlink($f);
}

/* the site-wide pace: a slot in the current second, or false (wait for the next) */
function met_slot(): bool
{
    $sec = time();
    q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = LAST_INSERT_ID(IF(last_at = ?, calls + 1, 1)), last_at = ?', ['met:sec', $sec, $sec, $sec]);
    $n = (int)(q('SELECT LAST_INSERT_ID() n')->fetch()['n'] ?? 0);
    return $n === 0 || $n <= MET_PER_SEC;   // 0: the row was just made (the first call)
}
/* $n more new MET requests for this visitor this minute and for the site today: false when either budget is spent */
function met_budget(int $n): bool
{
    if (PHP_SAPI === 'cli') return true;
    $now = time(); $win = $now - $now % 60; $day = $now - $now % 86400;
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? ''); $bin = @inet_pton($ip);
    if ($bin !== false && strlen($bin) === 16) $ip = substr($bin, 0, 12) === str_repeat("\0", 10) . "\xff\xff"
        ? inet_ntop(substr($bin, 12))                  // IPv4 written as IPv6 (::ffff:a.b.c.d): its own address, not one shared /64
        : bin2hex(substr($bin, 0, 8)) . '::/64';       // IPv6: one visitor holds a whole /64, so the budget counts per /64
    $h = md5('glett|metup|' . $ip);
    q('INSERT INTO ratelimit (ip_hash, window_start, n) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE n = IF(window_start = ?, LEAST(n + ?, 65000), ?), window_start = ?', [$h, $win, $n, $win, $n, $n, $win]);
    if ((int)(q('SELECT n FROM ratelimit WHERE ip_hash = ?', [$h])->fetch()['n'] ?? 0) > MET_IP_PER_MIN) return false;
    q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + ?, ?), last_at = ?', ['met:day', $day, $n, $day, $n, $n, $day]);
    return (int)(q('SELECT calls FROM throttle WHERE name = ?', ['met:day'])->fetch()['calls'] ?? 0) <= MET_PER_DAY;
}
/* after a 429 or 5xx from MET: no new requests for a minute, site-wide */
function met_paused(): bool { return (float)(q('SELECT last_at FROM throttle WHERE name = ?', ['met:pause'])->fetch()['last_at'] ?? 0) > time(); }
function met_pause(): void { $u = time() + 60; q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_at = ?, calls = calls + 1', ['met:pause', $u, $u]); }

/* MET's symbol (without _day/_night) as a WMO weather code: what js/kvcore.js classify() reads. Sleet is 68/69, which
   Open-Meteo never sends, so classify can call it sleet by name. */
function met_code(string $sym): int
{
    $s = preg_replace('~_(day|night|polartwilight)$~', '', $sym);
    if (str_contains($s, 'thunder')) return 95;
    static $map = ['clearsky' => 0, 'fair' => 1, 'partlycloudy' => 2, 'cloudy' => 3, 'fog' => 45,
        'lightrain' => 61, 'rain' => 63, 'heavyrain' => 65, 'lightrainshowers' => 80, 'rainshowers' => 81, 'heavyrainshowers' => 82,
        'lightsleet' => 68, 'sleet' => 68, 'heavysleet' => 69, 'lightsleetshowers' => 68, 'sleetshowers' => 68, 'heavysleetshowers' => 69,
        'lightsnow' => 71, 'snow' => 73, 'heavysnow' => 75, 'lightsnowshowers' => 85, 'snowshowers' => 85, 'heavysnowshowers' => 86];
    return $map[$s] ?? 3;
}
/* the sun above the horizon (refraction included) at a place and time: NOAA's approximation, good to a fraction of a degree */
function met_day(float $lat, float $lon, int $ts): int
{
    $d = $ts / 86400 - 10957.5;   // days since J2000
    $g = deg2rad(fmod(357.529 + 0.98560028 * $d, 360)); $q = fmod(280.459 + 0.98564736 * $d, 360);
    $L = deg2rad($q + 1.915 * sin($g) + 0.020 * sin(2 * $g)); $e = deg2rad(23.439 - 0.00000036 * $d);
    $dec = asin(sin($e) * sin($L)); $ra = atan2(cos($e) * sin($L), cos($L));
    $gmst = fmod(18.697374558 + 24.06570982441908 * $d, 24) * 15;
    $ha = deg2rad($gmst + $lon) - $ra; $la = deg2rad($lat);
    $alt = rad2deg(asin(sin($la) * sin($dec) + cos($la) * cos($dec) * cos($ha)));
    return $alt > -0.833 ? 1 : 0;
}
/* MET's answer -> the hourly series */
function met_series(array $j, float $lat, float $lon): ?array
{
    $ts = $j['properties']['timeseries'] ?? null;
    if (!is_array($ts) || count($ts) < 2) return null;
    $T = array_map(fn($x) => strtotime((string)$x['time']), $ts);
    $t0 = $T[0]; $end = $t0;
    foreach ($T as $t) if ($t <= $t0 + MET_HOURS * 3600) $end = $t;   // the last step inside the hours kept: the series ends on a value
    $n = intdiv($end - $t0, 3600) + 1;
    $at = fn($t) => intdiv($t - $t0, 3600);
    $temp = array_fill(0, $n, null); $dew = $temp; $gust = $temp; $mm = array_fill(0, $n, 0.0); $code = array_fill(0, $n, null); $time = [];
    for ($i = 0; $i < $n; $i++) $time[] = $t0 + 3600 * $i;
    $hr = $t0;
    foreach ($ts as $i => $x) {
        $t = $T[$i]; if ($t > $end) break;
        $d = $x['data'] ?? []; $ins = $d['instant']['details'] ?? []; $k = $at($t);
        $temp[$k] = $ins['air_temperature'] ?? null; $dew[$k] = $ins['dew_point_temperature'] ?? null;
        $step = isset($T[$i + 1]) ? intdiv($T[$i + 1] - $t, 3600) : 6;
        if ($step === 1) { $hr = $t; if (isset($ins['wind_speed_of_gust'])) $gust[$k] = $ins['wind_speed_of_gust']; }
        // the period after this step: its precipitation per hour and symbol go to the hours that end inside it
        $p = $step === 1 && isset($d['next_1_hours']) ? [1, $d['next_1_hours']] : (isset($d['next_6_hours']) ? [6, $d['next_6_hours']] : (isset($d['next_12_hours']) ? [12, $d['next_12_hours']] : (isset($d['next_1_hours']) ? [1, $d['next_1_hours']] : null)));
        if (!$p) continue;
        [$len, $per] = $p; $amt = (float)($per['details']['precipitation_amount'] ?? 0); $c = met_code((string)($per['summary']['symbol_code'] ?? ''));
        for ($h = 1; $h <= min($len, $step); $h++) { $kk = $k + $h; if ($kk >= $n) break; $mm[$kk] = round($amt / $len, 2); $code[$kk] = $c; }
        if ($k === 0) { $mm[0] = round($amt / $len, 2); $code[0] = $c; }   // the first hour has no hour before it: its own period stands in
    }
    // temperatures between the 6-hour steps drawn straight
    foreach ([&$temp, &$dew] as &$s) {
        $last = null;
        for ($i = 0; $i < $n; $i++) {
            if ($s[$i] === null) continue;
            if ($last !== null && $i - $last > 1) for ($j = $last + 1; $j < $i; $j++) $s[$j] = round($s[$last] + ($s[$i] - $s[$last]) * ($j - $last) / ($i - $last), 1);
            $last = $i;
        }
    }
    unset($s);
    for ($i = 1; $i < $n; $i++) if ($code[$i] === null) $code[$i] = $code[$i - 1];
    $day = array_map(fn($t) => met_day($lat, $lon, $t), $time);
    $alt = $j['geometry']['coordinates'][2] ?? null;
    return ['t' => $time, 'h' => ['time' => $time, 'temperature_2m' => $temp, 'dew_point_2m' => $dew, 'precipitation' => $mm,
        'weather_code' => $code, 'wind_gusts_10m' => $gust, 'is_day' => $day], 'e' => is_numeric($alt) ? (float)$alt : null, 'hr' => $hr];
}
function met_expires(array $hdr, int $now): int
{
    $e = isset($hdr['expires']) ? strtotime($hdr['expires']) : false;
    return $e && $e > $now ? min($e, $now + 86400) : $now + 1800;   // MET's own Expires (a day at most, against a broken header)
}

$now = time();
$out = []; $pending = []; $fail = []; $todo = [];
foreach ($keys as $k => $p) {
    $c = met_read($k);
    if ($c && $c['exp'] > $now) $out[$k] = $c['d'];
    else $todo[$k] = ['p' => $p, 'c' => $c];
}
met_clean();

/* the places not in the store (or expired): fetched a few at a time, paced site-wide */
if ($todo) {
    $over = !met_budget(count($todo));   // the whole call's places at once: the budgets count requests asked for
    $paused = $over || met_paused();
    $mh = curl_multi_init(); $live = []; $queue = array_keys($todo);
    $start = function (string $k) use (&$live, $mh, $todo) {
        $p = $todo[$k]['p']; $c = $todo[$k]['c'];
        $url = MET_URL . '?lat=' . $p['lat'] . '&lon=' . $p['lon'] . ($p['alt'] !== null ? '&altitude=' . $p['alt'] : '');
        $hdr = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 4, CURLOPT_TIMEOUT => 8, CURLOPT_ENCODING => '',
            CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => array_merge(['Accept: application/json'], $c && !empty($c['lm']) ? ['If-Modified-Since: ' . $c['lm']] : []),
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$live, $k) { $i = strpos($line, ':'); if ($i) $live[$k]['hdr'][strtolower(trim(substr($line, 0, $i)))] = trim(substr($line, $i + 1)); return strlen($line); }]);
        $live[$k] = ['ch' => $ch, 'hdr' => $hdr];
        curl_multi_add_handle($mh, $ch);
    };
    $stop = false;
    while (($queue && !$stop) || $live) {
        while (!$stop && !$paused && $queue && count($live) < MET_PARALLEL && microtime(true) - $GLOBALS['met_t0'] < MET_DEADLINE) {
            if (!met_slot()) break;
            $start(array_shift($queue));
        }
        if ($paused || microtime(true) - $GLOBALS['met_t0'] >= MET_DEADLINE) $stop = true;
        if (!$live) { if ($queue && !$stop) usleep(150000); continue; }
        curl_multi_exec($mh, $running);
        curl_multi_select($mh, 0.1);
        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle']; $k = null;
            foreach ($live as $kk => $l) if ($l['ch'] === $ch) { $k = $kk; break; }
            if ($k === null) continue;
            $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); $body = (string)curl_multi_getcontent($ch); $hdr = $live[$k]['hdr'];
            curl_multi_remove_handle($mh, $ch); curl_close($ch); unset($live[$k]);
            $c = $todo[$k]['c']; $p = $todo[$k]['p']; $t = time();
            if ($code === 304 && $c) { $c['exp'] = met_expires($hdr, $t); $c['at'] = $t; met_write($k, $c); $out[$k] = $c['d']; continue; }
            $j = $code === 200 || $code === 203 ? json_decode($body, true) : null;   // 203: the product is deprecated, the data still good
            $d = is_array($j) ? met_series($j, (float)$p['lat'], (float)$p['lon']) : null;
            if ($d) { met_write($k, ['at' => $t, 'exp' => met_expires($hdr, $t), 'lm' => $hdr['last-modified'] ?? '', 'd' => $d]); $out[$k] = $d; continue; }
            if ($code === 429 || $code >= 500 || $code === 0) { if ($code) met_pause(); $paused = $paused || $code > 0; }
            if ($code !== 200 && $code !== 203) error_log("Glett met: HTTP $code for $k");
            if ($c && $c['at'] > $t - MET_STALE) $out[$k] = $c['d']; else $fail[] = $k;
        }
    }
    curl_multi_close($mh);
    foreach ($queue as $k) {   // not asked in this call: a copy that is not too old, else ask again (or Open-Meteo when MET is paused)
        $c = $todo[$k]['c'];
        if ($c && $c['at'] > $now - MET_STALE) $out[$k] = $c['d'];
        elseif ($paused || $over) $fail[] = $k; else $pending[] = $k;
    }
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (!ini_get('zlib.output_compression') && extension_loaded('zlib')) ob_start('ob_gzhandler');
echo json_encode(['f' => (object)$out, 'pending' => $pending, 'fail' => $fail, 'source' => 'MET Norway Locationforecast 2.0 (CC BY 4.0)'], JSON_UNESCAPED_SLASHES);
