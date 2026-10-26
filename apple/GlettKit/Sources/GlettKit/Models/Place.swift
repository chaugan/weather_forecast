import Foundation

/// A place to forecast: what the web stores per saved location (`{id, name, lat, lon}`, js/data.js:600-611).
public struct Place: Sendable, Codable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var lat: Double
    public var lon: Double

    public init(id: String = UUID().uuidString, name: String, lat: Double, lon: Double) {
        self.id = id; self.name = name; self.lat = lat; self.lon = lon
    }

    /// `clean(l)` of js/data.js:600-604: trimmed name (≤ 120 characters), coordinates within range and rounded to 5 decimals; nil when unusable.
    public static func cleaned(id: String = UUID().uuidString, name: String, lat: Double, lon: Double) -> Place? {
        let n = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        guard !n.isEmpty, lat.isFinite, lon.isFinite, abs(lat) <= 90, abs(lon) <= 180 else { return nil }
        return Place(id: id, name: n, lat: JS.fixed(lat, 5), lon: JS.fixed(lon, 5))
    }

    /// `placeKey(p)` of js/app.js:23: the place to 0.001°, how the web matches recent and saved places.
    public var placeKey: String { "\(JS.toFixed(lat, 3)),\(JS.toFixed(lon, 3))" }

    /// `inNorway` of js/data.js:26 (mainland, Svalbard, Jan Mayen): MET warnings, Frost and Netatmo history apply here.
    public var inNorway: Bool { Place.inNorway(lat: lat, lon: lon) }

    public static func inNorway(lat: Double, lon: Double) -> Bool {
        (lat >= 57.5 && lat <= 71.5 && lon >= 4 && lon <= 31.5) || (lat >= 70 && lat <= 81 && lon >= -10 && lon <= 35)
    }

    /// `CITIES` (js/app.js:15-21): the predefined places.
    public static let cities: [Place] = [
        Place(id: "city:oslo", name: "Oslo", lat: 59.9139, lon: 10.7522),
        Place(id: "city:bergen", name: "Bergen", lat: 60.3913, lon: 5.3221),
        Place(id: "city:trondheim", name: "Trondheim", lat: 63.4305, lon: 10.3951),
        Place(id: "city:stavanger", name: "Stavanger", lat: 58.9700, lon: 5.7331),
        Place(id: "city:tromso", name: "Tromsø", lat: 69.6492, lon: 18.9553),
    ]
}

/// The web's places file (js/data.js:618-622), so a JSON export from glett.no imports into the app and back.
/// `routes` and `camps` travel through untouched.
public struct PlacesFile: Sendable, Codable {
    public struct Location: Sendable, Codable, Hashable { public var name: String; public var lat: Double; public var lon: Double
        public init(name: String, lat: Double, lon: Double) { self.name = name; self.lat = lat; self.lon = lon } }
    public var glett_locations: Int
    public var exported: String
    public var locations: [Location]
    public var routes: [JSONValue]
    public var camps: [JSONValue]

    public init(locations: [Location], routes: [JSONValue] = [], camps: [JSONValue] = [], exported: Date = Date()) {
        glett_locations = 1
        self.exported = JS.isoUTC(exported.timeIntervalSince1970)
        self.locations = locations; self.routes = routes; self.camps = camps
    }

    /// Reads a web export, also a bare array of locations (js/data.js:625); the places are `clean`ed, at most 500.
    public static func parse(_ data: Data) throws -> (places: [Place], file: PlacesFile?) {
        let dec = JSONDecoder()
        let raw = try dec.decode(JSONValue.self, from: data)
        let list: [JSONValue]
        var file: PlacesFile?
        if case .array(let a) = raw { list = a }
        else if case .object(let o) = raw, case .array(let a)? = o["locations"] {
            list = a
            file = try? dec.decode(PlacesFile.self, from: data)
        } else { throw GlettError.importFormat }
        let places = list.prefix(500).compactMap { v -> Place? in
            guard case .object(let o) = v, let name = o["name"]?.stringValue, let lat = o["lat"]?.numberValue, let lon = o["lon"]?.numberValue else { return nil }
            return Place.cleaned(name: name, lat: lat, lon: lon)
        }
        return (places, file)
    }

    private enum CodingKeys: String, CodingKey { case glett_locations, exported, locations, routes, camps }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        glett_locations = (try? c.decode(Int.self, forKey: .glett_locations)) ?? 1
        exported = (try? c.decode(String.self, forKey: .exported)) ?? ""
        locations = (try? c.decode([Location].self, forKey: .locations)) ?? []
        routes = (try? c.decode([JSONValue].self, forKey: .routes)) ?? []
        camps = (try? c.decode([JSONValue].self, forKey: .camps)) ?? []
    }
}
