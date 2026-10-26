# Glett iOS — native design spec (branch `ios-native-design`)

> **Owner revision, 2026-10-26 (after the first review):** no Steder tab. The tab bar is kept for the web's tools
> (Kjørevær, Turvær, Leirplass) and is hidden while Været is the only one. The places are chips on Været in the web's
> groups ("Mine steder" ★, "Sist søkt", "Byer"; the shown place filled with its own star), the search opens the places
> sheet (`AppSheet.places`), and "Mine steder" is edited from Settings. "Hva er Glett?" has an inline title, so "Glett"
> is large only once. Where this file says otherwise below, this note wins.

The owner-approved plan, made concrete. Do exactly this; anything not written here stays as it is. Wording comes from
the catalog (`L10n.t`, js/i18n.js keys) or `AppText.t` (`app.*`, Glett/About/AppStrings.xcstrings). No literal text.

## Owners

| Builder | Folders / files |
|---|---|
| SHELL | `Glett/App/` (not `App/Style/`), `Glett/Places/`, `Glett/Radar/` (presentation + the typography lines below), `Glett/Nowcast/` |
| SHEETS | `Glett/Settings/`, `Glett/Models/`, `Glett/About/` (AppStrings.xcstrings: see item 1) |
| CONTENT | `Glett/Forecast/`, `Glett/Hours/`, `Glett/Warnings/`, `Glett/Measured/` |
| spec | `Glett/App/Style/` — builders use it and do not edit it; report a needed change instead |

## Shared primitives (`Glett/App/Style/`, built and compiling)

| File | API | Use |
|---|---|---|
| `GlettMetrics.swift` | `GlettMetrics.pagePadding` 16, `.cardSpacing` 16, `.cardPadding` 16, `.cardRadius` (24 iOS 26 / 16 iOS 18), `.innerRadius` (14 / 10) | all spacing and radii |
| `GlettCardModifier.swift` | `GlettCardModifier(padding:)`; `View.glettInset(_ fill:)`, `.glettPage()`, `.glettPageBackground()` | cards, tinted inner boxes, page column, page colour |
| `GlettSectionHeader.swift` | `GlettSectionHeader(title:subtitle:) { trailing }` | every card title |
| `GlettHaptic.swift` | `GlettHaptic.selection` / `.refresh`; `View.glettHaptic(_:trigger:)` | all haptics (`sensoryFeedback`) |
| `AppNavigation.swift` | `AppTab` (.weather/.places, `title`, `systemImage`), `AppSheet` (.settings/.models/.about), `AppNavigation` (`tab`, `sheet`, `radarShown`, `searchFocused`), `AppModel.navigation`, `showHours(day:)`, `present(_:)`, `presentRadar()`, `searchPlaces()` | all navigation between folders |
| `RadarZoom.swift` | `EnvironmentValues.radarZoomNamespace`, `View.radarZoomSource()`, `.radarZoomDestination()` | item 4 |
| `SheetCloseButton.swift` | `SheetCloseButton()` (iOS 26 `Button(role: .close)` ✕, iOS 18 text `h.close`) | sheets and radar cover, `ToolbarItem(placement: .topBarTrailing)` |
| `GlettLink.swift` | `GlettLink.place(_ Place) -> URL` = `https://glett.no/?lat=…&lon=…&n=…` | "Del" |

## Hooks (every cross-folder call)

