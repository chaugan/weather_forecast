#!/usr/bin/env python3
"""Builds data/traffic/counts.json: the typical rush hours per counting point and direction on E- and R-roads, from
Statens vegvesen's Trafikkdata API (hourly vehicle counts, NLOD, no login). Run monthly; about 15 minutes.

For each operational vehicle counting point: the average vehicles per hour for weekdays and for weekends of the last
complete year, per direction. Each direction gets a compass bearing from the road line in NVDB, so a route can tell
which direction it drives through the point. The rush hours are found by rush_hours() below: commuter windows only,
a peak of at least 1 500 vehicles an hour, and the queue dip kept inside the span. Counts are demand, not speed: in a queue the count falls, so these hours say when a
road is usually busy, and the recorded travel times (record.py) say how many minutes it costs.

  counts.py [--year 2025] [--limit N]
"""
import json, math, os, re, sys, time, urllib.request

API = 'https://trafikkdata-api.atlas.vegvesen.no/'
NVDB = 'https://nvdbapiles.atlas.vegvesen.no/vegnett/api/v4/veglenkesekvenser/'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'data', 'traffic', 'counts.json')
CACHE = os.path.join(os.environ.get('GLETT_TRAFFIC_DIR', '/opt/code/glett-traffic'), 'nvdb-bearings.json')
UA = {'User-Agent': 'glett.no traffic counts (christian@chrzz.no)', 'X-Client': 'glett.no'}
RUSH_SHARE, RUSH_RATIO, RUSH_MIN = 0.75, 1.25, 1500
WINDOWS = [(6, 9), (14, 17)]   # commuter windows, hours starting 06–09 and 14–17


def rush_hours(wd, we):
    """the usual weekday rush hours of one direction: within each commuter window, from the first to the last hour at
    75 % or more of the busiest weekday hour, the hours between included (in a queue the count dips at the worst hour,
    so the dip must not split the rush). Only when the direction carries at least 1 500 vehicles an hour at its peak and
    the window is at least 1.25 times as busy as at weekends (the commuter signature)."""
    peak = max(wd)
    if peak < RUSH_MIN: return []
    out = []
    for a, b in WINDOWS:
        hs = [h for h in range(a, b + 1) if wd[h] >= RUSH_SHARE * peak]
        if not hs: continue
        span = list(range(min(hs), max(hs) + 1))
        if sum(wd[h] for h in span) >= RUSH_RATIO * max(1, sum(we[h] for h in span)): out += span
    return out


def gql(q, tries=3):
    for k in range(tries):
        try:
            r = urllib.request.Request(API, data=json.dumps({'query': q}).encode(), headers={'Content-Type': 'application/json', **UA})
            return json.load(urllib.request.urlopen(r, timeout=60))
        except Exception:
            time.sleep(5 * (k + 1))
    return {}


def bearing_at(seq, pos, cache):
    """compass bearing (0 = north) of the road line in its own link direction at relative position pos"""
    key = f'{seq}:{round(pos, 4)}'
    if key in cache: return cache[key]
    b = None
    try:
        j = json.load(urllib.request.urlopen(urllib.request.Request(NVDB + str(seq), headers={'Accept': 'application/json', **UA}), timeout=60))
        for v in j.get('veglenker', []):
            if v.get('sluttdato') or not (v['startposisjon'] <= pos <= v['sluttposisjon']): continue
            xy = [tuple(map(float, p.split()[:2])) for p in re.search(r'\((.*)\)', v['geometri']['wkt']).group(1).split(',')]
            f = (pos - v['startposisjon']) / max(1e-9, v['sluttposisjon'] - v['startposisjon'])
            seg = [math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) for i in range(1, len(xy))]; tot = sum(seg) or 1; acc = 0; i = 1
            while i < len(xy) - 1 and acc + seg[i - 1] < f * tot: acc += seg[i - 1]; i += 1
            a, c = xy[max(0, i - 1)], xy[i]
            b = round((math.degrees(math.atan2(c[0] - a[0], c[1] - a[1])) + 360) % 360)   # UTM grid: x east, y north
            break
    except Exception:
        b = None
    cache[key] = b
    return b


def hours(rows):
    out = [0] * 24
    for h in rows or []:
        if h.get('volume') and h['volume'].get('average') is not None: out[int(h['startOfHour'][:2])] = round(h['volume']['average'])
    return out


