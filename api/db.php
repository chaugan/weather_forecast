<?php
// Shared server helpers: configuration, MySQL connection and cache, outbound HTTP, rate limiting, JSON output.
// Only api/metar.php and api/reverse.php use this. The server never talks to Open-Meteo or MET Norway:
// the browser does that directly (see js/data.js), so every visitor uses their own API quota.
declare(strict_types=1);

ini_set('display_errors', '0');
set_time_limit(25);   // the host kills requests at 30 s; everything here must finish well before that

const WEFO_VERSION = '1.0';
const CACHE_MAX_BYTES = 30 * 1024 * 1024;   // hard cap for the cache table (oldest rows are dropped above it)
const CACHE_GZIP_ABOVE = 8192;              // bodies larger than this are stored compressed
const RATE_LIMIT_PER_MIN = 120;             // requests per minute per client IP (hashed); a full station history is ~20 requests
const HOUSEKEEPING_CHANCE = 100;            // 1 in N requests runs the cleanup (works without cron)
const GEOCODE_MAX_ROWS = 200000;            // the "permanent" place-name cache still gets a ceiling (~15 MB)

// Clients only ever get a generic message; the details go to the PHP error log (S6)
set_exception_handler(function (Throwable $e) {
    error_log(sprintf('Glett %s: %s in %s:%d', get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['error' => 'Server error'], JSON_UNESCAPED_UNICODE);
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        error_log(sprintf('Glett fatal: %s in %s:%d', $e['message'], $e['file'], $e['line']));
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'Server error'], JSON_UNESCAPED_UNICODE);
        }
    }
});

/* ---------------------------------------------------------------- config */
function app_config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    // Config file, first match wins: WEFO_CONFIG=<absolute path> (env), a wefo-config.php one level ABOVE the
    // web root (outside it, the safest place on shared hosting), or api/config.php (blocked by .htaccess).
    $candidates = array_filter([getenv('WEFO_CONFIG') ?: null, dirname(__DIR__, 2) . '/wefo-config.php', __DIR__ . '/config.php']);
    $file = [];
    foreach ($candidates as $f) if (is_file($f)) { $file = require $f; break; }
    $cfg = is_array($file) ? $file : [];
    foreach (['db_host' => 'WEFO_DB_HOST', 'db_port' => 'WEFO_DB_PORT', 'db_name' => 'WEFO_DB_NAME', 'db_user' => 'WEFO_DB_USER',
              'db_pass' => 'WEFO_DB_PASS', 'site_url' => 'WEFO_SITE_URL', 'contact_email' => 'WEFO_CONTACT_EMAIL',
              'frost_client_id' => 'WEFO_FROST_CLIENT_ID', 'frost_client_secret' => 'WEFO_FROST_CLIENT_SECRET',
              'netatmo_client_id' => 'WEFO_NETATMO_CLIENT_ID', 'netatmo_client_secret' => 'WEFO_NETATMO_CLIENT_SECRET', 'netatmo_refresh_token' => 'WEFO_NETATMO_REFRESH_TOKEN'] as $key => $env) {
        $v = getenv($env);
        if ($v !== false && $v !== '') $cfg[$key] = $v;
    }
    return $cfg;
}

function user_agent(): string
{
    $c = app_config();
    return sprintf('Glett/%s (+%s; %s)', WEFO_VERSION, $c['site_url'] ?? 'https://example.com', $c['contact_email'] ?? 'unknown@example.com');
}

/* ---------------------------------------------------------------- output */
function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/* Validated ?lat=&lon= */
function coords(): array
{
    $lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
    return [(float)$lat, (float)$lon];
}