| Caller (owner) | Today | Becomes | Implemented by |
|---|---|---|---|
| `DaysList` day tap + "Time for time" menu (CONTENT) | `selectedDay = …; scrollToHours = true` | `model.showHours(day: d.day)` | Style (done); SHELL keeps scrolling on `scrollToHours` |
| `OutlookLines` closure in `NowCard` (CONTENT) | `model.scrollToHours = true` | unchanged | — |
| `NowCard` "Vis nedbørradar" button (CONTENT) | `path.append(.radar)` | `model.presentRadar()` | SHELL presents `RadarCover` |
| `DisclaimerFooter` "footer.more" (CONTENT) | `path.append(.about)` | `model.present(.about)` | SHELL presents `AboutSheet` |
| `EmptyForecastView` search (CONTENT) | `showPlaces = true` | `model.searchPlaces()` | SHELL focuses the Steder search |
| `ModelsLink` (SHELL) | `path.append(.models)` | `model.present(.models)` | SHELL |
| `PlaceChips` search chip (SHELL) | `showPlaces = true` | `model.searchPlaces()` | SHELL |
| `SettingsView` Models / About rows (SHEETS) | `path.append(.models/.about)` | `NavigationLink { ModelsListView(model:) }` / `{ AttributionView() }` inside the sheet's stack | SHEETS |
| Sheet roots (SHEETS → SHELL) | pushed `RouteDestination` | `SettingsSheet(model:)`, `ModelsSheet(model:)`, `AboutSheet()` | SHEETS writes them, SHELL's `AppSheetRoot` switches on `AppSheet` |
| Radar strip tap (SHELL, Nowcast) | — | `NowcastLine(model:)` keeps the model and calls `model.presentRadar()` | SHELL |

`AppRoute`, `RouteDestination`, `model.path`, `model.showPlaces`, `SidebarPlaces` and `AppToolbar`'s menu go away. SHELL
deletes them only once `grep -rn "model.path\|showPlaces\|AppRoute" apple/Glett` finds no user outside `App/`; until
then they stay declared so the other builders keep compiling.

## 1. Tab bar — SHELL

- `RootView`: `TabView(selection: $nav.tab)` (`@Bindable var nav = model.navigation`) with the iOS 18 `Tab` API:
  `Tab(AppTab.weather.title, systemImage: AppTab.weather.systemImage, value: AppTab.weather) { WeatherTab(model:) }` and
  the same for `.places` with `PlacesView(model:)`. Default style (`.automatic`): iPhone bottom bar, iPad floating top
  bar; on iOS 26 both are Liquid Glass by themselves (no glass code, no `tabBarMinimizeBehavior`). `.tint(.glett.accent)`
  on the `TabView`. `.glettHaptic(.selection, trigger: nav.tab)`.
- New `App/WeatherTab.swift`: the size-class switch that `RootView` has today (`CompactRootView` / `RegularRootView`).
- Tab labels: "Været" = `ui.vaer.s`; "Steder" = new key `app.tab.places` (nb "Steder", en "Places"). SHELL is the only
  editor of AppStrings.xcstrings in this round and adds that key in the existing `app.*` format.
- `AppToolbar` keeps one item, `.topBarTrailing`: `Button { model.present(.settings) }` with
  `Label(tb.settings, systemImage: "gearshape")`. No places button, no "…" menu, no refresh item (pull to refresh and
  the Settings row stay). Compact: on the stack. Regular: on the detail column, as now.
- On the `TabView`: `.sheet(item: $nav.sheet) { AppSheetRoot(sheet: $0, model: model) }` (new `App/AppSheetRoot.swift`)
  and `.fullScreenCover(isPresented: $nav.radarShown) { RadarCover(model: model) }` (new `Radar/RadarCover.swift`),
  then `.environment(\.radarZoomNamespace, radarZoom)` after both (`@Namespace private var radarZoom` in `RootView`).
- `AppModel.applyLaunchScreen`: `models|settings|about` → `present(.…)`, `radar` → `presentRadar()`, `places` →
  `navigation.tab = .places`, `hours` → `scrollToHours = true`, `now` → nothing. Every `-GlettScreen` value keeps working.
- Steder tab (`PlacesView`): no "Lukk" button; title `nav.places`, `.navigationBarTitleDisplayMode(.large)`; picking a
  place = `model.select(p)` + `model.navigation.tab = .weather` (no dismiss). `EditButton` stays when places are saved.
  `.searchable(text:placement: .navigationBarDrawer(displayMode: .always), prompt: pb.search)` plus
  `.searchFocused($focused)` synced both ways with `model.navigation.searchFocused`. iOS 26 puts the field in the
  bottom toolbar on iPhone by itself; iOS 18 shows it under the large title.

