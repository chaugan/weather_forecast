<?php
// Rain in the last hours along a route, for Kjørevær's wet-road estimate (motorcycle): the forecast starts at the current
// hour, so rain that has just fallen is not in it. MET Nordic's analysis (MET Norway, CC BY 4.0; radar and gauges merged on
// MET Nordic's 1 km grid, hourly, ready about 15 minutes after the hour) from thredds.met.no, one OPeNDAP call a whole hour
// for the Nordic area at every 3rd point (3 km), kept as a file per hour (0.1 mm a byte) and shared by all visitors.
//   GET api/rain.php?k=60.39,5.32,0;60.06,7.53,12;…   (the places as api/met.php takes them, at most RAIN_MAX_KEYS; the height is ignored)
//   -> {t, h: [hour ends t-5h..t, unix s], r: {key: [6 values, 0.1 mm in the hour ending at h[i], null = not known] | null (outside
//       the area)}, fc: [hour ends taken from MET Nordic's forecast], source}
// t is the last whole hour. Before its analysis is out (HH:00-HH:15) that hour is the previous forecast run's first hour,
// listed in fc. An hour not in metpplatest any more is read from metpparchive. Never Open-Meteo.
declare(strict_types=1);
require __DIR__ . '/db.php';
require __DIR__ . '/metnordic.php';

const RAIN_HOURS = 6;              // the last 6 hours: Kjørevær's longest fitted drying time is 6 hours (tools/wetroad/params.json)
const RAIN_MAX_KEYS = 150;
const RAIN_BOX = [54.0, 3.0, 71.5, 32.0];   // s, w, n, e: as api/met.php
const RAIN_RATE_PER_MIN = 60;      // calls per visitor a minute (a long route with three alternatives is 4-6 calls)
const RAIN_UPSTREAM_PER_HOUR = 30; // site-wide thredds calls for rain hours (steady state 1-2 an hour)
const RAIN_SETTLE = 60;            // a file is used once it has been in the catalog for a minute
const RAIN_KEEP = 9 * 3600;        // hour files older than this go
const RAIN_MISSING = 255, RAIN_CAP = 250;
const RAIN_VAR = 'precipitation_amount.precipitation_amount[%d][0:3:2320][0:3:1795]';
$GLOBALS['wind_t0'] = microtime(true);

rate_limit(RAIN_RATE_PER_MIN, 'rain');
housekeeping();

$keys = []; $raw = (string)($_GET['k'] ?? '');
if (strlen($raw) > RAIN_MAX_KEYS * 20) json_out(['error' => 'Bad request'], 400);
foreach ($raw === '' ? [] : explode(';', $raw) as $k) {
    if (!preg_match('~^(-?\d{1,2}\.\d{2}),(-?\d{1,3}\.\d{2}),(x|-?\d{1,2})$~', $k, $m)) continue;
    $in = (float)$m[1] >= RAIN_BOX[0] && (float)$m[1] <= RAIN_BOX[2] && (float)$m[2] >= RAIN_BOX[1] && (float)$m[2] <= RAIN_BOX[3];
    $keys[$k] = $in ? [(float)$m[1], (float)$m[2]] : null;
}
if (!$keys || count($keys) > RAIN_MAX_KEYS) json_out(['error' => 'Bad request'], 400);

