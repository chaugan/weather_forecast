# Nattplass: fetch Norway's road barriers from NVDB (Statens vegvesen, NLOD, open, no key) with all properties.
# Types: 23 Vegbom, 607 Vegsperring, 273 Dyresperre -> cache/nvdb_barriers.json; with 'stops': 39 Rasteplass, 40 Snuplass,
# 43 Parkeringsområde, 47 Trafikklomme -> cache/nvdb_stops.json. Rows: [{t, id, lat, lon, e: {navn: verdi}, kat}]
import json, urllib.request, urllib.parse, sys, time, os
API = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/'
STOPS = len(sys.argv) > 1 and sys.argv[1] == 'stops'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'nvdb_stops.json' if STOPS else 'nvdb_barriers.json')
rows = []
for t in ((39, 40, 43, 47) if STOPS else (23, 607, 273)):
    start = None; n = 0
    while True:
        q = {'antall': 1000, 'inkluder': 'egenskaper,lokasjon', 'srid': 4326}
        if start: q['start'] = start
        req = urllib.request.Request(API + f'{t}?' + urllib.parse.urlencode(q), headers={'Accept': 'application/json', 'X-Client': 'glett-nattplass'})
        for attempt in range(4):
            try: d = json.load(urllib.request.urlopen(req, timeout=120)); break
            except Exception as ex: print('retry', t, ex, file=sys.stderr); time.sleep(5 * (attempt + 1))
        objs = d.get('objekter') or []
        for o in objs:
            loc = o.get('lokasjon') or {}
            wkt = (loc.get('geometri') or {}).get('wkt') or ''
            try:
                a, b = [float(x) for x in wkt[wkt.rindex('(') + 1:].replace(',', ' ').split()[:2]]
            except Exception:
                continue
            vs = loc.get('vegsystemreferanser') or [{}]
            kat = (vs[0].get('vegsystem') or {}).get('vegkategori')
            e = {x['navn']: x.get('verdi') for x in o.get('egenskaper') or [] if x.get('egenskapstype') != 'GeomPunkt' and 'Geometri' not in x['navn']}
            rows.append({'t': t, 'id': o['id'], 'lat': a, 'lon': b, 'kat': kat, 'e': e})
        n += len(objs)
        nxt = (d.get('metadata') or {}).get('neste', {}).get('start')
        if not objs or not nxt or nxt == start: break
        start = nxt
    print(t, n, file=sys.stderr)
json.dump(rows, open(OUT, 'w'), ensure_ascii=False)
print(len(rows), 'rows ->', OUT)
