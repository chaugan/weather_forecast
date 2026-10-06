<?php
// Wind map data: MET Nordic's 1 km forecast (MET Norway, CC BY 4.0) from thredds.met.no, for the animated wind map on Været.
// One OPeNDAP call fetches a whole forecast hour for the Nordic area (thredds pays per hour fetched, hardly per area), every
// 3rd point (3 km), turned into u/v and kept as a file per run and hour, shared by all visitors. A visitor gets the part of
// it on screen, resampled in here to a regular lat/lon grid, so the browser never sees MET's Lambert grid.
//   GET api/wind.php?meta=1                                    -> {run, ref, times[]}: the newest finished run and its hours
//   GET api/wind.php?run=&t=&s=&w=&n=&e=&nx=&ny=              -> {run, t, s, w, n, e, nx, ny, u[], v[]} in 0.1 m/s, null = no data
// u is towards the east, v towards the north (MET's wind_from_direction is relative to true north). Rows go south to north.
// When thredds fails, the hour is taken from the previous run if that one has it; the answer names the run it came from.
declare(strict_types=1);
require __DIR__ . '/db.php';

const WIND_BASE = 'https://thredds.met.no/thredds/';
const WIND_CATALOG = WIND_BASE . 'catalog/metpplatest/catalog.xml';
const WIND_FILE = 'metpplatest/met_forecast_1_0km_nordic_%s.nc';
// MET Nordic's grid: Lambert conformal, lat_0 = lat_1 = lat_2 = 63, lon_0 = 15, sphere R = 6371000, 1 km, 1796 x 2321
const WIND_NX = 1796, WIND_NY = 2321, WIND_X0 = -897442.2, WIND_Y0 = -1104322.0, WIND_DX = 1000.0;
const WIND_STRIDE = 3;                                   // every 3rd point: 3 km, 599 x 774, 1.85 MB a file
const WIND_SX = 599, WIND_SY = 774;                      // ceil(1796 / 3), ceil(2321 / 3)
const WIND_MISSING = -32768;
const WIND_SETTLE = 600;                                 // a run is used once its file has been still for 10 minutes
const WIND_UPSTREAM_PER_HOUR = 400;                      // site-wide budget of uncached thredds calls
const WIND_RATE_PER_MIN = 300;                           // per client: playing and scrubbing fetch an hour at a time
const WIND_MAX_PTS = 140;                                // per side of a slice
const WIND_DEADLINE = 18;                                // seconds: no new upstream call after this (the host stops a request at 30 s)
$GLOBALS['wind_t0'] = microtime(true);

rate_limit(WIND_RATE_PER_MIN, 'wind');
housekeeping();

function wind_dir(): string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/wind';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    if (!is_dir($d) || !is_writable($d)) throw new RuntimeException('wind cache not writable');
    return $d;
}
function wind_url(string $run): string { return WIND_BASE . 'dodsC/' . sprintf(WIND_FILE, $run); }
function wind_get(string $url, int $timeout): array
{
    $left = WIND_DEADLINE - (microtime(true) - $GLOBALS['wind_t0']);
    if ($left < 3) return [0, ''];   // too late in this request for another call
    $timeout = (int)min($timeout, $left);
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => $timeout, CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $body = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    return [$body === false ? 0 : $status, $body === false ? '' : (string)$body];
}
/* The site-wide budget for thredds calls, so a scraper cannot make Glett hammer MET */
function wind_budget(): bool
{
    $hour = time() - time() % 3600;
    q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + 1, 1), last_at = ?', ['wind:upstream', $hour, $hour, $hour]);
    return (int)(q('SELECT calls FROM throttle WHERE name = ?', ['wind:upstream'])->fetch()['calls'] ?? 0) <= WIND_UPSTREAM_PER_HOUR;
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

