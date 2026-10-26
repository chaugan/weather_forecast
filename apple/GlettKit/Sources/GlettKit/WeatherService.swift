import Foundation

/// A forecast as the service returns it: the prepared forecast and when it was fetched.
public struct ForecastBundle: Sendable {
    public var forecast: Forecast
    public var fetchedAt: Date
    public var expiresAt: Date
    /// Served from the cache (no request made).
    public var fromCache: Bool

    /// The service builds these; previews, widgets and tests can too.
    public init(forecast: Forecast, fetchedAt: Date, expiresAt: Date, fromCache: Bool) {
        self.forecast = forecast
        self.fetchedAt = fetchedAt
        self.expiresAt = expiresAt
        self.fromCache = fromCache
    }

    /// `AUTO_REFRESH_MS` (js/app.js:28): a forecast older than this is fetched again quietly (on open and on return).
    public static let autoRefreshInterval: TimeInterval = 30 * 60

    /// Older than `autoRefreshInterval` by its `generated` time.
    public func needsAutoRefresh(now: Date = Date()) -> Bool { now.timeIntervalSince(forecast.generated) > Self.autoRefreshInterval }

    /// The consensus for the current choices.
    public func consensus(settings: ForecastSettings = .init(), weights: (any ConsensusWeights)? = nil, now: Date = Date()) -> ConsensusEngine {
        ConsensusEngine(forecast: forecast, disabled: settings.disabledModels, weighted: settings.weighted, weights: weights, now: now)
    }
}

