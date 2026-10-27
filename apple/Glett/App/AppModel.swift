import Foundation
import GlettKit
import Observation
import SwiftUI

/// The app's state: the place, its forecast and consensus, loading and error state, the extras around the forecast
/// (nowcast, warnings, measured now) and the settings. One instance lives in `GlettApp`; every view gets it passed in.
/// The web keeps the same things in `state` (js/app.js:24-60).
@MainActor @Observable
final class AppModel {
    // MARK: Services and storage

    @ObservationIgnored let service: WeatherService
    /// Settings live in the App Group suite (brief §3.5) so widgets read the same values; without the entitlement the
    /// suite is still a private defaults domain of the app.
    @ObservationIgnored let defaults: UserDefaults
    @ObservationIgnored let launch: LaunchOptions
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var started = false
    /// Previews and tests: no network at all.
    @ObservationIgnored private let offline: Bool
    /// `state.autoRefreshed` (js/app.js:1159): when each place was last refreshed quietly.
    @ObservationIgnored private var autoRefreshed: [String: Date] = [:]

    // MARK: Place and forecast

    /// The place shown.
    private(set) var place: Place?
    /// The place came from "Min posisjon" (the web marks it with ◎).
    private(set) var placeIsGeo = false
    /// The forecast for `place` (fresh or from the cache).
    private(set) var bundle: ForecastBundle?
    /// The consensus for `bundle` with the current settings, weights and hour. Rebuilt on every change.
    private(set) var engine: ConsensusEngine?
    /// A fetch is running.
    private(set) var isLoading = false
    /// The last fetch failed with this; the forecast (if any) is then the cached one.
    private(set) var error: GlettError?
    /// Open-Meteo's gate is holding requests back until then (`om.wait`).
    private(set) var rateWaitUntil: Date?
    /// The clock the engine was last built with (moved on every minute while the app is open).
    private(set) var now: Date

    // MARK: Around the forecast (filled after the forecast; nil/empty until then or when unavailable)

    /// MET radar nowcast, or Open-Meteo's 15-minute fallback outside radar cover.
    private(set) var nowcast: NowcastSeries?
    /// MET warnings in force at the place, most serious first (Norway only).
    private(set) var alerts: [MetAlert] = []
    /// "Målt nå i nærheten" from public Netatmo stations via glett.no.
    private(set) var measured: MeasuredNow?
    /// The language `alerts` were fetched in.
    @ObservationIgnored private var alertsLang: String?

    // MARK: Settings (the web's localStorage keys, `SettingsKey`)

    /// `glett.wind`
    var windUnit: WindUnit { didSet { defaults.set(windUnit.rawValue, forKey: SettingsKey.windUnit) } }
    /// `glett.weighted`
    var weighted: Bool { didSet { defaults.set(weighted, forKey: SettingsKey.weighted); rebuild() } }
    /// `glett.disabled`
    var disabledModels: Set<String> {
        didSet { defaults.set(ForecastSettings.encodeDisabled(disabledModels), forKey: SettingsKey.disabledModels); rebuild() }
    }
    /// `glett.orient2`
    var hourView: HourView { didSet { defaults.set(hourView.rawValue, forKey: SettingsKey.hourView) } }
    /// `glett.step` (1, 3, 6 or 12 hours)
    var step: Int { didSet { defaults.set(step, forKey: SettingsKey.step) } }
    /// `glett.theme`
    var theme: AppTheme { didSet { defaults.set(theme.rawValue, forKey: SettingsKey.theme) } }
    /// Reliability weights (the verification agent sets these); nil = none loaded, every model counts 1.
    var weights: (any ConsensusWeights)? { didSet { rebuild() } }

    // MARK: Navigation

    /// The day the hour views show; nil = today from now (`state.day`).
    var selectedDay: Int?
    /// Set once from `-GlettScreen hours` (and by a tap on a day in compact width): the compact layout scrolls to the hours.
    var scrollToHours = false
    /// `state.recent` (js/app.js:1352): the places shown lately, newest first, at most `recentMax`; the chips show the
    /// ones that are neither saved nor a city under "Sist søkt".
    private(set) var recent: [Place] = []
    /// `RECENT_MAX` (js/app.js:22).
    static let recentMax = 5
    /// Launch-only: open scrolled to the week list (`-GlettScreen days`, for screenshots).
    var scrollToDays = false

