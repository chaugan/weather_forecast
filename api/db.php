<?php
// Κοινή σύνδεση SQLite + βοηθητικές συναρτήσεις JSON
declare(strict_types=1);

// Ανεκτικότητα σε παλαιότερες εκδόσεις PHP / ελλιπείς επεκτάσεις
if (!function_exists('str_contains')) { function str_contains(string $h, string $n): bool { return $n === '' || strpos($h, $n) !== false; } }
if (!function_exists('str_starts_with')) { function str_starts_with(string $h, string $n): bool { return strncmp($h, $n, strlen($n)) === 0; } }
ini_set('display_errors', '0');
set_exception_handler(function (Throwable $e) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Server error: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'PHP error: ' . $e['message']], JSON_UNESCAPED_UNICODE);
    }
});

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $dir = __DIR__ . '/../data';
    if (!extension_loaded('pdo_sqlite')) {
        json_out(['error' => 'The PHP extension pdo_sqlite is missing (e.g. apt install php-sqlite3)'], 500);
    }
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
        json_out(['error' => 'Cannot create the data/ directory. Grant write permission to the web server user'], 500);
    }
    if (!is_writable($dir)) {
        json_out(['error' => 'The data/ directory is not writable by the web server (chown www-data data && chmod 775 data)'], 500);
    }
    try {
        $pdo = new PDO('sqlite:' . $dir . '/wefo.sqlite');
    } catch (PDOException $e) {
        json_out(['error' => 'Database error: ' . $e->getMessage()], 500);
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS cache (
        k TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
    )');
    // Long-term daily history per saved location (downloaded once, then cached here)
    $pdo->exec('CREATE TABLE IF NOT EXISTS history_daily (
        loc_id INTEGER NOT NULL,
        d TEXT NOT NULL,
        tmax REAL, tmin REAL, tmean REAL, prcp REAL, wmax REAL, gust REAL, snow REAL,
        PRIMARY KEY (loc_id, d)
    ) WITHOUT ROWID');
    $pdo->exec('CREATE TABLE IF NOT EXISTS history_meta (
        loc_id INTEGER PRIMARY KEY,
        grid_lat REAL, grid_lon REAL, elevation REAL, timezone TEXT,
        first_date TEXT, last_date TEXT, fetched_at INTEGER NOT NULL
    )');
    return $pdo;
}

// Optional local config: api/config.php (git-ignored — see api/config.example.php) and/or environment
// variables (see the "WEFO_" section of api/config.example.php for the exact names and how to set them
// on Apache / Nginx+PHP-FPM / systemd). An env var always wins over the same key from config.php, so you
// can keep secrets out of any file on disk entirely if you prefer. Neither present = no optional
// features enabled; nothing else in the app depends on this.
function app_config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $f = __DIR__ . '/config.php';
    $file = is_file($f) ? (require $f) : [];
    $cfg = is_array($file) ? $file : [];
    foreach (['google_weather_api_key' => 'WEFO_GOOGLE_WEATHER_API_KEY'] as $key => $env) {
        $v = getenv($env);
        if ($v !== false && $v !== '') $cfg[$key] = $v;
    }
    return $cfg;
}

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function http_get(string $url, int $timeout = 20): ?string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT => 'wefo-weather-compare/1.0 (personal project)',
        CURLOPT_ENCODING => '',
        CURLOPT_SSL_VERIFYPEER => false, // τοπικό Laragon χωρίς CA bundle
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ($body !== false && $status === 200) ? $body : null;
}
