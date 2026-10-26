# Glett iOS/iPadOS app — architecture of the app target

The app target (`apple/Glett`, a synced folder: new files compile without touching `project.yml`; this file lives in
`apple/docs/` so it is not copied into the app) is SwiftUI on top
of GlettKit (data, engine) and `apple/Shared` (L10n, colours, weather icons). It mirrors the web's forecast page
(`index.html`, `js/app.js`).

## Folders and owners

| Folder | What | Owner |
|---|---|---|
| `App/` | `GlettApp`, `AppModel`, tabs and layouts (`RootView`, `WeatherTab`, `CompactRootView`, `RegularRootView`), toolbar, sheets (`AppSheetRoot`), SwiftData (`SavedPlace`, `PlaceStore`), `LaunchOptions`, `Format`, `PreviewSamples` | shell |
| `Forecast/` | `PlaceHeader`, `NowCard`, `VerdictView`, `VerdictDots`, `ProbabilityRow`, `AgreementBar`, `OutlookLines`, `SummaryChip`, `DaysList`, `DayRow`, `ForecastStatusView`, `EmptyForecastView`, `DisclaimerFooter`, helpers (`CardStyle`, `FlowLayout`, `WindArrow`, `CategoryColor`, `WeatherIcon+Category`) | shell |
| `Places/` | `PlacesView` (search, Min posisjon, saved list, cities, import/export), `PlaceChips`, `LocationProvider`, `PlacesExport` | shell |
| `App/Style/` | shared primitives (apple/docs/DESIGN.md): `GlettMetrics`, `GlettCardModifier` (`.glettCard()`, `.glettInset`, `.glettPage()`), `GlettSectionHeader`, `GlettHaptic`, `AppNavigation`, `RadarZoom`, `SheetCloseButton`, `GlettLink` | spec |
| `Hours/`, `Models/`, `Settings/`, `About/`, `Warnings/`, `Nowcast/`, `Radar/`, `Measured/` | feature views (see apple/README.md) | feature agents |

## AppModel (`App/AppModel.swift`)

`@MainActor @Observable final class AppModel`, one instance in `GlettApp`, passed explicitly (`model:`) to every view.

State (read-only to views unless noted):

- `place: Place?`, `placeIsGeo: Bool` — the shown place ("Min posisjon" sets `placeIsGeo`). Stored as `glett.last`.
- `bundle: ForecastBundle?` — GlettKit's bundle: `forecast: Forecast`, `fetchedAt`, `expiresAt`, `fromCache`.
- `engine: ConsensusEngine?` — rebuilt whenever the forecast, `weighted`, `disabledModels`, `weights` or the place's
  local hour changes (`AppModel.placeHour`, so half-hour offsets and DST changes turn it at the right time). Views call `engine.nowSummary()`, `engine.days()`, `engine.columns(step:day:)`, `engine.step(_:)` etc.
- `isLoading`, `error: GlettError?`, `errorMessage: String?` (verbatim or the catalog text, e.g. `err.quota`),
  `isShowingStoredData` (ForecastStatusView then shows `app.stored`), `rateWaitUntil: Date?` (Open-Meteo gate wait,
  `om.wait`), `now: Date`.
- `nowcast: NowcastSeries?`, `alerts: [MetAlert]`, `measured: MeasuredNow?` — loaded in parallel right after each
  forecast load (nil/empty until then). One that cannot be fetched keeps its previous value for the same place, so a
  warning in force does not vanish offline; `select` clears them. `languageChanged()` (called from GlettApp) fetches
  the warnings again in the new language.
- `modelCounts: (active, unique)?`, `lang` ("nb"/"en"), `forecastSettings`.

Settings (read/write; each writes its web key to `UserDefaults(suiteName: "group.no.glett.shared")`):
`windUnit` (`glett.wind`), `weighted` (`glett.weighted`), `disabledModels` (`glett.disabled`), `hourView`
(`glett.orient2`), `step` (`glett.step`), `theme` (`glett.theme`, applied with `.preferredColorScheme` in GlettApp).
`weights: (any ConsensusWeights)?` is set by `ReliabilityStore.shared` (Models/), which `AppModel` attaches after the
first forecast, as the web's `loadVerify`; the store then follows place changes and the consensus is rebuilt.
Language is not in AppModel: it is `LanguageSettings.shared` (Shared/L10n.swift), injected by `.glettLanguage()`. Its
`glett.lang` lives in the same App Group suite (`LanguageSettings.groupDefaults()`, which moves a value an earlier
build left in the standard defaults). The store applies a stored reliability result as weights only while it is fresh
(24 h), as the web does; an expired one is shown in the model list only.

