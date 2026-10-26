import Foundation

/// One step of a precipitation series: unix seconds and mm/h (`{t, rate}`, js/data.js:685).
public struct NowcastPoint: Sendable, Codable, Hashable {
    public var t: Double
    public var rate: Double
    public init(t: Double, rate: Double) { self.t = t; self.rate = rate }
    public var date: Date { Date(timeIntervalSince1970: t) }
}

/// The nowcast for a place (js/data.js:677-718): MET's radar nowcast for the point and the ring 5 km around it, or,
/// outside radar coverage, Open-Meteo's 15-minute model precipitation (`model == true`, no ring).
public struct NowcastSeries: Sendable, Codable {
    public struct Ring: Sendable, Codable, Hashable {
        /// "n", "ne", "e", "se", "s", "sw", "w", "nw" (`dir.<x>` in i18n).
        public var dir: String
        public var series: [NowcastPoint]
        public init(dir: String, series: [NowcastPoint]) { self.dir = dir; self.series = series }
    }
    public var series: [NowcastPoint]
    public var ring: [Ring]
    public var km: Double
    public var model: Bool
    public var fetched: Double

    public init(series: [NowcastPoint], ring: [Ring] = [], km: Double, model: Bool = false, fetched: Double) {
        self.series = series; self.ring = ring; self.km = km; self.model = model; self.fetched = fetched
    }

    private enum CodingKeys: String, CodingKey { case series, ring, km, model, fetched }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        series = try c.decode([NowcastPoint].self, forKey: .series)
        ring = try c.decodeIfPresent([Ring].self, forKey: .ring) ?? []
        km = try c.decodeIfPresent(Double.self, forKey: .km) ?? 0
        model = try c.decodeIfPresent(Bool.self, forKey: .model) ?? false
        fetched = try c.decodeIfPresent(Double.self, forKey: .fetched) ?? 0
    }
}
