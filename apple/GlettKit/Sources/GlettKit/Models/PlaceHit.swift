import Foundation

/// A search result. `kind` follows the web: Open-Meteo places, Kartverket addresses and streets (js/route.js:2770-2829),
/// Kartverket place names (js/route.js:1906-1918).
public struct PlaceHit: Sendable, Codable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Codable { case place, addr, street, name }
    /// "Bergen, Vestland, Norge" for a place; "Storgata 12, Lillehammer" for an address.
    public var name: String
    /// The second line of an address or street ("2609 Lillehammer · Ringsaker").
    public var sub: String?
    public var lat: Double
    public var lon: Double
    /// ISO country code (Open-Meteo places).
    public var cc: String?
    public var kind: Kind
    /// Kartverket's place type rank (`PLACE_TYPES`, js/route.js:1898), lower is more town-like; only for `.name`.
    public var rank: Int?

    public init(name: String, sub: String? = nil, lat: Double, lon: Double, cc: String? = nil, kind: Kind, rank: Int? = nil) {
        self.name = name; self.sub = sub; self.lat = lat; self.lon = lon; self.cc = cc; self.kind = kind; self.rank = rank
    }

    public var id: String { "\(kind.rawValue):\(name):\(lat),\(lon)" }

    /// The name a picked hit gets as a place: a place keeps its first part (js/app.js:1416), an address its whole text (js/route.js:2885).
    public var placeName: String {
        guard kind == .place || kind == .name else { return name }
        let first = name.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return first.isEmpty ? name : first
    }

    public func place(id: String = UUID().uuidString) -> Place { Place(id: id, name: placeName, lat: lat, lon: lon) }
}
