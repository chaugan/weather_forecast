<?php
// Kjørevær: a proxy to Statens vegvesen's route planner (Ruteplantjeneste v3), the primary router for Norway. The
// service needs a username and password (HTTP Basic), so the browser cannot call it directly; the credentials never
// leave the server. Free to use when Statens vegvesen is cited, 2500 calls a day: requests are rounded and cached,
// rate limited per client, and a site-wide daily budget keeps us under the limit. Without credentials it answers 503
// {unavailable} and the browser routes with Valhalla (OpenStreetMap) instead.
//   GET api/route.php?status=1                              -> {vegvesen: true|false}
//   GET api/route.php?stops=lat,lon;lat,lon[;...]&kind=best|tourist&start=YYYYMMDDHHmm&lang=nb|en
//                                                           -> Vegvesen's answer (GeoJSON routes), trimmed
declare(strict_types=1);
require __DIR__ . '/db.php';

const ROUTE_TTL = 1800;                // dynamic road information (closures, delays) changes: half an hour
const ROUTE_RATE_PER_MIN = 30;         // per client, on top of the site-wide limit (avoiding narrow roads asks up to 5 times)
const ROUTE_UPSTREAM_PER_DAY = 2000;   // Vegvesen allows 2500 calls a day; leave room for the odd retry
const ROUTE_BASE = 'https://www.vegvesen.no/ws/no/vegvesen/ruteplan/routingservice_v3_0/routingService/api/Route/';
// the same service has an open variant that needs no credentials (CORS open as well); it answers one route for "best"
// and two for "tourist", so without credentials both are asked and merged. Used until the username and password arrive.
const ROUTE_BASE_OPEN = 'https://www.vegvesen.no/ws/no/vegvesen/ruteplan/routingservice_v3_0/open/routingService/api/Route/';

rate_limit();
housekeeping();
$cfg = app_config();
$user = (string)($cfg['vegvesen_ruteplan_user'] ?? getenv('WEFO_VEGVESEN_RUTEPLAN_USER') ?: '');
$pass = (string)($cfg['vegvesen_ruteplan_pass'] ?? getenv('WEFO_VEGVESEN_RUTEPLAN_PASS') ?: '');
$ready = $user !== '' && $pass !== '';
$open = !$ready;   // no credentials: the open endpoint

if (isset($_GET['status'])) { header('Cache-Control: public, max-age=3600'); json_out(['vegvesen' => true, 'open' => $open]); }

// 2 to 10 stops (start, up to 8 via points, end), each in the Nordic area the service covers; rounded to about 100 m
$stops = [];
foreach (explode(';', (string)($_GET['stops'] ?? '')) as $s) {
    $p = explode(',', $s);
    if (count($p) !== 2 || !is_numeric($p[0]) || !is_numeric($p[1])) json_out(['error' => 'Invalid stops'], 400);
    [$la, $lo] = [round((float)$p[0], 3), round((float)$p[1], 3)];
    if ($la < 54 || $la > 72 || $lo < 3 || $lo > 32) json_out(['error' => 'Outside the area the route planner covers', 'outside' => true], 422);
    $stops[] = [$la, $lo];
}
if (count($stops) < 2 || count($stops) > 10) json_out(['error' => 'Give 2 to 10 stops'], 400);
$kind = (($_GET['kind'] ?? 'best') === 'tourist') ? 'tourist' : 'best';
$noFerry = !empty($_GET['noferry']);   // Kjørevær's Unngå ferjer
// Kjørevær's "Smale veier": points the route must not pass (the middle of each narrow stretch, on the road), "lat,lon;…";
// Vegvesen reads them in InputSRS and blocks the road within a few metres. At most 90: its firewall refuses longer addresses.
$barriers = [];
foreach (array_filter(explode(';', (string)($_GET['barriers'] ?? ''))) as $s) {
    $p = explode(',', $s);
    if (count($p) !== 2 || !is_numeric($p[0]) || !is_numeric($p[1])) json_out(['error' => 'Invalid barriers'], 400);
    [$la, $lo] = [round((float)$p[0], 5), round((float)$p[1], 5)];
    if ($la < 54 || $la > 72 || $lo < 3 || $lo > 32) json_out(['error' => 'Invalid barriers'], 400);
    $barriers[] = sprintf('%.5f,%.5f', $lo, $la);
}
if (count($barriers) > 90) json_out(['error' => 'Too many barriers'], 400);
$barrierStr = implode(';', $barriers);
$lang = (($_GET['lang'] ?? 'nb') === 'en') ? 'English' : 'Norwegian';
// the start time affects delays and dynamic road information: rounded to the hour, today to 3 days ahead only
$start = null;
if (preg_match('/^\d{12}$/', (string)($_GET['start'] ?? ''))) {
    $tz = new DateTimeZone('Europe/Oslo');
    $d = DateTimeImmutable::createFromFormat('!YmdHi', (string)$_GET['start'], $tz);
    // an impossible date (31 February) is rejected rather than rolled over into March
    if ($d && $d->format('YmdHi') === $_GET['start'] && $d->getTimestamp() > time() - 3600 && $d->getTimestamp() < time() + 4 * 86400) $start = $d->format('YmdH') . '0000';
}