/// The one door the UI, widgets and watch use. Requests go to the same services as the web, with the web's rounding,
/// cache keys and lifetimes; each device spends its own quota.
public actor WeatherService {
    public static let shared = WeatherService()

    public let http: HTTPClient
    public let cache: ForecastCache
    public let endpoints: Endpoints
    public let openMeteo: OpenMeteoClient
    public let met: METClient
    public let metSource: any METForecastSource
    public let glett: GlettAPIClient
    public let nowcasts: NowcastClient
    public let places: PlaceSearch
    /// The reliability check on this service's HTTP client and cache (`verification(for:)`, VerificationService.swift).
    public let verificationService: VerificationService
    /// One fetch per cell at a time: a second caller for the same cell waits for the first one's answer.
    private var inflight: [String: Task<ForecastBundle, any Error>] = [:]

    /// - Parameters:
    ///   - transport: `URLSession.shared` by default; tests pass a stub.
    ///   - metSource: where Locationforecast comes from (nil = api.met.no via `METClient`).
    public init(transport: any HTTPTransport = URLSession.shared, cache: ForecastCache = .shared, gate: RateGate? = .shared,
                identity: ClientIdentity = .current, endpoints: Endpoints = .production, metSource: (any METForecastSource)? = nil) {
        let http = HTTPClient(transport: transport, gate: gate, identity: identity)
        self.http = http
        self.cache = cache
        self.endpoints = endpoints
        openMeteo = OpenMeteoClient(http: http, endpoints: endpoints)
        met = METClient(http: http, cache: cache, base: endpoints.met)
        self.metSource = metSource ?? met
        glett = GlettAPIClient(http: http, base: endpoints.glettAPI)
        nowcasts = NowcastClient(met: met, openMeteo: openMeteo, cache: cache)
        places = PlaceSearch(openMeteo: openMeteo, http: http, geonorge: endpoints.geonorge)
        verificationService = VerificationService(http: http, cache: cache, endpoints: endpoints)
    }

    // MARK: Forecast (js/data.js:176-207)

    /// The forecast for a place's 0.01° cell. `force` ("Refresh") bypasses the cache at most once per 5 minutes per cell.
    /// MET/Yr failing is not an error (the 13 models still come); Open-Meteo failing is.
    public func forecast(for place: Place, force: Bool = false) async throws -> ForecastBundle {
        try await forecast(lat: place.lat, lon: place.lon, force: force)
    }

    public func forecast(lat: Double, lon: Double, force: Bool = false) async throws -> ForecastBundle {
        let la = OpenMeteoClient.cell(lat), lo = OpenMeteoClient.cell(lon)
        let key = CacheKey.forecast(lat: la, lon: lo)
        var refresh = force
        if refresh, !(await cache.mayForceRefresh(key)) { refresh = false }   // throttled: serve the cache
        if !refresh, let e = await cache.entry(Forecast.self, key), e.isFresh() {
            return ForecastBundle(forecast: e.value, fetchedAt: e.fetchedAt, expiresAt: e.expiresAt, fromCache: true)
        }
        if let running = inflight[key] { return try await running.value }
        let task = Task { [openMeteo, metSource, cache] () async throws -> ForecastBundle in
            async let omTask = openMeteo.forecastResponse(lat: la, lon: lo)
            async let yrTask: METCompactResponse? = try? metSource.compact(lat: la, lon: lo)   // MET failing is not an error
            let om = try await omTask
            let yr = await yrTask
            let offset = Int(om.utc_offset_seconds ?? 0)
            var providers = OpenMeteoClient.providers(from: om)
            if let y = METClient.yrProvider(yr, time: om.time, offset: offset) { providers.append(y) }
            let now = Date()
            let f = Forecast(lat: la, lon: lo, timezone: om.timezone, utcOffsetSeconds: offset, elevation: om.elevation, generated: now,
                             time: om.time, providers: providers).prepared()
            await cache.put(f, key, ttl: CacheKey.forecastTTL)
            if refresh { await cache.markForcedRefresh(key) }
            return ForecastBundle(forecast: f, fetchedAt: now, expiresAt: now.addingTimeInterval(CacheKey.forecastTTL), fromCache: false)
        }
        inflight[key] = task
        defer { inflight[key] = nil }
        return try await task.value
    }

    /// The newest cached forecast for the cell, fresh or not, without any request (widgets, watch, first paint).
    public func cachedForecast(for place: Place) async -> ForecastBundle? {
        let key = CacheKey.forecast(lat: OpenMeteoClient.cell(place.lat), lon: OpenMeteoClient.cell(place.lon))
        guard let e = await cache.entry(Forecast.self, key) else { return nil }
        return ForecastBundle(forecast: e.value, fetchedAt: e.fetchedAt, expiresAt: e.expiresAt, fromCache: true)
    }

    // MARK: Nowcast, warnings, measured now

    /// The radar nowcast (or the model fallback); nil when neither answers.
    public func nowcast(for place: Place) async -> NowcastSeries? {
        await nowcasts.nowcast(lat: place.lat, lon: place.lon)
    }

    /// All MET warnings (`fetchAlerts`, js/data.js:746-754), cached 10 minutes per language; nil when unavailable.
    /// `lang` is "nb" or "en".
    public func alerts(lang: String) async -> AlertsResponse? {
        let l = lang == "en" ? "en" : "nb", key = CacheKey.alerts(lang: l)
        if let c = await cache.get(AlertsResponse.self, key) { return c }
        guard let j = try? await glett.alerts(lang: l) else { return nil }
        await cache.put(j, key, ttl: CacheKey.alertsTTL)
        return j
    }

    /// The warnings in force at a place, most serious first (`loadAlerts` + `lmAlertsHere`, js/app.js:2283-2314):
    /// Norway only, matched at the forecast cell's point. `[]` = none (or outside Norway), nil = the warnings could
    /// not be fetched, so a caller can keep what it showed before instead of reading it as "no warnings".
    public func alerts(for place: Place, lang: String) async -> [MetAlert]? {
        guard place.inNorway else { return [] }
        guard let a = await alerts(lang: lang) else { return nil }
        return a.here(lat: OpenMeteoClient.cell(place.lat), lon: OpenMeteoClient.cell(place.lon))
    }

    /// "Measured nearby right now" (`fetchLocal`, js/data.js:721-729): nil when the service is unavailable; `ok == false`
    /// (with the station count) when too few stations report.
    public func measuredNow(for place: Place) async -> MeasuredNow? {
        let la = OpenMeteoClient.cell(place.lat), lo = OpenMeteoClient.cell(place.lon), key = CacheKey.local(lat: la, lon: lo)
        if let c = await cache.get(MeasuredNow.self, key) { return c }
        guard let j = try? await glett.netatmo(lat: la, lon: lo) else { return nil }
        if !j.ok {
            let few = MeasuredNow(ok: false, stations: j.stations)
            await cache.put(few, key, ttl: CacheKey.localFewTTL)
            return few
        }
        await cache.put(j, key, ttl: CacheKey.localTTL)
        return j
    }

    // MARK: Search

    /// The forecast page's search (Open-Meteo geocoding). `lang` is "nb" or "en".
    public func search(_ q: String, lang: String) async throws -> [PlaceHit] {
        try await places.places(q, lang: lang)
    }

    /// Kjørevær's search: addresses and streets from Kartverket as well as places.
    public func searchAddresses(_ q: String, lang: String) async -> [PlaceHit] {
        await places.search(q, lang: lang)
    }

    /// A name for a point from glett.no (fallback after CLGeocoder).
    public func reverseName(lat: Double, lon: Double, lang: String, detailed: Bool = false) async -> String? {
        (try? await glett.reverse(lat: lat, lon: lon, lang: lang, detailed: detailed)) ?? nil
    }

    /// Drops cache files that expired more than a week ago (call once per launch, after the first render, as the web
    /// does after 4 s; `ForecastCache.sweep`).
    public func sweepCache() async { await cache.sweep() }
}
