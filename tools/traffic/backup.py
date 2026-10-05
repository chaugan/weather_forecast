#!/usr/bin/env python3
"""Nightly: a consistent copy of traffic.db (SQLite online backup, gzipped) kept here for 14 days and copied to the web
host (glettno@linweb21:glett-traffic-backup/, outside the web root), so the history survives a lost disk on this server."""
import gzip, os, shutil, sqlite3, subprocess, time
DIR = os.environ.get('GLETT_TRAFFIC_DIR', '/opt/code/glett-traffic'); B = os.path.join(DIR, 'backup'); os.makedirs(B, exist_ok=True)
day = time.strftime('%Y%m%d'); tmp = os.path.join(B, f'traffic-{day}.db'); out = tmp + '.gz'
src = sqlite3.connect(os.path.join(DIR, 'traffic.db')); dst = sqlite3.connect(tmp); src.backup(dst); dst.close(); src.close()
with open(tmp, 'rb') as f, gzip.open(out, 'wb', 6) as g: shutil.copyfileobj(f, g)
os.remove(tmp)
for f in sorted(os.listdir(B)):
    if f.endswith('.db.gz') and os.path.getmtime(os.path.join(B, f)) < time.time() - 14 * 86400: os.remove(os.path.join(B, f))
r = subprocess.run(['rsync', '-a', '--delete', '-e', 'ssh -o BatchMode=yes', B + '/', 'glettno@linweb21.hmg9.webhuset.no:glett-traffic-backup/'], capture_output=True, text=True)
print(time.strftime('%F %T'), 'backup', out, os.path.getsize(out), 'bytes; offsite', 'ok' if r.returncode == 0 else 'FAILED ' + r.stderr[-300:])
