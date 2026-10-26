import Testing
import Foundation
@testable import GlettKit

struct StepAggregationTests {
    let p = provider("icon_seamless", 6) { v in
        v[.precipitation] = [0.1, nil, 0.4, 0, 0, 0]
        v[.windGusts10m] = [20, 35, nil, 10, 10, 10]
        v[.temperature2m] = [1, 2, 4, nil, nil, nil]
        v[.cape] = [nil, nil, nil, nil, nil, nil]
        v[.windDirection10m] = [90, 180, nil, 270, 0, 90]
        v[.windSpeed10m] = [10, 30, 5, 0, nil, 5]
        v[.weatherCode] = [3, 61, 2, nil, nil, nil]
    }

    @Test func sumMaxMean() {
        let f = forecast([p], hours: 6)
        let q = f.providers[0]
        #expect(StepAggregation.aggregate(q, .precip, 0, 3) == 0.5)
        #expect(StepAggregation.aggregate(q, .gust, 0, 3) == 35)
        #expect(StepAggregation.aggregate(q, .cape, 0, 3) == nil)
        #expect(StepAggregation.aggregate(q, .mean(.temperature2m), 0, 3) == 7.0 / 3.0)
        #expect(StepAggregation.aggregate(q, .mean(.temperature2m), 3, 6) == nil)
        #expect(StepAggregation.aggregate(q, .code, 0, 3) == 61)
        // the derived code fills the hours without a model code: cloud cover is null there, precipitation 0 → nil
        #expect(StepAggregation.aggregate(q, .code, 3, 6) == nil)
        #expect(StepAggregation.aggregate(q, .precip, 1, 2) == nil)
        #expect(StepAggregation.aggregate(q, .precip, 4, 10) == 0)   // slices past the end are cut, as JS slice does
    }

    @Test func circularMean() throws {
        // node: circMean([90, 180], [10, 30]) = 161.56505117707798; circMean([270, 0, 90], [0, null, 5]) = 75.96375653207355
        #expect(abs(StepAggregation.circularMean([90, 180], weights: [10, 30]) - 161.56505117707798) < 1e-9)
        let f = forecast([p], hours: 6)
        let dir = try #require(StepAggregation.aggregate(f.providers[0], .dir, 0, 3))
        #expect(abs(dir - 161.56505117707798) < 1e-9)
        let dir2 = try #require(StepAggregation.aggregate(f.providers[0], .dir, 3, 6))   // speeds 0 and null count as 1
        #expect(abs(dir2 - 75.96375653207355) < 1e-9)
        let north = StepAggregation.circularMean([350, 10], weights: [1, 1])
        #expect(north < 1e-9 || abs(north - 360) < 1e-9)
    }

    @Test func columnsAndNow() {
        let f = forecast([p], hours: 48)
        let now = localDate(hour: 10.5)
        #expect(f.nowIndex(now: now) == 10)
        #expect(f.todayIndex(now: now) == 0)
        #expect(f.dates == ["2026-10-25", "2026-10-26"])
        let c3 = f.columns(step: 3, now: now)
        #expect(c3.count == 16)
        #expect(c3[0].label == "00–03")
        #expect(c3[7].label == "21–00")
        #expect(c3[3].now && !c3[3].past)   // 09–12 holds 10:30
        #expect(c3[2].past && !c3[2].now)
        let c1 = f.columns(step: 1, day: 1, now: now)
        #expect(c1.count == 24 && c1[0].a == 24 && c1[0].label == "00:00" && c1[0].first)
        #expect(c1[0].night && !c1[12].night)   // no is_day from the model: 07–20 is day
        #expect(c1[0].start.timeIntervalSince1970 == osloMidnight + 86400)
        let c12 = f.columns(step: 12, now: now)
        #expect(c12.map(\.night) == [true, false, true, false])   // the middle hours 06 and 18: 06 is before 07, night
    }
}
