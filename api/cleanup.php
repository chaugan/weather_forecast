<?php
// Optional cron job: deletes expired cache rows and old rate-limit rows. Only runs from the command line
// (php api/cleanup.php); the same cleanup also happens automatically on ~1% of web requests, so cron is optional.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require __DIR__ . '/db.php';
$r = housekeeping(true);
printf("expired cache rows deleted: %d, old rate-limit rows deleted: %d, cache size: %.1f MB%s\n",
    $r['expired'], $r['ratelimit'], $r['bytes'] / 1048576, isset($r['evicted']) ? ", evicted (over cap): {$r['evicted']}" : '');
