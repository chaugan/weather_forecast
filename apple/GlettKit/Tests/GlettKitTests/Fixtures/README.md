# Golden fixtures (web JS → Swift)

These files show what the **website's own JavaScript** produces for recorded API responses. GlettKit's engine
has to give the same results. `apple/scripts/fixtures.mjs` produces them:

```sh
node apple/scripts/fixtures.mjs record          # fetch new raw responses (Open-Meteo + MET, then the reliability runs); rewrites raw/
node apple/scripts/fixtures.mjs record-verify   # re-record only the reliability runs (raw/verify/, manifest.verify)
node apple/scripts/fixtures.mjs                 # (= expect) run the JS on raw/, rewrite expected/  (deterministic)
```

The script contains none of the forecast maths. It loads `js/data.js` and `js/icons.js` whole into a node `vm`
context with a stub browser. It cuts the `js/app.js` code it needs out of the file, by declaration name or by
anchor text, and runs that code unchanged. `expected/sources.json` lists every piece with its `file:line` and
holds a sha256 of each JS file. If a hash no longer matches the current `js/`, the web has changed: run expect
again.

Recorded on **2026-10-25 20:02 UTC**. This is the night the clocks went back in Europe: Oslo had +3600 and London
+0. Tolerances follow brief §12. Shares, chances, means and aggregates must match within **1e-9**. Categories,
icon names, levels, dot counts, integer percentages, `k`/`n`, i18n keys and every index must match **exactly**.
In the JSON a missing value is always `null`, never left out (except `nowcast.model`, see below).

Swift: the folder is copied as a resource (`.copy("Fixtures")`). Load a file with
`Bundle.module.url(forResource: "oslo", withExtension: "json", subdirectory: "Fixtures/expected")`.

## Layout

```
raw/manifest.json            what was fetched: URLs, HTTP status, file names, the fixed 'now'
raw/<slug>.openmeteo.json    Open-Meteo forecast response, byte-for-byte (slugs: oslo bergen tromso finse london)
raw/<slug>.met.json          MET locationforecast 2.0 compact, timeseries trimmed (see below), re-serialised compactly
raw/nowcast/<slug>.<n>.json  every response js/data.js fetchNowcast requested (n = order of arrival; map them by URL)
raw/nowcast/london.0.txt     MET's 422 body for London (outside the radar): the trigger for the Open-Meteo fallback
raw/verify/<slug>.<n>.json   every response js/data.js fetchVerify requested (oslo: Frost + Netatmo; london: ERA5 + METAR)
expected/<slug>.json         per-place expected engine output (with "daily": day cards and today's lines)
expected/nowcast.json        expected nowcast series and sentence logic (recorded + synthetic)
expected/verify.json         what fetchVerify returned for each recorded reliability run
expected/sources.json        { js: {file: sha256}, pieces: {name: "js/app.js:a-b"} }
```

## raw/manifest.json

| field | meaning |
|---|---|
| `format` | 1 |
| `recordedAt` | ISO time of the recording |
| `userAgent` | the UA sent to both hosts: `Glett-iOS/0.1 (+https://glett.no; mail@hauganmg.no)` |
| `forecastNow` | **the fixed 'now'** (unix s) for every forecast fixture: the recording time rounded down to the hour (`2026-10-25T20:00:00Z` = 1792958400) |
| `places[]` | `{slug, name, lat, lon, openMeteo: {url, status, file}, met: {url, status, file, trimmedFrom, kept} \| null}` |
| `nowcast[]` | `{slug, name, lat, lon, now, wet, model, requests: [{url, status, file}]}`. `now` is the fixed 'now' of that nowcast (the recording minute). `requests` lists every URL fetchNowcast asked for, in order of arrival. |
| `verify[]` | `{slug, name, lat, lon, now, truth, requests: [{url, status, file}]}`: one fetchVerify run at `now` (unix s; the window dates follow from it). glett.no URLs are stored absolute (`https://glett.no/api/…`); the web calls them relative. |

`url` is exactly the URL that `js/data.js:184/186` builds (0.01° rounding, `toFixed(4)` for MET), so the Swift URL
builder can be tested against it. Lat/lon in `places` are the inputs before rounding. The MET timeseries were cut to
entries whose time ≤ last hour of the Open-Meteo axis + 6 h. `yrProvider` never reads beyond the axis, so its output
is the same as with the full response.

To rebuild the forecast as the web does: decode `openMeteo.file`. Keep each model in `MODELS` (data.js:29) for which
some variable other than `is_day` is non-null. Missing arrays count as all-null. Append the Yr provider made from
`met.file` (data.js:140-173). Then `prepare()` (app.js:96-113).