/* ---------------------------------------------------------------- database */
function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $c = app_config();
    if (!extension_loaded('pdo_mysql')) json_out(['error' => 'The PHP extension pdo_mysql is missing'], 500);
    if (empty($c['db_name']) || empty($c['db_user'])) json_out(['error' => 'Database not configured (api/config.php or WEFO_DB_* environment variables)'], 500);
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['db_host'] ?? 'localhost', (int)($c['db_port'] ?? 3306), $c['db_name']);
    try {
        $pdo = new PDO($dsn, (string)$c['db_user'], (string)($c['db_pass'] ?? ''), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
    } catch (PDOException $e) {
        error_log('Glett database connection failed: ' . $e->getMessage());
        json_out(['error' => 'Database connection failed'], 503);
    }
    return $pdo;
}

function ensure_schema(): void
{
    $pdo = db();
    $pdo->exec('CREATE TABLE IF NOT EXISTS cache (
        k          VARCHAR(191) NOT NULL PRIMARY KEY,
        body       MEDIUMTEXT NOT NULL,
        fetched_at INT UNSIGNED NOT NULL,
        expires_at INT UNSIGNED NOT NULL,
        KEY (expires_at), KEY (fetched_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    $pdo->exec('CREATE TABLE IF NOT EXISTS geocode_rev (
        lat_r DECIMAL(7,3) NOT NULL, lon_r DECIMAL(8,3) NOT NULL, lang CHAR(2) NOT NULL,
        name VARCHAR(200) NULL, fetched_at INT UNSIGNED NOT NULL,
        PRIMARY KEY (lat_r, lon_r, lang)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    $pdo->exec('CREATE TABLE IF NOT EXISTS throttle (
        name VARCHAR(32) NOT NULL PRIMARY KEY, last_at DOUBLE NOT NULL, calls INT UNSIGNED NOT NULL DEFAULT 0
    ) ENGINE=InnoDB');
    $pdo->exec('CREATE TABLE IF NOT EXISTS ratelimit (
        ip_hash CHAR(32) NOT NULL PRIMARY KEY, window_start INT UNSIGNED NOT NULL, n SMALLINT UNSIGNED NOT NULL,
        KEY (window_start)
    ) ENGINE=InnoDB');
}

/* Prepared query; creates the schema on first use (no install step needed) */
function q(string $sql, array $args = []): PDOStatement
{
    $pdo = db();
    try {
        $st = $pdo->prepare($sql);
        $st->execute($args);
        return $st;
    } catch (PDOException $e) {
        if (($e->errorInfo[0] ?? '') === '42S02' || (int)($e->errorInfo[1] ?? 0) === 1146) {   // table does not exist yet
            ensure_schema();
            $st = $pdo->prepare($sql);
            $st->execute($args);
            return $st;
        }
        throw $e;
    }
}

/* ---------------------------------------------------------------- cache */
function cache_get(string $k): ?string
{
    $r = q('SELECT body FROM cache WHERE k = ? AND expires_at > ?', [$k, time()])->fetch();
    if (!$r) return null;
    $b = (string)$r['body'];
    if (str_starts_with($b, 'gz:')) { $b = gzuncompress(base64_decode(substr($b, 3))); return $b === false ? null : $b; }
    return $b;
}

function cache_put(string $k, string $body, int $ttl): void
{
    if (strlen($body) > CACHE_GZIP_ABOVE) $body = 'gz:' . base64_encode(gzcompress($body, 6));
    $now = time();
    q('INSERT INTO cache (k, body, fetched_at, expires_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE body = ?, fetched_at = ?, expires_at = ?',
      [$k, $body, $now, $now + $ttl, $body, $now, $now + $ttl]);
}

/* Cached upstream fetch with stampede protection: $fetch returns an array (cached as JSON) or null (failure, not cached). */
function cached(string $k, int $ttl, callable $fetch): ?array
{
    $hit = cache_get($k);
    if ($hit !== null) return json_decode($hit, true);
    $lock = 'glett:' . md5($k);
    $got = (int)(q('SELECT GET_LOCK(?, 10) l', [$lock])->fetch()['l'] ?? 0);
    try {
        if ($got === 1) {
            $hit = cache_get($k);   // somebody else may have filled it while we waited
            if ($hit !== null) return json_decode($hit, true);
        }
        $data = $fetch();
        if ($data !== null) cache_put($k, json_encode($data, JSON_UNESCAPED_UNICODE), $ttl);
        return $data;
    } finally {
        if ($got === 1) q('SELECT RELEASE_LOCK(?)', [$lock]);
    }
}

/* ---------------------------------------------------------------- abuse protection & housekeeping */
function rate_limit(int $limit = RATE_LIMIT_PER_MIN): void
{
    if (PHP_SAPI === 'cli') return;
    $h = md5('glett|' . ($_SERVER['REMOTE_ADDR'] ?? ''));   // only a hash of the address is stored
    $now = time();
    $win = $now - $now % 60;
    q('INSERT INTO ratelimit (ip_hash, window_start, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = IF(window_start = ?, n + 1, 1), window_start = ?',
      [$h, $win, $win, $win]);
    $n = (int)(q('SELECT n FROM ratelimit WHERE ip_hash = ?', [$h])->fetch()['n'] ?? 0);
    if ($n > $limit) {
        header('Retry-After: 60');
        json_out(['error' => 'Too many requests, try again in a minute'], 429);
    }
}

function housekeeping(bool $force = false): array
{
    if (!$force && random_int(1, HOUSEKEEPING_CHANCE) !== 1) return [];
    $out = [];
    $out['expired'] = q('DELETE FROM cache WHERE expires_at < ? LIMIT 500', [time()])->rowCount();
    $out['ratelimit'] = q('DELETE FROM ratelimit WHERE window_start < ? LIMIT 500', [time() - 3600])->rowCount();
    $r = q('SELECT COALESCE(SUM(data_length + index_length), 0) b FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?', ['cache'])->fetch();
    $out['bytes'] = (int)($r['b'] ?? 0);
    if ($out['bytes'] > CACHE_MAX_BYTES) $out['evicted'] = q('DELETE FROM cache ORDER BY fetched_at ASC LIMIT 1000')->rowCount();
    $n = (int)q('SELECT COUNT(*) n FROM geocode_rev')->fetch()['n'];
    if ($n > GEOCODE_MAX_ROWS) $out['geocode_evicted'] = q('DELETE FROM geocode_rev ORDER BY fetched_at ASC LIMIT 1000')->rowCount();
    return $out;
}

/* ---------------------------------------------------------------- outbound HTTP (TLS verification always on) */
/* Like http_get() but also returns the status, so a caller can read the JSON error body of a 4xx answer */
function http_get_status(string $url, int $timeout = 12, array $headers = [], ?string $basicUser = null): array
{
    $c = app_config();
    $ch = curl_init($url);
    if ($basicUser !== null) curl_setopt($ch, CURLOPT_USERPWD, $basicUser . ':');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => max(1, min(12, $timeout)),
        CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3, CURLOPT_USERAGENT => user_agent(), CURLOPT_REFERER => (string)($c['site_url'] ?? ''),
        CURLOPT_ENCODING => '', CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_HTTPHEADER => array_merge(['Accept: application/json'], $headers),
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$body === false ? 0 : $status, $body === false ? null : $body];
}

function http_get(string $url, int $timeout = 12, array $headers = [], ?string $basicUser = null): ?string
{
    $c = app_config();
    $ch = curl_init($url);
    if ($basicUser !== null) curl_setopt($ch, CURLOPT_USERPWD, $basicUser . ':');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => max(1, min(12, $timeout)),
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_USERAGENT => user_agent(),
        CURLOPT_REFERER => (string)($c['site_url'] ?? ''),
        CURLOPT_ENCODING => '',
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTPHEADER => array_merge(['Accept: application/json'], $headers),
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ($body !== false && $status === 200) ? $body : null;
}
