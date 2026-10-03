#!/bin/sh
# Deploy glett to Webhuset. Assets go first and index.html last: Cloudflare caches a versioned asset URL for a year,
# so a visitor who loads a new index.html before the new asset is up would pin the old asset to the new URL.
set -e
cd "$(dirname "$0")/.."
EX="--exclude .git --exclude .gitignore --exclude docker/ --exclude docs/ --exclude tools/ --exclude README.md --exclude api/config.php --exclude *.swp --exclude statistikk/"
DEST=glettno@linweb21.hmg9.webhuset.no:www/
rsync -a $EX --exclude index.html ./ "$DEST" 2>&1 | grep -v "post-quantum\|store now\|openssh.com" || true
rsync -a --delete $EX ./ "$DEST" 2>&1 | grep -v "post-quantum\|store now\|openssh.com" || true
echo deployed
