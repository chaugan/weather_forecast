<?php
// Snow depth along a ski route for Turvær in winter: NVE's seNorge snow model (NVE, NLOD) from the GridTimeSeries API
// (gts.nve.no, no key, no CORS, hence this proxy). The model has 1 x 1 km cells on UTM 33 and a daily value valid at 07
// Norwegian time, from today through today+9 (the later days are NVE's forecast; the API does not mark them, so the split
// is on the Europe/Oslo date). Three themes, one POST each: sd (snow depth, cm), ski (NVE's ski class: 0 bare, 1 little snow,
// 2 moist, 3 dry) and sdfsw (new snow in the 24 hours to 07, cm).
//   GET api/snow.php?c=<cell>,<cell>,…   (cell = row * 1195 + col of NVE's grid, js/kvcore.js snowCell; at most SNOW_MAX_CELLS)
//   -> {d0, n, days[n], tiles[n] (the ImageServer raster names of the same days), sim, stale, at (unix s of NVE's answer),
//       cells: {cell: {a: the cell's height, sd[n], ski[n], nf[n]} | null (no cell there: sea, fjord, outer islands)}}
//   &w=1 (Turvær's smøretips is on): each cell also carries hs[7] and hn[7], NVE's ski class and new snow on the seven days
//       before today (the thaw and snowfall history), and the answer wx: true; without w=1 the answer has no new fields. In a
//       replay (sim, below) also t1[121] per cell, NVE's hourly air temperature (tm1h, °C at the cell's height) from the sim date
//       00 UTC on, hour by hour, and t1from (unix s of t1[0]); the forecast belongs to today, not to the replayed winter.
// NoData is null, never 0. All requested cells are fetched together, so one answer never mixes two of NVE's model runs; when
// NVE fails, the same date's last answer is served with stale: true, never another date's.
// ?sim=YYYY-MM-DD replays that date and the 9 after it as today..today+9 (history, so the feature can be built in summer):
// honoured only on a local test copy (WEFO_SNOW_SIM=1 and site_url on 127.0.0.1 or localhost), ignored silently elsewhere.
declare(strict_types=1);
require __DIR__ . '/db.php';

const SNOW_URL = 'https://gts.nve.no/api/MultiPointTimeSeries/ByMapCoordinateCsv';
const SNOW_MAX_CELLS = 400;            // cells per call (Finse–Krækkja's three routes are 122)
const SNOW_DAYS = 10;                  // today and NVE's nine forecast days
const SNOW_TTL = 3 * 3600;             // NVE's publishing time is not known: asked again after three hours
const SNOW_THEMES = ['sd', 'ski', 'sdfsw'];
const SNOW_HIST = 7;                   // days before today in the ski and sdfsw POSTs (the same POSTs, started earlier): hs/hn for the wax tips
const SNOW_T1_DAYS = 5;                // sim only: tm1h from the sim date 00 to 00 five days on (121 hours; the trip is within 72 h of "today")
const SNOW_UPSTREAM_PER_HOUR = 200;    // site-wide POSTs to NVE an hour (a fresh route is 3, plus halvings around a no-cell point)
const SNOW_VISITOR_PER_HOUR = 60;      // POSTs to NVE an hour for one visitor (address hash): one visitor cannot spend the site's hour
const SNOW_SPLIT_MAX = 12;             // halving POSTs per request; the no-cell points not found by then are null in this answer only
const SNOW_DISK_MAX = 50 * 1024 * 1024;
const SNOW_FILE_CELLS = 20000;         // cells kept in one day's file; the oldest go first
const SNOW_NOCELL_TTL = 30 * 86400;
const SNOW_DEADLINE = 12.0;            // seconds from the start, lock wait included: every POST ends by then (the page gives up at 20 s)
const SNOW_COLS = 1195, SNOW_ROWS = 1550;   // NVE's grid: x -75000..1120000, y 6450000..8000000 (UTM 33), 1 km
$GLOBALS['snow_t0'] = microtime(true);
$GLOBALS['snow_splits'] = 0; $GLOBALS['snow_partial'] = false;   // partial: some cells left unresolved, so the answer is not kept

rate_limit(30, 'snow');
housekeeping();

