<?php
// Base-map tiles for Finland and Sweden (Web Mercator, 256 px), so the maps can show each country's own topographic map as
// Kartverket's shows Norway. Both need a key that must not reach the browser, hence this proxy:
//   fi  Maanmittauslaitos' terrain map (maastokartta, open WMTS, CC BY 4.0; key: nls_key / WEFO_NLS_KEY)
//   se  Lantmäteriet's topographic web map (Topografisk webbkarta Nedladdning, raster, CC BY 4.0): one 156 GB GeoPackage
//       (SQLite) on Lantmäteriet's download server, read a tile at a time with HTTP range requests, the way the camp pipeline
//       reads elevation COGs (Geotorget login: lm_user / lm_pass, WEFO_LM_USER / WEFO_LM_PASS)
// Each map paints its neighbours (white, or grey), so a tile is cut to the country (api/borders.json, OpenStreetMap's national
// boundaries, tools/basemap_borders.py): a tile wholly outside is 204 (MapLibre draws nothing, nothing is fetched), a tile on
// the border has the outside made transparent. Tiles are kept on disk (glett-cache/tiles) and served with a long max-age.
//   GET tiles/<l>/<z>/<x>/<y>.png  (rewritten in .htaccess)  or  api/tile.php?l=&z=&x=&y=
declare(strict_types=1);
require __DIR__ . '/db.php';

const TILE_LAYERS = ['fi' => [5, 18], 'se' => [5, 17]];   // zoom range served (below 5 the maps are hidden anyway)
const TILE_TTL = 90 * 86400;                               // kept this long, then fetched again (the maps change slowly)
const TILE_MAX_AGE = 30 * 86400;                           // browsers and Cloudflare
const TILE_DISK_MAX = 20 * 1024 * 1024 * 1024;             // above this (counted roughly), tiles are served but not kept
const TILE_UPSTREAM_PER_MIN = 240;                         // fetches from the map services a minute per visitor (cache misses only)
const SE_URL = 'https://dl1.lantmateriet.se/karta/topowebb/data/topowebb-3857.gpkg';

$l = (string)($_GET['l'] ?? ''); $z = (int)($_GET['z'] ?? -1); $x = (int)($_GET['x'] ?? -1); $y = (int)($_GET['y'] ?? -1);
if (!isset(TILE_LAYERS[$l]) || $z < TILE_LAYERS[$l][0] || $z > TILE_LAYERS[$l][1] || $x < 0 || $y < 0 || $x >= (1 << $z) || $y >= (1 << $z)) tile_none(400);

function tile_none(int $code = 204): void   // nothing to draw here (or a bad request): no body
{
    http_response_code($code);
    header('Cache-Control: public, max-age=' . ($code === 204 ? TILE_MAX_AGE : 60));
    exit;
}
function tile_send(string $png, string $state): void
{
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=' . TILE_MAX_AGE);
    header('X-Tile: ' . $state);
    header('Content-Length: ' . strlen($png));
    echo $png;
    exit;
}
function tile_dir(): string
{
    $d = dirname(__DIR__, 2) . '/glett-cache/tiles';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    return $d;
}

// ---- the cache: a file per tile; an empty file means "outside the country"
$file = tile_dir() . "/$l/$z/$x/$y.png";
if (is_file($file) && filemtime($file) > time() - TILE_TTL) {
    $sz = filesize($file);
    if ($sz === 0) tile_none();
    tile_send((string)file_get_contents($file), 'hit');
}

