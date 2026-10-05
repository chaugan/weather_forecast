#!/usr/bin/env python3
"""Kjørevær: rest areas along the route. Builds data/rest/rest.json from Statens vegvesen's NVDB, object type 39
(Rasteplass), NLOD. Run monthly; about half a minute.

  data/rest/rest.json  {v, source, fields, pts: [[id, name, lat, lon, road, main, cars, trucks, disabled, charging,
                        water, shower, power, oneway, winter, from, to], ...]}
    main      1 for a main rest area (Hovedrasteplass), 0 for the others
    cars, trucks, disabled, charging   parking spaces (null when NVDB does not say)
    water, shower, power               1 yes, 0 no, null unknown
    oneway    1 when it can only be reached from one direction of travel
    winter    'closed' (helt vinterstengt), 'cleared' (vinterdrift av kjøreareal), 'open' (ikke vinterstengt), null
    from, to  the winter closure as 'MM-DD' (only with 'closed')
    toilet    [count, 'w' water closet | 'd' dry toilet | null, accessible 1/0/null, winter-closed 1/0/null, from, to] or null
              (NVDB type 243 Toalettanlegg, linked to the rest area; several buildings are added up)
    tables, roofed, benches, bins, play   counts of the linked outdoor furniture (type 28: tables, of them with a roof,
              benches), bins (27 Renovasjon) and play equipment (26 Lekeapparat)

  tools/rest/build.py
"""
import json, os, re, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'data', 'rest', 'rest.json')
API = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/39?inkluder=egenskaper,lokasjon,geometri&srid=4326&antall=1000'
UA = {'Accept': 'application/json', 'X-Client': 'glett.no', 'User-Agent': 'glett.no rest areas (christian@chrzz.no)'}
WINTER = {'Helt vinterstengt': 'closed', 'Vinterdrift av kjøreareal': 'cleared', 'Ikke vinterstengt': 'open'}


def fetch(url=API):
    out = []
    while url:
        j = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120))
        out += j['objekter']; n = j['metadata'].get('neste'); url = n['href'] if n and j['objekter'] else None
    return out


def centre(o):   # the middle of the area's outline (NVDB gives lat lon in EPSG:4326)
    w = (o.get('geometri') or {}).get('wkt') or ''
    pts = [tuple(map(float, p.split()[:2])) for p in re.findall(r'(-?\d+\.\d+ -?\d+\.\d+)', w)]
    if not pts: return None
    la, lo = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    return (la, lo) if la > lo else (lo, la)


def road(o):
    r = ((o.get('lokasjon') or {}).get('vegsystemreferanser') or [{}])[0].get('vegsystem') or {}
    k, n = r.get('vegkategori'), r.get('nummer')
    return {'E': f'E {n}', 'R': f'Rv {n}', 'F': f'Fv {n}', 'K': f'Kv {n}'}.get(k) if n else None


def yes(v): return None if v is None else 1 if str(v).startswith('Ja') else 0


def mmdd(v): return v[-5:] if isinstance(v, str) and re.match(r'^(\d{4}-)?\d\d-\d\d$', v) else None


def extras(ks):
    toil = [k for t, k in ks if t == 243]
    toilet = None
    if toil:
        kinds = {k.get('Type') for k in toil}
        acc = [yes(k.get('Universelt utformet')) for k in toil]; win = [yes(k.get('Vinterstengt')) for k in toil]
        toilet = [sum(int(k.get('Antall klosett') or 0) for k in toil) or None, 'w' if 'Vannklosett' in kinds else 'd' if 'Tørrklosett' in kinds else None,
                  1 if 1 in acc else 0 if 0 in acc else None, 0 if 0 in win else 1 if 1 in win else None,
                  next((mmdd(k.get('Vinterstengt, fra dato')) for k in toil if k.get('Vinterstengt, fra dato')), None), next((mmdd(k.get('Vinterstengt, til dato')) for k in toil if k.get('Vinterstengt, til dato')), None)]
    furn = [k.get('Type') or '' for t, k in ks if t == 28]
    return [toilet, sum(1 for f in furn if 'med bord' in f) or None, sum(1 for f in furn if 'takoverbygg' in f) or None, sum(1 for f in furn if f == 'Benk') or None,
            sum(1 for t, _ in ks if t == 27) or None, 1 if any(t == 26 for t, _ in ks) else None]


def main():
    out = []
    kids = {}   # rest area id -> the linked objects
    for typ in (243, 28, 27, 26):
        for o in fetch(f'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/{typ}?inkluder=egenskaper,relasjoner&antall=1000'):
            for f in (o.get('relasjoner') or {}).get('foreldre', []):
                if f['type']['id'] == 39:
                    for pid in f.get('vegobjekter', []): kids.setdefault(pid, []).append((typ, {e['navn']: e.get('verdi') for e in o.get('egenskaper', [])}))
    for o in fetch():
        p = {e['navn']: e.get('verdi') for e in o.get('egenskaper', [])}
        c = centre(o)
        if not c: continue
        w = WINTER.get(p.get('Vinterstengning'))
        out.append([o['id'], p.get('Navn'), round(c[0], 5), round(c[1], 5), road(o), 1 if p.get('Type') == 'Hovedrasteplass' else 0,
                    p.get('Antall oppstillingspl. små kjt.'), p.get('Antall oppstillingspl. store kjt.'), p.get('Antall oppstillingspl. forflytningshemmede'),
                    (p.get('Antall oppstillingspl. med lading, små kjt.') or 0) + (p.get('Antall oppstillingspl. med lading, store kjt.') or 0) or None,
                    yes(p.get('Drikkevann')), yes(p.get('Dusj')), yes(p.get('Strømuttak')), 1 if p.get('Lovlig adkomst') == 'En retning' else 0,
                    w, mmdd(p.get('Helt vinterstengt, fra dato')) if w == 'closed' else None, mmdd(p.get('Helt vinterstengt, til dato')) if w == 'closed' else None] + extras(kids.get(o['id'], [])))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = {'v': time.strftime('%Y-%m-%d'), 'source': 'Statens vegvesen, NVDB (NLOD)', 'fields': ['id', 'name', 'lat', 'lon', 'road', 'main', 'cars', 'trucks', 'disabled', 'charging', 'water', 'shower', 'power', 'oneway', 'winter', 'from', 'to', 'toilet', 'tables', 'roofed', 'benches', 'bins', 'play'], 'pts': out}
    json.dump(doc, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(out)} rest areas, {sum(x[5] for x in out)} main, {sum(1 for x in out if x[17])} with a toilet, {sum(1 for x in out if x[18])} with tables; {os.path.getsize(OUT) // 1024} KB')


if __name__ == '__main__':
    main()
