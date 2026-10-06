<?php
// Rest areas abroad for Kjørevær, in the same row format as data/rest/rest.json (Norway, NVDB), fetched only for a route
// that goes through the country. Each country's whole set is fetched once a day and kept (a stale copy is served for up
// to 30 days when the source is down); the browser matches it to the route itself.
//   GET api/rest.php?c=se   Sweden: Trafikverket's open API, object type Parking 1.4 (CC0). Needs a free key, kept here:
//                           'trafikverket_key' in the config file outside the web root.
//   GET api/rest.php?c=fi   Finland: Väylävirasto's open API, Tievelho palvelualueet (CC BY 4.0), no key. Rest areas,
//                           private service areas and parking areas with more than the minimum equipment; no commuter car parks.
// Row: [id, name, lat, lon, road, main, cars, trucks, disabled, charging, water, shower, power, oneway, winter, from, to,
//       toilet, tables, roofed, benches, bins, play, country, extra[]]; extra holds what Norway's rows have no column for:
//       'picnic', 'dump' (emptying for caravans), 'light', 'food:cafe|kiosk|restaurant|hotel', 'kit:basic|extra|service'.
declare(strict_types=1);
require __DIR__ . '/db.php';

const REST_TTL = 86400, REST_STALE = 30 * 86400;

rate_limit();
$c = (string)($_GET['c'] ?? '');
if (!in_array($c, ['se', 'fi'], true)) json_out(['error' => 'Bad request'], 400);

function rest_file(string $c): ?string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/rest';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return is_dir($d) && is_writable($d) ? "$d/$c.json" : null;
}
function rest_post(string $url, string $body, array $headers): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 20, CURLOPT_ENCODING => '', CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $b = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    return [$b === false ? 0 : $code, $b === false ? '' : (string)$b];
}
function rest_id($v): string { return substr(preg_replace('~[^A-Za-z0-9_.-]~', '', (string)$v), 0, 80); }   // ids from other agencies: plain characters only
$wkt = fn($s) => preg_match('~POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)~', (string)$s, $m) ? [(float)$m[2], (float)$m[1]] : null;   // lat, lon

/* Sweden: every rest area in one request (about 320) */
function rest_se(callable $wkt): ?array
{
    $key = (string)(app_config()['trafikverket_key'] ?? '');
    if ($key === '') { error_log('Glett rest: no trafikverket_key'); return null; }
    $q = '<REQUEST><LOGIN authenticationkey="' . htmlspecialchars($key, ENT_QUOTES) . '"/><QUERY objecttype="Parking" schemaversion="1.4" limit="5000"><FILTER><EQ name="Deleted" value="false"/></FILTER></QUERY></REQUEST>';
    [$code, $body] = rest_post('https://api.trafikinfo.trafikverket.se/v2/data.json', $q, ['Content-Type: text/xml']);
    $items = json_decode($body, true)['RESPONSE']['RESULT'][0]['Parking'] ?? null;
    if ($code !== 200 || !is_array($items)) { error_log("Glett rest: Trafikverket HTTP $code"); return null; }
    $pts = [];
    foreach ($items as $it) {
        if (!in_array('restArea', $it['UsageSenario'] ?? [], true) || ($it['OpenStatus'] ?? 'open') === 'closed') continue;
        $p = $wkt($it['Geometry']['WGS84'] ?? ''); if (!$p) continue;
        $eq = []; $wcAcc = null;
        foreach ($it['Equipment'] ?? [] as $e) { $eq[$e['Type'] ?? ''] = true; if (($e['Type'] ?? '') === 'toilet') $wcAcc = ($e['Accessibility'] ?? '') === 'handicappedAccessible' ? 1 : null; }
        $sp = []; foreach ($it['VehicleCharacteristics'] ?? [] as $v) $sp[$v['VehicleType'] ?? ''] = ($sp[$v['VehicleType'] ?? ''] ?? 0) + (int)($v['NumberOfSpaces'] ?? 0);
        $extra = []; if (isset($eq['picnicFacilities'])) $extra[] = 'picnic'; if (isset($eq['dumpingStation'])) $extra[] = 'dump';
        $pts[] = ['se:' . rest_id($it['Id'] ?? count($pts)), (string)($it['Name'] ?? ''), round($p[0], 5), round($p[1], 5), null, 0,
            $sp['car'] ?? null, ($sp['lorry'] ?? 0) ?: null, null, null, null, null, null, null, null, null, null,
            isset($eq['toilet']) ? [0, null, $wcAcc, null, null, null] : null, null, null, null, isset($eq['refuseBin']) ? 1 : null, isset($eq['playground']) ? 1 : null, 'se', $extra];
    }
    return $pts;
}

