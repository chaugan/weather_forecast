import Foundation

/// Open-Meteo's forecast answer for several models (`hourly` holds `<variable>_<model>` arrays).
public struct OpenMeteoForecastResponse: Sendable, Decodable {
    public var latitude: Double?
    public var longitude: Double?
    public var timezone: String?
    public var utc_offset_seconds: Double?
    public var elevation: Double?
    public var time: [String]
    public var series: [String: [Double?]]

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        latitude = try? c.decodeIfPresent(Double.self, forKey: Key("latitude"))
        longitude = try? c.decodeIfPresent(Double.self, forKey: Key("longitude"))
        timezone = try? c.decodeIfPresent(String.self, forKey: Key("timezone"))
        utc_offset_seconds = try? c.decodeIfPresent(Double.self, forKey: Key("utc_offset_seconds"))
        elevation = try? c.decodeIfPresent(Double.self, forKey: Key("elevation"))
        guard c.contains(Key("hourly")) else { time = []; series = [:]; return }
        let h = try c.nestedContainer(keyedBy: Key.self, forKey: Key("hourly"))
        time = (try? h.decode([String].self, forKey: Key("time"))) ?? []
        var s: [String: [Double?]] = [:]
        for k in h.allKeys where k.stringValue != "time" { if let a = try? h.decode([Double?].self, forKey: k) { s[k.stringValue] = a } }
        series = s
    }

    public init(timezone: String?, utcOffsetSeconds: Double?, elevation: Double?, time: [String], series: [String: [Double?]]) {
        self.timezone = timezone; utc_offset_seconds = utcOffsetSeconds; self.elevation = elevation; self.time = time; self.series = series
    }
}

/// Open-Meteo: the 13-model forecast (js/data.js:176-207), the 15-minute nowcast fallback (js/data.js:690-702) and
/// place search (js/data.js:668-671). Every call goes through the RateGate (in `HTTPClient`).
public struct OpenMeteoClient: Sendable {
    public let http: HTTPClient
    public let endpoints: Endpoints

    public init(http: HTTPClient, endpoints: Endpoints = .production) { self.http = http; self.endpoints = endpoints }

    /// `+lat.toFixed(2)`: the 0.01° cell every forecast request and cache entry uses (js/data.js:177).
    public static func cell(_ x: Double) -> Double { JS.fixed(x, 2) }

    /// The forecast URL of js/data.js:184, byte for byte (commas encoded as %2C, as `encodeURIComponent` does).
    public static func forecastURL(lat la: Double, lon lo: Double, base: URL = Endpoints.production.openMeteo) -> URL {
        Endpoints.url(base, "v1/forecast", JS.qs([
            ("latitude", JS.string(la)), ("longitude", JS.string(lo)),
            ("hourly", HourlyVariable.allCases.map(\.rawValue).joined(separator: ",")),
            ("models", ModelCatalog.openMeteoModels.joined(separator: ",")),
            ("timezone", "auto"), ("forecast_days", "7"),
        ]))
    }

    /// Fetches the 13 models for an already rounded cell.
    public func forecastResponse(lat la: Double, lon lo: Double) async throws -> OpenMeteoForecastResponse {
        let url = Self.forecastURL(lat: la, lon: lo, base: endpoints.openMeteo)
        let r = try await http.json(OpenMeteoForecastResponse.self, url)
        guard !r.time.isEmpty else { throw GlettError.upstream(host: url.host ?? "api.open-meteo.com") }
        return r
    }

    /// js/data.js:190-200: one provider per model that has some value other than `is_day`.
    public static func providers(from om: OpenMeteoForecastResponse) -> [Provider] {
        let n = om.time.count
        var out: [Provider] = []
        for id in ModelCatalog.openMeteoModels {
            var values: [HourlyVariable: [Double?]] = [:]
            var has = false
            for v in HourlyVariable.allCases {
                let arr = om.series["\(v.rawValue)_\(id)"] ?? Array(repeating: nil, count: n)
                values[v] = arr
                if v != .isDay && arr.contains(where: { $0 != nil }) { has = true }
            }
            if has { out.append(Provider(id: id, hourly: Hourly(values: values, count: n))) }
        }
        return out
    }

    /// The model nowcast URL of js/data.js:694.
    public static func minutelyURL(lat la: Double, lon lo: Double, base: URL = Endpoints.production.openMeteo) -> URL {
        Endpoints.url(base, "v1/forecast", JS.qs([
            ("latitude", JS.string(la)), ("longitude", JS.string(lo)), ("minutely_15", "precipitation"),
            ("forecast_minutely_15", "10"), ("timezone", "auto"), ("models", "best_match"),
        ]))
    }

    private struct Minutely: Decodable {
        struct M: Decodable { var time: [String]?; var precipitation: [Double?]? }
        var utc_offset_seconds: Double?
        var minutely_15: M?
    }

    /// `nowcastModel` (js/data.js:690-702) without the cache: 15-minute precipitation as mm/h (× 4, 2 decimals); nil on
    /// any failure or no values.
    public func modelNowcast(lat la: Double, lon lo: Double, now: Date = Date()) async -> NowcastSeries? {
        guard let j = try? await http.json(Minutely.self, Self.minutelyURL(lat: la, lon: lo, base: endpoints.openMeteo)),
              let m = j.minutely_15, let time = m.time else { return nil }
        let offset = Int(j.utc_offset_seconds ?? 0)
        let pr = m.precipitation ?? []
        var series: [NowcastPoint] = []
        for (i, s) in time.enumerated() {
            guard i < pr.count, let mm = pr[i] else { continue }
            series.append(NowcastPoint(t: JS.localToUnix(s, offset: offset), rate: JS.fixed(mm * 4, 2)))
        }
        guard !series.isEmpty else { return nil }
        return NowcastSeries(series: series, ring: [], km: 0, model: true, fetched: now.timeIntervalSince1970.rounded(.down))
    }

    /// The geocoding URL of js/data.js:669 (count 8, then language, then name).
    public static func searchURL(_ q: String, lang: String, base: URL = Endpoints.production.openMeteoGeocoding) -> URL {
        Endpoints.url(base, "v1/search", JS.qs([("count", "8"), ("language", lang), ("name", q)]))
    }

    private struct Geo: Decodable {
        struct R: Decodable { var name: String?; var admin1: String?; var country: String?; var latitude: Double; var longitude: Double; var country_code: String? }
        var results: [R]?
    }

    /// `search(q, lang)` of js/data.js:668-671: "name, region, country" hits. The caller debounces ≥ 350 ms and needs ≥ 2 characters.
    public func search(_ q: String, lang: String) async throws -> [PlaceHit] {
        let j = try await http.json(Geo.self, Self.searchURL(q, lang: lang, base: endpoints.openMeteoGeocoding))
        return (j.results ?? []).map { r in
            let name = [r.name, r.admin1, r.country].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
            return PlaceHit(name: name, lat: r.latitude, lon: r.longitude, cc: r.country_code, kind: .place)
        }
    }
}
