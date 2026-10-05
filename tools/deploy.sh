#!/bin/sh
# Deploy glett to Webhuset. Assets go first and index.html last: Cloudflare caches a versioned asset URL for a year,
# so a visitor who loads a new index.html before the new asset is up would pin the old asset to the new URL.
set -e
cd "$(dirname "$0")/.."
EX="--exclude .git --exclude .gitignore --exclude docker/ --exclude docs/ --exclude tools/ --exclude README.md --exclude api/config.php --exclude *.swp --exclude statistikk/"
DEST=glettno@linweb21.hmg9.webhuset.no:www/
# rsync's own exit status counts (a pipe through grep would hide a failed upload); one retry for a dropped connection
up() { for k in 1 2; do out=$(rsync -a "$@" 2>&1) && { printf '%s' "$out" | grep -v "post-quantum\|store now\|openssh.com" || true; return 0; }; sleep 5; done; printf '%s\n' "$out" >&2; echo "deploy FAILED" >&2; exit 1; }
up $EX --exclude index.html ./ "$DEST"
up --delete $EX ./ "$DEST"
echo deployed