## 2. Large title, place search — SHELL (PlaceHeader: CONTENT)

- `CompactRootView`: plain `NavigationStack` (no `path`), `ScrollView` directly inside it,
  `.navigationTitle(Text(verbatim: place?.name ?? nav.forecast))`, `.navigationBarTitleDisplayMode(.large)`: the full
  name, collapsing to inline on scroll by the system. Column: `VStack(alignment: .leading, spacing: GlettMetrics.cardSpacing)`
  `.glettPage()`, scroll view `.glettPageBackground()`. Content order unchanged: `PlaceChips`, `PlaceHeader`,
  `ForecastStatusView`, `WarningsBanner`, `NowCard`, `DaysList`, `HoursSection`, `ModelsLink`, `DisclaimerFooter`.
- `RegularRootView`: sidebar column the same with `.large`; `SidebarPlaces` replaced by `PlaceChips`; detail stays
  inline "Time for time" (`hrs.title`).
- `PlaceChips`: unchanged look; the search chip calls `model.searchPlaces()`; `.glettHaptic(.selection, trigger:
  model.place?.placeKey)`.
- `PlaceHeader` (CONTENT): the name `Text` goes (the large title shows it). One row: when `placeIsGeo` a
  `location.fill` (`.footnote`, accent) and the `pb.geo.name` capsule, then the meta line (`.caption`, muted, up to 2
  lines), `Spacer`, the star (`.title2`, unchanged). The row shows the star even before the bundle is there.

## 3. Settings, Models, About as sheets — SHEETS (presented by SHELL)

- New roots, one per file: `Settings/SettingsSheet.swift` = `NavigationStack { SettingsView(model:) }`,
  `Models/ModelsSheet.swift` = `NavigationStack { ModelsListView(model:) }`, `About/AboutSheet.swift` =
  `NavigationStack { AttributionView() }`. Each root page: `.navigationBarTitleDisplayMode(.large)`,
  `.toolbar { ToolbarItem(placement: .topBarTrailing) { SheetCloseButton() } }`, `.presentationSizing(.form)`,
  `.tint(.glett.accent)`. Pushed pages inside: `.inline`.
- `SettingsView`: `Form`, `.formStyle(.grouped)`; Models row = `NavigationLink` whose label is the current
  `LabeledContent` (`m.active` value, no hand-drawn chevron); "footer.more" row = `NavigationLink { AttributionView() }`.
- `ModelsListView`: `List` `.listStyle(.insetGrouped)`; rows, badges, toggles (`.tint(.glett.accent)`) as now;
  `-GlettModel` keeps opening the detail via its `navigationDestination` (it now has the sheet's stack).
- `AttributionView`: `List` `.listStyle(.insetGrouped)` instead of cards: `AboutHeader` as the first row
  (`.listRowBackground(Color.clear)`), each about section a `Section` (header = its `<h3>` title, body `.body`), then
  `NotOfficialCard` content, sources (`SourceRow` rows, header `app.sources`), credits (`.footnote`, header
  `app.credits`), privacy, version in the last section's footer. Keep the `.id("terms"|"sources"|"credits"|"privacy")`.
- Sheets use the system grouped colours (no `.glett.bg`, no `.scrollContentBackground(.hidden)`).

## 4. Radar zoom — SHELL

- `NowcastLine`: stores `model` (keeps `init(nowcast:now:)` for previews with a nil action). The strip box (the
  `RadarStripView` with its padding and background) gets `.contentShape(.rect)`, `.onTapGesture { model.presentRadar() }`,
  `.radarZoomSource()`, an `arrow.up.left.and.arrow.down.right` symbol (`.footnote`, muted) at its top trailing corner,
  and `.accessibilityAction(named: Text(verbatim: L10n.t("rm.open")))`. The plot's drag still picks bars (the inner
  gesture wins), with `.glettHaptic(.selection, trigger: selected)` in `RadarStripView`.
