import Foundation

/// MET's Locationforecast 2.0 compact answer, the parts Glett reads.
public struct METCompactResponse: Sendable, Codable {
    public struct Details: Sendable, Codable {
        public var air_temperature: Double?
        public var wind_speed: Double?
        public var wind_speed_of_gust: Double?
        public var wind_from_direction: Double?
        public var cloud_area_fraction: Double?
        public var relative_humidity: Double?
        public var air_pressure_at_sea_level: Double?
        public var precipitation_amount: Double?
        public var precipitation_rate: Double?
    }
    public struct Summary: Sendable, Codable { public var symbol_code: String? }
    public struct Block: Sendable, Codable { public var summary: Summary?; public var details: Details? }
    public struct Instant: Sendable, Codable { public var details: Details? }
    public struct DataBlock: Sendable, Codable { public var instant: Instant?; public var next_1_hours: Block?; public var next_6_hours: Block?; public var next_12_hours: Block? }
    public struct Step: Sendable, Codable { public var time: String; public var data: DataBlock }
    public struct Properties: Sendable, Codable { public var timeseries: [Step]? }
    public var properties: Properties?
}

/// Where the MET forecast comes from: api.met.no now, a caching proxy on glett.no later (brief §4.2) with no UI change.
public protocol METForecastSource: Sendable {
    func compact(lat: Double, lon: Double) async throws -> METCompactResponse
}

/// MET Norway (api.met.no): Locationforecast compact and the radar Nowcast, with the identifying User-Agent, 4-decimal
/// coordinates, `Expires` honoured and `If-Modified-Since` sent with the previous `Last-Modified` (MET's terms).
public struct METClient: METForecastSource {
    public let http: HTTPClient
    public let cache: ForecastCache
    public let base: URL

    public init(http: HTTPClient, cache: ForecastCache, base: URL = Endpoints.production.met) {
        self.http = http; self.cache = cache; self.base = base
    }

    /// js/data.js:186: the forecast cell's coordinates with 4 decimals.
    public static func compactURL(lat la: Double, lon lo: Double, base: URL = Endpoints.production.met) -> URL {
        Endpoints.url(base, "locationforecast/2.0/compact", "lat=\(JS.toFixed(la, 4))&lon=\(JS.toFixed(lo, 4))")
    }

    /// js/data.js:681.
    public static func nowcastURL(lat la: Double, lon lo: Double, base: URL = Endpoints.production.met) -> URL {
        Endpoints.url(base, "nowcast/2.0/complete", "lat=\(JS.toFixed(la, 4))&lon=\(JS.toFixed(lo, 4))")
    }

    public func compact(lat: Double, lon: Double) async throws -> METCompactResponse {
        let url = Self.compactURL(lat: lat, lon: lon, base: base)
        let d = try await conditionalGet(url)
        do { return try JSONDecoder().decode(METCompactResponse.self, from: d) } catch { throw GlettError.upstream(host: url.host ?? "api.met.no") }
    }

    /// `nowcastPoint(la, lo)` of js/data.js:679-686: `[{t, rate}]` without null rates; nil outside radar coverage (422) or on any failure.
    public func nowcastPoint(lat la: Double, lon lo: Double) async -> [NowcastPoint]? {
        guard let d = try? await conditionalGet(Self.nowcastURL(lat: la, lon: lo, base: base)),
              let j = try? JSONDecoder().decode(METCompactResponse.self, from: d),
              let list = j.properties?.timeseries, !list.isEmpty else { return nil }
        return list.compactMap { p in
            guard let t = JS.parseISO(p.time), let r = p.data.instant?.details?.precipitation_rate else { return nil }
            return NowcastPoint(t: t, rate: r)
        }
    }

    private struct Conditional: Codable, Sendable { var lastModified: String?; var expires: Double?; var body: Data }

