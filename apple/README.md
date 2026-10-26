# Glett for iPhone and iPad

The native SwiftUI app for [glett.no](https://glett.no). It shows the same 13 Open-Meteo models plus MET Norway/Yr
side by side, with the web's consensus maths ported to Swift and tested value for value against the web's own
JavaScript. The full brief, with the decisions behind it, is [`docs/apple/PROJECT.md`](../docs/apple/PROJECT.md). The
app target's internals (AppModel, tabs, layouts, navigation) are described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Scope today: the iPhone/iPad forecast app (work packages WP-0, WP-1 and WP-2 of the brief). Widgets, the watch,
Kjørevær, Turvær and Leirplass are not started.

## Requirements

- macOS 26 on Apple silicon, **Xcode 27.x** (built with 27.0 / iOS 27.0 SDK, Swift 6.4). The brief targets Xcode 27.1
  for iPhone Duo (see [Human steps](#human-steps-left)).
- An iOS 26 or 27 simulator runtime. Deployment target: iOS/iPadOS 18.0 (iOS 26+ looks behind `#available`, see `Glett/App/Compat.swift`).
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.46 or later (`brew install xcodegen`). The `.xcodeproj` is
  generated and git-ignored.
- Optional: `swiftlint` (`brew install swiftlint`), and `node` for the export and fixture scripts.
- No third-party Swift packages and no API keys. Every upstream that needs a secret is reached through glett.no.

## Generate, build, test

```sh
cd apple
xcodegen generate                      # after editing project.yml; scripts/build.sh does it when needed
scripts/build.sh 'platform=iOS Simulator,name=iPhone 17 Pro' build/DerivedData
scripts/test.sh build/spm               # GlettKit's tests on the Mac (swift test)
swiftlint                               # uses apple/.swiftlint.yml
```

- `scripts/build.sh [destination] [derived-data]` builds the `Glett` scheme for a simulator. It regenerates the project
  only when `project.yml` is newer than the project.
- The sources are XcodeGen **synced folders** (`Glett/`, `Shared/`), so a new Swift file compiles without regenerating.
  Keep Markdown and other non-resource files out of them, because they are copied into the app bundle.
- Tests live in the `GlettKit` package (swift-testing). There are 79 tests in 16 suites, the golden suites among them.
  - `GLETT_LIVE=1 swift test --filter LiveTests` and `--filter VerificationLiveTests` add live smoke tests against
    Open-Meteo, MET and glett.no.
  - `GLETT_GOLDEN_VERBOSE=1` prints how many values each golden comparison checked.
  - `GLETT_STRICT_FIXTURES=1` fails when `js/app.js`, `data.js` or `icons.js` changed since the fixtures were made.
- Signing: simulator builds need no team. For a device build, copy `Config/Signing.example.xcconfig` to
  `Config/Signing.local.xcconfig` (git-ignored) and fill in `DEVELOPMENT_TEAM`. The app uses automatic signing.
- On the owner's iPhone/iPad today: `scripts/install-device.sh` builds a Release and installs it over Wi-Fi or cable on
  every paired device that answers (or the UDIDs given). It signs manually with the development profile
  "Glett Development" (app id `no.glett.app`, the team's devices), made through the App Store Connect API, and
  without the App Group, which an API key cannot register. Nothing for it is stored in the repo.
- TestFlight: `scripts/testflight-upload.sh` archives, signs with the "Glett App Store" profile and uploads; Apple
  processes the build for 10–30 minutes. Builds go to the internal group "Glett intern" (the owner) automatically.
  The API key ids live in `~/.config/glett-apple/asc.env`, outside the repo.

### Keeping in step with the web

| Command (run in the repo root) | What it does |
|---|---|
| `node apple/scripts/i18n-export.mjs` | `js/i18n.js` → `Shared/Localizable.xcstrings` (nb, en, 1 736 keys, the web's key names) |
| `node apple/scripts/i18n-export.mjs check` | exits 1 when the catalog and `js/i18n.js` differ (for CI) |
| `node apple/scripts/icons-export.mjs` | `js/icons.js` → 14 vector weather icons and `css/style.css` → 23 colour sets in `Shared/Assets.xcassets` |
| `node apple/scripts/fixtures.mjs` | runs the web's own JS on the recorded responses and writes `GlettKit/Tests/GlettKitTests/Fixtures/expected` |
| `node apple/scripts/fixtures.mjs record` | records fresh API responses first (network), then run the line above |
| `node apple/scripts/fixtures.mjs record-verify` | re-records only the two reliability runs (Oslo with Frost, London with ERA5 + METAR) |

After a change to the web's maths, run `fixtures.mjs` and then the golden tests. The format is described in
`GlettKit/Tests/GlettKitTests/Fixtures/README.md`.

## Run with launch arguments

```sh
SIM=<simulator udid>
xcrun simctl install $SIM build/DerivedData/Build/Products/Debug-iphonesimulator/Glett.app
xcrun simctl launch $SIM no.glett.app -GlettPlace "59.9139,10.7522,Oslo" -GlettScreen hours -GlettLang en -GlettHourView meteogram
xcrun simctl io $SIM screenshot shot.png
```

Run `xcrun simctl terminate $SIM no.glett.app` before you launch again. For dark mode, use
`xcrun simctl ui $SIM appearance dark`.

| Argument | Values | Effect |
|---|---|---|
| `-GlettPlace` | `"lat,lon,Name"` | shows this place (it is not saved). Pass it as one argument. |
| `-GlettScreen` | `now` `days` `hours` `models` `settings` `about` `radar` `places` | opens that screen: `models`, `settings` and `about` as sheets, `radar` full screen, `places` the places sheet (`hours` scrolls to the hour section on a phone) |
| `-GlettLang` | `nb` `en` | the language choice (stored, as if chosen in Settings) |
| `-GlettHourView` | `down` `across` `meteogram` | the hour view for this run |
| `-GlettHoursModels` | `open` `closed` | "Vis alle modellene" in the hour views (stored) |
| `-GlettStep` | `1` `3` `6` `12` | the hour step (stored) |
| `-GlettScroll` | `reliability` (models); `places`, `about` (settings); `terms`, `sources`, `credits`, `privacy` (about) | scrolls the opened screen once |
| `-GlettModel` | a model id (`ecmwf_ifs025` …) or `info` | opens that model's reliability page, or the notes, from Models |

Screenshots of every screen, taken on iPhone 18 Pro and iPad Air 11 (iOS 27.0) with live data, are in
[`docs/screens/`](docs/screens). They are scaled down to 1100 px to keep the repository small.

## Layout of the code

```
apple/
  project.yml              XcodeGen spec (one iOS app target, synced folders, the GlettKit package)
  Config/                  Shared.xcconfig (versions, Swift 6, strict concurrency), Glett.entitlements (App Group),
                           Signing.example.xcconfig (Signing.local.xcconfig is git-ignored)
  GlettKit/                Swift package, no UI. API reference: GlettKit/API.md
    Sources/GlettKit/
      Models/              Forecast, Provider, Place, alerts, nowcast, verification, measured now …
      Net/                 HTTPClient, OpenMeteoClient, METClient, GlettAPIClient, NowcastClient, PlaceSearch,
                           ForecastCache (actor), RateGate (actor), VerificationService (actor)
      Engine/              ConsensusEngine, VerificationEngine, NowcastEngine, TodayOutlook, weather codes
      Store/ Support/      settings keys, JS-exact number helpers (JS.fmt, JS.round …)
      WeatherService.swift the facade the app uses (actor WeatherService.shared)
    Tests/GlettKitTests/   unit tests, golden tests and Fixtures/ (raw recordings + expected output from the JS)
  Glett/                   the app target (SwiftUI)
    App/                   GlettApp, AppModel, tabs, compact/regular layouts, sheets, SwiftData places, launch options;
                           Style/ the shared design primitives (cards, metrics, haptics, navigation hooks)
    Forecast/              place header, now card, verdict, probability row, 7 days, status, footer
    Hours/                 time down, time across, meteogram (Swift Charts), steps 1/3/6/12 h
    Models/                model list with switches, reliability ranking and per-model detail
    Settings/ About/       settings, sources, licences, privacy; app-only strings (About/AppStrings.xcstrings)
    Warnings/ Nowcast/     MET warnings with the gauge, "Neste glett" and the 2-hour radar strip
    Radar/                 MKMapView + MET WMS / RainViewer tile overlays, Kartverket topo
    Measured/ Places/      measured now nearby; search, Min posisjon, saved places, import/export
    InfoPlist.xcstrings    location prompt in nb and en
    PrivacyInfo.xcprivacy  privacy manifest
  Shared/                  L10n (t(), language setting), Theme (colours), WeatherIcon, Localizable.xcstrings,
                           Assets.xcassets (app icon, 14 weather icons, 23 colours with dark variants)
  scripts/                 build.sh, test.sh, i18n-export.mjs, icons-export.mjs, fixtures.mjs
  docs/                    ARCHITECTURE.md (app target internals), screens/
```

Conventions (brief §13): Swift 6 with strict concurrency. Caches and the rate gate are actors, and models are
`Sendable` values. There is one SwiftUI view per file, with previews built from the recorded Oslo fixture. All text
comes from the catalog through `L10n.t("key")` with the web's keys. Strings the web does not have are in
`About/AppStrings.xcstrings` as `app.*` keys, read through `AppText.t`. Constants keep the JS names, with a doc
comment pointing at the JS line. Layout follows the size class and the space available, never the idiom or
`UIScreen`. SwiftLint enforces the `UIScreen.main` rule.

## What is done

**WP-1, GlettKit core and golden tests: done.**
- Open-Meteo, MET (If-Modified-Since/Expires) and glett.no clients. They send the `Glett-iOS/<version>` User-Agent,
  and glett.no calls also send `X-Glett-Client: ios/<build>`.
- A rate gate for Open-Meteo, and a file cache with the web's keys and lifetimes.
- The consensus engine, nowcast, verification (reliability), place search, alerts, measured now and Yr conversion.
- Golden tests: about 370 000 values from the web's JS (5 places, steps 1/3/6/12, unweighted and weighted, nowcast
  sentences) match with no differences, at 1e-9 for floating-point values and exactly for everything else. The 7 day
  cards and today's rain and gust lines (5 places, 3 times of day, both runs) and two recorded reliability runs (Oslo
  against Frost, London against ERA5 + METAR, replayed through `VerificationService`) are held against the JS too.
- The i18n and icon exports. The i18n catalog check is in place. `swift test` passes and `swiftlint` is clean.

**WP-2, iPhone and iPad forecast app: done, apart from the iPhone Duo items below.**
- Places: search, Min posisjon, saved places in SwiftData, and import/export in the web's JSON.
- The now card, the five-dot verdict, the probability row, measured now, today's lines and "Neste glett" with the
  radar strip.
- MET warnings with a detail sheet, and 7 days.
- The hour views (time down, time across, meteogram) at 1/3/6/12 h, with all models behind "Vis alle modellene".
- The model list with switches and reliability scores; weighting by reliability is on from launch.
- Settings (wind unit, hour view, weighting, language, theme, places import/export), and the sources, licences and
  privacy page.
- The radar map (MapKit, MET WMS frames switched by opacity, nowcast frames, RainViewer outside the Nordic area).
- Two tabs, Været and Steder (Liquid Glass on iOS 26). Settings, the models and "Hva er Glett?" are sheets; the radar
  opens full screen with a zoom from the radar strip. Været has the place's name as a large title; compact width uses a
  `NavigationStack`, regular width a `NavigationSplitView`.
- The App Group `group.no.glett.shared` is in the entitlements. Settings, saved places and the forecast cache live
  there, ready for widgets and the watch.
- Built with no warnings for iPhone and iPad simulators, and run on both. Screenshots are in `docs/screens/`.

## Known gaps

- **iPhone Duo is not verified.** It needs Xcode 27.1. `Hours/ReservedRegions.swift` has a TODO for
  `reservedRegions(kind:options:layoutDirectionBehavior:)` (`.division`, `.occlusion`), which is not in the 27.0 SDK;
  until then its region list is empty, so the meteogram cursor is never hidden (a preview of `MeteogramCursor` shows
  the hiding with a fake region). The radar map does not avoid the fold yet.
- **The recorded Oslo reliability run has no Netatmo blend:** glett.no had only one Netatmo history row for the cell,
  under the 24 the web needs. The blend is covered by unit tests with synthetic rows.
- **Dynamic Type in charts is capped:** meteogram, radar-strip, time-across and gauge labels grow up to 1.2–1.4×, because the chart geometry around them is fixed.
- **Not driven by touch:** iPad landscape, live language switching, model switches, the meteogram cursor (and its
  VoiceOver adjustable action on the readout), horizontal scrolling of the hour strip, Min posisjon (no simulated
  location), the day context menu, swipe to delete a saved place, the radar zoom transition, the meteogram tap and
  long-press scrub, and the haptics. All are wired, and the static layouts were checked in screenshots. `simctl` cannot rotate the device or tap, and the Simulator GUI was shared
  with another session.
- **Places the meteogram differs from the web on purpose:**
  - it shows one continuous week at the chosen step, where the web shows 2 days at 1 h;
  - it adds wind and cloud rows;
  - one temperature axis covers the whole week.
  The owner may want to review these.
- **Not ported yet:**
  - the parameter tabs of the hour table (precipitation, wind, storm …);
  - "Se hva modellene sier", "Til toppen" and "Tilbake til nå";
  - the local maps and history;
  - the real moon phase on night icons (a static moon is used);
  - icon animations.
- **HTML strings** (`about.html`, `footer.html`, `r.*` …) go through a small HTML reader. The brief asks for hand-made
  versions of about/footer/empty later.
- **Small literals.** The "AI" model tag and the "Glett" label in the warning gauge are literals: brand and model
  terms with no i18n key, as on the web. The map base setting `glett.map` is read by the radar but has no picker in
  Settings.
- **The verdict's {k}** comes from JS `Math.round` of a share times n. A share landing exactly on .5 could in theory
  round differently in Swift and JS because of floating point. It does not happen in the recorded data.
- **Nothing has been submitted:** no TestFlight build, no App Store record.

## Human steps left

1. **Install Xcode 27.1** (it needs the Apple ID), then:
   - run `xcodebuild -downloadPlatform iOS` for the 27.1 runtime and the **iPhone Duo simulator**;
   - fill in the reserved-regions TODO;
   - test closed, open and tent poses (brief §8);
   - take Duo screenshots, which are required from April 2027.
2. **Signing for device builds:**
   - put the Team ID in `Config/Signing.local.xcconfig` (or decide to commit it, brief §14.4);
   - the bundle id `no.glett.app` and a development profile exist (2026-10-26, `scripts/install-device.sh`);
   - still to do, in Xcode signed in to the account: register the App Group `group.no.glett.shared` (Signing &
     Capabilities), which widgets and the watch need; an App Store Connect API key cannot do this.
3. Check that the app name "Glett" is free in App Store Connect, and get Open-Meteo's answer about free-tier use in
   an App Store app (brief §4.1, §14.5).
4. Add the app section to `privacy.html` (WP-5). The app's privacy card already links there.
