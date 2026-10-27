import CoreLocation
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

    /// The last "Min posisjon" the app found ("glett.geo"), with the name it gave it.
    static func lastGeoPlace(_ d: UserDefaults = defaults) -> Place? {
        struct Last: Decodable { var place: Place }
        return d.data(forKey: "glett.geo").flatMap { try? JSONDecoder().decode(Last.self, from: $0).place }
    }

    /// "Min posisjon" for a widget: the device's position when the widget may use it (the app has When In Use
    /// permission and the widget asks, `NSWidgetWantsLocation`), named as the app names it; else the last position the
    /// app found; else the last place shown.
    static func currentPlace(service: WeatherService = .shared) async -> Place {
        let stored = lastGeoPlace()
        let m = CLLocationManager()
        guard m.isAuthorizedForWidgetUpdates else { return stored ?? lastPlace() }
        // iOS's last known position; a new one (kilometre accuracy, at most 5 s) when that is older than 15 minutes.
        // The widget asks only while it is updating (a few times an hour at most), with the app's "while using the
        // app or widgets" permission: no background location.
        var loc = m.location
        if loc.map({ Date().timeIntervalSince($0.timestamp) > 15 * 60 }) ?? true, let fresh = await OneShotLocation.get(timeout: 5) { loc = fresh }
        guard let loc else { return stored ?? lastPlace() }
        let c = loc.coordinate
        // the stored name while the position is still near it; a new name from glett.no otherwise
        if let s = stored, CLLocation(latitude: s.lat, longitude: s.lon).distance(from: loc) < 3000 {
            return Place(id: "geo", name: s.name, lat: c.latitude, lon: c.longitude)
        }
        let name = await service.reverseName(lat: c.latitude, lon: c.longitude, lang: L10n.language.rawValue, detailed: true)
        return Place(id: "geo", name: name ?? stored?.name ?? L10n.t("pb.geo"), lat: c.latitude, lon: c.longitude)
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
            GlettSnapshot.make(place: place.shortName, latitude: place.lat, bundle: bundle, nowcast: nowcast, settings: settings, weights: weights, now: $0)
        }
        return (snaps, max(now.addingTimeInterval(1800), bundle.expiresAt))
    }
}

/// One position for a widget's update: `requestLocation()` with kilometre accuracy, nil when none comes in time.
@MainActor
final class OneShotLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var done: CheckedContinuation<CLLocation?, Never>?

    static func get(timeout seconds: Double) async -> CLLocation? {
        let one = OneShotLocation()
        return await one.run(timeout: seconds)
    }

    private func run(timeout seconds: Double) async -> CLLocation? {
        await withCheckedContinuation { c in
            done = c
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyKilometer
            manager.requestLocation()
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                self?.finish(nil)
            }
        }
    }

    private func finish(_ loc: CLLocation?) {
        guard let c = done else { return }
        done = nil
        manager.stopUpdatingLocation()
        c.resume(returning: loc)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let loc = locations.last
        Task { @MainActor in self.finish(loc) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
