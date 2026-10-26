import Testing
import Foundation
@testable import GlettKit

struct NowcastEngineTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    /// Rates every 5 minutes from 10 minutes ago (the first step is dropped, older than 5 minutes).
    func series(_ rates: [Double], model: Bool = false) -> NowcastSeries {
        let t0 = now.timeIntervalSince1970 - 600
        let pts = [NowcastPoint(t: t0, rate: 9)] + rates.enumerated().map { NowcastPoint(t: t0 + 300 * Double($0.offset + 1), rate: $0.element) }
        return NowcastSeries(series: pts, km: 5, model: model, fetched: 0)
    }
    func at(_ i: Int) -> Date { Date(timeIntervalSince1970: now.timeIntervalSince1970 - 600 + 300 * Double(i + 1)) }

    @Test func nextGlett() throws {
        #expect(NextGlett.evaluate(series([0, 0, 0.2, 0.3, 0]), now: now)?.kind == .dryUntil(at(2)))
        #expect(NextGlett.evaluate(series([0, 0.5, 0, 0]), now: now)?.kind == .blip(at(1)))
        #expect(NextGlett.evaluate(series([0.4, 0.4, 0, 0]), now: now)?.kind == .wetUntil(at(2)))
        #expect(NextGlett.evaluate(series([0.4, 0, 0.4, 0, 0]), now: now)?.kind == .wetUntil(at(3)))   // one dry step is not a stop
        #expect(NextGlett.evaluate(series([0.4, 0.4]), now: now)?.kind == .wetAll)
        #expect(NextGlett.evaluate(series([0, 0, 0]), now: now)?.kind == .dryAll)
        #expect(NextGlett.evaluate(series([0, 0, 0.2]), now: now)?.kind == .dryUntil(at(2)))   // the last step counts alone
        let m = try #require(NextGlett.evaluate(series([0.1], model: true), now: now))
        #expect(m.wetNow && m.model && m.key == "nc.wet.all")
        #expect(NextGlett.evaluate(nil, now: now) == nil)
    }

    @Test func here90() {
        let h = NowcastHere.evaluate(series([0, 0, 0.2, 0]), now: now)
        #expect(h?.flip == at(2) && h?.key == "lm.radar.here.from")
        #expect(NowcastHere.evaluate(series(Array(repeating: 0, count: 19) + [1]), now: now)?.key == "lm.radar.here.dry")   // beyond 19 steps
    }

    @Test func strip() throws {
        var nc = series([0, 0.2, 1.5, 5, 0, 0, 0])
        nc.ring = [.init(dir: "n", series: [NowcastPoint(t: at(3).timeIntervalSince1970, rate: 0.3)]), .init(dir: "e", series: [NowcastPoint(t: at(0).timeIntervalSince1970, rate: 0)])]
        let s = try #require(RadarStrip.make(nc, now: now))
        #expect(s.points.count == 7)
        #expect(s.top == 5)   // the peak 5 mm/h fits the 5 scale
        #expect(abs(s.total - (0.2 + 1.5 + 5) * 300 / 3600) < 1e-12)
        #expect(s.nearby?.directions == ["n"] && s.nearby?.single == true)
        #expect(RadarStrip.intensity(5) == "heavy" && RadarStrip.intensity(0.05) == nil)
        #expect(RadarStrip.make(series([0, 0]), now: now) == nil)
    }

    @Test func radarBadge() {
        let f = forecast([provider("icon_seamless", 24) { $0[.precipitation] = Array(repeating: 0, count: 24) }], hours: 24)
        let col = f.columns(step: 1, now: localDate(hour: 3))[3]
        let t0 = col.start.timeIntervalSince1970
        let wet = NowcastSeries(series: (0..<12).map { NowcastPoint(t: t0 + 300 * Double($0), rate: 1.2) }, km: 5, fetched: 0)
        guard case .rain(let mm)? = RadarBadge.badge(for: col, nowcast: wet, rainChance: 0.1) else { Issue.record("no rain badge"); return }
        #expect(abs(mm - 1.2) < 1e-9)
        #expect(RadarBadge.badge(for: col, nowcast: wet, rainChance: 0.35) == nil)
        let dry = NowcastSeries(series: (0..<12).map { NowcastPoint(t: t0 + 300 * Double($0), rate: 0) }, km: 5, fetched: 0)
        #expect(RadarBadge.badge(for: col, nowcast: dry, rainChance: 0.7) == .dry)
        #expect(RadarBadge.badge(for: col, nowcast: dry, rainChance: 0.5) == nil)
    }
}