$raw = (string)($_GET['c'] ?? '');
if ($raw === '' || strlen($raw) > SNOW_MAX_CELLS * 8 || !preg_match('~^\d{1,7}(,\d{1,7})*$~D', $raw)) json_out(['error' => 'Bad request'], 400);
$cells = array_values(array_unique(array_map('intval', explode(',', $raw))));
if (count($cells) < 1 || count($cells) > SNOW_MAX_CELLS) json_out(['error' => 'Bad request'], 400);
foreach ($cells as $i) if ($i % SNOW_COLS >= SNOW_COLS || intdiv($i, SNOW_COLS) >= SNOW_ROWS) json_out(['error' => 'Bad request'], 400);

function snow_dir(string $sub = ''): string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/snow' . ($sub !== '' ? '/' . $sub : '');
    if (!is_dir($d)) @mkdir($d, 0700, true);
    if (!is_dir($d) || !is_writable($d)) throw new RuntimeException('snow cache not writable');
    return $d;
}
function snow_read(string $f): array { $j = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null; return is_array($j) ? $j : []; }
function snow_write(string $f, array $data): void   // a file of its own first, then renamed: readers never see half a file
{
    $body = json_encode($data, JSON_UNESCAPED_SLASHES); $tmp = $f . '.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $body) === strlen($body)) @rename($tmp, $f); else @unlink($tmp);
}
function snow_disk(): int { $n = 0; foreach (array_merge(glob(snow_dir() . '/*.json') ?: [], glob(snow_dir('sim') . '/*.json') ?: []) as $f) $n += (int)@filesize($f); return $n; }
/* the local test copy may replay a past winter; production never (site_url is https://glett.no there) */
function snow_sim_on(): bool
{
    $c = app_config();
    return (string)($c['snow_sim'] ?? '') === '1' && in_array(parse_url((string)($c['site_url'] ?? ''), PHP_URL_HOST), ['127.0.0.1', 'localhost'], true);
}
function snow_centre(int $i): string { return ((($i % SNOW_COLS) * 1000) - 74500) . ' ' . (7999500 - intdiv($i, SNOW_COLS) * 1000); }   // always the cell's centre: a point on an edge lands in either cell
/* the budgets of POSTs to NVE this hour: the visitor's own (the rate-limit table, an hourly window under its own bucket; only a
   hash of the address is stored) and the site's (a file, under the snow lock). The visitor's is checked first, so a visitor over
   their own limit does not spend the site's. */
