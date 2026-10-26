# GlettKit API

GlettKit is the platform-agnostic core of the Glett app: models, networking, cache and the forecast engine. It has no
UI. Every piece mirrors the web code (`js/data.js`, `js/app.js`, `js/icons.js`, `js/omgate.js`, `js/route.js`), and
its doc comment says which file and lines. The engine gives the same numbers as the JS. It was checked against the
web's own functions on live data and on `Tests/GlettKitTests/Fixtures`, with no difference above 1e-9.

User-facing text is never produced here. Results carry **catalog keys** (the `js/i18n.js` names, e.g. `nc.dry.now`,
`hero.verdict.mid`, `cat.rain`) and their values. The UI turns those into strings through L10n.

## Quick start

```swift
import GlettKit

let service = WeatherService.shared                    // or WeatherService(transport:cache:gate:identity:endpoints:)
let oslo = Place.cities[0]                             // Place(id:name:lat:lon:)

let bundle = try await service.forecast(for: oslo)     // cached 1 h per 0.01° cell; force: true = "Refresh" (≤ 1 per 5 min)
let engine = bundle.consensus(settings: ForecastSettings(weighted: true, disabledModels: []),
                              weights: nil)            // reliability weights: any ConsensusWeights, nil = none loaded

if let now = engine.nowSummary() {                     // the now card
    now.temperature                                    // °C, weighted mean
    now.icon                                           // WeatherIcon (asset name = rawValue, e.g. "partly-night")
    now.verdict?.dots                                  // 1...5
    now.verdict?.level.key                             // "hero.verdict.hi|mid|lo"
}
let days = engine.days()                               // 7 × DaySummary
let steps = engine.columns(step: 3).map(engine.step)   // hour table / meteogram: [StepConsensus]

let nc = await service.nowcast(for: oslo)              // NowcastSeries? (MET radar + ring, or the model fallback)
let line = NextGlett.evaluate(nc)                      // "Neste glett": .key ("nc.dry.now", ...) and .time for {h}
let warnings = await service.alerts(for: oslo, lang: "nb")   // [MetAlert]?, most serious first; nil = unavailable
let measured = await service.measuredNow(for: oslo)    // MeasuredNow? (Netatmo via glett.no)
let hits = try await service.search("Bergen", lang: "nb")    // [PlaceHit]; hit.place() -> Place
```

`lang` is always the web's `LANG`: `"nb"` or `"en"`. Use `AppLanguage.resolved()` to get it from the setting.

## WeatherService (actor) — `WeatherService.swift`

