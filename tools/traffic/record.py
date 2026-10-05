#!/usr/bin/env python3
"""Records Statens vegvesen's DATEX travel times (GetTravelTimeData) into SQLite, every 5 minutes from cron.

The feed is live only: every 5-minute period that is not recorded is lost, so this runs on an always-on server and
keeps everything. Each stretch has the measured travel time and its free-flow time; the delay is the difference.
The stretch table (names and line geometry, UTM 33) is refreshed once a day.

  record.py            one snapshot (cron: */5 * * * *)
  record.py --status   print the health summary

Data:        $GLETT_TRAFFIC_DIR (default /opt/code/glett-traffic)/traffic.db
Credentials: ~/.config/glett/datex.json  {"user": ..., "pass": ...}  (the site's DATEX account; never in the repo)
Licence:     NLOD, Statens vegvesen.
"""
import base64, fcntl, json, math, os, re, sqlite3, sys, time, urllib.request
from datetime import datetime, timezone

BASE = 'https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/'
DIR = os.environ.get('GLETT_TRAFFIC_DIR', '/opt/code/glett-traffic')
DB = os.path.join(DIR, 'traffic.db')
CREDS = os.path.expanduser('~/.config/glett/datex.json')
UA = 'glett.no traffic recorder (christian@chrzz.no)'


def fetch(pub, tries=3):
    c = json.load(open(CREDS))
    auth = base64.b64encode(f"{c['user']}:{c['pass']}".encode()).decode()
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(BASE + pub + '/pullsnapshotdata', headers={'Authorization': 'Basic ' + auth, 'Accept': '*/*', 'Accept-Encoding': 'identity', 'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode('utf-8')
        except Exception as e:   # a short pause, then again: one lost period is one too many
            last = e; time.sleep(10 * (k + 1))
    raise last


def utm33(e, n):   # EPSG:32633 -> lat, lon
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f); ep = e2 / (1 - e2); x = e - 500000; m = n / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256)); e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
    c = ep * math.cos(p) ** 2; t = math.tan(p) ** 2; nn = a / math.sqrt(1 - e2 * math.sin(p) ** 2); rr = a * (1 - e2) / (1 - e2 * math.sin(p) ** 2) ** 1.5; d = x / (nn * k0)
    lat = p - (nn * math.tan(p) / rr) * (d * d / 2 - (5 + 3 * t + 10 * c - 4 * c * c - 9 * ep) * d ** 4 / 24)
    lon = (d - (1 + 2 * t + c) * d ** 3 / 6) / math.cos(p)
    return round(math.degrees(lat), 6), round(15 + math.degrees(lon), 6)


def epoch(s):
    return int(datetime.fromisoformat(s).timestamp())


def db():
    os.makedirs(DIR, exist_ok=True)
    con = sqlite3.connect(DB, timeout=60)
    con.executescript('''
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS stretch (id INTEGER PRIMARY KEY, name TEXT, km REAL, lat REAL, lon REAL, geom TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS obs (stretch INTEGER NOT NULL, t INTEGER NOT NULL, tt REAL, ff REAL, ffspeed REAL, trend TEXT, status TEXT,
                                      PRIMARY KEY (stretch, t)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS run (at INTEGER PRIMARY KEY, ok INTEGER, rows INTEGER, note TEXT);
    ''')
    return con