/* ---- the runs: the newest finished one from MET's catalog (asked every 5 minutes), its hours read once per run */
function wind_meta(): ?array
{
    $d = wind_dir(); $f = "$d/meta.json";
    $old = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null;
    if (is_array($old) && filemtime($f) > time() - 300) return $old;
    return wind_locked('meta', function () use ($f, $old) {
        if (is_file($f) && filemtime($f) > time() - 300) return json_decode((string)@file_get_contents($f), true);
        $runs = [];
        if (wind_budget()) {
            [$st, $xml] = wind_get(WIND_CATALOG, 8);
            if ($st === 200 && preg_match_all('~name="met_forecast_1_0km_nordic_(\d{8}T\d{2}Z)\.nc".*?<date type="modified">([^<]+)</date>~s', $xml, $m, PREG_SET_ORDER))
                foreach ($m as $x) if (strtotime($x[2]) < time() - WIND_SETTLE) $runs[] = $x[1];
        }
        sort($runs);
        $run = end($runs) ?: null;
        if ($run === null) { if (is_array($old)) @touch($f); return $old; }   // catalog not answering: the run we had, asked again in 5 minutes
        if (is_array($old) && $old['run'] === $run) { @touch($f); return $old; }
        // the grid is checked once per run, and the run is refused if MET has changed it
        [$st, $body] = wind_get(wind_url($run) . '.ascii?' . rawurlencode('time,x[0:1795:1795],y[0:2320:2320]'), 10);
        if ($st !== 200 || !preg_match('~time\[(\d+)\]\s*\n([^\n]+)~', $body, $tm) || !preg_match('~x\[2\]\s*\n\s*([-\d.E]+),\s*([-\d.E]+)~', $body, $xm) || !preg_match('~y\[2\]\s*\n\s*([-\d.E]+),\s*([-\d.E]+)~', $body, $ym)) { if (is_array($old)) @touch($f); return $old; }
        if (abs((float)$xm[1] - WIND_X0) > 1 || abs((float)$ym[1] - WIND_Y0) > 1 || abs((float)$xm[2] - (WIND_X0 + (WIND_NX - 1) * WIND_DX)) > 1 || abs((float)$ym[2] - (WIND_Y0 + (WIND_NY - 1) * WIND_DX)) > 1) {
            error_log('Glett wind: MET Nordic grid changed in ' . $run); if (is_array($old)) @touch($f); return $old;
        }
        $times = array_map(fn($v) => (int)round((float)$v), explode(',', $tm[2]));
        $meta = ['run' => $run, 'ref' => $times[0], 'times' => $times, 'prev' => is_array($old) ? $old['run'] : null];
        wind_write($f, json_encode($meta));
        // runs older than the previous one go
        foreach (glob(wind_dir() . '/2*', GLOB_ONLYDIR) ?: [] as $rd) { $r = basename($rd); if ($r !== $run && $r !== $meta['prev']) { array_map('unlink', glob("$rd/*") ?: []); @rmdir($rd); } }
        return $meta;
    }, $old);
}