// ---- where the tile lies: inside, outside or across the border
function lon_of(float $px, int $z): float { return $px / (256 * (1 << $z)) * 360 - 180; }
function lat_of(float $py, int $z): float { $n = M_PI - 2 * M_PI * $py / (256 * (1 << $z)); return rad2deg(atan(sinh($n))); }
function px_of(float $lon, int $z): float { return ($lon + 180) / 360 * 256 * (1 << $z); }
function py_of(float $lat, int $z): float { $r = deg2rad($lat); return (1 - log(tan($r) + 1 / cos($r)) / M_PI) / 2 * 256 * (1 << $z); }
function clip_ring(array $ring, float $w, float $s, float $e, float $n): array   // Sutherland-Hodgman against the box
{
    foreach ([[0, $w, 1], [0, $e, -1], [1, $s, 1], [1, $n, -1]] as [$k, $v, $sg]) {
        $out = []; $c = count($ring); if (!$c) return [];
        for ($i = 0; $i < $c; $i++) {
            $a = $ring[($i + $c - 1) % $c]; $b = $ring[$i];
            $ia = ($a[$k] - $v) * $sg >= 0; $ib = ($b[$k] - $v) * $sg >= 0;
            if ($ib) {
                if (!$ia) { $t = ($v - $a[$k]) / ($b[$k] - $a[$k]); $out[] = [$a[0] + ($b[0] - $a[0]) * $t, $a[1] + ($b[1] - $a[1]) * $t]; }
                $out[] = $b;
            } elseif ($ia) { $t = ($v - $a[$k]) / ($b[$k] - $a[$k]); $out[] = [$a[0] + ($b[0] - $a[0]) * $t, $a[1] + ($b[1] - $a[1]) * $t]; }
        }
        $ring = $out;
    }
    return $ring;
}
$B = json_decode((string)file_get_contents(__DIR__ . '/borders.json'), true)[$l];
$w = lon_of($x * 256, $z); $e = lon_of(($x + 1) * 256, $z); $n = lat_of($y * 256, $z); $s = lat_of(($y + 1) * 256, $z);
[$bw, $bs, $be, $bn] = $B['bbox'];
if ($e < $bw || $w > $be || $n < $bs || $s > $bn) { @mkdir(dirname($file), 0700, true); @touch($file); tile_none(); }
// the country's area in this tile (with a little margin, so the cut lines meet between tiles), in the tile's pixels
$m = ($e - $w) * 0.02; $mn = ($n - $s) * 0.02; $parts = []; $holes = [];
foreach (['outer' => &$parts, 'holes' => &$holes] as $key => &$dst)
    foreach ($B[$key] as $ring) {
        $c = clip_ring($ring, $w - $m, $s - $mn, $e + $m, $n + $mn);
        if (count($c) >= 3) $dst[] = array_map(fn($p) => [px_of($p[0], $z) - $x * 256, py_of($p[1], $z) - $y * 256], $c);
    }
unset($dst);
$area = 0.0;
foreach ($parts as $r) { $a = 0.0; $c = count($r); for ($i = 0; $i < $c; $i++) { $p = $r[$i]; $q = $r[($i + 1) % $c]; $a += $p[0] * $q[1] - $q[0] * $p[1]; } $area += abs($a) / 2; }
foreach ($holes as $r) { $a = 0.0; $c = count($r); for ($i = 0; $i < $c; $i++) { $p = $r[$i]; $q = $r[($i + 1) % $c]; $a += $p[0] * $q[1] - $q[0] * $p[1]; } $area -= abs($a) / 2; }
$full = (256 * 1.04) ** 2;
if ($area < 1) { @mkdir(dirname($file), 0700, true); @touch($file); tile_none(); }   // wholly outside
$cut = $area < $full * 0.9999;

// ---- the tile itself
rate_limit(TILE_UPSTREAM_PER_MIN, 'tile');
$cfg = app_config();
if ($l === 'fi') {
    $key = (string)($cfg['nls_key'] ?? getenv('WEFO_NLS_KEY') ?: '');
    if ($key === '') tile_none(503);
    $png = tile_get("https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/maastokartta/default/WGS84_Pseudo-Mercator/$z/$y/$x.png?api-key=" . rawurlencode($key));
} else {
    $user = (string)($cfg['lm_user'] ?? getenv('WEFO_LM_USER') ?: ''); $pass = (string)($cfg['lm_pass'] ?? getenv('WEFO_LM_PASS') ?: '');
    if ($user === '' || $pass === '') tile_none(503);
    $png = se_tile($z, $x, $y, $user, $pass);
}
if ($png === null) tile_none(502);
if ($png === '') { @mkdir(dirname($file), 0700, true); @touch($file); tile_none(); }   // the map has no tile here
if ($cut) $png = tile_cut($png, $parts, $holes) ?? $png;
tile_keep($file, $png);
tile_send($png, $cut ? 'cut' : 'miss');