| call | returns | web |
|---|---|---|
| `forecast(for: Place, force: Bool = false) async throws` | `ForecastBundle` | `fetchForecast` data.js:176-207 |
| `forecast(lat:lon:force:)` | same | |
| `cachedForecast(for:) async` | `ForecastBundle?`, fresh or stale, no request (widgets, first paint) | |
| `nowcast(for:) async` | `NowcastSeries?` | `fetchNowcast` data.js:703-718 |
| `alerts(lang:) async` | `AlertsResponse?` (all of Norway, cached 10 min) | `fetchAlerts` data.js:746 |
| `alerts(for:lang:) async` | `[MetAlert]?` at the place (Norway only; `[]` none, nil unavailable) | `loadAlerts` + `lmAlertsHere` app.js:2283-2314 |
| `measuredNow(for:) async` | `MeasuredNow?` (`ok == false` with `stations` when too few) | `fetchLocal` data.js:721 |
| `search(_:lang:) async throws` | `[PlaceHit]`, Open-Meteo geocoding (the Været search) | data.js:668 |
| `searchAddresses(_:lang:) async` | `[PlaceHit]` with Kartverket addresses and streets (Kjørevær's search) | route.js:2815 |
| `reverseName(lat:lon:lang:detailed:) async` | `String?` from glett.no (fallback after CLGeocoder) | data.js:672 |
| `sweepCache() async` | drops cache files expired more than `CacheKey.staleKeep` (7 days) ago (call once per launch) | `cacheSweep` |

Concurrent `forecast` calls for the same cell share one fetch. A failing MET/Yr leaves Yr out and is not an error.
Errors are `GlettError` (below).

`ForecastBundle`: `forecast`, `fetchedAt`, `expiresAt`, `fromCache`, `needsAutoRefresh(now:)` (older than
`autoRefreshInterval` = 30 min, `AUTO_REFRESH_MS`), and `consensus(settings:weights:now:) -> ConsensusEngine`. It has a public
memberwise `init(forecast:fetchedAt:expiresAt:fromCache:)` for previews, widgets and tests.

## Models — `Models/`

- `Place { id, name, lat, lon }`: Codable, Hashable. `Place.cleaned(name:lat:lon:)` = the web's `clean()`.
  `placeKey`, `inNorway`, `Place.cities`.
- `PlacesFile`: the web's export/import format. `PlacesFile.parse(data) -> (places, file)` and
  `PlacesFile(locations:routes:camps:)` for export. `routes` and `camps` pass through as `JSONValue`.
- `Forecast`: `lat, lon` (rounded 0.01°), `timezone`, `timeZone`, `utcOffsetSeconds`, `elevation`, `generated`,
  `time: [String]` (local `"YYYY-MM-DDTHH:MM"`), `times: [Date]`, `providers`, `isDay: [Double]`, `dates: [String]`,
  `uniqueProviders`. `prepare()` / `prepared()` = app.js `prepare()`. It encodes and decodes in **the web's JSON shape**
  (`utc_offset_seconds`, `hourly.temperature_2m`, …). A recorded web `data` object decodes directly and is prepared.
- `Provider { id, name, hourly: Hourly, dupOf: String? }`. `nameKey` = `"mn.<id>"`.
- `Hourly`: `hourly[.temperature2m] -> [Double?]`, `hourly.code` (the model's code, or the derived one).
- `HourlyVariable`: the 12 variables in `VARS` order, raw values = Open-Meteo names.
- `ModelCatalog`: `openMeteoModels` (13, `MODELS`), `verifyModels` (`VERIFY_MODELS`), `yrID`, `names`, `allIDs`,
  `headlineIDs`.
- `WeatherCategory`: `clear partly cloudy fog drizzle rain snow thunder`; `init?(code:)`, `representativeCode`,
  `key` (`cat.<x>`), `WeatherCategory.verification(code:)` (= `vcat`, drizzle merged into rain).
- `WeatherIcon`: the 14 icon names. `init?(code:night:)` keeps the web's order (66/67 → sleet, 65/82 → heavy rain
  first). `init(category:night:)`. `rawValue` = the asset name in `Shared/Assets.xcassets/Weather`.
- `AlertsResponse { updated, alerts: [MetAlert] }`, `here(lat:lon:)`. `MetAlert`: `name, level, type, area, desc,
  instr, cons, from/to (+ fromDate/toDate), web, geometry, levelRank, symbol`. `GeoJSONGeometry.contains(lat:lon:)`,
  `.bbox`.
- `NowcastSeries { series: [NowcastPoint{t, rate}], ring: [Ring{dir, series}], km, model, fetched }`. `t` is unix
  seconds and `rate` is mm/h, as on the web.
- `MeasuredNow`: the `api/netatmo.php` shape (`temp.v`, `hum.v`, `rain.mm_1h`, `wind.kmh`, `pts`, …) plus
  `feelsLike` and `rainState` (`.mm/.some/.none` → `local.rain.mm|some|none`).
- `MetarResponse`, `FrostTruth`, `NetatmoHistory`: the verification inputs from glett.no.
- `PlaceHit { name, sub, lat, lon, cc, kind: .place|.addr|.street|.name, rank }`, `placeName`, `place()`.
- `GlettError`: `.network(host)`, `.quota(host, limit: .minute|.hour|.day)`, `.http(host, status, reason)`,
  `.upstream(host)`, `.importFormat`. Show `verbatim` when it is non-nil. Otherwise use `l10nKey` (`err.network`,
  `err.quota`, `om.hour`, `om.day`, `err.upstream`, `err.import`) with `l10nArgs` (`host`, `s`).

## Engine — `Engine/`

`ConsensusEngine` is a value type. Build one per render with the current time:
`ConsensusEngine(forecast:disabled:weighted:weights:now:)`. Its `providers` are the active ones
(`activeProviders()`: unique, not disabled, never empty). `nowIndex`, `todayIndex`, `uniqueCount`.

Columns: `engine.columns(step: 1|3|6|12, day: Int? = nil) -> [StepColumn]`. A `StepColumn` has
`a, b, day, first, label, hour, past, now, night, start`. `label` is `"HH:MM"` or `"HH–HH"` like the web.

Per column (all weighted, with the short-range boost for `metno_seamless`/`yr`, unless noted):

| function | meaning |
|---|---|
| `weatherShares(c) -> [CategoryShare]?` | most likely weather, largest first. Ties keep the provider order. |
| `rainChance(c)` | share with ≥ 0.2 mm |
| `precipitation(c)` | mean mm |
| `temperature(c)`, `feelsLike(c)`, `wind(c)`, `gustMean(c)` | weighted means (°C, km/h) |
| `mean(.cloudCover, c)` etc. | any variable, with its own weight key |
| `direction(c)` | unweighted circular mean of the models' directions |
| `windChance(c)` | share with mean wind ≥ 30 km/h |
| `gustShare(c)` | **unweighted** share with gust ≥ 60 km/h (the web shows `round(× 100)`) |
| `thunderChance(c)`, `thunderSignal(p, c)` | storm signal 1 / 0.5 / 0 |
| `agreement(.temperature2m, c) -> Int?` | `round(clamp(1 − sd/TOL) × 100)`, unweighted, nil below 2 models |
| `spread(v, c)` | population sd |
| `values(param, c)` | the active models' raw step values (for min–max) |
| `step(c) -> StepConsensus` | all of the above at once |
| `verdict(c) -> Verdict?` | `category, share, level, dots, agreeing (k), total (n), temperatureMin/Max` |

The whole picture:

- `nowColumn()`, `nowSummary() -> NowSummary` (the now card: temp, feels, wind, gust, direction, verdict, icon,
  `showsFeelsLike`)
- `days() -> [DaySummary]` (category, high, low, rainChance ≥ 1 mm, precipitation, thunderChance, gust, restOfDay,
  isDry)
- `todayOutlook() -> TodayOutlook` (the rain line `.dry/.restOfDay/.from/.chance` with `.key`, and the gust line
  with `timeOfDayKey`)

Low level: `StepAggregation.aggregate(provider, .precip|.gust|.cape|.code|.dir|.mean(v), a, b)`,
`StepAggregation.circularMean`, `WeatherCode.derive(hourly, i)`, `FeelsLike.steadman(t, windKmh:rh:)`,
`ConsensusEngine.dayCategory(codes)`, and `pairs/wmean/wshare/wsum` for anything not listed here.

Constants, named after the JS: `ConsensusEngine.tolerance` (`TOL`), `rainThreshold`, `windThreshold`,
`gustThreshold`, `strongGust`, `shortBoostHours`, `shortBoostMax`, `shortBoostIDs`.

**Weights.** `protocol ConsensusWeights: Sendable { func weight(model: String, key: WeightKey) -> Double? }`.
`WeightKey`: `weather, temperature_2m, precip, wind, storm, cloud_cover, relative_humidity_2m, pressure_msl`. A
missing, nil, 0 or NaN weight counts as 1, as `W()`'s `|| 1` does. `UniformWeights()` and
`WeightTable([model: [key: w?]])` are provided. The verification agent's result should conform to
`ConsensusWeights`, or be turned into a `WeightTable` (the shape of `verify.models[id].weights`).

**Nowcast** (`NowcastEngine.swift`):

- `NextGlett.evaluate(nc, now:)` gives the "Neste glett" line: `kind` (`.wetUntil(Date)`, `.wetAll`,
  `.dryUntil(Date)`, `.blip(Date)`, `.dryAll`), `key`, `time`, `wetNow`, `model`. The label key is `nc.label`. The
  source key is `nc.src` or `nc.src.model`.
- `NowcastHere.evaluate(nc, now:)`: the 90-minute line (`lm.radar.here.*`), with `flip`.
- `RadarStrip.make(nc, now:)`: the bars, `top` scale, `total`, `status`, `nearby: RadarNearby?`.
  `RadarStrip.intensity(rate)`, `wordKey(rate)`.
- `RadarBadge.badge(for: column, nowcast:, rainChance:)` returns `.rain(mm)` / `.dry` / nil.

Formatting like the web: `JS.fmt(v, d)` is the web's `fmt` (`toFixed`, "-0" → "0", "–" for nil). Use it where the
web prints with `fmt`. `WindUnit.value(kmh)` is `wv()`.

## Networking — `Net/`

- `HTTPClient(transport:gate:identity:)` is `getJson` with the web's error mapping. Open-Meteo hosts go through the
  `RateGate`. `api.met.no` and `glett.no` get `User-Agent: Glett-iOS/<version> (+https://glett.no; mail@hauganmg.no)`,
  and `glett.no` also gets `X-Glett-Client: ios/<build>`. `json(_:_:)`, `data(_:)`, `send(_:headers:)`.
- `HTTPTransport` protocol (`URLSession` conforms). Inject a stub for tests.
- `ClientIdentity(product:version:build:platform:)`. Use `.current` in the app; set `product: "Glett-watchOS"` on
  the watch if wanted.
- `Endpoints.production` holds the base URLs (Open-Meteo forecast, geocoding, historical, archive, MET, glett.no,
  Geonorge). `Endpoints.url(base, path, query)` builds byte-exact URLs, with the query from `JS.qs([(k, v)])`.
- `RateGate` (actor, `.shared`) is OMGate: 500 weight a minute, 429 handling, hour/day limits shared. Use
  `RateGate.weight(url)` and `setWaitHandler { wait in … }` to show `om.wait`.
- `ForecastCache` (actor, `.shared`) keeps files in the App Group's `Library/Caches/Glett` (the user caches folder on
  macOS). `get`, `entry` (with times, stale too), `put(_:_:ttl:)`, `remove`, `sweep` (keeps expired entries 7 days), `mayForceRefresh`. Keys and
  TTLs are in `CacheKey` (`fc:<lat2>:<lon2>` 3600 s, `nc2:` 300 s, `ncm:` 900 s, `alerts:<lang>` 600 s, `nl:` 540/300 s,
  `vf3:<lat1>:<lon1>` 86400 s).