/* ---- one hour of one run for the whole area, as u then v (int16, 0.1 m/s), fetched once */
function wind_hour(string $run, int $t, array $times): ?string
{
    $i = array_search($t, $times, true); if ($i === false) return null;
    $f = wind_dir() . "/$run/$t.bin";
    $size = 4 * WIND_SX * WIND_SY;
    if (is_file($f) && filesize($f) === $size) return (string)@file_get_contents($f);
    return wind_locked("$run:$t", function () use ($run, $t, $i, $f, $size) {
        if (is_file($f) && filesize($f) === $size) return (string)@file_get_contents($f);
        if (!wind_budget()) return null;
        $sl = sprintf('[%d][0:%d:%d][0:%d:%d]', $i, WIND_STRIDE, WIND_NY - 1, WIND_STRIDE, WIND_NX - 1);
        [$st, $body] = wind_get(wind_url($run) . '.dods?' . str_replace(['[', ']'], ['%5B', '%5D'], "wind_speed_10m.wind_speed_10m$sl,wind_direction_10m.wind_direction_10m$sl"), 12);
        $at = strpos($body, "\nData:\n");
        if ($st !== 200 || $at === false) { error_log("Glett wind: thredds HTTP $st for $run $t"); return null; }
        // the variables come in the order the header names them, each as XDR: its length twice, then big-endian floats
        preg_match_all('~Float32 (\w+)\[time = 1\]\[y = (\d+)\]\[x = (\d+)\]~', substr($body, 0, $at), $hm, PREG_SET_ORDER);
        $n = WIND_SX * WIND_SY; $off = $at + 7; $pos = [];
        foreach ($hm as $h) {
            if ((int)$h[2] !== WIND_SY || (int)$h[3] !== WIND_SX) { error_log('Glett wind: unexpected shape ' . $h[0]); return null; }
            if (unpack('N', substr($body, $off, 4))[1] !== $n) { error_log('Glett wind: unexpected length'); return null; }
            $pos[$h[1]] = $off + 8; $off += 8 + 4 * $n;
        }
        if (!isset($pos['wind_speed_10m'], $pos['wind_direction_10m']) || strlen($body) < $off) { error_log('Glett wind: short answer'); return null; }
        $u = ''; $v = ''; $rad = M_PI / 180; $chunk = 4096;
        for ($k = 0; $k < $n; $k += $chunk) {   // in chunks: 460 000 floats as one PHP array would not fit a shared host
            $c = min($chunk, $n - $k);
            $sp = array_values(unpack("G$c", substr($body, $pos['wind_speed_10m'] + 4 * $k, 4 * $c)));
            $dr = array_values(unpack("G$c", substr($body, $pos['wind_direction_10m'] + 4 * $k, 4 * $c)));
            $uu = []; $vv = [];
            for ($j = 0; $j < $c; $j++) {
                $s = $sp[$j]; $a = $dr[$j];
                if (is_nan($s) || is_nan($a) || $s < 0 || $s > 150) { $uu[] = WIND_MISSING; $vv[] = WIND_MISSING; continue; }
                $uu[] = (int)round(-$s * sin($a * $rad) * 10); $vv[] = (int)round(-$s * cos($a * $rad) * 10);   // "from" the direction, so the wind goes the other way
            }
            $u .= pack('s*', ...$uu); $v .= pack('s*', ...$vv);
        }
        $out = $u . $v;
        if (strlen($out) !== $size) return null;
        if (!is_dir(dirname($f))) @mkdir(dirname($f), 0700, true);
        wind_write($f, $out);
        return $out;
    });
}

