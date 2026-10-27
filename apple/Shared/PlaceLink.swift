import Foundation
import GlettKit

extension Place {
    /// The name before the first comma ("Kristiansand sentrum ved Fiskebrygga" of "…, Kristiansand kommune"): the
    /// title in tight places (widgets, the Live Activity, the app's large title, the radar's subtitle).
    var shortName: String {
        let s = name.split(separator: ",", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? name
        return s.isEmpty ? name : s
    }

    /// The rest after the first comma ("Kristiansand kommune"), nil when there is none: the app's subtitle.
    var areaName: String? {
        let parts = name.split(separator: ",", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let s = parts[1].trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? nil : s
    }
}

/// `glett://place?lat=&lon=&name=[&geo=1]`: a widget or the Live Activity opens the app at its place, or at "Min
/// posisjon" when that is what it shows (owner, 2026-10-27).
enum PlaceLink {
    static func url(_ p: Place, geo: Bool) -> URL {
        var c = URLComponents()
        c.scheme = "glett"
        c.host = "place"
        c.queryItems = [URLQueryItem(name: "lat", value: String(p.lat)), URLQueryItem(name: "lon", value: String(p.lon)),
                        URLQueryItem(name: "name", value: p.name)] + (geo ? [URLQueryItem(name: "geo", value: "1")] : [])
        return c.url!
    }

    /// The place and whether it is "Min posisjon", for a link of `url`'s form.
    static func place(from url: URL) -> (place: Place, geo: Bool)? {
        guard url.scheme == "glett", url.host == "place",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func v(_ k: String) -> String? { items.first { $0.name == k }?.value }
        guard let lat = v("lat").flatMap(Double.init), let lon = v("lon").flatMap(Double.init),
              (-90...90).contains(lat), (-180...180).contains(lon) else { return nil }
        let name = v("name").flatMap { $0.isEmpty ? nil : $0 } ?? L10n.t("pb.geo.name")
        return (Place(name: name, lat: lat, lon: lon), v("geo") == "1")
    }
}
