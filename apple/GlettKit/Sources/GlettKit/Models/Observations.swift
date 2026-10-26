import Foundation

/// METAR hours near a place (`api/metar.php?lat=&lon=`, 0.1° cell): `{station, obs: {"YYYY-MM-DDTHH:00": row}}`.
public struct MetarResponse: Sendable, Codable {
    public struct Station: Sendable, Codable, Hashable { public var id: String; public var name: String?; public var km: Double?; public var elev: Double? }
    /// One hour (api/metar.php:96-104): temperature °C, wind km/h, cloud %, humidity %, pressure hPa, wet, category.
    public struct Row: Sendable, Codable, Hashable {
        public var t: Double?, w: Double?, c: Double?, h: Double?, p: Double?
        public var wet: Bool?
        public var cat: String?
    }
    public var station: Station?
    public var obs: [String: Row]
}

/// MET station observations as truth (`api/frost.php?truth=1&lat=&lon=&from=&to=`, api/frost.php:57-143).
public struct FrostTruth: Sendable, Codable {
    public struct Station: Sendable, Codable, Hashable { public var id: String; public var name: String?; public var km: Double? }
    /// t °C, w km/h, h %, p hPa, c % (from oktas), r mm in the hour.
    public struct Row: Sendable, Codable, Hashable { public var t: Double?, w: Double?, h: Double?, p: Double?, c: Double?, r: Double? }
    /// Which station gave which measurement, keyed t/w/h/p/c/r.
    public var stations: [String: Station]
    public var obs: [String: Row]

    private enum CodingKeys: String, CodingKey { case stations, obs }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stations = (try? c.decode([String: Station].self, forKey: .stations)) ?? [:]   // PHP sends [] for an empty map
        obs = (try? c.decode([String: Row].self, forKey: .obs)) ?? [:]
    }
    public init(stations: [String: Station], obs: [String: Row]) { self.stations = stations; self.obs = obs }
}

/// Glett's own hourly Netatmo snapshots for the 0.05° cell (`api/netatmo.php?history=1`, api/netatmo.php:22-32).
public struct NetatmoHistory: Sendable, Codable {
    public struct Row: Sendable, Codable, Hashable { public var n: Int?, t: Double?, h: Double?, r: Double?, ws: Double? }
    public var cell: String?
    public var obs: [String: Row]

    private enum CodingKeys: String, CodingKey { case cell, obs }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cell = try? c.decodeIfPresent(String.self, forKey: .cell)
        obs = (try? c.decode([String: Row].self, forKey: .obs)) ?? [:]
    }
    public init(cell: String?, obs: [String: Row]) { self.cell = cell; self.obs = obs }
}
