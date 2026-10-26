import Foundation

/// "Measured nearby right now": `api/netatmo.php?lat=&lon=` (robust averages of public Netatmo stations; api/netatmo.php:163-170).
/// With too few stations the answer is `{ok: false, stations: n}` and only `ok` and `stations` are set.
public struct MeasuredNow: Sendable, Codable {
    /// `robust()` of api/netatmo.php:88-97.
    public struct Robust: Sendable, Codable, Hashable {
        public var v: Double
        public var median: Double?
        public var n: Int
        public var dropped: Int?
        public var min: Double?
        public var max: Double?
    }
    public struct Rain: Sendable, Codable, Hashable { public var n: Int; public var mm_1h: Double; public var wet_share: Double }
    public struct Wind: Sendable, Codable, Hashable { public var n: Int; public var kmh: Double; public var gust_kmh: Double? }

    public var ok: Bool
    public var stations: Int
    /// Temperature cells about 1 km: [lat, lon, altitude, temp, n, rain_1h].
    public var pts: [[Double?]]?
    /// Rain gauges per cell: [lat, lon, mm last hour, n].
    public var rain_pts: [[Double?]]?
    /// Wind per cell: [lat, lon, km/h, from-direction, gust km/h, n].
    public var wind_pts: [[Double?]]?
    public var radius_km: Double?
    public var age_s: Double?
    public var temp: Robust?
    public var hum: Robust?
    public var pres: Robust?
    public var rain: Rain?
    public var wind: Wind?
    public var fetched: Double?

    public init(ok: Bool, stations: Int) { self.ok = ok; self.stations = stations }

    /// The web's "feels like" for the measured line (js/app.js:1196): the wind only with at least 5 wind stations.
    public var feelsLike: Double? {
        guard let t = temp?.v else { return nil }
        return FeelsLike.steadman(t, windKmh: (wind?.n ?? 0) >= 5 ? wind?.kmh : nil, rh: hum?.v)
    }

    /// The rain phrase of js/app.js:1198: nil without 5 gauges.
    public enum RainState: String, Sendable { case mm, some, none }
    public var rainState: RainState? {
        guard let r = rain, r.n >= 5 else { return nil }
        return r.mm_1h >= 0.2 ? .mm : r.wet_share >= 0.3 ? .some : RainState.none
    }

    private enum CodingKeys: String, CodingKey { case ok, stations, pts, rain_pts, wind_pts, radius_km, age_s, temp, hum, pres, rain, wind, fetched }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        stations = Int((try? c.decode(Double.self, forKey: .stations)) ?? 0)
        pts = try? c.decodeIfPresent([[Double?]].self, forKey: .pts)
        rain_pts = try? c.decodeIfPresent([[Double?]].self, forKey: .rain_pts)
        wind_pts = try? c.decodeIfPresent([[Double?]].self, forKey: .wind_pts)
        radius_km = try? c.decodeIfPresent(Double.self, forKey: .radius_km)
        age_s = try? c.decodeIfPresent(Double.self, forKey: .age_s)
        temp = try? c.decodeIfPresent(Robust.self, forKey: .temp)
        hum = try? c.decodeIfPresent(Robust.self, forKey: .hum)
        pres = try? c.decodeIfPresent(Robust.self, forKey: .pres)
        rain = try? c.decodeIfPresent(Rain.self, forKey: .rain)
        wind = try? c.decodeIfPresent(Wind.self, forKey: .wind)
        fetched = try? c.decodeIfPresent(Double.self, forKey: .fetched)
    }
}

/// The station cells for one map area (`api/netatmo.php?map=1`, js/data.js:795-804).
public struct NetatmoMap: Sendable, Codable {
    public var pts: [[Double?]]
    public var rain: [[Double?]]
    public var wind: [[Double?]]
    public init(pts: [[Double?]], rain: [[Double?]], wind: [[Double?]]) { self.pts = pts; self.rain = rain; self.wind = wind }
}