- `Radar/RadarCover.swift`: `NavigationStack { RadarMapView(model:) }` with `SheetCloseButton` at `.topBarTrailing`,
  `.radarZoomDestination()` on the stack. `RadarMapView` keeps title, subtitle and toolbar background.
- iOS 18 and 26 behave the same (zoom in, swipe down to zoom back). Without a strip the button's cover slides up.

## 5. Typography — all builders, in their folders

Allowed: `.largeTitle .title2 .headline .body .subheadline .footnote .caption` (weights and `.monospacedDigit()` free).
`scaledFont(size, relativeTo:, maxScale:)` only in fixed geometry: meteogram (`Meteogram*`), the radar strip's plot
labels and ticks, the time-across lanes (`TimeAcross*` and the cells drawn in them), the radar map overlays.

| View (owner) | Now | Becomes |
|---|---|---|
| `PlaceHeader` (C) | name `.title.heavy`; geo icon `.title3` | removed (large title); `.footnote` |
| `NowCard` (C) | temperature `scaledFont(44, .heavy)` | `.largeTitle.weight(.heavy).monospacedDigit()` |
| `DaysList`, `HoursHeader` (C) | title `.title3.bold` (+ subtitle `.subheadline`) | `GlettSectionHeader` (`.headline` + `.subheadline`) |
| `TimeDownSummaryCell`, `TimeDownHeaderRow`, `DuplicateModelsNote` (C) | `.caption2` | `.caption` |
| `ModelCellView`, `ModelRowLabel`, `RadarBadgeView` (C) | `.caption2` | `.scaledFont(11, weight: same, relativeTo: .caption2)` |
| `TimeAcrossColumn` (C) | `.callout.bold`; `.caption2` | `.scaledFont(16, weight: .bold, relativeTo: .callout)`; `.scaledFont(11, relativeTo: .caption2)` |
| `MeteogramDay`, `MeteogramTemperatureChart` (C) | `.caption2` | `.scaledFont(11, weight: same, relativeTo: .caption2)` |
| `RadarPanel` credits (SHELL) | `.caption2` | `.caption` |
| `RadarTimeline` (SHELL) | `.caption2.semibold` | `.scaledFont(11, weight: .semibold, relativeTo: .caption2)` |
| `RadarDownOverlay` (SHELL) | `scaledFont(16)`, `scaledFont(13.5)` | `.headline`, `.subheadline` |
| `ScoreBadge` large, `ModelReliabilityView` name (SHEETS) | `.title3.bold` | `.title2.bold` |
| `ReliabilityRow`, `ReliabilityHeader`, `MeasureRow`, `SourceRow` (SHEETS) | `.caption2` | `.caption` |
| `ReliabilityInfoView`, `PrivacyCard`, About section text (SHEETS) | `.callout` | `.body` |

Everything else already uses an allowed style and stays. Existing `scaledFont` in the meteogram and radar strip stays.

## 6. Context menus, swipe actions, haptics

- `DaysList` (CONTENT): tap = `model.showHours(day: d.day)`. Each day row `.contextMenu`:
  `Button { model.showHours(day: d.day) } label: { Label(hrs.title, systemImage: "clock") }`, then, when
  `model.place` is set, `ShareLink(item: GlettLink.place(p), subject: Text(verbatim: p.name)) { Label(kv.share,
  systemImage: "square.and.arrow.up") }`. System preview (the row). `.glettHaptic(.selection, trigger: model.selectedDay)`.
- `PlacesView` saved rows (SHELL): `.swipeActions(edge: .trailing) { Button(role: .destructive) { remove } label: {
  Label(saved.delete, systemImage: "trash") } }`; `.onDelete` stays for edit mode, `.onMove` stays.
