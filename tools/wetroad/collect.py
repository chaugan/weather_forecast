#!/usr/bin/env python3
"""Collects Finnish road-weather station history from Digitraffic for re-tuning the wet-road model (tools/wetroad/README.md).
Digitraffic keeps only the last 24 h, so this must run at least once a day; twice is safer. Proposed cron (NOT installed):
  23 5,17 * * * /usr/bin/python3 /opt/code/glett/tools/wetroad/collect.py >> /opt/code/glett-wetroad/collect.log 2>&1

Each run fetches from the end of the last good run minus 1 h (the overlap), at most the 24 h Digitraffic holds, for every
station with a surface-state sensor, on 8 threads, and keeps only the sensors that matter for drying. Written to
  $GLETT_WETROAD_DIR/fi/YYYY/MM/YYYYMMDD-HH.json.gz   (default /opt/code/glett-wetroad; about 1.5 GB a year)
in the same shape as the research file fi_hist_*.json.gz (times in epoch minutes UTC); the overlapping windows are merged
when the data is read (check_fi.py load()). fit.py --fi $GLETT_WETROAD_DIR/fi adds Finland as a third test set.
"""
import json, gzip, os, sys, time, datetime, urllib.request, concurrent.futures as cf

ROOT = os.environ.get('GLETT_WETROAD_DIR', '/opt/code/glett-wetroad')
STATE = os.path.join(ROOT, 'fi', 'state.json')
B = 'https://tie.digitraffic.fi/api/weather/v1/'
H = {'Digitraffic-User': 'glett.no wet-road research', 'Accept-Encoding': 'gzip'}
KEEP = ['KELI_1', 'OPTISEN_ANTURIN_KELI1', 'VEDEN_MÄÄRÄ1', 'VEDEN_MAARA1', 'SADE', 'SADE_INTENSITEETTI', 'SADESUMMA', 'ILMA', 'KASTEPISTE',
        'KESKITUULI', 'MAKSIMITUULI', 'VALOISAA', 'TIE_1']

def get(u):
    for k in range(3):
        try:
            r = urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=60).read()
            try: r = gzip.decompress(r)
            except OSError: pass
            return json.loads(r)
        except Exception as e:
            err = e; time.sleep(2 + 3 * k)
    raise err

def main():
    now = datetime.datetime.now(datetime.timezone.utc).replace(second=0, microsecond=0)
    try: last = datetime.datetime.fromisoformat(json.load(open(STATE))['to'])
    except Exception: last = None
    fr = max(now - datetime.timedelta(hours=24), (last - datetime.timedelta(hours=1)) if last else now - datetime.timedelta(hours=24))
    sens = {s['id']: s['name'] for s in get(B + 'sensors')['sensors'] if s['name'] in KEEP}
    meta = {f['id']: f for f in get(B + 'stations')['features']}
    ids = [s['id'] for s in get(B + 'stations/data')['stations'] if any(sens.get(v['id']) in ('KELI_1', 'OPTISEN_ANTURIN_KELI1') for v in s['sensorValues'])]
    F, T = fr.strftime('%Y-%m-%dT%H:%M:%SZ'), now.strftime('%Y-%m-%dT%H:%M:%SZ')
    def one(i):
        try: d = get(f'{B}stations/{i}/data/history?from={F}&to={T}')
        except Exception: return i, None
        s = {}
        for v in d.get('values', []):
            n = sens.get(v['id'])
            if n: s.setdefault(n, []).append([int(datetime.datetime.fromisoformat(v['measuredTime'].replace('Z', '+00:00')).timestamp() // 60), v['value']])
        for k in s: s[k].sort()
        f = meta.get(i, {}); c = (f.get('geometry') or {}).get('coordinates', [None, None])
        return i, {'name': (f.get('properties') or {}).get('name'), 'lon': c[0], 'lat': c[1], 's': s}
    out = {'src': 'Digitraffic tie.digitraffic.fi weather/v1 stations/{id}/data/history (Fintraffic, CC BY 4.0)', 'from': F, 'to': T, 't': 'epoch minutes UTC',
           'keli': {0: 'fault', 1: 'dry', 2: 'moist', 3: 'wet', 4: 'wet+salty', 5: 'frost', 6: 'snow', 7: 'ice', 8: 'prob. moist+salty', 9: 'slush'}, 'stations': {}}
    fails = 0
    with cf.ThreadPoolExecutor(8) as ex:
        for i, r in ex.map(one, ids):
            if r: out['stations'][i] = r
            else: fails += 1
    if len(out['stations']) < 0.5 * max(1, len(ids)): print(now.isoformat(), f'only {len(out["stations"])} of {len(ids)} stations, not saved', file=sys.stderr); sys.exit(1)
    d = os.path.join(ROOT, 'fi', now.strftime('%Y'), now.strftime('%m')); os.makedirs(d, exist_ok=True)
    fn = os.path.join(d, now.strftime('%Y%m%d-%H') + '.json.gz')
    with gzip.open(fn + '.tmp', 'wt') as f: json.dump(out, f, separators=(',', ':'))
    os.replace(fn + '.tmp', fn)
    json.dump({'to': now.isoformat()}, open(STATE, 'w'))
    print(now.isoformat(), f'{len(out["stations"])} stations ({fails} failed), {F}..{T} ->', fn, os.path.getsize(fn), 'bytes')

if __name__ == '__main__':
    main()