## expected/\<slug\>.json

Top level:

| field | type | meaning / JS source |
|---|---|---|
| `format` | int | 1 |
| `place` | `{slug,name,lat,lon}` | |
| `now`, `nowIso` | unix s, string | the fixed 'now' (= manifest `forecastNow`). `Date.now()` returned this for the whole run. |
| `source` | `{openMeteo, met}` | raw file paths relative to `Fixtures/` |
| `data` | object | `lat, lon` (rounded 0.01°), `timezone`, `utc_offset_seconds`, `elevation`, `time[168]` (local `YYYY-MM-DDTHH:MM`), `dates[7]`, `isDay[168]` (0/1). fetchForecast data.js:176-207 + prepare app.js:106-111 |
| `nowIdx` | int | index in `time` of the current local hour, `nowIdx()` app.js:209 |
| `providers[]` | `{id, dupOf, code[168]}` | in the web's order (MODELS order, `yr` last, models with no data dropped). `code` is the hourly weather code: the model's own `weather_code`, or `deriveCode` (app.js:85-94) where that is null; `null` when neither exists. `dupOf` comes from the duplicate signature (app.js:101-105), else `null`. |
| `dupOf` | `{id: firstId}` | the same duplicates as a map (e.g. Tromsø `dmi_seamless → knmi_seamless`) |
| `active` | `[id]` | `activeProviders()` app.js:66-69: providers without `dupOf`, none disabled |
| `yr` | `{var: [168]}` | the Yr provider's hourly series straight from `yrProvider` (data.js:140-173), before `prepare` adds `code`. The 12 Open-Meteo variable names. `apparent_temperature`, `cape` and `is_day` are always null. Wind is in km/h, rounded to 1 decimal. Precipitation is rounded to 2 decimals (6 h blocks /6). `weather_code` comes from `yrCode` (data.js:125-137). |
| `weights` | `{unweighted: null, synthetic: {models: {id: {weights: {key: w}}}}}` | the `state.verify` of each run (see Runs) |
| `heroColumn` | `{step: 1, a}` | the now card's column (app.js:1070): the `now` column, else the first one not past |
| `steps` | `{"1","3","6","12": Step}` | |

### Step

Every array in a step is indexed by **column** `k` = `steps[s].columns[k]`.

| field | meaning / JS source |
|---|---|
| `columns[]` | `columns(step)` app.js:174-195: `{a, b, day, first, label, hour, past, now, night}`. Hours `a..<b` of `time`. `label` is `"HH:MM"` for step 1 and `"HH–HH"` (en dash) for longer steps. `past`/`now` are relative to the fixed now. `night` = `isDay[min(a + floor(step/2), b-1)] === 0`. |
| `boost` | `{metno_seamless: [..], yr: [..]}`: `shortBoost(p, a)` app.js:210-215, i.e. `1 + (1 - (a - nowIdx)/6)` for `0 ≤ a - nowIdx < 6`, else 1. The other providers always get 1. |
| `agg` | `{providerId: {field: [..]}}` for **every** provider, duplicates included. `agg(p, field, a, b)` app.js:121-135. `temperature_2m`, `apparent_temperature`, `wind_speed_10m`, `cloud_cover`, `relative_humidity_2m`, `pressure_msl` are means of the non-null hours. `precip` is a sum (mm per step). `gust`, `cape` and `code` are max. `dir` is the circular mean weighted by wind speed (`circMean` app.js:116-120; weight `wind_speed \|\| 1`). Each value is `null` when the step has no values. Also: `category` = `WI.category(code)` (icons.js:64-75); `icon` = `key(code, columns[k].night)` (icons.js:80-95, one of the 14 names or `null`); `thunder` = the storm signal (app.js:366-372): `1` when a raw code ≥ 95, `0.5` when cape ≥ 1000, `0` otherwise, `null` when the model has neither raw codes nor cape in the step. Only raw `weather_code` counts as "raw" here. The max code may still be a derived one. |
| `agreement` | `{param: [int\|null]}` for `temperature_2m, wind_speed_10m, cloud_cover, relative_humidity_2m, pressure_msl`. This is the integer that `agreementPill(v, TOL[param])` prints (app.js:165-170, 405-407): `round(clamp(1 - sd/TOL) × 100)`. `v` = non-null `agg` values of the **active** providers, **unweighted**. `null` when there are fewer than 2 values. |
| `sd` | `{param: [number\|null]}`: the population sd from app.js:406 (`null` when there are fewer than 2 values) |
| `runs` | `{unweighted: Run, synthetic: Run}` |

### Runs

