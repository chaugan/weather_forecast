#!/usr/bin/env python3
"""Writes tools/wetroad/params.json from the three results: fit.py (the bucket), b1.py (the fixed lags) and check_fi.py.

  tools/wetroad/assemble.py FIT.json B1.json FI.json DATA_summary.json OUT.json

What ships follows the rule in README.md: the bucket only when it passed on both test sets with enough data (fit.py
'success'); otherwise B1, the fitted fixed lags. The block for js/route.js WR is under "WR".
"""
import json, sys, datetime
fit, b1, fi, summ = (json.load(open(f)) for f in sys.argv[1:5])
ship = 'bucket' if fit['success'] else 'B1'
L = lambda d, b: [[d[f'{b}_night'], d[f'{b}_day']]]
bins = ['0.1-0.5mm', '0.5-2mm', '2-5mm', '5-infmm']
WR = {'model': ship, 'rain': 0.1, 'bins': [0.1, 0.5, 2, 5],
      'lag': [[b1['lag_min'][f'{b}_night'], b1['lag_min'][f'{b}_day']] for b in bins],
      'wet': [[b1['wetLag_min'][f'{b}_night'], b1['wetLag_min'][f'{b}_day']] for b in bins],
      'carry': {'moist': [b1['carry_min']['moist_night'], b1['carry_min']['moist_day']], 'wet': [b1['carry_min']['wet_night'], b1['carry_min']['wet_day']]}}
if ship == 'bucket': WR.update({k: fit['values'][k] for k in ('Wmax', 'e0', 'aT', 'aD', 'aG', 'sDay', 'sSun', 'dCond', 'thMoist', 'thWet')}, Gref=fit['Gref'])
m = fit['metrics']
out = {'fitted': datetime.date.today().isoformat(), 'ship': ship,
       'why': ('the bucket passed on both test sets' if ship == 'bucket' else
               'the bucket failed the success test (PSS >= B1 + 0.05 and median abs. drying-time error <= 0.8 x B1, on both test sets): ' +
               '; '.join(f"{n}: PSS {m[n]['pss']['model'][0]:.3f} vs B1 {m[n]['pss']['B1'][0]:.3f}, MdAE {m[n]['mdae_min']['model']:.0f} vs B1 {m[n]['mdae_min']['B1']:.0f} min ({'pass' if m[n]['pass'] else 'FAIL'})" for n in ('test_time', 'test_space')) +
               f"; training stations {fit['info']['train']['stations']} (rule: 40), training events {fit['info']['train']['events']} (rule: 1500)"),
       'WR': WR,
       'WR_doc': {'lag': 'minutes after the end of the last rain hour (>= rain mm) that the road counts as wet-or-moist, [bin][night, day]; bin by the spell rain (consecutive rain hours) against bins; day = is_day at the end of that hour',
                  'wet': 'of lag, the minutes it is "wet" (the rest "moist")',
                  'carry': 'after an observed moist/wet road state at a time without rain: minutes until dry, [night, day] at that time (the level stays the observed one: not fitted separately)'},
       'B1': b1, 'bucket_not_shipped' if ship != 'bucket' else 'bucket': {k: fit[k] for k in ('values', 'ci95', 'dropped', 'Gref', 'pisun')},
       'metrics': m, 'fi_check': fi,
       'data': {'source': 'MET Frost, Statens vegvesen road weather stations (road_surface_condition, sum(precipitation_amount PT10M), air_temperature, dew_point_temperature, max(wind_speed_of_gust PT10M), mean(road_surface_temperature PT1M)), 15 Apr - 15 Oct 2022-2026',
                'series_pulled': summ['series_in'], 'series_kept': summ['series_kept'], 'stations_kept': summ['stations_kept'], 'held_out_stations': summ['held_out'],
                'events': summ['events'], 'events_uncensored': summ['uncensored'], 'dropped_series': len(summ['dropped']), 'train': fit['info']['train'], 'sun_radiation_cut': summ['kcut']}}
json.dump(out, open(sys.argv[5], 'w'), indent=1, ensure_ascii=False); print('ship', ship); print(json.dumps(WR))