    // MARK: Init

    init(service: WeatherService = .shared, defaults: UserDefaults = AppModel.settingsDefaults(), launch: LaunchOptions = .current,
         offline: Bool = false, now: Date = Date()) {
        self.service = service
        self.defaults = defaults
        self.launch = launch
        self.offline = offline
        self.now = now
        windUnit = WindUnit(rawValue: defaults.string(forKey: SettingsKey.windUnit) ?? "") ?? .default
        weighted = defaults.object(forKey: SettingsKey.weighted) as? Bool ?? true
        disabledModels = ForecastSettings.decodeDisabled(defaults.string(forKey: SettingsKey.disabledModels))
        // the launch argument wins for this run only (it is not stored)
        hourView = launch.hourView ?? HourView(rawValue: defaults.string(forKey: SettingsKey.hourView) ?? "") ?? .default
        let s = defaults.integer(forKey: SettingsKey.step)
        step = [1, 3, 6, 12].contains(s) ? s : 1
        theme = AppTheme(rawValue: defaults.string(forKey: SettingsKey.theme) ?? "") ?? .default
        if let p = launch.place {
            place = p
        } else if let last = Self.lastPlace(defaults) {
            place = last.place
            placeIsGeo = last.geo
        } else {
            place = Place.cities[0]   // Oslo on the very first visit (js/app.js:1818-1823)
        }
        recent = Self.recentPlaces(defaults)
        for p in launch.recent.reversed() { addRecent(p) }
    }

    /// `UserDefaults(suiteName: "group.no.glett.shared")`, or the standard defaults if the suite cannot be opened.
    nonisolated static func settingsDefaults() -> UserDefaults {
        _ = AppGroupMove.once
        return UserDefaults(suiteName: AppGroup.identifier) ?? .standard
    }

    // MARK: Derived

    /// The web's `LANG` for the services ("nb" / "en").
    var lang: String { L10n.language.rawValue }

    var forecastSettings: ForecastSettings {
        ForecastSettings(weighted: weighted, disabledModels: disabledModels, windUnit: windUnit, step: step)
    }

    /// The error as the web shows it: `verbatim` when the service gave a reason, else the catalog message.
    var errorMessage: String? {
        guard let error else { return nil }
        return error.verbatim ?? L10n.t(error.l10nKey, error.l10nArgs)
    }

    /// What is shown is older than the cache lifetime or the last fetch failed: the UI marks it as stored data.
    var isShowingStoredData: Bool {
        guard let bundle else { return false }
        return error != nil || bundle.expiresAt < now
    }

    /// `m.active`-style counts for the header: active and unique models.
    var modelCounts: (active: Int, unique: Int)? {
        engine.map { ($0.providers.count, $0.uniqueCount) }
    }

    // MARK: Lifecycle

    /// First appearance: hooks up the rate gate's waits, loads the place and opens the launch screen.
    func start() async {
        guard !started else { return }
        started = true
        if offline { rebuild(); return }
        let model = self   // lives as long as the app
        await RateGate.shared.setWaitHandler { wait in
            let until = wait.until
            Task { @MainActor in model.rateWaitUntil = until }
        }
        applyLaunchScreen()
        if place != nil { reload(force: false) }
        Task.detached(priority: .background) { [service] in
            try? await Task.sleep(for: .seconds(4))   // the web sweeps 4 s after the first render
            await service.sweepCache()
        }
    }

    /// Moves the clock on; rebuilds the consensus when the place's local hour changed and refetches a forecast older
    /// than 30 minutes (`AUTO_REFRESH_MS`, js/app.js:28) — only while the app is in use, as MET's terms ask.
    func tick(now newNow: Date = Date()) {
        let hourChanged = bundle.map { Self.placeHour(newNow, $0.forecast) != Self.placeHour(now, $0.forecast) } ?? false
        now = newNow
        if hourChanged { rebuild() }
        autoRefreshIfStale(now: newNow)
    }