function tile_get(string $url, array $headers = [], ?string $userpwd = null, ?array &$info = null): ?string
{
    for ($k = 0; $k < 4; $k++) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 15, CURLOPT_USERAGENT => user_agent(),
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_HTTPHEADER => $headers]);
        if ($userpwd !== null) curl_setopt($ch, CURLOPT_USERPWD, $userpwd);
        $body = curl_exec($ch); $st = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
        if ($body !== false && ($st === 200 || $st === 206)) return $body;
        if ($st === 404) return '';
        if ($st !== 403 && $st !== 429 && $st < 500 && $st !== 0) return null;   // Lantmäteriet answers 403 now and then (a node behind)
        usleep(200000 * ($k + 1));
    }
    return null;
}
function tile_keep(string $file, string $png): void
{
    $stat = tile_dir() . '/.bytes';
    $total = (int)@file_get_contents($stat);
    if ($total > TILE_DISK_MAX) return;
    @mkdir(dirname($file), 0700, true);
    $tmp = $file . '.' . getmypid();
    if (@file_put_contents($tmp, $png) === strlen($png)) { @rename($tmp, $file); @file_put_contents($stat, (string)($total + strlen($png)), LOCK_EX); }
    else @unlink($tmp);
}
function tile_cut(string $png, array $parts, array $holes): ?string   // the outside of the country made transparent
{
    if (!function_exists('imagecreatefromstring')) return null;   // no GD: the tile as it is
    $src = @imagecreatefromstring($png); if (!$src) return null;
    $t = imagecreatetruecolor(256, 256); imagealphablending($t, false); imagesavealpha($t, true);
    $clear = imagecolorallocatealpha($t, 0, 0, 0, 127); imagefill($t, 0, 0, $clear);
    imagecopy($t, $src, 0, 0, 0, 0, 256, 256);
    $mk = imagecreate(256, 256); $out = imagecolorallocate($mk, 0, 0, 0); $in = imagecolorallocate($mk, 255, 255, 255);
    $flat = fn($r) => array_merge(...array_map(fn($p) => [(int)round($p[0]), (int)round($p[1])], $r));
    foreach ($parts as $r) imagefilledpolygon($mk, $flat($r), $in);
    foreach ($holes as $r) imagefilledpolygon($mk, $flat($r), $out);
    for ($py = 0; $py < 256; $py++) for ($px = 0; $px < 256; $px++) if (imagecolorat($mk, $px, $py) === $out) imagesetpixel($t, $px, $py, $clear);
    ob_start(); imagepng($t, null, 6); return (string)ob_get_clean();
}

/* ---- Sweden: one tile out of Lantmäteriet's GeoPackage. SQLite pages (4 KB) are read with range requests; the B-tree's inner
   pages are kept on disk (few, and visited by every tile), the leaves and the tile's overflow pages are not. The tile table
   is found from sqlite_master (its unique index on zoom_level, tile_column, tile_row gives the rowid). */
