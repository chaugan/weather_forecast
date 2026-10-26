import Foundation

/// The reliability check could not run (`err.verify`): no archived forecasts, or no truth to score them against.
public enum VerificationError: Error, Sendable, Equatable {
    case unavailable

    public var l10nKey: String { "err.verify" }
    public var l10nArgs: [String: String] { [:] }
}

/// `fetchVerify(lat, lon)` (js/data.js:295-373): fetches archived forecasts and the truth for the 0.1° cell, scores
/// the models with `VerificationEngine`, and caches the result 24 h under `vf3:<lat1>:<lon1>`.
///
/// Norway (`inNorway`): MET stations through `api/frost.php?truth=1` (≥ 168 hours), blended with Glett's Netatmo
/// snapshots from `api/netatmo.php?history=1`. Elsewhere, or when Frost has too little: ERA5 from archive-api, blended
/// with METAR from `api/metar.php`. Open-Meteo requests go through the RateGate (in `HTTPClient`).
public actor VerificationService {
    public static let shared = VerificationService()

    public let http: HTTPClient
    public let cache: ForecastCache
    public let endpoints: Endpoints
    public let glett: GlettAPIClient
    private let clock: @Sendable () -> Date
    /// One run per cell at a time: a second caller waits for the first one's answer.
    private var inflight: [String: Task<VerificationResult, any Error>] = [:]

    public init(http: HTTPClient = HTTPClient(), cache: ForecastCache = .shared, endpoints: Endpoints = .production,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.http = http; self.cache = cache; self.endpoints = endpoints; self.clock = clock
        glett = GlettAPIClient(http: http, base: endpoints.glettAPI)
    }

    /// `+x.toFixed(1)`: the 0.1° cell (also what api/metar.php caches by).
    public static func cell(_ x: Double) -> Double { JS.fixed(x, 1) }

    /// The archived-forecast URL of js/data.js:317 (`qs({...base, start_date, end_date, models})`).
    public static func historicalURL(lat la: Double, lon lo: Double, start: String, end: String, base: URL = Endpoints.production.openMeteoHistorical) -> URL {
        Endpoints.url(base, "v1/forecast", JS.qs(baseQuery(la, lo) + [("start_date", start), ("end_date", end), ("models", ModelCatalog.verifyModels.joined(separator: ","))]))
    }

    /// The ERA5 URL of js/data.js:318.
    public static func archiveURL(lat la: Double, lon lo: Double, start: String, end: String, base: URL = Endpoints.production.openMeteoArchive) -> URL {
        Endpoints.url(base, "v1/archive", JS.qs(baseQuery(la, lo) + [("start_date", start), ("end_date", end)]))
    }

    private static func baseQuery(_ la: Double, _ lo: Double) -> [(String, String)] {
        [("latitude", JS.string(la)), ("longitude", JS.string(lo)), ("hourly", VerificationEngine.verifyVars.joined(separator: ",")), ("timezone", "UTC")]
    }

    /// The reliability for a place's 0.1° cell: from the cache when fresh (24 h), otherwise fetched. `force` skips the cache.
    /// Throws `GlettError` from the archived-forecast request (or ERA5's), or `VerificationError.unavailable`.
    public func verification(lat: Double, lon: Double, force: Bool = false) async throws -> VerificationResult {
        let la = Self.cell(lat), lo = Self.cell(lon), key = CacheKey.verify(lat: la, lon: lo)
        if !force, let c = await cache.get(VerificationResult.self, key) { return c }
        if let running = inflight[key] { return try await running.value }
        let task = Task { [http, glett, endpoints, cache, clock] () async throws -> VerificationResult in
            let r = try await Self.fetch(la: la, lo: lo, now: clock(), http: http, glett: glett, endpoints: endpoints)
            await cache.put(r, key, ttl: CacheKey.verifyTTL)
            return r
        }
        inflight[key] = task
        defer { inflight[key] = nil }
        return try await task.value
    }

    public func verification(for place: Place, force: Bool = false) async throws -> VerificationResult {
        try await verification(lat: place.lat, lon: place.lon, force: force)
    }

    /// The newest stored result for the cell, also an expired one, without any request (widgets, watch, first paint).
    public func cachedVerification(lat: Double, lon: Double) async -> VerificationResult? {
        await cachedVerificationEntry(lat: lat, lon: lon)?.value
    }

    /// The stored result with its times (`isFresh()`: the web would still use it as weights), also an expired one.
    public func cachedVerificationEntry(lat: Double, lon: Double) async -> CacheEntry<VerificationResult>? {
        await cache.entry(VerificationResult.self, CacheKey.verify(lat: Self.cell(lat), lon: Self.cell(lon)))
    }

    private static func fetch(la: Double, lo: Double, now: Date, http: HTTPClient, glett: GlettAPIClient, endpoints: Endpoints) async throws -> VerificationResult {
        let win = VerificationEngine.Window(now: now)
        var frost: FrostTruth?, nt: NetatmoHistory?
        if Place.inNorway(lat: la, lon: lo) {
            async let f: FrostTruth? = {
                // the first request for a new area can hit the web host's ~15 s limit after the station choice is saved; one retry is then quick
                if let f = try? await glett.frostTruth(lat: la, lon: lo, from: win.frostStart, to: win.forecastEnd) { return f }
                return try? await glett.frostTruth(lat: la, lon: lo, from: win.frostStart, to: win.forecastEnd)
            }()
            async let n: NetatmoHistory? = try? glett.netatmoHistory(lat: la, lon: lo, days: VerificationEngine.windowDays)
            frost = VerificationEngine.usableFrost(await f)
            nt = await n
        }
        try Task.checkCancellation()
        let useFrost = frost != nil
        let start = win.start(frost: useFrost), truthEnd = win.truthEnd(frost: useFrost)
        let fcURL = historicalURL(lat: la, lon: lo, start: start, end: win.forecastEnd, base: endpoints.openMeteoHistorical)
        async let fcTask = http.json(OpenMeteoForecastResponse.self, fcURL)
        async let truthTask: Result<OpenMeteoForecastResponse, any Error>? = useFrost ? nil : {
            do { return .success(try await http.json(OpenMeteoForecastResponse.self, archiveURL(lat: la, lon: lo, start: start, end: truthEnd, base: endpoints.openMeteoArchive))) }
            catch { return .failure(error) }
        }()
        async let metarTask: MetarResponse? = useFrost ? nil : try? glett.metar(lat: la, lon: lo)
        let fc = try await fcTask
        let truthResult = await truthTask, metar = await metarTask
        guard !fc.time.isEmpty else { throw VerificationError.unavailable }
        var truth: OpenMeteoForecastResponse?
        if !useFrost {
            switch truthResult {
            case .success(let t)?: truth = t
            case .failure(let e)?: throw e   // no ERA5 = nothing to score against
            case nil: break
            }
            guard let t = truth, !t.time.isEmpty else { throw VerificationError.unavailable }
        }
        guard let r = VerificationEngine.result(forecast: fc, truth: truth, frost: frost, netatmo: nt, metar: metar, now: now) else {
            throw VerificationError.unavailable
        }
        return r
    }
}

extension WeatherService {
    /// The reliability weights and scores for a place (`fetchVerify`), cached 24 h per 0.1° cell, through this
    /// service's transport, gate and cache. Pass the result as `weights:` to `ForecastBundle.consensus`.
    public func verification(for place: Place, force: Bool = false) async throws -> VerificationResult {
        try await verificationService.verification(for: place, force: force)
    }

    /// The stored reliability for the cell, also when expired; no request.
    public func cachedVerification(for place: Place) async -> VerificationResult? {
        await verificationService.cachedVerification(lat: place.lat, lon: place.lon)
    }

    /// The stored reliability with its times; no request. Use it as weights only while `isFresh()`, as the web does.
    public func cachedVerificationEntry(for place: Place) async -> CacheEntry<VerificationResult>? {
        await verificationService.cachedVerificationEntry(lat: place.lat, lon: place.lon)
    }
}
