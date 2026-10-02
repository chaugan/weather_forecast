<?php
// Kjørevær: live road information from Statens vegvesen's DATEX service (Basic auth, so the browser cannot ask directly;
// the credentials never leave the server). Both answers are compact JSON parsed from DATEX 3 XML and cached:
//   GET api/datex.php?cams=1  -> {cams: [{id, n, la, lo, r, c: [{id, d, f?, ts}]}]}   webcams grouped by site (a site can
//        have cameras looking in two or more directions; d = the place the camera looks towards, f = out of order, ts = the
//        camera's last status). From the status publication (the site table plus each camera's state), cached 10 minutes.
//        The images are public: https://kamera.atlas.vegvesen.no/api/images/{id}, refreshed about every minute.
//   GET api/datex.php?sit=1   -> {at, items: [{id, k, t, more, loc, r, one, det, from, to, per, p}]}   situations that
//        matter for a drive: k = closed (road closed), short (short closures), convoy (kolonnekjøring), hazard (obstruction,
//        slippery road, chains), works (roadworks with fewer or narrower lanes, traffic lights or manual direction). p = points [lat, lon] along the affected stretch; per = recurring periods
//        [{d: [1..7], s: 'HH:MM', e: 'HH:MM'}] in Oslo time. Cached for 5 minutes (the snapshot is ~28 MB).
//   GET api/datex.php?road=1  -> {at, t0, pts: [{id, n, r, la, lo, c: [...], s: [...]}]}   Statens vegvesen's road-surface
//        forecast for ~400 points on the road network: hour k (t0 + k hours, ~25 hours ahead) has the road condition c[k]
//        (dry, moist, wet, slippery, slushOnRoad, icy, snow…, as DATEX names it) and the road surface temperature s[k] (°C).
//        Cached 15 minutes; the points' names and places for a day.
// Licence: NLOD, Statens vegvesen.
declare(strict_types=1);
require __DIR__ . '/db.php';

const DATEX_BASE = 'https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/';
const DATEX_SIT_TTL = 300;
const DATEX_CAM_TTL = 600;
const DATEX_ROAD_TTL = 900;

rate_limit();
housekeeping();
$cfg = app_config();
$user = (string)($cfg['vegvesen_datex_user'] ?? '');
$pass = (string)($cfg['vegvesen_datex_pass'] ?? '');
if ($user === '' || $pass === '') json_out(['error' => 'DATEX is not configured', 'unavailable' => true], 503);

/* The snapshot, written to a temporary file (no need to hold 28 MB in memory). Returns the path or null. */
function datex_pull(string $what, string $user, string $pass): ?string
{
    $dir = dirname(__DIR__, 2) . '/glett-cache/datex';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $file = "$dir/$what." . bin2hex(random_bytes(4)) . '.xml';
    $fh = @fopen($file, 'wb');
    if (!$fh) return null;
    $ch = curl_init(DATEX_BASE . $what . '/pullsnapshotdata');
    curl_setopt_array($ch, [CURLOPT_FILE => $fh, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 60, CURLOPT_USERPWD => "$user:$pass",
        CURLOPT_ENCODING => '', CURLOPT_USERAGENT => user_agent(), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTPHEADER => ['Accept: */*']]);   // DATEX answers 406 to Accept: application/xml
    $ok = curl_exec($ch); $st = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch); fclose($fh);
    if (!$ok || $st !== 200 || filesize($file) < 1000) { error_log("Glett datex $what: HTTP $st"); @unlink($file); return null; }
    return $file;
}

/* Each <prefix:$tag ...>...</prefix:$tag> in a large file, read in pieces */
function datex_each(string $file, string $tag, callable $fn): void
{
    $fh = fopen($file, 'rb'); $buf = ''; $close = null;
    while (!feof($fh) || $buf !== '') {
        if (!feof($fh)) $buf .= fread($fh, 1 << 20);
        if ($close === null) { if (!preg_match("/<(\w+):$tag\b/", $buf, $m)) { if (feof($fh)) break; continue; } $close = "</{$m[1]}:$tag>"; $open = "<{$m[1]}:$tag"; }
        $done = false;
        while (($e = strpos($buf, $close)) !== false) {
            $head = substr($buf, 0, $e); $s = max((int)strrpos($head, "$open "), (int)strrpos($head, "$open>"));
            if (!str_starts_with(substr($buf, $s), $open)) $s = false;
            if ($s !== false) $fn(substr($buf, $s, $e + strlen($close) - $s));
            $buf = substr($buf, $e + strlen($close)); $done = true;
        }
        if (feof($fh)) break;
        if (!$done && strlen($buf) > 8 << 20) $buf = substr($buf, -(1 << 20));   // a runaway element: drop it
    }
    fclose($fh);
}