    /// GET with MET's caching rules: a stored answer is used until its `Expires`; after that the request carries
    /// `If-Modified-Since` and a 304 keeps the stored body.
    public func conditionalGet(_ url: URL) async throws -> Data {
        let key = "met:" + url.absoluteString
        let stored = await cache.entry(Conditional.self, key)?.value
        let now = Date().timeIntervalSince1970
        if let stored, let exp = stored.expires, exp > now { return stored.body }
        var headers: [String: String] = [:]
        if let lm = stored?.lastModified { headers["If-Modified-Since"] = lm }
        let (data, res) = try await http.send(url, headers: headers)
        let expires = (res.value(forHTTPHeaderField: "Expires")).flatMap(Self.httpDate)
        if res.statusCode == 304, let stored {
            await cache.put(Conditional(lastModified: res.value(forHTTPHeaderField: "Last-Modified") ?? stored.lastModified, expires: expires, body: stored.body), key, ttl: 86400)
            return stored.body
        }
        try HTTPClient.check(url, data, res)
        await cache.put(Conditional(lastModified: res.value(forHTTPHeaderField: "Last-Modified"), expires: expires, body: data), key, ttl: 86400)
        return data
    }

    /// An HTTP date ("Sun, 25 Oct 2026 19:35:12 GMT") as unix seconds.
    static func httpDate(_ s: String) -> Double? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return f.date(from: s)?.timeIntervalSince1970
    }

    // MARK: Yr on the forecast axis (js/data.js:125-173)

    /// `yrCode(s)` of js/data.js:125-137: MET's symbol to a WMO code.
    public static func yrCode(_ s: String) -> Int {
        let heavy = s.contains("heavy")
        if s.contains("thunder") { return 95 }
        if s.contains("snow") { return heavy ? 75 : (s.contains("showers") ? 85 : 73) }
        if s.contains("sleet") { return 68 }
        if s.contains("showers") { return heavy ? 82 : 80 }
        if s.contains("rain") { return heavy ? 65 : (s.contains("light") ? 61 : 63) }
        if s.contains("fog") { return 45 }
        if s.hasPrefix("cloudy") { return 3 }
        if s.hasPrefix("partlycloudy") { return 2 }
        if s.hasPrefix("fair") { return 1 }
        return 0
    }

    /// `yrProvider(yr, time, offset)` of js/data.js:140-173: MET resampled onto Open-Meteo's hourly axis (symbol → WMO,
    /// m/s → km/h with 1 decimal, 6-hour precipitation / 6 with 2 decimals; no apparent temperature, CAPE or is_day).
    public static func yrProvider(_ yr: METCompactResponse?, time: [String], offset: Int) -> Provider? {
        guard let list = yr?.properties?.timeseries, !list.isEmpty else { return nil }
        let pts: [(t: Double, d: METCompactResponse.DataBlock)] = list.map { (JS.parseISO($0.time) ?? .nan, $0.data) }
        var h: [HourlyVariable: [Double?]] = [:]
        for v in HourlyVariable.allCases { h[v] = [] }
        func push(_ v: HourlyVariable, _ x: Double?) { h[v]!.append(x) }
        var j = 0
        for localStr in time {
            let tt = JS.localToUnix(localStr, offset: offset)
            while j + 1 < pts.count && pts[j + 1].t <= tt { j += 1 }
            let p = pts[j]
            if tt < pts[0].t || tt - p.t > 6 * 3600 { for v in HourlyVariable.allCases { push(v, nil) }; continue }
            let d = p.d, i = d.instant?.details
            let hasHour = d.next_1_hours != nil
            let blk = d.next_1_hours ?? d.next_6_hours
            var prec: Double?
            if hasHour && p.t == tt { prec = d.next_1_hours?.details?.precipitation_amount }
            else if let six = d.next_6_hours?.details?.precipitation_amount { prec = six / 6 }
            else if hasHour { prec = d.next_1_hours?.details?.precipitation_amount }
            let sym = blk?.summary?.symbol_code
            push(.temperature2m, i?.air_temperature)
            push(.apparentTemperature, nil)
            push(.precipitation, prec.map { JS.round($0, 2) })
            push(.windSpeed10m, i?.wind_speed.map { JS.round($0 * 3.6, 1) })
            push(.windGusts10m, i?.wind_speed_of_gust.map { JS.round($0 * 3.6, 1) })
            push(.windDirection10m, i?.wind_from_direction)
            push(.cloudCover, i?.cloud_area_fraction)
            push(.relativeHumidity2m, i?.relative_humidity)
            push(.pressureMSL, i?.air_pressure_at_sea_level)
            push(.weatherCode, (sym?.isEmpty == false) ? Double(yrCode(sym!)) : nil)
            push(.cape, nil)
            push(.isDay, nil)
        }
        return Provider(id: ModelCatalog.yrID, name: "MET Norway / Yr", hourly: Hourly(values: h, count: time.count))
    }
}