- `OpenMeteoClient`: `forecastURL`, `forecastResponse`, `providers(from:)`, `minutelyURL`, `modelNowcast`,
  `searchURL`, `search`, `cell(x)` (0.01°).
- `METClient` (conforms to `METForecastSource`, so a proxy can replace it): `compactURL` (4 decimals), `compact`,
  `nowcastURL`, `nowcastPoint`, `conditionalGet` (Expires + If-Modified-Since), `yrCode`, `yrProvider`.
- `NowcastClient`: `nowcast(lat:lon:)`, `ringPoints`.
- `GlettAPIClient`: `alerts(lang:)`, `netatmo`, `netatmoMap`, `netatmoHistory`, `metar`, `frostTruth`, `reverse`.
- `PlaceSearch`: `places` (Open-Meteo), `search` (addresses/streets/places), `addresses`, `streets`,
  `namedPlaces` (Kartverket place names), `addressCandidates`, `townCase`. Debounce 350 ms and need 2 characters in
  the UI, as the web does.

## Verification — `Engine/VerificationEngine.swift`, `Models/VerificationResult.swift`, `Net/VerificationService.swift`

The reliability check (`fetchVerify`, js/data.js:209-373), ported unchanged: archived forecasts of the 12
`VERIFY_MODELS` (BOM has no archive) against measured truth over 28 days, per 0.1° cell, cached 24 h (`vf3:`).

