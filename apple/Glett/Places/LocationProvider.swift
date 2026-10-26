import CoreLocation
import GlettKit
import MapKit

/// "Min posisjon": one position with When In Use permission, and a name for it from Apple's reverse geocoder
/// (brief §3.3), falling back to glett.no's `api/reverse.php`.
enum LocationProvider {
    enum Failure: Error { case denied, unavailable }

    /// The device's position, or `Failure` when permission is refused or nothing comes within `timeout`.
    static func currentLocation(timeout: Duration = .seconds(15)) async throws -> CLLocation {
        try await withThrowingTaskGroup(of: CLLocation.self) { group in
            group.addTask {
                let session = CLServiceSession(authorization: .whenInUse)
                defer { session.invalidate() }
                for try await update in CLLocationUpdate.liveUpdates() {
                    if update.authorizationDenied || update.authorizationDeniedGlobally { throw Failure.denied }
                    if let loc = update.location { return loc }
                }
                throw Failure.unavailable
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw Failure.unavailable
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw Failure.unavailable }
            return first
        }
    }

    /// The position's name as the web gives it (js/app.js:1427): the nearest locality and its municipality from
    /// glett.no (`reverse.php?z=14`, e.g. "Frogner, Oslo"). MapKit's city is only the fallback, when glett.no has no
    /// name (busy or no answer), since it names the town alone.
    static func name(for location: CLLocation, service: WeatherService, lang: String) async -> String? {
        let c = location.coordinate
        if let name = await service.reverseName(lat: c.latitude, lon: c.longitude, lang: lang, detailed: true), !name.isEmpty {
            return name
        }
        if #available(iOS 26, *), let request = MKReverseGeocodingRequest(location: location) {
            request.preferredLocale = Locale(identifier: lang == "nb" ? "nb_NO" : "en_GB")
            if let item = try? await request.mapItems.first {
                if let city = item.addressRepresentations?.cityName, !city.isEmpty { return city }
                if let n = item.name, !n.isEmpty { return n }
            }
        }
        return nil
    }
}
