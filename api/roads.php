<?php
// Kjørevær abroad: road reports, webcams and road conditions in Sweden and Finland, in the shapes api/datex.php gives for
// Norway, so the page matches them to a route the same way. Asked only for a route that goes through the country.
//   GET api/roads.php?c=se|fi&what=sit    road reports: {at, items: [{id, k, t, more, loc, r, one, det, rw, from, to, per, p,
//        cc, tz, pl, dp?, win?, fx?}]}. As datex.php, plus: cc = country, tz = the time zone of per, pl = a short place name,
//        dp = the place a one-way report names as its direction, win = dated windows [[from, to, 'HH:MM'?, 'HH:MM'?]] (in
//        force inside one, at those times of day when given), fx = what the report says as codes (Finland: its texts are
//        Finnish only, so the page writes them in its own language).
//   GET api/roads.php?c=se|fi&what=cams   webcams: {cams: [{id, n, la, lo, r, cc, c: [{id, u, ub?, d?, deg?, sfc?, f?, ts}]}]};
//        u = the image (always the latest at that address), ub = a larger one, deg = the way it looks (degrees), sfc = it
//        looks at the road surface.
//   GET api/roads.php?c=se|fi&what=road   road conditions: {at, pts: [{n, r, la, lo, t0, seen?, h: [hours after t0], c: [...], s: [...]}]}
//        c as DATEX names road conditions (dry, moist, wet, slush, snow, icy), s the road surface temperature (°C).
//        Finland: Fintraffic's road-weather forecast per road section (now, +2, +4, +6, +12 h). Sweden: Trafikverket's
//        reported road condition (väglag) along its stretches, with the road temperature at the nearest weather station;
//        what it is now, used for the next three hours; seen = when that state was set (StartTime, up to 36 h back).
// Sweden: Trafikverket's open API (CC0), the free key in the config outside the web root ('trafikverket_key').
// Finland: Fintraffic Digitraffic (CC BY 4.0), no key.
declare(strict_types=1);
require __DIR__ . '/db.php';

const ROADS_TTL = ['sit' => 300, 'cams' => 600, 'road' => 900];

rate_limit();
$c = (string)($_GET['c'] ?? ''); $what = (string)($_GET['what'] ?? '');
if (!in_array($c, ['se', 'fi'], true) || !isset(ROADS_TTL[$what])) json_out(['error' => 'Bad request'], 400);

