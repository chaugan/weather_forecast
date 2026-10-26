import Foundation

/// `fetchNowcast(lat, lon)` of js/data.js:703-718: MET's radar nowcast for the point and, inside radar coverage, eight
/// points 5 km around it; outside coverage Open-Meteo's 15-minute model precipitation. Cached 5 minutes (15 for the model).
public struct NowcastClient: Sendable {
    /// `NOWCAST_RING_KM` (js/data.js:688).
    public static let ringKm = 5.0
    /// `RING_DIRS` (js/data.js:688).
    public static let ringDirections = ["n", "ne", "e", "se", "s", "sw", "w", "nw"]

    public let met: METClient
    public let openMeteo: OpenMeteoClient
    public let cache: ForecastCache

    public init(met: METClient, openMeteo: OpenMeteoClient, cache: ForecastCache) { self.met = met; self.openMeteo = openMeteo; self.cache = cache }

    /// The ring points (js/data.js:710-711): 5 km out at 0°, 45°, …, rounded to 0.001°.
    public static func ringPoints(lat la: Double, lon lo: Double) -> [(dir: String, lat: Double, lon: Double)] {
        let dLat = ringKm / 111.2, dLon = dLat / max(0.2, Foundation.cos((la * Double.pi) / 180))
        return ringDirections.enumerated().map { k, dir in
            let a = (Double(k) * Double.pi) / 4
            return (dir, JS.fixed(la + dLat * Foundation.cos(a), 3), JS.fixed(lo + dLon * Foundation.sin(a), 3))
        }
    }

    public func nowcast(lat: Double, lon: Double, now: Date = Date()) async -> NowcastSeries? {
        let la = JS.fixed(lat, 2), lo = JS.fixed(lon, 2), key = CacheKey.nowcast(lat: la, lon: lo)
        if let c = await cache.get(NowcastSeries.self, key) { return c }
        guard let series = await met.nowcastPoint(lat: la, lon: lo) else { return await model(la, lo, now) }
        var ring: [NowcastSeries.Ring] = []
        if !series.isEmpty {   // inside radar coverage: the neighbours too, in parallel; a failed one is left out
            let pts = Self.ringPoints(lat: la, lon: lo)
            let got = await withTaskGroup(of: (Int, [NowcastPoint]?).self) { g in
                for (k, p) in pts.enumerated() { g.addTask { (k, await met.nowcastPoint(lat: p.lat, lon: p.lon)) } }
                var out = [[NowcastPoint]?](repeating: nil, count: pts.count)
                for await (k, s) in g { out[k] = s }
                return out
            }
            ring = pts.enumerated().compactMap { k, p in got[k].flatMap { $0.isEmpty ? nil : NowcastSeries.Ring(dir: p.dir, series: $0) } }
        }
        let data = NowcastSeries(series: series, ring: ring, km: Self.ringKm, model: false, fetched: now.timeIntervalSince1970.rounded(.down))
        await cache.put(data, key, ttl: CacheKey.nowcastTTL)
        return data
    }

    private func model(_ la: Double, _ lo: Double, _ now: Date) async -> NowcastSeries? {
        let key = CacheKey.nowcastModel(lat: la, lon: lo)
        if let c = await cache.get(NowcastSeries.self, key) { return c }
        guard let data = await openMeteo.modelNowcast(lat: la, lon: lo, now: now) else { return nil }
        await cache.put(data, key, ttl: CacheKey.nowcastModelTTL)
        return data
    }
}
