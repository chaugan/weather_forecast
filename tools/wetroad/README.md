# Wet road after rain: fitting Kjørevær's drying model

Kjørevær's MC profile counts a road that is still wet after rain (js/route.js, the `WR` block). How long it stays wet is
fitted here on measured road-surface states, not guessed. `params.json` is the result the `WR` block copies.

## Data

- **Frost** (MET Norway): Statens vegvesen road weather stations with `road_surface_condition` (Vaisala: 256 dry,
  512 moist, 1024 wet) and `sum(precipitation_amount PT10M)`, plus air temperature, dew point, gust and road-surface
  temperature, 10-min, 15 April to 15 October 2022-2026.
- **Cloud / sun**: the nearest Frost station within 25 km with cloud cover or global radiation (`frost_pair.php`).
- **Finland** (Digitraffic, external check only): `fi_hist_*.json.gz` (24 h) or the collector's archive (`collect.py`).

## Re-running

The Frost client id lives only in `~/wefo-config.php` on the server; the PHP scripts run there over ssh and print data only.

```sh
S=/path/to/scratch; T=/opt/code/glett/tools/wetroad
ssh -o BatchMode=yes glettno@linweb21.hmg9.webhuset.no 'php -d date.timezone=Europe/Oslo' < $T/avail.php > $S/avail.json   # series + station positions
ssh -o BatchMode=yes glettno@linweb21.hmg9.webhuset.no 'php -d date.timezone=Europe/Oslo' < $T/frost_pair.php > $S/pair.json
python3 $T/prep.py --jobs $S/avail.json $S/jobs.txt
$T/pull.sh $S/jobs.txt $S/frost 3                      # ~770 jobs, about an hour; re-runnable
python3 $T/prep.py --sunjobs $S/jobs.txt $S/pair.json $S/sunjobs.txt $S/sunpairs.json
$T/pull.sh $S/sunjobs.txt $S/sun 2 --sun
python3 $T/prep.py $S/frost $S/sun $S/sunpairs.json $S/avail.json $S/data.npz
python3 $T/fit.py $S/data.npz $S/fit.json               # the bucket: 20 starts, 100 bootstrap resamples (~15 min); [--fi /opt/code/glett-wetroad/fi]
python3 $T/b1.py $S/data.npz $S/fit.json $S/b1.json      # the fixed lags (B1), wet part and carry-over, 200 bootstrap resamples
python3 $T/check_fi.py $S/fit.json $S/fi_hist_YYYYMMDD.json.gz --ana $S/ana --out $S/fi.json   # external check (gauge and MET Nordic analysis rain)
python3 $T/assemble.py $S/fit.json $S/b1.json $S/fi.json $S/data_summary.json $T/params.json
```

Needs numpy, scipy and gcc (the bucket runs in a few lines of C, compiled on first use).

## What ships, and why (fit of 2026-10-07)

The rule (decided before the fit): the bucket ships only if, on both test sets, its Peirce skill score (wet-or-moist vs
dry, post-rain hours) is at least B1's + 0.05 and its median absolute drying-time error is at most 0.8 x B1's, with all kept
terms of the physical sign and enough data (40 stations, 1,500 training events). Otherwise B1, the fitted fixed lags.

Data: 268 station-seasons pulled, 171 kept after the quality check (64 stations), 30,788 rain events (13,417 dried before
the next rain). Train: 36 stations, 2022-2024 (9,578 events). Test "time": the same stations' 2025-2026 (45 stations).
Test "space": 13 stations held out entirely (20 %, by county), every year.

| | PSS model | PSS B1 | PSS B0 | median abs. error model | B1 | B0 |
|---|---|---|---|---|---|---|
| test time | 0.635 | 0.458 | 0 | 58 min | 90 min | 100 min |
| test space | 0.619 | 0.483 | 0 | 75 min | 90 min | 70 min |

The bucket is clearly better at saying whether the road is still wet an hour or more after rain (PSS +0.14 to +0.18), but
on the held-out stations its drying-time error is 0.83 x B1's (the bar is 0.8), its mean error is twice B1's (it sometimes
keeps a road wet all night where it dried), and training had 36 stations (under 40). So **B1 ships**. Dropped bucket terms:
gust (CI holds 0), the sun factor beyond daytime (wrong sign) and the condensation cut (wrong sign).

B1 (minutes after the end of the last rain hour, night / day at that hour; 95 % station-bootstrap CIs in params.json):

| spell rain | wet-or-moist night | day | of which wet, night | day |
|---|---|---|---|---|
| 0.1-0.5 mm | 300 | 90 | 300 | 60 |
| 0.5-2 mm | 360 | 150 | 240 | 120 |
| 2-5 mm | 340 | 180 | 300 | 180 |
| >= 5 mm | 350 | 170 | 300 | 120 |

Carry-over after an observed state (no rain at the time): moist 240 / 60 min, wet 420 / 180 min (night / day).
Day vs night is the strong effect; beyond 0.5 mm the amount hardly matters (the road holds only a film).

External check, Finland, one autumn day (2026-10-06/07, not used in the fit): PSS B1 0.14, bucket 0.36, B0 0 with the
station gauges; with the MET Nordic analysis as the rain (what production uses before departure) B1 0.15, bucket 0.28.

## Collector (proposed, not installed)

Digitraffic keeps 24 h only. `collect.py` saves it twice a day for a later Finnish test set:

    23 5,17 * * * /usr/bin/python3 /opt/code/glett/tools/wetroad/collect.py >> /opt/code/glett-wetroad/collect.log 2>&1
