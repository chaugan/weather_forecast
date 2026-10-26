import Foundation
import Testing
@testable import GlettKit

/// The 7 day cards (`renderDays`, js/app.js:890-921) and today's rain and gust lines (`renderSummary`, js/app.js:931-953)
/// against the web's JS, on every recorded place at three times of the day, without and with the synthetic weights.
@Suite("Golden days and today") struct GoldenDailyTests {
    @Test(arguments: Golden.slugs, Golden.runs) func daily(_ slug: String, _ run: String) async throws {
        let exp = try await GoldenStore.shared.expected(slug)
        let f = try await GoldenStore.shared.forecast(slug)
        let daily = try #require(exp.daily, "\(slug): no 'daily' in the expected file; run scripts/fixtures.mjs")
        #expect(daily.count == 3)
        var d = GoldenDiff("\(slug) \(run) daily")
        for e in daily {
            let r = try #require(e.runs[run])
            let engine = ConsensusEngine(forecast: f, weighted: true, weights: exp.weights(run: run), now: Date(timeIntervalSince1970: e.now))
            let at = "t\(Int(e.now))"
            d.eq("\(at).nowIdx", engine.nowIndex, e.nowIdx)
            d.eq("\(at).todayIdx", engine.todayIndex, e.todayIdx)
            Self.days(engine.days(), r.days, at, &d)
            Self.outlook(engine.todayOutlook(), r.outlook, at, &d)
        }
        d.report()
    }

    static func days(_ got: [DaySummary], _ want: [GDaily.Day], _ at: String, _ d: inout GoldenDiff) {
        d.eq("\(at).days.count", got.count, want.count)
        for (k, (g, w)) in zip(got, want).enumerated() {
            let p = "\(at).days[\(k)]"
            d.eq("\(p).top", g.category?.rawValue, w.top)
            d.num("\(p).hi", g.high, w.hi)
            d.num("\(p).lo", g.low, w.lo)
            d.num("\(p).rp", g.rainChance, w.rp)
            d.eq("\(p).rain", g.rainChance.map { Int(JS.round($0 * 100)) }, w.rain)
            d.num("\(p).sp", g.thunderChance, w.sp)
            d.eq("\(p).storm", g.thunderChance.map { Int(JS.round($0 * 100)) } ?? 0, w.storm)
            d.num("\(p).mm", g.precipitation, w.mm)
            d.num("\(p).gust", g.gust, w.gust)
            d.eq("\(p).rest", g.restOfDay, w.rest)
            d.eq("\(p).dry", g.precipitation == nil || g.isDry, w.dry)
        }
    }

    static func outlook(_ got: TodayOutlook, _ want: GDaily.Outlook, _ at: String, _ d: inout GoldenDiff) {
        let p = "\(at).outlook"
        d.eq("\(p).rain?", got.rain != nil, want.rain != nil)
        if let g = got.rain, let w = want.rain {
            d.eq("\(p).rain.key", g.key, w.key)
            d.num("\(p).rain.maxP", got.rainMax, w.maxP)
            d.eq("\(p).rain.firstHour", got.rainHour, w.firstHour)
            switch g {
            case .dry(let rest): d.eq("\(p).rain.partial", rest, want.partial)
            case .restOfDay(let pct), .chance(let pct): d.eq("\(p).rain.pct", pct, w.pct)
            case .from(let c, let pct):
                d.eq("\(p).rain.pct", pct, w.pct)
                d.eq("\(p).rain.firstA", c.a, w.firstA)
                d.eq("\(p).rain.h", c.label, w.h)
            }
        }
        let shown = want.gust?.shown ?? false
        d.eq("\(p).gust?", got.gust != nil, shown)
        if let g = got.gust, let w = want.gust, shown {
            d.num("\(p).gust.value", g.value, w.g)
            d.eq("\(p).gust.a", g.column.a, w.a)
            d.eq("\(p).gust.hour", g.column.hour, w.hour)
            d.eq("\(p).gust.strong", g.strong, w.strong)
            d.eq("\(p).gust.tod", g.timeOfDayKey, w.tod)
            d.eq("\(p).gust.v", JS.fmt(g.value), w.v)   // the fixtures run in km/h
        }
    }
}
