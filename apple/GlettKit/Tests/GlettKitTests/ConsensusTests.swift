import Testing
import Foundation
@testable import GlettKit

/// Hand-computed cases. Three models at 12:00 with "now" 10:30, so MET Nordic gets the short-range boost
/// 1 + (1 − 2/6) = 5/3 and the total weight is 1 + 1 + 5/3 = 11/3.
struct ConsensusTests {
    static let n = 48
    static func fc(extra: [Provider] = [], order: [String] = ["icon_seamless", "gfs_seamless", "metno_seamless"]) -> Forecast {
        let a = provider("icon_seamless", n) { v in
            v[.weatherCode] = Array(repeating: 0, count: n); v[.weatherCode]![12] = 61; v[.weatherCode]![30] = 0
            v[.precipitation] = Array(repeating: 0, count: n); v[.precipitation]![12] = 0.5
            v[.temperature2m] = Array(repeating: 5, count: n); v[.temperature2m]![12] = 10
            v[.windSpeed10m] = Array(repeating: 5, count: n); v[.windSpeed10m]![12] = 20
            v[.windGusts10m] = Array(repeating: 10, count: n); v[.windGusts10m]![12] = 70
            v[.pressureMSL] = Array(repeating: 1000, count: n)
            v[.cape] = Array(repeating: 0, count: n)
        }
        let b = provider("gfs_seamless", n) { v in
            v[.weatherCode] = Array(repeating: 3, count: n); v[.weatherCode]![12] = 3
            v[.precipitation] = Array(repeating: 0, count: n); v[.precipitation]![12] = 0.1
            v[.temperature2m] = Array(repeating: 6, count: n); v[.temperature2m]![12] = 12
            v[.windSpeed10m] = Array(repeating: 5, count: n); v[.windSpeed10m]![12] = 40
            v[.windGusts10m] = Array(repeating: 10, count: n); v[.windGusts10m]![12] = 50
            v[.pressureMSL] = Array(repeating: 1001, count: n)
            v[.cape] = Array(repeating: 0, count: n); v[.cape]![12] = 1200
        }
        let c = provider("metno_seamless", n) { v in
            v[.weatherCode] = Array(repeating: 2, count: n); v[.weatherCode]![12] = 63
            v[.precipitation] = Array(repeating: 0, count: n); v[.precipitation]![12] = 0.3
            v[.temperature2m] = Array(repeating: 7, count: n); v[.temperature2m]![12] = 11
            v[.windSpeed10m] = Array(repeating: 5, count: n); v[.windSpeed10m]![12] = 10
            v[.windGusts10m] = Array(repeating: 10, count: n); v[.windGusts10m]![12] = 30
            v[.pressureMSL] = Array(repeating: 1002, count: n)
        }
        let all = [a, b, c]
        return forecast(order.map { id in all.first { $0.id == id }! } + extra, hours: n)
    }
    static let now = localDate(hour: 10.5)

    func col(_ e: ConsensusEngine, _ a: Int) -> StepColumn { e.columns(step: 1).first { $0.a == a }! }

    @Test func boostAndShares() throws {
        let e = ConsensusEngine(forecast: Self.fc(), now: Self.now)
        #expect(e.nowIndex == 10)
        let metno = e.providers[2]
        #expect(e.shortBoost(metno, 10) == 2)
        #expect(e.shortBoost(metno, 12) == 1 + (1 - 2.0 / 6))
        #expect(e.shortBoost(metno, 16) == 1)
        #expect(e.shortBoost(metno, 9) == 1)
        #expect(e.shortBoost(e.providers[0], 12) == 1)
        #expect(e.shortBoost(metno, nil) == 1)

        let c = col(e, 12)
        let shares = try #require(e.weatherShares(c))
        #expect(shares.map(\.category) == [.rain, .cloudy])
        #expect(abs(shares[0].share - 8.0 / 11) < 1e-12)
        #expect(abs(shares[1].share - 3.0 / 11) < 1e-12)
        #expect(abs(e.rainChance(c)! - 8.0 / 11) < 1e-12)
        #expect(abs(e.temperature(c)! - 11) < 1e-12)
        #expect(abs(e.windChance(c)! - 3.0 / 11) < 1e-12)
        #expect(e.gustShare(c) == 1.0 / 3)
        #expect(abs(e.gustMean(c)! - (70 + 50 + 30 * 5.0 / 3) / (11.0 / 3)) < 1e-12)
        // thunder: icon and metno have their own codes (no thunder, cape 0 / none) → 0; gfs cape 1200 → 0.5
        #expect(abs(e.thunderChance(c)! - 0.5 / (11.0 / 3)) < 1e-12)
        // temperatures 10, 12, 11: sd = sqrt(2/3), 1 − 0.8165/4 = 0.796 → 80
        #expect(e.agreement(.temperature2m, c) == 80)
        #expect(e.agreement(.pressureMSL, c) == 80)
        #expect(abs(e.spread(.temperature2m, c)! - (2.0 / 3).squareRoot()) < 1e-12)
        #expect(e.agreement(.cloudCover, c) == nil)
    }

