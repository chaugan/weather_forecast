import Foundation

/// Sends one request. `URLSession` conforms; tests inject a stub.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPTransport {
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Who the app says it is (brief §3.3): `User-Agent: Glett-iOS/<version> (+https://glett.no; mail@hauganmg.no)` to
/// api.met.no and glett.no, and `X-Glett-Client: ios/<build>` to glett.no. No device identifiers.
public struct ClientIdentity: Sendable, Hashable {
    /// "Glett-iOS" (a watch build may say "Glett-watchOS").
    public var product: String
    /// `CFBundleShortVersionString`.
    public var version: String
    /// `CFBundleVersion`.
    public var build: String
    /// "ios" in `X-Glett-Client`.
    public var platform: String

    public init(product: String = "Glett-iOS", version: String, build: String, platform: String = "ios") {
        self.product = product; self.version = version; self.build = build; self.platform = platform
    }

    /// From the main bundle (falls back to 0.1.0 / 1 where there is no app bundle, as in `swift test`).
    public static var current: ClientIdentity {
        let info = Bundle.main.infoDictionary ?? [:]
        let v = info["CFBundleShortVersionString"] as? String
        let b = info["CFBundleVersion"] as? String
        let isApp = Bundle.main.bundlePath.hasSuffix(".app") || Bundle.main.bundlePath.hasSuffix(".appex")
        return ClientIdentity(version: isApp ? (v ?? "0.1.0") : "0.1.0", build: isApp ? (b ?? "1") : "1")
    }

    public var userAgent: String { "\(product)/\(version) (+https://glett.no; \(GlettKit.contactEmail))" }
    public var clientHeader: String { "\(platform)/\(build)" }
}

/// Base URLs, injectable so tests (or a later MET proxy on glett.no, brief §4.2) can point elsewhere.
public struct Endpoints: Sendable, Hashable {
    public var openMeteo: URL
    public var openMeteoGeocoding: URL
    /// Archived forecasts for verification (js/data.js:315).
    public var openMeteoHistorical: URL
    /// ERA5 (verification truth and history, js/data.js:316, 377).
    public var openMeteoArchive: URL
    /// api.met.no's `weatherapi/` root.
    public var met: URL
    /// glett.no's `api/` root.
    public var glettAPI: URL
    public var geonorge: URL

    public init(openMeteo: URL, openMeteoGeocoding: URL, openMeteoHistorical: URL, openMeteoArchive: URL, met: URL, glettAPI: URL, geonorge: URL) {
        self.openMeteo = openMeteo; self.openMeteoGeocoding = openMeteoGeocoding; self.openMeteoHistorical = openMeteoHistorical
        self.openMeteoArchive = openMeteoArchive; self.met = met; self.glettAPI = glettAPI; self.geonorge = geonorge
    }

    public static let production = Endpoints(
        openMeteo: URL(string: "https://api.open-meteo.com/")!,
        openMeteoGeocoding: URL(string: "https://geocoding-api.open-meteo.com/")!,
        openMeteoHistorical: URL(string: "https://historical-forecast-api.open-meteo.com/")!,
        openMeteoArchive: URL(string: "https://archive-api.open-meteo.com/")!,
        met: URL(string: "https://api.met.no/weatherapi/")!,
        glettAPI: URL(string: "https://glett.no/api/")!,
        geonorge: URL(string: "https://ws.geonorge.no/")!)

    /// `base` + path + "?" + query, as a string, so the URL is byte for byte the web's (build `query` with `JS.qs`).
    public static func url(_ base: URL, _ path: String, _ query: String) -> URL {
        var s = base.absoluteString
        if !s.hasSuffix("/") { s += "/" }
        return URL(string: s + path + (query.isEmpty ? "" : "?" + query))!
    }
}

/// `getJson(url)` of js/data.js:105-118: one GET, Open-Meteo through the RateGate, errors mapped as the web maps them.
public struct HTTPClient: Sendable {
    public let transport: any HTTPTransport
    public let gate: RateGate?
    public let identity: ClientIdentity
    public var timeout: TimeInterval = 25

    public init(transport: any HTTPTransport = URLSession.shared, gate: RateGate? = .shared, identity: ClientIdentity = .current) {
        self.transport = transport; self.gate = gate; self.identity = identity
    }

    /// The request with the headers its host needs: the identifying User-Agent for api.met.no and glett.no, plus
    /// `X-Glett-Client` for glett.no. No cookies, no shared cache (the web asks Open-Meteo with `cache: 'no-store'`).
    public func request(_ url: URL, headers: [String: String] = [:]) -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpShouldHandleCookies = false
        let host = url.host ?? ""
        let glett = host == "glett.no" || host.hasSuffix(".glett.no")
        if glett || host == "api.met.no" || host.hasSuffix(".met.no") { r.setValue(identity.userAgent, forHTTPHeaderField: "User-Agent") }
        if glett { r.setValue(identity.clientHeader, forHTTPHeaderField: "X-Glett-Client") }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    /// Raw send with the web's error mapping for transport failures and Open-Meteo's gate; any status is returned.
    public func send(_ url: URL, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        let host = url.host ?? ""
        let req = request(url, headers: headers)
        do {
            if let gate, RateGate.isOpenMeteo(url) {
                return try await gate.fetch(url) { try await transport.send(req) }
            }
            return try await transport.send(req)
        } catch let e as GlettError { throw e }
        catch is CancellationError { throw CancellationError() }
        catch let e as URLError where e.code == .cancelled { throw CancellationError() }
        catch { throw GlettError.network(host: host) }
    }

    /// GET and return the body of a 2xx answer; 429 and "limit/quota" reasons are `.quota`.
    public func data(_ url: URL, headers: [String: String] = [:]) async throws -> Data {
        let (data, res) = try await send(url, headers: headers)
        try Self.check(url, data, res)
        return data
    }

    /// GET and decode JSON.
    public func json<T: Decodable>(_ type: T.Type, _ url: URL, headers: [String: String] = [:]) async throws -> T {
        let d = try await data(url, headers: headers)
        do { return try JSONDecoder().decode(T.self, from: d) } catch { throw GlettError.upstream(host: url.host ?? "") }
    }

    /// The status checks of js/data.js:110-116.
    static func check(_ url: URL, _ data: Data, _ res: HTTPURLResponse) throws {
        let host = url.host ?? ""
        if res.statusCode == 429 { throw GlettError.quota(host: host, limit: .minute) }
        guard (200..<300).contains(res.statusCode) else {
            let reason = Self.reason(data)
            if reason.range(of: "limit|quota", options: [.regularExpression, .caseInsensitive]) != nil { throw GlettError.quota(host: host, limit: .minute) }
            throw GlettError.http(host: host, status: res.statusCode, reason: reason.isEmpty ? nil : reason)
        }
    }

    /// `String(j.reason || j.error || '')` of an error body.
    static func reason(_ data: Data) -> String {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        for k in ["reason", "error"] {
            if let s = o[k] as? String, !s.isEmpty { return s }
            if let b = o[k] as? Bool, b { return "true" }
            if let n = o[k] as? NSNumber, n.doubleValue != 0 { return n.stringValue }
        }
        return ""
    }
}
