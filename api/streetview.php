<?php
// Kjørevær: Google Street View for a spot on the route. The key stays on the server (the repository is public):
//   GET api/streetview.php?status=1                          -> {ok: true|false}  (is a key configured)
//   GET api/streetview.php?meta=1&lat=&lon=                  -> {ok, pano, lat, lon, date, m}  Street View metadata within
//        50 m (free of charge, no quota), cached for 30 days per ~10 m cell; ok:false when there is no panorama nearby
//   GET api/streetview.php?img=1&pano=&heading=                -> a clean 640x400 Street View Static image for the popup,
//        fetched by the server (the visitor's browser never contacts Google for it), cached a day per pano and heading.
//        Static images are free up to 10,000 a month; a monthly counter stops at SV_STATIC_MONTH and answers 429 {quota},
//        and the popup then falls back to the free Embed frame, so this never gets billed.
//   GET api/streetview.php?embed=1&pano=|lat=&lon=&heading=&pitch=&fov=
//                                                            -> 302 to the Maps Embed API Street View iframe URL (free,
//        unlimited). The browser loads that URL in an iframe, so Google sees glett.no as the referrer the key is locked to.
// The key: 'google_maps_key' in the server config (WEFO_GOOGLE_MAPS_KEY), restricted in Google Cloud to the glett.no
// referrers and to the Maps Embed API and the Street View Static API (only its free metadata is used).
declare(strict_types=1);
require __DIR__ . '/db.php';

const SV_RADIUS = 50;              // metres around the clicked spot
const SV_META_TTL = 30 * 86400;    // panoramas rarely move
const SV_RATE_PER_MIN = 30;        // per client, metadata and image calls that reach Google
const SV_STATIC_MONTH = 9000;      // Static images per calendar month (Google's free cap is 10,000)
const SV_IMG_TTL = 86400;          // cached images: one day

rate_limit();
housekeeping();
$key = (string)(app_config()['google_maps_key'] ?? '');
if (isset($_GET['status'])) { header('Cache-Control: public, max-age=3600'); json_out(['ok' => $key !== '']); }
if ($key === '') json_out(['error' => 'Street View is not configured', 'unavailable' => true], 503);

$num = function (string $k, float $min, float $max, ?float $def = null): ?float {
    if (!isset($_GET[$k]) || $_GET[$k] === '') return $def;
    $v = filter_var($_GET[$k], FILTER_VALIDATE_FLOAT);
    if ($v === false || $v < $min || $v > $max) json_out(['error' => "Invalid $k"], 400);
    return (float)$v;
};

if (isset($_GET['embed'])) {
    $pano = (string)($_GET['pano'] ?? '');
    if ($pano !== '' && !preg_match('/^[A-Za-z0-9_.-]{8,160}$/', $pano)) json_out(['error' => 'Invalid pano'], 400);
    $q = ['key' => $key];
    if ($pano !== '') $q['pano'] = $pano;
    $lat = $num('lat', -90, 90); $lon = $num('lon', -180, 180);
    if ($lat !== null && $lon !== null) $q['location'] = sprintf('%.6f,%.6f', $lat, $lon);   // used if the pano is gone
    if (!isset($q['pano']) && !isset($q['location'])) json_out(['error' => 'Give pano or lat/lon'], 400);
    $q['heading'] = (string)round($num('heading', -360, 360, 0.0));
    $q['pitch'] = (string)round($num('pitch', -90, 90, 0.0));
    $q['fov'] = (string)round($num('fov', 10, 100, 80.0));
    header('Cache-Control: private, max-age=300');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Location: https://www.google.com/maps/embed/v1/streetview?' . http_build_query($q), true, 302);
    exit;
}