/* Finland: the whole service-area layer (about 3 200, 6.5 MB), the useful ones kept */
function rest_fi(): ?array
{
    $ch = curl_init('https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections/tiestotiedot:palvelualueet/items?f=json&limit=10000');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 20, CURLOPT_ENCODING => '', CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $body = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    $f = $code === 200 ? (json_decode((string)$body, true)['features'] ?? null) : null;
    if (!is_array($f)) { error_log("Glett rest: Väylä HTTP $code"); return null; }
    $food = ['Kahvila' => 'cafe', 'Kioski' => 'kiosk', 'Ravintola' => 'restaurant', 'Majoitus- ja ravintolapalvelut' => 'hotel'];
    $kit = ['Perusvarustelu' => 'basic', 'Lisävarustelu' => 'extra', 'Palvelualuevarustelu' => 'service'];
    $winter = ['Hoidetaan talvisin' => 'cleared', 'Ei talvikunnossapitoa' => 'closed'];
    $pts = [];
    foreach ($f as $x) {
        $p = $x['properties'] ?? []; $g = $x['geometry']['coordinates'] ?? null;
        if (!$g || !empty($p['loppu']) || !empty($p['toiminnalliset_ominaisuudet_liityntapysakointi'])) continue;
        $type = $p['tyyppi'] ?? ''; $kv = $p['rakenteelliset_ominaisuudet_varustelu'] ?? '';
        if (!($type === 'Levähdysalue' || $type === 'Yksityinen palvelualue' || ($type === 'Pysäköimisalue' && isset($kit[$kv])))) continue;
        $road = (int)($p['sijainti_tie'] ?? 0);
        $ref = $road <= 0 ? null : ($road < 40 ? "Vt $road" : ($road < 100 ? "Kt $road" : ($road < 1000 ? "St $road" : "Yt $road")));   // valtatie, kantatie, seututie, yhdystie
        $extra = [];
        if (isset($kit[$kv])) $extra[] = 'kit:' . $kit[$kv];
        if (isset($food[$p['toiminnalliset_ominaisuudet_yritys'] ?? ''])) $extra[] = 'food:' . $food[$p['toiminnalliset_ominaisuudet_yritys']];
        if (($p['rakenteelliset_ominaisuudet_valaistus'] ?? null) === true) $extra[] = 'light';
        $n = $p['rakenteelliset_ominaisuudet_ajoneuvo_paikkojen_lkm'] ?? null;
        $pts[] = ['fi:' . rest_id($p['oid'] ?? count($pts)), trim((string)($p['rakenteelliset_ominaisuudet_nimi'] ?? '')), round((float)$g[1], 5), round((float)$g[0], 5), $ref,
            $kv === 'Palvelualuevarustelu' || $type === 'Yksityinen palvelualue' ? 1 : 0, is_int($n) ? $n : null, null, null, null, null, null,
            ($p['rakenteelliset_ominaisuudet_sahkoliittyma'] ?? null) === true ? 1 : null, null, $winter[$p['talvikunnossapito'] ?? ''] ?? null, null, null,
            null, null, null, null, null, null, 'fi', $extra];
    }
    return $pts;
}

$file = rest_file($c);
$have = $file && is_file($file) ? json_decode((string)@file_get_contents($file), true) : null;
$fresh = is_array($have) && ($have['at'] ?? 0) > time() - REST_TTL;
if (!$fresh) {
    $lock = 'glett:rest:' . $c;
    $got = (int)(q('SELECT GET_LOCK(?, 10) l', [$lock])->fetch()['l'] ?? 0);
    try {
        $have2 = $file && is_file($file) ? json_decode((string)@file_get_contents($file), true) : null;   // another request may have just fetched it
        if (is_array($have2) && ($have2['at'] ?? 0) > time() - REST_TTL) $have = $have2;
        elseif ($got === 1) {
            $pts = $c === 'se' ? rest_se($wkt) : rest_fi();
            // a fetch that lost more than a fifth of what we had is not trusted over the copy we have
            if ($pts !== null && count($pts) >= 0.8 * count($have['pts'] ?? [])) {
                $have = ['v' => 1, 'c' => $c, 'at' => time(), 'source' => $c === 'se' ? 'Trafikverket (CC0)' : 'Väylävirasto, Avoin API (CC BY 4.0)', 'pts' => $pts];
                if ($file) { $tmp = $file . '.' . getmypid(); if (@file_put_contents($tmp, json_encode($have, JSON_UNESCAPED_UNICODE)) !== false) @rename($tmp, $file); }
            }
        }
    } finally { if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]); }
}
if (!is_array($have) || ($have['at'] ?? 0) < time() - REST_STALE) json_out(['error' => 'Rest areas not available', 'unavailable' => true], 503);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=21600');
unset($have['at']);
echo json_encode($have, JSON_UNESCAPED_UNICODE);