function rain_dir(): string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/rain';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    if (!is_dir($d) || !is_writable($d)) throw new RuntimeException('rain cache not writable');
    return $d;
}
/* One hour's field from thredds as bytes (0.1 mm, capped, RAIN_MISSING where MET has none), rows south to north */
function rain_fetch(string $path, int $ti): ?string
{
    [$code, $body] = wind_get(WIND_BASE . 'dodsC/' . $path . '.dods?' . str_replace(['[', ']'], ['%5B', '%5D'], sprintf(RAIN_VAR, $ti)), 12);
    $GLOBALS['rain_code'] = $code; $at = strpos($body, "\nData:\n"); $n = WIND_SX * WIND_SY;
    if ($code !== 200 || $at === false) { if ($code !== 404) error_log("Glett rain: thredds HTTP $code for $path"); return null; }
    if (!preg_match('~Float32 precipitation_amount\[time = 1\]\[y = ' . WIND_SY . '\]\[x = ' . WIND_SX . '\]~', substr($body, 0, $at))
        || strlen($body) < $at + 15 + 4 * $n || unpack('N', substr($body, $at + 7, 4))[1] !== $n) { error_log("Glett rain: unexpected answer for $path"); return null; }
    $out = ''; $off = $at + 15; $chunk = 4096;
    for ($k = 0; $k < $n; $k += $chunk) {   // in chunks: 460 000 floats as one PHP array would not fit a shared host
        $c = min($chunk, $n - $k); $b = [];
        foreach (unpack("G$c", substr($body, $off + 4 * $k, 4 * $c)) as $v) $b[] = is_nan($v) || $v < 0 || $v > 1000 ? RAIN_MISSING : min(RAIN_CAP, (int)round($v * 10));   // fill value 9.97e36
        $out .= pack('C*', ...$b);
    }
    return $out;
}
/* The file for the hour ending at $t: the analysis when MET has it, else (the last hour, before its analysis is out) the
   forecast run an hour or two before it. A file is taken once it has been in the catalog for a minute; one the catalog does
   not list (it is down, or a few minutes old) is asked for directly once it should be out (an analysis about 15 minutes
   after its hour, a forecast run about 27 minutes after its start), and a miss is not asked again for 10 minutes (a miss
   is kept per upstream file, so run t-1h missing does not stop run t-2h being tried for the same hour).
   -> [cached file, from the forecast] or null (not to be had now) */
