# Glett for iPhone, iPad and Apple Watch — project brief for the agent workflow

Written 2026-10-25 from a read of the whole repository and of this Mac. This file is the single source of truth for
the agents that build the native app. Read it fully before touching anything. Where it says *verify*, the fact came
from a secondary source and must be checked against Apple's documentation or the live service before code depends on it.

The repository is **public** (MIT). Nothing that is a secret may ever be committed: no API keys, tokens, passwords,
certificates, provisioning profiles, App Store Connect keys or push keys. Section 11 says exactly what may and may not
go into git.

---

## 0. The one-paragraph goal

Build a **native SwiftUI app** (not a web wrapper, not Electron-style, no WKWebView for the UI) that brings Glett's
forecast to iPhone, iPad and Apple Watch, with **Lock Screen and Home Screen widgets**, a **watchOS app with
complications and Smart Stack cards**, a layout that is right on **iPhone Duo** (Apple's foldable, on sale since
2026-10-23), and, for the driving-weather feature *Kjørevær*, **native navigation** (hand-off to Apple Maps first, in-app
turn-by-turn and CarPlay later). The app talks to the same public weather APIs the website does, and to the same PHP
endpoints on glett.no. It stores no user data on any server. It is free, has no ads and no analytics.

---

## 1. What Glett is today (the thing being ported)

Glett (glett.no) is a Norwegian weather site: a plain HTML/CSS/JS single page (no build step) plus small PHP 8
endpoints with a MySQL cache on shared hosting. The README (`/README.md`, 77 KB) describes every feature in detail;
the sections of this brief point into the code so the agents do not have to rediscover it.

Pages and modules:

| Page (menu) | What it does | Code |
|---|---|---|
| **Været** (forecast) | 13 Open-Meteo models + MET Norway/Yr side by side, hour by hour; a "most likely weather" probability row from model agreement, weighted by each model's recent reliability for the place; now card, 7 days, hour table in three views (time down, time across, meteogram); radar nowcast "neste glett"; MET warnings; "measured now nearby" from public Netatmo stations; local maps; location history since 1940 | `js/data.js` (fetching, cache, verification maths), `js/app.js` (UI + consensus), `js/icons.js`, `js/i18n.js` |
| **Kart og steder** | Map, saved places (browser only), export/import | `js/app.js`, `js/ui-kart.js` |
| **Kjørevær** | Weather along a driving route at the time you are there (car / motorcycle, A→B + via points, departure up to 3 days ahead); routes from Statens vegvesen (via `api/route.php`) or Valhalla; weather classes, slippery/gust/dark badges, "when should you drive" scoring over 72 h; DATEX road reports, webcams, Street View; hand-off links to Google Maps, Apple Maps, Waze | `js/kvcore.js` (shared engine), `js/route.js` |
| **Turvær** | Weather along a marked hiking trail; Dijkstra in the browser over static trail tiles (`data/tur/`), DNT walking-time rules, winter/ski mode, avalanche danger | `js/turvaer.js`, `data/tur/` (62 MB) |
| **Leirplass** | Quiet overnight/day stops for car, van, motorhome in NO/SE/FI from static tiles (`data/natt/`), with the night's weather | `js/nattplass.js`, `data/natt/` (54 MB) |

Server endpoints (`api/*.php`, PHP 8, MySQL cache, rate limit 120 requests/min per IP, no CORS headers, no
Origin/Referer/User-Agent checks, no cookies): `alerts`, `datex`, `frost`, `metar`, `met`, `netatmo`, `rain`, `rest`,
`reverse`, `roads`, `route`, `shadow`, `snow`, `streetview`, `tile`, `wind`. All return JSON (`{"error": …}` with
4xx/5xx on failure, `429` + `Retry-After: 60` over the limit). A native client can call every one of them as-is.

Languages: Norwegian bokmål (`nb`) and English (`en`), ~1 440 flat dotted keys per language in `js/i18n.js`.
Design tokens: `css/style.css` lines 2–21 (light and dark). Brand assets: `brand/` (SVG mark, lockups, PNG icons).
Inter font (SIL OFL) is self-hosted on the web; the app should use the system font (San Francisco) for Dynamic Type.

---

## 2. This Mac (verified 2026-10-25)

| Item | State |
|---|---|
| macOS | 26.6.2 (25G83), Apple silicon (arm64) |
| Xcode | **27.0 (27A266a)** at `/Applications/Xcode.app`; Swift 6.4; SDKs iOS 27.0, watchOS 27.0, macOS 27.0, visionOS 27.0 |
| **Xcode 27.1** | **Not installed.** Released 2026-10-15 (build 27A9275, iOS 27.1 SDK). Required for iPhone Duo: edge-to-edge layout on both displays, the iPhone Duo simulator, and App Store Connect accepts 27.1 builds. Installing it is the first task (section 12, WP-0). |
| Simulator runtimes | iOS 26.5 (23F77), iOS 27.0 (24A434). **No watchOS runtime installed** (device types for Apple Watch Series 9–12 and Ultra 4 exist, but no runtime). **No iOS 27.1 runtime**, so no iPhone Duo simulator yet. |
| Simulators present | iPhone 17 / 17 Pro / 17 Pro Max / 17e / Air, iPhone 18 Pro / Pro Max, iPad Pro 11/13 (M5), iPad Air 11/13 (M4), iPad mini (A17 Pro), iPad (A16) |
| Physical devices seen by `devicectl` | "Christian sin iPad", iPad (8th generation, iPad11,6), paired; "fnaskPhone", iPhone 14 Pro Max (iPhone15,3), currently unavailable (not connected). Check which OS each runs before using them as test targets (an iPad 8th gen may not run iPadOS 27 — *verify*). |
| Signing | Three valid identities in the login keychain: *Apple Development*, *iPhone Distribution*, *Developer ID Application*, all for the owner's team. Xcode is signed into the developer account (`~/Library/Developer/Xcode/UserData/Provisioning Profiles` holds 3 profiles). Use **automatic signing**. Get the Team ID with `security find-identity -v -p codesigning` (the 10-character code in parentheses); do not paste it into chat logs needlessly, see section 11 for where it may live. |
| Xcode Cloud | Xcode has Xcode Cloud state (`~/Library/Developer/Xcode/UserData/XcodeCloud`), so Xcode Cloud is an option for CI/TestFlight. |
| CLI tools | Homebrew 7.0.10, node v26.12.1, python3, gh. **Missing:** xcodegen, swiftlint, swiftformat, fastlane, php, docker. |