Both runs set `state.weighted = true`. `unweighted` has `state.verify = null`, so `W()` is 1 for everyone (only the
short-range boost applies). `synthetic` has `state.verify = weights.synthetic`. Those weights are a deterministic
ladder in [0.5, 1.8]. `cma_grapes_global` has no entry and `gfs_seamless.weights.precip` is `0`. `W()`
(app.js:204) is `verify.models[id]?.weights?.[key] || 1`, so **both of those give weight 1**. The weight of a provider
for a column is `W(p, key) × boost[k]` (wpairs app.js:216).

Run fields, each an array over columns:

| field | meaning / JS source |
|---|---|
| `shares` | `[{cat, share}]` sorted by share, descending, or `null`. `weatherShares(c)` app.js:222-227. The category of each active provider's step-max `code`, weight key `weather`. The sort is JS's stable sort, so **ties keep the order in which each category first appears in provider order**. |
| `icon` | `key(CAT_CODE[shares[0].cat], night)`: the consensus icon (app.js:309/321, CAT_CODE icons.js:76) |
| `rainChance` | `rainChance(c)` app.js:228. Weighted share of active providers with `precip ≥ RAIN_THR (0.2)`, weight key `precip`. `null` when nobody has a value. |
| `windChance` | app.js:360. Weighted share with mean `wind_speed_10m ≥ WIND_THR (30)`, weight key `wind`. `null` when nobody has wind. |
| `gustPct` | app.js:362. **Integer** `round(count(gust ≥ 60) / count × 100)`, unweighted, over the active providers' step-max gust. `null` when no provider has gusts. |
| `thunderChance` | app.js:385-387. `wmean` of the `thunder` signals, weight key `storm`. `null` when no provider has a signal. |
| `temp` | app.js:1071 `wmean(wpairs('temperature_2m', agg temperature_2m))` |
| `feels` | app.js:1074 `wmean(wpairs('temperature_2m', agg apparent_temperature))`. The weight key is temperature's. |
| `wind` | app.js:1072 `wmean(wpairs('wind', agg wind_speed_10m))` |
| `gust` | `gustMean(c)` app.js:272 `wmean(wpairs('wind', agg gust))` |
| `precip` | app.js:299 `wmean(wpairs('precip', agg precip))` |
| `dir` | `circMean(dd, dd.map(() => 1))` over the active providers' `agg.dir` (app.js:1072/1079), **unweighted**, `null` when none |
| `verdict` | the five-dot verdict of app.js:1083-1085, computed for every column (the web shows it for `heroColumn` only). `{level: "hi"\|"mid"\|"lo", dots: 1..5, k, n, cat, minT, maxT, min, max}`, or `null` without shares. `level`: top share ≥ 0.8 → hi, ≥ 0.5 → mid, else lo. `dots` = `max(1, round(share × 5))`, read from the aria-label. `k` = `round(share × n)` and `n` = number of active providers (the `{k}`/`{n}` of `hero.verdict.detail`). `minT`/`maxT` = min/max of the active providers' `agg.temperature_2m` (raw). `min`/`max` = the same values as the web prints them: `fmt(v)`, i.e. `toFixed(0)` with `-0` → `0`, as strings. |

All means use `wmean = Σ v·w / Σ w` and all shares use `wshare = Σ w[pred] / Σ w` (app.js:217-219), over providers
whose value is non-null and not NaN.

Rounding: the web rounds with JS `Math.round` (half rounds toward +∞, so `Math.round(-2.5) = -2`) and `toFixed`.
Swift's `.rounded()` rounds half away from zero, which differs for negative halves. Use
`(x + 0.5).rounded(.down)` to match `Math.round`.

### daily

`daily: [{now, nowIdx, todayIdx, runs: {unweighted, synthetic}}]`, evaluated at `forecastNow` + 0, 7 and 15 hours.
Each run is `{days, outlook}`:

- `days[d]` = the values of one day card in renderDays (app.js:890-921), statement for statement:
  `{top, hi, lo, rp, rain, sp, storm, mm, gust, rest, dry}`. `top` is the weighted day category, `rp`/`sp` the
  weighted shares (≥ 1 mm; own thunder code), `rain`/`storm` their rounded percentages, `mm` and `gust` (km/h)
  weighted means, `rest` true when today's rain/thunder/gust count from the current hour on.
- `outlook` = renderSummary's rain and gust lines (app.js:931-953): `{partial, rain, gust}`.
  `rain = {maxP, pct, firstA, firstHour, key, h}` (`key` one of `s.dry`, `s.dry.rest`, `s.rain.rest`,
  `s.rain.from`, `s.rain`; `h` the column label for `s.rain.from`), or null.
  `gust = {g, a, hour, shown, strong, v, tod}`: the strongest gust ahead; `shown` when it reached `STRONG_GUST`, then
  `v` is `fmt(wv(g))` in km/h and `tod` the `s.tod.*` key.