- Haptics, nothing else: `.selection` on tab (SHELL), place pick (SHELL), radar strip bar (SHELL), day (CONTENT),
  `model.step` and `model.hourView` in `HoursHeader` (CONTENT), meteogram step (CONTENT). `.refresh` after a pull to
  refresh: SHELL counts finished refreshes (`@State refreshes`, `+= 1` after `await model.refresh()`) as the trigger.

## 7. Meteogram selection — CONTENT

- `MeteogramDay`: `@State private var x: Double?`; each of the four charts gets `.chartXSelection(value: $x)` and
  `.chartGesture { proxy in … }`: `SpatialTapGesture` selects `proxy.selectXValue(at:)`, and
  `LongPressGesture(minimumDuration: 0.25).sequenced(before: DragGesture(minimumDistance: 0))` scrubs, so a plain
  horizontal swipe still scrolls the week. `.onChange(of: x)` → `onSelect(slice.firstIndex + clamp(Int(x.rounded(.down)), 0, slice.count - 1))`
  (`slice.x` is index − firstIndex + 0.5). The day's `onTapGesture` stays for the rows outside the charts.
- `MeteogramPanel`: `.glettHaptic(.selection, trigger: selected)`. Cursor, readout, colours and layout unchanged.

## Cards and sections (all content pages)

- Page colour `.glett.bg` (light #F3F6FB, dark #0D1420); card colour `.glett.panel` (#FFFFFF / #151F2F). They stay
  Glett's (light is within a shade of the system grouped colours; the tables paint `.glett.panel` behind pinned columns,
  so the card must be that colour).
- `Forecast/CardStyle.swift` (CONTENT) forwards to `GlettCardModifier(padding:)`: radius `GlettMetrics.cardRadius`,
  continuous corners, no outline. Every `.glettCard(padding: 14)` becomes `.glettCard()` (16).
- Inner tinted boxes (verdict `.glett.summary`, most likely `.glett.prob`, meteogram readout, duplicate note) use
  `.glettInset(color)`: radius `innerRadius`, padding 8/12. The measured-now dashed outline and the "Neste glett"
  bolt outline stay as they are.
- Page column: `VStack(spacing: GlettMetrics.cardSpacing)` + `.glettPage()`; card titles `GlettSectionHeader`.
- Sheets: system inset grouped (item 3). Accent everywhere: `.glett.accent` (AccentColor).

## Glett identity — reviewer checklist

- [ ] App icon unchanged; accent is Glett blue (`AccentColor` / `.glett.accent`) on tabs, toolbar, links, toggles.
- [ ] `WeatherIcon` / `WeatherGlyph` drawing untouched (`git diff` on Shared/ is empty); icons still animate.
- [ ] Five verdict dots, agreement bars, category colours, `.glett.*` palette unchanged.
- [ ] Meteogram looks as before (bands, lines, bars, cloud, night shading, cursor); only selection is new.
- [ ] Every string from `L10n.t` / `AppText.t`; no literal user-facing text; only new key `app.tab.places`.
- [ ] Været order: chips, place row, status, warnings, now card (verdict, most likely, chances, measured now, neste
      glett, radar strip, radar button), days, hours, models link, footer.
- [ ] Tabs Været + Steder only; no "…" menu, no map button; gear opens Settings; Models and About reachable.
- [ ] All `-GlettScreen` values open their screen; light and dark; Dynamic Type XXXL readable; iOS 18 fallbacks build.

## Screens to check (each builder, `build/design/<builder>/`)

`-GlettPlace "59.91,10.75,Oslo" -GlettLang nb` with `-GlettScreen` `now`, `hours` (+ `-GlettHourView meteogram`),
`places`, `settings`, `models`, `about`, `radar`, in light and dark. iPhone sim `A24048E3-2C60-44B5-AE8C-604434D3EDC7`.

## Not in this round

Kjørevær / Turvær / Leirplass tabs; any GlettKit or web change; moving the warnings; new settings.