def rerule():
    """apply the current rush rule to the stored profiles, without fetching again"""
    doc = json.load(open(OUT))
    for p in doc['pts']:
        for d in p[5]: d[4] = rush_hours(d[2], d[3])
    doc['rule'] = {'share': RUSH_SHARE, 'ratio': RUSH_RATIO, 'min': RUSH_MIN, 'windows': WINDOWS}; doc['v'] = time.strftime('%Y-%m-%dT%H:%M')
    json.dump(doc, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('rerule:', sum(1 for p in doc['pts'] for d in p[5] if d[4]), 'directions with rush hours')


def main():
    if '--rerule' in sys.argv: rerule(); return
    year = int(sys.argv[sys.argv.index('--year') + 1]) if '--year' in sys.argv else time.localtime().tm_year - 1
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    pts = gql('{ trafficRegistrationPoints(searchQuery: {roadCategoryIds: [E, R], isOperational: true}) { id name trafficRegistrationType location { coordinates { latLon { lat lon } } roadReference { shortForm } roadLinkSequence { roadLinkSequenceId relativePosition } } direction { fromAccordingToRoadLink toAccordingToRoadLink } } }')['data']['trafficRegistrationPoints']
    pts = [p for p in pts if p['trafficRegistrationType'] == 'VEHICLE'][:limit]
    out, nodata, nodir = [], 0, 0
    q = '{ trafficData(trafficRegistrationPointId: "%s") { volume { average { hourOfDay { wd: byYear(year: %d, dayType: WEEKDAY) { byDirection { heading total { startOfHour volume { average } } } } we: byYear(year: %d, dayType: WEEKEND) { byDirection { heading total { startOfHour volume { average } } } } } } } } }'
    for n, p in enumerate(pts):
        j = gql(q % (p['id'], year, year)); hod = (((j.get('data') or {}).get('trafficData') or {}).get('volume') or {}).get('average', {}).get('hourOfDay') or {}
        wd, we = (hod.get('wd') or {}).get('byDirection') or [], {d['heading']: d for d in ((hod.get('we') or {}).get('byDirection') or [])}
        if not wd: nodata += 1; continue
        loc, dr = p['location'], p['direction'] or {}
        lb = bearing_at(loc['roadLinkSequence']['roadLinkSequenceId'], loc['roadLinkSequence']['relativePosition'], cache) if loc.get('roadLinkSequence') else None
        dirs = []
        for d in wd:
            h_wd, h_we = hours(d['total']), hours((we.get(d['heading']) or {}).get('total'))
            if not any(h_wd): continue
            b = None if lb is None else lb if d['heading'] == dr.get('toAccordingToRoadLink') else (lb + 180) % 360 if d['heading'] == dr.get('fromAccordingToRoadLink') else None
            if b is None: nodir += 1
            dirs.append([d['heading'], b, h_wd, h_we, rush_hours(h_wd, h_we)])
        if dirs: out.append([p['id'], p['name'], round(loc['coordinates']['latLon']['lat'], 5), round(loc['coordinates']['latLon']['lon'], 5), re.sub(r'^(EV|RV)(\d+).*', lambda m: ('E ' if m.group(1) == 'EV' else 'Rv ') + m.group(2), loc['roadReference']['shortForm']), dirs])
        if n % 50 == 0:
            print(f'{n}/{len(pts)} points, {len(out)} with data', flush=True); json.dump(cache, open(CACHE, 'w'))
        time.sleep(0.15)   # be gentle with both APIs
    json.dump(cache, open(CACHE, 'w'))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = {'v': time.strftime('%Y-%m-%dT%H:%M'), 'year': year, 'source': 'Statens vegvesen, Trafikkdata (NLOD)', 'rule': {'share': RUSH_SHARE, 'ratio': RUSH_RATIO, 'min': RUSH_MIN, 'windows': WINDOWS},
           'fields': ['id', 'name', 'lat', 'lon', 'road', [['heading', 'bearing', 'weekday[24]', 'weekend[24]', 'rushHours']]], 'pts': out}
    json.dump(doc, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    rushy = sum(1 for p in out for d in p[5] if d[4])
    print(f'done: {len(out)} points, {rushy} directions with rush hours, {nodata} without {year} data, {nodir} directions without a bearing; {os.path.getsize(OUT) // 1024} KB')


if __name__ == '__main__':
    main()