def refresh_stretches(con):
    x = fetch('GetPredefinedTravelTimeLocations'); now = int(time.time()); n = 0
    for m in re.finditer(r'PredefinedLocation" id="(\d+)".*?<value lang="no">([^<]*)</value>.*?<ns9:posList>([^<]+)</ns9:posList>', x, re.S):
        v = list(map(float, m.group(3).split())); xs, ys = v[0::2], v[1::2]
        km = sum(math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) for i in range(1, len(xs))) / 1000
        pts = [utm33(xs[i], ys[i]) for i in range(0, len(xs), max(1, len(xs) // 60))] + [utm33(xs[-1], ys[-1])]   # about 60 points: enough to match routes
        mid = utm33(sum(xs) / len(xs), sum(ys) / len(ys))
        con.execute('INSERT INTO stretch (id, name, km, lat, lon, geom, updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, km=excluded.km, lat=excluded.lat, lon=excluded.lon, geom=excluded.geom, updated=excluded.updated',
                    (int(m.group(1)), m.group(2), round(km, 3), mid[0], mid[1], json.dumps(pts), now)); n += 1
    return n


def record(con):
    x = fetch('GetTravelTimeData'); rows = {}; stat = {}
    for r in re.findall(r'<ns6:physicalQuantity\b.*?</ns6:physicalQuantity>', x, re.S):
        sid = re.search(r'id="(\d+)"', r); per = re.search(r'<startOfPeriod>([^<]+)', r)
        g = lambda pat: (lambda mm: mm.group(1) if mm else None)(re.search(pat, r))
        if sid and 'trafficStatusValue' in r: stat[int(sid.group(1))] = g(r'trafficStatusValue>(\w+)')   # the status record has no period of its own
        if not sid or not per: continue
        k = (int(sid.group(1)), epoch(per.group(1))); row = rows.setdefault(k, {})
        if 'TravelTimeData' in r:
            tt, ff, sp = g(r'<ns6:travelTime><ns6:duration>([\d.]+)'), g(r'<ns6:freeFlowTravelTime><ns6:duration>([\d.]+)'), g(r'<ns6:freeFlowSpeed><speed>([\d.]+)')
            row.update(tt=float(tt) if tt else None, ff=float(ff) if ff else None, sp=float(sp) if sp else None, trend=g(r'travelTimeTrendType>(\w+)'))
    for (s_, t_), v in rows.items(): v.setdefault('status', stat.get(s_))
    con.executemany('INSERT OR IGNORE INTO obs (stretch, t, tt, ff, ffspeed, trend, status) VALUES (?,?,?,?,?,?,?)',
                    [(s, t, v.get('tt'), v.get('ff'), v.get('sp'), v.get('trend'), v.get('status')) for (s, t), v in rows.items()])
    return len(rows)


def status():
    con = db(); now = int(time.time())
    last = con.execute('SELECT MAX(t) FROM obs').fetchone()[0]; first = con.execute('SELECT MIN(t) FROM obs').fetchone()[0]
    n = con.execute('SELECT COUNT(*) FROM obs').fetchone()[0]; runs = con.execute('SELECT COUNT(*), SUM(ok) FROM run WHERE at > ?', (now - 86400,)).fetchone()
    periods = con.execute('SELECT COUNT(DISTINCT t) FROM obs WHERE t > ?', (now - 86400,)).fetchone()[0]
    st = {'now': now, 'first': first, 'last': last, 'stale_min': round((now - last) / 60) if last else None, 'rows': n,
          'stretches': con.execute('SELECT COUNT(*) FROM stretch').fetchone()[0], 'runs_24h': runs[0], 'ok_24h': runs[1] or 0,
          'periods_24h': periods, 'expected_24h': 288, 'db_mb': round(os.path.getsize(DB) / 1e6, 1)}
    json.dump(st, open(os.path.join(DIR, 'status.json'), 'w'))
    # no new period for 30 minutes: a notice on the portal dashboard (Temporary files), removed again when readings resume
    alert = '/opt/code/portal/data/files/ALERT-glett-traffic.txt'
    try:
        if st['stale_min'] is not None and st['stale_min'] > 30:
            last_run = con.execute('SELECT at, ok, note FROM run ORDER BY at DESC LIMIT 1').fetchone()
            open(alert, 'w').write(f"Glett traffic recorder: no new travel-time period for {st['stale_min']} minutes.\nLast run: {last_run}\nLog: {DIR}/record.log\n")
        elif os.path.exists(alert): os.remove(alert)
    except OSError: pass
    return st


def main():
    if '--status' in sys.argv: print(json.dumps(status(), indent=1)); return
    os.makedirs(DIR, exist_ok=True)
    lock = open(os.path.join(DIR, '.lock'), 'w')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: return   # the previous run is still busy
    con = db(); now = int(time.time()); note = ''
    try:
        upd = con.execute('SELECT MAX(updated) FROM stretch').fetchone()[0]
        if not upd or now - upd > 86400: note = f'stretches {refresh_stretches(con)}; '
        n = record(con); con.execute('INSERT OR REPLACE INTO run (at, ok, rows, note) VALUES (?,?,?,?)', (now, 1, n, note)); con.commit()
    except Exception as e:
        con.execute('INSERT OR REPLACE INTO run (at, ok, rows, note) VALUES (?,?,?,?)', (now, 0, 0, (note + repr(e))[:500])); con.commit()
        print(datetime.now(timezone.utc).isoformat(), 'FAILED', repr(e), file=sys.stderr)
    status()


if __name__ == '__main__':
    main()
