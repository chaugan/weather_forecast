<?php
// Wind map data: MET Nordic's 1 km forecast (MET Norway, CC BY 4.0) from thredds.met.no, for the animated wind map on Været.
// One OPeNDAP call fetches a whole forecast hour for the Nordic area (thredds pays per hour fetched, hardly per area), every
// 3rd point (3 km), turned into u/v and kept as a file per run and hour, shared by all visitors. A visitor gets the part of
// it on screen, resampled in here to a regular lat/lon grid, so the browser never sees MET's Lambert grid.
//   GET api/wind.php?meta=1                                    -> {run, ref, times[]}: the newest finished run and its hours
//   GET api/wind.php?run=&t=&s=&w=&n=&e=&nx=&ny=[&r=1]       -> {run, t, km, s, w, n, e, nx, ny, u[], v[]} in 0.1 m/s, null = no data
// r=1 (zoomed in): from MET's 1 km grid, in 128 km tiles fetched as needed (at most 9, the current run only), else the 3 km field.
// u is towards the east, v towards the north (MET's wind_from_direction is relative to true north). Rows go south to north.
// When thredds fails, the hour is taken from the previous run if that one has it; the answer names the run it came from.
declare(strict_types=1);
require __DIR__ . '/db.php';
require __DIR__ . '/metnordic.php';   // the grid, thredds calls, budget, locks, the catalog (shared with api/rain.php)

const WIND_FILE = 'metpplatest/met_forecast_1_0km_nordic_%s.nc';
const WIND_MISSING = -32768;
const WIND_SETTLE = 600;                                 // a run is used once its file has been still for 10 minutes
const WIND_FINE_PER_HOUR = 900;                          // budget for 1 km tiles (zoomed in); past it, the 3 km field is served
const WIND_TILE = 128;                                   // 1 km tiles of 128 x 128 points (64 KB a file)
const WIND_MAX_TILES = 9;                                // a box needing more is served at 3 km
const WIND_RATE_PER_MIN = 300;                           // per client: playing and scrubbing fetch an hour at a time
const WIND_MAX_PTS = 140;                                // per side of a slice
$GLOBALS['wind_t0'] = microtime(true);

rate_limit(WIND_RATE_PER_MIN, 'wind');
housekeeping();

function wind_url(string $run): string { return WIND_BASE . 'dodsC/' . sprintf(WIND_FILE, $run); }