    @Test func verdict() throws {
        let e = ConsensusEngine(forecast: Self.fc(), now: Self.now)
        let v = try #require(e.verdict(col(e, 12)))
        #expect(v.category == .rain)
        #expect(v.level == .mid)
        #expect(v.dots == 4)           // round(8/11 × 5 = 3.64)
        #expect(v.agreeing == 2)       // round(8/11 × 3 = 2.18)
        #expect(v.total == 3)
        #expect(v.temperatureMin == 10 && v.temperatureMax == 12)
        // the now card describes 10:00: clear (icon 0), cloudy (gfs 3), partly (metno 2 with boost 2) → partly 2/4 = 0.5
        let now = try #require(e.nowSummary())
        #expect(now.column.a == 10)
        #expect(now.top?.category == .partly)
        #expect(now.verdict?.level == .mid && now.verdict?.dots == 3 && now.agreeing == 2)   // round(2.5) = 3, round(1.5) = 2
    }

    @Test func tiesKeepProviderOrder() throws {
        let e1 = ConsensusEngine(forecast: Self.fc(order: ["icon_seamless", "gfs_seamless"]), now: Self.now)
        #expect(e1.weatherShares(col(e1, 30))!.map(\.category) == [.clear, .cloudy])
        let e2 = ConsensusEngine(forecast: Self.fc(order: ["gfs_seamless", "icon_seamless"]), now: Self.now)
        #expect(e2.weatherShares(col(e2, 30))!.map(\.category) == [.cloudy, .clear])
    }

    @Test func reliabilityWeights() throws {
        let w = WeightTable(["icon_seamless": ["weather": 1.5, "precip": 0], "gfs_seamless": ["weather": nil]])
        let e = ConsensusEngine(forecast: Self.fc(), weighted: true, weights: w, now: Self.now)
        let c = col(e, 12)
        #expect(abs(e.weatherShares(c)![0].share - (1.5 + 5.0 / 3) / (2.5 + 5.0 / 3)) < 1e-12)
        #expect(abs(e.rainChance(c)! - 8.0 / 11) < 1e-12)   // weight 0 counts as 1, as `|| 1` does
        let off = ConsensusEngine(forecast: Self.fc(), weighted: false, weights: w, now: Self.now)
        #expect(abs(off.weatherShares(c)![0].share - 8.0 / 11) < 1e-12)
    }

    @Test func duplicatesAndDisabled() {
        var dup = Self.fc().providers[0]
        dup.id = "dmi_seamless"
        dup.hourly[.weatherCode] = Array(repeating: 45, count: Self.n)   // other variables may differ; the signature is t, pr, wind, pressure
        let f = Self.fc(extra: [dup])
        #expect(f.providers.last?.dupOf == "icon_seamless")
        let e = ConsensusEngine(forecast: f, now: Self.now)
        #expect(e.providers.count == 3 && e.uniqueCount == 3)
        let d = ConsensusEngine(forecast: f, disabled: ["gfs_seamless"], now: Self.now)
        #expect(d.providers.map(\.id) == ["icon_seamless", "metno_seamless"])
        let none = ConsensusEngine(forecast: f, disabled: ["gfs_seamless", "icon_seamless", "metno_seamless"], now: Self.now)
        #expect(none.providers.count == 3)   // never an empty set
    }

    @Test func dayCategory() {
        #expect(ConsensusEngine.dayCategory([61, 61, 61, 0, 0, 0, 0]) == .rain)
        #expect(ConsensusEngine.dayCategory([95, 95, 0, 0, 0, 71, 71]) == .thunder)
        #expect(ConsensusEngine.dayCategory([71, 71, 61, 61, 61]) == .snow)
        #expect(ConsensusEngine.dayCategory([51, 61, 0, 0, 0, 2]) == .clear)
        #expect(ConsensusEngine.dayCategory([0, 3, nil]) == .clear)
        #expect(ConsensusEngine.dayCategory([3, 0]) == .cloudy)
        #expect(ConsensusEngine.dayCategory([nil]) == nil)
    }

    @Test func days() throws {
        let e = ConsensusEngine(forecast: Self.fc(), now: Self.now)
        let days = e.days()
        #expect(days.count == 2)
        let d0 = days[0]
        #expect(d0.restOfDay)
        // codes 06–22: icon 0 (one 61) → clear; gfs → cloudy; metno 2 (one 63) → partly; no boost on day cards → 1/3 each, icon first
        #expect(d0.category == .clear)
        #expect(d0.high == (10 + 12 + 11) / 3.0)
        #expect(d0.low == (5 + 6 + 7) / 3.0)
        #expect(abs(d0.precipitation! - (0.5 + 0.1 + 0.3) / 3) < 1e-12)
        #expect(d0.rainChance == 0)
        #expect(d0.thunderChance == 0)
        #expect(!days[1].restOfDay)
    }

    @Test func todayOutlook() {
        let e = ConsensusEngine(forecast: Self.fc(), now: Self.now)
        let o = e.todayOutlook()
        #expect(o.rain == .from(column: e.columns(step: 1).first { $0.a == 12 }!, percent: 73))
        #expect(o.rainHour == 12)
        #expect(o.gust?.column.a == 12)
        #expect(o.gust?.timeOfDayKey == "s.tod.midday")
        #expect(o.gust?.strong == false)   // (70 + 50 + 30 × 5/3) / (11/3) = 46.4 km/h: a line, not a warning
    }
}