$tag = fn(string $x, string $name): array => preg_match_all("/<(?:\w+:)?$name\b[^>]*>([^<]*)</", $x, $m) ? array_map(fn($v) => html_entity_decode(trim($v), ENT_QUOTES | ENT_XML1, 'UTF-8'), $m[1]) : [];
$one = fn(string $x, string $name): string => $tag($x, $name)[0] ?? '';

/* EPSG:25833 (UTM 33, ETRS89) to [lat, lon]: Krüger series */
function utm33(float $e, float $n): array
{
    $a = 6378137.0; $f = 1 / 298.257222101; $k0 = 0.9996;
    $nn = $f / (2 - $f); $A = $a / (1 + $nn) * (1 + $nn ** 2 / 4 + $nn ** 4 / 64);
    $b = [$nn / 2 - 2 / 3 * $nn ** 2 + 37 / 96 * $nn ** 3, $nn ** 2 / 48 + $nn ** 3 / 15, 17 / 480 * $nn ** 3];
    $d = [2 * $nn - 2 / 3 * $nn ** 2 - 2 * $nn ** 3, 7 / 3 * $nn ** 2 - 8 / 5 * $nn ** 3, 56 / 15 * $nn ** 3];
    $xi = $n / ($k0 * $A); $eta = ($e - 500000) / ($k0 * $A); $xp = $xi; $ep = $eta;
    for ($j = 1; $j <= 3; $j++) { $xp -= $b[$j - 1] * sin(2 * $j * $xi) * cosh(2 * $j * $eta); $ep -= $b[$j - 1] * cos(2 * $j * $xi) * sinh(2 * $j * $eta); }
    $chi = asin(sin($xp) / cosh($ep)); $phi = $chi;
    for ($j = 1; $j <= 3; $j++) $phi += $d[$j - 1] * sin(2 * $j * $chi);
    return [round(rad2deg($phi), 5), round(15 + rad2deg(atan2(sinh($ep), cos($xp))), 5)];
}

if (isset($_GET['cams'])) {
    $res = cached('datex:cams2', DATEX_CAM_TTL, function () use ($user, $pass, $tag, $one) {
        $file = datex_pull('GetCCTVStatus', $user, $pass);
        if ($file === null) return null;
        $sites = []; $state = [];
        datex_each($file, 'cctvCameraStatus', function (string $x) use (&$state, $one) {
            if (preg_match('/<(?:\w+:)?cctvCameraReference[^>]*\bid="([^"]+)"/', $x, $m))
                $state[$m[1]] = ['f' => $one($x, 'cctvStillImageAvailability') !== 'videoOrImagesAvailable', 'ts' => strtotime($one($x, 'cctvCameraStatusTime')) ?: null];
        });
        datex_each($file, 'cctvCameraMetadataRecord', function (string $x) use (&$sites, &$state, $tag, $one) {
            $id = $one($x, 'cctvCameraIdentification'); $site = $one($x, 'cctvCameraSiteId') ?: $id;
            $la = (float)$one($x, 'latitude'); $lo = (float)$one($x, 'longitude');
            if (!preg_match('/^[\w-]{1,40}$/', $id) || !$la || !$lo) return;
            $url = $one($x, 'urlLinkAddress');
            if ($url !== '' && !str_starts_with($url, 'https://kamera.atlas.vegvesen.no/')) return;   // only images we know and allow
            $sites[$site] ??= ['id' => $site, 'n' => $one($x, 'value'), 'la' => round($la, 5), 'lo' => round($lo, 5), 'r' => $one($x, 'roadNumber'), 'c' => []];
            $cam = ['id' => $id, 'd' => $one($x, 'cctvCameraOrientationDescription'), 'ts' => $state[$id]['ts'] ?? null];
            if (!empty($state[$id]['f'])) $cam['f'] = 1;
            $sites[$site]['c'][] = $cam;
        });
        @unlink($file);
        foreach ($sites as &$s) usort($s['c'], fn($p, $q) => strnatcmp($p['id'], $q['id']));
        unset($s);
        return $sites ? ['cams' => array_values($sites)] : null;
    });
    if ($res === null) json_out(['error' => 'DATEX did not answer', 'unavailable' => true], 502);
    header('Cache-Control: public, max-age=300');
    json_out($res);
}