function snow_visitor_budget(): bool
{
    if (PHP_SAPI === 'cli') return true;
    $h = md5('glett|snowup|' . ($_SERVER['REMOTE_ADDR'] ?? '')); $hour = time() - time() % 3600;
    q('INSERT INTO ratelimit (ip_hash, window_start, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = IF(window_start = ?, n + 1, 1), window_start = ?', [$h, $hour, $hour, $hour]);
    return (int)(q('SELECT n FROM ratelimit WHERE ip_hash = ?', [$h])->fetch()['n'] ?? 0) <= SNOW_VISITOR_PER_HOUR;
}
function snow_budget(): bool
{
    if (!snow_visitor_budget()) return false;
    $f = snow_dir() . '/upstream.json'; $u = snow_read($f); $hour = time() - time() % 3600;
    $n = ($u['h'] ?? 0) === $hour ? (int)($u['n'] ?? 0) + 1 : 1;
    snow_write($f, ['h' => $hour, 'n' => $n]);
    return $n <= SNOW_UPSTREAM_PER_HOUR;
}
/* One theme for the cells (centres "x y,x y"), $from..$to: [status, body]; status 0 when not sent or no answer */
function snow_post(string $theme, string $csv, string $from, string $to): array
{
    $left = SNOW_DEADLINE - (microtime(true) - $GLOBALS['snow_t0']);
    if ($left < 2 || !snow_budget()) return [0, ''];
    $c = app_config();
    $ch = curl_init(SNOW_URL);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_CONNECTTIMEOUT => 4, CURLOPT_TIMEOUT_MS => (int)(1000 * min(8, $left - 0.3)),
        CURLOPT_POSTFIELDS => json_encode(['Theme' => $theme, 'StartDate' => $from, 'EndDate' => $to, 'Format' => 'json', 'MapCoordinateCsv' => $csv]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json'], CURLOPT_USERAGENT => user_agent(), CURLOPT_REFERER => (string)($c['site_url'] ?? ''),
        CURLOPT_ENCODING => '', CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $body = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    return [$body === false ? 0 : $status, $body === false ? '' : (string)$body];
}
/* One theme for the cells as [cell => [Altitude, Data]]; null when NVE fails. A point without a cell makes NVE fail the whole
   batch (500, "The given key was not present"): the list is then halved until the culprits are alone, and they go to $nocell.
   At most SNOW_SPLIT_MAX halving POSTs a request: a part still failing then is left out (null in this answer, not marked as
   no-cell, so a later request finds the rest; the found ones are remembered for 30 days). */
function snow_theme(string $theme, array $cells, string $from, string $to, array &$nocell, bool $split = false): ?array
{
    if (!$cells) return [];
    if ($split && ++$GLOBALS['snow_splits'] > SNOW_SPLIT_MAX) { $GLOBALS['snow_partial'] = true; return []; }
    [$code, $body] = snow_post($theme, implode(',', array_map('snow_centre', $cells)), $from, $to);
    if ($code === 500 && str_contains($body, 'given key')) {
        if (count($cells) === 1) { $nocell[$cells[0]] = time(); return []; }
        if ($GLOBALS['snow_splits'] >= SNOW_SPLIT_MAX) { $GLOBALS['snow_partial'] = true; return []; }
        $h = intdiv(count($cells), 2);
        $a = snow_theme($theme, array_slice($cells, 0, $h), $from, $to, $nocell, true); if ($a === null) return null;
        $b = snow_theme($theme, array_slice($cells, $h), $from, $to, $nocell, true); if ($b === null) return null;
        return $a + $b;
    }
    $j = $code === 200 ? json_decode($body, true) : null;
    if (!is_array($j) || !is_array($j['CellTimeSeries'] ?? null)) {
        error_log("Glett snow: NVE $theme HTTP $code" . ($code === 200 ? ' (unexpected answer)' : ''));
        return null;
    }
    $nd = (int)($j['NoDataValue'] ?? 65535); $want = array_flip($cells); $out = [];
    foreach ($j['CellTimeSeries'] as $s) {
        $i = (int)($s['CellIndex'] ?? -1); if (!isset($want[$i]) || !is_array($s['Data'] ?? null)) continue;
        $out[$i] = [(int)($s['Altitude'] ?? 0), array_map(fn($v) => $v === null || (int)round((float)$v) === $nd ? null : (float)$v, $s['Data'])];
    }
    return $out;
}
/* the three themes for the cells over $n days from $from -> [cell => {t, a, sd, ski, nf, hs, hn}] (no-cell points left out); null
   when NVE fails. ski and sdfsw start SNOW_HIST days earlier in the same POST (17 values a cell): those days go to hs and hn. */
function snow_fetch(array $cells, string $from, array &$nocell): ?array
{
    $to = (new DateTimeImmutable($from))->modify('+' . (SNOW_DAYS - 1) . ' days')->format('Y-m-d');
    $early = (new DateTimeImmutable($from))->modify('-' . SNOW_HIST . ' days')->format('Y-m-d');
    $sd = snow_theme('sd', $cells, $from, $to, $nocell); if ($sd === null) return null;
    $ok = array_keys($sd);   // the other themes only for the cells that exist
    $ski = snow_theme('ski', $ok, $early, $to, $nocell); if ($ski === null) return null;
    $nf = snow_theme('sdfsw', $ok, $early, $to, $nocell); if ($nf === null) return null;
    $now = time(); $out = [];
    $series = fn(?array $x, callable $f, int $k0, int $n) => array_map(fn($k) => $x !== null && isset($x[1][$k]) && $x[1][$k] !== null ? $f($x[1][$k]) : null, range($k0, $k0 + $n - 1));
    $cls = fn($v) => $v >= 0 && $v <= 3 ? (int)$v : null;   // 255 is NoData; anything above 3 is not a class
    $cm = fn($v) => round($v, 1);
    foreach ($sd as $i => $s) $out[$i] = ['t' => $now, 'a' => $s[0],
        'sd' => $series($s, fn($v) => (int)round($v), 0, SNOW_DAYS),
        'ski' => $series($ski[$i] ?? null, $cls, SNOW_HIST, SNOW_DAYS), 'nf' => $series($nf[$i] ?? null, $cm, SNOW_HIST, SNOW_DAYS),
        'hs' => $series($ski[$i] ?? null, $cls, 0, SNOW_HIST), 'hn' => $series($nf[$i] ?? null, $cm, 0, SNOW_HIST)];
    return $out;
}
/* sim only: NVE's hourly air temperature (tm1h, °C, although the theme list says Kelvin) for the cells from the sim date 00 on,
   [cell => t1[121]]; null when NVE fails. Index 0 is taken as 00 UTC (eget anslag: it follows the UTC reanalysis at lag 0, r 0.86–0.98
   at Finse; not checked against a station). Values outside -60..+40 are NoData. */
function snow_t1(array $cells, string $sim, array &$nocell): ?array
{
    $to = (new DateTimeImmutable($sim))->modify('+' . SNOW_T1_DAYS . ' days')->format('Y-m-d');
    $tm = snow_theme('tm1h', $cells, $sim, $to, $nocell); if ($tm === null) return null;
    $n = SNOW_T1_DAYS * 24 + 1; $out = [];
    foreach ($tm as $i => $s) $out[$i] = array_map(fn($k) => isset($s[1][$k]) && $s[1][$k] !== null && $s[1][$k] >= -60 && $s[1][$k] <= 40 ? round($s[1][$k], 1) : null, range(0, $n - 1));
    return $out;
}
function snow_lock()   // the snow directory's lock, waited for while at least 3 s of the deadline are left (a fetch needs them); null when not had
{
    $h = @fopen(snow_dir() . '/.lock', 'c'); if (!$h) return null;
    while (SNOW_DEADLINE - (microtime(true) - $GLOBALS['snow_t0']) > 3) { if (flock($h, LOCK_EX | LOCK_NB)) return $h; usleep(100000); }
    fclose($h); return null;
}
function snow_clean(): void   // now and then: old day files, unused replays, old no-cell marks
{
    if (random_int(1, 20) !== 1) return;
    $keep = (new DateTimeImmutable('now', new DateTimeZone('Europe/Oslo')))->modify('-2 days')->format('Y-m-d');
    foreach (glob(snow_dir() . '/????-??-??.json') ?: [] as $f) if (basename($f, '.json') < $keep) @unlink($f);
    foreach (glob(snow_dir('sim') . '/*.json') ?: [] as $f) if (max((int)@fileatime($f), (int)@filemtime($f)) < time() - 30 * 86400) @unlink($f);
    $f = snow_dir() . '/nocell.json'; $no = snow_read($f); $keep = array_filter($no, fn($t) => $t >= time() - SNOW_NOCELL_TTL);
    if (count($keep) !== count($no)) snow_write($f, $keep);
}
function snow_out(array $data, bool $sim): void   // json_out() says no-store; a real answer may be kept ten minutes
{
    header('Content-Type: application/json; charset=utf-8');
    header($sim ? 'Cache-Control: no-store' : 'Cache-Control: public, max-age=600');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

$oslo = new DateTimeZone('Europe/Oslo');
$d0 = (new DateTimeImmutable('now', $oslo))->format('Y-m-d');
$days = array_map(fn($k) => (new DateTimeImmutable($d0))->modify("+$k days")->format('Y-m-d'), range(0, SNOW_DAYS - 1));
$sim = null;
if (isset($_GET['sim']) && snow_sim_on()) {
    $s = (string)$_GET['sim'];
    $ds = preg_match('~^\d{4}-\d{2}-\d{2}$~', $s) ? DateTimeImmutable::createFromFormat('!Y-m-d', $s, $oslo) : false;
    $latest = (new DateTimeImmutable($d0))->modify('-' . SNOW_DAYS . ' days')->format('Y-m-d');
    if (!$ds || $ds->format('Y-m-d') !== $s || $s < '1958-01-01' || $s > $latest) json_out(['error' => 'Bad request'], 400);   // all ten days must be history
    $sim = $s;
}
$from = $sim ?? $d0;
$wax = ($_GET['w'] ?? '') === '1';   // the wax tips want the history (and, in a replay, the replayed hours' temperature)
$tiles = array_map(fn($k) => 'sd_' . str_replace('-', '_', (new DateTimeImmutable($from))->modify("+$k days")->format('Y-m-d')), range(0, SNOW_DAYS - 1));

snow_clean();
$nf = snow_dir() . '/nocell.json';
$file = $sim !== null ? snow_dir('sim') . "/$sim.json" : snow_dir() . "/$d0.json";
// a cell from before the history was fetched (no hs) is fetched again once for a w=1 request
$fresh = fn(array $have, array $no) => array_reduce($cells, fn($ok, $i) => $ok && (isset($no[$i]) || (isset($have[$i]) && (!$wax || isset($have[$i]['hs'])) && ($sim !== null || $have[$i]['t'] >= time() - SNOW_TTL))), true);
// t1 null: NVE had no hours for that cell (asked, not in the answer): never asked again
$t1miss = fn(array $have, array $no) => $sim !== null && $wax ? array_values(array_filter($cells, fn($i) => !isset($no[$i]) && isset($have[$i]) && !array_key_exists('t1', $have[$i]))) : [];
$answer = function (array $have, array $no, bool $stale) use ($cells, $d0, $days, $tiles, $sim, $wax) {
    $out = []; $at = PHP_INT_MAX; $t1 = $sim !== null && $wax;
    foreach ($cells as $i) {
        if (isset($no[$i]) || !isset($have[$i])) { $out[(string)$i] = null; continue; }
        $c = $have[$i]; $at = min($at, (int)$c['t']); $t1 = $t1 && array_key_exists('t1', $c);
        $out[(string)$i] = ['a' => $c['a'], 'sd' => $c['sd'], 'ski' => $c['ski'], 'nf' => $c['nf']];
        if ($wax) $out[(string)$i] += ['hs' => $c['hs'] ?? array_fill(0, SNOW_HIST, null), 'hn' => $c['hn'] ?? array_fill(0, SNOW_HIST, null)];
        if ($sim !== null && $wax && isset($c['t1'])) $out[(string)$i]['t1'] = $c['t1'];
    }
    $data = ['d0' => $d0, 'n' => SNOW_DAYS, 'days' => $days, 'tiles' => $tiles, 'sim' => $sim, 'stale' => $stale, 'at' => $at === PHP_INT_MAX ? time() : $at, 'cells' => (object)$out];
    if ($wax) $data['wx'] = true;
    if ($t1) $data['t1from'] = (new DateTimeImmutable($sim . 'T00:00:00', new DateTimeZone('UTC')))->getTimestamp();   // only when every cell has its hours: else the page says the tips are not available
    snow_out($data, $sim !== null || $GLOBALS['snow_partial']);
};
$nocell = array_filter(snow_read($nf), fn($t) => $t >= time() - SNOW_NOCELL_TTL);
$have = snow_read($file);
if ($fresh($have, $nocell) && !$t1miss($have, $nocell)) $answer($have, $nocell, false);

$lock = snow_lock();
$have = snow_read($file); $nocell = array_filter(snow_read($nf), fn($t) => $t >= time() - SNOW_NOCELL_TTL);
if ($lock && $fresh($have, $nocell) && !$t1miss($have, $nocell)) $answer($have, $nocell, false);   // filled while we waited
$got = null;
if ($lock) {
    $n0 = count($nocell); $keep = false;
    if ($fresh($have, $nocell)) $got = [];   // only the replay's hours are missing
    else {
        $ask = array_values(array_filter($cells, fn($i) => !isset($nocell[$i])));
        $got = snow_fetch($ask, $from, $nocell);
        if ($got !== null) { foreach ($got as $i => $c) if (isset($have[$i]) && array_key_exists('t1', $have[$i])) $got[$i]['t1'] = $have[$i]['t1']; $have = $got + $have; $keep = true; }   // a replay's hours stay
    }
    if ($got !== null && ($miss = $t1miss($have, $nocell))) {   // sim and w=1 only: one more POST, kept with the replay for good; on failure the answer goes without
        $part = $GLOBALS['snow_partial']; $GLOBALS['snow_partial'] = false;
        $t1 = snow_t1($miss, $sim, $nocell); $cut = $GLOBALS['snow_partial']; $GLOBALS['snow_partial'] = $part || $cut;
        // a cell NVE left out of a whole answer gets null (not asked again); one the split cap left out is asked next time
        if ($t1 !== null) { foreach ($miss as $i) if (isset($have[$i]) && (isset($t1[$i]) || !$cut)) $have[$i]['t1'] = $t1[$i] ?? null; $keep = true; }
    }
    if (count($nocell) !== $n0) snow_write($nf, $nocell);
    if ($keep) {
        if (count($have) > SNOW_FILE_CELLS) { uasort($have, fn($a, $b) => $b['t'] <=> $a['t']); $have = array_slice($have, 0, SNOW_FILE_CELLS, true); }
        if (snow_disk() < SNOW_DISK_MAX) snow_write($file, $have);
    }
    flock($lock, LOCK_UN); fclose($lock);
}
if ($got !== null) $answer($have, $nocell, false);
// NVE did not answer (or the budget is spent): the same date's last answer, if it has every cell
if (array_reduce($cells, fn($ok, $i) => $ok && (isset($nocell[$i]) || isset($have[$i])), true)) $answer($have, $nocell, true);
error_log('Glett snow: no answer from NVE for ' . count($cells) . " cells ($from)");
json_out(['error' => 'upstream'], 502);
