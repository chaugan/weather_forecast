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
const ROUTE_RATE_PER_MIN = 10;         // per client, on top of the site-wide limit
const ROUTE_UPSTREAM_PER_DAY = 2000;   // Vegvesen allows 2500 calls a day; leave room for the odd retry
const ROUTE_BASE = 'https://www.vegvesen.no/ws/no/vegvesen/ruteplan/routingservice_v3_0/routingService/api/Route/';

rate_limit();
housekeeping();
$cfg = app_config();
$user = (string)($cfg['vegvesen_ruteplan_user'] ?? getenv('WEFO_VEGVESEN_RUTEPLAN_USER') ?: '');
$pass = (string)($cfg['vegvesen_ruteplan_pass'] ?? getenv('WEFO_VEGVESEN_RUTEPLAN_PASS') ?: '');
$ready = $user !== '' && $pass !== '';

if (isset($_GET['status'])) { header('Cache-Control: public, max-age=3600'); json_out(['vegvesen' => $ready]); }
if (!$ready) json_out(['error' => 'The Vegvesen route planner is not configured', 'unavailable' => true], 503);

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
$key = 'route:' . md5("$kind|$lang|$stopsStr|" . ($start ?? 'now') . ($noFerry ? '|noferry' : ''));
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
$qs = 'Stops=' . rawurlencode($stopsStr) . '&InputSRS=EPSG_4326&OutputSRS=EPSG_4326&ReturnFields=Geometry&Lang=' . $lang . ($start ? '&StartTime=' . $start : '') . ($noFerry ? '&AvoidRoadFeatureTypes=Ferge' : '');
[$status, $body] = http_get_status(ROUTE_BASE . $kind . '?' . $qs, 12, ['Authorization: Basic ' . base64_encode("$user:$pass")]);
$j = $status === 200 && $body ? json_decode($body, true) : null;
if (!is_array($j) || !isset($j['routes']) || !is_array($j['routes'])) { if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]); error_log('Glett route: Vegvesen HTTP ' . $status); json_out(['error' => 'The Vegvesen route planner did not answer', 'unavailable' => true], 502); }
// the NVDB link lists are large and unused by the browser
foreach ($j['routes'] as &$r) { unset($r['nvdbReferenceLinks'], $r['superReferenceLinks']); }
unset($r);
$out = json_encode($j, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
cache_put($key, $out, ROUTE_TTL);
if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, max-age=600');
echo $out;