if (isset($_GET['img'])) {
    $pano = (string)($_GET['pano'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_.-]{8,160}$/', $pano)) json_out(['error' => 'Invalid pano'], 400);
    $heading = (int)(round($num('heading', -360, 360, 0.0) / 15) * 15 + 360) % 360;   // 15 degree steps: better cache hits
    $dir = dirname(__DIR__, 2) . '/glett-cache/sv';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $file = "$dir/" . md5("$pano|$heading") . '.jpg';
    if (!is_file($file) || filemtime($file) < time() - SV_IMG_TTL) {
        rate_limit(SV_RATE_PER_MIN, 'streetview');
        $month = (int)date('Ym');   // the monthly budget of Static images
        q('INSERT INTO throttle (name, last_at, calls) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE calls = IF(last_at = ?, calls + 1, 1), last_at = ?', ['sv:static', $month, $month, $month]);
        if ((int)(q('SELECT calls FROM throttle WHERE name = ?', ['sv:static'])->fetch()['calls'] ?? 0) > SV_STATIC_MONTH) json_out(['error' => 'Monthly image budget used', 'quota' => true], 429);
        $ch = curl_init('https://maps.googleapis.com/maps/api/streetview?' . http_build_query(['size' => '640x400', 'pano' => $pano, 'heading' => $heading, 'pitch' => 0, 'fov' => 80, 'return_error_code' => 'true', 'key' => $key]));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10, CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
        $img = curl_exec($ch); $st = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); $ct = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE); curl_close($ch);
        if ($st !== 200 || !$img || stripos($ct, 'image/') !== 0) { error_log('Glett streetview image: HTTP ' . $st); json_out(['error' => 'Google did not answer'], 502); }
        if (is_dir($dir)) { @file_put_contents("$file.tmp", $img, LOCK_EX); @rename("$file.tmp", $file); }
        if (random_int(1, 50) === 1) foreach (glob("$dir/*.jpg") ?: [] as $old) if (filemtime($old) < time() - SV_IMG_TTL) @unlink($old);
    } else $img = file_get_contents($file);
    header('Content-Type: image/jpeg');
    header('Cache-Control: private, max-age=86400');
    echo $img;
    exit;
}

if (isset($_GET['meta'])) {
    [$lat, $lon] = coords();
    $la = round($lat, 4); $lo = round($lon, 4);   // ~10 m cells
    $res = cached(sprintf('sv:%.4f:%.4f', $la, $lo), SV_META_TTL, function () use ($la, $lo, $key) {
        rate_limit(SV_RATE_PER_MIN, 'streetview');   // only calls that reach Google count
        // sent without a Referer: Google refuses this key's server call when one is present (tested 2026-10-02), while
        // the browser's Embed iframe is checked against the glett.no referrer as intended
        $ch = curl_init('https://maps.googleapis.com/maps/api/streetview/metadata?' . http_build_query([
            'location' => sprintf('%.4f,%.4f', $la, $lo), 'radius' => SV_RADIUS, 'source' => 'outdoor', 'key' => $key]));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 8, CURLOPT_USERAGENT => user_agent(),
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $body = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
        $j = $status === 200 && $body ? json_decode($body, true) : null;
        if (!is_array($j)) { error_log('Glett streetview: HTTP ' . $status); return null; }
        $st = (string)($j['status'] ?? '');
        if ($st === 'ZERO_RESULTS' || $st === 'NOT_FOUND') return ['ok' => false, 'reason' => 'none'];   // no panorama nearby: worth caching
        if ($st !== 'OK') { error_log('Glett streetview: ' . $st); return null; }                         // key or quota trouble: never cached
        $plat = (float)($j['location']['lat'] ?? $la); $plon = (float)($j['location']['lng'] ?? $lo);
        $m = (int)round(6371000 * 2 * asin(sqrt(sin(deg2rad($plat - $la) / 2) ** 2 + cos(deg2rad($la)) * cos(deg2rad($plat)) * sin(deg2rad($plon - $lo) / 2) ** 2)));
        return ['ok' => true, 'pano' => (string)($j['pano_id'] ?? ''), 'lat' => $plat, 'lon' => $plon, 'date' => (string)($j['date'] ?? ''), 'm' => $m];
    });
    if ($res === null) json_out(['error' => 'Google did not answer', 'unavailable' => true], 502);
    header('Cache-Control: private, max-age=86400');
    json_out($res);
}
json_out(['error' => 'Unknown request'], 400);