    /// The place's local hour as a number (`nowIdx()` compares the place's ISO hour, js/app.js:209): it turns at the
    /// place's hour, also for offsets that are not whole hours and through a DST change of the device's zone.
    nonisolated static func placeHour(_ t: Date, _ f: Forecast) -> Int {
        Int(((t.timeIntervalSince1970 + Double(f.utcOffsetSeconds)) / 3600).rounded(.down))
    }

    /// The web's quiet refresh (js/app.js:1158-1161, 1302-1305): a forecast generated more than 30 minutes ago is fetched
    /// past the cache, at most once per place per 30 minutes, so a throttled or failed try is not repeated every minute.
    private func autoRefreshIfStale(now t: Date) {
        guard !offline, !isLoading, let p = place, let bundle, bundle.needsAutoRefresh(now: t) else { return }
        if let last = autoRefreshed[p.placeKey], t.timeIntervalSince(last) < ForecastBundle.autoRefreshInterval { return }
        autoRefreshed[p.placeKey] = t
        reload(force: true)
    }

    /// The scene became active again.
    func becameActive() {
        tick()
        if !offline, place != nil, bundle == nil, !isLoading { reload(force: false) }
    }

    // MARK: Place

    /// Shows a place: the cached forecast at once (if any), then a fresh one. `recent`: the place came from the search,
    /// "Min posisjon" or a recent chip, which the web lists under "Sist søkt" (js/app.js:1383, 1410, 1426).
    func select(_ p: Place, geo: Bool = false, recent: Bool = false) {
        let same = place.map { $0.placeKey == p.placeKey } ?? false
        place = p
        placeIsGeo = geo
        Self.storeLastPlace(p, geo: geo, defaults)
        if recent { addRecent(p) }
        guard !same || bundle == nil else { return }
        bundle = nil
        engine = nil
        error = nil
        nowcast = nil
        alerts = []
        alertsLang = nil
        measured = nil
        selectedDay = nil
        reload(force: false)
    }

    /// Renames the shown place (after a reverse geocode of "Min posisjon").
    func rename(_ name: String) {
        guard var p = place, !name.isEmpty else { return }
        p.name = name
        place = p
        Self.storeLastPlace(p, geo: placeIsGeo, defaults)
        addRecent(p)
    }

    /// `addRecent` (js/app.js:1352): to the front, once, at most `recentMax`.
    func addRecent(_ p: Place) {
        recent = Array(([p] + recent.filter { $0.placeKey != p.placeKey }).prefix(Self.recentMax))
        if let data = try? JSONEncoder().encode(recent) { defaults.set(data, forKey: Self.recentKey) }
    }

    // MARK: Fetching

    /// Starts a load (cancelling a running one).
    func reload(force: Bool) {
        loadTask?.cancel()
        loadTask = Task { await load(force: force) }
    }

    /// Pull to refresh: waits for the fetch. `force` bypasses the cache (at most once per 5 minutes per cell).
    func refresh() async {
        loadTask?.cancel()
        let t = Task { await load(force: true) }
        loadTask = t
        await t.value
    }

    private func load(force: Bool) async {
        guard let p = place, !offline else { return }
        if bundle == nil, let cached = await service.cachedForecast(for: p), isCurrent(p) {
            bundle = cached
            rebuild()
        }
        isLoading = true
        defer { if isCurrent(p) { isLoading = false } }
        do {
            let b = try await service.forecast(for: p, force: force)
            guard isCurrent(p), !Task.isCancelled else { return }
            bundle = b
            error = nil
            now = Date()
            rebuild()
            // the reliability weights after the forecast, as `loadVerify` (js/app.js:1167-1182); the store keeps one
            // result per place and follows place changes from then on
            ReliabilityStore.shared.attach(self)
        } catch is CancellationError {
            return
        } catch let e as GlettError {
            guard isCurrent(p), !Task.isCancelled else { return }
            error = e
        } catch {
            guard isCurrent(p), !Task.isCancelled else { return }
            self.error = .network(host: Endpoints.production.openMeteo.host() ?? "api.open-meteo.com")
        }
        await loadExtras(for: p)
    }