function roads_curl(string $url, ?string $post, array $headers, int $timeout = 40): ?string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => $timeout, CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => user_agent(), CURLOPT_HTTPHEADER => $headers, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    if ($post !== null) curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $post]);
    $b = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    if ($b === false || $code !== 200) { error_log('Glett roads: HTTP ' . $code . ' from ' . parse_url($url, PHP_URL_HOST)); return null; }
    return (string)$b;
}
/* Trafikverket: one query (objecttype, schema, namespace, the fields wanted), the list of objects or null */
function tv_query(string $type, string $schema, string $ns, array $fields, string $filter = '<EQ name="Deleted" value="false"/>'): ?array
{
    $key = (string)(app_config()['trafikverket_key'] ?? '');
    if ($key === '') { error_log('Glett roads: no trafikverket_key'); return null; }
    $inc = implode('', array_map(fn($f) => "<INCLUDE>$f</INCLUDE>", $fields));
    $q = '<REQUEST><LOGIN authenticationkey="' . htmlspecialchars($key, ENT_QUOTES) . '"/><QUERY objecttype="' . $type . '" schemaversion="' . $schema . '"'
        . ($ns !== '' ? ' namespace="' . $ns . '"' : '') . ' limit="20000"><FILTER>' . $filter . '</FILTER>' . $inc . '</QUERY></REQUEST>';
    $b = roads_curl('https://api.trafikinfo.trafikverket.se/v2/data.json', $q, ['Content-Type: text/xml']);
    $r = $b === null ? null : (json_decode($b, true)['RESPONSE']['RESULT'][0][$type] ?? null);
    return is_array($r) ? $r : null;
}
function dt_get(string $path): ?array
{
    $b = roads_curl('https://tie.digitraffic.fi' . $path, null, ['Digitraffic-User: Glett/glett.no', 'Accept: application/json']);
    $j = $b === null ? null : json_decode($b, true);
    return is_array($j) ? $j : null;
}
function rid($v): string { return substr(preg_replace('~[^A-Za-z0-9_.:-]~', '', (string)$v), 0, 80); }   // ids from other agencies: plain characters only
function clean(string $s, int $max = 600): string { $s = trim(preg_replace('/\s+/u', ' ', $s)); return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s; }
/* every [lat, lon] in a WKT string (WGS84 "lon lat"), or in GeoJSON coordinates */
function wkt_pts(string $w): array { preg_match_all('/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/', $w, $m); $o = []; foreach ($m[1] as $i => $lo) $o[] = [(float)$m[2][$i], (float)$lo]; return $o; }
function geo_pts($g): array
{
    $o = []; $walk = function ($a) use (&$walk, &$o) { if (is_array($a) && isset($a[0]) && is_numeric($a[0]) && isset($a[1])) $o[] = [(float)$a[1], (float)$a[0]]; elseif (is_array($a)) foreach ($a as $x) $walk($x); };
    $walk($g['coordinates'] ?? null); return $o;
}
function thin(array $pts, int $max = 40): array   // at most ~$max points, the ends kept, rounded
{
    $n = count($pts); $step = max(1, (int)ceil($n / $max)); $o = [];
    foreach ($pts as $i => $p) if ($i % $step === 0 || $i === $n - 1) $o[] = [round($p[0], 5), round($p[1], 5)];
    return $o;
}
const RANK = ['closed' => 6, 'short' => 5, 'convoy' => 4, 'hazard' => 3, 'works' => 2, 'limit' => 1];

