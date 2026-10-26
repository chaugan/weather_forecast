import Foundation

/// The forecast for one 0.01° cell: Open-Meteo's local hourly axis plus every provider on it (the `data` object of
/// js/data.js:203). Encoded in the web's shape, so recorded web data decodes directly.
public struct Forecast: Sendable, Codable {
    public var lat: Double
    public var lon: Double
    /// Open-Meteo's `timezone` (timezone=auto), e.g. "Europe/Oslo".
    public var timezone: String?
    /// Open-Meteo's `utc_offset_seconds`; the web uses this one offset for the whole week (js/data.js:189).
    public var utcOffsetSeconds: Int
    public var elevation: Double?
    public var generated: Date
    /// Local times as Open-Meteo sends them, "YYYY-MM-DDTHH:MM". The engine works on these, as the web does.
    public var time: [String]
    public var providers: [Provider]
    /// `data.isDay` (js/app.js:106-110), set by `prepare()`: 1 day, 0 night per hour.
    public private(set) var isDay: [Double] = []
    /// `data.dates` (js/app.js:111), set by `prepare()`: the distinct local dates "YYYY-MM-DD".
    public private(set) var dates: [String] = []
    /// `time` as instants (`localToUnix` with the one offset).
    public private(set) var times: [Date] = []

    public init(lat: Double, lon: Double, timezone: String?, utcOffsetSeconds: Int, elevation: Double?, generated: Date = Date(),
                time: [String], providers: [Provider]) {
        self.lat = lat; self.lon = lon; self.timezone = timezone; self.utcOffsetSeconds = utcOffsetSeconds
        self.elevation = elevation; self.generated = generated; self.time = time; self.providers = providers
        times = time.map { Date(timeIntervalSince1970: JS.localToUnix($0, offset: utcOffsetSeconds)) }
    }

    /// The place's time zone (Open-Meteo's id, else the fixed offset).
    public var timeZone: TimeZone { timezone.flatMap(TimeZone.init(identifier:)) ?? TimeZone(secondsFromGMT: utcOffsetSeconds) ?? .gmt }

    /// The unique providers (`uniqueProviders`, js/app.js:58): duplicates count once.
    public var uniqueProviders: [Provider] { providers.filter { $0.dupOf == nil } }

    /// `prepare(data)` of js/app.js:96-113: derived weather codes, duplicate marks, day/night per hour, the dates.
    public mutating func prepare() {
        for k in providers.indices {
            let h = providers[k].hourly
            let raw = h[.weatherCode]
            providers[k].hourly.code = raw.indices.map { i in raw[i] ?? WeatherCode.derive(h, i) }
            providers[k].dupOf = nil
        }
        var seen: [Signature: String] = [:]
        for k in providers.indices {
            let h = providers[k].hourly
            let sig = Signature(t: h[.temperature2m], p: h[.precipitation], w: h[.windSpeed10m], m: h[.pressureMSL])
            if let first = seen[sig] { providers[k].dupOf = first } else { seen[sig] = providers[k].id }
        }
        isDay = time.indices.map { i in
            for p in providers { let v = p.hourly[.isDay]; if i < v.count, let d = v[i] { return d } }
            let hr = Int(time[i].dropFirst(11).prefix(2)) ?? 0
            return hr >= 7 && hr < 20 ? 1 : 0
        }
        var seenDates = Set<String>()
        dates = time.map { String($0.prefix(10)) }.filter { seenDates.insert($0).inserted }
        times = time.map { Date(timeIntervalSince1970: JS.localToUnix($0, offset: utcOffsetSeconds)) }
    }

    /// Returns a prepared copy.
    public func prepared() -> Forecast { var f = self; f.prepare(); return f }

    /// The web's duplicate signature: the four series joined (js/app.js:103). Equal arrays ⇔ equal joined strings here,
    /// since every series has the same length.
    private struct Signature: Hashable { let t: [Double?], p: [Double?], w: [Double?], m: [Double?] }

    // MARK: Codable (the web's keys)

    private enum CodingKeys: String, CodingKey { case lat, lon, timezone, utc_offset_seconds, elevation, generated, time, providers, isDay, dates }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let generated: Date
        if let s = try? c.decode(String.self, forKey: .generated), let u = JS.parseISO(s) { generated = Date(timeIntervalSince1970: u) }
        else if let n = try? c.decode(Double.self, forKey: .generated) { generated = Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n) }
        else { generated = Date(timeIntervalSince1970: 0) }
        self.init(lat: try c.decode(Double.self, forKey: .lat), lon: try c.decode(Double.self, forKey: .lon),
                  timezone: try c.decodeIfPresent(String.self, forKey: .timezone),
                  utcOffsetSeconds: Int(try c.decodeIfPresent(Double.self, forKey: .utc_offset_seconds) ?? 0),
                  elevation: try c.decodeIfPresent(Double.self, forKey: .elevation), generated: generated,
                  time: try c.decode([String].self, forKey: .time), providers: try c.decode([Provider].self, forKey: .providers))
        isDay = try c.decodeIfPresent([Double].self, forKey: .isDay) ?? []
        dates = try c.decodeIfPresent([String].self, forKey: .dates) ?? []
        if isDay.count != time.count || dates.isEmpty { prepare() }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(lat, forKey: .lat); try c.encode(lon, forKey: .lon)
        try c.encodeIfPresent(timezone, forKey: .timezone)
        try c.encode(utcOffsetSeconds, forKey: .utc_offset_seconds)
        try c.encodeIfPresent(elevation, forKey: .elevation)
        try c.encode(JS.isoUTC(generated.timeIntervalSince1970), forKey: .generated)
        try c.encode(time, forKey: .time); try c.encode(providers, forKey: .providers)
        try c.encode(isDay, forKey: .isDay); try c.encode(dates, forKey: .dates)
    }
}
