<?php
// MET Norway weather warnings (MetAlerts 2.0) with their real polygons, for the local map. MET asks that the GeoJSON feed
// is not pulled at high volume, so the server fetches it once per 10 minutes for the whole site (per language), keeps only
// the fields the map needs and caches the result in MySQL. Norway only (MET issues no warnings elsewhere).
declare(strict_types=1);
require __DIR__ . '/db.php';

const ALERTS_TTL = 600;

rate_limit();
housekeeping();
$lang = (($_GET['lang'] ?? 'nb') === 'en') ? 'en' : 'nb';

$res = cached("alerts:$lang", ALERTS_TTL, function () use ($lang) {
    [$status, $body] = http_get_status('https://api.met.no/weatherapi/metalerts/2.0/current.json' . ($lang === 'en' ? '?lang=en' : ''), 12);
    if ($status !== 200 || !$body) { error_log('Glett alerts: HTTP ' . $status); return null; }
    $j = json_decode($body, true);
    if (!is_array($j) || !isset($j['features'])) return null;
    $part = fn($s, $i) => strtolower(trim(explode(';', (string)$s)[$i] ?? ''));   // "2; yellow; Moderate" -> yellow, "1; Wind" -> wind
    $out = [];
    foreach ($j['features'] as $f) {
        $p = $f['properties'] ?? []; $g = $f['geometry'] ?? null;
        if (!$g || ($p['status'] ?? 'Actual') !== 'Actual') continue;
        $when = $f['when']['interval'] ?? [null, null];
        $out[] = [
            'id' => (string)($p['id'] ?? ''), 'event' => (string)($p['event'] ?? ''), 'name' => (string)($p['eventAwarenessName'] ?? $p['event'] ?? ''),
            'level' => $part($p['awareness_level'] ?? '', 1), 'type' => $part($p['awareness_type'] ?? '', 1), 'severity' => (string)($p['severity'] ?? ''),
            'area' => (string)($p['area'] ?? ''), 'domain' => (string)($p['geographicDomain'] ?? 'land'),
            'desc' => (string)($p['description'] ?? ''), 'instr' => (string)($p['instruction'] ?? ''), 'cons' => (string)($p['consequences'] ?? ''),
            'trigger' => (string)($p['triggerLevel'] ?? ''), 'from' => $when[0] ?? null, 'to' => $when[1] ?? null, 'web' => (string)($p['web'] ?? ''),
            'geometry' => $g,
        ];
    }
    return ['updated' => $j['lastChange'] ?? null, 'alerts' => $out];
});
if ($res === null) json_out(['error' => 'MET alerts did not answer', 'unavailable' => true], 502);
json_out($res);