/* ---------------- Sweden: road reports ---------------- */
function se_sit(): ?array
{
    $D = 'Deviation.';
    $rows = tv_query('Situation', '1.6', 'road.trafficinfo', array_merge(['Id'], array_map(fn($f) => $D . $f, ['Id', 'MessageCodeValue', 'MessageTypeValue', 'Message',
        'LocationDescriptor', 'RoadNumber', 'RoadName', 'AffectedDirectionValue', 'StartTime', 'EndTime', 'Suspended', 'Schedule', 'TemporaryLimit',
        'PositionalDescription', 'Geometry.Line.WGS84', 'Geometry.Point.WGS84'])));
    if ($rows === null) return null;
    $now = time(); $items = [];
    $hazard = ['Accident', 'GeneralObstruction', 'AnimalPresenceObstruction', 'EnvironmentalObstruction', 'NonWeatherRelatedRoadConditions',
        'WeatherRelatedRoadConditions', 'VehicleObstruction', 'InfrastructureDamageObstruction', 'AbnormalTraffic', 'PoorEnvironmentConditions'];
    foreach ($rows as $s) {
        $best = null; $kind = ''; $det = false; $rw = false; $texts = []; $more = []; $geo = null;
        foreach ($s['Deviation'] ?? [] as $d) {
            if (!empty($d['Suspended'])) continue;   // "anger om objektet är inaktivt": not in force now
            $end = !empty($d['EndTime']) ? strtotime($d['EndTime']) : null; if ($end && $end < $now) continue;
            $code = $d['MessageCodeValue'] ?? ''; $type = $d['MessageTypeValue'] ?? ''; $msg = clean((string)($d['Message'] ?? '')); $lim = clean((string)($d['TemporaryLimit'] ?? ''));
            if ($type === 'ReroutingManagement' || preg_match('/omledning|omleds/iu', $msg)) $det = true;
            if (in_array($type, ['MaintenanceWorks', 'ConstructionWorks'], true)) $rw = true;
            if ($msg !== '') $texts[$msg] = true;
            if ($lim !== '') $more[$lim] = true;
            $k = '';
            // closed only to some vehicles (wider, heavier, longer than …): not a closure for a car
            if ($code === 'roadClosed') $k = preg_match('/fordonsbredd|bruttovikt|fordon över|fordonshöjd|fordonslängd|\d\s*ton\b/iu', "$lim $msg") ? 'limit' : 'closed';
            elseif ($code === 'blastingWork') $k = 'short';
            elseif (preg_match('/kolonn/iu', $msg)) $k = 'convoy';
            elseif (in_array($type, $hazard, true)) $k = 'hazard';
            // roadworks that change how you drive: lanes closed, traffic lights, a pilot car or a flagman
            elseif ($code === 'laneClosures' || ($rw && preg_match('/\b(signal|lots|vakt|bom|enkelriktad|avsmalnad|ett körfält)/iu', $msg))) $k = 'works';
            $g = $d['Geometry'] ?? [];
            $pts = wkt_pts((string)($g['Line']['WGS84'] ?? '')) ?: wkt_pts((string)($g['Point']['WGS84'] ?? ''));
            if ($pts && !$geo) $geo = $pts;
            if ($k !== '' && ($kind === '' || RANK[$k] > RANK[$kind])) { $kind = $k; $best = $d + ['_p' => $pts]; }
        }
        if ($best === null) continue;
        $pts = $best['_p'] ?: $geo; if (!$pts) continue;
        $loc = clean((string)($best['LocationDescriptor'] ?? ''), 200);
        // "E22 från Trafikplats Berga till Cirkulationsplats Karlsro i riktning mot Karlskrona i Kalmar län (H)"
        $short = fn($x) => trim(preg_replace('/^(Trafikplats|Tpl|Cirkulationsplats|Cpl|Korsning|Länsgr\.?|Trafikljus)\s+|\s*\(\d+\)$/u', '', trim($x)));
        $pl = preg_match('/\bfrån (.+?) till (.+?)(?: i riktning| båda| v båda| i [\p{L} ]+ (?:län|kommun)|,|$)/u', $loc, $m) ? $short($m[1]) . '–' . $short($m[2])
            : (preg_match('/\b(?:vid|mellan) (.+?)(?: i riktning| båda|,| i [\p{L} ]+ (?:län|kommun)|$)/u', $loc, $m) ? $short($m[1])
            : ((string)($best['RoadName'] ?? '') ?: trim(preg_replace('/,? i (?:båda riktningar|riktning|[\p{L} ]+ (?:län|kommun)).*$/u', '', $loc))));
        $dp = preg_match('/i riktning mot (.+?)(?:\s+i\s+[\p{L} ]+?\s(?:län|kommun)\b.*)?$/u', $loc, $m) ? trim($m[1]) : '';
        $win = []; $sched = !empty($best['Schedule']);
        foreach ($best['Schedule'] ?? [] as $sc) {
            $a = strtotime((string)($sc['StartOfPeriod'] ?? '')); $b = strtotime((string)($sc['EndOfPeriod'] ?? '')); if (!$a || !$b || $b < $now) continue;
            $rec = $sc['RecurringTimePeriodOfDay'] ?? [];
            if (!$rec) $win[] = [$a, $b]; else foreach ($rec as $r) $win[] = [$a, $b, substr((string)($r['Start'] ?? '00:00'), 0, 5), substr((string)($r['End'] ?? '23:59'), 0, 5)];
        }
        if ($sched && !$win) continue;   // a schedule with every window passed: over
        $road = (string)($best['RoadNumber'] ?? '');
        $r = preg_match('/^E\s?(\d+)/', $road, $m) ? 'E' . $m[1] : (preg_match('/^Väg (\d+)/u', $road, $m) ? $m[1] : '');
        $item = ['id' => 'se:' . rid($s['Id'] ?? ''), 'k' => $kind, 't' => implode(' ', array_keys($texts)), 'more' => implode(' ', array_keys($more)),
            'loc' => $loc, 'r' => $r, 'one' => ($best['AffectedDirectionValue'] ?? '') === 'OneDirection', 'det' => $det, 'rw' => $rw,
            'from' => !empty($best['StartTime']) ? strtotime($best['StartTime']) : null, 'to' => !empty($best['EndTime']) ? strtotime($best['EndTime']) : null,
            'per' => [], 'p' => thin($pts), 'cc' => 'se', 'tz' => 'Europe/Stockholm', 'pl' => $pl !== '' ? $pl : $loc];
        if ($dp !== '') $item['dp'] = $dp;
        if ($win) $item['win'] = array_slice($win, 0, 60);
        // a closed ramp or connection lies beside the main road: the page counts it only when the route drives along all of it
        if (preg_match('/påfart|avfart|anslutning|\bramp/iu', $loc . ' ' . $item['t'])) $item['ramp'] = true;
        $items[] = $item;
    }
    return ['at' => $now, 'items' => $items];
}