```swift
let v = try await WeatherService.shared.verification(for: place)     // VerificationResult (throws, see below)
let engine = bundle.consensus(settings: settings, weights: v)        // VerificationResult is a ConsensusWeights
let stale = await WeatherService.shared.cachedVerification(for: place)   // no request, also expired (widgets, watch)
let entry = await WeatherService.shared.cachedVerificationEntry(for: place)   // with times: weights only if entry.isFresh()
```

- **Truth** (`v.truth`): in Norway (`Place.inNorway`) MET stations via `api/frost.php?truth=1` when it gives ≥ 168
  hours, blended with Glett's Netatmo snapshots (`api/netatmo.php?history=1`, ≥ 24 rows, share 0.3). Otherwise ERA5
  (`archive-api`, 6 days late) blended with METAR (`api/metar.php`, ≥ 48 matched hours, share 0.6). The Frost request
  is retried once, as the web does.
- **Maths** (`VerificationEngine`, pure static functions): `evaluate` (MAE/bias per variable with ≥ 24 pairs, CSI of
  wet hours ≥ 0.1 mm, category accuracy with `vcat`), `skills` (`max(0, 1 − MAE/VTOL)`, precip = CSI with enough rain
  events, code = accuracy), `blendSkills` (`w2·s2 + (1−w2)·s1`), `meanScore` (`round(mean × 100)`), `normWeights`
  (`clamp((skill + 0.15)/mean, 0.5, 1.8)`, 3 decimals). Models whose MAEs sum to < 0.001 are skipped (ERA5 copies).
  Truth rows: `frostRows`, `netatmoRows`, `era5Rows`, `metarRows`. Dates: `VerificationEngine.Window(now:)`.
  `VerificationEngine.result(forecast:truth:frost:netatmo:metar:now:)` builds the whole result from fetched inputs.
  Constants keep the JS names (`windowDays`, `lagDays`, `minObs`, `obsWeight`, `netatmoWeight`, `recentDays`,
  `verifyVars`, `weightMin`/`weightMax`, …).