Navigation (read/write): `model.navigation` (`AppNavigation`, App/Style/AppNavigation.swift): `tab` (`AppTab`: the web's
tools, `.weather` only for now; the tab bar appears once a second tool joins), `sheet` (`AppSheet` `.settings` /
`.models` / `.about` / `.places`, shown as a sheet), `radarShown` (the full-screen radar), `searchFocused` (the places
sheet's search field). The places are not a tab (owner, 2026-10-26): chips on Været in the web's groups (`PlaceGroup`,
`PlaceChip`), the places sheet from the search, and Settings → "Mine steder". `AppModel.recent` is the web's
`state.recent` (`glett.recent`, 5). Views call the hooks, never set these directly:
`present(_ sheet:)`, `presentRadar()`, `searchPlaces()` (places sheet, search focused) and `showHours(day:)` (picks the
day, shows Været, scrolls to the hours). Also on `AppModel`: `selectedDay: Int?` (day for the hour views, nil = today)
and `scrollToHours` (compact layout scrolls to the hours and resets it).

Actions: `select(_ place:, geo:)`, `rename(_:)`, `reload(force:)`, `refresh() async` (pull to refresh, forced),
`setModel(_ id:, enabled:)` (the web's "one model stays on" rule), `tick()` (every minute: the hour check, and the web's
quiet refresh of a forecast generated over 30 minutes ago, forced past the cache and tried at most once per place per
30 minutes), `becameActive()`, `languageChanged()`, `rebuild()`.

Previews: `AppModel.preview()` (Oslo from `GlettKit/Tests/GlettKitTests/Fixtures/raw`, 2026-10-25 20:00 UTC, no
network; a synthetic forecast where the source tree is absent) and `AppModel.previewEmpty()`. `PreviewSamples.engine`
gives a `ConsensusEngine` for single-view previews. Saved places: `.modelContainer(PlaceStore.previewContainer())`.

## Layout (brief §8)

`RootView` is a `TabView` (iOS 18 `Tab` API, Liquid Glass on iOS 26 by itself) bound to `model.navigation.tab`, with
two tabs: Været (`WeatherTab`) and Steder (`PlacesView`: search with `.searchable`, Min posisjon, saved places with
swipe to delete, cities, import/export). On the tab view sit the sheet (`AppSheetRoot` → `SettingsSheet`,
`ModelsSheet`, `AboutSheet`, each its own `NavigationStack`; Models and "Kilder, lisenser og forbehold" are also pushed
inside the Settings sheet) and the full-screen radar (`Radar/RadarCover.swift`), which zooms out of the radar strip
(`radarZoomSource()` / `radarZoomDestination()`, App/Style/RadarZoom.swift). The toolbar (`AppToolbar`) has one gear
button that opens Settings. `WeatherTab` switches on `horizontalSizeClass` only:

- compact → `CompactRootView`: `NavigationStack` with the place's name as a large title (collapses on scroll), then
  chips, `PlaceHeader` (meta line and star), status, `WarningsBanner`, `NowCard` (verdict, probability row,
  `MeasuredNowLine`, today's lines, `NowcastLine` — a tap opens the radar —, radar button), `DaysList` (tap or long
  press → "Time for time", "Del"), `HoursSection` (scroll anchor `"hours"`), "Vis alle modellene" (Models sheet),
  `DisclaimerFooter` ("Hva er Glett?" sheet).
- regular → `RegularRootView`: `NavigationSplitView`; sidebar = chips, header, status, warnings, `NowCard`,
  `DaysList`, footer; detail = `NavigationStack` with `HoursSection` and "Vis alle modellene", titled "Time for time".

No `UIScreen`, no idiom checks. Pull to refresh on both columns (with a haptic when it ends).

## Feature views and their inputs

| File | Type | Init | Reads |
|---|---|---|---|
| `Hours/HoursSection.swift` | `struct HoursSection: View` | `init(model: AppModel)` | `engine`, `selectedDay`, `step`, `hourView`, `windUnit` |
| `Models/ModelsListView.swift` | `ModelsListView` | `(model:)` | `bundle?.forecast.providers`, `disabledModels`, `setModel`, `modelCounts`, `weights` |
| `Settings/SettingsView.swift` | `SettingsView` | `(model:)` + `@Environment(LanguageSettings.self)` | `weighted`, `windUnit`, `theme`, `hourView`, `reload` |
| `About/AttributionView.swift` | `AttributionView` | `()` | strings only (`about.html`, `footer.html`) |
| `Warnings/WarningsBanner.swift` | `WarningsBanner` | `(model:)` | `alerts` (empty → no view) |
| `Nowcast/NowcastLine.swift` | `NowcastLine` | `(model:)` | `nowcast` (`NextGlett.evaluate`) |
| `Radar/RadarMapView.swift` | `RadarMapView` | `(model:)` | `place`, `nowcast` (in `RadarCover`, full screen) |
| `Measured/MeasuredNowLine.swift` | `MeasuredNowLine` | `(model:)` | `measured`, `place`, `windUnit` |

Shared building blocks: `.glettCard()`, `SummaryChip`,
`FlowLayout`, `WindArrow`, `AgreementBar`, `VerdictDots`, `Format.*` (temperature, wind in unit, percent, mm, time,
day names as the web's `fmt`/`wv`/`dayName`), `WeatherIcon(category:night:size:)`.

Name clash: the app's `WeatherIcon` (a view, Shared/) shadows GlettKit's `WeatherIcon` enum, and `GlettKit.WeatherIcon`
does not compile (GlettKit has an enum named `GlettKit`). Use `summary.icon?.rawValue` with `WeatherIcon(name:)`, or
`WeatherIcon(category:night:size:)`.

## Saved places

SwiftData `@Model SavedPlace { uid, name, lat, lon, order, created }`. `PlaceStore.makeContainer()` uses the App Group
container when the entitlement exists, else the app's default store, else memory (never crashes). `PlaceStore`:
`save`, `remove`, `reorder`, `saved(_:in:)`, `importJSON` (web export or bare array, dedupe by `placeKey`, max 500),
`exportJSON` (web format, file `glett-locations.json` via `PlacesExport` + `ShareLink`).

## Launch arguments (screenshots, UI checks)

| Argument | Values | Effect |
|---|---|---|
| `-GlettPlace` | `"lat,lon,Name"` | shows this place on launch (not stored as saved) |
| `-GlettScreen` | `now` `days` `hours` `models` `settings` `about` `radar` `places` | opens that screen: `models` `settings` `about` as sheets, `radar` full screen, `places` the places sheet; `hours` scrolls to the hour section on compact width (it is always visible on regular width) |
| `-GlettLang` | `nb` `en` | sets the language choice (stored like a choice in the settings, so it stays for later launches) |
| `-GlettHourView` | `down` `across` `meteogram` | hour view for this run (not stored) |
| `-GlettHoursModels` | `open` `closed` | "Vis alle modellene" in the hour views (stored) |
| `-GlettStep` | `1` `3` `6` `12` | hour step (stored) |
| `-GlettScroll` | `reliability` (models); `places`, `about` (settings); `terms`, `sources`, `credits`, `privacy` (about) | scrolls the opened screen once |
| `-GlettModel` | a model id, or `info` | opens that model's reliability detail (or the notes) from the models screen |

```sh
cd apple
scripts/build.sh 'platform=iOS Simulator,id=<SIM>' build/dd-<you>
xcrun simctl boot <SIM>
xcrun simctl install <SIM> build/dd-<you>/Build/Products/Debug-iphonesimulator/Glett.app
xcrun simctl launch <SIM> no.glett.app -GlettPlace "59.91,10.75,Oslo" -GlettScreen hours -GlettLang nb -GlettHourView meteogram
sleep 8 && xcrun simctl io <SIM> screenshot build/screens-<you>/hours.png
```

Relaunch with `xcrun simctl terminate <SIM> no.glett.app` first. Dark mode: `xcrun simctl ui <SIM> appearance dark`.