/* ---------------- Finland: road reports ---------------- */
// what a report says, as codes the page puts in words: the roadwork restrictions (English codes) and the announcements'
// Finnish feature names
const FI_RESTRICT = ['ROAD_CLOSED' => 'closed', 'INTERMITTENT_SHORT_TERM_CLOSURE' => 'sclosed', 'INTERMITTENT_SHORT_TERM_STOPS' => 'stops',
    'INTERMITTENT_STOPS_AND_CLOSURE_EFFECTIVE' => 'stops', 'SINGLE_LANE_CLOSED' => 'lanes', 'MULTIPLE_LANES_CLOSED' => 'lanes', 'NARROW_LANES' => 'narrow',
    'TRAFFIC_LIGHTS' => 'lights', 'SINGLE_ALTERNATE_LINE_TRAFFIC' => 'alt', 'CONTRA_FLOW_TRAFFIC' => 'contra', 'SINGLE_CARRIAGEWAY_CLOSED' => 'onecw',
    'DETOUR' => 'detour', 'DETOUR_SIGNS' => 'detour', 'DETOUR_USING_ROADWAYS' => 'detour', 'ROAD_SURFACE_GRAVEL' => 'gravel', 'ROAD_SURFACE_MILLED' => 'milled',
    'SLOW_MOVING_MAINTENANCE_VEHICLE' => 'slow'];
const FI_FEATURE = ['Tie on suljettu liikenteeltä' => 'closed', 'Tie on ajoittain suljettu liikenteeltä' => 'sclosed', 'Liikenne pysäytetään ajoittain' => 'stops',
    'Liikenne on pysäytetty ajoittain' => 'stops', 'Ajokaista suljettu liikenteeltä' => 'lanes', 'Ajokaistoja suljettu liikenteeltä' => 'lanes',
    'Ajokaistoja on kavennettu' => 'narrow', 'Paikalla tilapäinen liikennevalo-ohjaus' => 'lights', 'Liikenne ohjataan vuorotellen tapahtumapaikan ohi' => 'alt',
    'Liikenne ohjataan kaksisuuntaisena toiselle ajoradalle' => 'contra', 'Toinen ajorata on suljettu liikenteeltä' => 'onecw',
    'Tapahtumapaikalla on käytössä kiertotie' => 'detour', 'Paikalla on kiertotieopastus' => 'detour', 'Kiertotien kuvaus' => 'detour',
    'Liikenne on jonoutunut' => 'queue', 'Liikenne saattaa ruuhkautua' => 'mayqueue', 'Raskaan ajoneuvon nostotyö' => 'lift'];
