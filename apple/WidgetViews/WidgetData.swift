import Foundation
import GlettKit
import SwiftData

/// Where the widgets get their place, settings and forecast: the App Group the app writes (settings, the last place,
/// saved places, the forecast cache), and the same `WeatherService` when the cache is old. Each timeline costs one
/// forecast and one nowcast request at most (brief §6).
enum WidgetData {
    /// The app's settings suite.
    static var defaults: UserDefaults {
        _ = AppGroupMove.once
        return UserDefaults(suiteName: AppGroup.identifier) ?? .standard
    }

    /// The choices that change the numbers, as the app reads them (`AppModel.init`).
    static func settings(_ d: UserDefaults = defaults) -> ForecastSettings {
        let step = d.integer(forKey: SettingsKey.step)
        return ForecastSettings(weighted: d.object(forKey: SettingsKey.weighted) as? Bool ?? true,
                                disabledModels: ForecastSettings.decodeDisabled(d.string(forKey: SettingsKey.disabledModels)),
                                windUnit: WindUnit(rawValue: d.string(forKey: SettingsKey.windUnit) ?? "") ?? .default,
                                step: [1, 3, 6, 12].contains(step) ? step : 1)
    }

    /// The place last shown in the app (`AppModel`'s "glett.last"), Oslo before any.
    static func lastPlace(_ d: UserDefaults = defaults) -> Place {
        struct Last: Decodable { var place: Place }
        return d.data(forKey: "glett.last").flatMap { try? JSONDecoder().decode(Last.self, from: $0).place } ?? Place.cities[0]
    }

    /// The saved places ("Mine steder"), in the app's order, read from the App Group store.
    static func savedPlaces() -> [Place] {
        guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier) else { return [] }
        let url = AppGroupMove.groupStoreURL(group)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let schema = Schema([SavedPlace.self])
        guard let c = try? ModelContainer(for: schema, configurations: [ModelConfiguration("Glett", schema: schema, url: url, allowsSave: false)])
        else { return [] }
        let ctx = ModelContext(c)
        let all = (try? ctx.fetch(FetchDescriptor<SavedPlace>(sortBy: [SortDescriptor(\.order), SortDescriptor(\.created)]))) ?? []
        return all.map(\.place)
    }

    /// The moments a timeline has entries for: every 15 minutes for two hours (the nowcast moves), then each hour to six.
    static func entryDates(from now: Date) -> [Date] {
        (0...8).map { now.addingTimeInterval(Double($0) * 900) } + (3...6).map { now.addingTimeInterval(Double($0) * 3600) }
    }

    /// The snapshots for a place from `now` on, and when to ask again: when the forecast's cache runs out, at least
    /// 30 minutes from now (brief §6). Nil when there is no forecast at all (offline before the first fetch).
    static func timeline(for place: Place, now: Date = Date(), service: WeatherService = .shared) async -> (snapshots: [GlettSnapshot], next: Date)? {
        let bundle: ForecastBundle?
        if let b = try? await service.forecast(for: place) { bundle = b } else { bundle = await service.cachedForecast(for: place) }
        guard let bundle else { return nil }
        let nowcast = await service.nowcast(for: place)
        let weights = await service.cachedVerificationEntry(for: place).flatMap { $0.isFresh(at: now) ? $0.value : nil }
        let settings = settings()
        let snaps = entryDates(from: now).compactMap {
            GlettSnapshot.make(place: place.name, bundle: bundle, nowcast: nowcast, settings: settings, weights: weights, now: $0)
        }
        return (snaps, max(now.addingTimeInterval(1800), bundle.expiresAt))
    }
}
