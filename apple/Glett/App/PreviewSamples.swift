import Foundation
import GlettKit

/// Sample data for SwiftUI previews: the recorded Oslo answers in GlettKitTests/Fixtures/raw (Open-Meteo + MET,
/// 2026-10-25 20:00 UTC), read from the source tree. Where the source tree is not there (a device), a small
/// synthetic forecast stands in so previews never fail.
enum PreviewSamples {
    struct Sample {
        var place: Place
        var bundle: ForecastBundle
        var nowcast: NowcastSeries?
        var now: Date
    }

    /// The fixtures' `now` (expected/oslo.json).
    static let fixtureNow = Date(timeIntervalSince1970: 1_792_958_400)

    static let oslo: Sample = {
        let place = Place(id: "city:oslo", name: "Oslo", lat: 59.9139, lon: 10.7522)
        let f = recorded("oslo") ?? synthetic()
        let bundle = ForecastBundle(forecast: f, fetchedAt: fixtureNow, expiresAt: fixtureNow.addingTimeInterval(CacheKey.forecastTTL), fromCache: false)
        return Sample(place: place, bundle: bundle, nowcast: nowcast(now: fixtureNow), now: fixtureNow)
    }()

    /// A consensus over the sample, for previews of single views.
    static var engine: ConsensusEngine { oslo.bundle.consensus(settings: ForecastSettings(), weights: nil, now: oslo.now) }

    private static var fixtureDir: URL {
        URL(fileURLWithPath: #filePath)   // apple/Glett/App/PreviewSamples.swift
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "GlettKit/Tests/GlettKitTests/Fixtures/raw")
    }

    /// Builds the forecast exactly as `WeatherService.forecast` does, from the recorded answers.
    private static func recorded(_ slug: String) -> Forecast? {
        let dec = JSONDecoder()
        guard let omData = try? Data(contentsOf: fixtureDir.appending(path: "\(slug).openmeteo.json")),
              let om = try? dec.decode(OpenMeteoForecastResponse.self, from: omData) else { return nil }
        let yr = (try? Data(contentsOf: fixtureDir.appending(path: "\(slug).met.json"))).flatMap { try? dec.decode(METCompactResponse.self, from: $0) }
        let offset = Int(om.utc_offset_seconds ?? 0)
        var providers = OpenMeteoClient.providers(from: om)
        if let y = METClient.yrProvider(yr, time: om.time, offset: offset) { providers.append(y) }
        return Forecast(lat: 59.91, lon: 10.75, timezone: om.timezone, utcOffsetSeconds: offset, elevation: om.elevation,
                        generated: fixtureNow, time: om.time, providers: providers).prepared()
    }

    /// Three made-up models over 7 days around the fixture time: mild, some rain in the afternoon.
    private static func synthetic() -> Forecast {
        let offset = 3600, start = (fixtureNow.timeIntervalSince1970 + Double(offset)) / 86400
        let day0 = floor(start) * 86400
        let n = 7 * 24
        let time = (0..<n).map { JS.isoUTC(day0 + Double($0) * 3600, 16) }
        let providers = ["ecmwf_ifs025", "icon_seamless", "metno_seamless"].enumerated().map { k, id -> Provider in
            func series(_ f: (Int) -> Double) -> [Double?] { (0..<n).map { Optional(f($0)) } }
            let values: [HourlyVariable: [Double?]] = [
                .temperature2m: series { 6 + 4 * sin(Double($0 % 24 - 9) / 24 * 2 * .pi) + Double(k) * 0.6 },
                .apparentTemperature: series { 3 + 4 * sin(Double($0 % 24 - 9) / 24 * 2 * .pi) },
                .precipitation: series { ($0 % 24 >= 14 && $0 % 24 <= 17 && k != 2) ? 0.6 : 0 },
                .windSpeed10m: series { 12 + Double(($0 + k * 3) % 9) },
                .windGusts10m: series { 25 + Double(($0 + k * 5) % 15) },
                .windDirection10m: series { _ in 200 + Double(k * 10) },
                .cloudCover: series { Double(($0 * 7 + k * 20) % 100) },
                .relativeHumidity2m: series { _ in 80 },
                .pressureMSL: series { _ in 1008 },
                .cape: series { _ in 0 },
            ]
            return Provider(id: id, hourly: Hourly(values: values, count: n))
        }
        return Forecast(lat: 59.91, lon: 10.75, timezone: "Europe/Oslo", utcOffsetSeconds: offset, elevation: 9,
                        generated: fixtureNow, time: time, providers: providers).prepared()
    }

    /// A radar-like series: dry now, a shower in about 40 minutes.
    private static func nowcast(now: Date) -> NowcastSeries {
        let t0 = now.timeIntervalSince1970
        let pts = (0..<19).map { i in NowcastPoint(t: t0 + Double(i) * 300, rate: (8...11).contains(i) ? 1.2 : 0) }
        return NowcastSeries(series: pts, km: 5, fetched: t0)
    }
}