function se_tile(int $z, int $x, int $y, string $user, string $pass): ?string
{
    $S = new SeGpkg($user . ':' . $pass);
    $meta = $S->meta(); if (!$meta) return null;
    $rid = $S->indexGet($meta['index'], [$z, $x, $y]);
    if ($rid === null) return '';
    $rec = $S->tableGet($meta['table'], $rid);
    return $rec ? (string)$rec[4] : null;
}
final class SeGpkg
{
    private int $ps = 4096; private int $u = 4096; private array $mem = [];
    public function __construct(private string $auth) {}
    private function range(int $a, int $len): ?string
    {
        $b = tile_get(SE_URL, ['Range: bytes=' . $a . '-' . ($a + $len - 1)], $this->auth);
        return ($b !== null && strlen($b) === $len) ? $b : null;
    }
    private function page(int $n, bool $keep): ?string
    {
        if (isset($this->mem[$n])) return $this->mem[$n];
        $f = tile_dir() . "/se-pages/$n";
        if (is_file($f) && filesize($f) === $this->ps) return $this->mem[$n] = (string)file_get_contents($f);
        $b = $this->range(($n - 1) * $this->ps, $this->ps); if ($b === null) return null;
        if ($keep) { @mkdir(dirname($f), 0700, true); @file_put_contents($f, $b); }
        return $this->mem[$n] = $b;
    }
    public function meta(): ?array
    {
        $f = tile_dir() . '/se-meta.json';
        $m = is_file($f) ? json_decode((string)file_get_contents($f), true) : null;
        if (is_array($m) && isset($m['table'], $m['index'], $m['ps'])) { $this->ps = $m['ps']; $this->u = $m['u']; return $m; }
        $h = $this->range(0, 100); if ($h === null) return null;
        $ps = unpack('n', substr($h, 16, 2))[1]; $this->ps = $ps === 1 ? 65536 : $ps; $this->u = $this->ps - ord($h[20]);
        $tbl = $idx = null;
        foreach ($this->scan(1) as $r) {
            if ($r[0] === 'table' && $r[1] === 'topowebb') $tbl = (int)$r[3];
            if ($r[0] === 'index' && $r[2] === 'topowebb' && str_starts_with((string)$r[1], 'sqlite_autoindex_topowebb')) $idx = (int)$r[3];
        }
        if (!$tbl || !$idx) return null;
        $m = ['table' => $tbl, 'index' => $idx, 'ps' => $this->ps, 'u' => $this->u];
        @file_put_contents($f, json_encode($m));
        return $m;
    }
    private static function varint(string $b, int &$i): int
    {
        $v = 0;
        for ($k = 0; $k < 9; $k++) { $c = ord($b[$i++]); if ($k === 8) return ($v << 8) | $c; $v = ($v << 7) | ($c & 0x7f); if ($c < 0x80) return $v; }
        return $v;
    }
    private function payload(string $b, int $i, int $p, bool $table): ?string
    {
        $u = $this->u; $xmax = $table ? $u - 35 : intdiv(($u - 12) * 64, 255) - 23;
        if ($p <= $xmax) return substr($b, $i, $p);
        $mm = intdiv(($u - 12) * 32, 255) - 23; $kk = $mm + (($p - $mm) % ($u - 4)); $loc = $kk <= $xmax ? $kk : $mm;
        $out = substr($b, $i, $loc); $ov = unpack('N', substr($b, $i + $loc, 4))[1];
        while (strlen($out) < $p && $ov) {
            $pg = $this->page($ov, false); if ($pg === null) return null;
            $ov = unpack('N', substr($pg, 0, 4))[1]; $out .= substr($pg, 4, min($u - 4, $p - strlen($out)));
        }
        return $out;
    }
    private static function record(string $b): array
    {
        $i = 0; $hs = self::varint($b, $i); $types = [];
        while ($i < $hs) $types[] = self::varint($b, $i);
        $vals = []; $j = $hs;
        foreach ($types as $t) {
            if ($t === 0) $vals[] = null;
            elseif ($t >= 1 && $t <= 6) { $n = [0, 1, 2, 3, 4, 6, 8][$t]; $v = 0; for ($k = 0; $k < $n; $k++) $v = ($v << 8) | ord($b[$j + $k]); if ($n < 8 && $v >= (1 << (8 * $n - 1))) $v -= 1 << (8 * $n); $vals[] = $v; $j += $n; }
            elseif ($t === 7) { $vals[] = unpack('E', substr($b, $j, 8))[1]; $j += 8; }
            elseif ($t === 8 || $t === 9) $vals[] = $t - 8;
            elseif ($t >= 12) { $n = $t % 2 === 0 ? ($t - 12) >> 1 : ($t - 13) >> 1; $vals[] = substr($b, $j, $n); $j += $n; }
        }
        return $vals;
    }
    private function cells(int $n, bool $keep): ?array
    {
        $b = $this->page($n, $keep); if ($b === null) return null;
        $o = $n === 1 ? 100 : 0; $typ = ord($b[$o]); $nc = unpack('n', substr($b, $o + 3, 2))[1];
        $inner = $typ === 2 || $typ === 5; $right = $inner ? unpack('N', substr($b, $o + 8, 4))[1] : null; $h = $o + ($inner ? 12 : 8);
        $ptrs = []; for ($k = 0; $k < $nc; $k++) $ptrs[] = unpack('n', substr($b, $h + 2 * $k, 2))[1];
        return [$typ, $ptrs, $right, $b];
    }
    private function scan(int $root): array   // every record of a (small) table
    {
        $c = $this->cells($root, true); if (!$c) return [];
        [$typ, $ptrs, $right, $b] = $c; $out = [];
        if ($typ === 13) { foreach ($ptrs as $p) { $i = $p; $len = self::varint($b, $i); self::varint($b, $i); $pl = $this->payload($b, $i, $len, true); if ($pl !== null) $out[] = self::record($pl); } return $out; }
        foreach ($ptrs as $p) $out = array_merge($out, $this->scan(unpack('N', substr($b, $p, 4))[1]));
        return array_merge($out, $this->scan($right));
    }
    public function tableGet(int $root, int $rowid): ?array
    {
        $n = $root;
        for ($d = 0; $d < 12; $d++) {
            $c = $this->cells($n, false); if (!$c) return null;
            [$typ, $ptrs, $right, $b] = $c;
            if ($typ === 13) {
                foreach ($ptrs as $p) { $i = $p; $len = self::varint($b, $i); $rid = self::varint($b, $i); if ($rid === $rowid) { $pl = $this->payload($b, $i, $len, true); return $pl === null ? null : self::record($pl); } }
                return null;
            }
            $this->keep($n, $b);
            $next = $right;   // binary search over the keys
            $lo = 0; $hi = count($ptrs) - 1;
            while ($lo <= $hi) { $mid = ($lo + $hi) >> 1; $i = $ptrs[$mid] + 4; $key = self::varint($b, $i); if ($rowid <= $key) { $next = unpack('N', substr($b, $ptrs[$mid], 4))[1]; $hi = $mid - 1; } else $lo = $mid + 1; }
            $n = $next;
        }
        return null;
    }
    public function indexGet(int $root, array $key): ?int
    {
        $n = $root;
        for ($d = 0; $d < 12; $d++) {
            $c = $this->cells($n, false); if (!$c) return null;
            [$typ, $ptrs, $right, $b] = $c;
            $rec = function (int $p, bool $inner) use ($b): ?array { $i = $p + ($inner ? 4 : 0); $len = self::varint($b, $i); $pl = $this->payload($b, $i, $len, false); return $pl === null ? null : self::record($pl); };
            if ($typ === 10) {
                foreach ($ptrs as $p) { $r = $rec($p, false); if ($r && array_slice($r, 0, 3) === $key) return (int)end($r); }
                return null;
            }
            $this->keep($n, $b);
            $next = $right; $lo = 0; $hi = count($ptrs) - 1;
            while ($lo <= $hi) {
                $mid = ($lo + $hi) >> 1; $r = $rec($ptrs[$mid], true); if (!$r) return null;
                $k = array_slice($r, 0, 3); $cmp = $key <=> $k;
                if ($cmp === 0) return (int)end($r);
                if ($cmp < 0) { $next = unpack('N', substr($b, $ptrs[$mid], 4))[1]; $hi = $mid - 1; } else $lo = $mid + 1;
            }
            $n = $next;
        }
        return null;
    }
    private function keep(int $n, string $b): void   // an inner page: on disk for the next tile
    {
        $f = tile_dir() . "/se-pages/$n";
        if (!is_file($f)) { @mkdir(dirname($f), 0700, true); @file_put_contents($f, $b); }
    }
}