## expected/verify.json

`{format, places: [{place, now, sources: [{url, status, file}], result}]}`. `result` is exactly what
`WEFO.fetchVerify(lat, lon)` (data.js:295-373) returned when `sources` were replayed at `now`, in the shape of the
`vf3:` cache entry (`truth, start, end, hours, recent_from, frost, netatmo_hours, station, obs_weight, models`).
The Netatmo history for Oslo had too few rows to be blended in (`netatmo_hours` 0); the blend is covered by unit tests.

## expected/nowcast.json

```
{ format: 1,
  recorded:  [{ place, now, model, sources: [{url, status, file}], nowcast, evaluations: [Eval] }],
  synthetic: [{ name, now, nowcast, evaluations: [Eval] }] }
```

- `nowcast` is exactly what `WEFO.fetchNowcast(lat, lon)` (data.js:677-718) returned, replayed from `sources`.
  For MET radar it is `{series: [{t, rate}], ring: [{dir, series}], km: 5, fetched}`. `t` is unix s, `rate` is mm/h,
  entries with a null rate are dropped, and `ring` keeps only neighbours that answered with data, in the order
  n, ne, e, se, s, sw, w, nw. The neighbour points are `la + dLat·cos(k·45°)` and `lo + dLon·sin(k·45°)`, rounded to
  3 decimals, with `dLat = 5/111.2` and `dLon = dLat / max(0.2, cos(la))`. For the Open-Meteo fallback (London, where
  MET answers 422) it is `{series, ring: [], km: 0, model: true, fetched}`, with `rate = round(mm × 4, 2)` per
  15 minutes. **`model` is left out (not `false`) for MET radar.** `fetched` is the fixed now.
- Recorded: Bergen, which was raining (wet for all 90 minutes), and London (model fallback, dry).
- Synthetic: 24 five-minute steps from `now` (= `forecastNow`) that cover the sentence cases. Read each case's
  `nowcast.series`. The cases: dry-all, wet-all, starts-at-6, stops-at-8, blip-at-4, wet-one-dry-gap, threshold-edge
  (0.09 / 0.1), late-change-after-90min, past-only, starts-in-past-window. Each case is evaluated at `now` and
  `now + 1500`.
- `Eval = { now, summary, here }`. `now` is what `Date.now()/1000` returned.
  - `summary`: the "Neste glett" line of renderSummary (app.js:955-962), or `null` when there is no series or
    nothing at or after `now − 300`. `{rainingNow, change, changeT, blipT, t: [{key, params}]}`. `change` is the
    `findIndex` result (-1 = none): a flip counts only when the next step agrees or it is the last step. `changeT`
    is `s[change].t` when `change > 0`, `blipT` is the lone wet step when dry. `t[0].key` is one of `nc.wet.now`,
    `nc.wet.all`, `nc.dry.now`, `nc.dry.blip`, `nc.dry.all`. `params.h` is the **unix second** of the time the web
    formats as HH:MM (fmtTime is stubbed to return `ms/1000`). Note that this line looks at the **whole** remaining
    series, not just 90 minutes (see late-change-after-90min).
  - `here`: `lmHereLine()` (app.js:2439-2444), the 90-minute sentence for the Lock Screen and Live Activity:
    `{wetNow, t: [{key, params}]}` or `null`. It looks at the first 19 points from `now − 300` and takes the first
    flip, with no two-step rule. Keys: `lm.radar.here.until`, `.from`, `.on`, `.dry`. `params.h` is a unix second,
    or `""` when there is no flip (that is what the web passes).

## i18n in the fixtures

`t(key, params)` was stubbed to record `{key, params}`. Fixtures therefore carry **catalog keys** (as in
`js/i18n.js`) and their parameters, not text. Times are unix seconds, not formatted strings.

## Re-recording

`record` changes every expected value. Run `expect` after it and commit raw/ and expected/ together. The script sends
the UA above to api.met.no and api.open-meteo.com, makes 5 Open-Meteo forecast requests (about 80 weight units, well under the
500/min gate) and 5 locationforecast requests, plus up to 4 nowcast probes and 11 nowcast requests. The reliability
runs add two historical-forecast requests, one ERA5 archive request and the glett.no Frost, Netatmo and METAR calls
(with `X-Glett-Client: ios/fixtures`). Thunder signal
0.5 (cape ≥ 1000 with no thunder code) did not occur in this recording. All 14 icon names and every category occur.