function fi_sit(): ?array
{
    $base = '/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=';
    $ta = dt_get($base . 'TRAFFIC_ANNOUNCEMENT'); $rw = dt_get($base . 'ROAD_WORK');
    if ($ta === null || $rw === null) return null;
    $now = time(); $items = []; $days = ['MONDAY' => 1, 'TUESDAY' => 2, 'WEDNESDAY' => 3, 'THURSDAY' => 4, 'FRIDAY' => 5, 'SATURDAY' => 6, 'SUNDAY' => 7];
    $dir1 = fn($x) => in_array($x['locationDetails']['roadAddressLocation']['direction'] ?? '', ['POS', 'NEG'], true);
    foreach (array_merge($ta['features'] ?? [], $rw['features'] ?? []) as $f) {
        $P = $f['properties'] ?? []; $a = null;
        foreach ($P['announcements'] ?? [] as $x) if (!$a || ($x['language'] ?? '') === 'EN') $a = $x;
        if (!$a) continue;
        $pts = geo_pts($f['geometry'] ?? []); if (!$pts) continue;
        // what applies when: each roadwork phase on its own (its restrictions, dates, working hours and direction);
        // an announcement as a whole, from its feature names
        $units = [];
        foreach ($a['roadWorkPhases'] ?? [] as $ph) {
            $s = strtotime((string)($ph['timeAndDuration']['startTime'] ?? '')) ?: null; $e = strtotime((string)($ph['timeAndDuration']['endTime'] ?? '')) ?: null;
            if ($e && $e < $now) continue;   // over: its restrictions no longer apply
            $fx = []; $speed = null; $delay = null;
            foreach ($ph['restrictions'] ?? [] as $r) {
                $t = (string)($r['type'] ?? ''); if (isset(FI_RESTRICT[$t])) $fx[FI_RESTRICT[$t]] = true;
                if ($t === 'SPEED_LIMIT' && !empty($r['restriction']['quantity'])) $speed = min($speed ?? 999, (int)$r['restriction']['quantity']);
                if ($t === 'ESTIMATED_DELAY' && !empty($r['restriction']['quantity'])) $delay = max($delay ?? 0, (int)$r['restriction']['quantity']);
            }
            // restrictions that are lifted outside working hours apply only then
            $per = [];
            if (!empty($ph['restrictionsLiftable'])) foreach ($ph['workingHours'] ?? [] as $w) $per[] = ['d' => [$days[$w['weekday'] ?? ''] ?? 0], 's' => substr((string)($w['startTime'] ?? ''), 0, 5), 'e' => substr((string)($w['endTime'] ?? ''), 0, 5)];
            $units[] = ['id' => (string)($ph['id'] ?? count($units)), 'fx' => $fx, 'speed' => $speed, 'delay' => $delay, 'from' => $s, 'to' => $e, 'per' => $per, 'one' => $dir1($ph), 'L' => $ph];
        }
        if (!($a['roadWorkPhases'] ?? [])) {
            $fx = []; $speed = null;
            foreach ($a['features'] ?? [] as $x) { $n = (string)($x['name'] ?? ''); if (isset(FI_FEATURE[$n])) $fx[FI_FEATURE[$n]] = true; if ($n === 'Nopeusrajoitus' && !empty($x['quantity'])) $speed = (int)$x['quantity']; }
            $e = strtotime((string)($a['timeAndDuration']['endTime'] ?? '')) ?: null;
            if (!$e || $e >= $now) $units[] = ['id' => '', 'fx' => $fx, 'speed' => $speed, 'delay' => null, 'from' => strtotime((string)($a['timeAndDuration']['startTime'] ?? '')) ?: null,
                'to' => $e, 'per' => [], 'one' => $dir1($a), 'L' => $a];
        }
        $acc = in_array($P['trafficAnnouncementType'] ?? '', ['ACCIDENT_REPORT', 'PRELIMINARY_ACCIDENT_REPORT'], true);
        foreach ($units as $u) {
            $fx = $u['fx']; if ($acc) $fx['accident'] = true;
            $kind = isset($fx['closed']) ? (isset($fx['stops']) || isset($fx['sclosed']) ? 'short' : 'closed') : (isset($fx['sclosed']) || isset($fx['stops']) ? 'short'
                : (array_intersect_key($fx, ['lanes' => 1, 'narrow' => 1, 'lights' => 1, 'alt' => 1, 'contra' => 1, 'onecw' => 1]) ? 'works' : ($acc ? 'hazard' : '')));
            if ($kind === '') continue;
            $codes = array_keys($fx); if ($u['speed']) $codes[] = 'speed:' . $u['speed']; if ($u['delay']) $codes[] = 'delay:' . $u['delay'];
            $L = $u['L']; $pp = $L['locationDetails']['roadAddressLocation']['primaryPoint'] ?? [];
            $road = (int)($pp['roadAddress']['road'] ?? 0);
            $desc = (string)($L['location']['description'] ?? $a['location']['description'] ?? '');
            $item = ['id' => 'fi:' . rid(($P['situationId'] ?? '') . ($u['id'] !== '' ? ':' . $u['id'] : '')), 'k' => $kind, 't' => clean((string)($a['title'] ?? '')), 'more' => clean(str_replace("\n", ' ', $desc)),
                'loc' => clean(strtok($desc, "\n") ?: '', 200), 'r' => $road >= 40 ? (string)$road : '',   // roads under 40 may carry an E number on the route
                'one' => $u['one'], 'det' => isset($fx['detour']), 'rw' => ($P['situationType'] ?? '') === 'ROAD_WORK', 'from' => $u['from'], 'to' => $u['to'],
                'per' => $u['per'], 'p' => thin($pts), 'cc' => 'fi', 'tz' => 'Europe/Helsinki',
                'pl' => clean((string)($pp['alertCLocation']['name'] ?? $pp['municipality'] ?? ''), 80), 'fx' => $codes];
            if (preg_match('/ramppi|liittymä/iu', $desc . ' ' . (string)($a['title'] ?? ''))) $item['ramp'] = true;
            $items[] = $item;
        }
    }
    return ['at' => $now, 'items' => $items];
}

