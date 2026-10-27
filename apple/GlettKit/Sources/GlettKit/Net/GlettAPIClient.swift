import Foundation

/// The PHP endpoints on glett.no (`api/*.php`) that the forecast pages use. Every call carries the identifying
/// User-Agent and `X-Glett-Client` (see `HTTPClient.request`). No caching here; `WeatherService` caches as the web does.
public struct GlettAPIClient: Sendable {
    public let http: HTTPClient
    public let base: URL

    public init(http: HTTPClient, base: URL = Endpoints.production.glettAPI) { self.http = http; self.base = base }

    func url(_ file: String, _ query: String) -> URL { Endpoints.url(base, file, query) }

    /// `api/alerts.php?lang=nb|en` (js/data.js:746-754): MET warnings for Norway.
    public func alerts(lang: String) async throws -> AlertsResponse {
        try await http.json(AlertsResponse.self, url("alerts.php", "lang=\(lang == "en" ? "en" : "nb")"))
    }

    /// `api/netatmo.php?lat=&lon=` (js/data.js:721-729), the cell to 0.01°.
    public func netatmo(lat: Double, lon: Double) async throws -> MeasuredNow {
        let la = JS.fixed(lat, 2), lo = JS.fixed(lon, 2)
        return try await http.json(MeasuredNow.self, url("netatmo.php", "lat=\(JS.string(la))&lon=\(JS.string(lo))"))
    }

    /// `api/netatmo.php?map=1&r=&lat=&lon=` (js/data.js:795-804).
    public func netatmoMap(lat: Double, lon: Double, r: Double = 0.25) async throws -> NetatmoMap {
        let la = JS.fixed(lat, 2), lo = JS.fixed(lon, 2)
        let j = try await http.json(JSONValue.self, url("netatmo.php", "map=1&r=\(JS.string(r))&lat=\(JS.string(la))&lon=\(JS.string(lo))"))
        func arr(_ k: String) -> [[Double?]] {
            guard case .object(let o) = j, case .array(let a)? = o[k] else { return [] }
            return a.map { row in if case .array(let r) = row { return r.map(\.numberValue) }; return [] }
        }
        return NetatmoMap(pts: arr("pts"), rain: arr("rain_pts"), wind: arr("wind_pts"))
    }

    /// `api/netatmo.php?history=1&lat=&lon=&days=` (js/data.js:306): Glett's hourly snapshots, for verification.
    public func netatmoHistory(lat: Double, lon: Double, days: Int = 28) async throws -> NetatmoHistory {
        try await http.json(NetatmoHistory.self, url("netatmo.php", "history=1&lat=\(JS.string(lat))&lon=\(JS.string(lon))&days=\(days)"))
    }

    /// `api/metar.php?lat=&lon=` (js/data.js:317), the 0.1° verification cell.
    public func metar(lat: Double, lon: Double) async throws -> MetarResponse {
        let d = try await http.data(url("metar.php", "lat=\(JS.string(lat))&lon=\(JS.string(lon))"))
        // PHP sends `{}` for no observations and `[]` would be an empty list: both are an empty map here
        guard var o = try JSONSerialization.jsonObject(with: d) as? [String: Any] else { throw GlettError.upstream(host: base.host ?? "glett.no") }
        if o["obs"] is [Any] { o["obs"] = [String: Any]() }
        if o["station"] is NSNull { o["station"] = nil }
        let clean = try JSONSerialization.data(withJSONObject: o)
        do { return try JSONDecoder().decode(MetarResponse.self, from: clean) } catch { throw GlettError.upstream(host: base.host ?? "glett.no") }
    }

    /// `api/frost.php?truth=1&lat=&lon=&from=&to=` (js/data.js:305): MET station hours as truth (Norway).
    public func frostTruth(lat: Double, lon: Double, from: String, to: String) async throws -> FrostTruth {
        try await http.json(FrostTruth.self, url("frost.php", "truth=1&lat=\(JS.string(lat))&lon=\(JS.string(lon))&from=\(from)&to=\(to)"))
    }

    /// `api/wind.php?meta=1` (js/windmap.js `loadMeta`): the wind map's newest run and its hours.
    public func windMeta() async throws -> WindMeta {
        try await http.json(WindMeta.self, url("wind.php", "meta=1"))
    }

    /// `api/wind.php?run=&t=&s=&w=&n=&e=&nx=&ny=[&r=1]` (js/windmap.js `frame`): one hour of the wind for a box, in
    /// 0.1 m/s with null where MET has nothing.
    public func windFrame(run: String, t: Double, view v: WindView) async throws -> WindFrame {
        struct R: Decodable { var run: String; var t: Double; var s, w, n, e: Double; var nx, ny: Int; var u, v: [Int?] }
        let q = "run=\(run)&t=\(Int(t))&s=\(JS.string(v.s))&w=\(JS.string(v.w))&n=\(JS.string(v.n))&e=\(JS.string(v.e))&nx=\(v.nx)&ny=\(v.ny)\(v.fine ? "&r=1" : "")"
        let r = try await http.json(R.self, url("wind.php", q))
        guard r.u.count == r.nx * r.ny, r.v.count == r.u.count else { throw GlettError.upstream(host: base.host ?? "glett.no") }
        func m(_ a: [Int?]) -> [Float] { a.map { $0.map { Float($0) / 10 } ?? .nan } }
        return WindFrame(run: r.run, t: r.t, s: r.s, w: r.w, n: r.n, e: r.e, nx: r.nx, ny: r.ny, u: m(r.u), v: m(r.v))
    }

    /// `api/reverse.php?lat=&lon=&lang=[&z=14]` (js/data.js:672-675): a place name, nil when unknown. The app uses
    /// CLGeocoder first (brief §3.3); this is the fallback.
    public func reverse(lat: Double, lon: Double, lang: String, detailed: Bool = false) async throws -> String? {
        struct R: Decodable { var name: String? }
        return try await http.json(R.self, url("reverse.php", "lat=\(JS.toFixed(lat, 4))&lon=\(JS.toFixed(lon, 4))&lang=\(lang)\(detailed ? "&z=14" : "")")).name
    }
}