Commands the workflow may run freely: `xcodebuild`, `xcrun simctl`, `xcrun devicectl`, `swift build/test`, `brew install`
of the dev tools above. Anything that needs the Apple ID password, two-factor codes or the App Store app GUI is a
human step: say so and stop.

---

## 3. Architecture decision

### 3.1 Native, shared core, one repository

- **Language/UI:** Swift 6.4 with strict concurrency, SwiftUI everywhere (iOS, iPadOS, watchOS, widgets). UIKit only
  through small representables where SwiftUI lacks an API (tile overlays on `MKMapView`, Look Around).
- **Minimum deployment:** iOS 26 / iPadOS 26 / watchOS 26. Reasons: Liquid Glass design system, `RelevanceKit` for
  Smart Stack cards on watchOS 26, Live Activities in CarPlay (iOS 26), `ConcentricRectangle`, and the iPhone Duo
  APIs that need the 27.x SDK compile fine against a 26 target with availability checks. iOS 26 covers iPhone 11 and
  later. Do not go lower.
- **Build with Xcode 27.1 / iOS 27.1 SDK** (iPhone Duo edge-to-edge needs the 27.1 SDK).
- **Monorepo:** the app lives in this repository under `apple/`. It shares the brand, the i18n source of truth and the
  static data with the web, and the data build scripts already commit here. `tools/deploy.sh` and `.htaccess` must
  exclude `apple/` (WP-0).

```
apple/
  project.yml                 XcodeGen spec (the .xcodeproj is generated, and git-ignored)
  Config/
    Shared.xcconfig           bundle id prefix, versions, deployment targets (committed)
    Signing.xcconfig          DEVELOPMENT_TEAM (see §11; may be committed, it is a public identifier)
  GlettKit/                   Swift package, platform-agnostic, no UI
    Package.swift
    Sources/GlettKit/
      Models/                 Forecast, Provider, Place, Consensus, Verification, Alert, Nowcast, Route…
      Net/                    OpenMeteoClient, METClient, GlettAPIClient, RateGate, HTTPCache
      Engine/                 ConsensusEngine (port of app.js §1–410), VerificationEngine (data.js), WeatherCode
      Trip/                   KVCore port (sampling, classes, vote), TrailRouter (Dijkstra), Leirplass tiles
      Store/                  Places (SwiftData), ForecastCache (files in the App Group container), Settings
      L10n/                   Localizable.xcstrings generated from js/i18n.js + Strings helper
    Tests/GlettKitTests/      golden tests against fixtures produced from the JS
  Glett/                      iOS + iPadOS app target
  GlettWidgets/               WidgetKit extension (Home Screen, Lock Screen, StandBy, Live Activity)
  GlettWatch/                 watchOS app (runs without the iPhone app installed)
  GlettWatchWidgets/          watchOS WidgetKit extension (complications + Smart Stack, RelevanceKit)
  Shared/Assets.xcassets      brand colours (light/dark), app icons, weather icons (SVG, preserve vector data)
  scripts/
    i18n-export.mjs           js/i18n.js → Localizable.xcstrings (node)
    icons-export.mjs          js/icons.js → SVG files for the asset catalog (node)
    fixtures.mjs              runs the JS consensus maths on recorded API responses → JSON golden files
    build.sh / test.sh        the exact xcodebuild invocations for CI and for the agents
  README.md                   how to build, run, test, release
```

Bundle identifiers (not secrets): `no.glett.app`, `no.glett.app.widgets`, `no.glett.app.watch`,
`no.glett.app.watch.widgets`. App Group: `group.no.glett.shared`. URL scheme: `glett://`.

### 3.2 Project generation

Use **XcodeGen** (`brew install xcodegen`). `apple/project.yml` is the diffable description of all targets; the
generated `Glett.xcodeproj` is git-ignored and regenerated with `xcodegen generate` in `apple/`. Agents edit
`project.yml`, never the pbxproj. (Tuist is the alternative; XcodeGen is simpler and enough.)

### 3.3 Data layer: who calls what

The web's rule stands: **the heavy lifting happens on the device, each device uses its own API quota**, and the
server stays a thin cache for upstreams that need a secret or forbid direct clients.