/* ---------------- webcams ---------------- */
function se_cams(): ?array
{
    $rows = tv_query('Camera', '1.0', '', ['Id', 'Name', 'Active', 'Status', 'Direction', 'PhotoUrl', 'PhotoTime', 'HasFullSizePhoto', 'Geometry.WGS84', 'Type'],
        '<EQ name="Deleted" value="false"/>');
    if ($rows === null) return null;
    $out = [];
    foreach ($rows as $x) {
        $p = wkt_pts((string)($x['Geometry']['WGS84'] ?? ''))[0] ?? null; $u = (string)($x['PhotoUrl'] ?? '');
        if (!$p || !str_starts_with($u, 'https://api.trafikinfo.trafikverket.se/')) continue;   // only images we know and allow
        $cam = ['id' => 'se:' . rid($x['Id'] ?? ''), 'u' => $u, 'ts' => strtotime((string)($x['PhotoTime'] ?? '')) ?: null];
        if (!empty($x['HasFullSizePhoto'])) $cam['ub'] = $u . '?type=fullsize';
        if (isset($x['Direction'])) $cam['deg'] = (int)$x['Direction'];
        if (($x['Type'] ?? '') === 'Väglagskamera') $cam['sfc'] = 1;   // a road-condition camera: it looks at the road
        if (empty($x['Active']) || ($x['Status'] ?? '') !== 'videoOrImagesAvailable' || ($cam['ts'] && $cam['ts'] < time() - 3 * 3600)) $cam['f'] = 1;
        $out[] = ['id' => $cam['id'], 'n' => clean((string)($x['Name'] ?? ''), 80), 'la' => round($p[0], 5), 'lo' => round($p[1], 5), 'r' => '', 'cc' => 'se', 'c' => [$cam]];
    }
    return $out ? ['cams' => $out] : null;
}
function fi_cams(): ?array
{
    $j = dt_get('/api/weathercam/v1/stations'); if ($j === null) return null;
    $times = [];   // each view's last image; one older than three hours shows as out of order (the address then gives a placeholder)
    foreach ((dt_get('/api/weathercam/v1/stations/data') ?? [])['stations'] ?? [] as $st) foreach ($st['presets'] ?? [] as $ps) $times[(string)($ps['id'] ?? '')] = strtotime((string)($ps['measuredTime'] ?? '')) ?: null;
    $out = []; $old = time() - 3 * 3600;
    foreach ($j['features'] ?? [] as $f) {
        $P = $f['properties'] ?? []; $g = $f['geometry']['coordinates'] ?? null; if (!$g) continue;
        $id = rid($P['id'] ?? ''); $name = (string)($P['name'] ?? '');   // "kt51_Inkoo", "vt2_Karkkila_Korpi"
        $r = preg_match('/^(?:vt|kt|st|yt|mt)?(\d+)_/i', $name, $m) ? (int)$m[1] : 0;
        $n = str_replace('_', ' ', preg_replace('/^(?:vt|kt|st|yt|mt)?\d+_/i', '', $name));
        $cams = [];
        foreach ($P['presets'] ?? [] as $ps) {
            if (empty($ps['inCollection'])) continue; $pid = rid($ps['id'] ?? ''); if ($pid === '') continue;
            $cam = ['id' => 'fi:' . $pid, 'u' => 'https://weathercam.digitraffic.fi/' . $pid . '.jpg', 'ts' => $times[$pid] ?? null];
            if (str_ends_with($pid, '09')) $cam['sfc'] = 1;   // preset 9 looks at the road surface
            if (($P['collectionStatus'] ?? '') !== 'GATHERING' || ($times && ($cam['ts'] ?? 0) < $old)) $cam['f'] = 1;
            $cams[] = $cam;
        }
        if ($cams) $out[] = ['id' => 'fi:' . $id, 'n' => clean($n, 80), 'la' => round((float)$g[1], 5), 'lo' => round((float)$g[0], 5), 'r' => $r ? (string)$r : '', 'cc' => 'fi', 'c' => $cams];
    }
    return $out ? ['cams' => $out] : null;
}