function wind_out(array $data, int $maxAge): void   // json_out() says no-store; these answers may be kept
{
    header('Content-Type: application/json; charset=utf-8');
    header("Cache-Control: public, max-age=$maxAge");
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

/* ---- MET's Lambert grid: lat/lon to a (fractional) index in the 3 km file */
function wind_index(float $lat, float $lon): array
{
    static $c = null;
    if ($c === null) { $p1 = deg2rad(63.0); $n = sin($p1); $F = cos($p1) * tan(M_PI / 4 + $p1 / 2) ** $n / $n; $c = [$n, $F, 6371000.0 * $F / tan(M_PI / 4 + $p1 / 2) ** $n]; }
    [$n, $F, $rho0] = $c;
    $rho = 6371000.0 * $F / tan(M_PI / 4 + deg2rad($lat) / 2) ** $n; $th = $n * deg2rad($lon - 15.0);
    $x = $rho * sin($th); $y = $rho0 - $rho * cos($th);
    return [($x - WIND_X0) / (WIND_DX * WIND_STRIDE), ($y - WIND_Y0) / (WIND_DX * WIND_STRIDE)];
}

if (isset($_GET['meta'])) {
    $meta = wind_meta();
    if ($meta === null) json_out(['error' => 'MET Nordic is not answering', 'unavailable' => true], 503);
    wind_out(['run' => $meta['run'], 'ref' => $meta['ref'], 'times' => $meta['times']], 300);
}

$run = (string)($_GET['run'] ?? ''); $t = (int)($_GET['t'] ?? 0);
$s = (float)($_GET['s'] ?? 0); $w = (float)($_GET['w'] ?? 0); $nn = (float)($_GET['n'] ?? 0); $e = (float)($_GET['e'] ?? 0);
$nx = (int)($_GET['nx'] ?? 0); $ny = (int)($_GET['ny'] ?? 0);
if (!preg_match('~^\d{8}T\d{2}Z$~', $run) || $t <= 0 || !($s < $nn) || !($w < $e) || $s < 40 || $nn > 80 || $w < -30 || $e > 60 || $nx < 2 || $ny < 2 || $nx > WIND_MAX_PTS || $ny > WIND_MAX_PTS)
    json_out(['error' => 'Bad request'], 400);
$meta = wind_meta();
if ($meta === null) json_out(['error' => 'MET Nordic is not answering', 'unavailable' => true], 503);
// the run asked for if it is the current or the previous one (a page that has been open a while), else the current one
$tries = array_values(array_unique(array_filter([in_array($run, [$meta['run'], $meta['prev']], true) ? $run : $meta['run'], $meta['run'], $meta['prev']])));
$data = null; $used = null;
foreach ($tries as $r) {
    $times = $r === $meta['run'] ? $meta['times'] : null;
    if ($times === null) {   // the previous run: its hours are on disk if anyone fetched them
        $f = wind_dir() . "/$r/$t.bin"; if (!is_file($f)) continue; $times = [$t];
    }
    $data = wind_hour($r, $t, $times);
    if ($data !== null && strlen($data) === 4 * WIND_SX * WIND_SY) { $used = $r; break; }
    $data = null;
}
if ($data === null) json_out(['error' => 'No wind for that hour', 'unavailable' => true], 503);

/* the slice: a regular lat/lon grid over the asked box, bilinear in the 3 km grid; a corner without data gives null */
$plane = WIND_SX * WIND_SY * 2; $rows = [];
$row = function (int $k, int $j) use ($data, $plane, &$rows) {   // one row of u (k = 0) or v (k = 1), unpacked once
    $key = $k * 10000 + $j;
    if (!isset($rows[$key])) $rows[$key] = array_values(unpack('s' . WIND_SX, substr($data, $k * $plane + $j * WIND_SX * 2, WIND_SX * 2)));
    return $rows[$key];
};
$U = []; $V = [];
for ($b = 0; $b < $ny; $b++) {
    $lat = $s + ($nn - $s) * $b / ($ny - 1);
    for ($a = 0; $a < $nx; $a++) {
        $lon = $w + ($e - $w) * $a / ($nx - 1);
        [$fi, $fj] = wind_index($lat, $lon);
        if ($fi < 0 || $fj < 0 || $fi > WIND_SX - 1 || $fj > WIND_SY - 1) { $U[] = null; $V[] = null; continue; }
        $i0 = min((int)floor($fi), WIND_SX - 2); $j0 = min((int)floor($fj), WIND_SY - 2); $di = $fi - $i0; $dj = $fj - $j0;
        $res = [];
        foreach ([0, 1] as $k) {
            $r0 = $row($k, $j0); $r1 = $row($k, $j0 + 1);
            $q = [$r0[$i0], $r0[$i0 + 1], $r1[$i0], $r1[$i0 + 1]];
            if (in_array(WIND_MISSING, $q, true)) { $res = null; break; }
            $res[] = (int)round($q[0] * (1 - $di) * (1 - $dj) + $q[1] * $di * (1 - $dj) + $q[2] * (1 - $di) * $dj + $q[3] * $di * $dj);
        }
        $U[] = $res ? $res[0] : null; $V[] = $res ? $res[1] : null;
    }
}
wind_out(['run' => $used, 't' => $t, 's' => $s, 'w' => $w, 'n' => $nn, 'e' => $e, 'nx' => $nx, 'ny' => $ny, 'u' => $U, 'v' => $V], $used === $run ? 86400 : 600);   // an hour of a run never changes