$stopsStr = implode(';', array_map(fn($p) => sprintf('%.3f,%.3f', $p[1], $p[0]), $stops));   // x,y = lon,lat in EPSG:4326
$key = 'route:' . md5(($open ? 'open|' : '') . "$kind|$lang|$stopsStr|" . ($start ?? 'now') . ($noFerry ? '|noferry' : '') . ($barrierStr ? '|b:' . $barrierStr : ''));
$hit = cache_get($key);
if ($hit !== null) { header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: private, max-age=600'); echo $hit; exit; }

// only calls that reach Vegvesen count against the client's own route limit and the site-wide daily budget
rate_limit(ROUTE_RATE_PER_MIN, 'route');
$day = (int)(new DateTimeImmutable('today', new DateTimeZone('Europe/Oslo')))->getTimestamp();   // the budget follows the Oslo day
q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + 1, 1), last_at = ?', ['route:upstream', $day, $day, $day]);
if ((int)(q('SELECT calls FROM throttle WHERE name = ?', ['route:upstream'])->fetch()['calls'] ?? 0) > ROUTE_UPSTREAM_PER_DAY) json_out(['error' => 'Busy, try again later', 'busy' => true], 503);

// identical requests arriving together wait for the first one instead of each calling Vegvesen
$lock = 'glett:' . md5($key);
$got = (int)(q('SELECT GET_LOCK(?, 15) l', [$lock])->fetch()['l'] ?? 0);
if ($got === 1 && ($hit = cache_get($key)) !== null) { q('SELECT RELEASE_LOCK(?)', [$lock]); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: private, max-age=600'); echo $hit; exit; }
$qs = 'Stops=' . rawurlencode($stopsStr) . '&InputSRS=EPSG_4326&OutputSRS=EPSG_4326&ReturnFields=Geometry&Lang=' . $lang . ($start ? '&StartTime=' . $start : '') . ($noFerry ? '&AvoidRoadFeatureTypes=Ferge' : '') . ($barrierStr ? '&Barriers=' . $barrierStr : '');   // digits , . ; - only (validated): unencoded, so 80 points stay under the firewall's ~2000 characters
$base = $open ? ROUTE_BASE_OPEN : ROUTE_BASE;
$hdr = $open ? ['Accept: application/json'] : ['Accept: application/json', 'Authorization: Basic ' . base64_encode("$user:$pass")];
[$status, $body] = http_get_status($base . $kind . '?' . $qs, 15, $hdr);
$j = $status === 200 && $body ? json_decode($body, true) : null;
if ($barrierStr && $status === 404 && is_array($j = json_decode((string)$body, true)) && (int)($j['code'] ?? 0) === 9005) { if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]); $nr = json_encode(['error' => 'No route without the blocked roads', 'noroute' => true]); cache_put($key, $nr, ROUTE_TTL); json_out(['error' => 'No route without the blocked roads', 'noroute' => true], 404); }   // remembered too: the same attempt again costs nothing   // every way is blocked: the browser keeps its best attempt
if (!is_array($j) || !isset($j['routes']) || !is_array($j['routes'])) { if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]); error_log('Glett route: Vegvesen HTTP ' . $status); json_out(['error' => 'The Vegvesen route planner did not answer', 'unavailable' => true], 502); }
if ($kind === 'best' && count($j['routes']) < 2) {   // alternatives: the tourist variant answers two routes; the ones not already there are added (the same length within 1 % is the same route)
    // the second upstream call counts against the daily budget too, so one request cannot spend two calls unseen
    q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + 1, 1), last_at = ?', ['route:upstream', $day, $day, $day]);
    $spent = (int)(q('SELECT calls FROM throttle WHERE name = ?', ['route:upstream'])->fetch()['calls'] ?? 0);
    [$st2, $b2] = $spent > ROUTE_UPSTREAM_PER_DAY ? [0, ''] : http_get_status($base . 'tourist?' . $qs, 15, $hdr);
    $j2 = $st2 === 200 && $b2 ? json_decode($b2, true) : null;
    if (is_array($j2) && !empty($j2['routes']) && is_array($j2['routes'])) {
        $len = fn($r) => (float)(($r['statistic']['totalLength'] ?? 0) ?: array_sum(array_map(fn($f) => (float)($f['properties']['length'] ?? 0), $r['features'] ?? [])));
        foreach ($j2['routes'] as $r2) {
            $dup = false; foreach ($j['routes'] as $r1) { $a = $len($r1); $b = $len($r2); if ($a > 0 && abs($a - $b) / $a < 0.01) { $dup = true; break; } }
            if (!$dup && count($j['routes']) < 3) $j['routes'][] = $r2;
        }
    }
}
// the NVDB link lists are large and unused by the browser
foreach ($j['routes'] as &$r) { unset($r['nvdbReferenceLinks'], $r['superReferenceLinks']); }
unset($r);
$out = json_encode($j, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
cache_put($key, $out, ROUTE_TTL);
if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, max-age=600');
echo $out;