/* ---- the runs: the newest finished one from MET's catalog (asked every 5 minutes), its hours read once per run */
function wind_meta(): ?array
{
    $d = wind_dir(); $f = "$d/meta.json";
    $old = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null;
    if (is_array($old) && filemtime($f) > time() - 300) return $old;
    return wind_locked('meta', function () use ($f, $old) {
        if (is_file($f) && filemtime($f) > time() - 300) return json_decode((string)@file_get_contents($f), true);
        $runs = [];
        foreach (mn_catalog() ?? [] as $name => $mod) if (preg_match('~^met_forecast_1_0km_nordic_(\d{8}T\d{2}Z)\.nc$~', $name, $m) && $mod < time() - WIND_SETTLE) $runs[] = $m[1];
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

/* ---- a block of one hour of one run: rows j0..j1 and columns i0..i1 of MET's 1 km grid, every $st-th point, as u then v
   (int16, 0.1 m/s), fetched once and kept. The whole area at 3 km is one block; zoomed in, 128 km tiles at 1 km are others. */
function wind_block(string $run, int $t, array $times, string $name, int $j0, int $j1, int $i0, int $i1, int $st): ?string
{
    $i = array_search($t, $times, true); if ($i === false) return null;
    $nx = intdiv($i1 - $i0, $st) + 1; $ny = intdiv($j1 - $j0, $st) + 1; $n = $nx * $ny; $size = 4 * $n;
    $f = wind_dir() . "/$run/$t$name.bin";
    if (is_file($f) && filesize($f) === $size) return (string)@file_get_contents($f);
    return wind_locked("$run:$t$name", function () use ($run, $t, $i, $f, $size, $n, $nx, $ny, $j0, $j1, $i0, $i1, $st, $name) {
        if (is_file($f) && filesize($f) === $size) return (string)@file_get_contents($f);
        if (!wind_budget($name === '' ? 'wind:upstream' : 'wind:fine', $name === '' ? WIND_UPSTREAM_PER_HOUR : WIND_FINE_PER_HOUR)) return null;
        $sl = sprintf('[%d][%d:%d:%d][%d:%d:%d]', $i, $j0, $st, $j1, $i0, $st, $i1);
        [$code, $body] = wind_get(wind_url($run) . '.dods?' . str_replace(['[', ']'], ['%5B', '%5D'], "wind_speed_10m.wind_speed_10m$sl,wind_direction_10m.wind_direction_10m$sl"), 12);
        $at = strpos($body, "\nData:\n");
        if ($code !== 200 || $at === false) { error_log("Glett wind: thredds HTTP $code for $run $t$name"); return null; }
        // the variables come in the order the header names them, each as XDR: its length twice, then big-endian floats
        preg_match_all('~Float32 (\w+)\[time = 1\]\[y = (\d+)\]\[x = (\d+)\]~', substr($body, 0, $at), $hm, PREG_SET_ORDER);
        $off = $at + 7; $pos = [];
        foreach ($hm as $h) {
            if ((int)$h[2] !== $ny || (int)$h[3] !== $nx) { error_log('Glett wind: unexpected shape ' . $h[0]); return null; }
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
                $sv = $sp[$j]; $a = $dr[$j];
                if (is_nan($sv) || is_nan($a) || $sv < 0 || $sv > 150) { $uu[] = WIND_MISSING; $vv[] = WIND_MISSING; continue; }
                $uu[] = (int)round(-$sv * sin($a * $rad) * 10); $vv[] = (int)round(-$sv * cos($a * $rad) * 10);   // "from" the direction, so the wind goes the other way
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
function wind_hour(string $run, int $t, array $times): ?string   // the whole area at 3 km
{
    return wind_block($run, $t, $times, '', 0, WIND_NY - 1, 0, WIND_NX - 1, WIND_STRIDE);
}
function wind_tile(string $run, int $t, array $times, int $tx, int $ty): ?string   // a 128 km tile at 1 km
{
    $i0 = $tx * WIND_TILE; $j0 = $ty * WIND_TILE;
    return wind_block($run, $t, $times, "-f$tx-$ty", $j0, min($j0 + WIND_TILE - 1, WIND_NY - 1), $i0, min($i0 + WIND_TILE - 1, WIND_NX - 1), 1);
}

if (isset($_GET['meta'])) {
    $meta = wind_meta();
    if ($meta === null) json_out(['error' => 'MET Nordic is not answering', 'unavailable' => true], 503);
    wind_out(['run' => $meta['run'], 'ref' => $meta['ref'], 'times' => $meta['times']], 300);
}

$run = (string)($_GET['run'] ?? ''); $t = (int)($_GET['t'] ?? 0); $fine = ($_GET['r'] ?? '') === '1';
$s = (float)($_GET['s'] ?? 0); $w = (float)($_GET['w'] ?? 0); $nn = (float)($_GET['n'] ?? 0); $e = (float)($_GET['e'] ?? 0);
$nx = (int)($_GET['nx'] ?? 0); $ny = (int)($_GET['ny'] ?? 0);
if (!preg_match('~^\d{8}T\d{2}Z$~', $run) || $t <= 0 || !($s < $nn) || !($w < $e) || $s < 40 || $nn > 80 || $w < -30 || $e > 60 || $nx < 2 || $ny < 2 || $nx > WIND_MAX_PTS || $ny > WIND_MAX_PTS)
    json_out(['error' => 'Bad request'], 400);
$meta = wind_meta();
if ($meta === null) json_out(['error' => 'MET Nordic is not answering', 'unavailable' => true], 503);

/* A grid to sample: get(u or v, i, j) in its own index units, its size, and its spacing in 1 km cells */
$grid = null; $used = null;
if ($fine && $run === $meta['run']) {   // zoomed in: the 1 km tiles the box touches (its edge is curved in MET's grid, so the edge is walked)
    $mi = INF; $xi = -INF; $mj = INF; $xj = -INF;
    for ($k = 0; $k <= 8; $k++) foreach ([[$s + ($nn - $s) * $k / 8, $w], [$s + ($nn - $s) * $k / 8, $e], [$s, $w + ($e - $w) * $k / 8], [$nn, $w + ($e - $w) * $k / 8]] as [$la, $lo]) {
        [$fi, $fj] = wind_index($la, $lo); $mi = min($mi, $fi); $xi = max($xi, $fi); $mj = min($mj, $fj); $xj = max($xj, $fj);
    }
    $tx0 = max(0, intdiv((int)floor(max(0, $mi)), WIND_TILE)); $tx1 = intdiv((int)min(WIND_NX - 1, ceil($xi) + 1), WIND_TILE);
    $ty0 = max(0, intdiv((int)floor(max(0, $mj)), WIND_TILE)); $ty1 = intdiv((int)min(WIND_NY - 1, ceil($xj) + 1), WIND_TILE);
    if ($xi >= 0 && $xj >= 0 && $mi <= WIND_NX - 1 && $mj <= WIND_NY - 1 && ($tx1 - $tx0 + 1) * ($ty1 - $ty0 + 1) <= WIND_MAX_TILES) {
        $tiles = [];
        for ($ty = $ty0; $ty <= $ty1 && $tiles !== null; $ty++) for ($tx = $tx0; $tx <= $tx1; $tx++) {
            $d = wind_tile($run, $t, $meta['times'], $tx, $ty);
            if ($d === null) { $tiles = null; break; }
            $tiles["$tx:$ty"] = $d;
        }
        if ($tiles !== null) {
            $rows = [];
            $grid = ['nx' => WIND_NX, 'ny' => WIND_NY, 'st' => 1, 'get' => function (int $k, int $i, int $j) use ($tiles, &$rows) {
                $tx = intdiv($i, WIND_TILE); $ty = intdiv($j, WIND_TILE); $key = "$tx:$ty";
                if (!isset($tiles[$key])) return WIND_MISSING;
                $w = min(WIND_TILE, WIND_NX - $tx * WIND_TILE); $h = min(WIND_TILE, WIND_NY - $ty * WIND_TILE); $r = $j - $ty * WIND_TILE;
                $rk = "$key:$k:$r";
                if (!isset($rows[$rk])) $rows[$rk] = array_values(unpack("s$w", substr($tiles[$key], ($k * $w * $h + $r * $w) * 2, $w * 2)));
                return $rows[$rk][$i - $tx * WIND_TILE];
            }];
            $used = $run;
        }
    }
}
if ($grid === null) {   // the whole area at 3 km: the run asked for if it is the current or the previous one (a page open a while), else the current one
    $tries = array_values(array_unique(array_filter([in_array($run, [$meta['run'], $meta['prev']], true) ? $run : $meta['run'], $meta['run'], $meta['prev']])));
    $data = null;
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
    $plane = WIND_SX * WIND_SY * 2; $rows = [];
    $grid = ['nx' => WIND_SX, 'ny' => WIND_SY, 'st' => WIND_STRIDE, 'get' => function (int $k, int $i, int $j) use ($data, $plane, &$rows) {
        $key = $k * 10000 + $j;
        if (!isset($rows[$key])) $rows[$key] = array_values(unpack('s' . WIND_SX, substr($data, $k * $plane + $j * WIND_SX * 2, WIND_SX * 2)));
        return $rows[$key][$i];
    }];
}

/* the slice: a regular lat/lon grid over the asked box, bilinear in MET's grid; a corner without data gives null */
$get = $grid['get']; $gx = $grid['nx']; $gy = $grid['ny']; $gs = $grid['st'];
$U = []; $V = [];
for ($b = 0; $b < $ny; $b++) {
    $lat = $s + ($nn - $s) * $b / ($ny - 1);
    for ($a = 0; $a < $nx; $a++) {
        $lon = $w + ($e - $w) * $a / ($nx - 1);
        [$fi, $fj] = wind_index($lat, $lon); $fi /= $gs; $fj /= $gs;
        if ($fi < 0 || $fj < 0 || $fi > $gx - 1 || $fj > $gy - 1) { $U[] = null; $V[] = null; continue; }
        $i0 = min((int)floor($fi), $gx - 2); $j0 = min((int)floor($fj), $gy - 2); $di = $fi - $i0; $dj = $fj - $j0;
        $res = [];
        foreach ([0, 1] as $k) {
            $q = [$get($k, $i0, $j0), $get($k, $i0 + 1, $j0), $get($k, $i0, $j0 + 1), $get($k, $i0 + 1, $j0 + 1)];
            if (in_array(WIND_MISSING, $q, true)) { $res = null; break; }
            $res[] = (int)round($q[0] * (1 - $di) * (1 - $dj) + $q[1] * $di * (1 - $dj) + $q[2] * (1 - $di) * $dj + $q[3] * $di * $dj);
        }
        $U[] = $res ? $res[0] : null; $V[] = $res ? $res[1] : null;
    }
}
wind_out(['run' => $used, 't' => $t, 'km' => $gs, 's' => $s, 'w' => $w, 'n' => $nn, 'e' => $e, 'nx' => $nx, 'ny' => $ny, 'u' => $U, 'v' => $V], $used === $run ? 86400 : 600);   // an hour of a run never changes