- **Result** (`VerificationResult`, Codable in the web's JSON shape): `truth` (`.frost`/`.era5`), `start`, `end`,
  `hours`, `recentFrom`, `frost?.stations` (keyed t/w/h/p/c/r), `netatmoHours`, `station` (METAR: id, name, km, elev,
  reports, start, end), `obsWeight`, `models: [id: ModelVerification]`.
  `ModelVerification`: `score`, `score7` (Int 0–100 or nil), `skill`, `mae`, `bias` (`[String: Double]` keyed by
  `VerificationMeasure` raw values; wind in km/h), `csi`, `codeAcc`, `obs` (the METAR/Netatmo figures), `weights`
  (`[String: Double?]` keyed by `WeightKey` raw values; `weather` and `storm` both come from the weather-type skill).
  Typed accessors: `skill(_ VerificationMeasure)`, `weight(_ WeightKey)`.
- **For the reliability table** (js/app.js:506-556): `v.ranked()` (score order, ties in `VERIFY_MODELS` order),
  `v.best(disabled:)` (the "best" marker per measurement), `VerificationResult.scoreLevel(score)` (`hi`/`mid`/`lo`,
  `scoreCls`), `v.weightTable` (a plain `WeightTable` to hand to widgets or the watch). `VerificationMeasure.allCases`
  is the table's column order; `.tolerance` is `VTOL`.
- **Errors**: `GlettError` from the archived-forecast or ERA5 request (show it as the web shows `err.message`), or
  `VerificationError.unavailable` (`l10nKey` = `err.verify`). The web then shows `r.unavailable` with `{e}`.
- `VerificationService` (actor, `.shared`, or `init(http:cache:endpoints:clock:)`) is the same thing without
  `WeatherService`: `verification(lat:lon:force:)`, `verification(for:force:)`, `cachedVerification(lat:lon:)`, `cachedVerificationEntry(lat:lon:)` (WeatherService: `(for:)`),
  `historicalURL`/`archiveURL` (byte-exact web URLs), `cell(x)` (0.1°). Concurrent calls for a cell share one run.

## Settings — `Store/Settings.swift`

`SettingsKey` holds the web's localStorage names: `glett.wind`, `glett.weighted`, `glett.disabled` (JSON array),
`glett.orient2`, `glett.lang`, `glett.theme`, `glett.map`, plus the app's own `glett.step`. Store them in
`UserDefaults(suiteName: AppGroup.identifier)`. The enums are `WindUnit` (`.ms` default, `value(kmh)`, `key`),
`HourView` (`v`/`h`/`m`), `AppLanguage` (`system`/`nb`/`en`, `resolved()`, `dateLocale()`) and `AppTheme`.
`ForecastSettings` holds `weighted, disabledModels, windUnit, step`, with `decodeDisabled`/`encodeDisabled` and
`canDisableAnother(disabled:forecast:)`, the web's "at least one model stays on" rule.

## Tests

`swift test --scratch-path ../build/spm-core` runs the hand-computed engine, JS-helper, URL, gate, cache, Yr, search
and model tests. `GLETT_LIVE=1 swift test --filter LiveTests` is the live Oslo smoke test (Open-Meteo, MET, glett.no,
consensus). `GLETT_LIVE=1 swift test --filter VerificationLiveTests` runs the reliability check live for Oslo.
