#!/bin/bash
# Pulls the Frost road-station series for the wet-road fit, in batches of 20 jobs per ssh call, up to 3 tries per job.
#   tools/wetroad/pull.sh jobs.txt OUTDIR [parallel] [--sun]   (--sun: cloud cover and radiation instead of the road series)
# jobs.txt: one "SNxxxxx:YYYY-MM-DD/YYYY-MM-DD" per line (prep.py --jobs writes it). Each finished job becomes
# OUTDIR/SNxxxxx_YYYY-MM-DD.csv.gz; jobs already there are skipped, so the script can be re-run after a break.
set -u
JOBS=$1; OUT=$2; PAR=${3:-3}; MODE=${4:-}; HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
run_batch() {  # $@ = jobs; one gzip per job that came back whole with HTTP 200, 404 or 412 (Frost has no data then)
  local tmp; tmp=$(mktemp -d -p "$OUT" .batch.XXXXXX)
  ssh -o BatchMode=yes -o ConnectTimeout=20 glettno@linweb21.hmg9.webhuset.no "php -d date.timezone=Europe/Oslo -d memory_limit=1G -- $MODE $*" < "$HERE/frost_pull.php" > "$tmp/all" 2>/dev/null
  awk -v d="$tmp" '
    /^#job /{ split($2,a,"[:/]"); f=""; if ($3==200||$3==404||$3==412) { f=d"/"a[1]"_"a[2]".csv"; printf "" > f } ; next }
    /^#end /{ if (f) { close(f); print f > (d"/done") } ; f=""; next }
    /^#/{ next }
    { if (f) print >> f }' "$tmp/all"
  [ -e "$tmp/done" ] && while read -r f; do gzip -c "$f" > "$OUT/$(basename "$f").gz.tmp" && mv "$OUT/$(basename "$f").gz.tmp" "$OUT/$(basename "$f").gz"; done < "$tmp/done"
  rm -rf "$tmp"
}
export -f run_batch; export OUT HERE MODE
for try in 1 2 3; do
  todo=$(while read -r j; do s=${j%%:*}; d=${j#*:}; d=${d%%/*}; [ -e "$OUT/${s}_${d}.csv.gz" ] || echo "$j"; done < "$JOBS")
  n=$(printf '%s\n' "$todo" | grep -c . || true); echo "try $try: $n jobs left"; [ "$n" = 0 ] && break
  printf '%s\n' "$todo" | xargs -n 20 -P "$PAR" bash -c 'run_batch "$@"' _
done
