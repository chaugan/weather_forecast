<?php
// Terrain shadow map (Norway only): a proxy to Sundrift's terrain-shadow endpoint. Sundrift's bearer token never leaves
// the server. The browser never sends a date: this file decides "today" in Europe/Oslo. Places are rounded to 0.01°
// (about 1 km), must lie in mainland Norway, and are cached per place and day, so the proxy cannot be used to query
// arbitrary dates and repeated requests cost Sundrift nothing.
//   GET api/shadow.php?ticket=1&lat=&lon=  -> {ticket, exp}: a short-lived signed ticket for this place and today
//   GET api/shadow.php?t=<ticket>          -> Sundrift's result for that place and today (JSON with bbox + PNGs)
declare(strict_types=1);
require __DIR__ . '/db.php';

const SHADOW_TTL_TICKET = 1800;          // a ticket is valid 30 minutes
const SHADOW_RATE_PER_MIN = 12;          // per client, on top of the site-wide limit
const SHADOW_UPSTREAM_PER_HOUR = 120;    // site-wide budget of uncached Sundrift calls
const SHADOW_TIMEOUT = 25;               // Sundrift may need a while for a fresh area

rate_limit();
housekeeping();
$cfg = app_config();
$base = rtrim((string)($cfg['sundrift_url'] ?? getenv('WEFO_SUNDRIFT_URL') ?: ''), '/');
$token = (string)($cfg['sundrift_token'] ?? getenv('WEFO_SUNDRIFT_TOKEN') ?: '');
if ($base === '' || $token === '') json_out(['error' => 'The shadow map is not configured yet', 'unavailable' => true], 503);

$oslo = new DateTimeZone('Europe/Oslo');
$today = (new DateTimeImmutable('now', $oslo))->format('Y-m-d');
$inNorway = fn(float $la, float $lo): bool => $la >= 57.8 && $la <= 71.3 && $lo >= 4.5 && $lo <= 31.3;

/* The signing key: made once and kept in the kv table, never sent anywhere */
function shadow_secret(): string
{
    try { $r = q('SELECT v FROM kv WHERE k = ?', ['shadow:secret'])->fetch(); if ($r) return (string)$r['v']; }
    catch (PDOException $e) { db()->exec('CREATE TABLE IF NOT EXISTS kv (k VARCHAR(64) NOT NULL PRIMARY KEY, v TEXT NOT NULL, updated_at INT UNSIGNED NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'); }
    $s = bin2hex(random_bytes(32));
    q('INSERT IGNORE INTO kv (k, v, updated_at) VALUES (?, ?, ?)', ['shadow:secret', $s, time()]);
    return (string)(q('SELECT v FROM kv WHERE k = ?', ['shadow:secret'])->fetch()['v'] ?? $s);
}
$b64u = fn(string $s): string => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');

/* 1. Ticket for a place, today */
if (isset($_GET['ticket'])) {
    [$lat, $lon] = coords();
    if (!$inNorway($lat, $lon)) json_out(['error' => 'The shadow map covers Norway only', 'outside' => true], 422);
    $payload = sprintf('%.2f|%.2f|%s|%d', round($lat, 2), round($lon, 2), $today, time() + SHADOW_TTL_TICKET);
    json_out(['ticket' => $b64u($payload) . '.' . $b64u(hash_hmac('sha256', $payload, shadow_secret(), true)), 'date' => $today]);
}

/* 2. The shadow data for a ticket */
rate_limit(SHADOW_RATE_PER_MIN + RATE_LIMIT_PER_MIN);   // (the site-wide limit already counted this request once)
$parts = explode('.', (string)($_GET['t'] ?? ''));
$dec = fn(string $s): string => (string)base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4));
if (count($parts) !== 2) json_out(['error' => 'Missing ticket'], 400);
$payload = $dec($parts[0]);
if (!hash_equals(hash_hmac('sha256', $payload, shadow_secret(), true), $dec($parts[1]))) json_out(['error' => 'Invalid ticket'], 403);
[$la, $lo, $date, $exp] = array_pad(explode('|', $payload), 4, '');
if ((int)$exp < time() || $date !== $today) json_out(['error' => 'Ticket expired', 'expired' => true], 410);

$key = "shadow:$la:$lo:$date";
$hit = cache_get($key);
if ($hit !== null) { header('Cache-Control: private, max-age=3600'); header('Content-Type: application/json; charset=utf-8'); echo $hit; exit; }

// site-wide budget for uncached calls, so a scraper cannot run up Sundrift's bill
$hour = time() - time() % 3600;
q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + 1, 1), last_at = ?', ['shadow:upstream', $hour, $hour, $hour]);
if ((int)(q('SELECT calls FROM throttle WHERE name = ?', ['shadow:upstream'])->fetch()['calls'] ?? 0) > SHADOW_UPSTREAM_PER_HOUR) json_out(['error' => 'Busy, try again later', 'busy' => true], 503);

$lock = 'glett:' . md5($key);
$got = (int)(q('SELECT GET_LOCK(?, 20) l', [$lock])->fetch()['l'] ?? 0);
try {
    $hit = cache_get($key);
    if ($hit === null) {
        $ch = curl_init($base . '/glett/terrain-shadow?' . http_build_query(['lat' => $la, 'lon' => $lo, 'date' => $date]));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => SHADOW_TIMEOUT, CURLOPT_ENCODING => '',
            CURLOPT_USERAGENT => user_agent(), CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $token],
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
        $body = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
        if ($status !== 200 || !$body || json_decode((string)$body, true) === null) { error_log('Glett shadow: Sundrift HTTP ' . $status); json_out(['error' => 'Sundrift did not answer', 'unavailable' => true], 502); }
        // until tomorrow in Oslo: the result is for today only
        $ttl = max(600, (new DateTimeImmutable('tomorrow', $oslo))->getTimestamp() - time());
        cache_put($key, (string)$body, $ttl);
        $hit = (string)$body;
    }
} finally {
    if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]);
}
header('Cache-Control: private, max-age=3600');
header('Content-Type: application/json; charset=utf-8');
echo $hit;