    /// Nowcast, warnings and measured now, in parallel. One that cannot be fetched keeps what was shown for this place
    /// (offline, a warning in force must not vanish as if there were none); `select` clears them for a new place.
    private func loadExtras(for p: Place) async {
        let lang = lang
        async let nc = service.nowcast(for: p)
        async let al = service.alerts(for: p, lang: lang)
        async let me = service.measuredNow(for: p)
        let (n, a, m) = await (nc, al, me)
        guard isCurrent(p) else { return }
        if let n { nowcast = n }
        if let a { alerts = a; alertsLang = lang }
        if let m { measured = m }
    }

    /// The language changed in Settings (or on the device): MET's warning texts are fetched again in the new one.
    func languageChanged() {
        guard !offline, let p = place, alertsLang != nil, alertsLang != lang else { return }
        let lang = lang
        Task {
            guard let a = await service.alerts(for: p, lang: lang), isCurrent(p) else { return }
            alerts = a
            alertsLang = lang
        }
    }

    private func isCurrent(_ p: Place) -> Bool { place?.placeKey == p.placeKey }

    /// Rebuilds the consensus (cheap: a value type over the prepared forecast).
    func rebuild() {
        engine = bundle?.consensus(settings: forecastSettings, weights: weights, now: now)
    }

    // MARK: Models

    /// The web's toggle (js/app.js:1043-1047): a model goes off only while another unique one stays on.
    func setModel(_ id: String, enabled: Bool) {
        if enabled { disabledModels.remove(id); return }
        guard let f = bundle?.forecast, ForecastSettings.canDisableAnother(disabled: disabledModels, forecast: f) else { return }
        disabledModels.insert(id)
    }

    // MARK: Launch screen

    private func applyLaunchScreen() {
        switch launch.screen {
        case .models?: present(.models)
        case .settings?: present(.settings)
        case .about?: present(.about)
        case .radar?: presentRadar()
        case .places?: navigation.sheet = .places
        case .hours?: scrollToHours = true
        case .days?: scrollToDays = true
        case .now?, nil: break
        }
    }

    // MARK: Last place (`glett.last`, as the web keeps it)

    private struct LastPlace: Codable { var place: Place; var geo: Bool }
    private static let lastKey = "glett.last"
    private static let recentKey = "glett.recent"

    private static func recentPlaces(_ d: UserDefaults) -> [Place] {
        d.data(forKey: recentKey).flatMap { try? JSONDecoder().decode([Place].self, from: $0) } ?? []
    }

    private static func lastPlace(_ d: UserDefaults) -> LastPlace? {
        d.data(forKey: lastKey).flatMap { try? JSONDecoder().decode(LastPlace.self, from: $0) }
    }

    private static func storeLastPlace(_ p: Place, geo: Bool, _ d: UserDefaults) {
        if let data = try? JSONEncoder().encode(LastPlace(place: p, geo: geo)) { d.set(data, forKey: lastKey) }
    }
}

extension AppModel {
    /// A model with a recorded forecast and no network, for previews (Oslo, 2026-10-25 20:00 UTC).
    static func preview(launch: LaunchOptions = LaunchOptions(arguments: []), alerts: [MetAlert] = []) -> AppModel {
        let sample = PreviewSamples.oslo
        let m = AppModel(defaults: UserDefaults(suiteName: "glett.preview") ?? .standard, launch: launch, offline: true, now: sample.now)
        m.place = sample.place
        m.bundle = sample.bundle
        m.nowcast = sample.nowcast
        m.alerts = alerts
        m.rebuild()
        return m
    }

    /// The empty first-launch state, for previews.
    static func previewEmpty() -> AppModel {
        let m = AppModel(defaults: UserDefaults(suiteName: "glett.preview.empty") ?? .standard, launch: LaunchOptions(arguments: []), offline: true)
        m.place = nil
        return m
    }
}

extension AppTheme {
    /// The colour scheme to force, nil = follow the system.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
