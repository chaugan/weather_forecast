<?php
// Kjørevær: Google Street View for a spot on the route. The key stays on the server (the repository is public):
//   GET api/streetview.php?status=1                          -> {ok: true|false}  (is a key configured)
//   GET api/streetview.php?meta=1&lat=&lon=                  -> {ok, pano, lat, lon, date, m}  Street View metadata within
//        50 m (free of charge, no quota), cached for 30 days per ~10 m cell; ok:false when there is no panorama nearby
//   GET api/streetview.php?embed=1&pano=|lat=&lon=&heading=&pitch=&fov=
//                                                            -> 302 to the Maps Embed API Street View iframe URL (free,
//        unlimited). The browser loads that URL in an iframe, so Google sees glett.no as the referrer the key is locked to.
// The key: 'google_maps_key' in the server config (WEFO_GOOGLE_MAPS_KEY), restricted in Google Cloud to the glett.no
// referrers and to the Maps Embed API and the Street View Static API (only its free metadata is used).
declare(strict_types=1);
require __DIR__ . '/db.php';

const SV_RADIUS = 50;              // metres around the clicked spot
const SV_META_TTL = 30 * 86400;    // panoramas rarely move
const SV_RATE_PER_MIN = 30;        // per client, metadata calls only

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