/* ---------------- road conditions ---------------- */
function road_kind(string $s): ?string   // Swedish väglag words and Finnish codes to DATEX-like names; the worst wins
{
    $s = mb_strtolower($s);
    if ($s === '') return null;
    if (preg_match('/\bis\b|isfläck|is-|halk|rimfrost|frost|icy|ice/u', $s)) return 'icy';
    if (preg_match('/modd|slush/u', $s)) return 'slush';
    if (preg_match('/snö|snow/u', $s)) return 'snow';
    if (preg_match('/fläckvis våt|fukt|moist/u', $s)) return 'moist';
    if (preg_match('/våt|wet/u', $s)) return 'wet';
    if (preg_match('/torr|dry/u', $s)) return 'dry';
    return null;
}
function fi_road(): ?array
{
    $geo = cached('roads:fi:sections', 86400, function () {   // the road sections' places and names: a day
        $j = dt_get('/api/weather/v1/forecast-sections'); if ($j === null) return null;
        $o = [];
        foreach ($j['features'] ?? [] as $f) {
            $pts = geo_pts($f['geometry'] ?? []); if (!$pts) continue;
            $m = $pts[intdiv(count($pts), 2)]; $P = $f['properties'] ?? [];
            $o[(string)($P['id'] ?? '')] = [trim(preg_replace('/\s+\d+\.\d+$/', '', (string)($P['description'] ?? ''))), (int)($P['roadNumber'] ?? 0), round($m[0], 5), round($m[1], 5)];
        }
        return $o ?: null;
    });
    $j = dt_get('/api/weather/v1/forecast-sections/forecasts');
    if (!$geo || $j === null) return null;
    $pts = []; $order = ['dry' => 0, 'moist' => 1, 'wet' => 2, 'slush' => 3, 'snow' => 4, 'icy' => 5];
    foreach ($j['forecastSections'] ?? [] as $s) {
        $g = $geo[(string)($s['id'] ?? '')] ?? null; if (!$g) continue;
        $t0 = null; $h = []; $c = []; $sv = [];
        foreach ($s['forecasts'] ?? [] as $f) {
            $tm = strtotime((string)($f['time'] ?? '')); if (!$tm) continue; $t0 ??= $tm;
            $rc = road_kind((string)($f['forecastConditionReason']['roadCondition'] ?? ''));
            if ($rc === null && ($f['type'] ?? '') === 'OBSERVATION') $rc = ($f['overallRoadCondition'] ?? '') === 'NORMAL_CONDITION' ? null : 'icy';
            $h[] = round(($tm - $t0) / 3600, 2); $c[] = $rc; $sv[] = isset($f['roadTemperature']) ? round((float)$f['roadTemperature'], 1) : null;
        }
        // the observation (0 h) has no condition of its own when the road is normal: the 2-hour forecast's then
        if ($c && $c[0] === null && isset($c[1])) $c[0] = $c[1];
        if (!$h || !array_filter($c)) continue;
        $pts[] = ['n' => $g[0], 'r' => $g[1] ? (string)$g[1] : '', 'la' => $g[2], 'lo' => $g[3], 't0' => $t0, 'h' => $h, 'c' => $c, 's' => $sv];
    }
    return $pts ? ['at' => time(), 'pts' => $pts] : null;
}
function se_road(): ?array
{
    $rc = tv_query('RoadCondition', '1.2', '', ['Id', 'ConditionInfo', 'ConditionCode', 'LocationText', 'RoadNumberNumeric', 'StartTime', 'Geometry.WGS84']);
    $wm = tv_query('WeatherMeasurepoint', '2.1', '', ['Id', 'Geometry.WGS84', 'Observation.Sample', 'Observation.Surface.Temperature.Value'], '<EQ name="Deleted" value="false"/>');
    if ($rc === null) return null;
    $now = time(); $temps = [];
    foreach ($wm ?? [] as $w) {
        $p = wkt_pts((string)($w['Geometry']['WGS84'] ?? ''))[0] ?? null; $v = $w['Observation']['Surface']['Temperature']['Value'] ?? null;
        $at = strtotime((string)($w['Observation']['Sample'] ?? ''));
        if ($p && is_numeric($v) && $at && $at > $now - 5400) $temps[] = [$p[0], $p[1], round((float)$v, 1)];
    }
    $near = function ($la, $lo) use ($temps) {   // the road temperature at the nearest station within 15 km
        $best = null; $bd = 15.0; $cs = cos(deg2rad($la));
        foreach ($temps as [$a, $b, $v]) { $d = hypot(($a - $la) * 111.2, ($b - $lo) * 111.2 * $cs); if ($d < $bd) { $bd = $d; $best = $v; } }
        return $best;
    };
    $pts = [];
    foreach ($rc as $x) {
        $at = strtotime((string)($x['StartTime'] ?? '')); if (!$at || $at < $now - 36 * 3600) continue;   // an old assessment says nothing about today
        $kinds = array_filter(array_map(fn($s) => road_kind((string)$s), $x['ConditionInfo'] ?? []));
        $order = ['dry' => 0, 'moist' => 1, 'wet' => 2, 'slush' => 3, 'snow' => 4, 'icy' => 5];
        usort($kinds, fn($a, $b) => $order[$b] <=> $order[$a]); $k = $kinds[0] ?? null;
        if ($k === null) continue;
        $line = wkt_pts((string)($x['Geometry']['WGS84'] ?? '')); if (!$line) continue;
        // a point every ~3 km along the stretch (the page matches points within 300 m of the route)
        $last = null; $road = (int)($x['RoadNumberNumeric'] ?? 0);
        foreach ($line as $i => $p) {
            if ($last && $i < count($line) - 1 && hypot(($p[0] - $last[0]) * 111.2, ($p[1] - $last[1]) * 111.2 * cos(deg2rad($p[0]))) < 3) continue;
            $last = $p; $sv = $near($p[0], $p[1]);
            $pts[] = ['n' => clean((string)($x['LocationText'] ?? ''), 80), 'r' => $road ? (string)$road : '', 'la' => round($p[0], 5), 'lo' => round($p[1], 5),
                't0' => $now, 'seen' => $at, 'h' => [0, 3], 'c' => [$k, $k], 's' => [$sv, $sv]];   // seen: when the state was set (rain since then can wet it)
        }
    }
    return $pts ? ['at' => $now, 'pts' => $pts] : null;
}

$fn = ['se' => ['sit' => 'se_sit', 'cams' => 'se_cams', 'road' => 'se_road'], 'fi' => ['sit' => 'fi_sit', 'cams' => 'fi_cams', 'road' => 'fi_road']][$c][$what];
$res = cached("roads4:$c:$what", ROADS_TTL[$what], $fn);
if ($res === null) json_out(['error' => 'The road authority did not answer', 'unavailable' => true], 502);
header('Content-Type: application/json; charset=utf-8');   // not json_out: that sets no-store
header('Cache-Control: public, max-age=' . (int)(ROADS_TTL[$what] / 2));
echo json_encode($res, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