if (isset($_GET['sit'])) {
    $res = cached('datex:sit2', DATEX_SIT_TTL, function () use ($user, $pass, $tag, $one) {
        $file = datex_pull('GetSituation', $user, $pass);
        if ($file === null) return null;
        $items = [];
        $days = ['monday' => 1, 'tuesday' => 2, 'wednesday' => 3, 'thursday' => 4, 'friday' => 5, 'saturday' => 6, 'sunday' => 7];
        $rank = ['closed' => 5, 'short' => 4, 'convoy' => 3, 'hazard' => 2, 'works' => 1];
        datex_each($file, 'situation', function (string $sit) use (&$items, $tag, $one, $days, $rank) {
            preg_match('/<(\w+):situation id="([^"]+)"/', $sit, $m); $sid = $m[2] ?? '';
            $p = $m[1] ?? 'x';
            $recs = explode("<$p:situationRecord ", $sit); array_shift($recs);
            $best = null; $kind = ''; $detour = false; $texts = [];
            foreach ($recs as $r) {
                preg_match('/xsi:type="(?:\w+:)?(\w+)"/', $r, $tm); $type = $tm[1] ?? '';
                $mgmt = $one($r, 'roadOrCarriagewayOrLaneManagementType'); $gen = $one($r, 'generalNetworkManagementType');
                $txt = implode(' ', $tag($r, 'value'));
                $k = '';
                if (in_array($mgmt, ['roadClosed', 'closedPermanentlyForTheWinter'], true)) $k = 'closed';
                elseif ($mgmt === 'intermittentShortTermClosures') $k = 'short';
                elseif ($gen === 'convoyServiceInOperation' || preg_match('/kolonne/iu', $txt)) $k = 'convoy';
                elseif (in_array($type, ['EnvironmentalObstruction', 'GeneralObstruction', 'InfrastructureDamageObstruction', 'AnimalPresenceObstruction',
                    'VehicleObstruction', 'NonWeatherRelatedRoadConditions', 'WeatherRelatedRoadConditions', 'PoorEnvironmentConditions', 'WinterDrivingManagement', 'Accident'], true)) $k = 'hazard';
                // roadworks that change how you drive: fewer or narrower lanes, traffic lights, manual direction
                elseif (in_array($mgmt, ['laneClosures', 'narrowLanes', 'contraflow', 'lanesDeviated'], true) || in_array($gen, ['temporaryTrafficLights', 'trafficBeingManuallyDirected'], true)) $k = 'works';
                if ($type === 'ReroutingManagement' || preg_match('/omkjøring/iu', $txt)) $detour = true;
                if ($k !== '' && ($kind === '' || $rank[$k] > $rank[$kind])) { $kind = $k; $best = $r; }
            }
            if ($best === null) return;
            // the texts: the processed note ("Vegarbeid, vegen er stengt.|Omkjøring er skiltet.") and the free description
            foreach ($recs as $r) foreach (preg_split('/<(?:\w+:)?generalPublicComment>/', $r) as $i => $c) {
                if ($i === 0) continue;
                $v = trim(str_replace('|', ' ', $one($c, 'value'))); $ct = $one($c, 'commentType');
                if ($v !== '') $texts[$ct === 'description' ? 'more' : 't'][$v] = true;
            }
            $loc = $one($best, 'value') !== '' && preg_match('/<(?:\w+:)?locationDescription>.*?<value[^>]*>([^<]+)</s', $best, $lm) ? html_entity_decode($lm[1], ENT_QUOTES | ENT_XML1, 'UTF-8') : '';
            // where: the lines (UTM 33), else the display points; at most ~40 points per item
            $pts = [];
            if (preg_match_all('/<(?:\w+:)?posList>([^<]+)</', $best, $pl)) foreach ($pl[1] as $list) {
                $v = preg_split('/\s+/', trim($list)); $line = [];
                for ($i = 0; $i + 1 < count($v); $i += 2) $line[] = [(float)$v[$i], (float)$v[$i + 1]];
                $step = max(1, (int)ceil(count($line) / 40));
                foreach ($line as $i => $q) if ($i % $step === 0 || $i === count($line) - 1) $pts[] = utm33($q[0], $q[1]);
            }
            if (!$pts) { $la = $tag($best, 'latitude'); $lo = $tag($best, 'longitude'); foreach ($la as $i => $v) if (isset($lo[$i])) $pts[] = [round((float)$v, 5), round((float)$lo[$i], 5)]; }
            if (!$pts) return;
            // when: the overall window and any recurring periods (days of the week and times of day, Oslo time)
            $per = [];
            foreach (preg_split('/<(?:\w+:)?validPeriod>/', $best) as $i => $vp) {
                if ($i === 0) continue;
                $s = substr($one($vp, 'startTimeOfPeriod'), 0, 5); $e = substr($one($vp, 'endTimeOfPeriod'), 0, 5);
                $d = array_values(array_filter(array_map(fn($x) => $days[$x] ?? 0, $tag($vp, 'applicableDay'))));
                if ($s !== '' && $e !== '') $per[] = ['d' => $d ?: [1, 2, 3, 4, 5, 6, 7], 's' => $s, 'e' => $e];
            }
            $from = $one($best, 'overallStartTime'); $to = $one($best, 'overallEndTime');
            $roads = array_values(array_unique(array_filter($tag($best, 'roadNumber'))));
            $items[] = ['id' => $sid, 'k' => $kind, 't' => implode(' ', array_keys($texts['t'] ?? [])), 'more' => implode(' ', array_keys($texts['more'] ?? [])),
                'loc' => $loc, 'r' => $roads[0] ?? '', 'one' => (bool)preg_match('/\bi retning\b/u', $loc), 'det' => $detour,
                'from' => $from !== '' ? strtotime($from) : null, 'to' => $to !== '' ? strtotime($to) : null, 'per' => $per, 'p' => $pts];
        });
        @unlink($file);
        return ['at' => time(), 'items' => $items];
    });
    if ($res === null) json_out(['error' => 'DATEX did not answer', 'unavailable' => true], 502);
    header('Cache-Control: public, max-age=120');
    json_out($res);
}
if (isset($_GET['road'])) {
    $res = cached('datex:road', DATEX_ROAD_TTL, function () use ($user, $pass, $tag, $one) {
        $locs = cached('datex:roadloc', 86400, function () use ($user, $pass, $one) {
            $file = datex_pull('GetForecastPointLocations', $user, $pass);
            if ($file === null) return null;
            $out = [];
            datex_each($file, 'predefinedLocationReference', function (string $x) use (&$out, $one) {
                if (!preg_match('/\bid="([^"]+)"/', $x, $m)) return;
                $la = (float)$one($x, 'latitude'); $lo = (float)$one($x, 'longitude');
                if ($la && $lo) $out[$m[1]] = ['n' => $one($x, 'value'), 'r' => $one($x, 'roadNumber'), 'la' => round($la, 5), 'lo' => round($lo, 5)];
            });
            @unlink($file);
            return $out ?: null;
        });
        if (!$locs) return null;
        $file = datex_pull('GetForecastPointData', $user, $pass);
        if ($file === null) return null;
        $rows = []; $t0 = null;
        datex_each($file, 'physicalQuantity', function (string $x) use (&$rows, &$t0, $locs, $one) {
            if (!preg_match('/predefinedLocationReference[^>]*\bid="([^"]+)"/', $x, $m) || !isset($locs[$m[1]])) return;
            $steps = [];
            foreach (preg_split('/<(?:\w+:)?basicData\b/', $x) as $i => $bd) {
                if ($i === 0) continue;
                $tm = strtotime($one($bd, 'timeValue')); if (!$tm) continue;
                $surf = preg_match('/<(?:\w+:)?roadSurfaceTemperature>\s*<(?:\w+:)?temperature>([^<]+)</', $bd, $q) ? round((float)$q[1], 1) : null;
                $steps[$tm] = [$one($bd, 'weatherRelatedRoadConditionType'), $surf];
                $t0 = $t0 === null ? $tm : min($t0, $tm);
            }
            if ($steps) $rows[] = ['id' => $m[1]] + $locs[$m[1]] + ['steps' => $steps];
        });
        @unlink($file);
        if (!$rows || $t0 === null) return null;
        // hourly arrays from the earliest hour (a missing hour is null)
        foreach ($rows as &$r) {
            $n = (int)((max(array_keys($r['steps'])) - $t0) / 3600) + 1; $r['c'] = array_fill(0, $n, null); $r['s'] = array_fill(0, $n, null);
            foreach ($r['steps'] as $tm => [$c, $sv]) { $k = (int)round(($tm - $t0) / 3600); $r['c'][$k] = $c !== '' ? $c : null; $r['s'][$k] = $sv; }
            unset($r['steps']);
        }
        unset($r);
        return ['at' => time(), 't0' => $t0, 'pts' => $rows];
    });
    if ($res === null) json_out(['error' => 'DATEX did not answer', 'unavailable' => true], 502);
    header('Cache-Control: public, max-age=300');
    json_out($res);
}
json_out(['error' => 'Unknown request'], 400);
