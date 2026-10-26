import Testing
import Foundation
@testable import GlettKit

/// Live smoke test against Open-Meteo, MET and glett.no. Off by default; run with
/// `GLETT_LIVE=1 swift test --filter LiveTests`.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["GLETT_LIVE"] == "1"))
struct LiveTests {
    @Test func osloEndToEnd() async throws {
        let service = WeatherService(cache: ForecastCache(directory: tempDir()), gate: RateGate(), identity: ClientIdentity(version: "0.1.0", build: "1"))
        let oslo = Place.cities[0]
        let bundle = try await service.forecast(for: oslo)
        let f = bundle.forecast
        #expect(!bundle.fromCache)
        #expect(f.time.count == 168 && f.dates.count == 7)
        #expect(f.providers.count >= 10)
        #expect(f.providers.contains { $0.id == "yr" })
        #expect(f.providers.contains { $0.id == "metno_seamless" })
        let again = try await service.forecast(for: oslo)
        #expect(again.fromCache)

        let e = bundle.consensus()
        let now = try #require(e.nowSummary())
        #expect(now.top != nil && now.temperature != nil && now.verdict != nil)
        #expect(e.days().count == 7)
        let steps = e.columns(step: 3).map(e.step)
        #expect(steps.count == 56)
        let nc = await service.nowcast(for: oslo)
        let alerts = await service.alerts(for: oslo, lang: "nb")
        let measured = await service.measuredNow(for: oslo)
        let hits = try await service.search("Bergen", lang: "nb")
        #expect(hits.first?.name.hasPrefix("Bergen") == true)
        print("""
        LIVE Oslo: \(f.providers.count) providers (\(f.providers.filter { $0.dupOf != nil }.count) duplicates), tz \(f.timezone ?? "-"), \
        now \(now.column.label) \(now.top!.category.rawValue) \(Int(JS.round(now.top!.share * 100)))% \
        temp \(JS.toFixed(now.temperature!, 1))° dots \(now.verdict!.dots) (\(now.verdict!.agreeing)/\(now.verdict!.total)); \
        nowcast \(nc.map { "\($0.series.count) steps, ring \($0.ring.count), model \($0.model), \(NextGlett.evaluate($0)?.key ?? "-")" } ?? "none"); \
        alerts here \(alerts.map { "\($0.count)" } ?? "unavailable"); measured \(measured.map { $0.ok ? "\($0.temp?.v ?? .nan)° from \($0.temp?.n ?? 0)" : "few (\($0.stations))" } ?? "unavailable")
        """)
    }
}