function rain_hour(int $t, int $now, ?array $cat): ?array
{
    $d = rain_dir(); $id = gmdate('Ymd\TH', $t);
    if (is_file("$d/$id.bin")) return ["$d/$id.bin", false];
    $ok = fn(string $name, int $due) => $cat !== null && isset($cat[$name]) ? $cat[$name] <= $now - RAIN_SETTLE : $now >= $due;
    $name = 'met_analysis_1_0km_nordic_' . $id . 'Z.nc'; $tries = [];
    if ($t < $now - 3 * 3600 && !isset($cat[$name])) $tries[] = ['metpparchive/' . gmdate('Y/m/d/', $t) . $name, 0, "$d/$id.bin", false];   // gone from latest
    elseif ($ok($name, $t + 20 * 60)) $tries[] = ['metpplatest/' . $name, 0, "$d/$id.bin", false];
    if (is_file("$d/{$id}f.bin")) $tries[] = ["$d/{$id}f.bin", -1, "$d/{$id}f.bin", true];
    foreach ([1, 2] as $ti) {   // the forecast's first hour (run t-1h, index 1) or its second (run t-2h, index 2)
        $fn = 'met_forecast_1_0km_nordic_' . gmdate('Ymd\TH', $t - 3600 * $ti) . 'Z.nc';
        if ($ok($fn, $t - 3600 * $ti + 40 * 60)) $tries[] = ['metpplatest/' . $fn, $ti, "$d/{$id}f.bin", true];
    }
    foreach ($tries as [$path, $ti, $f, $fc]) {
        if ($ti < 0) return [$f, $fc];   // the forecast's hour, fetched before
        $got = wind_locked("rain:$path", function () use ($path, $ti, $f, $fc, $d) {
            clearstatcache(true, $f);
            if (is_file($f)) return [$f, $fc];
            $miss = "$d/" . md5($path) . '.miss';
            if (is_file($miss) && filemtime($miss) > time() - 600) return null;   // failed lately: asked again after 10 minutes
            if (is_file("$d/down") && filemtime("$d/down") > time() - 120) return null;   // thredds did not answer a moment ago: what is kept, for 2 minutes
            if (!wind_budget('rain:upstream', RAIN_UPSTREAM_PER_HOUR)) return null;
            $b = rain_fetch($path, $ti); if ($b === null || strlen($b) !== WIND_SX * WIND_SY) { $c = $GLOBALS['rain_code'] ?? 0; if ($c === 200 || $c === 404) @touch($miss); elseif ($c === 0 && wind_left() >= 3) @touch("$d/down"); return null; }   // not there or not what we expect; or no answer in time
            wind_write($f, $b); @unlink($miss);
            foreach (glob("$d/*") ?: [] as $o) if (@filemtime($o) < time() - RAIN_KEEP) @unlink($o);   // at most ~9 hours kept (~4 MB)
            return [$f, $fc];
        }, null) ?? (is_file($f) ? [$f, $fc] : null);   // another request held the lock past 8 s: its file if it finished
        if ($got) return $got;
    }
    return null;
}
/* The value at a place: bilinear between the four 3 km points around it, over those that have data */
function rain_at($fh, float $lat, float $lon): ?int
{
    [$fi, $fj] = wind_index($lat, $lon); $fi /= WIND_STRIDE; $fj /= WIND_STRIDE;
    if ($fi < 0 || $fj < 0 || $fi > WIND_SX - 1 || $fj > WIND_SY - 1) return null;
    $i0 = min((int)floor($fi), WIND_SX - 2); $j0 = min((int)floor($fj), WIND_SY - 2); $di = $fi - $i0; $dj = $fj - $j0;
    $s = 0.0; $w = 0.0;
    foreach ([0, 1] as $b) {
        fseek($fh, ($j0 + $b) * WIND_SX + $i0); $two = fread($fh, 2); if (strlen($two) !== 2) continue;
        foreach ([0, 1] as $a) { $v = ord($two[$a]); $ww = ($a ? $di : 1 - $di) * ($b ? $dj : 1 - $dj); if ($v !== RAIN_MISSING && $ww > 0) { $s += $v * $ww; $w += $ww; } }
    }
    return $w > 0.25 ? (int)round($s / $w) : null;   // most of the weight on missing points: not known
}

$now = time(); $t = $now - $now % 3600;
$cat = mn_catalog();
$hours = []; for ($i = RAIN_HOURS - 1; $i >= 0; $i--) $hours[] = $t - 3600 * $i;
$files = []; $fc = [];
foreach ($hours as $h) { $x = rain_hour($h, $now, $cat); $files[] = $x ? $x[0] : null; if ($x && $x[1]) $fc[] = $h; }
if (!array_filter($files)) json_out(['error' => 'MET Nordic is not answering', 'unavailable' => true], 503);

$fhs = array_map(fn($f) => $f ? @fopen($f, 'rb') : null, $files);
$r = [];
foreach ($keys as $k => $p) {
    if ($p === null) { $r[$k] = null; continue; }
    $r[$k] = array_map(fn($fh) => $fh ? rain_at($fh, $p[0], $p[1]) : null, $fhs);
}
foreach ($fhs as $fh) if ($fh) fclose($fh);

// kept until just after the next full hour: from HH:00 the hour just ended is to be had (run t-1h's first hour, out since
// about HH-1:27), and the page's MET forecast then starts at HH:00, so an answer that stops an hour earlier leaves the hour
// between them not known. While the last hour is the forecast's or an hour is missing, until HH:16 (its analysis) and then
// 5 minutes at a time, never past the next hour.
$hour = $t + 3600 + 30;
$next = !$fc && !in_array(null, $files, true) ? $hour : min($hour, $now < $t + 16 * 60 ? $t + 16 * 60 : $now + 300);
wind_out(['t' => $t, 'h' => $hours, 'r' => (object)$r, 'fc' => $fc, 'source' => 'MET Nordic analysis (MET Norway, CC BY 4.0)'], max(60, $next - $now));