| Data | Call from the device | Through glett.no |
|---|---|---|
| Forecast, 13 models | `api.open-meteo.com/v1/forecast` (same URL, same `models=` and `hourly=` as `js/data.js:184`) | – |
| MET Norway / Yr forecast | `api.met.no/weatherapi/locationforecast/2.0/compact` | optional proxy later if traffic grows (MET's terms, §4.2) |
| Radar nowcast | `api.met.no/weatherapi/nowcast/2.0/complete` + 8 ring points (data.js:677–718) | – |
| Reliability (archived forecasts, ERA5) | `historical-forecast-api.open-meteo.com`, `archive-api.open-meteo.com` | METAR via `api/metar.php`; Frost truth via `api/frost.php?truth=1`; Netatmo snapshots via `api/netatmo.php?history=1` |
| MET warnings | – | `api/alerts.php?lang=nb|en` (site-wide 10-min cache) |
| Measured now nearby, local maps | – | `api/netatmo.php` |
| Reverse geocoding | **`CLGeocoder`** (Apple, free, no quota problems) | `api/reverse.php` only as fallback |
| Place search | `geocoding-api.open-meteo.com/v1/search`, `ws.geonorge.no/stedsnavn/v1/navn`, `ws.geonorge.no/adresser/v1/sok` (same as web) | – |
| History (1940→) | `archive-api.open-meteo.com` (ERA5) | Norway: `api/frost.php` (station series) |
| Routes (Kjørevær) | Valhalla `valhalla1.openstreetmap.de/route` (fallback) | `api/route.php` (Statens vegvesen, credentials stay on server) |
| Road reports, webcams, road surface | – | `api/datex.php`, `api/roads.php` |
| Route weather, rain last 6 h, MET at route points | Open-Meteo multi-location | `api/rain.php`, `api/met.php` |
| Trail / camp / POI / rest / traffic tiles | `https://glett.no/data/...` static JSON with `?v=<index.v>` (formats in §8) | – |
| Map tiles | Kartverket `cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png`, OSM, radar WMS on `thredds.met.no` | `https://glett.no/tiles/fi|se/{z}/{x}/{y}.png` |
| Street View | **Not in the app.** Google's terms forbid it next to a non-Google map; use Apple **Look Around** (`MKLookAroundSceneRequest`) where covered (*verify* Norwegian coverage) | – |

Every request to glett.no and to api.met.no carries `User-Agent: Glett-iOS/<CFBundleShortVersionString> (+https://glett.no; mail@hauganmg.no)`
(the e-mail is already public in `api/config.example.php`). Add `X-Glett-Client: ios/<build>` on glett.no calls so
server logs can tell the app from the web. Never send device identifiers.

### 3.4 Maps

**MapKit everywhere by default.** It is free, native, works on watch, gives Apple Maps hand-off, Look Around and
`MKDirections`. Custom rasters (Kartverket topo, Finnish/Swedish tiles via glett.no, radar WMS frames) are
`MKTileOverlay` subclasses on an `MKMapView` wrapped in `UIViewRepresentable` (SwiftUI's `Map` has no tile overlays —
*verify* for iOS 27). For WMS (radar), override `url(forTilePath:)` to build the bbox URL for the tile.
MapLibre Native is used only if/when in-app turn-by-turn is built with Ferrostar (§7.3), which renders with it.
Not in v1: the 3D terrain, the WebGL sun-shadow (`js/sunshade.js`), the wind-particle map.

### 3.5 Persistence and sync

- Saved places, saved routes, hikes and camps: **SwiftData** in the App Group container (so widgets and the watch
  extension read them). Schema mirrors the web's export format so **import/export of the web's JSON** works
  (`{"glett_locations":1, "exported", "locations":[{name,lat,lon}], "routes":[…], "camps":[…]}`, `js/data.js:618–622`).
- Forecast/verification/history caches: Codable files in the App Group container with the same keys and TTLs as the
  web (`fc:<lat2>:<lon2>` 3600 s, `vf3:<lat1>:<lon1>` 86400 s, nowcast 300 s, alerts 600 s). A single
  `ForecastCache` actor; widgets read the newest cached forecast and only fetch when stale.
- Phone ↔ watch: **WatchConnectivity** (places + settings + the latest forecast for the current place) in v1;
  **CloudKit private database** (SwiftData + CloudKit) as an opt-in sync of places in v2. Both keep user data off
  glett.no, which is a promise the website makes.
- Settings (`@AppStorage` in the App Group): language override (`nb`/`en`/system), theme, wind unit (`ms` default,
  `kmh`), disabled models, "weight by reliability" (default on), hour view, map base.

---

## 4. Rules from the data providers (binding)

### 4.1 Open-Meteo (CC BY 4.0, free tier non-commercial)

- Limits are per IP: 600 calls/min, 5 000/h, 10 000/day; heavy requests count more. Port the browser gate
  `js/omgate.js` (500 weight per 60 s) as `RateGate` and route every Open-Meteo call through it. Treat HTTP 429 and
  "limit/quota" reasons as a `quota` error with a friendly message (data.js:105–118).
- Round coordinates to 0.01° for the forecast cell (0.1° for verification), exactly as the web.
- Show "Weather data by Open-Meteo.com" in the attribution screen and on widgets where space allows.
- The app is free and ad-free, which is the same footing as the website. **Human action:** e-mail
  info@open-meteo.com before App Store release to confirm that a free, ad-free App Store app is fine under the
  non-commercial terms.
- Optional: `&format=flatbuffers` with the official `OpenMeteoSdk` Swift package (depends on FlatBuffers 25.9.23,
  iOS 12+, watchOS 8+) is smaller on the wire. JSON with `Codable` is simpler and is what the web parses. Start with
  JSON; switch only if the watch needs the bandwidth.

### 4.2 MET Norway (api.met.no, CC BY 4.0)

- **Identifying User-Agent is mandatory** (generic/missing UA is blocked on Locationforecast 2.0). Use the UA in §3.3.
- Coordinates truncated to **4 decimals** (5+ gives 403 on newer products).
- Honour `Expires`; send `If-Modified-Since` with the exact previous `Last-Modified`; never fetch while the app is
  not in use; add a random offset to scheduled refreshes; MetAlerts no more than once per 10 min (we use the
  site-wide cache on glett.no anyway).
- 20 requests/s is the total for the whole application, all installs together. Low-volume apps may call directly;
  if the app grows, MET expects a caching proxy. Design `METClient` behind a protocol with a `baseURL` so it can be
  pointed at a future `api/lf.php` proxy on glett.no without UI changes.
- Never use "Yr" in the app name or UI as a brand; credit "MET Norway" (the web shows "MET Norway / Yr" as a model
  name; keep the model name, but no Yr logo).

### 4.3 Others

- Kartverket, Lantmäteriet, Maanmittauslaitos, Open-Meteo, MET: CC BY 4.0 → attribution screen + map attribution.
  OpenStreetMap: ODbL, "© OpenStreetMap contributors". Statens vegvesen NVDB: NLOD. Keep the same credits as the
  web footer (`js/i18n.js` key `footer.html`).
- Valhalla on `valhalla1.openstreetmap.de` is a community demo server: fine for route planning as today, **not** for
  per-second rerouting traffic. In-app navigation (§7.3) must either rate-limit rerouting hard or use a Valhalla the
  owner hosts.
- Nominatim: do not call it from the app at all (CLGeocoder instead).

---

## 5. The forecast engine, specified for the port (GlettKit/Engine)

Port these exactly; the golden tests (WP-1) compare Swift output with the JS output on recorded inputs.

**Fetch (data.js:176–207).** `MODELS` = `ecmwf_aifs025_single, ecmwf_ifs025, gfs_seamless, icon_seamless, gem_seamless, meteofrance_seamless, ukmo_seamless, jma_seamless, cma_grapes_global, bom_access_global, knmi_seamless, dmi_seamless, metno_seamless`.
`hourly=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,pressure_msl,weather_code,cape,is_day`, `timezone=auto`, `forecast_days=7`.
A model is kept only if some variable other than `is_day` is non-null. Yr is converted onto the same hourly axis
(`yrProvider`, data.js:140–173; symbol→WMO code table in `yrCode`, :125–137; wind m/s→km/h ×3.6; 6-hourly precipitation
spread /6; Yr never has `apparent_temperature`, `cape`, `is_day`).

**Duplicate models (app.js:101–105).** Signature = joined `temperature_2m`, `precipitation`, `wind_speed_10m`,
`pressure_msl` arrays; an exact match of an earlier provider marks `dupOf`; duplicates are shown greyed ("Same data
as …") and counted once.

**Derived weather code (app.js:85–94)** when a model has none: precipitation ≥ 0.1 → (cape ≥ 1500 and pr ≥ 1 → 95;
t ≤ 0.5 → 73; pr ≥ 4 → 65; pr ≥ 0.3 → 61; else 51); otherwise cloud cover <20 → 0, <45 → 1, <75 → 2, else 3.

**Categories (icons.js:64–76).** clear ≤1, partly 2, cloudy 3 (fallback), fog 45/48, drizzle 51–57, rain 61–67 and
80–82, snow 71–77/85/86, thunder ≥95. Representative codes `{clear:0, partly:2, cloudy:3, fog:45, drizzle:51, rain:63, snow:73, thunder:95}`.
Verification uses the same table with drizzle merged into rain (data.js:211–222).

**Step aggregation (app.js:121–134)** for 1/3/6/12 h: precipitation sum; gust, cape, code max; wind direction =
speed-weighted circular mean; everything else mean.

**Thresholds (app.js:147–151).** `TOL = {temperature_2m: 4, wind_speed_10m: 15, cloud_cover: 50, relative_humidity_2m: 25, pressure_msl: 4}`,
`RAIN_THR = 0.2` mm/step, `WIND_THR = 30` km/h, `GUST_THR = 60`, `STRONG_GUST = 43`.

**Weights (app.js:203–218).** `W(model,key) = weighted && verify ? verify.models[id].weights[key] : 1`, keys
`weather, temperature_2m, precip, wind, storm, cloud_cover, relative_humidity_2m, pressure_msl`; multiplied by a
short-range boost for `metno_seamless` and `yr`: `1 + (1 − h/6)` for h in [0, 6) hours after now.
`wmean = Σv·w/Σw`, `wshare = Σw[pred]/Σw`.

**Most likely weather (app.js:220–226).** Per active provider, category of the step's max code; weighted share per
category, sorted descending; `shares[0]` is the verdict and its share is the agreement %. Rain chance = weighted
share with precipitation ≥ 0.2; wind chance = weighted share with mean wind ≥ 30 km/h; gust % = unweighted count
with max gust ≥ 60. Agreement for continuous parameters = `round(clamp(1 − sd/tol, 0, 1) × 100)` (population sd, "–"
with <2 values). Thunder signal per provider: 1 if code ≥ 95 (raw code only), else 0.5 if cape ≥ 1000, else 0;
chance = wmean with weight key `storm`.

**Five-dot verdict (app.js:1083–1086).** top share ≥ 0.8 → high, ≥ 0.5 → mid, else low; dots =
`max(1, round(share × 5))`; the sentence says `round(share × nActive)` of nActive models (a weighted share times the
count, not a raw count) plus the min–max temperature across providers.

**Reliability (data.js:295–373).** `WINDOW_DAYS 28, LAG_DAYS 6, MIN_OBS 48, OBS_WEIGHT 0.6, NETATMO_WEIGHT 0.3`;
outside Norway truth = ERA5 (+ METAR if ≥ 48 matched hours, weight 0.6); in Norway truth = Frost hourly (≥ 168 obs)
blended with Netatmo snapshots (≥ 24 rows, weight 0.3). Per model: MAE/bias per variable (≥ 24 pairs), CSI for wet
hours (≥ 0.1 mm), category accuracy; models whose MAEs sum to < 0.001 are skipped (they are copies of ERA5).
Skill = `max(0, 1 − MAE/VTOL)`, precip = CSI (only with enough rain events), code = accuracy; blended
`w2·s2 + (1−w2)·s1`; score = `round(mean × 100)`; weights `clamp((skill + 0.15)/mean(skill + 0.15), 0.5, 1.8)`.
Cache 24 h per 0.1° cell. This can stay phone-only in v1 (the watch and widgets use the phone's cached weights or 1).

**Nowcast (data.js:677–718).** Centre + 8 points 5 km out; series `[{t, rate}]`; fallback outside radar coverage is
Open-Meteo `minutely_15=precipitation&forecast_minutely_15=10&models=best_match` (rate = mm × 4). The "neste glett"
sentence (rain starts/stops within 90 min) is what the Lock Screen widget and the Live Activity show.

**Icons (icons.js:80–95).** 14 names: `clear-day, clear-night, partly-day, partly-night, cloudy, fog, drizzle, rain, heavy-rain, showers-day, showers-night, sleet, snow, thunder`;
mapping order matters (66/67 → sleet and 65/82 → heavy-rain before the general ranges). Night icons on the web draw
the real moon phase; v1 may use a static moon.

**i18n (i18n.js).** Flat keys, `t(key, {name})` with `{name}` placeholders, English fallback, then the key. Generate
`Localizable.xcstrings` with the **same key names** (`apple/scripts/i18n-export.mjs`); keys whose values contain HTML
(`about.html`, `footer.html`, `empty.html`) are rewritten by hand as AttributedString/Markdown. Language follows the
device unless overridden; months/dates via `Locale("nb-NO")` / `Locale("en-GB")`.

---

## 6. Widgets (iOS) — the Lock Screen is a first-class deliverable

Target `GlettWidgets`, families and content:

| Family | Content | Where it shows |
|---|---|---|
| `accessoryInline` | "12° · 11 av 13 for regn · neste glett 14:20" (one line, place name optional) | Lock Screen above the clock, watch (via watch ext) |
| `accessoryCircular` | temperature + most-likely icon, or a gauge of agreement (five-dot → 0–1), or rain-in-90-min countdown | Lock Screen, watch |
| `accessoryRectangular` | place, temp, icon, verdict sentence, nowcast line | Lock Screen, watch Smart Stack |
| `systemSmall` | now card (temp, icon, verdict dots, nowcast) | Home Screen, **StandBy**, CarPlay (iOS 26+) |
| `systemMedium` | now + next 6 h strip with agreement segments | Home Screen |
| `systemLarge` | 7-day list (icon, high/low, rain %, gust) | Home Screen, iPad |
| `systemExtraLargePortrait` (new in iOS 27) | meteogram day view | iPad Home Screen |

Rules:
- `AppIntentConfiguration` with a `Place` parameter (saved places + "Current location"); current location requires
  `NSWidgetWantsLocation` and *When In Use* permission granted in the app.
- Timeline: entries per hour for the next 6 h from the cached forecast; `.after(nextRefresh)` policy with
  `nextRefresh = max(now + 30 min, cache.expires)`. Each reload fetches one Open-Meteo call + one nowcast call at
  most. Respect the daily budget (~40–70 reloads/day); the app calls `WidgetCenter.shared.reloadAllTimelines()` when
  it has fetched fresh data and when it goes to the background.
- Deep links: `glett://place/<id>` and `glett://nowcast/<id>` open the app at the place.
- Attribution: `systemMedium` and larger show "Open-Meteo · MET Norway" in the corner; accessory families do not
  (no room) but the attribution screen in the app covers it.
- Test on an iPhone 17 simulator and on a real iPhone: **the iPhone Duo simulator runtime does not run app
  extensions or StandBy** (Xcode 27.1 release notes), so widgets are tested elsewhere.

**Live Activity "Neste glett" (ActivityKit):** started by the user from the now card when rain is expected to start
or stop within 90 min; shows the countdown and the radar rate curve in the Dynamic Island / Lock Screen; ends when
the event passes. Declare `supplementalActivityFamilies([.small])` for the watch and `.carPlay` for CarPlay
(*verify* the exact case name in ActivityKit for iOS 26+). Updates come from the app's own refresh (no push server
in v1).

**Controls (iOS 18+):** one `ControlWidget` button "Oppdater Glett" is cheap; optional.

---

## 7. The three trip features, and the navigation question

### 7.1 Kjørevær in the app (phase 3)

Port the planning, not the whole page: A → B + up to 8 via, car/motorcycle, departure now … +72 h; routes from
`api/route.php` (Vegvesen) with Valhalla as the fallback (`js/route.js:15–78`); samples every 10 min of driving or
20 km plus pass tops (`route.js:18–19, 362–377`); one Open-Meteo multi-location request, 50 places a call
(`kvcore.js:384–390`); classes `dry, fog, wet, heavy, sleet, snow, ice, thunder` + `damp` (`kvcore.js:430–441`);
flags: gust ≥ 20 m/s car / 13 m/s motorcycle, slippery when −4 < t ≤ 3 and (mm ≥ 0.1 or (t − dew < 1.5 and night)),
drift (snow/sleet, gust ≥ 15, z ≥ 600); the departure score table (`route.js:470–496`); DATEX road reports and
road-surface forecast via `api/datex.php`; MET warnings along the route. Show route cards, the stage list, the chart
(Swift Charts) and the map (MapKit polylines coloured by class). GPX export via `ShareLink`. Share links in the
web's `#kv?…` format (section 7.4 for universal links).

### 7.2 Native navigation: what Apple gives us, and the recommendation

**MapKit has no turn-by-turn guidance API for third-party apps.** `MKDirections` returns routes with step
instructions and geometry, but there is no guided-navigation UI, voice or rerouting from Apple. "Apple's navigation"
for a third-party app means one of three things:

1. **Hand-off to the Maps app** (`MKMapItem.openInMaps(launchOptions:)` with
   `MKLaunchOptionsDirectionsModeDriving`, or the `maps://` URL with multiple stops, supported from iOS 18.4 as the
   web already uses). One tap, zero maintenance, Apple handles guidance, CarPlay and rerouting. Glett's value
   (which route, when to leave, where it is slippery) is delivered before the drive. **Do this in phase 3.**
   To keep Glett's chosen route, pass the same via points the planner used (the web picks via points in the middle
   of long single-road stretches so Maps cannot snap them wrong, `route.js:2683–2688`; reuse that logic).
2. **Glett rides along while Maps navigates:** a **Live Activity "Kjørevær"** on the Lock Screen, Dynamic Island
   and **CarPlay** (Live Activities appear in CarPlay from iOS 26, *verify*) showing the next weather change on the
   route ("Snø fra Hardangervidda ca. 21:40", "Vegvesen varsler glatt føre ved …"), updated from the device's
   position with the already-fetched route weather, no new API calls per update. No CarPlay entitlement needed.
   **Do this in phase 3 as well.** This is the most Glett-like form of "navigation".
3. **In-app turn-by-turn** with the Glett route as the navigated route. Apple does not provide it; use
   **Ferrostar** (BSD, Swift Package `https://github.com/stadiamaps/ferrostar`, iOS beta "ready for production",
   `WellKnownRouteProvider.valhalla(endpointUrl:profile:)`, SwiftUI `DynamicallyOrientingNavigationView`,
   `SpokenInstructionObserver` on `AVSpeechSynthesizer`, renders with MapLibre). It consumes Valhalla routes, which
   Glett already computes, so the weather route and the navigated route are the same. Costs: a second map stack,
   a self-hosted Valhalla for rerouting (the FOSSGIS demo server is not for navigation traffic), and the **CarPlay
   navigation entitlement** (`com.apple.developer.carplay-maps`), which Apple grants on request only to apps with real
   turn-by-turn and takes weeks. **Phase 4+, and request the entitlement at the start of phase 3 so it is there when
   needed.** Alternative with no new dependency: `MKDirections` steps + `CLLocationManager` + `AVSpeechSynthesizer`
   for a minimal guidance mode on Apple's route geometry, but then the navigated road is Apple's, not Glett's.

Recommendation in one line: **phase 3 = Apple Maps hand-off + Kjørevær Live Activity in CarPlay; phase 4 = Ferrostar
in-app navigation if the owner still wants it after seeing phase 3.**

### 7.3 Turvær and Leirplass (phase 4)

- Turvær: port the browser router (`turvaer.js:62–211`): cells of 0.25° × 0.5° (`floor(lat*4)_floor(lon*2)`),
  summer = `g/` + `t/`, winter = `s/`; tile `{e:[[a,b,m,[lat,lon…],[z…],roadFlag]], p:[[node,name,type,lat,lon]]}`;
  snapping within 400 m; Dijkstra with road cost ×1.6 (least) or ×0.6 (most); alternatives with ×10 penalty; profile
  every 100 m; DNT time rule (3.5 km/h + 15 min/100 m up + 5 min/100 m down, ×1.1 breaks, pace 1.25/1/0.8, steep
  factor 1.1/1.25) and the ski rule (4 km/h + 10 min/100 m). Tiles are fetched from `https://glett.no/data/tur/`
  (62 MB in all, 10–60 KB a cell; **never bundle them**, cache on disk, invalidate on `index.json.v`). Node ids
  change with every data build, so saved hikes store coordinates and names, not node ids (the web does the same).
- Leirplass: cells 0.5° × 1° under `data/natt/<cc>/{s,b,a}/`, rows are positional arrays (33 fields for spots; the
  order is in `data/natt/index.json.f` and `nattplass.js:36–94`). MapKit annotations and the list; "Kjør hit" via
  Apple Maps hand-off.
- These two are big; they come after the forecast, widgets, watch and Kjørevær are shipped.

### 7.4 Links between web and app

The web's share links are URL fragments (`https://glett.no/#kv?…`, `#tv?…`, `#np?…`). Universal links match paths,
not fragments, so: add path aliases on the server (`/kv`, `/tv`, `/np`, `/sted` → `.htaccess` rewrite to the
fragment form for browsers), publish `/.well-known/apple-app-site-association` on glett.no (contains the Team ID +
bundle id, which is public information on every site that uses universal links), and let the app claim those paths
(`applinks:glett.no`). The app parses the same query grammar as `route.js:2711–2730`, `turvaer.js:1643–1660`,
`nattplass.js:938–947`. This is a small, owner-approved web change (WP-5); until then the app uses `glett://`.

---

## 8. iPhone Duo

Facts (Apple's "Prepare your app for iPhone Duo" page and Tech Talk 111461, plus press; sizes are *verify*):
5.4-inch outer display, 7.6-inch inner display; poses: closed, open, partially folded ("tent"), each in both
orientations. Built with the iOS 27.1 SDK the app goes edge to edge on both displays; toolbars and tab bars move
vertically beside the status bar in some poses. The iPhone Duo simulator ships with Xcode 27.1 (needs the iOS 27.1
runtime; if it is missing from Device Hub, `xcrun simctl create 'iPhone Duo' <deviceTypeId> <runtimeId>`), and
**StandBy and most app extensions do not run in it**. From April 2027 App Store submissions must include iPhone Duo
screenshots.

Rules for every view in this project:

- Lay out by **size classes and available space**, never by idiom or orientation. Compact-width = phone layout
  (closed Duo, iPhone), regular-width = `NavigationSplitView` with the now card + days in the sidebar and the hour
  views in detail (open Duo, iPad, landscape). The web already has this split (left column / right column on desktop).
- Never read `UIScreen.main`; use `GeometryReader`/`onGeometryChange` and re-layout on every size change (a fold
  resizes the window mid-session).
- Respect **reserved regions**: `GeometryProxy.reservedRegions(kind:options:layoutDirectionBehavior:)` with
  `.division` (the fold) and `.occlusion` (camera). Standard containers adapt by themselves; the meteogram chart and
  the map are custom and must avoid drawing the time cursor or a popup under the fold.
- Use `ArrangementView` (iOS 27.1) for map + chart in Kjørevær/Turvær so the two halves land on either side of the
  fold in the tent pose; `onHingeChange` to switch to that arrangement when `hinge.status == .partiallyOpen`
  (*verify* names against the 27.1 SDK headers once installed).
- Fill modes on hero images lose content on the wider inner display; the weather icon header must `fit`, not `fill`.
- Test matrix per PR: iPhone 17 (compact), iPad Air 11 (regular), iPhone Duo closed/open/tent/landscape.

---

## 9. Apple Watch

Target `GlettWatch` (SwiftUI, watchOS 26+, **runs without the iPhone app**, so URLSession on the watch fetches
Open-Meteo and MET itself when the phone is away) + `GlettWatchWidgets`:

- App: a page per saved place (TabView vertical) with the now card (temp, icon, verdict dots, nowcast sentence),
  next 12 hours as a list, 7 days compact, MET warning banner. Places come from the phone over WatchConnectivity;
  with no phone, "Min posisjon" via CoreLocation.
- Complications/widgets: `accessoryCircular`, `accessoryRectangular`, `accessoryInline`, `accessoryCorner`
  (temperature + icon, nowcast countdown, agreement gauge).
- **Smart Stack relevance (watchOS 26 RelevanceKit):** a `RelevanceConfiguration`/`RelevanceEntriesProvider`
  widget whose cards appear when rain starts within 90 min at the current place, when a MET warning is in force
  there, and at the departure time of a planned Kjørevær trip (`RelevantContext.date`, `.location`; *verify* API
  names). This is the watch's "neste glett".
- Background refresh: `WKApplicationRefreshBackgroundTask` scheduled ~every 30–60 min while there are saved places,
  with a jitter (MET rule), reusing the shared cache keys.
- Simulator: install the watchOS runtime first (`xcodebuild -downloadPlatform watchOS`), then pair an
  Apple Watch Series 12 (46mm) with an iPhone 17 Pro in Device Hub / `xcrun simctl pair`.

---

## 10. Design

- Liquid Glass system components, SF Pro with Dynamic Type, SF Symbols for UI chrome; **Glett's own weather icons**
  (exported from `js/icons.js` as SVG into the asset catalog, "Preserve Vector Data") for the weather itself, so the
  app looks like glett.no.
- Colours from `css/style.css` as asset-catalog colours with light/dark variants: accent `#2563eb` / `#5b9bff`,
  bg `#f3f6fb` / `#0d1420`, panel `#ffffff` / `#151f2f`, text `#16202e` / `#e6edf7`, muted `#64748b` / `#94a3b8`,
  good `#16a34a`, mid `#d97706`, bad `#dc2626`, rain `#3b82f6`, snow `#7dd3fc`, bolt `#f59e0b`, sun `#f5b301`.
- The verdict language is Glett's: "Modellene er enige · 13 av 13 modeller for klarvær · temperatur 6–10°". The
  probability row comes first; individual models behind "Vis alle modeller". Agreement bars are segmented by category.
- The app says, as the web does, that the probabilities measure model agreement and are not an official forecast,
  and the trip pages are not a safety verdict.
- App name "Glett". **Human action:** check in App Store Connect that the name is available in the Norwegian and
  worldwide storefronts; fallback "Glett – et glimt av været".

---

## 11. Secrets, privacy and what may be in git

**Never in the repository:** `.p12`/`.cer` certificates, `.mobileprovision` profiles, App Store Connect API keys
(`AuthKey_*.p8`), APNs keys, `ExportOptions.plist` with signing details, any `*.xcconfig` or `*.plist` that carries a
key or token, `~/.config/*`, Keychain exports, `fastlane/*` with credentials, `.env`. Add these to `.gitignore` in
WP-0 (`apple/*.xcodeproj`, `apple/build/`, `apple/DerivedData/`, `apple/**/xcuserdata/`, `*.p12`, `*.p8`,
`*.mobileprovision`, `apple/Config/*.local.xcconfig`).

**May be in the repository:** bundle identifiers, the App Group id, the URL scheme, `project.yml`, entitlements
files, the Team ID (`DEVELOPMENT_TEAM`) — it is a public identifier that already appears in every
`apple-app-site-association` file on the web, and Apple does not treat it as a secret. If the owner prefers, keep it
in `apple/Config/Signing.local.xcconfig` (git-ignored) with a committed `Signing.example.xcconfig`; the build scripts
accept `DEVELOPMENT_TEAM` from the environment too.

**The app needs no client-side API key at all.** Every upstream that needs a secret (Frost, Netatmo, Vegvesen,
DATEX, Google, Trafikverket, NLS, Lantmäteriet) is reached through glett.no, where the secret already lives outside
the web root. Do not add any SDK that requires a key (no analytics, no crash SDK with a token; use Xcode Organizer
crash reports and MetricKit).

**Privacy:** `PrivacyInfo.xcprivacy` with location "App Functionality", no tracking, no required-reason APIs beyond
`UserDefaults` (App Group) and file timestamps. `NSLocationWhenInUseUsageDescription` and
`NSWidgetWantsLocation` strings in NB and EN. The privacy page `privacy.html` is extended with an app section
(what the device sends to Open-Meteo, MET, Kartverket, glett.no; nothing is stored server-side). App Privacy labels
in App Store Connect: Location (not linked to identity, app functionality), no other data.

**The one hard-coded credential in the repo** (`tools/camp/thl.py:11`, Skogsstyrelsen's publicly published FTP
login) is pre-existing, documented as public by its comment, and unrelated to the app. Do not copy the pattern.

---

## 12. Work packages (for the workflow)

Each package names its deliverable, how it is verified, and what is a human step. Packages are ordered; later ones
depend on earlier ones. A package is done only when its verification passes on this Mac.

**WP-0 Bootstrap (half a day).**
- Human: install **Xcode 27.1** (App Store app or developer.apple.com downloads; needs the Apple ID), then
  `sudo xcode-select -s /Applications/Xcode.app` (or the versioned path). Agents: `xcodebuild -version` must say 27.1.
- `xcodebuild -downloadPlatform iOS` (27.1 runtime, brings the iPhone Duo simulator) and
  `xcodebuild -downloadPlatform watchOS`. Verify with `xcrun simctl list runtimes` and
  `xcrun simctl list devicetypes | grep -i duo`.
- `brew install xcodegen swiftlint swiftformat`.
- Create the `apple/` layout of §3.1, `project.yml`, `GlettKit` package, empty app/widget/watch targets, shared
  scheme, `scripts/build.sh` (`xcodebuild -project apple/Glett.xcodeproj -scheme Glett -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`)
  and `scripts/test.sh`. All targets build for simulator with automatic signing.
- Web repo touchpoints: `tools/deploy.sh` gets `--exclude apple/`; `.htaccess` denies `apple/` like `docker/`;
  `.gitignore` additions from §11. Commit style follows the repo ("iOS: …", "Watch: …", "GlettKit: …", one sentence
  saying what changed and why).

**WP-1 GlettKit core + golden tests (2–3 days).**
- `OpenMeteoClient`, `METClient`, `GlettAPIClient`, `RateGate`, `HTTPCache` (ETag/If-Modified-Since), models.
- `ConsensusEngine`, `WeatherCode`, `Nowcast`, `VerificationEngine`.
- `apple/scripts/fixtures.mjs`: run the pure JS functions of `js/app.js`/`js/data.js`/`js/icons.js` under node on
  recorded Open-Meteo + MET responses for Oslo, Bergen, Tromsø, Finse (mountain) and one place abroad (London), and
  write `GlettKitTests/Fixtures/*.json` with inputs and expected outputs (shares, chances, agreement, verdict,
  icons, step aggregation at 1/3/6/12 h). The JS files are browser globals; load them in a `vm` context with a stub
  `window`/`document`/`localStorage` and pull the functions out. Swift tests must reproduce them exactly (floating
  tolerance 1e-9 on shares, exact on categories, icons and dot counts).
- `i18n-export.mjs` → `Localizable.xcstrings` (nb, en), checked in; a CI check fails when `js/i18n.js` has keys the
  catalog lacks.
- `icons-export.mjs` → 14 SVGs in the asset catalog.
- Verify: `swift test` in `apple/GlettKit` green; `swiftlint` clean.

**WP-2 iPhone + iPad app, forecast (1 week).**
- Places (search, Min posisjon, saved places with SwiftData, web JSON import/export), now card, verdict, 7 days,
  hour table (time down / time across) and meteogram (Swift Charts) with 1/3/6/12 h steps, model list with
  enable/disable and reliability scores, settings (wind unit, weighting, language, theme), attribution screen,
  MET warnings, nowcast sentence, radar map (MapKit + WMS tile overlay, frames by opacity), measured-now line.
- `NavigationSplitView` for regular width; compact layout for phones; all §8 rules.
- Verify: builds and runs on iPhone 17 Pro, iPad Air 11, iPhone Duo (closed/open/tent); screenshots saved to
  `apple/docs/screens/` by `xcrun simctl io booted screenshot`; no `UIScreen.main` in the code base (`grep`);
  SwiftUI previews for every card.

**WP-3 Widgets + Live Activity (3 days).** §6. Verify in the widget gallery on iPhone 17 Pro simulator and on the
owner's iPhone over TestFlight (human: install TestFlight build); lock-screen families render in light/dark and
tinted mode; timeline reload count stays within budget over 24 h (log).

**WP-4 Watch (4 days).** §9. Verify on a paired Series 12 simulator (standalone fetch when the phone simulator is
shut down), complications in the gallery, Smart Stack card appears with a simulated location/time.

**WP-5 Web touchpoints (1 day, owner approves the diff).** Path aliases + AASA for universal links (§7.4);
`privacy.html` app section; optional `api/app.php?v=` returning `{minVersion, message}` so a broken release can be
told to update (no secrets, static JSON is fine too).

**WP-6 Kjørevær (1–2 weeks).** §7.1 + §7.2 options 1 and 2. Human: request the CarPlay navigation entitlement now
if phase 4 is wanted. Verify: Oslo–Bergen and Trondheim–Bodø routes match the web's cards (stage times, classes,
badges) within rounding; hand-off to Apple Maps keeps the via points; the Live Activity shows in CarPlay simulator
(Xcode → I/O → External Displays → CarPlay).

**WP-7 Turvær, Leirplass, Historikk, local maps (phase 4, scoped later).** §7.3; history charts (Swift Charts);
Netatmo temperature field as an `MKOverlayRenderer`.

**WP-8 Release.** App Store Connect record "Glett" (human), screenshots for iPhone 6.9", iPad 13", iPhone Duo
(required from April 2027), App Privacy labels, review notes explaining the data sources and that probabilities are
model agreement. TestFlight first. Distribution via `xcodebuild -exportArchive` with automatic signing on this Mac,
or Xcode Cloud; the App Store Connect API key for any CI lives in the Keychain or `~/.config/glett-apple/`, never
in the repo.

---

## 13. Conventions for the agents

- Swift 6 language mode, strict concurrency, `actor` for caches and the rate gate, `Sendable` models, no
  `@unchecked Sendable` without a comment saying why.
- One SwiftUI view per file; previews with fixture data from `GlettKitTests/Fixtures`.
- Strings only through the catalog; no literal user-facing text in views. Norwegian is the primary language; English
  must be complete too.
- Keep key names, constants and function names close to the JS (`RAIN_THR` → `Consensus.rainThreshold` with a doc
  comment pointing at `js/app.js:148`) so a change on the web can be mirrored by grep.
- Never commit generated `.xcodeproj`, build products, or anything in §11's never-list. Run
  `git diff --cached --name-only | grep -E '\.(p12|p8|mobileprovision|cer)$'` as a pre-commit guard.
- Do not change the web app's behaviour. Allowed web-side edits are the ones listed in WP-0 and WP-5 only; anything
  else is proposed to the owner in a short note.
- When an Apple API name in this brief is marked *verify*, confirm it in the installed SDK (`grep -r` in
  `/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/*/Modules/*.swiftinterface`
  or in Xcode's documentation viewer) before writing code against it.
- Prefer boring choices: JSON over FlatBuffers, MapKit over MapLibre, SwiftData over GRDB, WatchConnectivity over
  CloudKit, hand-off over in-app navigation, until a measured need says otherwise.

---

## 14. Open questions for the owner (do not block WP-0–WP-2 on them)

1. iCloud sync of saved places in v2 (opt-in) — yes/no?
2. Is in-app turn-by-turn (Ferrostar, self-hosted Valhalla, CarPlay entitlement) wanted after phase 3, or is
   Apple Maps hand-off + the CarPlay Live Activity enough?
3. Minimum OS iOS 26 / watchOS 26 as proposed, or lower?
4. Team ID committed in `Signing.xcconfig` (public identifier) or kept local?
5. Confirmation from Open-Meteo about App Store distribution under the free tier (§4.1) — who sends the e-mail?
6. Universal link path aliases on glett.no (`/kv`, `/tv`, `/np`, `/sted`) — approve the `.htaccess` change?

---

## Appendix A. Reference: the web code map

| Topic | Where |
|---|---|
| Models, variables, URLs | `js/data.js:29–34, 176–207` |
| Yr conversion | `js/data.js:125–173` |
| IndexedDB stores, cache keys, TTLs | `js/data.js:11–27, 49–92` |
| Nowcast | `js/data.js:677–718` |
| Verification | `js/data.js:211–258, 295–373` |
| Places, export/import | `js/data.js:600–622` |
| Consensus maths | `js/app.js:85–134, 147–151, 165–170, 203–228, 360–372, 1083–1086` |
| Categories, icons | `js/icons.js:64–95` |
| i18n | `js/i18n.js` (nb 5–301, en 302–598, helpers 600–645) |
| Route engine | `js/kvcore.js:384–390 (fetch), 430–441 (classes), 472–572 (vote), 575–598 (segments, crossings)` |
| Kjørevær | `js/route.js:15–78 (routers), 362–377 (samples), 470–496 (flags, score), 1814–1837 (DATEX), 2683–2688 (hand-off links), 2711–2746 (share link, saved routes)` |
| Turvær | `js/turvaer.js:17–65 (constants), 62–211 (graph, Dijkstra), 215–268 (profile, time), 589–626 (flags), 1643–1674 (share link, saved hikes)` |
| Leirplass | `js/nattplass.js:36–94 (tiles), 938–947 (share link)` |
| Server config and rate limit | `api/db.php:14, 40–68, 196–218` |
| Endpoints | `api/*.php`, summarised in README "HTTP API" and §1 above |
| Static data formats | `data/tur/index.json`, `data/natt/index.json`, `data/poi/index.json`, `data/rest/rest.json`, `data/traffic/counts.json` |
| Design tokens | `css/style.css:2–21` |
| Deploy | `tools/deploy.sh` (rsync to Webhuset; assets first, index.html last) |

## Appendix B. Sources consulted outside the repo (2026-10-25)

- Apple, *Prepare your app for iPhone Duo* — https://developer.apple.com/iphone-duo/prepare/ ; Tech Talk 111461;
  news *Prepare and submit your apps for iPhone Duo* (device on sale 2026-10-23, Duo screenshots required from
  April 2027) — https://developer.apple.com/news/?id=kkphp5qo
- Apple, *Xcode 27.1 release notes* (27A9275, 2026-10-15; Swift 6.4; iOS 27.1 SDK; StandBy and most app
  extensions unavailable in the iPhone Duo simulator) — https://developer.apple.com/documentation/xcode-release-notes/xcode-27_1-release-notes
- InfoQ, *What iOS developers need to change for iPhone Duo* (reserved regions API names) — https://www.infoq.com/news/2026/09/apple-iphone-duo-api/
- dev.to, *iPhone Duo for iOS developers* (ArrangementView, onHingeChange, UIHingeInteraction — *verify*) — https://dev.to/arshtechpro/iphone-duo-for-ios-developers-what-actually-changes-in-your-swift-code-5gc5
- Apple, WWDC26 *WidgetKit foundations* (systemExtraLargePortrait on iOS/iPadOS/macOS 27) — https://developer.apple.com/videos/play/wwdc2026/277
- MET Norway, *Terms of Service* — https://docs.api.met.no/doc/TermsOfService
- Open-Meteo, *Terms* — https://open-meteo.com/en/terms ; SDK — https://github.com/open-meteo/sdk
- Apple, *CarPlay Developer Guide* (October 2026; navigation entitlement rules) — https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf
- Ferrostar — https://github.com/stadiamaps/ferrostar , https://stadiamaps.github.io/ferrostar/
- MapLibre Navigation iOS (older fork; its README points new projects to Ferrostar) — https://github.com/maplibre/maplibre-navigation-ios
